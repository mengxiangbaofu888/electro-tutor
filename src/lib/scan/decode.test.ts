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
  cropLuminance,
  decodeImageData,
  decodeLuminance,
  formatIsbn,
  invertLuminance,
  isbn10Valid,
  isbn13Valid,
  normalizeIsbn,
  rgbaToLuminance,
  rotate90Luminance,
  scaleUpLuminance,
  tileRanges,
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
    expect(decodeLuminance(lum, 200, 200, { timeBudgetMs: 800 })).toBeNull();
  });

  it('随机噪点返回 null', () => {
    const lum = new Uint8ClampedArray(120 * 120);
    for (let i = 0; i < lum.length; i++) lum[i] = (i * 7919) % 256;
    expect(decodeLuminance(lum, 120, 120, { timeBudgetMs: 800 })).toBeNull();
  });

  it('时间预算真的生效：没有码的图不会让用户一直等', () => {
    // 500x500 噪点，没有任何码；给 150ms 预算就必须在 150ms 附近放弃
    const lum = new Uint8ClampedArray(500 * 500);
    for (let i = 0; i < lum.length; i++) lum[i] = (i * 2654435761) % 256;
    const t0 = Date.now();
    const hit = decodeLuminance(lum, 500, 500, { timeBudgetMs: 150 });
    const spent = Date.now() - t0;
    expect(hit).toBeNull();
    // 允许一次尝试的超出量，但绝不该跑成几秒
    expect(spent).toBeLessThan(2500);
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

describe('分块解码：对付"码在整张照片里太小"', () => {
  it('切块带重叠，且都落在图内', () => {
    const tiles = tileRanges(1000, 800, 2, 0.25);
    expect(tiles).toHaveLength(4);
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.x + t.width).toBeLessThanOrEqual(1000);
      expect(t.y + t.height).toBeLessThanOrEqual(800);
    }
    // 相邻块之间必须有重叠，否则码正好被切在边界上就永远解不出来
    const right = tiles.find((t) => t.x > 0)!;
    expect(right.x).toBeLessThan(500);
  });

  it('裁块取的是正确的像素', () => {
    // 4x3 的图，值 = 行号*10 + 列号
    const src = new Uint8ClampedArray(12);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) src[y * 4 + x] = y * 10 + x;
    const crop = cropLuminance(src, 4, 3, { x: 1, y: 1, width: 2, height: 2 });
    expect(Array.from(crop)).toEqual([11, 12, 21, 22]);
  });

  it('放大是最近邻复制，不引入新值', () => {
    const up = scaleUpLuminance(new Uint8ClampedArray([1, 2, 3, 4]), 2, 2, 2);
    expect(up.width).toBe(4);
    expect(up.height).toBe(4);
    expect(Array.from(up.lum.slice(0, 4))).toEqual([1, 1, 2, 2]);
    expect(Array.from(up.lum.slice(4, 8))).toEqual([1, 1, 2, 2]);
    expect(new Set(Array.from(up.lum))).toEqual(new Set([1, 2, 3, 4]));
  });

  it('二维码只占大图一角时（模拟拍整张封底）依然能解出来', () => {
    const url = 'http://weixin.qq.com/r/SMALL-CODE-TEST';
    const qr = qrToLuminance(url, 3, 2); // 小尺寸二维码
    const big = 1400;
    const canvas = new Uint8ClampedArray(big * big).fill(255);
    const ox = 980; // 放到右侧偏上，模拟封底上的小码
    const oy = 210;
    for (let y = 0; y < qr.dim; y++) {
      for (let x = 0; x < qr.dim; x++) {
        canvas[(oy + y) * big + (ox + x)] = qr.lum[y * qr.dim + x];
      }
    }
    const hit = decodeLuminance(canvas, big, big);
    expect(hit, '小码没解出来').toBeTruthy();
    expect(hit!.text).toBe(url);
  });
});

describe('真照片回归：用户拍的《零基础学电工》条码', () => {
  it('从真实照片里解出 ISBN 并通过校验', async () => {
    // 注意：jsdom 环境下 import.meta.url 是 http 协议，fileURLToPath 会拒绝，
    // 所以用 cwd 拼路径（vitest 的工作目录就是项目根）。
    const { join } = await import('node:path');
    const { Jimp } = (await import('jimp')) as unknown as {
      Jimp: {
        read: (
          p: string,
        ) => Promise<{ bitmap: { width: number; height: number; data: Uint8Array } }>;
      };
    };
    const path = join(process.cwd(), 'src', 'lib', 'scan', '__fixtures__', 'isbn-barcode.jpg');
    const img = await Jimp.read(path);
    const bm = img.bitmap;
    const hit = decodeLuminance(rgbaToLuminance(bm.data, bm.width, bm.height), bm.width, bm.height);
    expect(hit, '真照片没解出条码').toBeTruthy();
    expect(hit!.format).toBe('EAN_13');
    expect(hit!.text).toBe('9787111589549');
    expect(normalizeIsbn(hit!.text)).toBe('9787111589549');
    expect(formatIsbn(hit!.text)).toBe('978-7-111-58954-9');
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
