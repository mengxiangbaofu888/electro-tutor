// @vitest-environment jsdom
/**
 * 「我的」页里模型配置的交互测试。
 *
 * 这一组测试是从一条**真实用户反馈**来的：
 *   "你只给了模型厂商的选择，在哪儿填 API Key？你没给 key 留位置呀，填不了 key 选模型厂商有啥用"
 *
 * 事实是：Key 输入框一直存在，但它藏在「＋ 文本模型」按钮打开的弹层里，
 * 标题和按钮文案都没提"Key"，用户在第一屏根本找不到入口。
 * 这类问题单元测试原本盯不住（DOM 里确实有那个 input），
 * 所以这里改成盯**用户能不能走通这条路**：
 *   第一屏有没有填 Key 的入口 → 弹层里第一个字段是不是 Key
 *   → 模型是不是自己选（不能偷偷预填死） → 保存后库里有没有
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../lib/db/db';

const listModelsMock = vi.fn(async () => ['deepseek-chat', 'deepseek-reasoner']);
vi.mock('../../lib/llm/client', () => ({
  listModels: (...args: unknown[]) => listModelsMock(...(args as [])),
  testConnection: async () => '正常',
}));

const { SettingsPage } = await import('./SettingsPage');

beforeEach(async () => {
  listModelsMock.mockClear();
  await db.transaction('rw', [db.llmConfigs, db.profiles], async () => {
    await db.llmConfigs.clear();
    await db.profiles.clear();
  });
});

afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

/** 打开"填 Key"弹层 */
async function openSheet() {
  renderPage();
  const start = await screen.findByText('🔑 填 API Key（从这里开始）');
  fireEvent.click(start);
  await screen.findByText('① API Key');
}

describe('模型配置：用户要能自己填 Key、自己选模型', () => {
  it('第一屏就有"填 API Key"的入口，而不是只给一个服务商下拉框', async () => {
    renderPage();
    // 必须明确告诉用户"还没配模型，且入口在哪"
    expect(await screen.findByText(/还没有配置模型/)).toBeTruthy();
    expect(screen.getByText('🔑 填 API Key（从这里开始）')).toBeTruthy();
  });

  it('弹层里第一个字段就是 API Key，而且是密码框', async () => {
    await openSheet();
    const keyLabel = screen.getByText('① API Key');
    const field = keyLabel.closest('.field') as HTMLElement;
    const input = field.querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.type).toBe('password'); // 不该明文显示
  });

  it('不再预先填死一个模型：打开时是空的，让用户自己选', async () => {
    await openSheet();
    expect(screen.getByText(/当前已选：/)).toBeTruthy();
    expect(screen.getByText('（还没选）')).toBeTruthy();
  });

  it('填完 Key 后失焦，会自动联网拉一次模型列表', async () => {
    await openSheet();
    const field = screen.getByText('① API Key').closest('.field') as HTMLElement;
    const input = field.querySelector('input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'sk-test-123' } });
    fireEvent.blur(input);

    await waitFor(() => expect(listModelsMock).toHaveBeenCalledTimes(1));
    // 拉回来的模型要出现在"服务商返回 N 个模型"那一块里（那边才是联网结果）
    const block = (await screen.findByText(/服务商当前可用的 2 个模型/)).parentElement as HTMLElement;
    expect(within(block).getByText('deepseek-chat')).toBeTruthy();
    expect(within(block).getByText('deepseek-reasoner')).toBeTruthy();
  });

  it('点模型标签就选中它，保存后库里存的就是这个模型', async () => {
    await openSheet();
    const keyField = screen.getByText('① API Key').closest('.field') as HTMLElement;
    const keyInput = keyField.querySelector('input') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'sk-test-123' } });
    fireEvent.blur(keyInput);

    const block = (await screen.findByText(/服务商当前可用的 2 个模型/)).parentElement as HTMLElement;
    fireEvent.click(within(block).getByText('deepseek-reasoner'));

    // "当前已选"要跟着变成点过的那个
    const chosen = screen.getByText(/当前已选：/).parentElement as HTMLElement;
    expect(chosen.textContent).toContain('deepseek-reasoner');

    fireEvent.click(screen.getByText('保存'));

    await waitFor(async () => expect(await db.llmConfigs.count()).toBe(1));
    const saved = (await db.llmConfigs.toArray())[0];
    expect(saved.model).toBe('deepseek-reasoner');
    expect(saved.apiKey).toBe('sk-test-123');
    expect(saved.isDefaultText).toBe(true); // 第一个文本模型自动设为默认
  });

  it('没选模型就点保存：明确报错，而且不会存进半成品配置', async () => {
    await openSheet();
    const keyField = screen.getByText('① API Key').closest('.field') as HTMLElement;
    fireEvent.change(keyField.querySelector('input') as HTMLInputElement, {
      target: { value: 'sk-test-123' },
    });

    fireEvent.click(screen.getByText('保存'));

    // 提示在页面顶部和弹层里各渲染一次，所以用 findAllByText
    expect((await screen.findAllByText(/还没选模型/)).length).toBeGreaterThan(0);
    expect(await db.llmConfigs.count()).toBe(0);
  });

  it('没填 Key 时，"获取模型列表"按钮是禁用的（避免白跑一次网络请求）', async () => {
    await openSheet();
    const btn = screen.getByText('先填 API Key 才能获取模型列表').closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
