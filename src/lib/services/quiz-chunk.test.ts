/**
 * 分批出题的测试。
 *
 * 起因是用户实测反馈："我让他出随机 20 道题……他半天出不来"。
 * 原来是一次要 20 道：模型要一口气吐很大的 JSON，慢、容易被截断，
 * 中间还看不到任何进度。改成每批 5 道、逐批出、逐批报进度。
 *
 * 这里测的是**拆批的数学**：每批不超上限、总量一道不多一道不少、
 * 题型配比按比例缩到每批的题量（之和必须正好等于那一批的题量）。
 */
import { describe, expect, it } from 'vitest';
import { QUESTION_BATCH_SIZE, scaleTypeMix, splitAllocation } from './quiz';

const p = (pointId: string, count: number) => ({ pointId, count });

describe('把"知识点→题量"拆成一批批', () => {
  it('每批总量不超过上限', () => {
    const batches = splitAllocation([p('a', 12)], 5);
    expect(batches.map((b) => b.reduce((s, x) => s + x.count, 0))).toEqual([5, 5, 2]);
  });

  it('同一个知识点要得多，会拆到多批', () => {
    const batches = splitAllocation([p('a', 7)], 5);
    expect(batches).toEqual([[p('a', 5)], [p('a', 2)]]);
  });

  it('多个知识点会凑满同一批（宁可把某一点拆到下一批，也不留半空的批）', () => {
    // a2 + b2 = 4，还差 1 道才满 5：就把 c 的 1 道先放进这一批，c 剩下 2 道进下一批。
    // 这样每批都接近装满、请求次数更少。
    const batches = splitAllocation([p('a', 2), p('b', 2), p('c', 3)], 5);
    expect(batches).toEqual([
      [p('a', 2), p('b', 2), p('c', 1)],
      [p('c', 2)],
    ]);
  });

  it('总量一道不多、一道不少', () => {
    const input = [p('a', 3), p('b', 7), p('c', 1), p('d', 9)];
    const batches = splitAllocation(input, 5);
    const flat = batches.flat();
    for (const item of input) {
      expect(flat.filter((x) => x.pointId === item.pointId).reduce((s, x) => s + x.count, 0)).toBe(
        item.count,
      );
    }
  });

  it('正好装满时不产生空批', () => {
    expect(splitAllocation([p('a', 5), p('b', 5)], 5)).toEqual([[p('a', 5)], [p('b', 5)]]);
  });

  it('数量为 0 的知识点被忽略，空输入返回空', () => {
    expect(splitAllocation([p('a', 0)], 5)).toEqual([]);
    expect(splitAllocation([], 5)).toEqual([]);
  });

  it('默认批量是 5（一次要 20 道会被拆成 4 批）', () => {
    expect(QUESTION_BATCH_SIZE).toBe(5);
    expect(splitAllocation([p('a', 20)], QUESTION_BATCH_SIZE)).toHaveLength(4);
  });
});

describe('题型配比缩到"这一批要几道"', () => {
  it('缩完各题型数量之和正好等于这一批的题量', () => {
    const mix = [
      { type: 'single' as const, count: 6 },
      { type: 'judge' as const, count: 3 },
      { type: 'blank' as const, count: 1 },
    ];
    for (const n of [1, 2, 3, 5, 7, 10]) {
      const scaled = scaleTypeMix(mix, n);
      expect(scaled.reduce((s, x) => s + x.count, 0)).toBe(n);
      expect(scaled.every((x) => x.count > 0)).toBe(true);
    }
  });

  it('比例大致保持（单选最多）', () => {
    const mix = [
      { type: 'single' as const, count: 8 },
      { type: 'judge' as const, count: 2 },
    ];
    const scaled = scaleTypeMix(mix, 5);
    const single = scaled.find((s) => s.type === 'single')?.count ?? 0;
    const judge = scaled.find((s) => s.type === 'judge')?.count ?? 0;
    expect(single).toBeGreaterThan(judge);
    expect(single + judge).toBe(5);
  });

  it('只保留有数量的题型；配比为空或题量为 0 时不炸', () => {
    expect(scaleTypeMix([{ type: 'single', count: 3 }, { type: 'judge', count: 0 }], 2)).toEqual([
      { type: 'single', count: 2 },
    ]);
    expect(scaleTypeMix([], 5)).toEqual([]);
    expect(scaleTypeMix([{ type: 'single', count: 2 }], 0)).toEqual([{ type: 'single', count: 2 }]);
  });
});
