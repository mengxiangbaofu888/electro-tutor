// @vitest-environment jsdom
/**
 * 出题后台任务的测试。
 *
 * 用户实测反馈（这一版专门解决）：
 *   · "我正在生成题目，点了我的或首页，回来就没了"
 *   · "一开始生成就不能取消了"，还想要暂停
 *
 * 所以这里钉住三件事：
 *   1) 状态在模块级单例里，组件走了也还在（订阅者能收到通知）；
 *   2) 取消：不再开新批次，**已经出的题保留**；
 *   3) 暂停/继续：暂停在批次之间生效，继续后能跑完。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { generateQuestionsMock } = vi.hoisted(() => ({ generateQuestionsMock: vi.fn() }));
vi.mock('./quiz', async () => {
  const actual = await vi.importActual<typeof import('./quiz')>('./quiz');
  return { ...actual, generateQuestions: generateQuestionsMock };
});

const {
  cancelGeneration,
  getGenerationState,
  isGenerationActive,
  pauseGeneration,
  resetGeneration,
  resumeGeneration,
  startGeneration,
  subscribeGeneration,
} = await import('./generation-runner');

const baseParams = {
  outlineId: 'o1',
  track: 'fundamental' as const,
  allocation: [{ pointId: 'p1', count: 10 }],
  typeMix: [{ type: 'single' as const, count: 10 }],
  difficultyMix: '标准',
};

/** 用"闸门"精确控制每一批什么时候完成：比 sleep 更确定，不会忽快忽慢 */
function installGatedGenerator(batches: number) {
  const gates: (() => void)[] = [];
  const released = new Set<number>();
  const reached: number[] = [];
  generateQuestionsMock.mockImplementation(
    async (params: {
      onBatch?: (i: { done: number; total: number; batchIndex: number; batchCount: number }) => void;
      control?: { waitIfPaused?: () => Promise<void>; isCancelled?: () => boolean };
    }) => {
      const out: { id: string }[] = [];
      for (let b = 0; b < batches; b += 1) {
        if (params.control?.isCancelled?.()) break;
        await params.control?.waitIfPaused?.();
        if (params.control?.isCancelled?.()) break;
        reached.push(b);
        // 等测试放行这一批
        await new Promise<void>((resolve) => gates.push(resolve));
        if (params.control?.isCancelled?.()) break;
        out.push({ id: `q${out.length}` });
        params.onBatch?.({
          done: out.length,
          total: batches,
          batchIndex: b + 1,
          batchCount: batches,
        });
      }
      return out as never;
    },
  );
  return {
    /** 放行第 n 批（n 从 1 开始） */
    async release(n: number) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(n), { timeout: 2000 });
      if (!released.has(n - 1)) {
        released.add(n - 1);
        gates[n - 1]();
      }
      await vi.waitFor(() => expect(getGenerationState().done).toBeGreaterThanOrEqual(n), {
        timeout: 2000,
      });
    },
    /**
     * 把当前所有"在途"的批次都放行。
     * 取消/暂停时模型调用可能还在飞 —— 要让它返回，任务才会真正收尾。
     */
    async releasePending() {
      for (let round = 0; round < 20; round += 1) {
        let any = false;
        gates.forEach((resolve, idx) => {
          if (!released.has(idx)) {
            released.add(idx);
            any = true;
            resolve();
          }
        });
        if (!any) return;
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    reached,
  };
}

beforeEach(() => {
  generateQuestionsMock.mockReset();
  resetGeneration();
});

describe('出题后台任务', () => {
  it('跑起来后状态是"进行中"，并且能报出批次进度', async () => {
    const g = installGatedGenerator(3);
    expect(isGenerationActive()).toBe(false);
    expect(startGeneration(baseParams)).toBe(true);
    expect(isGenerationActive()).toBe(true);

    await g.release(1);
    expect(getGenerationState().note).toContain('第 1 / 3 批');
    await g.release(2);
    await g.release(3);
    expect(getGenerationState().status).toBe('done');
    expect(getGenerationState().questions).toHaveLength(3);
  });

  it('已经有任务在跑时不会重复启动（避免两份任务同时烧 token）', async () => {
    const g = installGatedGenerator(2);
    startGeneration(baseParams);
    expect(startGeneration(baseParams)).toBe(false);
    await g.release(1);
    await g.release(2);
    expect(getGenerationState().status).toBe('done');
  });

  it('订阅者能收到状态变化 —— 这就是"切到别的页面还看得到进度"的依据', async () => {
    const g = installGatedGenerator(2);
    const seen: string[] = [];
    const off = subscribeGeneration((s) => seen.push(s.status));
    startGeneration(baseParams);
    await g.release(1);
    await g.release(2);
    off();
    expect(seen).toContain('running');
    expect(seen).toContain('done');
  });

  it('取消：不再开新批次，已经出的题保留下来', async () => {
    const g = installGatedGenerator(5);
    startGeneration(baseParams);
    await g.release(1);
    cancelGeneration();
    // 取消时模型调用可能还在飞：放行它，任务才会收尾并汇报"已出的题已入库"
    await g.releasePending();
    await vi.waitFor(() => expect(getGenerationState().note).toContain('已经存进题库'), {
      timeout: 2000,
    });

    const s = getGenerationState();
    expect(s.status).toBe('cancelled');
    expect(s.questions).toHaveLength(1); // 第一批出的那一道留着
    // 取消之后不再有新批次被启动
    const reachedBefore = g.reached.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(g.reached.length).toBe(reachedBefore);
  });

  it('暂停：不再开新批次；继续之后能跑完', async () => {
    const g = installGatedGenerator(3);
    startGeneration(baseParams);
    await g.release(1);
    pauseGeneration();
    expect(getGenerationState().status).toBe('paused');

    // 暂停后不再有新批次启动、进度也不再增长
    const reachedAtPause = g.reached.length;
    const doneAtPause = getGenerationState().done;
    await new Promise((r) => setTimeout(r, 60));
    expect(g.reached.length).toBe(reachedAtPause);
    expect(getGenerationState().done).toBe(doneAtPause);

    resumeGeneration();
    // 继续之后把剩下的批次都放行（含暂停时卡在闸门上的那一批）
    await g.releasePending();
    await vi.waitFor(() => expect(getGenerationState().status).toBe('done'), { timeout: 2000 });
    expect(getGenerationState().questions).toHaveLength(3);
  });

  it('失败时把原因放在状态里（页面和横幅都能显示）', async () => {
    generateQuestionsMock.mockRejectedValue(new Error('模型没有返回内容'));
    startGeneration(baseParams);
    await vi.waitFor(() => expect(getGenerationState().status).toBe('error'), { timeout: 2000 });
    expect(getGenerationState().message).toContain('模型没有返回内容');
  });
});
