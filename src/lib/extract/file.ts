/// <reference types="vite/client" />

/** 按文件扩展名把上传的材料分派到各提取器，统一返回 ExtractResult */

import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import JSZip from 'jszip';
import * as mammothModule from 'mammoth';
import type { ExtractResult } from './types';

// pdfjs 的 worker 必须显式配置；Vite 用 ?url 把 worker 当静态资源打包并给出最终地址
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/** JSZip 实例类型：由值反推，避免依赖 jszip 的 export= 类型细节 */
type Zip = Awaited<ReturnType<typeof JSZip.loadAsync>>;

/* ============================ 通用小工具 ============================ */

/** 取小写扩展名（不含点），无扩展名时返回空串 */
function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** 取去掉扩展名的文件名，作为默认标题 */
function titleOf(name: string): string {
  const i = name.lastIndexOf('.');
  const base = (i > 0 ? name.slice(0, i) : name).trim();
  return base || '未命名材料';
}

/** 只规整换行与行尾空白（对 Markdown / CSV 等有结构的文本安全） */
function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/** 更激进的清洗：压缩行内多空格与多余空行（用于 PDF / HTML 这类抽取结果） */
function cleanExtracted(raw: string): string {
  return normalizeText(raw)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

/** 统计非空白字符数（中文材料用字数比用词数合理） */
function countChars(text: string): number {
  return text.replace(/\s/g, '').length;
}

/** 把未知异常转成可读的中文短句 */
function errText(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return '操作超时';
    return err.message || '未知错误';
  }
  if (typeof err === 'string' && err) return err;
  return '未知错误';
}

