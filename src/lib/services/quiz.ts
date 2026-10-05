/**
 * 出题与组卷服务。
 */
import { db, getDefaultLLM, getProfile, newId } from '../db/db';
import type { Attempt, ID, KnowledgePoint, Paper, Question, QuestionType, TrackId } from '../db/types';
import { QUESTION_TYPE_LABELS } from '../db/types';
import { chat, truncateText } from '../llm/client';
import { parseArrayLoose } from '../llm/json';
import { buildQuestionMessages, type QuestionDraft } from '../llm/prompts';
import { getOutlinePoints } from './outline';

/** 出题时附带的材料片段上限 */
const EXCERPT_BUDGET = 6_000;

export interface GenerateQuestionsParams {
  outlineId: ID;
  track: TrackId;
  /** 每个知识点要出几道 */
  allocation: { pointId: ID; count: number }[];
  /** 题型配比 */
  typeMix: { type: QuestionType; count: number }[];
  /** 难度描述，例如「以 2~3 星为主，穿插 1 道 4 星」 */
  difficultyMix: string;
  /** 是否把材料原文片段一起给模型参考 */
  withMaterial?: boolean;
  onProgress?: (delta: string) => void;
  /** 非致命问题的提示（例如有题目格式不完整被跳过） */
  onWarning?: (text: string) => void;
}

/** 把模型返回的知识点名称匹配到本地知识点 id */
function matchPointIds(names: string[] | undefined, points: KnowledgePoint[]): ID[] {
  if (!names?.length) return [];
  const ids: ID[] = [];
  for (const raw of names) {
    const name = String(raw).trim();
    let hit = points.find((p) => p.name === name);
    if (!hit) hit = points.find((p) => p.name.includes(name) || name.includes(p.name));
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
  }
  return ids;
}

/* ------------------------------ 模型输出的规范化与校验 ------------------------------ */

/**
 * 把模型返回的选项规范成 {key,text}[]。
 *
 * 模型经常不严格照约定来：可能给字符串数组、可能把文本放在 content/value 里、
 * 可能不给 key 或给重复的 key。以前的做法是"key 和 text 都得有，否则丢掉"——
 * 结果是一道**单选题一个选项都没有**，用户点进去发现根本没法作答。
 */
export function normalizeOptions(raw: unknown): { key: string; text: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: { key: string; text: string }[] = [];

  raw.forEach((item, index) => {
    const fallback = String.fromCharCode(65 + index);
    if (typeof item === 'string') {
      const text = item.trim();
      if (text) out.push({ key: fallback, text });
      return;
    }
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const text = String(rec.text ?? rec.content ?? rec.value ?? rec.label ?? '').trim();
      if (!text) return;
      const rawKey = String(rec.key ?? fallback).trim().toUpperCase();
      out.push({ key: /^[A-H]$/.test(rawKey) ? rawKey : fallback, text });
    }
  });
  if (!out.length) return undefined;

  // key 有重复或非法时，整体按顺序重排成 A、B、C……
  const keys = out.map((o) => o.key);
  const ok = new Set(keys).size === keys.length && keys.every((k) => /^[A-H]$/.test(k));
  return ok ? out : out.map((o, i) => ({ key: String.fromCharCode(65 + i), text: o.text }));
}

/**
 * 规范标准答案。
 *
 * 单选/多选最常见的问题是模型直接回了**选项文本**而不是字母，
 * 那样判分永远判错——**用户答对了却被算错**，是最伤信任的失败方式。
 * 这里如果答案不是有效字母，会尝试按选项文本反查回字母。
 */
