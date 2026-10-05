/**
 * 中国大学MOOC（icourse163）整门课抓取。
 *
 * 为什么做这个：一门课在慕课上是"一节课一个链接、一个文档一个链接"，
 * 学生想把这些喂给 App 只能一节一节复制——这个模块让 App 自己去抓。
 *
 * ## 边界（写清楚，不越线）
 * · 只用**公开**接口：课程目录、课程自测题库。这两条路都不需要登录。
 * · **不绕过任何登录态**：视频、以及需要登录才能看到的字幕，本模块一律不碰。
 * · 接口名是摸出来的（从它的前端 JS 包里挖出 297 个接口名，逐个试出来的），
 *   所以**随时可能变**：一旦抓不到，应当明确报错，而不是静默给一个空列表。
 *
 * ## 一个绕不过去的限制：CORS
 * 实测这两个接口**不返回可用的跨域头**（`access-control-allow-origin` 是空的），
 * 也就是说**浏览器里的网页版抓不了**（会被浏览器拦掉）。
 * APK 版走原生请求，不受这个限制。
 * 所以网页版上这个功能应当**明确说"请用 APK 版"**，而不是报一个看不懂的网络错误。
 */
import type { QuestionType } from '../db/types';
import { parseAnswer } from '../services/bank';

/* ============================== 类型 ============================== */

export interface MoocLesson {
  id: string;
  name: string;
  releaseTime?: number;
}

export interface MoocQuestion {
  /** 慕课那边的主键（用来去重） */
  remoteId: string;
  type: QuestionType;
  stem: string;
  options?: { key: string; text: string }[];
  answer: string | string[];
  explanation: string;
  /** 所属知识点名（优先用题目自带的节点名，其次课程名） */
  pointName: string;
  score?: number;
}

export interface MoocCourse {
  termId: string;
  courseId: string;
  courseTitle: string;
  lessons: MoocLesson[];
  questions: MoocQuestion[];
}

/* ============================== 纯函数部分 ============================== */

/**
 * 从课程链接里取出 courseId 与 termId。
 * 认得这些形态：
 *   https://www.icourse163.org/learn/CZMEC-1001754242?tid=1488467453#/learn/content
 *   https://www.icourse163.org/course/CZMEC-1001754242?tid=1488467453
 * termId 是抓目录必需的（界面上的 ?tid=），拿不到就返回 undefined，
 * 由上层提示用户"请从课程页面复制带 tid= 的链接"。
 */
export function parseCourseUrl(raw: string): { courseId: string; termId?: string } | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text.startsWith('http') ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!/(^|\.)icourse163\.org$/i.test(url.hostname)) return null;
  const m = /\/(?:learn|course)\/([A-Za-z0-9_-]+)/.exec(url.pathname);
  if (!m) return null;
  const termId = url.searchParams.get('tid') ?? undefined;
  return { courseId: m[1], termId: termId || undefined };
}

/** 去掉 HTML 标签、还原常见实体，并压掉多余空白 */
export function stripHtml(html: unknown): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    // </p><br/> 这种组合会产生连续换行；题干/解析里留一个换行就够，多的是噪声
    .replace(/[ \t]*\n[ \t]*(?:\n[ \t]*)+/g, '\n')
    .trim();
}

/** 慕课的题型编号 → 我们的题型 */
export function mapQuestionType(remote: unknown): QuestionType | null {
  switch (Number(remote)) {
    case 1:
      return 'single';
    case 2:
      return 'multiple';
    case 3:
      return 'blank';
    case 4:
      return 'judge';
    default:
      return null;
  }
}

interface RawOption {
  content?: string;
  answer?: boolean;
}

/**
 * 把慕课的一道题规范化成我们的题目结构。
 *
 * 各题型的答案形态（实测）：
 *   1 单选：optionDtos 里恰好一个 answer=true
 *   2 多选：optionDtos 里多个 answer=true
 *   3 填空：stdAnswer 用 ; 或 ；分隔多个空
 *   4 判断：optionDtos 是"正确/错误"两项，answer=true 的那个就是答案
 *
 * 答案统一交给 bank.ts 的 parseAnswer 处理——**只有一处规则**，
 * 免得"导入的题"和"AI 出的题"对答案的理解不一致。
 * 拿不到答案的题一律丢弃（答不了或一定判错的题进了库只会添乱）。
 */
