/**
 * types.ts —— 自进化引擎的公共数据结构（本目录自带最小结构，不依赖模块外部代码）
 */

/** 单个知识点的掌握记录（与 db/types.ts 中的字段名保持一致） */
export interface MasteryRecord {
  knowledgePointId: string;
  /** 静态掌握度 0..1（指数滑动平均的结果，不含遗忘衰减） */
  score: number;
  /** 总作答次数 */
  attempts: number;
  /** 客观题答对次数 */
  correct: number;
  /** 最近一次作答时间（毫秒时间戳） */
  lastSeen: number;
  /** 下次该复习的时间戳 */
  dueAt: number;
  /** 当前复习间隔（天，可为小数；0 表示尚未安排） */
  intervalDays: number;
  /** SM-2 难度因子 EF，初始 2.5，下限 1.3，上限 3.0 */
  ease: number;
  /** 连续答对次数 */
  reps: number;
}

/** 一次作答结果：可同时命中多个知识点 */
export interface Grade {
  knowledgePointIds: string[];
  /** 0..1：客观题对错用 1/0，主观题用 AI 给的得分率 */
  scoreRatio: number;
  /** 本次作答发生的时间（毫秒时间戳） */
  at: number;
}

/** 排序后的薄弱知识点 */
export interface WeakPoint {
  knowledgePointId: string;
  /** 当前掌握度（已含遗忘衰减）0..1 */
  score: number;
  /** 薄弱严重度 0..1，越大越该补 */
  severity: number;
  /** 中文人话解释 */
  reason: string;
}

/** 参与薄弱点排序 / 出题权重计算的知识点输入 */
export interface MasteryInput {
  knowledgePointId: string;
  name: string;
  record?: MasteryRecord;
}
