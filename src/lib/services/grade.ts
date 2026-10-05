/**
 * 阅卷服务。
 *
 * 策略：客观题本地判（免费、离线、100% 准确）；主观题交给大模型按评分点给分。
 */
import { db, getDefaultLLM, getProfile } from '../db/db';
import type { AnswerRecord, Attempt, ID, Question, QuestionType, StudyReport } from '../db/types';
import { QUESTION_TYPE_LABELS, isObjective } from '../db/types';
import { chat } from '../llm/client';
import { parseJsonLoose } from '../llm/json';
import { buildGradeMessages, buildReportMessages, type GradeDraft, type ReportDraft } from '../llm/prompts';
import { SCORE_PER_QUESTION } from './quiz';

/* ------------------------------ 答案归一化 ------------------------------ */

/** 全角转半角、去空白、统一大小写与常见标点 */
function normalize(raw: string): string {
  return raw
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/[\s,，。;；、:：'"'"`]/g, '')
    .toLowerCase();
}

/** 判断题答案归一化为布尔 */
function normalizeJudge(raw: string): boolean | null {
  const v = normalize(raw);
  if (['正确', '对', 'true', 't', 'yes', 'y', '√', 'v', '是', 'right'].includes(v)) return true;
  if (['错误', '错', 'false', 'f', 'no', 'n', '×', 'x', '否', 'wrong'].includes(v)) return false;
  return null;
}

/** 判断题的标准答案也归一化 */
function judgeKey(raw: string): boolean | null {
  const direct = normalizeJudge(raw);
  if (direct !== null) return direct;
  return null;
}

/** 主观化答案：数组或字符串统一成数组 */
export function toAnswerArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [String(value)];
}

export interface ObjectiveGrade {
  isCorrect: boolean;
  /** 部分正确（多选/填空半对）时的得分率 */
  scoreRatio: number;
}

/**
 * 客观题本地判分。
 * - 单选/判断：全对才得分
 * - 多选：全对满分，漏选给一半，错选 0 分（国内考试常见规则）
 * - 填空：多个空按比例给分
 */
export function gradeObjective(question: Question, userAnswer: string | string[]): ObjectiveGrade {
  const std = toAnswerArray(question.answer);

  if (question.type === 'judge') {
    const expected = judgeKey(std[0] ?? '');
    const got = normalizeJudge(toAnswerArray(userAnswer)[0] ?? '');
    const ok = expected !== null && got !== null && expected === got;
    return { isCorrect: ok, scoreRatio: ok ? 1 : 0 };
  }

  if (question.type === 'multiple') {
    const expectedSet = new Set(std.map((s) => normalize(s)).filter(Boolean));
    const gotArr = toAnswerArray(userAnswer).map((s) => normalize(s)).filter(Boolean);
    const gotSet = new Set(gotArr);
    if (!gotSet.size) return { isCorrect: false, scoreRatio: 0 };
    const wrong = gotArr.some((g) => !expectedSet.has(g));
    if (wrong) return { isCorrect: false, scoreRatio: 0 };
    const missed = [...expectedSet].some((e) => !gotSet.has(e));
    if (missed) return { isCorrect: false, scoreRatio: 0.5 };
    return { isCorrect: true, scoreRatio: 1 };
  }

  if (question.type === 'blank') {
    const gotArr = toAnswerArray(userAnswer);
    if (!std.length) return { isCorrect: false, scoreRatio: 0 };
    let hit = 0;
    std.forEach((s, i) => {
      // 支持一个空有多个可接受答案，用 ｜ 或 / 分隔
      const accepted = String(s)
        .split(/[|｜/]/)
        .map((x) => normalize(x))
        .filter(Boolean);
      const got = normalize(gotArr[i] ?? '');
      if (got && accepted.includes(got)) hit += 1;
    });
    const ratio = hit / std.length;
    return { isCorrect: ratio >= 0.999, scoreRatio: ratio };
  }

  // 单选
  const expected = normalize(std[0] ?? '');
  const got = normalize(toAnswerArray(userAnswer)[0] ?? '');
  const ok = Boolean(expected) && expected === got;
  return { isCorrect: ok, scoreRatio: ok ? 1 : 0 };
}

/* ------------------------------ 主观题 AI 批改 ------------------------------ */

