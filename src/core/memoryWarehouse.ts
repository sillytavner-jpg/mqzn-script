import {
  byteLength,
  checksumText,
  decodeMemoryPayload,
  encodeMemoryPayload,
  parseMemoryShardPayload,
  parseMemoryWarehouseManifest,
  parseShardDescriptor,
  splitEncodedPayload,
  stableTextId,
} from './memoryWarehouseCodec';
import {
  MEMORY_WAREHOUSE_COLLECTIONS,
  MEMORY_WAREHOUSE_SCHEMA_VERSION,
  type MemoryWarehouseCollection,
  type MemoryWarehouseInspection,
  type MemoryWarehouseInspectionIssue,
  type MemoryWarehouseManifest,
  type MemoryWarehouseQuery,
  type MemoryWarehouseQueryResult,
  type MemoryWarehouseRecord,
  type MemoryWarehouseRecordKind,
  type MemoryWarehouseShardDescriptor,
  type MemoryWarehouseShardIndex,
  type MemoryWarehouseShardPayload,
  type ReplaceMemoryCollectionInput,
  type ReplaceMemoryCollectionResult,
  type WriteMemoryShardInput,
} from './memoryWarehouseTypes';

export const MEMORY_WAREHOUSE_SOURCE = 'mqzn-memory-warehouse-v1';
export const MEMORY_WAREHOUSE_STAGING_SOURCE = 'mqzn-memory-warehouse-v1-staging';
export const MEMORY_WAREHOUSE_DEFAULT_CHUNK_LIMIT = 22_000;

const MANIFEST_KIND = 'manifest';
const SHARD_META_KIND = 'shard-meta';
const SHARD_CHUNK_KIND = 'shard-chunk';
const DEFAULT_WORLDBOOK_PREFIX = '智脑聊天记忆仓';

type MemoryWarehouseWorldbookEntry = Partial<WorldbookEntry>;

export interface MemoryWarehouseBackend {
  resolveCurrentWorldbook(): Promise<string>;
  readWorldbook(worldbookName: string): Promise<MemoryWarehouseWorldbookEntry[]>;
  createEntries(worldbookName: string, entries: MemoryWarehouseWorldbookEntry[]): Promise<void>;
  replaceWorldbook(worldbookName: string, entries: MemoryWarehouseWorldbookEntry[]): Promise<void>;
  persistWorldbook(worldbookName: string): Promise<void>;
}

export interface MemoryWarehouseLog {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface MemoryWarehouseOptions {
  chatId: string;
  backend?: MemoryWarehouseBackend;
  chunkCharacterLimit?: number;
  now?: () => Date;
  log?: MemoryWarehouseLog;
}

interface PreparedMemoryShard {
  descriptor: MemoryWarehouseShardDescriptor;
  chunks: string[];
}

export class MemoryWarehouseError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'manifest_invalid'
      | 'manifest_duplicate'
      | 'write_failed'
      | 'rollback_failed'
      | 'shard_missing'
      | 'shard_invalid'
      | 'record_collection_mismatch',
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'MemoryWarehouseError';
  }
}

const COLLECTION_KIND: Record<MemoryWarehouseCollection, MemoryWarehouseRecordKind> = {
  memory_bundles: 'memory_bundle',
  summary_segments: 'summary',
  character_memory_segments: 'character_memory',
  vector_indexes: 'vector_index',
  checkpoints: 'checkpoint',
};

function entryExtra(entry: MemoryWarehouseWorldbookEntry): Record<string, unknown> {
  const extra = entry.extra;
  return extra && typeof extra === 'object' ? (extra as Record<string, unknown>) : {};
}

function entryContent(entry: MemoryWarehouseWorldbookEntry): string {
  return typeof entry.content === 'string' ? entry.content : '';
}

function isRepositoryEntry(entry: MemoryWarehouseWorldbookEntry, repositoryId: string): boolean {
  const extra = entryExtra(entry);
  return (
    (extra.source === MEMORY_WAREHOUSE_SOURCE || extra.source === MEMORY_WAREHOUSE_STAGING_SOURCE)
    && extra.repositoryId === repositoryId
  );
}

function isManifestEntry(entry: MemoryWarehouseWorldbookEntry, repositoryId: string): boolean {
  const extra = entryExtra(entry);
  return extra.source === MEMORY_WAREHOUSE_SOURCE && extra.repositoryId === repositoryId && extra.kind === MANIFEST_KIND;
}

function isActiveShardEntry(
  entry: MemoryWarehouseWorldbookEntry,
  repositoryId: string,
  collection: MemoryWarehouseCollection,
  shardId: string,
): boolean {
  const extra = entryExtra(entry);
  return (
    extra.source === MEMORY_WAREHOUSE_SOURCE
    && extra.repositoryId === repositoryId
    && extra.collection === collection
    && extra.shardId === shardId
    && (extra.kind === SHARD_META_KIND || extra.kind === SHARD_CHUNK_KIND)
  );
}

function isStagingTransactionEntry(
  entry: MemoryWarehouseWorldbookEntry,
  repositoryId: string,
  transactionId: string,
): boolean {
  const extra = entryExtra(entry);
  return (
    extra.source === MEMORY_WAREHOUSE_STAGING_SOURCE
    && extra.repositoryId === repositoryId
    && extra.transactionId === transactionId
  );
}

function makeStorageEntry(
  name: string,
  content: string,
  extra: Record<string, unknown>,
): MemoryWarehouseWorldbookEntry {
  return {
    name,
    enabled: false,
    strategy: {
      type: 'constant',
      keys: [],
      keys_secondary: { logic: 'and_any', keys: [] },
      scan_depth: 'same_as_global',
    },
    position: {
      type: 'before_character_definition',
      role: 'system',
      depth: 4,
      order: 9999,
    },
    content,
    probability: 0,
    recursion: {
      prevent_incoming: true,
      prevent_outgoing: true,
      delay_until: null,
    },
    effect: {
      sticky: null,
      cooldown: null,
      delay: null,
    },
    extra,
  };
}

function createEmptyManifest(repositoryId: string, chatId: string, now: string): MemoryWarehouseManifest {
  return {
    schemaVersion: MEMORY_WAREHOUSE_SCHEMA_VERSION,
    repositoryId,
    chatId,
    createdAt: now,
    updatedAt: now,
    collections: {
      memory_bundles: { revision: 0, shards: [] },
      summary_segments: { revision: 0, shards: [] },
      character_memory_segments: { revision: 0, shards: [] },
      vector_indexes: { revision: 0, shards: [] },
      checkpoints: { revision: 0, shards: [] },
    },
  };
}

function cloneManifest(manifest: MemoryWarehouseManifest): MemoryWarehouseManifest {
  return JSON.parse(JSON.stringify(manifest)) as MemoryWarehouseManifest;
}

