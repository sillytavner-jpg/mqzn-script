import assert from 'node:assert/strict';
import {
  MemoryWarehouse,
  type MemoryWarehouseBackend,
  MEMORY_WAREHOUSE_SOURCE,
  MEMORY_WAREHOUSE_STAGING_SOURCE,
} from '../src/core/memoryWarehouse';
import { decodeFloat32Vector, encodeFloat32Vector } from '../src/core/memoryWarehouseCodec';
import {
  buildMemoryWarehouseDataset,
  MemoryWarehouseRepository,
  planMemoryWarehouseDataset,
} from '../src/core/memoryWarehouseRepository';
import type { MemoryBundleRecord, SummarySegmentRecord } from '../src/core/memoryWarehouseTypes';
import { RawChatReader } from '../src/core/rawChatReader';
import { SourceChangeTracker } from '../src/core/sourceChangeTracker';
import {
  fingerprintMemorySourceContents,
  hasMemoryBundleSourceChanged,
} from '../src/core/memoryWarehouseRuntime';

type Entry = Awaited<ReturnType<MemoryWarehouseBackend['readWorldbook']>>[number];

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FakeWorldbookBackend implements MemoryWarehouseBackend {
  entries: Entry[];
  private uid = 1;
  failNextPersist = false;
  beforeFailedPersist?: () => void;

  constructor(entries: Entry[] = []) {
    this.entries = clone(entries).map(entry => ({ ...entry, uid: entry.uid ?? this.uid++ }));
  }

  async resolveCurrentWorldbook(): Promise<string> {
    return '测试聊天世界书';
  }

  async readWorldbook(): Promise<Entry[]> {
    return clone(this.entries);
  }

  async createEntries(_worldbookName: string, entries: Entry[]): Promise<void> {
    this.entries.push(...clone(entries).map(entry => ({ ...entry, uid: entry.uid ?? this.uid++ })));
  }

  async replaceWorldbook(_worldbookName: string, entries: Entry[]): Promise<void> {
    this.entries = clone(entries).map(entry => ({ ...entry, uid: entry.uid ?? this.uid++ }));
  }

  async persistWorldbook(): Promise<void> {
    if (!this.failNextPersist) return;
    this.failNextPersist = false;
    this.beforeFailedPersist?.();
    throw new Error('模拟硬盘写入失败');
  }
}

function makeExternalEntry(name = '用户自己的世界书条目'): Entry {
  return {
    name,
    content: '必须完整保留',
    enabled: true,
    extra: { source: 'user-entry', custom: { nested: true } },
  };
}

function makeSummary(id: string, floorStart: number, floorEnd: number, character: string): SummarySegmentRecord {
  const time = new Date(2026, 6, 16, 20, floorEnd).toISOString();
  return {
    id,
    kind: 'summary',
    summaryKind: 'grand',
    segmentType: 'timeline_event',
    createdAt: time,
    updatedAt: time,
    floorStart,
    floorEnd,
    sourceHash: `source-${id}`,
    storyTime: `第${floorEnd}日`,
    characters: [character],
    keywords: ['密信', character],
    overview: `${character}在第${floorStart}-${floorEnd}层收到密信`,
    detail: '密信被藏在旧书的夹层里。',
  };
}

function ownedEntries(backend: FakeWorldbookBackend): Entry[] {
  return backend.entries.filter(entry => {
    const source = entry.extra?.source;
    return source === MEMORY_WAREHOUSE_SOURCE || source === MEMORY_WAREHOUSE_STAGING_SOURCE;
  });
}

async function testInitializeWriteReadQueryAndDelete(): Promise<void> {
  const external = makeExternalEntry();
  const backend = new FakeWorldbookBackend([external]);
  const warehouse = new MemoryWarehouse({
    chatId: 'character-a/chat-001',
    backend,
    chunkCharacterLimit: 1024,
  });

  const initialManifest = await warehouse.initialize();
  assert.equal(initialManifest.chatId, 'character-a/chat-001');
  assert.equal(backend.entries.filter(entry => entry.extra?.source === 'user-entry').length, 1);

  const first = makeSummary('summary-1', 1, 10, '秋青');
  const descriptor = await warehouse.writeShard({
    collection: 'summary_segments',
    shardId: 'floor-1-10',
    records: [first],
  });
  assert.equal(descriptor.generation, 1);
  assert.equal(descriptor.recordCount, 1);
  assert.equal(backend.entries.filter(entry => entry.extra?.source === 'user-entry').length, 1);
  assert.equal(
    backend.entries.some(entry => entry.extra?.source === MEMORY_WAREHOUSE_STAGING_SOURCE),
    false,
  );

  const loaded = await warehouse.readShard('summary_segments', 'floor-1-10');
  assert.deepEqual(loaded.records, [first]);

  const query = await warehouse.query({
    collections: ['summary_segments'],
    characters: ['秋青'],
    keywords: ['密信'],
    floorStart: 5,
    floorEnd: 12,
    limit: 10,
  });
  assert.equal(query.total, 1);
  assert.equal(query.loadedShardCount, 1);
  assert.equal(query.records[0]?.id, 'summary-1');

  const second = makeSummary('summary-2', 1, 12, '秋青');
  const overwritten = await warehouse.writeShard({
    collection: 'summary_segments',
    shardId: 'floor-1-10',
    records: [second],
  });
  assert.equal(overwritten.generation, 2);
  assert.deepEqual((await warehouse.readShard('summary_segments', 'floor-1-10')).records, [second]);

  assert.equal(await warehouse.deleteShard('summary_segments', 'floor-1-10'), true);
  assert.equal(await warehouse.deleteShard('summary_segments', 'floor-1-10'), false);
  assert.equal(backend.entries.filter(entry => entry.extra?.source === 'user-entry').length, 1);
  assert.equal((await warehouse.inspect()).ok, true);
  const resetManifest = await warehouse.resetOwnedWarehouse();
  assert.equal(Object.values(resetManifest.collections).every(collection => collection.shards.length === 0), true);
  assert.equal(backend.entries.filter(entry => entry.extra?.source === 'user-entry').length, 1);
}

