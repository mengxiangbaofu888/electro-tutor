/** 网页正文抓取（readability 式提炼）与 B 站官方 CC 字幕抓取 */

import type { ExtractResult } from './types';

/* ==================== 本地小工具（与 file.ts 保持独立） ==================== */

/** 统计非空白字符数 */
function countChars(text: string): number {
  return text.replace(/\s/g, '').length;
}

/** 抽取结果的统一清洗 */
function cleanExtracted(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 把未知异常转成可读的中文短句 */
function errText(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return '请求超时（15 秒）';
    if (err.name === 'TypeError') return '请求被浏览器拦截（多为跨域限制）';
    return err.message || '未知错误';
  }
  if (typeof err === 'string' && err) return err;
  return '未知错误';
}

/** 组装结果；warnings 为空时不写该字段 */
function buildResult(
  text: string,
  title: string,
  meta: Record<string, string | number>,
  warnings: string[],
): ExtractResult {
  const result: ExtractResult = { text, title, meta };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

/* ============================== 网页正文 ============================== */

/**
 * 注意：浏览器把 User-Agent 列为禁止修改的请求头，这里写了也会被静默忽略；
 * 只有在 Capacitor 原生 HTTP / 服务端代理里才能真正生效。
 */
const BROWSER_FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/** 页面里与正文无关的节点 */
const WEB_NOISE_SELECTOR = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'form',
  'button',
  'input',
  'select',
  'nav',
  'footer',
  'aside',
  'body > header',
].join(',');

/** 评论区 / 侧边栏 / 分享栏等典型噪声 */
const WEB_NOISE_EXTRA_SELECTOR = [
  '#comments',
  '.comments',
  '.comment-list',
  '.sidebar',
  '.share',
  '.recommend',
  '.related',
  '.advertisement',
  '.ad',
].join(',');

/** 常见正文容器（含微信公众号、各类博客与课程页） */
const WEB_CONTENT_SELECTORS: string[] = [
  'article',
  'main',
  '[role="main"]',
  '.article-content',
  '.articleContent',
  '.post-content',
  '.entry-content',
  '.markdown-body',
  '.rich_media_content',
  '#js_content',
  '.course-content',
  '.content',
  '#content',
];

/** 去掉脚本、导航、页脚、评论等噪声 */
function stripWebNoise(doc: Document): void {
  for (const selector of [WEB_NOISE_SELECTOR, WEB_NOISE_EXTRA_SELECTOR]) {
    try {
      doc.querySelectorAll(selector).forEach((el) => el.remove());
    } catch {
      // 个别选择器不被支持时忽略即可
    }
  }
}

/** 抽取块级元素文本：标题转 #，列表项转 -，并可过滤过短的碎片 */
function blockText(root: Element, minLength = 1): string {
  const blocks = root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th,figcaption');
  const lines: string[] = [];
  blocks.forEach((el) => {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < minLength) return;
    // 嵌套结构（p 套 li）会重复出现，跳过与上一条相同的内容
    if (lines.length > 0 && lines[lines.length - 1] === text) return;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      lines.push(`${'#'.repeat(Number.parseInt(tag.slice(1), 10))} ${text}`);
    } else if (tag === 'li') {
      lines.push(`- ${text}`);
    } else {
      lines.push(text);
    }
  });
  return lines.length > 0 ? cleanExtracted(lines.join('\n\n')) : '';
}

/** 找出正文容器：候选里文本最长的那个，太短就认为没找到 */
function pickContentRoot(doc: Document): Element | null {
  let best: Element | null = null;
  let bestLength = 0;
  for (const selector of WEB_CONTENT_SELECTORS) {
    for (const el of Array.from(doc.querySelectorAll(selector))) {
      const length = (el.textContent ?? '').trim().length;
      if (length > bestLength) {
        bestLength = length;
        best = el;
      }
    }
  }
  return bestLength >= 200 ? best : null;
}

/** 找不到正文容器时：用较长的段落拼出正文 */
function paragraphFallback(doc: Document): string {
  const body = doc.body;
  if (!body) return '';
  const fromParagraphs = blockText(body, 20);
  if (countChars(fromParagraphs) >= 100) return fromParagraphs;
  return cleanExtracted(body.textContent ?? '');
}

