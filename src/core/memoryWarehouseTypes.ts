/**
 * 聊天世界书记忆仓 V1 的领域协议。
 *
 * 这里不依赖 Pinia Store，也不直接依赖酒馆 API。业务模块只和这些类型
 * 以及 memoryWarehouseRepository 交互，世界书条目只是底层持久化细节。
 */

export const MEMORY_WAREHOUSE_SCHEMA_VERSION = 2 as const;

export const MEMORY_WAREHOUSE_COLLECTIONS = [
  'memory_bundles',
  'summary_segments',
  'character_memory_segments',
  'vector_indexes',
  'checkpoints',
] as const;

export type MemoryWarehouseCollection = (typeof MEMORY_WAREHOUSE_COLLECTIONS)[number];

export type MemoryWarehouseRecordKind = 'memory_bundle' | 'summary' | 'character_memory' | 'vector_index' | 'checkpoint';

export interface MemoryWarehouseRecordBase {
  id: string;
  kind: MemoryWarehouseRecordKind;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySourceRange {
  floorStart: number;
  floorEnd: number;
  /** 原始聊天内容的稳定摘要；用于判断重建来源是否发生变化。 */
  sourceHash: string;
}

export interface MemorySourceMessageFingerprint {
  messageId: number;
  /** 单条原始聊天正文的稳定摘要；正文不复制进记忆仓元数据。 */
  contentHash: string;
  role?: 'system' | 'assistant' | 'user';
  /** 当前被选中的消息页。相同正文的不同 swipe 仍是不同来源身份。 */
  swipeId?: number;
  /** 当前消息页 data／extra／swipe data 的稳定摘要，不保存元数据正文。 */
  metadataHash?: string;
  sceneId?: string;
  traceId?: string;
}

/**
 * 一批聊天原文所产生的完整派生记忆提交。
 *
 * 它只保存来源指纹与子记录 ID，不复制总结正文。active 数据集中只允许存在
 * committed 记录；staged 用于批量重建完成前的隔离区，invalidated 用于
 * 重 roll／swipe／手工重建后留下可诊断的作废标记。
 */
export interface MemoryBundleRecord extends MemoryWarehouseRecordBase, MemorySourceRange {
  kind: 'memory_bundle';
  bundleType: 'realtime' | 'batch_rebuild' | 'derived_rebuild';
  status: 'staged' | 'committed' | 'invalidated';
  /** 批量重建事务 ID；同一事务的 staged bundle 只会一起激活或一起作废。 */
  rebuildTransactionId?: string;
  summaryVersion?: number;
  sourceMessages: MemorySourceMessageFingerprint[];
  smallSummaryIds: string[];
  summarySegmentIds: string[];
  characterMemoryIds: string[];
  vectorIndexIds: string[];
  characters: string[];
  keywords: string[];
  stagedAt?: string;
  committedAt?: string;
  invalidatedAt?: string;
  invalidationReason?: 'swipe' | 'reroll' | 'message_deleted' | 'manual_rebuild' | 'source_changed';
}

export interface SummarySegmentRecord extends MemoryWarehouseRecordBase, MemorySourceRange {
  kind: 'summary';
  bundleId?: string;
  summaryKind: 'small' | 'grand';
  segmentType: 'small' | 'grand_overview' | 'timeline_event';
  summaryVersion?: number;
  storyTime?: string;
  location?: string;
  characters: string[];
  keywords: string[];
  overview: string;
  detail?: string;
  /** 保留尚未完成结构化迁移的业务字段，不允许把向量塞进这里。 */
  payload?: Record<string, unknown>;
}

export interface CharacterMemorySegmentRecord extends MemoryWarehouseRecordBase, MemorySourceRange {
  kind: 'character_memory';
  bundleId?: string;
  characterName: string;
  aliases: string[];
  memoryType: 'core' | 'recent';
  text: string;
  storyTime?: string;
  keywords: string[];
  summaryVersion?: number;
}

export type VectorEncoding = 'float32-base64';

export interface VectorIndexRecord extends MemoryWarehouseRecordBase {
  kind: 'vector_index';
  bundleId?: string;
  memoryId: string;
  memoryKind: 'summary' | 'character_memory';
  textHash: string;
  floorStart?: number;
  floorEnd?: number;
  storyTime?: string;
  characters: string[];
  keywords: string[];
  provider: string;
  model: string;
  dimensions: number;
  indexVersion: number;
  encoding: VectorEncoding;
  vector: string;
}

export interface MemoryCheckpointRecord extends MemoryWarehouseRecordBase {
  kind: 'checkpoint';
  taskType: 'full_rebuild' | 'summary_rebuild' | 'character_memory_rebuild' | 'vector_rebuild';
  status: 'running' | 'paused' | 'failed' | 'ready';
  rangeStart?: number;
  rangeEnd?: number;
  batchSize?: number;
  nextFloor: number;
  lastCommittedFloor: number;
  lastCommittedBundleId?: string;
  sourceChatRevision?: string;
  transactionId?: string;
  error?: string;
  statistics: {
    processedBatches: number;
    failedBatches: number;
    summaryRecords: number;
    characterMemoryRecords: number;
    vectorRecords: number;
  };
}

export type MemoryWarehouseRecord =
  | MemoryBundleRecord
  | SummarySegmentRecord
  | CharacterMemorySegmentRecord
  | VectorIndexRecord
  | MemoryCheckpointRecord;

export type MemoryWarehouseCompression = 'gzip-base64' | 'utf8-base64';

export interface MemoryWarehouseShardPayload {
  schemaVersion: typeof MEMORY_WAREHOUSE_SCHEMA_VERSION;
  repositoryId: string;
  collection: MemoryWarehouseCollection;
  shardId: string;
  generation: number;
  createdAt: string;
  records: MemoryWarehouseRecord[];
}

export interface MemoryWarehouseShardDescriptor {
  shardId: string;
  collection: MemoryWarehouseCollection;
  generation: number;
  createdAt: string;
  recordCount: number;
  recordIds: string[];
  floorStart?: number;
  floorEnd?: number;
  characters: string[];
  keywords: string[];
  compression: MemoryWarehouseCompression;
  checksum: string;
  encodedByteLength: number;
  chunkCount: number;
}

export interface MemoryWarehouseCollectionManifest {
  revision: number;
  shards: MemoryWarehouseShardDescriptor[];
}

export interface MemoryWarehouseManifest {
  schemaVersion: typeof MEMORY_WAREHOUSE_SCHEMA_VERSION;
  repositoryId: string;
  chatId: string;
  createdAt: string;
  updatedAt: string;
  lastCommittedTransactionId?: string;
  collections: Record<MemoryWarehouseCollection, MemoryWarehouseCollectionManifest>;
}

export interface MemoryWarehouseShardIndex {
  floorStart?: number;
  floorEnd?: number;
  characters?: string[];
  keywords?: string[];
}

export interface WriteMemoryShardInput {
  collection: MemoryWarehouseCollection;
  shardId: string;
  records: MemoryWarehouseRecord[];
  index?: MemoryWarehouseShardIndex;
}

export interface ReplaceMemoryCollectionInput {
  collection: MemoryWarehouseCollection;
  shards: Array<{
    shardId: string;
    records: MemoryWarehouseRecord[];
    index?: MemoryWarehouseShardIndex;
  }>;
}

export interface ReplaceMemoryCollectionResult {
  collection: MemoryWarehouseCollection;
  shards: MemoryWarehouseShardDescriptor[];
}

export interface MemoryWarehouseInspectionIssue {
  level: 'error' | 'warning';
  code:
    | 'manifest_missing'
    | 'manifest_duplicate'
    | 'manifest_invalid'
    | 'staging_orphaned'
    | 'shard_meta_missing'
    | 'shard_meta_duplicate'
    | 'shard_chunk_missing'
    | 'shard_chunk_duplicate'
    | 'shard_checksum_mismatch'
    | 'shard_payload_invalid';
  message: string;
  collection?: MemoryWarehouseCollection;
  shardId?: string;
  transactionId?: string;
}

export interface MemoryWarehouseInspection {
  ok: boolean;
  worldbookName: string;
  repositoryId: string;
  manifest: MemoryWarehouseManifest | null;
  ownedEntryCount: number;
  externalEntryCount: number;
  issues: MemoryWarehouseInspectionIssue[];
}

export interface MemoryWarehouseQuery {
  collections?: MemoryWarehouseCollection[];
  ids?: string[];
  kinds?: MemoryWarehouseRecordKind[];
  characters?: string[];
  keywords?: string[];
  floorStart?: number;
  floorEnd?: number;
  storyTime?: string;
  offset?: number;
  limit?: number;
  order?: 'floor_asc' | 'floor_desc' | 'updated_asc' | 'updated_desc';
}

export interface MemoryWarehouseQueryResult {
  records: MemoryWarehouseRecord[];
  total: number;
  loadedShardCount: number;
  candidateShardCount: number;
}
