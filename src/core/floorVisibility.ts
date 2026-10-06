import type { CapturedContent } from '../stores/mainStore';
import { logInfo, logWarn } from '../utils/logger';

export interface HiddenFloor {
  messageId: number;
  role: ChatMessage['role'];
  summary: string;
}

/**
 * 原生 /hide 单次调用能覆盖的区间数上限。
 * 原生命令每调一次都会 saveChatConditional() 写盘，区间太多会变成密集 IO；
 * 超过上限时回退到酒馆助手批量 API。
 */
const MAX_NATIVE_RANGES = 4;

/**
 * 楼层指纹缓存（内存态，不持久化）。
 * 用于「删楼后推断被删的是哪几层」——酒馆的 MESSAGE_DELETED 事件不带楼层号，
 * 只能靠前后快照做差分。
 */
let floorSignatureCache: string[] = [];

function uniqueSortedIds(ids: number[]): number[] {
  return Array.from(new Set(ids.filter(id => Number.isInteger(id) && id >= 0))).sort((a, b) => a - b);
}

/** 把升序楼层号压缩成连续区间，例如 [0,1,2,5,7,8] → [[0,2],[5,5],[7,8]] */
function collapseToRanges(ids: number[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const id of ids) {
    const last = ranges[ranges.length - 1];
    if (last && id === last[1] + 1) {
      last[1] = id;
    } else {
      ranges.push([id, id]);
    }
  }
  return ranges;
}

function safeLastMessageId(): number {
  try {
    return getLastMessageId();
  } catch {
    return -1;
  }
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
  const lastMessageId = safeLastMessageId();
  if (lastMessageId < 0) return [];

  return getChatMessages(`0-${lastMessageId}`, { hide_state: 'hidden' }).map(message => ({
    messageId: message.message_id,
    role: message.role,
    summary: summarizeMessage(message.message),
  }));
}

/**
 * 当前处于「隐藏」状态的楼层号。
 *
 * 酒馆助手的 `is_hidden` 是 API 层别名，落盘实体是 `message.is_system`
 * （SillyTavern 的 /hide 就是这么干的），因此这里读到的就是真实的隐藏集合。
 */
