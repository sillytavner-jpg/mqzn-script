import { checksumText, encodeFloat32Vector, stableTextId } from './memoryWarehouseCodec';
import { MemoryWarehouse } from './memoryWarehouse';
import {
  buildMemoryWarehouseDataset,
  MemoryWarehouseRepository,
  type CharacterMemoryRecallQuery,
  type CharacterMemoryRecallResult,
  type EmbeddingIndexIdentity,
  type MemoryBundleCommitResult,
  type MemoryRecallQuery,
  type MemoryWarehouseDataset,
  type MemoryWarehouseDatasetBuildInput,
  type MemoryWarehouseDatasetCommitResult,
  type SourceGrandSummary,
  type SourceSmallSummary,
  type TimelineEventRecallQuery,
  type TimelineEventRecallResult,
} from './memoryWarehouseRepository';
import type {
  CharacterMemorySegmentRecord,
  MemoryCheckpointRecord,
  MemoryBundleRecord,
  MemorySourceMessageFingerprint,
  MemoryWarehouseInspection,
  MemoryWarehouseQuery,
  MemoryWarehouseQueryResult,
  SummarySegmentRecord,
  VectorIndexRecord,
} from './memoryWarehouseTypes';
import type { RawChatSourceContent } from './rawChatReader';

export const MEMORY_WAREHOUSE_RUNTIME_VERSION = 3 as const;

export interface MemoryWarehouseRuntimeSettings {
  embeddingApiUrl?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
}

export interface MemoryWarehouseRuntimeSource {
  chatId: string;
  smallSummaries: SourceSmallSummary[];
  grandSummaries: SourceGrandSummary[];
  settings: MemoryWarehouseRuntimeSettings;
}

export interface MemoryWarehouseDerivedBundleSource {
  chatId: string;
  smallSummaries: SourceSmallSummary[];
  grandSummary: SourceGrandSummary;
  sourceContents: RawChatSourceContent[];
  settings: MemoryWarehouseRuntimeSettings;
  bundleType: MemoryBundleRecord['bundleType'];
  expectedBundleId?: string;
  replaceBundleIds?: string[];
}

export interface MemoryWarehouseBatchStageSource extends MemoryWarehouseDerivedBundleSource {
  transactionId: string;
  checkpoint: MemoryCheckpointRecord;
}

export interface MemoryWarehouseBatchRebuildState {
  checkpoint: MemoryCheckpointRecord | null;
  summaries: Array<SourceGrandSummary & { memoryBundleId?: string; rebuildTransactionId?: string }>;
}

export interface MemorySourceReconcileResult {
  examinedBundles: number;
  sourceChanged: boolean;
  invalidatedBundleCount: number;
  invalidatedStagedBundleCount: number;
  checkpointDeleted: boolean;
}

export interface MemoryWarehouseTestFixture {
  characterName: string;
  fact: string;
  storyTime?: string;
  floor?: number;
  keywords?: string[];
  vector?: number[];
  embedding?: EmbeddingIndexIdentity;
}

export interface MemoryWarehouseRuntimeHandle {
  chatId: string;
  warehouse: MemoryWarehouse;
  repository: MemoryWarehouseRepository;
}

export interface MemoryWarehouseDebugApi {
  readonly version: typeof MEMORY_WAREHOUSE_RUNTIME_VERSION;
  currentChatId(): string;
  inspect(): Promise<MemoryWarehouseInspection>;
  rebuildFromCurrentDerivedStateForTesting(): Promise<MemoryWarehouseDatasetCommitResult>;
  query(query?: MemoryWarehouseQuery): Promise<MemoryWarehouseQueryResult>;
  recall(query: MemoryRecallQuery): ReturnType<MemoryWarehouseRepository['recall']>;
  recallTimeline(query: TimelineEventRecallQuery): ReturnType<MemoryWarehouseRepository['recallTimelineEvents']>;
  seedFixture(fixture: MemoryWarehouseTestFixture): Promise<MemoryWarehouseDatasetCommitResult>;
  clearWarehouse(): Promise<void>;
}

declare global {
  interface Window {
    __MQZN_MEMORY_WAREHOUSE_V1__?: MemoryWarehouseDebugApi;
  }
}

