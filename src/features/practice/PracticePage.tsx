/**
 * 「练习」页：出题、组卷、开始答题。
 * 核心亮点是「自适应出题」——按掌握度自动决定每个知识点出几道。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { db, getDefaultLLM } from '../../lib/db/db';
import type { Attempt, KnowledgePoint, Outline, Question, QuestionType, TrackId } from '../../lib/db/types';
import { QUESTION_TYPE_LABELS, TRACK_LABELS } from '../../lib/db/types';
import { getOutlinePoints, listOutlines } from '../../lib/services/outline';
import { createPaper, listAllQuestions, startAttempt } from '../../lib/services/quiz';
import {
  cancelGeneration,
  getGenerationState,
  isGenerationActive,
  pauseGeneration,
  resetGeneration,
  resumeGeneration,
  startGeneration,
  subscribeGeneration,
} from '../../lib/services/generation-runner';
import { planAdaptiveAllocation } from '../../lib/services/practice';
import { Alert, Badge, Button, Card, Empty, Field, Loading, Select, TextArea, TextInput } from '../../components/ui';

const TYPE_ORDER: QuestionType[] = ['single', 'multiple', 'judge', 'blank', 'short', 'calc'];

const DIFFICULTY_OPTIONS = [
  { value: 'easy', label: '简单：以 1~2 星为主，适合刚学完' },
  { value: 'normal', label: '标准：以 2~3 星为主' },
  { value: 'hard', label: '偏难：以 3~4 星为主' },
  { value: 'mixed', label: '混合：简单到难都有' },
];

/** 常用题量档位。用户反馈"只有一个随机 20 道这一个选项，不够灵活"。 */
const QUICK_COUNTS = [10, 20, 50, 100];

/**
 * 「要多少道题」选择器：常用档位 + 自定义数量。
 * 自定义留了上限（500）并给出提示，避免手滑输入 99999 之后卡半天。
 */