async function testRollbackOnlyRestoresOwnedTransactionScope(): Promise<void> {
  const backend = new FakeWorldbookBackend([makeExternalEntry('原外部条目')]);
  const warehouse = new MemoryWarehouse({ chatId: 'chat-rollback', backend, chunkCharacterLimit: 1024 });
  await warehouse.initialize();
  const oldRecord = makeSummary('old', 1, 10, '秋青');
  await warehouse.writeShard({ collection: 'summary_segments', shardId: 'active', records: [oldRecord] });

  backend.failNextPersist = true;
  backend.beforeFailedPersist = () => {
    backend.entries.push({ ...makeExternalEntry('事务期间新增的外部条目'), uid: 99_999 });
  };
  await assert.rejects(
    warehouse.writeShard({
      collection: 'summary_segments',
      shardId: 'active',
      records: [makeSummary('new', 1, 20, '秋青')],
    }),
    /旧分片已恢复/,
  );

  assert.deepEqual((await warehouse.readShard('summary_segments', 'active')).records, [oldRecord]);
  assert.equal(backend.entries.some(entry => entry.name === '事务期间新增的外部条目'), true);
  assert.equal(
    backend.entries.some(entry => entry.extra?.source === MEMORY_WAREHOUSE_STAGING_SOURCE),
    false,
  );
}

async function testConcurrentWritesAreSerialized(): Promise<void> {
  const backend = new FakeWorldbookBackend([makeExternalEntry()]);
  const warehouse = new MemoryWarehouse({ chatId: 'chat-queue', backend, chunkCharacterLimit: 1024 });
  await Promise.all([
    warehouse.writeShard({
      collection: 'summary_segments',
      shardId: 'a',
      records: [makeSummary('a', 1, 5, '甲')],
    }),
    warehouse.writeShard({
      collection: 'summary_segments',
      shardId: 'b',
      records: [makeSummary('b', 6, 10, '乙')],
    }),
  ]);
  const manifest = await warehouse.loadManifest();
  assert.deepEqual(
    manifest.collections.summary_segments.shards.map(shard => shard.shardId).sort(),
    ['a', 'b'],
  );
  assert.equal(ownedEntries(backend).some(entry => entry.extra?.source === MEMORY_WAREHOUSE_STAGING_SOURCE), false);
}

async function testIdenticalPendingWritesAreCoalesced(): Promise<void> {
  const backend = new FakeWorldbookBackend();
  const warehouse = new MemoryWarehouse({ chatId: 'chat-coalesce', backend, chunkCharacterLimit: 1024 });
  const input = {
    collection: 'summary_segments' as const,
    shardId: 'same-request',
    records: [makeSummary('same', 1, 5, '秋青')],
  };
  const first = warehouse.writeShard(input);
  const second = warehouse.writeShard(input);
  assert.equal(first, second);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.generation, 1);
  assert.deepEqual(firstResult, secondResult);
  assert.equal((await warehouse.loadManifest()).collections.summary_segments.revision, 1);
}

async function testAtomicCollectionReplacement(): Promise<void> {
  const backend = new FakeWorldbookBackend([makeExternalEntry()]);
  const warehouse = new MemoryWarehouse({ chatId: 'chat-rebuild', backend, chunkCharacterLimit: 1024 });
  await warehouse.writeShard({
    collection: 'summary_segments',
    shardId: 'old',
    records: [makeSummary('old', 1, 10, '秋青')],
  });

  await warehouse.replaceCollection({
    collection: 'summary_segments',
    shards: [
      { shardId: 'new-a', records: [makeSummary('new-a', 1, 5, '秋青')] },
      { shardId: 'new-b', records: [makeSummary('new-b', 6, 12, '明月')] },
    ],
  });
  const committed = await warehouse.loadManifest();
  assert.deepEqual(
    committed.collections.summary_segments.shards.map(shard => shard.shardId).sort(),
    ['new-a', 'new-b'],
  );
  await assert.rejects(warehouse.readShard('summary_segments', 'old'), /没有找到记忆分片/);

  backend.failNextPersist = true;
  backend.beforeFailedPersist = () => {
    backend.entries.push({ ...makeExternalEntry('批量事务期间新增的外部条目'), uid: 88_888 });
  };
  await assert.rejects(
    warehouse.replaceCollection({
      collection: 'summary_segments',
      shards: [
        { shardId: 'failed-a', records: [makeSummary('failed-a', 1, 20, '甲')] },
        { shardId: 'failed-b', records: [makeSummary('failed-b', 21, 40, '乙')] },
      ],
    }),
    /旧分库已恢复/,
  );
  const rolledBack = await warehouse.loadManifest();
  assert.deepEqual(
    rolledBack.collections.summary_segments.shards.map(shard => shard.shardId).sort(),
    ['new-a', 'new-b'],
  );
  assert.equal(backend.entries.some(entry => entry.name === '批量事务期间新增的外部条目'), true);
  assert.equal(backend.entries.some(entry => entry.extra?.source === MEMORY_WAREHOUSE_STAGING_SOURCE), false);

  await warehouse.replaceCollection({ collection: 'summary_segments', shards: [] });
  assert.deepEqual((await warehouse.loadManifest()).collections.summary_segments.shards, []);
  assert.equal(backend.entries.filter(entry => entry.extra?.source === 'user-entry').length, 2);
}