export function normalizeAnswer(
  type: QuestionType,
  raw: unknown,
  options?: { key: string; text: string }[],
): string | string[] {
  const asArray = Array.isArray(raw) ? raw.map((v) => String(v)) : [String(raw ?? '')];
  const cleaned = asArray.map((s) => s.trim());

  /** 把一段答案（字母 / 选项文本 / "A. 甲"）转成选项字母 */
  const toKey = (value: string): string => {
    const v = value.trim();
    if (!v) return '';
    const upper = v.toUpperCase();
    if (/^[A-H]$/.test(upper) && (!options || options.some((o) => o.key === upper))) return upper;

    const byText = options?.find((o) => o.text.trim() === v);
    if (byText) return byText.key;

    const prefixed = /^([A-H])[.、．)）:：\s]/.exec(upper);
    if (prefixed && (!options || options.some((o) => o.key === prefixed[1]))) return prefixed[1];

    return upper;
  };

  if (type === 'single') return toKey(cleaned[0] ?? '');

  if (type === 'multiple') {
    // 兼容 ["A","B"]、["AB"]、"A,B"、"A、B" 几种写法
    const letters = cleaned
      .flatMap((s) => s.split(/[,，、;；\s]+/))
      .flatMap((token) => {
        const t = token.trim().toUpperCase();
        // 「AB」这种连写要拆成 A、B；但如果某个选项的文本正好就是「AB」，
        // 那它更像是在回答那个选项，不拆。
        if (/^[A-H]{2,}$/.test(t) && !options?.some((o) => o.text.trim().toUpperCase() === t)) {
          return [...t];
        }
        return [token];
      })
      .map(toKey)
      .filter((s) => /^[A-H]$/.test(s));
    return [...new Set(letters)].sort();
  }

  if (type === 'judge') {
    const v = cleaned[0] ?? '';
    const t = v.toLowerCase();
    if (['正确', '对', '是', 'true', 't', '√', 'right', 'y', 'yes'].includes(t)) return '正确';
    if (['错误', '错', '否', 'false', 'f', '×', 'x', 'wrong', 'n', 'no'].includes(t)) return '错误';
    return v;
  }

  if (type === 'blank') {
    const parts = cleaned.filter((s) => s !== '');
    return parts.length > 1 ? parts : (parts[0] ?? '');
  }

  return cleaned.filter((s) => s !== '').join('\n');
}

/**
 * 这道题能不能真的拿来考人。
 * 不能考的（没答案、选项不够、答案不在选项里）就别入库——
 * 留着只会让用户困惑：明明答对了却判错，或者根本没有可选项。
 */
export function isAnswerable(q: {
  type: QuestionType;
  stem: string;
  options?: { key: string; text: string }[];
  answer: string | string[];
}): { ok: true } | { ok: false; reason: string } {
  if (!q.stem.trim()) return { ok: false, reason: '缺题干' };

  const answers = (Array.isArray(q.answer) ? q.answer : [q.answer])
    .map((a) => String(a).trim())
    .filter(Boolean);
  if (!answers.length) return { ok: false, reason: '缺标准答案（这种题永远判不对）' };

  if (q.type === 'single' || q.type === 'multiple') {
    if (!q.options || q.options.length < 2) return { ok: false, reason: '选项不足两个' };
    const keys = new Set(q.options.map((o) => o.key));
    const bad = answers.filter((a) => !keys.has(a));
    if (bad.length) return { ok: false, reason: `答案 ${bad.join('、')} 不在选项里` };
  }
  return { ok: true };
}

/**
 * 调大模型生成题目并入库。
 * 会按题型分批请求，避免一次要太多题导致模型偷懒或截断。
 */
export async function generateQuestions(
  params: GenerateQuestionsParams,
): Promise<Question[]> {
  const { outlineId, track, allocation, typeMix, difficultyMix, withMaterial, onProgress, onWarning } = params;

  const config = await getDefaultLLM('text');
  if (!config) throw new Error('还没有配置文本大模型，请先到「我的 → 模型配置」里添加。');

  const wanted = allocation.filter((a) => a.count > 0);
  if (!wanted.length) throw new Error('请至少给一个知识点安排题目数量。');

  const allPoints = await getOutlinePoints(outlineId);
  const pointById = new Map(allPoints.map((p) => [p.id, p]));

  const kpPayload = wanted.map((a) => {
    const p = pointById.get(a.pointId);
    return { name: p?.name ?? '未命名知识点', summary: p?.summary, targetCount: a.count };
  });

  const profile = await getProfile();

  // 材料片段（可选）
  let excerpt: string | undefined;
  if (withMaterial) {
    const outline = await db.outlines.get(outlineId);
    if (outline?.materialIds.length) {
      const mats = await db.materials.bulkGet(outline.materialIds);
      const joined = mats
        .filter((m): m is NonNullable<typeof m> => Boolean(m))
        .map((m) => `### ${m.title}\n${m.content}`)
        .join('\n\n');
      if (joined) excerpt = truncateText(joined, EXCERPT_BUDGET);
    }
  }

  const messages = buildQuestionMessages({
    track,
    knowledgePoints: kpPayload,
    typeMix,
    difficultyMix,
    materialExcerpt: excerpt,
    profile,
  });

  let raw = '';
  const result = await chat(config, messages, {
    jsonMode: true,
    temperature: 0.7,
    maxTokens: 8192,
    onDelta: (delta) => {
      raw += delta;
      onProgress?.(delta);
    },
  });
  const text = result.content || raw;

  const drafts = parseArrayLoose<QuestionDraft>(text, '题目');
  if (!drafts.length) throw new Error('模型没有生成任何题目，请调整知识点或稍后重试。');

  const questions: Question[] = [];
  const skippedReasons: string[] = [];

  for (const d of drafts) {
    if (!d || typeof d.stem !== 'string' || !d.stem.trim()) {
      skippedReasons.push('缺题干');
      continue;
    }
    const type: QuestionType = (
      ['single', 'multiple', 'judge', 'blank', 'short', 'calc'] as QuestionType[]
    ).includes(d.type)
      ? d.type
      : 'single';
    const options = normalizeOptions(d.options);
    const answer = normalizeAnswer(type, d.answer, options);

    const check = isAnswerable({ type, stem: d.stem, options, answer });
    if (!check.ok) {
      skippedReasons.push(check.reason);
      continue;
    }

    questions.push({
      id: newId(),
      outlineId,
      knowledgePointIds: matchPointIds(d.knowledgePointNames, allPoints),
      type,
      stem: String(d.stem).trim(),
      options,
      answer,
      explanation: String(d.explanation ?? '').trim(),
      difficulty: Math.min(5, Math.max(1, Math.round(Number(d.difficulty) || 3))),
      source: 'ai' as const,
      createdAt: Date.now(),
      rubric: d.rubric?.length ? d.rubric : undefined,
    });
  }

  // 被跳过的题要说出来。静默丢弃会让用户以为"模型只出了这么几道"。
  if (skippedReasons.length) {
    const summary = [...new Set(skippedReasons)].join('；');
    onWarning?.(`有 ${skippedReasons.length} 道题格式不完整，已跳过（${summary}）。`);
  }
  if (!questions.length) {
    throw new Error(
      `模型返回的 ${drafts.length} 道题都无法使用（${[...new Set(skippedReasons)].join('；')}），请重试或换个模型。`,
    );
  }

  await db.questions.bulkPut(questions);
  return questions;
}

