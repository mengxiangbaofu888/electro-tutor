// @vitest-environment jsdom
/**
 * 练习页的交互测试。
 *
 * 重点守一条：**打开页面时不能是一屏灰按钮**。
 * 「自适应出题」默认勾着，但题量必须真的算出来，否则用户看到的是
 * 所有知识点都是 0、"共 0 道"、两个主按钮全禁用——
 * 会以为这页坏了，而"先点一下自适应推荐"这个前提没写在任何地方。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../lib/db/db';
import { installSeedOutline } from '../../lib/seed';
import { PracticePage } from './PracticePage';

async function clearAll() {
  await db.transaction(
    'rw',
    [db.outlines, db.knowledgePoints, db.questions, db.mastery, db.materials, db.llmConfigs],
    async () => {
      await db.outlines.clear();
      await db.knowledgePoints.clear();
      await db.questions.clear();
      await db.mastery.clear();
      await db.materials.clear();
      await db.llmConfigs.clear();
    },
  );
}

function renderPage() {
  return render(
    <MemoryRouter>
      <PracticePage />
    </MemoryRouter>,
  );
}

/**
 * 只统计**知识点**的题量输入框。
 * 页面上还有一组「题型配比」的数量输入（默认就凑够 20），不加区分地全加起来的话，
 * 断言会在自适应分配还没算完时就误判为"已经有题量了"。
 * 两组输入靠 aria-label 区分（顺带也让读屏软件能念清每个框是干什么的）。
 */
function allocationInputs(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll('input[type="number"]')].filter((el) =>
    (el.getAttribute('aria-label') ?? '').startsWith('知识点'),
  ) as HTMLInputElement[];
}

function sumAllocation(container: HTMLElement): number {
  return allocationInputs(container).reduce((sum, el) => sum + Number(el.value || 0), 0);
}

beforeEach(async () => {
  await clearAll();
  // 装一份内置大纲，模拟"用户已经有知识点可练"的状态
  await installSeedOutline('plc');
});

afterEach(cleanup);

describe('练习页交互', () => {
  it('打开页面就自动算好题量，主按钮可以直接点（不是一屏灰按钮）', async () => {
    const { container } = renderPage();
    await screen.findByText(/选择大纲与题量/);

    await waitFor(() => expect(sumAllocation(container)).toBeGreaterThan(0), { timeout: 8000 });

    const startButton = screen.getByText('生成并开始答题').closest('button') as HTMLButtonElement;
    expect(startButton.disabled).toBe(false);
    // 界面上要能看到总题数，而不是"共 0 道"
    expect(screen.queryByText('共 0 道')).toBeNull();
  });

  it('自动算出来的题量确实按知识点分配了，而不是只填了一个', async () => {
    const { container } = renderPage();
    await screen.findByText(/选择大纲与题量/);
    await waitFor(() => expect(sumAllocation(container)).toBeGreaterThan(0), { timeout: 8000 });

    const filled = allocationInputs(container).filter((el) => Number(el.value || 0) > 0);
    expect(filled.length).toBeGreaterThan(1);
    // 自适应推荐的默认总量是 20
    expect(sumAllocation(container)).toBe(20);
  });

  it('手动改过题量之后，不会再被自动计算覆盖掉', async () => {
    const { container } = renderPage();
    await screen.findByText(/选择大纲与题量/);
    await waitFor(() => expect(sumAllocation(container)).toBe(20), { timeout: 8000 });

    const first = allocationInputs(container)[0];
    fireEvent.change(first, { target: { value: '7' } });

    // 给自动计算留出再次触发的机会
    await new Promise((r) => setTimeout(r, 300));
    expect(allocationInputs(container)[0].value).toBe('7');
  });

  it('取消勾选自适应后，题量输入框变成可手动编辑', async () => {
    const { container } = renderPage();
    await screen.findByText(/选择大纲与题量/);
    await waitFor(() => expect(sumAllocation(container)).toBe(20), { timeout: 8000 });

    fireEvent.click(screen.getByLabelText(/自适应出题/));

    await screen.findByText(/手动模式/);
    expect(allocationInputs(container).length).toBeGreaterThan(0);
  });
});
