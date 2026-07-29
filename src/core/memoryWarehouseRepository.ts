import { checksumText, decodeFloat32Vector, encodeFloat32Vector, stableTextId } from './memoryWarehouseCodec';
import type { MemoryWarehouse } from './memoryWarehouse';
import type {
  CharacterMemorySegmentRecord,
  MemoryBundleRecord,
  MemoryCheckpointRecord,
  MemorySourceMessageFingerprint,
  MemoryWarehouseQuery,
  MemoryWarehouseRecord,
  ReplaceMemoryCollectionInput,
  SummarySegmentRecord,
  VectorIndexRecord,
} from './memoryWarehouseTypes';

export interface SourceSmallSummary {
  id: string;
  floorRange: { start: number; end: number };
  status: 'pending' | 'ready' | 'failed' | 'hidden-active' | 'absorbed' | 'ignored';
  generatedAt?: string;
  storyTime?: string;
  location?: string;
  mainEvent?: string;
  presentCharacters?: string[];
  interactingCharacters?: string[];
  characterLocations?: Array<{ name: string; location: string }>;
}

export interface SourceTimelineEvent {
  time?: string;
  event: string;
  detail?: string;
  triggers?: { characters?: string[]; keywords?: string[] };
  importance?: number;
  embedding?: number[];
}

export interface SourceCoreMemory {
  text: string;
  embedding?: number[];
  time?: string;
}

export interface SourceOrderedMemory {
  text: string;
  isCore: boolean;
  time?: string;
  id?: string;
  floor?: number;
  source?: string;
  embedding?: number[];
}

export interface SourceCharacterMemory {
  characterName: string;
  aliases?: string[];
  coreMemories?: Array<SourceCoreMemory | string>;
  recentMemories?: string[];
  keywords?: string[];
  orderedNewMemories?: SourceOrderedMemory[];
}

export interface SourceGrandSummary {
  version: number;
  generatedAt: string;
  upToMessageId?: number;
  coveredMessageIds?: number[];
  /** 正式实时／批量接线时提供；旧派生状态转换允许为空并使用整体 sourceHash。 */
  sourceMessages?: MemorySourceMessageFingerprint[];
  characterMemories?: SourceCharacterMemory[];
  timeline?: SourceTimelineEvent[];
  characterTable?: Array<{
    name: string;
    aliases?: string[];
    identity?: string;
    relationship?: string;
    status?: string;
  }>;
  rawText?: string;
  isFailed?: boolean;
}

export interface EmbeddingIndexIdentity {
  provider: string;
  model: string;
  dimensions: number;
  indexVersion: number;
}

export interface MemoryWarehouseDataset {
  bundles: MemoryBundleRecord[];
  summaries: SummarySegmentRecord[];
  characterMemories: CharacterMemorySegmentRecord[];
  vectors: VectorIndexRecord[];
  checkpoints: MemoryCheckpointRecord[];
}

export interface MemoryWarehouseDatasetBuildInput {
  chatId: string;
  smallSummaries: SourceSmallSummary[];
  grandSummaries: SourceGrandSummary[];
  embedding: EmbeddingIndexIdentity;
  bundleType?: MemoryBundleRecord['bundleType'];
  /** 批量重建断点恢复时，在 overview payload 中保存可恢复的完整投影。 */
  includeGrandSummaryProjection?: boolean;
  now?: string;
}

export interface MemoryWarehouseShardPlanOptions {
  bundleRecordsPerShard?: number;
  summaryRecordsPerShard?: number;
  characterRecordsPerShard?: number;
  vectorRecordsPerShard?: number;
  checkpointRecordsPerShard?: number;
}

export interface MemoryWarehouseDatasetCommitResult {
  bundleShards: number;
  summaryShards: number;
  characterMemoryShards: number;
  vectorShards: number;
  checkpointShards: number;
  bundleRecords: number;
  summaryRecords: number;
  characterMemoryRecords: number;
  vectorRecords: number;
  checkpointRecords: number;
}

export interface MemoryBundleCommitInput {
  bundle: MemoryBundleRecord;
  summaries: SummarySegmentRecord[];
  characterMemories: CharacterMemorySegmentRecord[];
  vectors: VectorIndexRecord[];
  checkpoint?: MemoryCheckpointRecord;
  /** 与新 Bundle 同一事务作废的旧 committed Bundle；用于手动重新总结。 */
  replaceBundleIds?: string[];
}

export interface MemoryBundleCommitResult {
  bundleId: string;
  shardCount: number;
  summaryRecords: number;
  characterMemoryRecords: number;
  vectorRecords: number;
  checkpointCommitted: boolean;
}

export type RecallableMemoryRecord = SummarySegmentRecord | CharacterMemorySegmentRecord;

export interface MemoryRecallQuery {
  queryText: string;
  queryVector?: number[];
  embedding?: EmbeddingIndexIdentity;
  characters?: string[];
  keywords?: string[];
  floorStart?: number;
  floorEnd?: number;
  storyTime?: string;
  recordKinds?: Array<RecallableMemoryRecord['kind']>;
  summarySegmentTypes?: SummarySegmentRecord['segmentType'][];
  limit?: number;
  candidateMultiplier?: number;
  hybridWeight?: number;
  minScore?: number;
}

export interface MemoryRecallItem {
  record: RecallableMemoryRecord;
  score: number;
  denseScore: number;
  lexicalScore: number;
  vectorMatched: boolean;
}

export interface MemoryRecallResult {
  items: MemoryRecallItem[];
  candidateCount: number;
  vectorCandidateCount: number;
  loadedShardCount: number;
  invalidVectorCount: number;
}

export interface CharacterMemoryRecallQuery {
  characterName: string;
  queryText: string;
  queryVector?: number[];
  embedding?: EmbeddingIndexIdentity;
  recentBundleCount?: number;
  recallLimit?: number;
  candidateMultiplier?: number;
  hybridWeight?: number;
  minScore?: number;
}

export interface CharacterMemoryRecallResult {
  recent: CharacterMemorySegmentRecord[];
  recalled: MemoryRecallItem[];
}

export interface TimelineEventRecallQuery {
  queryText: string;
  queryVector?: number[];
  embedding?: EmbeddingIndexIdentity;
  recentBundleCount?: number;
  recallLimit?: number;
  candidateMultiplier?: number;
  hybridWeight?: number;
  minScore?: number;
}