let activeRuntime: MemoryWarehouseRuntimeHandle | null = null;

function getCurrentChatId(): string {
  try {
    return SillyTavern.getCurrentChatId()?.trim() ?? '';
  } catch {
    return '';
  }
}

function assertCurrentChat(expectedChatId?: string): string {
  const currentChatId = getCurrentChatId();
  if (!currentChatId) throw new Error('当前没有已打开的酒馆聊天');
  if (expectedChatId && currentChatId !== expectedChatId) {
    throw new Error(`聊天已经切换：需要 ${expectedChatId}，当前为 ${currentChatId}`);
  }
  return currentChatId;
}

function getRuntime(expectedChatId?: string): MemoryWarehouseRuntimeHandle {
  const chatId = assertCurrentChat(expectedChatId);
  if (!activeRuntime || activeRuntime.chatId !== chatId) {
    const warehouse = new MemoryWarehouse({ chatId });
    activeRuntime = {
      chatId,
      warehouse,
      repository: new MemoryWarehouseRepository(warehouse),
    };
  }
  return activeRuntime;
}

function embeddingProvider(apiUrl?: string): string {
  if (!apiUrl?.trim()) return 'custom';
  try {
    return new URL(apiUrl).host || 'custom';
  } catch {
    return 'custom';
  }
}

function detectEmbeddingDimensions(source: MemoryWarehouseRuntimeSource): number {
  const configured = Number(source.settings.embeddingDimensions ?? 0);
  if (Number.isInteger(configured) && configured > 0) return configured;
  for (const summary of source.grandSummaries) {
    for (const event of summary.timeline ?? []) {
      if (event.embedding && event.embedding.length > 0) return event.embedding.length;
    }
    for (const memory of summary.characterMemories ?? []) {
      for (const item of memory.coreMemories ?? []) {
        if (typeof item !== 'string' && item.embedding && item.embedding.length > 0) return item.embedding.length;
      }
    }
  }
  return 0;
}

function embeddingIdentity(source: MemoryWarehouseRuntimeSource): EmbeddingIndexIdentity {
  return {
    provider: embeddingProvider(source.settings.embeddingApiUrl),
    model: source.settings.embeddingModel?.trim() || 'unknown',
    dimensions: detectEmbeddingDimensions(source),
    indexVersion: 1,
  };
}

export async function rebuildMemoryWarehouseFromDerivedStateForTesting(
  source: MemoryWarehouseRuntimeSource,
): Promise<MemoryWarehouseDatasetCommitResult> {
  const runtime = getRuntime(source.chatId);
  const buildInput: MemoryWarehouseDatasetBuildInput = {
    chatId: source.chatId,
    smallSummaries: source.smallSummaries,
    grandSummaries: source.grandSummaries,
    embedding: embeddingIdentity(source),
  };
  const dataset = buildMemoryWarehouseDataset(buildInput);
  return runtime.repository.replaceDataset(dataset);
}

export async function commitMemoryBundleFromDerivedState(
  source: MemoryWarehouseDerivedBundleSource,
): Promise<MemoryBundleCommitResult> {
  const runtime = getRuntime(source.chatId);
  const sourceMessages = fingerprintMemorySourceContents(source.sourceContents);
  if (sourceMessages.length === 0) throw new Error('MemoryBundle 缺少有效的来源聊天正文');

  const runtimeSource: MemoryWarehouseRuntimeSource = {
    chatId: source.chatId,
    smallSummaries: source.smallSummaries,
    grandSummaries: [{ ...source.grandSummary, sourceMessages }],
    settings: source.settings,
  };
  const dataset = buildMemoryWarehouseDataset({
    chatId: source.chatId,
    smallSummaries: source.smallSummaries,
    grandSummaries: runtimeSource.grandSummaries,
    embedding: embeddingIdentity(runtimeSource),
    bundleType: source.bundleType,
  });
  if (dataset.bundles.length !== 1) {
    throw new Error(`单次实时提交必须生成 1 个 MemoryBundle，实际 ${dataset.bundles.length} 个`);
  }
  if (source.expectedBundleId && dataset.bundles[0].id !== source.expectedBundleId) {
    throw new Error(
      `MemoryBundle 来源已变化：需要 ${source.expectedBundleId}，重新计算得到 ${dataset.bundles[0].id}`,
    );
  }
  return runtime.repository.commitBundle({
    bundle: dataset.bundles[0],
    summaries: dataset.summaries,
    characterMemories: dataset.characterMemories,
    vectors: dataset.vectors,
    replaceBundleIds: source.replaceBundleIds,
  });
}