export function normalizeMoocQuestion(raw: unknown, fallbackPointName = ''): MoocQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const type = mapQuestionType(item.type);
  if (!type) return null;

  const stem = stripHtml(item.plainTextTitle ?? item.title);
  if (!stem) return null;

  const rawOptions = Array.isArray(item.optionDtos) ? (item.optionDtos as RawOption[]) : [];
  const options = rawOptions
    .map((o, i) => ({
      key: String.fromCharCode(65 + i),
      text: stripHtml(o?.content),
      correct: Boolean(o?.answer),
    }))
    .filter((o) => o.text.length > 0);

  let answer: string | string[] | null = null;
  if (type === 'single') {
    const hit = options.find((o) => o.correct);
    if (hit) answer = parseAnswer('single', hit.key);
  } else if (type === 'multiple') {
    const keys = options.filter((o) => o.correct).map((o) => o.key);
    if (keys.length) answer = parseAnswer('multiple', keys.join(''));
  } else if (type === 'judge') {
    const hit = options.find((o) => o.correct);
    if (hit) answer = parseAnswer('judge', hit.text);
  } else if (type === 'blank') {
    const std = stripHtml(item.stdAnswer);
    if (std) answer = parseAnswer('blank', std);
  }
  if (answer === null || (Array.isArray(answer) && answer.length === 0)) return null;

  // 知识点：优先用题目自带的节点名（抓得到的话），否则用课程名
  const nodeNames = Array.isArray(item.nodeNameList) ? (item.nodeNameList as unknown[]) : [];
  const firstNode = nodeNames.map((n) => stripHtml(n)).find((n) => n.length > 0);
  const pointName = firstNode || fallbackPointName || '慕课导入';

  const explanation = stripHtml(item.analyse ?? item.aiAnalyse ?? '');
  const score = Number(item.score);

  return {
    remoteId: String(item.id ?? ''),
    type,
    stem,
    options:
      type === 'blank' ? undefined : options.map(({ key, text }) => ({ key, text })),
    answer,
    explanation,
    pointName,
    score: Number.isFinite(score) ? score : undefined,
  };
}

/** 课程课时列表 → 可作为"材料"的正文（用于生成大纲/出题） */
export function buildCourseMaterialContent(course: MoocCourse): string {
  const lines: string[] = [`# ${course.courseTitle || '慕课课程'}`, ''];
  lines.push(`- 来源：中国大学MOOC（icourse163）`);
  lines.push(`- 课程编号：${course.courseId}（termId ${course.termId}）`);
  lines.push(`- 课时数：${course.lessons.length}`);
  if (course.questions.length) lines.push(`- 自带自测题：${course.questions.length} 道`);
  lines.push('', '## 课时目录');
  course.lessons.forEach((l, i) => lines.push(`${i + 1}. ${l.name}`));
  lines.push('', '> 出题时优先覆盖上面这些课时对应的知识点。');
  return lines.join('\n');
}

/**
 * 把抓到的题目转成题库导入用的行（表头 + 数据）。
 * 走和 CSV 导入**同一条路**（bank.ts 的 importQuestionRows），
 * 这样知识点匹配、自动建点、告警这些行为完全一致。
 */
export function moocQuestionsToRows(questions: MoocQuestion[]): string[][] {
  const rows: string[][] = [['题型', '题干', '选项A', '选项B', '选项C', '选项D', '答案', '解析', '难度', '知识点']];
  const typeLabel: Record<QuestionType, string> = {
    single: '单选',
    multiple: '多选',
    judge: '判断',
    blank: '填空',
    short: '简答',
    calc: '计算',
  };
  for (const q of questions) {
    const opts = q.options ?? [];
    const row = [
      typeLabel[q.type],
      q.stem,
      opts[0]?.text ?? '',
      opts[1]?.text ?? '',
      opts[2]?.text ?? '',
      opts[3]?.text ?? '',
      Array.isArray(q.answer) ? q.answer.join(';') : q.answer,
      q.explanation,
      '3',
      q.pointName,
    ];
    rows.push(row);
  }
  return rows;
}

/* ============================== 网络部分 ============================== */

export interface HttpResult {
  status: number;
  text: string;
  /** 响应里的 set-cookie（原生请求下要自己接住，用来算 csrfKey） */
  setCookie: string[];
}

export interface MoocHttp {
  request(req: {
    url: string;
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
  }): Promise<HttpResult>;
}

const API_BASE = 'https://www.icourse163.org';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 网页版上的统一提示（浏览器跨域抓不了，别报一个看不懂的错误） */
export const MOOC_NEEDS_APP_MESSAGE =
  '慕课抓取要用 App（APK）版：慕课服务器不允许浏览器跨域直接取数据，' +
  '网页版会被浏览器拦掉。装 APK 版后这个功能就能用。';