export interface TimelineEventRecallResult {
  recent: SummarySegmentRecord[];
  recalled: MemoryRecallItem[];
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.map(value => value?.trim() ?? '').filter(Boolean))];
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function stableJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function sourceHash(value: unknown): string {
  return checksumText(stableJson(value));
}

function textKeywords(text: string): string[] {
  return uniqueStrings(
    (text.match(/[\p{L}\p{N}_-]{2,16}/gu) ?? [])
      .filter(token => token.length <= 16)
      .slice(0, 20),
  );
}

function normalizeRecallText(value: string): string {
  return [...value.toLocaleLowerCase()]
    .filter(character => /[\p{L}\p{N}]/u.test(character))
    .join('');
}

function textBigrams(value: string): Set<string> {
  const characters = [...normalizeRecallText(value)];
  if (characters.length < 2) return new Set(characters);
  const result = new Set<string>();
  for (let index = 0; index < characters.length - 1; index += 1) {
    result.add(`${characters[index]}${characters[index + 1]}`);
  }
  return result;
}

function lexicalSimilarity(queryText: string, record: RecallableMemoryRecord): number {
  const normalizedQuery = normalizeRecallText(queryText);
  if (!normalizedQuery) return 0;
  const text = record.kind === 'summary' ? `${record.overview}\n${record.detail ?? ''}` : record.text;
  const queryBigrams = textBigrams(normalizedQuery);
  const textBigramSet = textBigrams(text);
  let intersection = 0;
  for (const bigram of queryBigrams) {
    if (textBigramSet.has(bigram)) intersection += 1;
  }
  const union = new Set([...queryBigrams, ...textBigramSet]).size;
  const bigramScore = union > 0 ? intersection / union : 0;
  const matchedKeywords = record.keywords.filter(keyword => {
    const normalizedKeyword = normalizeRecallText(keyword);
    return normalizedKeyword.length > 0 && normalizedQuery.includes(normalizedKeyword);
  });
  const keywordScore = record.keywords.length > 0 ? matchedKeywords.length / record.keywords.length : 0;
  return Math.max(bigramScore, keywordScore);
}

function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function recallRecordFloor(record: RecallableMemoryRecord): number {
  return record.floorEnd;
}

function isRecallableRecord(record: MemoryWarehouseRecord): record is RecallableMemoryRecord {
  return record.kind === 'summary' || record.kind === 'character_memory';
}

