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
  /**
   * 思考模式：
   *   · `'off'` —— 对认识的服务商（DeepSeek / 通义 / 智谱）直接关掉思考模式。
   *     **结构化任务（出题、大纲、判分、连通性测试）都应该用它**：
   *     更快、更便宜，而且不会出现"额度被思考吃光、content 是空的"。
   *   · 不传 = 用服务商默认（DeepSeek 默认是开）。
   */
  thinking?: 'off' | 'default';
  /** 不关思考时把强度压到多少（默认 low：学习 App 里速度比"想得更深"重要） */
  reasoningEffort?: 'low' | 'high' | 'max';
}

/** 默认空闲超时：45 秒没有任何数据就判定为卡住 */
export const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
/** 识图/长文这类请求本身更慢，给更宽的空闲上限 */
export const VISION_IDLE_TIMEOUT_MS = 90_000;

export interface ChatResult {
  content: string;
  /** 粗略 token 统计，服务商返回时才有 */
  usage?: { prompt?: number; completion?: number };
  /** 推理型模型的思维链（content 为空时用来判断"它到底想没想"） */
  reasoning?: string;
  /** 服务端原始返回（出问题时用来诊断：是空 JSON、还是只有 [DONE]） */
  raw?: string;
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
  const raw = e instanceof Error ? e.message : String(e);
  // undici/浏览器会把底层原因包在 cause 里（如 TypeError: fetch failed ← socket hang up），
  // 只看最外层会漏掉真正的原因
  const cause = (e as { cause?: { message?: string; code?: string } })?.cause;
  const msg = `${raw} ${cause?.message ?? ''} ${cause?.code ?? ''}`.trim();
  if (e instanceof DOMException && e.name === 'AbortError') return '请求已取消。';
  // **偶发中断要排在前面**：undici 把它包成 "fetch failed"，
  // 先判"跨域/网络被拦"就会给出完全误导的提示（用户看到的英文原文也解释了）
  if (/connection abort|ECONNRESET|socket hang up|EPIPE|network is unreachable|UND_ERR_SOCKET/i.test(msg)) {
    return `连接被中断了（${raw}）。多半是网络切换或服务商瞬断，稍等一下再试通常就好；如果一直这样，换个网络或换个模型。`;
  }
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
  // 手机网络的"连接被中断"：用户看到的原文是
  // "Software caused connection abort"（Windows/安卓底层 WSAECONNABORTED），
  // 完全看不懂，而且它多半是**偶发**的（切网、服务商断流），所以自动重试一次。
  return `请求出错：${raw}`;
}

/** 是不是"偶发连接中断"这类值得自动重试的错误 */
export function isTransientNetworkError(e: unknown): boolean {
  const raw = e instanceof Error ? e.message : String(e);
  const cause = (e as { cause?: { message?: string; code?: string } })?.cause;
  const msg = `${raw} ${cause?.message ?? ''} ${cause?.code ?? ''}`;
  return /connection abort|ECONNRESET|socket hang up|EPIPE|network is unreachable|UND_ERR_SOCKET|fetch failed|Load failed/i.test(
    msg,
  );
}

/* ------------------------------ 主体 ------------------------------ */

/**
 * 各家"思考模式"的关闭参数。
 *
 * 为什么必须处理这个：DeepSeek 的 `deepseek-flash`（V4.1-Flash）**默认开着思考模式**，
 * 模型会先把额度花在思维链上（`reasoning_content`），最后才写 `content`。
 * 我们要的是**结构化 JSON**（出题、大纲、判分），思考模式：
 *   · 更慢、更贵；
 *   · 额度被思考吃光时 `content` 直接是空的 —— 用户看到的就是
 *     "连接成功，模型回复：(模型返回为空)" 和 "模型没有返回合法 JSON（no braces）"。
 *
 * 所以对认识的服务商，直接把思考关掉；不认识的**绝不乱发字段**
 * （很多网关遇到不认识的字段会直接 400）。
 */