/** 组装结果；warnings 为空时不写该字段，避免出现空数组 */
function buildResult(
  text: string,
  title: string,
  meta: Record<string, string | number>,
  warnings: string[],
): ExtractResult {
  const result: ExtractResult = { text, title, meta };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

/** 粗略判断是否为二进制内容（用于未知扩展名的兜底尝试） */
function looksBinary(raw: string): boolean {
  const sample = raw.slice(0, 2000);
  if (!sample) return false;
  if (sample.includes('\u0000')) return true;
  let bad = 0;
  for (const ch of sample) {
    if (ch.codePointAt(0) === 0xfffd) bad += 1;
  }
  return bad / sample.length > 0.1;
}

/** 安全地把码点转成字符（非法码点返回空串，避免 RangeError） */
function codePointToString(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** 解码 XML/HTML 常见实体与数字实体 */
function decodeEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_all, hex: string) => codePointToString(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec: string) => codePointToString(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** 取出 XML 片段里某个标签的文本内容（已解码实体） */
function tagTexts(fragment: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) {
    out.push(decodeEntities(m[1] ?? ''));
  }
  return out;
}

/** 取出标签属性值（属性名里的 : 原样匹配，如 r:id） */
function attrOf(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`);
  const m = re.exec(tag);
  return m ? decodeEntities(m[1] ?? '') : undefined;
}

/* ============================== PDF ============================== */

/** 同一行的 y 坐标容差（PDF 用户空间单位，约等于小号字高的一半） */
const PDF_LINE_TOLERANCE = 3;

interface PdfPiece {
  str: string;
  x: number;
  y: number;
}

/** 判断是否是带文本的项（TextMarkedContent 这类没有 str，需要跳过） */
function isPdfTextItem(value: unknown): value is { str: string; transform: number[] } {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as { str?: unknown; transform?: unknown };
  return typeof rec.str === 'string' && Array.isArray(rec.transform);
}

/** 把一页的文字片段按 y 坐标分行、行内按 x 排序后拼接 */
function pdfItemsToLines(items: unknown[]): string[] {
  const pieces: PdfPiece[] = [];
  for (const item of items) {
    if (!isPdfTextItem(item)) continue;
    const t = item.transform;
    if (t.length < 6) continue;
    const x = t[4] ?? 0;
    const y = t[5] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pieces.push({ str: item.str, x, y });
  }
  // PDF 的 y 轴向上：y 大的在上面，所以按 y 递减排；同一行内按 x 递增
  pieces.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: string[] = [];
  let lineY = Number.NaN;
  let buffer: string[] = [];
  const flush = (): void => {
    const text = buffer.join('').replace(/\s+/g, ' ').trim();
    if (text) lines.push(text);
    buffer = [];
  };
  for (const piece of pieces) {
    if (Number.isNaN(lineY) || Math.abs(piece.y - lineY) > PDF_LINE_TOLERANCE) {
      flush();
      lineY = piece.y;
    }
    buffer.push(piece.str);
  }
  flush();
  return lines;
}

async function extractPdf(file: File, fallbackTitle: string): Promise<ExtractResult> {
  const warnings: string[] = [];
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjsLib.getDocument({ data });
  const blocks: string[] = [];
  let pageCount = 0;
  let title = fallbackTitle;

  try {
    const doc = await task.promise;
    pageCount = doc.numPages;

    // 优先用 PDF 自带的标题
    try {
      const metadata = await doc.getMetadata();
      const info = metadata.info as unknown as { Title?: unknown };
      if (typeof info.Title === 'string' && info.Title.trim()) title = info.Title.trim();
    } catch {
      // 元数据不可用就忽略
    }

    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      try {
        const content = await page.getTextContent();
        const pageText = cleanExtracted(pdfItemsToLines(content.items).join('\n'));
        if (countChars(pageText) < 10) {
          warnings.push(`第${n}页可能是扫描图片，未提取到文字`);
        } else {
          blocks.push(pageText);
        }
      } finally {
        page.cleanup();
      }
    }
  } catch (err) {
    throw new Error(`PDF 解析失败：${errText(err)}（文件可能已加密或损坏）`);
  } finally {
    try {
      await task.destroy();
    } catch {
      // 销毁失败不影响已提取的内容
    }
  }

  const text = blocks.join('\n\n---\n\n');
  if (!text) warnings.push('整份 PDF 都没有提取到文字，可能是扫描件，需要先做 OCR');
  return buildResult(text, title, { kind: 'pdf', pages: pageCount, chars: countChars(text) }, warnings);
}

/* ============================== DOCX ============================== */

interface MammothMessage {
  type?: string;
  message?: string;
}

interface MammothOutput {
  value: string;
  messages?: MammothMessage[];
}

/**
 * mammoth 官方类型声明（lib/index.d.ts）只声明了 convertToHtml / extractRawText，
 * 运行时却有 convertToMarkdown，所以这里自己收敛成最小接口，避免用 any 或 @ts-ignore。
 */
interface MammothLike {
  convertToMarkdown?(input: { arrayBuffer: ArrayBuffer }): Promise<MammothOutput>;
  extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<MammothOutput>;
}

/** 不同打包器对 CJS 的互操作结果不同：命名导出或 default 各试一次 */
const mammothNamespace = mammothModule as unknown as MammothLike & { default?: MammothLike };
const mammothImpl: MammothLike | undefined =
  typeof mammothNamespace.extractRawText === 'function'
    ? mammothNamespace
    : mammothNamespace.default && typeof mammothNamespace.default.extractRawText === 'function'
      ? mammothNamespace.default
      : undefined;

/** 把 mammoth 的 messages 收集成中文 warning */
function collectMammothMessages(messages: MammothMessage[] | undefined, warnings: string[]): void {
  for (const msg of messages ?? []) {
    const level = msg.type === 'error' ? '错误' : '提示';
    const text = (msg.message ?? '').trim();
    if (text) warnings.push(`Word 文档${level}：${text}`);
  }
}

async function extractDocx(file: File, fallbackTitle: string): Promise<ExtractResult> {
  if (!mammothImpl) {
    throw new Error('Word 解析库（mammoth）未能加载，请把内容直接粘贴进 App');
  }
  const arrayBuffer = await file.arrayBuffer();
  const warnings: string[] = [];
  let value = '';
  let markdownFailed = false;

  if (typeof mammothImpl.convertToMarkdown === 'function') {
    try {
      const out = await mammothImpl.convertToMarkdown({ arrayBuffer });
      value = out.value;
      collectMammothMessages(out.messages, warnings);
    } catch {
      markdownFailed = true;
    }
  }

  if (!value) {
    try {
      const out = await mammothImpl.extractRawText({ arrayBuffer });
      value = out.value;
      collectMammothMessages(out.messages, warnings);
    } catch (err) {
      throw new Error(`Word 文档解析失败：${errText(err)}（文件可能已加密或损坏）`);
    }
    if (markdownFailed) warnings.push('Markdown 转换失败，已退化为纯文本提取');
  }

  const text = normalizeText(value);
  if (!text) warnings.push('文档里可能只有图片，未提取到文字，建议改用截图识图');
  return buildResult(text, fallbackTitle, { kind: 'docx', chars: countChars(text) }, warnings);
}

/* ============================== PPTX ============================== */

interface ZipPart {
  index: number;
  name: string;
}

/** 列出压缩包里匹配某个正则的成员，按编号排序 */
function listZipParts(zip: Zip, pattern: RegExp): ZipPart[] {
  const parts: ZipPart[] = [];
  for (const name of Object.keys(zip.files)) {
    const m = pattern.exec(name);
    if (!m) continue;
    parts.push({ index: Number.parseInt(m[1] ?? '0', 10), name });
  }
  return parts.sort((a, b) => a.index - b.index);
}

/** 读压缩包里的文本成员，读不到返回 undefined */
async function readZipText(zip: Zip, name: string): Promise<string | undefined> {
  const entry = zip.file(name);
  if (!entry) return undefined;
  try {
    return await entry.async('string');
  } catch {
    return undefined;
  }
}

/** 读 docProps/core.xml 里的标题（PPTX / XLSX 通用） */
async function readCoreTitle(zip: Zip): Promise<string | undefined> {
  const xml = await readZipText(zip, 'docProps/core.xml');
  if (!xml) return undefined;
  const m = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(xml);
  const title = m ? decodeEntities(m[1] ?? '').trim() : '';
  return title || undefined;
}

/** 抽取 <a:p> 段落里的 <a:t> 文本，一段一行 */
function pptParagraphs(xml: string): string[] {
  const lines: string[] = [];
  const paraRe = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g;
  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(xml)) !== null) {
    const line = tagTexts(m[1] ?? '', 'a:t').join('').replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
  }
  if (lines.length === 0) {
    // 结构异常（没有 <a:p> 包裹）时退化为直接抓全部 <a:t>
    for (const run of tagTexts(xml, 'a:t')) {
      const line = run.replace(/\s+/g, ' ').trim();
      if (line) lines.push(line);
    }
  }
  return lines;
}

/** 备注页文本：去掉自动页码域，避免混进"3"这种噪声 */
function pptNotesText(xml: string): string[] {
  const withoutFields = xml.replace(/<a:fld[\s\S]*?<\/a:fld>/g, '');
  return pptParagraphs(withoutFields).filter((line) => !/^\d+$/.test(line));
}

async function extractPptx(file: File, fallbackTitle: string): Promise<ExtractResult> {
  const warnings: string[] = [];
  let zip: Zip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch (err) {
    throw new Error(`PPTX 解析失败：${errText(err)}（文件可能已加密或损坏）`);
  }

  const slides = listZipParts(zip, /^ppt\/slides\/slide(\d+)\.xml$/);
  if (slides.length === 0) {
    throw new Error('PPTX 里没有找到幻灯片，文件结构可能不受支持');
  }

  // 备注页编号与幻灯片编号一一对应（notesSlide1 ↔ slide1）
  const notes = new Map<number, string>();
  for (const part of listZipParts(zip, /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/)) {
    const xml = await readZipText(zip, part.name);
    if (!xml) continue;
    const text = pptNotesText(xml).join('\n');
    if (text) notes.set(part.index, text);
  }

  const sections: string[] = [];
  for (const slide of slides) {
    const xml = await readZipText(zip, slide.name);
    const paragraphs = xml ? pptParagraphs(xml) : [];
    if (paragraphs.length === 0) {
      warnings.push(`第${slide.index}页没有提取到文字，可能是纯图片页`);
    }
    const block: string[] = [`## 第${slide.index}页`];
    if (paragraphs.length > 0) block.push(paragraphs.join('\n\n'));
    const note = notes.get(slide.index);
    if (note) block.push(`> 备注：${note.replace(/\n/g, '\n> ')}`);
    sections.push(block.join('\n\n'));
  }

  const text = sections.join('\n\n');
  const coreTitle = await readCoreTitle(zip);
  return buildResult(
    text,
    coreTitle ?? fallbackTitle,
    { kind: 'pptx', slides: slides.length, chars: countChars(text) },
    warnings,
  );
}

