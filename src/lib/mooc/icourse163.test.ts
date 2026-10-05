/**
 * 慕课整门抓取的测试。
 *
 * 这里不联网：网络部分通过注入一个假的 MoocHttp 来测**编排逻辑**
 * （先拿 cookie、再取目录、再取题库、出错时给什么提示）。
 * 真实接口早就用真课实测过了：一门电工课抓到 61 个课时 + 1570 道题。
 *
 * 重点盯两件事：
 *   1) 各种形态的链接都要能认出 courseId / tid，认不出要给**可操作**的提示；
 *   2) 题型和答案的映射必须和 bank.ts 的规则一致（复用它的 parseAnswer）。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildCourseMaterialContent,
  extractCourseTitle,
  fetchMoocCourse,
  mapQuestionType,
  moocQuestionsToRows,
  normalizeMoocQuestion,
  parseCourseUrl,
  stripHtml,
  type HttpResult,
  type MoocHttp,
} from './icourse163';

/* ------------------------------ 链接解析 ------------------------------ */

describe('认课程链接', () => {
  it('learn 链接（带 #/learn/content 和 tid）', () => {
    const r = parseCourseUrl(
      'https://www.icourse163.org/learn/CZMEC-1001754242?tid=1488467453#/learn/content',
    );
    expect(r).toEqual({ courseId: 'CZMEC-1001754242', termId: '1488467453' });
  });

  it('course 链接也认', () => {
    expect(parseCourseUrl('https://www.icourse163.org/course/CZMEC-1001754242?tid=1488467453')).toEqual({
      courseId: 'CZMEC-1001754242',
      termId: '1488467453',
    });
  });

  it('没有 tid 时照样返回 courseId（由上层提示用户补 tid）', () => {
    expect(parseCourseUrl('https://www.icourse163.org/course/ABC-123')).toEqual({
      courseId: 'ABC-123',
      termId: undefined,
    });
  });

  it('不是慕课链接 → null', () => {
    expect(parseCourseUrl('https://www.bilibili.com/video/BV1xx')).toBeNull();
    expect(parseCourseUrl('随便写的')).toBeNull();
    expect(parseCourseUrl('')).toBeNull();
  });
});

/* ------------------------------ 文本清洗 ------------------------------ */

describe('HTML 清洗', () => {
  it('去标签、还原实体、br 转换行', () => {
    expect(stripHtml('<p>电压&nbsp;U</p><br/>单位 V')).toBe('电压 U\n单位 V');
  });

  it('压掉多余空行与连续空格（题干/解析里留一个换行就够）', () => {
    expect(stripHtml('A   B\n\n\n\nC')).toBe('A B\nC');
  });

  it('空值不炸', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
  });
});

/* ------------------------------ 题型映射 ------------------------------ */

describe('题型映射（实测：1单选 2多选 3填空 4判断）', () => {
  it('四种都认', () => {
    expect(mapQuestionType(1)).toBe('single');
    expect(mapQuestionType(2)).toBe('multiple');
    expect(mapQuestionType(3)).toBe('blank');
    expect(mapQuestionType(4)).toBe('judge');
  });

  it('没见过的题型返回 null（不硬塞成单选）', () => {
    expect(mapQuestionType(9)).toBeNull();
    expect(mapQuestionType(undefined)).toBeNull();
  });
});

/* ------------------------------ 题目规范化 ------------------------------ */

const singleRaw = {
  id: 1390965330,
  type: 1,
  plainTextTitle: '电路中某两点间的电位差称为( )。',
  optionDtos: [
    { content: '<p>电源</p>', answer: false },
    { content: '<p>电流</p>', answer: false },
    { content: '<p>电压</p>', answer: true },
    { content: '<p>电阻</p>', answer: false },
  ],
  stdAnswer: null,
  score: 5,
};

