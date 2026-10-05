/**
 * 极简静态服务器，用来预览 dist/ 的构建产物。
 *
 * 为什么不直接用 `vite preview`：Vite 在 Windows 上会执行 `net use` 探测网络驱动器，
 * 在不允许子进程管道的受限环境里会抛 EPERM。这个脚本没有任何子进程，最稳。
 *
 * 用法：npm run serve        （默认 http://127.0.0.1:4173）
 *      npm run serve -- 8080
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.argv[2]) || 4173;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

if (!existsSync(ROOT)) {
  console.error(`找不到 ${ROOT}，请先运行 npm run build`);
  process.exit(1);
}

createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  // 防目录穿越
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let file = join(ROOT, safe);
  if (!file.startsWith(ROOT)) file = join(ROOT, 'index.html');
  if (urlPath === '/' || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(ROOT, 'index.html');
  }
  res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  createReadStream(file).pipe(res);
}).listen(PORT, HOST, () => {
  console.log(`dist 已启动：http://${HOST}:${PORT}`);
});
