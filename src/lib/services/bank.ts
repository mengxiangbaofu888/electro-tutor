/**
 * 题库的 CSV 导入导出。
 *
 * 为什么用 CSV 而不是 Excel：CSV 是纯文本，Excel / WPS / 记事本都能打开和编辑，
 * 用手机也能改，而且不需要再引入一个 xlsx 写库。导出时带 UTF-8 BOM，
 * 中文 Windows 上双击直接用 Excel 打开不会乱码。
 *
 * 列名是"表头驱动"的：中英文都认，列顺序随意，缺列也不报错。
 * 这样用户从各处拿到的题库（官方题库、别人整理的表格）大概率能直接导。
 *
 * 填空题约定（与判分逻辑保持一致）：
 *   · 多个空之间用 `;` 分隔
 *   · 同一个空的多个可接受答案用 `|` 或 `/` 分隔
 */
import { db, newId } from '../db/db';
import type { ID, KnowledgePoint, Outline, Question, QuestionType } from '../db/types';
import { QUESTION_TYPE_LABELS } from '../db/types';

/* ============================== 底层 CSV ============================== */

/** 解析 CSV 文本为二维数组。支持引号包裹、双引号转义、字段内逗号与换行。 */
export function parseCsvRows(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // 去 BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  // 丢掉全空行
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

function csvField(value: string): string {
  const v = value ?? '';
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** 二维数组转 CSV 文本（带 BOM，方便 Excel 正确识别中文） */
export function toCsvText(rows: string[][]): string {
  return `\ufeff${rows.map((r) => r.map(csvField).join(',')).join('\r\n')}\r\n`;
}

/* ============================== 表头与枚举映射 ============================== */

const HEADER_ALIASES = {
  type: ['题型', '类型', 'type'],
  stem: ['题干', '题目', '问题', 'stem', 'question'],
  answer: ['答案', '正确答案', 'answer'],
  explanation: ['解析', '答案解析', 'explanation', 'analysis'],
  difficulty: ['难度', 'difficulty'],
  knowledge: ['知识点', '考点', 'knowledge', 'point'],
} as const;

type HeaderKey = keyof typeof HEADER_ALIASES;

function normalizeHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '');
}

/** 从前两行里找出表头行（含"题干"或"stem"的那一行） */
function findHeaderIndex(rows: string[][]): number {
  const looksLikeHeader = (r: string[]) =>
    r.some((c) => {
      const h = normalizeHeader(c);
      return HEADER_ALIASES.stem.some((a) => normalizeHeader(a) === h);
    });
  for (let i = 0; i < Math.min(rows.length, 3); i += 1) {
    if (looksLikeHeader(rows[i])) return i;
  }
  return -1;
}

function buildColumnMap(header: string[]): { key: Record<HeaderKey, number>; options: { index: number; key: string }[] } {
  const key = { type: -1, stem: -1, answer: -1, explanation: -1, difficulty: -1, knowledge: -1 } as Record<HeaderKey, number>;
  const options: { index: number; key: string }[] = [];

  header.forEach((raw, index) => {
    const h = normalizeHeader(raw);
    (Object.keys(HEADER_ALIASES) as HeaderKey[]).forEach((k) => {
      if (key[k] === -1 && HEADER_ALIASES[k].some((a) => normalizeHeader(a) === h)) key[k] = index;
    });
    // 选项列：选项A / 选项 A / optionA / 选项1 / 单个字母
    const m = /^(?:选项|option)?([a-fA-F1-9])$/.exec(h.replace(/[（）()]/g, ''));
    if (m) {
      const letter = m[1].toUpperCase();
      const key2 = /[1-9]/.test(letter) ? String.fromCharCode(64 + Number(letter)) : letter;
      if (!options.some((o) => o.index === index)) options.push({ index, key: key2 });
    }
  });

  options.sort((a, b) => a.key.localeCompare(b.key));
  return { key, options };
}

const TYPE_ALIASES: Record<string, QuestionType> = {
  single: 'single', choice: 'single', 单选题: 'single', 单选: 'single', 选择题: 'single',
  multiple: 'multiple', multi: 'multiple', 多选题: 'multiple', 多选: 'multiple',
  judge: 'judge', truefalse: 'judge', 判断题: 'judge', 判断: 'judge',
  blank: 'blank', fill: 'blank', 填空题: 'blank', 填空: 'blank',
  short: 'short', essay: 'short', 简答题: 'short', 简答: 'short',
  calc: 'calc', calculation: 'calc', 计算题: 'calc', 计算: 'calc',
};

function parseType(raw: string | undefined): QuestionType {
  const t = normalizeHeader(raw ?? '');
  return TYPE_ALIASES[t] ?? 'single';
}

