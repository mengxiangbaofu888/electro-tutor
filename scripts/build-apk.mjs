/**
 * 一键构建安卓 APK（Windows / macOS / Linux 通用）。
 *
 * 用法：
 *   node scripts/build-apk.mjs            # 调试版（无需签名，可直接安装）
 *   node scripts/build-apk.mjs release    # 正式版（需要先配好签名）
 *
 * 需要先准备：
 *   - JDK 21（Capacitor 8 要求 Java 21）
 *   - Android SDK（platform 36 + build-tools）
 *   通过环境变量 JAVA_HOME / ANDROID_HOME 指定，
 *   或者放在仓库同级的 .android-tools/ 目录里（本项目的本地工具链约定）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_DIR = join(ROOT, 'android');
const TOOLS_DIR = join(ROOT, '..', '.android-tools');
const VARIANT = (process.argv[2] ?? 'debug').toLowerCase();
const IS_WIN = process.platform === 'win32';

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

/* ------------------------------ 定位 JDK ------------------------------ */

function findJdk() {
  if (process.env.JAVA_HOME && existsSync(join(process.env.JAVA_HOME, 'bin'))) return process.env.JAVA_HOME;
  if (!existsSync(TOOLS_DIR)) return null;
  const candidates = readdirSync(TOOLS_DIR)
    .filter((n) => /^jdk/i.test(n))
    .map((n) => join(TOOLS_DIR, n))
    .filter((p) => existsSync(join(p, 'bin')));
  return candidates[0] ?? null;
}

/* ------------------------------ 定位 Android SDK ------------------------------ */

function findSdk() {
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const v = process.env[key];
    if (v && existsSync(v)) return v;
  }
  const local = join(TOOLS_DIR, 'android-sdk');
  if (existsSync(local)) return local;
  // 兜底：读 android/local.properties（Android Studio 会写这里）
  const localProps = join(ANDROID_DIR, 'local.properties');
  if (existsSync(localProps)) {
    const m = /sdk\.dir\s*=\s*(.+)/.exec(readFileSync(localProps, 'utf8'));
    if (m) {
      // Java properties 里反斜杠和冒号都是转义的
      const dir = m[1].trim().replace(/\\\\/g, '\\').replace(/\\:/g, ':');
      if (existsSync(dir)) return dir;
    }
  }
  return null;
}

/* ------------------------------ 前置检查 ------------------------------ */

if (!existsSync(ANDROID_DIR)) {
  fail('还没有 android/ 工程目录。请先运行：npx cap add android');
}
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  fail('dist/ 里没有构建产物。请先运行：npm run build');
}

const jdk = findJdk();
if (!jdk) {
  fail(
    '找不到 JDK。请安装 JDK 21 并设置 JAVA_HOME，\n' +
      `   或把它放到 ${TOOLS_DIR}（例如 .android-tools/jdk-21.x.x）`,
  );
}

const sdk = findSdk();
if (!sdk) {
  fail(
    '找不到 Android SDK。请设置 ANDROID_HOME，\n' +
      `   或把它放到 ${join(TOOLS_DIR, 'android-sdk')}`,
  );
}

console.log('=== 构建环境 ===');
console.log(`  JDK        : ${jdk}`);
console.log(`  Android SDK: ${sdk}`);
console.log(`  构建类型   : ${VARIANT}`);

/* ------------------------------ 执行步骤 ------------------------------ */

/**
 * 统一用 inherit 保留实时输出（也避免受限环境下管道 stdio 被拒）。
 *
 * Windows 上 .bat / .cmd 必须经由 cmd.exe 执行；用 shell:true 会触发 Node 的
 * DEP0190 警告（参数不转义、直接拼接），所以这里显式调用 cmd.exe。
 */
function run(cmd, args, cwd, extraEnv = {}) {
  const file = IS_WIN ? 'cmd.exe' : cmd;
  const fileArgs = IS_WIN ? ['/d', '/s', '/c', cmd, ...args] : args;
  console.log(`\n▶ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(file, fileArgs, {
    cwd,
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      JAVA_HOME: jdk,
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
      ...extraEnv,
    },
  });
  if (res.error) fail(`${cmd} 启动失败：${res.error.message}`);
  if (res.status !== 0) fail(`${cmd} 退出码 ${res.status}`);
}

// 1) 把最新的 dist 同步进安卓工程
run('npx', ['cap', 'sync', 'android'], ROOT);

// 2) 调 Gradle Wrapper（Windows 用 .bat）
const gradle = IS_WIN ? join(ANDROID_DIR, 'gradlew.bat') : join(ANDROID_DIR, 'gradlew');
if (!existsSync(gradle)) fail(`找不到 Gradle Wrapper：${gradle}`);
if (!IS_WIN) run('chmod', ['+x', gradle], ANDROID_DIR);

const task = VARIANT === 'release' ? 'assembleRelease' : 'assembleDebug';
run(gradle, [task, '--no-daemon'], ANDROID_DIR);

/* ------------------------------ 汇报产物 ------------------------------ */

const outDir = join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', VARIANT);
if (!existsSync(outDir)) fail(`构建结束了，但没找到产物目录：${outDir}`);
const apks = readdirSync(outDir).filter((f) => f.endsWith('.apk'));

console.log('\n✅ 构建成功，产物：');
for (const apk of apks) {
  const full = join(outDir, apk);
  console.log(`   ${full}  (${(statSync(full).size / 1024 / 1024).toFixed(1)} MB)`);
}
console.log('\n安装到已连接的手机：');
console.log(`   "${join(sdk, 'platform-tools', IS_WIN ? 'adb.exe' : 'adb')}" install -r "${join(outDir, apks[0] ?? '')}"`);
