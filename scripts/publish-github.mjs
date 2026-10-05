/**
 * 把项目发布到 GitHub（建仓 + 推送 + 推标签），一条命令搞定。
 *
 * 用法（Token 通过环境变量传入，**绝不写进代码或 .git/config**）：
 *
 *   PowerShell:
 *     $env:GITHUB_TOKEN = "ghp_xxxxxxxx"
 *     node scripts/publish-github.mjs
 *
 *   bash:
 *     GITHUB_TOKEN=ghp_xxxxxxxx node scripts/publish-github.mjs
 *
 * 可选参数（环境变量）：
 *   GITHUB_REPO      仓库名，默认 electro-tutor
 *   GITHUB_PRIVATE   设为 1 则建私有仓库
 *   GITHUB_PROXY     形如 http://127.0.0.1:7890；国内直连 GitHub 被重置时需要
 *
 * Token 需要的最小权限：repo（建私有库/推代码）+ workflow（推 GitHub Actions 文件）。
 * 建议用 classic token，并在用完后到 GitHub 设置里删掉。
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim();
const REPO = (process.env.GITHUB_REPO ?? 'electro-tutor').trim();
const PRIVATE = process.env.GITHUB_PRIVATE === '1';
const PROXY = (process.env.GITHUB_PROXY ?? '').trim();
const IS_WIN = process.platform === 'win32';

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!TOKEN) {
  fail(
    '没有找到 Token。请先设置环境变量 GITHUB_TOKEN。\n\n' +
      '  PowerShell:  $env:GITHUB_TOKEN = "ghp_xxxx"\n' +
      '  bash:        export GITHUB_TOKEN=ghp_xxxx\n\n' +
      'Token 生成地址（勾选 repo 与 workflow）：https://github.com/settings/tokens',
  );
}

/** 统一经 cmd.exe 调 git（Windows 上避免 Node 的 DEP0190 警告） */
function git(args, { silent = false } = {}) {
  const extra = [];
  if (PROXY) {
    extra.push('-c', `http.proxy=${PROXY}`, '-c', `https.proxy=${PROXY}`);
  }
  // 本机实测：Windows 默认的 schannel TLS 后端会报 SEC_E_NO_CREDENTIALS，换 OpenSSL 才通
  extra.push('-c', 'http.sslBackend=openssl');

  const file = IS_WIN ? 'cmd.exe' : 'git';
  const fileArgs = IS_WIN ? ['/d', '/s', '/c', 'git', ...extra, ...args] : [...extra, ...args];
  const res = spawnSync(file, fileArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: silent ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
  });
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/* ------------------------------ 1. 确认身份 ------------------------------ */

console.log('=== 1/5 校验 Token 并读取账号信息 ===');
const meRes = await fetch('https://api.github.com/user', {
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'electro-tutor-publish',
  },
});
if (!meRes.ok) {
  fail(`Token 无效或权限不足（HTTP ${meRes.status}）。请确认勾选了 repo 与 workflow 权限。`);
}
const me = await meRes.json();
console.log(`  已认证：${me.login}`);

/* ------------------------------ 2. 建仓（已存在则跳过） ------------------------------ */

console.log(`\n=== 2/5 确认仓库 ${me.login}/${REPO} ===`);
const repoUrl = `https://api.github.com/repos/${me.login}/${REPO}`;
const head = await fetch(repoUrl, {
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'electro-tutor-publish' },
});
if (head.ok) {
  console.log('  仓库已存在，直接推送');
} else if (head.status === 404) {
  const create = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'electro-tutor-publish',
    },
    body: JSON.stringify({
      name: REPO,
      description: '电工陪练 · 电工/PLC 学习 AI 陪练：导入材料自动出大纲、出题组卷、批改评分，并针对薄弱点自进化',
      private: PRIVATE,
      has_issues: true,
      has_wiki: false,
      auto_init: false,
    }),
  });
  if (!create.ok) {
    fail(`建仓失败（HTTP ${create.status}）：${(await create.text()).slice(0, 300)}`);
  }
  const created = await create.json();
  console.log(`  已创建：${created.html_url}`);
} else {
  fail(`查询仓库失败（HTTP ${head.status}）`);
}

/* ------------------------------ 3. 配置 remote ------------------------------ */

console.log('\n=== 3/5 配置远程地址 ===');
const remoteUrl = `https://github.com/${me.login}/${REPO}.git`;
const hasOrigin = git(['remote', 'get-url', 'origin'], { silent: true }).status === 0;
if (hasOrigin) {
  git(['remote', 'set-url', 'origin', remoteUrl]);
} else {
  git(['remote', 'add', 'origin', remoteUrl]);
}
console.log(`  origin -> ${remoteUrl}`);

/* ------------------------------ 4. 推送 ------------------------------ */

// 用 -c http.extraHeader 临时带上凭据：不会写进 .git/config，也不会出现在 remote 地址里
const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

console.log('\n=== 4/5 推送提交与标签 ===');
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { silent: true }).stdout.trim() || 'main';

const pushMain = git([
  '-c',
  `http.extraHeader=Authorization: Basic ${basic}`,
  'push',
  '-u',
  'origin',
  branch,
]);
if (pushMain.status !== 0) {
  fail(
    '推送失败。常见原因：\n' +
      '  1) 国内直连 GitHub 被重置 —— 设置 GITHUB_PROXY=http://127.0.0.1:7890 后重试\n' +
      '  2) Token 没有 repo 权限\n' +
      '  3) 远端已有提交（先 git pull --rebase 再推）',
  );
}

const tags = git(['tag', '-l'], { silent: true }).stdout.split('\n').map((t) => t.trim()).filter(Boolean);
if (tags.length) {
  console.log(`  推送 ${tags.length} 个标签：${tags.join(', ')}`);
  const pushTags = git([
    '-c',
    `http.extraHeader=Authorization: Basic ${basic}`,
    'push',
    'origin',
    '--tags',
  ]);
  // 这一步必须查退出码：标签没推上去时，既不会触发 CI、也不会生成 Release，
  // 但分支已经推成功了——不报错的话使用者会以为发布完成（真实踩过一次：
  // v0.27.2 的标签丢了，仓库里没有这个版本，而脚本照样打印"完成"）。
  if (pushTags.status !== 0) {
    fail(
      '分支推成功了，但**标签没推上去**。\n' +
        '  后果：不会触发自动打包、也不会生成 Release，仓库里等于没有这个版本。\n' +
        '  补救（逐个补推，或直接重跑本脚本）：\n' +
        '    git push origin <标签名>',
    );
  }
  console.log('  标签推送完成');
}

/* ------------------------------ 5. 收尾 ------------------------------ */

console.log('\n=== 5/5 完成 ===');
console.log(`  仓库地址：https://github.com/${me.login}/${REPO}`);
console.log(`  提交历史：${git(['rev-list', '--count', 'HEAD'], { silent: true }).stdout.trim()} 个提交`);
console.log('\n下一步建议：');
console.log('  1) 到仓库 Settings → Actions → General，确认 Workflow permissions 允许写入');
console.log('  2) 打个标签触发自动出包：');
console.log('       git tag -a v0.3.0 -m "v0.3.0" && git push origin v0.3.0');
console.log('  3) 用完后到 https://github.com/settings/tokens 删掉这个 Token');
