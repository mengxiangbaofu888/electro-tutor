/**
 * 从大模型返回的文本里稳健地抽出 JSON。
 *
 * 现实情况：模型经常用 ```json 包裹、或在 JSON 前后写解释、或漏掉结尾括号。
 * 这里做多级降级尝试，失败时抛出带原文片段的错误，方便排查。
 */

/**
 * 从对象里按候选键名取第一个非空字符串值。
 *
 * 用途：模型经常换字段名（name/title/label、summary/description…）。
 * 与其在每个解析处各写一份，不如统一用这个。
 */
export function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/** 去掉 Markdown 代码围栏 */
function stripFences(text: string): string {
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/;
  const m = text.match(fence);
  return m ? m[1] : text;
}

/** 截取第一个 { 到最后一个 } （或 [ 到 ]）之间的内容 */
function sliceBraces(text: string): string | null {
  const candidates: [string, string][] = [
    ['{', '}'],
    ['[', ']'],
  ];
  for (const [open, close] of candidates) {
    const start = text.indexOf(open);
    if (start === -1) continue;
    const end = text.lastIndexOf(close);
    if (end > start) return text.slice(start, end + 1);
    // 找不到闭合符号：很可能是被 max_tokens 截断了，
    // 先原样返回，交给后面的 closeUnbalanced 去补括号
    return text.slice(start);
  }
  return null;
}

/** 常见的模型毛病：多余尾逗号 */
function dropTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, '$1');
}

/** 尝试修复被截断的 JSON：补齐未闭合的括号 */
function closeUnbalanced(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    else if (!inString && (ch === '{' || ch === '[')) stack.push(ch);
    else if (!inString && (ch === '}' || ch === ']')) stack.pop();
  }
  let out = text;
  if (inString) out += '"';
  while (stack.length) {
    const open = stack.pop();
    out += open === '{' ? '}' : ']';
  }
  return out;
}

/**
 * 解析模型返回的 JSON。
 * @param raw 模型原始输出
 * @param what 出错时用于提示的业务名，例如「大纲」
 */
export function parseJsonLoose<T>(raw: string, what = '模型返回'): T {
  const attempts: (() => string)[] = [
    () => raw.trim(),
    () => stripFences(raw).trim(),
    () => {
      const s = sliceBraces(stripFences(raw));
      if (s === null) throw new Error('no braces');
      return s;
    },
    () => {
      const s = sliceBraces(stripFences(raw));
      if (s === null) throw new Error('no braces');
      return dropTrailingCommas(s);
    },
    () => {
      const s = sliceBraces(stripFences(raw));
      if (s === null) throw new Error('no braces');
      return closeUnbalanced(dropTrailingCommas(s));
    },
  ];

  let lastErr: unknown;
  for (const build of attempts) {
    try {
      const text = build();
      if (!text) continue;
      return JSON.parse(text) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  const preview = raw.slice(0, 400).replace(/\s+/g, ' ');
  throw new Error(
    `${what}解析失败：模型没有返回合法 JSON。原始输出片段：${preview}${raw.length > 400 ? '…' : ''}` +
      (lastErr instanceof Error ? `（${lastErr.message}）` : ''),
  );
}

/** 从可能带解释文字的回复里提取数组 */
export function parseArrayLoose<T>(raw: string, what = '模型返回'): T[] {
  const value = parseJsonLoose<unknown>(raw, what);
  if (Array.isArray(value)) return value as T[];
  // 有些模型会包一层 { items: [...] } 或 { questions: [...] }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(v)) return v as T[];
    }
  }
  throw new Error(`${what}解析失败：期望数组，实际拿到 ${typeof value}`);
}
