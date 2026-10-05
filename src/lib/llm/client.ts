/**
 * 大模型调用层（OpenAI 兼容协议）。
 *
 * 关键设计：
 * 1. 浏览器直连可能被 CORS 拦截；在 Capacitor 原生壳里自动改走原生 HTTP（无 CORS 限制）。
 * 2. 所有错误都翻译成人能看懂的中文，并给出下一步动作。
 * 3. 支持流式输出（长文大纲生成时体验好很多）。
 */
import type { LLMConfig } from '../db/types';
import { chatCompletionsUrl, modelsUrl } from './presets';

export interface TextPart {
  type: 'text';
  text: string;
}
export interface ImagePart {
  type: 'image_url';
  image_url: { url: string };
}
export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface ChatOptions {
  /** 流式回调；提供后会使用 stream: true */
  onDelta?: (chunk: string) => void;
  signal?: AbortSignal;
  /** 要求模型输出 JSON 对象 */
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  /**
   * **空闲超时**（毫秒）：多久没有收到任何数据就放弃。
   *
   * 为什么必须有这个：以前浏览器那条路**没有超时**——模型名填错、服务商排队、
   * 网络半死的时候，请求会一直挂着，界面上就是"半天出不来"，
   * 用户完全不知道发生了什么。原生通道虽然有个 3 分钟的 readTimeout，
   * 但对使用者来说同样是"干等"。
   *
   * 用"空闲"而不是"总时长"：长文本生成本来就要几十秒，
   * 只要还在持续吐字就不该被打断；真正该掐掉的是"长时间一点动静都没有"。
   */
  idleTimeoutMs?: number;
}

/** 默认空闲超时：45 秒没有任何数据就判定为卡住 */
export const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
/** 识图/长文这类请求本身更慢，给更宽的空闲上限 */
export const VISION_IDLE_TIMEOUT_MS = 90_000;

export interface ChatResult {
  content: string;
  /** 粗略 token 统计，服务商返回时才有 */
  usage?: { prompt?: number; completion?: number };
}

/* ------------------------------ 原生 HTTP 通路 ------------------------------ */

interface CapacitorHttpPlugin {
  request(options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    data?: unknown;
    readTimeout?: number;
    connectTimeout?: number;
  }): Promise<{ status: number; data: unknown; headers: Record<string, string> }>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: { CapacitorHttp?: CapacitorHttpPlugin };
}

function getNativeHttp(): CapacitorHttpPlugin | null {
  const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  return cap.Plugins?.CapacitorHttp ?? null;
}

/* ------------------------------ 工具 ------------------------------ */

/** 拼接最终请求地址，并把可选的代理前缀套上 */
export function resolveUrl(baseUrl: string, proxyPrefix?: string): string {
  const target = baseUrl.trim();
  if (!proxyPrefix) return target;
  const p = proxyPrefix.trim();
  if (p.includes('{url}')) return p.replace('{url}', encodeURIComponent(target));
  return p + encodeURIComponent(target);
}

/** 按字符数截断长文本，保留头尾，避免超出模型上下文 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n……（中间省略约 ${text.length - maxChars} 字，属于原文中段，可忽略）……\n\n${text.slice(-tail)}`;
}

function describeHttpError(status: number, bodyText: string): string {
  const body = bodyText.slice(0, 500);
  switch (status) {
    case 401:
      return `鉴权失败（401）：API Key 不正确或已失效。请到「我的 → 模型配置」重新粘贴 Key。\n服务端返回：${body}`;
    case 403:
      return `无权访问（403）：该 Key 可能没有这个模型的权限，或需要实名/充值。\n服务端返回：${body}`;
    case 404:
      return `接口地址不对（404）：请检查「接口地址」是否填到了 /v1 这一层，模型 ID 是否存在。\n服务端返回：${body}`;
    case 429:
      return `触发限流或余额不足（429）：稍等再试，或换一个模型/服务商。\n服务端返回：${body}`;
    default:
      if (status >= 500) {
        return `服务商暂时故障（${status}）：稍后重试，或换一家模型。\n服务端返回：${body}`;
      }
      return `请求失败（${status}）。\n服务端返回：${body}`;
  }
}

function describeNetworkError(e: unknown, config: LLMConfig): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof DOMException && e.name === 'AbortError') return '请求已取消。';
  // 浏览器抛的是 TypeError("Failed to fetch" / "Load failed")，
  // Node/undici 抛的是 TypeError("fetch failed")，底层原因可能是 DNS、拒连或跨域。
  if (
    e instanceof TypeError ||
    /Failed to fetch|NetworkError|Load failed|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(msg)
  ) {
    return (
      '网络请求被拦截。常见原因有两种：\n' +
      '1）浏览器跨域（CORS）限制——网页版直连大模型接口时会出现，可在「模型配置」里填一个代理前缀，或改用 App 版（原生请求不受跨域限制）；\n' +
      '2）手机当前网络无法访问该接口地址——国内网络访问国外接口需要代理。\n' +
      `当前接口：${config.baseUrl}`
    );
  }
  return `请求出错：${msg}`;
}

/* ------------------------------ 主体 ------------------------------ */

