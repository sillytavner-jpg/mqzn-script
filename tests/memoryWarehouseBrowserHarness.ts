import { checksumText, encodeFloat32Vector, stableTextId } from '../src/core/memoryWarehouseCodec';
import { deleteMemoryWarehouseForChat, MemoryWarehouse } from '../src/core/memoryWarehouse';
import { MemoryWarehouseRepository, type EmbeddingIndexIdentity } from '../src/core/memoryWarehouseRepository';
import type {
  CharacterMemorySegmentRecord,
  MemoryBundleRecord,
  MemoryWarehouseInspection,
  SummarySegmentRecord,
  VectorIndexRecord,
} from '../src/core/memoryWarehouseTypes';

const RESULT_ENTRY_NAME = 'Codex记忆仓浏览器测试结果';
const EXTERNAL_ENTRY_NAME = 'Codex外部条目保留夹具';
const EMBEDDING: EmbeddingIndexIdentity = {
  provider: 'codex-browser-test',
  model: 'fixture-4d',
  dimensions: 4,
  indexVersion: 1,
};
const FACT = '秋青把银色钥匙藏在藏书阁第三排书架后。';

function collectionCounts(inspection: MemoryWarehouseInspection) {
  return Object.fromEntries(
    Object.entries(inspection.manifest?.collections ?? {}).map(([name, collection]) => [
      name,
      {
        shards: collection.shards.length,
        records: collection.shards.reduce((sum, shard) => sum + shard.recordCount, 0),
      },
    ]),
  );
}

function createFixtureDataset(chatId: string) {
  const now = new Date().toISOString();
  const keywords = ['秋青', '银色钥匙', '藏书阁'];
  const seed = `${chatId}|秋青|1|${FACT}`;
  const bundleId = stableTextId('browser-bundle', seed);
  const summary: SummarySegmentRecord = {
    id: stableTextId('browser-summary', seed),
    kind: 'summary',
    bundleId,
    summaryKind: 'grand',
    segmentType: 'timeline_event',
    createdAt: now,
    updatedAt: now,
    floorStart: 1,
    floorEnd: 1,
    sourceHash: checksumText(seed),
    storyTime: '景历十年春',
    characters: ['秋青'],
    keywords,
    overview: FACT,
    detail: `浏览器实测记忆：${FACT}`,
  };
  const characterMemory: CharacterMemorySegmentRecord = {
    id: stableTextId('browser-character', seed),
    kind: 'character_memory',
    bundleId,
    createdAt: now,
    updatedAt: now,
    floorStart: 1,
    floorEnd: 1,
    sourceHash: checksumText(`character|${seed}`),
    characterName: '秋青',
    aliases: [],
    memoryType: 'core',
    text: FACT,
    storyTime: '景历十年春',
    keywords,
  };
  const vector: VectorIndexRecord = {
    id: stableTextId('browser-vector', `${seed}|${EMBEDDING.model}`),
    kind: 'vector_index',
    bundleId,
    memoryId: characterMemory.id,
    memoryKind: 'character_memory',
    textHash: checksumText(FACT),
    floorStart: 1,
    floorEnd: 1,
    storyTime: '景历十年春',
    characters: ['秋青'],
    keywords,
    provider: EMBEDDING.provider,
    model: EMBEDDING.model,
    dimensions: EMBEDDING.dimensions,
    indexVersion: EMBEDDING.indexVersion,
    encoding: 'float32-base64',
    vector: encodeFloat32Vector([1, 0, 0, 0]),
    createdAt: now,
    updatedAt: now,
  };
  const bundle: MemoryBundleRecord = {
    id: bundleId,
    kind: 'memory_bundle',
    bundleType: 'derived_rebuild',
    status: 'committed',
    createdAt: now,
    updatedAt: now,
    floorStart: 1,
    floorEnd: 1,
    sourceHash: checksumText(seed),
    sourceMessages: [{ messageId: 1, contentHash: checksumText(FACT) }],
    smallSummaryIds: [],
    summarySegmentIds: [summary.id],
    characterMemoryIds: [characterMemory.id],
    vectorIndexIds: [vector.id],
    characters: ['秋青'],
    keywords,
    committedAt: now,
  };
  return { bundles: [bundle], summaries: [summary], characterMemories: [characterMemory], vectors: [vector], checkpoints: [] };
}

async function ensureExternalFixture(worldbookName: string): Promise<void> {
  const entries = await getWorldbook(worldbookName);
  if (entries.some(entry => entry.name === EXTERNAL_ENTRY_NAME)) return;
  await createWorldbookEntries(
    worldbookName,
    [{
      name: EXTERNAL_ENTRY_NAME,
      enabled: false,
      content: '该条目不属于智脑记忆仓，用于验证提交不会误删同一本聊天世界书里的外部数据。',
      extra: { source: 'codex-browser-external-fixture-v1' },
    }],
    { render: 'immediate' },
  );
}

