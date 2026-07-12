/**
 * 大总结记忆合并工具
 *
 * 把本次大总结覆盖楼层范围内的世界推进记忆，合并进对应角色的 orderedNewMemories，
 * 并按剧情时间排序。合并后返回需要被归档的世界推进记忆 ID 集合。
 */

import { compareStoryTime, normalizeStoryTime } from '../utils/storyTime';
import type { CharacterMemory, WorldProgressMemory } from '../stores/mainStore';

export interface MergeWorldProgressOptions {
  /** 本次大总结覆盖的楼层范围 [start, end] */
  floorRange: { start: number; end: number };
  /** 用于标记已归档的世界推进记忆版本 */
  summaryVersion: number;
}

export interface MergeWorldProgressResult {
  /** 合并后的角色记忆（已按时间排序） */
  memories: CharacterMemory[];
  /** 已被归档的世界推进记忆 ID 集合 */
  archivedIds: Set<string>;
}

type OrderedMemoryItem = NonNullable<CharacterMemory['orderedNewMemories']>[number];

function getCoreText(core: any): string {
  return typeof core === 'string' ? core : String(core?.text || '').trim();
}

function extractRecentMemoryText(text: string): { text: string; time?: string } {
  const raw = String(text || '').trim();
  const match = raw.match(/^\[(.+?)\]\s*/);
  if (!match) return { text: raw };
  return {
    time: normalizeStoryTime(match[1]),
    text: raw.slice(match[0].length).trim(),
  };
}

function buildOrderedItems(mem: CharacterMemory): OrderedMemoryItem[] {
  if (mem.orderedNewMemories && mem.orderedNewMemories.length > 0) {
    return mem.orderedNewMemories
      .map(item => ({ ...item, text: String(item.text || '').trim() }))
      .filter(item => item.text);
  }

  const items: OrderedMemoryItem[] = [];
  for (const core of mem.coreMemories || []) {
    const text = getCoreText(core);
    if (!text) continue;
    items.push({
      text,
      isCore: true,
      time: typeof core === 'string' ? undefined : (core as any)?.time,
    });
  }
  for (const recent of mem.recentMemories || []) {
    const parsed = extractRecentMemoryText(recent);
    if (!parsed.text) continue;
    items.push({
      text: parsed.text,
      isCore: false,
      time: parsed.time,
    });
  }
  return items;
}

function cloneMemory(mem: CharacterMemory): CharacterMemory {
  return {
    ...mem,
    coreMemories: [...(mem.coreMemories || [])],
    recentMemories: [...(mem.recentMemories || [])],
    orderedNewMemories: buildOrderedItems(mem),
  };
}

function compareOrderedMemory(a: OrderedMemoryItem, b: OrderedMemoryItem): number {
  const timeCompare = compareStoryTime(a.time || '', b.time || '');
  if (timeCompare !== 0) return timeCompare;
  const floorA = typeof a.floor === 'number' ? a.floor : Number.MAX_SAFE_INTEGER;
  const floorB = typeof b.floor === 'number' ? b.floor : Number.MAX_SAFE_INTEGER;
  return floorA - floorB;
}

function sortAndSyncRecent(mem: CharacterMemory): void {
  const ordered = (mem.orderedNewMemories || [])
    .map(item => ({ ...item, text: String(item.text || '').trim() }))
    .filter(item => item.text);
  mem.orderedNewMemories = ordered
    .map((item, index) => ({ item, index }))
    .sort((a, b) => compareOrderedMemory(a.item, b.item) || a.index - b.index)
    .map(({ item }) => item);
  mem.recentMemories = mem.orderedNewMemories
    .filter(item => !item.isCore)
    .map(item => item.text);
}

/**
 * 把指定楼层范围内的世界推进记忆合并到角色记忆中。
 *
 * 规则：
 * - 只合并 floor 在 [start, end] 范围内、且未归档的世界推进记忆。
 * - 同一角色已有大总结记忆时，追加到 orderedNewMemories 并整体排序。
 * - 同一角色没有大总结记忆时，创建一条仅含世界推进记忆的 CharacterMemory。
 * - 世界推进记忆的 isCore 固定为 false，source 标记为 'world_progress'。
 */
export function mergeWorldProgressIntoSummary(
  summaryMemories: CharacterMemory[],
  worldProgressMemories: WorldProgressMemory[],
  options: MergeWorldProgressOptions,
): MergeWorldProgressResult {
  const { floorRange } = options;
  const archivedIds = new Set<string>();

  // 筛选本次范围内的未归档世界推进记忆
  const candidates = (worldProgressMemories || []).filter(m => {
    if (!m || !m.text) return false;
    if ((m as any).archivedInSummaryVersion) return false;
    const floor = m.floor ?? -1;
    return floor >= floorRange.start && floor <= floorRange.end;
  });

  if (candidates.length === 0) {
    return { memories: summaryMemories.map(m => ({ ...m })), archivedIds };
  }

  const resultMap = new Map<string, CharacterMemory>();
  for (const m of summaryMemories) {
    resultMap.set(m.characterName, cloneMemory(m));
  }

  for (const wp of candidates.sort((a, b) =>
    compareStoryTime(a.time || '', b.time || '') || (a.floor ?? 0) - (b.floor ?? 0),
  )) {
    archivedIds.add(wp.id);

    const text = String(wp.text || '').trim();
    if (!text) continue;
    const time = wp.time ? normalizeStoryTime(wp.time) : '';

    let mem = resultMap.get(wp.characterName);
    if (!mem) {
      mem = {
        characterName: wp.characterName,
        aliases: [],
        attitude: 'neutral',
        coreMemories: [],
        recentMemories: [],
        keywords: [],
        orderedNewMemories: [],
      };
      resultMap.set(wp.characterName, mem);
    }

    const ordered = mem.orderedNewMemories || [];
    const exists = ordered.some(item => String(item.text || '').trim() === text);
    if (exists) continue;
    ordered.push({
      text,
      isCore: false,
      time,
      source: 'world_progress',
      id: wp.id,
      floor: wp.floor,
      recordId: wp.recordId,
    });
    mem.orderedNewMemories = ordered;
  }

  // 对每个角色的 orderedNewMemories 按剧情时间排序，并同步 recentMemories
  for (const mem of resultMap.values()) {
    sortAndSyncRecent(mem);
  }

  return {
    memories: [...resultMap.values()],
    archivedIds,
  };
}
