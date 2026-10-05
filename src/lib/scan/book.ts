/**
 * 「加书」的业务逻辑：把拍书皮、扫条码、扫微课二维码得到的东西
 * 组织成一条能直接用来出题的材料。
 *
 * 这里只有纯函数 +（可选的）一次联网查询，没有界面代码，方便单测。
 *
 * 一条设计原则：**扫出来的东西不猜**。
 *   · 条码解出来是 ISBN 才认，校验位不对就明确说"这不是 ISBN"；
 *   · 视觉模型读书皮一定会有错，所以只用来**填表给你改**，不当成事实直接入库。
 */
import type { BookMeta, MicroLesson } from '../db/types';
import { formatIsbn, normalizeIsbn } from './decode';

/** 把 ISBN 显示成 978-7-111-63650-2 这种分组形式；不是标准 ISBN 就原样返回 */
export function formatIsbnSafe(raw: string | undefined): string {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  const clean = normalizeIsbn(v);
  return clean ? formatIsbn(clean) : v;
}

/** 视觉模型读书皮时用的提示词 */
export const COVER_PROMPT =
  '这是一本教材（电工 / PLC 类）的封面或版权页照片。请只输出一个 JSON 对象，不要任何解释，字段如下：\n' +
  '{\n' +
  '  "bookTitle": "书名（去掉「十三五规划教材」这类宣传语）",\n' +
  '  "publisher": "出版社",\n' +
  '  "editor": "主编或作者",\n' +
  '  "edition": "版次与出版年，例如 第3版 / 2021年"\n' +
  '}\n' +
  '要求：看不清的字段留空字符串，**不要猜**。只输出 JSON。';

/**
 * 容错解析视觉模型返回的书目 JSON。
 * 模型经常把 JSON 包在 ``` 里、字段名换成中文、或者漏字段——都要能接住。
 */
export function parseCoverReading(raw: string): Partial<BookMeta> {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return {};
  }
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
      // 作者/主编经常给成数组（模型两边都可能），取前两个连起来
      if (Array.isArray(v)) {
        const names = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
        if (names.length) return names.slice(0, 2).join('、');
      }
    }
    return undefined;
  };
  const out: Partial<BookMeta> = {};
  const bookTitle = pick('bookTitle', 'title', 'name', '书名', '名称');
  if (bookTitle) out.bookTitle = bookTitle;
  const publisher = pick('publisher', 'press', '出版社', '出版单位');
  if (publisher) out.publisher = publisher;
  const editor = pick('editor', 'author', 'authors', '主编', '作者', '编者');
  if (editor) out.editor = editor;
  const edition = pick('edition', 'version', 'year', '版次', '出版年', '出版日期');
  if (edition) out.edition = edition;
  return out;
}

/** 扫到的条码/二维码内容该怎么归类放进书里 */
export type ScanTarget =
  | { kind: 'isbn'; isbn: string }
  | { kind: 'microLesson'; url: string }
  | { kind: 'unknown'; text: string };

/**
 * 判断扫码结果属于哪一类。
 * ISBN 走校验；http(s) 链接当微课；其余原样返回让用户自己决定。
 */
export function classifyScanForBook(text: string): ScanTarget {
  const trimmed = String(text ?? '').trim();
  const isbn = normalizeIsbn(trimmed);
  if (isbn) return { kind: 'isbn', isbn };
  if (/^https?:\/\//i.test(trimmed)) return { kind: 'microLesson', url: trimmed };
  return { kind: 'unknown', text: trimmed };
}

/**
 * 微课去重合并（同一个二维码扫两次不该出现两条）。
 * 以 url 为准去重；后扫到的标题更具体时保留新的标题。
 */
export function mergeMicroLessons(
  existing: MicroLesson[] | undefined,
  incoming: MicroLesson[],
): MicroLesson[] {
  const byUrl = new Map<string, MicroLesson>();
  for (const m of existing ?? []) byUrl.set(m.url, m);
  for (const m of incoming) {
    const old = byUrl.get(m.url);
    if (!old) {
      byUrl.set(m.url, m);
      continue;
    }
    // 已经有更具体的标题（不是「微课」这种占位）就别覆盖
    const oldIsPlaceholder = !old.title || old.title === '微课';
    if (oldIsPlaceholder && m.title && m.title !== '微课') byUrl.set(m.url, m);
  }
  return [...byUrl.values()].sort((a, b) => a.addedAt - b.addedAt);
}

/** 从链接里猜一个像样的默认标题（书籍二维码大多不带标题） */
export function guessMicroLessonTitle(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg) return decodeURIComponent(seg).slice(0, 60);
    return u.hostname;
  } catch {
    return '微课';
  }
}

