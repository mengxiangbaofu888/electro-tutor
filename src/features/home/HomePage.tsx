/**
 * 首页：今日该做什么 + 薄弱点 + 最近测验。
 * 这一页是"自进化"闭环的入口——它告诉你今天最该练什么。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, getDefaultLLM, getProfile } from '../../lib/db/db';
import type { Attempt, LearnerProfile } from '../../lib/db/types';
import { getTodayReview, getWeakPoints, type ReviewItem } from '../../lib/services/practice';
import { listQuestionsByPoints, startQuickPractice } from '../../lib/services/quiz';
import { Alert, Badge, Button, Card, Empty, Loading, Progress, Stat } from '../../components/ui';

interface WeakRow {
  knowledgePointId: string;
  name: string;
  score: number;
  severity: number;
  reason: string;
}

export function HomePage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<LearnerProfile | null>(null);
  const [hasModel, setHasModel] = useState(false);
  const [review, setReview] = useState<ReviewItem[]>([]);
  const [weak, setWeak] = useState<WeakRow[]>([]);
  const [recent, setRecent] = useState<Attempt[]>([]);
  const [stats, setStats] = useState({ questions: 0, points: 0, mastered: 0, accuracy: 0 });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [fatal, setFatal] = useState('');

  const load = useCallback(async () => {
    try {
      const [pf, textCfg, rev, wk] = await Promise.all([
        getProfile(),
        getDefaultLLM('text'),
        getTodayReview(8),
        getWeakPoints(5),
      ]);
      setProfile(pf);
      setHasModel(Boolean(textCfg));
      setReview(rev);
      setWeak(wk);

      const attempts = await db.attempts.toArray();
      setRecent(attempts.sort((a, b) => b.startedAt - a.startedAt).slice(0, 3));

      const [questions, points, mastery] = await Promise.all([
        db.questions.count(),
        db.knowledgePoints.count(),
        db.mastery.toArray(),
      ]);
      const answered = mastery.reduce((s, m) => s + m.attempts, 0);
      const correct = mastery.reduce((s, m) => s + m.correct, 0);
      setStats({
        questions,
        points,
        mastered: mastery.filter((m) => m.score >= 0.8).length,
        accuracy: answered ? Math.round((correct / answered) * 100) : 0,
      });
    } catch (e) {
      // 最常见的原因是浏览器禁用了本地存储（无痕模式、或用 file:// 直接打开页面），
      // 这时数据库打不开，必须给出提示而不是一直转圈。
      setFatal(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 从一组知识点里凑题开始练习 */
  async function practiceFromPoints(pointIds: string[], title: string, limit = 10) {
    setBusy(pointIds[0] ?? 'x');
    setError('');
    try {
      const pool = await listQuestionsByPoints(pointIds);
      if (!pool.length) {
        setError('这些知识点下还没有题目。请到「练习」页先生成一批题目。');
        return;
      }
      // 打乱后取前 limit 道
      const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, limit);
      const attempt = await startQuickPractice({ title, questions: shuffled });
      navigate(`/exam/${attempt.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  if (loading) return <Loading />;

  if (fatal) {
    return (
      <Alert tone="error">
        {'本地数据库打不开，所以页面一直在转圈。\n\n'}
        {'常见原因有两个：\n'}
        {'① 浏览器处于无痕 / 隐私模式；\n'}
        {'② 你是用 file:// 直接双击打开 HTML 文件的。\n\n'}
        {'请改用 http 地址访问（npm run dev 会在终端打印地址），并且不要用无痕模式。\n\n'}
        {`原始错误：${fatal}`}
      </Alert>
    );
  }

  return (
    <>
      {!hasModel && (
        <Alert tone="warn">
          还没有配置大模型，出题和批改都用不了。
          <div style={{ marginTop: 8 }}>
            <Button size="sm" variant="primary" onClick={() => navigate('/me')}>
              去配置模型
            </Button>
          </div>
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}

      {/* ---------------- 概览 ---------------- */}
      <Card title="📈 学习概览">
        <div className="stats">
          <Stat value={stats.points} label="知识点" />
          <Stat value={stats.questions} label="题库" />
          <Stat value={stats.mastered} label="已掌握" />
        </div>
        <div style={{ marginTop: 10 }}>
          <div className="row between small muted">
            <span>累计正确率</span>
            <span>{stats.accuracy}%</span>
          </div>
          <Progress value={stats.accuracy / 100} tone={stats.accuracy >= 80 ? 'ok' : undefined} />
        </div>
        {profile?.weakAreas.length ? (
          <div className="row wrap" style={{ marginTop: 10 }}>
            {profile.weakAreas.slice(0, 4).map((w) => (
              <Badge key={w} tone="bad">
                {w}
              </Badge>
            ))}
          </div>
        ) : null}
      </Card>

      {/* ---------------- 今日复习 ---------------- */}
      <Card
        title="🔁 今日该复习"
        extra={<Badge tone={review.some((r) => r.due) ? 'warn' : undefined}>{review.length} 个知识点</Badge>}
      >
        {review.length === 0 ? (
          <Empty
            icon="🌱"
            text="还没有复习安排"
            hint="先去做一套题，系统会根据遗忘曲线自动给你排复习计划"
          />
        ) : (
          <>
            <p className="small muted" style={{ marginTop: 0 }}>
              {review.some((r) => r.due)
                ? '这些知识点已经到复习时间了，现在练效果最好。'
                : '暂时没有到期的，下面是目前最薄弱的，可以提前练。'}
            </p>
            <div className="col">
              {review.map((item) => (
                <div key={item.point.id} className="card tight" style={{ margin: 0 }}>
                  <div className="row between">
                    <div className="grow">
                      <div className="row" style={{ gap: 6 }}>
                        <strong className="small">{item.point.name}</strong>
                        {item.due ? <Badge tone="warn">该复习</Badge> : <Badge>巩固</Badge>}
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <Progress value={item.score} tone={item.score < 0.6 ? 'bad' : undefined} />
                      </div>
                      <div className="small faint" style={{ marginTop: 4 }}>
                        当前掌握度 {Math.round(item.score * 100)}%
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === item.point.id}
                      onClick={() => practiceFromPoints([item.point.id], `复习：${item.point.name}`, 6)}
                    >
                      练一下
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="btn-row" style={{ marginTop: 12 }}>
              <Button
                variant="primary"
                block
                loading={busy === 'all'}
                onClick={() => practiceFromPoints(review.map((r) => r.point.id), '今日复习组合卷', 12)}
              >
                开始今日复习（{review.length} 个知识点）
              </Button>
            </div>
          </>
        )}
      </Card>

      {/* ---------------- 薄弱点 ---------------- */}
      <Card title="🎯 最该补的薄弱点">
        {weak.length === 0 ? (
          <Empty icon="💪" text="还没有薄弱点数据" hint="做过题之后这里会自动算出你最该补的地方" />
        ) : (
          <div className="col">
            {weak.map((w) => (
              <div key={w.knowledgePointId} className="card tight" style={{ margin: 0 }}>
                <div className="row between">
                  <strong className="small grow">{w.name}</strong>
                  <Badge tone={w.score < 0.4 ? 'bad' : 'warn'}>{Math.round(w.score * 100)}%</Badge>
                </div>
                <div className="small faint" style={{ marginTop: 4 }}>
                  {w.reason}
                </div>
                <div className="btn-row" style={{ marginTop: 8 }}>
                  <Button
                    size="sm"
                    loading={busy === w.knowledgePointId}
                    onClick={() => practiceFromPoints([w.knowledgePointId], `专项突破：${w.name}`, 8)}
                  >
                    专项练习
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => navigate(`/knowledge?point=${w.knowledgePointId}`)}
                  >
                    生成补强讲义
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ---------------- 最近测验 ---------------- */}
      {recent.length > 0 && (
        <Card title="🕒 最近测验">
          <div className="col">
            {recent.map((a) => (
              <div key={a.id} className="row between card tight" style={{ margin: 0 }}>
                <div className="grow">
                  <div className="small truncate">{a.paperTitle}</div>
                  <div className="small faint">
                    {new Date(a.startedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
                {typeof a.score === 'number' && (
                  <Badge tone={a.score >= 80 ? 'ok' : a.score >= 60 ? 'warn' : 'bad'}>{a.score} 分</Badge>
                )}
                <Button size="sm" variant="ghost" onClick={() => navigate(`/report/${a.id}`)}>
                  看报告
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ---------------- 快捷入口 ---------------- */}
      <Card title="🚀 快捷入口">
        <div className="btn-row">
          <Button onClick={() => navigate('/materials')}>📚 导入材料</Button>
          <Button onClick={() => navigate('/outlines')}>🗺️ 知识大纲</Button>
          <Button onClick={() => navigate('/practice')}>✏️ 出题组卷</Button>
          <Button onClick={() => navigate('/wrong')}>📕 错题本</Button>
          <Button onClick={() => navigate('/knowledge')}>🧭 掌握度地图</Button>
        </div>
      </Card>
    </>
  );
}