/** 用大模型批改一道主观题 */
export async function gradeSubjective(
  question: Question,
  userAnswer: string | string[],
): Promise<AnswerRecord> {
  const config = await getDefaultLLM('text');
  if (!config) throw new Error('还没有配置文本大模型，无法批改主观题。');

  const profile = await getProfile();
  const messages = buildGradeMessages({ question, userAnswer, profile });
  const res = await chat(config, messages, { jsonMode: true, temperature: 0.2 });
  const draft = parseJsonLoose<GradeDraft>(res.content, '批改结果');

  const ratio = Math.min(1, Math.max(0, Number(draft.scoreRatio) || 0));
  return {
    questionId: question.id,
    userAnswer,
    isCorrect: typeof draft.isCorrect === 'boolean' ? draft.isCorrect : ratio >= 0.8,
    scoreRatio: ratio,
    aiComment: [draft.comment, ...(draft.knowledgeGaps?.length ? [`知识缺口：${draft.knowledgeGaps.join('；')}`] : [])]
      .filter(Boolean)
      .join('\n'),
    aiBreakdown: Array.isArray(draft.breakdown)
      ? draft.breakdown.map((b) => ({
          point: String(b.point ?? ''),
          got: Number(b.got) || 0,
          full: Number(b.full) || 0,
          comment: String(b.comment ?? ''),
        }))
      : undefined,
  };
}

/** 统一入口：按题型自动选择本地判分或 AI 批改 */
export async function gradeOne(question: Question, userAnswer: string | string[]): Promise<AnswerRecord> {
  if (isObjective(question.type)) {
    const g = gradeObjective(question, userAnswer);
    return {
      questionId: question.id,
      userAnswer,
      isCorrect: g.isCorrect,
      scoreRatio: g.scoreRatio,
      aiComment: g.isCorrect ? undefined : `正确答案：${toAnswerArray(question.answer).join(' / ')}`,
    };
  }
  return gradeSubjective(question, userAnswer);
}

/* ------------------------------ 交卷与报告 ------------------------------ */

/** 计算总分（百分制） */
export function computeScore(questions: Question[], answers: AnswerRecord[]): number {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  let got = 0;
  let full = 0;
  for (const q of questions) {
    const weight = SCORE_PER_QUESTION[q.type] ?? 2;
    full += weight;
    const record = byId.get(q.id);
    const ratio = record?.scoreRatio ?? 0;
    got += weight * ratio;
  }
  if (!full) return 0;
  return Math.round((got / full) * 100);
}

/**
 * 交卷：算总分、生成学习报告并落库。
 * @param onProgress 报告生成的流式回调
 */
export async function finishAttempt(params: {
  attemptId: ID;
  onProgress?: (delta: string) => void;
}): Promise<{ attempt: Attempt; report: StudyReport }> {
  const { attemptId, onProgress } = params;
  const attempt = await db.attempts.get(attemptId);
  if (!attempt) throw new Error('找不到这次测验记录。');

  const paper = await db.papers.get(attempt.paperId);
  const questions = paper
    ? ((await db.questions.bulkGet(paper.questionIds)).filter(Boolean) as Question[])
    : [];
  if (!questions.length) throw new Error('这份卷子的题目已经不存在了。');

  const score = computeScore(questions, attempt.answers);
  const finished: Attempt = { ...attempt, finishedAt: Date.now(), score };
  await db.attempts.put(finished);

  // 生成学习报告（AI）
  const report = await buildReport({ attempt: finished, questions, onProgress });
  finished.report = report;
  await db.attempts.put(finished);

  return { attempt: finished, report };
}

/** 生成学习报告 */
export async function buildReport(params: {
  attempt: Attempt;
  questions: Question[];
  onProgress?: (delta: string) => void;
}): Promise<StudyReport> {
  const { attempt, questions, onProgress } = params;
  const config = await getDefaultLLM('text');
  const score = attempt.score ?? computeScore(questions, attempt.answers);

  // 先把所有知识点名字查出来（薄弱点排序要用）
  const pointIds = [...new Set(questions.flatMap((q) => q.knowledgePointIds))];
  const points = pointIds.length ? await db.knowledgePoints.bulkGet(pointIds) : [];
  const nameById = new Map(
    points.filter((p): p is NonNullable<typeof p> => Boolean(p)).map((p) => [p.id, p.name]),
  );

  const answerById = new Map(attempt.answers.map((a) => [a.questionId, a]));
  const items = questions.map((q) => {
    const a = answerById.get(q.id);
    return {
      id: q.id,
      stem: q.stem,
      type: q.type,
      isCorrect: a?.isCorrect ?? false,
      userAnswer: toAnswerArray(a?.userAnswer ?? '').join(' / '),
      correctAnswer: toAnswerArray(q.answer).join(' / '),
      comment: a?.aiComment,
    };
  });

  // 本地先算一版薄弱点（即使 AI 报告失败，用户也能看到薄弱点）
  const localWeak = computeLocalWeakPoints(questions, attempt.answers, nameById);

  if (!config) {
    return {
      score,
      summary: '还没有配置文本大模型，只能给出本地统计结果。请到「我的 → 模型配置」添加模型后重新生成报告。',
      weakPoints: localWeak,
      mistakes: [],
      suggestions: ['先完成模型配置，才能得到错因分析和针对性建议。'],
      generatedAt: Date.now(),
    };
  }

  const profile = await getProfile();
  const paper = await db.papers.get(attempt.paperId);
  const messages = buildReportMessages({
    track: paper?.track ?? 'fundamental',
    score,
    items,
    profile,
  });

  let raw = '';
  try {
    const res = await chat(config, messages, {
      jsonMode: true,
      temperature: 0.4,
      maxTokens: 4096,
      onDelta: (delta) => {
        raw += delta;
        onProgress?.(delta);
      },
    });
    const draft = parseJsonLoose<ReportDraft>(res.content || raw, '学习报告');
    const draftMistakes = Array.isArray(draft.mistakes) ? draft.mistakes : [];
    return {
      score,
      summary: draft.summary ?? '',
      weakPoints: localWeak,
      mistakes: draftMistakes
        .filter((m) => m && m.questionId)
        .map((m) => ({
          questionId: String(m.questionId),
          what: String(m.what ?? ''),
          why: String(m.why ?? ''),
          fix: String(m.fix ?? ''),
        })),
      suggestions: Array.isArray(draft.suggestions) ? draft.suggestions.map(String) : [],
      generatedAt: Date.now(),
    };
  } catch (e) {
    return {
      score,
      summary: `AI 报告生成失败：${e instanceof Error ? e.message : String(e)}。以下是本地统计结果。`,
      weakPoints: localWeak,
      mistakes: [],
      suggestions: ['可以点「重新生成报告」再试一次。'],
      generatedAt: Date.now(),
    };
  }
}

