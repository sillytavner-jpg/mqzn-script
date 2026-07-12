/**
 * 全局后台队列 (Background Queue)
 *
 * 核心职责：
 * 1. 所有后台 AI 调用进入队列，并发模式最多同时执行 5 个任务，排队模式 1 个
 * 2. 正文生成永远最高优先级，后台任务不得与正文抢 API
 * 3. 用户发言后暂停启动新的后台任务；正文生成结束后恢复
 * 4. 后台任务按优先级排序，同类型最多 1 个并发
 * 5. 提供完整状态供总览面板展示
 */

import { logInfo, logError } from '../utils/logger';

// ========== 类型定义 ==========

export type BackgroundTaskType =
  | 'grand_summary'
  | 'small_summary'
  | 'dreamtalk'
  | 'character_memory_update'
  | 'dynamic_profile_update'
  | 'world_progress'
  | 'relationship_analysis'
  | 'embedding'
  | 'embedding_mem'
  | 'embedding_item'
  | 'embedding_timeline'
  | 'persona'
  | 'world_book_distill';

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundTask {
  id: string;
  type: BackgroundTaskType;
  status: TaskStatus;
  priority: number;
  label: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  durationMs?: number;
  /** 同类型去重键（仅 small_summary 用，传楼层号）。详见 enqueue 注释。 */
  dedupeKey?: string;
}

// ========== 优先级（数字越小越优先） ==========

const PRIORITY: Record<BackgroundTaskType, number> = {
  small_summary: 1,
  grand_summary: 2,
  dreamtalk: 3,
  dynamic_profile_update: 4,
  character_memory_update: 5,
  world_progress: 6,
  relationship_analysis: 8,
  persona: 9,
  embedding: 10,
  embedding_mem: 11,
  embedding_item: 10,
  embedding_timeline: 10,
};

const TASK_LABELS: Record<BackgroundTaskType, string> = {
  small_summary: '小总结',
  grand_summary: '大总结',
  dreamtalk: '梦呓分析',
  dynamic_profile_update: '动态人设更新',
  character_memory_update: '角色记忆更新',
  world_progress: '世界推进',
  relationship_analysis: '关系分析',
  persona: '人格分析',
  embedding: '事件向量生成',
  embedding_mem: '记忆向量生成',
  embedding_item: '物品向量生成',
  embedding_timeline: '时间线向量生成',
};

// ========== 内部状态 ==========

interface QueuedTask extends BackgroundTask {
  execute: () => Promise<void>;
  /** 同类型去重键。仅 small_summary 使用：传楼层号字符串。
   *  - 不传：维持旧语义，同类型已在队列/在跑则丢弃新的（防扎堆抢API）
   *  - 传：同 type+dedupeKey 已在队列则取消旧任务（重roll同楼层用新正文）；
   *        在跑的让自然跑完（不主动Abort），但push阶段会被index.ts重roll清理覆盖；
   *        不同 dedupeKey 的同类型任务各自独立进队列 FIFO 等待。
   *  processQueue 始终保证同类型一次最多跑1个。 */
  dedupeKey?: string;
}

const queue: QueuedTask[] = [];
const history: BackgroundTask[] = [];
const MAX_HISTORY = 20;

const TASK_INTERVAL_SERIAL = 300; // 排队模式任务间隔 ms

function getMaxConcurrent(): number {
  try {
    // 动态导入避免循环依赖
    const { useMainStore } = require('../stores/mainStore');
    const store = useMainStore();
    const mode = (store.settings as any).schedulerMode;
    return mode === 'serial' ? 1 : 5;
  } catch {
    return 5; // 默认并发
  }
}
let runningTasks: Set<QueuedTask> = new Set();

let isProcessing = false;
let isGenerating = false;
let isPaused = false;

// ========== 工具函数 ==========

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function toRecord(task: QueuedTask): BackgroundTask {
  const { execute, ...record } = task;
  return record;
}

function pushHistory(task: BackgroundTask): void {
  history.unshift(task);
  if (history.length > MAX_HISTORY) history.pop();
}

// ========== 核心 API ==========