/** 抓不到标题时用域名兜底 */
function hostFallback(url: string): string {
  try {
    return new URL(url).hostname || '网页正文';
  } catch {
    return '网页正文';
  }
}

/**
 * 抓取网页正文，尽力做 readability 式提炼。
 * 浏览器直连失败（多为 CORS）时抛出中文友好错误。
 */
export async function extractFromUrl(url: string): Promise<ExtractResult> {
  const target = url.trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error('链接格式不正确，请填写以 http:// 或 https:// 开头的网页地址');
  }

  let res: Response;
  try {
    res = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      headers: BROWSER_FETCH_HEADERS,
    });
  } catch {
    // 浏览器里 CORS 被拦截只会抛 TypeError，无法区分具体原因
    throw new Error('网页抓取被浏览器跨域限制拦截，请在 App 内直接粘贴正文内容');
  }

  if (!res.ok) {
    throw new Error(`网页返回 ${res.status} 错误，无法抓取正文，请在 App 内直接粘贴内容`);
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  const body = await res.text();
  const warnings: string[] = [];
  let title = '';
  let text = '';

  const looksHtml = contentType.includes('html') || /<html[\s>]|<body[\s>]|<p[\s>]/i.test(body);
  if (looksHtml) {
    if (typeof DOMParser === 'undefined') {
      throw new Error('当前运行环境不支持 HTML 解析，请在 App 内直接粘贴正文内容');
    }
    const doc = new DOMParser().parseFromString(body, 'text/html');
    title = (doc.title || '').trim();
    stripWebNoise(doc);
    const root = pickContentRoot(doc);
    text = root ? blockText(root) : paragraphFallback(doc);
  } else {
    text = cleanExtracted(body);
    warnings.push('这个链接返回的不是网页，已按纯文本处理');
  }

  if (countChars(text) < 50) {
    warnings.push('抓到的正文很少，可能没抓全，建议直接在 App 内粘贴正文');
  }

  return buildResult(
    text,
    title || hostFallback(target),
    { kind: 'web', url: target, chars: countChars(text) },
    warnings,
  );
}

/* ============================== B 站字幕 ============================== */

const BILI_API_VIEW = 'https://api.bilibili.com/x/web-interface/view';
const BILI_API_PLAYER = 'https://api.bilibili.com/x/player/v2';
/** 单次请求超时（毫秒）：接口被风控时不能一直挂着 */
const BILI_TIMEOUT_MS = 15000;

interface BiliViewData {
  aid?: number;
  cid?: number;
  title?: string;
}

interface BiliViewResponse {
  code?: number;
  message?: string;
  data?: BiliViewData;
}

interface BiliSubtitleEntry {
  lan?: string;
  lan_doc?: string;
  subtitle_url?: string;
}

interface BiliPlayerResponse {
  code?: number;
  message?: string;
  data?: { subtitle?: { subtitles?: BiliSubtitleEntry[] } };
}

interface BiliCue {
  from?: number;
  to?: number;
  content?: string;
}

interface BiliSubtitleBody {
  body?: BiliCue[];
}

/** 带超时的 JSON 请求；失败直接抛异常，由外层统一转成 ok:false */
async function getJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BILI_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        // 浏览器会忽略该头，原生 HTTP 下可减少风控概率
        'User-Agent': BROWSER_FETCH_HEADERS['User-Agent'] ?? '',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // res.json() 的类型是 any，这里显式收敛成调用方声明的结构
    return (await res.json()) as unknown as T;
  } finally {
    clearTimeout(timer);
  }
}

/** 从链接里解析 BV 号（BV + 10 位）或老的 av 号 */
function parseBiliId(input: string): { kind: 'bv' | 'av'; value: string } | null {
  const text = input.trim();
  const bv = /BV[0-9A-Za-z]{10}/.exec(text);
  if (bv) return { kind: 'bv', value: bv[0] };
  const av = /\bav(\d{1,12})\b/i.exec(text);
  const avValue = av?.[1];
  if (avValue) return { kind: 'av', value: avValue };
  return null;
}

