/**
 * 大总结链 —— 「大总结V2（时间线）」+「角色记忆更新」的统一执行入口。
 *
 * 背景：这三条链路原本各写各的，行为不一致 ——
 *   - `index.ts` 的 `executeSummaryChain`：并发（Promise.allSettled）+ 耗时日志
 *   - `OverviewTab.vue` 的 `runGrandSummaryAndHide`：串行（await 接 await）+ 无日志 + 无 signal
 *   - `batchSummary.ts` 的批量总结：串行 + 无日志（有 signal）
 * 同一个功能三套写法，改一次要改三处，且用户观察到的"大总结出完字才出角色记忆"就是串行现场。
 *
 * 本模块把这些共性收敛到一处：
 *   - 并发执行（两条链路互不依赖，可同时发请求）
 *   - 耗时日志（判据：总耗时≈最长者=真并发；≈各任务之和=串行）
 *   - AbortSignal 透传（可被外部中止）
 *   - 按需开关（只跑事件 / 只跑记忆 / 都跑）
 *
 * ⚠️ 重试策略**不**放在这里：三个入口的重试语义不同
 *   （index.ts 走弹窗倒计时循环；批量总结交给 callGenerateRaw 的内层重试；
 *    总览页手动触发靠用户点"重新总结"），因此由调用方决定。
 */

import type { CapturedContent, CharacterMemory, SmallSummaryRecord } from '../stores/mainStore';
import { executeGrandSummaryV2 } from './grandSummaryV2';
import type { GrandSummaryV2Result } from './grandSummaryV2';
import { executeCharacterMemoryUpdate } from './characterMemoryUpdate';
import type { CharacterMemoryUpdateResult } from './characterMemoryUpdate';
import { logInfo } from '../utils/logger';

/** 要跑哪几条链路；缺省 = 两条都跑 */
export interface SummaryChainOptions {
  /** 是否跑大总结 V2（时间线）。缺省 true */
  event?: boolean;
  /** 是否跑角色记忆更新。缺省 true */
  memory?: boolean;
  /** 中止信号，透传给两条链路 */
  abortSignal?: AbortSignal;
  /** 角色记忆条数下限（仅 memory 生效） */
  memoryMin?: number;
  /** 角色记忆条数上限（仅 memory 生效） */
  memoryMax?: number;
  /** 追加到 generateRaw 的参数（如 _responseFormat） */
  extraGenerateParams?: { _responseFormat?: 'json_object' | 'text' };
  /** 角色黑名单 */
  blacklistedNames?: string[];
  /** 日志前缀，便于区分调用来源（如 '大总结链' / '批量总结' / '总览页'） */
  logScope?: string;
}

export interface SummaryChainResult {
  /** 大总结 V2 结果；未跑 event 时为 null */
  v2Result: GrandSummaryV2Result | null;
  /** 角色记忆结果；未跑 memory 时为 null */
  memResult: CharacterMemoryUpdateResult | null;
}

/**
 * 缺口补齐：只补跑尚未拿到的部分。
 * 用于 index.ts 的重试循环 —— 大总结已成功、角色记忆失败时，
 * 下一轮只重发角色记忆，不白白重跑大总结（省 token、省时间）。
 */
export interface SummaryChainResume {
  /** 已有的大总结结果；非空则跳过 event */
  v2Result?: GrandSummaryV2Result | null;
  /** 已有的角色记忆结果；非空则跳过 memory */
  memResult?: CharacterMemoryUpdateResult | null;
}

/**
 * 统一执行「大总结 + 角色记忆」，两条链路并发。
 *
 * @param contents  待总结的正文内容
 * @param smallSummaries 小总结（大总结 V2 的补充材料）
 * @param previousSummaryText 上一版大总结原文（用于续接事件编号）
 * @param existingMemories 既有角色记忆（作为 delta 基线）
 * @param userName 用户名
 * @param options 开关 / 中止信号 / 参数
 * @param resume 续跑：已有结果则不重跑对应链路
 */
export async function runSummaryChain(
  contents: CapturedContent[],
  smallSummaries: SmallSummaryRecord[],
  previousSummaryText: string | undefined,
  existingMemories: CharacterMemory[],
  userName: string,
  options: SummaryChainOptions = {},
  resume: SummaryChainResume = {},
): Promise<SummaryChainResult> {
  const doEvent = options.event !== false;
  const doMemory = options.memory !== false;
  const scope = options.logScope || '大总结链';

  const tasks: Array<{
    key: 'summary' | 'memory';
    name: string;
    promise: Promise<any>;
  }> = [];

  // ★ 续跑：已有结果就不再入列（失败重试时只补缺口）
  if (doEvent && !resume.v2Result) {
    tasks.push({
      key: 'summary',
      name: '大总结V2',
      promise: executeGrandSummaryV2(
        smallSummaries,
        contents,
        previousSummaryText,
        userName,
        options.abortSignal,
        options.extraGenerateParams,
        options.blacklistedNames,
      ),
    });
  }
  if (doMemory && !resume.memResult) {
    tasks.push({
      key: 'memory',
      name: '角色记忆更新',
      promise: executeCharacterMemoryUpdate(
        contents,
        existingMemories,
        options.memoryMin ?? 4,
        options.memoryMax ?? 8,
        userName,
        options.abortSignal,
        options.extraGenerateParams,
        options.blacklistedNames,
      ),
    });
  }

  // 没有任何任务要跑（两条链路都已续跑完成）→ 直接回填
  if (tasks.length === 0) {
    return {
      v2Result: resume.v2Result ?? null,
      memResult: resume.memResult ?? null,
    };
  }

  // 诊断：记录每个子任务的实际耗时。
  // 判据：总耗时 ≈ 最长者 → 真并发；≈ 各任务之和 → 实际串行了。
  const chainT0 = Date.now();
  const settled = await Promise.allSettled(
    tasks.map(async (task) => {
      const subT0 = Date.now();
      const v = await task.promise;
      logInfo(scope, `${task.name} 耗时 ${Date.now() - subT0}ms`);
      return v;
    }),
  );
  logInfo(
    scope,
    `并发启动 ${tasks.length} 个任务，总耗时 ${Date.now() - chainT0}ms`
      + '（≈最长者=并发；≈各任务之和=串行）',
  );

  // 失败汇总：把每个失败任务的原因带上，便于上层决定重试粒度
  const failed: Array<{ name: string; reason: any }> = [];
  let v2Result: GrandSummaryV2Result | null = resume.v2Result ?? null;
  let memResult: CharacterMemoryUpdateResult | null = resume.memResult ?? null;

  for (let i = 0; i < settled.length; i++) {
    const task = tasks[i];
    const result = settled[i];
    if (result.status === 'fulfilled') {
      if (task.key === 'summary') v2Result = result.value;
      if (task.key === 'memory') memResult = result.value;
    } else {
      failed.push({ name: task.name, reason: result.reason });
    }
  }

  if (failed.length > 0) {
    // AbortError 优先原样抛出，让上层识别"用户主动中止"
    const abortError = failed.find(f => f.reason?.name === 'AbortError')?.reason;
    if (abortError) throw abortError;

    // ★ 把已成功的部分挂到错误上，上层可据此做"只重试失败项"的续跑
    //   用法：catch (e) { if (e.partial) resume = e.partial; }
    const firstFailed = failed[0];
    const message = firstFailed.reason?.message || String(firstFailed.reason);
    const err: any = new Error(`${firstFailed.name}失败：${message}`);
    err.partial = { v2Result, memResult };
    err.failedTasks = failed.map(f => f.name);
    throw err;
  }

  return { v2Result, memResult };
}