async function testCorruptionIsReported(): Promise<void> {
  const backend = new FakeWorldbookBackend();
  const warehouse = new MemoryWarehouse({ chatId: 'chat-corrupt', backend, chunkCharacterLimit: 1024 });
  await warehouse.writeShard({
    collection: 'summary_segments',
    shardId: 'corrupt-me',
    records: [makeSummary('corrupt', 1, 3, '秋青')],
  });
  const chunk = backend.entries.find(
    entry => entry.extra?.source === MEMORY_WAREHOUSE_SOURCE && entry.extra?.kind === 'shard-chunk',
  );
  assert.ok(chunk);
  chunk.content = `${chunk.content ?? ''}broken`;
  const inspection = await warehouse.inspect();
  assert.equal(inspection.ok, false);
  assert.equal(inspection.issues.some(issue => issue.code === 'shard_payload_invalid'), true);
}

function testFloat32VectorCodec(): void {
  const source = [0.125, -0.5, 1.25, Math.PI];
  const encoded = encodeFloat32Vector(source);
  const decoded = decodeFloat32Vector(encoded, source.length);
  source.forEach((value, index) => assert.ok(Math.abs(decoded[index] - value) < 1e-6));
  assert.throws(() => decodeFloat32Vector(encoded, source.length + 1), /向量字节长度不正确/);
}

