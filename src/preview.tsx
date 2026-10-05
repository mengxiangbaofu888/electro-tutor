/**
 * UI 预览入口（**仅用于本地/CI 的可视化检查，不参与正式构建**）。
 *
 * 为什么需要它：正式构建（index.html → main.tsx）跑在浏览器里需要 IndexedDB，
 * 而用 file:// 打开时浏览器不允许使用本地数据库，页面会停在"加载中"。
 * 这个入口先注入内存版 IndexedDB（fake-indexeddb）并塞一批示例数据，
 * 于是整份产物可以在 file:// 下直接渲染出来——
 * 不需要服务器、不经过网络代理，可以稳定地截图检查界面。
 *
 * 用法：
 *   node scripts/build-preview.mjs          # 产出 dist-preview/preview-*.html
 * 然后用浏览器（或无头浏览器）打开对应文件即可。
 *
 * ⚠️ 这里的示例数据只存在于内存里，且只在这个预览产物中；正式 App 完全不受影响。
 */
import 'fake-indexeddb/auto';
import { db, newId, saveProfile } from './lib/db/db';
import type { Attempt, Paper, Question, StudyReport } from './lib/db/types';
import { installSeedOutline } from './lib/seed';
import { computeScore } from './lib/services/grade';
import { createMastery, currentScore, updateMastery } from './lib/srs';