export function fingerprintMemorySourceContents(sourceContents: RawChatSourceContent[]) {
  return sourceContents
    .filter(item => Number.isFinite(item.messageId) && typeof item.content === 'string' && item.content.length > 0)
    .sort((left, right) => left.messageId - right.messageId)
    .filter((item, index, all) => index === 0 || item.messageId !== all[index - 1].messageId)
    .map(item => ({
      messageId: item.messageId,
      contentHash: checksumText(item.content),
      role: item.role,
      ...(Number.isInteger(item.swipeId) ? { swipeId: item.swipeId } : {}),
      ...(item.metadataHash?.trim() ? { metadataHash: item.metadataHash.trim() } : {}),
      ...(item.sceneId?.trim() ? { sceneId: item.sceneId.trim() } : {}),
      ...(item.traceId?.trim() ? { traceId: item.traceId.trim() } : {}),
    }));
}

export async function stageBatchMemoryBundleFromDerivedState(
  source: MemoryWarehouseBatchStageSource,
): Promise<MemoryBundleCommitResult> {
  const runtime = getRuntime(source.chatId);
  const transactionId = source.transactionId.trim();
  if (!transactionId) throw new Error('批量重建事务 ID 不能为空');
  if (source.checkpoint.transactionId !== transactionId || source.checkpoint.status === 'ready') {
    throw new Error('staged bundle 必须绑定同一批量事务的运行中 Checkpoint');
  }
  const persistedCheckpoint = await runtime.repository.getCheckpoint('full_rebuild');
  if (!persistedCheckpoint || persistedCheckpoint.transactionId !== transactionId) {
    const error = new Error('批量重建事务已因来源变化或用户操作失效，拒绝重新写入 staged Bundle');
    error.name = 'MemorySourceChangedError';
    throw error;
  }
  const sourceMessages = fingerprintMemorySourceContents(source.sourceContents);
  if (sourceMessages.length === 0) throw new Error('批量 MemoryBundle 缺少有效的来源聊天正文');

  // staging 命名空间确保重建结果不会覆盖当前 committed 子记录。
  const stagingChatId = `${source.chatId}#rebuild:${transactionId}`;
  const runtimeSource: MemoryWarehouseRuntimeSource = {
    chatId: stagingChatId,
    smallSummaries: source.smallSummaries,
    grandSummaries: [{ ...source.grandSummary, sourceMessages }],
    settings: source.settings,
  };
  const dataset = buildMemoryWarehouseDataset({
    chatId: stagingChatId,
    smallSummaries: source.smallSummaries,
    grandSummaries: runtimeSource.grandSummaries,
    embedding: embeddingIdentity(runtimeSource),
    bundleType: 'batch_rebuild',
    includeGrandSummaryProjection: true,
  });
  if (dataset.bundles.length !== 1) {
    throw new Error(`单批重建必须生成 1 个 MemoryBundle，实际 ${dataset.bundles.length} 个`);
  }
  const now = new Date().toISOString();
  const bundle = dataset.bundles[0];
  bundle.status = 'staged';
  bundle.rebuildTransactionId = transactionId;
  bundle.stagedAt = now;
  bundle.committedAt = undefined;
  const overview = dataset.summaries.find(record => (
    record.kind === 'summary'
    && record.bundleId === bundle.id
    && record.segmentType === 'grand_overview'
  ));
  if (!overview) throw new Error('staged bundle 缺少 grand overview 投影');
  overview.payload = {
    ...(overview.payload ?? {}),
    grandSummaryProjection: {
      ...source.grandSummary,
      memoryBundleId: bundle.id,
      rebuildTransactionId: transactionId,
    },
  };
  const checkpoint: MemoryCheckpointRecord = {
    ...source.checkpoint,
    lastCommittedBundleId: bundle.id,
    updatedAt: now,
  };
  return runtime.repository.commitBundle({
    bundle,
    summaries: dataset.summaries,
    characterMemories: dataset.characterMemories,
    vectors: dataset.vectors,
    checkpoint,
  });
}

