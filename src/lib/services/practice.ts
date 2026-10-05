/**
 * 自进化引擎的粘合层：
 * 把答题结果喂给 src/lib/srs 的算法，更新掌握度、错题本、复习排程和学习者画像。
 */
import { db, getDefaultLLM, getProfile, newId, saveProfile } from '../db/db';
import type {
  Attempt,
  ID,
  KnowledgePoint,
  LearnerProfile,
  MasteryRecord,
  MicroLessonRow,
  MistakeNote,
  Question,
  QuestionType,
  TrackId,
} from '../db/types';
import { chat } from '../llm/client';
import { generateQuestions, listQuestionsByPoints } from './quiz';
import { parseJsonLoose, parseArrayLoose } from '../llm/json';
import {
  buildMicroLessonMessages,
  buildProfileMessages,
  type MicroLessonDraft,
  type ProfileDraft,
} from '../llm/prompts';
import type { Grade, MasteryInput } from '../srs';
import {
  allocateQuestions,
  applyGrade,
  createMastery,
  currentScore,
  dueForReview,
  forecastLoad,
  questionWeights,
  rankWeakPoints,
} from '../srs';

/** 每累计答这么多题，就刷新一次学习者画像 */
const PROFILE_REFRESH_EVERY = 20;

/* ------------------------------ 保证有题可做 ------------------------------ */

/** 随机取 n 个元素（不改原数组） */
function sample<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/**
 * 保证这批知识点下有题可做：题库里够就直接用，不够就**现场补生成**。
 *
 * 为什么必须有这个函数：首页的「今日复习」「专项突破」都是以知识点为入口的，
 * 如果题库里这些点还没有题，用户点进来只会看到一句"还没有题目"，
 * 而唯一能出题的入口在另一个页面——每日复习这条核心闭环就断在这里。
 *
 * 出题顺序按掌握度加权（越薄弱出得越多），与「自适应出题」用的是同一套引擎。
 */
export async function ensureQuestionsForPoints(params: {
  pointIds: ID[];
  targetCount?: number;
  /** 状态提示（例如"正在为你补 8 道题…"） */
  onStatus?: (text: string) => void;
  /** 模型流式输出 */
  onProgress?: (delta: string) => void;
  /** 非致命提示（例如有题目格式不完整被跳过） */
  onWarning?: (text: string) => void;
}): Promise<Question[]> {
  const { pointIds, targetCount = 10, onStatus, onProgress, onWarning } = params;
  if (!pointIds.length) throw new Error('没有指定知识点。');

  const existing = await listQuestionsByPoints(pointIds);
  if (existing.length >= targetCount) return sample(existing, targetCount);

  const points = (await db.knowledgePoints.bulkGet(pointIds)).filter(
    (p): p is KnowledgePoint => Boolean(p),
  );
  if (!points.length) throw new Error('这些知识点已经不存在了，请返回上级页面刷新后再试。');

  const outlineId = points[0].outlineId;
  const outline = await db.outlines.get(outlineId);
  const track: TrackId = outline?.track ?? 'fundamental';

  // 按掌握度把缺的题量分到这些知识点上
  const needed = Math.max(targetCount - existing.length, 3);
  const records = await db.mastery.bulkGet(pointIds);
  const inputs: MasteryInput[] = pointIds.map((id, i) => ({
    knowledgePointId: id,
    name: points.find((p) => p.id === id)?.name ?? id,
    record: records[i],
  }));
  const weights = questionWeights(inputs, Date.now());
  const allocation = Object.entries(allocateQuestions(weights, needed))
    .filter(([, count]) => count > 0)
    .map(([pointId, count]) => ({ pointId, count }));
  if (!allocation.length) throw new Error('这些知识点暂时无法出题。');

  const typeMix: { type: QuestionType; count: number }[] = [
    { type: 'single', count: Math.max(1, Math.round(needed * 0.4)) },
    { type: 'judge', count: Math.max(1, Math.round(needed * 0.25)) },
    { type: 'multiple', count: Math.max(1, Math.round(needed * 0.2)) },
    { type: 'blank', count: Math.max(1, Math.round(needed * 0.15)) },
  ];

  onStatus?.(
    existing.length
      ? `这些知识点下只有 ${existing.length} 道题，正在再补 ${needed} 道…`
      : `这些知识点下还没有题，正在为你出 ${needed} 道…`,
  );
  const generated = await generateQuestions({
    outlineId,
    track,
    allocation,
    typeMix,
    difficultyMix: '标准：以 2~3 星为主，穿插一道稍难的',
    withMaterial: true,
    onProgress,
    onWarning,
  });
  onStatus?.('');

  return sample([...existing, ...generated], targetCount);
}

