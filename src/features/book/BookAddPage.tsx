/**
 * 「加一本教材」页：拍书皮 + 扫码，把一本书建档，并把它的微课收集起来。
 *
 * 三条路，用户想用哪条用哪条：
 *   ① 拍书皮 → 视觉模型认字 → 自动填书名/出版社/主编/版次（**一定能改**）
 *   ② 拍书背条码 → ZXing 真解码 → ISBN（带校验，错了不收）
 *   ③ 拍书上每节的微课二维码 → 一张一张加进来，最后一起存档
 *
 * 界面上刻意把"手动填"放在同等位置：识图和扫码都会出错，
 * 用户必须能直接改，而不是被迫接受一个错的书名。
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { db, getDefaultLLM, newId } from '../../lib/db/db';
import type { BookMeta, Material, MicroLesson, TrackId } from '../../lib/db/types';
import { TRACK_LABELS } from '../../lib/db/types';
import { visionExtract } from '../../lib/llm/client';
import { extractFromUrl } from '../../lib/extract';
import { compressImages, formatBytes } from '../../lib/platform/image';
import { decodeImageFile } from '../../lib/scan/decode';
import {
  COVER_PROMPT,
  buildBookContent,
  classifyScanForBook,
  collectMicroLessonMaterials,
  formatIsbnSafe,
  guessMicroLessonTitle,
  lookupIsbn,
  mergeMicroLessons,
  parseCoverReading,
} from '../../lib/scan/book';
import { Alert, Badge, Button, Card, Field, Select, TextInput } from '../../components/ui';

const TRACK_OPTIONS = (Object.keys(TRACK_LABELS) as TrackId[]).map((k) => ({
  value: k,
  label: TRACK_LABELS[k],
}));

/** 一次最多扫多少张（用户实测会一次选上百张，这里不再卡在 12 张） */
const MAX_SCAN_BATCH = 100;
/** 一批扫描的总时限：到点就停下来汇报，让用户再点一次继续（而不是让界面卡死） */
const SCAN_TOTAL_BUDGET_MS = 150_000;
/** 单张的时间上限：批量场景用小的，免得个别难解的照片拖住整批 */
const SCAN_PER_IMAGE_BUDGET_MS = 3_000;

