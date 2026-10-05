/**
 * 业务层端到端集成测试。
 *
 * 这是最接近"用户真的用一遍"的自动化验证：在内存 IndexedDB 上跑完整闭环——
 * 导入材料 → 生成大纲 → 出题 → 组卷 → 答题 → 判分 → 交卷出报告 → 写入掌握度与错题
 * → 自适应出题 → 今日复习 → 补强微讲义。
 *
 * 大模型调用被替换成固定应答（只 mock `chat`，JSON 解析等保持真实），
 * 所以这个测试验证的是**我们自己的装配逻辑**：数据库索引、事务、字段映射、
 * 分数换算、知识点关联，而不是模型能力。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, newId } from '../db/db';
import type { LLMConfig, Question } from '../db/types';

/* ------------------------------ 替换大模型调用 ------------------------------ */

const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));

vi.mock('../llm/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, chat: chatMock };
});

// 必须在 mock 之后导入，确保业务模块拿到的是被替换的 chat
const { generateOutline, getOutlinePoints } = await import('./outline');
const { generateQuestions, createPaper, startAttempt, listQuestionsByPoints } = await import('./quiz');
const { gradeOne, finishAttempt } = await import('./grade');
const {
  recordAttempt,
  planAdaptiveAllocation,
  getTodayReview,
  getWeakPoints,
  generateMicroLesson,
} = await import('./practice');
const { installSeedOutline } = await import('../seed');

/* ------------------------------ 固定应答 ------------------------------ */

const OUTLINE_REPLY = {
  title: '电工基础与PLC入门',
  nodes: [
    {
      name: '欧姆定律',
      summary: '电流电压电阻的关系，一切电路计算的基础',
      importance: 5,
      children: [
        { name: '串联电路计算', summary: '串联分压，电流处处相等', importance: 4 },
        { name: '并联电路计算', summary: '并联分流，电压处处相等', importance: 4 },
      ],
    },
    {
      name: '接触器自锁回路',
      summary: '按下启动按钮松手后仍能保持通电的经典回路',
      importance: 5,
    },
  ],
};

const QUESTIONS_REPLY = {
  questions: [
    {
      knowledgePointNames: ['欧姆定律'],
      type: 'single',
      stem: '一段导体两端电压 12V，电阻 4Ω，通过的电流是多少？',
      options: [
        { key: 'A', text: '3A' },
        { key: 'B', text: '48A' },
        { key: 'C', text: '0.33A' },
        { key: 'D', text: '8A' },
      ],
      answer: 'A',
      explanation: '由欧姆定律 I = U / R = 12 / 4 = 3A。',
      difficulty: 2,
    },
    {
      knowledgePointNames: ['串联电路计算'],
      type: 'judge',
      stem: '串联电路中各处的电流都相等。',
      answer: '正确',
      explanation: '串联电路只有一条通路，电流处处相等。',
      difficulty: 1,
    },
    {
      knowledgePointNames: ['接触器自锁回路'],
      type: 'calc',
      stem: '某接触器线圈额定电压 220V、功率 5W，求线圈电流（保留两位小数）。',
      answer: 'I = P / U = 5 / 220 ≈ 0.02A',
      explanation: '先写出公式，再代入数值，最后给出结果。',
      difficulty: 3,
      rubric: ['写出公式 I = P/U（4 分）', '正确代入数值（3 分）', '结果 0.02A 且单位正确（3 分）'],
    },
  ],
};

const GRADE_REPLY = {
  scoreRatio: 0.7,
  isCorrect: false,
  comment: '公式写对了，代入数值也没错，但结果的有效数字处理不严谨。',
  breakdown: [
    { point: '写出公式 I = P/U', got: 4, full: 4, comment: '正确' },
    { point: '正确代入数值', got: 3, full: 3, comment: '正确' },
    { point: '结果与单位', got: 0, full: 3, comment: '结果精度不对' },
  ],
  knowledgeGaps: ['有效数字与单位换算不熟练'],
};

