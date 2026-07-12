import type { CapturedContent } from '../stores/mainStore';
import { logInfo } from '../utils/logger';

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
  const missingIds: number[] = [];
  for (const id of uniqueIds) {
    const msgs = getChatMessages(id);
    if (msgs && msgs.length > 0) {
      existingIds.add(id);
    } else {
      missingIds.push(id);
    }
  }
  if (missingIds.length > 0) {
    logInfo('楼层', '消息ID校验', `${existingIds.size}个存在, ${missingIds.length}个不存在`);
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

export function getRecentFloorIdsToKeepVisible(aiCount = 4): number[] {
  if (aiCount <= 0) return []; // slice(-0) === slice(0) 会返回全部元素！

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

export async function ensureRecentFloorsVisible(
  refresh: SetChatMessagesOption['refresh'] = 'affected',
  aiCount = 4,
): Promise<number[]> {
  const protectedIds = getRecentFloorIdsToKeepVisible(aiCount);
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
  return hiddenProtectedIds;
}

export async function setFloorsHidden(
  messageIds: number[],
  isHidden: boolean,
  refresh: SetChatMessagesOption['refresh'] = 'affected',
  preserveCount = 4,
): Promise<number[]> {
  logInfo('楼层', `${isHidden ? '隐藏' : '取消隐藏'} ${messageIds.length}个楼层`);
  const existingIds = getExistingMessageIds(messageIds);
  if (existingIds.length === 0) {
    return [];
  }

  logInfo('楼层', `实际${isHidden ? '隐藏' : '取消隐藏'} ${existingIds.length}个楼层`);
  await setChatMessages(
    existingIds.map(message_id => ({ message_id, is_hidden: isHidden })),
    { refresh },
  );

  if (isHidden) {
    await ensureRecentFloorsVisible(refresh, preserveCount);
  }

  return existingIds;
}

/**
 * 大总结后隐藏楼层：所有 <= maxSummarizedId 的楼层都隐藏
 * （最新 N 条 AI 回复通过 getContentsSinceLast 排除，不会被总结，自然不会被隐藏）
 */
export async function hideSummaryFloors(
  maxSummarizedId: number,
  preserveCount: number,
  refresh: SetChatMessagesOption['refresh'] = 'affected',
): Promise<number[]> {
  const cutoff = maxSummarizedId - preserveCount;
  if (cutoff <= 0) {
    return [];
  }
  const idsToHide: number[] = [];
  for (let id = 0; id <= cutoff; id++) {
    idsToHide.push(id);
  }

  return setFloorsHidden(idsToHide, true, refresh, preserveCount);
}

export async function hideCapturedContentsWithUsers(
  contents: CapturedContent[],
  refresh: SetChatMessagesOption['refresh'] = 'none',
): Promise<number[]> {
  const idsToHide = getCapturedContentAndUserMessageIds(contents);
  return setFloorsHidden(idsToHide, true, refresh);
}
