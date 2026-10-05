/**
 * 二维码 / 条形码解码：拍一张照，把码里的内容真解出来。
 *
 * 为什么**必须真解码**、不能让 AI「看着二维码说内容」：
 * 大模型看到一张二维码，会在"看起来合理"的范围里编一个网址给你，
 * 而且编得非常像真的（域名、路径都像）。微课链接、ISBN 这种
 * 错一个字符就完全没用的东西，只能靠真正的解码库。
 *
 * 用 ZXing（纯 JS）：
 *   · 二维码和一维条码（书背的 EAN-13 / ISBN、UPC、Code128…）都能解；
 *   · 完全离线，不联网、不花 API 费用、不上传照片；
 *   · 不需要额外的原生插件，网页版（PWA）和 APK 都能跑。
 */
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';

export interface ScanCode {
  /** 解出来的原始文本（网址 / ISBN / 任意字符串） */
  text: string;
  /** 码制名称，如 QR_CODE、EAN_13 */
  format: string;
}

/** 支持的码制：二维码 + 书背常见的几种一维条码 */
const FORMATS = [  BarcodeFormat.QR_CODE,
  BarcodeFormat.DATA_MATRIX,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.ITF,
  BarcodeFormat.CODABAR,
];

/**
 * 默认时间预算（毫秒）。
 * 实测：拍整张封底、码只占很小一块时，要 **7.1 秒**才能找到第一个二维码；
 * 而拍近的码只要几十到几百毫秒。所以上限给 8 秒——宁可等一会儿，
 * 也不要把本来能解出来的照片判成失败。
 */
export const DEFAULT_TIME_BUDGET_MS = 8000;

/* ============================== 纯计算部分（可单测） ============================== */

/**
 * RGBA 像素 → 灰度数组（0 = 黑，255 = 白）。
 * 权重按人眼感知：绿 0.587 / 红 0.299 / 蓝 0.114。
 */
export function rgbaToLuminance(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  }
  return out;
}

/** 反相（黑白颠倒）：深色背景上的码靠它才解得出来 */
export function invertLuminance(luminance: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(luminance.length);
  for (let i = 0; i < luminance.length; i++) out[i] = 255 - luminance[i];
  return out;
}

/** 顺时针转 90°：一维条码拍歪成竖的时靠它兜底 */
export function rotate90Luminance(
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // 新图尺寸：宽 = height，高 = width
      out[x * height + (height - 1 - y)] = luminance[y * width + x];
    }
  }
  return out;
}

export interface TileRange {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把图切成 grid×grid 个**带重叠**的小块。
 *
 * 为什么要重叠：不重叠的话，码正好被切在边界上就永远解不出来。
 * 为什么要分块：用户拍的是整张封底，二维码可能只占画面 1/10，
 * 直接整张解经常失败——切小块等于"局部放大"，这是标准解法。
 */
export function tileRanges(
  width: number,
  height: number,
  grid: number,
  overlapRatio = 0.25,
): TileRange[] {
  if (grid < 2 || width <= 0 || height <= 0) return [];
  const tileW = Math.ceil(width / grid);
  const tileH = Math.ceil(height / grid);
  const padX = Math.round(tileW * overlapRatio);
  const padY = Math.round(tileH * overlapRatio);
  const out: TileRange[] = [];
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const x = Math.max(0, gx * tileW - padX);
      const y = Math.max(0, gy * tileH - padY);
      const w = Math.min(width - x, tileW + padX * 2);
      const h = Math.min(height - y, tileH + padY * 2);
      if (w > 0 && h > 0) out.push({ x, y, width: w, height: h });
    }
  }
  return out;
}

/** 从大图里裁一块出来（超出边界的部分自动裁掉，不抛异常） */
export function cropLuminance(
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
  r: TileRange,
): Uint8ClampedArray {
  const w = Math.max(0, Math.min(r.width, width - r.x));
  const h = Math.max(0, Math.min(r.height, height - r.y));
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const src = (r.y + y) * width + r.x;
    out.set(luminance.subarray(src, src + w), y * w);
  }
  return out;
}

