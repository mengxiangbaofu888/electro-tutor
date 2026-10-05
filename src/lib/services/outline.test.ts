/**
 * 大纲增删改的测试。
 *
 * 重点在删除时的数据完整性——这类问题平时不显，但一旦发生就会留下一堆
 * 用户既看不懂、又清不掉的脏数据：
 *   · 删了大纲，题目还在题库里飘着（没有知识点归属 → 掌握度永远统计不到，
 *     而界面又没有"题目管理"入口）
 *   · 删了知识点，题目上留下指向不存在节点的悬空 id（界面显示"未知知识点"）
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db, newId } from '../db/db';
import type {
  ID,
  KnowledgePoint,
  Material,
  MistakeNote,
  Outline,
  Question,
  TrackId,
} from '../db/types';
import { createMastery } from '../srs';
import {
  createOutlineFromTitles,
  deleteOutline,
  materialSections,
  normalizeOutlineNodes,
  removeKnowledgePoint,
  titlesToNodes,
} from './outline';

/* ------------------------------ 造数据 ------------------------------ */

async function clearAll() {
  await db.transaction(
    'rw',
    [db.outlines, db.knowledgePoints, db.questions, db.mastery, db.mistakes, db.papers],
    async () => {
      await db.outlines.clear();
      await db.knowledgePoints.clear();
      await db.questions.clear();
      await db.mastery.clear();
      await db.mistakes.clear();
      await db.papers.clear();
    },
  );
}

