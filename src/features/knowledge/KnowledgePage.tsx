/**
 * 掌握度地图：每个知识点的掌握情况 + 复习负载预测 + 补强微讲义。
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { db, getDefaultLLM } from '../../lib/db/db';
import type { KnowledgePoint, Outline, TrackId } from '../../lib/db/types';
import { TRACK_LABELS } from '../../lib/db/types';
import { currentScore } from '../../lib/srs';
import { generateMicroLesson, getForecast, listMicroLessons } from '../../lib/services/practice';
import { listOutlines } from '../../lib/services/outline';
import { Alert, Badge, Button, Card, Empty, Loading, Progress, Select, Sheet } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import type { MicroLessonRow } from '../../lib/db/types';

interface PointRow {
  point: KnowledgePoint;
  score: number;
  attempts: number;
  correct: number;
  dueAt: number;
}

export function KnowledgePage() {
  const [params, setParams] = useSearchParams();
  const [outlines, setOutlines] = useState<Outline[] | null>(null);
  const [outlineId, setOutlineId] = useState('');
  const [rows, setRows] = useState<PointRow[]>([]);
  const [forecast, setForecast] = useState<Record<string, number>>({});
  const [lessons, setLessons] = useState<MicroLessonRow[]>([]);
  const [busy, setBusy] = useState('');
  const [stream, setStream] = useState('');
  const [lesson, setLesson] = useState<{ title: string; body: string } | null>(null);
  const [error, setError] = useState('');
  const [hasModel, setHasModel] = useState(true);
  const [sortBy, setSortBy] = useState<'weak' | 'order'>('weak');
  const [showLessons, setShowLessons] = useState(false);

  const load = useCallback(async () => {
    const [os, cfg] = await Promise.all([listOutlines(), getDefaultLLM('text')]);
    setOutlines(os);
    setHasModel(Boolean(cfg));
    setForecast(await getForecast(14));
    setLessons(await listMicroLessons());
    return os;
  }, []);

  useEffect(() => {
    void (async () => {
      const os = await load();
      if (!outlineId && os[0]) setOutlineId(os[0].id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const loadPoints = useCallback(async (oid: string) => {
    if (!oid) {
      setRows([]);
      return;
    }
    const points = (await db.knowledgePoints.where('outlineId').equals(oid).toArray()).sort(
      (a, b) => a.order - b.order,
    );
    const records = await db.mastery.bulkGet(points.map((p) => p.id));
    const now = Date.now();
    setRows(
      points.map((p, i) => {
        const r = records[i];
        return {
          point: p,
          score: r ? currentScore(r, now) : 0,
          attempts: r?.attempts ?? 0,
          correct: r?.correct ?? 0,
          dueAt: r?.dueAt ?? 0,
        };
      }),
    );
  }, []);

  useEffect(() => {
    void loadPoints(outlineId);
  }, [outlineId, loadPoints]);

  // 从别的页面带 ?point= 过来时，自动打开该知识点的补强讲义
  useEffect(() => {
    const pid = params.get('point');
    if (pid && rows.length && hasModel) {
      setParams({}, { replace: true });
      void makeLesson(pid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, params]);

  async function makeLesson(pointId: string) {
    if (!hasModel) {
      setError('还没有配置文本大模型，无法生成讲义。');
      return;
    }
    setBusy(pointId);
    setStream('');
    setError('');
    setLesson(null);
    try {
      const outline = outlines?.find((o) => o.id === outlineId);
      const draft = await generateMicroLesson({
        pointId,
        track: (outline?.track ?? 'fundamental') as TrackId,
        onProgress: (d) => setStream((prev) => (prev + d).slice(-2000)),
      });
      setLesson({ title: draft.title, body: draft.body });
      setLessons(await listMicroLessons());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
      setStream('');
    }
  }

  if (!outlines) return <Loading />;

  const sorted = [...rows].sort((a, b) =>
    sortBy === 'weak' ? a.score - b.score : a.point.order - b.point.order,
  );
  const mastered = rows.filter((r) => r.score >= 0.8).length;
  const untouched = rows.filter((r) => r.attempts === 0).length;
  const forecastEntries = Object.entries(forecast).slice(0, 8);

  return (
    <>
      {!hasModel && <Alert tone="warn">还没有配置文本大模型，补强讲义生成不了。</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      <Card title="🧭 总体掌握情况">
        <div className="stats">
          <div className="stat">
            <b>{rows.length}</b>
            <span>知识点</span>
          </div>
          <div className="stat">
            <b>{mastered}</b>
            <span>已掌握</span>
          </div>
          <div className="stat">
            <b>{untouched}</b>
            <span>没练过</span>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <div className="row between small muted">
            <span>整体进度</span>
            <span>{rows.length ? Math.round((mastered / rows.length) * 100) : 0}%</span>
          </div>
          <Progress value={rows.length ? mastered / rows.length : 0} tone="ok" />
        </div>
      </Card>

      {/* ---------------- 复习负载 ---------------- */}
      {forecastEntries.length > 0 && (
        <Card title="📅 未来复习安排">
          <p className="small muted" style={{ marginTop: 0 }}>
            遗忘曲线算出来的复习计划，照着做就能记住。
          </p>
          <div className="col">
            {forecastEntries.map(([date, count]) => (
              <div key={date} className="row between">
                <span className="small">{formatDate(date)}</span>
                <div className="row" style={{ gap: 8 }}>
                  <Badge tone={count > 8 ? 'warn' : undefined}>{count} 个知识点</Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ---------------- 知识点掌握度 ---------------- */}
      <Card
        title="📊 知识点掌握度"
        extra={
          <div className="row" style={{ gap: 6 }}>
            <Button size="sm" variant={sortBy === 'weak' ? 'primary' : 'ghost'} onClick={() => setSortBy('weak')}>
              按薄弱
            </Button>
            <Button size="sm" variant={sortBy === 'order' ? 'primary' : 'ghost'} onClick={() => setSortBy('order')}>
              按顺序
            </Button>
          </div>
        }
      >
        {outlines.length > 1 && (
          <Select
            value={outlineId}
            onChange={setOutlineId}
            options={outlines.map((o) => ({ value: o.id, label: `${o.title}（${TRACK_LABELS[o.track]}）` }))}
          />
        )}

        {rows.length === 0 ? (
          <Empty icon="🗺️" text="还没有知识点" hint="先去「材料」导入内容并生成大纲" />
        ) : (
          <div className="col" style={{ marginTop: 10 }}>
            {sorted.map((r) => (
              <div key={r.point.id} className="card tight" style={{ margin: 0 }}>
                <div className="row between">
                  <span className="small grow">{r.point.name}</span>
                  {r.attempts === 0 ? (
                    <Badge>没练过</Badge>
                  ) : (
                    <Badge tone={r.score >= 0.8 ? 'ok' : r.score < 0.5 ? 'bad' : 'warn'}>
                      {Math.round(r.score * 100)}%
                    </Badge>
                  )}
                </div>
                <div style={{ marginTop: 6 }}>
                  <Progress value={r.score} tone={r.score >= 0.8 ? 'ok' : r.score < 0.5 ? 'bad' : undefined} />
                </div>
                <div className="row between" style={{ marginTop: 6 }}>
                  <span className="small faint">
                    {r.attempts ? `练过 ${r.attempts} 次 · 对 ${r.correct} 次` : '还没有练习记录'}
                    {r.dueAt > 0 && ` · ${r.dueAt <= Date.now() ? '该复习了' : `下次复习 ${formatDate(new Date(r.dueAt).toISOString().slice(0, 10))}`}`}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === r.point.id}
                    onClick={() => makeLesson(r.point.id)}
                  >
                    补强讲义
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ---------------- 已生成的讲义 ---------------- */}
      <Card
        title="📖 我的补强讲义"
        extra={
          lessons.length ? (
            <Button size="sm" variant="ghost" onClick={() => setShowLessons((v) => !v)}>
              {showLessons ? '收起' : `展开 ${lessons.length} 篇`}
            </Button>
          ) : (
            <Badge>0</Badge>
          )
        }
      >
        {lessons.length === 0 ? (
          <Empty icon="📖" text="还没有补强讲义" hint="在上面的知识点上点「补强讲义」就会生成" />
        ) : showLessons ? (
          <div className="col">
            {lessons.map((l) => (
              <div key={l.id} className="card tight" style={{ margin: 0 }}>
                <div className="row between">
                  <span className="small">{l.title}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setLesson({ title: l.title, body: l.body })}
                  >
                    阅读
                  </Button>
                </div>
                <div className="small faint">{new Date(l.createdAt).toLocaleString('zh-CN')}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            已经攒了 {lessons.length} 篇，点右上角展开。
          </p>
        )}
      </Card>

      {/* ---------------- 讲义弹层 ---------------- */}
      <Sheet
        open={Boolean(lesson) || Boolean(busy)}
        title={lesson?.title ?? '正在生成补强讲义…'}
        onClose={() => {
          setLesson(null);
          setBusy('');
          setStream('');
        }}
      >
        {busy && (
          <div className="row" style={{ gap: 10, marginBottom: 12 }}>
            <span className="spinner" />
            <span className="small">老师正在针对你的薄弱点写讲义…</span>
          </div>
        )}
        {busy && stream && (
          <div className="small mono pre-wrap" style={{ maxHeight: 160, overflowY: 'auto', marginBottom: 12 }}>
            {stream}
          </div>
        )}
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

function formatDate(iso: string): string {
  const today = new Date();
  const target = new Date(`${iso}T00:00:00`);
  const diff = Math.round((target.getTime() - new Date(today.toDateString()).getTime()) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  return `${target.getMonth() + 1} 月 ${target.getDate()} 日`;
}
