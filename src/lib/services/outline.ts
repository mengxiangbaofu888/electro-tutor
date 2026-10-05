/**
 * 大纲生成服务：把导入的材料变成知识点树。
 */
import { db, getDefaultLLM, getProfile, newId } from '../db/db';
import type { ID, KnowledgePoint, Material, Outline, TrackId } from '../db/types';
import { chat, truncateText } from '../llm/client';
import { parseJsonLoose, pickString } from '../llm/json';
import { buildOutlineMessages, type OutlineNodeDraft } from '../llm/prompts';

/** 单次塞给模型的材料上限（字符），超出会头尾保留 + 中段省略 */
const MATERIAL_BUDGET = 24_000;

export interface OutlineGenerateResult {
  outline: Outline;
  points: KnowledgePoint[];
  /** 因为节点没有名称而被丢弃的数量（仅 AI 生成时有意义） */
  droppedNodes?: number;
}

/**
 * 把模型返回的知识点树规范化。
 *
 * 模型经常换字段名：节点名可能叫 title / label / 名称，说明可能叫 description，
 * 子节点可能叫 sub / items。以前直接取 node.name——名字缺失时**不报错**，
 * 而是产出一个没有名字的知识点：界面上是一行空白，出题时把空名字发给模型，
 * 最后表现为"出题失败"或"出一堆无关的题"。整条线索都看不出真正原因。
 *
 * 这里把没名字的节点直接丢掉（而不是产出空节点），并统计丢了多少，
 * 由上层明确告诉用户。
 *
 * 一种例外要保住：模型把"章"这一层的名字漏了，但小节点都有名字
 * （如 `{summary:'概述', items:[{name:'欧姆定律'}]}`）。这时丢掉整棵子树
 * 会连有名字的知识点一起吞掉，而计入 dropped 的又只有那一个无名节点，
 * 提示语"N 个节点因为缺少名称被跳过"就跟实际丢的东西对不上了。
 * 所以：无名节点本身计数丢弃，它**有名字的子节点提升到当前层级**，不丢内容。
 */
export function normalizeOutlineNodes(raw: unknown): { nodes: OutlineNodeDraft[]; dropped: number } {
  if (!Array.isArray(raw)) return { nodes: [], dropped: 0 };
  let dropped = 0;

  const walk = (list: unknown[]): OutlineNodeDraft[] => {
    const out: OutlineNodeDraft[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') {
        dropped += 1;
        continue;
      }
      const obj = item as Record<string, unknown>;
      const name = pickString(obj, ['name', 'title', 'label', '知识点', '名称', '标题']);
      const childrenRaw = obj.children ?? obj.sub ?? obj.items ?? obj['子项'] ?? obj['子知识点'];
      if (!name) {
        dropped += 1;
        // 无名节点本身不要，但它有名字的子节点提升到当前层级，别把内容一起丢了
        if (Array.isArray(childrenRaw)) out.push(...walk(childrenRaw));
        continue;
      }
      const summary = pickString(obj, ['summary', 'description', 'desc', '说明', '简介']);
      const importanceRaw = obj.importance ?? obj.weight ?? obj['重要度'];
      const children = Array.isArray(childrenRaw) ? walk(childrenRaw) : [];

      out.push({
        name,
        summary,
        importance: Math.min(5, Math.max(1, Math.round(Number(importanceRaw) || 3))),
        children: children.length ? children : undefined,
      });
    }
    return out;
  };

  return { nodes: walk(raw), dropped };
}