/* ------------------------------ 掌握度与错题本 ------------------------------ */

/**
 * 把一次测验的结果写入自进化引擎。
 * 返回本次涉及的知识点掌握度变化，便于界面展示"进步了多少"。
 */
export async function recordAttempt(attempt: Attempt, questions: Question[]): Promise<void> {
  const answerById = new Map(attempt.answers.map((a) => [a.questionId, a]));
  const now = Date.now();

  // 1) 按知识点聚合本次作答（同一知识点可能有多道题）
  const perPoint = new Map<ID, { ratios: number[] }>();
  for (const q of questions) {
    const a = answerById.get(q.id);
    if (!a || typeof a.scoreRatio !== 'number') continue;
    for (const pid of q.knowledgePointIds) {
      const cur = perPoint.get(pid) ?? { ratios: [] };
      cur.ratios.push(a.scoreRatio);
      perPoint.set(pid, cur);
    }
  }

  await db.transaction('rw', db.mastery, db.mistakes, async () => {
    // 2) 更新掌握度
    for (const [pid, { ratios }] of perPoint) {
      const avg = ratios.reduce((s, r) => s + r, 0) / ratios.length;
      const existing = (await db.mastery.get(pid)) ?? createMastery(pid, now);
      const grade: Grade = { knowledgePointIds: [pid], scoreRatio: avg, at: now };
      const updated = applyGrade([existing], grade, now)[0];
      updated.attempts = existing.attempts + ratios.length;
      updated.correct = existing.correct + ratios.filter((r) => r >= 0.8).length;
      await db.mastery.put(updated);
    }

    // 3) 更新错题本
    for (const q of questions) {
      const a = answerById.get(q.id);
      if (!a || typeof a.scoreRatio !== 'number') continue;
      const existing = await db.mistakes.where('questionId').equals(q.id).first();
      if (a.scoreRatio < 0.8) {
        if (existing) {
          await db.mistakes.update(existing.id, {
            wrongCount: existing.wrongCount + 1,
            lastWrongAt: now,
            resolved: false,
            streak: 0,
          });
        } else {
          const note: MistakeNote = {
            id: newId(),
            questionId: q.id,
            wrongCount: 1,
            lastWrongAt: now,
            resolved: false,
            streak: 0,
          };
          await db.mistakes.put(note);
        }
      } else if (existing && !existing.resolved) {
        // 连续答对 2 次才算真正掌握
        const streak = existing.streak + 1;
        await db.mistakes.update(existing.id, { streak, resolved: streak >= 2 });
      }
    }
  });

  // 4) 够样本量就刷新画像
  const profile = await getProfile();
  const totalAnswered = profile.totalAnswered + attempt.answers.length;
  await saveProfile({ ...profile, totalAnswered });
  if (totalAnswered >= PROFILE_REFRESH_EVERY && totalAnswered % PROFILE_REFRESH_EVERY < attempt.answers.length) {
    try {
      await refreshLearnerProfile();
    } catch {
      // 画像刷新失败不影响主流程
    }
  }
}

/* ------------------------------ 复习排程 ------------------------------ */

export interface ReviewItem {
  point: KnowledgePoint;
  record: MasteryRecord;
  /** 当前（含遗忘衰减）掌握度 */
  score: number;
  /** 是否已经到期该复习 */
  due: boolean;
}

/** 取今日待复习列表；若没有到期的，则返回最薄弱的几个点作为"提前复习" */
export async function getTodayReview(limit = 10): Promise<ReviewItem[]> {
  const records = await db.mastery.toArray();
  const now = Date.now();
  const due = dueForReview(records, now, limit);

  const picked = due.length
    ? due
    : records
        .map((r) => ({ r, s: currentScore(r, now) }))
        .sort((a, b) => a.s - b.s)
        .slice(0, limit)
        .map((x) => x.r);

  const points = await db.knowledgePoints.bulkGet(picked.map((r) => r.knowledgePointId));
  const items: ReviewItem[] = [];
  picked.forEach((record, i) => {
    const point = points[i];
    if (!point) return;
    items.push({
      point,
      record,
      score: currentScore(record, now),
      due: record.dueAt <= now,
    });
  });
  return items;
}

/** 未来 N 天的复习负载 */
export async function getForecast(days = 14): Promise<Record<string, number>> {
  const records = await db.mastery.toArray();
  return forecastLoad(records, Date.now(), days);
}

