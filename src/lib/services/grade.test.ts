/**
 * 判分规则测试。
 *
 * 客观题判分是整个 App 里唯一"绝对不能出错"的地方——它不调用大模型，
 * 用户看到的分就是最终分。所以规则要逐条钉死。
 */
import { describe, expect, it } from 'vitest';
import type { AnswerRecord, Question, QuestionType } from '../db/types';
import { computeScore, gradeObjective, normalizeReportDraft, normalizeScoreRatio, toAnswerArray } from './grade';

function makeQuestion(type: QuestionType, answer: string | string[]): Question {
  return {
    id: `q-${type}`,
    knowledgePointIds: [],
    type,
    stem: '题干',
    answer,
    explanation: '',
    difficulty: 3,
    source: 'ai',
    createdAt: 0,
  };
}

describe('toAnswerArray', () => {
  it('字符串包装成数组，数组原样返回', () => {
    expect(toAnswerArray('A')).toEqual(['A']);
    expect(toAnswerArray(['A', 'B'])).toEqual(['A', 'B']);
  });
});

describe('单选题判分', () => {
  const q = makeQuestion('single', 'A');

  it('选对得分', () => {
    expect(gradeObjective(q, 'A')).toEqual({ isCorrect: true, scoreRatio: 1 });
  });

  it('大小写不敏感', () => {
    expect(gradeObjective(q, 'a').isCorrect).toBe(true);
  });

  it('选错不得分', () => {
    expect(gradeObjective(q, 'B')).toEqual({ isCorrect: false, scoreRatio: 0 });
  });

  it('空作答不得分', () => {
    expect(gradeObjective(q, []).scoreRatio).toBe(0);
  });
});

describe('多选题判分（国内考试惯例：漏选给一半，错选不得分）', () => {
  const q = makeQuestion('multiple', ['A', 'B', 'C']);

  it('全选对拿满分', () => {
    expect(gradeObjective(q, ['C', 'A', 'B'])).toEqual({ isCorrect: true, scoreRatio: 1 });
  });

  it('漏选给一半分，且不算通过', () => {
    const g = gradeObjective(q, ['A', 'B']);
    expect(g.isCorrect).toBe(false);
    expect(g.scoreRatio).toBe(0.5);
  });

  it('只要选错一个就零分', () => {
    expect(gradeObjective(q, ['A', 'B', 'D'])).toEqual({ isCorrect: false, scoreRatio: 0 });
  });

  it('一个没选不给分', () => {
    expect(gradeObjective(q, []).scoreRatio).toBe(0);
  });
});

describe('判断题判分（要兼容各种写法）', () => {
  const q = makeQuestion('judge', '正确');

  it('"正确" 得对', () => {
    expect(gradeObjective(q, '正确').isCorrect).toBe(true);
  });

  it('"对""√""true""T""是" 都算对', () => {
    for (const v of ['对', '√', 'true', 'T', '是', '正确']) {
      expect(gradeObjective(q, v).isCorrect, `写法 ${v} 应该判对`).toBe(true);
    }
  });

  it('"错误""错""×""false" 都算错', () => {
    for (const v of ['错误', '错', '×', 'x', 'false', 'F', '否']) {
      expect(gradeObjective(q, v).isCorrect, `写法 ${v} 应该判错`).toBe(false);
    }
  });

  it('标准答案是"错误"时，答"错"也能判对', () => {
    const q2 = makeQuestion('judge', '错误');
    expect(gradeObjective(q2, '错').isCorrect).toBe(true);
    expect(gradeObjective(q2, '正确').isCorrect).toBe(false);
  });

  it('识别不了的写法不给分', () => {
    expect(gradeObjective(q, '不知道').isCorrect).toBe(false);
  });
});

