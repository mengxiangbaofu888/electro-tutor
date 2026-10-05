/**
 * 题库 CSV 导入导出的测试。
 *
 * 重点守两件事：
 *  1. CSV 解析要够宽容——用户从各处拿到的表格，列名、列序、引号、逗号都不该让它翻车
 *  2. **导出的文件必须能被自己导回来**（往返一致），否则"导出备份"就是假的安全感
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db, newId } from '../db/db';
import type { KnowledgePoint, Outline, Question } from '../db/types';
import {
  exportQuestionsCsv,
  importQuestionsCsv,
  parseAnswer,
  parseCsvRows,
  parseQuestionsCsv,
  renderAnswer,
  toCsvText,
} from './bank';

async function clearAll() {
  await db.transaction('rw', [db.outlines, db.knowledgePoints, db.questions], async () => {
    await db.outlines.clear();
    await db.knowledgePoints.clear();
    await db.questions.clear();
  });
}

async function makeOutline(title = '测试大纲'): Promise<Outline> {
  const outline: Outline = {
    id: newId(),
    title,
    track: 'fundamental',
    materialIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.outlines.put(outline);
  return outline;
}

async function makePoint(outlineId: string, name: string): Promise<KnowledgePoint> {
  const point: KnowledgePoint = {
    id: newId(),
    outlineId,
    name,
    summary: '',
    importance: 4,
    order: 0,
    depth: 1,
  };
  await db.knowledgePoints.put(point);
  return point;
}

/* ============================== 底层 CSV ============================== */