async function saveResult(worldbookName: string, result: Record<string, unknown>): Promise<void> {
  const content = JSON.stringify(result, null, 2);
  const entries = await getWorldbook(worldbookName);
  if (entries.some(entry => entry.name === RESULT_ENTRY_NAME)) {
    await updateWorldbookWith(
      worldbookName,
      worldbook => worldbook.map(entry => entry.name === RESULT_ENTRY_NAME
        ? {
            ...entry,
            enabled: false,
            content,
            extra: { ...entry.extra, source: 'codex-browser-test-result-v1' },
          }
        : entry),
      { render: 'immediate' },
    );
    return;
  }
  await createWorldbookEntries(
    worldbookName,
    [{
      name: RESULT_ENTRY_NAME,
      enabled: false,
      content,
      extra: { source: 'codex-browser-test-result-v1' },
    }],
    { render: 'immediate' },
  );
}

async function run(): Promise<void> {
  let worldbookName = '';
  try {
    const chatId = SillyTavern.getCurrentChatId()?.trim() ?? '';
    if (!chatId) throw new Error('当前没有已打开的测试聊天');
    const warehouse = new MemoryWarehouse({ chatId });
    worldbookName = (await warehouse.inspect()).worldbookName;
    await ensureExternalFixture(worldbookName);

    const repository = new MemoryWarehouseRepository(warehouse);
    const before = await warehouse.inspect();
    const mode = before.manifest ? 'reload-read' : 'initial-seed';
    const commit = before.manifest ? null : await repository.replaceDataset(createFixtureDataset(chatId));
    const after = await warehouse.inspect();
    const query = await warehouse.query({
      collections: ['character_memory_segments'],
      characters: ['秋青'],
      keywords: ['银色钥匙'],
      storyTime: '景历十年',
      limit: 10,
    });
    const recall = await repository.recall({
      queryText: '秋青把银色钥匙藏在哪里？',
      queryVector: [1, 0, 0, 0],
      embedding: EMBEDDING,
      characters: ['秋青'],
      keywords: ['银色钥匙'],
      limit: 5,
      hybridWeight: 0.8,
    });
    const persistedEntries = await getWorldbook(after.worldbookName);
    const externalPreserved = persistedEntries.some(entry =>
      entry.name === EXTERNAL_ENTRY_NAME
      && entry.extra?.source === 'codex-browser-external-fixture-v1');
    const queryHit = query.records.some(record =>
      record.kind === 'character_memory'
      && record.characterName === '秋青'
      && record.text.includes('藏书阁第三排书架后'));
    const recallHit = recall.items.some(item =>
      item.record.kind === 'character_memory'
      && item.record.text.includes('藏书阁第三排书架后')
      && item.vectorMatched
      && item.denseScore > 0.99);
    const result = {
      success: Boolean(after.ok && after.manifest && externalPreserved && queryHit && recallHit),
      mode,
      chatId,
      worldbookName: after.worldbookName,
      before: {
        ok: before.ok,
        hadManifest: Boolean(before.manifest),
        ownedEntryCount: before.ownedEntryCount,
        externalEntryCount: before.externalEntryCount,
        issues: before.issues,
      },
      after: {
        ok: after.ok,
        ownedEntryCount: after.ownedEntryCount,
        externalEntryCount: after.externalEntryCount,
        issues: after.issues,
        counts: collectionCounts(after),
      },
      commit,
      query: {
        total: query.total,
        loadedShardCount: query.loadedShardCount,
        candidateShardCount: query.candidateShardCount,
        ids: query.records.map(record => record.id),
      },
      recall: {
        candidateCount: recall.candidateCount,
        vectorCandidateCount: recall.vectorCandidateCount,
        loadedShardCount: recall.loadedShardCount,
        invalidVectorCount: recall.invalidVectorCount,
        items: recall.items.map(item => ({
          id: item.record.id,
          kind: item.record.kind,
          score: item.score,
          denseScore: item.denseScore,
          lexicalScore: item.lexicalScore,
          vectorMatched: item.vectorMatched,
        })),
      },
      checks: { externalPreserved, queryHit, recallHit },
      finishedAt: new Date().toISOString(),
    };
    await saveResult(after.worldbookName, result);
    (window as Window & { __MQZN_BROWSER_TEST_RESULT__?: typeof result }).__MQZN_BROWSER_TEST_RESULT__ = result;
    if (result.success) toastr.success(`记忆仓浏览器测试通过（${mode}）`, '智脑记忆仓 V1');
    else toastr.error('记忆仓浏览器测试未通过，请查看聊天世界书中的测试结果条目', '智脑记忆仓 V1');
  } catch (error) {
    const result = {
      success: false,
      mode: 'error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : '',
      finishedAt: new Date().toISOString(),
    };
    if (worldbookName) await saveResult(worldbookName, result).catch(() => undefined);
    (window as Window & { __MQZN_BROWSER_TEST_RESULT__?: typeof result }).__MQZN_BROWSER_TEST_RESULT__ = result;
    toastr.error(result.message, '智脑记忆仓 V1 浏览器测试失败');
  }
}

$(() => void run());

eventOn(tavern_events.CHAT_DELETED, (chatFileName: string) => {
  void deleteMemoryWarehouseForChat(chatFileName).catch(error => {
    console.error('[智脑记忆仓浏览器测试] 删除聊天世界书失败', error);
  });
});
