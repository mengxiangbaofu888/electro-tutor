/**
 * 答题页：做题 + 交卷批改。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { db } from '../../lib/db/db';
import type { AnswerRecord, Attempt, Paper, Question } from '../../lib/db/types';
import { QUESTION_TYPE_LABELS, isObjective } from '../../lib/db/types';
import { finishAttempt, gradeOne, toAnswerArray } from '../../lib/services/grade';
import { recordAttempt } from '../../lib/services/practice';
import { Alert, Badge, Button, Card, Loading, Sheet } from '../../components/ui';

/** 学生作答的中间态：统一用字符串数组存 */
type Draft = Record<string, string[]>;

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
      // 恢复已有草稿
      const restored: Draft = {};
      for (const q of qs) {
        const rec = a.answers.find((x) => x.questionId === q.id);
        if (rec) restored[q.id] = toAnswerArray(rec.userAnswer);
      }
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

  const current = questions[index];
  const answeredCount = useMemo(
    () => questions.filter((q) => (draft[q.id] ?? []).some((v) => v.trim())).length,
    [questions, draft],
  );

  function setAnswer(qid: string, values: string[]) {
    setDraft((prev) => ({ ...prev, [qid]: values }));
  }

  async function submit() {
    if (!attempt) return;
    const unanswered = questions.length - answeredCount;
    if (unanswered > 0 && !confirm(`还有 ${unanswered} 道题没做，确定交卷吗？`)) return;

    setBusy(true);
    setError('');
    const records: AnswerRecord[] = [];
    try {
      for (let i = 0; i < questions.length; i += 1) {
        const q = questions[i];
        const answer = draft[q.id] ?? [];
        setProgress(`正在批改 ${i + 1}/${questions.length}：${QUESTION_TYPE_LABELS[q.type]}`);
        const rec = await gradeOne(q, answer.filter((v) => v !== undefined));
        records.push(rec);
        // 边批边存，避免中途失败全丢
        await db.attempts.update(attempt.id, { answers: [...records] });
      }
      setProgress('正在生成学习报告…');
      await db.attempts.update(attempt.id, { answers: records });
      const { attempt: finished } = await finishAttempt({
        attemptId: attempt.id,
        onProgress: () => setProgress('正在生成学习报告…'),
      });
      // 写入自进化引擎
      const paperRow = await db.papers.get(finished.paperId);
      if (paperRow) {
        await recordAttempt(finished, questions);
        await db.papers.update(paperRow.id, {}); // 触发一次写入，保证索引同步
      }
      navigate(`/report/${finished.id}`, { replace: true });
    } catch (e) {
      setError(`交卷过程中出错：${e instanceof Error ? e.message : String(e)}。已批改的部分已保存，可以再点一次交卷。`);
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  if (error && !questions.length) return <Alert tone="error">{error}</Alert>;
  if (!attempt || !paper) return <Loading />;
  if (!questions.length) return <Alert tone="warn">这份卷子里没有题目。</Alert>;

  const timeText = paper.durationMin
    ? formatTime(Math.max(0, paper.durationMin * 60 - elapsed))
    : formatTime(elapsed);

  return (
    <>
      {error && <Alert tone="error">{error}</Alert>}

      <Card className="tight">
        <div className="row between">
          <div className="grow">
            <div className="small truncate">{paper.title}</div>
            <div className="small faint">
              已答 {answeredCount}/{questions.length} · 用时 {timeText}
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

      {/* ---------------- 翻页 ---------------- */}
      <div className="action-bar">
        <Button
          variant="ghost"
          block
          disabled={index === 0}
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
        >
          ‹ 上一题
        </Button>
        {index < questions.length - 1 ? (
          <Button variant="primary" block onClick={() => setIndex((i) => i + 1)}>
            下一题 ›
          </Button>
        ) : (
          <Button variant="accent" block loading={busy} onClick={submit}>
            交卷批改
          </Button>
        )}
      </div>

      {index === questions.length - 1 && !busy && (
        <div style={{ marginTop: 10 }}>
          <Button variant="accent" block loading={busy} onClick={submit}>
            ✅ 交卷并批改（还有 {questions.length - answeredCount} 题未答）
          </Button>
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
