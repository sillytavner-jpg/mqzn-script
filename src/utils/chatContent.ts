import type { CapturedContent } from '../stores/mainStore';
import { extractContentFromMessage, isValidMainContent, parseAssistantMessage } from './messageParser';

export interface ChatUserInput {
  messageId: number;
  content: string;
}

export interface DreamtalkPair {
  userFloor: number;
  aiFloor: number;
  userInput: string;
  aiResponse: string;
  rolledResponses: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function getLastMessageIdSafe(): number {
  try {
    return typeof getLastMessageId === 'function' ? getLastMessageId() : -1;
  } catch {
    return -1;
  }
}

function getChatMessagesSafe(
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

function getMessageText(message: any): string {
  if (!message) return '';
  if (typeof message.message === 'string') return message.message;
  if (Array.isArray(message.swipes)) {
    const swipeId = Number.isFinite(message.swipe_id) ? Number(message.swipe_id) : 0;
    return String(message.swipes[swipeId] ?? message.swipes[0] ?? '');
  }
  return '';
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

function toContentRecord(message: any): CapturedContent | null {
  if (!message || message.role !== 'assistant' || isIgnoredMessageKind(message)) return null;
  const parsed = parseAssistantMessage(getMessageText(message));
  const content = parsed.content;
  if (!isValidMainContent(content)) return null;
  return {
    messageId: Number(message.message_id),
    content,
    thinkingChain: parsed.thinkingChain || undefined,
    capturedAt: nowIso(),
    swipeCount: Number.isFinite(message.swipe_id) ? Number(message.swipe_id) : 0,
  };
}

function fallbackContentsInRange(
  fallback: CapturedContent[] | undefined,
  startFloor: number,
  endFloor: number,
): CapturedContent[] {
  if (!Array.isArray(fallback) || fallback.length === 0) return [];
  return fallback
    .filter(c => c.messageId >= startFloor && c.messageId <= endFloor && isValidMainContent(c.content))
    .slice()
    .sort((a, b) => a.messageId - b.messageId);
}

export function readAssistantContentAtFloor(
  aiFloor: number,
  fallback?: CapturedContent[],
): CapturedContent | null {
  if (!Number.isFinite(aiFloor) || aiFloor < 0) return null;
  const messages = getChatMessagesSafe(aiFloor, { role: 'assistant' });
  if (messages && messages.length > 0) {
    return toContentRecord(messages[0]);
  }
  return fallbackContentsInRange(fallback, aiFloor, aiFloor)[0] ?? null;
}

export function readAssistantExtractedContentAtFloor(aiFloor: number): string | null {
  if (!Number.isFinite(aiFloor) || aiFloor < 0) return null;
  const messages = getChatMessagesSafe(aiFloor, { role: 'assistant' });
  if (!messages || messages.length === 0 || isIgnoredMessageKind(messages[0])) return null;
  return extractContentFromMessage(getMessageText(messages[0]));
}

export function readAssistantContentsInRange(
  startFloor: number,
  endFloor: number,
  fallback?: CapturedContent[],
): CapturedContent[] {
  const lastId = getLastMessageIdSafe();
  const start = Math.max(0, Math.floor(startFloor));
  const end = Math.floor(Math.min(endFloor, lastId >= 0 ? lastId : endFloor));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];

  const messages = getChatMessagesSafe(`${start}-${end}`, { role: 'assistant' });
  if (messages && messages.length > 0) {
    return messages
      .map(toContentRecord)
      .filter((item): item is CapturedContent => !!item)
      .sort((a, b) => a.messageId - b.messageId);
  }
  return fallbackContentsInRange(fallback, start, end);
}

export function readPendingSummaryContents(
  lastSummaryAtMessageId: number,
  preserveRecentFloors: number,
  fallback?: CapturedContent[],
): CapturedContent[] {
  const lastId = getLastMessageIdSafe();
  if (lastId < 0) {
    const fallbackPending = fallbackContentsInRange(fallback, lastSummaryAtMessageId + 1, Number.MAX_SAFE_INTEGER);
    return preserveRecentFloors > 0 ? fallbackPending.slice(0, -preserveRecentFloors) : fallbackPending;
  }
  const pending = readAssistantContentsInRange(lastSummaryAtMessageId + 1, lastId, fallback);
  const preserved = Math.max(0, Math.floor(preserveRecentFloors || 0));
  return preserved > 0 ? pending.slice(0, -preserved) : pending;
}

export function countPendingAssistantContents(
  lastSummaryAtMessageId: number,
  preserveRecentFloors: number,
  fallback?: CapturedContent[],
): number {
  return readPendingSummaryContents(lastSummaryAtMessageId, preserveRecentFloors, fallback).length;
}

export function readRecentAssistantContents(
  count: number,
  beforeOrAtFloor?: number,
  fallback?: CapturedContent[],
): CapturedContent[] {
  const limit = Math.max(0, Math.floor(count || 0));
  if (limit === 0) return [];

  const lastId = getLastMessageIdSafe();
  const end = Math.floor(Math.min(
    beforeOrAtFloor ?? lastId,
    lastId >= 0 ? lastId : (beforeOrAtFloor ?? -1),
  ));
  if (end < 0) return fallbackContentsInRange(fallback, 0, Number.MAX_SAFE_INTEGER).slice(-limit);

  const found: CapturedContent[] = [];
  for (let floor = end; floor >= 0 && found.length < limit; floor--) {
    const record = readAssistantContentAtFloor(floor, fallback);
    if (record) found.unshift(record);
  }
  return found;
}

export function readLatestAssistantContent(fallback?: CapturedContent[]): CapturedContent | null {
  return readRecentAssistantContents(1, undefined, fallback)[0] ?? null;
}

export function readLatestUserInputBefore(aiFloor: number): ChatUserInput | null {
  const directFloor = Math.floor(aiFloor - 1);
  if (directFloor >= 0) {
    const direct = getChatMessagesSafe(directFloor, { role: 'user' });
    if (direct && direct.length > 0) {
      return { messageId: Number(direct[0].message_id), content: getMessageText(direct[0]) };
    }
  }

  for (let floor = directFloor - 1; floor >= 0; floor--) {
    const messages = getChatMessagesSafe(floor, { role: 'user' });
    if (messages && messages.length > 0) {
      return { messageId: Number(messages[0].message_id), content: getMessageText(messages[0]) };
    }
  }
  return null;
}

export function readDreamtalkPair(
  aiFloor: number,
  includeSwipes = false,
): DreamtalkPair | null {
  const messages = getChatMessagesSafe(aiFloor, { role: 'assistant', include_swipes: includeSwipes });
  if (!messages || messages.length === 0) return null;

  const aiMessage = messages[0] as any;
  const aiResponse = extractContentFromMessage(getMessageText(aiMessage));
  if (!isValidMainContent(aiResponse)) return null;

  const user = readLatestUserInputBefore(aiFloor);
  if (!user) return null;

  const rolledResponses: string[] = [];
  if (includeSwipes && Array.isArray(aiMessage.swipes)) {
    const selected = Number.isFinite(aiMessage.swipe_id) ? Number(aiMessage.swipe_id) : 0;
    const seen = new Set<string>([aiResponse]);
    for (let i = 0; i < aiMessage.swipes.length; i++) {
      if (i === selected) continue;
      const text = extractContentFromMessage(String(aiMessage.swipes[i] ?? ''));
      if (!isValidMainContent(text) || seen.has(text)) continue;
      seen.add(text);
      rolledResponses.push(text);
    }
  }

  return {
    userFloor: user.messageId,
    aiFloor,
    userInput: user.content,
    aiResponse,
    rolledResponses,
  };
}

export function hasValidAssistantContentForFloor(
  aiFloor: number,
  fallback?: CapturedContent[],
): boolean {
  return !!readAssistantContentAtFloor(aiFloor, fallback);
}

export function isAssistantContentCurrent(
  aiFloor: number,
  expectedContent: string,
  fallback?: CapturedContent[],
): boolean {
  const current = readAssistantContentAtFloor(aiFloor, fallback);
  return !!current && current.content === expectedContent && isValidMainContent(current.content);
}

export function getLatestValidAssistantFloorBefore(
  aiFloor: number,
  fallback?: CapturedContent[],
): number {
  const recent = readRecentAssistantContents(1, aiFloor - 1, fallback);
  return recent[0]?.messageId ?? -1;
}