/* ============================== XLSX ============================== */

/** 单个工作表最多提取的行数，避免超大表格卡死界面 */
const XLSX_MAX_ROWS = 2000;

interface SheetInfo {
  title: string;
  partName: string;
}

/** 把 rels 里的 Target 规整成压缩包内完整路径 */
function normalizePartPath(target: string): string {
  const clean = target.replace(/^\/+/, '');
  return clean.startsWith('xl/') ? clean : `xl/${clean}`;
}

/** 读 xl/sharedStrings.xml，得到共享字符串表 */
async function readSharedStrings(zip: Zip): Promise<string[]> {
  const xml = await readZipText(zip, 'xl/sharedStrings.xml');
  if (!xml) return [];
  const out: string[] = [];
  const siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    // 富文本会被拆成多个 <r><t>，拼起来即可
    out.push(tagTexts(m[1] ?? '', 't').join(''));
  }
  return out;
}

/** 列出工作表：优先用 workbook.xml 的真实表名，失败则按文件名顺序兜底 */
async function listSheets(zip: Zip): Promise<SheetInfo[]> {
  const relMap = new Map<string, string>();
  const relsXml = await readZipText(zip, 'xl/_rels/workbook.xml.rels');
  if (relsXml) {
    const relRe = /<Relationship\b[^>]*>/g;
    let m: RegExpExecArray | null;
    while ((m = relRe.exec(relsXml)) !== null) {
      const id = attrOf(m[0], 'Id');
      const target = attrOf(m[0], 'Target');
      if (id && target) relMap.set(id, target);
    }
  }

  const workbookXml = await readZipText(zip, 'xl/workbook.xml');
  const sheets: SheetInfo[] = [];
  if (workbookXml) {
    const sheetRe = /<sheet\b[^>]*\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = sheetRe.exec(workbookXml)) !== null) {
      const tag = m[0];
      const rid = attrOf(tag, 'r:id') ?? attrOf(tag, 'id');
      const target = rid ? relMap.get(rid) : undefined;
      if (!target) continue;
      const partName = normalizePartPath(target);
      if (!zip.file(partName)) continue;
      sheets.push({ title: attrOf(tag, 'name') ?? `Sheet${sheets.length + 1}`, partName });
    }
  }
  if (sheets.length > 0) return sheets;

  return listZipParts(zip, /^xl\/worksheets\/sheet(\d+)\.xml$/).map((part) => ({
    title: `Sheet${part.index}`,
    partName: part.name,
  }));
}

