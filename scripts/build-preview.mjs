/**
 * 构建「可离线打开」的 UI 预览产物。
 *
 * 用途：不做任何服务器、不经过任何网络代理，直接把界面渲染出来看。
 * 它是目前唯一能在受限环境里验证「界面长什么样」的手段——
 * 单元测试只能证明 DOM 里有没有某个元素，证明不了它看起来对不对。
 *
 * 产物：dist-preview/preview-<路由>.html（每个文件都是自包含的单文件）
 *
 * 用法：node scripts/build-preview.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlineSingleFile } from './lib/inline.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'dist-preview');
const IS_WIN = process.platform === 'win32';

/** 要截图的页面 */
const ROUTES = [
  ['home', '#/', '首页'],
  ['materials', '#/materials', '材料导入'],
  ['outlines', '#/outlines', '大纲'],
  ['knowledge', '#/knowledge', '掌握度地图'],
  ['practice', '#/practice', '出题练习'],
  ['wrong', '#/wrong', '错题本'],
  ['report', '#/report/preview-attempt', '学习报告'],
  ['me', '#/me', '我的'],
];

function run(cmd, args, cwd) {
  const file = IS_WIN ? 'cmd.exe' : cmd;
  const argv = IS_WIN ? ['/d', '/s', '/c', cmd, ...args] : args;
  const res = spawnSync(file, argv, { cwd, stdio: 'inherit', shell: false });
  if (res.status !== 0) {
    console.error(`\n❌ ${cmd} ${args.join(' ')} 失败（退出码 ${res.status}）`);
    process.exit(1);
  }
}

console.log('▶ 构建预览产物（vite build --config vite.preview.config.ts）');
run('npx', ['vite', 'build', '--config', 'vite.preview.config.ts'], ROOT);

if (!existsSync(OUT_DIR)) {
  console.error('❌ 没有产出 dist-preview/');
  process.exit(1);
}

// 先内联成一份自包含 HTML（入口产物名跟随入口文件名）
const base = inlineSingleFile(OUT_DIR, 'preview.html', {
  inputName: 'preview.html',
  titleSuffix: '（UI 预览）',
});
const baseHtml = readFileSync(base, 'utf8');

// 再按路由各写一份：把初始路由注入到 <head>，让 HashRouter 直接落到目标页面
for (const [name, hash, label] of ROUTES) {
  const injected = baseHtml.replace(
    '</head>',
    `<script>window.__PREVIEW_ROUTE__ = ${JSON.stringify(hash)};</script>\n</head>`,
  );
  const file = join(OUT_DIR, `preview-${name}.html`);
  writeFileSync(file, injected, 'utf8');
  console.log(`  生成 preview-${name}.html  → ${label}（${hash}）`);
}

console.log(`\n✅ 预览产物在 dist-preview/，共 ${ROUTES.length + 1} 个文件`);
console.log('   用浏览器直接打开即可（file:// 也行，不需要服务器）');
