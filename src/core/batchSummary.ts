/**
 * 批量总结引擎 (V2)
 *
 * 从捕获记录中按楼层范围 + 每批N层，连续自动运行大总结。
 * 使用 V2 流水线：白描时间线 → 角色记忆+NSFW。
 * 单批失败自动重试3次（指数退避）。
 * 不做动态人设/梦呓/生态系统/世界进度/剧情导演。
 */

import { logInfo, logWarn, logError } from '../utils/logger';
import { checksumText, stableTextId } from './memoryWarehouseCodec';
import {
  activateBatchRebuild,
  discardBatchRebuild,
  finalizeBatchRebuild,
  loadBatchRebuildState,
  saveBatchRebuildCheckpoint,
} from './memoryWarehouseRuntime';
import { stageBatchMemoryTransaction } from './memoryCommitCoordinator';

import { executeGrandSummaryV2 } from './grandSummaryV2';
import { executeCharacterMemoryUpdate } from './characterMemoryUpdate';
import { embedTimelineEvents, embedCharacterMemories } from './embedding';
import { buildMemorySectionText } from './summary';
import type { CapturedContent, GrandSummary, TimelineEvent, CharacterMemory } from '../stores/mainStore';
import type { MemoryCheckpointRecord } from './memoryWarehouseTypes';

export interface BatchProgress {
  status: 'idle' | 'running' | 'done' | 'cancelled' | 'paused';
  /** 暂停原因：用户主动暂停可继续；error 表示重试耗尽或致命错误。 */
  pauseReason?: 'user' | 'error';
  currentBatch: number;
  totalBatches: number;
  totalMessages: number;
  startFloor: number;
  endFloor: number;
  batchSize: number;
  /** 当前批次实际楼层范围 */
  currentBatchFloorStart?: number;
  currentBatchFloorEnd?: number;
  /** 当前批次捕获条数 */
  currentBatchCount?: number;
  errors: Array<{ batch: number; message: string; retries: number }>;
}

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 5000;

/** 可中止的 sleep：每秒检查 abortSignal，被中止时抛 AbortError */
async function interruptibleSleep(ms: number, abortSignal?: { value: boolean }): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (abortSignal?.value) throw new DOMException('Aborted', 'AbortError');
    await new Promise(r => setTimeout(r, Math.min(1000, deadline - Date.now())));
  }
}

/** 按楼层范围将捕获记录分配到各批次 */
function computeBatchMap(
  contents: CapturedContent[],
  startFloor: number,
  endFloor: number,
  batchSize: number,
): Map<number, CapturedContent[]> {
  const totalFloors = endFloor - startFloor + 1;
  const totalBatches = Math.ceil(totalFloors / batchSize);
  const map = new Map<number, CapturedContent[]>();
  for (let b = 0; b < totalBatches; b++) map.set(b, []);

  for (const c of contents) {
    const batchIdx = Math.floor((c.messageId - startFloor) / batchSize);
    if (batchIdx >= 0 && batchIdx < totalBatches) {
      map.get(batchIdx)!.push(c);
    }
  }
  return map;
}

/**
 * 将 V2 大总结 + 角色记忆结果组装为 GrandSummary（统一存储格式）
 * 复刻 index.ts 和 OverviewTab.vue 中的组装逻辑
 */
