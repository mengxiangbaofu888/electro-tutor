/**
 * 提示词库。
 *
 * 学习者画像（LearnerProfile.digest）会自动注入到每个 prompt 里，
 * 这是"自进化"能生效的关键：模型每次都知道你是谁、你卡在哪。
 */
import type { KnowledgePoint, LearnerProfile, Question, QuestionType, TrackId } from '../db/types';
import { QUESTION_TYPE_LABELS, TRACK_HINTS, TRACK_LABELS } from '../db/types';
import type { ChatMessage } from './client';

/** 所有场景共用的教师人设 */
export const SYSTEM_TUTOR =
  '你是一位有 30 年经验的中国电工与 PLC 实训教师，同时非常懂成人零基础教学。' +
  '你的教学对象是一名电工零基础、电控薄弱的成年学习者，他的目标是：① 补电工基础以便学 PLC；② 考取低压电工特种作业操作证；③ 考取电工中级职业技能等级证。' +
  '铁律：\n' +
  '1. 技术必须准确，严格遵循中国国家标准（GB）与电力行业习惯表述；不确定的地方宁可说"需要查证"，绝不编造参数或标准号。\n' +
  '2. 从零讲起，不跳步。先讲"为什么"，再讲"怎么做"。\n' +
  '3. 术语第一次出现时给出口诀式解释或生活类比。\n' +
  '4. 只输出被要求的内容，不要寒暄、不要客套。';

/** 把学习者画像渲染成可注入的文本 */
export function renderProfile(profile?: LearnerProfile): string {
  if (!profile) return '';
  const lines: string[] = [];
  if (profile.level) lines.push(`自评水平：${profile.level}`);
  if (profile.preferredStyle) lines.push(`偏好的讲解方式：${profile.preferredStyle}`);
  if (profile.weakAreas.length) lines.push(`已识别薄弱点：${profile.weakAreas.join('；')}`);
  if (profile.errorPatterns.length) lines.push(`反复出现的错误模式：${profile.errorPatterns.join('；')}`);
  if (profile.digest) lines.push(`历史学习画像总结：\n${profile.digest}`);
  if (!lines.length) return '';
  return `\n\n【这个学生的画像，请据此调整讲解深度和出题重点】\n${lines.join('\n')}`;
}

/* ============================== 大纲生成 ============================== */

export interface OutlineNodeDraft {
  name: string;
  summary: string;
  importance: number;
  children?: OutlineNodeDraft[];
}

const OUTLINE_SCHEMA = `{
  "title": "大纲标题（12 字以内）",
  "nodes": [
    {
      "name": "知识点名称（12 字以内，专业术语）",
      "summary": "一句话说明这是啥、为什么要学、学完能干什么（40 字以内）",
      "importance": 1到5的整数,
      "children": [ 同结构，可为空数组，最多再嵌套 1 层 ]
    }
  ]
}`;

export function buildOutlineMessages(params: {
  track: TrackId;
  materialText: string;
  profile?: LearnerProfile;
  extraInstruction?: string;
}): ChatMessage[] {
  const { track, materialText, profile, extraInstruction } = params;
  const user = `请把下面这份学习材料，整理成一份**可直接用来出题的知识大纲**。

【学习线】${TRACK_LABELS[track]}
【这条线通常覆盖的内容】${TRACK_HINTS[track]}

【要求】
1. 先通读材料，再提炼。节点必须来自材料实际讲的内容，不要凭空补充材料里没有的章节。
2. 结构最多 3 层（顶层 → 子项 → 更细项），总计 8~25 个知识点。
3. 每个节点的 name 必须是能直接作为出题锚点的**具体知识点**，例如「接触器自锁回路的原理」，不要写「第一章」这种空壳标题。
4. importance：考证必考/PLC 必用的给 4~5，了解即可的给 1~2。
5. 如果材料内容明显不足以支撑某个子项，就不要硬造。${extraInstruction ? `\n6. 额外要求：${extraInstruction}` : ''}${renderProfile(profile)}

【严格输出格式】只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码围栏：
${OUTLINE_SCHEMA}

【学习材料】
${materialText}`;

  return [
    { role: 'system', content: SYSTEM_TUTOR },
    { role: 'user', content: user },
  ];
}

/* ============================== 出题 ============================== */

