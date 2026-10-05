/**
 * 生成安卓端图标与启动页，替换 Capacitor 模板里的默认素材。
 *
 * 为什么需要：`npx cap add android` 生成的图标和启动页是 Capacitor/安卓的默认样式，
 * 装到手机上不好看。这个脚本把它们全部换成项目自己的闪电图标。
 *
 * 用法：npm run icons        （会连同网页图标一起生成）
 *      node scripts/gen-android-assets.mjs
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAppIcon, renderSplash, readPngSize, COLORS, hex, BOLT_SVG_PATH } from './lib/png.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RES = join(ROOT, 'android', 'app', 'src', 'main', 'res');

if (!existsSync(RES)) {
  console.error(`找不到安卓资源目录：${RES}`);
  console.error('请先运行：npx cap add android');
  process.exit(1);
}

let count = 0;
function write(file, data) {
  writeFileSync(file, data);
  count += 1;
}

/* ------------------------------ 1. 启动图标（API 24-25 用） ------------------------------ */

const LEGACY_SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, size] of Object.entries(LEGACY_SIZES)) {
  const dir = join(RES, `mipmap-${density}`);
  if (!existsSync(dir)) continue;
  write(join(dir, 'ic_launcher.png'), renderAppIcon(size, { shape: 'rounded', radius: 0.2 }));
  write(join(dir, 'ic_launcher_round.png'), renderAppIcon(size, { shape: 'circle' }));
}
console.log(`✅ 已替换启动图标（${Object.keys(LEGACY_SIZES).length} 套，方图 + 圆图）`);

/* ------------------------------ 2. 自适应图标前景 ------------------------------ */

// 108dp 画布，系统只保证中间约 72dp 可见，所以闪电要缩到 ~52%
const FOREGROUND_SIZES = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
for (const [density, size] of Object.entries(FOREGROUND_SIZES)) {
  const dir = join(RES, `mipmap-${density}`);
  if (!existsSync(dir)) continue;
  write(join(dir, 'ic_launcher_foreground.png'), renderAppIcon(size, { shape: 'none', boltScale: 0.52 }));
}
console.log(`✅ 已替换自适应图标前景（${Object.keys(FOREGROUND_SIZES).length} 套）`);

/* ------------------------------ 3. 自适应图标背景色 ------------------------------ */

const bgColorFile = join(RES, 'values', 'ic_launcher_background.xml');
write(
  bgColorFile,
  `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 scripts/gen-android-assets.mjs 生成，改成与 App 主题一致的深蓝 -->
<resources>
    <color name="ic_launcher_background">${hex(COLORS.bgSolid)}</color>
</resources>
`,
);
console.log(`✅ 已把自适应图标背景色改为 ${hex(COLORS.bgSolid)}`);

/* ------------------------------ 4. 矢量版前后景（部分设备会走矢量） ------------------------------ */

const drawableDir = join(RES, 'drawable');
if (existsSync(drawableDir)) {
  write(
    join(drawableDir, 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="${hex(COLORS.bgSolid)}"
        android:pathData="M0,0h108v108h-108z" />
</vector>
`,
  );
}

const drawableV24 = join(RES, 'drawable-v24');
if (existsSync(drawableV24)) {
  // 视口 108x108：把 64x64 的闪电缩到 0.78 并居中（安全区内）
  write(
    join(drawableV24, 'ic_launcher_foreground.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <group
        android:translateX="29"
        android:translateY="29"
        android:scaleX="0.78"
        android:scaleY="0.78">
        <path
            android:fillColor="${hex(COLORS.boltStart)}"
            android:pathData="${BOLT_SVG_PATH}" />
    </group>
</vector>
`,
  );
}
console.log('✅ 已替换矢量版图标资源');

/* ------------------------------ 5. 启动页（保持原有尺寸） ------------------------------ */

const splashFiles = [];
function collectSplash(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSplash(full);
    else if (entry.name === 'splash.png') splashFiles.push(full);
  }
}
collectSplash(RES);

for (const file of splashFiles) {
  const size = readPngSize(readFileSync(file));
  if (!size) {
    console.warn(`  ⚠️ 跳过无法识别的 PNG：${file}`);
    continue;
  }
  // 大屏用小一点的闪电比例，避免在平板上显得过大
  const ratio = Math.min(size.width, size.height) > 1000 ? 0.15 : 0.22;
  write(file, renderSplash(size.width, size.height, { boltRatio: ratio }));
}
console.log(`✅ 已替换启动页 ${splashFiles.length} 张（深色底 + 光晕 + 闪电）`);

console.log(`\n共写入 ${count} 个资源文件到 android/app/src/main/res/`);
