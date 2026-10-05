// @vitest-environment jsdom
/**
 * 大纲页的交互测试。
 *
 * 重点验「内置起步大纲」这块——它是新用户唯一的零成本起点，
 * 按钮点下去必须真的装上四套大纲和上百个知识点。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../lib/db/db';
import { OutlineListPage } from './OutlineListPage';

beforeEach(async () => {
  await db.transaction('rw', [db.outlines, db.knowledgePoints, db.materials], async () => {
    await db.outlines.clear();
    await db.knowledgePoints.clear();
    await db.materials.clear();
  });
});

afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter>
      <OutlineListPage />
    </MemoryRouter>,
  );
}

describe('大纲页交互', () => {
  it('点「一键装上全部四条线」会装上四套内置大纲和上百个知识点', async () => {
    renderPage();
    await screen.findByText('📦 内置起步大纲');
    expect(screen.getByText('0/4 已装')).toBeTruthy();

    fireEvent.click(screen.getByText('一键装上全部四条线'));

    await waitFor(async () => expect(await db.outlines.count()).toBe(4), { timeout: 8000 });

    const outlines = await db.outlines.toArray();
    expect(outlines.every((o) => o.seed)).toBe(true);
    expect(outlines.map((o) => o.track).sort()).toEqual([
      'fundamental',
      'lowvoltage-cert',
      'midlevel-cert',
      'plc',
    ]);

    // 知识点也一起进去了，而且数量对得上
    expect(await db.knowledgePoints.count()).toBeGreaterThan(90);

    // 界面切成「已装」状态
    await screen.findByText('4/4 已装');
    expect(screen.getAllByText('已装').length).toBeGreaterThanOrEqual(4);
  });

  it('已经装过之后再点，不会重复装', async () => {
    renderPage();
    await screen.findByText('📦 内置起步大纲');

    fireEvent.click(screen.getByText('一键装上全部四条线'));
    await waitFor(async () => expect(await db.outlines.count()).toBe(4), { timeout: 8000 });

    // 装完之后按钮变成禁用态，再点也不会翻倍
    await screen.findByText('4/4 已装');
    const button = screen.getByText('一键装上全部四条线').closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(await db.outlines.count()).toBe(4);
  });
});