/** 由 "B3" 这样的单元格引用算出列下标（A=0） */
function columnIndexOf(ref: string): number {
  const letters = /^([A-Za-z]+)/.exec(ref)?.[1];
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/** 取单元格的值（共享字符串 / 内联字符串 / 布尔 / 公式结果 / 原始数字） */
function cellValue(type: string, inner: string, shared: string[]): string {
  if (type === 's') {
    const idx = Number.parseInt(tagTexts(inner, 'v').join('') || '-1', 10);
    return Number.isInteger(idx) && idx >= 0 && idx < shared.length ? (shared[idx] ?? '') : '';
  }
  if (type === 'inlineStr') return tagTexts(inner, 't').join('');
  if (type === 'b') return tagTexts(inner, 'v').join('') === '1' ? 'TRUE' : 'FALSE';
  // 'str'（公式的字符串结果）、'e'（#N/A 等错误值）、'n'（数字/日期序列号）都按原文输出
  return tagTexts(inner, 'v').join('');
}

/** 解析一行里的单元格，并按 r 属性补齐空列 */
function parseRowCells(rowXml: string, shared: string[]): string[] {
  const cells: string[] = [];
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(rowXml)) !== null) {
    const attrs = m[1] ?? '';
    const inner = m[2] ?? '';
    const ref = attrOf(attrs, 'r');
    const col = ref ? columnIndexOf(ref) : cells.length;
    if (col > 16384) continue; // 超过 xlsx 最大列数，视为异常引用直接跳过
    while (cells.length < col) cells.push('');
    cells[col] = cellValue(attrOf(attrs, 't') ?? 'n', inner, shared);
  }
  while (cells.length > 0 && (cells[cells.length - 1] ?? '') === '') cells.pop();
  return cells;
}