export function collectHiddenFloorIds(): number[] {
  const lastMessageId = safeLastMessageId();
  if (lastMessageId < 0) return [];

  try {
    const hidden = getChatMessages(`0-${lastMessageId}`, { hide_state: 'hidden' });
    return uniqueSortedIds(hidden.map(message => message.message_id));
  } catch (error) {
    logWarn('楼层', '读取隐藏楼层失败', String(error));
    return [];
  }
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

  const lastMessageId = safeLastMessageId();
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

/**
 * 用酒馆原生 `/hide`、`/unhide` 命令切换楼层隐藏。
 *
 * 为什么需要它：酒馆助手 `setChatMessages({is_hidden})` 只保证数据层正确，
 * 在「重roll / 删楼」触发增量重绘时，页面上的隐藏外观可能丢失（数据仍在，
 * 所以手动刷新页面又能恢复）。原生 `hideChatMessageRange()` 会**同时**写
 * `message.is_system` 与 DOM 的 `is_system` 属性，因此重贴一次即可让外观与数据重新对齐。
 *
 * @returns true = 原生命令执行成功；false = 不可用（调用方回退批量 API）
 */
async function applyNativeFloorVisibility(start: number, end: number, isHidden: boolean): Promise<boolean> {
  if (typeof triggerSlash !== 'function') return false;

  const lastMessageId = safeLastMessageId();
  if (lastMessageId < 0) return false;

  const from = Math.max(0, Math.min(start, lastMessageId));
  const to = Math.max(0, Math.min(end, lastMessageId));
  if (from > to) return true;

  try {
    await triggerSlash(`${isHidden ? '/hide' : '/unhide'} ${from}-${to}`);
    return true;
  } catch (error) {
    logWarn('楼层', `原生${isHidden ? '隐藏' : '取消隐藏'}失败，回退批量API`, String(error));
    return false;
  }
}

/**
 * 统一入口：切换一组楼层的隐藏状态。
 * 优先原生命令（同时写数据 + DOM），失败或区间过多时回退酒馆助手批量 API。
 *
 * @returns true = 走了原生命令；false = 回退到 setChatMessages
 */
async function applyFloorVisibility(
  ids: number[],
  isHidden: boolean,
  refresh: SetChatMessagesOption['refresh'] = 'affected',
): Promise<boolean> {
  if (ids.length === 0) return true;

  const ranges = collapseToRanges(uniqueSortedIds(ids));
  if (ranges.length <= MAX_NATIVE_RANGES) {
    let allOk = true;
    for (const [start, end] of ranges) {
      if (!(await applyNativeFloorVisibility(start, end, isHidden))) {
        allOk = false;
        break;
      }
    }
    if (allOk) return true;
  }

  await setChatMessages(
    ids.map(message_id => ({ message_id, is_hidden: isHidden })),
    { refresh },
  );
  return false;
}

export async function ensureRecentFloorsVisible(
  refresh: SetChatMessagesOption['refresh'] = 'affected',
  aiCount = 4,
): Promise<number[]> {
  const protectedIds = getRecentFloorIdsToKeepVisible(aiCount);
  if (protectedIds.length === 0) return [];

  const protectedSet = new Set(protectedIds);
  const hiddenProtectedIds = collectHiddenFloorIds().filter(id => protectedSet.has(id));

  if (hiddenProtectedIds.length === 0) return [];

  await applyFloorVisibility(hiddenProtectedIds, false, refresh);
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
  await applyFloorVisibility(existingIds, isHidden, refresh);

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

// ========== 楼层变化后的自愈 ==========

/**
 * 把当前处于隐藏状态的楼层**重新贴一遍**。
 *
 * 触发场景：「重roll / 删除楼层」会让酒馆重建消息区，TauriTavern 在这种情况下
 * 有可能丢掉 DOM 上的隐藏外观（chat 数据里的 is_system 仍在，所以手动刷新能恢复）。
 * 这里主动用原生 /hide 重贴，让页面外观与数据重新一致，免得用户每次都要刷新。
 *
 * @returns 重贴的楼层数（0 = 无需处理）
 */
export async function reapplyHiddenFloors(): Promise<number> {
  const hiddenIds = collectHiddenFloorIds();
  if (hiddenIds.length === 0) return 0;

  // 快速自检：DOM 上的隐藏外观若已追平数据，就不必再跑一遍命令
  try {
    const domHiddenCount = document.querySelectorAll('.mes[is_system="true"]').length;
    if (domHiddenCount >= hiddenIds.length) return 0;
  } catch {
    // 拿不到 DOM 就照常重贴
  }

  const usedNative = await applyFloorVisibility(hiddenIds, true, 'affected');
  logInfo('楼层', `重贴隐藏外观 ${hiddenIds.length} 个楼层`, usedNative ? '原生/hide' : '批量API');
  return hiddenIds.length;
}

// ========== 删楼差分（酒馆的 MESSAGE_DELETED 事件不带楼层号） ==========

/** 记录当前楼层指纹快照（每次楼层稳定后调用） */
export function snapshotFloorSignatures(): void {
  const lastMessageId = safeLastMessageId();
  if (lastMessageId < 0) {
    floorSignatureCache = [];
    return;
  }
  try {
    floorSignatureCache = getChatMessages(`0-${lastMessageId}`).map(
      message => `${message.role}|${(message.message || '').slice(0, 60)}`,
    );
  } catch {
    floorSignatureCache = [];
  }
}

/**
 * 与上次快照做差分，推断本次被删掉的楼层号（基于**删除前**的编号）。
 * 快照缺失（例如刚刷新页面就删楼）时返回空数组，调用方应退化为 clampFloorCursors。
 */
export function diffDeletedFloorIndexes(): number[] {
  const previous = floorSignatureCache;
  if (previous.length === 0) return [];

  const lastMessageId = safeLastMessageId();
  if (lastMessageId < 0) return [];

  let current: string[] = [];
  try {
    current = getChatMessages(`0-${lastMessageId}`).map(
      message => `${message.role}|${(message.message || '').slice(0, 60)}`,
    );
  } catch {
    return [];
  }

  const deleted: number[] = [];
  let i = 0;
  let j = 0;
  while (i < previous.length && j < current.length) {
    if (previous[i] === current[j]) {
      i++;
      j++;
      continue;
    }
    deleted.push(i);
    i++;
  }
  while (i < previous.length) {
    deleted.push(i);
    i++;
  }
  return deleted;
}

/** 清除指纹快照（切换聊天时调用，避免跨聊天误判） */
export function clearFloorSignatureCache(): void {
  floorSignatureCache = [];
}
