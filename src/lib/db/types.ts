/**
 * 全局数据模型定义。
 *
 * 设计原则：
 * - 所有数据都存在本机 IndexedDB，不上传任何服务器。
 * - 知识点（KnowledgePoint）是整个系统的枢纽：题目、错题、掌握度、复习计划都挂在它上面。
 */

export type ID = string;

/** 学习线：四条线共用同一套知识点树结构，只是训练方式不同 */
export type TrackId = 'fundamental' | 'plc' | 'lowvoltage-cert' | 'midlevel-cert';

export const TRACK_LABELS: Record<TrackId, string> = {
  fundamental: '电工基础',
  plc: 'PLC',
  'lowvoltage-cert': '低压电工证',
  'midlevel-cert': '电工中级等级证',
};

export const TRACK_HINTS: Record<TrackId, string> = {
  fundamental: '为 PLC 打地基：直流电路 → 电磁 → 交流电 → 三相电路 → 电工仪表',
  plc: '硬件结构 → IO 接线 → 梯形图基本指令 → 定时器/计数器 → 顺序控制 → 典型控制电路',
  'lowvoltage-cert': '安全法规与用电常识 · 电工基础 · 仪表工具 · 导线连接 · 低压电器 · 电气控制线路 · 触电急救',
  'midlevel-cert': '电路分析 · 模拟数字电路 · 电机与拖动 · 电气控制 · PLC 基础 · 电气测量',
};

/** 题型 */
export type QuestionType = 'single' | 'multiple' | 'judge' | 'blank' | 'short' | 'calc';

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
  blank: '填空题',
  short: '简答题',
  calc: '计算题',
};

/** 客观题（可本地判分、无需调用大模型） */
export const OBJECTIVE_TYPES: QuestionType[] = ['single', 'multiple', 'judge', 'blank'];

export function isObjective(type: QuestionType): boolean {
  return OBJECTIVE_TYPES.includes(type);
}

/** 大模型配置（OAI 兼容接口） */
export interface LLMConfig {
  id: ID;
  /** 显示名，例如「DeepSeek 主力」 */
  name: string;
  /** 接口地址，到 /v1 为止，不含 /chat/completions */
  baseUrl: string;
  apiKey: string;
  /** 模型 ID，例如 deepseek-chat、glm-4-flash */
  model: string;
  /** 用途：文本推理 还是 视觉识图 */
  kind: 'text' | 'vision';
  temperature: number;
  /**
   * 可选的请求前缀代理。
   * 浏览器直连大模型接口可能被 CORS 拦截，此时可填一个转发前缀，
   * 例如 `https://your-worker.workers.dev/?url=`，最终请求会变成 前缀 + encodeURIComponent(真实地址)。
   */
  proxyPrefix?: string;
  /** 是否作为默认文本模型 */
  isDefaultText?: boolean;
  /** 是否作为默认视觉模型 */
  isDefaultVision?: boolean;
  createdAt: number;
}

/** 导入的原始学习材料 */
export interface Material {
  id: ID;
  title: string;
  /** 材料来源 */
  sourceType: 'text' | 'url' | 'file' | 'image' | 'subtitle';
  /** URL 或文件名 */
  sourceRef?: string;
  /** 提取出的正文（Markdown/纯文本） */
  content: string;
  charCount: number;
  track?: TrackId;
  createdAt: number;
  warnings?: string[];
}

/** 知识大纲 */
export interface Outline {
  id: ID;
  title: string;
  track: TrackId;
  materialIds: ID[];
  /** 是否是 App 内置的起步大纲（不是由 AI 生成的） */
  seed?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 知识点（树形） */
export interface KnowledgePoint {
  id: ID;
  outlineId: ID;
  parentId?: ID;
  name: string;
  /** 一句话说明「这是啥、为什么要学」 */
  summary?: string;
  /** 重要度 1..5 */
  importance: number;
  /** 同级排序 */
  order: number;
  /** 层级，根为 1 */
  depth: number;
}

/** 题目 */
export interface Question {
  id: ID;
  outlineId?: ID;
  knowledgePointIds: ID[];
  type: QuestionType;
  stem: string;
  /** 选择/判断题的选项 */
  options?: { key: string; text: string }[];
  /** 标准答案：单选/判断为字符串，多选/填空为字符串数组 */
  answer: string | string[];
  /** 解析 */
  explanation: string;
  /** 难度 1..5 */
  difficulty: number;
  source: 'ai' | 'imported';
  createdAt: number;
  /** 评分点（主观题 AI 批改用） */
  rubric?: string[];
}

/** 试卷 */
export interface Paper {
  id: ID;
  title: string;
  outlineId?: ID;
  track?: TrackId;
  questionIds: ID[];
  /** 时长（分钟），0 表示不限时 */
  durationMin: number;
  createdAt: number;
}

/** 单题作答结果 */
export interface AnswerRecord {
  questionId: ID;
  userAnswer: string | string[];
  /** 客观题判分结果 */
  isCorrect?: boolean;
  /** 归一化得分 0..1 */
  scoreRatio?: number;
  /** 主观题 AI 评语 */
  aiComment?: string;
  /** 主观题分步评分 */
  aiBreakdown?: { point: string; got: number; full: number; comment: string }[];
  /** 是否经过申诉重判 */
  regraded?: boolean;
  timeSpentMs?: number;
}

/** 薄弱点 */
export interface WeakPoint {
  knowledgePointId: ID;
  name: string;
  /** 当前掌握度 0..1 */
  score: number;
  /** 严重程度，越大越该补 */
  severity: number;
  /** 中文人话解释 */
  reason: string;
}

/** 学习报告 */
export interface StudyReport {
  score: number;
  /** 一句话总评 */
  summary: string;
  weakPoints: WeakPoint[];
  /** 逐题错因分析 */
  mistakes: { questionId: ID; what: string; why: string; fix: string }[];
  /** 下一步建议 */
  suggestions: string[];
  generatedAt: number;
}

/** 一次测验 */
export interface Attempt {
  id: ID;
  paperId: ID;
  paperTitle: string;
  startedAt: number;
  finishedAt?: number;
  answers: AnswerRecord[];
  score?: number;
  report?: StudyReport;
}

/** 知识点掌握度记录（由 src/lib/srs 引擎维护） */
export interface MasteryRecord {
  knowledgePointId: string;
  score: number;
  attempts: number;
  correct: number;
  lastSeen: number;
  dueAt: number;
  intervalDays: number;
  ease: number;
  reps: number;
}

/** 错题本条目 */
export interface MistakeNote {
  id: ID;
  questionId: ID;
  wrongCount: number;
  lastWrongAt: number;
  /** 连续答对 2 次后置为 true */
  resolved: boolean;
  streak: number;
}

/** 学习者画像：自进化的核心资产，会注入到每次出题/讲解的 prompt 中 */
export interface LearnerProfile {
  id: 'me';
  /** 自评水平描述 */
  level: string;
  /** 已识别出的薄弱领域 */
  weakAreas: string[];
  /** 反复出现的错误模式 */
  errorPatterns: string[];
  /** 偏好的讲解风格 */
  preferredStyle: string;
  /** 直接注入 prompt 的画像全文（AI 维护） */
  digest: string;
  /** 累计答题数，用于判断画像是否够"厚" */
  totalAnswered: number;
  updatedAt: number;
}

/** 已生成的补强微讲义（轻量视图，实际存在 materials 表里） */
export interface MicroLessonRow {
  id: ID;
  title: string;
  body: string;
  createdAt: number;
}