/** 读一个工作表的所有行（最多 XLSX_MAX_ROWS 行） */
async function readSheetRows(zip: Zip, partName: string, shared: string[]): Promise<string[][]> {
  const xml = await readZipText(zip, partName);
  if (!xml) return [];
  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(xml)) !== null) {
    if (rows.length >= XLSX_MAX_ROWS) break;
    const cells = parseRowCells(m[1] ?? '', shared);
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/** 行数据 → Markdown 表格（首行当表头） */
function rowsToMarkdown(rows: string[][]): string {
  let width = 1;
  for (const row of rows) {
    if (row.length > width) width = row.length;
  }
  const pad = (row: string[]): string[] => {
    const out = row.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  };
  const esc = (cell: string): string => cell.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
  const header = pad(rows[0] ?? []);
  const lines: string[] = [
    `| ${header.map(esc).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows.slice(1)) {
    lines.push(`| ${pad(row).map(esc).join(' | ')} |`);
  }
  return lines.join('\n');
}

async function extractXlsx(file: File, fallbackTitle: string): Promise<ExtractResult> {
  const warnings: string[] = [];
  let zip: Zip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch (err) {
    throw new Error(`Excel 解析失败：${errText(err)}（文件可能已加密或损坏）`);
  }

  const sheets = await listSheets(zip);
  if (sheets.length === 0) {
    throw new Error('XLSX 里没有找到工作表，文件结构可能不受支持');
  }

  const shared = await readSharedStrings(zip);
  const sections: string[] = [];
  for (const sheet of sheets) {
    const rows = await readSheetRows(zip, sheet.partName, shared);
    if (rows.length === 0) {
      warnings.push(`工作表「${sheet.title}」没有内容`);
      continue;
    }
    if (rows.length >= XLSX_MAX_ROWS) {
      warnings.push(`工作表「${sheet.title}」行数过多，只提取了前 ${XLSX_MAX_ROWS} 行`);
    }
    sections.push(`## ${sheet.title}\n\n${rowsToMarkdown(rows)}`);
  }

  const text = sections.join('\n\n');
  const coreTitle = await readCoreTitle(zip);
  return buildResult(
    text,
    coreTitle ?? fallbackTitle,
    { kind: 'xlsx', sheets: sheets.length, chars: countChars(text) },
    warnings,
  );
}

/* ============================== HTML ============================== */

/** HTML 里与正文无关的节点 */
const HTML_NOISE_SELECTOR = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'form',
  'button',
  'input',
  'select',
  'nav',
  'footer',
  'aside',
  'body > header',
].join(',');

/** 去掉脚本、导航、页脚等噪声；页内 header 保留（常含文章标题） */
function stripHtmlNoise(doc: Document): void {
  doc.querySelectorAll(HTML_NOISE_SELECTOR).forEach((el) => el.remove());
}

/** 抽取块级元素的文本：标题转 #，列表项转 - */
function htmlBlockText(root: Element): string {
  const blocks = root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,td,th,figcaption,dt,dd');
  const lines: string[] = [];
  blocks.forEach((el) => {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    // p 套 li 这类嵌套结构会重复出现，跳过与上一条完全相同的内容
    if (lines.length > 0 && lines[lines.length - 1] === text) return;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      const level = Number.parseInt(tag.slice(1), 10);
      lines.push(`${'#'.repeat(level)} ${text}`);
    } else if (tag === 'li') {
      lines.push(`- ${text}`);
    } else {
      lines.push(text);
    }
  });
  if (lines.length > 0) return lines.join('\n\n');
  return cleanExtracted(root.textContent ?? '');
}

