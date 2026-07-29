import { checksumText } from './memoryWarehouseCodec';
import { extractContentFromMessage } from '../utils/messageParser';

export type RawChatRole = 'system' | 'assistant' | 'user';

export interface RawChatMessageRecord {
  messageId: number;
  role: RawChatRole;
  name: string;
  isHidden: boolean;
  selectedSwipeId: number;
  rawContent: string;
  content: string;
  swipeContents: string[];
  metadataHash?: string;
  sceneId?: string;
  traceId?: string;
  ignored: boolean;
}

/**
 * 提交 MemoryBundle 时保存的来源身份。正文与消息页数据只保存摘要，
 * 不复制进记忆仓元数据。
 */
export interface RawChatSourceContent {
  messageId: number;
  role: RawChatRole;
  content: string;
  swipeId?: number;
  metadataHash?: string;
  sceneId?: string;
  traceId?: string;
}

export interface RawChatReaderDependencies {
  getMessages(
    range: string | number,
    options?: GetChatMessagesOption,
  ): Array<ChatMessage | ChatMessageSwiped> | null;
  getLastMessageId(): number;
}

function defaultGetMessages(
  range: string | number,
  options?: GetChatMessagesOption,
): Array<ChatMessage | ChatMessageSwiped> | null {
  try {
    if (typeof getChatMessages !== 'function') return null;
    return getChatMessages(range, options) as Array<ChatMessage | ChatMessageSwiped>;
  } catch {
    return null;
  }
}

function defaultGetLastMessageId(): number {
  try {
    return typeof getLastMessageId === 'function' ? getLastMessageId() : -1;
  } catch {
    return -1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeForHash(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => normalizeForHash(item, seen));
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (typeof item === 'function' || item === undefined) continue;
    result[key] = normalizeForHash(item, seen);
  }
  return result;
}

function metadataHash(value: unknown): string | undefined {
  if (!isRecord(value) || Object.keys(value).length === 0) return undefined;
  try {
    const normalized = normalizeForHash(value);
    if (isRecord(normalized) && Object.keys(normalized).length === 0) return undefined;
    return checksumText(JSON.stringify(normalized));
  } catch {
    return undefined;
  }
}