function makeManifestEntry(manifest: MemoryWarehouseManifest): MemoryWarehouseWorldbookEntry {
  return makeStorageEntry(
    `【智脑记忆仓V1】Manifest-${stableTextId('chat', manifest.chatId)}`,
    JSON.stringify(manifest),
    {
      source: MEMORY_WAREHOUSE_SOURCE,
      repositoryId: manifest.repositoryId,
      chatId: manifest.chatId,
      kind: MANIFEST_KIND,
      schemaVersion: MEMORY_WAREHOUSE_SCHEMA_VERSION,
    },
  );
}

function readManifestFromEntries(
  entries: MemoryWarehouseWorldbookEntry[],
  repositoryId: string,
): MemoryWarehouseManifest | null {
  const manifestEntries = entries.filter(entry => isManifestEntry(entry, repositoryId));
  if (manifestEntries.length > 1) {
    throw new MemoryWarehouseError('同一聊天记忆仓存在重复 Manifest', 'manifest_duplicate', {
      repositoryId,
      count: manifestEntries.length,
    });
  }
  if (manifestEntries.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(entryContent(manifestEntries[0]));
  } catch (error) {
    throw new MemoryWarehouseError('记忆仓 Manifest 无法解析', 'manifest_invalid', String(error));
  }
  const manifest = parseMemoryWarehouseManifest(raw);
  if (!manifest || manifest.repositoryId !== repositoryId) {
    throw new MemoryWarehouseError('记忆仓 Manifest 结构无效', 'manifest_invalid', raw);
  }
  return manifest;
}

function uniqueStrings(values: readonly string[]): string[] {
  const normalized = values.map(value => value.trim()).filter(Boolean);
  return [...new Set(normalized)];
}

function recordFloorStart(record: MemoryWarehouseRecord): number | undefined {
  return 'floorStart' in record && typeof record.floorStart === 'number' ? record.floorStart : undefined;
}

function recordFloorEnd(record: MemoryWarehouseRecord): number | undefined {
  return 'floorEnd' in record && typeof record.floorEnd === 'number' ? record.floorEnd : undefined;
}

function recordCharacters(record: MemoryWarehouseRecord): string[] {
  if (record.kind === 'memory_bundle') return record.characters;
  if (record.kind === 'summary') return record.characters;
  if (record.kind === 'character_memory') return [record.characterName, ...record.aliases];
  if (record.kind === 'vector_index') return record.characters;
  return [];
}

function recordKeywords(record: MemoryWarehouseRecord): string[] {
  if (
    record.kind === 'memory_bundle'
    || record.kind === 'summary'
    || record.kind === 'character_memory'
    || record.kind === 'vector_index'
  ) {
    return record.keywords;
  }
  return [];
}

function recordStoryTime(record: MemoryWarehouseRecord): string {
  if (record.kind === 'summary' || record.kind === 'character_memory' || record.kind === 'vector_index') {
    return record.storyTime ?? '';
  }
  return '';
}

function deriveShardIndex(records: MemoryWarehouseRecord[], index?: MemoryWarehouseShardIndex): Required<MemoryWarehouseShardIndex> {
  const floorStarts = records.map(recordFloorStart).filter((value): value is number => value !== undefined);
  const floorEnds = records.map(recordFloorEnd).filter((value): value is number => value !== undefined);
  return {
    floorStart: index?.floorStart ?? (floorStarts.length > 0 ? Math.min(...floorStarts) : -1),
    floorEnd: index?.floorEnd ?? (floorEnds.length > 0 ? Math.max(...floorEnds) : -1),
    characters: uniqueStrings(index?.characters ?? records.flatMap(recordCharacters)),
    keywords: uniqueStrings(index?.keywords ?? records.flatMap(recordKeywords)),
  };
}