/** 按整数倍最近邻放大：小码放大后 ZXing 的检测器更容易命中（不引入虚假细节） */
export function scaleUpLuminance(
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
  factor = 2,
): { lum: Uint8ClampedArray; width: number; height: number } {
  if (factor <= 1) return { lum: luminance, width, height };
  const w = width * factor;
  const h = height * factor;
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = luminance[y * width + x];
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * w + x * factor;
        for (let dx = 0; dx < factor; dx++) out[row + dx] = v;
      }
    }
  }
  return { lum: out, width: w, height: h };
}

function tryDecodeOnce(
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
): ScanCode | null {
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, FORMATS);
  // TRY_HARDER：慢一点，但手机上拍的照片往往不够干净，值得
  hints.set(DecodeHintType.TRY_HARDER, true);
  const source = new RGBLuminanceSource(luminance, width, height);
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));
  const result = new MultiFormatReader().decode(bitmap, hints);
  const format = BarcodeFormat[result.getBarcodeFormat()] ?? String(result.getBarcodeFormat());
  return { text: result.getText(), format };
}

/**
 * 纯解码：给一张灰度图，返回码里的内容；解不出来返回 null（**不抛异常**）。
 *
 * 分三层试，越往后越费时间，但能救回越难拍的照片：
 *
 * ① 整张图，四种拍法：正相 → 反相（深底浅码） → 转 90° → 转 90° 再反相
 * ② 分块（2×2 / 3×3 带重叠）再试：正相 + 反相（二维码本身不怕转，一维码在书上是横的，
 *    所以分块阶段不再试旋转，省一半时间）—— 对付"码在整张照片里太小"
 * ③ 分块 ×2 最近邻放大再试 —— 对付"码更小"
 *
 * ②③ 是从真实照片里学到的：用户拍整张封底时，二维码只占画面很小一块，
 * 只试整张图会**全部失败**（实测过），切块后就解出来了。
 *
 * **时间预算**：没有任何码的照片会走完所有分支（上百次尝试）。实测噪点图要 5 秒以上，
 * 大照片更久，用户会以为卡死。所以给一个预算，到点就放弃并如实返回 null，
 * 由界面提示"靠近一点重拍"。
 */
export function decodeLuminance(
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
  options: { timeBudgetMs?: number; onPhase?: (phase: 'full' | 'tiles') => void } = {},
): ScanCode | null {
  if (width <= 0 || height <= 0 || luminance.length < width * height) return null;

  // 默认 8 秒：实测"整张封底找小二维码"要 7.1 秒才能找到（大图 + 切块 + 放大），
  // 预算给小了会把**本来能解出来的**照片判成失败。码拍得近时只要几十毫秒，
  // 所以正常用法根本等不到这个上限。
  const budget = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const started = Date.now();
  const outOfTime = () => Date.now() - started > budget;

  // ① 整张（二维码拍得大时这一层立刻命中，通常几十毫秒）
  const full = tryAllVariants(luminance, width, height);
  if (full) return full;

  // 整张没找到 → 告诉界面"正在切块细找"，别让用户对着转圈发呆
  options.onPhase?.('tiles');

  // ②③ 分块 + 放大
  for (const grid of [2, 3]) {
    for (const tile of tileRanges(width, height, grid)) {
      if (outOfTime()) return null;
      const crop = cropLuminance(luminance, width, height, tile);
      const hit = tryPlainVariants(crop, tile.width, tile.height, outOfTime);
      if (hit) return hit;

      // 放大这一步**不能省**：实测用户拍的那张封底照片，
      // 三个小二维码只有靠"分块 + 放大"才解得出来，只分块不放大是解不出的。
      // 慢的问题交给时间预算兜（每次尝试前都查一次表）。
      if (outOfTime()) return null;
      const up = scaleUpLuminance(crop, tile.width, tile.height, 2);
      const hit2 = tryPlainVariants(up.lum, up.width, up.height, outOfTime);
      if (hit2) return hit2;
    }
  }
  return null;
}

