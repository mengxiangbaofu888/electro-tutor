// @vitest-environment jsdom
/**
 * 答题页的交互测试。
 *
 * 之前的测试只到"页面能渲染出来"为止，按钮点下去会发生什么没人验过。
 * 这一页又是交互最重、而且草稿自动保存逻辑是照着设计直接写的——
 * 必须真的点一遍才算数。
 *
 * 全部用客观题，所以整个流程不需要调用大模型。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, newId } from '../../lib/db/db';
import type { Attempt, KnowledgePoint, Outline, Paper, Question } from '../../lib/db/types';
import { ExamPage } from './ExamPage';

/* ------------------------------ 准备数据 ------------------------------ */

interface Seed {
  attemptId: string;
  q1: Question;
  q2: Question;
}

async function clearAll() {
  await db.transaction(
    'rw',
    [db.outlines, db.knowledgePoints, db.questions, db.papers, db.attempts, db.mastery, db.mistakes, db.profiles],
    async () => {
      await db.outlines.clear();
      await db.knowledgePoints.clear();
      await db.questions.clear();
      await db.papers.clear();
      await db.attempts.clear();
      await db.mastery.clear();
      await db.mistakes.clear();
      await db.profiles.clear();
    },
  );
}

async function seed(): Promise<Seed> {
  const outline: Outline = {
    id: newId(),
    title: '交互测试大纲',
    track: 'fundamental',
    materialIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.outlines.put(outline);

  const point: KnowledgePoint = {
    id: newId(),
    outlineId: outline.id,
    name: '欧姆定律',
    summary: '',
    importance: 4,
    order: 0,
    depth: 1,
  };
  await db.knowledgePoints.put(point);

  const q1: Question = {
    id: newId(),
    outlineId: outline.id,
    knowledgePointIds: [point.id],
    type: 'single',
    stem: '一段导体电压 12V、电阻 4Ω，电流是多少？',
    options: [
      { key: 'A', text: '3安培' },
      { key: 'B', text: '48安培' },
    ],
    answer: 'A',
    explanation: 'I = U/R = 3A',
    difficulty: 2,
    source: 'ai',
    createdAt: 1,
  };
  const q2: Question = {
    id: newId(),
    outlineId: outline.id,
    knowledgePointIds: [point.id],
    type: 'judge',
    stem: '串联电路中各处的电流都相等。',
    answer: '正确',
    explanation: '',
    difficulty: 1,
    source: 'ai',
    createdAt: 2,
  };
  await db.questions.bulkPut([q1, q2]);

  const paper: Paper = {
    id: newId(),
    title: '交互测试卷',
    outlineId: outline.id,
    questionIds: [q1.id, q2.id],
    durationMin: 0,
    createdAt: 1,
  };
  await db.papers.put(paper);

  const attempt: Attempt = {
    id: newId(),
    paperId: paper.id,
    paperTitle: paper.title,
    startedAt: Date.now(),
    answers: [],
  };
  await db.attempts.put(attempt);

  return { attemptId: attempt.id, q1, q2 };
}

/** 渲染答题页，并把报告页换成一个可断言的标记 */
function renderExam(attemptId: string) {
  return render(
    <MemoryRouter initialEntries={[`/exam/${attemptId}`]}>
      <Routes>
        <Route path="/exam/:attemptId" element={<ExamPage />} />
        <Route path="/report/:attemptId" element={<div>报告页标记</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(clearAll);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ============================== 测试 ============================== */

describe('答题页交互', () => {
  it('渲染第一题，并把题干和选项显示出来', async () => {
    const { attemptId, q1 } = await seed();
    renderExam(attemptId);

    expect(await screen.findByText(q1.stem)).toBeTruthy();
    expect(screen.getByText('3安培')).toBeTruthy();
    expect(screen.getByText('48安培')).toBeTruthy();
    expect(screen.getByText(/第 1 题/)).toBeTruthy();
  });

  it('点选项后，草稿会自动落盘（切后台/被杀也不会丢答案）', async () => {
    const { attemptId, q1 } = await seed();
    renderExam(attemptId);
    await screen.findByText(q1.stem);

    fireEvent.click(screen.getByText('3安培'));

    // 防抖 700ms 后才写入，等它落盘
    await waitFor(
      async () => {
        const saved = await db.attempts.get(attemptId);
        const record = saved?.answers.find((a) => a.questionId === q1.id);
        expect(record?.userAnswer).toEqual(['A']);
      },
      { timeout: 3000 },
    );
  });

  it('翻到下一题再翻回来，刚才的选择还在', async () => {
    const { attemptId, q1, q2 } = await seed();
    renderExam(attemptId);
    await screen.findByText(q1.stem);

    fireEvent.click(screen.getByText('3安培'));
    fireEvent.click(screen.getByText('下一题 ›'));
    expect(await screen.findByText(q2.stem)).toBeTruthy();

    fireEvent.click(screen.getByText('‹ 上一题'));
    expect(await screen.findByText(q1.stem)).toBeTruthy();

    // 选项处于选中态
    const option = screen.getByText('3安培').closest('.option');
    expect(option?.className).toContain('selected');
  });

  it('已经保存过的草稿会在重新进入时恢复', async () => {
    const { attemptId, q1 } = await seed();
    // 模拟上次留下的草稿
    await db.attempts.update(attemptId, {
      answers: [{ questionId: q1.id, userAnswer: ['B'] }],
    });

    renderExam(attemptId);
    await screen.findByText(q1.stem);

    const option = screen.getByText('48安培').closest('.option');
    expect(option?.className).toContain('selected');
    // 顶部计数也要认这道题已答
    expect(screen.getByText(/已答 1\/2/)).toBeTruthy();
  });

  it('还有题没做时交卷会先确认；点取消就留在原页面', async () => {
    const { attemptId, q1 } = await seed();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderExam(attemptId);
    await screen.findByText(q1.stem);

    // 第一题上就应该有交卷入口（以前只有翻到最后一题才出现）
    fireEvent.click(screen.getByText('交卷'));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(confirmSpy.mock.calls[0][0]).toContain('还有 2 道题没做');
    expect(screen.queryByText('报告页标记')).toBeNull();
    // 卷子还没交
    expect((await db.attempts.get(attemptId))?.finishedAt).toBeUndefined();
  });

  it('未答题数的提示是实时的，不会在全部答完后还写"还有 0 题"', async () => {
    const { attemptId, q1, q2 } = await seed();
    renderExam(attemptId);
    await screen.findByText(q1.stem);
    expect(screen.getByText(/还有 2 题没答/)).toBeTruthy();

    fireEvent.click(screen.getByText('3安培'));
    await waitFor(() => expect(screen.getByText(/还有 1 题没答/)).toBeTruthy());

    fireEvent.click(screen.getByText('下一题 ›'));
    await screen.findByText(q2.stem);
    fireEvent.click(screen.getByText('错误'));
    await waitFor(() => expect(screen.queryByText(/还有 \d+ 题没答/)).toBeNull());

    // 最后一题上按钮文案才是"交卷批改"
    expect(screen.getByText('交卷批改')).toBeTruthy();
  });

  it('做完全部题交卷：批改客观题、算出分数、跳到报告页', async () => {
    const { attemptId, q1, q2 } = await seed();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderExam(attemptId);
    await screen.findByText(q1.stem);

    // 第一题答对
    fireEvent.click(screen.getByText('3安培'));
    fireEvent.click(screen.getByText('下一题 ›'));
    await screen.findByText(q2.stem);
    // 第二题答错
    fireEvent.click(screen.getByText('错误'));

    fireEvent.click(screen.getByText('交卷批改'));

    expect(await screen.findByText('报告页标记')).toBeTruthy();
    // 全部答完就不该再弹确认
    expect(confirmSpy).not.toHaveBeenCalled();

    const finished = await db.attempts.get(attemptId);
    expect(finished?.finishedAt).toBeGreaterThan(0);
    // 单选 2 分答对 + 判断 1 分答错 → 2/3 → 67 分
    expect(finished?.score).toBe(67);
    expect(finished?.report).toBeTruthy();

    // 判分结果逐题写回
    const graded = finished?.answers ?? [];
    expect(graded.find((a) => a.questionId === q1.id)?.isCorrect).toBe(true);
    expect(graded.find((a) => a.questionId === q2.id)?.isCorrect).toBe(false);

    // 自进化引擎也写进去了
    expect(await db.mastery.count()).toBeGreaterThan(0);
    expect(await db.mistakes.count()).toBe(1);
  });

  it('答题卡能跳到指定题目', async () => {
    const { attemptId, q1, q2 } = await seed();
    renderExam(attemptId);
    await screen.findByText(q1.stem);

    fireEvent.click(screen.getByText('答题卡'));
    fireEvent.click(screen.getByText('2'));

    expect(await screen.findByText(q2.stem)).toBeTruthy();
  });
});