function pickCookie(setCookie: string[], name: string): string | undefined {
  for (const raw of setCookie) {
    // 原生插件返回的 set-cookie 可能是多个 cookie 用 "、" ", " 或 "; " 拼在一起的，
    // 所以前后分隔符都要认
    const m = new RegExp(`(?:^|[;,]\\s*)${name}=([^;,\\s]+)`).exec(raw);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * 抓一门课：目录 + 自测题库。
 *
 * 步骤（和手工点的顺序一致）：
 *   1. 先访问课程页拿 cookie（接口要凭 NTESSTUDYSI 这个 cookie 当 csrfKey）
 *   2. columnBean.getMocLessonBaseDtos  → 课时列表（需要 termId + sortType）
 *   3. mocQuizRpcBean.getQuestionListByTermId → 题库
 *   4. 课程标题从课程页里捞（页面里有 termId 附近的 JSON）
 */
export async function fetchMoocCourse(params: {
  url: string;
  http: MoocHttp;
  onProgress?: (message: string) => void;
}): Promise<MoocCourse> {
  const { url, http, onProgress } = params;
  const parsed = parseCourseUrl(url);
  if (!parsed) {
    throw new Error('这不像中国大学MOOC的课程链接。请在课程页面复制地址（形如 icourse163.org/learn/xxx?tid=数字）。');
  }
  if (!parsed.termId) {
    throw new Error(
      '链接里缺少 tid=（课程期次号）。请打开课程页面、随便点一节课，' +
        '地址栏里会出现 ?tid=数字，把完整链接复制过来。',
    );
  }

  onProgress?.('正在打开课程页…');
  const page = await http.request({
    url: `${API_BASE}/course/${parsed.courseId}?tid=${parsed.termId}`,
    method: 'GET',
    headers: { 'User-Agent': UA },
  });
  if (page.status < 200 || page.status >= 300) {
    throw new Error(`打不开课程页（HTTP ${page.status}）。检查一下链接，或者稍后再试。`);
  }
  const csrfKey = pickCookie(page.setCookie, 'NTESSTUDYSI');
  if (!csrfKey) {
    throw new Error('没能从课程页拿到会话标识（cookie）。慕课可能改了接口，或者当前网络被拦了。');
  }

  const post = async (path: string, query: string) => {
    const r = await http.request({
      url: `${API_BASE}/web/j/${path}.rpc?csrfKey=${encodeURIComponent(csrfKey)}&${query}`,
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Referer: `${API_BASE}/course/${parsed.courseId}`,
        Cookie: `NTESSTUDYSI=${csrfKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: '',
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`接口 ${path} 返回 HTTP ${r.status}`);
    let json: { code?: number; result?: unknown; message?: string };
    try {
      json = JSON.parse(r.text) as typeof json;
    } catch {
      throw new Error(`接口 ${path} 返回的不是 JSON（慕课可能改接口了）。`);
    }
    if (typeof json.code === 'number' && json.code !== 0) {
      throw new Error(`接口 ${path} 报错：${json.message || json.code}`);
    }
    return json.result;
  };

  onProgress?.('正在取课时目录…');
  const lessonsRaw = (await post('columnBean.getMocLessonBaseDtos', `termId=${parsed.termId}&sortType=1`)) as
    | Array<{ id?: unknown; name?: unknown; releaseTime?: unknown }>
    | null;
  const lessons: MoocLesson[] = (Array.isArray(lessonsRaw) ? lessonsRaw : [])
    .map((l) => ({
      id: String(l?.id ?? ''),
      name: stripHtml(l?.name) || '（未命名课时）',
      releaseTime: typeof l?.releaseTime === 'number' ? l.releaseTime : undefined,
    }))
    .filter((l) => l.id);

  onProgress?.('正在取课程自测题库（数据量较大，稍等）…');
  const quizRaw = (await post('mocQuizRpcBean.getQuestionListByTermId', `termId=${parsed.termId}`)) as
    | unknown[]
    | null;
  const courseTitle = extractCourseTitle(page.text) || `慕课课程 ${parsed.courseId}`;
  const questions: MoocQuestion[] = [];
  let dropped = 0;
  for (const raw of Array.isArray(quizRaw) ? quizRaw : []) {
    const q = normalizeMoocQuestion(raw, courseTitle);
    if (q) questions.push(q);
    else dropped += 1;
  }

  onProgress?.(
    `抓取完成：${lessons.length} 个课时、${questions.length} 道题` +
      (dropped ? `（另有 ${dropped} 道题没有答案或信息不全，已跳过）` : ''),
  );

  return {
    termId: parsed.termId,
    courseId: parsed.courseId,
    courseTitle,
    lessons,
    questions,
  };
}

/** 从课程页 HTML 里捞课程标题（页面里有 termId 附近的一坨 JSON） */
export function extractCourseTitle(html: string): string {
  const m = /"name"\s*:\s*"([^"]{2,80})"/.exec(html) ?? /<title>([^<]{2,80})<\/title>/.exec(html);
  if (!m) return '';
  const raw = m[1].replace(/_中国大学MOOC.*$/, '').replace(/\(慕课\).*$/, '').trim();
  try {
    return decodeURIComponent(escape(raw));
  } catch {
    return raw;
  }
}
