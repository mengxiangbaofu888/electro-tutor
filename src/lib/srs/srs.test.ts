/**
 * 自进化引擎的行为测试。
 *
 * 这些算法直接决定"今天该复习什么""下一张卷子考什么"，所以要把关键性质钉死：
 * 单调性、上下限、纯函数性、题量守恒。
 */
import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  INITIAL_EASE,
  MAX_EASE,
  MIN_EASE,
  allocateQuestions,
  applyGrade,
  createMastery,
  currentScore,
  dueForReview,
  forecastLoad,
  questionWeights,
  rankWeakPoints,
  updateMastery,
} from './index';
import type { MasteryInput, MasteryRecord } from './types';

/** 固定基准时间，避免测试结果随"现在"变化 */
const T0 = Date.UTC(2026, 0, 1);

const gradeOf = (scoreRatio: number, at: number) => ({ knowledgePointIds: ['kp'], scoreRatio, at });

/** 造一条指定 dueAt 的记录 */
function record(id: string, dueAt: number): MasteryRecord {
  return { ...createMastery(id, T0), dueAt, lastSeen: T0 };
}

const input = (id: string, r?: MasteryRecord): MasteryInput => ({ knowledgePointId: id, name: id, record: r });

describe('createMastery', () => {
  it('新记录是空的，难度因子取初始值', () => {
    const r = createMastery('kp1', T0);
    expect(r.knowledgePointId).toBe('kp1');
    expect(r.score).toBe(0);
    expect(r.attempts).toBe(0);
    expect(r.reps).toBe(0);
    expect(r.ease).toBe(INITIAL_EASE);
  });
});

describe('updateMastery', () => {
  it('首次答对直接把掌握度拉到 1，并安排下次复习', () => {
    const r = updateMastery(createMastery('kp', T0), gradeOf(1, T0), T0);
    expect(r.score).toBeCloseTo(1, 5);
    expect(r.reps).toBe(1);
    expect(r.intervalDays).toBeGreaterThan(0);
    expect(r.dueAt).toBeGreaterThan(T0);
  });

  it('是滑动平均：答对一次再答错一次，不会直接归零', () => {
    let r = updateMastery(createMastery('kp', T0), gradeOf(1, T0), T0);
    r = updateMastery(r, gradeOf(0, T0 + DAY_MS), T0 + DAY_MS);
    expect(r.score).toBeGreaterThan(0.6);
    expect(r.score).toBeLessThan(0.8);
  });

  it('答错时连续次数清零，且次日就要复习', () => {
    let r = updateMastery(createMastery('kp', T0), gradeOf(1, T0), T0);
    r = updateMastery(r, gradeOf(0.2, T0 + 10 * DAY_MS), T0 + 10 * DAY_MS);
    expect(r.reps).toBe(0);
    expect(r.intervalDays).toBe(1);
    expect(r.dueAt).toBe(T0 + 10 * DAY_MS + DAY_MS);
  });

  it('连续答对时间隔递增', () => {
    let r = createMastery('kp', T0);
    const intervals: number[] = [];
    for (let i = 1; i <= 4; i += 1) {
      const at = T0 + i * 30 * DAY_MS;
      r = updateMastery(r, gradeOf(1, at), at);
      intervals.push(r.intervalDays);
    }
    for (let i = 1; i < intervals.length; i += 1) {
      expect(intervals[i]).toBeGreaterThan(intervals[i - 1]);
    }
  });

  it('难度因子被夹在 MIN_EASE 与 MAX_EASE 之间', () => {
    let r = createMastery('kp', T0);
    for (let i = 1; i <= 30; i += 1) {
      const at = T0 + i * DAY_MS;
      r = updateMastery(r, gradeOf(0, at), at);
    }
    expect(r.ease).toBeGreaterThanOrEqual(MIN_EASE);

    for (let i = 1; i <= 30; i += 1) {
      const at = T0 + (200 + i) * DAY_MS;
      r = updateMastery(r, gradeOf(1, at), at);
    }
    expect(r.ease).toBeLessThanOrEqual(MAX_EASE);
  });

  it('不修改入参（纯函数）', () => {
    const r0 = createMastery('kp', T0);
    const before = JSON.stringify(r0);
    updateMastery(r0, gradeOf(1, T0), T0);
    expect(JSON.stringify(r0)).toBe(before);
  });
});

describe('currentScore（遗忘衰减）', () => {
  it('刚复习完等于静态掌握度', () => {
    const r = updateMastery(createMastery('kp', T0), gradeOf(1, T0), T0);
    expect(currentScore(r, T0)).toBeCloseTo(r.score, 5);
  });

  it('随时间单调不增，且不会归零', () => {
    const r = updateMastery(createMastery('kp', T0), gradeOf(1, T0), T0);
    const points = [0, 1, 7, 30, 365, 100000].map((d) => currentScore(r, T0 + d * DAY_MS));
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]).toBeLessThanOrEqual(points[i - 1] + 1e-9);
    }
    expect(points[points.length - 1]).toBeGreaterThan(0.2);
  });

  it('时间倒流（now 早于 lastSeen）不会放大掌握度', () => {
    const r = updateMastery(createMastery('kp', T0), gradeOf(0.5, T0), T0);
    expect(currentScore(r, T0 - 30 * DAY_MS)).toBeLessThanOrEqual(r.score + 1e-9);
  });
});