/** 选一条可用字幕：优先中文，其次第一条 */
function pickSubtitle(entries: BiliSubtitleEntry[]): BiliSubtitleEntry | undefined {
  const usable = entries.filter((e) => typeof e.subtitle_url === 'string' && e.subtitle_url.length > 0);
  if (usable.length === 0) return undefined;
  return usable.find((e) => (e.lan ?? '').startsWith('zh')) ?? usable[0];
}

/** 把协议相对地址（// 开头）补成 https 绝对地址 */
function toHttpsUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith('//')) return `https:${value}`;
  if (/^https:\/\//i.test(value)) return value;
  // http 会被 https 页面按混合内容拦掉，统一升级
  if (/^http:\/\//i.test(value)) return value.replace(/^http:\/\//i, 'https://');
  if (value.startsWith('/')) return `https://api.bilibili.com${value}`;
  return null;
}

/** 秒 → mm:ss（超过 1 小时用 h:mm:ss） */
function formatTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 抓 B 站官方 CC 字幕：BV 号 → aid/cid → 字幕列表 → 字幕 JSON。
 * 任何失败都返回 ok:false（接口有 CORS 与风控，失败属于正常情况，不做重试）。
 */
export async function extractBilibiliSubtitle(
  url: string,
): Promise<{ ok: true; result: ExtractResult } | { ok: false; reason: string }> {
  const noSubtitle = '这个视频没有 CC 字幕，请在 App 内粘贴文案或上传讲义/截图';
  try {
    const id = parseBiliId(url);
    if (!id) {
      return {
        ok: false,
        reason: '没有识别出 B 站视频号，请粘贴形如 https://www.bilibili.com/video/BV1xx411c7mD 的链接',
      };
    }

    const query = id.kind === 'bv' ? `bvid=${encodeURIComponent(id.value)}` : `aid=${encodeURIComponent(id.value)}`;
    const view = await getJson<BiliViewResponse>(`${BILI_API_VIEW}?${query}`);
    if (view.code !== 0 || !view.data) {
      return {
        ok: false,
        reason: `B 站接口没有返回视频信息（${view.message || '视频可能已删除、需要登录或触发风控'}）`,
      };
    }

    const { aid, cid } = view.data;
    if (typeof aid !== 'number' || typeof cid !== 'number') {
      return { ok: false, reason: 'B 站接口返回的数据不完整，拿不到字幕地址' };
    }
    const title = (view.data.title ?? '').trim() || 'B 站视频字幕';

    const player = await getJson<BiliPlayerResponse>(`${BILI_API_PLAYER}?aid=${aid}&cid=${cid}`);
    const entries = player.data?.subtitle?.subtitles ?? [];
    if (entries.length === 0) return { ok: false, reason: noSubtitle };

    const chosen = pickSubtitle(entries);
    const subtitleUrl = chosen?.subtitle_url ? toHttpsUrl(chosen.subtitle_url) : null;
    if (!subtitleUrl) return { ok: false, reason: '字幕地址缺失或格式异常，请在 App 内粘贴文案或上传讲义/截图' };

    const subtitle = await getJson<BiliSubtitleBody>(subtitleUrl);
    const cues = (subtitle.body ?? []).filter(
      (cue) => typeof cue.content === 'string' && cue.content.trim().length > 0,
    );
    if (cues.length === 0) {
      return { ok: false, reason: '字幕内容为空，请在 App 内粘贴文案或上传讲义/截图' };
    }

    const text = cues
      .map((cue) => {
        const content = (cue.content ?? '').replace(/\s+/g, ' ').trim();
        return `[${formatTime(typeof cue.from === 'number' ? cue.from : 0)}] ${content}`;
      })
      .join('\n');

    return {
      ok: true,
      result: buildResult(
        text,
        title,
        { kind: 'bilibili', bvid: id.kind === 'bv' ? id.value : '', lang: chosen?.lan ?? '', cues: cues.length, chars: countChars(text) },
        [],
      ),
    };
  } catch (err) {
    // CORS / 风控 / 网络问题都走这里，不抛异常、不重试
    return {
      ok: false,
      reason: `B 站字幕抓取失败：${errText(err)}。可改为在 App 内粘贴文案或上传讲义/截图`,
    };
  }
}
