/**
 * 「加书」业务逻辑的测试。
 *
 * 重点在两条：
 *   1) 视觉模型读书皮**一定会出错**（字段名换、漏字段、包代码围栏），
 *      解析必须接得住，并且**看不清就留空、不猜**；
 *   2) 扫码结果分类要严：ISBN 校验位不对就不能当 ISBN 收下。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MicroLesson } from '../db/types';
import {
  buildBookContent,
  classifyScanForBook,
  collectMicroLessonMaterials,
  guessMicroLessonTitle,
  isUsableContent,
  mergeMicroLessons,
  parseCoverReading,
  parseDoubanBookPage,
} from './book';

function micro(url: string, title = '微课', addedAt = 1): MicroLesson {
  return { id: url, url, title, addedAt };
}

describe('读模型返回的书皮信息（一定要容错）', () => {
  it('标准 JSON 直接可用', () => {
    const out = parseCoverReading(
      '{"bookTitle":"电工技术","publisher":"机械工业出版社","editor":"张三","edition":"第3版"}',
    );
    expect(out).toEqual({
      bookTitle: '电工技术',
      publisher: '机械工业出版社',
      editor: '张三',
      edition: '第3版',
    });
  });

  it('被 ``` 包起来、前后带解释文字也能解析', () => {
    const raw = '好的，识别结果如下：\n```json\n{"bookTitle":"PLC应用技术","publisher":"高教出版社"}\n```\n希望有帮助。';
    expect(parseCoverReading(raw).bookTitle).toBe('PLC应用技术');
  });

  it('字段名写成中文（书名/出版社/主编）也认', () => {
    const out = parseCoverReading('{"书名":"低压电工","出版社":"化学工业出版社","主编":"李四"}');
    expect(out.bookTitle).toBe('低压电工');
    expect(out.publisher).toBe('化学工业出版社');
    expect(out.editor).toBe('李四');
  });

  it('作者给成数组时合并成「甲、乙」而不是丢掉', () => {
    expect(parseCoverReading('{"bookTitle":"X","authors":["甲","乙"]}').editor).toBe('甲、乙');
  });

  it('数组里混入空值时只留有效名字', () => {
    expect(parseCoverReading('{"bookTitle":"X","editor":["","丙","丁","戊"]}').editor).toBe('丙、丁');
  });

  it('看不清就留空——不编内容', () => {
    const out = parseCoverReading('{"bookTitle":"电工基础","publisher":"","editor":"   "}');
    expect(out.bookTitle).toBe('电工基础');
    expect(out.publisher).toBeUndefined();
    expect(out.editor).toBeUndefined();
  });

  it('完全不是 JSON 时返回空对象，不抛错', () => {
    expect(parseCoverReading('这张照片看不清')).toEqual({});
    expect(parseCoverReading('')).toEqual({});
    expect(parseCoverReading('{坏掉的 json')).toEqual({});
  });
});

describe('扫到的东西怎么归类', () => {
  it('合法 ISBN → isbn', () => {
    expect(classifyScanForBook('9787111636502')).toEqual({ kind: 'isbn', isbn: '9787111636502' });
  });

  it('校验位不对的 13 位数字 → 不当 ISBN（当普通文本）', () => {
    expect(classifyScanForBook('9787111636507').kind).toBe('unknown');
  });

  it('网址 → 微课', () => {
    expect(classifyScanForBook('https://www.icourse163.org/learn/x')).toEqual({
      kind: 'microLesson',
      url: 'https://www.icourse163.org/learn/x',
    });
  });

  it('其它文本 → unknown（交给用户判断）', () => {
    expect(classifyScanForBook('第11讲 触电急救').kind).toBe('unknown');
  });
});

describe('微课清单去重合并', () => {
  it('同一个网址扫两次只留一条', () => {
    const out = mergeMicroLessons([micro('https://a.com/1')], [micro('https://a.com/1')]);
    expect(out).toHaveLength(1);
  });

  it('占位标题会被后扫到的具体标题替换', () => {
    const out = mergeMicroLessons(
      [micro('https://a.com/1', '微课')],
      [micro('https://a.com/1', '11.1 触电急救')],
    );
    expect(out[0].title).toBe('11.1 触电急救');
  });

  it('已有具体标题不会被占位标题覆盖', () => {
    const out = mergeMicroLessons(
      [micro('https://a.com/1', '11.1 触电急救')],
      [micro('https://a.com/1', '微课')],
    );
    expect(out[0].title).toBe('11.1 触电急救');
  });

  it('不同网址都保留，按加入时间排序', () => {
    const out = mergeMicroLessons(
      [micro('https://a.com/2', '后', 200)],
      [micro('https://a.com/1', '先', 100)],
    );
    expect(out.map((m) => m.url)).toEqual(['https://a.com/1', 'https://a.com/2']);
  });

  it('原来没有清单也能合并', () => {
    expect(mergeMicroLessons(undefined, [micro('https://a.com/1')])).toHaveLength(1);
  });
});

describe('从链接猜默认标题', () => {
  it('取路径最后一段', () => {
    expect(guessMicroLessonTitle('https://x.com/course/11-1.html')).toBe('11-1.html');
  });

  it('只有域名时用域名', () => {
    expect(guessMicroLessonTitle('https://x.com/')).toBe('x.com');
  });

  it('不是网址时给个兜底标题', () => {
    expect(guessMicroLessonTitle('乱七八糟')).toBe('微课');
  });
});

describe('用 ISBN 补全书目（豆瓣，国内能通的那个源）', () => {
  // 真实数据：从 book.douban.com/isbn/9787111589549/ 抓下来裁剪的片段。
  // 起因：用户反馈"ISBN 补全没用" —— 实测原因是原来只用 Open Library / Google Books，
  // 这两个在国内**直接超时**（实测 9 秒无响应），而豆瓣 1.1 秒就返回了完整书目。
  const html = readFileSync(
    join(process.cwd(), 'src/lib/scan/__fixtures__/douban-9787111589549.html'),
    'utf8',
  );

  it('真实豆瓣页面：书名 / 作者 / 出版社 / 出版年 都能解出来', () => {
    const r = parseDoubanBookPage(html);
    expect(r).not.toBeNull();
    expect(r!.bookTitle).toBe('零基础学电工');
    expect(r!.editor).toBe('韩雪涛');
    expect(r!.publisher).toBe('机械工业出版社');
    expect(r!.edition).toBe('2018-2');
  });

  it('JSON-LD 坏掉时，还能从标签和 <title> 兜回来', () => {
    const broken = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '');
    const r = parseDoubanBookPage(broken);
    expect(r!.bookTitle).toBe('零基础学电工'); // 来自 <title>，并去掉"(豆瓣)"
    expect(r!.publisher).toBe('机械工业出版社'); // 来自 #info 标签
  });

  it('不是书目页（没有书名也没有标签）→ 返回 null', () => {
    expect(parseDoubanBookPage('<html><body><p>什么都没有</p></body></html>')).toBeNull();
  });
});

describe('让 App 自己去抓微课内容', () => {
  it('抓到正文的进 ok，标题优先用网页标题', async () => {
    const r = await collectMicroLessonMaterials({
      lessons: [micro('https://x.com/a', '11.1 触电急救')],
      extract: async () => ({ text: 'x'.repeat(300), title: '触电急救 - 出版社资源页' }),
    });
    expect(r.ok).toHaveLength(1);
    expect(r.ok[0].title).toBe('触电急救 - 出版社资源页');
    expect(r.failed).toHaveLength(0);
  });

  it('网页没标题时退回微课自己的标题', async () => {
    const r = await collectMicroLessonMaterials({
      lessons: [micro('https://x.com/a', '11.1 触电急救')],
      extract: async () => ({ text: 'y'.repeat(500) }),
    });
    expect(r.ok[0].title).toBe('11.1 触电急救');
  });

  it('抓到的东西太少 → 不算成功，并告诉用户下一步该干嘛（多半是视频页）', async () => {
    const r = await collectMicroLessonMaterials({
      lessons: [micro('https://x.com/video', '微课视频')],
      extract: async () => ({ text: '请下载客户端观看' }),
    });
    expect(r.ok).toHaveLength(0);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].reason).toContain('视频页');
    expect(r.failed[0].reason).toContain('拍照识图');
  });

  it('单个链接抓失败不影响其他链接，失败原因原样带出', async () => {
    const r = await collectMicroLessonMaterials({
      lessons: [micro('https://x.com/bad', '坏的'), micro('https://x.com/good', '好的')],
      extract: async (url) => {
        if (url.includes('bad')) throw new Error('连不上这个站点');
        return { text: 'z'.repeat(400) };
      },
    });
    expect(r.ok.map((o) => o.lesson.url)).toEqual(['https://x.com/good']);
    expect(r.failed[0].reason).toBe('连不上这个站点');
  });

  it('进度回调按顺序报，最后一定报到总数', async () => {
    const seen: number[] = [];
    await collectMicroLessonMaterials({
      lessons: [micro('https://x.com/1'), micro('https://x.com/2')],
      extract: async () => ({ text: 'a'.repeat(300) }),
      onProgress: (done, total) => seen.push(`${done}/${total}` as unknown as number),
    });
    expect(seen.map(String)).toEqual(['0/2', '1/2', '2/2']);
  });

  it('空清单不炸', async () => {
    const r = await collectMicroLessonMaterials({ lessons: [], extract: async () => ({ text: '' }) });
    expect(r).toEqual({ ok: [], failed: [] });
  });

  it('"内容够不够用"的判定边界', () => {
    expect(isUsableContent('短')).toBe(false);
    expect(isUsableContent('字'.repeat(200))).toBe(true);
    expect(isUsableContent('  ' + '字'.repeat(199) + '  ')).toBe(false);
    expect(isUsableContent('')).toBe(false);
  });
});

describe('组织成材料正文', () => {
  it('含有书名、出版社、主编、ISBN', () => {
    const text = buildBookContent({
      bookTitle: '电工技术',
      publisher: '机械工业出版社',
      editor: '王五',
      edition: '第3版',
      isbn: '9787111636502',
      microLessons: [micro('https://a.com/1', '11.1 触电急救')],
    });
    expect(text).toContain('# 电工技术');
    expect(text).toContain('机械工业出版社');
    expect(text).toContain('王五');
    expect(text).toContain('9787111636502');
    expect(text).toContain('配套微课（共 1 节）');
    expect(text).toContain('11.1 触电急救');
  });

  it('没有微课时明确说明，而不是留空', () => {
    const text = buildBookContent({ bookTitle: '只有书名的书' });
    expect(text).toContain('还没扫到微课二维码');
  });

  it('书名缺失也不崩', () => {
    expect(buildBookContent({} as never)).toContain('未填书名');
  });
});
