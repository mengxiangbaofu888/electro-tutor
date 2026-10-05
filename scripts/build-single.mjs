/**
 * 把 dist-single/ 的构建产物合并成一个自包含的 single.html。
 *
 * 做三件事：
 *  1. 把 <link rel="stylesheet"> 换成内联 <style>
 *  2. 把 <script type="module" src="..."> 换成内联 <script type="module">
 *  3. 删掉 modulepreload（内联后没意义）
 *
 * 注意：JS 里如果出现 `</script>` 会提前结束脚本，必须转义成 `<\/script>`。
 *
 * 用法：npm run build:single
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'dist-single');

if (!existsSync(DIR)) {
  console.error('找不到 dist-single/，请先运行：npx vite build --config vite.single.config.ts');
  process.exit(1);
}

let html = readFileSync(join(DIR, 'index.html'), 'utf8');

/** 内联所有样式表 */
html = html.replace(/<link[^>]+rel="stylesheet"[^>]*>/g, (tag) => {
  const href = /href="([^"]+)"/.exec(tag)?.[1];
  if (!href) return '';
  const file = join(DIR, href.replace(/^\.?\//, ''));
  if (!existsSync(file)) return tag;
  const css = readFileSync(file, 'utf8');
  return `<style>\n${css}\n</style>`;
});

/** 内联主脚本 */
html = html.replace(/<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_tag, src) => {
  const file = join(DIR, String(src).replace(/^\.?\//, ''));
  if (!existsSync(file)) return '';
  const js = readFileSync(file, 'utf8').replace(/<\/script>/gi, '<\\/script>');
  return `<script type="module">\n${js}\n</script>`;
});

/** 去掉模块预加载与 PWA 注册（单文件场景无意义） */
html = html
  .replace(/<link[^>]+rel="modulepreload"[^>]*>/g, '')
  .replace(/<link[^>]+rel="manifest"[^>]*>/g, '')
  .replace(/<script[^>]*src="[^"]*registerSW\.js"[^>]*><\/script>/g, '');

// 把单文件标记写进标题，方便确认打开的是单文件版
html = html.replace(/<title>(.*?)<\/title>/, '<title>$1（单文件离线版）</title>');

const out = join(DIR, 'single.html');
writeFileSync(out, html, 'utf8');

const kb = (html.length / 1024).toFixed(1);
console.log(`已生成 dist-single/single.html（${kb} KB）`);
console.log(`目录内容：${readdirSync(DIR).join(', ')}`);
