// @vitest-environment jsdom
/**
 * 材料导入页的交互测试。
 *
 * 这一页决定了"能不能把材料喂进去"，是整条链路的起点。
 * 之前只验证了它能渲染出加载态，没验证过填表到落库这一步。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../lib/db/db';
import { IngestPage } from './IngestPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <IngestPage />
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await db.transaction('rw', db.materials, async () => {
    await db.materials.clear();
  });
});

afterEach(cleanup);

describe('材料导入页交互', () => {
  it('粘贴文本并保存，会写入一条材料并清空表单', async () => {
    const { container } = renderPage();
    await screen.findByText('➕ 添加学习材料');

    const title = container.querySelector('input[type="text"]') as HTMLInputElement;
    const body = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: '接触器自锁回路' } });
    fireEvent.change(body, { target: { value: '按下 SB2，KM 线圈得电；松开后经 KM 常开触点继续供电，这就是自锁。' } });

    fireEvent.click(screen.getByText('保存材料'));

    await waitFor(async () => expect(await db.materials.count()).toBe(1));
    const material = (await db.materials.toArray())[0];
    expect(material.title).toBe('接触器自锁回路');
    expect(material.content).toContain('自锁');
    expect(material.sourceType).toBe('text');
    expect(material.track).toBe('fundamental'); // 默认学习线
    expect(material.charCount).toBeGreaterThan(0);

    // 保存后表单清空，方便接着录下一条
    await waitFor(() => {
      expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
      expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('');
    });
    await screen.findByText(/已保存/);
  });

  it('内容为空时点保存只提示，不写入空材料', async () => {
    renderPage();
    await screen.findByText('➕ 添加学习材料');

    fireEvent.click(screen.getByText('保存材料'));

    await screen.findByText(/请先粘贴内容/);
    expect(await db.materials.count()).toBe(0);
  });

  it('切换学习线后保存，材料会带上所属线', async () => {
    const { container } = renderPage();
    await screen.findByText('➕ 添加学习材料');

    const select = container.querySelector('select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'plc' } });
    fireEvent.change(container.querySelector('textarea') as HTMLTextAreaElement, {
      target: { value: '梯形图的基本规则：从左到右、从上到下，能流不能倒流。' },
    });

    fireEvent.click(screen.getByText('保存材料'));

    await waitFor(async () => expect(await db.materials.count()).toBe(1));
    expect((await db.materials.toArray())[0].track).toBe('plc');
  });

  it('切到「上传文档」模式会换成文件选择入口', async () => {
    renderPage();
    await screen.findByText('➕ 添加学习材料');

    expect(screen.queryByText(/选择文件/)).toBeNull();
    fireEvent.click(screen.getByText(/📄 上传文档/));
    expect(screen.getByText(/选择文件/)).toBeTruthy();
    // 文件模式下不再需要填标题
    expect(screen.queryByText(/标题（可留空自动生成）/)).toBeNull();
  });

  it('已经导入的材料会列出来，可以删除', async () => {
    await db.materials.put({
      id: 'm1',
      title: '待删除的材料',
      sourceType: 'text',
      content: '内容',
      charCount: 2,
      createdAt: Date.now(),
    });

    renderPage();
    await screen.findByText('待删除的材料');

    fireEvent.click(screen.getByText('删除'));

    await waitFor(async () => expect(await db.materials.count()).toBe(0));
    expect(screen.queryByText('待删除的材料')).toBeNull();
  });
});
