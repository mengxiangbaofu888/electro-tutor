/**
 * 「我的」页：模型配置、学习者画像、数据备份。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  db,
  deleteLLMConfig,
  getProfile,
  listLLMConfigs,
  newId,
  saveLLMConfig,
  saveProfile,
} from '../../lib/db/db';
import type {
  Attempt,
  KnowledgePoint,
  LearnerProfile,
  LLMConfig,
  MasteryRecord,
  Material,
  MistakeNote,
  Outline,
  Paper,
  Question,
  TrackId,
} from '../../lib/db/types';
import { TRACK_LABELS } from '../../lib/db/types';
import { PROVIDER_PRESETS, chatCompletionsUrl, isPrivateEndpoint, makeConfig } from '../../lib/llm/presets';
import { listModels, looksLikeItSawTheImage, testConnection, testVisionConnection } from '../../lib/llm/client';
import { refreshLearnerProfile } from '../../lib/services/practice';
import { exportQuestionsCsv } from '../../lib/services/bank';
import { saveTextFile } from '../../lib/platform/save-file';
import { Alert, Badge, Button, Card, Field, Loading, Select, Sheet, TextArea, TextInput } from '../../components/ui';

const PROVIDER_OPTIONS = Object.entries(PROVIDER_PRESETS).map(([key, p]) => ({
  value: key,
  label: p.label,
}));

export function SettingsPage() {
  const navigate = useNavigate();
  const [configs, setConfigs] = useState<LLMConfig[] | null>(null);
  const [profile, setProfile] = useState<LearnerProfile | null>(null);
  const [editing, setEditing] = useState<LLMConfig | null>(null);
  const [providerKey, setProviderKey] = useState<string>('deepseek');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [modelList, setModelList] = useState<string[]>([]);
  const [stats, setStats] = useState({ materials: 0, questions: 0, attempts: 0, points: 0 });

  async function reload() {
    const [cs, pf] = await Promise.all([listLLMConfigs(), getProfile()]);
    setConfigs(cs);
    setProfile(pf);
    const [materials, questions, attempts, points] = await Promise.all([
      db.materials.count(),
      db.questions.count(),
      db.attempts.count(),
      db.knowledgePoints.count(),
    ]);
    setStats({ materials, questions, attempts, points });
  }

  useEffect(() => {
    void reload();
  }, []);

  function startAdd(kind: 'text' | 'vision') {
    const preset = PROVIDER_PRESETS[providerKey] ?? PROVIDER_PRESETS.custom;
    setEditing(
      makeConfig({
        id: newId(),
        name: `${preset.label.split('（')[0]} · ${kind === 'text' ? '文本' : '识图'}`,
        baseUrl: preset.baseUrl,
        // 故意**不**预先填模型：用户明确要求"具体用哪个模型我自己选"。
        // 弹层里会给出常用模型标签（点一下即可）和联网拉取的完整列表。
        model: '',
        kind,
        isDefaultText: kind === 'text' && !(configs ?? []).some((c) => c.kind === 'text'),
        isDefaultVision: kind === 'vision' && !(configs ?? []).some((c) => c.kind === 'vision'),
      }),
    );
    setModelList([]);
    setMessage(null);
  }

  async function save() {
    if (!editing) return;
    if (!editing.baseUrl.trim()) {
      setMessage({ tone: 'error', text: '接口地址必须填（选了预设服务商的话已经自动填好了）。' });
      return;
    }
    if (!editing.model.trim()) {
      setMessage({
        tone: 'error',
        text: '还没选模型。点上面的「常用」标签，或点「从服务商获取模型列表」再选一个。',
      });
      return;
    }
    await saveLLMConfig({ ...editing, name: editing.name.trim() || editing.model });
    setEditing(null);
    setMessage({ tone: 'ok', text: '配置已保存在本机。' });
    await reload();
  }

  async function doTest() {
    if (!editing) return;
    setBusy('test');
    setMessage(null);
    try {
      // 识图配置要走**真的发一张图**的测试：只发一句文字是测不出"能不能看图"的，
      // 而这正是用户踩过的坑——测试连接显示正常，真去识图却一直失败。
      if (editing.kind === 'vision') {
        const reply = await testVisionConnection(editing);
        if (looksLikeItSawTheImage(reply)) {
          setMessage({ tone: 'ok', text: `识图正常：模型说它看到「${reply}」。` });
        } else {
          setMessage({
            tone: 'warn',
            text:
              `模型回话了（「${reply}」），但**它好像没看到图**——多半这个模型不吃图片输入。\n` +
              '识图请换成真的有视觉能力的模型，例如智谱 GLM 的 glm-4v-flash（有免费档）。',
          });
        }
        return;
      }
      const reply = await testConnection(editing);
      setMessage({ tone: 'ok', text: `连接成功，模型回复：${reply}` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessage({
        tone: 'error',
        text:
          editing.kind === 'vision'
            ? `${msg}\n（识图测试失败：这个模型多半不支持图片输入。识图建议用智谱 glm-4v-flash。）`
            : msg,
      });
    } finally {
      setBusy('');
    }
  }

  async function doListModels() {
    if (!editing) return;
    setBusy('models');
    setMessage(null);
    try {
      const list = await listModels(editing);
      setModelList(list);
      setMessage(
        list.length
          ? { tone: 'ok', text: `拿到 ${list.length} 个模型，点下面的标签直接选用。` }
          : { tone: 'warn', text: '服务商没有返回模型列表，请手动填写模型 ID。' },
      );
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  async function exportBackup() {
    setBusy('export');
    try {
      const dump = {
        version: 1,
        exportedAt: new Date().toISOString(),
        materials: await db.materials.toArray(),
        outlines: await db.outlines.toArray(),
        knowledgePoints: await db.knowledgePoints.toArray(),
        questions: await db.questions.toArray(),
        papers: await db.papers.toArray(),
        attempts: await db.attempts.toArray(),
        mastery: await db.mastery.toArray(),
        mistakes: await db.mistakes.toArray(),
        profiles: await db.profiles.toArray(),
      };
      const result = await saveTextFile({
        filename: `电工陪练备份-${new Date().toISOString().slice(0, 10)}.json`,
        content: JSON.stringify(dump, null, 2),
        mime: 'application/json',
        dialogTitle: '保存备份文件',
      });
      setMessage({
        tone: result.cancelled ? 'warn' : 'ok',
        text: result.cancelled
          ? '你取消了保存，备份没有生成。换手机前记得重新导出一次。'
          : result.via === 'share'
            ? '备份已生成，请在系统面板里选择存到哪（网盘 / 微信 / 本机文件）。文件不含 API Key，可以放心存。'
            : '备份文件已导出（不含 API Key，可以放心存网盘）。',
      });
    } finally {
      setBusy('');
    }
  }

  /** 把题库导出成 CSV，方便用 Excel 查看、编辑、打印或分享 */
  async function exportBank() {
    setBusy('bank');
    try {
      const { csv, count } = await exportQuestionsCsv();
      if (!count) {
        setMessage({ tone: 'warn', text: '题库还是空的，先去「练习」页生成一些题目。' });
        return;
      }
      const result = await saveTextFile({
        filename: `电工陪练题库-${new Date().toISOString().slice(0, 10)}.csv`,
        content: csv,
        mime: 'text/csv;charset=utf-8',
        dialogTitle: '保存题库文件',
      });
      if (result.cancelled) {
        setMessage({ tone: 'warn', text: '你取消了保存。' });
        return;
      }
      setMessage({
        tone: 'ok',
        text:
          result.via === 'share'
            ? `已生成 ${count} 道题的 CSV，请在系统面板里选择存到哪。想导回来去「大纲」页。`
            : `已导出 ${count} 道题（UTF-8 CSV，Excel / WPS 可直接打开）。想导回来去「大纲」页。`,
      });
    } finally {
      setBusy('');
    }
  }

  async function importBackup(file: File) {    setBusy('import');
    try {
      const text = await file.text();
      const dump = JSON.parse(text) as Record<string, unknown>;
      // 按 key 取出数组并断言成对应表类型
      const take = <T,>(key: string): T[] => (Array.isArray(dump[key]) ? (dump[key] as T[]) : []);
      const put = async <T,>(table: { bulkPut: (rows: T[]) => Promise<unknown> }, rows: T[]) => {
        if (rows.length) await table.bulkPut(rows);
      };

      await db.transaction(
        'rw',
        [db.materials, db.outlines, db.knowledgePoints, db.questions, db.papers, db.attempts, db.mastery, db.mistakes, db.profiles],
        async () => {
          await put<Material>(db.materials, take<Material>('materials'));
          await put<Outline>(db.outlines, take<Outline>('outlines'));
          await put<KnowledgePoint>(db.knowledgePoints, take<KnowledgePoint>('knowledgePoints'));
          await put<Question>(db.questions, take<Question>('questions'));
          await put<Paper>(db.papers, take<Paper>('papers'));
          await put<Attempt>(db.attempts, take<Attempt>('attempts'));
          await put<MasteryRecord>(db.mastery, take<MasteryRecord>('mastery'));
          await put<MistakeNote>(db.mistakes, take<MistakeNote>('mistakes'));
          await put<LearnerProfile>(db.profiles, take<LearnerProfile>('profiles'));
        },
      );
      setMessage({ tone: 'ok', text: '导入完成。' });
      await reload();
    } catch (e) {
      setMessage({ tone: 'error', text: `导入失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy('');
    }
  }

  if (!configs || !profile) return <Loading />;

  const textConfigs = configs.filter((c) => c.kind === 'text');
  const visionConfigs = configs.filter((c) => c.kind === 'vision');

  return (
    <>
      {message && <Alert tone={message.tone === 'warn' ? 'warn' : message.tone}>{message.text}</Alert>}

      {/* ---------------- 模型配置 ---------------- */}
      <Card title="🤖 大模型配置" extra={<Badge tone="primary">{configs.length} 个</Badge>}>
        <p className="small muted" style={{ marginTop: 0 }}>
          Key 只保存在这台手机本地，不会上传、也不会进 GitHub。
        </p>

        {configs.length === 0 && (
          <>
            <Alert tone="warn">
              还没有配置模型——出题、批改、讲解全都要用它。
              点下面这个按钮，把 API Key 填进去就能开始（Key 只存在这台手机本地，不会上传）。
            </Alert>
            <div className="btn-row" style={{ marginBottom: 12 }}>
              <Button variant="primary" onClick={() => startAdd('text')}>
                🔑 填 API Key（从这里开始）
              </Button>
            </div>
          </>
        )}

        {textConfigs.map((c) => (
          <ConfigRow
            key={c.id}
            config={c}
            onEdit={() => {
              setEditing(c);
              setModelList([]);
              setMessage(null);
            }}
            onDelete={async () => {
              await deleteLLMConfig(c.id);
              await reload();
            }}
          />
        ))}

        <div className="section-label">识图模型（可选，用来识别电路图和公式截图）</div>
        {visionConfigs.map((c) => (
          <ConfigRow
            key={c.id}
            config={c}
            onEdit={() => {
              setEditing(c);
              setModelList([]);
              setMessage(null);
            }}
            onDelete={async () => {
              await deleteLLMConfig(c.id);
              await reload();
            }}
          />
        ))}

        <div className="divider" />
        <Field label="① 先选服务商（下一步才填 Key）">
          <Select value={providerKey} onChange={setProviderKey} options={PROVIDER_OPTIONS} />
        </Field>
        <p className="small faint" style={{ marginTop: -4 }}>
          {PROVIDER_PRESETS[providerKey]?.note}
        </p>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <Button variant={configs.length ? undefined : 'primary'} onClick={() => startAdd('text')}>
            ＋ 填 API Key 加文本模型
          </Button>
          <Button onClick={() => startAdd('vision')}>＋ 加识图模型（可选）</Button>
        </div>
      </Card>

      {/* ---------------- 学习者画像 ---------------- */}
      <Card
        title="🧠 学习者画像"
        extra={<Badge>{profile.totalAnswered} 题</Badge>}
      >
        <p className="small muted" style={{ marginTop: 0 }}>
          这是「自进化」的核心：每次出题、讲解、批改都会把这份画像发给模型，所以它越用越懂你。
        </p>
        <Field label="你的水平自评">
          <TextArea
            rows={2}
            value={profile.level}
            onChange={(v) => setProfile({ ...profile, level: v })}
          />
        </Field>
        <Field label="你希望它怎么讲">
          <TextArea
            rows={2}
            value={profile.preferredStyle}
            onChange={(v) => setProfile({ ...profile, preferredStyle: v })}
          />
        </Field>
        {profile.weakAreas.length > 0 && (
          <Field label="已识别薄弱点">
            <div className="row wrap">
              {profile.weakAreas.map((w) => (
                <Badge key={w} tone="bad">
                  {w}
                </Badge>
              ))}
            </div>
          </Field>
        )}
        {profile.errorPatterns.length > 0 && (
          <Field label="反复出现的错误模式">
            <div className="col">
              {profile.errorPatterns.map((w) => (
                <div key={w} className="small muted">
                  · {w}
                </div>
              ))}
            </div>
          </Field>
        )}
        {profile.digest && (
          <Field label="AI 维护的画像摘要">
            <div className="small muted pre-wrap">{profile.digest}</div>
          </Field>
        )}
        <div className="btn-row">
          <Button onClick={async () => { await saveProfile(profile); setMessage({ tone: 'ok', text: '画像已保存。' }); }}>
            保存修改
          </Button>
          <Button
            variant="ghost"
            loading={busy === 'profile'}
            onClick={async () => {
              setBusy('profile');
              setMessage(null);
              try {
                const p = await refreshLearnerProfile();
                setProfile(p);
                setMessage({ tone: 'ok', text: '画像已根据最近的答题记录更新。' });
              } catch (e) {
                setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
              } finally {
                setBusy('');
              }
            }}
          >
            用最近的答题刷新
          </Button>
        </div>
      </Card>

      {/* ---------------- 快捷入口 ---------------- */}
      <Card title="📊 数据概览">
        <div className="stats">
          <div className="stat">
            <b>{stats.materials}</b>
            <span>材料</span>
          </div>
          <div className="stat">
            <b>{stats.points}</b>
            <span>知识点</span>
          </div>
          <div className="stat">
            <b>{stats.questions}</b>
            <span>题目</span>
          </div>
          <div className="stat">
            <b>{stats.attempts}</b>
            <span>测验</span>
          </div>
        </div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <Button onClick={() => navigate('/knowledge')}>掌握度地图</Button>
          <Button onClick={() => navigate('/wrong')}>错题本</Button>
        </div>
      </Card>

      {/* ---------------- 备份 ---------------- */}
      <Card title="💾 数据备份">
        <p className="small muted" style={{ marginTop: 0 }}>
          所有数据都在手机本地。换手机前请先导出备份，否则会丢。
          （题库也可以单独导出成 CSV，用 Excel 打开就能看和改。）
        </p>
        <div className="btn-row">
          <Button loading={busy === 'export'} onClick={exportBackup}>
            导出备份
          </Button>
          <label className="btn">
            导入备份
            <input
              type="file"
              accept="application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importBackup(f);
                e.target.value = '';
              }}
            />
          </label>
          <Button variant="ghost" loading={busy === 'bank'} onClick={exportBank}>
            导出题库（CSV）
          </Button>
        </div>
      </Card>

      <p className="small faint" style={{ textAlign: 'center', marginTop: 18 }}>
        电工陪练 · 开源项目 electro-tutor
      </p>

      {/* ---------------- 编辑弹层 ---------------- */}
      <Sheet
        open={Boolean(editing)}
        title={editing?.kind === 'vision' ? '配置识图模型（填 Key + 选模型）' : '配置文本模型（填 Key + 选模型）'}
        onClose={() => setEditing(null)}
      >
        {editing && (
          <>
            {message && <Alert tone={message.tone === 'warn' ? 'warn' : message.tone}>{message.text}</Alert>}
            <Field
              label="① API Key"
              hint="只保存在这台手机本地，不会上传。填完会自动联网读一次可用模型列表。"
            >
              <TextInput
                password
                value={editing.apiKey}
                placeholder={editing.kind === 'vision' ? '服务商的 Key（识图和文本通常同一个）' : 'sk-...'}
                onChange={(v) => setEditing({ ...editing, apiKey: v })}
                onBlur={() => {
                  if (editing.apiKey.trim() && !modelList.length && busy !== 'models') void doListModels();
                }}
              />
            </Field>

            <Field
              label="② 接口地址"
              hint={`实际请求：${chatCompletionsUrl(editing.baseUrl || 'https://…/v1')}`}
            >
              <TextInput
                value={editing.baseUrl}
                placeholder="https://api.deepseek.com/v1"
                onChange={(v) => setEditing({ ...editing, baseUrl: v })}
              />
            </Field>
            {editing.baseUrl.trim().toLowerCase().startsWith('http://') &&
              !isPrivateEndpoint(editing.baseUrl) && (
                <Alert tone="warn">
                  这个地址是 http://（明文），API Key 会以明文在网络里传输。
                  只有在你完全信任该地址时才这样配；局域网里的本地模型
                  （192.168.x.x / 10.x.x.x / localhost）不受影响。
                </Alert>
              )}

            <Field label="③ 模型（你自己选）" hint="点「从服务商获取模型列表」联网拉取，或直接手填模型 ID。">
              <TextInput
                value={editing.model}
                placeholder="先点下面的「获取模型列表」，再从结果里选"
                onChange={(v) => setEditing({ ...editing, model: v })}
              />
            </Field>
            <div className="small muted" style={{ marginTop: -6, marginBottom: 10 }}>
              当前已选：<b>{editing.model || '（还没选）'}</b>
            </div>

            {editing.kind === 'vision' &&
              /deepseek\.com/i.test(editing.baseUrl) && (
                <Alert tone="warn">
                  DeepSeek **没有视觉模型**，用它识图不会成功（要么报错、要么一直没响应）。
                  识图请换一家：智谱 GLM 的 <b>glm-4v-flash</b> 有免费档，最合适。
                </Alert>
              )}

            <div className="btn-row" style={{ marginBottom: 10 }}>
              <Button loading={busy === 'models'} disabled={!editing.apiKey.trim()} onClick={doListModels}>
                {editing.apiKey.trim() ? '从服务商获取模型列表（联网）' : '先填 API Key 才能获取模型列表'}
              </Button>
            </div>

            {modelList.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div className="small faint" style={{ marginBottom: 6 }}>
                  服务商当前可用的 {modelList.length} 个模型，点一下选用（这份列表是**刚联网拉到的**，
                  不是 App 里写死的）：
                </div>
                <div className="row wrap">
                  {modelList.map((m) => (
                    <button
                      key={m}
                      className={`badge${editing.model === m ? ' primary' : ''}`}
                      style={{ border: 'none', cursor: 'pointer' }}
                      onClick={() => setEditing({ ...editing, model: m })}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Field label="显示名称（随便写，只是给你自己看）">
              <TextInput value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} />
            </Field>

            <Field label="温度（越高越有创意，出题建议 0.6~0.8）">
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.1}
                value={editing.temperature}
                onChange={(e) => setEditing({ ...editing, temperature: Number(e.target.value) })}
              />
              <div className="small muted">当前：{editing.temperature}</div>
            </Field>

            <Field
              label="代理前缀（可选）"
              hint="网页版直连被跨域拦截时才需要。填 https://你的代理/?url= 这种形式，会把真实地址拼在后面。"
            >
              <TextInput
                value={editing.proxyPrefix ?? ''}
                placeholder="留空即可"
                onChange={(v) => setEditing({ ...editing, proxyPrefix: v })}
              />
            </Field>

            <div className="row" style={{ marginBottom: 12 }}>
              <label className="row small" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={Boolean(editing.kind === 'text' ? editing.isDefaultText : editing.isDefaultVision)}
                  onChange={(e) =>
                    setEditing(
                      editing.kind === 'text'
                        ? { ...editing, isDefaultText: e.target.checked }
                        : { ...editing, isDefaultVision: e.target.checked },
                    )
                  }
                />
                设为默认{editing.kind === 'text' ? '文本' : '识图'}模型
              </label>
            </div>

            <div className="btn-row">
              <Button variant="primary" onClick={save}>
                保存
              </Button>
              <Button loading={busy === 'test'} onClick={doTest}>
                测试连接
              </Button>
            </div>
          </>
        )}
      </Sheet>
    </>
  );
}

function ConfigRow({
  config,
  onEdit,
  onDelete,
}: {
  config: LLMConfig;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isDefault = config.kind === 'text' ? config.isDefaultText : config.isDefaultVision;
  return (
    <div className="card tight">
      <div className="row between">
        <div className="grow">
          <div className="row" style={{ gap: 6 }}>
            <strong>{config.name || config.model}</strong>
            {isDefault && <Badge tone="primary">默认</Badge>}
          </div>
          <div className="small faint truncate">{config.model}</div>
          <div className="small faint truncate">{config.baseUrl}</div>
        </div>
        <div className="col" style={{ gap: 4 }}>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            编辑
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete}>
            删除
          </Button>
        </div>
      </div>
    </div>
  );
}

/** 供其他页面复用：把 track 显示成中文 */
export function trackLabel(track?: TrackId): string {
  return track ? TRACK_LABELS[track] : '未分类';
}