async function testDatasetConversionShardingAndCommit(): Promise<void> {
  const source = {
    chatId: 'chat-dataset',
    now: '2026-07-16T12:00:00.000Z',
    embedding: {
      provider: 'test-provider',
      model: 'test-embedding',
      dimensions: 4,
      indexVersion: 1,
    },
    smallSummaries: [{
      id: 'small-source-1',
      floorRange: { start: 1, end: 2 },
      status: 'ready' as const,
      generatedAt: '2026-07-16T12:01:00.000Z',
      storyTime: '景历十年春',
      location: '藏书阁',
      mainEvent: '秋青发现旧书夹层里的密信',
      presentCharacters: ['秋青'],
    }],
    grandSummaries: [{
      version: 1,
      generatedAt: '2026-07-16T12:02:00.000Z',
      coveredMessageIds: [1, 2, 3, 4],
      sourceMessages: [
        { messageId: 1, contentHash: 'message-hash-1' },
        { messageId: 2, contentHash: 'message-hash-2' },
        { messageId: 3, contentHash: 'message-hash-3' },
        { messageId: 4, contentHash: 'message-hash-4' },
      ],
      rawText: '秋青在藏书阁发现密信，并决定暂时隐瞒。',
      characterTable: [{ name: '秋青', aliases: ['阿青'] }],
      timeline: [{
        time: '景历十年春',
        event: '发现密信',
        detail: '密信藏在旧书夹层里。',
        triggers: { characters: ['秋青'], keywords: ['密信', '藏书阁'] },
        embedding: [0.1, 0.2, 0.3, 0.4],
      }],
      characterMemories: [{
        characterName: '秋青',
        aliases: ['阿青'],
        keywords: ['密信'],
        coreMemories: [{ text: '我在藏书阁发现了一封密信。', time: '景历十年春', embedding: [0.4, 0.3, 0.2, 0.1] }],
        orderedNewMemories: [
          { text: '我在藏书阁发现了一封密信。', isCore: true, time: '景历十年春' },
          { text: '我决定暂时不告诉明月。', isCore: false, time: '景历十年春' },
        ],
      }],
    }],
  };
  const dataset = buildMemoryWarehouseDataset(source);
  const rebuilt = buildMemoryWarehouseDataset(source);
  assert.equal(dataset.bundles.length, 1);
  assert.equal(dataset.summaries.length, 3);
  assert.equal(dataset.characterMemories.length, 2);
  assert.equal(dataset.vectors.length, 2);
  assert.equal(dataset.checkpoints.length, 0);
  assert.equal(dataset.bundles[0].sourceMessages.length, 4);
  assert.equal(dataset.summaries.every(record => record.bundleId === dataset.bundles[0].id), true);
  assert.equal(dataset.characterMemories.every(record => record.bundleId === dataset.bundles[0].id), true);
  assert.equal(dataset.vectors.every(record => record.bundleId === dataset.bundles[0].id), true);
  assert.deepEqual(
    dataset.summaries.map(record => record.id),
    rebuilt.summaries.map(record => record.id),
  );
  assert.equal(dataset.vectors.every(record => !record.vector.includes('0.1')), true);

  const plans = planMemoryWarehouseDataset(dataset, {
    summaryRecordsPerShard: 1,
    characterRecordsPerShard: 1,
    vectorRecordsPerShard: 1,
  });
  assert.deepEqual(plans.map(plan => plan.shards.length), [1, 3, 2, 2, 0]);

  const backend = new FakeWorldbookBackend([makeExternalEntry()]);
  const warehouse = new MemoryWarehouse({ chatId: 'chat-dataset', backend, chunkCharacterLimit: 1024 });
  const repository = new MemoryWarehouseRepository(warehouse);
  const committed = await repository.replaceDataset(dataset, {
    summaryRecordsPerShard: 1,
    characterRecordsPerShard: 1,
    vectorRecordsPerShard: 1,
  });
  assert.deepEqual(committed, {
    bundleShards: 1,
    summaryShards: 3,
    characterMemoryShards: 2,
    vectorShards: 2,
    checkpointShards: 0,
    bundleRecords: 1,
    summaryRecords: 3,
    characterMemoryRecords: 2,
    vectorRecords: 2,
    checkpointRecords: 0,
  });
  assert.equal((await repository.getBundle(dataset.bundles[0].id))?.sourceHash, dataset.bundles[0].sourceHash);

  const checkpoint = {
    id: 'checkpoint-full-rebuild',
    kind: 'checkpoint' as const,
    taskType: 'full_rebuild' as const,
    status: 'running' as const,
    createdAt: '2026-07-16T12:03:00.000Z',
    updatedAt: '2026-07-16T12:03:00.000Z',
    nextFloor: 5,
    lastCommittedFloor: 4,
    lastCommittedBundleId: dataset.bundles[0].id,
    sourceChatRevision: 'chat-revision-1',
    statistics: {
      processedBatches: 1,
      failedBatches: 0,
      summaryRecords: 3,
      characterMemoryRecords: 2,
      vectorRecords: 2,
    },
  };
  await repository.saveCheckpoint(checkpoint);
  assert.deepEqual(await repository.getCheckpoint('full_rebuild'), checkpoint);
  assert.equal(await repository.deleteCheckpoint('full_rebuild'), true);
  assert.equal(await repository.getCheckpoint('full_rebuild'), null);

  const secondBundleId = `${dataset.bundles[0].id}-second`;
  const recordIdMap = new Map<string, string>();
  for (const record of [...dataset.summaries, ...dataset.characterMemories]) {
    recordIdMap.set(record.id, `${record.id}-second`);
  }
  const secondSummaries = dataset.summaries.map(record => ({
    ...clone(record),
    id: recordIdMap.get(record.id)!,
    bundleId: secondBundleId,
    floorStart: record.floorStart + 4,
    floorEnd: record.floorEnd + 4,
    sourceHash: `${record.sourceHash}-second`,
  }));
  const secondCharacterMemories = dataset.characterMemories.map(record => ({
    ...clone(record),
    id: recordIdMap.get(record.id)!,
    bundleId: secondBundleId,
    floorStart: record.floorStart + 4,
    floorEnd: record.floorEnd + 4,
    sourceHash: `${record.sourceHash}-second`,
  }));
  const secondVectors = dataset.vectors.map(record => ({
    ...clone(record),
    id: `${record.id}-second`,
    bundleId: secondBundleId,
    memoryId: recordIdMap.get(record.memoryId)!,
    floorStart: (record.floorStart ?? 0) + 4,
    floorEnd: (record.floorEnd ?? 0) + 4,
  }));
  const secondBundle = {
    ...clone(dataset.bundles[0]),
    id: secondBundleId,
    summaryVersion: 2,
    floorStart: 5,
    floorEnd: 8,
    sourceHash: `${dataset.bundles[0].sourceHash}-second`,
    sourceMessages: dataset.bundles[0].sourceMessages.map(message => ({
      messageId: message.messageId + 4,
      contentHash: `${message.contentHash}-second`,
    })),
    smallSummaryIds: secondSummaries.filter(record => record.summaryKind === 'small').map(record => record.id),
    summarySegmentIds: secondSummaries.filter(record => record.summaryKind === 'grand').map(record => record.id),
    characterMemoryIds: secondCharacterMemories.map(record => record.id),
    vectorIndexIds: secondVectors.map(record => record.id),
  };
  const secondCheckpoint = {
    ...checkpoint,
    id: 'checkpoint-full-rebuild-second',
    status: 'ready' as const,
    nextFloor: 9,
    lastCommittedFloor: 8,
    lastCommittedBundleId: secondBundleId,
    sourceChatRevision: 'chat-revision-2',
  };
  const bundleCommit = await repository.commitBundle({
    bundle: secondBundle,
    summaries: secondSummaries,
    characterMemories: secondCharacterMemories,
    vectors: secondVectors,
    checkpoint: secondCheckpoint,
  });
  assert.deepEqual(bundleCommit, {
    bundleId: secondBundleId,
    shardCount: 5,
    summaryRecords: secondSummaries.length,
    characterMemoryRecords: secondCharacterMemories.length,
    vectorRecords: secondVectors.length,
    checkpointCommitted: true,
  });
  assert.equal((await repository.getBundle(secondBundleId))?.status, 'committed');
  assert.equal((await repository.getCheckpoint('full_rebuild'))?.lastCommittedBundleId, secondBundleId);
  const characterRecall = await repository.recallCharacterMemories({
    characterName: '秋青',
    queryText: '密信',
    queryVector: [0.4, 0.3, 0.2, 0.1],
    embedding: source.embedding,
    recentBundleCount: 1,
    recallLimit: 5,
  });
  assert.equal(characterRecall.recent.length > 0, true);
  assert.equal(characterRecall.recent.every(record => record.bundleId === secondBundleId), true);
  assert.equal(characterRecall.recalled.some(item => item.record.bundleId === dataset.bundles[0].id), true);
  assert.equal(await repository.invalidateBundlesFromFloor(5, 'source_changed'), 1);
  assert.equal((await repository.getBundle(secondBundleId))?.status, 'invalidated');
  assert.equal((await repository.getBundle(dataset.bundles[0].id))?.status, 'committed');
  const recallAfterInvalidation = await repository.recall({
    queryText: '密信',
    characters: ['秋青'],
    limit: 20,
  });
  assert.equal(recallAfterInvalidation.items.some(item => item.record.bundleId === secondBundleId), false);
  backend.failNextPersist = true;
  await assert.rejects(
    repository.commitBundle({
      bundle: secondBundle,
      summaries: secondSummaries,
      characterMemories: secondCharacterMemories,
      vectors: secondVectors,
      checkpoint: secondCheckpoint,
    }),
    /旧分库已恢复/,
  );
  assert.equal((await repository.getBundle(secondBundleId))?.status, 'invalidated');
  assert.equal((await repository.getCheckpoint('full_rebuild'))?.lastCommittedBundleId, secondBundleId);
  assert.equal(await repository.deleteCheckpoint('full_rebuild'), true);
  const storyQuery = await warehouse.query({
    collections: ['summary_segments', 'character_memory_segments'],
    storyTime: '景历十年',
    characters: ['秋青'],
    limit: 20,
  });
  // 底层查询可用于诊断，仍能看到已作废 Bundle 的子记录；正式 recall 会按 Bundle 状态过滤。
  assert.equal(storyQuery.total, 8);

  const recall = await repository.recall({
    queryText: '秋青还记得那封密信吗',
    queryVector: [0.4, 0.3, 0.2, 0.1],
    embedding: source.embedding,
    characters: ['秋青'],
    summarySegmentTypes: ['small', 'timeline_event'],
    hybridWeight: 0.8,
    limit: 2,
  });
  assert.equal(recall.items.length, 2);
  assert.equal(recall.items[0].record.kind, 'character_memory');
  assert.equal(recall.items[0].vectorMatched, true);
  assert.ok(recall.items[0].denseScore > 0.999);
  assert.equal(recall.vectorCandidateCount, 2);

  const wrongModelRecall = await repository.recall({
    queryText: '密信',
    queryVector: [0.4, 0.3, 0.2, 0.1],
    embedding: { ...source.embedding, model: 'other-model' },
    characters: ['秋青'],
    limit: 2,
  });
  assert.equal(wrongModelRecall.vectorCandidateCount, 0);
  assert.equal(wrongModelRecall.items.some(item => item.vectorMatched), false);
  await assert.rejects(
    repository.recall({
      queryText: '密信',
      queryVector: [0.1, 0.2],
      embedding: source.embedding,
    }),
    /查询向量维度不正确/,
  );
  const manifestBeforeFailedReplacement = await warehouse.loadManifest();
  backend.failNextPersist = true;
  backend.beforeFailedPersist = () => {
    backend.entries.push({ ...makeExternalEntry('多分库事务期间新增的外部条目'), uid: 77_777 });
  };
  await assert.rejects(
    repository.replaceDataset({
      bundles: [],
      summaries: [{ ...dataset.summaries[0], id: 'replacement-summary' }],
      characterMemories: [],
      vectors: [],
      checkpoints: [],
    }),
    /旧分库已恢复/,
  );
  const manifestAfterFailedReplacement = await warehouse.loadManifest();
  for (const collection of ['memory_bundles', 'summary_segments', 'character_memory_segments', 'vector_indexes', 'checkpoints'] as const) {
    assert.deepEqual(
      manifestAfterFailedReplacement.collections[collection].shards.map(shard => shard.shardId),
      manifestBeforeFailedReplacement.collections[collection].shards.map(shard => shard.shardId),
    );
  }
  assert.equal(backend.entries.some(entry => entry.name === '多分库事务期间新增的外部条目'), true);
  assert.equal(backend.entries.filter(entry => entry.extra?.source === 'user-entry').length, 2);
}