function parseDifficulty(raw: string | undefined): number {
  const n = Number.parseInt((raw ?? '').replace(/[^\d]/g, ''), 10);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

/** 判断题答案归一化（认各种写法） */
function parseJudgeAnswer(raw: string): string {
  const v = normalizeHeader(raw);
  if (['正确', '对', '是', 'true', 't', '√', 'v', 'right', 'y', 'yes'].includes(v)) return '正确';
  if (['错误', '错', '否', 'false', 'f', '×', 'x', 'wrong', 'n', 'no'].includes(v)) return '错误';
  return raw.trim();
}

/** 按题型整理答案 */
export function parseAnswer(type: QuestionType, raw: string): string | string[] {
  const text = (raw ?? '').trim();
  if (type === 'single') {
    const m = /[A-Fa-f]/.exec(text);
    return m ? m[0].toUpperCase() : text;
  }
  if (type === 'multiple') {
    const letters = [...new Set((text.toUpperCase().match(/[A-F]/g) ?? []))].sort();
    return letters.length ? letters : text;
  }
  if (type === 'judge') return parseJudgeAnswer(text);
  if (type === 'blank') {
    // 多个空用 ; 分隔；空内可接受答案的 | 与 / 保持原样，交给判分逻辑处理
    const parts = text.split(/[;；]/).map((s) => s.trim());
    return parts.length > 1 ? parts : text;
  }
  return text;
}

/* ============================== 解析成题目草稿 ============================== */

export interface ParsedQuestion {
  type: QuestionType;
  stem: string;
  options?: { key: string; text: string }[];
  answer: string | string[];
  explanation: string;
  difficulty: number;
  knowledgeNames: string[];
}

export interface ParseResult {
  questions: ParsedQuestion[];
  warnings: string[];
}

/** 把 CSV 文本解析成题目草稿（不碰数据库，方便测试） */
export function parseQuestionsCsv(text: string): ParseResult {
  const rows = parseCsvRows(text);
  const warnings: string[] = [];
  if (!rows.length) return { questions: [], warnings: ['文件是空的。'] };

  const headerIndex = findHeaderIndex(rows);
  if (headerIndex === -1) {
    return {
      questions: [],
      warnings: ['没找到表头。第一行需要包含「题干」（或 stem）等列名，例如：题型,题干,选项A,选项B,答案,解析,难度,知识点'],
    };
  }

  const { key, options } = buildColumnMap(rows[headerIndex]);
  if (key.stem === -1) return { questions: [], warnings: ['表头里缺少「题干」列。'] };
  if (key.answer === -1) warnings.push('表头里没有「答案」列，导入的题目会没有标准答案。');

  const questions: ParsedQuestion[] = [];
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const stem = (row[key.stem] ?? '').trim();
    if (!stem) continue;

    const type = parseType(key.type === -1 ? '' : row[key.type]);
    const opts = options
      .map((o) => ({ key: o.key, text: (row[o.index] ?? '').trim() }))
      .filter((o) => o.text.length > 0);

    const knowledgeRaw = key.knowledge === -1 ? '' : (row[key.knowledge] ?? '');
    const knowledgeNames = knowledgeRaw
      .split(/[;；、]/)
      .map((s) => s.trim())
      .filter(Boolean);

    questions.push({
      type,
      stem,
      options: opts.length ? opts : undefined,
      answer: parseAnswer(type, key.answer === -1 ? '' : (row[key.answer] ?? '')),
      explanation: (key.explanation === -1 ? '' : (row[key.explanation] ?? '')).trim(),
      difficulty: parseDifficulty(key.difficulty === -1 ? '' : row[key.difficulty]),
      knowledgeNames,
    });
  }

  if (!questions.length) warnings.push('表头之后没有找到任何有效题目行。');
  return { questions, warnings };
}

/* ============================== 导出 ============================== */

const EXPORT_HEADER = [
  '题型',
  '题干',
  '选项A',
  '选项B',
  '选项C',
  '选项D',
  '选项E',
  '选项F',
  '答案',
  '解析',
  '难度',
  '知识点',
];

/** 答案渲染成 CSV 里的字符串（与 parseAnswer 互逆） */
export function renderAnswer(type: QuestionType, answer: string | string[]): string {
  const arr = Array.isArray(answer) ? answer : [answer];
  if (type === 'multiple') return arr.join('');
  if (type === 'blank') return arr.join('；');
  return arr.join('；');
}

const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** 把题目渲染成 CSV 行（不含表头） */
export function questionsToRows(questions: Question[], pointNameById: Map<ID, string>): string[][] {
  return questions.map((q) => {
    const optionCells = OPTION_KEYS.map(
      (k) => q.options?.find((o) => o.key === k)?.text ?? '',
    );
    return [
      QUESTION_TYPE_LABELS[q.type],
      q.stem,
      ...optionCells,
      renderAnswer(q.type, q.answer),
      q.explanation,
      String(q.difficulty),
      q.knowledgePointIds.map((id) => pointNameById.get(id) ?? '').filter(Boolean).join('；'),
    ];
  });
}

/**
 * 导出题库为 CSV 文本。
 * @param outlineId 传了就只导出这份大纲的题，不传则导出全部
 */
