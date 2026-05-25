import type { CapturedContent } from '../stores/mainStore';
import { PRESERVE_RECENT_COUNT } from './summary';

export interface HiddenFloor {
  messageId: number;
  role: ChatMessage['role'];
  summary: string;
}

function uniqueSortedIds(ids: number[]): number[] {
  return Array.from(new Set(ids.filter(id => Number.isInteger(id) && id >= 0))).sort((a, b) => a - b);
}

function getExistingMessageIds(ids: number[]): number[] {
  const uniqueIds = uniqueSortedIds(ids);
  if (uniqueIds.length === 0) return [];

  const existingIds = new Set<number>();
  for (const id of uniqueIds) {
    if (getChatMessages(id).length > 0) {
      existingIds.add(id);
    }
  }
  return Array.from(existingIds).sort((a, b) => a - b);
}

function summarizeMessage(message: string): string {
  const contentMatch = message.match(/<content\b[^>]*>([\s\S]*?)(?:<\/content>|$)/i);
  const rawText = contentMatch ? contentMatch[1] : message;
  const cleaned = rawText
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(cleaned);
  if (chars.length === 0) return '（空楼层）';
  return chars.slice(0, 30).join('') + (chars.length > 30 ? '...' : '');
}

export function getHiddenFloorsFromChat(): HiddenFloor[] {
  let lastMessageId = -1;
  try {
    lastMessageId = getLastMessageId();
  } catch {
    return [];
  }
  if (lastMessageId < 0) return [];

  return getChatMessages(`0-${lastMessageId}`, { hide_state: 'hidden' }).map(message => ({
    messageId: message.message_id,
    role: message.role,
    summary: summarizeMessage(message.message),
  }));
}

export function parseFloorRange(input: string, maxMessageId = getLastMessageId()): number[] {
  const ids = new Set<number>();
  const parts = input
    .split(/[,\uff0c\s]+/)
    .map(part => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*[-~\uff5e]\s*(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      const min = Math.min(start, end);
      const max = Math.max(start, end);
      for (let id = min; id <= max; id++) {
        if (id <= maxMessageId) ids.add(id);
      }
      continue;
    }

    if (/^\d+$/.test(part)) {
      const id = Number(part);
      if (id <= maxMessageId) ids.add(id);
    }
  }

  return uniqueSortedIds(Array.from(ids));
}

export function getCapturedContentMessageIds(contents: CapturedContent[]): number[] {
  return uniqueSortedIds(contents.map(content => content.messageId));
}

export function getCapturedContentAndUserMessageIds(contents: CapturedContent[]): number[] {
  return uniqueSortedIds(
    contents.flatMap(content => {
      const ids = [content.messageId];
      if (content.messageId > 0) ids.push(content.messageId - 1);
      return ids;
    }),
  );
}

export function getRecentFloorIdsToKeepVisible(aiCount = PRESERVE_RECENT_COUNT): number[] {
  let lastMessageId = -1;
  try {
    lastMessageId = getLastMessageId();
  } catch {
    return [];
  }
  if (lastMessageId < 0) return [];

  const recentAiMessages = getChatMessages(`0-${lastMessageId}`, { role: 'assistant' }).slice(-aiCount);
  const ids: number[] = [];

  for (const message of recentAiMessages) {
    ids.push(message.message_id);

    const previousMessage = message.message_id > 0 ? getChatMessages(message.message_id - 1)[0] : undefined;
    if (previousMessage?.role === 'user') {
      ids.push(previousMessage.message_id);
    }
  }

  return uniqueSortedIds(ids);
}

export async function ensureRecentFloorsVisible(refresh: SetChatMessagesOption['refresh'] = 'affected'): Promise<number[]> {
  const protectedIds = getRecentFloorIdsToKeepVisible();
  if (protectedIds.length === 0) return [];

  const protectedSet = new Set(protectedIds);
  const hiddenProtectedIds = getHiddenFloorsFromChat()
    .map(floor => floor.messageId)
    .filter(id => protectedSet.has(id));

  if (hiddenProtectedIds.length === 0) return [];

  await setChatMessages(
    hiddenProtectedIds.map(message_id => ({ message_id, is_hidden: false })),
    { refresh },
  );
  console.info(`[智脑] 安全检查：已取消隐藏最新 ${hiddenProtectedIds.length} 个楼层`);
  return hiddenProtectedIds;
}

export async function setFloorsHidden(
  messageIds: number[],
  isHidden: boolean,
  refresh: SetChatMessagesOption['refresh'] = 'affected',
): Promise<number[]> {
  const existingIds = getExistingMessageIds(messageIds);
  if (existingIds.length === 0) return [];

  await setChatMessages(
    existingIds.map(message_id => ({ message_id, is_hidden: isHidden })),
    { refresh },
  );

  if (isHidden) {
    await ensureRecentFloorsVisible(refresh);
  }

  return existingIds;
}

export async function hideCapturedContentsWithUsers(
  contents: CapturedContent[],
  refresh: SetChatMessagesOption['refresh'] = 'none',
): Promise<number[]> {
  const idsToHide = getCapturedContentAndUserMessageIds(contents);
  return setFloorsHidden(idsToHide, true, refresh);
}
