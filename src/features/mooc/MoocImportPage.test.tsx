// @vitest-environment jsdom
/**
 * 「慕课整门导入」页的交互测试。
 *
 * 盯三件事：
 *   1) 网页版（没有原生通道）必须**明确说要装 APK**，而不是报一个看不懂的跨域错误；
 *   2) 抓取失败时把服务端的错误原样带给用户（不然用户不知道发生了什么）；
 *   3) 挑题 → 导入这条链路真的把题写进题库，并且是按课时名建知识点。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../lib/db/db';
import type { HttpResult, MoocHttp } from '../../lib/mooc/icourse163';

const { MoocImportPage } = await import('./MoocImportPage');

/** 一门"假课"：两个课时 + 4 种题型各一道 */
const LESSONS = [
  { id: 11, name: '11.1 触电与触电急救' },
  { id: 12, name: '11.2 电气火灾与扑救' },
];
const QUIZ = [
  {
    id: 101,
    type: 1,
    plainTextTitle: '电路中某两点间的电位差称为( )。',
    optionDtos: [
      { content: '电源', answer: false },
      { content: '电流', answer: false },
      { content: '电压', answer: true },
      { content: '电阻', answer: false },
    ],
    nodeNameList: ['触电与触电急救'],
  },
  {
    id: 102,
    type: 4,
    plainTextTitle: '电位是没有方向的。',
    optionDtos: [
      { content: '正确', answer: true },
      { content: '错误', answer: false },
    ],
    nodeNameList: ['触电与触电急救'],
  },
];

function makeHttp(overrides: { lessons?: unknown; quiz?: unknown; failPost?: string } = {}): MoocHttp {
  return {
    request: async (req): Promise<HttpResult> => {
      if (req.method === 'GET') {
        return {
          status: 200,
          text: '<title>电工技术_中国大学MOOC(慕课)</title>',
          setCookie: ['NTESSTUDYSI=csrf-abc; Path=/'],
        };
      }
      if (overrides.failPost) {
        return { status: 200, text: JSON.stringify({ code: -1, message: overrides.failPost }), setCookie: [] };
      }
      const isQuiz = req.url.includes('Quiz');
      return {
        status: 200,
        text: JSON.stringify({
          code: 0,
          result: isQuiz ? (overrides.quiz ?? QUIZ) : (overrides.lessons ?? LESSONS),
        }),
        setCookie: [],
      };
    },
  };
}

const LINK = 'https://www.icourse163.org/learn/CZMEC-1001754242?tid=1488467453';

beforeEach(async () => {
  await db.transaction('rw', [db.materials, db.outlines, db.knowledgePoints, db.questions], async () => {
    await db.materials.clear();
    await db.outlines.clear();
    await db.knowledgePoints.clear();
    await db.questions.clear();
  });
});

afterEach(cleanup);

function renderPage(http: MoocHttp | null) {
  return render(
    <MemoryRouter>
      <MoocImportPage http={http} />
    </MemoryRouter>,
  );
}

/** 粘链接并抓取 */
async function grab(http: MoocHttp | null, link = LINK) {
  renderPage(http);
  fireEvent.change(screen.getByPlaceholderText('https://www.icourse163.org/learn/…?tid=…'), {
    target: { value: link },
  });
  fireEvent.click(screen.getByText('抓取这门课'));
  await screen.findByText(/抓到|打不开|不像|缺少|没能|报错|HTTP/);
}

