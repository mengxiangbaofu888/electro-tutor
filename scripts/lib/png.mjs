/**
 * 零依赖 PNG 生成与绘图工具。
 *
 * 为什么要手写 PNG：项目不想为一个图标引入 sharp / canvas 之类的原生依赖。
 * PNG 格式本身很简单（IHDR + IDAT + IEND，像素用 zlib 压缩），Node 自带 zlib 就够。
 *
 * 提供给 gen-icons.mjs（网页图标）和 gen-android-assets.mjs（安卓图标与启动图）共用。
 */
import { deflateSync } from 'node:zlib';

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
export function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前面加一个 filter 字节 0（无滤波）
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** 从 PNG 头部读出尺寸（用于"保持原尺寸替换"的场景） */
export function readPngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/* ------------------------------ 几何 ------------------------------ */

/** 闪电多边形（归一化坐标，y 轴向下） */
export const BOLT = [
  [0.585, 0.05],
  [0.275, 0.525],
  [0.455, 0.525],
  [0.4, 0.95],
  [0.745, 0.455],
  [0.545, 0.455],
  [0.665, 0.05],
];

/** SVG path 形式（给安卓 vector drawable 用，视口 64x64） */
export const BOLT_SVG_PATH = 'M37.4,6 L17.6,33.6 L29.1,33.6 L25.6,58 L47.7,29.1 L34.9,29.1 L42.6,6 Z';

export function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 圆角矩形内部判定（坐标 0..1） */
export function inRoundedRect(x, y, radius) {
  if (x < 0 || y < 0 || x > 1 || y > 1) return false;
  const r = radius;
  const cx = x < r ? r : x > 1 - r ? 1 - r : x;
  const cy = y < r ? r : y > 1 - r ? 1 - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

export function inCircle(x, y) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  return dx * dx + dy * dy <= 0.25;
}

export const lerp = (a, b, t) => a + (b - a) * t;

/** 主题色（与 src/styles.css 保持一致） */
export const COLORS = {
  bgTop: [19, 31, 58],
  bgBottom: [11, 17, 32],
  bgSolid: [11, 17, 32],
  boltStart: [34, 211, 238],
  boltEnd: [59, 130, 246],
};

/* ------------------------------ 渲染 ------------------------------ */

/** 颜色转 #RRGGBB */
export function hex(rgb) {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/**
 * 应用图标。
 * @param size 边长（像素）
 * @param opts.shape  'rounded' 圆角方块 | 'circle' 圆形 | 'none' 透明背景
 * @param opts.boltScale 闪电占画面的比例
 */
export function renderAppIcon(size, opts = {}) {
  const { shape = 'rounded', radius = 0.22, boltScale = 0.78, ss = 3 } = opts;
  const rgba = new Uint8Array(size * size * 4);
  const boltOffset = (1 - boltScale) / 2;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let bgCov = 0;
      let boltCov = 0;

      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;

          if (
            shape === 'rounded'
              ? inRoundedRect(x, y, radius)
              : shape === 'circle'
                ? inCircle(x, y)
                : shape === 'square' // 满幅背景（给 Android 自适应图标用）
                  ? true
                  : false
          ) {
            bgCov += 1;
          }
          const bx = (x - boltOffset) / boltScale;
          const by = (y - boltOffset) / boltScale;
          if (bx >= 0 && bx <= 1 && by >= 0 && by <= 1 && inPolygon(bx, by, BOLT)) boltCov += 1;
        }
      }

      const total = ss * ss;
      const bgA = bgCov / total;
      const boltA = boltCov / total;
      // 不透明度要取「背景 或 闪电」的并集。
      // 只取背景覆盖率的话，透明背景模式（自适应图标前景）会整块全透明、闪电看不见。
      const alphaA = 1 - (1 - bgA) * (1 - boltA);

      const t = (px / size + py / size) / 2;
      const bt = (px / size + py / size) / 2;

      const r = lerp(lerp(COLORS.bgTop[0], COLORS.bgBottom[0], t), lerp(COLORS.boltStart[0], COLORS.boltEnd[0], bt), boltA);
      const g = lerp(lerp(COLORS.bgTop[1], COLORS.bgBottom[1], t), lerp(COLORS.boltStart[1], COLORS.boltEnd[1], bt), boltA);
      const b = lerp(lerp(COLORS.bgTop[2], COLORS.bgBottom[2], t), lerp(COLORS.boltStart[2], COLORS.boltEnd[2], bt), boltA);

      const i = (py * size + px) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(alphaA * 255);
    }
  }

  return encodePng(size, size, rgba);
}

/**
 * 启动页：深色底 + 中心柔和光晕 + 居中闪电。
 * @param boltRatio 闪电大小相对于短边的比例
 */
export function renderSplash(width, height, opts = {}) {
  const { boltRatio = 0.2 } = opts;
  const rgba = new Uint8Array(width * height * 4);
  const ss = 2;
  const cx = width / 2;
  const cy = height / 2;
  const boltPx = Math.min(width, height) * boltRatio;
  const glowR = Math.min(width, height) * 0.55;

  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      let boltCov = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const x = px + (sx + 0.5) / ss;
          const y = py + (sy + 0.5) / ss;
          const bx = (x - (cx - boltPx / 2)) / boltPx;
          const by = (y - (cy - boltPx / 2)) / boltPx;
          if (bx >= 0 && bx <= 1 && by >= 0 && by <= 1 && inPolygon(bx, by, BOLT)) boltCov += 1;
        }
      }
      const boltA = boltCov / (ss * ss);

      // 中心柔和光晕
      const dx = (px - cx) / glowR;
      const dy = (py - cy) / glowR;
      const glow = Math.exp(-(dx * dx + dy * dy) * 3.2);

      const bt = px / width;
      const base = COLORS.bgSolid;
      const glowColor = [24, 60, 120];
      const br = lerp(base[0], glowColor[0], glow);
      const bgc = lerp(base[1], glowColor[1], glow);
      const bb = lerp(base[2], glowColor[2], glow);

      const boltR = lerp(COLORS.boltStart[0], COLORS.boltEnd[0], bt);
      const boltG = lerp(COLORS.boltStart[1], COLORS.boltEnd[1], bt);
      const boltB = lerp(COLORS.boltStart[2], COLORS.boltEnd[2], bt);

      const i = (py * width + px) * 4;
      rgba[i] = Math.round(lerp(br, boltR, boltA));
      rgba[i + 1] = Math.round(lerp(bgc, boltG, boltA));
      rgba[i + 2] = Math.round(lerp(bb, boltB, boltA));
      rgba[i + 3] = 255;
    }
  }

  return encodePng(width, height, rgba);
}
