// @vitest-environment jsdom
/**
 * 图片压缩的测试。
 *
 * 背景：识图之前是把原图直接转 base64 发出去，最多 6 张手机照片就是
 * 几十 MB 的请求体，基本必然失败。这里守住压缩后的尺寸与"该跳就跳"。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compressImageToDataUrl, compressImages, formatBytes, targetSize } from './image';

/* ------------------------------ 造一个可控的图片环境 ------------------------------ */

let bitmap: { width: number; height: number } | null = { width: 4000, height: 3000 };
let canvasUsed: { width: number; height: number } | null = null;
let toDataUrlResult = 'data:image/jpeg;base64,MOCK';

beforeEach(() => {
  bitmap = { width: 4000, height: 3000 };
  canvasUsed = null;
  toDataUrlResult = 'data:image/jpeg;base64,MOCK';

  // jsdom 没有 createImageBitmap
  (globalThis as unknown as Record<string, unknown>).createImageBitmap = vi.fn(async () => {
    if (!bitmap) throw new Error('无法解码');
    return bitmap;
  });

  // jsdom 的 canvas 没有 2d 上下文实现，这里替身化，顺便记录画布尺寸
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    canvasUsed = { width: this.width, height: this.height };
    return { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => toDataUrlResult);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeFile(bytes: number, name = 'photo.jpg', type = 'image/jpeg'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/* ============================== 尺寸计算 ============================== */

describe('targetSize', () => {
  it('本来就够小就原样返回', () => {
    expect(targetSize(800, 600, 1280)).toEqual({ width: 800, height: 600 });
    expect(targetSize(1280, 720, 1280)).toEqual({ width: 1280, height: 720 });
  });

  it('横图按宽缩，长边严格不超过上限', () => {
    expect(targetSize(4000, 3000, 1280)).toEqual({ width: 1280, height: 960 });
  });

  it('竖图按高缩', () => {
    expect(targetSize(3000, 4000, 1280)).toEqual({ width: 960, height: 1280 });
  });

  it('极端比例与四舍五入都不会让长边超过上限', () => {
    for (const [w, h] of [
      [2000, 1000],
      [1001, 1000],
      [1, 9999],
      [9999, 1],
      [1281, 1281],
      [3333, 1111],
    ]) {
      const out = targetSize(w, h, 1280);
      expect(Math.max(out.width, out.height), `${w}x${h}`).toBeLessThanOrEqual(1280);
      expect(out.width).toBeGreaterThan(0);
      expect(out.height).toBeGreaterThan(0);
    }
  });

  it('非法尺寸不抛错，返回 1x1', () => {
    expect(targetSize(0, 0, 1280)).toEqual({ width: 1, height: 1 });
    expect(targetSize(-5, 100, 1280)).toEqual({ width: 1, height: 1 });
    expect(targetSize(Number.NaN, 100, 1280)).toEqual({ width: 1, height: 1 });
  });
});

/* ============================== 压缩流程 ============================== */

describe('compressImageToDataUrl', () => {
  it('大图会被缩到长边 1280 并转成 JPEG', async () => {
    const file = makeFile(5 * 1024 * 1024);
    const out = await compressImageToDataUrl(file);

    expect(out).toBe('data:image/jpeg;base64,MOCK');
    expect(canvasUsed).toEqual({ width: 1280, height: 960 });
  });

  it('又小又不超限的图片原样返回，不做二次压缩', async () => {
    bitmap = { width: 600, height: 400 };
    const file = makeFile(100 * 1024, 'small.png', 'image/png');

    const out = await compressImageToDataUrl(file);

    expect(out.startsWith('data:image/png;base64,')).toBe(true);
    expect(canvasUsed).toBeNull();
  });

  it('体积小但分辨率超限的图仍要缩', async () => {
    bitmap = { width: 4000, height: 2000 };
    const file = makeFile(50 * 1024, 'wide.png', 'image/png');

    await compressImageToDataUrl(file);

    expect(canvasUsed).toEqual({ width: 1280, height: 640 });
  });

  it('可以自定义上限与质量', async () => {
    const file = makeFile(5 * 1024 * 1024);
    await compressImageToDataUrl(file, { maxEdge: 800 });
    expect(canvasUsed).toEqual({ width: 800, height: 600 });
  });

  it('解码失败时退回原图，而不是让整个识图流程挂掉', async () => {
    bitmap = null; // 让 createImageBitmap 抛错
    const file = makeFile(5 * 1024 * 1024, 'broken.jpg', 'image/jpeg');

    // jsdom 里 <img> 既不 load 也不 error，靠超时兜底——
    // 没有超时的话这个 Promise 永远不会 settle，识图会一直卡在"正在压缩…"
    const out = await compressImageToDataUrl(file, { loadTimeoutMs: 50 });

    expect(out.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(canvasUsed).toBeNull();
  });

  it('canvas 被污染（toDataURL 抛错）时也退回原图', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
      throw new Error('Tainted canvas');
    });
    const file = makeFile(5 * 1024 * 1024);

    const out = await compressImageToDataUrl(file);

    expect(out.startsWith('data:image/jpeg;base64,')).toBe(true);
  });
});

/* ============================== 批量与格式化 ============================== */

describe('compressImages', () => {
  it('逐张压缩并统计体积', async () => {
    const files = [makeFile(4 * 1024 * 1024), makeFile(3 * 1024 * 1024)];

    const result = await compressImages(files);

    expect(result.dataUrls).toHaveLength(2);
    expect(result.originalBytes).toBe(7 * 1024 * 1024);
    // MOCK 的 base64 很短，压缩后体积应远小于原图
    expect(result.compressedBytes).toBeLessThan(result.originalBytes);
  });
});

describe('formatBytes', () => {
  it('按量级给出可读的单位', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(4.5 * 1024 * 1024)).toBe('4.5 MB');
  });
});
