// @vitest-environment jsdom
/**
 * 导出文件的两条路径都要验。
 *
 * 这条测试特别重要：App 版的导出曾经是静默失败的——
 * Capacitor 的 WebView 不实现下载，<a download> 点下去既没反应也不报错，
 * 而 README 却让用户"换手机前先导出备份"。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { nativeFlag, writeFileMock, shareMock } = vi.hoisted(() => ({
  nativeFlag: { value: false },
  writeFileMock: vi.fn(),
  shareMock: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => nativeFlag.value },
}));
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { writeFile: writeFileMock },
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: shareMock } }));

const { isNativePlatform, saveTextFile } = await import('./save-file');

const FILE = {
  filename: '电工陪练备份-2026-10-05.json',
  content: '{"hello":"世界"}',
  mime: 'application/json',
};

let clicked: HTMLAnchorElement | null = null;

beforeEach(() => {
  nativeFlag.value = false;
  writeFileMock.mockReset();
  shareMock.mockReset();
  clicked = null;

  // jsdom 没有实现 createObjectURL
  const url = URL as unknown as Record<string, unknown>;
  url.createObjectURL = vi.fn(() => 'blob:mock-url');
  url.revokeObjectURL = vi.fn();

  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked = this;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('网页版：走浏览器下载', () => {
  it('用 Blob + a[download] 触发下载，并带上正确的文件名与类型', async () => {
    const result = await saveTextFile(FILE);

    expect(isNativePlatform()).toBe(false);
    expect(result.via).toBe('download');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

    const blob = (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/json');
    expect(await blob.text()).toBe(FILE.content);

    expect(clicked?.download).toBe(FILE.filename);
    expect(clicked?.href).toContain('blob:mock-url');
    // 用完要释放，否则 blob 会一直占着内存
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('CSV 也照走同一条路', async () => {
    const result = await saveTextFile({ ...FILE, filename: '题库.csv', mime: 'text/csv;charset=utf-8' });
    expect(result.via).toBe('download');
    expect(clicked?.download).toBe('题库.csv');
  });
});

describe('App 版：写文件 + 调起系统分享', () => {
  beforeEach(() => {
    nativeFlag.value = true;
    writeFileMock.mockResolvedValue({ uri: 'file:///data/cache/电工陪练备份.json' });
    shareMock.mockResolvedValue({ activityType: '' });
  });

  it('先写进缓存目录，再把文件交给分享面板', async () => {
    const result = await saveTextFile(FILE);

    expect(result.via).toBe('share');
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock.mock.calls[0][0]).toMatchObject({
      path: FILE.filename,
      data: FILE.content,
      directory: 'CACHE',
      encoding: 'utf8',
    });

    expect(shareMock).toHaveBeenCalledTimes(1);
    expect(shareMock.mock.calls[0][0]).toMatchObject({
      title: FILE.filename,
      files: ['file:///data/cache/电工陪练备份.json'],
    });

    // App 版绝不该去碰浏览器那套下载
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(clicked).toBeNull();
  });

  it('分享面板的标题可以自定义', async () => {
    await saveTextFile({ ...FILE, dialogTitle: '保存备份文件' });
    expect(shareMock.mock.calls[0][0].dialogTitle).toBe('保存备份文件');
  });

  it('用户在分享面板取消，返回 cancelled 而不是抛错', async () => {
    shareMock.mockRejectedValue(new Error('Share canceled'));
    const result = await saveTextFile(FILE);
    expect(result).toEqual({ via: 'share', cancelled: true });
  });

  it('真正的写入失败要抛出来（不能悄悄吞掉）', async () => {
    writeFileMock.mockRejectedValue(new Error('存储空间不足'));
    await expect(saveTextFile(FILE)).rejects.toThrow(/存储空间不足/);
  });

  it('非取消失败也要抛出来', async () => {
    shareMock.mockRejectedValue(new Error('没有可分享的应用'));
    await expect(saveTextFile(FILE)).rejects.toThrow(/没有可分享的应用/);
  });
});