/** 组卷 */
export async function createPaper(params: {
  title: string;
  questionIds: ID[];
  durationMin: number;
  outlineId?: ID;
  track?: TrackId;
}): Promise<Paper> {
  if (!params.questionIds.length) throw new Error('这份卷子还没有题目。');
  const paper: Paper = {
    id: newId(),
    title: params.title.trim() || `模拟测验 ${new Date().toLocaleDateString('zh-CN')}`,
    outlineId: params.outlineId,
    track: params.track,
    questionIds: params.questionIds,
    durationMin: params.durationMin,
    createdAt: Date.now(),
  };
  await db.papers.put(paper);
  return paper;
}

/** 按知识点筛选题库 */
export async function listQuestionsByPoints(pointIds: ID[]): Promise<Question[]> {
  if (!pointIds.length) return [];
  return db.questions.where('knowledgePointIds').anyOf(pointIds).toArray();
}

/** 开始一次测验（创建答题记录） */
export async function startAttempt(paper: Paper): Promise<Attempt> {
  const attempt: Attempt = {
    id: newId(),
    paperId: paper.id,
    paperTitle: paper.title,
    startedAt: Date.now(),
    answers: [],
  };
  await db.attempts.put(attempt);
  return attempt;
}

/**
 * 一键快速练习：直接拿一批题目组卷并开始答题。
 * 首页的「今日复习」和薄弱点补强都走这个入口。
 */
export async function startQuickPractice(params: {
  title: string;
  questions: Question[];
  durationMin?: number;
  track?: TrackId;
}): Promise<Attempt> {
  if (!params.questions.length) throw new Error('没有可练习的题目。请先到「练习」页生成题目。');
  const paper = await createPaper({
    title: params.title,
    questionIds: params.questions.map((q) => q.id),
    durationMin: params.durationMin ?? 0,
    outlineId: params.questions[0]?.outlineId,
    track: params.track,
  });
  return startAttempt(paper);
}

/** 列出全部题目（新的在前） */
export async function listAllQuestions(): Promise<Question[]> {
  const all = await db.questions.toArray();
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/** 按大纲查题目 */
export async function listQuestionsByOutline(outlineId: ID): Promise<Question[]> {
  return db.questions.where('outlineId').equals(outlineId).toArray();
}

/** 把题型配比渲染成给用户看的一行字 */
export function describeTypeMix(typeMix: { type: QuestionType; count: number }[]): string {
  return typeMix
    .filter((t) => t.count > 0)
    .map((t) => `${QUESTION_TYPE_LABELS[t.type]}×${t.count}`)
    .join('、');
}

/** 每种题型默认给多少分（用于百分制换算） */
export const SCORE_PER_QUESTION: Record<QuestionType, number> = {
  single: 2,
  multiple: 4,
  judge: 1,
  blank: 2,
  short: 8,
  calc: 10,
};