/**
 * 将后台任务入队
 * - 不传 dedupeKey：同类型已在队列/在跑则丢弃新的（防扎堆抢API，旧语义不变）
 * - 传 dedupeKey（仅 small_summary 用，传楼层号字符串）：
 *   * 队列中有同 type+dedupeKey → 取消旧任务（重roll同楼层用新正文替换等待中的旧任务）
 *   * 不同 dedupeKey（不同楼层）→ 各自独立进队列 FIFO 等待
 *   * 在跑的不主动Abort，让它跑完；其 record 会被 index.ts 重roll清理逻辑覆盖
 * - 按优先级排序
 * - 如果正文生成中或暂停，任务入队但不立即执行
 */
export function enqueue(
  type: BackgroundTaskType,
  execute: () => Promise<void>,
  label?: string,
  dedupeKey?: string,
): void {
  if (dedupeKey === undefined) {
    // 经典模式：同类型去重丢弃（防扎堆抢API），行为与历史一致
    if (queue.some(t => t.type === type)) {
      return;
    }
    let runningSame = 0;
    for (const t of runningTasks) { if (t.type === type) runningSame++; }
    if (runningSame >= 1) {
      return;
    }
  } else {
    // dedupeKey 模式：仅取消队列里同 type+dedupeKey 的旧任务（重roll同楼层替换）
    for (let i = queue.length - 1; i >= 0; i--) {
      const t = queue[i];
      if (t.type === type && t.dedupeKey === dedupeKey) {
        t.status = 'cancelled';
        t.completedAt = Date.now();
        pushHistory(toRecord(t));
        queue.splice(i, 1);
        logInfo('后台队列', `${t.label} 被同楼层重roll取消（dedupeKey=${dedupeKey}）`);
      }
    }
    // 在跑的同 dedupeKey 任务不主动Abort，让它跑完，记录会被 index.ts 覆盖
  }

  const task: QueuedTask = {
    id: generateId(),
    type,
    status: 'queued',
    priority: PRIORITY[type],
    label: label || TASK_LABELS[type],
    createdAt: Date.now(),
    execute,
    dedupeKey,
  };

  queue.push(task);
  queue.sort((a, b) => a.priority - b.priority);

  // 尝试开始处理
  if (!isProcessing && !isGenerating && !isPaused) {
    processQueue();
  } else if (isProcessing && !isGenerating && !isPaused) {
    notifyProcess();
  }
}

/**
 * 正文生成锁
 * - true: 正文生成开始，暂停后台队列
 * - false: 正文生成结束，恢复后台队列
 */
export function setGenerating(value: boolean): void {
  const prev = isGenerating;
  isGenerating = value;
  if (prev && !value) {
    // 正文结束，恢复队列
    if (!isProcessing && !isPaused && queue.length > 0) {
      processQueue();
    } else if (isProcessing) {
      notifyProcess();
    }
  } else if (!prev && value) {
    // 正文生成开始，暂停启动新任务
  }
}

/** 手动暂停 */
export function pause(): void {
  isPaused = true;
}

/** 手动恢复 */
export function resume(): void {
  isPaused = false;
  if (!isProcessing && !isGenerating && queue.length > 0) {
    processQueue();
  } else if (isProcessing) {
    notifyProcess();
  }
}

/** 清空队列（聊天切换/紧急停止） */
export function clear(): void {
  // 标记所有排队任务为取消
  for (const task of queue) {
    task.status = 'cancelled';
    task.completedAt = Date.now();
    pushHistory(toRecord(task));
  }
  queue.length = 0;
  notifyProcess();
}

/**
 * 获取完整队列状态（供面板展示）
 */
export function getQueueState(): {
  isProcessing: boolean;
  isGenerating: boolean;
  isPaused: boolean;
  current: BackgroundTask | null;
  running: BackgroundTask[];
  queued: BackgroundTask[];
  history: BackgroundTask[];
} {
  const firstRunning = runningTasks.size > 0 ? [...runningTasks][0] : null;
  return {
    isProcessing,
    isGenerating,
    isPaused,
    current: firstRunning ? toRecord(firstRunning) : null,
    running: [...runningTasks].map(toRecord),
    queued: queue.map(toRecord),
    history: [...history],
  };
}