/** 纯本地薄弱点统计：按知识点聚合正确率，正确率越低越薄弱 */
export function computeLocalWeakPoints(
  questions: Question[],
  answers: AnswerRecord[],
  nameById: Map<ID, string>,
): StudyReport['weakPoints'] {
  const answerById = new Map(answers.map((a) => [a.questionId, a]));
  const stat = new Map<ID, { total: number; got: number }>();
  for (const q of questions) {
    const ratio = answerById.get(q.id)?.scoreRatio ?? 0;
    for (const pid of q.knowledgePointIds) {
      const cur = stat.get(pid) ?? { total: 0, got: 0 };
      cur.total += 1;
      cur.got += ratio;
      stat.set(pid, cur);
    }
  }
  const out: StudyReport['weakPoints'] = [];
  for (const [pid, s] of stat) {
    const rate = s.total ? s.got / s.total : 0;
    if (rate >= 0.8) continue;
    out.push({
      knowledgePointId: pid,
      name: nameById.get(pid) ?? '未知知识点',
      score: rate,
      severity: (1 - rate) * (1 + s.total * 0.1),
      reason: `本次测验该知识点正确率 ${Math.round(rate * 100)}%（${s.total} 道题）`,
    });
  }
  return out.sort((a, b) => b.severity - a.severity);
}

/* ------------------------------ 申诉重判 ------------------------------ */

/** 学生对批改不满意时，带上他的说明重新批改 */
export async function regradeWithAppeal(params: {
  questionId: ID;
  userAnswer: string | string[];
  appeal: string;
}): Promise<AnswerRecord> {
  const question = await db.questions.get(params.questionId);
  if (!question) throw new Error('题目不存在。');
  const config = await getDefaultLLM('text');
  if (!config) throw new Error('还没有配置文本大模型，无法重判。');

  const base = buildGradeMessages({ question, userAnswer: params.userAnswer });
  const messages = [
    ...base,
    {
      role: 'user' as const,
      content:
        `【学生申诉】他认为你的批改有问题，理由是：${params.appeal}\n` +
        '请客观复核。如果你之前判错了，就改分并在 comment 里承认；如果他确实错了，就解释清楚为什么，不要为了讨好而给分。' +
        '仍然只输出 JSON。',
    },
  ];
  const res = await chat(config, messages, { jsonMode: true, temperature: 0.2 });
  const draft = parseJsonLoose<GradeDraft>(res.content, '重判结果');
  const ratio = Math.min(1, Math.max(0, Number(draft.scoreRatio) || 0));
  return {
    questionId: question.id,
    userAnswer: params.userAnswer,
    isCorrect: ratio >= 0.8,
    scoreRatio: ratio,
    aiComment: draft.comment,
    aiBreakdown: Array.isArray(draft.breakdown)
      ? draft.breakdown.map((b) => ({
          point: String(b.point ?? ''),
          got: Number(b.got) || 0,
          full: Number(b.full) || 0,
          comment: String(b.comment ?? ''),
        }))
      : undefined,
    regraded: true,
  };
}

/** 供错题本使用：取一组题目 */
export async function getQuestions(ids: ID[]): Promise<Question[]> {
  if (!ids.length) return [];
  const rows = await db.questions.bulkGet(ids);
  return rows.filter((q): q is Question => Boolean(q));
}

/** 组装一份题目清单的题型分布描述 */
export function describeQuestions(questions: Question[]): string {
  const counter = new Map<QuestionType, number>();
  for (const q of questions) counter.set(q.type, (counter.get(q.type) ?? 0) + 1);
  return [...counter.entries()].map(([t, n]) => `${QUESTION_TYPE_LABELS[t]}×${n}`).join('、');
}
