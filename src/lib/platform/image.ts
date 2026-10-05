/**
 * 图片压缩（给识图用）。
 *
 * 为什么必须压：手机拍的课件照片动辄 3~8 MB，转成 base64 还要再涨约 33%。
 * 一次识图最多带 6 张，原图直发就是几十 MB 的请求体——
 * 移动网络下基本必然失败（用户只会看到一句看不懂的报错），
 * 而且视觉模型按图片体积计费，白花的都是钱。
 *
 * 缩到长边 1280、JPEG 质量 0.85 后单张通常 200~400 KB，
 * 对识别课件文字、电路图、公式这个分辨率是够的。
 *
 * 注意：本来就不大的图片会原样返回，避免"压了两次"损失画质。
 */

export interface ImageSize {
  width: number;
  height: number;
}

export interface CompressOptions {
  /** 长边上限，默认 1280 */
  maxEdge?: number;
  /** JPEG 质量 0~1，默认 0.85 */
  quality?: number;
  /** 小于这个字节数、且长边不超限的图片直接原样返回 */
  skipBelowBytes?: number;
  /** 加载图片的超时（毫秒），默认 8000；超时就放弃压缩、返回原图 */
  loadTimeoutMs?: number;
}

const DEFAULTS = { maxEdge: 1280, quality: 0.85, skipBelowBytes: 400 * 1024, loadTimeoutMs: 8000 };

/**
 * 等比缩放到长边不超过 maxEdge。
 * 保证结果的长边**严格不超过** maxEdge（四舍五入可能多出 1 像素，这里夹住）。
 */
export function targetSize(width: number, height: number, maxEdge: number): ImageSize {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1 };
  }
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width: Math.round(width), height: Math.round(height) };

  const scale = maxEdge / longest;
  let w = Math.round(width * scale);
  let h = Math.round(height * scale);
  if (Math.max(w, h) > maxEdge) {
    if (w >= h) w = maxEdge;
    else h = maxEdge;
  }
  return { width: Math.max(1, w), height: Math.max(1, h) };
}

/* ------------------------------ 内部工具 ------------------------------ */

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 用 <img> 解码。
 *
 * 必须带超时：图片解码有可能既不触发 onload 也不触发 onerror
 * （解码器卡住、data URL 过长、某些 WebView 的边界情况），
 * 那样这个 Promise 永远不会 settle，用户的识图流程就会一直停在"正在压缩…"。
 * 宁可放弃压缩返回原图，也不能挂死。
 */
function loadImageElement(src: string, timeoutMs: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const finish = (value: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    img.onload = () => finish(img);
    img.onerror = () => finish(null);
    img.src = src;
  });
}

interface Drawable {
  source: CanvasImageSource;
  width: number;
  height: number;
}

/** 优先用 createImageBitmap（更快、不阻塞），不支持或失败时退回 <img> */
async function loadDrawable(file: File, dataUrl: string, timeoutMs: number): Promise<Drawable | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // 落到下面的 <img> 分支
    }
  }
  const img = await loadImageElement(dataUrl, timeoutMs);
  if (!img) return null;
  return { source: img, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
}

/* ------------------------------ 对外接口 ------------------------------ */

/**
 * 把图片压成 data URL。
 * 任何一步失败都退回原图——宁可发大一点，也不能因为压缩失败让用户没法识图。
 */
export async function compressImageToDataUrl(file: File, opts: CompressOptions = {}): Promise<string> {
  const { maxEdge, quality, skipBelowBytes, loadTimeoutMs } = { ...DEFAULTS, ...opts };
  const dataUrl = await readAsDataUrl(file);

  const drawable = await loadDrawable(file, dataUrl, loadTimeoutMs);
  if (!drawable) return dataUrl;

  const longest = Math.max(drawable.width, drawable.height);
  // 又小又不超限：原样返回，避免二次压缩损失画质
  if (file.size <= skipBelowBytes && longest <= maxEdge) return dataUrl;

  const target = targetSize(drawable.width, drawable.height, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;

  ctx.drawImage(drawable.source, 0, 0, target.width, target.height);
  try {
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    // 某些环境下 canvas 会被判为污染，toDataURL 会抛错
    return dataUrl;
  }
}

/** 批量压缩，并给出压缩前后的体积，便于界面提示 */
export async function compressImages(
  files: File[],
  opts: CompressOptions = {},
): Promise<{ dataUrls: string[]; originalBytes: number; compressedBytes: number }> {
  const dataUrls: string[] = [];
  let originalBytes = 0;
  let compressedBytes = 0;

  for (const file of files) {
    originalBytes += file.size;
    const url = await compressImageToDataUrl(file, opts);
    dataUrls.push(url);
    // data URL 里 base64 段的长度 × 3/4 就是实际字节数
    const base64 = url.slice(url.indexOf(',') + 1);
    compressedBytes += Math.round((base64.length * 3) / 4);
  }

  return { dataUrls, originalBytes, compressedBytes };
}

/** 体积转成人话，例如 4.2 MB */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
