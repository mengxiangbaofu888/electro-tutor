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
  /**
   * 分批进度：出了几道 / 共几道、正在第几批。
   * 用户要的是"看得见的进度"——一次要 20 道题等半天，是最容易被骂的体验。
   */
  onBatch?: (info: { done: number; total: number; batchIndex: number; batchCount: number }) => void;
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
/**
 * 单次请求最多要几道题。
 *
 * 为什么分批：用户实测"要 20 道题，半天出不来"。一次要 20 道，
 * 模型要一口气吐出很大的 JSON，既慢、又更容易被 max_tokens 截断；
 * 中间还看不到任何进度，只能干等。
 * 改成每批 5 道：每批都快，而且**出一道就能先看到一道**。
 */
export const QUESTION_BATCH_SIZE = 5;

export async function generateQuestions(
  params: GenerateQuestionsParams,
): Promise<Question[]> {
  const {
    outlineId,
    track,
    allocation,
    typeMix,
    difficultyMix,
    withMaterial,
    onProgress,
    onBatch,
    onWarning,
  } = params;

  const config = await getDefaultLLM('text');
  if (!config) throw new Error('还没有配置文本大模型，请先到「我的 → 模型配置」里添加。');

  const wanted = allocation.filter((a) => a.count > 0);
  if (!wanted.length) throw new Error('请至少给一个知识点安排题目数量。');

  const allPoints = await getOutlinePoints(outlineId);
  const pointById = new Map(allPoints.map((p) => [p.id, p]));

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

  const totalWanted = wanted.reduce((sum, a) => sum + a.count, 0);
  const batches = splitAllocation(wanted, QUESTION_BATCH_SIZE);
  const questions: Question[] = [];
  const skippedReasons: string[] = [];
  const batchFailures: string[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchCount = batch.reduce((sum, a) => sum + a.count, 0);

    onBatch?.({
      done: questions.length,
      total: totalWanted,
      batchIndex: i + 1,
      batchCount: batches.length,
    });

    const messages = buildQuestionMessages({
      track,
      knowledgePoints: batch.map((a) => {
        const p = pointById.get(a.pointId);
        return { name: p?.name ?? '未命名知识点', summary: p?.summary, targetCount: a.count };
      }),
      typeMix: scaleTypeMix(typeMix, batchCount),
      difficultyMix,
      materialExcerpt: excerpt,
      profile,
    });

    // 每批最多试两次。
    // 为什么：DeepSeek 官方文档承认 JSON Output **有概率返回空 content**，
    // 并建议"修改 prompt 以缓解此类问题"。所以第一次空/解析不出来时，
    // **追加一句更硬的格式要求**再要一次——这是照官方建议做的补救。
    let drafts: QuestionDraft[] = [];
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2 && !drafts.length; attempt += 1) {
      let raw = '';
      const attemptMessages =
        attempt === 0
          ? messages
          : [
              ...messages,
              {
                role: 'user' as const,
                content:
                  '上一次没有返回任何内容。请**只**输出那个 JSON 对象本身（以 { 开头、以 } 结尾），' +
                  '不要任何解释文字、不要 Markdown 代码围栏、不要前后缀。',
              },
            ];
      try {
        onProgress?.(`正在出第 ${i + 1}/${batches.length} 批（本批 ${batchCount} 道）…`);
        const result = await chat(config, attemptMessages, {
          jsonMode: true,
          temperature: 0.7,
          // 注意别把预算压得太小：推理型模型（DeepSeek 的 deepseek-flash 默认开思考）
          // 会先把额度花在思维链上，额度不够时 **content 直接是空的**——
          // 表现就是"模型没有返回合法 JSON（no braces）"。jsonMode 会自动关思考，
          // 但不同服务商行为不一，所以这里给一个足够的下限。
          maxTokens: Math.max(4096, 800 + batchCount * 400),
          // **不走流式**：实测同一模型（deepseek-flash）非流式正常、流式返回空内容。
          // 出题进度由 onBatch 报（"已出 N / 共 M 道"），比逐字刷 JSON 更有用。
        });
        const text = result.content || raw;
        drafts = parseArrayLoose<QuestionDraft>(text, '题目');
      } catch (e) {
        lastError = e;
      }
    }
    if (!drafts.length) {
      batchFailures.push(
        `第 ${i + 1} 批：${lastError instanceof Error ? lastError.message : '模型两次都没有给出题目'}`,
      );
      continue;
    }
    collectDrafts(drafts, { outlineId, allPoints, questions, skippedReasons });
    onBatch?.({
      done: questions.length,
      total: totalWanted,
      batchIndex: i + 1,
      batchCount: batches.length,
    });
  }

  // 出了什么问题都要说出来。静默丢弃会让用户以为"模型只出了这么几道"。
  // 分两类说：**题目本身不合格**（跳过了几道）和**整批失败**（哪几批没成），
  // 混成一句"N 处"反而让人看不懂到底是题的问题还是接口的问题。
  const notes: string[] = [];
  if (skippedReasons.length) {
    notes.push(
      `有 ${skippedReasons.length} 道题格式不完整，已跳过（${[...new Set(skippedReasons)].join('；')}）`,
    );
  }
  if (batchFailures.length) {
    notes.push(describeBatchFailures(batchFailures));
  }
  if (notes.length) onWarning?.(`${notes.join('；')}。`);

  if (!questions.length) {
    throw new Error(
      `这批题一道都没成（${[...new Set([...skippedReasons, ...batchFailures])].join('；') || '模型没有返回可用内容'}），请重试或换个模型。`,
    );
  }

  await db.questions.bulkPut(questions);
  return questions;
}