describe('applyGrade', () => {
  it('给缺失的知识点补建记录，并按 id 去重', () => {
    const out = applyGrade([], { knowledgePointIds: ['a', 'b', 'a'], scoreRatio: 1, at: T0 }, T0);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((r) => r.knowledgePointId)).size).toBe(2);
  });
});

describe('dueForReview', () => {
  it('只返回到期的，最该复习的排最前', () => {
    const recs = [record('a', T0 - 3 * DAY_MS), record('b', T0 - 1 * DAY_MS), record('c', T0 + 5 * DAY_MS)];
    expect(dueForReview(recs, T0, 10).map((r) => r.knowledgePointId)).toEqual(['a', 'b']);
  });

  it('limit 生效，limit=0 返回空', () => {
    const recs = [record('a', T0 - 3 * DAY_MS), record('b', T0 - 1 * DAY_MS)];
    expect(dueForReview(recs, T0, 1)).toHaveLength(1);
    expect(dueForReview(recs, T0, 0)).toEqual([]);
  });

  it('没有到期的就返回空', () => {
    expect(dueForReview([record('c', T0 + 5 * DAY_MS)], T0, 10)).toEqual([]);
  });
});

describe('forecastLoad', () => {
  it('日期键格式正确，逾期算进窗口内，总数不丢', () => {
    const recs = [record('a', T0 - 5 * DAY_MS), record('b', T0 + 2 * DAY_MS)];
    const f = forecastLoad(recs, T0, 7);
    for (const key of Object.keys(f)) {
      expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(Object.values(f).reduce((s, n) => s + n, 0)).toBe(2);
  });

  it('days <= 0 返回空对象', () => {
    expect(forecastLoad([record('a', T0)], T0, 0)).toEqual({});
  });
});

describe('rankWeakPoints', () => {
  it('没练过的点会明确说明"尚未练习过"', () => {
    const out = rankWeakPoints([input('a')], T0, 5);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toContain('尚未练习');
  });

  it('掌握度低的排在掌握度高的前面，reason 都是中文且非空', () => {
    let weak = updateMastery(createMastery('weak', T0), { knowledgePointIds: ['weak'], scoreRatio: 0.2, at: T0 }, T0);
    let strong = createMastery('strong', T0);
    for (let i = 0; i < 5; i += 1) {
      strong = updateMastery(strong, { knowledgePointIds: ['strong'], scoreRatio: 1, at: T0 }, T0);
    }
    weak = { ...weak, attempts: 3 };
    const out = rankWeakPoints([input('strong', strong), input('weak', weak)], T0, 5);
    expect(out[0].knowledgePointId).toBe('weak');
    for (const w of out) {
      expect(w.reason.length).toBeGreaterThan(0);
      expect(w.severity).toBeGreaterThanOrEqual(0);
      expect(w.severity).toBeLessThanOrEqual(1);
      expect(w.score).toBeGreaterThanOrEqual(0);
      expect(w.score).toBeLessThanOrEqual(1);
    }
  });

  it('limit 生效', () => {
    const out = rankWeakPoints([input('a'), input('b'), input('c')], T0, 2);
    expect(out).toHaveLength(2);
  });
});

describe('questionWeights / allocateQuestions（自适应出题）', () => {
  it('没练过的权重高于已掌握的，但已掌握的仍保留保底权重', () => {
    let mastered = createMastery('mastered', T0);
    for (let i = 0; i < 6; i += 1) {
      mastered = updateMastery(mastered, { knowledgePointIds: ['mastered'], scoreRatio: 1, at: T0 }, T0);
    }
    const w = questionWeights([input('fresh'), input('mastered', mastered)], T0);
    expect(w.fresh).toBeGreaterThan(w.mastered);
    expect(w.mastered).toBeGreaterThan(0);
  });

  it('题量分配之和精确等于目标题数', () => {
    const weights = { a: 1.1, b: 0.3, c: 0.9, d: 0.2, e: 0.5 };
    for (const count of [0, 1, 3, 7, 20, 100]) {
      const alloc = allocateQuestions(weights, count);
      expect(Object.values(alloc).reduce((s, n) => s + n, 0)).toBe(count);
    }
  });

  it('题数少于知识点数时，优先给权重最高的', () => {
    const alloc = allocateQuestions({ hi: 1.2, mid: 0.5, lo: 0.16 }, 1);
    expect(alloc.hi).toBe(1);
    expect((alloc.mid ?? 0) + (alloc.lo ?? 0)).toBe(0);
  });

  it('权重全为 0 时也不会丢题量', () => {
    const alloc = allocateQuestions({ a: 0, b: 0, c: 0 }, 5);
    expect(Object.values(alloc).reduce((s, n) => s + n, 0)).toBe(5);
  });
});