describe('题目规范化', () => {
  it('单选：认出发答案的那个选项', () => {
    const q = normalizeMoocQuestion(singleRaw, '电工技术')!;
    expect(q.type).toBe('single');
    expect(q.stem).toBe('电路中某两点间的电位差称为( )。');
    expect(q.options?.map((o) => o.key)).toEqual(['A', 'B', 'C', 'D']);
    expect(q.options?.[2].text).toBe('电压');
    expect(q.answer).toBe('C');
    expect(q.pointName).toBe('电工技术');
  });

  it('多选：多个正确选项都要收', () => {
    const q = normalizeMoocQuestion({
      id: 1,
      type: 2,
      title: '带电灭火应使用____',
      optionDtos: [
        { content: '水流喷射', answer: false },
        { content: '泡沫灭火器', answer: false },
        { content: '二氧化碳灭火', answer: true },
        { content: '干粉灭火器', answer: true },
      ],
    })!;
    expect(q.type).toBe('multiple');
    expect(q.answer).toEqual(['C', 'D']);
  });

  it('判断：正确/错误映射成我们统一的写法', () => {
    const q = normalizeMoocQuestion({
      id: 2,
      type: 4,
      title: '电位是没有方向的。',
      optionDtos: [
        { content: '正确', answer: true },
        { content: '错误', answer: false },
      ],
    })!;
    expect(q.type).toBe('judge');
    expect(q.answer).toBe('正确');
  });

  it('填空：按 ; 和 ；拆成多个空', () => {
    const q = normalizeMoocQuestion({
      id: 3,
      type: 3,
      title: '基尔霍夫电压定律简称为____，其内容为：沿任一____各段电压的____恒等于零。',
      stdAnswer: 'KVL;回路；代数和；∑U=0',
      optionDtos: [],
    })!;
    expect(q.type).toBe('blank');
    expect(q.answer).toEqual(['KVL', '回路', '代数和', '∑U=0']);
    expect(q.options).toBeUndefined();
  });

  it('题目自带知识点名时优先用它', () => {
    const q = normalizeMoocQuestion({ ...singleRaw, nodeNameList: ['<b>电路基础</b>', '别的'] })!;
    expect(q.pointName).toBe('电路基础');
  });

  it('没有答案的题一律丢掉（答不了或一定判错，进了库只会添乱）', () => {
    expect(normalizeMoocQuestion({ id: 4, type: 1, title: '题目', optionDtos: [] })).toBeNull();
    expect(normalizeMoocQuestion({ id: 5, type: 3, title: '题目', stdAnswer: '' })).toBeNull();
  });

  it('题干为空的丢掉', () => {
    expect(normalizeMoocQuestion({ id: 6, type: 4, title: '   ', optionDtos: [{ content: '正确', answer: true }] })).toBeNull();
  });

  it('乱七八糟的输入不炸', () => {
    expect(normalizeMoocQuestion(null)).toBeNull();
    expect(normalizeMoocQuestion('字符串')).toBeNull();
    expect(normalizeMoocQuestion({ type: 99 })).toBeNull();
  });
});

/* ------------------------------ 转成导入行 ------------------------------ */

describe('转成题库导入行', () => {
  it('表头 + 每道题一行，选项进 A~D 列，数组答案用 ; 连接', () => {
    const rows = moocQuestionsToRows([
      normalizeMoocQuestion(singleRaw, '电工技术')!,
      normalizeMoocQuestion({
        id: 3,
        type: 3,
        title: '填空',
        stdAnswer: '甲;乙',
      })!,
    ]);
    expect(rows[0]).toEqual([
      '题型',
      '题干',
      '选项A',
      '选项B',
      '选项C',
      '选项D',
      '答案',
      '解析',
      '难度',
      '知识点',
    ]);
    expect(rows[1][0]).toBe('单选');
    expect(rows[1][1]).toContain('电位差');
    expect(rows[1][6]).toBe('C');
    expect(rows[1][9]).toBe('电工技术');
    expect(rows[2][0]).toBe('填空');
    expect(rows[2][6]).toBe('甲;乙');
  });
});

/* ------------------------------ 材料正文 ------------------------------ */

describe('课程 → 材料正文', () => {
  it('含课程名、课时数、课时清单', () => {
    const text = buildCourseMaterialContent({
      termId: '1488467453',
      courseId: 'CZMEC-1001754242',
      courseTitle: '电工技术',
      lessons: [
        { id: '1', name: '11.1 触电与触电急救' },
        { id: '2', name: '11.2 电气火灾与扑救' },
      ],
      questions: [],
    });
    expect(text).toContain('# 电工技术');
    expect(text).toContain('课时数：2');
    expect(text).toContain('1. 11.1 触电与触电急救');
    expect(text).toContain('2. 11.2 电气火灾与扑救');
  });
});

describe('从课程页里捞标题', () => {
  it('优先取页面里的 name 字段', () => {
    expect(extractCourseTitle('<script>{"name":"电工技术","termId":"1"}</script>')).toBe('电工技术');
  });

  it('退而取 <title>', () => {
    expect(extractCourseTitle('<title>电工技术_中国大学MOOC(慕课)</title>')).toBe('电工技术');
  });

  it('都没有就返回空串', () => {
    expect(extractCourseTitle('<html></html>')).toBe('');
  });
});

/* ------------------------------ 抓取编排（用假 HTTP） ------------------------------ */

