/**
 * 慕课抓取用的网络通道。
 *
 * 为什么单独写一个：慕课接口**不返回可用的跨域头**（实测
 * `access-control-allow-origin` 是空的），所以浏览器里的网页版**抓不了**——
 * 会被浏览器拦掉，报一个用户看不懂的跨域错误。
 *
 * App（APK）里走 Capacitor 的原生请求，不受跨域限制，而且能拿到
 * `set-cookie`（接口要拿 cookie 里的值当 csrfKey，浏览器里跨域取不到）。
 *
 * 网页版上返回 null，由界面明确提示"请用 APK 版"，而不是让请求失败在那里。
 */
import type { HttpResult, MoocHttp } from '../mooc/icourse163';

interface CapacitorHttpPlugin {
  request(options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    data?: unknown;
    readTimeout?: number;
    connectTimeout?: number;
  }): Promise<{ status: number; data: unknown; headers: Record<string, string | string[]> }>;
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

/** 从响应头里把 set-cookie 取成数组（原生插件可能给字符串、数组、或逗号拼接） */
export function extractSetCookie(headers: Record<string, string | string[]> | undefined): string[] {
  if (!headers) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'set-cookie') continue;
    if (Array.isArray(v)) out.push(...v);
    else if (typeof v === 'string') out.push(v);
  }
  return out;
}

/**
 * 造一个慕课用的原生 HTTP 通道。
 * 不在 App 里（或插件不可用）时返回 null——调用方据此提示"请用 APK 版"。
 */
export function createMoocHttp(): MoocHttp | null {
  const native = getNativeHttp();
  if (!native) return null;

  return {
    async request({ url, method, headers, body }): Promise<HttpResult> {
      const res = await native.request({
        url,
        method,
        headers: { ...(headers ?? {}) },
        data: body,
        readTimeout: 90_000, // 题库一次好几 MB，给足时间
        connectTimeout: 20_000,
      });
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
      return { status: res.status, text, setCookie: extractSetCookie(res.headers) };
    },
  };
}