async function testNoEmbeddingApiUsesLexicalRecall(): Promise<void> {
  const source = {
    chatId: 'chat-no-embedding',
    now: '2026-07-17T02:00:00.000Z',
    // 无向量 API 时仍保留索引身份占位，但任何事实记录都不依赖它。
    embedding: {
      provider: 'disabled',
      model: 'none',
      dimensions: 0,
      indexVersion: 1,
    },
    smallSummaries: [],
    grandSummaries: [{
      version: 1,
      generatedAt: '2026-07-17T02:00:00.000Z',
      coveredMessageIds: [1, 2],
      sourceMessages: [
        { messageId: 1, contentHash: 'no-embedding-message-1' },
        { messageId: 2, contentHash: 'no-embedding-message-2' },
      ],
      rawText: '秋青把月光石交给明月保管。',
      characterTable: [{ name: '秋青', aliases: ['阿青'] }],
      timeline: [{
        time: '景历十年夏',
        event: '托付月光石',
        detail: '秋青把月光石交给明月保管，没有生成任何向量。',
        triggers: { characters: ['秋青', '明月'], keywords: ['月光石', '保管'] },
      }],
      characterMemories: [{
        characterName: '秋青',
        aliases: ['阿青'],
        keywords: ['月光石', '明月'],
        coreMemories: [{ text: '我把月光石交给明月保管。', time: '景历十年夏' }],
        orderedNewMemories: [
          { text: '我把月光石交给明月保管。', isCore: true, time: '景历十年夏' },
        ],
      }],
    }],
  };
  const dataset = buildMemoryWarehouseDataset(source);
  assert.equal(dataset.bundles.length, 1);
  assert.equal(dataset.vectors.length, 0);
  assert.deepEqual(dataset.bundles[0].vectorIndexIds, []);
  assert.equal(dataset.summaries.some(record => record.segmentType === 'timeline_event'), true);
  assert.equal(dataset.characterMemories.length, 1);

  const backend = new FakeWorldbookBackend([makeExternalEntry()]);
  const warehouse = new MemoryWarehouse({ chatId: source.chatId, backend, chunkCharacterLimit: 1024 });
  const repository = new MemoryWarehouseRepository(warehouse);
  await repository.replaceDataset(dataset);

  const characterRecall = await repository.recallCharacterMemories({
    characterName: '秋青',
    queryText: '月光石由谁保管',
    recentBundleCount: 0,
    recallLimit: 5,
    minScore: 0.1,
  });
  assert.equal(characterRecall.recent.length, 0);
  assert.equal(characterRecall.recalled.length, 1);
  assert.equal(characterRecall.recalled[0].record.kind, 'character_memory');
  assert.equal(characterRecall.recalled[0].vectorMatched, false);
  assert.equal(characterRecall.recalled[0].denseScore, 0);
  assert.ok(characterRecall.recalled[0].lexicalScore > 0);

  const timelineRecall = await repository.recallTimelineEvents({
    queryText: '秋青 月光石 保管',
    recentBundleCount: 0,
    recallLimit: 5,
    minScore: 0.1,
  });
  assert.equal(timelineRecall.recent.length, 0);
  assert.equal(timelineRecall.recalled.length, 1);
  assert.equal(timelineRecall.recalled[0].record.kind, 'summary');
  assert.equal(timelineRecall.recalled[0].vectorMatched, false);
  assert.equal(timelineRecall.recalled[0].denseScore, 0);
  assert.ok(timelineRecall.recalled[0].lexicalScore > 0);
  assert.equal(backend.entries.filter(entry => entry.extra?.source === 'user-entry').length, 1);
}