/** HTML 字符串 → 结果（上传 .html 文件时使用） */
function extractHtmlString(html: string, fallbackTitle: string): ExtractResult {
  if (typeof DOMParser === 'undefined') {
    throw new Error('当前运行环境不支持 HTML 解析，请把正文直接粘贴进 App');
  }
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  stripHtmlNoise(doc);
  const root = doc.querySelector('article') ?? doc.querySelector('main') ?? doc.body;
  const text = root ? htmlBlockText(root) : '';
  if (!text) warnings.push('没有从 HTML 里提取到正文，可能是纯图片或需要脚本渲染的页面');
  return buildResult(
    text,
    (doc.title || '').trim() || fallbackTitle,
    { kind: 'html', chars: countChars(text) },
    warnings,
  );
}

/* ============================ 纯文本类 ============================ */

/** 猜文本是不是被当成 UTF-8 解码坏了（Windows 上的 GBK / UTF-16 讲义很常见） */
function looksMisencoded(raw: string): boolean {
  const sample = raw.slice(0, 4000);
  if (!sample) return false;
  if (sample.charCodeAt(0) === 0xfeff) return true; // BOM 残留
  if (sample.includes('\u0000')) return true; // UTF-16 里的空字节
  let bad = 0;
  for (const ch of sample) {
    if (ch.charCodeAt(0) === 0xfffd) bad += 1;
  }
  return bad >= 3 && bad / sample.length > 0.02;
}

async function extractPlainText(file: File, ext: string, fallbackTitle: string): Promise<ExtractResult> {
  const raw = await file.text();
  const warnings: string[] = [];
  let text = normalizeText(raw);

  if (looksMisencoded(raw)) {
    warnings.push('文件可能不是 UTF-8 编码（如 GBK / UTF-16），文字可能显示为乱码，建议另存为 UTF-8 后重新上传');
  }

  if (ext === 'json') {
    try {
      const parsed: unknown = JSON.parse(raw);
      text = `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
    } catch {
      warnings.push('JSON 解析失败，已按纯文本输出');
    }
  }
  if (!text) warnings.push('文件内容为空，未提取到文字');
  return buildResult(text, fallbackTitle, { kind: ext || 'text', chars: countChars(text) }, warnings);
}

/* ============================== 入口 ============================== */

/** 按文件扩展名分派到具体提取器，统一返回 ExtractResult */
export async function extractFromFile(file: File): Promise<ExtractResult> {
  const ext = extOf(file.name);
  const title = titleOf(file.name);

  switch (ext) {
    case 'txt':
    case 'md':
    case 'markdown':
    case 'csv':
    case 'json':
      return extractPlainText(file, ext, title);

    case 'html':
    case 'htm':
      return extractHtmlString(await file.text(), title);

    case 'pdf':
      return extractPdf(file, title);

    case 'docx':
      return extractDocx(file, title);

    case 'pptx':
      return extractPptx(file, title);

    case 'xlsx':
      return extractXlsx(file, title);

    case 'doc':
    case 'ppt':
    case 'xls':
      throw new Error(`暂不支持旧版 .${ext} 格式，请先用 Office 另存为 .${ext}x 再上传`);

    default: {
      // 未知扩展名：按纯文本尽力尝试，明显是二进制文件就直接拒绝
      const raw = await file.text();
      if (looksBinary(raw)) {
        throw new Error(
          `暂不支持的文件类型：${ext ? `.${ext}` : '无扩展名'}，请上传 txt / md / pdf / docx / pptx / xlsx / html`,
        );
      }
      const text = normalizeText(raw);
      const warnings = [`未识别的扩展名${ext ? ` .${ext}` : ''}，已按纯文本提取`];
      if (!text) warnings.push('文件内容为空，未提取到文字');
      return buildResult(text, title, { kind: ext || 'unknown', chars: countChars(text) }, warnings);
    }
  }
}
