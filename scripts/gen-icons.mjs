/**
 * 生成 PWA 图标（不依赖任何第三方库）。
 *
 * 用 zlib 手写 PNG：深色圆角底 + 青蓝渐变闪电。
 * 输出到 public/：icon-192.png、icon-512.png、icon-maskable-512.png
 *
 * 用法：npm run icons
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'public');

/* ------------------------------ PNG 编码 ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** rgba: Uint8Array，长度 width*height*4 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前面加一个 filter 字节 0
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ 绘图 ------------------------------ */

/** 闪电多边形（归一化坐标，y 向下） */
const BOLT = [
  [0.585, 0.05],
  [0.275, 0.525],
  [0.455, 0.525],
  [0.4, 0.95],
  [0.745, 0.455],
  [0.545, 0.455],
  [0.665, 0.05],
];

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 圆角矩形内部判定 */
function inRoundedRect(x, y, radius) {
  if (x < 0 || y < 0 || x > 1 || y > 1) return false;
  const r = radius;
  const cx = x < r ? r : x > 1 - r ? 1 - r : x;
  const cy = y < r ? r : y > 1 - r ? 1 - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * 渲染一张图标。
 * @param size 边长
 * @param maskable true 时背景铺满（给 Android 自适应图标用），否则用圆角
 */
function render(size, maskable) {
  const rgba = new Uint8Array(size * size * 4);
  const SS = 3; // 3x3 超采样抗锯齿
  const radius = maskable ? 0 : 0.22;
  // maskable 需要留安全区，闪电缩小一点
  const boltScale = maskable ? 0.62 : 0.78;
  const boltOffset = (1 - boltScale) / 2;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let bgCov = 0;
      let boltCov = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;

          // 背景
          if (maskable || inRoundedRect(x, y, radius)) bgCov += 1;

          // 闪电
          const bx = (x - boltOffset) / boltScale;
          const by = (y - boltOffset) / boltScale;
          if (bx >= 0 && bx <= 1 && by >= 0 && by <= 1 && inPolygon(bx, by, BOLT)) boltCov += 1;
        }
      }

      const total = SS * SS;
      const bgA = bgCov / total;
      const boltA = boltCov / total;

      // 背景：深蓝渐变（左上偏浅，右下偏深）
      const t = (px / size + py / size) / 2;
      const bgR = lerp(19, 11, t);
      const bgG = lerp(31, 17, t);
      const bgB = lerp(58, 32, t);

      // 闪电：青→蓝渐变
      const bt = (px / size) * 0.5 + (py / size) * 0.5;
      const boltR = lerp(34, 59, bt);
      const boltG = lerp(211, 130, bt);
      const boltB = lerp(238, 246, bt);

      // 合成：闪电盖在背景上
      const r = lerp(bgR, boltR, boltA);
      const g = lerp(bgG, boltG, boltA);
      const b = lerp(bgB, boltB, boltA);
      const a = Math.round(bgA * 255);

      const i = (py * size + px) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = a;
    }
  }

  return encodePng(size, size, rgba);
}

/* ------------------------------ 输出 ------------------------------ */

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  ['icon-192.png', render(192, false)],
  ['icon-512.png', render(512, false)],
  ['icon-maskable-512.png', render(512, true)],
];

for (const [name, buf] of targets) {
  writeFileSync(resolve(OUT_DIR, name), buf);
  console.log(`已生成 public/${name}（${(buf.length / 1024).toFixed(1)} KB）`);
}

// favicon.svg：同样的观感，矢量版
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#131f3a"/>
      <stop offset="1" stop-color="#0b1120"/>
    </linearGradient>
    <linearGradient id="bolt" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#22d3ee"/>
      <stop offset="1" stop-color="#3b82f6"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#bg)"/>
  <path d="M37.4 6 L17.6 33.6 L29.1 33.6 L25.6 58 L47.7 29.1 L34.9 29.1 L42.6 6 Z"
        fill="url(#bolt)" stroke="url(#bolt)" stroke-width="1.5" stroke-linejoin="round"/>
</svg>
`;
writeFileSync(resolve(OUT_DIR, 'favicon.svg'), svg, 'utf8');
console.log('已生成 public/favicon.svg');