function flatten(
  nodes: OutlineNodeDraft[],
  outlineId: ID,
  parentId: ID | undefined,
  depth: number,
  counter: { n: number },
  out: KnowledgePoint[],
): void {
  nodes.forEach((node) => {
    // 兜底：没有名字的节点不落库（无名知识点在界面上是一行空白，
    // 出题时还会把空名字发给模型，属于典型的"静默坏数据"）
    if (!node?.name || !String(node.name).trim()) return;
    const point: KnowledgePoint = {
      id: newId(),
      outlineId,
      parentId,
      name: node.name,
      summary: node.summary,
      importance: Math.min(5, Math.max(1, Math.round(node.importance || 3))),
      order: counter.n++,
      depth,
    };
    out.push(point);
    if (node.children?.length) {
      flatten(node.children, outlineId, point.id, depth + 1, counter, out);
    }
  });
}

/**
 * 根据若干材料生成大纲与知识点。
 * @param onProgress 可选流式回调，用于在界面上实时显示模型输出
 */
export async function generateOutline(params: {
  materialIds: ID[];
  track: TrackId;
  title?: string;
  extraInstruction?: string;
  onProgress?: (delta: string) => void;
}): Promise<OutlineGenerateResult> {
  const { materialIds, track, title, extraInstruction, onProgress } = params;
  if (!materialIds.length) throw new Error('请先选择至少一份学习材料。');

  const config = await getDefaultLLM('text');
  if (!config) throw new Error('还没有配置文本大模型，请先到「我的 → 模型配置」里添加。');

  const materials: Material[] = await db.materials.bulkGet(materialIds).then((rows) =>
    rows.filter((m): m is Material => Boolean(m)),
  );
  if (!materials.length) throw new Error('选中的材料已经不存在了，请重新选择。');

  const combined = materials
    .map((m) => `### 材料：${m.title}\n${m.content}`)
    .join('\n\n');
  const text = truncateText(combined, MATERIAL_BUDGET);

  const profile = await getProfile();
  const messages = buildOutlineMessages({ track, materialText: text, profile, extraInstruction });

  // **不走流式**：实测同一模型（deepseek-flash）非流式的"测试连接"正常，
  // 而流式请求会返回空内容（HTTP 200、一个字都没有）。要 JSON 的任务
  // 本来也不需要逐字显示，进度由界面上的状态提示承担。
  onProgress?.('正在让模型读材料并归纳知识点（一次性请求，完成后直接显示结果）…');
  const res = await chat(config, messages, {
    jsonMode: true,
    temperature: 0.3,
  });

  const draftText = res.content;
  const draft = parseJsonLoose<{ title?: string; nodes?: unknown }>(draftText, '大纲');

  // 先规范化再落库：模型可能把节点名写成 title/label，
  // 也可能给出没有名字的节点——那些不能变成无名知识点。
  const rawNodes = Array.isArray(draft.nodes) ? draft.nodes : [];
  const { nodes, dropped } = normalizeOutlineNodes(rawNodes);
  if (!nodes.length) {
    throw new Error(
      rawNodes.length
        ? '模型返回的知识点全部缺少名称，无法使用。请重试或换一个模型。'
        : '模型没有生成任何知识点，可能是材料内容太少，请换一份更完整的材料再试。',
    );
  }

  const result = await createOutlineFromNodes({
    title: title?.trim() || draft.title || materials[0].title,
    track,
    nodes,
    materialIds,
  });

  // 标记材料属于哪条线，方便后续筛选
  await db.transaction('rw', db.materials, async () => {
    for (const m of materials) await db.materials.update(m.id, { track });
  });

  return { ...result, droppedNodes: dropped };
}

/**
 * 把一棵知识点草稿树落库成大纲。
 * AI 生成的大纲与内置起步大纲共用这一条路径，保证两者结构完全一致。
 */
