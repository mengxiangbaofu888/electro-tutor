/**
 * 学习报告页：得分、总评、错因分析、薄弱点、逐题复盘。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { db } from '../../lib/db/db';
import type { Attempt, Paper, Question } from '../../lib/db/types';
import { QUESTION_TYPE_LABELS, isObjective } from '../../lib/db/types';
import { buildReport, toAnswerArray } from '../../lib/services/grade';
import { startQuickPractice } from '../../lib/services/quiz';
import { Alert, Badge, Button, Card, Empty, Loading, Progress, Stat } from '../../components/ui';
import { Markdown } from '../../components/Markdown';

export function ReportPage() {
  const { attemptId = '' } = useParams();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    const a = await db.attempts.get(attemptId);
    if (!a) {
      setError('找不到这次测验记录。');
      return;
    }
    setAttempt(a);
    const p = await db.papers.get(a.paperId);
    setPaper(p ?? null);
    if (p) {
      const qs = (await db.questions.bulkGet(p.questionIds)).filter(Boolean) as Question[];
      setQuestions(qs);
    }
  }, [attemptId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function regenerate() {
    if (!attempt) return;
    setBusy('report');
    setError('');
    try {
      const report = await buildReport({ attempt, questions });
      const updated = { ...attempt, report };
      await db.attempts.put(updated);
      setAttempt(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  async function practiceWrongOnly() {
    if (!attempt) return;
    setBusy('wrong');
    try {
      const wrongIds = attempt.answers.filter((a) => (a.scoreRatio ?? 0) < 0.8).map((a) => a.questionId);
      const wrongQuestions = questions.filter((q) => wrongIds.includes(q.id));
      if (!wrongQuestions.length) {
        setError('这次没有错题，厉害。');
        return;
      }
      const next = await startQuickPractice({ title: `错题重做 · ${paper?.title ?? ''}`, questions: wrongQuestions });
      navigate(`/exam/${next.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  if (error && !attempt) return <Alert tone="error">{error}</Alert>;
  if (!attempt) return <Loading />;

  if (!attempt.finishedAt) {
    return (
      <Card title="这份卷子还没交">
        <Empty icon="✏️" text="还没有批改结果" hint="回去把题做完并交卷，就能看到报告了" />
        <Button variant="primary" block onClick={() => navigate(`/exam/${attempt.id}`)}>
          继续答题
        </Button>
      </Card>
    );
  }

  const answerById = new Map(attempt.answers.map((a) => [a.questionId, a]));
  const wrongCount = attempt.answers.filter((a) => (a.scoreRatio ?? 0) < 0.8).length;
  const correctCount = attempt.answers.filter((a) => (a.scoreRatio ?? 0) >= 0.8).length;
  const report = attempt.report;

  return (
    <>
      {error && <Alert tone="error">{error}</Alert>}

      {/* ---------------- 总分 ---------------- */}
      <Card title={paper?.title ?? attempt.paperTitle}>
        <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 40, fontWeight: 700, color: scoreColor(attempt.score ?? 0) }}>
            {attempt.score ?? 0}
          </span>
          <span className="muted">分 / 100</span>
        </div>
        <Progress
          value={(attempt.score ?? 0) / 100}
          tone={(attempt.score ?? 0) >= 80 ? 'ok' : (attempt.score ?? 0) < 60 ? 'bad' : undefined}
        />
        <div className="stats" style={{ marginTop: 12 }}>
          <Stat value={correctCount} label="答对" />
          <Stat value={wrongCount} label="答错" />
          <Stat value={questions.length} label="总题数" />
        </div>
        <div className="small faint" style={{ marginTop: 8 }}>
          用时 {formatDuration((attempt.finishedAt ?? 0) - attempt.startedAt)} ·{' '}
          {new Date(attempt.startedAt).toLocaleString('zh-CN')}
        </div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <Button variant="accent" loading={busy === 'wrong'} onClick={practiceWrongOnly}>
            只练错题（{wrongCount}）
          </Button>
          <Button variant="ghost" loading={busy === 'report'} onClick={regenerate}>
            重新生成报告
          </Button>
        </div>
      </Card>

      {/* ---------------- 总评 ---------------- */}
      {report ? (
        <>
          <Card title="🧑‍🏫 老师总评">
            <div className="pre-wrap">{report.summary}</div>
          </Card>

          {report.weakPoints.length > 0 && (
            <Card title="🎯 这次暴露的薄弱点">
              <div className="col">
                {report.weakPoints.map((w) => (
                  <div key={w.knowledgePointId} className="row between">
                    <span className="small grow">{w.name}</span>
                    <Badge tone={w.score < 0.5 ? 'bad' : 'warn'}>{Math.round(w.score * 100)}%</Badge>
                  </div>
                ))}
              </div>
              <div className="btn-row" style={{ marginTop: 12 }}>
                <Button
                  size="sm"
                  onClick={() =>
                    navigate(`/knowledge?point=${report.weakPoints[0].knowledgePointId}`)
                  }
                >
                  给最弱的这个点生成补强讲义
                </Button>
              </div>
            </Card>
          )}

          {report.mistakes.length > 0 && (
            <Card title="🔍 错因分析">
              <div className="col">
                {report.mistakes.map((m, i) => {
                  const q = questions.find((x) => x.id === m.questionId);
                  return (
                    <div key={`${m.questionId}-${i}`} className="card tight" style={{ margin: 0 }}>
                      <div className="small muted truncate">{q?.stem ?? '（题目已删除）'}</div>
                      <div className="small" style={{ marginTop: 6 }}>
                        <b>错在哪：</b>
                        {m.what}
                      </div>
                      <div className="small" style={{ marginTop: 4 }}>
                        <b>根因：</b>
                        {m.why}
                      </div>
                      <div className="small" style={{ marginTop: 4, color: 'var(--ok)' }}>
                        <b>怎么补：</b>
                        {m.fix}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {report.suggestions.length > 0 && (
            <Card title="📌 下一步怎么做">
              <ol style={{ paddingLeft: 20, margin: 0 }}>
                {report.suggestions.map((s, i) => (
                  <li key={i} className="small" style={{ marginBottom: 6 }}>
                    {s}
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </>
      ) : (
        <Card title="🧑‍🏫 老师总评">
          <Empty icon="📝" text="还没有生成总评" />
          <Button variant="primary" block loading={busy === 'report'} onClick={regenerate}>
            生成学习报告
          </Button>
        </Card>
      )}

      {/* ---------------- 逐题复盘 ---------------- */}
      <Card
        title="📖 逐题复盘"
        extra={
          <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
            {showAll ? '只看错题' : '看全部'}
          </Button>
        }
      >
        <div className="col">
          {questions
            .filter((q) => showAll || (answerById.get(q.id)?.scoreRatio ?? 0) < 0.8)
            .map((q, i) => {
              const a = answerById.get(q.id);
              const ratio = a?.scoreRatio ?? 0;
              const ok = ratio >= 0.8;
              return (
                <div key={q.id} className="card tight" style={{ margin: 0 }}>
                  <div className="row between">
                    <Badge tone={ok ? 'ok' : 'bad'}>
                      {ok ? '✔ 正确' : ratio > 0 ? `△ 部分正确 ${Math.round(ratio * 100)}%` : '✘ 错误'}
                    </Badge>
                    <span className="small faint">
                      {i + 1} · {QUESTION_TYPE_LABELS[q.type]}
                      {!isObjective(q.type) && ' · AI 批改'}
                    </span>
                  </div>
                  <div className="pre-wrap small" style={{ marginTop: 8 }}>
                    {q.stem}
                  </div>
                  {q.options && (
                    <div className="small muted" style={{ marginTop: 6 }}>
                      {q.options.map((o) => (
                        <div key={o.key}>
                          {o.key}. {o.text}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="divider" />
                  <div className="small">
                    <span className="muted">你的作答：</span>
                    <span style={{ color: ok ? 'var(--ok)' : 'var(--bad)' }}>
                      {toAnswerArray(a?.userAnswer ?? '').filter(Boolean).join(' / ') || '（未作答）'}
                    </span>
                  </div>
                  <div className="small">
                    <span className="muted">正确答案：</span>
                    <span style={{ color: 'var(--ok)' }}>{toAnswerArray(q.answer).join(' / ')}</span>
                  </div>
                  {a?.aiComment && (
                    <div className="small" style={{ marginTop: 6 }}>
                      <span className="muted">AI 评语：</span>
                      <span className="pre-wrap">{a.aiComment}</span>
                    </div>
                  )}
                  {a?.aiBreakdown?.length ? (
                    <div className="small" style={{ marginTop: 6 }}>
                      <div className="muted">分步得分：</div>
                      {a.aiBreakdown.map((b, bi) => (
                        <div key={bi} className="row between">
                          <span className="grow">{b.point}</span>
                          <span className="faint">
                            {b.got}/{b.full}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <details style={{ marginTop: 8 }}>
                    <summary className="small muted" style={{ cursor: 'pointer' }}>
                      看解析
                    </summary>
                    <div className="small" style={{ marginTop: 6 }}>
                      <Markdown text={q.explanation || '（这道题没有解析）'} />
                    </div>
                  </details>
                </div>
              );
            })}
        </div>
      </Card>

      <Button variant="ghost" block onClick={() => navigate('/')}>
        回首页
      </Button>
    </>
  );
}

function scoreColor(score: number): string {
  if (score >= 80) return 'var(--ok)';
  if (score >= 60) return 'var(--warn)';
  return 'var(--bad)';
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  return `${m} 分 ${s} 秒`;
}