export async function loadBatchRebuildState(chatId: string): Promise<MemoryWarehouseBatchRebuildState> {
  const runtime = getRuntime(chatId);
  const checkpoint = await runtime.repository.getCheckpoint('full_rebuild');
  if (!checkpoint?.transactionId) return { checkpoint, summaries: [] };
  return {
    checkpoint,
    summaries: await runtime.repository.listGrandSummaryProjections(checkpoint.transactionId),
  };
}

export async function saveBatchRebuildCheckpoint(
  chatId: string,
  checkpoint: MemoryCheckpointRecord,
): Promise<void> {
  const runtime = getRuntime(chatId);
  await runtime.repository.saveCheckpoint(checkpoint);
}

export async function activateBatchRebuild(
  chatId: string,
  transactionId: string,
): Promise<{ activatedBundleIds: string[]; invalidatedBundleIds: string[] }> {
  const runtime = getRuntime(chatId);
  const checkpoint = await runtime.repository.getCheckpoint('full_rebuild');
  if (!checkpoint || checkpoint.transactionId !== transactionId) {
    throw new Error('批量重建 Checkpoint 已变化，拒绝激活过期事务');
  }
  const now = new Date().toISOString();
  return runtime.repository.activateStagedBundles(transactionId, {
    ...checkpoint,
    status: 'ready',
    nextFloor: (checkpoint.rangeEnd ?? checkpoint.lastCommittedFloor) + 1,
    lastCommittedFloor: checkpoint.rangeEnd ?? checkpoint.lastCommittedFloor,
    error: undefined,
    updatedAt: now,
  });
}

export async function finalizeBatchRebuild(chatId: string, transactionId: string): Promise<boolean> {
  const runtime = getRuntime(chatId);
  const checkpoint = await runtime.repository.getCheckpoint('full_rebuild');
  if (!checkpoint || checkpoint.transactionId !== transactionId || checkpoint.status !== 'ready') return false;
  return runtime.repository.deleteCheckpoint('full_rebuild');
}

export async function discardBatchRebuild(chatId: string, transactionId: string, reason: string): Promise<number> {
  const runtime = getRuntime(chatId);
  return runtime.repository.invalidateStagedBundles(transactionId, reason);
}

/** 用户明确放弃续建：作废暂存结果并删除 Checkpoint；已 committed 记忆不受影响。 */
export async function abandonBatchRebuild(
  chatId: string,
): Promise<{ invalidatedBundleCount: number; checkpointDeleted: boolean }> {
  const runtime = getRuntime(chatId);
  const checkpoint = await runtime.repository.getCheckpoint('full_rebuild');
  const invalidatedBundleCount = checkpoint?.transactionId
    ? await runtime.repository.invalidateStagedBundles(checkpoint.transactionId, '用户放弃批量重建')
    : 0;
  const checkpointDeleted = await runtime.repository.deleteCheckpoint('full_rebuild');
  return { invalidatedBundleCount, checkpointDeleted };
}

function sourceFingerprintMatches(
  expected: MemorySourceMessageFingerprint,
  current: MemorySourceMessageFingerprint | undefined,
): boolean {
  if (!current || expected.contentHash !== current.contentHash) return false;
  if (expected.role !== undefined && expected.role !== current.role) return false;
  if (expected.swipeId !== undefined && expected.swipeId !== current.swipeId) return false;
  if (expected.metadataHash !== undefined && expected.metadataHash !== current.metadataHash) return false;
  if (expected.sceneId !== undefined && expected.sceneId !== current.sceneId) return false;
  if (expected.traceId !== undefined && expected.traceId !== current.traceId) return false;
  return true;
}

export function hasMemoryBundleSourceChanged(
  bundle: MemoryBundleRecord,
  currentByMessageId: ReadonlyMap<number, MemorySourceMessageFingerprint>,
  fromFloor = 0,
): boolean {
  if (bundle.sourceMessages.length === 0) return true;
  return bundle.sourceMessages.filter(expected => expected.messageId >= fromFloor).some(expected => (
    !sourceFingerprintMatches(expected, currentByMessageId.get(expected.messageId))
  ));
}