export async function createOutlineFromNodes(params: {
  title: string;
  track: TrackId;
  nodes: OutlineNodeDraft[];
  materialIds?: ID[];
}): Promise<OutlineGenerateResult> {
  const { title, track, nodes, materialIds = [] } = params;
  if (!nodes.length) throw new Error('没有任何知识点，无法创建大纲。');

  const outlineId = newId();
  const points: KnowledgePoint[] = [];
  flatten(nodes, outlineId, undefined, 1, { n: 0 }, points);

  const outline: Outline = {
    id: outlineId,
    title,
    track,
    materialIds,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await db.transaction('rw', db.outlines, db.knowledgePoints, async () => {
    await db.outlines.put(outline);
    await db.knowledgePoints.bulkPut(points);
  });

  return { outline, points };
}

/**
 * 这条材料**自带的**结构化标题（有就能本地拼大纲，不用调模型）。
 *
 * 通用规则，不针对任何一本特定的书或某一门课：
 *   · 慕课导入时会把课时目录存进 `sections`
 *   · 教材扫码时会把微课标题存在 `book.microLessons`
 * 两条来源都只是"一串标题"，谁来了都一样处理。
 */
export function materialSections(m: Material): string[] {
  if (m.sections?.length) return m.sections.filter((s) => s.trim().length > 0);
  const micros = m.book?.microLessons ?? [];
  return micros.map((x) => x.title).filter((t) => t && t.trim().length > 0);
}

/**
 * 把"一串标题"变成大纲节点（**纯函数，不调用任何模型**）。
 *
 * 为什么这一步不需要模型：标题本身就是知识点的骨架。
 * 让模型去"归纳"一遍现成的课时目录，只会更慢、更贵、还可能改错名字。
 *
 * 为什么**不自己编章节名**：我们只知道标题长什么样，不知道它是"第几讲"还是"第几章"，
 * 编一个"第 11 讲"很可能与你书上写的不一致。所以只按标题原样铺开，
 * 顺序保持和来源一致——这比编一个错的结构强。
 *
 * 什么时候不能用它：材料是一整篇没有小标题的文字（PDF/笔记/截图转写），
 * 那就没有现成结构，必须让模型读一遍再归纳（走 generateOutline）。
 */
export function titlesToNodes(titles: string[]): OutlineNodeDraft[] {
  const seen = new Set<string>();
  const nodes: OutlineNodeDraft[] = [];
  for (const raw of titles) {
    const name = String(raw ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    nodes.push({ name, summary: '', importance: 3 });
  }
  return nodes;
}

/**
 * 用一串标题直接建大纲（秒出、不花钱）。titles 至少给两个才有意义。
 */
export async function createOutlineFromTitles(params: {
  title: string;
  track: TrackId;
  titles: string[];
  materialIds?: ID[];
}): Promise<OutlineGenerateResult> {
  const { title, track, titles, materialIds = [] } = params;
  const nodes = titlesToNodes(titles);
  if (nodes.length < 2) {
    throw new Error(
      '这条材料里没有可用的标题清单（至少要两个）。' +
        '慕课链接和教材扫码会自带标题；文档/笔记/截图这类要用 AI 生成大纲。',
    );
  }
  return createOutlineFromNodes({ title, track, nodes, materialIds });
}

/** 读取某大纲下的全部知识点，按 order 排序 */export async function getOutlinePoints(outlineId: ID): Promise<KnowledgePoint[]> {
  const points = await db.knowledgePoints.where('outlineId').equals(outlineId).toArray();
  return points.sort((a, b) => a.order - b.order);
}

/** 列出全部大纲（新的在前） */
export async function listOutlines(): Promise<Outline[]> {
  const all = await db.outlines.toArray();
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 删除大纲：连同它的知识点、掌握度记录、题目、错题本条目一起清掉。
 *
 * 为什么题目也必须删：题目的归属完全依赖知识点（掌握度、薄弱点、复习排程都挂在
 * knowledgePointId 上）。知识点没了，题就成了没有归属的孤儿——掌握度永远统计不到，
 * 而界面上又没有"题目管理"入口，用户永远清理不掉，只能看着题库越来越脏。
 */
export async function deleteOutline(outlineId: ID): Promise<void> {
  await db.transaction(
    'rw',
    db.outlines,
    db.knowledgePoints,
    db.mastery,
    db.questions,
    db.mistakes,
    async () => {
      const points = await db.knowledgePoints.where('outlineId').equals(outlineId).toArray();
      const pointIds = points.map((p) => p.id);

      const questions = await db.questions.where('outlineId').equals(outlineId).toArray();
      const questionIds = questions.map((q) => q.id);

      // 错题本里指向这些题的条目也要清掉，否则会留下指向不存在题目的记录
      if (questionIds.length) {
        const notes = await db.mistakes.where('questionId').anyOf(questionIds).toArray();
        await db.mistakes.bulkDelete(notes.map((n) => n.id));
      }

      await db.questions.bulkDelete(questionIds);
      await db.mastery.bulkDelete(pointIds);
      await db.knowledgePoints.bulkDelete(pointIds);
      await db.outlines.delete(outlineId);
    },
  );
}

/** 手动新增知识点（用户增删改） */
export async function addKnowledgePoint(params: {
  outlineId: ID;
  name: string;
  summary?: string;
  parentId?: ID;
  importance?: number;
}): Promise<KnowledgePoint> {
  const siblings = await db.knowledgePoints.where('outlineId').equals(params.outlineId).toArray();
  const parent = params.parentId ? siblings.find((s) => s.id === params.parentId) : undefined;
  const point: KnowledgePoint = {
    id: newId(),
    outlineId: params.outlineId,
    parentId: params.parentId,
    name: params.name,
    summary: params.summary,
    importance: params.importance ?? 3,
    order: siblings.length ? Math.max(...siblings.map((s) => s.order)) + 1 : 0,
    depth: parent ? parent.depth + 1 : 1,
  };
  await db.knowledgePoints.put(point);
  await db.outlines.update(params.outlineId, { updatedAt: Date.now() });
  return point;
}

/** 更新知识点 */
export async function updateKnowledgePoint(id: ID, patch: Partial<KnowledgePoint>): Promise<void> {
  await db.knowledgePoints.update(id, patch);
}

/**
 * 删除知识点（连带其子节点）。
 *
 * 题目本身**不删**——用户可能只是重整大纲结构，删掉他辛苦生成（还花了 token）的题
 * 是不可接受的。但必须把题目上对这些知识点的引用摘掉，否则会留下指向不存在节点的
 * 悬空 id，界面会显示成"未知知识点"，掌握度也永远统计不到。
 */
export async function removeKnowledgePoint(id: ID): Promise<void> {
  await db.transaction('rw', db.knowledgePoints, db.mastery, db.questions, async () => {
    const all = await db.knowledgePoints.toArray();
    const toDelete = new Set<ID>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of all) {
        if (p.parentId && toDelete.has(p.parentId) && !toDelete.has(p.id)) {
          toDelete.add(p.id);
          grew = true;
        }
      }
    }
    const ids = [...toDelete];

    // 摘掉题目上的引用（命中的题目必然至少引用了一个被删的点，所以一定会变）
    const affected = await db.questions.where('knowledgePointIds').anyOf(ids).toArray();
    if (affected.length) {
      await db.questions.bulkPut(
        affected.map((q) => ({
          ...q,
          knowledgePointIds: q.knowledgePointIds.filter((pid) => !toDelete.has(pid)),
        })),
      );
    }

    await db.knowledgePoints.bulkDelete(ids);
    await db.mastery.bulkDelete(ids);
  });
}

/** 取一棵树（用于渲染） */
export interface PointNode extends KnowledgePoint {
  children: PointNode[];
}

export function buildTree(points: KnowledgePoint[]): PointNode[] {
  const map = new Map<ID, PointNode>();
  for (const p of points) map.set(p.id, { ...p, children: [] });
  const roots: PointNode[] = [];
  for (const p of points) {
    const node = map.get(p.id)!;
    if (p.parentId && map.has(p.parentId)) map.get(p.parentId)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}