async function testStagedBatchActivationIsAtomic(): Promise<void> {
  const backend = new FakeWorldbookBackend([makeExternalEntry()]);
  const warehouse = new MemoryWarehouse({ chatId: 'chat-batch-activation', backend, chunkCharacterLimit: 1024 });
  const repository = new MemoryWarehouseRepository(warehouse);
  const oldSummary = { ...makeSummary('old-summary', 1, 10, '秋青'), bundleId: 'old-bundle' };
  const oldBundle = {
    id: 'old-bundle',
    kind: 'memory_bundle' as const,
    bundleType: 'realtime' as const,
    status: 'committed' as const,
    createdAt: '2026-07-16T10:00:00.000Z',
    updatedAt: '2026-07-16T10:00:00.000Z',
    committedAt: '2026-07-16T10:00:00.000Z',
    floorStart: 1,
    floorEnd: 10,
    sourceHash: 'old-source',
    sourceMessages: [{ messageId: 10, contentHash: 'old-message' }],
    smallSummaryIds: [],
    summarySegmentIds: [oldSummary.id],
    characterMemoryIds: [],
    vectorIndexIds: [],
    characters: ['秋青'],
    keywords: ['密信'],
  };
  await repository.commitBundle({ bundle: oldBundle, summaries: [oldSummary], characterMemories: [], vectors: [] });

  const transactionId = 'tx-batch-001';
  const stagedSummary = {
    ...makeSummary('staged-summary', 1, 10, '秋青'),
    bundleId: 'staged-bundle',
    overview: '秋青在重建时间线里交出了新密信',
    payload: {
      grandSummaryProjection: {
        version: 2,
        generatedAt: '2026-07-16T11:00:00.000Z',
        coveredMessageIds: [1, 10],
        characterMemories: [],
        timeline: [],
        characterTable: [],
        rawText: '秋青在重建时间线里交出了新密信',
      },
    },
  };
  const stagedBundle = {
    ...oldBundle,
    id: 'staged-bundle',
    bundleType: 'batch_rebuild' as const,
    status: 'staged' as const,
    rebuildTransactionId: transactionId,
    stagedAt: '2026-07-16T11:00:00.000Z',
    committedAt: undefined,
    createdAt: '2026-07-16T11:00:00.000Z',
    updatedAt: '2026-07-16T11:00:00.000Z',
    sourceHash: 'staged-source',
    sourceMessages: [{ messageId: 10, contentHash: 'staged-message' }],
    summarySegmentIds: [stagedSummary.id],
  };
  const runningCheckpoint = {
    id: 'checkpoint-full-rebuild',
    kind: 'checkpoint' as const,
    taskType: 'full_rebuild' as const,
    status: 'running' as const,
    createdAt: '2026-07-16T11:00:00.000Z',
    updatedAt: '2026-07-16T11:00:00.000Z',
    rangeStart: 1,
    rangeEnd: 10,
    batchSize: 10,
    nextFloor: 11,
    lastCommittedFloor: 10,
    lastCommittedBundleId: stagedBundle.id,
    sourceChatRevision: 'revision-1',
    transactionId,
    statistics: {
      processedBatches: 1,
      failedBatches: 0,
      summaryRecords: 1,
      characterMemoryRecords: 0,
      vectorRecords: 0,
    },
  };
  await repository.commitBundle({
    bundle: stagedBundle,
    summaries: [stagedSummary],
    characterMemories: [],
    vectors: [],
    checkpoint: runningCheckpoint,
  });
  const beforeActivation = await repository.recall({ queryText: '密信', characters: ['秋青'], limit: 10 });
  assert.equal(beforeActivation.items.some(item => item.record.bundleId === stagedBundle.id), false);
  assert.equal(beforeActivation.items.some(item => item.record.bundleId === oldBundle.id), true);

  // 激活落盘失败时，旧 committed Bundle 与 staged Bundle 的可见性必须原样恢复。
  backend.failNextPersist = true;
  await assert.rejects(
    repository.activateStagedBundles(transactionId, {
      ...runningCheckpoint,
      status: 'ready',
      updatedAt: '2026-07-16T11:00:30.000Z',
    }),
    /旧分库已恢复/,
  );
  assert.equal((await repository.getBundle(stagedBundle.id))?.status, 'staged');
  assert.equal((await repository.getBundle(oldBundle.id))?.status, 'committed');
  assert.equal((await repository.getCheckpoint('full_rebuild'))?.status, 'running');
  const afterFailedActivation = await repository.recall({ queryText: '密信', characters: ['秋青'], limit: 10 });
  assert.equal(afterFailedActivation.items.some(item => item.record.bundleId === stagedBundle.id), false);
  assert.equal(afterFailedActivation.items.some(item => item.record.bundleId === oldBundle.id), true);

  const activated = await repository.activateStagedBundles(transactionId, {
    ...runningCheckpoint,
    status: 'ready',
    updatedAt: '2026-07-16T11:01:00.000Z',
  });
  assert.deepEqual(activated.activatedBundleIds, [stagedBundle.id]);
  assert.deepEqual(activated.invalidatedBundleIds, [oldBundle.id]);
  assert.equal((await repository.getBundle(stagedBundle.id))?.status, 'committed');
  assert.equal((await repository.getBundle(oldBundle.id))?.status, 'invalidated');
  assert.equal((await repository.getCheckpoint('full_rebuild'))?.status, 'ready');
  const afterActivation = await repository.recall({ queryText: '密信', characters: ['秋青'], limit: 10 });
  assert.equal(afterActivation.items.some(item => item.record.bundleId === stagedBundle.id), true);
  assert.equal(afterActivation.items.some(item => item.record.bundleId === oldBundle.id), false);
  const timelineRecall = await repository.recallTimelineEvents({
    queryText: '新密信',
    recentBundleCount: 1,
    recallLimit: 5,
  });
  assert.equal(timelineRecall.recent.length, 1);
  assert.equal(timelineRecall.recent[0].bundleId, stagedBundle.id);
  assert.equal(timelineRecall.recalled.some(item => item.record.bundleId === oldBundle.id), false);
  const projections = await repository.listGrandSummaryProjections(transactionId);
  assert.equal(projections.length, 1);
  assert.equal(projections[0].memoryBundleId, stagedBundle.id);
  assert.equal(backend.entries.filter(entry => entry.extra?.source === 'user-entry').length, 1);
}