function buildBody(config: LLMConfig, messages: ChatMessage[], opts: ChatOptions, stream: boolean) {
  const body: Record<string, unknown> = {
    model: config.model.trim(),
    messages,
    temperature: opts.temperature ?? config.temperature ?? 0.6,
    stream,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  // 不是所有服务商都支持 response_format，失败时由调用方降级重试
  if (opts.jsonMode && !stream) body.response_format = { type: 'json_object' };
  return body;
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '(无法读取响应体)';
  }
}

/**
 * 发起一次对话请求，返回完整文本。
 * 提供 opts.onDelta 时使用流式，边生成边回调。
 */
export async function chat(
  config: LLMConfig,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  if (!config.baseUrl.trim()) throw new Error('还没有配置接口地址，请先到「我的 → 模型配置」里填写。');
  if (!config.model.trim()) throw new Error('还没有填写模型 ID，请先到「我的 → 模型配置」里填写。');
  if (!config.apiKey.trim()) throw new Error('还没有填写 API Key，请先到「我的 → 模型配置」里填写。');

  const url = resolveUrl(chatCompletionsUrl(config.baseUrl), config.proxyPrefix);
  const streaming = Boolean(opts.onDelta);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey.trim()}`,
  };
  const payload = buildBody(config, messages, opts, streaming);

  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  /** 出错时用这个把"哪家、哪个模型"说清楚，不然用户只能干瞪眼 */
  const where = `${config.model || '(未填模型)'} @ ${hostOf(config.baseUrl)}`;

  const native = getNativeHttp();
  if (native) {
    // 原生壳：一次性拿回结果（原生流式实现复杂，收益有限，暂不做）
    let res: { status: number; data: unknown };
    try {
      res = await native.request({
        url,
        method: 'POST',
        headers,
        data: payload,
        // 原生通道只有读超时；按空闲超时 + 一点余量，别再挂 3 分钟
        readTimeout: idleMs + 30_000,
        connectTimeout: 20_000,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/timeout|timed out|超时/i.test(msg)) {
        throw new Error(
          `等 ${Math.round((idleMs + 30_000) / 1000)} 秒还没有回应（${where}）。` +
            '可能是模型名不对、服务商在排队、或者网络不通。建议：到「我的 → 模型配置」点「从服务商获取模型列表」重新选一个模型，再点「测试连接」确认。',
        );
      }
      throw new Error(describeNetworkError(e, config));
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(describeHttpError(res.status, JSON.stringify(res.data ?? '')));
    }
    const text = extractContent(res.data);
    if (opts.onDelta && text) opts.onDelta(text);
    return { content: text };
  }

  // 浏览器通路：自己实现空闲超时（以前这里完全没有超时，卡住就是永远卡住）
  const ctrl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, idleMs);
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const onOuterAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onOuterAbort);
  touch();

  const netError = (e: unknown): Error => {
    if (timedOut) {
      return new Error(
        `等 ${Math.round(idleMs / 1000)} 秒没有收到任何数据（${where}）。` +
          '可能是模型名不对、服务商在排队、或者网络不通。建议：到「我的 → 模型配置」点「从服务商获取模型列表」重新选一个模型，再点「测试连接」确认。',
      );
    }
    return new Error(describeNetworkError(e, config));
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    // jsonMode 不被支持时，服务端可能直接拒绝，这里兜底重试一次不带 response_format
    if (opts.jsonMode && !streaming && !timedOut) {
      const retryPayload = buildBody(config, messages, { ...opts, jsonMode: false }, false);
      try {
        touch();
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(retryPayload),
          signal: ctrl.signal,
        });
      } catch (e2) {
        clear();
        opts.signal?.removeEventListener('abort', onOuterAbort);
        throw netError(e2);
      }
    } else {
      clear();
      opts.signal?.removeEventListener('abort', onOuterAbort);
      throw netError(e);
    }
  }

  if (!res.ok) {
    let bodyText = await readErrorBody(res);
    // 有些服务商不支持 response_format，去掉后重试一次
    if (opts.jsonMode && (res.status === 400 || res.status === 422)) {
      touch();
      const retry = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildBody(config, messages, { ...opts, jsonMode: false }, false)),
        signal: ctrl.signal,
      });
      if (retry.ok) {
        clear();
        opts.signal?.removeEventListener('abort', onOuterAbort);
        return finalize(await retry.json(), opts);
      }
      bodyText = await readErrorBody(retry);
    }
    clear();
    opts.signal?.removeEventListener('abort', onOuterAbort);
    throw new Error(describeHttpError(res.status, bodyText));
  }

  try {
    if (streaming && res.body) {
      return await streamResponse(res, opts, touch);
    }
    const json = (await res.json()) as unknown;
    return finalize(json, opts);
  } catch (e) {
    throw netError(e);
  } finally {
    clear();
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** 从接口地址里取出主机名，用于错误提示（让用户知道打到了哪里） */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).host;
  } catch {
    return baseUrl.trim() || '(未填地址)';
  }
}

/** 从非流式响应里取正文与用量 */
function finalize(json: unknown, opts: ChatOptions): ChatResult {
  const content = extractContent(json);
  const usage = extractUsage(json);
  if (opts.onDelta && content) opts.onDelta(content);
  return { content, usage };
}

function extractContent(json: unknown): string {
  const choices = (json as { choices?: { message?: { content?: unknown }; text?: unknown }[] })?.choices;
  const first = choices?.[0];
  if (!first) {
    const err = (json as { error?: { message?: string } })?.error;
    if (err?.message) throw new Error(`模型返回错误：${err.message}`);
    return '';
  }
  const raw = first.message?.content ?? first.text ?? '';
  if (typeof raw === 'string') return raw;
  // 有些服务商把 content 返回成数组（多模态格式）
  if (Array.isArray(raw)) {
    return raw
      .map((p) => (typeof p === 'string' ? p : ((p as TextPart)?.text ?? '')))
      .join('');
  }
  return String(raw ?? '');
}

function extractUsage(json: unknown): ChatResult['usage'] {
  const u = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage;
  if (!u) return undefined;
  return { prompt: u.prompt_tokens, completion: u.completion_tokens };
}

/** 解析 SSE 流。若服务端其实返回的是普通 JSON（无视了 stream:true），自动退回普通解析。 */
async function streamResponse(
  res: Response,
  opts: ChatOptions,
  touch?: () => void,
): Promise<ChatResult> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let rawAll = '';
  let sawSse = false;

  for (;;) {
    const { done, value } = await reader.read();
    // 每收到一块数据就把空闲计时器重置：只要还在吐字就不算卡住
    touch?.();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    rawAll += chunk;
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      sawSse = true;
      try {
        const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          opts.onDelta?.(delta);
        }
      } catch {
        // 单行解析失败不影响整体
      }
    }
  }

  // 有些网关（自建代理、部分中转）会无视 stream: true 直接返回一段完整 JSON。
  // 这时按 SSE 解析会得到空字符串——用户看到"没有输出"，却不知道为什么。
  // 所以一个 data: 都没收到时，退回普通解析。
  if (!sawSse) {
    const text = rawAll.trim();
    if (text) {
      try {
        return finalize(JSON.parse(text), opts);
      } catch {
        // 连 JSON 都不是：把原文当内容返回，也总比返回空好
        opts.onDelta?.(text);
        return { content: text };
      }
    }
  }

  return { content: full };
}

/* ------------------------------ 视觉（识图） ------------------------------ */

/** 把 File 转成 data URL */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 用视觉模型识图，返回 Markdown 文本。
 * 用于把电路图、公式截图、课件照片变成可出题的文字。
 */
export async function visionExtract(
  config: LLMConfig,
  dataUrls: string[],
  instruction: string,
  opts: ChatOptions = {},
): Promise<string> {
  const content: ContentPart[] = [{ type: 'text', text: instruction }];
  for (const url of dataUrls) {
    content.push({ type: 'image_url', image_url: { url } });
  }
  const result = await chat(
    config,
    [
      {
        role: 'system',
        content: '你是电工与 PLC 领域的资深教师，擅长把教材图片、电路图、公式截图准确转写成文字。',
      },
      { role: 'user', content },
    ],
    // 识图本身比纯文本慢（图片要上传、模型要多看一轮），所以给更宽的空闲上限；
    // 但仍然要有上限——没有上限时用户看到的就是"点了一下然后一直转圈"。
    { ...opts, temperature: opts.temperature ?? 0.2, idleTimeoutMs: opts.idleTimeoutMs ?? VISION_IDLE_TIMEOUT_MS },
  );
  return result.content;
}

/* ------------------------------ 连通性测试 ------------------------------ */

/** 拉取服务商支持的模型列表 */
export async function listModels(config: LLMConfig): Promise<string[]> {
  const url = resolveUrl(modelsUrl(config.baseUrl), config.proxyPrefix);
  const headers = { Authorization: `Bearer ${config.apiKey.trim()}` };
  const native = getNativeHttp();
  if (native) {
    const res = await native.request({ url, method: 'GET', headers, readTimeout: 30_000, connectTimeout: 15_000 });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(describeHttpError(res.status, JSON.stringify(res.data ?? '')));
    }
    return pickModelIds(res.data);
  }
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    throw new Error(describeNetworkError(e, config));
  }
  if (!res.ok) throw new Error(describeHttpError(res.status, await readErrorBody(res)));
  return pickModelIds(await res.json());
}

function pickModelIds(json: unknown): string[] {
  const data = (json as { data?: unknown })?.data;
  if (Array.isArray(data)) {
    return data
      .map((m) => (typeof m === 'string' ? m : String((m as { id?: string })?.id ?? '')))
      .filter(Boolean);
  }
  if (Array.isArray(json)) return json.map(String);
  return [];
}

/** 发一句最短的话验证配置是否可用（故意给短超时：用户要的是立刻知道通不通） */
export async function testConnection(config: LLMConfig): Promise<string> {
  const res = await chat(config, [{ role: 'user', content: '回复两个字：正常' }], {
    temperature: 0,
    maxTokens: 16,
    idleTimeoutMs: 20_000,
  });
  return res.content.trim() || '(模型返回为空)';
}