const REPORT_REPLY = {
  summary: '整体思路清楚，欧姆定律已经会用，主要问题是计算题的精度习惯。',
  mistakes: [
    {
      questionId: '', // 测试里会填上真实 id
      what: '计算题结果精度不对',
      why: '没有先确定保留几位有效数字就动笔',
      fix: '做计算题前先写下"结果保留两位小数"，再开始算',
    },
  ],
  suggestions: ['把欧姆定律的三个变形各练 3 遍', '计算题养成先写单位再算数值的习惯'],
};

const MICRO_LESSON_REPLY = {
  title: '有效数字与单位换算',
  body: '## 一句话说清\n结果要按题目要求的位数保留。\n## 为什么是这样\n测量本身有精度极限。\n## 怎么记\n先定位数，再动笔。\n## 最容易错的地方\n忘记写单位。',
  drills: [
    {
      knowledgePointNames: ['欧姆定律'],
      type: 'single',
      stem: '2A 电流通过 5Ω 电阻，电压是多少？',
      options: [
        { key: 'A', text: '10V' },
        { key: 'B', text: '2.5V' },
      ],
      answer: 'A',
      explanation: 'U = I·R = 2×5 = 10V。',
      difficulty: 1,
    },
  ],
};

/** 根据提示词内容决定返回哪一份应答 */
function replyFor(messages: { content: unknown }[]): unknown {
  const text = messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
  if (text.includes('知识大纲')) return OUTLINE_REPLY;
  if (text.includes('请为一名电工零基础的学习者出题')) return QUESTIONS_REPLY;
  if (text.includes('请批改下面这道题')) return GRADE_REPLY;
  if (text.includes('请为这次测验写一份学习报告')) return REPORT_REPLY;
  if (text.includes('补强微讲义')) return MICRO_LESSON_REPLY;
  throw new Error(`测试没有为这类提示词准备应答：${text.slice(0, 120)}`);
}

/* ------------------------------ 准备 ------------------------------ */

async function resetDb() {
  await db.transaction(
    'rw',
    [db.materials, db.outlines, db.knowledgePoints, db.questions, db.papers, db.attempts, db.mastery, db.mistakes, db.profiles, db.llmConfigs],
    async () => {
      // 逐个 await：Dexie 的事务区对并行 Promise 比较敏感，串行更稳
      await db.materials.clear();
      await db.outlines.clear();
      await db.knowledgePoints.clear();
      await db.questions.clear();
      await db.papers.clear();
      await db.attempts.clear();
      await db.mastery.clear();
      await db.mistakes.clear();
      await db.profiles.clear();
      await db.llmConfigs.clear();
    },
  );
}

async function seedModelConfig(): Promise<LLMConfig> {
  const config: LLMConfig = {
    id: newId(),
    name: '测试用模型',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'test-key',
    model: 'test-model',
    kind: 'text',
    temperature: 0.3,
    isDefaultText: true,
    createdAt: Date.now(),
  };
  await db.llmConfigs.put(config);
  return config;
}

const MATERIAL_TEXT = `
电工基础讲义（节选）
一、欧姆定律
导体中的电流与两端电压成正比，与电阻成反比，即 I = U / R。
串联电路：电流处处相等，总电阻等于各电阻之和，各电阻分压。
并联电路：电压处处相等，总电流等于各支路电流之和。
二、接触器自锁回路
按下启动按钮 SB2，接触器 KM 线圈得电，KM 的常开辅助触点闭合；
松开 SB2 后电流经该触点继续供电，这就是自锁。
停止按钮 SB1 串联在回路中，按下即断开。
`;

/**
 * 安装一个"忠实"的大模型替身：像真实 client 那样
 * 既回调 onDelta（流式），也返回 content。
 */
function installChatMock(pick?: (messages: unknown[]) => string) {
  chatMock.mockImplementation(
    async (_config: unknown, messages: unknown[], opts?: { onDelta?: (d: string) => void }) => {
      const text = pick ? pick(messages) : JSON.stringify(replyFor(messages as { content: unknown }[]));
      opts?.onDelta?.(text);
      return { content: text };
    },
  );
}

beforeEach(async () => {
  await resetDb();
  await seedModelConfig();
  chatMock.mockReset();
  installChatMock();
});

/* ------------------------------ 测试 ------------------------------ */

