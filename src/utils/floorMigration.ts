/**
 * 楼层引用迁移 —— 纯函数、零副作用，便于用真实数据回归验证。
 *
 * 背景：酒馆「删除楼层」会把被删楼层之后的**楼层号整体前移**，
 * 而智脑大量数据以楼层号为键（8 个游标 + 捕获记录 + 覆盖区间 + 图谱版本…）。
 * 不同步迁移的后果：
 * - 游标悬空 → 大总结 / 小总结 / 梦呓 / 动态人设 / 世界推进 / 剧情导演**全部不再触发**
 * - capturedContents / userInputRecords 指错楼层 → 正文回空误判、重跑旧楼层
 * - smallSummaries.floorRange / knowledgeGraphVersions.floor 错位 → 旧数据被误判 obsolete
 *
 * 与 dataScope.ts 的 applyMigrationReset 分工不同：
 * - applyMigrationReset：**跨聊天**继承时整体归零
 * - 本模块：**同一聊天内**删楼层后逐项前移
 */

/**
 * 楼层号前移：被删楼层之后的编号整体 -1。
 *
 * 判定用 `<=`（而不是 `<`），以覆盖「引用正好落在被删楼层上」的情况：
 * - 游标：该层已被删，已处理范围要同步缩小 1
 * - 其它引用：该层已不存在，引用前移到删除点
 * 两端语义一致，因此共用一个函数。
 */
function shiftFloor(floor: number, deleted: number[]): number {
  let shift = 0;
  for (const d of deleted) {
    if (d <= floor) shift++;
  }
  return floor - shift;
}

/** 归一化被删楼层列表：去重、升序、只保留非负整数 */
export function normalizeDeletedIndexes(deletedIndexes: number[]): number[] {
  return Array.from(
    new Set((deletedIndexes || []).filter(d => Number.isInteger(d) && d >= 0)),
  ).sort((a, b) => a - b);
}

/** 迁移区间两端，并保证 start <= end */
function shiftRange(range: { start: number; end: number } | undefined, deleted: number[]) {
  if (!range) return range;
  const start = shiftFloor(range.start, deleted);
  const end = shiftFloor(range.end, deleted);
  return { start, end: Math.max(start, end) };
}

/**
 * 就地迁移 chatData 里所有「楼层号」引用。
 *
 * @param data 聊天的 chatData（会被就地修改）
 * @param deletedIndexes 被删除的楼层号，基于**删除前**的编号
 * @returns 迁移到的游标数量（用于日志；0 表示无需迁移）
 */
export function migrateFloorReferences(data: any, deletedIndexes: number[]): number {
  if (!data || typeof data !== 'object') return 0;

  const deleted = normalizeDeletedIndexes(deletedIndexes);
  if (deleted.length === 0) return 0;
  const deletedSet = new Set(deleted);

  let movedCursors = 0;

  // 1) 楼层游标（-1 = 从未触发，保持不动）
  const cursorKeys = [
    'lastSummaryAtMessageId',
    'lastCharacterMemoryAtMessageId',
    'lastSmallSummaryFloor',
    'lastDreamtalkFloor',
    'lastWorldProgressFloor',
    'pendingWorldProgressFloor',
    'lastDynamicProfileFloor',
    'lastPlotCheckFloor',
  ];
  for (const key of cursorKeys) {
    const current = data[key];
    if (typeof current !== 'number' || current < 0) continue;
    const next = shiftFloor(current, deleted);
    if (next !== current) {
      data[key] = next;
      movedCursors++;
    }
  }

  // 2) 正文捕获 / 玩家输入：所指楼层已不存在 → 整条丢弃；否则前移
  for (const key of ['capturedContents', 'userInputRecords']) {
    const arr = data[key];
    if (!Array.isArray(arr)) continue;
    data[key] = arr
      .filter((x: any) => x && typeof x.messageId === 'number' && !deletedSet.has(x.messageId))
      .map((x: any) => ({ ...x, messageId: shiftFloor(x.messageId, deleted) }));
  }

  // 3) 小总结覆盖区间（两端前移；整段被删则原样保留，内容仍然有效）
  if (Array.isArray(data.smallSummaries)) {
    for (const record of data.smallSummaries) {
      if (record?.floorRange) record.floorRange = shiftRange(record.floorRange, deleted);
    }
  }

  // 4) 图谱版本快照（按楼层索引，供楼层感知注入）
  if (Array.isArray(data.knowledgeGraphVersions)) {
    for (const version of data.knowledgeGraphVersions) {
      if (typeof version?.floor === 'number') version.floor = shiftFloor(version.floor, deleted);
    }
  }

  // 5) 世界推进记录 / 场外记忆
  if (Array.isArray(data.worldProgressRecords)) {
    for (const record of data.worldProgressRecords) {
      if (record?.basedOnFloorRange) record.basedOnFloorRange = shiftRange(record.basedOnFloorRange, deleted);
    }
  }
  if (Array.isArray(data.worldProgressMemories)) {
    for (const memory of data.worldProgressMemories) {
      if (typeof memory?.floor === 'number') memory.floor = shiftFloor(memory.floor, deleted);
      if (typeof memory?.expiresAtFloor === 'number') {
        memory.expiresAtFloor = shiftFloor(memory.expiresAtFloor, deleted);
      }
    }
  }

  // 6) 大总结覆盖楼层号
  for (const key of ['summaries', 'summaryHistory']) {
    const arr = data[key];
    if (!Array.isArray(arr)) continue;
    for (const summary of arr) {
      if (Array.isArray(summary?.coveredMessageIds)) {
        summary.coveredMessageIds = summary.coveredMessageIds
          .filter((id: number) => typeof id === 'number' && !deletedSet.has(id))
          .map((id: number) => shiftFloor(id, deleted));
      }
      if (typeof summary?.upToMessageId === 'number' && summary.upToMessageId >= 0) {
        summary.upToMessageId = shiftFloor(summary.upToMessageId, deleted);
      }
    }
  }

  return movedCursors;
}

/**
 * 兜底：楼层指纹快照丢失时（例如刚刷新页面就删楼），无法精确算出删了哪几层，
 * 只能把越界游标钳制到当前最后楼层，避免「游标悬空 → 功能永久停摆」。
 *
 * @returns 被钳制的游标数量
 */
export function clampFloorCursors(data: any, maxFloor: number): number {
  if (!data || typeof data !== 'object' || !Number.isInteger(maxFloor) || maxFloor < 0) return 0;

  const floorKeys = [
    'lastSummaryAtMessageId',
    'lastCharacterMemoryAtMessageId',
    'lastSmallSummaryFloor',
    'lastDreamtalkFloor',
    'lastWorldProgressFloor',
    'pendingWorldProgressFloor',
    'lastDynamicProfileFloor',
    'lastPlotCheckFloor',
  ];

  let clamped = 0;
  for (const key of floorKeys) {
    const current = data[key];
    if (typeof current === 'number' && current > maxFloor) {
      data[key] = maxFloor;
      clamped++;
    }
  }
  return clamped;
}
