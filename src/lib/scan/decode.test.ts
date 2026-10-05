// @vitest-environment jsdom
/**
 * 二维码 / 条形码解码的测试。
 *
 * 关键点：**用真二维码测**。
 * 测试里用 `qrcode` 现场生成一个二维码的模块矩阵，把它渲染成像素，
 * 再喂给我们的解码函数——解出来的文本必须和生成时的一模一样。
 * 这样测的是"真的能把码读出来"，而不是"函数被调用过"。
 *
 * （顺带说明为什么不让 AI 看图说内容：大模型看到二维码会编一个像真的网址，
 *   微课链接、ISBN 错一个字符就全废，所以必须真解码。）
 */
import QRCode from 'qrcode';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyScan,
  decodeImageData,
  decodeLuminance,
  formatIsbn,
  invertLuminance,
  isbn10Valid,
  isbn13Valid,
  normalizeIsbn,
  rgbaToLuminance,
  rotate90Luminance,
  decodeDataUrl,
} from './decode';

/** 把一个真二维码渲染成灰度像素图（含 4 模块静区，模拟干净拍照） */
function qrToLuminance(text: string, scale = 4, quiet = 4) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const dim = (size + quiet * 2) * scale;
  const lum = new Uint8ClampedArray(dim * dim).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!qr.modules.data[y * size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          lum[((y + quiet) * scale + dy) * dim + (x + quiet) * scale + dx] = 0;
        }
      }
    }
  }
  return { lum, dim };
}

describe('真二维码能被解出来', () => {
  it('解出来的文本和生成时完全一致', () => {
    const url = 'https://www.icourse163.org/learn/CZMEC-1001754242?tid=1488467453';
    const { lum, dim } = qrToLuminance(url);
    const hit = decodeLuminance(lum, dim, dim);
    expect(hit, '没能解出二维码').toBeTruthy();
    expect(hit!.text).toBe(url);
    expect(hit!.format).toBe('QR_CODE');
  });

  it('中文内容也能解（微课标题、书里的链接说明）', () => {
    const text = '电工技术 第11讲 触电急救 微课';
    const { lum, dim } = qrToLuminance(text);
    expect(decodeLuminance(lum, dim, dim)?.text).toBe(text);
  });

  it('深色背景上的浅色码（反相）也能解', () => {
    const url = 'https://example.com/micro/11-1';
    const { lum, dim } = qrToLuminance(url);
    expect(decodeLuminance(invertLuminance(lum), dim, dim)?.text).toBe(url);
  });

  it('整张图被拍歪 90° 也能解', () => {
    const url = 'https://example.com/micro/rotated';
    const { lum, dim } = qrToLuminance(url);
    const rotated = rotate90Luminance(lum, dim, dim);
    expect(decodeLuminance(rotated, dim, dim)?.text).toBe(url);
  });
});

describe('解不出来时不能崩、也不能瞎猜', () => {
  it('空白图返回 null（而不是抛异常或编一个结果）', () => {
    const lum = new Uint8ClampedArray(200 * 200).fill(255);
    expect(decodeLuminance(lum, 200, 200)).toBeNull();
  });

  it('随机噪点返回 null', () => {
    const lum = new Uint8ClampedArray(120 * 120);
    for (let i = 0; i < lum.length; i++) lum[i] = (i * 7919) % 256;
    expect(decodeLuminance(lum, 120, 120)).toBeNull();
  });

  it('尺寸不合法时返回 null', () => {
    expect(decodeLuminance(new Uint8ClampedArray(0), 0, 0)).toBeNull();
    expect(decodeLuminance(new Uint8ClampedArray(10), 100, 100)).toBeNull();
  });
});