describe('CSV 底层读写', () => {
  it('处理引号包裹、字段内逗号、换行与双引号转义', () => {
    const rows = parseCsvRows('a,b\n"x,1","他说""你好"""\n"多\n行",z');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x,1', '他说"你好"'],
      ['多\n行', 'z'],
    ]);
  });

  it('去掉 BOM，忽略全空行，兼容 CRLF', () => {
    expect(parseCsvRows('\ufeffa,b\r\n\r\n,,\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('导出时给特殊字符加引号，并带 UTF-8 BOM（Excel 打开中文不乱码）', () => {
    const csv = toCsvText([['含,逗号', '带"引号"', '换\n行']]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"含,逗号"');
    expect(csv).toContain('"带""引号"""');
    expect(csv).toContain('"换\n行"');
  });
});

/* ============================== 答案归一化 ============================== */

describe('答案解析', () => {
  it('单选题取第一个字母（大小写与"选A"都能认）', () => {
    expect(parseAnswer('single', 'A')).toBe('A');
    expect(parseAnswer('single', 'a')).toBe('A');
    expect(parseAnswer('single', '选 A')).toBe('A');
  });

  it('多选题提取所有字母、去重排序（AB / B,A / AAB 都认）', () => {
    expect(parseAnswer('multiple', 'AB')).toEqual(['A', 'B']);
    expect(parseAnswer('multiple', 'B,A')).toEqual(['A', 'B']);
    expect(parseAnswer('multiple', 'AAB')).toEqual(['A', 'B']);
  });

  it('判断题把各种写法归一成"正确/错误"', () => {
    for (const v of ['正确', '对', '√', 'T', 'true', '是']) {
      expect(parseAnswer('judge', v), `写法 ${v}`).toBe('正确');
    }
    for (const v of ['错误', '错', '×', 'F', 'false', '否']) {
      expect(parseAnswer('judge', v), `写法 ${v}`).toBe('错误');
    }
  });

  it('填空题多个空用分号分隔，单个空内的多种写法保留', () => {
    expect(parseAnswer('blank', '欧姆；安培')).toEqual(['欧姆', '安培']);
    expect(parseAnswer('blank', '欧姆;安培')).toEqual(['欧姆', '安培']);
    expect(parseAnswer('blank', '欧姆')).toBe('欧姆');
    expect(parseAnswer('blank', '欧姆|Ω')).toBe('欧姆|Ω');
  });
});

/* ============================== 表头驱动解析 ============================== */

describe('题库 CSV 解析', () => {
  const CHINESE_CSV = [
    '题型,题干,选项A,选项B,选项C,选项D,答案,解析,难度,知识点',
    '单选题,"一段导体两端电压 12V，电阻 4Ω，电流是多少？",3A,48A,0.33A,8A,A,由欧姆定律 I=U/R=3A,2,欧姆定律及其应用',
    '判断题,串联电路中各处电流都相等。,,,,,正确,串联只有一条通路,1,串联电路的计算',
  ].join('\n');

  it('能读中文表头，正确拆出各题型', () => {
    const { questions, warnings } = parseQuestionsCsv(CHINESE_CSV);
    expect(warnings.filter((w) => w.includes('缺少'))).toEqual([]);
    expect(questions).toHaveLength(2);

    const [single, judge] = questions;
    expect(single.type).toBe('single');
    expect(single.options).toEqual([
      { key: 'A', text: '3A' },
      { key: 'B', text: '48A' },
      { key: 'C', text: '0.33A' },
      { key: 'D', text: '8A' },
    ]);
    expect(single.answer).toBe('A');
    expect(single.difficulty).toBe(2);
    expect(single.knowledgeNames).toEqual(['欧姆定律及其应用']);

    expect(judge.type).toBe('judge');
    expect(judge.answer).toBe('正确');
    expect(judge.options).toBeUndefined();
    expect(judge.explanation).toBe('串联只有一条通路');
  });

  it('列顺序随意、用英文表头也能读', () => {
    const csv = ['knowledge,answer,stem,type,difficulty,optionA,optionB', '欧姆定律,B,题目一,single,4,甲,乙'].join('\n');
    const { questions } = parseQuestionsCsv(csv);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ type: 'single', stem: '题目一', answer: 'B', difficulty: 4 });
    expect(questions[0].options).toEqual([
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' },
    ]);
    expect(questions[0].knowledgeNames).toEqual(['欧姆定律']);
  });

  it('题干里带逗号、引号、换行都不会拆错', () => {
    const csv = ['题干,答案,type', '"他问：""电流""是多少？,再算一遍",A,single'].join('\n');
    const { questions } = parseQuestionsCsv(csv);
    expect(questions).toHaveLength(1);
    expect(questions[0].stem).toBe('他问："电流"是多少？,再算一遍');
  });

  it('找不到表头时给出可照做的中文提示', () => {
    const { questions, warnings } = parseQuestionsCsv('第一行随便写点什么\n第二行也是');
    expect(questions).toHaveLength(0);
    expect(warnings[0]).toContain('题干');
    expect(warnings[0]).toContain('题型,题干');
  });

  it('没有答案列时提示，但题目照样解析出来', () => {
    const csv = ['题干,type', '一道没有答案的题,single'].join('\n');
    const { questions, warnings } = parseQuestionsCsv(csv);
    expect(questions).toHaveLength(1);
    expect(warnings.some((w) => w.includes('答案'))).toBe(true);
  });

  it('空表头行之后没有数据时给出提示', () => {
    const { questions, warnings } = parseQuestionsCsv('题干,答案');
    expect(questions).toHaveLength(0);
    expect(warnings.some((w) => w.includes('有效题目行'))).toBe(true);
  });
});

/* ============================== 往返一致 ============================== */