export function BookAddPage({ materialId: propId }: { materialId?: string } = {}) {
  const navigate = useNavigate();
  const params = useParams();
  /** 有 id = 在编辑一本已存在的教材（比如回头补充微课），没有 = 新建一本 */
  const materialId = propId ?? params.materialId;
  const [meta, setMeta] = useState<BookMeta>({ bookTitle: '' });
  const [track, setTrack] = useState<TrackId>('fundamental');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(
    null,
  );
  /** 手动加微课时用的一行输入 */
  const [manualUrl, setManualUrl] = useState('');
  /** 正在编辑的那条材料的创建时间（更新时保留，不改成"今天新建"） */
  const [createdAt, setCreatedAt] = useState<number | null>(null);

  const patch = (p: Partial<BookMeta>) => setMeta((prev) => ({ ...prev, ...p }));

  /* ------------------------------ 编辑已有教材 ------------------------------ */

  useEffect(() => {
    if (!materialId) return;
    let alive = true;
    void (async () => {
      const row = await db.materials.get(materialId);
      if (!alive || !row) return;
      setMeta(row.book ?? { bookTitle: row.title });
      setTrack(row.track ?? 'fundamental');
      setCreatedAt(row.createdAt);
      setMessage({
        tone: 'ok',
        text: `正在补充/编辑《${row.book?.bookTitle || row.title}》。把漏掉的微课二维码拍进来，保存后会更新这一本（不会新建一条）。`,
      });
    })();
    return () => {
      alive = false;
    };
  }, [materialId]);

  /* ------------------------------ ① 拍书皮 ------------------------------ */

  async function handleCover(file: File) {
    setMessage(null);
    setBusy('cover');
    try {
      const vision = await getDefaultLLM('vision');
      setProgress('正在压缩照片…');
      const { dataUrls, originalBytes, compressedBytes } = await compressImages([file]);
      patch({ coverDataUrl: dataUrls[0] });

      if (!vision) {
        setMessage({
          tone: 'warn',
          text:
            '照片已存下，但还没有配置识图模型，所以没法自动认字。' +
            '到「我的 → 大模型配置」加一个视觉模型（推荐智谱 glm-4v-flash，免费档），' +
            '或者直接在下面手动填书名、出版社。',
        });
        return;
      }
      setProgress(
        `照片 ${formatBytes(originalBytes)} → ${formatBytes(compressedBytes)}，正在识别书名…`,
      );
      const raw = await visionExtract(vision, [dataUrls[0]], COVER_PROMPT);
      const read = parseCoverReading(raw);
      patch(read);
      const got = Object.keys(read).length;
      setMessage(
        got
          ? {
              tone: 'ok',
              text: `已从书皮认出 ${got} 项，**下面每一项都能改**，请核对后再保存（识图会认错字）。`,
            }
          : {
              tone: 'warn',
              text: '没能从这张照片里读出书目信息（可能太糊或拍的不是封面）。照片已存下，书名请手动填。',
            },
      );
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
      setProgress('');
    }
  }

  /* ------------------------------ ② 扫码（条码 / 二维码） ------------------------------ */

  async function handleScan(files: FileList) {
    // 用户可以一次选很多张（实测有人一次选上百张）。这里不再切到 12 张，
    // 但**必须有总时限**：否则上百张、每张最坏几秒，用户会以为死机了。
    const list = Array.from(files).slice(0, MAX_SCAN_BATCH);
    if (!list.length) return;
    setMessage(null);
    setBusy('scan');

    const found: MicroLesson[] = [];
    let isbn: string | undefined;
    let unknown = 0;
    let failed = 0;
    let processed = 0;
    const deadline = Date.now() + SCAN_TOTAL_BUDGET_MS;

    try {
      for (let i = 0; i < list.length; i++) {
        if (Date.now() > deadline) {
          setMessage({
            tone: 'warn',
            text:
              `已处理 ${processed} 张（找到 ${found.length} 个微课链接` +
              (isbn ? `、ISBN ${formatIsbnSafe(isbn)}` : '') +
              `）。为免卡太久先停一下——**再点一次可以继续扫剩下的 ${list.length - i} 张**。` +
              '小技巧：一张只拍一个码、靠近一点，扫得又快又准。',
          });
          return;
        }
        setProgress(`正在解码第 ${i + 1} / ${list.length} 张…（已找到 ${found.length} 个微课链接）`);
        let hit = null;
        try {
          // 批量场景下给每张较小的预算，避免个别照片把整批拖住
          hit = await decodeImageFile(list[i], (phase) => {
            if (phase === 'tiles') {
              setProgress(
                `第 ${i + 1} / ${list.length} 张：整张没找到，正在切块放大细找…（已找到 ${found.length} 个）`,
              );
            }
          }, SCAN_PER_IMAGE_BUDGET_MS);
        } catch {
          failed += 1;
          continue;
        } finally {
          processed += 1;
        }
        if (!hit) {
          failed += 1;
          continue;
        }
        const target = classifyScanForBook(hit.text);
        if (target.kind === 'isbn') {
          isbn = target.isbn;
        } else if (target.kind === 'microLesson') {
          found.push({
            id: newId(),
            url: target.url,
            title: guessMicroLessonTitle(target.url),
            addedAt: Date.now() + found.length,
          });
        } else {
          unknown += 1;
        }
      }

      if (isbn) patch({ isbn });
      if (found.length) patch({ microLessons: mergeMicroLessons(meta.microLessons, found) });

      const parts: string[] = [];
      if (isbn) parts.push(`ISBN ${formatIsbnSafe(isbn)}`);
      if (found.length) parts.push(`${found.length} 个微课链接（重复的已自动去掉）`);
      if (unknown) parts.push(`${unknown} 个码的内容既不是 ISBN 也不是网址`);
      if (failed) parts.push(`${failed} 张没能解出码`);

      setMessage(
        parts.length
          ? {
              tone: failed && !found.length && !isbn ? 'warn' : 'ok',
              text:
                `识别完成：${parts.join('，')}。` +
                (failed
                  ? '解不出来的通常是拍糊了/太远/反光——把码拍大一点、正对着再试一次。'
                  : ''),
            }
          : {
              tone: 'warn',
              text: '这些照片里没有解出二维码或条码。靠近一点、让码填满画面、别反光。',
            },
      );
    } finally {
      setBusy('');
      setProgress('');
    }
  }

  /* ------------------------------ ④ 让 App 自己去把微课内容抓下来 ------------------------------ */

  async function grabMicroLessonContent() {
    const lessons = meta.microLessons ?? [];
    if (!lessons.length) return;
    setBusy('content');
    setMessage(null);
    try {
      // 抓过的链接不再重复抓（材料的 sourceRef 就是那个链接）
      const existing = new Set(
        (await db.materials.toArray()).map((m) => m.sourceRef).filter((x): x is string => Boolean(x)),
      );
      const todo = lessons.filter((l) => !existing.has(l.url));
      const skipped = lessons.length - todo.length;
      if (!todo.length) {
        setMessage({ tone: 'warn', text: `这 ${lessons.length} 个微课链接的内容之前都抓过了。` });
        return;
      }

      setProgress(`正在逐个打开微课页面（共 ${todo.length} 个）…`);
      const result = await collectMicroLessonMaterials({
        lessons: todo,
        extract: extractFromUrl,
        onProgress: (done, total, lesson) =>
          setProgress(`正在抓第 ${done + 1} / ${total} 个：${lesson.title}`),
      });

      for (const item of result.ok) {
        await db.materials.put({
          id: newId(),
          title: item.title,
          sourceType: 'url',
          sourceRef: item.lesson.url,
          content: item.content,
          charCount: item.content.length,
          track,
          createdAt: Date.now(),
        });
      }

      const parts = [`抓到 ${result.ok.length} 篇正文，已存成材料`];
      if (skipped) parts.push(`${skipped} 个之前抓过、跳过`);
      if (result.failed.length) parts.push(`${result.failed.length} 个没抓到正文`);
      const reasons = result.failed
        .slice(0, 2)
        .map((f) => `《${f.lesson.title}》：${f.reason}`)
        .join('；');

      setMessage({
        tone: result.ok.length === 0 ? 'warn' : result.failed.length ? 'warn' : 'ok',
        text:
          parts.join('，') +
          '。' +
          (reasons ? ` 没抓到的原因：${reasons}` : '') +
          (result.ok.length
            ? ' 抓到正文的那些现在可以去「大纲」页生成知识大纲，或者直接拿去出题。'
            : ''),
      });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
      setProgress('');
    }
  }

  /* ------------------------------ 用 ISBN 联网补全 ------------------------------ */

  async function handleLookup() {
    if (!meta.isbn) return;
    setBusy('lookup');
    setMessage(null);
    try {
      const r = await lookupIsbn(meta.isbn);
      if (!r) {
        setMessage({
          tone: 'warn',
          text:
            '公开书目库没查到这本（或者当前网络连不上境外接口）。' +
            '书名、出版社直接手填就行，不影响使用。',
        });
        return;
      }
      patch({
        bookTitle: r.bookTitle || meta.bookTitle,
        publisher: r.publisher || meta.publisher,
        editor: r.editor || meta.editor,
        edition: r.edition || meta.edition,
      });
      setMessage({
        tone: 'ok',
        text: `已从 ${r.source} 补全，请核对后保存（第三方数据也可能有错）。`,
      });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  /* ------------------------------ 保存 ------------------------------ */

  async function save() {
    if (!meta.bookTitle.trim()) {
      setMessage({ tone: 'error', text: '书名不能空。拍书皮没认出来的话，手动写一个也行。' });
      return;
    }
    setBusy('save');
    try {
      const content = buildBookContent(meta);
      const editingExisting = Boolean(materialId && createdAt !== null);
      const row: Material = {
        // 编辑已有教材时**保留原 id 和创建时间**：这是"补充"，不是新建一本
        id: editingExisting ? (materialId as string) : newId(),
        title: meta.bookTitle.trim(),
        sourceType: 'book',
        sourceRef: meta.isbn ? `ISBN ${meta.isbn}` : undefined,
        content,
        charCount: content.length,
        track,
        createdAt: editingExisting ? (createdAt as number) : Date.now(),
        book: { ...meta, updatedAt: Date.now() },
      };
      await db.materials.put(row);
      setMessage({
        tone: 'ok',
        text: editingExisting
          ? `已更新《${row.title}》，现在有 ${meta.microLessons?.length ?? 0} 个微课链接。`
          : '这本教材已存进「材料」。接下来可以去「大纲」页用它生成知识大纲，或者直接去「练习」出题。',
      });
      if (!editingExisting) setTimeout(() => navigate('/outlines'), 1200);
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  const micros = meta.microLessons ?? [];

  return (
    <>
      {message && <Alert tone={message.tone === 'warn' ? 'warn' : message.tone}>{message.text}</Alert>}
      {progress && <Alert tone="ok">{progress}</Alert>}

      {/* ① 书皮 */}
      <Card title="📷 第一步：拍书皮（可选）" extra={<Badge>AI 识图</Badge>}>
        <p className="small muted" style={{ marginTop: 0 }}>
          拍封面或版权页，自动认出书名、出版社、主编、版次。
          **认错是常事**，认完你可以直接改下面的输入框。
        </p>
        <div className="btn-row">
          <label className="btn primary">
            {busy === 'cover' ? '识别中…' : '拍照 / 选书皮照片'}
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleCover(f);
                e.target.value = '';
              }}
            />
          </label>
        </div>
        {meta.coverDataUrl && (
          <div style={{ marginTop: 10 }}>
            <img
              src={meta.coverDataUrl}
              alt="书皮"
              style={{ width: '100%', borderRadius: 8, maxHeight: 220, objectFit: 'contain' }}
            />
            <div className="small faint">书皮照片只存在这台手机上。</div>
          </div>
        )}
      </Card>

      {/* ② 书目信息 */}
      <Card title="📖 第二步：核对 / 填写书目">
        <Field label="书名（必填）">
          <TextInput
            value={meta.bookTitle}
            placeholder="例如：电工技术（第3版）"
            onChange={(v) => patch({ bookTitle: v })}
          />
        </Field>
        <Field label="出版社">
          <TextInput value={meta.publisher ?? ''} onChange={(v) => patch({ publisher: v })} />
        </Field>
        <Field label="主编 / 作者">
          <TextInput value={meta.editor ?? ''} onChange={(v) => patch({ editor: v })} />
        </Field>
        <Field label="版次 / 出版年">
          <TextInput
            value={meta.edition ?? ''}
            placeholder="例如：第3版 2021年"
            onChange={(v) => patch({ edition: v })}
          />
        </Field>
        <Field
          label="ISBN"
          hint={
            meta.isbn
              ? `已识别：${formatIsbnSafe(meta.isbn)}（已通过校验位检查）`
              : '扫书背的条码能得到；也可以手填'
          }
        >
          <TextInput
            value={meta.isbn ?? ''}
            placeholder="978-7-111-63650-2"
            onChange={(v) => patch({ isbn: v.replace(/[^0-9Xx]/g, '') || undefined })}
          />
        </Field>
        <div className="btn-row">
          <Button loading={busy === 'lookup'} disabled={!meta.isbn} onClick={handleLookup}>
            用 ISBN 联网补全书目
          </Button>
        </div>
        <Field label="归到哪条学习线">
          <Select value={track} onChange={(v) => setTrack(v as TrackId)} options={TRACK_OPTIONS} />
        </Field>
      </Card>

      {/* ③ 微课 */}
      <Card
        title="🎬 第三步：把书上的微课二维码扫进来"
        extra={<Badge tone={micros.length ? 'primary' : undefined}>{micros.length} 节</Badge>}
      >
        <p className="small muted" style={{ marginTop: 0 }}>
          书里每节旁边印的二维码，拍一张解一张，可以一次选多张。
          扫到的链接会攒在下面的清单里，保存后就是这本书的配套微课。
        </p>
        <Alert tone="warn">
          说明：**扫书皮上那一个二维码就拿到整本书的微课，做不到**——
          那个码通常只指向出版社的资源首页。所以这里走"一节一码"的路子：
          你把书上每节的码拍进来，App 批量解出来攒好，不用你手动抄链接。
        </Alert>
        <div className="btn-row">
          <label className="btn primary">
            {busy === 'scan' ? '解码中…' : '拍照 / 选二维码（可多选）'}
            <input
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files;
                if (f?.length) void handleScan(f);
                e.target.value = '';
              }}
            />
          </label>
        </div>

        {micros.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {micros.map((m, i) => (
              <div key={m.id} className="card tight">
                <div className="row between">
                  <div className="grow">
                    <div className="small faint">第 {i + 1} 节</div>
                    <input
                      value={m.title}
                      onChange={(e) => {
                        const next = micros.map((x) =>
                          x.id === m.id ? { ...x, title: e.target.value } : x,
                        );
                        patch({ microLessons: next });
                      }}
                    />
                    <div className="small faint truncate">{m.url}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => patch({ microLessons: micros.filter((x) => x.id !== m.id) })}
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <Field label="也可以手动粘一个微课链接">
          <div className="row" style={{ gap: 6 }}>
            <TextInput value={manualUrl} placeholder="https://…" onChange={setManualUrl} />
            <Button
              onClick={() => {
                const url = manualUrl.trim();
                if (!/^https?:\/\//i.test(url)) {
                  setMessage({ tone: 'error', text: '请填完整网址（以 http:// 或 https:// 开头）。' });
                  return;
                }
                const item: MicroLesson = {
                  id: newId(),
                  url,
                  title: guessMicroLessonTitle(url),
                  addedAt: Date.now(),
                };
                patch({ microLessons: mergeMicroLessons(meta.microLessons, [item]) });
                setManualUrl('');
                setMessage({ tone: 'ok', text: '已加入微课清单。' });
              }}
            >
              加入
            </Button>
          </div>
        </Field>

        {micros.length > 0 && (
          <>
            <div className="divider" />
            <div className="btn-row">
              <Button variant="primary" loading={busy === 'content'} onClick={grabMicroLessonContent}>
                让 App 去抓这 {micros.length} 个微课的内容
              </Button>
            </div>
            <p className="small faint" style={{ marginTop: 4 }}>
              点这个按钮，App 会自己逐个打开上面这些链接、把正文抠出来存成材料，
              <b>你不用一页页点开看</b>。抓不到正文的（多半是视频页或要登录）
              会明确告诉你原因和下一步怎么办。
            </p>
          </>
        )}
      </Card>

      <div className="btn-row">
        <Button variant="primary" loading={busy === 'save'} onClick={save}>
          {materialId && createdAt !== null ? '保存修改（补充微课）' : '保存这本教材'}
        </Button>
        <Button variant="ghost" onClick={() => navigate('/materials')}>
          返回材料页
        </Button>
      </div>

      <p className="small faint" style={{ textAlign: 'center', marginTop: 18 }}>
        扫码是**真解码**（ZXing，离线），不是让 AI 看二维码猜内容——猜出来的链接一个字符错就全废。
      </p>
    </>
  );
}