function makeHttp(handlers: {
  page?: Partial<HttpResult>;
  lessons?: unknown;
  quiz?: unknown;
  onPost?: (url: string) => void;
}): MoocHttp {
  return {
    request: async (req) => {
      if (req.method === 'GET') {
        return {
          status: 200,
          text: '<title>电工技术_中国大学MOOC(慕课)</title>',
          setCookie: ['NTESSTUDYSI=abc123; Path=/'],
          ...handlers.page,
        };
      }
      handlers.onPost?.(req.url);
      const isQuiz = req.url.includes('Quiz');
      return {
        status: 200,
        text: JSON.stringify({
          code: 0,
          result: isQuiz ? (handlers.quiz ?? [singleRaw]) : (handlers.lessons ?? [{ id: 7, name: '11.1 触电急救' }]),
        }),
        setCookie: [],
      };
    },
  };
}

describe('抓一门课（编排逻辑）', () => {
  const url = 'https://www.icourse163.org/learn/CZMEC-1001754242?tid=1488467453';

  it('正常抓到：标题、课时、题目都在，并且先取 cookie 再调接口', async () => {
    const progress: string[] = [];
    const course = await fetchMoocCourse({ url, http: makeHttp({}), onProgress: (m) => progress.push(m) });
    expect(course.courseTitle).toBe('电工技术');
    expect(course.termId).toBe('1488467453');
    expect(course.lessons).toEqual([{ id: '7', name: '11.1 触电急救', releaseTime: undefined }]);
    expect(course.questions).toHaveLength(1);
    expect(course.questions[0].answer).toBe('C');
    expect(progress.some((p) => p.includes('课时目录'))).toBe(true);
    expect(progress.some((p) => p.includes('抓取完成'))).toBe(true);
  });

  it('接口地址里带上了 csrfKey（就是 cookie 的值）', async () => {
    const seen: string[] = [];
    await fetchMoocCourse({ url, http: makeHttp({ onPost: (u) => seen.push(u) }) });
    expect(seen.length).toBe(2);
    expect(seen.every((u) => u.includes('csrfKey=abc123'))).toBe(true);
    expect(seen.some((u) => u.includes('sortType=1'))).toBe(true);
  });

  it('链接缺 tid → 提示怎么补，而不是干瞪眼', async () => {
    await expect(
      fetchMoocCourse({ url: 'https://www.icourse163.org/course/ABC-1', http: makeHttp({}) }),
    ).rejects.toThrow(/tid=/);
  });

  it('不是慕课链接 → 明确说不是', async () => {
    await expect(
      fetchMoocCourse({ url: 'https://www.bilibili.com/video/BV1', http: makeHttp({}) }),
    ).rejects.toThrow(/中国大学MOOC/);
  });

  it('拿不到 cookie → 明确报错（不静默返回空课程）', async () => {
    await expect(
      fetchMoocCourse({ url, http: makeHttp({ page: { setCookie: [] } }) }),
    ).rejects.toThrow(/会话标识|接口/);
  });

  it('接口返回业务错误码 → 把服务端的 message 带出来', async () => {
    const http: MoocHttp = {
      request: async (req) =>
        req.method === 'GET'
          ? { status: 200, text: '', setCookie: ['NTESSTUDYSI=abc;'] }
          : { status: 200, text: JSON.stringify({ code: -1, message: '001:系统异常' }), setCookie: [] },
    };
    await expect(fetchMoocCourse({ url, http })).rejects.toThrow(/001:系统异常/);
  });

  it('接口返回的不是 JSON → 提示可能改了接口', async () => {
    const http: MoocHttp = {
      request: async (req) =>
        req.method === 'GET'
          ? { status: 200, text: '', setCookie: ['NTESSTUDYSI=abc;'] }
          : { status: 200, text: '<html>502</html>', setCookie: [] },
    };
    await expect(fetchMoocCourse({ url, http })).rejects.toThrow(/不是 JSON|改接口/);
  });

  it('没有答案的题会被跳过，并在进度里如实说明', async () => {
    const progress: string[] = [];
    const course = await fetchMoocCourse({
      url,
      http: makeHttp({ quiz: [singleRaw, { id: 99, type: 1, title: '没答案的题', optionDtos: [] }] }),
      onProgress: (m) => progress.push(m),
    });
    expect(course.questions).toHaveLength(1);
    expect(progress.some((p) => p.includes('跳过'))).toBe(true);
  });

  it('课程页 HTTP 失败 → 报状态码并提示检查链接', async () => {
    const http = makeHttp({ page: { status: 404, text: '' } });
    await expect(fetchMoocCourse({ url, http })).rejects.toThrow(/404/);
  });

  it('onProgress 是可选参数（不传也不能炸）', async () => {
    const spy = vi.fn();
    const course = await fetchMoocCourse({ url, http: makeHttp({}) });
    expect(course.questions.length).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