/** 四种拍法：正相 / 反相 / 转 90° / 转 90° 再反相（整张图用这套） */
function tryAllVariants(
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
): ScanCode | null {
  const rotated = rotate90Luminance(luminance, width, height);
  const attempts: Array<{ lum: Uint8ClampedArray; w: number; h: number }> = [
    { lum: luminance, w: width, h: height },
    { lum: invertLuminance(luminance), w: width, h: height },
    { lum: rotated, w: height, h: width },
    { lum: invertLuminance(rotated), w: height, h: width },
  ];
  for (const a of attempts) {
    try {
      const hit = tryDecodeOnce(a.lum, a.w, a.h);
      if (hit) return hit;
    } catch {
      // ZXing 解不出来就是抛异常，这是它的正常控制流，继续试下一种
    }
  }
  return null;
}

/** 两种拍法：正相 + 反相（分块阶段用这套，省一半时间）；每次尝试前查一次时间预算 */
function tryPlainVariants(
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
  outOfTime?: () => boolean,
): ScanCode | null {
  for (const lum of [luminance, invertLuminance(luminance)]) {
    if (outOfTime?.()) return null;
    try {
      const hit = tryDecodeOnce(lum, width, height);
      if (hit) return hit;
    } catch {
      /* 继续 */
    }
  }
  return null;
}

/** 解一张 ImageData（canvas 取出来的像素） */
export function decodeImageData(img: ImageData): ScanCode | null {
  return decodeLuminance(rgbaToLuminance(img.data, img.width, img.height), img.width, img.height);
}

/* ============================== ISBN ============================== */

/** ISBN-13 校验位是否正确（权重 1/3 交替） */
export function isbn13Valid(digits: string): boolean {
  if (!/^\d{13}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(digits[12]);
}

/** ISBN-10 校验位是否正确（末位可能是 X） */
export function isbn10Valid(digits: string): boolean {
  if (!/^\d{9}[\dX]$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * (10 - i);
  sum += digits[9] === 'X' ? 10 : Number(digits[9]);
  return sum % 11 === 0;
}

/**
 * 把扫到的条码文本规范成 ISBN；不是合法 ISBN 就返回 null。
 *
 * 书背条码是 EAN-13，且必须以 978 / 979 开头才是图书。
 * 校验位不对也返回 null——**宁可说"这不是 ISBN"，也不要存一个错的**。
 */
export function normalizeIsbn(raw: string): string | null {
  const digits = raw.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (digits.length === 13) {
    if (!/^97[89]/.test(digits)) return null;
    return isbn13Valid(digits) ? digits : null;
  }
  if (digits.length === 10) return isbn10Valid(digits) ? digits : null;
  return null;
}

/** 显示成 978-7-111-12345-6 这种好读的形式（分组位置按 ISBN 规则） */
export function formatIsbn(isbn: string): string {
  if (isbn.length === 13) {
    return `${isbn.slice(0, 3)}-${isbn[3]}-${isbn.slice(4, 7)}-${isbn.slice(7, 12)}-${isbn.slice(12)}`;
  }
  if (isbn.length === 10) return `${isbn.slice(0, 1)}-${isbn.slice(1, 4)}-${isbn.slice(4, 9)}-${isbn.slice(9)}`;
  return isbn;
}

/** 扫到的内容是哪一类 */
export function classifyScan(text: string): 'isbn' | 'url' | 'text' {
  if (normalizeIsbn(text)) return 'isbn';
  if (/^https?:\/\//i.test(text.trim())) return 'url';
  return 'text';
}

/* ============================== 依赖浏览器 API 的部分 ============================== */

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片打不开，可能不是有效的图片文件。'));
    img.src = dataUrl;
  });
}

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读取图片失败。'));
    fr.readAsDataURL(file);
  });
}

/** 解一张 dataURL 图片（App 里照片压缩后就是这个格式） */
export async function decodeDataUrl(
  dataUrl: string,
  onPhase?: (phase: 'full' | 'tiles') => void,
): Promise<ScanCode | null> {
  const img = await loadImage(dataUrl);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height);
  return decodeLuminance(rgbaToLuminance(pixels.data, width, height), width, height, { onPhase });
}

/** 解一个图片文件（用户拍的或选的）；onPhase 用来告诉界面"正在切块细找" */
export async function decodeImageFile(
  file: Blob,
  onPhase?: (phase: 'full' | 'tiles') => void,
): Promise<ScanCode | null> {
  return decodeDataUrl(await fileToDataUrl(file), onPhase);
}
