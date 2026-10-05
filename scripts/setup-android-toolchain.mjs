/**
 * 一键准备安卓构建工具链（JDK 21 + Android SDK），全部放在仓库同级的 .android-tools/。
 *
 * 为什么需要这个脚本：
 *   正常情况装个 Android Studio 就够了。但在**受限网络**下（国内直连 Google 不稳、
 *   没有管理员权限、不能写 C:\Users），sdkmanager 常常拉不到仓库清单。这个脚本改成
 *   "直接下载官方组件压缩包，再手工铺成 SDK 目录结构"，全程只需要 Node，且所有文件
 *   都落在仓库同级目录里，不污染系统。
 *
 * 用法：
 *   node scripts/setup-android-toolchain.mjs
 *
 * 完成后：
 *   npm run apk        # 会自动找到 .android-tools/ 下的 JDK 和 SDK
 *
 * 产物目录：
 *   ../.android-tools/jdk-21/
 *   ../.android-tools/android-sdk/{cmdline-tools,platform-tools,platforms,build-tools,licenses}
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, renameSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = resolve(ROOT, '..', '.android-tools');
const DOWNLOADS = join(TOOLS, 'downloads');
const SDK = join(TOOLS, 'android-sdk');
const IS_WIN = process.platform === 'win32';

const JDK_MAJOR = '21'; // Capacitor 8 的安卓模板要求 Java 21
const SDK_PLATFORM = '36';
const BUILD_TOOLS = '36.0.0';

// 国内镜像优先，官方源兜底（两边文件同名）
const GOOGLE = 'https://dl.google.com/android/repository/';
const TENCENT = 'https://mirrors.cloud.tencent.com/AndroidSDK/';
const ADOPTIUM = [
  'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/',
  'https://mirrors.ustc.edu.cn/adoptium/',
];

mkdirSync(DOWNLOADS, { recursive: true });

/* ------------------------------ 小工具 ------------------------------ */

