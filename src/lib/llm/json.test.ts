/**
 * 大模型返回内容解析的测试。
 *
 * 这段代码的价值全在"容错"上——模型真实输出经常带围栏、带解释、带尾逗号、
 * 或者被 max_tokens 截断。所以每个容错分支都要有一个用例把它钉住。
 */
import { describe, expect, it } from 'vitest';
import { parseArrayLoose, parseJsonLoose } from './json';

describe('parseJsonLoose', () => {
  it('解析干净的 JSON 对象', () => {
    expect(parseJsonLoose<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('解析干净的 JSON 数组', () => {
    expect(parseJsonLoose<number[]>('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('剥掉 ```json 代码围栏', () => {
    expect(parseJsonLoose('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('剥掉没有语言标记的代码围栏', () => {
    expect(parseJsonLoose('```\n{"a":3}\n```')).toEqual({ a: 3 });
  });

  it('忽略 JSON 前后的解释文字', () => {
    expect(parseJsonLoose('好的，结果如下：\n{"a":4}\n希望有帮助')).toEqual({ a: 4 });
  });

  it('去掉多余的尾逗号', () => {
    expect(parseJsonLoose('{"a":5,}')).toEqual({ a: 5 });
  });

  it('修复被 max_tokens 截断的 JSON（补齐括号）', () => {
    expect(parseJsonLoose('{"a":{"b":6')).toEqual({ a: { b: 6 } });
  });

  it('修复被截断的数组', () => {
    expect(parseJsonLoose('[1,2,3')).toEqual([1, 2, 3]);
  });

  it('前导有说明文字且被截断时也能救回来', () => {
    expect(parseJsonLoose('这是大纲：\n```json\n{"title":"电工基础","nodes":[{"name":"欧姆定律"')).toEqual({
      title: '电工基础',
      nodes: [{ name: '欧姆定律' }],
    });
  });

  it('完全不是 JSON 时抛出带原文片段的中文错误', () => {
    expect(() => parseJsonLoose('对不起，我不能回答这个问题')).toThrow(/解析失败/);
    expect(() => parseJsonLoose('对不起，我不能回答这个问题')).toThrow(/模型没有返回合法 JSON/);
  });

  it('错误信息里带上了原始输出片段，方便排查', () => {
    try {
      parseJsonLoose('完全跑偏的输出内容');
      throw new Error('本行不该执行到');
    } catch (e) {
      expect((e as Error).message).toContain('完全跑偏的输出内容');
    }
  });
});

describe('parseArrayLoose', () => {
  it('本身就是数组时直接返回', () => {
    expect(parseArrayLoose<{ x: number }>('[{"x":1}]')).toEqual([{ x: 1 }]);
  });

  it('包在对象里（例如 { questions: [...] }）也能取出来', () => {
    expect(parseArrayLoose<{ x: number }>('{"questions":[{"x":1}]}')).toEqual([{ x: 1 }]);
    expect(parseArrayLoose<{ x: number }>('{"items":[{"x":2}]}')).toEqual([{ x: 2 }]);
  });

  it('既不是数组也没有数组字段时抛错', () => {
    expect(() => parseArrayLoose('{"a":1}')).toThrow(/解析失败/);
  });
});
