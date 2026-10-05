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
import { isAnswerable } from './quiz';

/* ============================== 底层 CSV ============================== */

/** 猜分隔符：从第一行非空内容里数，谁出现的次数多就算谁 */
export function guessDelimiter(text: string): string {
  const firstLine =
    text
      .replace(/^\ufeff/, '')
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0) ?? '';
  const candidates = ['\t', ',', ';', '|'];
  let best = ',';
  let bestCount = 0;
  for (const d of candidates) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 解析分隔符文本为二维数组。支持引号包裹、双引号转义、字段内分隔符与换行。
 * @param delimiter 省略时自动猜——从 Excel/WPS 里复制粘贴出来的是制表符分隔，
 *                  欧洲区导出的 CSV 常用分号，所以不能写死逗号。
 */
export function parseDelimitedRows(text: string, delimiter?: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // 去 BOM
  const sep = delimiter ?? guessDelimiter(src);
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
    if (ch === sep) {
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

/** 严格按逗号解析（保留旧名字，供只认 CSV 的场景使用） */
export function parseCsvRows(text: string): string[][] {
  return parseDelimitedRows(text, ',');
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

/** 把二维表解析成题目草稿（不碰数据库，方便测试） */
export function parseQuestionRows(rows: string[][]): ParseResult {
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

/** 从分隔符文本解析题目（CSV / TSV / 分号分隔都认） */
export function parseQuestionsCsv(text: string): ParseResult {
  return parseQuestionRows(parseDelimitedRows(text));
}

/* ============================== Excel（xlsx）直读 ============================== */

/** 把 &amp; 之类的实体还原 */
function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** 列号字母转下标：A→0，B→1，AA→26 */
function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/**
 * 直接读 .xlsx 的第一个工作表，返回二维字符串数组。
 *
 * 为什么要直读：低压电工证的官方题库绝大多数是以 Excel 形式流传的，
 * 要求用户先"另存为 CSV"再导入，就是白白多一步、而且很容易存错格式。
 *
 * 这是按需解析（只认单元格文本与共享字符串表），不是完整的 OOXML 实现：
 * 公式取缓存值、日期会显示成序列号、合并单元格只取左上角的值。
 * 对题库这种以文本为主的表格足够了。
 */
export async function xlsxToRows(data: ArrayBuffer): Promise<string[][]> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(data);

  // 共享字符串表：单元格里 t="s" 时 <v> 存的是这张表的下标
  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('string');
  const shared: string[] = [];
  if (sharedXml) {
    for (const si of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const parts = [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]));
      shared.push(parts.join(''));
    }
  }

  // 取第一个工作表（去掉自闭合标签，避免正则跨单元格误吞）
  const sheetPath = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
  if (!sheetPath) return [];
  const sheetXml = (await zip.file(sheetPath)?.async('string')) ?? '';

  const rows: string[][] = [];
  const body = sheetXml.replace(/<row[^>]*\/>/g, '');
  for (const rowMatch of body.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cellsXml = rowMatch[1].replace(/<c[^>]*\/>/g, '');
    const cells: string[] = [];
    for (const cellMatch of cellsXml.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2];
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const index = ref ? columnIndex(ref) : cells.length;
      const type = /t="([^"]+)"/.exec(attrs)?.[1];

      let value = '';
      if (type === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
        value = shared[Number(v)] ?? '';
      } else if (type === 'inlineStr') {
        value = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');
      } else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
      }

      while (cells.length < index) cells.push('');
      cells[index] = value;
    }
    rows.push(cells);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
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
export async function importQuestionRows(params: {
  rows: string[][];
  outlineId: ID;
  onProgress?: (done: number, total: number) => void;
}): Promise<ImportResult> {
  const { rows: inputRows, outlineId, onProgress } = params;
  const outline: Outline | undefined = await db.outlines.get(outlineId);
  if (!outline) throw new Error('目标大纲不存在。');

  const { questions: parsed, warnings } = parseQuestionRows(inputRows);
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
  const skipped: string[] = [];
  parsed.forEach((p, i) => {
    const knowledgePointIds = p.knowledgeNames
      .map(resolvePoint)
      .filter((id): id is ID => Boolean(id));
    const row: Question = {
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
    };
    // 和 AI 出题走同一套校验：没答案、选项不够、答案不在选项里的题不要入库，
    // 否则用户在练习时会遇到"答对了判错"或者"根本没有可选项"。
    const check = isAnswerable(row);
    if (!check.ok) {
      skipped.push(check.reason);
      return;
    }
    rows.push(row);
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
  if (skipped.length) {
    warnings.push(
      `有 ${skipped.length} 道题格式不完整，已跳过（${[...new Set(skipped)].join('；')}）。请检查这几行的答案与选项列。`,
    );
  }

  return { imported: rows.length, createdPoints, warnings };
}

/** 从 CSV / TSV 等分隔符文本导入题目 */
export function importQuestionsCsv(params: {
  text: string;
  outlineId: ID;
  onProgress?: (done: number, total: number) => void;
}): Promise<ImportResult> {
  return importQuestionRows({
    rows: parseDelimitedRows(params.text),
    outlineId: params.outlineId,
    onProgress: params.onProgress,
  });
}

/**
 * 从用户选的文件导入：.xlsx 直读，其余按分隔符文本处理。
 * 这是界面上真正调用的入口。
 */
export async function importQuestionsFromFile(params: {
  file: File;
  outlineId: ID;
  onProgress?: (done: number, total: number) => void;
}): Promise<ImportResult> {
  const name = params.file.name.toLowerCase();
  if (name.endsWith('.xlsx')) {
    const rows = await xlsxToRows(await params.file.arrayBuffer());
    return importQuestionRows({ rows, outlineId: params.outlineId, onProgress: params.onProgress });
  }
  const text = await params.file.text();
  return importQuestionRows({
    rows: parseDelimitedRows(text),
    outlineId: params.outlineId,
    onProgress: params.onProgress,
  });
}