export interface QuestionDraft {
  knowledgePointNames: string[];
  type: QuestionType;
  stem: string;
  options?: { key: string; text: string }[];
  answer: string | string[];
  explanation: string;
  difficulty: number;
  rubric?: string[];
}

const QUESTION_SCHEMA = `{
  "questions": [
    {
      "knowledgePointNames": ["必须严格使用给定知识点清单里的名称"],
      "type": "single | multiple | judge | blank | short | calc",
      "stem": "题干",
      "options": [{ "key": "A", "text": "选项内容" }],
      "answer": "单选/判断填字符串如 \\"A\\" 或 \\"正确\\"；多选/填空填字符串数组；简答/计算填参考答案要点",
      "explanation": "解析：为什么是这个答案，错在哪里的坑是什么",
      "difficulty": 1到5的整数,
      "rubric": ["评分点1：xx（3分）", "评分点2：xx（2分）"]
    }
  ]
}`;

export function buildQuestionMessages(params: {
  track: TrackId;
  knowledgePoints: { name: string; summary?: string; targetCount: number }[];
  typeMix: { type: QuestionType; count: number }[];
  difficultyMix: string;
  materialExcerpt?: string;
  profile?: LearnerProfile;
}): ChatMessage[] {
  const { track, knowledgePoints, typeMix, difficultyMix, materialExcerpt, profile } = params;

  const kpList = knowledgePoints
    .map((k) => `- ${k.name}${k.summary ? `（${k.summary}）` : ''} —— 需要出 ${k.targetCount} 道`)
    .join('\n');
  const typeList = typeMix.map((t) => `${QUESTION_TYPE_LABELS[t.type]} ${t.count} 道`).join('、');

  const user = `请为一名电工零基础的学习者出题。

【学习线】${TRACK_LABELS[track]}
【题型与数量】${typeList}
【难度要求】${difficultyMix}
【知识点分配】必须按下面每个知识点的指定数量出题：
${kpList}

【出题铁律】
1. 技术必须正确。数值类题目要先自己算一遍，答案和解析里的数字必须一致。
2. 每道题必须能明确判对错。单选题只能有一个正确选项；判断题的答案只能填"正确"或"错误"。
3. 四个选项要有迷惑性，错误选项要对应**初学者真实会犯的错**（例如把自锁和互锁搞混、把线电压和相电压搞混），不要凑数。
4. 解析要讲清楚"为什么"，并点出这道题考的是哪个知识点、容易错在哪。150 字以内。
5. 计算题必须给完整解题步骤，并在 rubric 里列出分步评分点（每步多少分），总分合计 10 分。
6. 简答题同样要给 rubric 评分点。
7. 填空题用 ____ 表示空格；多个空时答案数组按顺序给出。
8. 不要出需要看图片才能做的题（纯文字描述清楚，例如"如图所示的星三角启动电路"要改成文字描述）。
9. knowledgePointNames 只能填上面清单里出现过的名称，不要自创。${renderProfile(profile)}

【严格输出格式】只输出一个 JSON 对象，不要解释文字、不要代码围栏：
${QUESTION_SCHEMA}
${materialExcerpt ? `\n【可以参考的材料原文片段】\n${materialExcerpt}` : ''}`;

  return [
    { role: 'system', content: SYSTEM_TUTOR },
    { role: 'user', content: user },
  ];
}

/* ============================== 阅卷 / 批改 ============================== */

export interface GradeDraft {
  scoreRatio: number;
  isCorrect: boolean;
  comment: string;
  breakdown: { point: string; got: number; full: number; comment: string }[];
  knowledgeGaps: string[];
}

const GRADE_SCHEMA = `{
  "scoreRatio": 0 到 1 之间的小数（得分率）,
  "isCorrect": true 或 false（≥0.8 视为通过）,
  "comment": "给学生的中文评语，先肯定对的部分，再指出问题，语气像老师在旁边讲解，120 字以内",
  "breakdown": [{ "point": "评分点描述", "got": 实际得分数字, "full": 该点满分数字, "comment": "这一点为什么给这个分" }],
  "knowledgeGaps": ["从这次作答暴露出的具体知识缺口，例如「不清楚线电压与相电压的关系」"]
}`;