function CountPicker({ onPick, busy }: { onPick: (n: number) => void; busy: boolean }) {
  const [custom, setCustom] = useState('');
  const customNum = Number(custom);
  const customOk = custom.trim() !== '' && Number.isFinite(customNum) && customNum > 0 && customNum <= 500;

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        {QUICK_COUNTS.map((n) => (
          <Button key={n} size="sm" variant="ghost" disabled={busy} onClick={() => onPick(n)}>
            {n} 道
          </Button>
        ))}
      </div>
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <div style={{ width: 110 }}>
          <TextInput value={custom} placeholder="自定义" type="number" onChange={setCustom} />
        </div>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !customOk}
          onClick={() => customOk && onPick(Math.round(customNum))}
        >
          用这个数
        </Button>
        <span className="small faint">1 ~ 500 道</span>
      </div>
    </div>
  );
}

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
  // 出题任务跑在模块级单例里（见 services/generation-runner.ts）：
  // 这里只是订阅它的状态，所以切页面、组件卸载都不影响它。
  const [gen, setGen] = useState(getGenerationState());
  useEffect(() => subscribeGeneration(setGen), []);
  const genActive = isGenerationActive(gen);
  /** 上次没答完的卷子（答题中暂停退出的，从这里接着做） */
  const [unfinished, setUnfinished] = useState<Attempt | null>(null);
  /** 每道题最近一次的作答结果（true 答对 / false 答错 / 没记录 = 还没做过） */
  const [lastResult, setLastResult] = useState<Map<string, boolean>>(new Map());
  const [bankFilter, setBankFilter] = useState<'todo' | 'correct' | 'wrong' | 'all'>('todo');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [bankCount, setBankCount] = useState(0);
  const [hasModel, setHasModel] = useState(true);
  const [adaptive, setAdaptive] = useState(true);

  const load = useCallback(async () => {
    const [os, cfg, count] = await Promise.all([listOutlines(), getDefaultLLM('text'), db.questions.count()]);
    setOutlines(os);
    setHasModel(Boolean(cfg));
    setBankCount(count);
    // 找最近一次没答完的卷子（答题中暂停退出的），给一个"继续答题"的入口
    const all = await db.attempts.toArray();
    const open = all
      .filter((a) => !a.finishedAt)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    setUnfinished(open ?? null);
    // 顺带算出"哪些题做过/做对/做错"，给下面的题库分区用
    const lastResult = new Map<string, boolean>();
    for (const a of all) {
      for (const rec of a.answers ?? []) {
        if (typeof rec.isCorrect === 'boolean') lastResult.set(rec.questionId, rec.isCorrect);
      }
    }
    setLastResult(lastResult);
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

  // 一进页面就把题量算出来。
  // 「自适应出题」默认是勾上的，但题量并不会自己冒出来——没有这段的话，
  // 打开页面看到的是：所有知识点都是 0、"共 0 道"、两个主按钮全是灰的。
  // 用户会以为这页坏了，而"先点一下自适应推荐 20 道"这个前提没写在任何地方。
  useEffect(() => {
    if (!adaptive || !outlineId || !points.length) return;
    if (totalQuestions > 0) return; // 已经有题量就别覆盖用户的选择
    void (async () => {
      try {
        await refreshAdaptive(20);
      } catch {
        // 算不出来就保持 0，用户可以手动填，不影响页面能用
      }
    })();
  }, [adaptive, outlineId, points, totalQuestions, refreshAdaptive]);
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

    setMessage(null);
    const diffText = DIFFICULTY_OPTIONS.find((d) => d.value === difficulty)?.label ?? '标准';
    // **交给后台任务跑**：这样切到别的页面也不会中断，而且能暂停/取消。
    // （用户实测反馈："我点了我的或者首页，回来就没了"、"一开始生成就不能取消了"）
    const started = startGeneration({
      outlineId,
      track,
      allocation: alloc,
      typeMix: mix,
      difficultyMix: `${diffText}${instruction.trim() ? `；额外要求：${instruction.trim()}` : ''}`,
      withMaterial,
      thenStart,
    });
    if (!started) {
      setMessage({ tone: 'warn', text: '已经有一个出题任务在跑了，等它结束或先取消它。' });
    }
  }

  /** 出题完成后的收尾：刷新题库；如果用户要求"生成并开始答题"，就组卷进考场 */
  const finishRef = useRef(false);
  useEffect(() => {
    if (gen.status !== 'done') {
      finishRef.current = false;
      return;
    }
    if (finishRef.current) return;
    finishRef.current = true;
    void (async () => {
      await load();
      if (gen.thenStart && gen.questions.length) {
        try {
          const paper = await createPaper({
            title: `${outlines?.find((o) => o.id === outlineId)?.title ?? '练习'} · ${new Date().toLocaleDateString('zh-CN')}`,
            questionIds: gen.questions.map((q) => q.id),
            durationMin: 0,
            outlineId,
            track,
          });
          const attempt = await startAttempt(paper);
          navigate(`/exam/${attempt.id}`);
        } catch (e) {
          setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
  }, [gen.status]);

  /** 用题库里已有的题直接组卷 */
  async function practiceFromBank(count: number) {
    setBusy('bank');
    setMessage(null);
    try {
      const pool = (await listAllQuestions()).filter((q) => !outlineId || q.outlineId === outlineId);
      if (!pool.length) {
        setMessage({ tone: 'warn', text: '题库里还没有题目，先用上面的方式生成一批。' });
        return;
      }
      // 按当前筛选抽题：比如"专练没做过的"/"专练做错的"
      const picked = [...pool]
        .filter((q) => {
          const r = lastResult.get(q.id);
          if (bankFilter === 'todo') return r === undefined;
          if (bankFilter === 'correct') return r === true;
          if (bankFilter === 'wrong') return r === false;
          return true;
        })
        .sort(() => Math.random() - 0.5)
        .slice(0, count);
      if (!picked.length) {
        setMessage({
          tone: 'warn',
          text:
            bankFilter === 'wrong'
              ? '这个筛选下没有题（没有做错过的）。换一个筛选，或先去生成一批新题。'
              : bankFilter === 'todo'
                ? '这个筛选下没有题（都做过了）。换"做错过的"再练，或生成新题。'
                : '这个筛选下没有题。',
        });
        return;
      }
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
          {/* 上次没答完的卷子：答到一半退出/切走的，从这里接着做 */}
          {unfinished && (
            <Card title="⏸ 有一次没答完的卷子">
              <div className="small muted" style={{ marginTop: 0 }}>
                {unfinished.paperTitle} · 开始于{' '}
                {new Date(unfinished.startedAt).toLocaleString('zh-CN')} · 已答的题都存着
              </div>
              <div className="btn-row" style={{ marginTop: 8 }}>
                <Button variant="primary" onClick={() => navigate(`/exam/${unfinished.id}`)}>
                  继续答题
                </Button>
              </div>
            </Card>
          )}
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
                      aria-label={`知识点「${p.name}」的题量`}
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
                <span className="small faint">按掌握度自动铺开</span>
              )}
            </div>
            {/* 题量：常用档位 + 自定义（用户反馈"只有一个 20 道不够灵活"） */}
            <div style={{ marginTop: 8 }}>
              <div className="small faint" style={{ marginBottom: 6 }}>
                要多少道？点一下按掌握度重新铺开（专挑弱的先练）：
              </div>
              <CountPicker busy={false} onPick={(n) => void refreshAdaptive(n)} />
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
                    aria-label={`题型「${QUESTION_TYPE_LABELS[t]}」的数量`}
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

          {/* 出题进度改由下面的「出题任务」卡片显示（有批次进度，比刷原始 JSON 清楚） */}

          <div className="action-bar">
            <Button
              variant="ghost"
              block
              disabled={!totalQuestions || !typeTotal || genActive}
              onClick={() => doGenerate(false)}
            >
              只生成题目
            </Button>
            <Button
              variant="accent"
              block
              disabled={!totalQuestions || !typeTotal || genActive}
              onClick={() => doGenerate(true)}
            >
              生成并开始答题
            </Button>
          </div>

          {/* 出题任务的状态与操作：切到别的页面也在跑，随时可以暂停/取消 */}
          {(genActive || gen.status === 'done' || gen.status === 'cancelled' || gen.status === 'error') && (
            <Card
              title="⏳ 出题任务"
              extra={
                <Badge tone={gen.status === 'error' ? undefined : 'primary'}>
                  {genActive ? (gen.status === 'paused' ? '已暂停' : '进行中') : gen.status === 'done' ? '已完成' : gen.status === 'cancelled' ? '已取消' : '失败'}
                </Badge>
              }
            >
              <div className="small">{gen.note || (genActive ? '正在准备…' : '')}</div>
              {gen.message && <Alert tone={gen.status === 'error' ? 'error' : 'warn'}>{gen.message}</Alert>}
              <div className="btn-row" style={{ marginTop: 8 }}>
                {gen.status === 'running' && (
                  <Button size="sm" variant="ghost" onClick={pauseGeneration}>
                    暂停
                  </Button>
                )}
                {gen.status === 'paused' && (
                  <Button size="sm" variant="primary" onClick={resumeGeneration}>
                    继续
                  </Button>
                )}
                {genActive && (
                  <Button size="sm" variant="danger" onClick={cancelGeneration}>
                    取消（保留已出的题）
                  </Button>
                )}
                {!genActive && (
                  <Button size="sm" variant="ghost" onClick={resetGeneration}>
                    知道了
                  </Button>
                )}
              </div>
              {genActive && (
                <p className="small faint" style={{ marginTop: 6, marginBottom: 0 }}>
                  可以放心切到别的页面，出题会继续；回来后进度还在。
                </p>
              )}
            </Card>
          )}

          <Card title="📚 题库直接练习" extra={<Badge>{bankCount} 道</Badge>}>
            <p className="small muted" style={{ marginTop: 0 }}>
              不调用大模型，直接从已有题目里抽题做，省 token 也更快。
              先选练哪一类（生成出来还没做的 / 做对过的 / 做错过的），再点题量。
            </p>
            <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
              {(
                [
                  ['todo', '还没做过的'],
                  ['correct', '做对过的'],
                  ['wrong', '做错过的'],
                  ['all', '全部'],
                ] as const
              ).map(([key, label]) => (
                <Button
                  key={key}
                  size="sm"
                  variant={bankFilter === key ? 'primary' : 'ghost'}
                  onClick={() => setBankFilter(key)}
                >
                  {label}
                </Button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => navigate('/wrong')}>
                只练错题本 ›
              </Button>
            </div>
            <CountPicker busy={busy === 'bank'} onPick={(n) => void practiceFromBank(n)} />
            <div className="btn-row" style={{ marginTop: 8 }}>
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