describe('完整学习闭环', () => {
  it('从材料一路走到补强微讲义，数据全部正确落库', async () => {
    /* --- 1. 导入材料 --- */
    const materialId = newId();
    await db.materials.put({
      id: materialId,
      title: '电工基础讲义',
      sourceType: 'text',
      content: MATERIAL_TEXT,
      charCount: MATERIAL_TEXT.length,
      track: 'plc',
      createdAt: Date.now(),
    });

    /* --- 2. 生成大纲 --- */
    const { outline, points } = await generateOutline({ materialIds: [materialId], track: 'plc' });
    expect(outline.id).toBeTruthy();
    expect(points).toHaveLength(4); // 2 个顶层 + 2 个子项
    expect(points[0].name).toBe('欧姆定律');
    expect(points[0].importance).toBe(5);
    // 层级关系正确：子项挂在"欧姆定律"下
    const child = points.find((p) => p.name === '串联电路计算');
    expect(child?.parentId).toBe(points[0].id);
    expect(child?.depth).toBe(2);
    // 落库了
    expect(await getOutlinePoints(outline.id)).toHaveLength(4);

    /* --- 3. 出题 --- */
    const questions = await generateQuestions({
      outlineId: outline.id,
      track: 'plc',
      allocation: [
        { pointId: points[0].id, count: 1 },
        { pointId: points[1].id, count: 1 },
        { pointId: points[3].id, count: 1 },
      ],
      typeMix: [
        { type: 'single', count: 1 },
        { type: 'judge', count: 1 },
        { type: 'calc', count: 1 },
      ],
      difficultyMix: '标准',
    });
    expect(questions).toHaveLength(3);
    // 模型返回的是知识点"名称"，必须被正确映射成 id
    const single = questions.find((q) => q.type === 'single')!;
    expect(single.knowledgePointIds).toEqual([points[0].id]);
    const judge = questions.find((q) => q.type === 'judge')!;
    expect(judge.knowledgePointIds).toEqual([points[1].id]);
    const calc = questions.find((q) => q.type === 'calc')!;
    expect(calc.knowledgePointIds).toEqual([points[3].id]);
    expect(calc.rubric).toHaveLength(3);
    // 多值索引查得到
    expect(await listQuestionsByPoints([points[0].id])).toHaveLength(1);

    /* --- 4. 组卷 + 开始答题 --- */
    const paper = await createPaper({
      title: '第一次测验',
      questionIds: questions.map((q) => q.id),
      durationMin: 20,
      outlineId: outline.id,
      track: 'plc',
    });
    const attempt = await startAttempt(paper);
    expect(attempt.answers).toHaveLength(0);
    expect(attempt.finishedAt).toBeUndefined();

    /* --- 5. 判分：客观题本地判、主观题走模型 --- */
    // 清零调用计数，让下面只统计"判分阶段"用了几次模型
    chatMock.mockClear();
    const singleRecord = await gradeOne(single, 'A'); // 答对
    expect(singleRecord.isCorrect).toBe(true);
    expect(singleRecord.scoreRatio).toBe(1);

    const judgeRecord = await gradeOne(judge, '错误'); // 答错
    expect(judgeRecord.isCorrect).toBe(false);
    expect(judgeRecord.scoreRatio).toBe(0);

    const calcRecord = await gradeOne(calc, '5/220=0.0227A'); // 主观题，模型给 0.7
    expect(calcRecord.scoreRatio).toBeCloseTo(0.7, 5);
    expect(calcRecord.aiComment).toContain('有效数字');
    expect(calcRecord.aiBreakdown).toHaveLength(3);

    // 只有主观题才应该调用模型
    expect(chatMock).toHaveBeenCalledTimes(1);

    /* --- 6. 交卷并生成报告 --- */
    const answerRecords = [singleRecord, judgeRecord, calcRecord];
    await db.attempts.update(attempt.id, { answers: answerRecords });

    // 把报告里占位的题目 id 换成真实 id
    REPORT_REPLY.mistakes[0].questionId = calc.id;

    const { attempt: finished, report } = await finishAttempt({ attemptId: attempt.id });
    expect(finished.finishedAt).toBeGreaterThan(0);
    // 单选 2 分（得 2）+ 判断 1 分（得 0）+ 计算 10 分（得 7）= 9/13 ≈ 69
    expect(finished.score).toBe(69);
    expect(report.score).toBe(69);
    expect(report.summary).toContain('欧姆定律');
    expect(report.suggestions.length).toBeGreaterThan(0);
    // 本地薄弱点统计一定会有（不依赖模型）
    expect(report.weakPoints.length).toBeGreaterThan(0);
    const weakNames = report.weakPoints.map((w) => w.name);
    expect(weakNames).toContain('串联电路计算'); // 判断题答错

    /* --- 7. 写入自进化引擎 --- */
    await recordAttempt(finished, questions);

    const mastery = await db.mastery.toArray();
    expect(mastery.length).toBeGreaterThan(0);
    const judgeMastery = mastery.find((m) => m.knowledgePointId === points[1].id)!;
    expect(judgeMastery.attempts).toBe(1);
    expect(judgeMastery.correct).toBe(0);
    expect(judgeMastery.score).toBeLessThan(0.5); // 答错，掌握度低
    const singleMastery = mastery.find((m) => m.knowledgePointId === points[0].id)!;
    expect(singleMastery.correct).toBe(1);
    expect(singleMastery.score).toBeCloseTo(1, 5); // 首次答对直接满分

    // 错题本只收了答错的两道
    const mistakes = await db.mistakes.toArray();
    expect(mistakes).toHaveLength(2);
    expect(mistakes.map((m) => m.questionId).sort()).toEqual([judge.id, calc.id].sort());

    /* --- 8. 自适应出题：薄弱点应该分到更多题 --- */
    const plan = await planAdaptiveAllocation({ outlineId: outline.id, totalCount: 10, minPerPoint: 1 });
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.reduce((s, p) => s + p.count, 0)).toBe(10);
    // 每个知识点都有题（minPerPoint=1）
    const everyPoint = await getOutlinePoints(outline.id);
    expect(plan).toHaveLength(everyPoint.length);

    /* --- 9. 今日复习：没到期的也要能给出建议 --- */
    const review = await getTodayReview(5);
    expect(review.length).toBeGreaterThan(0);
    expect(review[0].point.name).toBeTruthy();
    expect(review[0].score).toBeGreaterThanOrEqual(0);
    expect(review[0].score).toBeLessThanOrEqual(1);

    /* --- 10. 薄弱点排行 --- */
    const weak = await getWeakPoints(5, outline.id);
    expect(weak.length).toBeGreaterThan(0);
    expect(weak[0].name).toBeTruthy();
    expect(weak[0].reason.length).toBeGreaterThan(0);

    /* --- 11. 补强微讲义：生成并入库 --- */
    const target = weak[0].knowledgePointId;
    const lesson = await generateMicroLesson({ pointId: target, track: 'plc' });
    expect(lesson.title).toBeTruthy();
    expect(lesson.body).toContain('##');
    // 巩固题要进题库
    const drills = await db.questions.where('knowledgePointIds').equals(target).toArray();
    expect(drills.length).toBeGreaterThan(0);
    // 讲义本身留档在材料表里
    const mats = await db.materials.toArray();
    expect(mats.some((m) => m.title.startsWith('补强讲义：'))).toBe(true);
  });
});

