/**
 * 内置起步大纲的数据与安装测试。
 *
 * 这些数据会直接变成题库的骨架，所以结构必须干净：
 * 名称在同一条线内唯一（否则"知识点名称→id"的映射会有歧义）、
 * 层级不超过 3 层、重要度在 1~5、说明不为空。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { TRACK_LABELS, type TrackId } from '../db/types';
import { SEED_OUTLINES, countSeedNodes, getSeedOutline, type SeedNode } from './data';
import { installAllSeedOutlines, installedSeedTracks, installSeedOutline } from './index';

const ALL_TRACKS = Object.keys(TRACK_LABELS) as TrackId[];

/** 把树展平，带上层级 */
function flatten(nodes: SeedNode[], depth = 1): { node: SeedNode; depth: number }[] {
  const out: { node: SeedNode; depth: number }[] = [];
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.children) out.push(...flatten(node.children, depth + 1));
  }
  return out;
}

describe('内置大纲数据', () => {
  it('四条学习线各有一套', () => {
    expect(SEED_OUTLINES).toHaveLength(ALL_TRACKS.length);
    for (const track of ALL_TRACKS) {
      expect(getSeedOutline(track), `${TRACK_LABELS[track]} 应该有内置大纲`).toBeTruthy();
    }
  });

  it('每条线的知识点数量够用（至少 15 个）', () => {
    for (const seed of SEED_OUTLINES) {
      const n = countSeedNodes(seed.nodes);
      expect(n, `${seed.title} 只有 ${n} 个知识点`).toBeGreaterThanOrEqual(15);
    }
  });

  it('知识点名称在同一条线内唯一', () => {
    // 这条很重要：出题时模型返回的是知识点"名称"，
    // 重名会导致关联到错误的知识点。
    for (const seed of SEED_OUTLINES) {
      const names = flatten(seed.nodes).map((x) => x.node.name);
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      expect(dupes, `${seed.title} 里有重复的知识点名称：${[...new Set(dupes)].join('、')}`).toEqual([]);
    }
  });

  it('层级不超过 3 层', () => {
    for (const seed of SEED_OUTLINES) {
      const maxDepth = Math.max(...flatten(seed.nodes).map((x) => x.depth));
      expect(maxDepth, `${seed.title} 层级达到 ${maxDepth}`).toBeLessThanOrEqual(3);
    }
  });

  it('重要度都在 1~5 之间，说明都不为空', () => {
    for (const seed of SEED_OUTLINES) {
      for (const { node } of flatten(seed.nodes)) {
        expect(Number.isInteger(node.importance), `${node.name} 的重要度不是整数`).toBe(true);
        expect(node.importance).toBeGreaterThanOrEqual(1);
        expect(node.importance).toBeLessThanOrEqual(5);
        expect(node.name.trim().length, `${seed.title} 有空名称`).toBeGreaterThan(0);
        expect(node.summary.trim().length, `${node.name} 没有说明`).toBeGreaterThan(0);
      }
    }
  });

  it('有叶子节点可以出题，且每条线都标了重点', () => {
    for (const seed of SEED_OUTLINES) {
      const flat = flatten(seed.nodes);
      const leaves = flat.filter((x) => !x.node.children?.length);
      expect(leaves.length, `${seed.title} 没有叶子知识点`).toBeGreaterThan(0);
      expect(flat.some((x) => x.node.importance >= 5), `${seed.title} 没有标出重点`).toBe(true);
    }
  });

  it('标题与描述都写清楚了', () => {
    for (const seed of SEED_OUTLINES) {
      expect(seed.title.length).toBeGreaterThan(0);
      expect(seed.description.length).toBeGreaterThan(10);
    }
  });
});

describe('内置大纲安装', () => {
  beforeEach(async () => {
    await db.transaction('rw', [db.outlines, db.knowledgePoints], async () => {
      await db.outlines.clear();
      await db.knowledgePoints.clear();
    });
  });

  it('安装后大纲与知识点都落库，并标记为内置', async () => {
    const { outline, points } = await installSeedOutline('plc');
    expect(outline.seed).toBe(true);
    expect(points.length).toBe(countSeedNodes(getSeedOutline('plc')!.nodes));

    const stored = await db.outlines.get(outline.id);
    expect(stored?.seed).toBe(true);

    const storedPoints = await db.knowledgePoints.where('outlineId').equals(outline.id).toArray();
    expect(storedPoints).toHaveLength(points.length);
    // 层级关系正确
    const parents = storedPoints.filter((p) => p.parentId);
    expect(parents.length).toBeGreaterThan(0);
    for (const p of parents) {
      expect(storedPoints.some((x) => x.id === p.parentId)).toBe(true);
    }
  });

  it('能识别出已经装过哪几条线', async () => {
    expect((await installedSeedTracks()).size).toBe(0);
    await installSeedOutline('fundamental');
    const installed = await installedSeedTracks();
    expect(installed.has('fundamental')).toBe(true);
    expect(installed.has('plc')).toBe(false);
  });

  it('一次装全部四条线，重复调用不会装第二遍', async () => {
    expect(await installAllSeedOutlines()).toBe(4);
    expect(await installAllSeedOutlines()).toBe(0);
    expect(await db.outlines.count()).toBe(4);
  });

  it('不存在的学习线会报错', async () => {
    await expect(installSeedOutline('nope' as TrackId)).rejects.toThrow(/没有找到内置大纲/);
  });
});
