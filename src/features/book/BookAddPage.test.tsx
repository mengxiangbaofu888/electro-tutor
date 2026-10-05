// @vitest-environment jsdom
/**
 * 「加一本教材」页的交互测试。
 *
 * 这一页的价值全在"用户能不能真的把一本书建起来"：
 *   拍书皮（AI 认字，可能认错）→ 手动改 → 扫码（真解码）→ 攒微课 → 保存成材料。
 * 所以测试盯的是这条链路，而不是"页面上有没有某个 div"。
 *
 * 解码库在测试里被打桩（返回预设的扫码结果），因为真解码的验证
 * 已经由 decode.test.ts 用真二维码覆盖了；这里要验的是接线对不对。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../lib/db/db';

/** 每次调用依次返回预设的扫码结果（null = 这张没解出来） */
const scanResults: Array<{ text: string; format: string } | null> = [];
vi.mock('../../lib/scan/decode', async () => {
  const actual = await vi.importActual<typeof import('../../lib/scan/decode')>('../../lib/scan/decode');
  return {
    ...actual,
    decodeImageFile: async () => scanResults.shift() ?? null,
  };
});

const visionMock = vi.fn(async () =>
  '```json\n{"bookTitle":"电工技术","publisher":"机械工业出版社","主编":"王五","版次":"第3版"}\n```',
);
vi.mock('../../lib/llm/client', () => ({
  visionExtract: (...args: unknown[]) => visionMock(...(args as [])),
}));

vi.mock('../../lib/platform/image', async () => {
  const actual = await vi.importActual<typeof import('../../lib/platform/image')>('../../lib/platform/image');
  return {
    ...actual,
    compressImages: async () => ({
      dataUrls: ['data:image/jpeg;base64,MOCK'],
      originalBytes: 1000,
      compressedBytes: 300,
    }),
  };
});

/** 抓网页正文：默认返回"够用"的正文，测试里可以按链接改造 */
const extractMock = vi.fn(async (url: string) => ({
  text: '这是一段足够长的微课正文。'.repeat(30),
  title: `网页标题-${url.slice(-4)}`,
}));
vi.mock('../../lib/extract', () => ({
  extractFromUrl: (...args: unknown[]) => extractMock(...(args as [string])),
}));

const { BookAddPage } = await import('./BookAddPage');

beforeEach(async () => {
  scanResults.length = 0;
  visionMock.mockClear();
  extractMock.mockClear();
  extractMock.mockImplementation(async (url: string) => ({
    text: '这是一段足够长的微课正文。'.repeat(30),
    title: `网页标题-${url.slice(-4)}`,
  }));
  await db.transaction('rw', [db.materials, db.llmConfigs], async () => {
    await db.materials.clear();
    await db.llmConfigs.clear();
    // 页面要读"默认识图模型"，放一个进去
    await db.llmConfigs.put({
      id: 'v1',
      name: '识图',
      baseUrl: 'https://example.com/v1',
      apiKey: 'k',
      model: 'glm-4v-flash',
      kind: 'vision',
      temperature: 0.2,
      isDefaultVision: true,
      createdAt: 1,
    });
  });
});

afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter>
      <BookAddPage />
    </MemoryRouter>,
  );
}

/** 造一个"照片文件" */
function fakeImage(name = 'cover.jpg') {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });
}