/**
 * 把书目信息组织成材料的正文（给大纲/出题用）。
 *
 * 为什么要有这段文本：材料没有正文就没法生成大纲、出题也没依据。
 * 书本身是纸，我们能拿到的就是"这是哪本书 + 配套了哪些微课"，
 * 所以正文写成结构化的清单，让模型知道要围绕这本书的哪些内容出题。
 */
export function buildBookContent(meta: BookMeta): string {
  const lines: string[] = [];
  lines.push(`# ${meta.bookTitle || '（未填书名）'}`);
  lines.push('');
  const facts: string[] = [];
  if (meta.publisher) facts.push(`- 出版社：${meta.publisher}`);
  if (meta.editor) facts.push(`- 主编：${meta.editor}`);
  if (meta.edition) facts.push(`- 版次：${meta.edition}`);
  if (meta.isbn) facts.push(`- ISBN：${meta.isbn}`);
  if (facts.length) {
    lines.push('## 书目信息');
    lines.push(...facts);
    lines.push('');
  }
  const micros = meta.microLessons ?? [];
  if (micros.length) {
    lines.push(`## 配套微课（共 ${micros.length} 节）`);
    micros.forEach((m, i) => lines.push(`${i + 1}. ${m.title} —— ${m.url}`));
    lines.push('');
    lines.push('> 出题时优先覆盖上面这些微课对应的知识点。');
  } else {
    lines.push('## 配套微课');
    lines.push('（还没扫到微课二维码。可以扫书上每节的二维码补进来。）');
  }
  return lines.join('\n');
}

/* ============================== 让 App 自己去抓微课内容 ============================== */

/** 正文少于这么多字，就认为"没抓到有用的东西"（多半是个视频页/需要登录） */
export const MIN_USABLE_CONTENT = 200;

export function isUsableContent(text: string, min = MIN_USABLE_CONTENT): boolean {
  return String(text ?? '').trim().length >= min;
}

export interface MicroLessonContent {
  lesson: MicroLesson;
  title: string;
  content: string;
}

export interface MicroLessonFailure {
  lesson: MicroLesson;
  /** 给人看的原因，不是错误码 */
  reason: string;
}

export interface CollectResult {
  ok: MicroLessonContent[];
  failed: MicroLessonFailure[];
}

/**
 * 把书里扫到的微课链接**逐个抓成正文**，好拿去做材料、出题。
 *
 * 为什么要有这一步：二维码只给出一个链接，用户要的是"内容"。
 * App 自己去打开这些页面、把正文抠出来——用户就不用一页页点开看了。
 *
 * 抓取函数是**注入**的（默认用 App 现有的 extractFromUrl），
 * 这样纯逻辑可测，也方便以后换实现。
 *
 * 诚实处理：不少微课二维码指向的是**视频页**，抓不到正文。
 * 这种不报"成功"，而是给出原因让人知道下一步该干嘛（拍视频画面 / 直接去看）。
 */