describe('内置起步大纲', () => {
  it('不需要任何材料就能出题，且能模糊匹配到内置知识点', async () => {
    const { outline, points } = await installSeedOutline('fundamental');
    expect(outline.seed).toBe(true);
    expect(outline.materialIds).toEqual([]); // 内置大纲不依赖任何材料

    const questions = await generateQuestions({
      outlineId: outline.id,
      track: 'fundamental',
      allocation: [{ pointId: points[0].id, count: 1 }],
      typeMix: [{ type: 'single', count: 1 }],
      difficultyMix: '标准',
      withMaterial: true, // 即使要求"参考资料"，没有材料也不该报错
    });
    expect(questions.length).toBeGreaterThan(0);

    // 模型返回的知识点是"欧姆定律"，内置节点叫"欧姆定律及其应用"，
    // matchPointIds 的包含匹配应该能对上
    const single = questions.find((q) => q.type === 'single')!;
    expect(single.knowledgePointIds.length).toBeGreaterThan(0);
    const matched = points.find((p) => p.id === single.knowledgePointIds[0]);
    expect(matched?.name).toContain('欧姆定律');
  });
});

describe('边界与容错', () => {
  it('没有配置模型时给出明确中文错误，而不是崩掉', async () => {
    await db.llmConfigs.clear();
    await expect(generateOutline({ materialIds: ['x'], track: 'plc' })).rejects.toThrow(/模型/);
  });

  it('模型返回脏 JSON（带围栏和解释）也能解析', async () => {
    const materialId = newId();
    await db.materials.put({
      id: materialId,
      title: '材料',
      sourceType: 'text',
      content: MATERIAL_TEXT,
      charCount: MATERIAL_TEXT.length,
      createdAt: Date.now(),
    });
    installChatMock(() => '好的，这是大纲：\n```json\n' + JSON.stringify(OUTLINE_REPLY) + '\n```\n希望对你有帮助');
    const { points } = await generateOutline({ materialIds: [materialId], track: 'fundamental' });
    expect(points).toHaveLength(4);
  });

  it('即使 client 只返回 content 而不回调 onDelta，大纲也能生成', async () => {
    // 钉住一个曾经真实存在的脆弱点：generateOutline 一度只从 onDelta 累积结果，
    // 换一个不回调的实现就会解析到空字符串。现在必须两条路都能拿到内容。
    const materialId = newId();
    await db.materials.put({
      id: materialId,
      title: '材料',
      sourceType: 'text',
      content: MATERIAL_TEXT,
      charCount: MATERIAL_TEXT.length,
      createdAt: Date.now(),
    });
    chatMock.mockImplementation(async () => ({ content: JSON.stringify(OUTLINE_REPLY) }));
    const { points } = await generateOutline({ materialIds: [materialId], track: 'plc' });
    expect(points).toHaveLength(4);
  });

  it('模型虚构了不存在的知识点名称时，题目仍然入库（只是关联为空）', async () => {
    const materialId = newId();
    await db.materials.put({
      id: materialId,
      title: '材料',
      sourceType: 'text',
      content: MATERIAL_TEXT,
      charCount: MATERIAL_TEXT.length,
      createdAt: Date.now(),
    });
    const { outline, points } = await generateOutline({ materialIds: [materialId], track: 'plc' });
    installChatMock(() =>
      JSON.stringify({
        questions: [
          {
            knowledgePointNames: ['这个知识点根本不存在'],
            type: 'single',
            stem: '题干',
            options: [{ key: 'A', text: '甲' }],
            answer: 'A',
            explanation: '解析',
            difficulty: 2,
          },
        ],
      }),
    );
    const questions = await generateQuestions({
      outlineId: outline.id,
      track: 'plc',
      allocation: [{ pointId: points[0].id, count: 1 }],
      typeMix: [{ type: 'single', count: 1 }],
      difficultyMix: '标准',
    });
    expect(questions).toHaveLength(1);
    expect(questions[0].knowledgePointIds).toEqual([]);
  });

  it('交卷时算不出分不会崩，空答案记 0 分', async () => {
    const materialId = newId();
    await db.materials.put({
      id: materialId,
      title: '材料',
      sourceType: 'text',
      content: MATERIAL_TEXT,
      charCount: MATERIAL_TEXT.length,
      createdAt: Date.now(),
    });
    const { outline } = await generateOutline({ materialIds: [materialId], track: 'plc' });
    const questions = await generateQuestions({
      outlineId: outline.id,
      track: 'plc',
      allocation: [{ pointId: (await getOutlinePoints(outline.id))[0].id, count: 1 }],
      typeMix: [{ type: 'single', count: 1 }],
      difficultyMix: '标准',
    });
    const paper = await createPaper({ title: '空卷', questionIds: questions.map((q) => q.id), durationMin: 0 });
    const attempt = await startAttempt(paper);
    const blank: Question = questions[0];
    const record = await gradeOne(blank, []);
    expect(record.scoreRatio).toBe(0);
    await db.attempts.update(attempt.id, { answers: [record] });
    const { attempt: finished } = await finishAttempt({ attemptId: attempt.id });
    expect(finished.score).toBe(0);
  });
});
