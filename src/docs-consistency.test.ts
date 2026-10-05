/**
 * 文档与代码的一致性检查。
 *
 * 为什么需要：README 和 docs/ 里写满了"事实声明"——测试文件清单、
 * 知识点数量、npm 脚本名、文档链接。这些数字**每轮都在手工更新**，
 * 而手工维护的数字一定会腐烂：
 *   · 加了新的测试文件，忘了往 README 的表里补一行
 *   · 改了脚本名，文档里还写着旧名字
 *   · 移动了文档，链接指向不存在的路径
 *   · 知识点的实际数量变了，文档里的数字还是旧的
 * 这些错误让文档变得不可信——而不可信的文档比没有文档更糟。
 *
 * 这里只检查**能从代码推导出来的**事实。像"APK 多大""几个用例通过"
 * 这种会随构建变化的数字不在此列——它们压根不该写死在文档里。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRACK_LABELS, type TrackId } from './lib/db/types';
import { SEED_OUTLINES, countSeedNodes } from './lib/seed/data';

const ROOT = process.cwd();

function readText(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf8');
}

/** 去掉代码块，避免把示例里的假链接/假命令当成真的 */
function stripCodeFences(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

function listMarkdownFiles(dir: string): string[] {
  return readdirSync(resolve(ROOT, dir))
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(dir, name));
}

/** 递归找出 src 下所有测试文件（POSIX 风格相对路径） */
function listTestFiles(): string[] {
  const out: string[] = [];
  const walk = (absDir: string) => {
    for (const name of readdirSync(absDir)) {
      const abs = join(absDir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.test\.tsx?$/.test(name)) out.push(relative(ROOT, abs).split('\\').join('/'));
    }
  };
  walk(resolve(ROOT, 'src'));
  return out.sort();
}

const README = 'README.md';
const DOC_FILES = [README, ...listMarkdownFiles('docs')];
const PACKAGE_SCRIPTS = Object.keys(
  (JSON.parse(readText('package.json')) as { scripts: Record<string, string> }).scripts,
);

/* ============================== 1. npm 脚本 ============================== */

describe('文档里提到的 npm 脚本都真实存在', () => {
  for (const file of DOC_FILES) {
    it(`${file} 里的脚本名没有写错`, () => {
      const text = stripCodeFences(readText(file));
      const used = new Set<string>();

      for (const m of text.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) used.add(m[1]);
      if (/\bnpm test\b/.test(text)) used.add('test');

      const unknown = [...used].filter((name) => !PACKAGE_SCRIPTS.includes(name));
      expect(unknown, `${file} 里出现了 package.json 中不存在的脚本：${unknown.join('、')}`).toEqual([]);
    });
  }
});

/* ============================== 2. 文档链接 ============================== */

describe('文档里的相对链接都指向真实存在的文件', () => {
  for (const file of DOC_FILES) {
    it(`${file} 里的链接没有失效`, () => {
      const text = stripCodeFences(readText(file));
      const broken: string[] = [];

      for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
        const target = m[1].trim();
        // 只看相对路径；外链和锚点不管
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const pathOnly = target.split('#')[0];
        if (!pathOnly) continue;
        const abs = resolve(ROOT, dirname(file), pathOnly);
        if (!existsSync(abs)) broken.push(`${target}（相对 ${file}）`);
      }

      expect(broken, `${file} 里有失效链接：${broken.join('、')}`).toEqual([]);
    });
  }
});

/* ============================== 3. 知识点数量 ============================== */

describe('文档里的知识点数量与内置数据一致', () => {
  it('README 声明的知识点总数对得上', () => {
    const total = SEED_OUTLINES.reduce((sum, outline) => sum + countSeedNodes(outline.nodes), 0);
    const text = readText(README);

    // 形如「共 100+ 个知识点」或「共 105 个知识点」
    const claim = /共\s*(\d+)\s*\+?\s*个知识点/.exec(text);
    expect(claim, 'README 里没有找到知识点总数的声明').toBeTruthy();

    const claimed = Number(claim![1]);
    if (claim![0].includes('+')) {
      // 写「N+」时，实际数量必须不少于 N
      expect(total, `README 写的是 ${claimed}+，实际只有 ${total}`).toBeGreaterThanOrEqual(claimed);
    } else {
      expect(total, `README 写的 ${claimed} 与实际 ${total} 不一致`).toBe(total);
    }
  });

  it('四条学习线各有内置大纲，且数量都说得过去', () => {
    const tracks = Object.keys(TRACK_LABELS) as TrackId[];
    for (const track of tracks) {
      const seed = SEED_OUTLINES.find((s) => s.track === track);
      expect(seed, `${TRACK_LABELS[track]} 缺少内置大纲`).toBeTruthy();
      expect(countSeedNodes(seed!.nodes)).toBeGreaterThanOrEqual(15);
    }
    // 四条线不能共用同一个标题，否则"装没装过"的判断会错乱
    const titles = new Set(SEED_OUTLINES.map((s) => s.title));
    expect(titles.size).toBe(SEED_OUTLINES.length);
  });

  it('上手指南里列的每条线的知识点数量都对得上', () => {
    // 只有被自动核对过的精确数字，才敢写进文档——否则迟早腐烂。
    const guide = readText('docs/04-上手指南.md');
    for (const seed of SEED_OUTLINES) {
      const label = TRACK_LABELS[seed.track];
      const actual = countSeedNodes(seed.nodes);
      const row = new RegExp(`\\|\\s*${label}\\s*\\|\\s*(\\d+)\\s*\\|`).exec(guide);
      expect(row, `上手指南的表格里没有 ${label} 这一行`).toBeTruthy();
      expect(Number(row![1]), `${label} 在指南里写的是 ${row![1]}，实际是 ${actual}`).toBe(actual);
    }
  });
});

/* ============================== 4. 测试文件清单 ============================== */

describe('README 的测试文件表与实际文件一致', () => {
  it('表里列出的就是磁盘上真实存在的全部测试文件', () => {
    const text = readText(README);
    const listed = [...text.matchAll(/^\|\s*`(src\/[^`]+\.test\.tsx?)`\s*\|/gm)]
      .map((m) => m[1])
      .sort();
    const actual = listTestFiles();

    const missingFromDoc = actual.filter((f) => !listed.includes(f));
    const staleInDoc = listed.filter((f) => !actual.includes(f));

    expect(missingFromDoc, `这些测试文件没有写进 README 的表：${missingFromDoc.join('、')}`).toEqual([]);
    expect(staleInDoc, `README 的表里列了不存在的测试文件：${staleInDoc.join('、')}`).toEqual([]);
  });
});

/* ============================== 5. 文档里引用的源码路径 ============================== */

describe('文档里引用的源码路径都存在', () => {
  it('README 与 docs 提到的 src/ scripts/ public/ 路径都真实存在', () => {
    const broken: string[] = [];
    for (const file of DOC_FILES) {
      const text = stripCodeFences(readText(file));
      for (const m of text.matchAll(/\b((?:src|scripts|public|docs|android)\/[A-Za-z0-9_./\u4e00-\u9fa5-]+)/g)) {
        const path = m[1];
        // 目录前缀也算命中（例如 src/features/ 这种描述性写法）
        if (existsSync(resolve(ROOT, path))) continue;
        if (existsSync(resolve(ROOT, dirname(path)))) continue;
        broken.push(`${path}（出现在 ${file}）`);
      }
    }
    expect([...new Set(broken)], `文档里引用了不存在的路径：\n${[...new Set(broken)].join('\n')}`).toEqual([]);
  });
});