function makeTransactionId(repositoryId: string): string {
  const randomId = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${stableTextId('repo', repositoryId)}-${randomId}`;
}

function normalizeNameForMatch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function overlapsRange(
  shard: Pick<MemoryWarehouseShardDescriptor, 'floorStart' | 'floorEnd'>,
  query: Pick<MemoryWarehouseQuery, 'floorStart' | 'floorEnd'>,
): boolean {
  if (query.floorStart === undefined && query.floorEnd === undefined) return true;
  if (shard.floorStart === undefined || shard.floorEnd === undefined || shard.floorStart < 0 || shard.floorEnd < 0) {
    return false;
  }
  if (query.floorStart !== undefined && shard.floorEnd < query.floorStart) return false;
  if (query.floorEnd !== undefined && shard.floorStart > query.floorEnd) return false;
  return true;
}

function matchesAny(haystack: readonly string[], needles?: readonly string[]): boolean {
  if (!needles || needles.length === 0) return true;
  const normalizedHaystack = new Set(haystack.map(normalizeNameForMatch));
  return needles.some(needle => normalizedHaystack.has(normalizeNameForMatch(needle)));
}

function descriptorMatchesQuery(descriptor: MemoryWarehouseShardDescriptor, query: MemoryWarehouseQuery): boolean {
  return (
    (!query.ids || query.ids.length === 0 || query.ids.some(id => descriptor.recordIds.includes(id)))
    &&
    overlapsRange(descriptor, query)
    && matchesAny(descriptor.characters, query.characters)
    && matchesAny(descriptor.keywords, query.keywords)
  );
}

function recordMatchesQuery(record: MemoryWarehouseRecord, query: MemoryWarehouseQuery): boolean {
  if (query.ids && query.ids.length > 0 && !query.ids.includes(record.id)) return false;
  if (query.kinds && query.kinds.length > 0 && !query.kinds.includes(record.kind)) return false;
  if (!overlapsRange({ floorStart: recordFloorStart(record), floorEnd: recordFloorEnd(record) }, query)) return false;
  if (!matchesAny(recordCharacters(record), query.characters)) return false;
  if (!matchesAny(recordKeywords(record), query.keywords)) return false;
  if (
    query.storyTime
    && !normalizeNameForMatch(recordStoryTime(record)).includes(normalizeNameForMatch(query.storyTime))
  ) {
    return false;
  }
  return true;
}

function sortRecords(records: MemoryWarehouseRecord[], order: MemoryWarehouseQuery['order']): void {
  const updatedValue = (record: MemoryWarehouseRecord) => Date.parse(record.updatedAt) || 0;
  const floorValue = (record: MemoryWarehouseRecord) => recordFloorEnd(record) ?? -1;
  if (order === 'floor_asc') records.sort((left, right) => floorValue(left) - floorValue(right));
  else if (order === 'updated_asc') records.sort((left, right) => updatedValue(left) - updatedValue(right));
  else if (order === 'updated_desc') records.sort((left, right) => updatedValue(right) - updatedValue(left));
  else records.sort((left, right) => floorValue(right) - floorValue(left));
}

export function memoryWarehouseWorldbookName(chatId: string): string {
  const readableChatId = [...chatId]
    .map(character => character.charCodeAt(0) < 32 ? '_' : character)
    .join('')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32) || 'chat';
  const hash = stableTextId('chat', chatId).replace(/^chat-/, '');
  return `${DEFAULT_WORLDBOOK_PREFIX}-${readableChatId}-${hash}`.slice(0, 64);
}

function makeDefaultBackend(chatId: string, repositoryId: string): MemoryWarehouseBackend {
  let resolving: Promise<string> | null = null;

  async function resolveOnce(): Promise<string> {
    const bound = getChatWorldbookName('current')?.trim();
    if (bound) return bound;

    const desiredName = memoryWarehouseWorldbookName(chatId);

    try {
      const created = await getOrCreateChatWorldbook('current', desiredName);
      const verified = getChatWorldbookName('current')?.trim();
      if (verified) return verified;
      if (created) {
        await rebindChatWorldbook('current', created);
        const rebound = getChatWorldbookName('current')?.trim();
        if (rebound) return rebound;
      }
    } catch (error) {
      console.warn('[智脑记忆仓] 自动创建聊天世界书失败，检查同名仓库归属', error);
    }

    if (getWorldbookNames().includes(desiredName)) {
      const entries = await getWorldbook(desiredName);
      if (entries.some(entry => isManifestEntry(entry, repositoryId))) {
        await rebindChatWorldbook('current', desiredName);
        return desiredName;
      }
    }

    const worldbookNames = new Set(getWorldbookNames());
    for (let suffix = 2; suffix <= 1_000; suffix += 1) {
      const candidate = `${desiredName.slice(0, 60)}-${suffix}`;
      if (worldbookNames.has(candidate)) continue;
      const created = await getOrCreateChatWorldbook('current', candidate);
      const rebound = getChatWorldbookName('current')?.trim();
      if (rebound) return rebound;
      if (created) {
        await rebindChatWorldbook('current', created);
        const verified = getChatWorldbookName('current')?.trim();
        if (verified) return verified;
      }
    }
    throw new Error('无法为当前聊天创建唯一的智脑记忆仓世界书');
  }

  return {
    resolveCurrentWorldbook() {
      if (!resolving) {
        resolving = resolveOnce().finally(() => {
          resolving = null;
        });
      }
      return resolving;
    },
    async readWorldbook(worldbookName) {
      return getWorldbook(worldbookName);
    },
    async createEntries(worldbookName, entries) {
      await createWorldbookEntries(worldbookName, entries, { render: 'debounced' });
    },
    async replaceWorldbook(worldbookName, entries) {
      await replaceWorldbook(worldbookName, entries, { render: 'immediate' });
    },
    async persistWorldbook(worldbookName) {
      const rawWorldbook = await SillyTavern.loadWorldInfo(worldbookName);
      if (!rawWorldbook) throw new Error(`无法从酒馆读取世界书“${worldbookName}”`);
      await SillyTavern.saveWorldInfo(worldbookName, rawWorldbook, true);
      SillyTavern.reloadWorldInfoEditor(worldbookName, false);
      await SillyTavern.updateWorldInfoList();
    },
  };
}

export async function deleteMemoryWarehouseForChat(chatId: string): Promise<boolean> {
  const normalizedChatId = chatId.trim();
  if (!normalizedChatId) return false;
  const worldbookName = memoryWarehouseWorldbookName(normalizedChatId);
  if (!getWorldbookNames().includes(worldbookName)) return false;

  const repositoryId = `mqzn-memory-v1:${normalizedChatId}`;
  const entries = await getWorldbook(worldbookName);
  if (!entries.some(entry => isManifestEntry(entry, repositoryId))) {
    console.warn('[智脑记忆仓] 跳过删除同名但不属于目标聊天的世界书', { chatId: normalizedChatId, worldbookName });
    return false;
  }
  return deleteWorldbook(worldbookName);
}

export class MemoryWarehouse {
  readonly chatId: string;
  readonly repositoryId: string;
  private readonly backend: MemoryWarehouseBackend;
  private readonly chunkCharacterLimit: number;
  private readonly now: () => Date;
  private readonly log?: MemoryWarehouseLog;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly pendingShardWrites = new Map<string, Promise<MemoryWarehouseShardDescriptor>>();

  constructor(options: MemoryWarehouseOptions) {
    const chatId = options.chatId.trim();
    if (!chatId) throw new Error('初始化记忆仓必须提供聊天 ID');
    this.chatId = chatId;
    this.repositoryId = `mqzn-memory-v1:${chatId}`;
    this.backend = options.backend ?? makeDefaultBackend(this.chatId, this.repositoryId);
    this.chunkCharacterLimit = options.chunkCharacterLimit ?? MEMORY_WAREHOUSE_DEFAULT_CHUNK_LIMIT;
    this.now = options.now ?? (() => new Date());
    this.log = options.log;
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.writeQueue.then(task);
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async ensureManifestUnlocked(
    worldbookName: string,
    entries: MemoryWarehouseWorldbookEntry[],
  ): Promise<{ manifest: MemoryWarehouseManifest; entries: MemoryWarehouseWorldbookEntry[] }> {
    const existing = readManifestFromEntries(entries, this.repositoryId);
    if (existing) return { manifest: existing, entries };

    const manifest = createEmptyManifest(this.repositoryId, this.chatId, this.now().toISOString());
    const nextEntries = [...entries, makeManifestEntry(manifest)];
    await this.backend.replaceWorldbook(worldbookName, nextEntries);
    await this.backend.persistWorldbook(worldbookName);
    const persisted = await this.backend.readWorldbook(worldbookName);
    const verified = readManifestFromEntries(persisted, this.repositoryId);
    if (!verified) throw new MemoryWarehouseError('记忆仓 Manifest 初始化校验失败', 'manifest_invalid');
    this.log?.info('记忆仓 Manifest 初始化完成', { worldbookName, repositoryId: this.repositoryId });
    return { manifest: verified, entries: persisted };
  }

  async initialize(): Promise<MemoryWarehouseManifest> {
    return this.enqueueWrite(async () => {
      const worldbookName = await this.backend.resolveCurrentWorldbook();
      const entries = await this.backend.readWorldbook(worldbookName);
      return (await this.ensureManifestUnlocked(worldbookName, entries)).manifest;
    });
  }

  /**
   * 显式清空当前聊天下本仓库拥有的全部条目并创建当前 schema 的空 Manifest。
   * 用于“不迁移旧派生记忆，改从原始聊天批量重建”的版本切换；不会触碰外部条目。
   */
  async resetOwnedWarehouse(): Promise<MemoryWarehouseManifest> {
    return this.enqueueWrite(async () => {
      const worldbookName = await this.backend.resolveCurrentWorldbook();
      const entries = await this.backend.readWorldbook(worldbookName);
      const preservedExternalEntries = entries.filter(entry => !isRepositoryEntry(entry, this.repositoryId));
      const manifest = createEmptyManifest(this.repositoryId, this.chatId, this.now().toISOString());
      await this.backend.replaceWorldbook(worldbookName, [...preservedExternalEntries, makeManifestEntry(manifest)]);
      await this.backend.persistWorldbook(worldbookName);
      const persisted = await this.backend.readWorldbook(worldbookName);
      const verified = readManifestFromEntries(persisted, this.repositoryId);
      if (!verified) throw new MemoryWarehouseError('记忆仓重建清空后的 Manifest 校验失败', 'manifest_invalid');
      this.log?.info('记忆仓已清空并切换到当前 schema', {
        worldbookName,
        schemaVersion: MEMORY_WAREHOUSE_SCHEMA_VERSION,
        preservedExternalEntries: preservedExternalEntries.length,
      });
      return verified;
    });
  }

  async loadManifest(): Promise<MemoryWarehouseManifest> {
    const worldbookName = await this.backend.resolveCurrentWorldbook();
    const entries = await this.backend.readWorldbook(worldbookName);
    const manifest = readManifestFromEntries(entries, this.repositoryId);
    return manifest ?? this.initialize();
  }

  private assertRecordCollection(input: WriteMemoryShardInput): void {
    const expectedKind = COLLECTION_KIND[input.collection];
    const invalid = input.records.find(record => record.kind !== expectedKind);
    if (invalid) {
      throw new MemoryWarehouseError(
        `记录 ${invalid.id} 的类型 ${invalid.kind} 不能写入 ${input.collection}`,
        'record_collection_mismatch',
        { expectedKind, record: invalid },
      );
    }
    const duplicateIds = input.records
      .map(record => record.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index);
    if (duplicateIds.length > 0) {
      throw new Error(`同一分片存在重复记录 ID：${[...new Set(duplicateIds)].join(', ')}`);
    }
  }

  private async prepareShard(
    input: WriteMemoryShardInput,
    previousDescriptor?: MemoryWarehouseShardDescriptor,
  ): Promise<PreparedMemoryShard> {
    this.assertRecordCollection(input);
    const generation = (previousDescriptor?.generation ?? 0) + 1;
    const createdAt = this.now().toISOString();
    const payload: MemoryWarehouseShardPayload = {
      schemaVersion: MEMORY_WAREHOUSE_SCHEMA_VERSION,
      repositoryId: this.repositoryId,
      collection: input.collection,
      shardId: input.shardId,
      generation,
      createdAt,
      records: input.records,
    };
    const encoded = await encodeMemoryPayload(payload);
    const chunks = splitEncodedPayload(encoded.encoded, this.chunkCharacterLimit);
    const derivedIndex = deriveShardIndex(input.records, input.index);
    return {
      descriptor: {
        shardId: input.shardId,
        collection: input.collection,
        generation,
        createdAt,
        recordCount: input.records.length,
        recordIds: input.records.map(record => record.id),
        ...(derivedIndex.floorStart < 0 ? {} : { floorStart: derivedIndex.floorStart }),
        ...(derivedIndex.floorEnd < 0 ? {} : { floorEnd: derivedIndex.floorEnd }),
        characters: derivedIndex.characters,
        keywords: derivedIndex.keywords,
        compression: encoded.compression,
        checksum: encoded.checksum,
        encodedByteLength: encoded.encodedByteLength,
        chunkCount: chunks.length,
      },
      chunks,
    };
  }

  private async createEntriesInBatches(
    worldbookName: string,
    entries: MemoryWarehouseWorldbookEntry[],
  ): Promise<void> {
    const batchSize = 25;
    for (let offset = 0; offset < entries.length; offset += batchSize) {
      await this.backend.createEntries(worldbookName, entries.slice(offset, offset + batchSize));
    }
  }

  private makeStagingEntries(
    transactionId: string,
    descriptor: MemoryWarehouseShardDescriptor,
    chunks: string[],
  ): MemoryWarehouseWorldbookEntry[] {
    const sharedExtra = {
      source: MEMORY_WAREHOUSE_STAGING_SOURCE,
      repositoryId: this.repositoryId,
      chatId: this.chatId,
      collection: descriptor.collection,
      shardId: descriptor.shardId,
      generation: descriptor.generation,
      transactionId,
      schemaVersion: MEMORY_WAREHOUSE_SCHEMA_VERSION,
    };
    const prefix = `【智脑记忆仓V1·暂存】${descriptor.collection}/${descriptor.shardId}`;
    return [
      makeStorageEntry(`${prefix}/meta`, JSON.stringify(descriptor), { ...sharedExtra, kind: SHARD_META_KIND }),
      ...chunks.map((chunk, index) =>
        makeStorageEntry(`${prefix}/${index + 1}-${chunks.length}`, chunk, {
          ...sharedExtra,
          kind: SHARD_CHUNK_KIND,
          part: index + 1,
          totalParts: chunks.length,
        }),
      ),
    ];
  }

  private async decodeShardFromEntries(
    entries: MemoryWarehouseWorldbookEntry[],
    descriptor: MemoryWarehouseShardDescriptor,
    source: typeof MEMORY_WAREHOUSE_SOURCE | typeof MEMORY_WAREHOUSE_STAGING_SOURCE,
    transactionId?: string,
  ): Promise<MemoryWarehouseShardPayload> {
    const matched = entries.filter(entry => {
      const extra = entryExtra(entry);
      return (
        extra.source === source
        && extra.repositoryId === this.repositoryId
        && extra.collection === descriptor.collection
        && extra.shardId === descriptor.shardId
        && (transactionId === undefined || extra.transactionId === transactionId)
      );
    });
    const metaEntries = matched.filter(entry => entryExtra(entry).kind === SHARD_META_KIND);
    if (metaEntries.length !== 1) {
      throw new MemoryWarehouseError('记忆分片索引缺失或重复', 'shard_invalid', {
        collection: descriptor.collection,
        shardId: descriptor.shardId,
        metaCount: metaEntries.length,
      });
    }
    const storedDescriptor = parseShardDescriptor(JSON.parse(entryContent(metaEntries[0])));
    if (
      !storedDescriptor
      || storedDescriptor.checksum !== descriptor.checksum
      || storedDescriptor.generation !== descriptor.generation
    ) {
      throw new MemoryWarehouseError('记忆分片索引与 Manifest 不一致', 'shard_invalid', {
        descriptor,
        storedDescriptor,
      });
    }
    const chunkEntries = matched
      .filter(entry => entryExtra(entry).kind === SHARD_CHUNK_KIND)
      .sort((left, right) => Number(entryExtra(left).part ?? 0) - Number(entryExtra(right).part ?? 0));
    if (chunkEntries.length !== descriptor.chunkCount) {
      throw new MemoryWarehouseError('记忆分片数量不正确', 'shard_invalid', {
        expected: descriptor.chunkCount,
        actual: chunkEntries.length,
      });
    }
    const parts = chunkEntries.map(entry => Number(entryExtra(entry).part ?? 0));
    const expectedParts = Array.from({ length: descriptor.chunkCount }, (_, index) => index + 1);
    if (parts.some((part, index) => part !== expectedParts[index])) {
      throw new MemoryWarehouseError('记忆分片编号缺失或重复', 'shard_invalid', { parts, expectedParts });
    }
    const encoded = chunkEntries.map(entryContent).join('');
    if (byteLength(encoded) !== descriptor.encodedByteLength || checksumText(encoded) !== descriptor.checksum) {
      throw new MemoryWarehouseError('记忆分片校验失败', 'shard_invalid', {
        collection: descriptor.collection,
        shardId: descriptor.shardId,
      });
    }
    const decoded = await decodeMemoryPayload<unknown>(encoded, descriptor.compression, descriptor.checksum);
    const payload = parseMemoryShardPayload(decoded);
    if (
      !payload
      || payload.repositoryId !== this.repositoryId
      || payload.collection !== descriptor.collection
      || payload.shardId !== descriptor.shardId
      || payload.generation !== descriptor.generation
      || payload.records.length !== descriptor.recordCount
    ) {
      throw new MemoryWarehouseError('记忆分片内容结构无效', 'shard_invalid', decoded);
    }
    return payload;
  }

  private promoteTransactionEntries(
    entries: MemoryWarehouseWorldbookEntry[],
    transactionId: string,
  ): MemoryWarehouseWorldbookEntry[] {
    return entries
      .filter(entry => isStagingTransactionEntry(entry, this.repositoryId, transactionId))
      .map(entry => {
        const extra = { ...entryExtra(entry) };
        delete extra.transactionId;
        extra.source = MEMORY_WAREHOUSE_SOURCE;
        const kind = extra.kind === SHARD_META_KIND ? 'meta' : `${String(extra.part)}-${String(extra.totalParts)}`;
        return {
          ...entry,
          name: `【智脑记忆仓V1】${String(extra.collection)}/${String(extra.shardId)}/${kind}`,
          extra,
        };
      });
  }

  private async rollbackShardScope(
    worldbookName: string,
    previousEntries: MemoryWarehouseWorldbookEntry[],
    collection: MemoryWarehouseCollection,
    shardId: string,
    transactionId: string,
  ): Promise<void> {
    const currentEntries = await this.backend.readWorldbook(worldbookName);
    const previousScope = previousEntries.filter(entry =>
      isManifestEntry(entry, this.repositoryId)
      || isActiveShardEntry(entry, this.repositoryId, collection, shardId),
    );
    const preservedCurrent = currentEntries.filter(entry =>
      !isManifestEntry(entry, this.repositoryId)
      && !isActiveShardEntry(entry, this.repositoryId, collection, shardId)
      && !isStagingTransactionEntry(entry, this.repositoryId, transactionId),
    );
    await this.backend.replaceWorldbook(worldbookName, [...preservedCurrent, ...previousScope]);
    await this.backend.persistWorldbook(worldbookName);
  }

  private async rollbackCollectionsScope(
    worldbookName: string,
    previousEntries: MemoryWarehouseWorldbookEntry[],
    collections: readonly MemoryWarehouseCollection[],
    transactionId: string,
  ): Promise<void> {
    const currentEntries = await this.backend.readWorldbook(worldbookName);
    const belongsToCollection = (entry: MemoryWarehouseWorldbookEntry): boolean => {
      const extra = entryExtra(entry);
      return (
        extra.source === MEMORY_WAREHOUSE_SOURCE
        && extra.repositoryId === this.repositoryId
        && typeof extra.collection === 'string'
        && collections.includes(extra.collection as MemoryWarehouseCollection)
        && (extra.kind === SHARD_META_KIND || extra.kind === SHARD_CHUNK_KIND)
      );
    };
    const previousScope = previousEntries.filter(entry =>
      isManifestEntry(entry, this.repositoryId) || belongsToCollection(entry),
    );
    const preservedCurrent = currentEntries.filter(entry =>
      !isManifestEntry(entry, this.repositoryId)
      && !belongsToCollection(entry)
      && !isStagingTransactionEntry(entry, this.repositoryId, transactionId),
    );
    await this.backend.replaceWorldbook(worldbookName, [...preservedCurrent, ...previousScope]);
    await this.backend.persistWorldbook(worldbookName);
  }

  writeShard(input: WriteMemoryShardInput): Promise<MemoryWarehouseShardDescriptor> {
    this.assertRecordCollection(input);
    const requestKey = `${input.collection}/${input.shardId}/${checksumText(JSON.stringify(input))}`;
    const pending = this.pendingShardWrites.get(requestKey);
    if (pending) return pending;

    const operation = this.enqueueWrite(async () => {
      const worldbookName = await this.backend.resolveCurrentWorldbook();
      let previousEntries = await this.backend.readWorldbook(worldbookName);
      const initialized = await this.ensureManifestUnlocked(worldbookName, previousEntries);
      let manifest = initialized.manifest;
      previousEntries = initialized.entries;
      const previousDescriptor = manifest.collections[input.collection].shards.find(
        shard => shard.shardId === input.shardId,
      );
      const { descriptor, chunks } = await this.prepareShard(input, previousDescriptor);
      const transactionId = makeTransactionId(this.repositoryId);
      const stagingEntries = this.makeStagingEntries(transactionId, descriptor, chunks);
      let phase = '写入暂存分片';

      try {
        await this.createEntriesInBatches(worldbookName, stagingEntries);
        phase = '校验暂存分片';
        const stagedWorldbook = await this.backend.readWorldbook(worldbookName);
        await this.decodeShardFromEntries(
          stagedWorldbook,
          descriptor,
          MEMORY_WAREHOUSE_STAGING_SOURCE,
          transactionId,
        );

        phase = '提交 Manifest 与正式分片';
        manifest = cloneManifest(manifest);
        const targetCollection = manifest.collections[input.collection];
        targetCollection.revision += 1;
        targetCollection.shards = [
          ...targetCollection.shards.filter(shard => shard.shardId !== input.shardId),
          descriptor,
        ];
        manifest.updatedAt = this.now().toISOString();
        manifest.lastCommittedTransactionId = transactionId;
        const promoted = this.promoteTransactionEntries(stagedWorldbook, transactionId);
        const nextWorldbook = [
          ...stagedWorldbook.filter(entry =>
            !isManifestEntry(entry, this.repositoryId)
            && !isActiveShardEntry(entry, this.repositoryId, input.collection, input.shardId)
            && !isStagingTransactionEntry(entry, this.repositoryId, transactionId),
          ),
          ...promoted,
          makeManifestEntry(manifest),
        ];
        await this.backend.replaceWorldbook(worldbookName, nextWorldbook);

        phase = '硬盘落盘';
        await this.backend.persistWorldbook(worldbookName);

        phase = '最终校验';
        const persisted = await this.backend.readWorldbook(worldbookName);
        const persistedManifest = readManifestFromEntries(persisted, this.repositoryId);
        const persistedDescriptor = persistedManifest?.collections[input.collection].shards.find(
          shard => shard.shardId === input.shardId,
        );
        if (
          !persistedManifest
          || persistedManifest.lastCommittedTransactionId !== transactionId
          || !persistedDescriptor
          || persistedDescriptor.checksum !== descriptor.checksum
          || persisted.some(entry => isStagingTransactionEntry(entry, this.repositoryId, transactionId))
        ) {
          throw new MemoryWarehouseError('记忆仓提交后的 Manifest 校验失败', 'write_failed');
        }
        await this.decodeShardFromEntries(persisted, persistedDescriptor, MEMORY_WAREHOUSE_SOURCE);
        this.log?.info('记忆分片提交完成', {
          worldbookName,
          collection: input.collection,
          shardId: input.shardId,
          generation: descriptor.generation,
          recordCount: input.records.length,
          chunkCount: chunks.length,
          checksum: descriptor.checksum,
        });
        return persistedDescriptor;
      } catch (error) {
        this.log?.error('记忆分片提交失败，准备回滚本事务范围', {
          phase,
          collection: input.collection,
          shardId: input.shardId,
          transactionId,
          error: String(error),
        });
        try {
          await this.rollbackShardScope(
            worldbookName,
            previousEntries,
            input.collection,
            input.shardId,
            transactionId,
          );
        } catch (rollbackError) {
          throw new MemoryWarehouseError('记忆仓提交失败且回滚未完成', 'rollback_failed', {
            phase,
            error: String(error),
            rollbackError: String(rollbackError),
          });
        }
        throw new MemoryWarehouseError('记忆仓提交失败，旧分片已恢复', 'write_failed', {
          phase,
          error: String(error),
        });
      }
    });
    this.pendingShardWrites.set(requestKey, operation);
    operation.then(
      () => this.pendingShardWrites.delete(requestKey),
      () => this.pendingShardWrites.delete(requestKey),
    );
    return operation;
  }

  /**
   * 在一次事务中新增或替换多个分库里的指定分片，未声明的旧分片保持不变。
   * 实时 MemoryBundle 用它原子提交 Bundle、总结段、角色记忆、向量和检查点。
   */
  async upsertShards(inputs: WriteMemoryShardInput[]): Promise<MemoryWarehouseShardDescriptor[]> {
    if (inputs.length === 0) return [];
    const duplicateKeys = inputs
      .map(input => `${input.collection}/${input.shardId}`)
      .filter((key, index, keys) => keys.indexOf(key) !== index);
    if (duplicateKeys.length > 0) {
      throw new Error(`同一事务重复声明分片：${[...new Set(duplicateKeys)].join(', ')}`);
    }
    for (const input of inputs) this.assertRecordCollection(input);

    return this.enqueueWrite(async () => {
      const worldbookName = await this.backend.resolveCurrentWorldbook();
      let previousEntries = await this.backend.readWorldbook(worldbookName);
      const initialized = await this.ensureManifestUnlocked(worldbookName, previousEntries);
      const manifest = initialized.manifest;
      previousEntries = initialized.entries;
      const prepared: PreparedMemoryShard[] = [];
      for (const input of inputs) {
        const previousDescriptor = manifest.collections[input.collection].shards.find(
          descriptor => descriptor.shardId === input.shardId,
        );
        prepared.push(await this.prepareShard(input, previousDescriptor));
      }

      const transactionId = makeTransactionId(this.repositoryId);
      const stagingEntries = prepared.flatMap(shard =>
        this.makeStagingEntries(transactionId, shard.descriptor, shard.chunks),
      );
      const targetKeys = new Set(inputs.map(input => `${input.collection}/${input.shardId}`));
      const targetCollections = [...new Set(inputs.map(input => input.collection))];
      const isTargetActiveEntry = (entry: MemoryWarehouseWorldbookEntry): boolean => {
        const extra = entryExtra(entry);
        return (
          extra.source === MEMORY_WAREHOUSE_SOURCE
          && extra.repositoryId === this.repositoryId
          && typeof extra.collection === 'string'
          && typeof extra.shardId === 'string'
          && targetKeys.has(`${extra.collection}/${extra.shardId}`)
          && (extra.kind === SHARD_META_KIND || extra.kind === SHARD_CHUNK_KIND)
        );
      };
      let phase = '写入增量事务暂存分片';

      try {
        await this.createEntriesInBatches(worldbookName, stagingEntries);
        phase = '校验增量事务暂存分片';
        const stagedWorldbook = await this.backend.readWorldbook(worldbookName);
        for (const shard of prepared) {
          await this.decodeShardFromEntries(
            stagedWorldbook,
            shard.descriptor,
            MEMORY_WAREHOUSE_STAGING_SOURCE,
            transactionId,
          );
        }

        phase = '原子提交增量分片与 Manifest';
        const nextManifest = cloneManifest(manifest);
        for (const collection of targetCollections) {
          const target = nextManifest.collections[collection];
          const replacements = prepared
            .filter(shard => shard.descriptor.collection === collection)
            .map(shard => shard.descriptor);
          const replacementIds = new Set(replacements.map(descriptor => descriptor.shardId));
          target.revision += 1;
          target.shards = [
            ...target.shards.filter(descriptor => !replacementIds.has(descriptor.shardId)),
            ...replacements,
          ];
        }
        nextManifest.updatedAt = this.now().toISOString();
        nextManifest.lastCommittedTransactionId = transactionId;
        const nextWorldbook = [
          ...stagedWorldbook.filter(entry =>
            !isManifestEntry(entry, this.repositoryId)
            && !isTargetActiveEntry(entry)
            && !isStagingTransactionEntry(entry, this.repositoryId, transactionId),
          ),
          ...this.promoteTransactionEntries(stagedWorldbook, transactionId),
          makeManifestEntry(nextManifest),
        ];
        await this.backend.replaceWorldbook(worldbookName, nextWorldbook);

        phase = '增量事务硬盘落盘';
        await this.backend.persistWorldbook(worldbookName);

        phase = '校验增量事务最终状态';
        const persisted = await this.backend.readWorldbook(worldbookName);
        const persistedManifest = readManifestFromEntries(persisted, this.repositoryId);
        if (
          !persistedManifest
          || persistedManifest.lastCommittedTransactionId !== transactionId
          || persisted.some(entry => isStagingTransactionEntry(entry, this.repositoryId, transactionId))
        ) {
          throw new Error('增量事务 Manifest 最终校验失败');
        }
        const committed: MemoryWarehouseShardDescriptor[] = [];
        for (const shard of prepared) {
          const descriptor = persistedManifest.collections[shard.descriptor.collection].shards.find(
            item => item.shardId === shard.descriptor.shardId,
          );
          if (!descriptor || descriptor.checksum !== shard.descriptor.checksum) {
            throw new Error(`增量事务分片索引校验失败：${shard.descriptor.shardId}`);
          }
          await this.decodeShardFromEntries(persisted, descriptor, MEMORY_WAREHOUSE_SOURCE);
          committed.push(descriptor);
        }
        this.log?.info('记忆多分库增量事务完成', {
          worldbookName,
          collections: targetCollections,
          shardCount: committed.length,
          recordCount: committed.reduce((total, descriptor) => total + descriptor.recordCount, 0),
          transactionId,
        });
        return committed;
      } catch (error) {
        this.log?.error('记忆多分库增量事务失败，准备恢复旧分库', {
          phase,
          collections: targetCollections,
          transactionId,
          error: String(error),
        });
        try {
          await this.rollbackCollectionsScope(worldbookName, previousEntries, targetCollections, transactionId);
        } catch (rollbackError) {
          throw new MemoryWarehouseError('增量事务失败且回滚未完成', 'rollback_failed', {
            phase,
            error: String(error),
            rollbackError: String(rollbackError),
          });
        }
        throw new MemoryWarehouseError('增量事务失败，旧分库已恢复', 'write_failed', {
          phase,
          error: String(error),
        });
      }
    });
  }

  /**
   * 用一组已经完整生成的新分片原子替换整个逻辑分库。
   * 批量重建期间旧分库持续可读，只有所有暂存分片通过校验后才切换 Manifest。
   */
  async replaceCollection(input: ReplaceMemoryCollectionInput): Promise<MemoryWarehouseShardDescriptor[]> {
    const results = await this.replaceCollections([input]);
    return results[0].shards;
  }

  /** 一次事务替换多个逻辑分库，供完整重建在最终阶段原子切换。 */
  async replaceCollections(inputs: ReplaceMemoryCollectionInput[]): Promise<ReplaceMemoryCollectionResult[]> {
    if (inputs.length === 0) return [];
    const duplicateCollections = inputs
      .map(input => input.collection)
      .filter((collection, index, collections) => collections.indexOf(collection) !== index);
    if (duplicateCollections.length > 0) {
      throw new Error(`同一事务重复声明逻辑分库：${[...new Set(duplicateCollections)].join(', ')}`);
    }
    for (const input of inputs) {
      const duplicateShardIds = input.shards
        .map(shard => shard.shardId)
        .filter((shardId, index, shardIds) => shardIds.indexOf(shardId) !== index);
      if (duplicateShardIds.length > 0) {
        throw new Error(`批量替换包含重复分片 ID：${[...new Set(duplicateShardIds)].join(', ')}`);
      }
      for (const shard of input.shards) {
        this.assertRecordCollection({ collection: input.collection, ...shard });
      }
    }

    return this.enqueueWrite(async () => {
      const worldbookName = await this.backend.resolveCurrentWorldbook();
      let previousEntries = await this.backend.readWorldbook(worldbookName);
      const initialized = await this.ensureManifestUnlocked(worldbookName, previousEntries);
      const manifest = initialized.manifest;
      previousEntries = initialized.entries;
      const preparedByCollection = new Map<MemoryWarehouseCollection, PreparedMemoryShard[]>();
      for (const input of inputs) {
        const previousDescriptors = new Map(
          manifest.collections[input.collection].shards.map(descriptor => [descriptor.shardId, descriptor]),
        );
        const prepared: PreparedMemoryShard[] = [];
        for (const shard of input.shards) {
          prepared.push(await this.prepareShard(
            { collection: input.collection, ...shard },
            previousDescriptors.get(shard.shardId),
          ));
        }
        preparedByCollection.set(input.collection, prepared);
      }
      const prepared = [...preparedByCollection.values()].flat();
      const transactionId = makeTransactionId(this.repositoryId);
      const stagingEntries = prepared.flatMap(shard =>
        this.makeStagingEntries(transactionId, shard.descriptor, shard.chunks),
      );
      const targetCollections = inputs.map(input => input.collection);
      const belongsToTargetCollections = (entry: MemoryWarehouseWorldbookEntry): boolean => {
        const extra = entryExtra(entry);
        return (
          extra.source === MEMORY_WAREHOUSE_SOURCE
          && extra.repositoryId === this.repositoryId
          && typeof extra.collection === 'string'
          && targetCollections.includes(extra.collection as MemoryWarehouseCollection)
          && (extra.kind === SHARD_META_KIND || extra.kind === SHARD_CHUNK_KIND)
        );
      };
      let phase = '写入多分库暂存分片';

      try {
        if (stagingEntries.length > 0) {
          await this.createEntriesInBatches(worldbookName, stagingEntries);
        }
        phase = '校验全部暂存分片';
        const stagedWorldbook = await this.backend.readWorldbook(worldbookName);
        for (const shard of prepared) {
          await this.decodeShardFromEntries(
            stagedWorldbook,
            shard.descriptor,
            MEMORY_WAREHOUSE_STAGING_SOURCE,
            transactionId,
          );
        }

        phase = '原子切换多分库 Manifest';
        const nextManifest = cloneManifest(manifest);
        for (const input of inputs) {
          const preparedCollection = preparedByCollection.get(input.collection) ?? [];
          nextManifest.collections[input.collection].revision += 1;
          nextManifest.collections[input.collection].shards = preparedCollection.map(shard => shard.descriptor);
        }
        nextManifest.updatedAt = this.now().toISOString();
        nextManifest.lastCommittedTransactionId = transactionId;
        const nextWorldbook = [
          ...stagedWorldbook.filter(entry =>
            !isManifestEntry(entry, this.repositoryId)
            && !belongsToTargetCollections(entry)
            && !isStagingTransactionEntry(entry, this.repositoryId, transactionId),
          ),
          ...this.promoteTransactionEntries(stagedWorldbook, transactionId),
          makeManifestEntry(nextManifest),
        ];
        await this.backend.replaceWorldbook(worldbookName, nextWorldbook);

        phase = '多分库硬盘落盘';
        await this.backend.persistWorldbook(worldbookName);

        phase = '校验多分库最终状态';
        const persisted = await this.backend.readWorldbook(worldbookName);
        const persistedManifest = readManifestFromEntries(persisted, this.repositoryId);
        if (
          !persistedManifest
          || persistedManifest.lastCommittedTransactionId !== transactionId
          || persisted.some(entry => isStagingTransactionEntry(entry, this.repositoryId, transactionId))
        ) {
          throw new Error('多分库 Manifest 最终校验失败');
        }
        const results: ReplaceMemoryCollectionResult[] = [];
        for (const input of inputs) {
          const preparedCollection = preparedByCollection.get(input.collection) ?? [];
          const finalDescriptors = persistedManifest.collections[input.collection].shards;
          if (finalDescriptors.length !== preparedCollection.length) {
            throw new Error(`逻辑分库分片数量校验失败：${input.collection}`);
          }
          for (const shard of preparedCollection) {
            const finalDescriptor = finalDescriptors.find(item => item.shardId === shard.descriptor.shardId);
            if (!finalDescriptor || finalDescriptor.checksum !== shard.descriptor.checksum) {
              throw new Error(`批量分片索引校验失败：${shard.descriptor.shardId}`);
            }
            await this.decodeShardFromEntries(persisted, finalDescriptor, MEMORY_WAREHOUSE_SOURCE);
          }
          results.push({ collection: input.collection, shards: finalDescriptors });
        }
        this.log?.info('记忆多分库原子替换完成', {
          worldbookName,
          collections: targetCollections,
          shardCount: prepared.length,
          recordCount: prepared.reduce((total, shard) => total + shard.descriptor.recordCount, 0),
          transactionId,
        });
        return results;
      } catch (error) {
        this.log?.error('记忆多分库原子替换失败，准备恢复旧分库', {
          phase,
          collections: targetCollections,
          transactionId,
          error: String(error),
        });
        try {
          await this.rollbackCollectionsScope(worldbookName, previousEntries, targetCollections, transactionId);
        } catch (rollbackError) {
          throw new MemoryWarehouseError('多分库提交失败且回滚未完成', 'rollback_failed', {
            phase,
            error: String(error),
            rollbackError: String(rollbackError),
          });
        }
        throw new MemoryWarehouseError('多分库提交失败，旧分库已恢复', 'write_failed', {
          phase,
          error: String(error),
        });
      }
    });
  }

  async readShard(collection: MemoryWarehouseCollection, shardId: string): Promise<MemoryWarehouseShardPayload> {
    const worldbookName = await this.backend.resolveCurrentWorldbook();
    const entries = await this.backend.readWorldbook(worldbookName);
    const manifest = readManifestFromEntries(entries, this.repositoryId);
    const descriptor = manifest?.collections[collection].shards.find(shard => shard.shardId === shardId);
    if (!descriptor) {
      throw new MemoryWarehouseError(`没有找到记忆分片：${collection}/${shardId}`, 'shard_missing');
    }
    return this.decodeShardFromEntries(entries, descriptor, MEMORY_WAREHOUSE_SOURCE);
  }

  async deleteShard(collection: MemoryWarehouseCollection, shardId: string): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const worldbookName = await this.backend.resolveCurrentWorldbook();
      const previousEntries = await this.backend.readWorldbook(worldbookName);
      const manifest = readManifestFromEntries(previousEntries, this.repositoryId);
      const descriptor = manifest?.collections[collection].shards.find(shard => shard.shardId === shardId);
      if (!manifest || !descriptor) return false;
      const transactionId = makeTransactionId(this.repositoryId);
      const nextManifest = cloneManifest(manifest);
      nextManifest.collections[collection].revision += 1;
      nextManifest.collections[collection].shards = nextManifest.collections[collection].shards.filter(
        shard => shard.shardId !== shardId,
      );
      nextManifest.updatedAt = this.now().toISOString();
      nextManifest.lastCommittedTransactionId = transactionId;
      const nextEntries = [
        ...previousEntries.filter(entry =>
          !isManifestEntry(entry, this.repositoryId)
          && !isActiveShardEntry(entry, this.repositoryId, collection, shardId),
        ),
        makeManifestEntry(nextManifest),
      ];
      try {
        await this.backend.replaceWorldbook(worldbookName, nextEntries);
        await this.backend.persistWorldbook(worldbookName);
        const persisted = await this.backend.readWorldbook(worldbookName);
        const persistedManifest = readManifestFromEntries(persisted, this.repositoryId);
        if (
          !persistedManifest
          || persistedManifest.collections[collection].shards.some(shard => shard.shardId === shardId)
          || persisted.some(entry => isActiveShardEntry(entry, this.repositoryId, collection, shardId))
        ) {
          throw new Error('删除后校验失败');
        }
        return true;
      } catch (error) {
        await this.rollbackShardScope(worldbookName, previousEntries, collection, shardId, transactionId);
        throw new MemoryWarehouseError('删除记忆分片失败，旧分片已恢复', 'write_failed', String(error));
      }
    });
  }

  async query(query: MemoryWarehouseQuery = {}): Promise<MemoryWarehouseQueryResult> {
    const worldbookName = await this.backend.resolveCurrentWorldbook();
    const entries = await this.backend.readWorldbook(worldbookName);
    const manifest = readManifestFromEntries(entries, this.repositoryId);
    if (!manifest) return { records: [], total: 0, loadedShardCount: 0, candidateShardCount: 0 };
    const collections = query.collections ?? [...MEMORY_WAREHOUSE_COLLECTIONS];
    const candidates = collections
      .flatMap(collection => manifest.collections[collection].shards)
      .filter(descriptor => descriptorMatchesQuery(descriptor, query));
    const records: MemoryWarehouseRecord[] = [];
    for (const descriptor of candidates) {
      const payload = await this.decodeShardFromEntries(entries, descriptor, MEMORY_WAREHOUSE_SOURCE);
      records.push(...payload.records.filter(record => recordMatchesQuery(record, query)));
    }
    sortRecords(records, query.order);
    const total = records.length;
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(0, query.limit ?? 100);
    return {
      records: records.slice(offset, offset + limit),
      total,
      loadedShardCount: candidates.length,
      candidateShardCount: candidates.length,
    };
  }

  async inspect(): Promise<MemoryWarehouseInspection> {
    const worldbookName = await this.backend.resolveCurrentWorldbook();
    const entries = await this.backend.readWorldbook(worldbookName);
    const ownedEntries = entries.filter(entry => isRepositoryEntry(entry, this.repositoryId));
    const issues: MemoryWarehouseInspectionIssue[] = [];
    const stagingEntries = ownedEntries.filter(
      entry => entryExtra(entry).source === MEMORY_WAREHOUSE_STAGING_SOURCE,
    );
    for (const transactionId of uniqueStrings(
      stagingEntries.map(entry => String(entryExtra(entry).transactionId ?? '')).filter(Boolean),
    )) {
      issues.push({
        level: 'warning',
        code: 'staging_orphaned',
        message: `发现未清理的暂存事务：${transactionId}`,
        transactionId,
      });
    }

    let manifest: MemoryWarehouseManifest | null = null;
    try {
      manifest = readManifestFromEntries(entries, this.repositoryId);
      if (!manifest) {
        issues.push({ level: 'error', code: 'manifest_missing', message: '记忆仓 Manifest 不存在' });
      }
    } catch (error) {
      const duplicate = error instanceof MemoryWarehouseError && error.code === 'manifest_duplicate';
      issues.push({
        level: 'error',
        code: duplicate ? 'manifest_duplicate' : 'manifest_invalid',
        message: String(error),
      });
    }

    if (manifest) {
      for (const collection of MEMORY_WAREHOUSE_COLLECTIONS) {
        for (const descriptor of manifest.collections[collection].shards) {
          try {
            await this.decodeShardFromEntries(entries, descriptor, MEMORY_WAREHOUSE_SOURCE);
          } catch (error) {
            issues.push({
              level: 'error',
              code: 'shard_payload_invalid',
              message: String(error),
              collection,
              shardId: descriptor.shardId,
            });
          }
        }
      }
    }

    return {
      ok: issues.every(issue => issue.level !== 'error'),
      worldbookName,
      repositoryId: this.repositoryId,
      manifest,
      ownedEntryCount: ownedEntries.length,
      externalEntryCount: entries.length - ownedEntries.length,
      issues,
    };
  }
}