function validDate(value: string | undefined, fallback: string): string {
  return value && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function grandSummaryRange(summary: SourceGrandSummary, previousFloor: number): { floorStart: number; floorEnd: number } {
  const covered = (summary.coveredMessageIds ?? []).filter(Number.isFinite);
  if (covered.length > 0) {
    return { floorStart: Math.min(...covered), floorEnd: Math.max(...covered) };
  }
  const floorEnd = Number.isFinite(summary.upToMessageId) ? Number(summary.upToMessageId) : previousFloor;
  return { floorStart: Math.max(0, previousFloor + 1), floorEnd: Math.max(previousFloor + 1, floorEnd) };
}

function memoryId(prefix: string, parts: unknown[]): string {
  return `${prefix}-${stableTextId('id', stableJson(parts)).slice('id-'.length)}`;
}

function bundleShardSuffix(bundleId: string): string {
  return stableTextId('bundle', bundleId).slice('bundle-'.length);
}

function checkpointShardId(taskType: MemoryCheckpointRecord['taskType']): string {
  return `checkpoint-${stableTextId('task', taskType).slice('task-'.length)}`;
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function makeVectorRecord(
  record: SummarySegmentRecord | CharacterMemorySegmentRecord,
  vector: number[],
  embedding: EmbeddingIndexIdentity,
): VectorIndexRecord | null {
  if (vector.length === 0 || vector.length !== embedding.dimensions) return null;
  const now = record.updatedAt;
  return {
    id: memoryId('vec', [record.id, embedding.provider, embedding.model, embedding.dimensions, embedding.indexVersion]),
    kind: 'vector_index',
    bundleId: record.bundleId,
    memoryId: record.id,
    memoryKind: record.kind,
    textHash: checksumText(record.kind === 'summary' ? `${record.overview}\n${record.detail ?? ''}` : record.text),
    floorStart: record.floorStart,
    floorEnd: record.floorEnd,
    storyTime: record.storyTime,
    characters: record.kind === 'summary' ? record.characters : [record.characterName, ...record.aliases],
    keywords: record.keywords,
    provider: embedding.provider,
    model: embedding.model,
    dimensions: embedding.dimensions,
    indexVersion: embedding.indexVersion,
    encoding: 'float32-base64',
    vector: encodeFloat32Vector(vector),
    createdAt: now,
    updatedAt: now,
  };
}

function buildSmallSummaryRecords(
  input: MemoryWarehouseDatasetBuildInput,
  fallbackNow: string,
): SummarySegmentRecord[] {
  return input.smallSummaries
    .filter(summary => ['ready', 'hidden-active', 'absorbed'].includes(summary.status))
    .map(summary => {
      const overview = summary.mainEvent?.trim() || `${summary.location?.trim() || '未知地点'}的阶段记录`;
      const characters = uniqueStrings([
        ...(summary.presentCharacters ?? []),
        ...(summary.interactingCharacters ?? []),
        ...(summary.characterLocations ?? []).map(item => item.name),
      ]);
      const keywords = uniqueStrings([
        summary.location,
        ...characters,
        ...textKeywords(overview),
      ]);
      const hashInput = {
        chatId: input.chatId,
        id: summary.id,
        floorRange: summary.floorRange,
        storyTime: summary.storyTime,
        location: summary.location,
        overview,
        characters,
      };
      const timestamp = validDate(summary.generatedAt, fallbackNow);
      return {
        id: memoryId('small', [input.chatId, summary.id, summary.floorRange]),
        kind: 'summary',
        summaryKind: 'small',
        segmentType: 'small',
        createdAt: timestamp,
        updatedAt: timestamp,
        floorStart: summary.floorRange.start,
        floorEnd: summary.floorRange.end,
        sourceHash: sourceHash(hashInput),
        storyTime: summary.storyTime,
        location: summary.location,
        characters,
        keywords,
        overview,
        payload: {
          sourceId: summary.id,
          status: summary.status,
          characterLocations: summary.characterLocations ?? [],
        },
      } satisfies SummarySegmentRecord;
    });
}

function orderedCharacterMemories(memory: SourceCharacterMemory): SourceOrderedMemory[] {
  if (memory.orderedNewMemories && memory.orderedNewMemories.length > 0) {
    const coreEmbedding = new Map<string, number[]>();
    for (const item of memory.coreMemories ?? []) {
      if (typeof item !== 'string' && item.embedding) coreEmbedding.set(item.text, item.embedding);
    }
    return memory.orderedNewMemories.map(item => ({
      ...item,
      embedding: item.embedding ?? (item.isCore ? coreEmbedding.get(item.text) : undefined),
    }));
  }
  const core = (memory.coreMemories ?? []).map(item =>
    typeof item === 'string'
      ? { text: item, isCore: true }
      : { text: item.text, isCore: true, time: item.time, embedding: item.embedding },
  );
  const recent = (memory.recentMemories ?? []).map(text => ({ text, isCore: false }));
  return [...core, ...recent];
}

export function buildMemoryWarehouseDataset(input: MemoryWarehouseDatasetBuildInput): MemoryWarehouseDataset {
  const fallbackNow = input.now ?? new Date().toISOString();
  const summaries = buildSmallSummaryRecords(input, fallbackNow);
  const bundles: MemoryBundleRecord[] = [];
  const characterMemories: CharacterMemorySegmentRecord[] = [];
  const vectors: VectorIndexRecord[] = [];
  let previousFloor = -1;

  for (const summary of [...input.grandSummaries].sort((left, right) => left.version - right.version)) {
    if (summary.isFailed) continue;
    const range = grandSummaryRange(summary, previousFloor);
    previousFloor = Math.max(previousFloor, range.floorEnd);
    const timestamp = validDate(summary.generatedAt, fallbackNow);
    const sourceMessages = [...(summary.sourceMessages ?? [])]
      .filter(message => Number.isFinite(message.messageId) && !!message.contentHash?.trim())
      .sort((left, right) => left.messageId - right.messageId)
      .filter((message, index, all) => index === 0 || message.messageId !== all[index - 1].messageId)
      .map(message => ({
        messageId: message.messageId,
        contentHash: message.contentHash.trim(),
        ...(message.role ? { role: message.role } : {}),
        ...(Number.isInteger(message.swipeId) ? { swipeId: message.swipeId } : {}),
        ...(message.metadataHash?.trim() ? { metadataHash: message.metadataHash.trim() } : {}),
        ...(message.sceneId?.trim() ? { sceneId: message.sceneId.trim() } : {}),
        ...(message.traceId?.trim() ? { traceId: message.traceId.trim() } : {}),
      }));
    const bundleSourceHash = sourceMessages.length > 0
      ? sourceHash({ chatId: input.chatId, sourceMessages })
      : sourceHash({
          chatId: input.chatId,
          version: summary.version,
          range,
          coveredMessageIds: summary.coveredMessageIds,
          rawText: summary.rawText,
          timeline: (summary.timeline ?? []).map(event => ({ ...event, embedding: undefined })),
          characterMemories: summary.characterMemories,
        });
    const bundleId = memoryId('bundle', [input.chatId, summary.version, range, bundleSourceHash]);
    const tableCharacters = uniqueStrings((summary.characterTable ?? []).map(item => item.name));
    const overviewText = (summary.rawText ?? '').split(/---SECTION---/i)[0]?.trim()
      || (summary.timeline ?? []).map(event => event.event).filter(Boolean).join('；')
      || `大总结版本 ${summary.version}`;
    const overviewRecord: SummarySegmentRecord = {
      id: memoryId('grand', [input.chatId, summary.version, 'overview']),
      kind: 'summary',
      bundleId,
      summaryKind: 'grand',
      segmentType: 'grand_overview',
      summaryVersion: summary.version,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...range,
      sourceHash: sourceHash({
        chatId: input.chatId,
        version: summary.version,
        range,
        rawText: summary.rawText,
        characterTable: summary.characterTable,
      }),
      characters: tableCharacters,
      keywords: uniqueStrings([...tableCharacters, ...textKeywords(overviewText)]),
      overview: overviewText.slice(0, 500),
      detail: overviewText,
      payload: {
        characterTable: summary.characterTable ?? [],
        ...(input.includeGrandSummaryProjection ? { grandSummaryProjection: summary } : {}),
      },
    };
    summaries.push(overviewRecord);
    const summarySegmentIds = [overviewRecord.id];
    const characterMemoryIds: string[] = [];
    const vectorIndexIds: string[] = [];
    const bundleCharacters = new Set(tableCharacters);
    const bundleKeywords = new Set(overviewRecord.keywords);

    const smallSummaryIds = summaries
      .filter(record => (
        record.summaryKind === 'small'
        && record.floorEnd >= range.floorStart
        && record.floorEnd <= range.floorEnd
      ))
      .map(record => {
        record.bundleId = bundleId;
        for (const character of record.characters) bundleCharacters.add(character);
        for (const keyword of record.keywords) bundleKeywords.add(keyword);
        return record.id;
      });

    for (const [eventIndex, event] of (summary.timeline ?? []).entries()) {
      if (!event.event?.trim()) continue;
      const characters = uniqueStrings(event.triggers?.characters ?? []);
      const keywords = uniqueStrings([
        ...(event.triggers?.keywords ?? []),
        ...characters,
        ...textKeywords(event.event),
      ]);
      const eventRecord: SummarySegmentRecord = {
        id: memoryId('event', [input.chatId, summary.version, eventIndex, event.event, event.time]),
        kind: 'summary',
        bundleId,
        summaryKind: 'grand',
        segmentType: 'timeline_event',
        summaryVersion: summary.version,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...range,
        sourceHash: sourceHash({ version: summary.version, eventIndex, event: { ...event, embedding: undefined } }),
        storyTime: event.time,
        characters,
        keywords,
        overview: event.event.trim(),
        detail: event.detail?.trim(),
        payload: {
          importance: event.importance,
          triggers: event.triggers ?? {},
        },
      };
      summaries.push(eventRecord);
      summarySegmentIds.push(eventRecord.id);
      for (const character of characters) bundleCharacters.add(character);
      for (const keyword of keywords) bundleKeywords.add(keyword);
      if (event.embedding) {
        const vectorRecord = makeVectorRecord(eventRecord, event.embedding, input.embedding);
        if (vectorRecord) {
          vectors.push(vectorRecord);
          vectorIndexIds.push(vectorRecord.id);
        }
      }
    }

    for (const memory of summary.characterMemories ?? []) {
      const characterName = memory.characterName.trim();
      if (!characterName) continue;
      const aliases = uniqueStrings(memory.aliases ?? []).filter(alias => normalizeName(alias) !== normalizeName(characterName));
      const keywords = uniqueStrings([characterName, ...aliases, ...(memory.keywords ?? [])]);
      for (const [itemIndex, item] of orderedCharacterMemories(memory).entries()) {
        const text = item.text.trim();
        if (!text) continue;
        const itemFloor = Number.isFinite(item.floor) ? Number(item.floor) : undefined;
        const recordRange = itemFloor === undefined
          ? range
          : { floorStart: itemFloor, floorEnd: itemFloor };
        const record: CharacterMemorySegmentRecord = {
          id: item.id?.trim() || memoryId('char', [input.chatId, summary.version, characterName, itemIndex, text]),
          kind: 'character_memory',
          bundleId,
          createdAt: timestamp,
          updatedAt: timestamp,
          ...recordRange,
          sourceHash: sourceHash({ summaryVersion: summary.version, characterName, item, range: recordRange }),
          characterName,
          aliases,
          memoryType: item.isCore ? 'core' : 'recent',
          text,
          storyTime: item.time,
          keywords,
          summaryVersion: summary.version,
        };
        characterMemories.push(record);
        characterMemoryIds.push(record.id);
        bundleCharacters.add(characterName);
        for (const alias of aliases) bundleCharacters.add(alias);
        for (const keyword of keywords) bundleKeywords.add(keyword);
        if (item.embedding) {
          const vectorRecord = makeVectorRecord(record, item.embedding, input.embedding);
          if (vectorRecord) {
            vectors.push(vectorRecord);
            vectorIndexIds.push(vectorRecord.id);
          }
        }
      }
    }

    bundles.push({
      id: bundleId,
      kind: 'memory_bundle',
      bundleType: input.bundleType ?? 'derived_rebuild',
      status: 'committed',
      summaryVersion: summary.version,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...range,
      sourceHash: bundleSourceHash,
      sourceMessages,
      smallSummaryIds,
      summarySegmentIds,
      characterMemoryIds,
      vectorIndexIds,
      characters: [...bundleCharacters],
      keywords: [...bundleKeywords],
      committedAt: timestamp,
    });
  }

  return { bundles, summaries, characterMemories, vectors, checkpoints: [] };
}

function chunkRecords<T extends MemoryWarehouseRecord>(records: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error('每分片记录数必须是正整数');
  const chunks: T[][] = [];
  for (let offset = 0; offset < records.length; offset += size) {
    chunks.push(records.slice(offset, offset + size));
  }
  return chunks;
}

function recordFloor(record: MemoryWarehouseRecord, key: 'floorStart' | 'floorEnd'): number {
  if (key === 'floorStart') {
    return 'floorStart' in record && typeof record.floorStart === 'number' ? record.floorStart : -1;
  }
  return 'floorEnd' in record && typeof record.floorEnd === 'number' ? record.floorEnd : -1;
}

function makeShardId(prefix: string, records: MemoryWarehouseRecord[], index: number): string {
  const starts = records.map(record => recordFloor(record, 'floorStart')).filter(floor => floor >= 0);
  const ends = records.map(record => recordFloor(record, 'floorEnd')).filter(floor => floor >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : 0;
  const end = ends.length > 0 ? Math.max(...ends) : 0;
  return `${prefix}-${String(start).padStart(6, '0')}-${String(end).padStart(6, '0')}-${String(index + 1).padStart(4, '0')}-${stableTextId('set', records.map(record => record.id).join('|')).slice(4)}`;
}

export function planMemoryWarehouseDataset(
  dataset: MemoryWarehouseDataset,
  options: MemoryWarehouseShardPlanOptions = {},
): ReplaceMemoryCollectionInput[] {
  const bundleSize = options.bundleRecordsPerShard ?? 50;
  const summarySize = options.summaryRecordsPerShard ?? 100;
  const characterSize = options.characterRecordsPerShard ?? 100;
  const vectorSize = options.vectorRecordsPerShard ?? 200;
  const checkpointSize = options.checkpointRecordsPerShard ?? 20;
  const bundleShards = chunkRecords(dataset.bundles, bundleSize).map((records, index) => ({
    shardId: makeShardId('bundle', records, index),
    records,
  }));
  const summaryShards = chunkRecords(dataset.summaries, summarySize).map((records, index) => ({
    shardId: makeShardId('summary', records, index),
    records,
  }));

  const characterGroups = new Map<string, CharacterMemorySegmentRecord[]>();
  for (const record of dataset.characterMemories) {
    const key = normalizeName(record.characterName);
    const group = characterGroups.get(key) ?? [];
    group.push(record);
    characterGroups.set(key, group);
  }
  const characterShards: ReplaceMemoryCollectionInput['shards'] = [];
  for (const [characterName, records] of [...characterGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const prefix = `character-${stableTextId('name', characterName).slice(5)}`;
    characterShards.push(...chunkRecords(records, characterSize).map((chunk, index) => ({
      shardId: makeShardId(prefix, chunk, index),
      records: chunk,
    })));
  }

  const vectorGroups = new Map<string, VectorIndexRecord[]>();
  for (const record of dataset.vectors) {
    const key = `${record.provider}|${record.model}|${record.dimensions}|${record.indexVersion}`;
    const group = vectorGroups.get(key) ?? [];
    group.push(record);
    vectorGroups.set(key, group);
  }
  const vectorShards: ReplaceMemoryCollectionInput['shards'] = [];
  for (const [identity, records] of [...vectorGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const prefix = `vector-${stableTextId('model', identity).slice(6)}`;
    vectorShards.push(...chunkRecords(records, vectorSize).map((chunk, index) => ({
      shardId: makeShardId(prefix, chunk, index),
      records: chunk,
    })));
  }

  const checkpointShards = chunkRecords(dataset.checkpoints, checkpointSize).map((records, index) => ({
    shardId: makeShardId('checkpoint', records, index),
    records,
  }));

  return [
    { collection: 'memory_bundles', shards: bundleShards },
    { collection: 'summary_segments', shards: summaryShards },
    { collection: 'character_memory_segments', shards: characterShards },
    { collection: 'vector_indexes', shards: vectorShards },
    { collection: 'checkpoints', shards: checkpointShards },
  ];
}

export class MemoryWarehouseRepository {
  constructor(private readonly warehouse: MemoryWarehouse) {}

  async replaceDataset(
    dataset: MemoryWarehouseDataset,
    options?: MemoryWarehouseShardPlanOptions,
  ): Promise<MemoryWarehouseDatasetCommitResult> {
    const plans = planMemoryWarehouseDataset(dataset, options);
    const committedCollections = await this.warehouse.replaceCollections(plans);
    const results = new Map(committedCollections.map(result => [result.collection, result.shards.length]));
    return {
      bundleShards: results.get('memory_bundles') ?? 0,
      summaryShards: results.get('summary_segments') ?? 0,
      characterMemoryShards: results.get('character_memory_segments') ?? 0,
      vectorShards: results.get('vector_indexes') ?? 0,
      checkpointShards: results.get('checkpoints') ?? 0,
      bundleRecords: dataset.bundles.length,
      summaryRecords: dataset.summaries.length,
      characterMemoryRecords: dataset.characterMemories.length,
      vectorRecords: dataset.vectors.length,
      checkpointRecords: dataset.checkpoints.length,
    };
  }

  async commitBundle(input: MemoryBundleCommitInput): Promise<MemoryBundleCommitResult> {
    const { bundle, summaries, characterMemories, vectors, checkpoint } = input;
    if (bundle.kind !== 'memory_bundle' || !['staged', 'committed'].includes(bundle.status)) {
      throw new Error('只有 staged 或 committed MemoryBundle 可以写入记忆仓');
    }
    const summaryIds = summaries.map(record => record.id);
    const expectedSummaryIds = [...bundle.smallSummaryIds, ...bundle.summarySegmentIds];
    if (!sameIds(summaryIds, expectedSummaryIds)) {
      throw new Error('MemoryBundle 的总结段 ID 与提交内容不一致');
    }
    if (!sameIds(characterMemories.map(record => record.id), bundle.characterMemoryIds)) {
      throw new Error('MemoryBundle 的角色记忆 ID 与提交内容不一致');
    }
    if (!sameIds(vectors.map(record => record.id), bundle.vectorIndexIds)) {
      throw new Error('MemoryBundle 的向量索引 ID 与提交内容不一致');
    }
    const mismatched = [...summaries, ...characterMemories, ...vectors]
      .find(record => record.bundleId !== bundle.id);
    if (mismatched) {
      throw new Error(`记录 ${mismatched.id} 未绑定到 MemoryBundle ${bundle.id}`);
    }
    if (checkpoint?.lastCommittedBundleId && checkpoint.lastCommittedBundleId !== bundle.id) {
      throw new Error('Checkpoint 的 lastCommittedBundleId 与本次 MemoryBundle 不一致');
    }

    const suffix = bundleShardSuffix(bundle.id);
    const bundleShardRecords = new Map<string, MemoryBundleRecord[]>();
    const replacementIds = new Set(
      (input.replaceBundleIds ?? []).map(id => id.trim()).filter(id => id && id !== bundle.id),
    );
    if (replacementIds.size > 0) {
      if (bundle.status !== 'committed') throw new Error('只有 committed Bundle 可以原子替换旧记忆');
      const manifest = await this.warehouse.loadManifest();
      const now = new Date().toISOString();
      for (const descriptor of manifest.collections.memory_bundles.shards) {
        if (!descriptor.recordIds.some(id => replacementIds.has(id))) continue;
        const payload = await this.warehouse.readShard('memory_bundles', descriptor.shardId);
        bundleShardRecords.set(
          descriptor.shardId,
          payload.records.map(record => {
            if (record.kind !== 'memory_bundle' || !replacementIds.has(record.id) || record.status !== 'committed') {
              return record as MemoryBundleRecord;
            }
            return {
              ...record,
              status: 'invalidated' as const,
              invalidatedAt: now,
              invalidationReason: 'manual_rebuild' as const,
              updatedAt: now,
            };
          }),
        );
      }
    }
    const newBundleShardId = `bundle-${suffix}`;
    const sameShard = bundleShardRecords.get(newBundleShardId) ?? [];
    bundleShardRecords.set(newBundleShardId, [
      ...sameShard.filter(record => record.id !== bundle.id),
      bundle,
    ]);
    const shards = [
      ...[...bundleShardRecords.entries()].map(([shardId, records]) => ({
        collection: 'memory_bundles' as const,
        shardId,
        records,
      })),
      ...(summaries.length > 0
        ? [{ collection: 'summary_segments' as const, shardId: `summary-${suffix}`, records: summaries }]
        : []),
      ...(characterMemories.length > 0
        ? [{ collection: 'character_memory_segments' as const, shardId: `character-${suffix}`, records: characterMemories }]
        : []),
      ...(vectors.length > 0
        ? [{ collection: 'vector_indexes' as const, shardId: `vector-${suffix}`, records: vectors }]
        : []),
      ...(checkpoint
        ? [{ collection: 'checkpoints' as const, shardId: checkpointShardId(checkpoint.taskType), records: [checkpoint] }]
        : []),
    ];
    const committed = await this.warehouse.upsertShards(shards);
    return {
      bundleId: bundle.id,
      shardCount: committed.length,
      summaryRecords: summaries.length,
      characterMemoryRecords: characterMemories.length,
      vectorRecords: vectors.length,
      checkpointCommitted: !!checkpoint,
    };
  }

  async getBundle(bundleId: string): Promise<MemoryBundleRecord | null> {
    const id = bundleId.trim();
    if (!id) return null;
    const result = await this.warehouse.query({
      collections: ['memory_bundles'],
      ids: [id],
      kinds: ['memory_bundle'],
      limit: 1,
    });
    const record = result.records[0];
    return record?.kind === 'memory_bundle' ? record : null;
  }

  async listBundles(query: Omit<MemoryWarehouseQuery, 'collections' | 'kinds'> = {}): Promise<MemoryBundleRecord[]> {
    const result = await this.warehouse.query({
      ...query,
      collections: ['memory_bundles'],
      kinds: ['memory_bundle'],
    });
    return result.records.filter((record): record is MemoryBundleRecord => record.kind === 'memory_bundle');
  }

  async invalidateBundlesFromFloor(
    floor: number,
    reason: NonNullable<MemoryBundleRecord['invalidationReason']>,
  ): Promise<number> {
    const normalizedFloor = Math.max(0, Math.floor(floor));
    const affected = (await this.listBundles({
      floorStart: normalizedFloor,
      order: 'floor_asc',
      limit: Number.MAX_SAFE_INTEGER,
    })).filter(bundle => bundle.status === 'committed' && bundle.floorEnd >= normalizedFloor);
    if (affected.length === 0) return 0;

    const manifest = await this.warehouse.loadManifest();
    const descriptors = manifest.collections.memory_bundles.shards;
    const affectedByShard = new Map<string, Set<string>>();
    for (const bundle of affected) {
      const descriptor = descriptors.find(shard => shard.recordIds.includes(bundle.id));
      if (!descriptor) throw new Error(`MemoryBundle ${bundle.id} 缺少所属分片`);
      const ids = affectedByShard.get(descriptor.shardId) ?? new Set<string>();
      ids.add(bundle.id);
      affectedByShard.set(descriptor.shardId, ids);
    }

    const now = new Date().toISOString();
    const shards = [];
    for (const [shardId, bundleIds] of affectedByShard) {
      const payload = await this.warehouse.readShard('memory_bundles', shardId);
      shards.push({
        collection: 'memory_bundles' as const,
        shardId,
        records: payload.records.map(record => {
          if (record.kind !== 'memory_bundle' || !bundleIds.has(record.id)) return record;
          return {
            ...record,
            status: 'invalidated' as const,
            updatedAt: now,
            invalidatedAt: now,
            invalidationReason: reason,
          };
        }),
      });
    }
    await this.warehouse.upsertShards(shards);
    return affected.length;
  }

  async activateStagedBundles(
    transactionId: string,
    readyCheckpoint: MemoryCheckpointRecord,
  ): Promise<{ activatedBundleIds: string[]; invalidatedBundleIds: string[] }> {
    const normalizedTransactionId = transactionId.trim();
    if (!normalizedTransactionId) throw new Error('批量重建事务 ID 不能为空');
    if (readyCheckpoint.status !== 'ready' || readyCheckpoint.transactionId !== normalizedTransactionId) {
      throw new Error('原子激活需要同一事务的 ready Checkpoint');
    }

    const bundles = await this.listBundles({ order: 'floor_asc', limit: Number.MAX_SAFE_INTEGER });
    const staged = bundles.filter(bundle => (
      bundle.status === 'staged' && bundle.rebuildTransactionId === normalizedTransactionId
    ));
    if (staged.length === 0) throw new Error(`批量重建事务 ${normalizedTransactionId} 没有 staged bundle`);
    const floorStart = Math.min(...staged.map(bundle => bundle.floorStart));
    const floorEnd = Math.max(...staged.map(bundle => bundle.floorEnd));
    const stagedIds = new Set(staged.map(bundle => bundle.id));
    const obsolete = bundles.filter(bundle => (
      bundle.status === 'committed'
      && !stagedIds.has(bundle.id)
      && bundle.floorEnd >= floorStart
      && bundle.floorStart <= floorEnd
    ));
    const obsoleteIds = new Set(obsolete.map(bundle => bundle.id));
    const affectedIds = new Set([...stagedIds, ...obsoleteIds]);

    const manifest = await this.warehouse.loadManifest();
    const now = new Date().toISOString();
    const shards = [];
    for (const descriptor of manifest.collections.memory_bundles.shards) {
      if (!descriptor.recordIds.some(id => affectedIds.has(id))) continue;
      const payload = await this.warehouse.readShard('memory_bundles', descriptor.shardId);
      shards.push({
        collection: 'memory_bundles' as const,
        shardId: descriptor.shardId,
        records: payload.records.map(record => {
          if (record.kind !== 'memory_bundle') return record;
          if (stagedIds.has(record.id)) {
            return {
              ...record,
              status: 'committed' as const,
              updatedAt: now,
              committedAt: now,
              invalidatedAt: undefined,
              invalidationReason: undefined,
            };
          }
          if (obsoleteIds.has(record.id)) {
            return {
              ...record,
              status: 'invalidated' as const,
              updatedAt: now,
              invalidatedAt: now,
              invalidationReason: 'manual_rebuild' as const,
            };
          }
          return record;
        }),
      });
    }
    shards.push({
      collection: 'checkpoints' as const,
      shardId: checkpointShardId(readyCheckpoint.taskType),
      records: [{ ...readyCheckpoint, updatedAt: now }],
    });
    await this.warehouse.upsertShards(shards);
    return {
      activatedBundleIds: [...stagedIds],
      invalidatedBundleIds: [...obsoleteIds],
    };
  }

  async invalidateStagedBundles(transactionId: string, error: string): Promise<number> {
    const normalizedTransactionId = transactionId.trim();
    if (!normalizedTransactionId) return 0;
    const staged = (await this.listBundles({ order: 'floor_asc', limit: Number.MAX_SAFE_INTEGER }))
      .filter(bundle => bundle.status === 'staged' && bundle.rebuildTransactionId === normalizedTransactionId);
    if (staged.length === 0) return 0;
    const stagedIds = new Set(staged.map(bundle => bundle.id));
    const manifest = await this.warehouse.loadManifest();
    const now = new Date().toISOString();
    const shards = [];
    for (const descriptor of manifest.collections.memory_bundles.shards) {
      if (!descriptor.recordIds.some(id => stagedIds.has(id))) continue;
      const payload = await this.warehouse.readShard('memory_bundles', descriptor.shardId);
      shards.push({
        collection: 'memory_bundles' as const,
        shardId: descriptor.shardId,
        records: payload.records.map(record => (
          record.kind === 'memory_bundle' && stagedIds.has(record.id)
            ? {
                ...record,
                status: 'invalidated' as const,
                updatedAt: now,
                invalidatedAt: now,
                invalidationReason: 'manual_rebuild' as const,
              }
            : record
        )),
      });
    }
    const checkpoint = await this.getCheckpoint('full_rebuild');
    if (checkpoint?.transactionId === normalizedTransactionId) {
      shards.push({
        collection: 'checkpoints' as const,
        shardId: checkpointShardId(checkpoint.taskType),
        records: [{ ...checkpoint, status: 'failed' as const, error, updatedAt: now }],
      });
    }
    await this.warehouse.upsertShards(shards);
    return staged.length;
  }

  async listGrandSummaryProjections(
    transactionId: string,
  ): Promise<Array<SourceGrandSummary & { memoryBundleId?: string; rebuildTransactionId?: string }>> {
    const bundles = (await this.listBundles({ order: 'floor_asc', limit: Number.MAX_SAFE_INTEGER }))
      .filter(bundle => bundle.rebuildTransactionId === transactionId && bundle.status !== 'invalidated')
      .sort((left, right) => (left.summaryVersion ?? 0) - (right.summaryVersion ?? 0));
    const overviewIds = bundles.flatMap(bundle => bundle.summarySegmentIds.slice(0, 1));
    if (overviewIds.length === 0) return [];
    const query = await this.warehouse.query({
      collections: ['summary_segments'],
      ids: overviewIds,
      kinds: ['summary'],
      limit: overviewIds.length,
    });
    const byId = new Map(query.records
      .filter((record): record is SummarySegmentRecord => record.kind === 'summary')
      .map(record => [record.id, record]));
    const result: Array<SourceGrandSummary & { memoryBundleId?: string; rebuildTransactionId?: string }> = [];
    for (const bundle of bundles) {
      const overview = byId.get(bundle.summarySegmentIds[0]);
      const projection = overview?.payload?.grandSummaryProjection;
      if (!projection || typeof projection !== 'object' || Array.isArray(projection)) continue;
      const summary = projection as unknown as SourceGrandSummary;
      if (!Number.isFinite(summary.version) || typeof summary.generatedAt !== 'string') continue;
      result.push({ ...summary, memoryBundleId: bundle.id, rebuildTransactionId: transactionId });
    }
    return result;
  }

  async recallCharacterMemories(input: CharacterMemoryRecallQuery): Promise<CharacterMemoryRecallResult> {
    const characterName = input.characterName.trim();
    if (!characterName) return { recent: [], recalled: [] };
    const recentBundleCount = Math.max(0, Math.floor(input.recentBundleCount ?? 2));
    const recallLimit = Math.max(1, Math.floor(input.recallLimit ?? 10));

    const matchingBundles = (await this.listBundles({
      characters: [characterName],
      order: 'floor_desc',
      limit: Number.MAX_SAFE_INTEGER,
    }))
      .filter(bundle => bundle.status === 'committed')
      .sort((left, right) => (
        (right.summaryVersion ?? -1) - (left.summaryVersion ?? -1)
        || right.floorEnd - left.floorEnd
      ));
    const recentBundles = matchingBundles.slice(0, recentBundleCount);
    const recentBundleIds = new Set(recentBundles.map(bundle => bundle.id));
    const recentMemoryIds = uniqueStrings(recentBundles.flatMap(bundle => bundle.characterMemoryIds));
    let recent: CharacterMemorySegmentRecord[] = [];
    if (recentMemoryIds.length > 0) {
      const recentQuery = await this.warehouse.query({
        collections: ['character_memory_segments'],
        ids: recentMemoryIds,
        kinds: ['character_memory'],
        order: 'floor_asc',
        limit: recentMemoryIds.length,
      });
      const normalizedCharacter = normalizeName(characterName);
      recent = recentQuery.records
        .filter((record): record is CharacterMemorySegmentRecord => (
          record.kind === 'character_memory'
          && record.bundleId !== undefined
          && recentBundleIds.has(record.bundleId)
          && (
            normalizeName(record.characterName) === normalizedCharacter
            || record.aliases.some(alias => normalizeName(alias) === normalizedCharacter)
          )
        ))
        .sort((left, right) => left.floorEnd - right.floorEnd || left.createdAt.localeCompare(right.createdAt));
    }

    const recall = await this.recall({
      queryText: input.queryText,
      queryVector: input.queryVector,
      embedding: input.embedding,
      characters: [characterName],
      recordKinds: ['character_memory'],
      limit: recallLimit + recentMemoryIds.length,
      candidateMultiplier: input.candidateMultiplier,
      hybridWeight: input.hybridWeight,
      minScore: input.minScore,
    });
    const recalled = recall.items
      .filter(item => (
        item.record.kind === 'character_memory'
        && (!item.record.bundleId || !recentBundleIds.has(item.record.bundleId))
      ))
      .slice(0, recallLimit);
    return { recent, recalled };
  }

  async recallTimelineEvents(input: TimelineEventRecallQuery): Promise<TimelineEventRecallResult> {
    const recentBundleCount = Math.max(0, Math.floor(input.recentBundleCount ?? 2));
    const recallLimit = Math.max(1, Math.floor(input.recallLimit ?? 10));
    const committedBundles = (await this.listBundles({
      order: 'floor_desc',
      limit: Number.MAX_SAFE_INTEGER,
    }))
      .filter(bundle => bundle.status === 'committed')
      .sort((left, right) => (
        (right.summaryVersion ?? -1) - (left.summaryVersion ?? -1)
        || right.floorEnd - left.floorEnd
      ));
    const recentBundles = committedBundles.slice(0, recentBundleCount);
    const recentBundleIds = new Set(recentBundles.map(bundle => bundle.id));
    const recentEventIds = uniqueStrings(recentBundles.flatMap(bundle => bundle.summarySegmentIds));
    let recent: SummarySegmentRecord[] = [];
    if (recentEventIds.length > 0) {
      const recentQuery = await this.warehouse.query({
        collections: ['summary_segments'],
        ids: recentEventIds,
        kinds: ['summary'],
        order: 'floor_asc',
        limit: recentEventIds.length,
      });
      recent = recentQuery.records
        .filter((record): record is SummarySegmentRecord => (
          record.kind === 'summary'
          && record.segmentType === 'timeline_event'
          && !!record.bundleId
          && recentBundleIds.has(record.bundleId)
        ))
        .sort((left, right) => left.floorEnd - right.floorEnd || left.createdAt.localeCompare(right.createdAt));
    }
    const recall = await this.recall({
      queryText: input.queryText,
      queryVector: input.queryVector,
      embedding: input.embedding,
      recordKinds: ['summary'],
      summarySegmentTypes: ['timeline_event'],
      limit: recallLimit + recentEventIds.length,
      candidateMultiplier: input.candidateMultiplier,
      hybridWeight: input.hybridWeight,
      minScore: input.minScore,
    });
    const recalled = recall.items
      .filter(item => (
        item.record.kind === 'summary'
        && item.record.segmentType === 'timeline_event'
        && (!item.record.bundleId || !recentBundleIds.has(item.record.bundleId))
      ))
      .slice(0, recallLimit);
    return { recent, recalled };
  }

  async saveCheckpoint(checkpoint: MemoryCheckpointRecord): Promise<void> {
    const shardId = checkpointShardId(checkpoint.taskType);
    await this.warehouse.writeShard({
      collection: 'checkpoints',
      shardId,
      records: [checkpoint],
    });
  }

  async getCheckpoint(taskType: MemoryCheckpointRecord['taskType']): Promise<MemoryCheckpointRecord | null> {
    const id = memoryId('checkpoint', [taskType]);
    const byId = await this.warehouse.query({
      collections: ['checkpoints'],
      ids: [id],
      kinds: ['checkpoint'],
      limit: 1,
    });
    const direct = byId.records[0];
    if (direct?.kind === 'checkpoint') return direct;

    // 允许调用方使用自定义 ID；同一 taskType 仍只取更新时间最新的一条。
    const fallback = await this.warehouse.query({
      collections: ['checkpoints'],
      kinds: ['checkpoint'],
      order: 'updated_desc',
      limit: 100,
    });
    return fallback.records.find(
      (record): record is MemoryCheckpointRecord => record.kind === 'checkpoint' && record.taskType === taskType,
    ) ?? null;
  }

  async deleteCheckpoint(taskType: MemoryCheckpointRecord['taskType']): Promise<boolean> {
    const shardId = checkpointShardId(taskType);
    return this.warehouse.deleteShard('checkpoints', shardId);
  }

  async recall(input: MemoryRecallQuery): Promise<MemoryRecallResult> {
    const limit = Math.max(1, Math.floor(input.limit ?? 10));
    const candidateMultiplier = Math.max(1, Math.floor(input.candidateMultiplier ?? 4));
    const candidateLimit = limit * candidateMultiplier;
    const hybridWeight = Math.min(1, Math.max(0, input.hybridWeight ?? 0.7));
    const minScore = Math.min(1, Math.max(0, input.minScore ?? 0));
    const requestedKinds = input.recordKinds?.length
      ? [...new Set(input.recordKinds)]
      : ['summary', 'character_memory'] as Array<RecallableMemoryRecord['kind']>;
    const requestedCollections = requestedKinds.map(kind =>
      kind === 'summary' ? 'summary_segments' as const : 'character_memory_segments' as const,
    );
    if (input.queryVector && !input.embedding) {
      throw new Error('向量召回必须提供 Embedding 模型身份');
    }
    if (input.queryVector && input.embedding && input.queryVector.length !== input.embedding.dimensions) {
      throw new Error(
        `查询向量维度不正确：模型需要 ${input.embedding.dimensions}，实际 ${input.queryVector.length}`,
      );
    }

    const baseQuery: MemoryWarehouseQuery = {
      characters: input.characters,
      keywords: input.keywords,
      floorStart: input.floorStart,
      floorEnd: input.floorEnd,
      storyTime: input.storyTime,
    };
    let loadedShardCount = 0;
    let invalidVectorCount = 0;
    const denseScores = new Map<string, number>();

    if (input.queryVector && input.embedding) {
      const vectorQuery = await this.warehouse.query({
        ...baseQuery,
        collections: ['vector_indexes'],
        kinds: ['vector_index'],
        limit: 100_000,
      });
      loadedShardCount += vectorQuery.loadedShardCount;
      for (const record of vectorQuery.records) {
        if (
          record.kind !== 'vector_index'
          || record.provider !== input.embedding.provider
          || record.model !== input.embedding.model
          || record.dimensions !== input.embedding.dimensions
          || record.indexVersion !== input.embedding.indexVersion
        ) {
          continue;
        }
        try {
          const vector = decodeFloat32Vector(record.vector, record.dimensions);
          denseScores.set(record.memoryId, Math.max(0, cosineSimilarity(input.queryVector, vector)));
        } catch (error) {
          invalidVectorCount += 1;
          console.warn('[智脑记忆仓] 跳过无法解码的可重建向量索引', { memoryId: record.memoryId, error });
        }
      }
    }

    const denseMemoryIds = [...denseScores.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, candidateLimit)
      .map(([memoryId]) => memoryId);
    const lexicalQuery = await this.warehouse.query({
      ...baseQuery,
      collections: requestedCollections,
      kinds: requestedKinds,
      order: 'floor_desc',
      limit: Math.max(200, candidateLimit * 4),
    });
    loadedShardCount += lexicalQuery.loadedShardCount;

    const denseRecordQuery = denseMemoryIds.length > 0
      ? await this.warehouse.query({
          ...baseQuery,
          collections: requestedCollections,
          ids: denseMemoryIds,
          kinds: requestedKinds,
          limit: denseMemoryIds.length,
        })
      : null;
    if (denseRecordQuery) loadedShardCount += denseRecordQuery.loadedShardCount;

    const candidates = new Map<string, RecallableMemoryRecord>();
    for (const record of [...lexicalQuery.records, ...(denseRecordQuery?.records ?? [])]) {
      if (!isRecallableRecord(record)) continue;
      if (!requestedKinds.includes(record.kind)) continue;
      if (
        record.kind === 'summary'
        && input.summarySegmentTypes
        && input.summarySegmentTypes.length > 0
        && !input.summarySegmentTypes.includes(record.segmentType)
      ) {
        continue;
      }
      candidates.set(record.id, record);
    }

    const candidateBundleIds = uniqueStrings(
      [...candidates.values()].map(record => record.bundleId),
    );
    if (candidateBundleIds.length > 0) {
      const bundleQuery = await this.warehouse.query({
        collections: ['memory_bundles'],
        ids: candidateBundleIds,
        kinds: ['memory_bundle'],
        limit: candidateBundleIds.length,
      });
      loadedShardCount += bundleQuery.loadedShardCount;
      const committedBundleIds = new Set(
        bundleQuery.records
          .filter((record): record is MemoryBundleRecord => record.kind === 'memory_bundle' && record.status === 'committed')
          .map(record => record.id),
      );
      for (const [recordId, record] of candidates) {
        if (record.bundleId && !committedBundleIds.has(record.bundleId)) candidates.delete(recordId);
      }
    }

    const items = [...candidates.values()]
      .map(record => {
        const denseScore = denseScores.get(record.id) ?? 0;
        const lexicalScore = lexicalSimilarity(input.queryText, record);
        const vectorMatched = denseScores.has(record.id);
        const score = vectorMatched
          ? hybridWeight * denseScore + (1 - hybridWeight) * lexicalScore
          : lexicalScore;
        return { record, score, denseScore, lexicalScore, vectorMatched } satisfies MemoryRecallItem;
      })
      .filter(item => item.score >= minScore)
      .sort((left, right) => right.score - left.score || recallRecordFloor(right.record) - recallRecordFloor(left.record))
      .slice(0, limit);
    const activeVectorCandidateCount = [...denseScores.keys()].filter(memoryId => candidates.has(memoryId)).length;

    return {
      items,
      candidateCount: candidates.size,
      vectorCandidateCount: activeVectorCandidateCount,
      loadedShardCount,
      invalidVectorCount,
    };
  }
}
