/**
 * 答题草稿读写的行为测试。
 *
 * 这里守的是"数据不能丢"：手机上切走、被系统回收、交卷中途失败，
 * 这三种情况在真实使用里都会发生。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db, newId, patchAnswer } from '../db/db';
import type { Attempt } from '../db/types';
import { loadDraftAnswers, saveDraftAnswers } from './exam-draft';

async function makeAttempt(): Promise<Attempt> {
  const a: Attempt = {
    id: newId(),
    paperId: 'p1',
    paperTitle: '测试卷',
    startedAt: Date.now(),
    answers: [],
  };
  await db.attempts.put(a);
  return a;
}

beforeEach(async () => {
  await db.transaction('rw', db.attempts, async () => {
    await db.attempts.clear();
  });
});

describe('答题草稿', () => {
  it('保存后能原样读回来', async () => {
    const a = await makeAttempt();
    await saveDraftAnswers(a.id, { q1: ['A'], q2: ['欧姆', '安培'] });
    const loaded = await loadDraftAnswers(a.id);
    expect(loaded.q1).toEqual(['A']);
    expect(loaded.q2).toEqual(['欧姆', '安培']);
  });

  it('保存草稿不会冲掉同一次测验里已有的批改结果', async () => {
    const a = await makeAttempt();
    // 第一题已经批改过
    await patchAnswer(a.id, { questionId: 'q1', userAnswer: 'A', isCorrect: true, scoreRatio: 1 });
    // 然后保存第二题的草稿
    await saveDraftAnswers(a.id, { q2: ['B'] });

    const raw = await db.attempts.get(a.id);
    const q1 = raw?.answers.find((x) => x.questionId === 'q1');
    expect(q1?.scoreRatio).toBe(1);
    expect(q1?.isCorrect).toBe(true);
    expect((await loadDraftAnswers(a.id)).q2).toEqual(['B']);
  });

  it('重复保存同一题是覆盖，不会产生重复条目', async () => {
    const a = await makeAttempt();
    await saveDraftAnswers(a.id, { q1: ['A'] });
    await saveDraftAnswers(a.id, { q1: ['B'] });

    const raw = await db.attempts.get(a.id);
    expect(raw?.answers.filter((x) => x.questionId === 'q1')).toHaveLength(1);
    expect((await loadDraftAnswers(a.id)).q1).toEqual(['B']);
  });

  it('交卷中途失败时，未批改的题仍保留着草稿答案', async () => {
    const a = await makeAttempt();
    await saveDraftAnswers(a.id, { q1: ['A'], q2: ['B'], q3: ['C'] });
    // 只批改到第一题就"崩了"
    await patchAnswer(a.id, { questionId: 'q1', userAnswer: 'A', isCorrect: true, scoreRatio: 1 });

    const loaded = await loadDraftAnswers(a.id);
    expect(loaded.q2).toEqual(['B']);
    expect(loaded.q3).toEqual(['C']);
    // 三条记录都在：一条带分数，两条是草稿
    const raw = await db.attempts.get(a.id);
    expect(raw?.answers).toHaveLength(3);
    expect(raw?.answers.filter((x) => typeof x.scoreRatio === 'number')).toHaveLength(1);
  });

  it('空草稿与空 id 不会写坏数据', async () => {
    const a = await makeAttempt();
    expect(await saveDraftAnswers(a.id, {})).toBe(0);
    expect(await saveDraftAnswers(a.id, { '': ['A'] })).toBe(0);
    expect((await db.attempts.get(a.id))?.answers).toHaveLength(0);
  });

  it('对不存在的测验读数返回空对象，而不是抛错', async () => {
    expect(await loadDraftAnswers('不存在的 id')).toEqual({});
  });
});
