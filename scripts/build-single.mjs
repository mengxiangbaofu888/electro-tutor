/**
 * 把 dist-single/ 的构建产物合并成一个自包含的 single.html。
 *
 * 用途：产出「双击就能打开」的离线版 HTML。
 * 注意 file:// 下浏览器不允许用本地数据库，所以这个产物需要放到 http 上访问才完整可用
 * （预览版预览见 scripts/build-preview.mjs，那个内联了内存版 IndexedDB）。
 *
 * 用法：npm run build:single
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlineSingleFile } from './lib/inline.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'dist-single');

if (!existsSync(DIR)) {
  console.error('找不到 dist-single/，请先运行：npx vite build --config vite.single.config.ts');
  process.exit(1);
}

const out = inlineSingleFile(DIR, 'single.html', { titleSuffix: '（单文件离线版）' });

console.log(`已生成 ${out}`);
console.log(`目录内容：${readdirSync(DIR).join(', ')}`);
