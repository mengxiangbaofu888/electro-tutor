/**
 * 模型输出规范化与校验的测试。
 *
 * 背景：真实的大模型**不会**严格照提示词里的 JSON 约定返回。
 * 之前的代码只在"key 和 text 都有"时才保留选项、答案则原样收下，
 * 结果会静默产出两类坏题：
 *   · 单选题一个选项都没有 → 用户点进去根本没法作答
 *   · 答案为空或写成了选项文本 → 用户答对了却被判错
 * 这两种都是"看起来正常、用起来致命"，必须挡住。
 */
import { describe, expect, it } from 'vitest';
import { isAnswerable, normalizeAnswer, normalizeOptions } from './quiz';

/* ============================== 选项规范化 ============================== */

describe('normalizeOptions', () => {
  it('标准写法原样保留', () => {
    expect(
      normalizeOptions([
        { key: 'A', text: '甲' },
        { key: 'B', text: '乙' },
      ]),
    ).toEqual([
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' },
    ]);
  });

  it('模型只给字符串数组时自动补上 A、B、C（以前会被整组丢掉）', () => {
    expect(normalizeOptions(['甲', '乙', '丙'])).toEqual([
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' },
      { key: 'C', text: '丙' },
    ]);
  });

  it('文本字段写成 content / value / label 也能认', () => {
    expect(normalizeOptions([{ key: 'A', content: '甲' }, { key: 'B', value: '乙' }, { label: '丙' }])).toEqual([
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' },
      { key: 'C', text: '丙' },
    ]);
  });

  it('key 缺失、非法或重复时整体重排成 A、B、C', () => {
    expect(normalizeOptions([{ text: '甲' }, { text: '乙' }])).toEqual([
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' },
    ]);
    expect(
      normalizeOptions([
        { key: 'A', text: '甲' },
        { key: 'A', text: '乙' },
      ]),
    ).toEqual([
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' },
    ]);
    expect(
      normalizeOptions([
        { key: '甲', text: '甲' },
        { key: '乙', text: '乙' },
      ]),
    ).toEqual([
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' },
    ]);
  });

  it('丢掉空文本项；全空则返回 undefined', () => {
    expect(normalizeOptions([{ key: 'A', text: '甲' }, { key: 'B', text: '   ' }])).toEqual([{ key: 'A', text: '甲' }]);
    expect(normalizeOptions([{ key: 'A', text: '' }])).toBeUndefined();
    expect(normalizeOptions([])).toBeUndefined();
    expect(normalizeOptions(undefined)).toBeUndefined();
    expect(normalizeOptions('甲、乙')).toBeUndefined();
  });
});

/* ============================== 答案规范化 ============================== */

describe('normalizeAnswer', () => {
  const options = [
    { key: 'A', text: '3A' },
    { key: 'B', text: '48A' },
    { key: 'C', text: '0.33A' },
  ];

  it('单选：字母、大小写、以及"选A"都能认', () => {
    expect(normalizeAnswer('single', 'A', options)).toBe('A');
    expect(normalizeAnswer('single', 'a', options)).toBe('A');
    expect(normalizeAnswer('single', 'A. 甲', options)).toBe('A');
  });

  it('单选：模型回了**选项文本**时反查回字母（否则用户答对也判错）', () => {
    expect(normalizeAnswer('single', '3A', options)).toBe('A');
    expect(normalizeAnswer('single', '48A', options)).toBe('B');
  });

  it('多选：兼容 ["A","B"]、["AB"]、"A,B"、"A、B" 四种写法', () => {
    expect(normalizeAnswer('multiple', ['A', 'B'], options)).toEqual(['A', 'B']);
    expect(normalizeAnswer('multiple', ['AB'], options)).toEqual(['A', 'B']);
    expect(normalizeAnswer('multiple', 'A,B', options)).toEqual(['A', 'B']);
    expect(normalizeAnswer('multiple', 'A、B', options)).toEqual(['A', 'B']);
    // 去重 + 排序
    expect(normalizeAnswer('multiple', 'B,A,A', options)).toEqual(['A', 'B']);
  });

  it('判断题：各种写法都归一成"正确/错误"', () => {
    for (const v of ['正确', '对', '√', 'T', 'true', '是']) {
      expect(normalizeAnswer('judge', v, undefined), v).toBe('正确');
    }
    for (const v of ['错误', '错', '×', 'F', 'false', '否']) {
      expect(normalizeAnswer('judge', v, undefined), v).toBe('错误');
    }
  });

  it('填空题：多个空保留成数组，单个空保持字符串', () => {
    expect(normalizeAnswer('blank', ['欧姆', '安培'], undefined)).toEqual(['欧姆', '安培']);
    expect(normalizeAnswer('blank', '欧姆', undefined)).toBe('欧姆');
    expect(normalizeAnswer('blank', ['欧姆', ''], undefined)).toBe('欧姆');
  });

  it('简答/计算题保留原文，空值归成空字符串', () => {
    expect(normalizeAnswer('calc', 'I = P/U = 5/220 ≈ 0.02A', undefined)).toBe('I = P/U = 5/220 ≈ 0.02A');
    expect(normalizeAnswer('short', undefined, undefined)).toBe('');
    expect(normalizeAnswer('short', [], undefined)).toBe('');
  });
});

/* ============================== 可考性校验 ============================== */

describe('isAnswerable', () => {
  const base = { stem: '题干', answer: 'A' as string | string[] };

  it('正常的单选可以通过', () => {
    expect(
      isAnswerable({ ...base, type: 'single', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }] }),
    ).toEqual({ ok: true });
  });

  it('没有题干不行', () => {
    const r = isAnswerable({ ...base, type: 'judge', stem: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('题干');
  });

  it('没有答案不行——这种题永远判不对', () => {
    const r = isAnswerable({ ...base, type: 'judge', answer: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('标准答案');
  });

  it('单选题选项不足两个不行', () => {
    expect(isAnswerable({ ...base, type: 'single', options: [] }).ok).toBe(false);
    expect(isAnswerable({ ...base, type: 'single', options: undefined }).ok).toBe(false);
    expect(isAnswerable({ ...base, type: 'single', options: [{ key: 'A', text: '甲' }] }).ok).toBe(false);
  });

  it('答案不在选项里不行', () => {
    const r = isAnswerable({ ...base, type: 'single', answer: 'D', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('不在选项里');
  });

  it('判断题与简答题只要题干和答案齐了就算可用', () => {
    expect(isAnswerable({ type: 'judge', stem: '题', answer: '正确' })).toEqual({ ok: true });
    expect(isAnswerable({ type: 'calc', stem: '题', answer: 'I = 3A' })).toEqual({ ok: true });
  });
});