/** 薄弱知识点排行（含没练过的点） */
export async function getWeakPoints(limit = 8, outlineId?: ID) {
  const points = outlineId
    ? (await db.knowledgePoints.where('outlineId').equals(outlineId).toArray()).sort((a, b) => a.order - b.order)
    : await db.knowledgePoints.toArray();
  if (!points.length) return [];
  const records = await db.mastery.bulkGet(points.map((p) => p.id));
  const inputs: MasteryInput[] = points.map((p, i) => ({
    knowledgePointId: p.id,
    name: p.name,
    record: records[i],
  }));
  const ranked = rankWeakPoints(inputs, Date.now(), limit);
  return ranked.map((w) => {
    const point = points.find((p) => p.id === w.knowledgePointId);
    return { ...w, name: point?.name ?? '未知知识点', point };
  });
}

/** 让「自适应出题」决定每个知识点该出几道 */
export async function planAdaptiveAllocation(params: {
  outlineId: ID;
  totalCount: number;
  minPerPoint?: number;
}): Promise<{ pointId: ID; name: string; count: number; mastery: number }[]> {
  const { outlineId, totalCount, minPerPoint = 0 } = params;
  const points = (await db.knowledgePoints.where('outlineId').equals(outlineId).toArray()).sort(
    (a, b) => a.order - b.order,
  );
  if (!points.length) return [];

  const records = await db.mastery.bulkGet(points.map((p) => p.id));
  const now = Date.now();
  const inputs: MasteryInput[] = points.map((p, i) => ({
    knowledgePointId: p.id,
    name: p.name,
    record: records[i],
  }));

  // 复用 srs 引擎的权重计算与题量分配
  const weights = questionWeights(inputs, now);
  let allocation = allocateQuestions(weights, totalCount);

  if (minPerPoint > 0) {
    // 保证每个被选中的点至少有 minPerPoint 道，多出来的从权重最高的点扣
    const fixed: Record<string, number> = {};
    let used = 0;
    for (const p of points) {
      const c = allocation[p.id] ?? 0;
      if (c > 0) {
        const give = Math.max(minPerPoint, c);
        fixed[p.id] = give;
        used += give;
      }
    }
    if (used > totalCount) {
      // 兜底：按权重从低到高砍
      const sorted = Object.keys(fixed).sort((a, b) => (weights[a] ?? 0) - (weights[b] ?? 0));
      for (const id of sorted) {
        while (used > totalCount && fixed[id] > 1) {
          fixed[id] -= 1;
          used -= 1;
        }
        if (used <= totalCount) break;
      }
    }
    allocation = fixed;
  }

  return points
    .map((p) => ({
      pointId: p.id,
      name: p.name,
      count: allocation[p.id] ?? 0,
      mastery: currentScore(records[points.indexOf(p)] ?? createMastery(p.id, now), now),
    }))
    .filter((x) => x.count > 0)
    .sort((a, b) => a.mastery - b.mastery);
}

/* ------------------------------ 学习者画像迭代 ------------------------------ */

/** 基于最近的答题记录，让 AI 更新学习画像 */
export async function refreshLearnerProfile(): Promise<LearnerProfile> {
  const config = await getDefaultLLM('text');
  const previous = await getProfile();
  if (!config) return previous;

  // 取最近 40 条作答记录
  const attempts = await db.attempts.orderBy('startedAt').reverse().limit(8).toArray();
  const allAnswers = attempts.flatMap((a) => a.answers);
  const questionIds = [...new Set(allAnswers.map((a) => a.questionId))];
  const questions = await db.questions.bulkGet(questionIds);
  const pointIds = [...new Set(questions.flatMap((q) => q?.knowledgePointIds ?? []))];
  const points = await db.knowledgePoints.bulkGet(pointIds);
  const pointName = new Map(points.filter(Boolean).map((p) => [p!.id, p!.name]));

  const recentRecords = questions
    .filter((q): q is Question => Boolean(q))
    .slice(0, 40)
    .map((q) => {
      const a = allAnswers.find((x) => x.questionId === q.id);
      return {
        knowledgePointName: q.knowledgePointIds.map((id) => pointName.get(id) ?? '未分类').join('、'),
        questionType: q.type,
        isCorrect: a?.isCorrect ?? false,
        stem: q.stem,
        gap: a?.aiComment,
      };
    });

  if (recentRecords.length < 8) return previous;

  const messages = buildProfileMessages({ previous, recentRecords });
  const res = await chat(config, messages, { jsonMode: true, temperature: 0.4 });
  const draft = parseJsonLoose<ProfileDraft>(res.content, '学习画像');

  const updated: LearnerProfile = {
    ...previous,
    level: draft.level || previous.level,
    weakAreas: Array.isArray(draft.weakAreas) ? draft.weakAreas.map(String).slice(0, 8) : previous.weakAreas,
    errorPatterns: Array.isArray(draft.errorPatterns)
      ? draft.errorPatterns.map(String).slice(0, 6)
      : previous.errorPatterns,
    preferredStyle: draft.preferredStyle || previous.preferredStyle,
    digest: draft.digest || previous.digest,
    updatedAt: Date.now(),
  };
  await saveProfile(updated);
  return updated;
}

