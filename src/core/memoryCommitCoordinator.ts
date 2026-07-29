import {
  commitMemoryBundleFromDerivedState,
  stageBatchMemoryBundleFromDerivedState,
  type MemoryWarehouseRuntimeSettings,
} from './memoryWarehouseRuntime';
import type {
  MemoryBundleCommitResult,
  SourceGrandSummary,
  SourceSmallSummary,
} from './memoryWarehouseRepository';
import type { MemoryBundleRecord, MemoryCheckpointRecord } from './memoryWarehouseTypes';
import { RawChatReader, rawChatReader, type RawChatSourceContent } from './rawChatReader';

export interface DerivedAssistantContent {
  messageId: number;
  content: string;
}

interface MemoryCommitBase {
  chatId: string;
  smallSummaries: SourceSmallSummary[];
  grandSummary: SourceGrandSummary & { memoryBundleId?: string };
  assistantContents: readonly DerivedAssistantContent[];
  settings: MemoryWarehouseRuntimeSettings;
  reader?: RawChatReader;
}

export interface RealtimeMemoryCommit extends MemoryCommitBase {
  bundleType?: Extract<MemoryBundleRecord['bundleType'], 'realtime' | 'derived_rebuild'>;
  expectedBundleId?: string;
  replaceBundleIds?: string[];
  /** 只有仓库提交成功后才会调用；热 Store 的游标推进必须放在这里。 */
  onCommitted?: (result: MemoryBundleCommitResult) => void | Promise<void>;
}

export interface BatchMemoryCommit extends MemoryCommitBase {
  transactionId: string;
  checkpoint: MemoryCheckpointRecord;
}

function sourceChangedError(message: string): Error {
  const error = new Error(message);
  error.name = 'MemorySourceChangedError';
  return error;
}

export function buildMemorySourceContents(
  assistantContents: readonly DerivedAssistantContent[],
  reader: RawChatReader = rawChatReader,
): RawChatSourceContent[] {
  const expected = new Map(
    assistantContents
      .filter(item => Number.isFinite(item.messageId) && typeof item.content === 'string')
      .map(item => [Math.floor(item.messageId), item.content] as const),
  );
  if (expected.size === 0) throw new Error('记忆提交缺少有效的助手来源楼层');
  const sourceContents = reader.readSourceContentsForAssistantFloors([...expected.keys()]);
  const assistantSources = new Map(
    sourceContents
      .filter(item => item.role === 'assistant')
      .map(item => [item.messageId, item] as const),
  );
  for (const [messageId, content] of expected) {
    const current = assistantSources.get(messageId);
    if (!current) throw sourceChangedError(`原始聊天中已找不到助手楼层 ${messageId}，拒绝提交过期记忆`);
    if (current.content !== content) {
      throw sourceChangedError(`助手楼层 ${messageId} 的当前 swipe 正文已经变化，拒绝提交过期记忆`);
    }
  }
  return sourceContents;
}

/**
 * 自动、手动和重新总结共用的实时提交边界：先核对原始楼层，再提交仓库，
 * 最后才允许调用方推进 mainStore 热投影。
 */
export async function commitRealtimeMemoryTransaction(
  input: RealtimeMemoryCommit,
): Promise<MemoryBundleCommitResult> {
  const result = await commitMemoryBundleFromDerivedState({
    chatId: input.chatId,
    smallSummaries: input.smallSummaries,
    grandSummary: input.grandSummary,
    sourceContents: buildMemorySourceContents(input.assistantContents, input.reader),
    settings: input.settings,
    bundleType: input.bundleType ?? 'realtime',
    expectedBundleId: input.expectedBundleId,
    replaceBundleIds: input.replaceBundleIds,
  });
  input.grandSummary.memoryBundleId = result.bundleId;
  await input.onCommitted?.(result);
  return result;
}

/** 批量链只写 staged Bundle；热投影仍要等全部批次原子激活后再替换。 */
export async function stageBatchMemoryTransaction(
  input: BatchMemoryCommit,
): Promise<MemoryBundleCommitResult> {
  const result = await stageBatchMemoryBundleFromDerivedState({
    chatId: input.chatId,
    smallSummaries: input.smallSummaries,
    grandSummary: input.grandSummary,
    sourceContents: buildMemorySourceContents(input.assistantContents, input.reader),
    settings: input.settings,
    bundleType: 'batch_rebuild',
    transactionId: input.transactionId,
    checkpoint: input.checkpoint,
  });
  input.grandSummary.memoryBundleId = result.bundleId;
  return result;
}
