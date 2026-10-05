/**
 * 「材料」页：把各种来源的学习材料变成可出题的文本。
 * 支持：粘贴文本 / 网页链接 / B站字幕 / 上传文档 / 拍照识图。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, getDefaultLLM, newId } from '../../lib/db/db';
import type { Material, TrackId } from '../../lib/db/types';
import { TRACK_HINTS, TRACK_LABELS } from '../../lib/db/types';
import { extractBilibiliSubtitle, extractFromFile, extractFromUrl } from '../../lib/extract';
import { createOutlineFromTitles, materialSections } from '../../lib/services/outline';import { visionExtract } from '../../lib/llm/client';
import { compressImages, formatBytes } from '../../lib/platform/image';
import { Alert, Badge, Button, Card, Empty, Field, Loading, Select, TextArea, TextInput } from '../../components/ui';

const TRACK_OPTIONS = (Object.keys(TRACK_LABELS) as TrackId[]).map((t) => ({
  value: t,
  label: TRACK_LABELS[t],
}));

type Mode = 'text' | 'url' | 'video' | 'file' | 'image';

const MODES: { key: Mode; label: string; icon: string }[] = [
  { key: 'text', label: '粘贴文本', icon: '📝' },
  { key: 'url', label: '网页链接', icon: '🔗' },
  { key: 'video', label: 'B站视频', icon: '🎬' },
  { key: 'file', label: '上传文档', icon: '📄' },
  { key: 'image', label: '拍照识图', icon: '📷' },
];

export function IngestPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('text');
  const [track, setTrack] = useState<TrackId>('fundamental');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [materials, setMaterials] = useState<Material[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState('');

  const load = useCallback(async () => {
    const all = await db.materials.toArray();
    setMaterials(all.sort((a, b) => b.createdAt - a.createdAt));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveMaterial(m: Omit<Material, 'id' | 'createdAt' | 'charCount'> & { charCount?: number }) {
    const row: Material = {
      id: newId(),
      createdAt: Date.now(),
      charCount: m.charCount ?? m.content.length,
      ...m,
    };
    await db.materials.put(row);
    await load();
    return row;
  }

  /* ------------------------------ 各来源处理 ------------------------------ */

  async function handleText() {
    if (!text.trim()) {
      setMessage({ tone: 'error', text: '请先粘贴内容。' });
      return;
    }
    setBusy('go');
    setMessage(null);
    try {
      await saveMaterial({
        title: title.trim() || `粘贴内容 ${new Date().toLocaleDateString('zh-CN')}`,
        sourceType: 'text',
        content: text.trim(),
        track,
      });
      setText('');
      setTitle('');
      setMessage({ tone: 'ok', text: '已保存。可以去「大纲」页生成知识大纲了。' });
    } finally {
      setBusy('');
    }
  }

  async function handleUrl() {
    if (!url.trim()) return;
    setBusy('go');
    setProgress('正在抓取网页…');
    setMessage(null);
    try {
      const res = await extractFromUrl(url.trim());
      if (!res.text.trim()) throw new Error('这个页面没有抓到正文内容。');
      await saveMaterial({
        title: title.trim() || res.title || url.trim(),
        sourceType: 'url',
        sourceRef: url.trim(),
        content: res.text,
        track,
        warnings: res.warnings,
      });
      setUrl('');
      setTitle('');
      setMessage({ tone: 'ok', text: `已抓取 ${res.text.length} 字。` });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
      setProgress('');
    }
  }

  async function handleVideo() {
    if (!url.trim()) return;
    setBusy('go');
    setProgress('正在尝试抓取视频字幕…');
    setMessage(null);
    try {
      const res = await extractBilibiliSubtitle(url.trim());
      if (!res.ok) {
        setMessage({ tone: 'warn', text: `${res.reason}\n\n替代办法：① 用「粘贴文本」把课程要点贴进来；② 用「拍照识图」拍课件；③ 有配套讲义的话直接上传文档。` });
        return;
      }
      await saveMaterial({
        title: title.trim() || res.result.title || 'B站视频字幕',
        sourceType: 'subtitle',
        sourceRef: url.trim(),
        content: res.result.text,
        track,
      });
      setUrl('');
      setTitle('');
      setMessage({ tone: 'ok', text: `字幕抓取成功，共 ${res.result.text.length} 字。` });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
      setProgress('');
    }
  }

  async function handleFiles(files: FileList) {
    setBusy('go');
    setMessage(null);
    const warnings: string[] = [];
    let okCount = 0;
    try {
      for (const file of Array.from(files)) {
        setProgress(`正在解析 ${file.name}…`);
        try {
          const res = await extractFromFile(file);
          if (!res.text.trim()) {
            warnings.push(`${file.name}：没有提取到文字（可能是扫描件/纯图片）`);
            continue;
          }
          await saveMaterial({
            title: res.title || file.name.replace(/\.[^.]+$/, ''),
            sourceType: 'file',
            sourceRef: file.name,
            content: res.text,
            track,
            warnings: res.warnings,
          });
          okCount += 1;
        } catch (e) {
          warnings.push(`${file.name}：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      setMessage(
        warnings.length
          ? { tone: 'warn', text: `成功 ${okCount} 个，以下有问题：\n${warnings.join('\n')}` }
          : { tone: 'ok', text: `成功导入 ${okCount} 个文件。` },
      );
    } finally {
      setBusy('');
      setProgress('');
    }
  }

  async function handleImages(files: FileList) {
    const vision = await getDefaultLLM('vision');
    if (!vision) {
      setMessage({
        tone: 'warn',
        text: '还没有配置识图模型。到「我的 → 模型配置」里添加一个视觉模型（推荐智谱 glm-4v-flash，免费档）后再来。',
      });
      return;
    }
    setBusy('go');
    setMessage(null);
    try {
      const list = Array.from(files).slice(0, 6);
      // 手机照片动辄几 MB，原图直发会让请求体到几十 MB（基本必然失败，还按体积计费）。
      // 先压到长边 1280 再送出去。
      setProgress(`正在压缩 ${list.length} 张图片…`);
      const { dataUrls, originalBytes, compressedBytes } = await compressImages(list, {
        // 课件/电路图需要看清细节，长边保持 1280；但质量降一档，上传更快
        maxEdge: 1280,
        quality: 0.8,
      });
      setProgress(
        `图片 ${formatBytes(originalBytes)} → ${formatBytes(compressedBytes)}，正在识别…`,
      );

      const out = await visionExtract(
        vision,
        dataUrls,
        '请把图片里的内容完整转写成 Markdown 文本，用于之后出题。要求：\n' +
          '1. 电路图要用文字描述清楚元件、连接关系和端子编号（例如"KM1 主触点串在 QF 与电动机之间"）。\n' +
          '2. 公式要用文本写清楚，例如 U = IR、P = √3·U线·I线·cosφ。\n' +
          '3. 表格用 Markdown 表格还原。\n' +
          '4. 看不清的地方标注「（图片此处不清晰）」，不要瞎猜。\n' +
          '5. 只输出转写内容，不要额外解释。',
      );

      await saveMaterial({
        title: title.trim() || `截图识别 ${new Date().toLocaleDateString('zh-CN')}`,
        sourceType: 'image',
        content: out,
        track,
      });
      setTitle('');
      setMessage({ tone: 'ok', text: '识别完成，请到材料列表里核对内容是否准确（识图可能有误差，可手动修正）。' });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
      setProgress('');
    }
  }

  async function removeMaterial(id: string) {
    await db.materials.delete(id);
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    await load();
  }

  /**
   * 材料**自带标题清单**时（慕课课时、书里的微课标题），直接拼出大纲。
   * 不调模型：标题本身就是知识点的骨架，秒出、不花钱，也不会被模型改错名字。
   * 没有标题清单的材料（PDF/笔记/截图）不显示这个按钮，那些仍需 AI 归纳。
   */
  async function quickOutline(m: Material) {
    const titles = materialSections(m);
    setBusy('outline');
    setMessage(null);
    try {
      const res = await createOutlineFromTitles({
        title: m.title,
        track: m.track ?? track,
        titles,
        materialIds: [m.id],
      });
      setMessage({
        tone: 'ok',
        text:
          `已用这条材料自带的 ${titles.length} 个标题直接建好大纲「${res.outline.title}」` +
          `（${res.points.length} 个知识点）—— **没有调用模型**，秒出、不花钱。` +
          '接下来去「练习」页就能按这些知识点出题。',
      });
      navigate(`/outlines/${res.outline.id}`);
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!materials) return <Loading />;

  return (
    <>
      {message && <Alert tone={message.tone === 'warn' ? 'warn' : message.tone}>{message.text}</Alert>}
      {progress && <Alert>{progress}</Alert>}

      {/* ---------------- 加书（拍照 + 扫码） ---------------- */}
      <Card title="📚 加一本教材（拍书皮 + 扫二维码）" extra={<Badge tone="primary">新</Badge>}>
        <p className="small muted" style={{ marginTop: 0 }}>
          有纸书的话用这条：拍书皮自动认书名/出版社/主编，扫书背条码拿 ISBN，
          再把书里每节的微课二维码拍照批量解出来攒好——不用一节一节手抄链接。
        </p>
        <div className="btn-row">
          <Button variant="primary" onClick={() => navigate('/book')}>
            去加一本教材
          </Button>
        </div>
      </Card>

      {/* ---------------- 慕课整门导入 ---------------- */}
      <Card title="🎓 慕课整门导入（粘一个链接，抓整门课）" extra={<Badge tone="primary">新</Badge>}>
        <p className="small muted" style={{ marginTop: 0 }}>
          在中国大学MOOC（icourse163）上学的课，把课程链接粘进来就行：
          App 自己去抓**课时目录**和**课程自测题（含答案）**，然后你一条条挑要哪些，
          不用再一节课一个链接地复制。
        </p>
        <div className="btn-row">
          <Button variant="primary" onClick={() => navigate('/mooc')}>
            去抓一门慕课
          </Button>
        </div>
      </Card>

      {/* ---------------- 导入 ---------------- */}
      <Card title="➕ 添加学习材料">
        <Field label="属于哪条学习线">
          <Select value={track} onChange={setTrack} options={TRACK_OPTIONS} />
          <div className="hint">{TRACK_HINTS[track]}</div>
        </Field>

        <div className="btn-row" style={{ marginBottom: 12 }}>
          {MODES.map((m) => (
            <Button
              key={m.key}
              size="sm"
              variant={mode === m.key ? 'primary' : 'ghost'}
              onClick={() => {
                setMode(m.key);
                setMessage(null);
              }}
            >
              {m.icon} {m.label}
            </Button>
          ))}
        </div>

        {mode !== 'file' && mode !== 'image' && (
          <Field label="标题（可留空自动生成）">
            <TextInput value={title} onChange={setTitle} placeholder="例如：接触器自锁回路" />
          </Field>
        )}

        {mode === 'text' && (
          <>
            <Field label="把课程要点/讲义/字幕粘贴到这里">
              <TextArea
                rows={10}
                value={text}
                onChange={setText}
                placeholder={'例如：\n接触器自锁回路\n1. 启动按钮 SB2 并联接触器常开辅助触点 KM\n2. 按下 SB2，KM 线圈得电，KM 常开触点闭合\n3. 松开 SB2 后电流经 KM 触点继续供电，这叫自锁\n4. 停止按钮 SB1 串联在回路里，按下即断开'}
              />
            </Field>
            <Button variant="primary" block loading={busy === 'go'} onClick={handleText}>
              保存材料
            </Button>
          </>
        )}

        {mode === 'url' && (
          <>
            <Field label="网页地址" hint="教程文章、课程介绍页都可以；被跨域拦截时请改用「粘贴文本」。">
              <TextInput value={url} onChange={setUrl} placeholder="https://..." />
            </Field>
            <Button variant="primary" block loading={busy === 'go'} onClick={handleUrl}>
              抓取正文
            </Button>
          </>
        )}

        {mode === 'video' && (
          <>
            <Field
              label="B站视频地址"
              hint="只能抓视频自带的 CC 字幕。没有字幕的视频抓不到，这是平台限制，不是 bug。"
            >
              <TextInput value={url} onChange={setUrl} placeholder="https://www.bilibili.com/video/BV..." />
            </Field>
            <Button variant="primary" block loading={busy === 'go'} onClick={handleVideo}>
              尝试抓字幕
            </Button>
          </>
        )}

        {mode === 'file' && (
          <>
            <Alert>
              支持 PDF、Word(docx)、PPT(pptx)、Excel(xlsx)、TXT、Markdown、HTML、CSV。
              扫描版 PDF 提取不到文字，请改用「拍照识图」。
            </Alert>
            <label className="btn primary block">
              选择文件（可多选）
              <input
                type="file"
                multiple
                accept=".pdf,.docx,.pptx,.xlsx,.txt,.md,.markdown,.csv,.json,.html,.htm"
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files?.length) void handleFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          </>
        )}

        {mode === 'image' && (
          <>
            <Alert>
              拍照或从相册选课件、电路图、公式截图，交给识图模型转成文字。
              图片会<b>自动压缩</b>后再发送（长边缩到 1280），省流量也省钱。
              识别结果请自己核对一遍——复杂电路图仍可能有误差。
            </Alert>
            <label className="btn primary block">
              选择图片（最多 6 张）
              <input
                type="file"
                multiple
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files?.length) void handleImages(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          </>
        )}
      </Card>

      {/* ---------------- 材料列表 ---------------- */}
      <Card
        title="📚 已导入材料"
        extra={
          selected.size > 0 ? (
            <Button
              size="sm"
              variant="accent"
              onClick={() => navigate(`/outlines?materials=${[...selected].join(',')}&track=${track}`)}
            >
              用这 {selected.size} 份生成大纲
            </Button>
          ) : (
            <Badge>{materials.length} 份</Badge>
          )
        }
      >
        {materials.length === 0 ? (
          <Empty icon="📚" text="还没有材料" hint="先添加一份材料，才能生成知识大纲" />
        ) : (
          <div className="col">
            {materials.map((m) => (
              <div key={m.id} className="card tight" style={{ margin: 0 }}>
                <div className="row between">
                  <label className="row grow" style={{ gap: 8, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={selected.has(m.id)}
                      onChange={() => toggleSelect(m.id)}
                    />
                    <div className="grow">
                      <div className="small truncate">{m.title}</div>
                      <div className="small faint">
                        {SOURCE_LABELS[m.sourceType]} · {m.charCount} 字 ·{' '}
                        {new Date(m.createdAt).toLocaleDateString('zh-CN')}
                        {m.track ? ` · ${TRACK_LABELS[m.track]}` : ''}
                      </div>
                    </div>
                  </label>
                  <div className="col" style={{ gap: 4 }}>
                    {m.sourceType === 'book' && (
                      <Button size="sm" variant="ghost" onClick={() => navigate(`/book/${m.id}`)}>
                        补充微课 / 编辑
                      </Button>
                    )}
                    {materialSections(m).length >= 2 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void quickOutline(m)}
                      >
                        直接建大纲（{materialSections(m).length} 个标题）
                      </Button>
                    )}
                    <Button size="sm" variant="danger" onClick={() => removeMaterial(m.id)}>
                      删除
                    </Button>
                  </div>
                </div>
                {m.warnings?.length ? (
                  <div className="small faint" style={{ marginTop: 6 }}>
                    ⚠️ {m.warnings.slice(0, 3).join('；')}
                  </div>
                ) : null}
                <details style={{ marginTop: 6 }}>
                  <summary className="small muted" style={{ cursor: 'pointer' }}>
                    预览内容
                  </summary>
                  <div className="small muted pre-wrap" style={{ maxHeight: 200, overflowY: 'auto', marginTop: 6 }}>
                    {m.content.slice(0, 1200)}
                    {m.content.length > 1200 ? '…' : ''}
                  </div>
                </details>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

const SOURCE_LABELS: Record<Material['sourceType'], string> = {
  text: '粘贴',
  url: '网页',
  file: '文件',
  image: '识图',
  subtitle: '字幕',
  book: '教材',
};