async function makeOutline(title: string, track: TrackId = 'fundamental'): Promise<Outline> {
  const outline: Outline = {
    id: newId(),
    title,
    track,
    materialIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.outlines.put(outline);
  return outline;
}

async function makePoint(
  outlineId: ID,
  name: string,
  options: { parentId?: ID; order?: number; depth?: number } = {},
): Promise<KnowledgePoint> {
  const point: KnowledgePoint = {
    id: newId(),
    outlineId,
    parentId: options.parentId,
    name,
    summary: '',
    importance: 3,
    order: options.order ?? 0,
    depth: options.depth ?? 1,
  };
  await db.knowledgePoints.put(point);
  return point;
}

async function makeQuestion(outlineId: ID, pointIds: ID[], stem: string): Promise<Question> {
  const question: Question = {
    id: newId(),
    outlineId,
    knowledgePointIds: pointIds,
    type: 'single',
    stem,
    options: [{ key: 'A', text: '甲' }],
    answer: 'A',
    explanation: '',
    difficulty: 2,
    source: 'ai',
    createdAt: Date.now(),
  };
  await db.questions.put(question);
  return question;
}

async function makeMistake(questionId: ID): Promise<MistakeNote> {
  const note: MistakeNote = {
    id: newId(),
    questionId,
    wrongCount: 1,
    lastWrongAt: Date.now(),
    resolved: false,
    streak: 0,
  };
  await db.mistakes.put(note);
  return note;
}

async function makeMastery(pointId: ID): Promise<void> {
  await db.mastery.put(createMastery(pointId, Date.now()));
}

beforeEach(clearAll);

/* ============================== 删除大纲 ============================== */

describe('删除大纲', () => {
  it('连同知识点、掌握度、题目、错题记录一起清掉', async () => {
    const outline = await makeOutline('要被删掉的大纲');
    const point = await makePoint(outline.id, '欧姆定律');
    const question = await makeQuestion(outline.id, [point.id], '题干');
    const note = await makeMistake(question.id);
    await makeMastery(point.id);

    await deleteOutline(outline.id);

    expect(await db.outlines.get(outline.id)).toBeUndefined();
    expect(await db.knowledgePoints.where('outlineId').equals(outline.id).count()).toBe(0);
    expect(await db.mastery.get(point.id)).toBeUndefined();
    expect(await db.questions.get(question.id)).toBeUndefined();
    expect(await db.mistakes.get(note.id)).toBeUndefined();
  });

  it('不会误伤别的大纲', async () => {
    const doomed = await makeOutline('要被删掉的');
    const keeper = await makeOutline('要留下的', 'plc');

    const doomedPoint = await makePoint(doomed.id, '旧知识点');
    const keeperPoint = await makePoint(keeper.id, '梯形图');
    const doomedQuestion = await makeQuestion(doomed.id, [doomedPoint.id], '旧题');
    const keeperQuestion = await makeQuestion(keeper.id, [keeperPoint.id], '要留的题');
    await makeMistake(doomedQuestion.id);
    const keeperNote = await makeMistake(keeperQuestion.id);
    await makeMastery(doomedPoint.id);
    await makeMastery(keeperPoint.id);

    await deleteOutline(doomed.id);

    expect(await db.outlines.count()).toBe(1);
    expect(await db.outlines.get(keeper.id)).toBeTruthy();
    expect(await db.knowledgePoints.get(keeperPoint.id)).toBeTruthy();
    expect(await db.questions.get(keeperQuestion.id)).toBeTruthy();
    expect(await db.mastery.get(keeperPoint.id)).toBeTruthy();
    expect(await db.mistakes.get(keeperNote.id)).toBeTruthy();
  });

  it('删一份没有题的大纲也不会出错', async () => {
    const outline = await makeOutline('空大纲');
    await makePoint(outline.id, '孤立知识点');

    await expect(deleteOutline(outline.id)).resolves.toBeUndefined();
    expect(await db.outlines.count()).toBe(0);
    expect(await db.knowledgePoints.count()).toBe(0);
  });

  it('删不存在的大纲不会抛错', async () => {
    await expect(deleteOutline('根本没有这个 id')).resolves.toBeUndefined();
  });
});

/* ============================== 模型输出的容错 ============================== */

describe('normalizeOutlineNodes（模型返回的知识点树容错）', () => {
  it('标准字段原样保留', () => {
    const { nodes, dropped } = normalizeOutlineNodes([
      { name: '欧姆定律', summary: '说明', importance: 5, children: [{ name: '串联计算', summary: '子说明', importance: 4 }] },
    ]);
    expect(dropped).toBe(0);
    expect(nodes).toEqual([
      { name: '欧姆定律', summary: '说明', importance: 5, children: [{ name: '串联计算', summary: '子说明', importance: 4 }] },
    ]);
  });

  it('节点名写成 title / 名称 也能认，说明写成 description 也能认', () => {
    const { nodes } = normalizeOutlineNodes([
      { title: '甲', description: '说明甲', weight: 4 },
      { 名称: '乙' },
    ]);
    expect(nodes.map((n) => n.name)).toEqual(['甲', '乙']);
    expect(nodes[0].summary).toBe('说明甲');
    expect(nodes[0].importance).toBe(4);
    expect(nodes[1].importance).toBe(3); // 缺省给 3
  });

  it('子节点写成 sub / items / 子项 也能认', () => {
    expect(normalizeOutlineNodes([{ name: '甲', sub: [{ name: '子甲' }] }]).nodes[0].children?.[0].name).toBe('子甲');
    expect(normalizeOutlineNodes([{ name: '甲', items: [{ name: '子甲' }] }]).nodes[0].children?.[0].name).toBe('子甲');
    expect(normalizeOutlineNodes([{ name: '甲', 子项: [{ name: '子甲' }] }]).nodes[0].children?.[0].name).toBe('子甲');
  });

  it('没有名称的节点被丢弃并计数——不再产出无名知识点', () => {
    const { nodes, dropped } = normalizeOutlineNodes([
      { name: '有名字' },
      { summary: '只有说明没有名字' },
      null,
      '字符串节点',
      { name: '   ' },
    ]);
    expect(nodes.map((n) => n.name)).toEqual(['有名字']);
    expect(dropped).toBe(4);
  });

  it('重要度被夹在 1~5；非数字给默认 3', () => {
    const { nodes } = normalizeOutlineNodes([
      { name: 'a', importance: 99 },
      { name: 'b', importance: -2 },
      { name: 'c', importance: '不知道' },
      { name: 'd', importance: 3.6 },
    ]);
    expect(nodes.map((n) => n.importance)).toEqual([5, 1, 3, 4]);
  });

  it('章这一层漏了名字时，有名字的小节点提升上来而不是整棵子树被吞掉', () => {
    const { nodes, dropped } = normalizeOutlineNodes([
      { summary: '概述，忘了写名字', items: [{ name: '欧姆定律' }, { name: '基尔霍夫定律' }] },
    ]);
    // 无名的"章"被丢弃并计数，说明跟实际丢的东西对得上（内容没丢）
    expect(dropped).toBe(1);
    expect(nodes.map((n) => n.name)).toEqual(['欧姆定律', '基尔霍夫定律']);
  });

  it('嵌套两层都漏名字时，计数与提升都对', () => {
    const { nodes, dropped } = normalizeOutlineNodes([
      { items: [{ items: [{ name: '深处的知识点' }] }] },
    ]);
    expect(dropped).toBe(2);
    expect(nodes.map((n) => n.name)).toEqual(['深处的知识点']);
  });

  it('非数组输入返回空结果而不是抛错', () => {
    expect(normalizeOutlineNodes(undefined)).toEqual({ nodes: [], dropped: 0 });
    expect(normalizeOutlineNodes('abc')).toEqual({ nodes: [], dropped: 0 });
    expect(normalizeOutlineNodes({ name: 'x' })).toEqual({ nodes: [], dropped: 0 });
  });
});

/* ============================== 用现成标题直接建大纲 ============================== */

describe('材料自带的标题清单（决定能不能不调模型）', () => {
  it('慕课那种存了 sections 的，直接用', () => {
    const m = { id: '1', title: 't', sections: ['第1讲 电路', '第2讲 电磁'] } as Material;
    expect(materialSections(m)).toEqual(['第1讲 电路', '第2讲 电磁']);
  });

  it('教材那种没 sections 的，用扫到的微课标题', () => {
    const m = {
      id: '2',
      title: '电工技术',
      book: {
        bookTitle: '电工技术',
        microLessons: [
          { id: 'a', url: 'u1', title: '11.1 触电急救', addedAt: 1 },
          { id: 'b', url: 'u2', title: '11.2 电气火灾', addedAt: 2 },
        ],
      },
    } as unknown as Material;
    expect(materialSections(m)).toEqual(['11.1 触电急救', '11.2 电气火灾']);
  });

  it('什么都没有的材料返回空（这类只能让 AI 归纳）', () => {
    expect(materialSections({ id: '3', title: 't' } as Material)).toEqual([]);
    expect(
      materialSections({ id: '4', title: 't', book: { bookTitle: 'x' } } as unknown as Material),
    ).toEqual([]);
  });

  it('空白标题被过滤掉', () => {
    expect(materialSections({ id: '5', title: 't', sections: ['甲', '  ', ''] } as Material)).toEqual([
      '甲',
    ]);
  });
});

describe('把标题变成大纲节点（纯函数，不调模型）', () => {
  it('按原样铺开，顺序不变、去掉空白、去掉重复', () => {
    const nodes = titlesToNodes(['11.1 触电急救', ' 11.2 电气火灾 ', '', '11.1 触电急救']);
    expect(nodes.map((n) => n.name)).toEqual(['11.1 触电急救', '11.2 电气火灾']);
    expect(nodes.every((n) => n.importance === 3)).toBe(true);
  });

  it('**不自己编章节名**：标题里没有的层级就不造（编错了比不编更糟）', () => {
    const nodes = titlesToNodes(['11.1 触电急救', '11.2 电气火灾']);
    expect(nodes.every((n) => !n.children || n.children.length === 0)).toBe(true);
  });
});

describe('直接建大纲', () => {
  it('标题够多就真的建出来（大纲 + 知识点都入库，且不调模型）', async () => {
    const res = await createOutlineFromTitles({
      title: '慕课：电工技术',
      track: 'fundamental',
      titles: ['11.1 触电急救', '11.2 电气火灾', '第十一讲 单元测试'],
    });
    expect(res.points.map((p) => p.name)).toEqual([
      '11.1 触电急救',
      '11.2 电气火灾',
      '第十一讲 单元测试',
    ]);
    expect(await db.outlines.count()).toBe(1);
    expect(await db.knowledgePoints.count()).toBe(3);
    // 这个测试里根本没配任何模型；能跑通就证明这条路没走 AI
  });

  it('标题太少（不足两个）时明确说清楚该怎么办', async () => {
    await expect(
      createOutlineFromTitles({ title: 'x', track: 'plc', titles: ['只有一个'] }),
    ).rejects.toThrow(/至少要两个/);
  });
});

/* ============================== 删除知识点 ============================== */

describe('删除知识点', () => {
  it('连同子节点一起删，掌握度也清掉', async () => {
    const outline = await makeOutline('大纲');
    const parent = await makePoint(outline.id, '欧姆定律', { order: 0 });
    const child = await makePoint(outline.id, '串联计算', { parentId: parent.id, order: 1, depth: 2 });
    const grandChild = await makePoint(outline.id, '分压', { parentId: child.id, order: 2, depth: 3 });
    const other = await makePoint(outline.id, '并联计算', { order: 3 });

    await makeMastery(parent.id);
    await makeMastery(child.id);
    await makeMastery(grandChild.id);
    await makeMastery(other.id);

    await removeKnowledgePoint(parent.id);

    for (const p of [parent, child, grandChild]) {
      expect(await db.knowledgePoints.get(p.id), `${p.name} 应该被删掉`).toBeUndefined();
      expect(await db.mastery.get(p.id)).toBeUndefined();
    }
    // 无关的兄弟节点要留下
    expect(await db.knowledgePoints.get(other.id)).toBeTruthy();
    expect(await db.mastery.get(other.id)).toBeTruthy();
  });

  it('题目保留，但会摘掉指向被删知识点的引用', async () => {
    const outline = await makeOutline('大纲');
    const doomed = await makePoint(outline.id, '要被删的点');
    const keeper = await makePoint(outline.id, '要留下的点', { order: 1 });

    // 一道只挂被删点，一道两个点都挂
    const onlyDoomed = await makeQuestion(outline.id, [doomed.id], '只挂被删点');
    const both = await makeQuestion(outline.id, [doomed.id, keeper.id], '两个点都挂');

    await removeKnowledgePoint(doomed.id);

    const a = await db.questions.get(onlyDoomed.id);
    const b = await db.questions.get(both.id);
    // 题本身不能丢——用户可能只是重整大纲，题是花了 token 生成的
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a?.knowledgePointIds).toEqual([]);
    expect(b?.knowledgePointIds).toEqual([keeper.id]);
    // 不能再留下指向不存在节点的悬空 id
    expect(await db.knowledgePoints.get(doomed.id)).toBeUndefined();
  });

  it('不会动别的大纲里的知识点和题目', async () => {
    const outline = await makeOutline('甲');
    const other = await makeOutline('乙', 'plc');
    const point = await makePoint(outline.id, '甲的点');
    const otherPoint = await makePoint(other.id, '乙的点');
    const otherQuestion = await makeQuestion(other.id, [otherPoint.id], '乙的题');

    await removeKnowledgePoint(point.id);

    expect(await db.knowledgePoints.get(otherPoint.id)).toBeTruthy();
    expect((await db.questions.get(otherQuestion.id))?.knowledgePointIds).toEqual([otherPoint.id]);
  });

  it('删不存在的知识点不会抛错', async () => {
    await expect(removeKnowledgePoint('根本没有这个 id')).resolves.toBeUndefined();
  });
});