describe('填空题判分（多空按比例给分）', () => {
  const q = makeQuestion('blank', ['欧姆', '安培']);

  it('全对满分', () => {
    expect(gradeObjective(q, ['欧姆', '安培'])).toEqual({ isCorrect: true, scoreRatio: 1 });
  });

  it('只对一半给一半分', () => {
    const g = gradeObjective(q, ['欧姆', '伏特']);
    expect(g.isCorrect).toBe(false);
    expect(g.scoreRatio).toBe(0.5);
  });

  it('忽略空格与标点', () => {
    expect(gradeObjective(q, [' 欧 姆 ', '安培。']).isCorrect).toBe(true);
  });

  it('一个空支持多种可接受答案（用 ｜ 或 / 分隔）', () => {
    const q2 = makeQuestion('blank', '欧姆｜Ω');
    expect(gradeObjective(q2, ['欧姆']).isCorrect).toBe(true);
    expect(gradeObjective(q2, ['Ω']).isCorrect).toBe(true);
    expect(gradeObjective(q2, ['伏特']).isCorrect).toBe(false);
  });

  it('没作答得 0 分', () => {
    expect(gradeObjective(q, []).scoreRatio).toBe(0);
  });
});

describe('normalizeScoreRatio（模型评分结果的容错）', () => {
  it('标准写法：scoreRatio', () => {
    expect(normalizeScoreRatio({ scoreRatio: 0.7 })).toBeCloseTo(0.7, 5);
    expect(normalizeScoreRatio({ scoreRatio: 1 })).toBe(1);
    expect(normalizeScoreRatio({ scoreRatio: 0 })).toBe(0);
  });

  it('字段名换成正则的别名也认', () => {
    expect(normalizeScoreRatio({ score_ratio: 0.6 })).toBeCloseTo(0.6, 5);
    expect(normalizeScoreRatio({ ratio: 0.4 })).toBeCloseTo(0.4, 5);
    expect(normalizeScoreRatio({ 得分率: 0.9 })).toBeCloseTo(0.9, 5);
  });

  it('得分率写成百分数也能认出来', () => {
    expect(normalizeScoreRatio({ scoreRatio: 70 })).toBeCloseTo(0.7, 5);
    expect(normalizeScoreRatio({ scoreRatio: '85%' })).toBeCloseTo(0.85, 5);
  });

  it('从分步评分求和算出来（最可靠的一条路）', () => {
    expect(
      normalizeScoreRatio({
        breakdown: [
          { point: '公式', got: 4, full: 4 },
          { point: '代入', got: 3, full: 3 },
          { point: '结果', got: 0, full: 3 },
        ],
      }),
    ).toBeCloseTo(0.7, 5);
  });

  it('score + 满分', () => {
    expect(normalizeScoreRatio({ score: 7, maxScore: 10 })).toBeCloseTo(0.7, 5);
    expect(normalizeScoreRatio({ score: 7, total: 10 })).toBeCloseTo(0.7, 5);
    expect(normalizeScoreRatio({ 得分: 7, 满分: 10 })).toBeCloseTo(0.7, 5);
  });

  it('只给一个裸 score 时按量级判断（提示词里明确是 10 分制）', () => {
    expect(normalizeScoreRatio({ score: 0.7 })).toBeCloseTo(0.7, 5); // 已经比率
    expect(normalizeScoreRatio({ score: 7 })).toBeCloseTo(0.7, 5); // 十分制
    expect(normalizeScoreRatio({ score: 70 })).toBeCloseTo(0.7, 5); // 百分制
    expect(normalizeScoreRatio({ score: '7分' })).toBeCloseTo(0.7, 5);
  });

  it('非法或含糊的数值不猜——宁可返回 null 让上层明确报错', () => {
    // 1.5 既不可能是比率（比率 ≤1），也不像一个百分数。
    // 猜"满分 1"或"1.5%"都会给出错误分数，所以拒绝猜测。
    expect(normalizeScoreRatio({ scoreRatio: 1.5 })).toBeNull();
    expect(normalizeScoreRatio({ scoreRatio: -3 })).toBeNull();
    expect(normalizeScoreRatio({ scoreRatio: 120 })).toBeNull();
  });

  it('确实读不出分数时返回 null，而不是默默当成 0 分', () => {
    // 这是这条函数存在的理由：以前 `Number(draft.scoreRatio) || 0` 会把
    // 这些情况统统变成 0 分——学生答对了也拿 0 分。
    expect(normalizeScoreRatio({ comment: '写得不错' })).toBeNull();
    expect(normalizeScoreRatio({ isCorrect: true })).toBeNull();
    expect(normalizeScoreRatio({})).toBeNull();
    expect(normalizeScoreRatio(null)).toBeNull();
    expect(normalizeScoreRatio(undefined)).toBeNull();
    expect(normalizeScoreRatio('0.8')).toBeNull();
    expect(normalizeScoreRatio({ scoreRatio: '不知道' })).toBeNull();
  });
});