// ========== 队列处理 ==========

const TASK_TIMEOUT = 5 * 60 * 1000; // 5分钟

let processResolve: (() => void) | null = null;

async function processQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (true) {
      if (isGenerating || isPaused) {
        break;
      }

      const maxConcurrent = getMaxConcurrent();
      while (queue.length > 0 && runningTasks.size < maxConcurrent) {
        if (isGenerating || isPaused) break;
        // 同类型并发保障：若该类型已有任务在跑，则跳过队列里的同类型任务，
        // 等下一个 tick 再启。对其他类型无影响（旧 enqueue 去重本就只让1条进队列）；
        // 仅对带 dedupeKey 的小总结生效，保证 FIFO 一次只跑1个，不抢API。
        let pickedIdx = -1;
        const runningTypes = new Set<BackgroundTaskType>();
        for (const r of runningTasks) { runningTypes.add(r.type); }
        for (let i = 0; i < queue.length; i++) {
          const task = queue[i];
          if (!runningTypes.has(task.type)) { pickedIdx = i; break; }
        }
        if (pickedIdx === -1) break; // 队列里所有可启任务的同类型都已在跑，等下个tick
        const task = queue.splice(pickedIdx, 1)[0];
        task.status = 'running';
        task.startedAt = Date.now();
        runningTasks.add(task);
        runTask(task);
      }

      if (runningTasks.size === 0 && queue.length === 0) break;

      await new Promise<void>(resolve => {
        processResolve = resolve;
      });
      processResolve = null;
    }
  } finally {
    isProcessing = false;
  }
}

function notifyProcess(): void {
  if (processResolve) {
    const r = processResolve;
    processResolve = null;
    r();
  }
}

async function runTask(task: QueuedTask): Promise<void> {
  try {
    await Promise.race([
      task.execute(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`超时 (${TASK_TIMEOUT / 1000}s)`)), TASK_TIMEOUT),
      ),
    ]);
    task.status = 'completed';
    task.completedAt = Date.now();
    task.durationMs = task.completedAt - task.startedAt!;
    logInfo('后台队列', `${task.label} 完成 (${task.durationMs}ms)`);
  } catch (error: any) {
    task.status = 'failed';
    task.completedAt = Date.now();
    task.durationMs = task.completedAt - task.startedAt!;
    task.error = error?.message || String(error);
    logError('后台队列', `${task.label} 失败`, String(error));
  }
  pushHistory(toRecord(task));
  runningTasks.delete(task);
  // 排队模式下任务间加 300ms 间隔
  if (getMaxConcurrent() === 1) {
    setTimeout(() => notifyProcess(), TASK_INTERVAL_SERIAL);
  } else {
    notifyProcess();
  }
}

// ========== 兼容旧 scheduler 接口（过渡期） ==========

/** 兼容 enqueueAnalysis — 旧 task name 映射到新 type */
const LEGACY_NAME_MAP: Record<string, BackgroundTaskType> = {
  summary_chain: 'grand_summary',
  dreamtalk_chain: 'dreamtalk',
  dynamic_profile_v2: 'dynamic_profile_update',
  world_progress: 'world_progress',
  persona: 'persona',
  embedding: 'embedding',
  embedding_mem: 'embedding_mem',
  embedding_item: 'embedding_item',
  embedding_timeline: 'embedding_timeline',
};

export function enqueueAnalysis(name: string, execute: () => Promise<void>, dedupeKey?: string): void {
  const type = LEGACY_NAME_MAP[name] || (name as BackgroundTaskType);
  enqueue(type, execute, undefined, dedupeKey);
}

export function clearSchedulerQueue(): void {
  clear();
}

export function getSchedulerStatus(): {
  isProcessing: boolean;
  currentTask: string | null;
  runningTasks: string[];
  queueLength: number;
  queueNames: string[];
} {
  return {
    isProcessing,
    currentTask: runningTasks.size > 0 ? [...runningTasks][0].type : null,
    runningTasks: [...runningTasks].map(t => t.type),
    queueLength: queue.length,
    queueNames: queue.map(t => t.type),
  };
}

export function isSchedulerBusy(): boolean {
  return isProcessing || queue.length > 0;
}
