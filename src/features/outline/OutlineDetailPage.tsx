/**
 * 大纲详情：查看/编辑知识点树，并从这里去出题。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { db } from '../../lib/db/db';
import type { KnowledgePoint, Outline } from '../../lib/db/types';
import { TRACK_LABELS } from '../../lib/db/types';
import {
  addKnowledgePoint,
  buildTree,
  getOutlinePoints,
  removeKnowledgePoint,
  updateKnowledgePoint,
  type PointNode,
} from '../../lib/services/outline';
import { currentScore } from '../../lib/srs';
import { generateMicroLesson } from '../../lib/services/practice';
import { bankCsvTemplate, exportQuestionsCsv, importQuestionsCsv } from '../../lib/services/bank';
import { Alert, Badge, Button, Card, Empty, Field, Loading, Sheet, TextArea, TextInput } from '../../components/ui';
import { Markdown } from '../../components/Markdown';

/** 触发浏览器下载一段文本 */
function downloadText(text: string, filename: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function OutlineDetailPage() {
  const { outlineId = '' } = useParams();
  const navigate = useNavigate();
  const [outline, setOutline] = useState<Outline | null>(null);
  const [points, setPoints] = useState<KnowledgePoint[] | null>(null);
  const [mastery, setMastery] = useState<Map<string, number>>(new Map());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<KnowledgePoint | null>(null);
  const [adding, setAdding] = useState<{ parentId?: string } | null>(null);
  const [message, setMessage] = useState('');
  // 「让老师讲一遍」：按需为任意知识点生成一段讲解
  const [lesson, setLesson] = useState<{ title: string; body: string } | null>(null);
  const [explaining, setExplaining] = useState('');
  const [lessonStream, setLessonStream] = useState('');
  const [lessonError, setLessonError] = useState('');
  // 题库导入导出
  const [bankBusy, setBankBusy] = useState('');
  const [bankMsg, setBankMsg] = useState('');

  /** 把这份大纲的题库导出成 CSV */
  async function exportBank() {
    if (!outline) return;
    setBankBusy('export');
    setBankMsg('');
    try {
      const { csv, count } = await exportQuestionsCsv(outline.id);
      if (!count) {
        setBankMsg('这份大纲下还没有题目，先把题生成出来再导出。');
        return;
      }
      downloadText(csv, `${outline.title}-题库-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8');
      setBankMsg(`已导出 ${count} 道题（UTF-8 CSV，Excel / WPS 可直接打开）。`);
    } catch (e) {
      setBankMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBankBusy('');
    }
  }

  /** 从 CSV 导入题库到这份大纲 */
  async function importBank(file: File) {
    if (!outline) return;
    setBankBusy('import');
    setBankMsg('');
    try {
      const text = await file.text();
      const res = await importQuestionsCsv({
        text,
        outlineId: outline.id,
        onProgress: (done, total) => setBankMsg(`正在导入 ${done}/${total}…`),
      });
      if (!res.imported) {
        setBankMsg(res.warnings.join('\n') || '没有导入任何题目。');
        return;
      }
      setBankMsg([`成功导入 ${res.imported} 道题。`, ...res.warnings].join('\n'));
      await load();
    } catch (e) {
      setBankMsg(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBankBusy('');
    }
  }

  const load = useCallback(async () => {
    if (!outlineId) return;
    const o = await db.outlines.get(outlineId);
    setOutline(o ?? null);
    const ps = await getOutlinePoints(outlineId);
    setPoints(ps);
    const records = await db.mastery.bulkGet(ps.map((p) => p.id));
    const now = Date.now();
    const map = new Map<string, number>();
    records.forEach((r, i) => {
      if (r) map.set(ps[i].id, currentScore(r, now));
    });
    setMastery(map);
  }, [outlineId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 让大模型针对某个知识点写一段讲解（不需要先做错题） */
  async function explain(point: KnowledgePoint) {
    setExplaining(point.id);
    setLesson(null);
    setLessonStream('');
    setLessonError('');
    try {
      const draft = await generateMicroLesson({
        pointId: point.id,
        track: outline?.track ?? 'fundamental',
        onProgress: (d) => setLessonStream((prev) => (prev + d).slice(-2000)),
      });
      setLesson({ title: draft.title, body: draft.body });
    } catch (e) {
      setLessonError(e instanceof Error ? e.message : String(e));
    } finally {
      setExplaining('');
      setLessonStream('');
    }
  }

  if (!points || !outline) return <Loading />;

  const tree = buildTree(points);
  const leafCount = points.filter((p) => !points.some((c) => c.parentId === p.id)).length;

  function renderNode(node: PointNode, isLast: boolean) {
    void isLast;
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(node.id);
    const score = mastery.get(node.id);
    return (
      <div key={node.id} className="tree-node">
        <div className="tree-row">
          {hasChildren ? (
            <button
              className="tree-toggle"
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(node.id)) next.delete(node.id);
                  else next.add(node.id);
                  return next;
                })
              }
            >
              {isCollapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="tree-toggle" style={{ opacity: 0.4 }}>
              ·
            </span>
          )}
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 6 }}>
              <span className="small" style={{ fontWeight: hasChildren ? 600 : 400 }}>
                {node.name}
              </span>
              {node.importance >= 4 && <Badge tone="primary">重点</Badge>}
              {typeof score === 'number' && (
                <Badge tone={score >= 0.8 ? 'ok' : score < 0.5 ? 'bad' : 'warn'}>
                  {Math.round(score * 100)}%
                </Badge>
              )}
            </div>
            {node.summary && <div className="small faint">{node.summary}</div>}
          </div>
          <div className="row" style={{ gap: 4 }}>
            <button
              className="tree-toggle"
              title="让老师讲一遍这个知识点"
              disabled={explaining === node.id}
              onClick={() => explain(node)}
            >
              讲
            </button>
            <button className="tree-toggle" title="添加子知识点" onClick={() => setAdding({ parentId: node.id })}>
              ＋
            </button>
            <button className="tree-toggle" title="编辑" onClick={() => setEditing(node)}>
              ✎
            </button>
            <button
              className="tree-toggle"
              title="删除"
              onClick={async () => {
                if (!confirm(`删除「${node.name}」及其所有子知识点？`)) return;
                await removeKnowledgePoint(node.id);
                await load();
              }}
            >
              ✕
            </button>
          </div>
        </div>
        {hasChildren && !isCollapsed && <div>{node.children.map((c) => renderNode(c, false))}</div>}
      </div>
    );
  }

  return (
    <>
      {message && <Alert tone="ok">{message}</Alert>}

      <Card
        title={outline.title}
        extra={<Badge tone="primary">{TRACK_LABELS[outline.track]}</Badge>}
      >
        <div className="stats">
          <div className="stat">
            <b>{points.length}</b>
            <span>知识点</span>
          </div>
          <div className="stat">
            <b>{leafCount}</b>
            <span>可出题项</span>
          </div>
          <div className="stat">
            <b>{mastery.size}</b>
            <span>已练过</span>
          </div>
        </div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <Button variant="accent" onClick={() => navigate(`/practice?outlineId=${outline.id}`)}>
            ✏️ 用这份大纲出题
          </Button>
          <Button variant="ghost" onClick={() => setAdding({})}>
            ＋ 新增顶层知识点
          </Button>
        </div>
      </Card>

      <Card title="🌳 知识点树" extra={<span className="small faint">点「讲」让老师讲一遍</span>}>
        {points.length === 0 ? (
          <Empty icon="🌳" text="这份大纲还没有知识点" hint="重新生成，或手动添加" />
        ) : (
          <div>{tree.map((n) => renderNode(n, false))}</div>
        )}
      </Card>

      {/* 题库导入导出 */}
      <Card title="📥 题库导入 / 导出">
        <p className="small muted" style={{ marginTop: 0 }}>
          找到现成的题库时（比如低压电工证的官方题库），整理成 CSV 就能导进来刷。
          表头认中英文、列顺序随意。填空题多个空用 <code>;</code> 分隔，
          同一个空的多种写法用 <code>|</code> 分隔。
        </p>
        {bankMsg && <Alert>{bankMsg}</Alert>}
        <div className="btn-row">
          <label className="btn primary">
            导入 CSV
            <input
              type="file"
              accept=".csv,.txt"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importBank(f);
                e.target.value = '';
              }}
            />
          </label>
          <Button loading={bankBusy === 'export'} onClick={exportBank}>
            导出这份大纲的题库
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              downloadText(bankCsvTemplate(), '题库导入模板.csv', 'text/csv;charset=utf-8');
              setBankMsg('模板已下载，用 Excel / WPS 打开照着填就行。');
            }}
          >
            下载导入模板
          </Button>
        </div>
      </Card>

      {/* 编辑弹层 */}
      <Sheet open={Boolean(editing)} title="编辑知识点" onClose={() => setEditing(null)}>
        {editing && (
          <>
            <Field label="名称">
              <TextInput value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} />
            </Field>
            <Field label="说明" hint="一句话讲清这是啥、为什么学">
              <TextArea
                rows={2}
                value={editing.summary ?? ''}
                onChange={(v) => setEditing({ ...editing, summary: v })}
              />
            </Field>
            <Field label={`重要度：${editing.importance}`}>
              <input
                type="range"
                min={1}
                max={5}
                value={editing.importance}
                onChange={(e) => setEditing({ ...editing, importance: Number(e.target.value) })}
              />
            </Field>
            <div className="btn-row">
              <Button
                variant="primary"
                onClick={async () => {
                  await updateKnowledgePoint(editing.id, {
                    name: editing.name,
                    summary: editing.summary,
                    importance: editing.importance,
                  });
                  setEditing(null);
                  setMessage('已保存。');
                  await load();
                }}
              >
                保存
              </Button>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                取消
              </Button>
            </div>
          </>
        )}
      </Sheet>

      {/* 新增弹层 */}
      <Sheet open={Boolean(adding)} title="新增知识点" onClose={() => setAdding(null)}>
        {adding && <AddPointForm parentId={adding.parentId} outlineId={outline.id} onDone={async () => { setAdding(null); setMessage('已添加。'); await load(); }} />}
      </Sheet>

      {/* 讲解弹层：不需要先做错题，直接针对知识点问 */}
      <Sheet
        open={Boolean(explaining) || Boolean(lesson) || Boolean(lessonError)}
        title={lesson?.title ?? (lessonError ? '讲解生成失败' : '老师正在备课…')}
        onClose={() => {
          setLesson(null);
          setLessonError('');
          setExplaining('');
          setLessonStream('');
        }}
      >
        {explaining && (
          <>
            <div className="row" style={{ gap: 10, marginBottom: 12 }}>
              <span className="spinner" />
              <span className="small">正在针对这个知识点写讲解…</span>
            </div>
            {lessonStream && (
              <div className="small mono pre-wrap" style={{ maxHeight: 160, overflowY: 'auto' }}>
                {lessonStream}
              </div>
            )}
          </>
        )}
        {lessonError && <Alert tone="error">{lessonError}</Alert>}
        {lesson && <Markdown text={lesson.body} />}
        {lesson && (
          <div className="btn-row" style={{ marginTop: 14 }}>
            <Button
              variant="primary"
              onClick={() => {
                setLesson(null);
              }}
            >
              看完了
            </Button>
          </div>
        )}
      </Sheet>
    </>
  );
}

function AddPointForm({
  outlineId,
  parentId,
  onDone,
}: {
  outlineId: string;
  parentId?: string;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [importance, setImportance] = useState(3);
  return (
    <>
      <Field label="知识点名称">
        <TextInput value={name} onChange={setName} placeholder="例如：星三角降压启动的接线" />
      </Field>
      <Field label="说明">
        <TextArea rows={2} value={summary} onChange={setSummary} />
      </Field>
      <Field label={`重要度：${importance}`}>
        <input
          type="range"
          min={1}
          max={5}
          value={importance}
          onChange={(e) => setImportance(Number(e.target.value))}
        />
      </Field>
      <Button
        variant="primary"
        block
        disabled={!name.trim()}
        onClick={async () => {
          await addKnowledgePoint({ outlineId, parentId, name: name.trim(), summary, importance });
          onDone();
        }}
      >
        添加
      </Button>
    </>
  );
}
