/**
 * 错题本：所有做错的题集中在这里，连续答对两次自动移出。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../../lib/db/db';
import type { MistakeNote, Question } from '../../lib/db/types';
import { QUESTION_TYPE_LABELS } from '../../lib/db/types';
import { startQuickPractice } from '../../lib/services/quiz';
import { getQuestions } from '../../lib/services/grade';
import { Alert, Badge, Button, Card, Empty, Loading } from '../../components/ui';
import { Markdown } from '../../components/Markdown';

interface Row {
  note: MistakeNote;
  question: Question;
  points: string[];
}

export function WrongBookPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [onlyUnresolved, setOnlyUnresolved] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const notes = await db.mistakes.toArray();
    const questions = await getQuestions(notes.map((n) => n.questionId));
    const qById = new Map(questions.map((q) => [q.id, q]));
    const pointIds = [...new Set(questions.flatMap((q) => q.knowledgePointIds))];
    const points = pointIds.length ? await db.knowledgePoints.bulkGet(pointIds) : [];
    const nameById = new Map(
      points.filter((p): p is NonNullable<typeof p> => Boolean(p)).map((p) => [p.id, p.name]),
    );

    const list: Row[] = [];
    for (const n of notes) {
      const q = qById.get(n.questionId);
      if (!q) continue;
      list.push({
        note: n,
        question: q,
        points: q.knowledgePointIds.map((id) => nameById.get(id) ?? '未分类'),
      });
    }
    list.sort((a, b) => b.note.lastWrongAt - a.note.lastWrongAt);
    setRows(list);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function practiceWrong(list: Row[]) {
    if (!list.length) return;
    setBusy('practice');
    setError('');
    try {
      const next = await startQuickPractice({
        title: `错题重做 · ${new Date().toLocaleDateString('zh-CN')}`,
        questions: list.map((r) => r.question),
      });
      navigate(`/exam/${next.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }

  if (!rows) return <Loading />;

  const visible = onlyUnresolved ? rows.filter((r) => !r.note.resolved) : rows;
  const unresolvedCount = rows.filter((r) => !r.note.resolved).length;

  return (
    <>
      {error && <Alert tone="error">{error}</Alert>}

      <Card
        title="📕 错题本"
        extra={
          <Button size="sm" variant="ghost" onClick={() => setOnlyUnresolved((v) => !v)}>
            {onlyUnresolved ? '显示全部' : '只看未掌握'}
          </Button>
        }
      >
        <div className="stats">
          <div className="stat">
            <b>{unresolvedCount}</b>
            <span>待攻克</span>
          </div>
          <div className="stat">
            <b>{rows.length}</b>
            <span>累计错题</span>
          </div>
          <div className="stat">
            <b>{rows.length - unresolvedCount}</b>
            <span>已攻克</span>
          </div>
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>
          规则：做错的题进错题本；连续答对 2 次才算真正掌握，会自动移出。
        </p>
        <div className="btn-row">
          <Button
            variant="accent"
            loading={busy === 'practice'}
            disabled={!visible.length}
            onClick={() => practiceWrong(visible)}
          >
            🔁 重做这些错题（{visible.length}）
          </Button>
          <Button variant="ghost" disabled={!visible.length} onClick={() => practiceWrong(visible.slice(0, 5))}>
            只练前 5 道
          </Button>
        </div>
      </Card>

      {visible.length === 0 ? (
        <Card>
          <Empty
            icon="🎉"
            text={rows.length ? '错题都攻克了！' : '错题本还是空的'}
            hint={rows.length ? '继续保持' : '做题做错之后会自动收录到这里'}
          />
        </Card>
      ) : (
        visible.map((r) => (
          <Card key={r.note.id}>
            <div className="row between">
              <div className="row" style={{ gap: 6 }}>
                <Badge tone={r.note.resolved ? 'ok' : 'bad'}>
                  {r.note.resolved ? '已攻克' : `错 ${r.note.wrongCount} 次`}
                </Badge>
                <Badge>{QUESTION_TYPE_LABELS[r.question.type]}</Badge>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await db.mistakes.delete(r.note.id);
                  await load();
                }}
              >
                移出
              </Button>
            </div>

            <div className="pre-wrap small" style={{ marginTop: 10 }}>
              {r.question.stem}
            </div>
            {r.question.options && (
              <div className="small muted" style={{ marginTop: 6 }}>
                {r.question.options.map((o) => (
                  <div key={o.key}>
                    {o.key}. {o.text}
                  </div>
                ))}
              </div>
            )}

            <div className="divider" />
            <div className="small">
              <span className="muted">正确答案：</span>
              <span style={{ color: 'var(--ok)' }}>
                {Array.isArray(r.question.answer) ? r.question.answer.join(' / ') : r.question.answer}
              </span>
            </div>
            {r.points.length > 0 && (
              <div className="row wrap" style={{ marginTop: 6 }}>
                {r.points.map((p) => (
                  <Badge key={p}>{p}</Badge>
                ))}
              </div>
            )}
            <details style={{ marginTop: 8 }}>
              <summary className="small muted" style={{ cursor: 'pointer' }}>
                看解析
              </summary>
              <div className="small" style={{ marginTop: 6 }}>
                <Markdown text={r.question.explanation || '（无解析）'} />
              </div>
            </details>
          </Card>
        ))
      )}
    </>
  );
}
