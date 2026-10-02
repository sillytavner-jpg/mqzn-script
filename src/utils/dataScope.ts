/**
 * 数据导出 / 导入的「分组定义」与「迁移重置」—— 纯函数、零副作用，便于单测。
 *
 * 抽成独立模块的原因：
 * ① 导出与导入必须共用**同一张字段表**，否则日后加字段时两边会失步；
 * ② 「继承到新聊天」的重置规则需要能脱离酒馆运行环境单独验证（真实数据回归）。
 */
import { klona } from 'klona';

/**
 * 导出分组 → chatData 字段清单。
 * `globalSettings` 特殊：它不在 chatData 里，单独处理 scriptData。
 */
export const EXPORT_SCOPE_FIELDS: Record<string, string[]> = {
  timeline: ['summaries', 'summaryHistory', 'timelineOverrides', 'storyDateFormat', '_summaryDeltaFormat'],
  characterMemory: ['characterMemories', 'characterProfiles', 'savedCharacterProfiles'],
  graph: ['knowledgeGraph', 'knowledgeGraphEmbeddingCache', 'knowledgeGraphVersions', 'knowledgeGraphHistory', 'knowledgeGraphUndoHistory', 'characterLocations'],
  characterRegistry: ['characterRegistry', 'pendingUnresolved', 'blacklistedCharacters'],
  dynamicProfile: ['dynamicProfilesV2'],
  relationship: ['relationshipProfiles'],
  items: ['itemMemories'],
  dreamtalk: ['dreamtalk', 'dreamtalkHistory', 'dreamtalkUndoHistory', 'nsfwMemories', 'nsfwDreamtalk', 'nsfwDynamicProfiles'],
  worldProgress: ['worldProgressRecords', 'worldProgressMemories'],
  plotDirector: ['plotOutline', 'lastPlotCheckResult'],
  worldBook: ['worldBookEntries', 'worldBookTagBindings', 'selectedWorldBookKeys', 'savedPlotWB', 'worldProgressWorldBookKeys', 'savedWPWB', 'worldProgressManualChars'],
};

/** 全部可导出的分组（globalSettings 排最前，其余按 UI 顺序） */
export const ALL_EXPORT_SCOPES: string[] = ['globalSettings', ...Object.keys(EXPORT_SCOPE_FIELDS)];

/** 默认勾选：备份 / 迁移最常用的一组 */
export const DEFAULT_EXPORT_SCOPES: string[] = ['globalSettings', 'timeline', 'characterMemory', 'graph', 'characterRegistry'];

/** 分组 → 中文名（UI 与日志共用） */
export const EXPORT_SCOPE_LABELS: Record<string, string> = {
  globalSettings: '全局设置',
  timeline: '时光轴',
  characterMemory: '角色记忆',
  graph: '知识图谱',
  characterRegistry: '角色库',
  dynamicProfile: '动态人设',
  relationship: '关系档案',
  items: '物品库',
  dreamtalk: '梦呓 / NSFW',
  worldProgress: '世界推进',
  plotDirector: '剧情导演',
  worldBook: '世界书配置',
};

/**
 * 「继承到新聊天」模式必须重置的**楼层绑定**字段。
 *
 * 这些字段里的楼层号属于**旧聊天**；带进新聊天后新楼层从 0 开始，会出现：
 * - 游标悬空 → 大总结 / 梦呓 / 动态人设 / 世界推进 / 剧情导演**都不再触发**
 * - 旧小总结 `floorRange` 无对应楼层 → 新聊天第一次小总结时被当 obsolete 清空
 * - 图谱版本按楼层索引 → 新楼层取不到版本 → 图谱注入开局为空
 * - 大总结的 `upToMessageId` → 下次总结把覆盖区间算成 start > end
 *
 * 内容型记忆（大总结正文 / 角色记忆 / 图谱快照 / 人设 / 关系 / 物品…）不受影响，照常保留。
 */
export function applyMigrationReset(data: any): void {
  if (!data || typeof data !== 'object') return;

  // 1) 楼层游标归零（-1 = 从未触发，与 zod prefault 对齐）
  data.lastSummaryAtMessageId = -1;
  data.lastCharacterMemoryAtMessageId = -1;
  data.lastSmallSummaryFloor = -1;
  data.lastDreamtalkFloor = -1;
  data.lastWorldProgressFloor = -1;
  data.pendingWorldProgressFloor = -1;
  data.lastDynamicProfileFloor = -1;
  data.lastPlotCheckFloor = -1;
  data.worldProgressAttempts = -1;
  data.pendingWorldProgress = false;
  data.pendingDynamicProfile = false;
  data.lastPlotCheckResult = null;

  // 2) 楼层绑定的记录：清空（旧 floorRange 在新聊天里没有意义）
  data.smallSummaries = [];
  data.knowledgeGraphVersions = [];
  data.knowledgeGraphHistory = [];
  data.knowledgeGraphUndoHistory = [];
  data.worldProgressRecords = [];
  data.worldProgressMemories = [];

  // 3) 正文捕获 / 用户输入：新聊天没有对应楼层
  data.capturedContents = [];
  data.userInputRecords = [];

  // 4) 大总结上的楼层号改写为无（否则 UI 会显示「覆盖 #300-#344」）
  for (const s of data.summaries || []) {
    s.coveredMessageIds = undefined;
    s.upToMessageId = undefined;
  }
}

/** 按分组把导入数据的字段搬到目标对象上（未勾选的分组保持目标原值） */
export function applyScopedChatData(target: any, source: any, scopes: string[]): void {
  for (const key of Object.keys(EXPORT_SCOPE_FIELDS)) {
    if (!scopes.includes(key)) continue;
    for (const field of EXPORT_SCOPE_FIELDS[key]) {
      if (field in source) target[field] = klona(source[field]);
    }
  }
}

/**
 * 从当前 chatData 里按分组裁出要导出的部分。
 * @param scopes 勾选的分组（不含 globalSettings —— 它在 scriptData 里）
 */
export function pickChatDataByScopes(chatData: any, scopes: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of Object.keys(EXPORT_SCOPE_FIELDS)) {
    if (!scopes.includes(key)) continue;
    for (const field of EXPORT_SCOPE_FIELDS[key]) {
      if (chatData && field in chatData) out[field] = chatData[field];
    }
  }
  return out;
}
