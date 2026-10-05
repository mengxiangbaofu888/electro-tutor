/**
 * 把一个 Vite 构建产物目录合并成单个自包含 HTML。
 *
 * 做三件事：
 *  1. <link rel="stylesheet"> → 内联 <style>
 *  2. <script type="module" src="..."> → 内联 <script type="module">
 *  3. 删掉 modulepreload 与 PWA 注册（内联后无意义）
 *
 * 注意：JS 里若出现 `</script>` 会提前结束脚本，必须转义成 `<\/script>`。
 *
 * 被 build-single.mjs（单文件离线版）和 build-preview.mjs（UI 预览版）共用。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param dir 构建产物目录
 * @param outName 输出文件名（写在同一目录下）
 * @param options.inputName 入口 HTML 的文件名，默认 index.html
 * @param options.titleSuffix 追加到 <title> 后面的说明
 * @param options.headScript 插到 <head> 里的额外脚本（预览版用来指定初始路由）
 * @returns 输出文件的绝对路径
 */
export function inlineSingleFile(dir, outName, options = {}) {
  const { inputName = 'index.html', titleSuffix = '', headScript = '' } = options;
  const indexPath = join(dir, inputName);
  if (!existsSync(indexPath)) {
    throw new Error(`找不到 ${indexPath}，请先执行 vite build`);
  }

  let html = readFileSync(indexPath, 'utf8');

  // 样式内联
  html = html.replace(/<link[^>]+rel="stylesheet"[^>]*>/g, (tag) => {
    const href = /href="([^"]+)"/.exec(tag)?.[1];
    if (!href) return '';
    const file = join(dir, href.replace(/^\.?\//, ''));
    if (!existsSync(file)) return tag;
    return `<style>\n${readFileSync(file, 'utf8')}\n</style>`;
  });

  // 主脚本内联
  html = html.replace(/<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_tag, src) => {
    const file = join(dir, String(src).replace(/^\.?\//, ''));
    if (!existsSync(file)) return '';
    const js = readFileSync(file, 'utf8').replace(/<\/script>/gi, '<\\/script>');
    return `<script type="module">\n${js}\n</script>`;
  });

  // 去掉模块预加载与 PWA 注册
  html = html
    .replace(/<link[^>]+rel="modulepreload"[^>]*>/g, '')
    .replace(/<link[^>]+rel="manifest"[^>]*>/g, '')
    .replace(/<script[^>]*src="[^"]*registerSW\.js"[^>]*><\/script>/g, '');

  if (titleSuffix) {
    html = html.replace(/<title>(.*?)<\/title>/, `<title>$1 ${titleSuffix}</title>`);
  }
  if (headScript) {
    html = html.replace('</head>', `${headScript}\n</head>`);
  }

  const outPath = join(dir, outName);
  writeFileSync(outPath, html, 'utf8');
  return outPath;
}
