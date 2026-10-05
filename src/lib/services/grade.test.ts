/**
 * 判分规则测试。
 *
 * 客观题判分是整个 App 里唯一"绝对不能出错"的地方——它不调用大模型，
 * 用户看到的分就是最终分。所以规则要逐条钉死。
 */
import { describe, expect, it } from 'vitest';
import type { AnswerRecord, Question, QuestionType } from '../db/types';
import { computeScore, gradeObjective, toAnswerArray } from './grade';

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
