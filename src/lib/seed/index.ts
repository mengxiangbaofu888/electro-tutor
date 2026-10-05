/**
 * 内置起步大纲的安装逻辑。
 *
 * 数据在 ./data.ts，这里只负责把它落进数据库，以及判断装没装过。
 */
import { db } from '../db/db';
import type { TrackId } from '../db/types';
import { createOutlineFromNodes, type OutlineGenerateResult } from '../services/outline';
import { SEED_OUTLINES, getSeedOutline } from './data';

export * from './data';

/** 已经装过内置大纲的学习线 */
export async function installedSeedTracks(): Promise<Set<TrackId>> {
  const outlines = await db.outlines.toArray();
  return new Set(outlines.filter((o) => o.seed).map((o) => o.track));
}

/** 安装某一条线的内置大纲 */
export async function installSeedOutline(track: TrackId): Promise<OutlineGenerateResult> {
  const seed = getSeedOutline(track);
  if (!seed) throw new Error(`没有找到内置大纲：${track}`);
  const result = await createOutlineFromNodes({
    title: seed.title,
    track,
    nodes: seed.nodes,
  });
  await db.outlines.update(result.outline.id, { seed: true });
  result.outline.seed = true;
  return result;
}

/** 一次把四条线全部装上（跳过已装的） */
export async function installAllSeedOutlines(): Promise<number> {
  const installed = await installedSeedTracks();
  let count = 0;
  for (const seed of SEED_OUTLINES) {
    if (installed.has(seed.track)) continue;
    await installSeedOutline(seed.track);
    count += 1;
  }
  return count;
}