/** 往某个 file input 里塞文件 */
function pickFile(labelText: string, files: File[]) {
  const label = screen.getByText(labelText).closest('label') as HTMLElement;
  const input = label.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

describe('加教材：拍书皮 → 核对 → 扫码 → 保存', () => {
  it('拍书皮后自动填出书名/出版社/主编/版次，并且这些字段都能改', async () => {
    renderPage();
    pickFile('拍照 / 选书皮照片', [fakeImage()]);

    await waitFor(() => {
      const title = screen.getByPlaceholderText('例如：电工技术（第3版）') as HTMLInputElement;
      expect(title.value).toBe('电工技术');
    });
    expect((screen.getByDisplayValue('机械工业出版社') as HTMLInputElement).value).toBe(
      '机械工业出版社',
    );
    expect((screen.getByDisplayValue('王五') as HTMLInputElement).value).toBe('王五');

    // 认错了要能直接改
    const title = screen.getByPlaceholderText('例如：电工技术（第3版）') as HTMLInputElement;
    fireEvent.change(title, { target: { value: '电工技术（第3版）' } });
    expect(title.value).toBe('电工技术（第3版）');
  });

  it('扫到微课二维码就进清单，重复的自动去掉', async () => {
    scanResults.push(
      { text: 'https://x.com/course/11-1', format: 'QR_CODE' },
      { text: 'https://x.com/course/11-1', format: 'QR_CODE' }, // 同一个码扫两次
      { text: 'https://x.com/course/11-2', format: 'QR_CODE' },
    );
    renderPage();
    pickFile('拍照 / 选二维码（可多选）', [fakeImage('q1.jpg'), fakeImage('q2.jpg'), fakeImage('q3.jpg')]);

    await screen.findByText('https://x.com/course/11-1');
    expect(screen.getAllByText('https://x.com/course/11-1')).toHaveLength(1); // 去重了
    expect(screen.getByText('https://x.com/course/11-2')).toBeTruthy();
  });

  it('扫到 ISBN 条码会填进 ISBN 字段并做校验位检查', async () => {
    scanResults.push({ text: '9787111636502', format: 'EAN_13' });
    renderPage();
    pickFile('拍照 / 选二维码（可多选）', [fakeImage()]);

    await waitFor(() => {
      const isbn = screen.getByPlaceholderText('978-7-111-63650-2') as HTMLInputElement;
      expect(isbn.value).toBe('9787111636502');
    });
    expect(screen.getByText(/已通过校验位检查/)).toBeTruthy();
  });

  it('校验位不对的号码不会被当成 ISBN 收下', async () => {
    scanResults.push({ text: '9787111636507', format: 'EAN_13' });
    renderPage();
    pickFile('拍照 / 选二维码（可多选）', [fakeImage()]);

    await screen.findByText(/既不是 ISBN 也不是网址/);
    const isbn = screen.getByPlaceholderText('978-7-111-63650-2') as HTMLInputElement;
    expect(isbn.value).toBe('');
  });

  it('拍糊了（解不出码）会明确告诉用户怎么办，而不是静默失败', async () => {
    scanResults.push(null, null);
    renderPage();
    pickFile('拍照 / 选二维码（可多选）', [fakeImage(), fakeImage()]);
    await screen.findByText(/没能解出码|没有解出二维码或条码/);
  });

  it('保存后材料库里有一条「教材」材料，正文含书目与微课清单', async () => {
    scanResults.push({ text: 'https://x.com/course/11-1', format: 'QR_CODE' });
    renderPage();

    const title = screen.getByPlaceholderText('例如：电工技术（第3版）') as HTMLInputElement;
    fireEvent.change(title, { target: { value: '电工技术（第3版）' } });
    pickFile('拍照 / 选二维码（可多选）', [fakeImage()]);
    await screen.findByText('https://x.com/course/11-1');

    fireEvent.click(screen.getByText('保存这本教材'));

    await waitFor(async () => expect(await db.materials.count()).toBe(1));
    const row = (await db.materials.toArray())[0];
    expect(row.sourceType).toBe('book');
    expect(row.title).toBe('电工技术（第3版）');
    expect(row.book?.microLessons?.[0].url).toBe('https://x.com/course/11-1');
    expect(row.content).toContain('# 电工技术（第3版）');
    expect(row.content).toContain('配套微课（共 1 节）');
  });

  it('书名为空时拒绝保存，并给出可操作的提示', async () => {
    renderPage();
    fireEvent.click(screen.getByText('保存这本教材'));
    expect(await screen.findByText(/书名不能空/)).toBeTruthy();
    expect(await db.materials.count()).toBe(0);
  });

  it('手动粘链接也能加微课，格式不对会被拦住', async () => {
    renderPage();
    const input = screen.getByPlaceholderText('https://…') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '不是网址' } });
    fireEvent.click(screen.getByText('加入'));
    expect(await screen.findByText(/请填完整网址/)).toBeTruthy();

    fireEvent.change(input, { target: { value: 'https://x.com/manual/1' } });
    fireEvent.click(screen.getByText('加入'));
    await screen.findByText('https://x.com/manual/1');
  });
});