export async function exportQuestionsCsv(outlineId?: ID): Promise<{ csv: string; count: number }> {
  const questions = outlineId
    ? await db.questions.where('outlineId').equals(outlineId).toArray()
    : await db.questions.toArray();
  questions.sort((a, b) => b.createdAt - a.createdAt);

  const pointIds = [...new Set(questions.flatMap((q) => q.knowledgePointIds))];
  const points = pointIds.length ? await db.knowledgePoints.bulkGet(pointIds) : [];
  const nameById = new Map(
    points.filter((p): p is KnowledgePoint => Boolean(p)).map((p) => [p.id, p.name]),
  );

  const csv = toCsvText([EXPORT_HEADER, ...questionsToRows(questions, nameById)]);
  return { csv, count: questions.length };
}

/**
 * 导入模板：只有表头加三行示例，用来告诉用户该填成什么样。
 * 直接给 Excel / WPS 打开就能照着填。
 */
export function bankCsvTemplate(): string {
  return toCsvText([
    EXPORT_HEADER,
    ['单选题', '一段导体两端电压 12V、电阻 4Ω，通过的电流是多少？', '3A', '48A', '0.33A', '8A', '', '', 'A', '由欧姆定律 I=U/R=12/4=3A', '2', '欧姆定律'],
    ['判断题', '串联电路中各处的电流都相等。', '', '', '', '', '', '', '正确', '串联只有一条通路，电流处处相等', '1', '串联电路的计算'],
    ['填空题', '欧姆定律的表达式是 U=____×I。', '', '', '', '', '', '', 'R', '由 U=IR 变形得到', '2', '欧姆定律'],
  ]);
}

/* ============================== 导入 ============================== */

export interface ImportResult {
  imported: number;
  /** 因为题库里没有、被自动新建的知识点数 */
  createdPoints: number;
  warnings: string[];
}

/**
 * 把 CSV 导入到某份大纲。
 * 知识点名称会先在已有知识点里精确匹配，匹配不到再尝试包含匹配，
 * 还是匹配不到就**自动新建**一个知识点（否则题目会没有归属，掌握度统计不到）。
 */
export async function importQuestionsCsv(params: {
  text: string;
  outlineId: ID;
  onProgress?: (done: number, total: number) => void;
}): Promise<ImportResult> {
  const { text, outlineId, onProgress } = params;
  const outline: Outline | undefined = await db.outlines.get(outlineId);
  if (!outline) throw new Error('目标大纲不存在。');

  const { questions: parsed, warnings } = parseQuestionsCsv(text);
  if (!parsed.length) {
    return { imported: 0, createdPoints: 0, warnings: warnings.length ? warnings : ['没有解析到任何题目。'] };
  }

  const existingPoints = await db.knowledgePoints.where('outlineId').equals(outlineId).toArray();
  const byName = new Map(existingPoints.map((p) => [p.name, p]));
  let order = existingPoints.length ? Math.max(...existingPoints.map((p) => p.order)) + 1 : 0;
  const newPoints: KnowledgePoint[] = [];
  let createdPoints = 0;

  const resolvePoint = (name: string): ID | undefined => {
    const exact = byName.get(name);
    if (exact) return exact.id;
    const fuzzy =
      existingPoints.find((p) => p.name.includes(name) || name.includes(p.name)) ??
      newPoints.find((p) => p.name.includes(name) || name.includes(p.name));
    if (fuzzy) return fuzzy.id;

    // 题库里没有这个知识点，自动建一个顶层节点
    const created: KnowledgePoint = {
      id: newId(),
      outlineId,
      name,
      summary: '从题库导入时自动创建的知识点',
      importance: 3,
      order: order++,
      depth: 1,
    };
    newPoints.push(created);
    byName.set(name, created);
    createdPoints += 1;
    return created.id;
  };

  const rows: Question[] = [];
  parsed.forEach((p, i) => {
    const knowledgePointIds = p.knowledgeNames
      .map(resolvePoint)
      .filter((id): id is ID => Boolean(id));
    rows.push({
      id: newId(),
      outlineId,
      knowledgePointIds,
      type: p.type,
      stem: p.stem,
      options: p.options,
      answer: p.answer,
      explanation: p.explanation,
      difficulty: p.difficulty,
      source: 'imported',
      createdAt: Date.now(),
    });
    onProgress?.(i + 1, parsed.length);
  });

  await db.transaction('rw', db.knowledgePoints, db.questions, db.outlines, async () => {
    if (newPoints.length) await db.knowledgePoints.bulkPut(newPoints);
    await db.questions.bulkPut(rows);
    await db.outlines.update(outlineId, { updatedAt: Date.now() });
  });

  if (createdPoints > 0) {
    warnings.push(`题库里有 ${createdPoints} 个知识点原本不存在，已自动在大纲里新建。`);
  }
  const noAnswer = rows.filter((r) =>
    Array.isArray(r.answer) ? r.answer.length === 0 : !String(r.answer).trim(),
  ).length;
  if (noAnswer > 0) warnings.push(`有 ${noAnswer} 道题没有答案，做题时无法判分，建议补齐。`);

  return { imported: rows.length, createdPoints, warnings };
}
