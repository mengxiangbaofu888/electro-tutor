/**
 * 出题的后台任务。
 *
 * 起因（用户实测反馈）：
 *   · "我点了我的或者首页其他的一些东西，回来就没了" —— 生成中途切页面就丢
 *   · "一开始生成就不能取消了" —— 没有取消，也没有暂停
 *
 * 做法：出题跑在**模块级单例**里，而不是某个组件的 state。
 * 组件只是"订阅"它的状态，所以切页面、组件卸载都不会打断它。
 * 同时提供暂停/继续/取消：暂停在**批次之间**生效（当前这一批做完再停），
 * 这样已经出好的题不会白费。
 */
import type { ID, Question, QuestionType, TrackId } from '../db/types';
import { generateQuestions, type GenerateQuestionsParams } from './quiz';

export type GenerationStatus = 'idle' | 'running' | 'paused' | 'done' | 'cancelled' | 'error';

export interface GenerationState {
  status: GenerationStatus;
  /** 已经出了几道 / 一共要几道 */
  done: number;
  total: number;
  /** 正在第几批 / 共几批 */
  batchIndex: number;
  batchCount: number;
  /** 给人看的一句话（界面上直接显示这一句） */
  note: string;
  /** 出完的题目（已入库）；走题库时不经过这里 */
  questions: Question[];
  /** 失败原因或警告 */
  message?: string;
  /** 完成后是否要直接开始答题（页面自己决定怎么用） */
  thenStart: boolean;
}

const EMPTY: GenerationState = {
  status: 'idle',
  done: 0,
  total: 0,
  batchIndex: 0,
  batchCount: 0,
  note: '',
  questions: [],
  thenStart: false,
};

let state: GenerationState = { ...EMPTY };
const listeners = new Set<(s: GenerationState) => void>();

/** 暂停/取消用的是模块级标志：组件卸载也不会丢 */
let paused = false;
let cancelled = false;
let pauseWaiters: (() => void)[] = [];

/**
 * 任务序号：每次 startGeneration 递增。
 *
 * 为什么需要：旧任务被取消/重置后，它可能**迟到**地报进度或"完成"，
 * 那就把新任务的状态覆盖了（用户表现：取消后马上重新生成，界面显示的却是上一次的结果；
 * 我自己的测试也因为这个互相污染）。所以每个任务只认自己的序号。
 */
let runId = 0;

function emit(patch: Partial<GenerationState>, forRun?: number): void {
  if (forRun !== undefined && forRun !== runId) return; // 旧任务的结果一律丢弃
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

export function getGenerationState(): GenerationState {
  return state;
}

export function subscribeGeneration(fn: (s: GenerationState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => {
    listeners.delete(fn);
  };
}

/** 是不是有任务在跑（或暂停着）——用来决定要不要显示全局横幅 */
export function isGenerationActive(s: GenerationState = state): boolean {
  return s.status === 'running' || s.status === 'paused';
}

export function pauseGeneration(): void {
  if (state.status !== 'running') return;
  paused = true;
  emit({ status: 'paused', note: '已暂停（当前这一批做完后停下，已出的题都留着）' });
}

export function resumeGeneration(): void {
  if (state.status !== 'paused') return;
  paused = false;
  emit({ status: 'running', note: '继续生成…' });
  const waiters = pauseWaiters;
  pauseWaiters = [];
  for (const w of waiters) w();
}

/** 取消：不再开新批次，**已经出的题全部保留** */
export function cancelGeneration(): void {
  if (!isGenerationActive()) return;
  cancelled = true;
  paused = false;
  emit({ status: 'cancelled', note: '已取消（已经出的题会保留）' });
  const waiters = pauseWaiters;
  pauseWaiters = [];
  for (const w of waiters) w();
}

function waitIfPaused(): Promise<void> {
  if (!paused) return Promise.resolve();
  return new Promise<void>((resolve) => {
    pauseWaiters.push(resolve);
  });
}

export interface StartGenerationParams
  extends Omit<GenerateQuestionsParams, 'onProgress' | 'onBatch' | 'onWarning'> {
  outlineId: ID;
  track: TrackId;
  allocation: { pointId: ID; count: number }[];
  typeMix: { type: QuestionType; count: number }[];
  difficultyMix: string;
  thenStart?: boolean;
}

/**
 * 启动一次出题。**这个函数不等结果**（后台跑），
 * 界面通过 subscribeGeneration 看进度。
 * 返回 false 表示已经有任务在跑（不重复启动）。
 */
export function startGeneration(params: StartGenerationParams): boolean {
  if (isGenerationActive()) return false;

  runId += 1;
  const myRun = runId;
  paused = false;
  cancelled = false;
  pauseWaiters = [];
  const total = params.allocation.reduce((s, a) => s + a.count, 0);
  emit(
    {
      ...EMPTY,
      status: 'running',
      total,
      thenStart: Boolean(params.thenStart),
      note: '正在准备出题…',
    },
    myRun,
  );

  void (async () => {
    try {
      const questions = await generateQuestions({
        ...params,
        onBatch: ({ done, total: t, batchIndex, batchCount }) => {
          emit(
            {
              done,
              total: t,
              batchIndex,
              batchCount,
              note: `已出 ${done} / ${t} 道（第 ${batchIndex} / ${batchCount} 批）`,
            },
            myRun,
          );
        },
        onWarning: (text) => {
          emit({ message: text }, myRun);
        },
        control: {
          waitIfPaused,
          isCancelled: () => cancelled || myRun !== runId,
        },
      });

      if (myRun !== runId) return; // 已被新的任务/重置取代，别再改状态

      if (cancelled) {
        emit(
          {
            status: 'cancelled',
            questions,
            done: questions.length,
            note: `已取消：这次出了 ${questions.length} 道，已经存进题库了`,
          },
          myRun,
        );
        return;
      }
      if (!questions.length) {
        emit({ status: 'error', message: '一道题都没出出来，请重试或换个模型。', note: '' }, myRun);
        return;
      }
      emit(
        {
          status: 'done',
          questions,
          done: questions.length,
          note: `出题完成：${questions.length} 道（已存进题库）`,
        },
        myRun,
      );
    } catch (e) {
      if (myRun !== runId) return;
      if (cancelled) {
        emit({ status: 'cancelled', note: '已取消' }, myRun);
        return;
      }
      emit(
        {
          status: 'error',
          message: e instanceof Error ? e.message : String(e),
          note: '',
        },
        myRun,
      );
    }
  })();

  return true;
}

/**
 * 把状态清回初始（用户看过结果之后点「知道了」）。
 *
 * 注意这里是**强制**清干净（含正在跑的任务）。以前写成"进行中就不重置"，
 * 结果一个被暂停的任务把状态永久卡在 paused，后面的任务再也起不来 ——
 * 这是我自己的测试抓出来的真 bug（测试间状态泄漏）。
 * 界面上「知道了」只在任务结束后出现，所以强制清不会误伤正在跑的任务。
 */
export function resetGeneration(): void {
  cancelled = true;
  paused = false;
  const waiters = pauseWaiters;
  pauseWaiters = [];
  for (const w of waiters) w();
  cancelled = false;
  state = { ...EMPTY };
  for (const fn of listeners) fn(state);
}