/**
 * 核对一次酒馆来源变化。只有来源指纹确实变化时才作废 committed Bundle；
 * 单纯重渲染或隐藏楼层不会改变指纹，因此不会误判为记忆失效。
 */
export async function reconcileMemoryWarehouseSourceChange(source: {
  chatId: string;
  floor: number;
  reason: NonNullable<MemoryBundleRecord['invalidationReason']>;
  currentSourceContents: RawChatSourceContent[];
  cancelStaged?: boolean;
}): Promise<MemorySourceReconcileResult> {
  const runtime = getRuntime(source.chatId);
  const floor = Math.max(0, Math.floor(source.floor));
  const currentByMessageId = new Map(
    fingerprintMemorySourceContents(source.currentSourceContents)
      .map(message => [message.messageId, message] as const),
  );
  const candidates = (await runtime.repository.listBundles({
    floorStart: floor,
    order: 'floor_asc',
    limit: Number.MAX_SAFE_INTEGER,
  })).filter(bundle => bundle.status === 'committed' && bundle.floorEnd >= floor);
  const sourceChanged = candidates.some(bundle => hasMemoryBundleSourceChanged(bundle, currentByMessageId, floor));
  const invalidatedBundleCount = sourceChanged
    ? await runtime.repository.invalidateBundlesFromFloor(floor, source.reason)
    : 0;

  let invalidatedStagedBundleCount = 0;
  let checkpointDeleted = false;
  const checkpoint = await runtime.repository.getCheckpoint('full_rebuild');
  const checkpointEnd = checkpoint?.rangeEnd ?? checkpoint?.lastCommittedFloor ?? -1;
  if (source.cancelStaged && checkpoint?.transactionId && floor <= checkpointEnd) {
    invalidatedStagedBundleCount = await runtime.repository.invalidateStagedBundles(
      checkpoint.transactionId,
      `来源楼层 ${floor} 已变化`,
    );
    checkpointDeleted = await runtime.repository.deleteCheckpoint('full_rebuild');
  }

  return {
    examinedBundles: candidates.length,
    sourceChanged,
    invalidatedBundleCount,
    invalidatedStagedBundleCount,
    checkpointDeleted,
  };
}

export async function recallCharacterMemoriesFromWarehouse(
  source: { chatId: string; settings: MemoryWarehouseRuntimeSettings },
  query: Omit<CharacterMemoryRecallQuery, 'embedding'>,
): Promise<CharacterMemoryRecallResult> {
  const runtime = getRuntime(source.chatId);
  const dimensions = Number(source.settings.embeddingDimensions ?? 0);
  const embedding = query.queryVector
    ? {
        provider: embeddingProvider(source.settings.embeddingApiUrl),
        model: source.settings.embeddingModel?.trim() || 'unknown',
        dimensions,
        indexVersion: 1,
      }
    : undefined;
  return runtime.repository.recallCharacterMemories({ ...query, embedding });
}

export async function recallTimelineEventsFromWarehouse(
  source: { chatId: string; settings: MemoryWarehouseRuntimeSettings },
  query: Omit<TimelineEventRecallQuery, 'embedding'>,
): Promise<TimelineEventRecallResult> {
  const runtime = getRuntime(source.chatId);
  const dimensions = Number(source.settings.embeddingDimensions ?? 0);
  const embedding = query.queryVector
    ? {
        provider: embeddingProvider(source.settings.embeddingApiUrl),
        model: source.settings.embeddingModel?.trim() || 'unknown',
        dimensions,
        indexVersion: 1,
      }
    : undefined;
  return runtime.repository.recallTimelineEvents({ ...query, embedding });
}