describe('normalizeReportDraft（学习报告的容错）', () => {
  const weak = [{ knowledgePointId: 'kp1', name: '串联电路', score: 0.3, severity: 0.8, reason: '正确率低' }];

  it('标准字段原样接上', () => {
    const report = normalizeReportDraft(
      {
        summary: '整体不错',
        mistakes: [{ questionId: 'q1', what: '错在哪', why: '根因', fix: '怎么补' }],
        suggestions: ['先补星三角', '再练互锁'],
      },
      67,
      weak,
    );
    expect(report.score).toBe(67);
    expect(report.summary).toBe('整体不错');
    expect(report.mistakes).toEqual([{ questionId: 'q1', what: '错在哪', why: '根因', fix: '怎么补' }]);
    expect(report.suggestions).toEqual(['先补星三角', '再练互锁']);
    expect(report.weakPoints).toEqual(weak);
  });

  it('字段名换了也能认（总评 / 错因 / 建议）', () => {
    const report = normalizeReportDraft(
      {
        总评: '换名字的总评',
        错因: [{ 题目: 'q2', 错在哪: '概念混了', 根因: '没理解', 怎么补: '画图' }],
        建议: ['多做题'],
      },
      50,
      weak,
    );
    expect(report.summary).toBe('换名字的总评');
    expect(report.mistakes[0]).toMatchObject({ questionId: 'q2', what: '概念混了', why: '没理解', fix: '画图' });
    expect(report.suggestions).toEqual(['多做题']);
  });

  it('总评缺失时给出明确说明，而不是一块空白卡片', () => {
    const report = normalizeReportDraft({}, 0, weak);
    expect(report.summary).toContain('没有给出总评');
    expect(report.mistakes).toEqual([]);
    expect(report.suggestions).toEqual([]);
  });

  it('建议写成对象数组时也能取出文本', () => {
    const report = normalizeReportDraft({ suggestions: [{ text: '甲' }, { 建议: '乙' }, '丙', '', null] }, 1, []);
    expect(report.suggestions).toEqual(['甲', '乙', '丙']);
  });

  it('脏数据不会抛错：非对象、缺字段、错类型都兜住', () => {
    expect(normalizeReportDraft(null, 1, []).summary).toContain('没有给出总评');
    expect(normalizeReportDraft('一段字符串', 1, []).mistakes).toEqual([]);
    expect(normalizeReportDraft({ mistakes: '不是数组', suggestions: 123 }, 1, []).mistakes).toEqual([]);
    // 空对象条目会被过滤掉
    expect(normalizeReportDraft({ mistakes: [{}, { what: '有内容' }] }, 1, []).mistakes).toHaveLength(1);
  });
});

describe('computeScore（百分制换算）', () => {
  const single = makeQuestion('single', 'A'); // 权重 2
  const judge = makeQuestion('judge', '正确'); // 权重 1

  const answers: AnswerRecord[] = [
    { questionId: single.id, userAnswer: 'A', isCorrect: true, scoreRatio: 1 },
    { questionId: judge.id, userAnswer: '错误', isCorrect: false, scoreRatio: 0 },
  ];

  it('按题型权重加权，换算成百分制', () => {
    // 得 2 分 / 共 3 分 = 66.67% -> 67
    expect(computeScore([single, judge], answers)).toBe(67);
  });

  it('全对是 100 分', () => {
    const allRight = answers.map((a) => ({ ...a, isCorrect: true, scoreRatio: 1 }));
    expect(computeScore([single, judge], allRight)).toBe(100);
  });

  it('一题没答是 0 分', () => {
    expect(computeScore([single, judge], [])).toBe(0);
  });

  it('部分给分（主观题得分率）会体现到总分里', () => {
    const calc = makeQuestion('calc', '答案'); // 权重 10
    const half: AnswerRecord[] = [{ questionId: calc.id, userAnswer: '答案', scoreRatio: 0.5 }];
    expect(computeScore([calc], half)).toBe(50);
  });

  it('没有题目时返回 0，不除零', () => {
    expect(computeScore([], [])).toBe(0);
  });
});
