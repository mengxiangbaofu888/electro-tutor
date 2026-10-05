/**
 * 答题草稿的读写。
 *
 * 单独抽出来，是因为这里有一条必须守住的性质：
 * **保存草稿只能覆盖"作答内容"，绝不能把已有的批改结果冲掉。**
 *
 * 交卷是逐题批改、边批边存的，中途失败或用户退出都很常见。
 * 如果草稿写入采用"整体替换 answers 数组"，用户就会丢掉已经批好的分数；
 * 如果草稿从不落盘，用户在手机上切走一次就丢掉全部答案。
 * 两种做法都是真实会发生的数据丢失。
 */
import { db, patchAnswer } from '../db/db';
import type { ID } from '../db/types';

/**
 * 把一批草稿作答合并写入测验记录。
 * 已存在的同题记录会被替换（用户改了答案），其他题一律不动。
 * @returns 实际写入的题数
 */
export async function saveDraftAnswers(attemptId: ID, drafts: Record<ID, string[]>): Promise<number> {
  const ids = Object.keys(drafts).filter((id) => id);
  for (const qid of ids) {
    await patchAnswer(attemptId, { questionId: qid, userAnswer: drafts[qid] ?? [] });
  }
  return ids.length;
}

/**
 * 读出某次测验里已存的作答（既包含纯草稿，也包含已批改的记录）。
 * 交卷失败后重新进入时，未批改的题就靠这个恢复。
 */
export async function loadDraftAnswers(attemptId: ID): Promise<Record<ID, string[]>> {
  const attempt = await db.attempts.get(attemptId);
  const out: Record<ID, string[]> = {};
  if (!attempt) return out;
  for (const a of attempt.answers) {
    out[a.questionId] = Array.isArray(a.userAnswer) ? a.userAnswer : [String(a.userAnswer)];
  }
  return out;
}