describe('补充添加微课（加完书之后回头补漏的）', () => {
  it('带着已有教材的 id 打开：载入这本书，保存是"更新"而不是新建', async () => {
    // 先造一本已经存在的教材，里面已经有 1 个微课
    const existingId = 'book-existing';
    await db.materials.put({
      id: existingId,
      title: '电工技术（第3版）',
      sourceType: 'book',
      content: '# 电工技术（第3版）',
      charCount: 12,
      track: 'plc',
      createdAt: 111,
      book: {
        bookTitle: '电工技术（第3版）',
        publisher: '机械工业出版社',
        microLessons: [
          { id: 'm1', url: 'https://x.com/micro/1', title: '第1节', addedAt: 1 },
        ],
      },
    });

    render(
      <MemoryRouter>
        <BookAddPage materialId={existingId} />
      </MemoryRouter>,
    );

    // 书名要从已存的书里带出来，并明确告诉用户这是"补充"
    await waitFor(() => {
      const title = screen.getByPlaceholderText('例如：电工技术（第3版）') as HTMLInputElement;
      expect(title.value).toBe('电工技术（第3版）');
    });
    expect(await screen.findByText(/正在补充\/编辑/)).toBeTruthy();
    // 已有的微课要显示出来，才知道漏了哪些
    expect(screen.getByText('https://x.com/micro/1')).toBeTruthy();
    // 按钮变成"保存修改"
    const saveBtn = screen.getByText('保存修改（补充微课）');

    // 再补一个微课，然后保存
    const input = screen.getByPlaceholderText('https://…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://x.com/micro/2' } });
    fireEvent.click(screen.getByText('加入'));
    await screen.findByText('https://x.com/micro/2');

    fireEvent.click(saveBtn);
    await waitFor(async () => expect(await db.materials.count()).toBe(1));
    const row = await db.materials.get(existingId);
    expect(row?.book?.microLessons?.map((m) => m.url).sort()).toEqual([
      'https://x.com/micro/1',
      'https://x.com/micro/2',
    ]);
    // 创建时间不能被改成"今天"，这是补充不是新建
    expect(row?.createdAt).toBe(111);
    expect(row?.track).toBe('plc');
  });
});

describe('让 App 自己去把微课内容抓下来（用户要的是软件自己找到内容）', () => {
  /** 往微课清单里加一个链接 */
  async function addMicroLesson(url: string) {
    const input = screen.getByPlaceholderText('https://…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: url } });
    fireEvent.click(screen.getByText('加入'));
    await screen.findByText(url);
  }

  it('点一下按钮，App 就逐个打开链接并把正文存成材料', async () => {
    renderPage();
    await addMicroLesson('https://x.com/micro/11-1');
    await addMicroLesson('https://x.com/micro/11-2');

    fireEvent.click(screen.getByText(/让 App 去抓这 2 个微课的内容/));

    await waitFor(async () => expect(await db.materials.count()).toBe(2), { timeout: 8000 });
    const rows = await db.materials.toArray();
    expect(rows.map((m) => m.sourceType)).toEqual(['url', 'url']);
    expect(rows.map((m) => m.sourceRef).sort()).toEqual([
      'https://x.com/micro/11-1',
      'https://x.com/micro/11-2',
    ]);
    // 标题优先用网页自己的标题
    expect(rows.some((m) => m.title.startsWith('网页标题-'))).toBe(true);
    expect(await screen.findByText(/抓到 2 篇正文/)).toBeTruthy();
  });

  it('抓不到正文（多半是视频页）时明确说原因和下一步，并且不建材料', async () => {
    extractMock.mockImplementation(async () => ({ text: '请下载客户端观看', title: '视频页' }));
    renderPage();
    await addMicroLesson('https://x.com/video/1');

    fireEvent.click(screen.getByText(/让 App 去抓这 1 个微课的内容/));

    const alert = await screen.findByText(/没抓到正文/);
    expect(alert.textContent).toContain('视频页');
    expect(alert.textContent).toContain('拍照识图');
    expect(await db.materials.count()).toBe(0);
  });

  it('已经抓过的链接不会重复抓（点第二次会说明）', async () => {
    renderPage();
    await addMicroLesson('https://x.com/micro/once');

    fireEvent.click(screen.getByText(/让 App 去抓这 1 个微课的内容/));
    await waitFor(async () => expect(await db.materials.count()).toBe(1), { timeout: 8000 });

    fireEvent.click(screen.getByText(/让 App 去抓这 1 个微课的内容/));
    expect(await screen.findByText(/之前都抓过了/)).toBeTruthy();
    expect(await db.materials.count()).toBe(1);
  });
});