export function buildGradeMessages(params: {
  question: Pick<Question, 'type' | 'stem' | 'options' | 'answer' | 'explanation' | 'rubric'>;
  userAnswer: string | string[];
  profile?: LearnerProfile;
}): ChatMessage[] {
  const { question, userAnswer, profile } = params;
  const answerText = Array.isArray(question.answer) ? question.answer.join(' / ') : question.answer;
  const userText = Array.isArray(userAnswer) ? userAnswer.join(' / ') : userAnswer;
  const rubricText = question.rubric?.length ? `\n【评分点】\n${question.rubric.map((r) => `- ${r}`).join('\n')}` : '';

  const user = `请批改下面这道题。

【题型】${QUESTION_TYPE_LABELS[question.type]}
【题目】${question.stem}${question.options ? `\n【选项】\n${question.options.map((o) => `${o.key}. ${o.text}`).join('\n')}` : ''}
【标准答案】${answerText}
【参考解析】${question.explanation}${rubricText}
【学生的作答】${userText || '（学生没有作答）'}

【批改要求】
1. 逐条对照评分点给分，最后换算成 0~1 的得分率。
2. 特别注意区分这三种情况，并在 comment 里说明：
   - 思路对、算错数 → 只扣计算分，不要判全错；
   - 思路错但碰巧答案对 → 要指出，不能给满分；
   - 概念混淆 → 要在 knowledgeGaps 里明确写出混淆了什么。
3. 学生的写法可能不标准，只要意思对就算对（例如"自锁"写成"自己锁住自己"）。
4. comment 必须具体，不要写"继续努力"这种空话。${renderProfile(profile)}

【严格输出格式】只输出一个 JSON 对象：
${GRADE_SCHEMA}`;

  return [
    { role: 'system', content: SYSTEM_TUTOR },
    { role: 'user', content: user },
  ];
}

/* ============================== 学习报告 ============================== */

export interface ReportDraft {
  summary: string;
  mistakes: { questionId: string; what: string; why: string; fix: string }[];
  suggestions: string[];
}

const REPORT_SCHEMA = `{
  "summary": "整体评价，指出这次考得怎么样、反映出什么状态，150 字以内",
  "mistakes": [{ "questionId": "原样返回我给的 id", "what": "错在哪（具体到步骤或概念）", "why": "为什么会错（根因，不是表面现象）", "fix": "怎么补：下一步该做什么" }],
  "suggestions": ["下一步学习建议，按优先级排序，3~5 条，每条一句话且可执行"]
}`;

export function buildReportMessages(params: {
  track: TrackId;
  score: number;
  items: {
    id: string;
    stem: string;
    type: QuestionType;
    isCorrect: boolean;
    userAnswer: string;
    correctAnswer: string;
    comment?: string;
  }[];
  profile?: LearnerProfile;
}): ChatMessage[] {
  const { track, score, items, profile } = params;
  const wrong = items.filter((i) => !i.isCorrect);
  const list = items
    .map(
      (i) =>
        `- id=${i.id}｜${QUESTION_TYPE_LABELS[i.type]}｜${i.isCorrect ? '✔答对' : '✘答错'}\n` +
        `  题干：${i.stem.slice(0, 160)}\n` +
        `  学生答：${i.userAnswer || '（空）'}\n` +
        `  正确答案：${i.correctAnswer}\n` +
        (i.comment ? `  单题评语：${i.comment}\n` : ''),
    )
    .join('\n');

  const user = `请为这次测验写一份学习报告。

【学习线】${TRACK_LABELS[track]}
【总分】${score} 分（百分制）
【错题数】${wrong.length} / ${items.length}

【逐题情况】
${list}

【要求】
1. mistakes 只列**答错的题**，根因要挖到知识和思维层面。例如不要写"计算错误"，要写"没有先判断电路是串联还是并联就直接套了欧姆定律"。
2. fix 要具体可执行，例如"把星三角启动的六个端子接线画三遍，直到不用看图也能画出来"。
3. suggestions 按优先级排序，聚焦最该补的 1~2 个点，不要泛泛而谈。
4. 语气像一位负责的实训老师，实事求是不吹捧。${renderProfile(profile)}

【严格输出格式】只输出一个 JSON 对象：
${REPORT_SCHEMA}`;

  return [
    { role: 'system', content: SYSTEM_TUTOR },
    { role: 'user', content: user },
  ];
}

/* ============================== 学习者画像迭代 ============================== */