/** 造一批贴近真实使用的数据，让各个页面都有内容可看 */
async function seedPreviewData() {
  const { outline, points } = await installSeedOutline('plc');
  const leaves = points.filter((p) => !points.some((c) => c.parentId === p.id));

  // 模型配置（假 Key，只为了不让界面一直显示"还没配置"的警告）
  await db.llmConfigs.put({
    id: newId(),
    name: 'DeepSeek（预览用假 Key）',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-preview-not-a-real-key',
    model: 'deepseek-chat',
    kind: 'text',
    temperature: 0.6,
    isDefaultText: true,
    createdAt: Date.now(),
  });

  // 题目：每个叶子知识点挂一道
  const stems = [
    ['单选题', '按下启动按钮后接触器 KM 得电，松开按钮仍保持通电，靠的是？', ['KM 的常开辅助触点', 'KM 的常闭触点'], 'A'],
    ['判断题', '星三角降压启动是在启动瞬间把定子绕组接成三角形。', [], '错误'],
    ['单选题', 'PLC 的一个扫描周期内，程序里读到的输入状态会怎样变化？', ['跟随现场实时变化', '整个周期保持不变'], 'B'],
    ['判断题', '正反转控制线路中，电气互锁可以完全取代程序互锁。', [], '错误'],
    ['单选题', '星三角切换时如果不加切换间隔，最可能发生什么？', ['短路跳闸', '电机反转'], 'A'],
    ['填空题', '热继电器主要用来实现电动机的 ____ 保护。', [], '过载'],
    ['单选题', '晶体管输出型 PLC 相比继电器输出型，最大优势是？', ['动作频率高、寿命长', '可以带更大的电流'], 'A'],
    ['判断题', '装设接地线必须先接导体端，后接接地端。', [], '错误'],
  ] as const;

  const questions: Question[] = stems.map(([type, stem, options, answer], i) => ({
    id: newId(),
    outlineId: outline.id,
    knowledgePointIds: leaves[i % leaves.length] ? [leaves[i % leaves.length].id] : [],
    type:
      type === '单选题' ? 'single' : type === '判断题' ? 'judge' : 'blank',
    stem,
    options: options.length ? options.map((text, k) => ({ key: String.fromCharCode(65 + k), text })) : undefined,
    answer,
    explanation: '解析占位：正式使用时这里会是 AI 生成的完整解析。',
    difficulty: 2 + (i % 3),
    source: 'ai',
    createdAt: Date.now() - i * 1000,
  }));
  await db.questions.bulkPut(questions);

  // 掌握度：故意造出高低差，让「薄弱点」和「今日复习」都有内容
  const now = Date.now();
  const day = 86_400_000;
  for (let i = 0; i < leaves.length; i += 1) {
    const point = leaves[i];
    let record = createMastery(point.id, now);
    // 前面的点练得好，后面的点练得差
    const ratio = i < 3 ? 1 : i < 6 ? 0.6 : 0.2;
    record = updateMastery(record, { knowledgePointIds: [point.id], scoreRatio: ratio, at: now - 6 * day }, now - 6 * day);
    record = updateMastery(record, { knowledgePointIds: [point.id], scoreRatio: ratio, at: now - 3 * day }, now - 3 * day);
    record.attempts = 2 + (i % 3);
    record.correct = ratio >= 0.8 ? record.attempts : Math.max(0, record.attempts - 2);
    await db.mastery.put(record);
  }

  // 一次已完成的测验 + 试卷 + 报告，让「最近测验」和报告页有东西看。
  // 用固定 id 是为了能用 #/report/preview-attempt 直接截到报告页。
  const answers = questions.map((q, i) => {
    const wrong = i % 3 === 0;
    return {
      questionId: q.id,
      userAnswer: q.answer,
      isCorrect: !wrong,
      scoreRatio: wrong ? 0 : 1,
    };
  });
  const score = computeScore(questions, answers);

  const paper: Paper = {
    id: 'preview-paper',
    title: 'PLC 控制线路 · 第 3 次练习',
    outlineId: outline.id,
    track: 'plc',
    questionIds: questions.map((q) => q.id),
    durationMin: 0,
    createdAt: now - day,
  };
  await db.papers.put(paper);

  const report: StudyReport = {
    score,
    summary:
      '整体思路基本清楚，接触器自锁和互锁的概念已经建立起来了。主要问题集中在星三角切换的时序上——知道要降压启动，但说不清切换间隔为什么必须留。',
    weakPoints: [
      { knowledgePointId: leaves[6].id, name: leaves[6].name, score: 0.28, severity: 0.82, reason: '掌握度仅 28%，基本没掌握' },
      { knowledgePointId: leaves[7].id, name: leaves[7].name, score: 0.41, severity: 0.66, reason: '掌握度仅 41%，且近 14 天未复习' },
    ],
    mistakes: [
      {
        questionId: questions[4].id,
        what: '把"必须留切换间隔"答成了"可以直接切换"',
        why: '只记住了"星三角是降压启动"，没有理解切换瞬间两套接触器同时吸合会造成相间短路',
        fix: '把星三角的六个端子接线画三遍，重点标出切换瞬间哪两个接触器绝对不能在同时吸合',
      },
      {
        questionId: questions[0].id,
        what: '把自锁回路说成了"靠按钮一直按着"',
        why: '没有把"并联的常开辅助触点"和"按钮"区分开，混淆了自锁与点动',
        fix: '拿一张纸画出点动和自锁两个回路，只改一处接线，对比着看差别在哪',
      },
    ],
    suggestions: [
      '先把星三角的切换时序搞清（这是本次最该补的点）',
      '再用 5 分钟复习接触器互锁的电气接线',
      '做 3 道关于热继电器整定的题巩固过载保护',
    ],
    generatedAt: now - day,
  };

  const attempt: Attempt = {
    id: 'preview-attempt',
    paperId: paper.id,
    paperTitle: paper.title,
    startedAt: now - day,
    finishedAt: now - day + 8 * 60 * 1000,
    score,
    report,
    answers,
  };
  await db.attempts.put(attempt);
  await db.mistakes.put({
    id: newId(),
    questionId: questions[4].id,
    wrongCount: 2,
    lastWrongAt: now - day,
    resolved: false,
    streak: 0,
  });

  // 学习者画像
  await saveProfile({
    id: 'me',
    level: '电工零基础，电控薄弱，目标是为 PLC 打基础并考取低压电工证',
    weakAreas: ['星三角降压启动的时序', '热继电器整定', '线电压与相电压'],
    errorPatterns: ['记住结论但说不清原理', '看到三相就默认线电压等于相电压'],
    preferredStyle: '先讲为什么，再给口诀，最后给反例',
    digest: '你在接触器自锁和互锁上已经稳了；星三角的切换时序和线电压/相电压还容易混，讲解时要多给接线图式描述。',
    totalAnswered: 26,
    updatedAt: Date.now(),
  });

  // 让「今日复习」有到期项
  const due = await db.mastery.toArray();
  await db.mastery.bulkPut(
    due.map((m, i) => (i % 2 === 0 ? { ...m, dueAt: Date.now() - day, score: 0.35 } : m)),
  );

  return { points: leaves.length, masteryAvg: due.length ? due.reduce((s, m) => s + currentScore(m, now), 0) / due.length : 0 };
}

const info = await seedPreviewData();
// eslint-disable-next-line no-console
console.log(`[preview] 已注入示例数据：${info.points} 个知识点、平均掌握度 ${(info.masteryAvg * 100).toFixed(0)}%`);

// 允许通过注入的全局变量指定初始路由（HashRouter 读的是 location.hash）
const route = (globalThis as { __PREVIEW_ROUTE__?: string }).__PREVIEW_ROUTE__;
if (route) location.hash = route;

// 数据就绪后再加载应用主体
await import('./main');