export async function collectMicroLessonMaterials(params: {
  lessons: MicroLesson[];
  extract: (url: string) => Promise<{ text: string; title?: string }>;
  onProgress?: (done: number, total: number, lesson: MicroLesson) => void;
}): Promise<CollectResult> {
  const { lessons, extract, onProgress } = params;
  const ok: MicroLessonContent[] = [];
  const failed: MicroLessonFailure[] = [];

  for (let i = 0; i < lessons.length; i++) {
    const lesson = lessons[i];
    onProgress?.(i, lessons.length, lesson);
    try {
      const res = await extract(lesson.url);
      const text = String(res?.text ?? '').trim();
      if (!isUsableContent(text)) {
        failed.push({
          lesson,
          reason: `这个链接只抓到 ${text.length} 个字，多半是视频页或需要登录。建议直接点开看，或者把视频里的板书/画面拍下来用「拍照识图」。`,
        });
        continue;
      }
      ok.push({
        lesson,
        title: (res?.title ?? '').trim() || lesson.title || '微课',
        content: text,
      });
    } catch (e) {
      failed.push({
        lesson,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  onProgress?.(lessons.length, lessons.length, lessons[lessons.length - 1]);
  return { ok, failed };
}

/* ============================== 可选：用 ISBN 联网补全书目 ============================== */

export interface IsbnLookupResult {
  bookTitle?: string;
  publisher?: string;
  editor?: string;
  edition?: string;
  source: string;
}

/**
 * 用 ISBN 到公开书目库补全书名/出版社/作者。
 *
 * 说明清楚这是**尽力而为**：
 *   · 国内网络不一定连得上这些境外接口，连不上就返回 null，让用户手填；
 *   · 不填 API Key、不注册账号，只用公开接口；
 *   · 返回的字段仍然要用户核对（数据源本身有错漏）。
 */
export async function lookupIsbn(isbn: string, timeoutMs = 8000): Promise<IsbnLookupResult | null> {
  const clean = normalizeIsbn(isbn);
  if (!clean) return null;

  const withTimeout = async (url: string): Promise<Response | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      return r.ok ? r : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // 1) Open Library：公开、无需 Key
  const ol = await withTimeout(`https://openlibrary.org/isbn/${clean}.json`);
  if (ol) {
    try {
      const j = (await ol.json()) as Record<string, unknown>;
      const title = typeof j.title === 'string' ? j.title : undefined;
      let publisher: string | undefined;
      let edition: string | undefined;
      if (Array.isArray(j.publishers) && typeof j.publishers[0] === 'string') publisher = j.publishers[0];
      if (typeof j.publish_date === 'string') edition = j.publish_date;
      const authors: string[] = [];
      if (Array.isArray(j.authors)) {
        for (const a of (j.authors as Array<{ key?: string }>).slice(0, 2)) {
          if (!a?.key) continue;
          const ar = await withTimeout(`https://openlibrary.org${a.key}.json`);
          if (ar) {
            const aj = (await ar.json()) as { name?: string };
            if (aj.name) authors.push(aj.name);
          }
        }
      }
      if (title || publisher || authors.length) {
        return {
          bookTitle: title,
          publisher,
          editor: authors.join('、') || undefined,
          edition,
          source: 'Open Library',
        };
      }
    } catch {
      /* 落到下一个数据源 */
    }
  }

  // 2) Google Books：也公开，但国内常连不上
  const gb = await withTimeout(
    `https://www.googleapis.com/books/v1/volumes?q=isbn:${clean}&maxResults=1`,
  );
  if (gb) {
    try {
      const j = (await gb.json()) as {
        totalItems?: number;
        items?: Array<{ volumeInfo?: Record<string, unknown> }>;
      };
      const info = j.items?.[0]?.volumeInfo;
      if (info) {
        const arr = (v: unknown): string | undefined =>
          Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined;
        const title = typeof info.title === 'string' ? info.title : undefined;
        if (title) {
          return {
            bookTitle: title,
            publisher: typeof info.publisher === 'string' ? info.publisher : undefined,
            editor: arr(info.authors),
            edition: typeof info.publishedDate === 'string' ? info.publishedDate : undefined,
            source: 'Google Books',
          };
        }
      }
    } catch {
      /* 放弃 */
    }
  }

  return null;
}