export function thinkingOffParam(config: LLMConfig): Record<string, unknown> | null {
  const host = hostOf(config.baseUrl).toLowerCase();
  const model = config.model.trim().toLowerCase();

  // 按**域名或模型名**判断厂商：很多人用中转/代理地址调同一家的模型，
  // 只看域名会漏掉；只看模型名又可能被自定义名字骗到，两个都认更稳。
  const isDeepSeek = host.includes('deepseek.com') || /^deepseek/.test(model);
  const isQwen = host.includes('dashscope') || host.includes('aliyuncs') || /^qwen/.test(model);
  const isZhipu = host.includes('bigmodel') || host.includes('zhipu') || /^glm/.test(model);

  if (isDeepSeek) {
    // 官方文档：{"thinking": {"type": "enabled/disabled"}}。
    // 推理专用模型（*-reasoner）本来就是靠思考工作的，不去动它。
    return /reasoner/.test(model) ? null : { thinking: { type: 'disabled' } };
  }
  if (isQwen) return { enable_thinking: false };
  if (isZhipu) return { thinking: { type: 'disabled' } };
  // 不认识的服务商**绝不乱发字段**：很多网关遇到不认识的字段会直接 400
  return null;
}

/**
 * 要不要给这家服务商发 `response_format`。
 *
 * **DeepSeek 不发**：官方文档《JSON Output》注意事项第 4 条明确写着
 *   "在使用 JSON Output 功能时，API 有概率会返回空的 content。
 *    我们正在积极优化该问题，您可以尝试修改 prompt 以缓解此类问题。"
 * 用户实测完全对得上：纯文本（测试连接）正常，一出题（要 JSON）就 4 批全空。
 *
 * 我们的提示词里本来就写死了"只输出一个 JSON 对象、不要解释文字、
 * 不要代码围栏"，解析器也能容忍代码围栏和多余文字 —— 所以**不依赖这个参数更稳**。
 */
export function shouldSendResponseFormat(config: LLMConfig): boolean {
  const host = hostOf(config.baseUrl).toLowerCase();
  const model = config.model.trim().toLowerCase();
  const isDeepSeek = host.includes('deepseek.com') || /^deepseek/.test(model);
  return !isDeepSeek;
}

