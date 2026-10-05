/**
 * 「练习」页：出题、组卷、开始答题。
 * 核心亮点是「自适应出题」——按掌握度自动决定每个知识点出几道。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { db, getDefaultLLM } from '../../lib/db/db';
import type { KnowledgePoint, Outline, Question, QuestionType, TrackId } from '../../lib/db/types';
import { QUESTION_TYPE_LABELS, TRACK_LABELS } from '../../lib/db/types';
import { getOutlinePoints, listOutlines } from '../../lib/services/outline';
import { createPaper, generateQuestions, listAllQuestions, startAttempt } from '../../lib/services/quiz';
import { planAdaptiveAllocation } from '../../lib/services/practice';
import { Alert, Badge, Button, Card, Empty, Field, Loading, Select, TextArea } from '../../components/ui';

const TYPE_ORDER: QuestionType[] = ['single', 'multiple', 'judge', 'blank', 'short', 'calc'];

const DIFFICULTY_OPTIONS = [
  { value: 'easy', label: '简单：以 1~2 星为主，适合刚学完' },
  { value: 'normal', label: '标准：以 2~3 星为主' },
  { value: 'hard', label: '偏难：以 3~4 星为主' },
  { value: 'mixed', label: '混合：简单到难都有' },
];

export function PracticePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [outlines, setOutlines] = useState<Outline[] | null>(null);
  const [outlineId, setOutlineId] = useState('');
  const [points, setPoints] = useState<KnowledgePoint[]>([]);
  const [allocation, setAllocation] = useState<Record<string, number>>({});
  const [typeMix, setTypeMix] = useState<Record<QuestionType, number>>({
    single: 8,
    multiple: 2,
    judge: 5,
    blank: 3,
    short: 1,
    calc: 1,
  });
  const [difficulty, setDifficulty] = useState('normal');
  const [withMaterial, setWithMaterial] = useState(true);
  const [track, setTrack] = useState<TrackId>('fundamental');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState('');
  const [stream, setStream] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [bankCount, setBankCount] = useState(0);
  const [hasModel, setHasModel] = useState(true);
  const [adaptive, setAdaptive] = useState(true);

  const load = useCallback(async () => {
    const [os, cfg, count] = await Promise.all([listOutlines(), getDefaultLLM('text'), db.questions.count()]);
    setOutlines(os);
    setHasModel(Boolean(cfg));
    setBankCount(count);
    return os;
  }, []);

  useEffect(() => {
    void (async () => {
      const os = await load();
      const wanted = params.get('outlineId');
      const initial = wanted && os.some((o) => o.id === wanted) ? wanted : (os[0]?.id ?? '');
      setOutlineId(initial);
    })();
  }, [load, params]);

  useEffect(() => {
    void (async () => {
      if (!outlineId) {
        setPoints([]);
        return;
      }
      const ps = await getOutlinePoints(outlineId);
      setPoints(ps);
      const outline = outlines?.find((o) => o.id === outlineId);
      if (outline) setTrack(outline.track);
    })();
  }, [outlineId, outlines]);

  // 自适应：按掌握度自动分配题量
  const refreshAdaptive = useCallback(
    async (total: number) => {
      if (!outlineId) return;
      const plan = await planAdaptiveAllocation({ outlineId, totalCount: total, minPerPoint: 1 });
      const next: Record<string, number> = {};
      for (const p of points) next[p.id] = 0;
      for (const row of plan) next[row.pointId] = row.count;
      setAllocation(next);
    },
    [outlineId, points],
  );

  const totalQuestions = useMemo(
    () => Object.values(allocation).reduce((s, n) => s + (n || 0), 0),
    [allocation],
  );
  const typeTotal = useMemo(() => Object.values(typeMix).reduce((s, n) => s + (n || 0), 0), [typeMix]);

  async function doGenerate(thenStart: boolean) {
    if (!outlineId) {
      setMessage({ tone: 'error', text: '请先选择一份大纲。' });
      return;
    }
    const alloc = Object.entries(allocation)
      .filter(([, n]) => n > 0)
      .map(([pointId, count]) => ({ pointId, count }));
    if (!alloc.length) {
      setMessage({ tone: 'error', text: '请给至少一个知识点安排题目数量，或点「自适应推荐」。' });
      return;
    }
    const mix = TYPE_ORDER.map((t) => ({ type: t, count: typeMix[t] || 0 })).filter((m) => m.count > 0);
    if (!mix.length) {
      setMessage({ tone: 'error', text: '请至少选择一种题型。' });
      return;
    }

    setBusy('generate');
    setStream('');
    setMessage(null);
    try {
      const diffText = DIFFICULTY_OPTIONS.find((d) => d.value === difficulty)?.label ?? '标准';
      const questions = await generateQuestions({
        outlineId,
        track,
        allocation: alloc,
        typeMix: mix,
        difficultyMix: `${diffText}${instruction.trim() ? `；额外要求：${instruction.trim()}` : ''}`,
        withMaterial,
        onProgress: (d) => setStream((prev) => (prev + d).slice(-3000)),
      });
      setMessage({ tone: 'ok', text: `生成 ${questions.length} 道题。` });
      await load();

      if (thenStart && questions.length) {
        const paper = await createPaper({
          title: `${outlines?.find((o) => o.id === outlineId)?.title ?? '练习'} · ${new Date().toLocaleDateString('zh-CN')}`,
          questionIds: questions.map((q) => q.id),
          durationMin: 0,
          outlineId,
          track,
        });
        const attempt = await startAttempt(paper);
        navigate(`/exam/${attempt.id}`);
      }
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  /** 用题库里已有的题直接组卷 */
  async function practiceFromBank(count: number) {
    setBusy('bank');
    setMessage(null);
    try {
      const pool = await listAllQuestions();
      const filtered = outlineId ? pool.filter((q) => q.outlineId === outlineId) : pool;
      if (!filtered.length) {
        setMessage({ tone: 'warn', text: '题库里还没有题目，先用上面的方式生成一批。' });
        return;
      }
      const picked = [...filtered].sort(() => Math.random() - 0.5).slice(0, count);
      const paper = await createPaper({
        title: `题库练习 · ${new Date().toLocaleDateString('zh-CN')}`,
        questionIds: picked.map((q) => q.id),
        durationMin: 0,
        outlineId,
        track,
      });
      const attempt = await startAttempt(paper);
      navigate(`/exam/${attempt.id}`);
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  if (!outlines) return <Loading />;

  return (
    <>
      {!hasModel && (
        <Alert tone="warn">
          还没有配置文本大模型，出题会失败。
          <div style={{ marginTop: 8 }}>
            <Button size="sm" variant="primary" onClick={() => navigate('/me')}>
              去配置
            </Button>
          </div>
        </Alert>
      )}
      {message && <Alert tone={message.tone === 'warn' ? 'warn' : message.tone}>{message.text}</Alert>}

      {outlines.length === 0 ? (
        <Card title="✏️ 出题">
          <Empty
            icon="🗺️"
            text="还没有知识大纲"
            hint="需要先导入材料并生成大纲，才能出题"
          />
          <div className="btn-row">
            <Button variant="primary" onClick={() => navigate('/materials')}>
              去导入材料
            </Button>
            <Button variant="ghost" onClick={() => navigate('/outlines')}>
              去生成大纲
            </Button>
          </div>
        </Card>
      ) : (
        <>
          <Card title="🎯 选择大纲与题量">
            <Field label="知识大纲">
              <Select
                value={outlineId}
                onChange={setOutlineId}
                options={outlines.map((o) => ({ value: o.id, label: `${o.title}（${TRACK_LABELS[o.track]}）` }))}
              />
            </Field>

            <div className="row between">
              <div className="row" style={{ gap: 8 }}>
                <label className="row small" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={adaptive}
                    onChange={(e) => setAdaptive(e.target.checked)}
                  />
                  自适应出题（专挑弱点）
                </label>
              </div>
              {adaptive && (
                <Button size="sm" variant="ghost" onClick={() => refreshAdaptive(Math.max(totalQuestions || 20, 20))}>
                  重新计算
                </Button>
              )}
            </div>

            {!adaptive && (
              <p className="small faint" style={{ marginTop: 6 }}>
                手动模式：自己给每个知识点填题量。
              </p>
            )}

            {points.length === 0 ? (
              <Alert tone="warn">这份大纲下没有知识点。</Alert>
            ) : (
              <div className="col scroll-y" style={{ marginTop: 8 }}>
                {points.map((p) => (
                  <div key={p.id} className="row between">
                    <span className="small grow truncate" style={{ paddingLeft: (p.depth - 1) * 10 }}>
                      {p.depth > 1 ? '└ ' : ''}
                      {p.name}
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={30}
                      value={allocation[p.id] ?? 0}
                      onChange={(e) =>
                        setAllocation((prev) => ({ ...prev, [p.id]: Math.max(0, Number(e.target.value) || 0) }))
                      }
                      style={{ width: 64, textAlign: 'center' }}
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="row between" style={{ marginTop: 10 }}>
              <span className="small muted">共 {totalQuestions} 道</span>
              {adaptive && (
                <Button size="sm" variant="ghost" onClick={() => refreshAdaptive(20)}>
                  自适应推荐 20 道
                </Button>
              )}
            </div>
          </Card>

          <Card title="🧩 题型配比" extra={<Badge>{typeTotal} 道</Badge>}>
            <div className="col">
              {TYPE_ORDER.map((t) => (
                <div key={t} className="row between">
                  <span className="small">
                    {QUESTION_TYPE_LABELS[t]}
                    {(t === 'short' || t === 'calc') && <span className="faint small"> · AI 批改</span>}
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={typeMix[t]}
                    onChange={(e) =>
                      setTypeMix((prev) => ({ ...prev, [t]: Math.max(0, Number(e.target.value) || 0) }))
                    }
                    style={{ width: 64, textAlign: 'center' }}
                  />
                </div>
              ))}
            </div>
          </Card>

          <Card title="⚙️ 难度与要求">
            <Field label="难度">
              <Select value={difficulty} onChange={setDifficulty} options={DIFFICULTY_OPTIONS} />
            </Field>
            <Field label="补充要求（可选）">
              <TextArea
                rows={2}
                value={instruction}
                onChange={setInstruction}
                placeholder="例如：多出一些需要判断电路串并联的题"
              />
            </Field>
            <label className="row small" style={{ gap: 6 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={withMaterial}
                onChange={(e) => setWithMaterial(e.target.checked)}
              />
              把材料原文片段给模型参考（更贴合你的教材）
            </label>
          </Card>

          {busy === 'generate' && stream && (
            <Card title="模型正在出题（实时预览）">
              <div className="small mono pre-wrap" style={{ maxHeight: 200, overflowY: 'auto' }}>
                {stream}
              </div>
            </Card>
          )}

          <div className="action-bar">
            <Button
              variant="ghost"
              block
              loading={busy === 'generate'}
              disabled={!totalQuestions || !typeTotal}
              onClick={() => doGenerate(false)}
            >
              只生成题目
            </Button>
            <Button
              variant="accent"
              block
              loading={busy === 'generate'}
              disabled={!totalQuestions || !typeTotal}
              onClick={() => doGenerate(true)}
            >
              生成并开始答题
            </Button>
          </div>

          <Card title="📚 题库直接练习" extra={<Badge>{bankCount} 道</Badge>}>
            <p className="small muted" style={{ marginTop: 0 }}>
              不调用大模型，直接从已有题目里抽题做，省 token 也更快。
            </p>
            <div className="btn-row">
              <Button loading={busy === 'bank'} onClick={() => practiceFromBank(10)}>
                随机 10 题
              </Button>
              <Button variant="ghost" loading={busy === 'bank'} onClick={() => practiceFromBank(20)}>
                随机 20 题
              </Button>
              <Button variant="ghost" onClick={() => navigate('/wrong')}>
                只练错题
              </Button>
            </div>
          </Card>
        </>
      )}
    </>
  );
}

export type { Question };
