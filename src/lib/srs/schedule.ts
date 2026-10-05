/**
 * schedule.ts —— 遗忘曲线复习排程：今天该复习什么 + 未来 N 天的复习负载
 */
import type { MasteryRecord } from './types';
import { currentScore, DAY_MS } from './mastery';

/** 逾期天数上限（用于排序时避免极端值，不影响真实数据） */
const MAX_OVERDUE_DAYS = 3650;
/** forecastLoad 允许的最大预测天数，防止误传大数导致内存问题 */
const MAX_FORECAST_DAYS = 3660;

/** dueAt 缺失/非法时按 0 处理（视为已到期，需要被看见） */
function dueAtOf(record: MasteryRecord): number {
  return Number.isFinite(record.dueAt) ? record.dueAt : 0;
}

/** 本地时区的当天 0 点时间戳 */
function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地日期格式化为 YYYY-MM-DD（不用 toISOString，避免时区偏移） */
function formatLocalDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 今天该复习的知识点（dueAt <= now），按紧迫度排序：
 * 逾期越久越靠前；同逾期时当前掌握度越低越靠前；再并列按 dueAt、id 稳定排序。
 * limit 省略 = 全部；limit <= 0 = 空数组。
 */
export function dueForReview(records: MasteryRecord[], now: number, limit?: number): MasteryRecord[] {
  const t = Number.isFinite(now) ? now : 0;
  const due = records.filter((record) => dueAtOf(record) <= t);

  due.sort((a, b) => {
    const overdueA = Math.min((t - dueAtOf(a)) / DAY_MS, MAX_OVERDUE_DAYS);
    const overdueB = Math.min((t - dueAtOf(b)) / DAY_MS, MAX_OVERDUE_DAYS);
    if (overdueA !== overdueB) return overdueB - overdueA;

    const scoreA = currentScore(a, t);
    const scoreB = currentScore(b, t);
    if (scoreA !== scoreB) return scoreA - scoreB;

    const dueDiff = dueAtOf(a) - dueAtOf(b);
    if (dueDiff !== 0) return dueDiff;

    return a.knowledgePointId < b.knowledgePointId ? -1 : a.knowledgePointId > b.knowledgePointId ? 1 : 0;
  });

  if (limit === undefined) return due;
  const n = Math.floor(Number.isFinite(limit) ? limit : 0);
  return n <= 0 ? [] : due.slice(0, n);
}

/**
 * 未来 N 天的复习负载预测：日期(YYYY-MM-DD) -> 待复习条数。
 * - 从"今天"起共 days 天，没有任务的日期也返回 0（方便直接画柱状图）；
 * - 已逾期（dueAt < now）的计入今天（第 0 天），即"今天要补多少"；
 * - 超出窗口的任务不计入；days <= 0 或非有限值返回 {}。
 */
export function forecastLoad(
  records: MasteryRecord[],
  now: number,
  days: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  const t = Number.isFinite(now) ? now : 0;
  const total = Math.min(Math.floor(Number.isFinite(days) ? days : 0), MAX_FORECAST_DAYS);
  if (total <= 0) return out;

  const base = new Date(t);
  base.setHours(0, 0, 0, 0);
  const baseTime = base.getTime();

  const keys: string[] = [];
  for (let i = 0; i < total; i += 1) {
    // 用 (年, 月, 日+i) 构造，天然处理跨月/跨年与夏令时
    const key = formatLocalDate(new Date(base.getFullYear(), base.getMonth(), base.getDate() + i).getTime());
    keys.push(key);
    out[key] = 0;
  }

  for (const record of records) {
    const dueDay = startOfLocalDay(dueAtOf(record));
    // 用四舍五入抵消夏令时造成的 23/25 小时偏差
    const index = Math.round((dueDay - baseTime) / DAY_MS);
    const bucket = index < 0 ? 0 : index;
    if (bucket >= total) continue;
    const key = keys[bucket];
    if (key === undefined) continue;
    out[key] = (out[key] ?? 0) + 1;
  }

  return out;
}