describe('导出的 CSV 能被自己导回来', () => {
  beforeEach(clearAll);

  it('四种题型的题干、选项、答案、解析、难度、知识点都能对上', async () => {
    const outline = await makeOutline();
    const point = await makePoint(outline.id, '欧姆定律');

    const base = { outlineId: outline.id, knowledgePointIds: [point.id], source: 'ai' as const };
    const originals: Question[] = [
      {
        ...base,
        id: newId(),
        type: 'single',
        stem: '题干含,逗号与"引号"',
        options: [
          { key: 'A', text: '甲' },
          { key: 'B', text: '乙' },
        ],
        answer: 'B',
        explanation: '解析一',
        difficulty: 4,
        createdAt: 1,
      },
      {
        ...base,
        id: newId(),
        type: 'multiple',
        stem: '多选题干',
        options: [
          { key: 'A', text: '甲' },
          { key: 'B', text: '乙' },
          { key: 'C', text: '丙' },
        ],
        answer: ['A', 'C'],
        explanation: '解析二',
        difficulty: 3,
        createdAt: 2,
      },
      { ...base, id: newId(), type: 'judge', stem: '判断题干', answer: '错误', explanation: '解析三', difficulty: 1, createdAt: 3 },
      { ...base, id: newId(), type: 'blank', stem: '填空 ____ 与 ____', answer: ['欧姆', '安培'], explanation: '解析四', difficulty: 2, createdAt: 4 },
    ];
    await db.questions.bulkPut(originals);

    // 导出
    const { csv, count } = await exportQuestionsCsv(outline.id);
    expect(count).toBe(4);

    // 导进另一份大纲
    const target = await makeOutline('导入目标');
    const result = await importQuestionsCsv({ text: csv, outlineId: target.id });
    expect(result.imported).toBe(4);
    // 目标大纲里没有"欧姆定律"这个知识点，应该被自动建出来
    expect(result.createdPoints).toBe(1);

    const imported = await db.questions.where('outlineId').equals(target.id).toArray();
    const byStem = new Map(imported.map((q) => [q.stem, q]));

    const single = byStem.get('题干含,逗号与"引号"');
    expect(single?.type).toBe('single');
    expect(single?.options).toEqual([
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' },
    ]);
    expect(single?.answer).toBe('B');
    expect(single?.explanation).toBe('解析一');
    expect(single?.difficulty).toBe(4);
    expect(single?.knowledgePointIds).toHaveLength(1);

    expect(byStem.get('多选题干')?.answer).toEqual(['A', 'C']);
    expect(byStem.get('判断题干')?.answer).toBe('错误');
    expect(byStem.get('填空 ____ 与 ____')?.answer).toEqual(['欧姆', '安培']);
  });

  it('导入时能按名称匹配到已有知识点，不会重复创建', async () => {
    const outline = await makeOutline();
    await makePoint(outline.id, '欧姆定律及其应用');
    const csv = ['题型,题干,答案,知识点', '单选题,题目甲,A,欧姆定律'].join('\n'); // 简称，应模糊匹配到"欧姆定律及其应用"

    const result = await importQuestionsCsv({ text: csv, outlineId: outline.id });
    expect(result.imported).toBe(1);
    expect(result.createdPoints).toBe(0);
    expect(await db.knowledgePoints.where('outlineId').equals(outline.id).count()).toBe(1);

    const q = (await db.questions.toArray())[0];
    expect(q.knowledgePointIds).toHaveLength(1);
  });

  it('没有答案的题会被标出来，不会静默通过', async () => {
    const outline = await makeOutline();
    const csv = ['题型,题干,答案', '单选题,没有答案的题,'].join('\n');
    const result = await importQuestionsCsv({ text: csv, outlineId: outline.id });
    expect(result.imported).toBe(1);
    expect(result.warnings.some((w) => w.includes('没有答案'))).toBe(true);
  });

  it('目标大纲不存在时报错，而不是把数据写散', async () => {
    await expect(importQuestionsCsv({ text: '题干,答案\n题,A', outlineId: '不存在' })).rejects.toThrow(/大纲不存在/);
  });
});

/* ============================== 渲染答案 ============================== */

describe('renderAnswer', () => {
  it('多选题拼成字母串，填空题用分号连接', () => {
    expect(renderAnswer('multiple', ['A', 'C'])).toBe('AC');
    expect(renderAnswer('blank', ['欧姆', '安培'])).toBe('欧姆；安培');
    expect(renderAnswer('single', 'B')).toBe('B');
  });
});