/* ------------------------------ 补强微讲义 ------------------------------ */

/** 针对一个薄弱知识点生成微讲义 + 3 道巩固题，并把巩固题存入题库 */
export async function generateMicroLesson(params: {
  pointId: ID;
  track: TrackId;
  onProgress?: (delta: string) => void;
}): Promise<MicroLessonDraft> {
  const { pointId, track, onProgress } = params;
  const config = await getDefaultLLM('text');
  if (!config) throw new Error('还没有配置文本大模型，无法生成微讲义。');

  const point = await db.knowledgePoints.get(pointId);
  if (!point) throw new Error('知识点不存在。');

  // 找他在这个点上错过的题作为例子
  const questions = await db.questions.where('knowledgePointIds').equals(pointId).toArray();
  const attempts = await db.attempts.toArray();
  const wrongExamples: { stem: string; userAnswer: string; correctAnswer: string }[] = [];
  for (const q of questions) {
    for (const at of attempts) {
      const a = at.answers.find((x) => x.questionId === q.id);
      if (a && a.scoreRatio !== undefined && a.scoreRatio < 0.8 && wrongExamples.length < 3) {
        wrongExamples.push({
          stem: q.stem,
          userAnswer: Array.isArray(a.userAnswer) ? a.userAnswer.join(' / ') : String(a.userAnswer),
          correctAnswer: Array.isArray(q.answer) ? q.answer.join(' / ') : String(q.answer),
        });
      }
    }
    if (wrongExamples.length >= 3) break;
  }

  const profile = await getProfile();
  const messages = buildMicroLessonMessages({ knowledgePoint: point, track, wrongExamples, profile });
  // **不走流式**：实测同一模型非流式正常、流式会返回空内容（见 llm/client.ts 的说明）
  onProgress?.('正在生成补强讲义（一次性请求）…');
  const res = await chat(config, messages, {
    jsonMode: true,
    temperature: 0.6,
    maxTokens: 4096,
  });

  const draft = parseJsonLoose<MicroLessonDraft>(res.content, '补强讲义');
  if (!draft.body) throw new Error('模型没有返回讲义内容，请稍后再试。');

  // 把巩固题存进题库，下次可以直接练
  let drills: MicroLessonDraft['drills'] = [];
  try {
    drills = parseArrayLoose<MicroLessonDraft['drills'][number]>(
      JSON.stringify(draft.drills ?? []),
      '巩固题',
    );
  } catch {
    drills = [];
  }
  if (drills.length) {
    const rows: Question[] = drills.slice(0, 5).map((d) => ({
      id: newId(),
      knowledgePointIds: [pointId],
      type: d.type ?? 'single',
      stem: String(d.stem ?? '').trim(),
      options: d.options,
      answer: d.answer ?? '',
      explanation: String(d.explanation ?? ''),
      difficulty: Math.min(5, Math.max(1, Math.round(Number(d.difficulty) || 2))),
      source: 'ai' as const,
      createdAt: Date.now(),
      rubric: d.rubric,
    }));
    await db.questions.bulkPut(rows.filter((r) => r.stem));
  }

  // 记一笔讲义，方便回看
  await db.materials.put({
    id: newId(),
    title: `补强讲义：${draft.title || point.name}`,
    sourceType: 'text',
    content: draft.body,
    charCount: draft.body.length,
    createdAt: Date.now(),
    track,
    warnings: ['这是针对你的薄弱点自动生成的微讲义'],
  });

  return draft;
}

/** 列出已生成的微讲义 */
export async function listMicroLessons(): Promise<MicroLessonRow[]> {
  const mats = await db.materials.where('sourceType').equals('text').toArray();
  return mats
    .filter((m) => m.title.startsWith('补强讲义：'))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((m) => ({
      id: m.id,
      title: m.title.replace('补强讲义：', ''),
      body: m.content,
      createdAt: m.createdAt,
    }));
}