function testRawChatReaderAndSourceTracker(): void {
  const messages: any[] = [
    {
      message_id: 0,
      name: '秋青',
      role: 'assistant',
      is_hidden: false,
      swipe_id: 0,
      swipes: ['<content>开场白</content>'],
      swipes_data: [{}],
      swipes_info: [{}],
    },
    {
      message_id: 1,
      name: '明月',
      role: 'user',
      is_hidden: false,
      swipe_id: 0,
      swipes: ['我把银钥匙交给你。'],
      swipes_data: [{}],
      swipes_info: [{}],
    },
    {
      message_id: 2,
      name: '秋青',
      role: 'assistant',
      is_hidden: false,
      swipe_id: 1,
      swipes: ['<content>旧消息页</content>', '<content>她收下银钥匙。</content>'],
      swipes_data: [{}, { tangquan: { sceneId: 'scene-1', traceId: 'trace-1' } }],
      swipes_info: [{}, {}],
    },
  ];
  const reader = new RawChatReader({
    getLastMessageId: () => messages.length - 1,
    getMessages: (range, options) => {
      const [start, end] = typeof range === 'number'
        ? [range, range]
        : String(range).split('-').map(Number);
      return messages.filter(message => (
        message.message_id >= start
        && message.message_id <= end
        && (!options?.role || options.role === 'all' || message.role === options.role)
      ));
    },
  });

  const selected = reader.readMessage(2, 'assistant');
  assert.equal(selected?.selectedSwipeId, 1);
  assert.equal(selected?.content, '她收下银钥匙。');
  assert.equal(selected?.sceneId, 'scene-1');
  assert.equal(selected?.traceId, 'trace-1');

  const originalSources = reader.readSourceContentsForAssistantFloors([2]);
  assert.deepEqual(originalSources.map(item => item.messageId), [1, 2]);
  const tracker = new SourceChangeTracker();
  tracker.reset(originalSources);

  messages[2].is_hidden = true;
  const hiddenOnly = tracker.diffAndReset(reader.readSourceContentsForAssistantFloors([2]), 2);
  assert.equal(hiddenOnly.changed, false, '隐藏楼层不改变长期事实来源');

  messages[2].swipe_id = 0;
  const swipeChangedSources = reader.readSourceContentsForAssistantFloors([2]);
  const swipeChanged = tracker.diffAndReset(swipeChangedSources, 2);
  assert.equal(swipeChanged.changed, true);
  assert.equal(swipeChanged.earliestChangedFloor, 2);

  const expectedFingerprints = fingerprintMemorySourceContents(originalSources);
  const bundle: MemoryBundleRecord = {
    id: 'source-test-bundle',
    kind: 'memory_bundle',
    bundleType: 'realtime',
    status: 'committed',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    floorStart: 1,
    floorEnd: 2,
    sourceHash: 'source-test',
    sourceMessages: expectedFingerprints,
    smallSummaryIds: [],
    summarySegmentIds: [],
    characterMemoryIds: [],
    vectorIndexIds: [],
    characters: [],
    keywords: [],
  };
  const currentById = new Map(
    fingerprintMemorySourceContents(swipeChangedSources).map(item => [item.messageId, item] as const),
  );
  assert.equal(hasMemoryBundleSourceChanged(bundle, currentById), true);
}

