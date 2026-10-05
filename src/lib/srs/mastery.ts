/**
 * mastery.ts —— 掌握度模型：指数滑动平均掌握度 + SM-2 间隔重复 + 遗忘衰减
 */
import type { Grade, MasteryRecord } from './types';

/** 一天的毫秒数 */
export const DAY_MS = 86_400_000;
/** 通过阈值：得分率 >= 0.8 视为通过 */
export const PASS_RATIO = 0.8;
/** 初始难度因子 EF */
export const INITIAL_EASE = 2.5;
/** EF 下限 */
export const MIN_EASE = 1.3;
/** EF 上限 */
export const MAX_EASE = 3.0;
/** 掌握度滑动平均：新观测占 30%，历史占 70% */
const SCORE_ALPHA = 0.3;
/** 遗忘衰减下限：再久也保留 30% 的静态掌握度，不归零 */
const RETENTION_FLOOR = 0.3;
/** 稳定性随连对次数的增幅：每 1 次连对，稳定性 +50%（最多按 12 次计） */
const STABILITY_GROWTH = 0.5;
/** 单次复习间隔上限（天），防止间隔无限膨胀 */
const MAX_INTERVAL_DAYS = 365;

/** 夹在 [lo, hi] 之间 */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 夹在 0..1 之间 */
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** 有限数兜底：非有限值（NaN/Infinity）一律用 fallback */
function num(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** 保留 1 位小数，去掉浮点噪声 */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** 新建一条初始 MasteryRecord：未练习过，立即到期（dueAt = at） */
export function createMastery(knowledgePointId: string, at: number): MasteryRecord {
  const t = num(at, 0);
  return {
    knowledgePointId,
    score: 0,
    attempts: 0,
    correct: 0,
    lastSeen: t,
    dueAt: t,
    intervalDays: 0,
    ease: INITIAL_EASE,
    reps: 0,
  };
}

/**
 * 用一次作答结果更新掌握度，返回新的 record（纯函数，不改入参）。
 * - 通过（scoreRatio >= 0.8）：reps+1，间隔按 1 → 3 → interval*ease 递推，并乘得分率加成；
 *   EF 至少 +0.05（上限 3.0）。
 * - 未通过：reps 归零，间隔回落 1 天，EF 至少 -0.15（下限 1.3）。
 */
export function updateMastery(prev: MasteryRecord, grade: Grade, at: number): MasteryRecord {
  const prevLastSeen = num(prev.lastSeen, 0);
  // 乱序作答（时间回退）时不让记录时间倒退
  const eventAt = Math.max(num(at, 0), prevLastSeen);

  const ratio = clamp01(num(grade.scoreRatio, 0));
  const prevAttempts = Math.max(0, Math.floor(num(prev.attempts, 0)));
  const prevCorrect = Math.max(0, Math.floor(num(prev.correct, 0)));
  const prevScore = clamp01(num(prev.score, 0));
  const prevEase = clamp(num(prev.ease, INITIAL_EASE), MIN_EASE, MAX_EASE);
  const prevReps = Math.max(0, Math.floor(num(prev.reps, 0)));
  const prevInterval = Math.max(0, num(prev.intervalDays, 0));

  const passed = ratio >= PASS_RATIO;

  // 掌握度：指数滑动平均；首次作答直接取得分率
  const score = prevAttempts === 0 ? ratio : prevScore * (1 - SCORE_ALPHA) + ratio * SCORE_ALPHA;

  // EF：以 SM-2 的质量分公式为基础，再保证"通过必微增、未通过必下调"
  const q = ratio * 5;
  const sm2Delta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
  const easeDelta = passed ? Math.max(0.05, sm2Delta) : Math.min(-0.15, sm2Delta);
  const ease = clamp(prevEase + easeDelta, MIN_EASE, MAX_EASE);

  let reps: number;
  let rawInterval: number;
  if (passed) {
    reps = prevReps + 1;
    const base =
      reps === 1 ? 1 : reps === 2 ? 3 : Math.max(prevInterval > 0 ? prevInterval : 1, 1) * ease;
    // 得分率越高，间隔给得越长（0.9 ~ 1.1 倍）
    rawInterval = base * (0.9 + 0.2 * ratio);
  } else {
    reps = 0;
    rawInterval = 1;
  }

  const intervalDays = round1(clamp(rawInterval, 1, MAX_INTERVAL_DAYS));
  const dueAt = eventAt + intervalDays * DAY_MS;

  return {
    ...prev,
    knowledgePointId: prev.knowledgePointId,
    score,
    attempts: prevAttempts + 1,
    correct: prevCorrect + (passed ? 1 : 0),
    lastSeen: eventAt,
    dueAt,
    intervalDays,
    ease,
    reps,
  };
}

/**
 * 计算"当前"掌握度（把遗忘衰减算进去）。
 * score * (0.3 + 0.7 * exp(-elapsedDays / stability))：
 * - 刚复习完（elapsed=0）等于静态 score；
 * - 时间越久越低，单调不增，最低保留 30%；
 * - stability 由 intervalDays 与 reps 推出：间隔越长、连对越多，忘得越慢。
 */
export function currentScore(record: MasteryRecord, now: number): number {
  const score = clamp01(num(record.score, 0));
  const lastSeen = num(record.lastSeen, 0);
  // now 早于 lastSeen（时钟回拨/乱序）按 0 处理，不放大掌握度
  const elapsedDays = Math.max(0, num(now, lastSeen) - lastSeen) / DAY_MS;
  if (elapsedDays === 0 || score === 0) return score;

  // intervalDays 为 0（新建/异常数据）时按 1 天算，保证 stability > 0
  const interval = num(record.intervalDays, 0) > 0 ? num(record.intervalDays, 1) : 1;
  const reps = clamp(num(record.reps, 0), 0, 12);
  const stability = Math.max(1, interval) * (1 + STABILITY_GROWTH * reps);

  const retention = RETENTION_FLOOR + (1 - RETENTION_FLOOR) * Math.exp(-elapsedDays / stability);
  return clamp01(score * retention);
}

/**
 * 批量更新：一次答题涉及多个知识点时用。
 * - 已有记录的按同一得分率更新；没有记录的会先建再更新；
 * - knowledgePointIds 自动去重（避免同题重复计次），空数组原样返回副本；
 * - 时间取 grade.at（非有限值时退回 now）。
 */
export function applyGrade(records: MasteryRecord[], grade: Grade, now: number): MasteryRecord[] {
  const at = num(grade.at, num(now, 0));
  const ids: string[] = [];
  const wanted = new Set<string>();
  for (const id of grade.knowledgePointIds) {
    if (typeof id === 'string' && id.length > 0 && !wanted.has(id)) {
      wanted.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) return records.slice();

  const result: MasteryRecord[] = records.map((record) => {
    if (!wanted.has(record.knowledgePointId)) return record;
    return updateMastery(record, { knowledgePointIds: ids, scoreRatio: grade.scoreRatio, at }, at);
  });

  const existing = new Set(records.map((record) => record.knowledgePointId));
  for (const id of ids) {
    if (existing.has(id)) continue;
    const fresh = createMastery(id, at);
    result.push(updateMastery(fresh, { knowledgePointIds: ids, scoreRatio: grade.scoreRatio, at }, at));
  }
  return result;
}
