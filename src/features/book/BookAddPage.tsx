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
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { db, getDefaultLLM, newId } from '../../lib/db/db';
import type { BookMeta, LLMConfig, Material, MicroLesson, TrackId } from '../../lib/db/types';
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
/** 书页草稿存在哪（退出 App 再回来也能接着扫） */
const DRAFT_KEY = 'electro-tutor:book-draft';
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
  /** 抓微课内容的结果：**常驻显示**（用户反馈"转两圈就没了，不知道到哪步"） */
  const [fetchResults, setFetchResults] = useState<
    { title: string; url: string; detail: string; ok: boolean }[]
  >([]);
  /** 没有识图模型时，是否可以用现有文本模型的 Key 一键加一个（用户只有文本模型） */
  const [canReuseKey, setCanReuseKey] = useState(false);
  /** 批量扫码：用户点"停止"用（扫码中途不想扫了） */
  const stopScanRef = useRef(false);
  /** 每张照片的解码结果（用户反馈："我不知道他差的那一张是哪一张"） */
  const [imgResults, setImgResults] = useState<{ name: string; ok: boolean; detail: string }[]>([]);

  /**
   * 用**现有文本模型同一个 Key** 加一个识图模型。
   * 有些模型（DeepSeek 的 deepseek-flash、智谱 GLM、通义 Qwen-VL）本身就能看图，
   * 没必要让用户再去别处申请 Key —— 那是他被"还得自己填"卡住的真正原因。
   */
  async function reuseKeyForVision() {
    setBusy('vision');
    setMessage(null);
    try {
      const textCfg = await getDefaultLLM('text');
      if (!textCfg) {
        setMessage({ tone: 'error', text: '还没有文本模型配置，请先到「我的」里加一个。' });
        return;
      }
      const cfg: LLMConfig = {
        ...textCfg,
        id: newId(),
        kind: 'vision',
        name: `${textCfg.name}（兼识图）`,
        // 同一个地址、同一个 Key、同一个模型名：能不能看图由服务商决定，
        // 点「测试连接」会真发一张图去验证，不行会明确告诉你
        createdAt: Date.now(),
      };
      await db.llmConfigs.put(cfg);
      setCanReuseKey(false);
      setMessage({
        tone: 'ok',
        text:
          `已添加识图模型「${cfg.name}」（用的是同一个 Key 和模型）。` +
          '建议先到「我的」点一下它的「测试连接」——那会真发一张图验证能不能看图；' +
          '然后回到这里重新拍一次书皮。',
      });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  const patch = (p: Partial<BookMeta>) => setMeta((prev) => ({ ...prev, ...p }));

  /* ------------------------------ 草稿自动保存 ------------------------------ */
  // 用户反馈："添加微课不能退出来，一退出来回去就找不到之前解码的进度了"。
  // 所以每次改动都把表单写到本地（不含封面大图，免得占满存储），
  // 重新进来时自动恢复，接着扫就行。

  useEffect(() => {
    if (materialId) return; // 编辑已有教材：数据本来就在库里，不掺草稿
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as { meta?: BookMeta; track?: TrackId };
      const m = d?.meta;
      if (!m) return;
      if (m.bookTitle || m.isbn || (m.microLessons?.length ?? 0) > 0) {
        setMeta(m);
        if (d.track) setTrack(d.track);
        setMessage({
          tone: 'ok',
          text:
            `已恢复上次没保存完的草稿：${m.bookTitle || '(还没填书名)'}` +
            `、${m.microLessons?.length ?? 0} 个微课链接。接着扫/接着填都行。`,
        });
      }
    } catch {
      /* 草稿坏了就当没有 */
    }
  }, [materialId]);

  useEffect(() => {
    if (materialId) return;
    try {
      const hasContent = Boolean(
        meta.bookTitle || meta.isbn || meta.coverDataUrl || (meta.microLessons?.length ?? 0) > 0,
      );
      if (!hasContent) {
        localStorage.removeItem(DRAFT_KEY);
        return;
      }
      // 封面照片是 base64 大图，存进 localStorage 容易顶满；草稿只留文字与微课清单
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ meta: { ...meta, coverDataUrl: undefined }, track }));
    } catch {
      /* 存储满了就算了，不影响主流程 */
    }
  }, [meta, track, materialId]);

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
      const { dataUrls, originalBytes, compressedBytes } = await compressImages([file], {
        // 书皮只要看清书名/出版社，不需要 1280 那么细：压小一点，识图快很多
        maxEdge: 1024,
        quality: 0.8,
      });
      patch({ coverDataUrl: dataUrls[0] });

      if (!vision) {
        // 用户反馈："书皮添加进去了也没有用，还是得自己填详细信息。"
        // 原因多半是**没配识图模型**（他只有文本模型），而让他再去申请一个 Key 太麻烦。
        // 所以这里给一条一键通道：复用已有的 Key 加一个识图模型。
        const textCfg = await getDefaultLLM('text');
        setMessage({
          tone: 'warn',
          text:
            '照片已存下，但还没有配置识图模型，所以没法自动认字。' +
            (textCfg
              ? `点下面的「用同一个 Key 加识图模型」就能用你现有的 ${textCfg.model} 试试` +
                '（DeepSeek 的 deepseek-flash 本身就支持看图）；也可以直接在下面手动填书名。'
              : '到「我的 → 大模型配置」加一个视觉模型（推荐智谱 glm-4v-flash，免费档），' +
                '或者直接在下面手动填书名、出版社。'),
        });
        setCanReuseKey(Boolean(textCfg));
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
    let stopped = false; // 超时或用户点了"停止"
    /** 每张照片的结果（用户反馈："我不知道他差的那一张是哪一张"） */
    const imgResults: { name: string; ok: boolean; detail: string }[] = [];
    const deadline = Date.now() + SCAN_TOTAL_BUDGET_MS;

    try {
      for (let i = 0; i < list.length; i++) {
        if (Date.now() > deadline) {
          stopped = true;
          break;
        }
        if (stopScanRef.current) {
          stopped = true;
          break;
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
          imgResults.push({ name: list[i].name, ok: false, detail: '读图出错' });
          continue;
        } finally {
          processed += 1;
        }
        if (!hit) {
          failed += 1;
          imgResults.push({ name: list[i].name, ok: false, detail: '没解出码（多半是糊/远/反光）' });
          continue;
        }
        const target = classifyScanForBook(hit.text);
        if (target.kind === 'isbn') {
          isbn = target.isbn;
          imgResults.push({ name: list[i].name, ok: true, detail: `ISBN ${formatIsbnSafe(target.isbn)}` });
        } else if (target.kind === 'microLesson') {
          found.push({
            id: newId(),
            url: target.url,
            title: guessMicroLessonTitle(target.url),
            addedAt: Date.now() + found.length,
          });
          imgResults.push({ name: list[i].name, ok: true, detail: '微课链接' });
        } else {
          unknown += 1;
          imgResults.push({ name: list[i].name, ok: false, detail: '不是 ISBN 也不是微课码' });
        }
      }
    } finally {
      // **关键**：不管是扫完、超时还是手动停止，都要把已扫到的先保存进清单。
      // 以前超时那条路直接 return，扫到的东西全丢了 —— 用户只能全部重扫（真实踩到）。
      if (isbn) patch({ isbn });
      if (found.length) patch({ microLessons: mergeMicroLessons(meta.microLessons, found) });
      setImgResults(imgResults);
      setBusy('');
      setProgress('');
      stopScanRef.current = false;

      const parts: string[] = [];
      if (isbn) parts.push(`ISBN ${formatIsbnSafe(isbn)}`);
      if (found.length) parts.push(`${found.length} 个微课链接（重复的已自动去掉）`);
      if (unknown) parts.push(`${unknown} 个码的内容既不是 ISBN 也不是网址`);
      if (failed) parts.push(`${failed} 张没能解出码`);

      const remain = Math.max(0, list.length - processed);
      const head = stopped
        ? `已停下：处理了 ${processed} 张，还剩 ${remain} 张没扫。`
        : `识别完成（${processed} 张）：`;
      setMessage(
        parts.length
          ? {
              tone: failed && !found.length && !isbn ? 'warn' : 'ok',
              text:
                head +
                parts.join('，') +
                '。扫到的都已经列在下面的清单里了。' +
                (stopped
                  ? `（为免卡太久先停一下。想继续就再选一次照片——**重复的会自动去重**，不会扫出两份。` +
                    (failed ? `没解出来的 ${failed} 张在下面的"每张照片结果"里，可以只补拍那几张。` : '') +
                    '）'
                  : failed
                    ? '解不出来的通常是拍糊了/太远/反光——把码拍大一点、正对着再试一次。'
                    : ''),
            }
          : {
              tone: 'warn',
              text: '这些照片里没有解出二维码或条码。靠近一点、让码填满画面、别反光。',
            },
      );
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
      setFetchResults(todo.map((l) => ({ title: l.title, url: l.url, ok: false, detail: '排队中…' })));
      const result = await collectMicroLessonMaterials({
        lessons: todo,
        extract: extractFromUrl,
        onProgress: (done, total, lesson) => {
          setProgress(`正在抓第 ${done + 1} / ${total} 个：${lesson.title}`);
          // 每开始一个就在清单里标出"正在抓"，用户随时知道到哪步了
          setFetchResults((prev) =>
            prev.map((r) =>
              r.url === lesson.url && r.detail === '排队中…' ? { ...r, detail: '正在抓…' } : r,
            ),
          );
        },
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

      // 结果**常驻**：每个链接一行，成功/失败与原因都留着（不再"转两圈就没了"）
      const okByUrl = new Map(result.ok.map((o) => [o.lesson.url, o.content.length]));
      const failByUrl = new Map(result.failed.map((f) => [f.lesson.url, f.reason]));
      setFetchResults((prev) =>
        prev.map((r) => {
          const chars = okByUrl.get(r.url);
          if (chars !== undefined) return { ...r, ok: true, detail: `已抓到 ${chars} 字，存成材料` };
          const reason = failByUrl.get(r.url);
          return { ...r, ok: false, detail: reason ?? '没抓到' };
        }),
      );

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

  async function handleLookup(auto = false) {
    if (!meta.isbn) return;
    if (busy === 'lookup') return;
    setBusy('lookup');
    if (!auto) setMessage(null);
    else setMessage({ tone: 'ok', text: `正在用 ISBN ${formatIsbnSafe(meta.isbn)} 联网查书目…` });
    try {
      const r = await lookupIsbn(meta.isbn);
      if (!r) {
        setMessage({
          tone: 'warn',
          text:
            `书名库里没有这个 ISBN（${formatIsbnSafe(meta.isbn)}）的记录。` +
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
        text:
          `已从「${r.source}」补全：${r.bookTitle ?? ''}` +
          `${r.editor ? ` / ${r.editor}` : ''}${r.publisher ? ` / ${r.publisher}` : ''}` +
          `${r.edition ? ` / ${r.edition}` : ''}。（第三方数据也可能有错，请核对）`,
      });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy('');
    }
  }

  /* ------------------------------ 专扫条形码（ISBN） ------------------------------ */

  /**
   * 用户反馈："这个（ISBN）是在条形码上面的，最好加一个扫条形码处"。
   * 所以给一个**专门扫条码**的入口：拍/选一张条码照片 → 只认 ISBN，
   * 认出来就直接填进 ISBN 字段并自动联网补全，不用再手点一次。
   */
  async function handleBarcodeScan(file: File) {
    setBusy('barcode');
    setMessage({ tone: 'ok', text: '正在识别条形码…' });
    try {
      const hit = await decodeImageFile(file, (phase) => {
        if (phase === 'tiles') setMessage({ tone: 'ok', text: '整张没认出，正在切块放大细找…' });
      });
      if (!hit) {
        setMessage({
          tone: 'warn',
          text: '没认出条形码。小技巧：**只拍条码那一小块**、让条码占满画面、对焦清楚、别反光。',
        });
        return;
      }
      const target = classifyScanForBook(hit.text);
      if (target.kind !== 'isbn') {
        setMessage({
          tone: 'warn',
          text: `认出的是「${hit.text.slice(0, 40)}」，不是 ISBN 条码。请对着书背的条形码拍（ISBN 通常印在条码上方）。`,
        });
        return;
      }
      patch({ isbn: target.isbn });
      setMessage({
        tone: 'ok',
        text: `已识别 ISBN ${formatIsbnSafe(target.isbn)}（校验位通过），正在联网补全书目…`,
      });
      await handleLookup(true);
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
      // 存好了就把草稿清掉：否则下次进来还会"恢复"这本已经保存过的书（测试抓到的遗漏）
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* 清不掉也不影响主流程 */
      }
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
          {canReuseKey && (
            <Button loading={busy === 'vision'} onClick={() => void reuseKeyForVision()}>
              用同一个 Key 加识图模型
            </Button>
          )}
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
              ? `已识别：${formatIsbnSafe(meta.isbn)}（已通过校验位检查）—— 离开输入框会自动联网补全`
              : '扫书背的条码能得到；也可以手填（ISBN 通常印在条形码上方）'
          }
        >
          <TextInput
            value={meta.isbn ?? ''}
            placeholder="978-7-111-63650-2"
            onChange={(v) => patch({ isbn: v.replace(/[^0-9Xx]/g, '') || undefined })}
            // 用户反馈："这个数字我输入完半天没有用，他也不会自己补全"
            // → 填完离开输入框就自动查，不用再手点按钮
            onBlur={() => {
              if (meta.isbn && meta.isbn.length >= 10) void handleLookup(true);
            }}
          />
        </Field>
        <div className="btn-row">
          <label className="btn ghost">
            {busy === 'barcode' ? '识别条码中…' : '📷 扫条形码（ISBN）'}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleBarcodeScan(f);
                e.target.value = '';
              }}
            />
          </label>
          <Button loading={busy === 'lookup'} disabled={!meta.isbn} onClick={() => void handleLookup()}>
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
          {busy === 'scan' && (
            <Button variant="danger" onClick={() => (stopScanRef.current = true)}>
              停止（保留已扫到的）
            </Button>
          )}
        </div>

        {/* 每张照片的结果：用户要知道"差的那一张是哪一张" */}
        {imgResults.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="small faint" style={{ marginBottom: 4 }}>
              每张照片的结果（{imgResults.filter((r) => r.ok).length} 张成功 /{' '}
              {imgResults.filter((r) => !r.ok).length} 张没解出）：
            </div>
            <div className="col" style={{ gap: 2, maxHeight: 180, overflowY: 'auto' }}>
              {imgResults.map((r, i) => (
                <div key={`${r.name}-${i}`} className="small">
                  {r.ok ? '✅' : '⚠️'} <span className="mono">{r.name}</span>
                  <span className="faint"> · {r.detail}</span>
                </div>
              ))}
            </div>
          </div>
        )}

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

            {/* 抓取结果常驻：用户反馈"转两圈就没了，也不知道到哪步了" */}
            {fetchResults.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div className="small faint" style={{ marginBottom: 4 }}>
                  抓取结果（每个链接一行，抓完不会消失）：
                </div>
                <div className="col" style={{ gap: 4, maxHeight: 220, overflowY: 'auto' }}>
                  {fetchResults.map((r) => (
                    <div key={r.url} className="small">
                      {r.ok ? '✅' : r.detail === '正在抓…' ? '⏳' : r.detail === '排队中…' ? '…' : '⚠️'}{' '}
                      <b>{r.title}</b>
                      <span className="faint"> · {r.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
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