function findMetadataString(value: unknown, targetKey: 'sceneId' | 'traceId', depth = 0): string | undefined {
  if (depth > 6 || !value || typeof value !== 'object') return undefined;
  if (isRecord(value)) {
    const direct = value[targetKey];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    for (const child of Object.values(value)) {
      const found = findMetadataString(child, targetKey, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  for (const child of value as unknown[]) {
    const found = findMetadataString(child, targetKey, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function selectedSwipeId(message: any): number {
  const raw = Number(message?.swipe_id ?? 0);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  const max = Array.isArray(message?.swipes) ? Math.max(0, message.swipes.length - 1) : raw;
  return Math.min(Math.floor(raw), max);
}

function rawMessageText(message: any, swipeId: number): string {
  if (Array.isArray(message?.swipes)) {
    return String(message.swipes[swipeId] ?? message.swipes[0] ?? message.message ?? '');
  }
  return typeof message?.message === 'string' ? message.message : '';
}

function messageMetadata(message: any, swipeId: number): Record<string, unknown> {
  const swipeData = Array.isArray(message?.swipes_data) ? message.swipes_data[swipeId] : undefined;
  const swipeInfo = Array.isArray(message?.swipes_info) ? message.swipes_info[swipeId] : undefined;
  return {
    data: isRecord(message?.data) ? message.data : undefined,
    extra: isRecord(message?.extra) ? message.extra : undefined,
    swipeData: isRecord(swipeData) ? swipeData : undefined,
    swipeInfo: isRecord(swipeInfo) ? swipeInfo : undefined,
  };
}

function isIgnoredMessageKind(message: any): boolean {
  const candidates = [
    message?.type,
    message?.kind,
    message?.data?.type,
    message?.data?.kind,
    message?.extra?.type,
    message?.extra?.kind,
    message?.extra?.event_type,
  ];
  return candidates.some(value => {
    const normalized = typeof value === 'string' ? value.toLowerCase() : '';
    return normalized === 'quiet' || normalized === 'command' || normalized === 'extension';
  });
}

function normalizeRole(value: unknown): RawChatRole {
  return value === 'user' || value === 'system' ? value : 'assistant';
}

export class RawChatReader {
  constructor(private readonly dependencies: RawChatReaderDependencies = {
    getMessages: defaultGetMessages,
    getLastMessageId: defaultGetLastMessageId,
  }) {}

  getLastMessageId(): number {
    const value = this.dependencies.getLastMessageId();
    return Number.isFinite(value) ? Math.floor(value) : -1;
  }

  readMessage(messageId: number, role: RawChatRole | 'all' = 'all'): RawChatMessageRecord | null {
    if (!Number.isFinite(messageId) || messageId < 0) return null;
    const messages = this.dependencies.getMessages(Math.floor(messageId), {
      role,
      hide_state: 'all',
      include_swipes: true,
    });
    if (!messages || messages.length === 0) return null;
    return this.normalizeMessage(messages[0]);
  }

  readRange(
    startFloor: number,
    endFloor: number,
    role: RawChatRole | 'all' = 'all',
  ): RawChatMessageRecord[] {
    const start = Math.max(0, Math.floor(startFloor));
    const last = this.getLastMessageId();
    const end = Math.floor(Math.min(endFloor, last >= 0 ? last : endFloor));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
    const messages = this.dependencies.getMessages(`${start}-${end}`, {
      role,
      hide_state: 'all',
      include_swipes: true,
    });
    if (!messages) return [];
    return messages
      .map(message => this.normalizeMessage(message))
      .filter((message): message is RawChatMessageRecord => !!message)
      .sort((left, right) => left.messageId - right.messageId);
  }

  readLatestUserBefore(messageId: number): RawChatMessageRecord | null {
    for (let floor = Math.floor(messageId) - 1; floor >= 0; floor--) {
      const message = this.readMessage(floor, 'user');
      if (message && !message.ignored) return message;
    }
    return null;
  }

  readSourceContentsForAssistantFloors(assistantFloors: readonly number[]): RawChatSourceContent[] {
    const floorSet = new Set(
      assistantFloors.filter(Number.isFinite).map(value => Math.max(0, Math.floor(value))),
    );
    if (floorSet.size === 0) return [];
    const minFloor = Math.min(...floorSet);
    const maxFloor = Math.max(...floorSet);
    const all = this.readRange(minFloor, maxFloor, 'all').filter(message => !message.ignored);
    const byFloor = new Map(all.map(message => [message.messageId, message]));
    const result = new Map<number, RawChatSourceContent>();
    let latestUser = this.readLatestUserBefore(minFloor);
    if (latestUser) result.set(latestUser.messageId, this.toSourceContent(latestUser));
    for (let floor = minFloor; floor <= maxFloor; floor++) {
      const message = byFloor.get(floor);
      if (!message) continue;
      if (message.role === 'user') latestUser = message;
      if (message.role !== 'assistant' || !floorSet.has(floor)) continue;
      if (latestUser) result.set(latestUser.messageId, this.toSourceContent(latestUser));
      result.set(message.messageId, this.toSourceContent(message));
    }
    return [...result.values()].sort((left, right) => left.messageId - right.messageId);
  }

  readAllSourceContents(): RawChatSourceContent[] {
    const last = this.getLastMessageId();
    if (last < 0) return [];
    return this.readSourceContentsInRange(0, last);
  }

  readSourceContentsInRange(startFloor: number, endFloor: number): RawChatSourceContent[] {
    return this.readRange(startFloor, endFloor, 'all')
      .filter(message => !message.ignored && (message.role === 'user' || message.role === 'assistant'))
      .map(message => this.toSourceContent(message));
  }

  private toSourceContent(message: RawChatMessageRecord): RawChatSourceContent {
    return {
      messageId: message.messageId,
      role: message.role,
      content: message.role === 'assistant' ? message.content : message.rawContent,
      swipeId: message.selectedSwipeId,
      metadataHash: message.metadataHash,
      sceneId: message.sceneId,
      traceId: message.traceId,
    };
  }

  private normalizeMessage(message: any): RawChatMessageRecord | null {
    const messageId = Number(message?.message_id);
    if (!Number.isFinite(messageId) || messageId < 0) return null;
    const swipeId = selectedSwipeId(message);
    const rawContent = rawMessageText(message, swipeId);
    const role = normalizeRole(message?.role);
    const metadata = messageMetadata(message, swipeId);
    return {
      messageId: Math.floor(messageId),
      role,
      name: typeof message?.name === 'string' ? message.name : '',
      isHidden: !!message?.is_hidden,
      selectedSwipeId: swipeId,
      rawContent,
      content: role === 'assistant' ? extractContentFromMessage(rawContent) : rawContent,
      swipeContents: Array.isArray(message?.swipes)
        ? message.swipes.map((value: unknown) => String(value ?? ''))
        : [rawContent],
      metadataHash: metadataHash(metadata),
      sceneId: findMetadataString(metadata, 'sceneId'),
      traceId: findMetadataString(metadata, 'traceId'),
      ignored: isIgnoredMessageKind(message),
    };
  }
}

export const rawChatReader = new RawChatReader();