/**
 * 把"哪几批失败了"说成人话。
 *
 * 真实反馈：用户看到的是 4 批失败、每条原因一字不差地重复 4 遍
 * （"第 1 批：…；第 2 批：…；第 3 批：…；第 4 批：…"），
 * 一屏红字看着就像程序坏了，而其实原因只有一个。
 * 同一个原因就合并成一句，并说清"是哪几批"。
 */
export function describeBatchFailures(failures: string[]): string {
  const reasons = failures.map((f) => f.replace(/^第\s*\d+\s*批[：:]\s*/, '').trim());
  const unique = [...new Set(reasons)];
  if (failures.length > 1 && unique.length === 1) {
    return `${failures.length} 批都没能出题，原因是同一个：${unique[0]}`;
  }
  return `有 ${unique.length} 批没能出题（${failures.join('；')}）`;
}

/**
 * 把"知识点 → 题量"拆成一批批，每批总量不超过 maxPerBatch。
 * 单个知识点要得比一批还多时，会拆到多批里。
 */
export function splitAllocation(
  allocation: { pointId: ID; count: number }[],
  maxPerBatch: number,
): { pointId: ID; count: number }[][] {
  const limit = Math.max(1, maxPerBatch);
  const batches: { pointId: ID; count: number }[][] = [];
  let current: { pointId: ID; count: number }[] = [];
  let currentCount = 0;
  const flush = () => {
    if (current.length) batches.push(current);
    current = [];
    currentCount = 0;
  };

  for (const a of allocation) {
    let left = Math.max(0, Math.floor(a.count));
    while (left > 0) {
      const room = limit - currentCount;
      if (room <= 0) {
        flush();
        continue;
      }
      const take = Math.min(room, left);
      current.push({ pointId: a.pointId, count: take });
      currentCount += take;
      left -= take;
      if (currentCount >= limit) flush();
    }
  }
  flush();
  return batches;
}

/**
 * 把整套题型配比按比例缩到"这一批要几道"。
 * 按最大余数法分配，保证各题型数量之和**正好等于**这一批的题量。
 */
export function scaleTypeMix(
  mix: { type: QuestionType; count: number }[],
  count: number,
): { type: QuestionType; count: number }[] {
  const usable = mix.filter((m) => m.count > 0);
  const totalMix = usable.reduce((sum, m) => sum + m.count, 0);
  if (!usable.length || totalMix <= 0 || count <= 0) return usable;

  const scaled = usable.map((m) => {
    const exact = (m.count / totalMix) * count;
    const base = Math.floor(exact);
    return { type: m.type, count: base, rem: exact - base };
  });

  let left = count - scaled.reduce((sum, s) => sum + s.count, 0);
  const order = [...scaled].sort((a, b) => b.rem - a.rem);
  for (let i = 0; left > 0 && order.length; i = (i + 1) % order.length) {
    order[i].count += 1;
    left -= 1;
  }

  return scaled
    .filter((s) => s.count > 0)
    .map((s) => ({ type: s.type, count: s.count }));
}

/**
 * 把一批草稿变成可入库的题目：逐题校验，不合格的记下原因。
 * 抽成函数是因为现在**分批出题**，每批都要走一遍同样的校验。
 */
function collectDrafts(
  drafts: QuestionDraft[],
  ctx: {
    outlineId: ID;
    allPoints: KnowledgePoint[];
    questions: Question[];
    skippedReasons: string[];
  },
): void {
  const { outlineId, allPoints, questions, skippedReasons } = ctx;

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
