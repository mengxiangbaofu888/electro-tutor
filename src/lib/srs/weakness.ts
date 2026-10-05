/**
 * weakness.ts —— 薄弱点排序：把掌握度、样本量、遗忘程度、出错情况合成可排序的 severity
 */
import type { MasteryInput, MasteryRecord, WeakPoint } from './types';
import { currentScore, DAY_MS } from './mastery';

/** 四类因素的权重（合计 1）：掌握度为主，遗忘与出错次之，样本量最少 */
const W_MASTERY = 0.45;
const W_UNCERTAINTY = 0.15;
const W_STALE = 0.2;
const W_ERROR = 0.2;

/** 认为"样本够用"的作答次数（达到后不确定性归零） */
const CONFIDENT_ATTEMPTS = 4;
/** 样本极少（<= 2 次）时理由权重的加成：先提示"样本不够"，别急着下结论 */
const TINY_SAMPLE_BOOST = 2;
/** 未复习多久算"遗忘到顶"（天） */
const STALE_FULL_DAYS = 14;
/** 完全没练过时的固定严重度：高于一般薄弱点，低于"四个维度全崩"的极端点（理论上限约 0.96） */
const UNPRACTICED_SEVERITY = 0.8;
/** 理由片段的最小权重，低于此值视为"不值得一提" */
const MIN_REASON_WEIGHT = 0.05;
/** reason 最多拼接几条理由 */
const MAX_REASON_PARTS = 2;

/** 一个理由片段及其在 severity 中的贡献权重 */
interface ReasonPart {
  text: string;
  weight: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function num(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** 0..1 -> 百分数整数 */
function pct(v: number): number {
  return Math.round(clamp01(v) * 100);
}

/** 作答过（至少 1 次）的记录：算 severity 并给出中文理由 */
function evaluateRecord(record: MasteryRecord, now: number): { score: number; severity: number; reason: string } {
  const score = currentScore(record, now);
  const attempts = Math.max(0, Math.floor(num(record.attempts, 0)));
  const correct = Math.max(0, Math.floor(num(record.correct, 0)));
  const reps = Math.max(0, Math.floor(num(record.reps, 0)));
  const lastSeen = num(record.lastSeen, now);
  const elapsedDays = Math.max(0, num(now, lastSeen) - lastSeen) / DAY_MS;

  const masteryGap = clamp01(1 - score);
  const uncertainty = 1 - Math.min(attempts / CONFIDENT_ATTEMPTS, 1);
  const staleGap = Math.min(elapsedDays / STALE_FULL_DAYS, 1);
  const errorRate = attempts > 0 ? clamp01((attempts - correct) / attempts) : 1;
  const streakFail = attempts > 0 && reps === 0 ? 1 : 0;
  // "近期反复出错"：历史错误率 + 当前是否处于连错（记录里没有逐题明细，用这两项近似）
  const recentError = clamp01(0.6 * errorRate + 0.4 * streakFail);

  const severity = clamp01(
    W_MASTERY * masteryGap + W_UNCERTAINTY * uncertainty + W_STALE * staleGap + W_ERROR * recentError,
  );

  const parts: ReasonPart[] = [];

  if (score < 0.8) {
    const text =
      score < 0.3 ? `掌握度仅 ${pct(score)}%，基本没掌握` : score < 0.6 ? `掌握度仅 ${pct(score)}%` : `掌握度 ${pct(score)}%，还不够稳`;
    parts.push({ text, weight: W_MASTERY * masteryGap });
  }

  if (elapsedDays >= 1) {
    const days = Math.round(elapsedDays);
    const text = elapsedDays >= 7 ? `近 ${days} 天未复习，遗忘明显` : `已 ${days} 天未复习`;
    parts.push({ text, weight: W_STALE * staleGap });
  }

  if (attempts < CONFIDENT_ATTEMPTS) {
    parts.push({
      text: `只做过 ${attempts} 道题，样本太少，建议再练 ${CONFIDENT_ATTEMPTS - attempts} 道确认`,
      weight: W_UNCERTAINTY * uncertainty * (attempts <= 2 ? TINY_SAMPLE_BOOST : 1),
    });
  }

  if (attempts >= 2 && streakFail === 1) {
    parts.push({ text: `最近仍未通过，历史正确率仅 ${pct(1 - errorRate)}%`, weight: W_ERROR * recentError });
  } else if (errorRate >= 0.3) {
    parts.push({ text: `历史正确率仅 ${pct(1 - errorRate)}%，出错偏多`, weight: W_ERROR * recentError });
  }

  const useful = parts
    .filter((part) => part.weight >= MIN_REASON_WEIGHT)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_REASON_PARTS)
    .map((part) => part.text);

  const reason = useful.length > 0 ? useful.join('，且') : '掌握情况良好，保持复习节奏即可';
  return { score, severity, reason };
}

/**
 * 按薄弱程度排序，输出前 limit 个薄弱知识点。
 * - severity（0..1）= 0.45*掌握度缺口 + 0.15*样本不足 + 0.2*遗忘程度 + 0.2*出错程度；
 * - 没有记录（或记录 attempts 为 0）的也参与，severity 固定 0.8，reason 为"尚未练习过"
 *   （空白点高于"练过但一般"，低于"练过且四个维度全崩"的极端点，理论最高约 0.96）；
 * - reason 由权重最高的 2 条理由用"，且"拼接，样本 <= 2 次时优先提示"样本太少"；
 * - 排序：severity 降序 → 当前掌握度升序 → id 升序（稳定可复现）；
 * - limit 省略 = 全部；limit <= 0 = 空数组。
 */
export function rankWeakPoints(inputs: MasteryInput[], now: number, limit?: number): WeakPoint[] {
  const t = Number.isFinite(now) ? now : 0;
  const seen = new Set<string>();
  const result: WeakPoint[] = [];

  for (const input of inputs) {
    const id = input.knowledgePointId;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);

    const record = input.record;
    const attempts = record ? Math.max(0, Math.floor(num(record.attempts, 0))) : 0;
    if (record === undefined || attempts === 0) {
      result.push({ knowledgePointId: id, score: 0, severity: UNPRACTICED_SEVERITY, reason: '尚未练习过' });
      continue;
    }

    const { score, severity, reason } = evaluateRecord(record, t);
    result.push({ knowledgePointId: id, score, severity, reason });
  }

  result.sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    if (a.score !== b.score) return a.score - b.score;
    return a.knowledgePointId < b.knowledgePointId ? -1 : a.knowledgePointId > b.knowledgePointId ? 1 : 0;
  });

  if (limit === undefined) return result;
  const n = Math.floor(Number.isFinite(limit) ? limit : 0);
  return n <= 0 ? [] : result.slice(0, n);
}