describe('像素换算', () => {
  it('RGBA → 灰度：白 255 / 黑 0 / 纯红约 76', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
    const lum = rgbaToLuminance(rgba, 3, 1);
    expect(lum[0]).toBe(255);
    expect(lum[1]).toBe(0);
    expect(lum[2]).toBe(76); // 0.299 * 255
  });

  it('反相两次回到原样', () => {
    const src = new Uint8ClampedArray([0, 128, 255]);
    const back = invertLuminance(invertLuminance(src));
    expect(Array.from(back)).toEqual([0, 128, 255]);
  });

  it('转 90° 四次回到原样', () => {
    // 2x3 的图（宽2 高3）
    const src = new Uint8ClampedArray([1, 2, 3, 4, 5, 6]);
    const r1 = rotate90Luminance(src, 2, 3); // → 3x2
    const r2 = rotate90Luminance(r1, 3, 2); // → 2x3
    const r3 = rotate90Luminance(r2, 2, 3); // → 3x2
    const r4 = rotate90Luminance(r3, 3, 2); // → 2x3（回到原样）
    expect(Array.from(r4)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('从 ImageData / dataURL 走一遍（照片进 App 的真实路径）', () => {
  it('ImageData 里的二维码能解出来', () => {
    const url = 'https://example.com/from-imagedata';
    const { lum, dim } = qrToLuminance(url);
    // 展开成 RGBA，灰度值同时填进 R/G/B
    const rgba = new Uint8ClampedArray(dim * dim * 4);
    for (let i = 0; i < lum.length; i++) {
      rgba[i * 4] = lum[i];
      rgba[i * 4 + 1] = lum[i];
      rgba[i * 4 + 2] = lum[i];
      rgba[i * 4 + 3] = 255;
    }
    const fakeImageData = { data: rgba, width: dim, height: dim } as ImageData;
    expect(decodeImageData(fakeImageData)?.text).toBe(url);
  });

  it('dataURL 路径：画到 canvas 再取像素，能解出二维码', async () => {
    const url = 'https://example.com/from-dataurl';
    const { lum, dim } = qrToLuminance(url);

    // jsdom 里没有 canvas 实现，这里把 Image 与 canvas 的 2D 上下文都打桩，
    // 验证的是"我们这条取像素的链路接得对不对"。
    const rgba = new Uint8ClampedArray(dim * dim * 4);
    for (let i = 0; i < lum.length; i++) {
      rgba[i * 4] = lum[i];
      rgba[i * 4 + 1] = lum[i];
      rgba[i * 4 + 2] = lum[i];
      rgba[i * 4 + 3] = 255;
    }
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = dim;
        naturalHeight = dim;
        width = dim;
        height = dim;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_v: string) {
          setTimeout(() => this.onload?.(), 0);
        }
      },
    );
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({
        drawImage: () => undefined,
        getImageData: () => ({ data: rgba, width: dim, height: dim }),
      } as unknown as CanvasRenderingContext2D);

    try {
      const hit = await decodeDataUrl('data:image/png;base64,AAAA');
      expect(hit?.text).toBe(url);
    } finally {
      getContext.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe('ISBN：宁可说不是，也不存一个错的', () => {
  // 下面的号码是**校验位正确**的样例：
  //   978711163650 的前 12 位按 1/3 交替加权 = 108 → 校验位 = (10-8)%10 = 2
  //   711163650 的 9 位按 10..2 加权 = 184 → 184%11=8 → 校验位 = 3
  it('合法 ISBN-13（978 开头、校验位正确）通过', () => {
    expect(isbn13Valid('9787111636502')).toBe(true);
    expect(normalizeIsbn('9787111636502')).toBe('9787111636502');
  });

  it('条码里带连字符/空格也能认', () => {
    expect(normalizeIsbn('978-7-111-63650-2')).toBe('9787111636502');
    expect(normalizeIsbn(' 978 7111 636502 ')).toBe('9787111636502');
  });

  it('校验位错 → null（不猜、不纠正）', () => {
    expect(normalizeIsbn('9787111636507')).toBeNull();
  });

  it('不是书（不以 978/979 开头）→ null', () => {
    expect(normalizeIsbn('6901234567892')).toBeNull();
  });

  it('ISBN-10 合法通过、非法拒绝', () => {
    expect(isbn10Valid('7111636503')).toBe(true);
    expect(normalizeIsbn('7111636503')).toBe('7111636503');
    expect(isbn10Valid('7111636509')).toBe(false);
    expect(normalizeIsbn('7111636509')).toBeNull();
  });

  it('ISBN-10 末位 X 的处理', () => {
    expect(isbn10Valid('080442957X')).toBe(true);
    expect(normalizeIsbn('080442957X')).toBe('080442957X');
  });

  it('不是号码的文本 → null', () => {
    expect(normalizeIsbn('https://example.com')).toBeNull();
    expect(normalizeIsbn('')).toBeNull();
  });

  it('显示成分组形式', () => {
    expect(formatIsbn('9787111636502')).toBe('978-7-111-63650-2');
  });
});

describe('扫到的东西是哪一类', () => {
  it('ISBN 条码 / 网址 / 其他文本', () => {
    expect(classifyScan('9787111636502')).toBe('isbn');
    expect(classifyScan('https://www.icourse163.org/learn/x')).toBe('url');
    expect(classifyScan('第11讲 触电急救')).toBe('text');
  });
});
