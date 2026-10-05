/**
 * 大纲生成服务：把导入的材料变成知识点树。
 */
import { db, getDefaultLLM, getProfile, newId } from '../db/db';
import type { ID, KnowledgePoint, Material, Outline, TrackId } from '../db/types';
import { chat, truncateText } from '../llm/client';
import { parseJsonLoose } from '../llm/json';
import { buildOutlineMessages, type OutlineNodeDraft } from '../llm/prompts';

/** 单次塞给模型的材料上限（字符），超出会头尾保留 + 中段省略 */
const MATERIAL_BUDGET = 24_000;

export interface OutlineGenerateResult {
  outline: Outline;
  points: KnowledgePoint[];
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

  let raw = '';
  const res = await chat(config, messages, {
    jsonMode: true,
    temperature: 0.3,
    onDelta: (delta) => {
      raw += delta;
      onProgress?.(delta);
    },
  });

  // 优先用返回值，流式回调只作为兜底。
  // 只依赖 onDelta 是脆弱的：换一个不回调的实现（或非流式通道）就会解析到空字符串。
  const draftText = res.content || raw;
  const draft = parseJsonLoose<{ title: string; nodes: OutlineNodeDraft[] }>(draftText, '大纲');
  if (!draft.nodes?.length) throw new Error('模型没有生成任何知识点，可能是材料内容太少，请换一份更完整的材料再试。');

  const result = await createOutlineFromNodes({
    title: title?.trim() || draft.title || materials[0].title,
    track,
    nodes: draft.nodes,
    materialIds,
  });

  // 标记材料属于哪条线，方便后续筛选
  await db.transaction('rw', db.materials, async () => {
    for (const m of materials) await db.materials.update(m.id, { track });
  });

  return result;
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

/** 读取某大纲下的全部知识点，按 order 排序 */
export async function getOutlinePoints(outlineId: ID): Promise<KnowledgePoint[]> {
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
