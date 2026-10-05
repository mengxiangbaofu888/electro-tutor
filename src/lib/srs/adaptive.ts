/**
 * adaptive.ts —— 自适应出题：知识点权重 + 按权重的题量分配
 */
import type { MasteryInput } from './types';
import { currentScore } from './mastery';

/** 权重保底值：即使完全掌握也保留相对权重，避免该知识点被彻底"饿死" */
export const BASE_WEIGHT = 0.15;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 自适应出题权重：weight = (1 - 当前掌握度)^2 + 0.15。
 * - 未练过的知识点掌握度记 0，权重最高（1.15）；
 * - 完全掌握的知识点仍保留 0.15（约为最高权重的 13%），保证偶尔复习；
 * - 权重是相对值（不必求和为 1），未做归一化以免新增知识点时全体漂移；
 * - 重复 id 只取第一次出现的输入。
 */
export function questionWeights(inputs: MasteryInput[], now: number): Record<string, number> {
  const t = Number.isFinite(now) ? now : 0;
  const weights = new Map<string, number>();

  for (const input of inputs) {
    const id = input.knowledgePointId;
    if (typeof id !== 'string' || id.length === 0 || weights.has(id)) continue;
    const score = input.record === undefined ? 0 : clamp01(currentScore(input.record, t));
    const gap = 1 - score;
    weights.set(id, gap * gap + BASE_WEIGHT);
  }

  return Object.fromEntries(weights);
}

/**
 * 按权重把 count 道题分配到各知识点（最大余数法，总和恰好等于 count）。
 * - 每个知识点先按配额取整数部分，剩余名额按"小数余数从大到小"发放，
 *   余数并列时权重高者优先，仍并列则按 key 升序（结果稳定可复现）；
 * - count 小于知识点数时，先拿到名额的自然就是权重最高的那些点；
 * - count <= 0：返回所有 key 且值全为 0；
 * - 权重全为 0/非法：退化为平均分配，保证题量不丢。
 */
export function allocateQuestions(
  weights: Record<string, number>,
  count: number,
): Record<string, number> {
  const keys = Object.keys(weights);
  if (keys.length === 0) return {};

  const zeros = (): Record<string, number> =>
    Object.fromEntries(keys.map((key) => [key, 0] as const));

  const total = Math.floor(Number.isFinite(count) ? count : 0);
  if (total <= 0) return zeros();

  const clean = keys.map((key) => {
    const raw = weights[key] ?? 0;
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  });
  let sum = clean.reduce((acc, v) => acc + v, 0);
  if (sum <= 0) {
    for (let i = 0; i < clean.length; i += 1) clean[i] = 1;
    sum = clean.length;
  }

  const quota = clean.map((v) => (total * v) / sum);
  const alloc = quota.map((q) => Math.floor(q));
  let leftover = total - alloc.reduce((acc, v) => acc + v, 0);

  const order = keys.map((_, i) => i).sort((a, b) => {
    const remA = (quota[a] ?? 0) - (alloc[a] ?? 0);
    const remB = (quota[b] ?? 0) - (alloc[b] ?? 0);
    if (remB !== remA) return remB - remA;
    const weightA = clean[a] ?? 0;
    const weightB = clean[b] ?? 0;
    if (weightB !== weightA) return weightB - weightA;
    return (keys[a] ?? '') < (keys[b] ?? '') ? -1 : 1;
  });

  // 数学上 leftover 一定落在 [0, 知识点数)；这里仍做双向兜底，防浮点异常破坏"总数恰好等于 count"
  for (let i = 0; leftover > 0 && i < order.length; i += 1) {
    const index = order[i];
    if (index === undefined) continue;
    alloc[index] = (alloc[index] ?? 0) + 1;
    leftover -= 1;
  }
  if (leftover < 0) {
    const asc = keys.map((_, i) => i).sort((a, b) => (quota[a] ?? 0) - (quota[b] ?? 0));
    for (let i = 0; leftover < 0 && i < asc.length; i += 1) {
      const index = asc[i];
      if (index === undefined || (alloc[index] ?? 0) <= 0) continue;
      alloc[index] = (alloc[index] ?? 0) - 1;
      leftover += 1;
    }
  }

  const out = new Map<string, number>();
  keys.forEach((key, i) => out.set(key, alloc[i] ?? 0));
  return Object.fromEntries(out);
}
