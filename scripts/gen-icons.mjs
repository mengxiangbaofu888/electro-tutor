/**
 * 生成网页/PWA 图标（不依赖任何第三方库）。
 *
 * 用法：npm run icons
 * 输出：public/icon-192.png、icon-512.png、icon-maskable-512.png、favicon.svg
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAppIcon } from './lib/png.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public');
mkdirSync(OUT, { recursive: true });

const targets = [
  // 普通图标：圆角方块
  ['icon-192.png', renderAppIcon(192, { shape: 'rounded' })],
  ['icon-512.png', renderAppIcon(512, { shape: 'rounded' })],
  // 自适应图标：满幅背景 + 缩小到安全区内的闪电（系统会自己裁形状）
  ['icon-maskable-512.png', renderAppIcon(512, { shape: 'square', boltScale: 0.58 })],
];

for (const [name, buf] of targets) {
  writeFileSync(resolve(OUT, name), buf);
  console.log(`已生成 public/${name}（${(buf.length / 1024).toFixed(1)} KB）`);
}

// favicon.svg：矢量版，观感与位图一致
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
writeFileSync(resolve(OUT, 'favicon.svg'), svg, 'utf8');
console.log('已生成 public/favicon.svg');
