/**
 * 答题页：做题 + 交卷批改。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { db, patchAnswer } from '../../lib/db/db';
import type { Attempt, Paper, Question } from '../../lib/db/types';
import { QUESTION_TYPE_LABELS, isObjective } from '../../lib/db/types';
import { finishAttempt, gradeOne } from '../../lib/services/grade';
import { recordAttempt } from '../../lib/services/practice';
import { loadDraftAnswers, saveDraftAnswers } from '../../lib/services/exam-draft';
import { Alert, Badge, Button, Card, Loading, Sheet } from '../../components/ui';

/** 学生作答的中间态：统一用字符串数组存 */
type Draft = Record<string, string[]>;

/** 草稿自动保存的防抖时长（毫秒） */
const AUTOSAVE_DELAY = 700;

function blankCount(q: Question): number {
  if (q.type !== 'blank') return 1;
  return Array.isArray(q.answer) && q.answer.length > 1 ? q.answer.length : 1;
}

export function ExamPage() {
  const { attemptId = '' } = useParams();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [draft, setDraft] = useState<Draft>({});
  const [index, setIndex] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [savedAt, setSavedAt] = useState(0);
  const [timeUp, setTimeUp] = useState(false);

  // 草稿自动保存。手机上随时可能切走、锁屏或被系统回收，
  // 答案不能只活在内存里。
  const draftRef = useRef<Draft>({});
  const dirty = useRef<Set<string>>(new Set());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 交卷开始后不再回写草稿，否则草稿会把批改结果覆盖掉
  const submitted = useRef(false);
  const autoSubmitted = useRef(false);

  const load = useCallback(async () => {
    const a = await db.attempts.get(attemptId);
    if (!a) {
      setError('找不到这次测验。');
      return;
    }
    setAttempt(a);
    const p = await db.papers.get(a.paperId);
    setPaper(p ?? null);
    if (p) {
      const qs = (await db.questions.bulkGet(p.questionIds)).filter(Boolean) as Question[];
      setQuestions(qs);
      // 恢复上次的草稿（也可能是上次交卷失败时留下的部分批改结果）
      const restored = await loadDraftAnswers(a.id);
      draftRef.current = restored;
      setDraft(restored);
    }
  }, [attemptId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // 已经交过卷就直接跳报告
  useEffect(() => {
    if (attempt?.finishedAt) navigate(`/report/${attempt.id}`, { replace: true });
  }, [attempt, navigate]);

  /** 把攒下的草稿写进数据库 */
  const flushDrafts = useCallback(async () => {
    if (!attempt || submitted.current) return;
    const ids = [...dirty.current];
    if (!ids.length) return;
    const payload: Record<string, string[]> = {};
    for (const qid of ids) payload[qid] = draftRef.current[qid] ?? [];
    try {
      await saveDraftAnswers(attempt.id, payload);
      // 写入成功才清脏标记；期间新产生的修改不会被误删
      for (const qid of ids) dirty.current.delete(qid);
      setSavedAt(Date.now());
    } catch {
      // 写库失败就保留脏标记，等下一次编辑或离开页面时重试，避免静默丢答案
    }
  }, [attempt]);

  // 离开页面或切到后台时立刻落盘，不等防抖
  useEffect(() => {
    const flush = () => {
      void flushDrafts();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      flush();
    };
  }, [flushDrafts]);

  const current = questions[index];
  const answeredCount = useMemo(
    () => questions.filter((q) => (draft[q.id] ?? []).some((v) => v.trim())).length,
    [questions, draft],
  );

  function setAnswer(qid: string, values: string[]) {
    draftRef.current = { ...draftRef.current, [qid]: values };
    setDraft(draftRef.current);
    dirty.current.add(qid);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void flushDrafts();
    }, AUTOSAVE_DELAY);
  }

  async function submit(force = false) {
    if (!attempt) return;
    if (!force) {
      const unanswered = questions.length - answeredCount;
      if (unanswered > 0 && !confirm(`还有 ${unanswered} 道题没做，确定交卷吗？`)) return;
    }

    setBusy(true);
    setError('');
    try {
      // 先把草稿全部落盘，再开始批改；批改结果用「合并写入」，
      // 所以半途失败也不会把没批改到的题弄丢。
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await flushDrafts();
      submitted.current = true;

      for (let i = 0; i < questions.length; i += 1) {
        const q = questions[i];
        const answer = draftRef.current[q.id] ?? [];
        setProgress(`正在批改 ${i + 1}/${questions.length}：${QUESTION_TYPE_LABELS[q.type]}`);
        const rec = await gradeOne(q, answer.filter((v) => v !== undefined));
        await patchAnswer(attempt.id, rec);
      }

      setProgress('正在生成学习报告…');
      const { attempt: finished } = await finishAttempt({
        attemptId: attempt.id,
        onProgress: () => setProgress('正在生成学习报告…'),
      });
      // 写入自进化引擎：掌握度、错题本、复习排程
      await recordAttempt(finished, questions);
      navigate(`/report/${finished.id}`, { replace: true });
    } catch (e) {
      // 放开 submitted，允许重试；此时未批改的题仍保留着草稿答案
      submitted.current = false;
      setError(
        `交卷过程中出错：${e instanceof Error ? e.message : String(e)}。` +
          '已批改的部分已保存，可以再点一次「交卷批改」继续。',
      );
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  // 限时卷时间到自动交卷
  useEffect(() => {
    if (!paper?.durationMin || submitted.current) return;
    if (elapsed >= paper.durationMin * 60) setTimeUp(true);
  }, [elapsed, paper]);

  useEffect(() => {
    if (!timeUp || autoSubmitted.current) return;
    autoSubmitted.current = true;
    void submit(true);
    // submit 每次渲染都会重建，这里只需要在 timeUp 翻转时触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeUp]);

  if (error && !questions.length) return <Alert tone="error">{error}</Alert>;
  if (!attempt || !paper) return <Loading />;
  if (!questions.length) return <Alert tone="warn">这份卷子里没有题目。</Alert>;

  const timeText = paper.durationMin
    ? formatTime(Math.max(0, paper.durationMin * 60 - elapsed))
    : formatTime(elapsed);

  return (
    <>
      {error && <Alert tone="error">{error}</Alert>}
      {timeUp && <Alert tone="warn">⏰ 时间到，正在自动交卷…</Alert>}

      <Card className="tight">
        <div className="row between">
          <div className="grow">
            <div className="small truncate">{paper.title}</div>
            <div className="small faint">
              已答 {answeredCount}/{questions.length} · 用时 {timeText}
              {savedAt > 0 && !busy && ' · 已自动保存'}
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setSheetOpen(true)}>
            答题卡
          </Button>
        </div>
        <div className="progress" style={{ marginTop: 8 }}>
          <i style={{ width: `${(answeredCount / questions.length) * 100}%` }} />
        </div>
      </Card>

      {/* ---------------- 题目 ---------------- */}
      <Card
        title={`第 ${index + 1} 题 · ${QUESTION_TYPE_LABELS[current.type]}`}
        extra={<Badge>难度 {'★'.repeat(current.difficulty)}</Badge>}
      >
        <div className="pre-wrap" style={{ marginBottom: 14, fontSize: 15.5 }}>
          {current.stem}
        </div>

        {/* 单选 */}
        {current.type === 'single' && (
          <div>
            {(current.options ?? []).map((o) => {
              const selected = (draft[current.id] ?? [])[0] === o.key;
              return (
                <div
                  key={o.key}
                  className={`option${selected ? ' selected' : ''}`}
                  onClick={() => setAnswer(current.id, [o.key])}
                >
                  <span className="key">{o.key}</span>
                  <span>{o.text}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* 多选 */}
        {current.type === 'multiple' && (
          <div>
            <p className="small faint" style={{ marginTop: 0 }}>
              多选题：选全才得分，漏选给一半分，选错不得分。
            </p>
            {(current.options ?? []).map((o) => {
              const arr = draft[current.id] ?? [];
              const selected = arr.includes(o.key);
              return (
                <div
                  key={o.key}
                  className={`option${selected ? ' selected' : ''}`}
                  onClick={() =>
                    setAnswer(
                      current.id,
                      selected ? arr.filter((k) => k !== o.key) : [...arr, o.key].sort(),
                    )
                  }
                >
                  <span className="key">{o.key}</span>
                  <span>{o.text}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* 判断 */}
        {current.type === 'judge' && (
          <div>
            {['正确', '错误'].map((v) => {
              const selected = (draft[current.id] ?? [])[0] === v;
              return (
                <div
                  key={v}
                  className={`option${selected ? ' selected' : ''}`}
                  onClick={() => setAnswer(current.id, [v])}
                >
                  <span className="key">{v === '正确' ? '✓' : '✗'}</span>
                  <span>{v}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* 填空 */}
        {current.type === 'blank' && (
          <div className="col">
            {Array.from({ length: blankCount(current) }).map((_, bi) => (
              <div key={bi} className="row">
                <span className="small muted" style={{ flex: '0 0 60px' }}>
                  第 {bi + 1} 空
                </span>
                <input
                  className="grow"
                  value={(draft[current.id] ?? [])[bi] ?? ''}
                  placeholder="填答案"
                  onChange={(e) => {
                    const arr = [...(draft[current.id] ?? [])];
                    while (arr.length < blankCount(current)) arr.push('');
                    arr[bi] = e.target.value;
                    setAnswer(current.id, arr);
                  }}
                />
              </div>
            ))}
          </div>
        )}

        {/* 简答 / 计算 */}
        {(current.type === 'short' || current.type === 'calc') && (
          <div>
            <p className="small faint" style={{ marginTop: 0 }}>
              {current.type === 'calc'
                ? '计算题：请写出完整步骤（公式→代入→结果），AI 会按步骤给分，思路对只错算式不会全扣。'
                : '简答题：分条作答，答到要点就有分。'}
            </p>
            <textarea
              rows={8}
              value={(draft[current.id] ?? [])[0] ?? ''}
              placeholder={current.type === 'calc' ? '解：\n① 已知…\n② 由公式…\n③ 代入得…' : '答：\n1. …\n2. …'}
              onChange={(e) => setAnswer(current.id, [e.target.value])}
            />
          </div>
        )}
      </Card>

      {/* ---------------- 翻页 / 交卷 ---------------- */}
      <div className="action-bar">
        <Button
          variant="ghost"
          block
          disabled={index === 0}
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
        >
          ‹ 上一题
        </Button>
        {index < questions.length - 1 && (
          <Button variant="primary" block onClick={() => setIndex((i) => i + 1)}>
            下一题 ›
          </Button>
        )}
        {/* 交卷入口始终可见：以前只在最后一题出现，答完第一题想直接交卷会找不到按钮 */}
        <Button variant="accent" block loading={busy} onClick={() => submit()}>
          {index < questions.length - 1 ? '交卷' : '交卷批改'}
        </Button>
      </div>

      {!busy && answeredCount < questions.length && (
        <div className="small faint" style={{ textAlign: 'center', marginTop: 8 }}>
          还有 {questions.length - answeredCount} 题没答
        </div>
      )}

      {busy && (
        <Card>
          <div className="row" style={{ gap: 10 }}>
            <span className="spinner" />
            <span className="small">{progress || '正在批改…'}</span>
          </div>
          <p className="small faint" style={{ marginBottom: 0 }}>
            客观题是本地判分（瞬间完成）；简答和计算题要逐个交给 AI 批改，请稍等。
          </p>
        </Card>
      )}

      {/* ---------------- 答题卡 ---------------- */}
      <Sheet open={sheetOpen} title="答题卡" onClose={() => setSheetOpen(false)}>
        <div className="sheet-grid">
          {questions.map((q, i) => {
            const done = (draft[q.id] ?? []).some((v) => v.trim());
            return (
              <button
                key={q.id}
                className={`${done ? 'answered ' : ''}${i === index ? 'current' : ''}`}
                onClick={() => {
                  setIndex(i);
                  setSheetOpen(false);
                }}
              >
                {i + 1}
              </button>
            );
          })}
        </div>
        <div className="btn-row" style={{ marginTop: 14 }}>
          <Button
            variant="accent"
            block
            loading={busy}
            onClick={() => {
              setSheetOpen(false);
              void submit();
            }}
          >
            交卷批改
          </Button>
        </div>
        {isObjective(current.type) && (
          <p className="small faint" style={{ marginTop: 10 }}>
            提示：客观题本地判分不花钱；只有简答/计算题会调用大模型。
          </p>
        )}
      </Sheet>
    </>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
