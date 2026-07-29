import {
  MEMORY_WAREHOUSE_COLLECTIONS,
  MEMORY_WAREHOUSE_SCHEMA_VERSION,
  type MemoryWarehouseCollection,
  type MemoryWarehouseCompression,
  type MemoryWarehouseManifest,
  type MemoryWarehouseShardDescriptor,
  type MemoryWarehouseShardPayload,
} from './memoryWarehouseTypes';

export interface EncodedMemoryPayload {
  compression: MemoryWarehouseCompression;
  encoded: string;
  checksum: string;
  encodedByteLength: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const blockSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    const block = bytes.subarray(offset, Math.min(offset + blockSize, bytes.length));
    for (const byte of block) binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== 'function') return null;
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const stream = new Blob([input.buffer]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前浏览器不支持 gzip 解压，无法读取该记忆分片');
  }
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const stream = new Blob([input.buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** FNV-1a 仅用于传输完整性校验，不作为安全哈希。 */
export function checksumText(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

export function stableTextId(prefix: string, value: string): string {
  return `${prefix}-${checksumText(value).slice('fnv1a32:'.length)}`;
}

export function splitEncodedPayload(value: string, chunkCharacterLimit: number): string[] {
  if (!Number.isInteger(chunkCharacterLimit) || chunkCharacterLimit < 1024) {
    throw new Error('记忆分片字符上限必须是不小于 1024 的整数');
  }
  if (value.length === 0) return [''];
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += chunkCharacterLimit) {
    chunks.push(value.slice(offset, offset + chunkCharacterLimit));
  }
  return chunks;
}

export async function encodeMemoryPayload(value: unknown): Promise<EncodedMemoryPayload> {
  const json = JSON.stringify(value);
  const plainBytes = new TextEncoder().encode(json);
  const plainBase64 = bytesToBase64(plainBytes);
  const compressedBytes = await gzip(plainBytes);
  const compressedBase64 = compressedBytes ? bytesToBase64(compressedBytes) : null;
  const useGzip = compressedBase64 !== null && compressedBase64.length < plainBase64.length;
  const encoded = useGzip ? compressedBase64 : plainBase64;
  return {
    compression: useGzip ? 'gzip-base64' : 'utf8-base64',
    encoded,
    checksum: checksumText(encoded),
    encodedByteLength: byteLength(encoded),
  };
}

export async function decodeMemoryPayload<T>(
  encoded: string,
  compression: MemoryWarehouseCompression,
  expectedChecksum?: string,
): Promise<T> {
  if (expectedChecksum && checksumText(encoded) !== expectedChecksum) {
    throw new Error('记忆分片校验和不一致');
  }
  const storedBytes = base64ToBytes(encoded);
  const jsonBytes = compression === 'gzip-base64' ? await gunzip(storedBytes) : storedBytes;
  return JSON.parse(new TextDecoder().decode(jsonBytes)) as T;
}

export function encodeFloat32Vector(vector: readonly number[]): string {
  const bytes = new Uint8Array(vector.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value, true));
  return bytesToBase64(bytes);
}

export function decodeFloat32Vector(encoded: string, dimensions: number): Float32Array {
  const bytes = base64ToBytes(encoded);
  const expectedBytes = dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(`向量字节长度不正确：需要 ${expectedBytes}，实际 ${bytes.byteLength}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    vector[index] = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
  }
  return vector;
}

function isCollection(value: unknown): value is MemoryWarehouseCollection {
  return typeof value === 'string' && (MEMORY_WAREHOUSE_COLLECTIONS as readonly string[]).includes(value);
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return null;
  return [...new Set(value)];
}

export function parseShardDescriptor(value: unknown): MemoryWarehouseShardDescriptor | null {
  if (!isRecord(value) || typeof value.shardId !== 'string' || !isCollection(value.collection)) return null;
  if (
    typeof value.generation !== 'number'
    || typeof value.createdAt !== 'string'
    || typeof value.recordCount !== 'number'
    || typeof value.compression !== 'string'
    || !['gzip-base64', 'utf8-base64'].includes(value.compression)
    || typeof value.checksum !== 'string'
    || typeof value.encodedByteLength !== 'number'
    || typeof value.chunkCount !== 'number'
  ) {
    return null;
  }
  const characters = parseStringArray(value.characters);
  const keywords = parseStringArray(value.keywords);
  const recordIds = parseStringArray(value.recordIds);
  if (!characters || !keywords || !recordIds) return null;
  const floorStart = typeof value.floorStart === 'number' ? value.floorStart : undefined;
  const floorEnd = typeof value.floorEnd === 'number' ? value.floorEnd : undefined;
  return {
    shardId: value.shardId,
    collection: value.collection,
    generation: value.generation,
    createdAt: value.createdAt,
    recordCount: value.recordCount,
    recordIds,
    ...(floorStart === undefined ? {} : { floorStart }),
    ...(floorEnd === undefined ? {} : { floorEnd }),
    characters,
    keywords,
    compression: value.compression as MemoryWarehouseCompression,
    checksum: value.checksum,
    encodedByteLength: value.encodedByteLength,
    chunkCount: value.chunkCount,
  };
}

export function parseMemoryWarehouseManifest(value: unknown): MemoryWarehouseManifest | null {
  if (
    !isRecord(value)
    || value.schemaVersion !== MEMORY_WAREHOUSE_SCHEMA_VERSION
    || typeof value.repositoryId !== 'string'
    || typeof value.chatId !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || !isRecord(value.collections)
  ) {
    return null;
  }

  const collections = {} as MemoryWarehouseManifest['collections'];
  for (const collection of MEMORY_WAREHOUSE_COLLECTIONS) {
    const rawCollection = value.collections[collection];
    if (!isRecord(rawCollection) || typeof rawCollection.revision !== 'number' || !Array.isArray(rawCollection.shards)) {
      return null;
    }
    const shards = rawCollection.shards.map(parseShardDescriptor);
    if (shards.some(shard => shard === null)) return null;
    collections[collection] = {
      revision: rawCollection.revision,
      shards: shards as MemoryWarehouseShardDescriptor[],
    };
  }

  return {
    schemaVersion: MEMORY_WAREHOUSE_SCHEMA_VERSION,
    repositoryId: value.repositoryId,
    chatId: value.chatId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.lastCommittedTransactionId === 'string'
      ? { lastCommittedTransactionId: value.lastCommittedTransactionId }
      : {}),
    collections,
  };
}

export function parseMemoryShardPayload(value: unknown): MemoryWarehouseShardPayload | null {
  if (
    !isRecord(value)
    || value.schemaVersion !== MEMORY_WAREHOUSE_SCHEMA_VERSION
    || typeof value.repositoryId !== 'string'
    || !isCollection(value.collection)
    || typeof value.shardId !== 'string'
    || typeof value.generation !== 'number'
    || typeof value.createdAt !== 'string'
    || !Array.isArray(value.records)
  ) {
    return null;
  }
  return value as unknown as MemoryWarehouseShardPayload;
}
