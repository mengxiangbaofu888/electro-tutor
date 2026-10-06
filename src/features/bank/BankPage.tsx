/**
 * 题库页：所有生成出来 / 导入进来的题，都在这里能**看见**。
 *
 * 起因（用户原话，骂得对）：
 *   "已经生成但是还没有做的题你保存到哪儿了？在练习里点还没做过的题啥也没有。
 *    已经生成出来了我去哪儿找？你藏那么深干什么？这个软件主要目标就是刷题用的。"
 *
 * 之前"还没做过的/做对过的/做错过的"只是一组**抽样筛选**，界面上根本不显示题目本身 ——
 * 这是设计错误。现在这道题在这里逐条列出来：默认就看"还没做过的"，
 * 每题可以单独练，也可以把当前筛选的一批做成一次练习。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../../lib/db/db';
import type { Question } from '../../lib/db/types';
import { QUESTION_TYPE_LABELS } from '../../lib/db/types';
import { listAllQuestions, createPaper, startAttempt } from '../../lib/services/quiz';
import { Alert, Badge, Button, Card, Empty, Loading } from '../../components/ui';

type Filter = 'todo' | 'correct' | 'wrong' | 'all';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'todo', label: '还没做过' },
  { key: 'correct', label: '做对过' },
  { key: 'wrong', label: '做错过' },
  { key: 'all', label: '全部' },
];

/** 一次列表最多渲染多少条（题库大了不卡；抽题练习不受这个限制） */
const RENDER_LIMIT = 100;

export function BankPage() {
  const navigate = useNavigate();
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [lastResult, setLastResult] = useState<Map<string, boolean>>(new Map());
  const [filter, setFilter] = useState<Filter>('todo');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [qs, attempts] = await Promise.all([listAllQuestions(), db.attempts.toArray()]);
    const result = new Map<string, boolean>();
    for (const a of attempts) {
      for (const rec of a.answers ?? []) {
        if (typeof rec.isCorrect === 'boolean') result.set(rec.questionId, rec.isCorrect);
      }
    }
    setLastResult(result);
    setQuestions([...qs].sort((a, b) => b.createdAt - a.createdAt));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const c = { todo: 0, correct: 0, wrong: 0, all: 0 };
    for (const q of questions ?? []) {
      const r = lastResult.get(q.id);
      c.all += 1;
      if (r === undefined) c.todo += 1;
      else if (r === true) c.correct += 1;
      else c.wrong += 1;
    }
    return c;
  }, [questions, lastResult]);

  const filtered = useMemo(() => {
    return (questions ?? []).filter((q) => {
      const r = lastResult.get(q.id);
      if (filter === 'todo') return r === undefined;
      if (filter === 'correct') return r === true;
      if (filter === 'wrong') return r === false;
      return true;
    });
  }, [questions, lastResult, filter]);

  /** 单练一题：一张只有这一题的卷子，立刻开始 */
  async function practiceOne(q: Question) {
    setBusy(q.id);
    setMessage(null);
    try {
      const paper = await createPaper({
        title: `单题练习 · ${new Date().toLocaleDateString('zh-CN')}`,
        questionIds: [q.id],
        durationMin: 0,
        outlineId: q.outlineId,
      });
      const attempt = await startAttempt(paper);
      navigate(`/exam/${attempt.id}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setBusy('');
    }
  }

  /** 把当前筛选的一批题做成一次练习（最多 50 道，防止一卷太大） */
  async function practiceFiltered() {
    setBusy('batch');
    setMessage(null);
    try {
      const picked = filtered.slice(0, 50);
      if (!picked.length) {
        setMessage('当前筛选下一道题都没有。');
        return;
      }
      const paper = await createPaper({
        title: `题库练习 · ${FILTERS.find((f) => f.key === filter)?.label ?? ''} · ${new Date().toLocaleDateString('zh-CN')}`,
        questionIds: picked.map((q) => q.id),
        durationMin: 0,
        outlineId: picked[0].outlineId,
      });
      const attempt = await startAttempt(paper);
      navigate(`/exam/${attempt.id}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  if (questions === null) return <Loading />;

  return (
    <>
      {message && <Alert tone="warn">{message}</Alert>}

      <Card title="📚 题库" extra={<Badge>{counts.all} 道</Badge>}>
        <p className="small muted" style={{ marginTop: 0 }}>
          这里是**所有题目**：生成出来的、导入进来的都在。默认看「还没做过」的。
        </p>
        <div className="row wrap" style={{ gap: 6 }}>
          {FILTERS.map((f) => (
            <Button
              key={f.key}
              size="sm"
              variant={filter === f.key ? 'primary' : 'ghost'}
              onClick={() => setFilter(f.key)}
            >
              {f.label} {counts[f.key]}
            </Button>
          ))}
        </div>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <Button variant="primary" loading={busy === 'batch'} disabled={!filtered.length} onClick={() => void practiceFiltered()}>
            把当前筛选的题做成一次练习{filtered.length > 50 ? '（前 50 道）' : ''}
          </Button>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Empty
          icon="🗃️"
          text={
            filter === 'todo'
              ? '所有题都做过了。可以点「做错过」复习错题，或去「练习」生成新题。'
              : filter === 'wrong'
                ? '还没有做错过的题。'
                : '题库是空的：先去「练习」生成一批，或用「材料」导入。'
          }
          hint="换个筛选看看，或去「练习」页生成新题。"
        />
      ) : (
        <div className="col" style={{ gap: 8 }}>
          {filtered.slice(0, RENDER_LIMIT).map((q) => {
            const r = lastResult.get(q.id);
            return (
              <div key={q.id} className="card tight" style={{ margin: 0 }}>
                <div className="row between" style={{ gap: 8 }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6, marginBottom: 2 }}>
                      <Badge>{QUESTION_TYPE_LABELS[q.type]}</Badge>
                      {r === undefined ? (
                        <Badge>还没做过</Badge>
                      ) : r ? (
                        <Badge tone="primary">答对过</Badge>
                      ) : (
                        <Badge tone="warn">答错过</Badge>
                      )}
                    </div>
                    <div className="small" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {q.stem}
                    </div>
                  </div>
                  <Button size="sm" variant="primary" loading={busy === q.id} onClick={() => void practiceOne(q)}>
                    练这题
                  </Button>
                </div>
              </div>
            );
          })}
          {filtered.length > RENDER_LIMIT && (
            <div className="small faint">
              共 {filtered.length} 道，只显示前 {RENDER_LIMIT} 道。用上面的筛选缩小范围，
              或点「做成一次练习」直接开做。
            </div>
          )}
        </div>
      )}
    </>
  );
}
