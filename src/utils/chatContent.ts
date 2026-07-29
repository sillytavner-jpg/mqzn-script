import type { CapturedContent } from '../stores/mainStore';
import { extractContentFromMessage, isValidMainContent } from './messageParser';
import { rawChatReader } from '../core/rawChatReader';

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

function toContentRecord(message: ReturnType<typeof rawChatReader.readMessage>): CapturedContent | null {
  if (!message || message.role !== 'assistant' || message.ignored) return null;
  const content = message.content;
  if (!isValidMainContent(content)) return null;
  return {
    messageId: message.messageId,
    content,
    capturedAt: nowIso(),
    swipeCount: message.selectedSwipeId,
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
  const message = rawChatReader.readMessage(aiFloor, 'assistant');
  if (message) {
    return toContentRecord(message);
  }
  return fallbackContentsInRange(fallback, aiFloor, aiFloor)[0] ?? null;
}

export function readAssistantExtractedContentAtFloor(aiFloor: number): string | null {
  if (!Number.isFinite(aiFloor) || aiFloor < 0) return null;
  const message = rawChatReader.readMessage(aiFloor, 'assistant');
  if (!message || message.ignored) return null;
  return message.content;
}

export function readAssistantContentsInRange(
  startFloor: number,
  endFloor: number,
  fallback?: CapturedContent[],
): CapturedContent[] {
  const lastId = rawChatReader.getLastMessageId();
  const start = Math.max(0, Math.floor(startFloor));
  const end = Math.floor(Math.min(endFloor, lastId >= 0 ? lastId : endFloor));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];

  const messages = rawChatReader.readRange(start, end, 'assistant');
  if (messages.length > 0) {
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
  const lastId = rawChatReader.getLastMessageId();
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

  const lastId = rawChatReader.getLastMessageId();
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
  const message = rawChatReader.readLatestUserBefore(aiFloor);
  return message ? { messageId: message.messageId, content: message.rawContent } : null;
}

export function readDreamtalkPair(
  aiFloor: number,
  includeSwipes = false,
): DreamtalkPair | null {
  const aiMessage = rawChatReader.readMessage(aiFloor, 'assistant');
  if (!aiMessage || aiMessage.ignored) return null;
  const aiResponse = aiMessage.content;
  if (!isValidMainContent(aiResponse)) return null;

  const user = readLatestUserInputBefore(aiFloor);
  if (!user) return null;

  const rolledResponses: string[] = [];
  if (includeSwipes && aiMessage.swipeContents.length > 0) {
    const selected = aiMessage.selectedSwipeId;
    const seen = new Set<string>([aiResponse]);
    for (let i = 0; i < aiMessage.swipeContents.length; i++) {
      if (i === selected) continue;
      const text = extractContentFromMessage(aiMessage.swipeContents[i]);
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
