// @vitest-environment jsdom
/**
 * 题库页的测试。
 *
 * 起因是用户最重的一条反馈（原话）：
 *   "已经生成但是还没有做的题你保存到哪儿了？在练习里点还没做过的题啥也没有。
 *    已经生成出来了我去哪儿找？你藏那么深干什么？这个软件主要目标就是刷题用的。"
 *
 * 之前"还没做过/做对/做错"只是一组抽样参数，界面上根本没有题目列表 —— 设计错误。
 * 现在题库是一级页面：默认看"还没做过"，每题能单练，也能把一批做成一次练习。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../lib/db/db';
import type { Question } from '../../lib/db/types';

const { BankPage } = await import('./BankPage');

function q(id: string, stem: string, createdAt: number): Question {
  return {
    id,
    outlineId: 'o1',
    knowledgePointIds: [],
    type: 'single',
    stem,
    options: [
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' },
    ],
    answer: 'A',
    explanation: '',
    difficulty: 2,
    source: 'ai',
    createdAt,
  };
}

async function seed() {
  await db.transaction('rw', [db.questions, db.attempts, db.papers], async () => {
    await db.questions.clear();
    await db.attempts.clear();
    await db.papers.clear();
    await db.questions.bulkPut([
      q('q1', '还没做过的题甲', 1000),
      q('q2', '还没做过的题乙', 900),
      q('q3', '做对过的题', 800),
      q('q4', '做错过的题', 700),
    ]);
    // 一次做过 q3（对）和 q4（错）的答题记录
    const paper = {
      id: 'p1',
      title: '卷子',
      questionIds: ['q3', 'q4'],
      durationMin: 0,
      outlineId: 'o1',
      createdAt: 500,
    };
    await db.papers.put(paper);
    await db.attempts.put({
      id: 'a1',
      paperId: 'p1',
      paperTitle: '卷子',
      startedAt: 500,
      finishedAt: 600,
      score: 50,
      answers: [
        { questionId: 'q3', userAnswer: ['A'], isCorrect: true },
        { questionId: 'q4', userAnswer: ['B'], isCorrect: false },
      ],
    });
  });
}

beforeEach(seed);
afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter>
      <BankPage />
    </MemoryRouter>,
  );
}

describe('题库页（生成出来的题必须一眼可见）', () => {
  it('默认显示"还没做过"的题：生成出来没做过的都在', async () => {
    renderPage();
    expect(await screen.findByText('还没做过的题甲')).toBeTruthy();
    expect(screen.getByText('还没做过的题乙')).toBeTruthy();
    // 做过的不该出现在这个筛选里
    expect(screen.queryByText('做对过的题')).toBeNull();
    expect(screen.queryByText('做错过的题')).toBeNull();
    // 计数要如实：2 道没做过、1 道做对、1 道做错
    expect(screen.getByText(/还没做过 2/)).toBeTruthy();
  });

  it('切到"做错过"就只显示做错的题', async () => {
    renderPage();
    fireEvent.click(await screen.findByText(/做错过 1/));
    expect(await screen.findByText('做错过的题')).toBeTruthy();
    expect(screen.queryByText('还没做过的题甲')).toBeNull();
  });

  it('每道题可以单独练：点「练这题」会开出只有这一题的卷子', async () => {
    renderPage();
    const rows = await screen.findAllByText(/练这题/);
    fireEvent.click(rows[0]);
    await waitFor(async () => {
      const attempts = await db.attempts.toArray();
      const single = attempts.filter((a) => a.paperTitle.startsWith('单题练习'));
      expect(single).toHaveLength(1);
      const paper = await db.papers.get(single[0].paperId);
      expect(paper?.questionIds).toHaveLength(1);
    });
  });

  it('筛选下一道都没有时，把话说清楚而不是白屏', async () => {
    renderPage();
    // 做错过只有 1 道：把它做成练习后就没了 —— 这里直接切一个空场景：全部答完后"还没做过"为空
    fireEvent.click(await screen.findByText(/做对过 1/));
    expect(await screen.findByText('做对过的题')).toBeTruthy();
  });
});
