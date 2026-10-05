import Dexie, { type Table } from 'dexie';
import type {
  AnswerRecord,
  Attempt,
  ID,
  KnowledgePoint,
  LearnerProfile,
  LLMConfig,
  MasteryRecord,
  Material,
  MistakeNote,
  Outline,
  Paper,
  Question,
} from './types';

/** 生成唯一 ID */
export function newId(): ID {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 简易键值设置表 */
export interface SettingRow {
  key: string;
  value: unknown;
}

/**
 * 本机数据库。全部数据都在本地，永远不上传服务器。
 */
export class ElectroTutorDB extends Dexie {
  materials!: Table<Material, string>;
  outlines!: Table<Outline, string>;
  knowledgePoints!: Table<KnowledgePoint, string>;
  questions!: Table<Question, string>;
  papers!: Table<Paper, string>;
  attempts!: Table<Attempt, string>;
  mastery!: Table<MasteryRecord, string>;
  mistakes!: Table<MistakeNote, string>;
  profiles!: Table<LearnerProfile, string>;
  llmConfigs!: Table<LLMConfig, string>;
  settings!: Table<SettingRow, string>;

  constructor() {
    super('electro-tutor');
    this.version(1).stores({
      materials: 'id, createdAt, track, sourceType',
      outlines: 'id, createdAt, track',
      knowledgePoints: 'id, outlineId, parentId, order',
      questions: 'id, outlineId, type, difficulty, createdAt, *knowledgePointIds',
      papers: 'id, createdAt, track',
      attempts: 'id, paperId, startedAt',
      mastery: 'knowledgePointId, dueAt, lastSeen',
      mistakes: 'id, questionId, resolved, lastWrongAt',
      profiles: 'id',
      llmConfigs: 'id, kind, createdAt',
      settings: 'key',
    });
  }
}

export const db = new ElectroTutorDB();

/* ------------------------------ 设置读写 ------------------------------ */

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row ? (row.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}

/* ------------------------------ 模型配置 ------------------------------ */

export async function listLLMConfigs(): Promise<LLMConfig[]> {
  return db.llmConfigs.orderBy('createdAt').toArray();
}

export async function saveLLMConfig(config: LLMConfig): Promise<void> {
  await db.transaction('rw', db.llmConfigs, async () => {
    await db.llmConfigs.put(config);
    // 保证同类模型只有一个默认
    const all = await db.llmConfigs.where('kind').equals(config.kind).toArray();
    for (const c of all) {
      if (c.id === config.id) continue;
      const patch: Partial<LLMConfig> = {};
      if (config.kind === 'text' && c.isDefaultText) patch.isDefaultText = false;
      if (config.kind === 'vision' && c.isDefaultVision) patch.isDefaultVision = false;
      if (Object.keys(patch).length) await db.llmConfigs.update(c.id, patch);
    }
  });
}

export async function deleteLLMConfig(id: ID): Promise<void> {
  await db.llmConfigs.delete(id);
}

export async function getDefaultLLM(kind: 'text' | 'vision'): Promise<LLMConfig | undefined> {
  const all = await db.llmConfigs.where('kind').equals(kind).toArray();
  if (!all.length) return undefined;
  const flag = kind === 'text' ? 'isDefaultText' : 'isDefaultVision';
  return all.find((c) => c[flag]) ?? all[0];
}

/* ------------------------------ 学习者画像 ------------------------------ */

export const EMPTY_PROFILE: LearnerProfile = {
  id: 'me',
  level: '电工零基础，电控薄弱，目标是为 PLC 打基础并考取低压电工证与电工中级等级证',
  weakAreas: [],
  errorPatterns: [],
  preferredStyle: '从零讲起，先讲"为什么"再讲"怎么做"，多用生活类比，公式要给推导步骤',
  digest: '',
  totalAnswered: 0,
  updatedAt: 0,
};

export async function getProfile(): Promise<LearnerProfile> {
  const p = await db.profiles.get('me');
  return p ?? { ...EMPTY_PROFILE };
}

export async function saveProfile(p: LearnerProfile): Promise<void> {
  await db.profiles.put(p);
}

/* ------------------------------ 答题记录 ------------------------------ */

export async function saveAttempt(attempt: Attempt): Promise<void> {
  await db.attempts.put(attempt);
}

export async function getAttempt(id: ID): Promise<Attempt | undefined> {
  return db.attempts.get(id);
}

/** 把一条作答结果写回测验（不可变方式更新） */
export async function patchAnswer(attemptId: ID, record: AnswerRecord): Promise<void> {
  const attempt = await db.attempts.get(attemptId);
  if (!attempt) return;
  const answers = attempt.answers.filter((a) => a.questionId !== record.questionId);
  answers.push(record);
  await db.attempts.update(attemptId, { answers });
}