export interface ProfileDraft {
  level: string;
  weakAreas: string[];
  errorPatterns: string[];
  preferredStyle: string;
  digest: string;
}

const PROFILE_SCHEMA = `{
  "level": "对当前水平的判断，一句话",
  "weakAreas": ["薄弱知识点名称列表，按严重程度排序，最多 8 条"],
  "errorPatterns": ["反复出现的错误模式，最多 6 条，例如「看到三相就默认线电压等于相电压」"],
  "preferredStyle": "什么样的讲解方式对他有效，一句话",
  "digest": "给未来的自己看的一段画像摘要，300 字以内，写成第二人称（例如：你在接触器互锁上已经稳了，但…），这份摘要每次出题都会用到"
}`;

export function buildProfileMessages(params: {
  previous?: LearnerProfile;
  recentRecords: {
    knowledgePointName: string;
    questionType: QuestionType;
    isCorrect: boolean;
    stem: string;
    gap?: string;
  }[];
}): ChatMessage[] {
  const { previous, recentRecords } = params;
  const prevText = previous?.digest ? `【上一次的画像摘要】\n${previous.digest}\n` : '【上一次的画像摘要】\n（还没有）\n';
  const list = recentRecords
    .map(
      (r) =>
        `- ${r.isCorrect ? '✔' : '✘'}【${r.knowledgePointName}｜${QUESTION_TYPE_LABELS[r.questionType]}】${r.stem.slice(0, 100)}` +
        (r.gap ? `\n    暴露的缺口：${r.gap}` : ''),
    )
    .join('\n');

  const user = `请更新这名电工学习者的学习画像。

${prevText}
【最近一批答题记录】
${list}

【要求】
1. 在旧画像基础上**增量修正**，不要推翻重来。已经掌握的弱点要从 weakAreas 里移除。
2. errorPatterns 要写"思维层面的惯性错误"，不要写具体的某道题。
3. digest 要写成对学习者本人说话的口气，让未来的模型读了就知道该怎么教他。
4. 样本少就不要过度推断，宁可保守。

【严格输出格式】只输出一个 JSON 对象：
${PROFILE_SCHEMA}`;

  return [
    { role: 'system', content: SYSTEM_TUTOR },
    { role: 'user', content: user },
  ];
}

/* ============================== 薄弱点补强微讲义 ============================== */

export interface MicroLessonDraft {
  title: string;
  /** 正文，Markdown */
  body: string;
  /** 3 道即时巩固题 */
  drills: QuestionDraft[];
}

export function buildMicroLessonMessages(params: {
  knowledgePoint: KnowledgePoint;
  track: TrackId;
  wrongExamples: { stem: string; userAnswer: string; correctAnswer: string }[];
  profile?: LearnerProfile;
}): ChatMessage[] {
  const { knowledgePoint, track, wrongExamples, profile } = params;
  const examples = wrongExamples.length
    ? `\n【他最近在这个点上错的题】\n${wrongExamples
        .map(
          (e, i) =>
            `${i + 1}. ${e.stem.slice(0, 140)}\n   他答：${e.userAnswer || '（空）'}\n   正确：${e.correctAnswer}`,
        )
        .join('\n')}`
    : '';

  const user = `这名学生卡在了知识点【${knowledgePoint.name}】上。请给他写一份"3 分钟补强微讲义"。

【学习线】${TRACK_LABELS[track]}
【知识点说明】${knowledgePoint.summary ?? '（无）'}${examples}${renderProfile(profile)}

【讲义要求】
1. 用 Markdown，结构固定为：
   ## 一句话说清
   ## 为什么是这样（讲原理，配生活类比）
   ## 怎么记 / 怎么算（给口诀或步骤清单）
   ## 最容易错的地方（针对上面他错的题）
2. 全程不超过 600 字，要能 3 分钟读完。
3. 直接从他的错题出发讲，不要从教科书第一章讲起。

【严格输出格式】只输出一个 JSON 对象：
{
  "title": "讲义标题",
  "body": "Markdown 正文",
  "drills": [ 3 道题，结构完全同下 ]
}
其中 drills 里每道题的结构：
${QUESTION_SCHEMA.slice(QUESTION_SCHEMA.indexOf('[') + 1, QUESTION_SCHEMA.lastIndexOf(']'))}`;

  return [
    { role: 'system', content: SYSTEM_TUTOR },
    { role: 'user', content: user },
  ];
}