function buildBody(config: LLMConfig, messages: ChatMessage[], opts: ChatOptions, stream: boolean) {
  const body: Record<string, unknown> = {
    model: config.model.trim(),
    messages,
    stream,
  };

  // 思考模式的开关与强度
  const thinkingOff = opts.thinking === 'off';
  if (thinkingOff) {
    Object.assign(body, thinkingOffParam(config) ?? {});
  } else {
    // 不关思考时把强度压到 low：这是个学习 App，速度比"想得更深"重要
    body.reasoning_effort = opts.reasoningEffort ?? 'low';
  }

  // 官方明确：思考模式下 temperature 不生效（发了也不报错，但会被忽略）。
  // 关掉思考时它才有效，所以只在"确实关掉了思考"或"压根没发思考参数"时发，
  // 避免给出"以为在调参"的假象。
  const thinkingDisabled = thinkingOff && thinkingOffParam(config) !== null;
  if (!thinkingDisabled) body.temperature = opts.temperature ?? config.temperature ?? 0.6;

  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  // 不是所有服务商都支持 response_format，失败时由调用方降级重试；
  // DeepSeek 干脆不发（它的 JSON Output 有概率返回空 content，官方文档承认）
  if (opts.jsonMode && !stream && shouldSendResponseFormat(config)) {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

/**
 * 空回复不是成功。
 *
 * 踩过的坑：DeepSeek 的 deepseek-flash 默认开思考模式，我们只给了 16 个 token，
 * 思考把额度用光 → HTTP 200 但 `content` 是空字符串 →
 * 旧代码照样报"连接成功，模型回复：(模型返回为空)"，用户一头雾水，
 * 真去出题时全是"模型没有返回合法 JSON"。
 *
 * 现在：空内容一律当失败，并且把可能的原因和下一步说清楚。
 */
function emptyReplyError(
  config: LLMConfig,
  reasoning: string,
  opts: ChatOptions,
  rawSnippet = '',
): Error {
  const where = `${config.model || '(未填模型)'} @ ${hostOf(config.baseUrl)}`;
  const sawReasoning = reasoning.trim().length > 0;
  // 把服务端**实际返回的东西**带一小段出来：没有这个，排查只能靠猜
  // （用户截图里那句"一个字都没有"就没法区分"返回了空 JSON"和"只返回了 [DONE]"）
  const snippet = rawSnippet.trim()
    ? ` 服务端原文开头：${rawSnippet.trim().slice(0, 200).replace(/\s+/g, ' ')}`
    : '';
  return new Error(
    (sawReasoning
      ? `模型只输出了思考内容、没有给出最终答案（${where}）。`
      : `模型返回了空内容（HTTP 200 但一个字都没有，${where}）。`) +
      '常见原因：① 这是推理型模型且 max_tokens 太小，额度被"思考"用光了；' +
      '② 流式返回与"关闭思考"的组合在某些服务商上会返回空；' +
      '③ 模型名不对或该模型不支持这种请求方式；④ 服务商侧异常。' +
      (opts.jsonMode ? '（本次要的是 JSON，App 应当已自动关闭思考模式。）' : '') +
      ' App 已经自动重试过（流式→非流式、去掉 JSON 模式参数），仍失败才报这条。' +
      ' 建议：到「我的 → 模型配置」点「测试连接」看是否也是空回复；' +
      '若测试正常而出题为空，请把这条错误连同"服务端原文"一起反馈。' +
      snippet,
  );
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
  if (!config.apiKey.trim()) throw new Error('还没有配置 API Key，请先到「我的 → 模型配置」里填写。');

  // 要 JSON 的任务（出题、大纲、判分、识图取结构化结果）一律关掉思考模式：
  // 更快、更省钱，而且**不会出现"思考把 max_tokens 用光、content 是空的"**——
  // 这正是用户遇到的"测试连接正常、真出题全是空/无法解析 JSON"的根因。
  if (opts.jsonMode && !opts.thinking) opts = { ...opts, thinking: 'off' };

  const url = resolveUrl(chatCompletionsUrl(config.baseUrl), config.proxyPrefix);
  const streaming = Boolean(opts.onDelta);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey.trim()}`,
  };
  const payload = buildBody(config, messages, opts, streaming);

  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  /** 这次请求是否带上了 response_format（空回复时要用"去掉它"再试一次） */
  const sentResponseFormat = Boolean(opts.jsonMode && !streaming && shouldSendResponseFormat(config));
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
    if (text.trim()) return { content: text };
    // 空回复 + 我们发过 response_format → 去掉它再试一次
    if (sentResponseFormat) {
      const retry = await native.request({
        url,
        method: 'POST',
        headers,
        data: buildBody(config, messages, { ...opts, jsonMode: false }, false),
        readTimeout: idleMs + 30_000,
        connectTimeout: 20_000,
      });
      if (retry.status >= 200 && retry.status < 300) {
        const retryText = extractContent(retry.data);
        if (retryText.trim()) {
          if (opts.onDelta && retryText) opts.onDelta(retryText);
          return { content: retryText };
        }
      }
    }
    throw emptyReplyError(config, extractReasoning(res.data), opts, safeStringify(res.data));
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

  /**
   * 带一次自动重试的发送。
   * 手机网络里"Software caused connection abort / ECONNRESET"这类**偶发**中断很常见，
   * 用户看到的却是一句看不懂的英文；直接失败会让他以为程序坏了。超时和主动取消不重试。
   */
  const doFetch = async (bodyObj: unknown): Promise<Response> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        touch();
        return await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(bodyObj),
          signal: ctrl.signal,
        });
      } catch (e) {
        lastErr = e;
        if (timedOut || opts.signal?.aborted || !isTransientNetworkError(e)) throw e;
      }
    }
    throw lastErr;
  };

  let res: Response;
  try {
    res = await doFetch(payload);
  } catch (e) {
    // jsonMode 不被支持时，服务端可能直接拒绝，这里兜底重试一次不带 response_format
    if (opts.jsonMode && !streaming && !timedOut) {
      const retryPayload = buildBody(config, messages, { ...opts, jsonMode: false }, false);
      try {
        res = await doFetch(retryPayload);
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
      const retry = await doFetch(buildBody(config, messages, { ...opts, jsonMode: false }, false));
      if (retry.ok) {
        clear();
        opts.signal?.removeEventListener('abort', onOuterAbort);
        const out = finalize(await retry.json(), opts);
        if (!out.content.trim()) throw emptyReplyError(config, out.reasoning ?? '', opts, out.raw ?? '');
        return out;
      }
      bodyText = await readErrorBody(retry);
    }
    clear();
    opts.signal?.removeEventListener('abort', onOuterAbort);
    throw new Error(describeHttpError(res.status, bodyText));
  }

  let result: ChatResult;
  try {
    if (streaming && res.body) {
      result = await streamResponse(res, opts, touch);
    } else {
      const json = (await res.json()) as unknown;
      result = finalize(json, opts);
    }
  } catch (e) {
    throw netError(e);
  } finally {
    clear();
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }

  // HTTP 200 但没有正文**不是成功**。空回复曾经被当成"连接成功"报给用户，
  // 结果他真去出题时全是"模型没有返回合法 JSON"——必须在这里拦住。
  //
  // 拦之前先自救两次，按最可能的原因排序：
  //  ① **流式返回空 → 换非流式再来一次**。
  //     实测证据：同一模型、同样关着思考，"测试连接"（非流式）正常，
  //     一出题（我为了显示进度用了流式）就空 —— 差别只有流式这一个。
  //  ② 发过 response_format → 去掉它再来一次（DeepSeek 的 JSON Output
  //     有概率返回空 content，官方文档已承认）。
  if (!result.content.trim() && streaming) {
    try {
      const plainRes = await doFetch(buildBody(config, messages, { ...opts, onDelta: undefined }, false));
      if (plainRes.ok) {
        const plainOut = finalize(await plainRes.json(), opts);
        if (plainOut.content.trim()) result = plainOut;
      }
    } catch {
      // 重试也失败就继续往下走，最终按空回复报错
    } finally {
      clear();
    }
  }
  if (!result.content.trim() && sentResponseFormat && !streaming) {
    // 去掉 response_format 再试一次：DeepSeek 的 JSON Output 会概率性返回空内容
    // （官方文档已承认）。提示词里本来就要求只输出 JSON，去掉它通常就好了。
    try {
      const retryRes = await doFetch(buildBody(config, messages, { ...opts, jsonMode: false }, false));
      if (retryRes.ok) {
        const retryOut = finalize(await retryRes.json(), opts);
        if (retryOut.content.trim()) result = retryOut;
      }
    } catch {
      // 重试也失败就按空回复报错，错误信息里有排查指引
    } finally {
      clear();
    }
  }
  if (!result.content.trim()) {
    throw emptyReplyError(config, result.reasoning ?? '', opts, result.raw ?? '');
  }
  return result;
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
  const reasoning = extractReasoning(json);
  if (opts.onDelta && content) opts.onDelta(content);
  const raw = safeStringify(json);
  return reasoning ? { content, usage, reasoning, raw } : { content, usage, raw };
}

/** 把响应转成便于诊断的短字符串（不能因为循环引用之类的把流程搞崩） */
function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value ?? '');
  } catch {
    return '';
  }
}

/** 取思维链内容（DeepSeek 等把 CoT 放在与 content 同级的 reasoning_content） */
export function extractReasoning(json: unknown): string {
  const first = (json as { choices?: { message?: { reasoning_content?: unknown } }[] })?.choices?.[0];
  const raw = first?.message?.reasoning_content;
  return typeof raw === 'string' ? raw : '';
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
  /** 思维链（推理型模型会先吐这个）；最终 content 为空时它是唯一线索 */
  let reasoning = '';
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
        const parsed = JSON.parse(data) as {
          choices?: { delta?: { content?: string; reasoning_content?: string } }[];
        };
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.reasoning_content) reasoning += delta.reasoning_content;
        if (delta?.content) {
          full += delta.content;
          opts.onDelta?.(delta.content);
        }
      } catch {
        // 单行解析失败不影响整体
      }
    }
  }

  // 有些网关（自建代理、部分中转）会无视 stream: true 直接返回一段完整 JSON。
  // 这时按 SSE 解析会得到空字符串——用户看到"没有输出"，却不知道为什么。
  // 所以一个 data: 都没收到时，退回普通解析。
  //
  // 但**只收到 [DONE] 这类标记不算"有内容"**：曾经因此把 "data: [DONE]"
  // 当成模型输出返回给上层（日志里就是一句莫名其妙的 data: [DONE]）。
  const stripped = rawAll
    .replace(/^\s*data:\s*/gim, '')
    .replace(/\[DONE\]/gi, '')
    .trim();
  if (!sawSse && stripped) {
    try {
      return finalize(JSON.parse(stripped), opts);
    } catch {
      // 连 JSON 都不是：把原文当内容返回，也总比返回空好
      opts.onDelta?.(stripped);
      return { content: stripped };
    }
  }

  return reasoning ? { content: full, reasoning, raw: rawAll } : { content: full, raw: rawAll };
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
    //
    // **识图也默认关掉思考模式**：读一张书皮/一张电路图是"把图里的东西抄出来"，
    // 不需要长篇思维链；而开着思考时（DeepSeek 的 deepseek-flash 默认开）
    // 又慢、又可能因为额度被思考吃光而返回空内容——用户看到的就是"识图没反应/识别不出来"。
    {
      ...opts,
      temperature: opts.temperature ?? 0.2,
      thinking: opts.thinking ?? 'off',
      idleTimeoutMs: opts.idleTimeoutMs ?? VISION_IDLE_TIMEOUT_MS,
    },
  );
  return result.content;
}

/* ------------------------------ 连通性测试 ------------------------------ */

/**
 * 一张很小的测试图（48×48：蓝底 + 中间白色圆 + 左上黄色方块）。
 * 用来验证"这个模型到底能不能看图"，见 testVisionConnection。
 */
export const VISION_PROBE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAABBklEQVR4AdXBTY2WYQyG0WvufBbY0g1CqIOKQQ0mqIMawERtsBnCbsKGvM9PQs95+/Xz0zsLvnz7zv9ADCeGE8OJ4cRwYjgxnBhODCeGE8OJy7qCm14c1hX8rSv4yDw55e3z1x/vHNAVPGWe7BIHdAUruoJdYlNXsKMr2CE2dAUndAWrxKKu4KSuYIUYTizoCm7oCp4Sw4nhxHDioa7gpq7gCfGQeXKTefKEGE4MJ4YTC8yTG8yTp8RwYpF5cpJ5skJsME9OME9WiU3myQ7zZIc4wDxZYZ7senGIefJHV/Av5skpLw4zTz7qCsyTW8Rl5slNYjgxnBhODCeGE8OJ4cRwYjgx3G/+fz2N4sq8TwAAAABJRU5ErkJggg==';

/**
 * 验证"这个模型到底能不能看图"。
 *
 * 为什么单做这个：用户配了识图模型，点「测试连接」显示一切正常——
 * 因为那只发了一句文字。可**真拿去识别图片时却一直失败或者没反应**，
 * 原因是很多模型**根本不吃图片输入**（把文本模型填进识图配置是最常见的一种）。
 * 纯文本的连通性测试永远发现不了这个问题。
 *
 * 这里直接发一张真实的小图，让模型说出它看到了什么：
 *   · 报错 → 这个模型不支持图片输入，当场告诉用户；
 *   · 答得牛头不对马嘴（没提到蓝/圆）→ 图很可能被忽略了，也要提醒。
 */
export async function testVisionConnection(config: LLMConfig): Promise<string> {
  const reply = await visionExtract(
    config,
    [VISION_PROBE_IMAGE],
    '这是一张很小的测试图。请只回答两点：1) 底色是什么颜色？2) 中间是什么形状？不要解释。',
    // 关掉思考 + 给足额度：推理型模型（如 deepseek-flash 默认开思考）会把额度花在
    // 思维链上，content 就空了，测试会误判成"模型不行"，其实是预算没给够。
    { temperature: 0, maxTokens: 512, thinking: 'off', idleTimeoutMs: VISION_IDLE_TIMEOUT_MS },
  );
  return reply.trim() || '(模型返回为空)';
}

/** 模型对测试图的回答是否"真的看到了图"（认出蓝色或圆形） */
export function looksLikeItSawTheImage(reply: string): boolean {
  const t = String(reply ?? '').toLowerCase();
  const color = /蓝|blue/.test(t);
  const shape = /圆|circle|轮/.test(t);
  return color || shape;
}

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
    // 这里曾经只给 16 个 token：推理型模型（DeepSeek 的 deepseek-flash 默认开思考模式）
    // 思考就把额度用光，content 是空的，界面却报
    // "连接成功，模型回复：(模型返回为空)" —— 用户据此以为配置没问题，
    // 真去出题时却全是"模型没有返回合法 JSON"。
    // 现在：关掉思考 + 给足额度，"测试通不通"才真的可信。
    maxTokens: 512,
    thinking: 'off',
    idleTimeoutMs: 20_000,
  });
  return res.content.trim() || '(模型返回为空)';
}