describe('慕课整门导入', () => {
  it('网页版（没有原生通道）：明确提示要装 APK，而不是报跨域错误', async () => {
    renderPage(null);
    fireEvent.change(screen.getByPlaceholderText('https://www.icourse163.org/learn/…?tid=…'), {
      target: { value: LINK },
    });
    fireEvent.click(screen.getByText('抓取这门课'));
    const alert = await screen.findByText(/慕课抓取要用 App（APK）版/);
    expect(alert).toBeTruthy();
  });

  it('抓到后显示课程名、课时清单和题目数', async () => {
    await grab(makeHttp());
    expect(await screen.findByText('📚 电工技术')).toBeTruthy();
    expect(screen.getByText(/11\.1 触电与触电急救/)).toBeTruthy();
    expect(screen.getByText(/抓到 2 个课时、2 道自测题/)).toBeTruthy();
  });

  it('默认全选，可以取消单题；选中的数量会实时显示', async () => {
    await grab(makeHttp());
    await screen.findByText('📝 挑要导入的题');
    expect(screen.getByText(/已选 2 \/ 2/)).toBeTruthy();

    // 取消第一题（点题干所在的那张卡片里的复选框）
    const card = screen.getByText('电路中某两点间的电位差称为( )。').closest('label') as HTMLElement;
    fireEvent.click(within(card).getByRole('checkbox'));
    await waitFor(() => expect(screen.getByText(/已选 1 \/ 2/)).toBeTruthy());
  });

  it('按题型筛选：只显示该题型', async () => {
    await grab(makeHttp());
    await screen.findByText('📝 挑要导入的题');
    fireEvent.click(screen.getByText(/^判断 1$/));
    await waitFor(() => expect(screen.queryByText(/电位差/)).toBeNull());
    expect(screen.getByText('电位是没有方向的。')).toBeTruthy();
  });

  it('关键词搜索能缩小范围', async () => {
    await grab(makeHttp());
    await screen.findByText('📝 挑要导入的题');
    fireEvent.change(screen.getByPlaceholderText('例如：星三角 / 触电 / 万用表'), {
      target: { value: '电位差' },
    });
    await waitFor(() => expect(screen.queryByText('电位是没有方向的。')).toBeNull());
    expect(screen.getByText(/电位差/)).toBeTruthy();
  });

  it('导入选中的题：写进题库，并按课时名建出知识点', async () => {
    await grab(makeHttp());
    await screen.findByText('📝 挑要导入的题');
    fireEvent.click(screen.getByText(/导入选中的 2 道题/));

    await waitFor(async () => expect(await db.questions.count()).toBe(2), { timeout: 8000 });
    const questions = await db.questions.toArray();
    expect(questions.map((q) => q.type).sort()).toEqual(['judge', 'single']);
    const single = questions.find((q) => q.type === 'single')!;
    expect(single.answer).toBe('C');
    expect(single.source).toBe('imported');

    // 知识点按题目自带的节点名建出来了，并且题目挂到了它上面
    const points = await db.knowledgePoints.toArray();
    expect(points.map((p) => p.name)).toContain('触电与触电急救');
    expect(single.knowledgePointIds.length).toBe(1);

    // 课程本身也存成了一条材料，方便之后生成大纲
    const materials = await db.materials.toArray();
    expect(materials[0].title).toBe('慕课：电工技术');
    expect(materials[0].content).toContain('11.2 电气火灾与扑救');
  });

  it('只导入选中的那一部分（取消的不会进库）', async () => {
    await grab(makeHttp());
    await screen.findByText('📝 挑要导入的题');
    const card = screen.getByText('电路中某两点间的电位差称为( )。').closest('label') as HTMLElement;
    fireEvent.click(within(card).getByRole('checkbox'));
    await waitFor(() => expect(screen.getByText(/已选 1 \/ 2/)).toBeTruthy());

    fireEvent.click(screen.getByText(/导入选中的 1 道题/));
    await waitFor(async () => expect(await db.questions.count()).toBe(1), { timeout: 8000 });
    const q = (await db.questions.toArray())[0];
    expect(q.type).toBe('judge');
  });

  it('服务端报错时把原文带出来（用户才知道发生了什么）', async () => {
    await grab(makeHttp({ failPost: '001:系统异常' }));
    expect(await screen.findByText(/001:系统异常/)).toBeTruthy();
  });

  it('链接里没有 tid 时，提示怎么补，而不是笼统说失败', async () => {
    await grab(makeHttp(), 'https://www.icourse163.org/course/CZMEC-1001754242');
    // 注意：字段提示里也有 tid=，所以这里断言整句，避免匹配到多个元素
    expect(await screen.findByText(/链接里缺少 tid=/)).toBeTruthy();
  });

  it('空链接点抓取：提示先粘链接', async () => {
    renderPage(makeHttp());
    fireEvent.click(screen.getByText('抓取这门课'));
    expect(await screen.findByText(/先把课程链接粘进来/)).toBeTruthy();
  });
});