function createFixtureDataset(chatId: string, fixture: MemoryWarehouseTestFixture): MemoryWarehouseDataset {
  const now = new Date().toISOString();
  const floor = Math.max(0, Math.floor(fixture.floor ?? 1));
  const characterName = fixture.characterName.trim();
  const fact = fixture.fact.trim();
  if (!characterName || !fact) throw new Error('测试记忆必须提供角色名和事实文本');
  const keywords = [...new Set([characterName, ...(fixture.keywords ?? [])].map(value => value.trim()).filter(Boolean))];
  const idSeed = `${chatId}|${characterName}|${floor}|${fact}`;
  const bundleId = stableTextId('fixture-bundle', idSeed);
  const summary: SummarySegmentRecord = {
    id: stableTextId('fixture-summary', idSeed),
    kind: 'summary',
    bundleId,
    summaryKind: 'grand',
    segmentType: 'timeline_event',
    createdAt: now,
    updatedAt: now,
    floorStart: floor,
    floorEnd: floor,
    sourceHash: checksumText(idSeed),
    storyTime: fixture.storyTime,
    characters: [characterName],
    keywords,
    overview: fact,
    detail: `测试记忆：${fact}`,
  };
  const characterMemory: CharacterMemorySegmentRecord = {
    id: stableTextId('fixture-character', idSeed),
    kind: 'character_memory',
    bundleId,
    createdAt: now,
    updatedAt: now,
    floorStart: floor,
    floorEnd: floor,
    sourceHash: checksumText(`character|${idSeed}`),
    characterName,
    aliases: [],
    memoryType: 'core',
    text: fact,
    storyTime: fixture.storyTime,
    keywords,
  };
  const vectors: VectorIndexRecord[] = [];
  if (fixture.vector && fixture.embedding) {
    if (fixture.vector.length !== fixture.embedding.dimensions) {
      throw new Error(`测试向量维度不正确：需要 ${fixture.embedding.dimensions}，实际 ${fixture.vector.length}`);
    }
    vectors.push({
      id: stableTextId('fixture-vector', `${idSeed}|${fixture.embedding.model}`),
      kind: 'vector_index',
      bundleId,
      memoryId: characterMemory.id,
      memoryKind: 'character_memory',
      textHash: checksumText(fact),
      floorStart: floor,
      floorEnd: floor,
      storyTime: fixture.storyTime,
      characters: [characterName],
      keywords,
      provider: fixture.embedding.provider,
      model: fixture.embedding.model,
      dimensions: fixture.embedding.dimensions,
      indexVersion: fixture.embedding.indexVersion,
      encoding: 'float32-base64',
      vector: encodeFloat32Vector(fixture.vector),
      createdAt: now,
      updatedAt: now,
    });
  }
  const bundle: MemoryBundleRecord = {
    id: bundleId,
    kind: 'memory_bundle',
    bundleType: 'derived_rebuild',
    status: 'committed',
    createdAt: now,
    updatedAt: now,
    floorStart: floor,
    floorEnd: floor,
    sourceHash: checksumText(idSeed),
    sourceMessages: [{ messageId: floor, contentHash: checksumText(fact) }],
    smallSummaryIds: [],
    summarySegmentIds: [summary.id],
    characterMemoryIds: [characterMemory.id],
    vectorIndexIds: vectors.map(vector => vector.id),
    characters: [characterName],
    keywords,
    committedAt: now,
  };
  return { bundles: [bundle], summaries: [summary], characterMemories: [characterMemory], vectors, checkpoints: [] };
}

export function installMemoryWarehouseDebugApi(source: () => MemoryWarehouseRuntimeSource): MemoryWarehouseDebugApi {
  const api: MemoryWarehouseDebugApi = {
    version: MEMORY_WAREHOUSE_RUNTIME_VERSION,
    currentChatId: getCurrentChatId,
    async inspect() {
      return getRuntime().warehouse.inspect();
    },
    async rebuildFromCurrentDerivedStateForTesting() {
      return rebuildMemoryWarehouseFromDerivedStateForTesting(source());
    },
    async query(query = {}) {
      return getRuntime().warehouse.query(query);
    },
    async recall(query) {
      return getRuntime().repository.recall(query);
    },
    async recallTimeline(query) {
      return getRuntime().repository.recallTimelineEvents(query);
    },
    async seedFixture(fixture) {
      const runtime = getRuntime();
      return runtime.repository.replaceDataset(createFixtureDataset(runtime.chatId, fixture));
    },
    async clearWarehouse() {
      const runtime = getRuntime();
      await runtime.warehouse.resetOwnedWarehouse();
    },
  };
  window.__MQZN_MEMORY_WAREHOUSE_V1__ = api;
  return api;
}