const human = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`);

/**
 * 下载到 xxx.part，全部完成后才改名。
 * 并且**校验 content-length**——实测某些 CDN 返回的长度和实际字节数不符，
 * 不校验就会留下一个能解压失败、但看起来正常的坏包。
 */
async function download(url, dest, label) {
  if (existsSync(dest)) {
    console.log(`  [跳过] ${label}（已存在 ${human(statSync(dest).size)}）`);
    return dest;
  }
  const part = `${dest}.part`;
  if (existsSync(part)) rmSync(part);

  process.stdout.write(`  [下载] ${label} … `);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(900000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length') ?? 0);
  let got = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    got += c.length;
  });
  await pipeline(body, createWriteStream(part));

  const size = statSync(part).size;
  if (total && size !== total) {
    rmSync(part);
    throw new Error(`大小不符（期望 ${total}，实际 ${size}）`);
  }
  if (size < 1024 * 1024) {
    rmSync(part);
    throw new Error(`文件过小（${size} 字节）`);
  }
  renameSync(part, dest);
  console.log(human(size));
  return dest;
}

/** 依次尝试多个源 */
async function downloadAny(urls, dest, label) {
  let lastErr;
  for (const url of urls) {
    try {
      return await download(url, dest, label);
    } catch (e) {
      lastErr = e;
      process.stdout.write(`失败（${e.message}），换源… `);
    }
  }
  throw new Error(`${label} 所有源都失败：${lastErr?.message}`);
}

/** 用系统自带的 tar 解压 zip（Windows 10+ / macOS / Linux 都自带 bsdtar） */
function unzip(zip, destDir) {
  mkdirSync(destDir, { recursive: true });
  const res = spawnSync('tar', ['-xf', zip, '-C', destDir], { stdio: 'inherit', shell: false });
  if (res.status !== 0) throw new Error(`解压失败：${zip}`);
}

/** 把 srcDir 移动/改名成 destDir */
function place(srcDir, destDir) {
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
  mkdirSync(dirname(destDir), { recursive: true });
  try {
    renameSync(srcDir, destDir);
  } catch {
    // 跨盘符时 rename 会失败，退化成复制
    const res = spawnSync(IS_WIN ? 'xcopy' : 'cp', IS_WIN ? [srcDir, destDir, '/E', '/I', '/Y'] : ['-r', srcDir, destDir], {
      stdio: 'inherit',
      shell: false,
    });
    if (res.status !== 0) throw new Error(`复制失败：${srcDir} -> ${destDir}`);
    rmSync(srcDir, { recursive: true, force: true });
  }
}

/* ------------------------------ 1. JDK ------------------------------ */

console.log(`\n=== 1/4 下载 JDK ${JDK_MAJOR} ===`);

async function findJdkUrl() {
  for (const base of ADOPTIUM) {
    const dir = `${base}${JDK_MAJOR}/jdk/${IS_WIN ? 'x64/windows' : 'x64/linux'}/`;
    try {
      const res = await fetch(dir, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const names = [...(await res.text()).matchAll(/href="([^"]+\.(zip|tar\.gz))"/g)]
        .map((m) => m[1])
        .filter((n) => /jdk/i.test(n) && !/debug|test|sources/i.test(n));
      if (names.length) {
        names.sort();
        return new URL(names[names.length - 1], dir).href;
      }
    } catch {
      // 换下一个镜像
    }
  }
  throw new Error(`找不到 JDK ${JDK_MAJOR} 的下载地址`);
}

const jdkUrl = await findJdkUrl();
const jdkArchive = join(DOWNLOADS, decodeURIComponent(jdkUrl.split('/').pop()));
await downloadAny([jdkUrl], jdkArchive, `JDK ${JDK_MAJOR}`);

const jdkTmp = join(TOOLS, 'tmp-jdk');
unzip(jdkArchive, jdkTmp);
const jdkInner = (await import('node:fs')).readdirSync(jdkTmp).find((n) => /jdk/i.test(n));
if (!jdkInner) throw new Error('JDK 压缩包里没找到 jdk 目录');
place(join(jdkTmp, jdkInner), join(TOOLS, `jdk-${JDK_MAJOR}`));
rmSync(jdkTmp, { recursive: true, force: true });
console.log(`  JDK 就位：${join(TOOLS, `jdk-${JDK_MAJOR}`)}`);

/* ------------------------------ 2. cmdline-tools ------------------------------ */

console.log('\n=== 2/4 下载 Android cmdline-tools ===');
const cmdZip = join(DOWNLOADS, 'commandlinetools.zip');
await downloadAny(
  [
    `${GOOGLE}commandlinetools-${IS_WIN ? 'win' : 'linux'}-11076708_latest.zip`,
    `${TENCENT}commandlinetools-${IS_WIN ? 'win' : 'linux'}-11076708_latest.zip`,
  ],
  cmdZip,
  'Android cmdline-tools',
);
const cmdTmp = join(TOOLS, 'tmp-cmdline');
unzip(cmdZip, cmdTmp);
place(join(cmdTmp, 'cmdline-tools'), join(SDK, 'cmdline-tools', 'latest'));
rmSync(cmdTmp, { recursive: true, force: true });

/* ------------------------------ 3. SDK 组件 ------------------------------ */

console.log('\n=== 3/4 下载 Android SDK 组件 ===');

const components = [
  {
    label: 'platform-tools',
    file: `${IS_WIN ? 'platform-tools-latest-windows.zip' : 'platform-tools-latest-linux.zip'}`,
    // 压缩包内层目录名 -> SDK 里的目标位置
    dest: join(SDK, 'platform-tools'),
  },
  {
    label: `platforms;android-${SDK_PLATFORM}`,
    file: `platform-${SDK_PLATFORM}_r01.zip`,
    dest: join(SDK, 'platforms', `android-${SDK_PLATFORM}`),
  },
  {
    label: `build-tools;${BUILD_TOOLS}`,
    file: IS_WIN ? `build-tools_r${SDK_PLATFORM}_windows.zip` : `build-tools_r${SDK_PLATFORM}-linux.zip`,
    // 注意：build-tools 压缩包内层目录叫 android-16 这种代号，必须改名成版本号
    dest: join(SDK, 'build-tools', BUILD_TOOLS),
  },
];

for (const c of components) {
  console.log(`  --- ${c.label} ---`);
  const zip = join(DOWNLOADS, c.file);
  await downloadAny([`${GOOGLE}${c.file}`, `${TENCENT}${c.file}`], zip, c.label);
  const tmp = join(TOOLS, `tmp-${c.label.replace(/[;]/g, '-')}`);
  unzip(zip, tmp);
  const inner = (await import('node:fs')).readdirSync(tmp).find((n) => statSync(join(tmp, n)).isDirectory());
  if (!inner) throw new Error(`${c.file} 解压后没有目录`);
  place(join(tmp, inner), c.dest);
  rmSync(tmp, { recursive: true, force: true });
}

/* ------------------------------ 4. 许可证 ------------------------------ */

console.log('\n=== 4/4 写入 SDK 许可证 ===');
const licenses = join(SDK, 'licenses');
mkdirSync(licenses, { recursive: true });
// 这些是 Android SDK 各许可协议的哈希，等价于手动执行 sdkmanager --licenses 并全部同意
const LICENSE_HASHES = {
  'android-sdk-license': [
    '8933bad161af4178b1185d1a37fbf41ea5269c55',
    'd56f5187479451eabf01fb78af6dfcb131a6481e',
    '24333f8a63b6825ea9c5514f83c2829b004d1fee',
  ],
  'android-sdk-preview-license': ['84831b9409646a918e30573bab4c9c91346d8abd'],
};
for (const [name, hashes] of Object.entries(LICENSE_HASHES)) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(licenses, name), hashes.join('\n'), 'utf8');
  console.log(`  ${name}`);
}

/* ------------------------------ 自检 ------------------------------ */

console.log('\n=== 自检 ===');
const checks = [
  [join(TOOLS, `jdk-${JDK_MAJOR}`, 'bin', IS_WIN ? 'java.exe' : 'java'), 'JDK'],
  [join(SDK, 'platform-tools', IS_WIN ? 'adb.exe' : 'adb'), 'platform-tools'],
  [join(SDK, 'platforms', `android-${SDK_PLATFORM}`, 'android.jar'), `platforms;android-${SDK_PLATFORM}`],
  [join(SDK, 'build-tools', BUILD_TOOLS, IS_WIN ? 'aapt2.exe' : 'aapt2'), `build-tools;${BUILD_TOOLS}`],
];
let allOk = true;
for (const [file, label] of checks) {
  const ok = existsSync(file);
  if (!ok) allOk = false;
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
}

if (allOk) {
  console.log(`\n🎉 工具链就绪，在 ${TOOLS}`);
  console.log('   直接运行：npm run apk');
} else {
  console.log('\n⚠️ 有组件缺失，请检查上面的输出。');
  process.exit(1);
}
