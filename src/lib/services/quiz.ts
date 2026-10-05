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

/**
 * 调大模型生成题目并入库。
 * 会按题型分批请求，避免一次要太多题导致模型偷懒或截断。
 */
export async function generateQuestions(
  params: GenerateQuestionsParams,
): Promise<Question[]> {
  const { outlineId, track, allocation, typeMix, difficultyMix, withMaterial, onProgress } = params;

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

  const questions: Question[] = drafts
    .filter((d) => d && typeof d.stem === 'string' && d.stem.trim())
    .map((d) => ({
      id: newId(),
      outlineId,
      knowledgePointIds: matchPointIds(d.knowledgePointNames, allPoints),
      type: (['single', 'multiple', 'judge', 'blank', 'short', 'calc'] as QuestionType[]).includes(d.type)
        ? d.type
        : 'single',
      stem: String(d.stem).trim(),
      options: d.options?.filter((o) => o?.key && o?.text),
      answer: d.answer ?? '',
      explanation: String(d.explanation ?? '').trim(),
      difficulty: Math.min(5, Math.max(1, Math.round(Number(d.difficulty) || 3))),
      source: 'ai' as const,
      createdAt: Date.now(),
      rubric: d.rubric?.length ? d.rubric : undefined,
    }));

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
