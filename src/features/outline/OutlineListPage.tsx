/**
 * 「大纲」页：生成新大纲 / 管理已有大纲。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { db, getDefaultLLM } from '../../lib/db/db';
import type { Material, Outline, TrackId } from '../../lib/db/types';
import { TRACK_HINTS, TRACK_LABELS } from '../../lib/db/types';
import { deleteOutline, generateOutline, listOutlines } from '../../lib/services/outline';
import {
  SEED_OUTLINES,
  countSeedNodes,
  installAllSeedOutlines,
  installSeedOutline,
  installedSeedTracks,
} from '../../lib/seed';
import { Alert, Badge, Button, Card, Empty, Field, Loading, Select, TextArea } from '../../components/ui';

const TRACK_OPTIONS = (Object.keys(TRACK_LABELS) as TrackId[]).map((t) => ({
  value: t,
  label: TRACK_LABELS[t],
}));

export function OutlineListPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [outlines, setOutlines] = useState<Outline[] | null>(null);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [pickedMaterials, setPickedMaterials] = useState<string[]>([]);
  const [track, setTrack] = useState<TrackId>('fundamental');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [hasModel, setHasModel] = useState(true);
  const [installedSeed, setInstalledSeed] = useState<Set<TrackId>>(new Set());
  const [seedBusy, setSeedBusy] = useState('');

  const load = useCallback(async () => {
    const [os, ms, cfg, seed] = await Promise.all([
      listOutlines(),
      db.materials.toArray(),
      getDefaultLLM('text'),
      installedSeedTracks(),
    ]);
    setOutlines(os);
    setMaterials(ms.sort((a, b) => b.createdAt - a.createdAt));
    setHasModel(Boolean(cfg));
    setInstalledSeed(seed);
  }, []);

  /** 安装内置起步大纲（不调用大模型） */
  async function addSeed(track: TrackId | 'all') {
    setSeedBusy(track);
    setMessage(null);
    try {
      let count = 0;
      if (track === 'all') {
        count = await installAllSeedOutlines();
      } else {
        await installSeedOutline(track);
        count = 1;
      }
      await load();
      setMessage({
        tone: count > 0 ? 'ok' : 'warn',
        text:
          count > 0
            ? `已添加 ${count} 套内置大纲，现在可以直接去「练习」页出题了（不需要材料，也不花 token）。`
            : '这几套已经装过了。',
      });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSeedBusy('');
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  // 从「材料」页带过来的参数：预选材料
  useEffect(() => {
    const ids = params.get('materials');
    const t = params.get('track') as TrackId | null;
    if (ids) setPickedMaterials(ids.split(',').filter(Boolean));
    if (t && TRACK_LABELS[t]) setTrack(t);
  }, [params]);

  async function generate() {
    if (!pickedMaterials.length) {
      setMessage({ tone: 'error', text: '请至少勾选一份材料。' });
      return;
    }
    setBusy(true);
    setStream('');
    setMessage(null);
    try {
      const res = await generateOutline({
        materialIds: pickedMaterials,
        track,
        extraInstruction: instruction.trim() || undefined,
        onProgress: (d) => setStream((prev) => (prev + d).slice(-4000)),
      });
      setMessage({ tone: 'ok', text: `已生成 ${res.points.length} 个知识点，正在打开…` });
      setParams({}, { replace: true });
      await load();
      navigate(`/outlines/${res.outline.id}`);
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!outlines) return <Loading />;

  const picked = materials.filter((m) => pickedMaterials.includes(m.id));

  return (
    <>
      {!hasModel && (
        <Alert tone="warn">
          还没有配置文本大模型，生成大纲会失败。
          <div style={{ marginTop: 8 }}>
            <Button size="sm" variant="primary" onClick={() => navigate('/me')}>
              去配置
            </Button>
          </div>
        </Alert>
      )}
      {message && <Alert tone={message.tone === 'warn' ? 'warn' : message.tone}>{message.text}</Alert>}

      {/* ---------------- 内置起步大纲 ---------------- */}
      <Card
        title="📦 内置起步大纲"
        extra={<Badge tone={installedSeed.size === SEED_OUTLINES.length ? 'ok' : 'primary'}>
          {installedSeed.size}/{SEED_OUTLINES.length} 已装
        </Badge>}
      >
        <p className="small muted" style={{ marginTop: 0 }}>
          还没找到合适的材料？这四套知识点是我按考试范围和由浅入深的顺序整理好的，
          <b>装上就能直接出题</b>，不需要材料、不调用大模型、不花一分钱。
        </p>
        <div className="col">
          {SEED_OUTLINES.map((seed) => {
            const done = installedSeed.has(seed.track);
            return (
              <div key={seed.track} className="card tight" style={{ margin: 0 }}>
                <div className="row between">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <strong className="small">{TRACK_LABELS[seed.track]}</strong>
                      <Badge>{countSeedNodes(seed.nodes)} 个知识点</Badge>
                      {done && <Badge tone="ok">已装</Badge>}
                    </div>
                    <div className="small faint" style={{ marginTop: 4 }}>
                      {seed.description}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={done ? 'ghost' : 'primary'}
                    disabled={done}
                    loading={seedBusy === seed.track}
                    onClick={() => addSeed(seed.track)}
                  >
                    {done ? '已添加' : '添加'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <Button
            variant="accent"
            block
            disabled={installedSeed.size === SEED_OUTLINES.length}
            loading={seedBusy === 'all'}
            onClick={() => addSeed('all')}
          >
            一键装上全部四条线
          </Button>
        </div>
      </Card>

      {/* ---------------- 生成新大纲 ---------------- */}
      <Card title="🪄 生成新大纲">
        <Field label="学习线">
          <Select value={track} onChange={setTrack} options={TRACK_OPTIONS} />
          <div className="hint">{TRACK_HINTS[track]}</div>
        </Field>

        <Field label={`选择材料（已选 ${pickedMaterials.length} 份）`}>
          {materials.length === 0 ? (
            <Alert tone="warn">
              还没有材料。
              <div style={{ marginTop: 8 }}>
                <Button size="sm" variant="primary" onClick={() => navigate('/materials')}>
                  去导入材料
                </Button>
              </div>
            </Alert>
          ) : (
            <div className="col scroll-y">
              {materials.map((m) => (
                <label key={m.id} className="row" style={{ gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={pickedMaterials.includes(m.id)}
                    onChange={() =>
                      setPickedMaterials((prev) =>
                        prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id],
                      )
                    }
                  />
                  <span className="small grow truncate">
                    {m.title} <span className="faint">（{m.charCount} 字）</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </Field>

        <Field label="补充要求（可选）" hint="例如「重点覆盖接触器互锁和星三角启动」「只保留考证必考内容」">
          <TextArea
            rows={2}
            value={instruction}
            onChange={setInstruction}
            placeholder="留空则让模型自己判断"
          />
        </Field>

        <Button
          variant="accent"
          block
          loading={busy}
          disabled={!pickedMaterials.length || !materials.length}
          onClick={generate}
        >
          {busy ? '正在生成大纲…' : `生成大纲（${picked.length} 份材料）`}
        </Button>

        {busy && stream && (
          <div className="card tight" style={{ marginTop: 12, marginBottom: 0 }}>
            <div className="small faint">模型正在输出（实时预览）：</div>
            <div className="small mono pre-wrap" style={{ maxHeight: 180, overflowY: 'auto', marginTop: 6 }}>
              {stream}
            </div>
          </div>
        )}
      </Card>

      {/* ---------------- 已有大纲 ---------------- */}
      <Card title="🗂️ 已有大纲" extra={<Badge>{outlines.length}</Badge>}>
        {outlines.length === 0 ? (
          <Empty icon="🗺️" text="还没有大纲" hint="上面选好材料就能生成" />
        ) : (
          <div className="col">
            {outlines.map((o) => (
              <div key={o.id} className="card tight" style={{ margin: 0 }}>
                <div className="row between">
                  <div className="grow" onClick={() => navigate(`/outlines/${o.id}`)} style={{ cursor: 'pointer' }}>
                    <div className="small">{o.title}</div>
                    <div className="small faint">
                      {TRACK_LABELS[o.track]} · {o.materialIds.length} 份材料 ·{' '}
                      {new Date(o.createdAt).toLocaleDateString('zh-CN')}
                    </div>
                  </div>
                  <div className="col" style={{ gap: 4 }}>
                    <Button size="sm" onClick={() => navigate(`/outlines/${o.id}`)}>
                      打开
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={async () => {
                        if (!confirm(`删除大纲「${o.title}」？相关的知识点和掌握度记录也会一起删掉。`)) return;
                        await deleteOutline(o.id);
                        await load();
                      }}
                    >
                      删除
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