async function testManualReplacementIsAtomic(): Promise<void> {
  const backend = new FakeWorldbookBackend([makeExternalEntry()]);
  const warehouse = new MemoryWarehouse({ chatId: 'manual-replace-chat', backend });
  const repository = new MemoryWarehouseRepository(warehouse);
  await warehouse.initialize();

  const makeBundle = (id: string, summaryId: string, text: string): {
    bundle: MemoryBundleRecord;
    summary: SummarySegmentRecord;
  } => {
    const summary = makeSummary(summaryId, 1, 2, '秋青');
    summary.bundleId = id;
    summary.overview = text;
    summary.detail = text;
    const bundle: MemoryBundleRecord = {
      id,
      kind: 'memory_bundle',
      bundleType: 'realtime',
      status: 'committed',
      createdAt: '2026-07-17T01:00:00.000Z',
      updatedAt: '2026-07-17T01:00:00.000Z',
      floorStart: 1,
      floorEnd: 2,
      sourceHash: `${id}-source`,
      sourceMessages: [{ messageId: 2, contentHash: `${id}-content`, role: 'assistant', swipeId: 0 }],
      smallSummaryIds: [],
      summarySegmentIds: [summary.id],
      characterMemoryIds: [],
      vectorIndexIds: [],
      characters: ['秋青'],
      keywords: ['银钥匙'],
      committedAt: '2026-07-17T01:00:00.000Z',
    };
    return { bundle, summary };
  };

  const oldMemory = makeBundle('old-manual-bundle', 'old-manual-summary', '旧记忆：没有收下钥匙');
  await repository.commitBundle({
    bundle: oldMemory.bundle,
    summaries: [oldMemory.summary],
    characterMemories: [],
    vectors: [],
  });

  const replacement = makeBundle('new-manual-bundle', 'new-manual-summary', '新记忆：收下银钥匙');
  backend.failNextPersist = true;
  await assert.rejects(repository.commitBundle({
    bundle: replacement.bundle,
    summaries: [replacement.summary],
    characterMemories: [],
    vectors: [],
    replaceBundleIds: [oldMemory.bundle.id],
  }));
  assert.equal((await repository.getBundle(oldMemory.bundle.id))?.status, 'committed');
  assert.equal(await repository.getBundle(replacement.bundle.id), null);

  await repository.commitBundle({
    bundle: replacement.bundle,
    summaries: [replacement.summary],
    characterMemories: [],
    vectors: [],
    replaceBundleIds: [oldMemory.bundle.id],
  });
  assert.equal((await repository.getBundle(oldMemory.bundle.id))?.status, 'invalidated');
  assert.equal((await repository.getBundle(replacement.bundle.id))?.status, 'committed');
  const recalled = await repository.recall({ queryText: '银钥匙', characters: ['秋青'], limit: 10 });
  assert.equal(recalled.items.some(item => item.record.bundleId === oldMemory.bundle.id), false);
  assert.equal(recalled.items.some(item => item.record.bundleId === replacement.bundle.id), true);
  assert.equal(backend.entries.filter(entry => entry.extra?.source === 'user-entry').length, 1);
}

async function main(): Promise<void> {
  await testInitializeWriteReadQueryAndDelete();
  await testRollbackOnlyRestoresOwnedTransactionScope();
  await testConcurrentWritesAreSerialized();
  await testIdenticalPendingWritesAreCoalesced();
  await testAtomicCollectionReplacement();
  await testCorruptionIsReported();
  testFloat32VectorCodec();
  await testDatasetConversionShardingAndCommit();
  await testNoEmbeddingApiUsesLexicalRecall();
  await testStagedBatchActivationIsAtomic();
  testRawChatReaderAndSourceTracker();
  await testManualReplacementIsAtomic();
  console.log('智脑记忆仓内部测试通过：12/12');
}

void main();
