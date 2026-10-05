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
const FORMATS = [
  BarcodeFormat.QR_CODE,
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
 * 依次试四种拍法，覆盖最常见的几种"拍不好"：
 *   正相 → 反相（深底浅码） → 转 90° → 转 90° 再反相
 */
export function decodeLuminance(
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
): ScanCode | null {
  if (width <= 0 || height <= 0 || luminance.length < width * height) return null;

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
export async function decodeDataUrl(dataUrl: string): Promise<ScanCode | null> {
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
  return decodeImageData(ctx.getImageData(0, 0, width, height));
}

/** 解一个图片文件（用户拍的或选的） */
export async function decodeImageFile(file: Blob): Promise<ScanCode | null> {
  return decodeDataUrl(await fileToDataUrl(file));
}