function assembleGrandSummary(
  v2Events: Array<{
    time: string;
    location: string;
    presentCharacters: string[];
    summary: string;
    event: string;
    importance: number;
    keywords: string[];
  }>,
  memResult: { characterMemories: CharacterMemory[]; nsfwMemories: any[] },
  summaryVersion: number,
  previousSummary?: GrandSummary,
): GrandSummary {
  // V2 事件 → TimelineEvent[]（summary=速览用于召回，detail=完整经过用于注入）
  const timeline: TimelineEvent[] = v2Events.map(e => ({
    time: e.time,
    event: e.summary || e.event.slice(0, 50),
    detail: e.event,
    importance: e.importance,
    triggers: {
      characters: e.presentCharacters,
      keywords: e.keywords,
    },
  }));

  // 事件编号续接上次大总结
  const offset = previousSummary
    ? (() => {
        let max = 0;
        const s1 = previousSummary.rawText.split(/---SECTION---/i)[0] || '';
        for (const m of s1.matchAll(/\[#(\d+)\]/g)) max = Math.max(max, parseInt(m[1], 10));
        return max;
      })()
    : 0;
  let eventNum = offset;
  const s1Lines: string[] = [];
  for (const e of timeline) {
    eventNum++;
    s1Lines.push(`[#${eventNum}] [${e.time}] ${e.event}`);
    s1Lines.push(`重要性: ${e.importance || 3}`);
    if (e.detail) s1Lines.push(e.detail);
    if (e.triggers?.characters?.length) s1Lines.push(`[角色: ${e.triggers.characters.join(', ')}]`);
    if (e.triggers?.keywords?.length) s1Lines.push(`[关键词: ${e.triggers.keywords.join(', ')}]`);
    s1Lines.push('');
  }

  // Section 2: 角色记忆
  const section2 = buildMemorySectionText(memResult.characterMemories);

  // Section 3: NSFW
  let section3 = '[NSFW记录]\n无NSFW内容';
  if (memResult.nsfwMemories.length > 0) {
    const nsfwParts: string[] = [];
    for (const n of memResult.nsfwMemories) {
      nsfwParts.push(`### ${n.characterName}`);
      nsfwParts.push(`敏感点: ${n.sensitivePoints.join(', ')}`);
      nsfwParts.push(`偏好: ${n.preferences.join(', ')}`);
      nsfwParts.push(`行为模式: ${n.behaviors.join(', ')}`);
      nsfwParts.push('记忆:');
      for (const m of n.memories) nsfwParts.push(`- ${m}`);
    }
    section3 = nsfwParts.join('\n');
  }

  const rawText = [
    s1Lines.join('\n').trim() || '[剧情摘要]',
    '---SECTION---',
    section2.trim() || '[角色记忆]',
    '---SECTION---',
    section3,
  ].join('\n');

  return {
    version: summaryVersion,
    generatedAt: new Date().toISOString(),
    characterMemories: memResult.characterMemories,
    timeline,
    characterTable: memResult.characterMemories.map(m => ({
      name: m.characterName,
      aliases: m.keywords.slice(0, 3),
      identity: '',
      relationship: m.attitude === 'like' ? '好感' : m.attitude === 'dislike' ? '厌恶' : '中立',
      status: '活跃',
    })),
    rawText,
  };
}

export async function executeBatchSummary(
  startFloor: number,
  endFloor: number,
  batchSize: number,
  capturedContents: CapturedContent[],
  store: any,
  onProgress: (progress: BatchProgress) => void,
  /** 外部可设置此 ref 为 true 来中止批量（停止按钮） */
  abortSignal?: { value: boolean },
  options?: { resumeFromFloor?: number },
): Promise<void> {
  const progress: BatchProgress = {
    status: 'running',
    currentBatch: 0,
    totalBatches: 0,
    totalMessages: 0,
    startFloor,
    endFloor,
    batchSize,
    pauseReason: undefined,
    errors: [],
  };

  // 创建 AbortController：当外部设置 abortSignal.value=true 时真正中断 fetch 请求
  const controller = new AbortController();
  const pollAbort = () => {
    if (abortSignal?.value) controller.abort();
  };
  // 每 200ms 检查一次，有变化立即中止
  const abortPollTimer = setInterval(pollAbort, 200);

  try {
    // 1. 从捕获记录中筛选范围 + 按 messageId 排序
    const rangeContents = capturedContents
      .filter(c => c.messageId >= startFloor && c.messageId <= endFloor)
      .sort((a, b) => a.messageId - b.messageId);

    if (rangeContents.length === 0) {
      progress.status = 'done';
      onProgress(progress);
      logWarn('批量总结', `楼层 ${startFloor}-${endFloor} 内无捕获记录`);
      return;
    }

    progress.totalMessages = rangeContents.length;
    const totalFloors = endFloor - startFloor + 1;
    const totalBatches = Math.ceil(totalFloors / batchSize);
    progress.totalBatches = totalBatches;
    const batchContentsByFloor = computeBatchMap(rangeContents, startFloor, endFloor, batchSize);
    const chatId = SillyTavern.getCurrentChatId()?.trim() ?? '';
    if (!chatId) throw new Error('当前没有已打开的酒馆聊天');
    const sourceChatRevision = checksumText(rangeContents
      .map(content => `${content.messageId}:${checksumText(content.content)}`)
      .join('|'));
    const now = new Date().toISOString();
    const existingState = await loadBatchRebuildState(chatId);
    const existingCheckpoint = existingState.checkpoint;
    const checkpointMatches = !!(
      existingCheckpoint?.transactionId
      && ['running', 'paused', 'ready'].includes(existingCheckpoint.status)
      && existingCheckpoint.rangeStart === startFloor
      && existingCheckpoint.rangeEnd === endFloor
      && existingCheckpoint.batchSize === batchSize
      && existingCheckpoint.sourceChatRevision === sourceChatRevision
    );
    if (existingCheckpoint?.transactionId && !checkpointMatches) {
      await discardBatchRebuild(chatId, existingCheckpoint.transactionId, '批量范围或来源正文已变化');
    }
    const transactionId = checkpointMatches
      ? existingCheckpoint!.transactionId!
      : stableTextId('batch-rebuild', `${chatId}|${startFloor}|${endFloor}|${batchSize}|${Date.now()}`);
    let stagedSummaries = checkpointMatches
      ? existingState.summaries as GrandSummary[]
      : [];
    let activeCheckpoint: MemoryCheckpointRecord = checkpointMatches
      ? existingCheckpoint!
      : {
          id: 'checkpoint-full-rebuild',
          kind: 'checkpoint',
          taskType: 'full_rebuild',
          status: 'running',
          createdAt: now,
          updatedAt: now,
          rangeStart: startFloor,
          rangeEnd: endFloor,
          batchSize,
          nextFloor: startFloor,
          lastCommittedFloor: startFloor - 1,
          sourceChatRevision,
          transactionId,
          statistics: {
            processedBatches: 0,
            failedBatches: 0,
            summaryRecords: 0,
            characterMemoryRecords: 0,
            vectorRecords: 0,
          },
        };

    if (activeCheckpoint.status === 'ready') {
      store.replaceSummaryRangeAtomically(startFloor, endFloor, stagedSummaries);
      for (const summary of stagedSummaries) {
        const nsfw = (summary as any)._batchNsfwMemories;
        if (Array.isArray(nsfw) && nsfw.length > 0) store.updateNsfwMemories(nsfw);
      }
      store.forcePersist();
      await finalizeBatchRebuild(chatId, transactionId);
      progress.currentBatch = totalBatches;
      progress.status = 'done';
      progress.pauseReason = undefined;
      onProgress({ ...progress });
      logInfo('批量总结', `已从 ready Checkpoint 恢复并完成投影: ${transactionId}`);
      return;
    }
    activeCheckpoint = { ...activeCheckpoint, status: 'running', error: undefined, updatedAt: new Date().toISOString() };
    await saveBatchRebuildCheckpoint(chatId, activeCheckpoint);
    progress.pauseReason = undefined;
    const pauseForUser = async (): Promise<void> => {
      activeCheckpoint = {
        ...activeCheckpoint,
        status: 'paused',
        error: '用户暂停批量总结',
        updatedAt: new Date().toISOString(),
      };
      await saveBatchRebuildCheckpoint(chatId, activeCheckpoint);
      progress.status = 'paused';
      progress.pauseReason = 'user';
      onProgress({ ...progress });
    };
    const resumeFloor = Math.max(
      startFloor,
      activeCheckpoint.nextFloor,
      Math.floor(options?.resumeFromFloor ?? startFloor),
    );
    const firstBatch = Math.max(0, Math.floor((resumeFloor - startFloor) / batchSize));
    onProgress({ ...progress });
    logInfo(
      '批量总结',
      `${stagedSummaries.length > 0 ? '断点续跑' : '开始'}: 楼层 ${startFloor}-${endFloor}, ${rangeContents.length}条, ${totalBatches}批, tx=${transactionId}`,
    );

    // 2. 逐批处理（按楼层范围）
    for (let b = firstBatch; b < totalBatches; b++) {
      // 外部中止检查
      if (abortSignal?.value) {
        await pauseForUser();
        return;
      }
      const batchStartFloor = startFloor + b * batchSize;
      const batchEndFloor = Math.min(startFloor + (b + 1) * batchSize - 1, endFloor);
      const batchContents = batchContentsByFloor.get(b) || [];

      progress.currentBatch = b + 1;
      progress.currentBatchFloorStart = batchStartFloor;
      progress.currentBatchFloorEnd = batchEndFloor;
      progress.currentBatchCount = batchContents.length;
      onProgress({ ...progress });

      if (batchContents.length === 0) {
        activeCheckpoint = {
          ...activeCheckpoint,
          status: 'running',
          nextFloor: batchEndFloor + 1,
          lastCommittedFloor: batchEndFloor,
          updatedAt: new Date().toISOString(),
        };
        await saveBatchRebuildCheckpoint(chatId, activeCheckpoint);
        continue;
      }

      const lastMsgId = batchContents[batchContents.length - 1].messageId;
      const batchCoveredIds = batchContents.map(c => c.messageId);

      // 重试循环
      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        // 每次重试前检查中止信号
        if (abortSignal?.value) {
          await pauseForUser();
          return;
        }

        // 非首次尝试时等待
        if (retry > 0) {
          const delay = RETRY_BASE_DELAY * Math.pow(2, retry - 1);
          logWarn('批量总结', `第${b + 1}/${totalBatches}批失败, ${delay / 1000}s后重试(${retry}/${MAX_RETRIES})`);
          try {
            await interruptibleSleep(delay, abortSignal);
          } catch (e: any) {
            if (e?.name === 'AbortError') {
              await pauseForUser();
              return;
            }
            throw e;
          }
        }

        try {
          // 获取上次总结作为上下文（每批自动续接）
          const previousSummary = store.previewSummarySequence(stagedSummaries) || store.getLatestSummary();
          const existingMemories: CharacterMemory[] = previousSummary?.characterMemories || [];
          const summaryVersion = (previousSummary?.version || 0) + 1;

          // === 步骤1：V2 白描事实时间线（空小总结 → 兜底原文模式） ===
          const v2Result = await executeGrandSummaryV2(
            [],  // 批量总结无小总结，走 buildInputMaterial 的兜底模式
            batchContents,
            previousSummary?.rawText,  // 续接上次事件编号
            store.getUserName(),
            controller.signal,
            { _responseFormat: 'json_object' },
          );

          // AI 调用完成后立即检查中止
          if (abortSignal?.value) {
            await pauseForUser();
            return;
          }

          // === 步骤2：角色记忆 + NSFW（调色盘分析） ===
          const memResult = await executeCharacterMemoryUpdate(
            batchContents,
            existingMemories,
            4, 8,
            store.getUserName(),
            controller.signal,
            { _responseFormat: 'json_object' },
          );

          if (abortSignal?.value) {
            await pauseForUser();
            return;
          }

          // === 组装 GrandSummary 并存储 ===
          const summary = assembleGrandSummary(
            v2Result.events,
            memResult,
            summaryVersion,
            previousSummary,
          );
          summary.upToMessageId = lastMsgId;
          summary.coveredMessageIds = batchCoveredIds;
          summary.rebuildTransactionId = transactionId;
          (summary as any)._batchNsfwMemories = memResult.nsfwMemories;
          store.prepareSummaryForCommit(summary);

          // === 向量先写入 staged bundle；失败时保留可重建的文本记录 ===
          if (store.settings.embeddingEnabled && store.settings.embeddingApiKey) {
            try {
              if (summary.timeline.length > 0) {
                await embedTimelineEvents(
                  summary.timeline,
                  store.settings.embeddingApiUrl,
                  store.settings.embeddingApiKey,
                  store.settings.embeddingModel,
                  store.settings.embeddingDimensions,
                  undefined,
                  store.settings.embeddingManualMatryoshka,
                );
              }
              const totalCores = memResult.characterMemories.reduce(
                (sum: number, memory: any) => sum + (memory.coreMemories?.length || 0),
                0,
              );
              if (totalCores > 0) {
                await embedCharacterMemories(
                  memResult.characterMemories,
                  store.settings.embeddingApiUrl,
                  store.settings.embeddingApiKey,
                  store.settings.embeddingModel,
                  store.settings.embeddingDimensions,
                  store.settings.embeddingManualMatryoshka,
                );
              }
            } catch (embeddingError) {
              logWarn('批量总结', 'Embedding 失败，保留文本并允许后续 vector_rebuild', String(embeddingError));
            }
          }

          const characterRecordCount = memResult.characterMemories.reduce(
            (sum: number, memory: any) => sum + (
              memory.orderedNewMemories?.length
              || (memory.coreMemories?.length || 0) + (memory.recentMemories?.length || 0)
            ),
            0,
          );
          const vectorRecordCount = summary.timeline.filter(event => event.embedding?.length).length
            + memResult.characterMemories.reduce(
              (sum: number, memory: any) => sum + (memory.coreMemories || []).filter((item: any) => (
                typeof item !== 'string' && item.embedding?.length
              )).length,
              0,
            );
          const checkpoint: MemoryCheckpointRecord = {
            ...activeCheckpoint,
            status: 'running',
            nextFloor: batchEndFloor + 1,
            lastCommittedFloor: batchEndFloor,
            updatedAt: new Date().toISOString(),
            error: undefined,
            statistics: {
              processedBatches: activeCheckpoint.statistics.processedBatches + 1,
              failedBatches: activeCheckpoint.statistics.failedBatches,
              summaryRecords: activeCheckpoint.statistics.summaryRecords + 1 + summary.timeline.length,
              characterMemoryRecords: activeCheckpoint.statistics.characterMemoryRecords + characterRecordCount,
              vectorRecords: activeCheckpoint.statistics.vectorRecords + vectorRecordCount,
            },
          };
          const staged = await stageBatchMemoryTransaction({
            chatId,
            smallSummaries: [],
            grandSummary: summary,
            assistantContents: batchContents,
            settings: {
              embeddingApiUrl: store.settings.embeddingApiUrl,
              embeddingModel: store.settings.embeddingModel,
              embeddingDimensions: store.settings.embeddingDimensions,
            },
            transactionId,
            checkpoint,
          });
          summary.memoryBundleId = staged.bundleId;
          stagedSummaries = [...stagedSummaries, summary];
          activeCheckpoint = {
            ...checkpoint,
            lastCommittedBundleId: staged.bundleId,
          };

          logInfo('批量总结', `第${b + 1}/${totalBatches}批已进入 staging，尚未对召回生效`);
          break;
        } catch (err: any) {
          // AbortError = 用户中止请求，直接退出
          if (err?.name === 'AbortError') {
            await pauseForUser();
            clearInterval(abortPollTimer);
            return;
          }
          if (err?.name === 'MemorySourceChangedError') {
            progress.status = 'cancelled';
            progress.pauseReason = undefined;
            progress.errors.push({
              batch: b + 1,
              message: String(err?.message || '来源聊天已经变化，本次批量重建已取消'),
              retries: retry,
            });
            onProgress({ ...progress });
            logWarn('批量总结', '来源聊天已经变化，本次事务已取消且不会续写旧 Checkpoint');
            clearInterval(abortPollTimer);
            return;
          }
          // 记录错误，下一轮循环会在开头检查中止+等待
          progress.errors.push({
            batch: b + 1,
            message: String(err?.message || err),
            retries: retry + 1,
          });
          onProgress({ ...progress });
          if (retry >= MAX_RETRIES) {
            logError('批量总结', `第${b + 1}/${totalBatches}批最终失败，已暂停`);
            progress.errors.push({
              batch: b + 1,
              message: String(err?.message || err),
              retries: MAX_RETRIES + 1,
            });
            progress.status = 'paused';
            progress.pauseReason = 'error';
            activeCheckpoint = {
              ...activeCheckpoint,
              status: 'paused',
              error: String(err?.message || err),
              updatedAt: new Date().toISOString(),
              statistics: {
                ...activeCheckpoint.statistics,
                failedBatches: activeCheckpoint.statistics.failedBatches + 1,
              },
            };
            await saveBatchRebuildCheckpoint(chatId, activeCheckpoint);
            onProgress({ ...progress });
            return;  // 停止整个批量，等待用户决定继续或放弃
          }
        }
      }
    }

    await activateBatchRebuild(chatId, transactionId);
    const activatedState = await loadBatchRebuildState(chatId);
    const activatedSummaries = activatedState.summaries as GrandSummary[];
    store.replaceSummaryRangeAtomically(startFloor, endFloor, activatedSummaries);
    for (const summary of activatedSummaries) {
      const nsfw = (summary as any)._batchNsfwMemories;
      if (Array.isArray(nsfw) && nsfw.length > 0) store.updateNsfwMemories(nsfw);
    }
    store.forcePersist();
    await finalizeBatchRebuild(chatId, transactionId);

    progress.currentBatch = totalBatches;
    progress.status = 'done';
    progress.pauseReason = undefined;
    onProgress({ ...progress });
    const okCount = totalBatches - progress.errors.filter((e) => e.retries > MAX_RETRIES).length;
    logInfo('批量总结', `原子激活完成: ${okCount}/${totalBatches}批成功, tx=${transactionId}`);
  } catch (err: any) {
    clearInterval(abortPollTimer);
    if (err?.name === 'AbortError') {
      progress.status = 'paused';
      progress.pauseReason = 'user';
    } else {
      progress.status = 'paused';
      progress.pauseReason = 'error';
      progress.errors.push({
        batch: 0,
        message: `致命错误: ${err?.message || err}`,
        retries: 0,
      });
      logError('批量总结', `致命错误: ${err?.message || err}`);
    }
    onProgress({ ...progress });
  } finally {
    clearInterval(abortPollTimer);
  }
}
