import { klona } from 'klona';
import type { DreamtalkData } from '../core/dreamtalk';
import type { WorldProgressCandidate, WorldProgressRecord } from '../core/worldProgress';
import type { DynamicProfileV2 } from '../core/dynamicProfileV2';
import type { ItemMemory } from '../core/itemMemory';
import { logWarn, type CodeLogEntry } from '../utils/logger';
import { removeItemHistoryByVersion } from '../core/itemMemory';
import type { KnowledgeGraph, KnowledgeGraphDiff, KnowledgeGraphEmbeddingCache } from '../core/knowledgeGraph';
import {
  buildStableId,
  computeLocationHopDistance,
  createEmptyKnowledgeGraph,
  createEmptyKnowledgeGraphEmbeddingCache,
  demoteAbsentItems,
  ensureKnowledgeGraphEmbeddingCache,
  hydrateKnowledgeGraphEmbeddingsFromCache,
  migrateItemPlacement,
  normalizeLegacyGraph,
  pruneKnowledgeGraphEmbeddingCache,
  stripEmbeddingsFromGraph,
  syncKnowledgeGraphEmbeddingCache,
} from '../core/knowledgeGraph';
import type { PlotOutline, PlotCheckResult } from '../core/plotDirector';
import type { WorldBookEntryInfo, WorldBookTagBinding } from '../core/worldBookTags';

// ── 世界书蒸馏记录类型（原 core/worldBookDistill.ts 已整体删除，类型迁移至此） ──
export interface DistillSection {
  /** 原文汇编（可编辑） */
  text: string;
  /** 来源条目名（溯源） */
  sourceEntries: string[];
}

export interface DistillCharacterSection {
  characterName: string;
  /** 该角色相关原文汇编（可编辑） */
  text: string;
  sourceEntries: string[];
}

export interface DistillRecord {
  id: string;
  /** 本次蒸馏读了哪几本书（标识+溯源） */
  sourceBookNames: string[];
  /** 若为角色卡世界书蒸馏，记角色卡名 */
  sourceCharName?: string;
  distillAt: number;
  /** 世界观一块 */
  worldView: DistillSection;
  /** 每角色一条 */
  characters: DistillCharacterSection[];
  /** 解析失败的兜底原文（仅保留 AI 原始输出，不再混入错误文案） */
  rawJson?: string;
  /** 失败时的错误信息（与 rawJson 分离，避免错误文案被当成蒸馏内容） */
  error?: string;
  status: 'ready' | 'failed';
}
import { charBigramSimilarity, cosineSimilarity } from '../core/embedding';

import { getCapturedContentMessageIds, getHiddenFloorsFromChat, type HiddenFloor } from '../core/floorVisibility';
import type { NsfwCharacterMemory, NsfwDreamtalkData, NsfwDynamicProfile } from '../core/nsfwIsolation';

import { buildMemorySectionText, parseSummaryOutput, type ParsedSummary } from '../core/summary';
import { isValidMainContent } from '../utils/messageParser';
import {
  cleanCharacterAliases as cleanCharacterAliasList,
  normalizeCharacterName as normalizeCharacterNameKey,
  resolveCharacterName as resolveCharacterNameFromEntries,
  MEANINGLESS_ALIASES,
  type CharacterNameEntry,
} from '../utils/characterNames';
import {
  buildRegistryFromEntries,
  getRegistryStats,
  mergeInRegistry,
  renameInRegistry,
  resolveOrPending,
  type CharacterRegistry,
  type CharacterRecord,
  type PendingResolution,
} from '../core/characterRegistry';

const KNOWLEDGE_GRAPH_VERSION_LIMIT = 6;
const DREAMTALK_RECORD_LIMIT = 20;
const WORLD_PROGRESS_MEMORY_TTL_FLOORS = 20;

// ========== 数据类型定义 ==========

export interface UserPersona {
  id: string;
  name: string;
  rawInput: string;
  analyzedProfile: string;
  lastAnalyzedAt: string;
}

export interface CapturedContent {
  messageId: number;
  content: string;
  capturedAt: string;
  swipeCount: number;
}

/** 单条核心记忆（支持语义向量） */
export interface CoreMemoryItem {
  text: string;
  embedding?: number[];
  /** 剧情时间（从 AI 输出的 [日期] 前缀提取） */
  time?: string;
}

export interface CharacterProfile {
  basicInfo: {
    identity: string;
    appearance: string;
    background: string;
    relationToUser: string;
  };
  colorPalette: {
    explanation: string;
    base: string;
    primary: string;
    accents: string[];
    derivatives: string[];
  };
  secondaryExplanation: Array<{ topic: string; content: string }>;
  corePersonality?: {
    surfaceDesire: string;
    deepLack: string;
    coreFear: string;
    defenseMechanism: string;
    coreConflict: string;
    moralBottomLine: string;
    selfAwareness: string;
  };
  imagery?: string;
  literaryReferences: Array<{
    character: string;
    work: string;
    borrowedTraits: string;
  }>;
  generatedAt: string;
  fullMode: boolean;
}

export interface CharacterMemory {
  characterName: string;
  aliases: string[];
  attitude: 'like' | 'dislike' | 'neutral';
  coreMemories: CoreMemoryItem[]; // 核心记忆（远期语义召回，近期完整注入）
  recentMemories: string[]; // 近期记忆（本轮新生成的，每次总结替换）
  keywords: string[];
  /** 每角色语义召回上限（默认取全局 memoryRecallLimit） */
  recallLimit?: number;
  /** 每角色召回开关（false=关闭语义召回，远期核心完整注入。重要角色可设为false） */
  recallEnabled?: boolean;
  /** AI 原始编号顺序（展示用，非持久），如 [{text:"...", isCore:true, time:"..."}, ...] */
  orderedNewMemories?: Array<{ text: string; isCore: boolean; time?: string; source?: string; id?: string; floor?: number; recordId?: string }>;
  /** 角色设定档案（手动生成，按写卡规范产出，防止野生NPC刻板化） */
  profile?: CharacterProfile;
}

export interface TimelineEventTrigger {
  characters: string[]; // 触发角色名
  keywords: string[]; // 触发关键词（地名/物品/事件名/话题）
}

export interface TimelineEvent {
  time: string;
  event: string; // 速览（常驻注入用）
  detail?: string; // 完整详情
  triggers?: TimelineEventTrigger; // AI 生成的激活条件
  summaryVersion?: number; // 来源大总结版本号
  importance?: number; // AI 标注的事件重要性 1-5
  embedding?: number[]; // 语义向量（大总结后批量生成，用于语义召回兜底）
}

export interface CharacterEntry {
  name: string;
  aliases: string[];
  identity: string;
  relationship: string;
  status: string;
}

export interface DynamicProfile {
  characterName: string;
  dynamicContent: string;
  lastUpdatedAt: string;
  basedOnSummaryVersion: number;
}

export interface GrandSummary {
  version: number;
  generatedAt: string;
  /** 新记忆仓中与本轮来源楼层对应的原子提交 ID。 */
  memoryBundleId?: string;
  /** 批量重建事务 ID；用于 ready Checkpoint 恢复时避免重复投影。 */
  rebuildTransactionId?: string;
  upToMessageId?: number;
  coveredMessageIds?: number[];
  characterMemories: CharacterMemory[];
  timeline: TimelineEvent[];
  characterTable: CharacterEntry[];
  rawText: string;
  /** 失败占位标记：true=本次总结失败生成的空壳占位，不推进游标、不回喂下一轮AI */
  isFailed?: boolean;
}

export interface RelationshipProfile {
  id: string;
  from: string;
  to: string;
  fromName: string;
  toName: string;
  kind: 'user-character' | 'character-character';
  relationType: string;
  origin: string;
  currentState: string;
  tension: string;
  futureTrigger: string;
  evidence: string[];
  memoryBias: string[];
  misreadWarnings: string[];
  confidence: '高' | '中' | '低' | string;
  worldbook: {
    fromFound: boolean;
    toFound: boolean;
    entryNames: string[];
  };
  basedOnSummaryVersion: number;
  lastAnalyzedAt: string;
  rawText?: string;
}

	/** 知识图谱版本快照（按楼层索引） */
export interface KnowledgeGraphVersion {
  /** 提交时的 AI 楼层 */
  floor: number;
  /** 该楼层的图谱快照 */
  graph: KnowledgeGraph;
  /** 该图谱版本对应的角色位置快照 */
  characterLocations?: Record<string, string>;
}

export interface KnowledgeGraphState {
  graph: KnowledgeGraph | null;
  characterLocations: Record<string, string>;
}

export interface SmallSummaryRecord {
  id: string;
  floorRange: { start: number; end: number };
  status: 'pending' | 'ready' | 'failed' | 'hidden-active' | 'absorbed' | 'ignored';
  generatedAt?: string;
  storyTime?: string;
  location?: string;
  mainEvent?: string;
  presentCharacters: string[];
  /** 本轮正文实际出场并互动的角色（仅世界推进判在场用，不进图谱） */
  interactingCharacters?: string[];
  /** 本轮每个角色对应的地点明细（含玩家，仅世界推进兜底判在场用，不进图谱） */
  characterLocations?: Array<{ name: string; location: string }>;
  error?: string;
  /** 本次小总结消费的世界推进记录 ID（重roll时用于清除 WP 的 smallSummaryConsumed 标记） */
  consumedWorldProgressId?: string;
}

/** executeSmallSummary 的返回：精简后的 record + 不入库的 graphDiff（由 index.ts 直接消费 commit 到图谱） */
export interface SmallSummaryResult {
  record: SmallSummaryRecord;
  graphDiff?: KnowledgeGraphDiff;
  /** 本轮解析的「角色→地点」明细（含玩家，按首次出现去重）。index.ts 用它批量更新 chatData.characterLocations */
  characterLocations?: Array<{ name: string; location: string }>;
}

export interface WorldProgressMemory {
  id: string;
  characterName: string;
  text: string;
  time?: string;
  floor: number;
  expiresAtFloor: number;
  source: 'world_progress';
  recordId: string;
  /** 已被归档进哪个版本的大总结，归档后不再动态注入 */
  archivedInSummaryVersion?: number;
}

export interface UserInputRecord {
  messageId: number;
  userInput: string;
  aiResponse: string;
  rolledResponses: string[];
}

// ========== 存储拆分：聊天变量（每个聊天独立） ==========

export interface ChatData {
  chatId: string;
  capturedContents: CapturedContent[];
  userInputRecords: UserInputRecord[];
  summaries: GrandSummary[];
  summaryHistory: GrandSummary[];
  dynamicProfiles: any[]; // 已废弃,保留兼容(不再写入新数据)
  dreamtalk: DreamtalkData | null;
  dreamtalkHistory: DreamtalkData[];
  dreamtalkUndoHistory: DreamtalkData[];
  lastSummaryAtMessageId: number;
  // 角色记忆独立游标（分离触发后独立追踪，-1=从未触发）
  lastCharacterMemoryAtMessageId: number;
  // 角色记忆独立存储（分离后不再只存在 GrandSummary 里）
  characterMemories: CharacterMemory[];
  // NSFW隔离层
  nsfwMemories: NsfwCharacterMemory[];
  nsfwDreamtalk: NsfwDreamtalkData | null;
  nsfwDynamicProfiles: NsfwDynamicProfile[];

  // 世界推进记录
  worldProgressRecords: WorldProgressRecord[];
  lastWorldProgressFloor: number;
  pendingWorldProgress: boolean;
  pendingWorldProgressFloor: number;
  /** 推演尝试序号：每当到达推演间隔（无论是否真推、有没有候选）+1。
   *  冷却判定基于"距上次入场引导经过的推演尝试次数"，而非楼层差。
   *  这样即使只有一个候选角色、被冷却时这一轮不推，attempt 仍 +1，冷却逐步递减直到解封。
   *  -1=尚未发生过推演尝试（初始）。 */
  worldProgressAttempts: number;
  worldProgressMemories: WorldProgressMemory[];
  // 关系档案（手动分析生成，不修改记忆）
  relationshipProfiles: RelationshipProfile[];
  // 剧情日期格式记忆（首次总结时从AI输出中提取，后续总结传给AI参考）
  storyDateFormat: string;
  // 小总结记录
  smallSummaries: SmallSummaryRecord[];
  // 小总结间隔触发追踪（上一次触发小总结的轮对话楼层，-1=从未触发；第0层开场白单独算一轮）
  lastSmallSummaryFloor: number;
  // 梦呓独立间隔触发追踪（dreamtalkInterval>0 时用，-1=从未触发；=0 时跟随大总结不用此字段；第0层开场白单独算一轮）
  lastDreamtalkFloor: number;
  // 物品记忆库
  itemMemories: ItemMemory[];
	  // ===== 知识图谱（搭车小总结生成，跟聊天走） =====
	  // 当前图谱快照（null=首次未构建）
	  knowledgeGraph: KnowledgeGraph | null;
	  // 图谱版本历史（按楼层索引，用于楼层感知注入和回退截断）
	  knowledgeGraphVersions: KnowledgeGraphVersion[];
    // 图谱节点向量缓存：旧版本图谱结构借这里做语义召回
    knowledgeGraphEmbeddingCache: KnowledgeGraphEmbeddingCache;
	  // 图谱撤回栈（≤6）
	  knowledgeGraphHistory: KnowledgeGraph[];
	  // 图谱恢复栈（≤6）
	  knowledgeGraphUndoHistory: KnowledgeGraph[];
  // 角色当前位置映射：角色正式名 → 地点稳定 id（由小总结在场角色+地点每轮维护）
  characterLocations: Record<string, string>;
  // 动态人设V2
  dynamicProfilesV2: DynamicProfileV2[];
  // 动态人设V2独立触发追踪（第0层开场白单独算一轮，因此默认从0开始）
  lastDynamicProfileFloor: number;
  pendingDynamicProfile: boolean;
  // 世界推进记录
  // 剧情导演
  plotOutline: PlotOutline | null;
  lastPlotCheckFloor: number;
  lastPlotCheckResult: PlotCheckResult | null;
  // 是否已迁移为增量存储（false=旧格式全量快照，true=增量delta）
  _summaryDeltaFormat: boolean;
  // 时间线手动编辑覆盖（key = `${time}|${event.slice(0,30)}`）
  timelineOverrides: Record<string, TimelineEvent & { _deleted?: boolean }>;
  // 世界书条目轻量列表（条目名+所属世界书名+uid，供剧情导演/世界推进/UI 勾选用；正文不在此持久化）
  worldBookEntries: WorldBookEntryInfo[];
  // 用户手动绑定的世界书标签索引（1/2：世界背景前置、角色设定后置）
  worldBookTagBindings: WorldBookTagBinding[];
  // 剧情导演勾选的世界书条目key列表
  selectedWorldBookKeys: string[];
  // 剧情导演已保存的勾选条目正文（点保存时从运行时 raw cache 反查录入）
  savedPlotWB: Array<WorldBookEntryInfo & { content: string }>;
  // 世界推进勾选的世界书条目key列表（独立于剧情导演）
  worldProgressWorldBookKeys: string[];
  // 世界推进已保存的勾选条目正文
  savedWPWB: Array<WorldBookEntryInfo & { content: string }>;
  // 优先推演角色，逗号分隔，最多2个，跟随聊天保存
  worldProgressManualChars: string;
  // 角色设定档案（手动生成，独立存储，不依赖 characterMemories）
  // key = 角色名，value = CharacterProfile
  characterProfiles: Record<string, CharacterProfile>;
  // 保存的角色设定历史（手动点"保存人设"按钮存入，可存多个版本）
  savedCharacterProfiles: Array<{ name: string; profile: CharacterProfile; savedAt: string }>;
  // ===== 角色名字系统重构：稳定 ID 注册表（P1，唯一真相源）=====
  // null=尚未从旧数据迁移；首次访问时由 ensureCharacterRegistry() lazy 建。
  characterRegistry: CharacterRegistry | null;
  // P2 写入收口：AI 输出的名字 resolve 不中（歧义/未知）时挂入此队列，
  // 不再无脑 fallback 新建角色。待 P5 人工/规则仲裁。
  pendingUnresolved: PendingResolution[];
}

// ========== 存储拆分：脚本变量（全局共享） ==========

/** API 库条目 */
export interface ApiConfig {
  id: string;
  name: string;
  url: string;
  key: string;
  model: string;
}

/** 分析类型 → API 配置 ID 映射 */
export type ApiAssignments = Record<string, string>;

/** 分析类型 → 自定义破限词覆盖 */
export interface JailbreakPromptOverride {
  head?: string;
  tail?: string;
}

export type JailbreakPromptOverrides = Record<string, JailbreakPromptOverride>;

export interface ScriptSettings {
  personas: UserPersona[];
  activePersonaId: string;
  settings: {
    personaEnabled: boolean;
    dynamicProfileEnabled: boolean;
    captureEnabled: boolean;
    smallSummaryEnabled: boolean;
    memoryActivationEnabled: boolean;
    dreamtalkEnabled: boolean;
    summaryInjectionEnabled: boolean;
    itemRecallEnabled: boolean;
    summaryInterval: number; // 大总结触发间隔（每 N 轮对话，默认10；每个AI回复为一轮，开场白第0层单独算一轮）
    eventRecallRecent: number; // 自动注入最近 N 轮总结的已完成事件
    eventRecallLimit: number; // 远期事件召回上限（条数）
    preserveRecentFloors: number;
    memoryMinPerChar: number;
    memoryMaxPerChar: number;
    recentMemoryVersions: number;
    memoryRecallLimit: number; // 每角色语义召回上限（条数，默认10）
    // 世界推进
    worldProgressEnabled: boolean;
    worldProgressInterval: number; // 触发间隔（每 N 轮对话，默认2；每个AI回复为一轮，开场白第0层单独算一轮）
    entryCooldownRounds: number; // 入场引导后冷却A：N 次"推演尝试"内不再推演该角色，默认 1 次
    entryHintCooldownRounds: number; // 入场引导后冷却B：N 次推演尝试内不再为该角色注入入场引导，默认 3 次
    // 剧情导演
    plotDirectorEnabled: boolean;
    plotCheckInterval: number; // 校对间隔（每 N 轮对话，默认5；每个AI回复为一轮，开场白第0层单独算一轮）
    plotDirectorSummaryCount: number; // 大纲对话时注入最近N轮大总结
    plotDirectorSummaryMode: string; // 'detail' | 'overview'
    plotDirectorSpoilerMode: boolean; // 防剧透模式
    // 大总结引导弹窗
    summaryGuidanceEnabled: boolean;
    // 梦呓
    preferredPlayStyle: string; // ''=自动判定, '不抢话'|'抢话'|'混合'
    // 界面
    fontSize: number;
    colorMode: 'dark' | 'light'; // 深色(夜空,默认) / 浅色(白昼樱花)
    // API 库
    apiLibrary: ApiConfig[];
    apiAssignments: ApiAssignments;
    jailbreakOverrides: JailbreakPromptOverrides;
    schedulerMode: 'concurrent' | 'serial';
    // API 监听器（调试用，始终开启）
    apiMonitorEnabled: boolean;
    // 关系档案注入（手动分析后自动注入，默认开启）
    relationshipInjectionEnabled: boolean;
    // 语义向量召回
    embeddingEnabled: boolean;
    embeddingApiUrl: string;
    embeddingApiKey: string;
    embeddingModel: string;
    embeddingDimensions: number;
    /** 未知模型时用户手动声明此模型支持 Matryoshka 降维（发 dimensions 参数） */
    embeddingManualMatryoshka: boolean;
    embeddingSimilarityThreshold: number;
    /** 混合检索权重（0-1，语义 vs 词汇匹配，默认0.7=偏语义） */
    hybridWeight: number;
    // 时间衰减
    timeDecayEnabled: boolean;
    timeDecayRate: number;
    timeDecayBoost: number;
    // 两阶段重排
    rerankEnabled: boolean;
    rerankModel: string;
    rerankCandidateMultiplier: number;
    // API 重试
    apiMaxRetries: number;
    // 世界书蒸馏结果（跨聊天复用，跟角色卡走）
    distillRecords: DistillRecord[];
    // ===== A5.x 开关与间隔体系扩展 =====
    // 触发开关/间隔
    smallSummaryInterval: number; // 小总结触发间隔（每 N 轮对话，默认1=每轮）
    grandSummaryEnabled: boolean; // 大总结触发开关
    characterMemoryEnabled: boolean; // 角色记忆更新触发开关
    characterMemoryInterval: number; // 角色记忆触发间隔（每 N 轮对话，默认10；当前与大总结绑定，未独立使用）
    dreamtalkInterval: number; // 梦呓触发间隔（>0=独立按轮对话间隔，默认10）
    // 注入开关（与触发开关拆分，可只生成不注入或只注入旧数据）
    dynamicProfileInjectionEnabled: boolean;
    dreamtalkInjectionEnabled: boolean;
    worldProgressInjectionEnabled: boolean;
    plotGuidanceInjectionEnabled: boolean;
    nsfwIsolationEnabled: boolean;
  };
}

// ========== Zod Schema ==========

const SavedWorldBookEntrySchema = z.object({
  key: z.string().optional().default(''),
  book: z.string().optional().default(''),
  uid: z.coerce.number().optional(),
  entryName: z.string().optional(),
  content: z.string().optional().default(''),
});

const ChatDataSchema = z
  .object({
    chatId: z.string().prefault(''),
    capturedContents: z.array(z.any()).prefault([]),
    userInputRecords: z.array(z.any()).prefault([]),
    summaries: z.array(z.any()).prefault([]),
    summaryHistory: z.array(z.any()).prefault([]),
    dynamicProfiles: z.array(z.any()).prefault([]), // 已废弃,保留兼容
    dreamtalk: z.any().prefault(null),
    dreamtalkHistory: z.array(z.any()).prefault([]),
    dreamtalkUndoHistory: z.array(z.any()).prefault([]),
    lastSummaryAtMessageId: z.coerce.number().prefault(-1),
    // 角色记忆独立游标
    lastCharacterMemoryAtMessageId: z.coerce.number().prefault(-1),
    // 角色记忆独立存储
    characterMemories: z.array(z.any()).prefault([]),
    // NSFW隔离层
    nsfwMemories: z.array(z.any()).prefault([]),
    nsfwDreamtalk: z.any().prefault(null),
    nsfwDynamicProfiles: z.array(z.any()).prefault([]),

    // 世界推进记录
    worldProgressRecords: z.array(z.any()).prefault([]),
    lastWorldProgressFloor: z.coerce.number().prefault(-1),
    pendingWorldProgress: z.boolean().prefault(false),
    pendingWorldProgressFloor: z.coerce.number().prefault(-1),
    worldProgressAttempts: z.coerce.number().prefault(-1),
    worldProgressMemories: z.array(z.any()).prefault([]),
    // 关系档案
    relationshipProfiles: z.array(z.any()).prefault([]),
    // 剧情日期格式
    storyDateFormat: z.string().prefault(''),
    // 小总结记录
    smallSummaries: z.array(z.any()).prefault([]),
    // 小总结间隔触发追踪
    lastSmallSummaryFloor: z.coerce.number().prefault(-1),
    // 梦呓独立间隔触发追踪
    lastDreamtalkFloor: z.coerce.number().prefault(-1),
    // 物品记忆库
    itemMemories: z.array(z.any()).prefault([]),
	    // 知识图谱
	    knowledgeGraph: z.any().prefault(null),
	    knowledgeGraphVersions: z.array(z.any()).prefault([]),
	    knowledgeGraphEmbeddingCache: z.any().prefault({ locations: {}, items: {} }),
	    knowledgeGraphHistory: z.array(z.any()).prefault([]),
	    knowledgeGraphUndoHistory: z.array(z.any()).prefault([]),
    characterLocations: z.record(z.string(), z.string()).prefault({}),
    // 动态人设V2
    dynamicProfilesV2: z.array(z.any()).prefault([]),
    lastDynamicProfileFloor: z.coerce.number().prefault(0),
    pendingDynamicProfile: z.boolean().prefault(false),
    // 世界推进记录
    // 剧情导演
    plotOutline: z.any().prefault(null),
    lastPlotCheckFloor: z.coerce.number().prefault(-1),
    lastPlotCheckResult: z.any().prefault(null),
    // 增量存储标记
    _summaryDeltaFormat: z.boolean().prefault(false),
    // 时间线手动编辑覆盖
    timelineOverrides: z.record(z.string(), z.any()).prefault({}),
    // 世界书条目 + 选择
    worldBookEntries: z.array(z.object({
      key: z.string().optional().default(""),
      book: z.string().optional().default(""),
      uid: z.coerce.number().optional(),
      entryName: z.string().optional(),
    })).prefault([]),
    worldBookTagBindings: z.array(z.any()).prefault([]),
    selectedWorldBookKeys: z.array(z.string()).prefault([]),
    savedPlotWB: z.array(SavedWorldBookEntrySchema).prefault([]),
    worldProgressWorldBookKeys: z.array(z.string()).prefault([]),
    savedWPWB: z.array(SavedWorldBookEntrySchema).prefault([]),
    worldProgressManualChars: z.string().prefault(''),
    // 角色设定档案（独立存储，不依赖 characterMemories）
    characterProfiles: z.record(z.string(), z.any()).prefault({}),
    // 保存的角色设定历史
    savedCharacterProfiles: z.array(z.any()).prefault([]),
    // 角色名字系统重构：稳定 ID 注册表（P1，唯一真相源）
    characterRegistry: z.any().prefault(null),
    // P2 写入收口：待仲裁的歧义/未知角色名队列
    pendingUnresolved: z.array(z.any()).prefault([]),
  })
  .prefault({});

const ScriptSettingsSchema = z
  .object({
    personas: z
      .array(
        z.object({
          id: z.string().prefault(''),
          name: z.string().prefault(''),
          rawInput: z.string().prefault(''),
          analyzedProfile: z.string().prefault(''),
          lastAnalyzedAt: z.string().prefault(''),
        }),
      )
      .prefault([]),
    activePersonaId: z.string().prefault(''),
    settings: z
      .object({
        personaEnabled: z.boolean().prefault(true),
        dynamicProfileEnabled: z.boolean().prefault(true),
        dynamicProfileInterval: z.coerce.number().prefault(2), // 动态人设触发间隔（每 N 轮对话，默认2；每个AI回复为一轮，开场白第0层单独算一轮）
        captureEnabled: z.boolean().prefault(true),
        smallSummaryEnabled: z.boolean().prefault(true),
        memoryActivationEnabled: z.boolean().prefault(true),
        dreamtalkEnabled: z.boolean().prefault(true),
        summaryInjectionEnabled: z.boolean().prefault(true),
        itemRecallEnabled: z.boolean().prefault(true),
        summaryInterval: z.coerce.number().prefault(10),
        eventRecallRecent: z.coerce.number().prefault(2),
        eventRecallLimit: z.coerce.number().prefault(15),
        preserveRecentFloors: z.coerce.number().prefault(4),
        memoryMinPerChar: z.coerce.number().prefault(4),
        memoryMaxPerChar: z.coerce.number().prefault(8),
        recentMemoryVersions: z.coerce.number().prefault(3),
        memoryRecallLimit: z.coerce.number().prefault(10),
        // 世界推进
        worldProgressEnabled: z.boolean().prefault(false),
        worldProgressInterval: z.coerce.number().prefault(2),
      entryCooldownRounds: z.coerce.number().prefault(1),
      entryHintCooldownRounds: z.coerce.number().prefault(3),
        // 剧情导演
        plotDirectorEnabled: z.boolean().prefault(false),
        plotCheckInterval: z.coerce.number().prefault(5),
        plotDirectorSummaryCount: z.coerce.number().prefault(1),
        plotDirectorSummaryMode: z.string().prefault('overview'),
        plotDirectorSpoilerMode: z.boolean().prefault(false),
        // 大总结引导弹窗
        summaryGuidanceEnabled: z.boolean().prefault(true),
        // 梦呓
        preferredPlayStyle: z.string().prefault(''),
        // 界面
        fontSize: z.coerce.number().prefault(1),
        colorMode: z.enum(['dark', 'light']).prefault('dark'), // 深色(夜空,默认) / 浅色(白昼樱花)
        colorTheme: z.string().prefault('cool'), // 旧字段,保留兼容(已弃用)
        // API 库
        apiLibrary: z.array(z.object({
          id: z.string().prefault(''),
          name: z.string().prefault(''),
          url: z.string().prefault(''),
          key: z.string().prefault(''),
          model: z.string().prefault(''),
        })).prefault([]),
        apiAssignments: z.record(z.string(), z.string()).prefault({}),
        jailbreakOverrides: z.record(z.string(), z.object({
          head: z.string().optional(),
          tail: z.string().optional(),
        })).prefault({}),
        schedulerMode: z.string().prefault('concurrent'), // 'concurrent' | 'serial'
        apiMonitorEnabled: z.boolean().prefault(true),
        relationshipInjectionEnabled: z.boolean().prefault(true),
        // 语义向量召回
        embeddingEnabled: z.boolean().prefault(false),
        embeddingApiUrl: z.string().prefault('https://api.siliconflow.cn/v1/embeddings'),
        embeddingApiKey: z.string().prefault(''),
        embeddingModel: z.string().prefault('BAAI/bge-m3'),
        embeddingDimensions: z.coerce.number().prefault(1024), // bge-m3 native dims
        embeddingManualMatryoshka: z.boolean().prefault(false), // 未知模型手动声明支持降维
        embeddingSimilarityThreshold: z.coerce.number().prefault(0.55),
        hybridWeight: z.coerce.number().prefault(0.7),
        // 时间衰减
        timeDecayEnabled: z.boolean().prefault(true),
        timeDecayRate: z.coerce.number().prefault(0.05),
        timeDecayBoost: z.coerce.number().prefault(0.3),
        // 两阶段重排
        rerankEnabled: z.boolean().prefault(false),
        rerankModel: z.string().prefault('BAAI/bge-reranker-v2-m3'),
        rerankCandidateMultiplier: z.coerce.number().prefault(3),
        // API 重试
        apiMaxRetries: z.coerce.number().prefault(3),
        // 知识图谱（A5.x 顺风车版）
        kgAutoEnabled: z.boolean().prefault(true),
        kgEmbeddingEnabled: z.boolean().prefault(true),
        kgEmbeddingDimensions: z.coerce.number().prefault(0), // 0 = 跟随全局 embeddingDimensions
        kgInjectTopK: z.coerce.number().prefault(40),
        /** 每个角色（含玩家）当前可用物品的注入上限；0 = 不限制。 */
        kgPerCharacterItemLimit: z.coerce.number().prefault(6),
        kgDiagramShowCharacters: z.boolean().prefault(true),
        // ===== A5.x 开关与间隔体系扩展 =====
        smallSummaryInterval: z.coerce.number().prefault(1),
        grandSummaryEnabled: z.boolean().prefault(true),
        characterMemoryEnabled: z.boolean().prefault(true),
        characterMemoryInterval: z.coerce.number().prefault(10),
        dreamtalkInterval: z.coerce.number().prefault(10),
        dynamicProfileInjectionEnabled: z.boolean().prefault(true),
        dreamtalkInjectionEnabled: z.boolean().prefault(true),
        worldProgressInjectionEnabled: z.boolean().prefault(true),
        plotGuidanceInjectionEnabled: z.boolean().prefault(true),
        nsfwIsolationEnabled: z.boolean().prefault(true),
        // quiet/raw 调用注入守卫：解析变量/后台用途的调用（quiet/command/extension/impersonate 及 generateRaw）不注入智脑内容
        quietInjectionGuard: z.boolean().prefault(true),
// 世界书蒸馏结果
        distillRecords: z.array(z.any()).prefault([]),
      })
      .prefault({}),
  })
  .prefault({});

// ========== Store ==========

/**
 * 旧格式迁移：旧版直接存储扁平 ChatData 对象（无 chatId 字段），
 * 返回 ChatData 对象供调用方以当前 chatId 为 key 存入 Record。
 */
function migrateOldFormatToChatData(oldData: Record<string, unknown>): ChatData {

  return ChatDataSchema.parse(oldData);
}

const CHAT_DATA_KEY = 'mqzn_chat_data';
const SETTINGS_KEY = 'mqzn_settings';
/** 跨版本恢复用的稳定ID，不依赖 getScriptId() */
const STABLE_ID = 'mqzn-script-data';
/** localStorage key for global settings */
const SETTINGS_LOCAL_KEY = 'mqzn_global_settings';
/**
 * 聊天变量里的某项是否为"智脑聊天记录"形状（即一条 ChatData）。
 *
 * 作用：区分智脑存的 `Record<chatId, ChatData>` 与其它脚本/系统写在同聊天
 * 变量里的非智脑字段（如 nsfw 隔离系统的 `nsfw_thinking_chain` 字符串），
 * 只清洗前者，避免误删同聊天下别人写的字段。
 */
function isChatDataLike(v: any): boolean {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    && ('chatId' in v || 'capturedContents' in v || 'summaries' in v || 'smallSummaries' in v);
}

function chatRecordMatchesKey(key: string, v: any): boolean {
  if (!isChatDataLike(v)) return false;
  const embeddedChatId = typeof v.chatId === 'string' ? v.chatId : '';
  return !embeddedChatId || embeddedChatId === key;
}

function filterChatRecordMap(records: Record<string, any> | null | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  if (!records || typeof records !== 'object') return out;
  for (const [k, v] of Object.entries(records)) {
    if (chatRecordMatchesKey(k, v)) out[k] = v;
  }
  return out;
}

/**
 * 判断一条 ChatData 是否真的承载了智脑内容。
 * 用于迁移保护：当前聊天变量若只是空壳，不允许覆盖全局备份里的实数据。
 */
function hasChatPayload(v: any): boolean {
  if (!isChatDataLike(v)) return false;
  const arrayKeys = [
    'capturedContents',
    'userInputRecords',
    'summaries',
    'summaryHistory',
    'smallSummaries',
    'worldProgressRecords',
    'worldProgressMemories',
    'dynamicProfiles',
    'dynamicProfilesV2',
    'characterMemories',
    'relationshipProfiles',
    'dreamtalkHistory',
    'dreamtalkUndoHistory',
    'nsfwMemories',
    'nsfwDynamicProfiles',
    'itemMemories',
    'knowledgeGraphVersions',
    'knowledgeGraphHistory',
    'knowledgeGraphUndoHistory',
    'savedCharacterProfiles',
    'savedWPWB',
    'savedPlotWB',
    'worldBookEntries',
    'worldBookTagBindings',
    'selectedWorldBookKeys',
    'worldProgressWorldBookKeys',
  ];
  if (arrayKeys.some(k => Array.isArray(v[k]) && v[k].length > 0)) return true;

  const recordKeys = ['characterProfiles', 'characterLocations', 'timelineOverrides'];
  if (recordKeys.some(k => v[k] && typeof v[k] === 'object' && Object.keys(v[k]).length > 0)) return true;

  const kg = v.knowledgeGraph;
  if (kg && typeof kg === 'object') {
    if ((kg.locations?.length ?? 0) > 0 || (kg.items?.length ?? 0) > 0 || (kg.characters?.length ?? 0) > 0 || (kg.edges?.length ?? 0) > 0) {
      return true;
    }
  }

  return !!(v.dreamtalk || v.nsfwDreamtalk || v.plotOutline || v.lastPlotCheckResult || v.assembledSummary);
}

function hasStrongChatPayload(v: any): boolean {
  if (!isChatDataLike(v)) return false;
  const arrayKeys = [
    'capturedContents',
    'userInputRecords',
    'summaries',
    'summaryHistory',
    'smallSummaries',
    'worldProgressRecords',
    'worldProgressMemories',
    'dynamicProfiles',
    'dynamicProfilesV2',
    'characterMemories',
    'relationshipProfiles',
    'dreamtalkHistory',
    'dreamtalkUndoHistory',
    'nsfwMemories',
    'nsfwDynamicProfiles',
    'itemMemories',
    'knowledgeGraphVersions',
    'knowledgeGraphHistory',
    'knowledgeGraphUndoHistory',
    'savedCharacterProfiles',
    'savedWPWB',
    'savedPlotWB',
    'worldBookTagBindings',
    'selectedWorldBookKeys',
    'worldProgressWorldBookKeys',
  ];
  if (arrayKeys.some(k => {
    const arr = v[k];
    if (!Array.isArray(arr) || arr.length === 0) return false;
    if (k === 'capturedContents') {
      return arr.some((item: any) => Number(item?.messageId ?? -1) > 0);
    }
    return true;
  })) return true;

  const recordKeys = ['characterProfiles', 'characterLocations', 'timelineOverrides'];
  if (recordKeys.some(k => v[k] && typeof v[k] === 'object' && Object.keys(v[k]).length > 0)) return true;

  const kg = v.knowledgeGraph;
  if (kg && typeof kg === 'object') {
    if ((kg.locations?.length ?? 0) > 0 || (kg.items?.length ?? 0) > 0 || (kg.characters?.length ?? 0) > 0 || (kg.edges?.length ?? 0) > 0) {
      return true;
    }
  }

  return !!(
    v.dreamtalk
    || v.nsfwDreamtalk
    || v.plotOutline
    || v.lastPlotCheckResult
    || v.assembledSummary
    || (typeof v.worldProgressManualChars === 'string' && v.worldProgressManualChars.trim())
  );
}

/** 从 type:'chat' 变量表里提取所有智脑聊天记录（ChatDataLike），其它字段原样保留返回。 */
function extractChatRecords(chatVars: Record<string, any> | null | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  if (!chatVars) return out;
  for (const [k, v] of Object.entries(chatVars)) {
    if (chatRecordMatchesKey(k, v)) out[k] = v;
  }
  return out;
}

function getSillyTavernContext(): any | null {
  try {
    const st: any = (typeof SillyTavern !== 'undefined') ? SillyTavern : (window as any).SillyTavern;
    return st?.getContext?.() ?? st ?? null;
  } catch {
    return null;
  }
}

function getActiveChatIdFromContext(ctx: any = getSillyTavernContext()): string {
  try {
    const st: any = (typeof SillyTavern !== 'undefined') ? SillyTavern : (window as any).SillyTavern;
    if (st && typeof st.getCurrentChatId === 'function') {
      const activeId = st.getCurrentChatId();
      return activeId ? String(activeId) : '';
    }
  } catch {
    // fallback to context fields below
  }
  const fallbackId = ctx?.chatId || ctx?.groupId || '';
  return fallbackId ? String(fallbackId) : '';
}

function getCurrentChatMetadata(): Record<string, any> | null {
  const ctx = getSillyTavernContext();
  if (ctx?.chatMetadata && typeof ctx.chatMetadata === 'object') {
    return ctx.chatMetadata as Record<string, any>;
  }
  try {
    const st: any = (typeof SillyTavern !== 'undefined') ? SillyTavern : (window as any).SillyTavern;
    if (st?.chatMetadata && typeof st.chatMetadata === 'object') {
      return st.chatMetadata as Record<string, any>;
    }
  } catch {
    // noop
  }
  return null;
}

function extractChatMetadataRecords(currentChatId: string): Record<string, any> {
  const metadata = getCurrentChatMetadata();
  const localRaw = metadata?.variables?.[CHAT_DATA_KEY];
  if (typeof localRaw === 'string' && localRaw.trim()) {
    try {
      const parsed = JSON.parse(localRaw);
      if (isChatDataLike(parsed) && chatRecordMatchesKey(currentChatId, parsed)) {
        return { [currentChatId]: parsed };
      }
      const records = filterChatRecordMap(parsed);
      if (Object.keys(records).length > 0) return records;
    } catch {
      // 兼容旧坏值，继续读顶层 metadata。
    }
  }

  const raw = metadata?.[CHAT_DATA_KEY];
  if (!raw || typeof raw !== 'object') return {};
  if (isChatDataLike(raw) && chatRecordMatchesKey(currentChatId, raw)) {
    return { [currentChatId]: raw };
  }
  return filterChatRecordMap(raw);
}

function slimDreamtalkRecordsForPersist(records: any[]): any[] {
  return (records || [])
    .filter(record => {
      const userInput = typeof record?.userInput === 'string' ? record.userInput.trim() : '';
      const aiResponse = typeof record?.aiResponse === 'string' ? record.aiResponse : '';
      return !!userInput && isValidMainContent(aiResponse);
    })
    .map(record => {
      const seen = new Set<string>([record.aiResponse]);
      const rolledResponses: string[] = [];
      for (const rolled of record.rolledResponses || []) {
        if (typeof rolled !== 'string' || !isValidMainContent(rolled) || seen.has(rolled)) continue;
        seen.add(rolled);
        rolledResponses.push(rolled);
      }
      return { ...record, rolledResponses };
    })
    .slice(-DREAMTALK_RECORD_LIMIT);
}

function slimChatDataForPersist(data: any): any {
  const copy = klona(data);
  if (copy && typeof copy === 'object' && !Array.isArray(copy)) {
    if (Array.isArray(copy.capturedContents)) copy.capturedContents = [];
    if (Array.isArray(copy.userInputRecords)) {
      copy.userInputRecords = slimDreamtalkRecordsForPersist(copy.userInputRecords);
    }
  }
  return copy;
}

function writeChatMetadataCurrent(chatId: string, data: any): void {
  const ctx = getSillyTavernContext();
  const activeChatId = getActiveChatIdFromContext(ctx);
  if (!chatId || !activeChatId || activeChatId !== chatId) {
    logWarn('智脑存储', '写入跳过：当前聊天已切换或关闭', { targetChatId: chatId, activeChatId });
    return;
  }

  const payload = { [chatId]: slimChatDataForPersist(data) };
  const payloadString = JSON.stringify(payload);
  if (ctx?.variables?.local?.set && typeof ctx.variables.local.set === 'function') {
    ctx.variables.local.set(CHAT_DATA_KEY, payloadString);
  }

  if (ctx?.updateChatMetadata && typeof ctx.updateChatMetadata === 'function') {
    const metadata = getCurrentChatMetadata() || {};
    const variables = {
      ...(metadata.variables && typeof metadata.variables === 'object' ? metadata.variables : {}),
      [CHAT_DATA_KEY]: payloadString,
    };
    // ⭐ 只写 variables[CHAT_DATA_KEY]（副本①，字符串形态，主读取源）。
    // 不再写顶层 [CHAT_DATA_KEY]（副本③）——同一份内容写两份是纯冗余，
    // 读取侧 extractChatMetadataRecords 优先读 variables 内的字符串副本①，
    // 顶层③仅作①parse 失败时的回退；放弃这层冗余换 ~50% metadata 体积瘦身。
    ctx.updateChatMetadata({ variables, tainted: true }, false);

    // ⭐ 主动清理顶层旧的副本③残留：updateChatMetadata 是浅合并，不传 [CHAT_DATA_KEY]
    // 只是不写新的、不会删旧的。这里持同一 chatMetadata 引用直接 delete，
    // 下次落盘见到的就是少了③的精简结构。（只删对象形态的旧 ③，不动 字符串①）
    try {
      const after = getCurrentChatMetadata();
      if (after && after[CHAT_DATA_KEY] && typeof after[CHAT_DATA_KEY] === 'object') {
        delete after[CHAT_DATA_KEY];
      }
    } catch { /* 清理失败不影响主写入 */ }
    return;
  }

  const metadata = getCurrentChatMetadata();
  if (!metadata) {
    logWarn('智脑存储', '写入跳过：当前聊天 metadata 不存在', { chatId });
    return;
  }
  if (!metadata.variables || typeof metadata.variables !== 'object') metadata.variables = {};
  metadata.variables[CHAT_DATA_KEY] = payloadString;
  metadata[CHAT_DATA_KEY] = payload;
  metadata.tainted = true;
}

function buildCurrentMetadataSnapshot(): Record<string, any> {
  const metadata = getCurrentChatMetadata();
  return metadata && typeof metadata === 'object' ? klona(metadata) : {};
}

async function forceSaveCurrentChatMetadata(targetChatId: string): Promise<void> {
  const ctx = getSillyTavernContext();
  const activeChatId = getActiveChatIdFromContext(ctx);
  if (!targetChatId || !activeChatId || activeChatId !== targetChatId) {
    logWarn('智脑存储', '强制保存跳过：当前聊天已切换或关闭', { targetChatId, activeChatId });
    return;
  }

  if (!ctx?.getRequestHeaders || !Array.isArray(ctx.chat)) {
    logWarn('智脑存储', '强制保存跳过：SillyTavern 上下文不完整', {
      hasHeaders: !!ctx?.getRequestHeaders,
      hasChatArray: Array.isArray(ctx?.chat),
    });
    return;
  }

  const metadata = buildCurrentMetadataSnapshot();
  metadata.tainted = true;
  const metadataBytes = JSON.stringify(metadata).length;
  const header = {
    chat_metadata: metadata,
    user_name: 'unused',
    character_name: 'unused',
  };

  try {
    if (ctx.groupId) {
      const group = Array.isArray(ctx.groups) ? ctx.groups.find((x: any) => x.id === ctx.groupId) : null;
      const chatId = group?.chat_id || ctx.chatId;
      if (!chatId) {
        logWarn('智脑存储', '强制保存群聊跳过：找不到 chatId', { groupId: ctx.groupId });
        return;
      }
      const response = await fetch('/api/chats/group/save', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({
          id: chatId,
          chat: [header, ...ctx.chat],
          force: true,
        }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        logWarn('智脑', '强制保存群聊 metadata 接口失败', JSON.stringify({ status: response.status, detail }));
      } else {
      }
      return;
    }

    const character = Array.isArray(ctx.characters) ? ctx.characters[ctx.characterId] : null;
    const fileName = character?.chat || ctx.chatId;
    if (!character || !fileName) {
      logWarn('智脑存储', '强制保存单聊跳过：找不到角色或聊天文件', {
        characterId: ctx.characterId,
        fileName,
      });
      return;
    }
    const response = await fetch('/api/chats/save', {
      method: 'POST',
      cache: 'no-cache',
      headers: ctx.getRequestHeaders(),
      body: JSON.stringify({
        ch_name: character.name,
        file_name: fileName,
        chat: [header, ...ctx.chat],
        avatar_url: character.avatar,
        force: true,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logWarn('智脑', '强制保存聊天 metadata 接口失败', JSON.stringify({ status: response.status, detail }));
    } else {
    }
  } catch (error) {
    logWarn('智脑', '强制保存聊天 metadata 失败', error);
  }
}

function requestChatMetadataSave(targetChatId: string): void {
  try {
    const ctx = getSillyTavernContext();
    const activeChatId = getActiveChatIdFromContext(ctx);
    if (!targetChatId || !activeChatId || activeChatId !== targetChatId) {
      logWarn('智脑存储', '保存跳过：当前聊天已切换或关闭', { targetChatId, activeChatId });
      return;
    }

    const metadata = getCurrentChatMetadata();
    if (metadata) {
      metadata.tainted = true;
    }
    const saveOfficial = ctx?.saveMetadata || ctx?.saveChat;
    const result = typeof saveOfficial === 'function' ? saveOfficial.call(ctx) : null;
    if (result && typeof result.then === 'function') {
      result
        .then(() => {
        })
        .catch((error: any) => {
          logWarn('智脑', '聊天变量保存失败', error);
        });
    } else if (typeof saveOfficial === 'function') {
    } else {
      logWarn('智脑存储', '官方保存函数不存在，将只尝试强制保存');
      setTimeout(() => {
        const delayedCtx = getSillyTavernContext();
        const delayedActiveChatId = getActiveChatIdFromContext(delayedCtx);
        if (!targetChatId || !delayedActiveChatId || delayedActiveChatId !== targetChatId) {
          logWarn('智脑存储', '延迟强制保存跳过：当前聊天已切换或关闭', { targetChatId, activeChatId: delayedActiveChatId });
          return;
        }
        forceSaveCurrentChatMetadata(targetChatId);
      }, 250);
    }
  } catch (error) {
    logWarn('智脑', '触发聊天变量保存失败', error);
  }
}

/**
 * 把"当前聊天单条 ChatData"写回 type:'chat'，并清掉同聊天变量表里其它 chatId 的旧智脑残留
 * （旧格式曾把所有聊天合并塞进每个聊天文件，每次写当前聊天时顺手瘦身掉残留）。
 * 用 getVariables+replaceVariables 手动合并，并显式请求 SillyTavern 保存当前聊天 metadata；
 * 保留原变量表里非智脑字段（如 nsfw 隔离系统的 nsfw_thinking_chain），不误删别人写的字段。
 */
function writeChatScopeCurrent(chatId: string, data: any): void {
  const ctx = getSillyTavernContext();
  const activeChatId = getActiveChatIdFromContext(ctx);
  if (!chatId || !activeChatId || activeChatId !== chatId) {
    logWarn('智脑存储', '写入跳过：当前聊天已切换或关闭', { targetChatId: chatId, activeChatId });
    return;
  }
  writeChatMetadataCurrent(chatId, data);
  try {
    const existing = (getVariables({ type: 'chat' }) as Record<string, any>) || {};
    const next: Record<string, any> = { ...existing };
    // 清掉非当前 chatId 的智脑聊天记录残留（旧多聊天合并格式的瘦身）
    for (const k of Object.keys(next)) {
      if (k !== chatId && isChatDataLike(next[k])) delete next[k];
    }
    // ⭐ 现代酒馆（有 updateChatMetadata）已通过 writeChatMetadataCurrent 写副本①，
    // 不再往 type:'chat' 变量表按 chatId 键写副本②——同样内容第三份纯冗余。
    // 老酒馆无 updateChatMetadata API，仍写副本②作兜底读取源。
    const hasModernApi = !!(ctx?.updateChatMetadata && typeof ctx.updateChatMetadata === 'function');
    if (hasModernApi) {
      // 主动清掉当前 chatId 下旧的副本②残留（新写入不再产生②，但旧文件里可能还有）
      if (next[chatId] && isChatDataLike(next[chatId])) delete next[chatId];
    } else {
      next[chatId] = slimChatDataForPersist(data);
    }
    replaceVariables(next, { type: 'chat' });
  } catch (error) {
    logWarn('智脑', '兼容写入聊天变量失败，已写入官方 chatMetadata', error);
  }
  requestChatMetadataSave(chatId);
}

/** 写 STABLE_ID：测试版不再保存全局聊天池，只保留全局设置。 */
function writeStableSettings(settings: any): void {
  replaceVariables(
    { [CHAT_DATA_KEY]: {}, [SETTINGS_KEY]: klona(settings) },
    { type: 'script', script_id: STABLE_ID },
  );
}

function loadSettingsFromLocal(): any | null {
  try {
    // 优先访问父页面（SillyTavern）的 localStorage；同域直接可用，跨域时抛 SecurityError
    const storage = (window.parent || window).localStorage;
    const raw = storage.getItem(SETTINGS_LOCAL_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {

  }
  return null;
}

function saveSettingsToLocal(data: any): void {
  try {
    const storage = (window.parent || window).localStorage;
    storage.setItem(SETTINGS_LOCAL_KEY, JSON.stringify(data));
  } catch (e) {

  }
}

function tryReadData(currentScriptId: string, currentChatId: string): {
  /** 全量 Record<chatId, ChatData>（所有聊天合并） */
  allChatsData: Record<string, any>;
  /** type:'chat' 里是否检测到旧的"多聊天合并"格式，需要上层做一次性瘦身迁移 */
  needsMultiChatSlim: boolean;
  /** 当前聊天是否已经有自己的 type:'chat' 智脑记录 */
  currentChatInChatScope: boolean;
  /** 当前聊天是否还残留在 STABLE_ID 全局备份里 */
  currentChatInStableBackup: boolean;
  /** STABLE_ID 里的当前聊天原始记录，用于空壳覆盖保护 */
  stableCurrentChatData: any;
  settings: any;
  migrated: boolean;
} {
  const primaryChat = getVariables({ type: 'chat' });
  const primaryScript = getVariables({ type: 'script', script_id: currentScriptId }) ?? {};

  // settings 加载优先级：localStorage > script变量 > 空
  let settings: any = null;
  const localSettings = loadSettingsFromLocal();
  if (localSettings) {
    settings = localSettings;

  } else if (primaryScript && Object.keys(primaryScript).length > 0) {
    settings = primaryScript;
  }
  if (!settings) settings = {};

  // 旧版全局聊天池：现在只作为搬家来源读取，新写入时会清空聊天池。
  const stable = getVariables({ type: 'script', script_id: STABLE_ID }) ?? {};
  const stableAllChats = filterChatRecordMap(
    (stable[CHAT_DATA_KEY] && typeof stable[CHAT_DATA_KEY] === 'object') ? stable[CHAT_DATA_KEY] : {},
  );
  const hasScriptSettings = settings && Object.keys(settings).length > 0;

  if (!currentChatId) {
    logWarn('智脑存储', '初始化读取跳过：当前没有聊天 id', {
      chatVarKeys: primaryChat && typeof primaryChat === 'object' ? Object.keys(primaryChat) : [],
      stableRecordKeys: Object.keys(stableAllChats),
    });
    return {
      allChatsData: {},
      needsMultiChatSlim: false,
      currentChatInChatScope: false,
      currentChatInStableBackup: false,
      stableCurrentChatData: null,
      settings: hasScriptSettings ? settings : (stable[SETTINGS_KEY] ?? settings),
      migrated: false,
    };
  }

  // 把 type:'chat' 里的智脑聊天记录提取出来（可能含旧的多聊天合并，也可能已只是单条当前聊天）。
  const variableChatRecords = extractChatRecords(primaryChat);
  const metadataChatRecords = extractChatMetadataRecords(currentChatId);
  const chatRecords = { ...variableChatRecords, ...metadataChatRecords };
  const chatRecordCount = Object.keys(chatRecords).length;
  let currentChatInChatScope = Object.prototype.hasOwnProperty.call(chatRecords, currentChatId);
  const currentChatInStableBackup = Object.prototype.hasOwnProperty.call(stableAllChats, currentChatId);
  const stableCurrentChatData = stableAllChats[currentChatId];
  // 是否为旧版"多聊天合并"格式：里面有>1个 key 且都是 ChatData 形状 → 需一次性瘦身迁移
  // （新格式下 type:'chat' 只含当前聊天单条，key 数应 = 1 或 0）
  const needsMultiChatSlim = Object.keys(variableChatRecords).length > 1;

  // 合并：旧全局聊天池作为迁移来源，并入 type:'chat' 记录（覆盖式，type:'chat' 当次最新鲜）
  const merged: Record<string, any> = { ...stableAllChats };
  let mergedNew = 0;
  for (const [k, v] of Object.entries(chatRecords)) {
    const stableExisting = merged[k];
    if (k === currentChatId && hasChatPayload(stableExisting) && !hasChatPayload(v)) {
      continue;
    }
    if (!merged[k] || merged[k] !== v) { merged[k] = v; mergedNew++; }
  }

  // ⭐ 导入聊天后的 chatId 错位认领：酒馆原生导入 JSONL 会把文件名改成
  // "<角色> - <时间> imported"，导致当前 chatId 与数据里内嵌/外层的旧 chatId 不一致，
  // 下游 allChatsData.value[currentChatId] 取不到 → 智脑读到空。
  // 这里在合并后做一次归一化：若 merged 里没有 currentChatId 这条 key、但有且仅有
  // 一条其它 chatId 的记录（典型导入场景），就把它认领为 currentChatId。
  // 多条记录（旧多聊天合并格式）不动，保留各自真实 chatId。
  if (currentChatId && !merged[currentChatId]) {
    const otherKeys = Object.keys(merged).filter(k => k !== currentChatId);
    if (otherKeys.length === 1) {
      const adoptKey = otherKeys[0];
      const adopted = merged[adoptKey];
      if (hasChatPayload(adopted)) {
        const relocated = klona(adopted);
        if (relocated && typeof relocated === 'object') {
          relocated.chatId = currentChatId; // 内嵌 chatId 也归一化
        }
        delete merged[adoptKey];
        merged[currentChatId] = relocated;
        currentChatInChatScope = true; // 认领后当前聊天已在 chatRecords 中
      }
    }
  }

  const totalChats = Object.keys(merged).length;
  if (totalChats > 0) {

    return {
      allChatsData: merged,
      needsMultiChatSlim,
      currentChatInChatScope,
      currentChatInStableBackup,
      stableCurrentChatData,
      settings: hasScriptSettings ? settings : (stable[SETTINGS_KEY] ?? settings),
      migrated: needsMultiChatSlim,
    };
  }

  // STABLE_ID 与 type:'chat' 都无智脑记录
  if (hasScriptSettings) {

    return {
      allChatsData: {},
      needsMultiChatSlim: false,
      currentChatInChatScope,
      currentChatInStableBackup,
      stableCurrentChatData,
      settings,
      migrated: false,
    };
  }

  // 兜底：无可恢复数据。返回 migrated:false，避免上层把空对象覆盖式写回。

  return {
    allChatsData: {},
    needsMultiChatSlim: false,
    currentChatInChatScope,
    currentChatInStableBackup,
    stableCurrentChatData,
    settings: {},
    migrated: false,
  };
}

export const useMainStore = defineStore('main', () => {
  const currentScriptId = getScriptId();
  const currentChatId = SillyTavern.getCurrentChatId();

  // ========== 数据加载（主存储 → 跨版本备份回退） ==========
  const {
    allChatsData: rawAllChats,
    needsMultiChatSlim,
    currentChatInChatScope,
    currentChatInStableBackup,
    stableCurrentChatData,
    settings: rawSettings,
    migrated: migratedFromOld,
  } = tryReadData(currentScriptId, currentChatId);

  // 旧格式迁移：旧版直接存扁平 ChatData（无 chatId 维度），以当前 chatId 收一条
  // 兼容：rawAllChats 里若混入无 chatId 的扁平对象（旧版直接存整个 ChatData），收一条
  const flatLegacy =
    rawAllChats && (rawAllChats.summaries !== undefined || rawAllChats.capturedContents !== undefined);
  const flatLegacyMatchesCurrent = !!flatLegacy && chatRecordMatchesKey(currentChatId, rawAllChats);
  const needsMigration = flatLegacyMatchesCurrent;

  const allChatsData = ref<Record<string, ChatData>>(
    flatLegacyMatchesCurrent
      ? { [currentChatId]: migrateOldFormatToChatData(rawAllChats) }
      : (flatLegacy ? {} : (rawAllChats ?? {})),
  );

  const scriptData = ref<ScriptSettings>(ScriptSettingsSchema.parse(rawSettings ?? {}));

  // API 库迁移：旧版 customApiUrl → apiLibrary
  const _rawS = (rawSettings?.settings ?? {}) as any;
  const _s = scriptData.value.settings as any;
  if ((!_s.apiLibrary || _s.apiLibrary.length === 0) && (_rawS.customApiUrl || _rawS.customApiModel)) {
    const oldUrl = _rawS.customApiUrl || '';
    const oldKey = _rawS.customApiKey || '';
    const oldModel = _rawS.customApiModel || '';
    const library: ApiConfig[] = [{ id: 'api_1', name: '默认API', url: oldUrl, key: oldKey, model: oldModel }];
    const assignments: ApiAssignments = {};
    const allTypes = ['grand_summary', 'small_summary', 'dreamtalk', 'dynamic_profile', 'character_memory', 'relationship', 'world_progress', 'plot_director', 'persona', 'character_profile'];
    if (_rawS.smallSummaryApiUrl && _rawS.smallSummaryApiModel) {
      library.push({ id: 'api_2', name: '小总结API', url: _rawS.smallSummaryApiUrl, key: _rawS.smallSummaryApiKey || '', model: _rawS.smallSummaryApiModel });
      assignments['small_summary'] = 'api_2';
      allTypes.forEach(t => { if (t !== 'small_summary') assignments[t] = 'api_1'; });
    } else {
      allTypes.forEach(t => { assignments[t] = 'api_1'; });
    }
    _s.apiLibrary = library;
    _s.apiAssignments = assignments;

  }

  // 迁移后立即写回：type:'chat' 只写当前聊天单条（新格式），STABLE_ID 不再保存聊天池。
  // ⚠ 空对象守卫（修复刷新丢数据根因1）：仅当确实存在可迁移数据时才覆盖式写回，
  // 防止「chat_metadata 未就绪 / 备份为空」时空对象把已有 storage/backup 抹掉。
  if (migratedFromOld || needsMigration || needsMultiChatSlim) {
    const hasAllChatsData = allChatsData.value && Object.keys(allChatsData.value).length > 0;
    if (hasAllChatsData) {
      // 写当前聊天单条到 type:'chat'（同时清掉同聊天变量里其它 chatId 的旧合并残留）
      // 注：此处 chatData ref 尚未创建，写 allChatsData 里已就绪的当前聊天条目即可
      const migrationCurrent = allChatsData.value[currentChatId];
      if (hasChatPayload(migrationCurrent)) {
        writeChatScopeCurrent(currentChatId, migrationCurrent);
      } else {
        logWarn('智脑存储', '初始化迁移跳过空数据回写', {
          currentChatId,
          hasCurrentRecord: Object.prototype.hasOwnProperty.call(allChatsData.value, currentChatId),
          allKeys: Object.keys(allChatsData.value),
        });
      }
      saveSettingsToLocal(scriptData.value);
      replaceVariables(klona(scriptData.value), { type: 'script', script_id: currentScriptId });
      // 当前聊天写入自己的 chat 变量；STABLE_ID 聊天池立即清空，只保留全局设置。
      writeStableSettings(scriptData.value);
      if (needsMultiChatSlim) {

      } else {

      }
    } else {

    }
  }

  // 从 allChatsData 中提取当前聊天的数据（不存在则初始化）
  const parsedChat = allChatsData.value[currentChatId]
    ? ChatDataSchema.parse(allChatsData.value[currentChatId])
    : ChatDataSchema.parse({});
  const chatData = ref<ChatData>(parsedChat);
  const startupCurrentHadRecord = Object.prototype.hasOwnProperty.call(allChatsData.value ?? {}, currentChatId);
  let _startupEmptyReadProtection =
    !!currentChatId
    && !startupCurrentHadRecord
    && !currentChatInStableBackup
    && !migratedFromOld
    && !needsMigration
    && !needsMultiChatSlim;
  let _startupEmptyReadStartedAt = Date.now();

  // ⭐ 二级安全网：当前聊天在主存储中缺失，从跨版本备份恢复
  // 兼容旧全局数据：以 STABLE_ID 中的当前聊天为来源搬到 type:'chat'，随后清空全局聊天池。
  if (!allChatsData.value[currentChatId]) {
    const stableRecovery = getVariables({ type: 'script', script_id: STABLE_ID }) ?? {};
    const backupAllChats = filterChatRecordMap(
      (stableRecovery[CHAT_DATA_KEY] && typeof stableRecovery[CHAT_DATA_KEY] === 'object')
        ? stableRecovery[CHAT_DATA_KEY] : {},
    );
    const backupChatData = backupAllChats?.[currentChatId];
    if (backupChatData) {
      const parsed = ChatDataSchema.parse(backupChatData);
      chatData.value = parsed;
      // 以完整备份为基础，补入当前聊天，避免其它聊天数据被覆盖
      const backupRecord = (backupAllChats && typeof backupAllChats === 'object') ? backupAllChats : {};
      allChatsData.value = { ...backupRecord, [currentChatId]: parsed };
      // 回写到主存储：type:'chat' 只写当前聊天单条
      writeChatScopeCurrent(currentChatId, parsed);
      writeStableSettings(scriptData.value);
      _startupEmptyReadProtection = false;

    }
  }

  // 首次初始化时记录当前聊天ID
  if (!chatData.value.chatId) {
    chatData.value.chatId = currentChatId;
  }

  // 当前聊天自动搬家：只写进自己的 chat 变量，然后清空 STABLE_ID 聊天池。
  if (currentChatInStableBackup) {
    const stableHasPayload = hasChatPayload(stableCurrentChatData);
    const currentHasPayload = hasChatPayload(chatData.value);
    if (!stableHasPayload || currentHasPayload || !currentChatInChatScope) {
      writeChatScopeCurrent(currentChatId, chatData.value);
    }
    writeStableSettings(scriptData.value);
  }

  // 梦呓 v1 → v2 迁移：检测旧格式（有 generalBehaviors 字段），自动丢弃
  if (chatData.value.dreamtalk && (chatData.value.dreamtalk as any).generalBehaviors !== undefined) {

    chatData.value.dreamtalk = null;
  }

  // 梦呓 v2 补字段：旧 v2 数据不含 userInfo/personality，补默认值
  if (chatData.value.dreamtalk && !chatData.value.dreamtalk.userInfo) {
    (chatData.value.dreamtalk as any).userInfo = { basic: '', appearance: '', background: '', relationship: '' };
    (chatData.value.dreamtalk as any).personality = null;
  }

  // 梦呓 v2.1 → v2 条目格式迁移：旧格式 patterns/prevent → 新格式 entries
  if (chatData.value.dreamtalk) {
    let migrated = false;
    const dt = chatData.value.dreamtalk as any;

    // bodyContact: { patterns, prevent } → { entries }
    if (dt.bodyContact && Array.isArray(dt.bodyContact.patterns) && !dt.bodyContact.entries) {
      const prevent = dt.bodyContact.prevent || '';
      dt.bodyContact = { entries: dt.bodyContact.patterns.map((t: string) => ({ text: t, prevent })) };
      migrated = true;
    }
    // speechStyle: { patterns, prevent } → { entries }
    if (dt.speechStyle && Array.isArray(dt.speechStyle.patterns) && !dt.speechStyle.entries) {
      const prevent = dt.speechStyle.prevent || '';
      dt.speechStyle = { entries: dt.speechStyle.patterns.map((t: string) => ({ text: t, prevent })) };
      migrated = true;
    }
    // characterInteractions: { behaviors, prevent } → { entries }
    if (Array.isArray(dt.characterInteractions)) {
      for (let i = 0; i < dt.characterInteractions.length; i++) {
        const ci = dt.characterInteractions[i];
        if (Array.isArray(ci.behaviors) && !ci.entries) {
          const prevent = ci.prevent || '';
          ci.entries = ci.behaviors.map((t: string) => ({ text: t, prevent }));
          delete ci.behaviors;
          delete ci.prevent;
          migrated = true;
        }
      }
    }

    if (migrated) {

    }
  }

  // ========== 运行状态（不持久化，脚本重载后重置） ==========

  const summaryInProgress = ref(false);
  const dreamtalkInProgress = ref(false);
  const characterMemoryInProgress = ref(false);
  const chatContentRevision = ref(0);
  const _isRealChatMessage = ref(false); // MESSAGE_SENT 触发才为 true，generateRaw 分析请求不会触发
  const _isBackgroundCall = ref(false); // generateRaw 调用期间为 true，阻止 CHAT_COMPLETION_SETTINGS_READY 误注入
  // native generateRaw 的单次消费标记：调用前+1，处理器消费时-1。带超时自动清除防 stuck。
  let _bgNativeCallPending = false;
  let _bgNativeCallTimer: ReturnType<typeof setTimeout> | null = null;
  function markBgNativeCall(): void {
    _bgNativeCallPending = true;
    if (_bgNativeCallTimer) clearTimeout(_bgNativeCallTimer);
    _bgNativeCallTimer = setTimeout(() => {
      _bgNativeCallPending = false;
      _bgNativeCallTimer = null;
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '存储',
        level: 'warn',
        message: 'native标记超时自动清除',
      });
    }, 15000);
  }
  function consumeBgNativeCall(): boolean {
    if (!_bgNativeCallPending) return false;
    _bgNativeCallPending = false;
    if (_bgNativeCallTimer) {
      clearTimeout(_bgNativeCallTimer);
      _bgNativeCallTimer = null;
    }
    return true;
  }

  // quiet 守卫已改为直接读 CC_SR payload.type（见 index.ts），不再需要预标记。

  // API 监听器日志（运行时，不持久化，最多5条）
  interface ApiMonitorEntry {
    timestamp: string;
    analysisName: string;
    model: string;
    messages: Array<{ role: string; content: string }>;
    response: string;
    durationMs: number;
    /** 失败时填入错误摘要（成功调用无此字段） */
    error?: string;
  }
  const apiMonitorLogs = ref<ApiMonitorEntry[]>([]);
  function pushApiMonitorLog(entry: ApiMonitorEntry) {
    const logs = apiMonitorLogs.value;
    logs.unshift(entry);
    if (logs.length > 5) logs.pop();
    // 触发响应式更新
    apiMonitorLogs.value = [...logs];
  }
  function clearApiMonitorLogs() {
    apiMonitorLogs.value = [];
  }

  // 代码日志（运行时，不持久化，最多 100 条）
  let _codeLogIdCounter = 1;
  const MAX_CODE_LOGS = 100;
  const codeLogs = ref<CodeLogEntry[]>([]);
  function pushCodeLog(entry: CodeLogEntry) {
    codeLogs.value.unshift(entry);
    if (codeLogs.value.length > MAX_CODE_LOGS) codeLogs.value.pop();
    codeLogs.value = [...codeLogs.value];
  }
  function clearCodeLogs() {
    codeLogs.value = [];
  }

  // 关系档案分析状态（运行时，不持久化，切tab不丢失）
  const relAnalyzing = ref(false);
  const relStatus = ref('');
  const relError = ref('');
  const relSelectedNodeId = ref<string>('__zhino_user__');
  const relSelectedEdgeId = ref<string>('');

  // 世界书条目运行时全文缓存（非持久化）：WORLDINFO_ENTRIES_LOADED 时由 index.ts 同步赋值，
  // 供 WorldTab 保存勾选时按 key 反查条目正文，写入 savedPlotWB/savedWPWB。
  const worldBookRawCache = ref<Array<WorldBookEntryInfo & { content: string }>>([]);

  function setSummaryInProgress(v: boolean) {
    summaryInProgress.value = v;
  }
  function setDreamtalkInProgress(v: boolean) {
    dreamtalkInProgress.value = v;
  }
  function setCharacterMemoryInProgress(v: boolean) {
    characterMemoryInProgress.value = v;
  }

  function touchChatContent() {
    chatContentRevision.value++;
  }

  function normalizeRolledResponses(aiResponse: string, rolledResponses: string[] | undefined): string[] {
    const seen = new Set<string>([aiResponse]);
    const normalized: string[] = [];
    for (const text of rolledResponses || []) {
      const value = typeof text === 'string' ? text : '';
      if (!isValidMainContent(value) || seen.has(value)) continue;
      seen.add(value);
      normalized.push(value);
    }
    return normalized;
  }

  function trimDreamtalkRecords() {
    chatData.value.userInputRecords = chatData.value.userInputRecords
      .filter(record => {
        const userInput = typeof record?.userInput === 'string' ? record.userInput.trim() : '';
        const aiResponse = typeof record?.aiResponse === 'string' ? record.aiResponse : '';
        return !!userInput && isValidMainContent(aiResponse);
      })
      .map(record => ({
        ...record,
        rolledResponses: normalizeRolledResponses(record.aiResponse, record.rolledResponses),
      }))
      .slice(-DREAMTALK_RECORD_LIMIT);
  }

  trimDreamtalkRecords();

  // ========== 持久化系统 ==========
  // 防抖 + dirty 标记
  // - doPersist():       防抖 1 秒（内部调用用，如 addSummary 等）
  // - schedulePersist(): 防抖 1 秒（UI 编辑用，替代 forcePersist）
  // - forcePersist():    立即 flush（AI 操作、聊天切换等关键路径用）

  let _persistTimer: ReturnType<typeof setTimeout> | null = null;
  let _persistDirty = false;
  let _settingsDirty = false;
  function persistSettingsIfDirty(): boolean {
    if (!_settingsDirty) return false;
    _settingsDirty = false;
    saveSettingsToLocal(scriptData.value);
    replaceVariables(klona(scriptData.value), { type: 'script', script_id: currentScriptId });
    return true;
  }

  function tryRecoverStartupEmptyRead(): boolean {
    if (!_startupEmptyReadProtection) return false;
    try {
      const reread = tryReadData(currentScriptId, currentChatId);
      const recovered = reread.allChatsData?.[currentChatId];
      if (hasStrongChatPayload(recovered)) {
        const parsed = ChatDataSchema.parse(recovered);
        chatData.value = parsed;
        allChatsData.value = { ...(allChatsData.value ?? {}), ...reread.allChatsData, [currentChatId]: parsed };
        _startupEmptyReadProtection = false;
        return true;
      }
    } catch (error) {
      logWarn('智脑存储', '空读启动保护：延迟读取失败', error);
    }
    return false;
  }

  function _doPersistNow() {
    if (_persistTimer) {
      clearTimeout(_persistTimer);
      _persistTimer = null;
    }
    if (!_persistDirty) return;
    _persistDirty = false;
    if (_startupEmptyReadProtection) {
      tryRecoverStartupEmptyRead();
    }

    // 1. 当前聊天数据 → 持久化副本（深拷贝，运行期 chatData 不动）
    //    关键瘦身：历史快照(versions/history/undoHistory)的三处图谱副本
    //    在落盘前 strip 掉 embedding 向量，避免 ≤11 份 × 1024维向量导致每轮涨 0.5MB。
    //    当前图谱(knowledgeGraph)的 embedding 保留，召回 cosine 依赖它；
    //    reload 后缺向量由 hasMissingEmbedding + embedKnowledgeGraphNodes lazy 补齐。
    const persistCopy: any = klona(chatData.value);
    if (persistCopy) {
      persistCopy.capturedContents = [];
      if (Array.isArray(persistCopy.userInputRecords)) {
        persistCopy.userInputRecords = slimDreamtalkRecordsForPersist(persistCopy.userInputRecords);
      }
      if (persistCopy.knowledgeGraphVersions && Array.isArray(persistCopy.knowledgeGraphVersions)) {
        for (const v of persistCopy.knowledgeGraphVersions) {
          if (v && v.graph) v.graph = stripEmbeddingsFromGraph(v.graph);
        }
      }
      if (Array.isArray(persistCopy.knowledgeGraphHistory)) {
        for (let i = 0; i < persistCopy.knowledgeGraphHistory.length; i++) {
          persistCopy.knowledgeGraphHistory[i] = stripEmbeddingsFromGraph(persistCopy.knowledgeGraphHistory[i]);
        }
      }
      if (Array.isArray(persistCopy.knowledgeGraphUndoHistory)) {
        for (let i = 0; i < persistCopy.knowledgeGraphUndoHistory.length; i++) {
          persistCopy.knowledgeGraphUndoHistory[i] = stripEmbeddingsFromGraph(persistCopy.knowledgeGraphUndoHistory[i]);
        }
      }
    }
    if (_startupEmptyReadProtection) {
      const elapsedMs = Date.now() - _startupEmptyReadStartedAt;
      const strongPayload = hasStrongChatPayload(persistCopy);
      const bytes = JSON.stringify(persistCopy).length;
      if (!strongPayload || elapsedMs < 5000) {
        logWarn('智脑存储', '空读启动保护：跳过空壳写回', {
          currentChatId,
          elapsedMs,
          strongPayload,
          bytes,
        });
        const settingsPersisted = persistSettingsIfDirty();
        if (settingsPersisted) writeStableSettings(scriptData.value);
        if (strongPayload && elapsedMs < 5000) {
          _persistDirty = true;
          _persistTimer = setTimeout(_doPersistNow, Math.max(250, 5000 - elapsedMs));
        }
        return;
      }
      _startupEmptyReadProtection = false;
      logWarn('智脑存储', '空读启动保护：等待窗口结束，允许新内容写回', {
        currentChatId,
        elapsedMs,
        bytes,
      });
    }
    allChatsData.value[currentChatId] = persistCopy;

    // 新存储模型：type:'chat' 只含当前聊天单条；STABLE_ID 不再保存聊天池。
    // 旧 STABLE_ID 只作为搬家来源读取；搬家完成后写空聊天池，避免 settings.json 继续膨胀。
    const _stableNow = getVariables({ type: 'script', script_id: STABLE_ID }) ?? {};
    const _stableAllChats = filterChatRecordMap(
      (_stableNow[CHAT_DATA_KEY] && typeof _stableNow[CHAT_DATA_KEY] === 'object')
        ? _stableNow[CHAT_DATA_KEY] : {},
    );
    const _existingKeys = Object.keys(_stableAllChats);
    const _newKeys = (allChatsData.value && Object.keys(allChatsData.value)) || [];
    const _existingCur = _stableAllChats[currentChatId];
    const _existingCurHasData = _existingCur && (
      (Array.isArray(_existingCur.summaries) && _existingCur.summaries.length > 0) ||
      (Array.isArray(_existingCur.capturedContents) && _existingCur.capturedContents.length > 0)
    );
    const _newCur = allChatsData.value[currentChatId];
    const _newCurHasData = _newCur && (
      (Array.isArray(_newCur.summaries) && _newCur.summaries.length > 0) ||
      (Array.isArray(_newCur.capturedContents) && _newCur.capturedContents.length > 0)
    );
    const _newIsEmpty = _newKeys.length === 0;

    let _skipChatWrite = false;
    if (_newIsEmpty) {
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '存储',
        level: 'warn',
        message: 'allChatsData为空，跳过写回',
      });
      _skipChatWrite = true;
    } else if (_existingKeys.length > _newKeys.length) {
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '存储',
        level: 'warn',
        message: '疑刷新竞态缩水，跳过写回',
      });
      _skipChatWrite = true;
    } else if (_existingCurHasData && !_newCurHasData) {
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '存储',
        level: 'warn',
        message: '疑刷新竞态，跳过写回避免抹空',
      });
      _skipChatWrite = true;
    }

    // type:'chat' 只写当前聊天单条（同时清掉同聊天变量里其它 chatId 的旧合并残留）
    if (!_skipChatWrite) {
      writeChatScopeCurrent(currentChatId, persistCopy);
    }

    // 2. 设置数据（仅当 dirty 时才写入）
    const settingsPersisted = persistSettingsIfDirty();

    // 3. STABLE_ID 只保留全局设置，聊天池写空。
    if (settingsPersisted || _existingKeys.length > 0) {
      writeStableSettings(scriptData.value);
    }
  }

  function doPersist() {
    _persistDirty = true;
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(_doPersistNow, 1000);
  }

  /** UI 编辑用的防抖持久化（1 秒后写入，不阻塞编辑） */
  function schedulePersist(options: { settings?: boolean } = {}) {
    _persistDirty = true;
    if (options.settings !== false) _settingsDirty = true; // UI 编辑可能涉及设置，保守标记
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(_doPersistNow, 1000);
  }

  /** 立即落盘（AI 操作、聊天切换、页面卸载前用） */
  function forcePersist(options: { settings?: boolean } = {}) {
    _persistDirty = true;
    if (options.settings !== false) _settingsDirty = true;
    _doPersistNow();
  }

  // 页面卸载前 flush，防止防抖导致数据丢失
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      if (_persistDirty) _doPersistNow();
    });
  }

  // ========== 便捷访问器 ==========

  const personas = computed(() => scriptData.value.personas);
  const activePersonaId = computed(() => scriptData.value.activePersonaId);
  const persona = computed(() => {
    const active = scriptData.value.personas.find(p => p.id === scriptData.value.activePersonaId);
    return active ?? { id: '', name: '', rawInput: '', analyzedProfile: '', lastAnalyzedAt: '' };
  });
  const settings = computed(() => scriptData.value.settings);
  const capturedContents = computed(() => chatData.value.capturedContents);
  const summaries = computed(() => chatData.value.summaries);
  const dynamicProfiles = computed(() => chatData.value.dynamicProfiles || []);
  const characterRegistry = computed(() => chatData.value.characterRegistry);
  const dreamtalk = computed(() => chatData.value.dreamtalk);
  const userInputRecords = computed(() => chatData.value.userInputRecords);
  const lastSummaryAtMessageId = computed(() => chatData.value.lastSummaryAtMessageId);
  const storyDateFormat = computed({
    get: () => chatData.value.storyDateFormat,
    set: (val: string) => {
      chatData.value.storyDateFormat = val;
    },
  });

  // ========== 用户人格相关 ==========

  function addPersona(name: string): string {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    scriptData.value.personas.push({ id, name, rawInput: '', analyzedProfile: '', lastAnalyzedAt: '' });
    if (!scriptData.value.activePersonaId) {
      scriptData.value.activePersonaId = id;
    }
    forcePersist();
    return id;
  }

  function removePersona(id: string) {
    scriptData.value.personas = scriptData.value.personas.filter(p => p.id !== id);
    if (scriptData.value.activePersonaId === id) {
      scriptData.value.activePersonaId = scriptData.value.personas[0]?.id ?? '';
    }
    forcePersist();
  }

  function setActivePersona(id: string) {
    scriptData.value.activePersonaId = id;
    forcePersist();
  }

  function updatePersonaRaw(rawInput: string) {
    const idx = scriptData.value.personas.findIndex(x => x.id === scriptData.value.activePersonaId);
    if (idx !== -1) {
      scriptData.value.personas[idx] = { ...scriptData.value.personas[idx], rawInput };
      forcePersist();
    }
  }

  function updatePersonaProfile(analyzedProfile: string) {
    const idx = scriptData.value.personas.findIndex(x => x.id === scriptData.value.activePersonaId);
    if (idx !== -1) {
      scriptData.value.personas[idx] = {
        ...scriptData.value.personas[idx],
        analyzedProfile,
        lastAnalyzedAt: new Date().toISOString(),
      };
      forcePersist();
    }
  }

  function renamePersona(id: string, name: string) {
    const idx = scriptData.value.personas.findIndex(x => x.id === id);
    if (idx !== -1) {
      scriptData.value.personas[idx] = { ...scriptData.value.personas[idx], name };
      forcePersist();
    }
  }

  // ========== 设置相关 ==========

  function updateSettings(partial: Partial<ScriptSettings['settings']>) {
    Object.assign(scriptData.value.settings, partial);
    _settingsDirty = true;
    // 设置变更直接落盘到 localStorage（轻量），replaceVariables 走 doPersist
    saveSettingsToLocal(scriptData.value);
  }

  // ========== 正文捕获相关 ==========

  function captureContent(messageId: number, content: string) {
    void messageId;
    void content;
    touchChatContent();
  }

  // 捕获第0层开场白（不会触发 MESSAGE_RECEIVED 事件）
  function captureFloorZero() {
    touchChatContent();
  }

  // ========== 用户输入记录 ==========

  function recordUserInput(messageId: number, userInput: string, aiResponse: string, rolledResponses: string[] = []) {
    const normalizedUserInput = typeof userInput === 'string' ? userInput : '';
    const normalizedAiResponse = typeof aiResponse === 'string' ? aiResponse : '';
    if (!normalizedUserInput.trim() || !isValidMainContent(normalizedAiResponse)) {
      const before = chatData.value.userInputRecords.length;
      chatData.value.userInputRecords = chatData.value.userInputRecords.filter(r => r.messageId !== messageId);
      if (chatData.value.userInputRecords.length !== before) {
        touchChatContent();
        schedulePersist({ settings: false });
      }
      return;
    }
    const normalizedRolled = normalizeRolledResponses(normalizedAiResponse, rolledResponses);
    const existing = chatData.value.userInputRecords.find(r => r.messageId === messageId);
    if (existing) {
      existing.rolledResponses = normalizeRolledResponses(existing.aiResponse, existing.rolledResponses);
      if (existing.aiResponse !== normalizedAiResponse && isValidMainContent(existing.aiResponse)) {
        existing.rolledResponses.push(existing.aiResponse);
      }
      existing.userInput = normalizedUserInput;
      existing.aiResponse = normalizedAiResponse;
      for (const rolled of normalizedRolled) {
        if (!existing.rolledResponses.includes(rolled)) {
          existing.rolledResponses.push(rolled);
        }
      }
    } else {
      chatData.value.userInputRecords.push({
        messageId,
        userInput: normalizedUserInput,
        aiResponse: normalizedAiResponse,
        rolledResponses: normalizedRolled,
      });
    }
    trimDreamtalkRecords();
    touchChatContent();
    schedulePersist({ settings: false });
  }

  // ========== 大总结相关 ==========

  /**
   * 增量存储：每条 summary 只存本轮新增内容，不再存合并后的全集。
   * 旧格式（_summaryDeltaFormat=false）首次调用时自动迁移。
   */
  /**
   * 在进入正式持久化边界前统一规范化大总结派生数据。
   * 新记忆仓与 addSummary 共用，确保两边保存的是同一份角色名和记忆顺序。
   */
  function prepareSummaryForCommit(summary: GrandSummary): GrandSummary {
    summary.characterMemories = normalizeIncomingCharacterMemories(summary.characterMemories);
    summary.characterTable = normalizeIncomingCharacterTable(summary.characterTable);
    for (const event of summary.timeline || []) {
      if (event.triggers?.characters) {
        event.triggers.characters = resolveKnownCharacterNames(event.triggers.characters, true);
      }
    }

    // 过滤用户自身（AI偶尔误生成user的记忆条目）
    summary.characterMemories = summary.characterMemories.filter(m => {
      const isUser = isUserCharacterName(m.characterName);
      if (isUser) {
        pushCodeLog({
          id: _codeLogIdCounter++,
          timestamp: new Date().toISOString(),
          module: '存储',
          level: 'warn',
          message: `已过滤user记忆条目: "${m.characterName}"`,
        });
      }
      return !isUser;
    });

    // ⭐ 增量模式：不合并旧核心，直接存储本轮 AI 输出的 delta
    // 核心记忆的累积合并在 assembledSummary 中读取时完成
    for (const mem of summary.characterMemories) {
      mem.recentMemories = (mem.recentMemories || []).slice(0, 8);
      // 如果 JSON 解析路径已设置 orderedNewMemories（AI原始顺序），保留不重建
      if (!(mem as any).orderedNewMemories || (mem as any).orderedNewMemories.length === 0) {
        const orderedItems: Array<{ text: string; isCore: boolean; time?: string }> = [];
        for (const c of (mem.coreMemories || [])) {
          const t = typeof c === 'string' ? c : (c as any)?.text || '';
          if (t) orderedItems.push({ text: t, isCore: true, time: (c as any)?.time });
        }
        for (const r of mem.recentMemories) {
          orderedItems.push({ text: r, isCore: false });
        }
        (mem as any).orderedNewMemories = orderedItems;
      }
    }
    return summary;
  }

  /**
   * 增量存储：每条 summary 只存本轮新增内容，不再存合并后的全集。
   * 旧格式（_summaryDeltaFormat=false）首次调用时自动迁移。
   */
  function addSummary(summary: GrandSummary, upToMessageId?: number, coveredMessageIds?: number[]) {
    // ── 旧格式迁移：旧版每条 summary 都是全量快照，只保留最后一条作为基础 delta ──
    if (!(chatData.value as any)._summaryDeltaFormat) {
      const oldCount = chatData.value.summaries.length;
      if (oldCount > 0) {
        // 只保留最后一条（已包含所有合并信息），其余丢弃（都是重复数据）
        chatData.value.summaries = [chatData.value.summaries[oldCount - 1]];
        pushCodeLog({
          id: _codeLogIdCounter++,
          timestamp: new Date().toISOString(),
          module: '存储',
          level: 'info',
          message: `大总结存储已迁移为增量格式 (旧版 ${oldCount} 条 → 1 条基础delta)`,
        });
      }
      (chatData.value as any)._summaryDeltaFormat = true;
    }

    prepareSummaryForCommit(summary);

    const normalizedCoveredIds = coveredMessageIds ?? getCapturedContentMessageIds(chatData.value.capturedContents);
    summary.coveredMessageIds = normalizedCoveredIds;
    summary.upToMessageId =
      upToMessageId ?? normalizedCoveredIds[normalizedCoveredIds.length - 1] ?? chatData.value.lastSummaryAtMessageId;

    const oldLastId = chatData.value.lastSummaryAtMessageId;
    chatData.value.summaries.push(summary);
    // ★ 失败占位（isFailed=true）只占位不推进游标，保证下次自动触发/手动重试覆盖同一批楼层
    if (!summary.isFailed) {
      chatData.value.lastSummaryAtMessageId = Math.max(oldLastId, summary.upToMessageId ?? 0);
      chatData.value.characterMemories = summary.characterMemories;
    }


    // 立即持久化（AI 生成后关键操作，需立即落盘）
    forcePersist();
    // 结构性变化：重建 assembledSummary
    rebuildAssembled();
  }

  /** 获取最新的原始 delta（写操作用） */
  function getLatestDelta(): GrandSummary | undefined {
    return chatData.value.summaries[chatData.value.summaries.length - 1];
  }

  /** 组装增量 delta 为完整大总结视图（纯函数，不含响应式） */
  /** 组装增量 delta 为完整大总结视图（纯函数，不含响应式） */
  function buildAssembledSummary(additionalSummaries: GrandSummary[] = []): GrandSummary | undefined {
    // ★ 失败占位（isFailed=true）不参与组装：其 rawText="总结失败" 空 timeline/记忆
    // 一旦进入组装会污染 Section1 与 last delta，故先剔除
    const stored = chatData.value.summaries.filter(s => !s.isFailed);
    const deltas = additionalSummaries.length > 0
      ? [
          ...((chatData.value as any)._summaryDeltaFormat ? stored : stored.slice(-1)),
          ...additionalSummaries.filter(s => !s.isFailed),
        ]
      : stored;
    if (deltas.length === 0) return undefined;

    // 旧格式（尚未迁移）：直接返回最后一条
    if (!(chatData.value as any)._summaryDeltaFormat && additionalSummaries.length === 0) {
      return deltas[deltas.length - 1];
    }

    const last = deltas[deltas.length - 1];

    // ═══ 组装叙事文本 (Section 1)：拼接所有 delta 的 Section 1 ═══
    const sections1: string[] = [];
    for (const d of deltas) {
      const parts = d.rawText.split(/---SECTION---/i);
      const s1 = (parts[0] || '').trim();
      if (s1) sections1.push(s1);
    }

    // ═══ 组装角色记忆 (Section 2)：累积合并所有 delta 的记忆 ═══
    // 手动编辑过的角色：跳过旧 delta 合并，直接使用最新 delta 的数据
    const manuallyEdited = new Set<string>();
    for (const mem of last.characterMemories) {
      if ((mem as any)._manuallyEdited) manuallyEdited.add(mem.characterName);
    }

    // 辅助：从 coreMemories（兼容旧 string[] 格式）提取 text
    function coreText(c: any): string {
      return typeof c === 'string' ? c : c?.text || '';
    }
    function existingCoreTexts(mem: CharacterMemory): Set<string> {
      return new Set((mem.coreMemories || []).map(c => coreText(c)).filter(Boolean));
    }

    const memMap = new Map<string, CharacterMemory>();
    for (const d of deltas) {
      for (const mem of d.characterMemories) {
        // 手动编辑过的角色：只在最新 delta 中处理一次，跳过旧 delta
        if (manuallyEdited.has(mem.characterName) && d !== last) continue;
        const existing = memMap.get(mem.characterName);
        if (existing && !manuallyEdited.has(mem.characterName)) {
          // 核心去重追加，近期替换
          const existTexts = existingCoreTexts(existing);
          const newCores = ((mem.coreMemories || []) as any[]).filter(
            c => !existTexts.has(coreText(c)),
          ) as CoreMemoryItem[];
          existing.coreMemories = [...existing.coreMemories, ...newCores];
          existing.recentMemories = mem.recentMemories;
          if (mem.keywords?.length) existing.keywords = mem.keywords;
          if (mem.aliases?.length) existing.aliases = mem.aliases;
          if (mem.attitude) existing.attitude = mem.attitude;
        } else {
          memMap.set(mem.characterName, {
            ...mem,
            coreMemories: [...(mem.coreMemories || [])],
            recentMemories: [...mem.recentMemories],
          });
        }
      }
    }
    const allCharMems = [...memMap.values()];
    const section2 = buildMemorySectionText(allCharMems);

    // ═══ NSFW (Section 3)：只用最后一条 delta 的 ═══
    const lastParts = last.rawText.split(/---SECTION---/i);
    const section3 = (lastParts[2] || '').trim() || '[NSFW记录]\n无NSFW内容';

    // ═══ 时间线：拼接所有 delta（新版覆盖旧版同key事件） ═══
    const allTimeline: TimelineEvent[] = [];
    const eventIndex = new Map<string, number>(); // key → index in allTimeline

    for (const d of deltas) {
      for (const evt of d.timeline) {
        const key = `${evt.time}|${evt.event.slice(0, 30)}`;
        const existingIdx = eventIndex.get(key);

        if (existingIdx !== undefined) {
          // 同名事件：新版数据覆盖（可能 ongoing→completed 状态变化）
          allTimeline[existingIdx] = { ...evt, summaryVersion: d.version };
        } else {
          allTimeline.push({ ...evt, summaryVersion: d.version });
          eventIndex.set(key, allTimeline.length - 1);
        }
      }
    }

    // ═══ 手动编辑覆盖：应用用户对时间线的修改 ═══
    const overrides = chatData.value.timelineOverrides || {};
    for (const [key, ov] of Object.entries(overrides)) {
      if (ov._deleted) {
        // 删除事件
        const delIdx = allTimeline.findIndex(e => `${e.time}|${e.event.slice(0, 30)}` === key);
        if (delIdx >= 0) allTimeline.splice(delIdx, 1);
        continue;
      }
      const existIdx = allTimeline.findIndex(e => `${e.time}|${e.event.slice(0, 30)}` === key);
      if (existIdx >= 0) {
        // 更新已有事件
        allTimeline[existIdx] = { ...allTimeline[existIdx], ...ov };
      } else {
        // 用户新增的事件
        const { _deleted, ...newEvt } = ov as any;
        allTimeline.push(newEvt as TimelineEvent);
      }
    }

    // ═══ 角色表格：取最后一条 ═══
    const charTable =
      last.characterTable.length > 0
        ? last.characterTable
        : allCharMems.map(m => ({
            name: m.characterName,
            aliases: m.aliases,
            identity: '',
            relationship: '',
            status: '',
          }));

    const lastSection1 = (last.rawText.split(/---SECTION---/i)[0] || '').trim() || '[剧情摘要]';

    const fullRawText = [
      lastSection1,
      '---SECTION---',
      section2 || '[角色记忆]',
      '---SECTION---',
      section3,
    ].join('\n');

    return {
      version: last.version,
      generatedAt: last.generatedAt,
      memoryBundleId: last.memoryBundleId,
      rebuildTransactionId: last.rebuildTransactionId,
      upToMessageId: last.upToMessageId,
      coveredMessageIds: last.coveredMessageIds,
      rawText: fullRawText,
      characterMemories: allCharMems,
      timeline: allTimeline,
      characterTable: charTable,
    };
  }

  /** 只预览额外 delta 的组装结果，不写 store；批量重建用于续接下一批上下文。 */
  function previewSummarySequence(additionalSummaries: GrandSummary[]): GrandSummary | undefined {
    return buildAssembledSummary(additionalSummaries);
  }

  /**
   * 批量重建激活后的单次投影：选区内旧 delta 一次性替换，最后只持久化一次。
   * 世界书记忆仓是权威数据；这里是兼容现有 UI/注入链的热投影。
   */
  function replaceSummaryRangeAtomically(
    floorStart: number,
    floorEnd: number,
    incomingSummaries: GrandSummary[],
  ): void {
    const start = Math.max(0, Math.floor(floorStart));
    const end = Math.max(start, Math.floor(floorEnd));
    const existingKeys = new Set<string>();
    const incoming = incomingSummaries
      .filter(summary => !summary.isFailed)
      .map(summary => prepareSummaryForCommit(summary))
      .filter(summary => {
        const key = summary.memoryBundleId || `${summary.rebuildTransactionId || ''}|${summary.version}`;
        if (existingKeys.has(key)) return false;
        existingKeys.add(key);
        return true;
      });
    const incomingBundleIds = new Set(incoming.map(summary => summary.memoryBundleId).filter(Boolean));
    const overlapsRange = (summary: GrandSummary): boolean => {
      const covered = (summary.coveredMessageIds ?? []).filter(Number.isFinite);
      if (covered.length > 0) return covered.some(floor => floor >= start && floor <= end);
      const upTo = summary.upToMessageId;
      return Number.isFinite(upTo) && Number(upTo) >= start && Number(upTo) <= end;
    };
    const retained = chatData.value.summaries.filter(summary => (
      !overlapsRange(summary)
      && (!summary.memoryBundleId || !incomingBundleIds.has(summary.memoryBundleId))
    ));
    chatData.value.summaries = [...retained, ...incoming]
      .sort((left, right) => (
        (left.upToMessageId ?? -1) - (right.upToMessageId ?? -1)
        || left.version - right.version
      ));
    (chatData.value as any)._summaryDeltaFormat = true;
    const latest = [...chatData.value.summaries].reverse().find(summary => !summary.isFailed);
    chatData.value.lastSummaryAtMessageId = latest?.upToMessageId ?? 0;
    if (latest) chatData.value.characterMemories = latest.characterMemories;
    forcePersist();
    rebuildAssembled();
  }

  /**
   * 原始聊天从某楼层开始变化时，移除所有依赖该楼层或更后来源的热总结投影。
   * 记忆仓作废必须先完成；本方法只负责 mainStore/UI，不能单独当作事实事务。
   */
  function invalidateSummaryProjectionsFromFloor(floor: number): number {
    const normalizedFloor = Math.max(0, Math.floor(floor));
    const dependsOnChangedFloor = (summary: GrandSummary): boolean => {
      const covered = (summary.coveredMessageIds ?? []).filter(Number.isFinite);
      if (covered.length > 0) return covered.some(messageId => messageId >= normalizedFloor);
      return Number(summary.upToMessageId ?? -1) >= normalizedFloor;
    };
    const removed = chatData.value.summaries.filter(dependsOnChangedFloor);
    const removedHistory = chatData.value.summaryHistory.filter(dependsOnChangedFloor);
    if (removed.length === 0 && removedHistory.length === 0) return 0;

    chatData.value.summaries = chatData.value.summaries.filter(summary => !dependsOnChangedFloor(summary));
    chatData.value.summaryHistory = chatData.value.summaryHistory.filter(summary => !dependsOnChangedFloor(summary));
    const removedVersions = new Set([...removed, ...removedHistory].map(summary => summary.version));
    chatData.value.dynamicProfiles = chatData.value.dynamicProfiles.filter(
      profile => !removedVersions.has(profile.basedOnSummaryVersion),
    );
    if (chatData.value.itemMemories?.length) {
      for (const version of removedVersions) {
        chatData.value.itemMemories = removeItemHistoryByVersion(chatData.value.itemMemories, version);
      }
    }
    // NSFW 独立热表当前没有来源版本，无法安全保留受影响范围；从原始聊天重建优于继续注入陈旧状态。
    chatData.value.nsfwMemories = [];

    const latest = [...chatData.value.summaries].reverse().find(summary => !summary.isFailed);
    chatData.value.lastSummaryAtMessageId = latest?.upToMessageId ?? -1;
    chatData.value.characterMemories = latest?.characterMemories ?? [];
    forcePersist({ settings: false });
    rebuildAssembled();
    return removed.length + removedHistory.length;
  }

  // ⭐ 缓存化的 assembledSummary：shallowRef + 手动失效，避免编辑时全量重算
  const assembledSummary = shallowRef<GrandSummary | undefined>(undefined);

  /** 全量重建 assembledSummary（结构性变化时调用：新增总结、合并角色、回退等） */
  function rebuildAssembled() {
    try {
      assembledSummary.value = buildAssembledSummary();
    } catch (e) {
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '存储',
        level: 'error',
        message: '组装失败',
        detail: String(e),
      });
      assembledSummary.value = undefined;
    }
    _fusedCache.clear();
  }

  /** 确保缓存已构建（惰性初始化：首次访问时才构建，避免 store 创建时崩溃） */
  function ensureAssembled() {
    if (assembledSummary.value === undefined && chatData.value.summaries.length > 0) {
      try {
        assembledSummary.value = buildAssembledSummary();
      } catch (e) {
        pushCodeLog({
          id: _codeLogIdCounter++,
          timestamp: new Date().toISOString(),
          module: '存储',
          level: 'error',
          message: '初始组装失败',
        });
      }
    }
  }

  /** 轻量触发响应式（UI 编辑后调用：数据已通过引用共享更新，只需通知组件重渲染） */
  function touchAssembled() {
    ensureAssembled();
    const cur = assembledSummary.value;
    if (cur) {
      assembledSummary.value = { ...cur };
    }
  }

  /** 获取最新的完整大总结视图（读操作用，自动组装 delta） */
  function getLatestSummary(): GrandSummary | undefined {
    ensureAssembled();
    return assembledSummary.value;
  }

  function getCoveredFloorsDisplay(): string {
    const summary = getLatestSummary();
    if (!summary?.coveredMessageIds?.length) return '';
    const ids = [...summary.coveredMessageIds].sort((a, b) => a - b);
    return ` (#${ids[0]}${ids.length > 1 ? `-#${ids[ids.length - 1]}` : ''}, ${ids.length}层)`;
  }

  function rollbackSummary(force = false, saveToHistory = true): GrandSummary | undefined {
    if (!force && chatData.value.summaries.length <= 1) {
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '存储',
        level: 'info',
        message: '无法撤回，至少保留一条总结',
      });
      return undefined;
    }
    const removed = chatData.value.summaries.pop();
    if (removed && saveToHistory) {
      chatData.value.summaryHistory.push(removed);
    }
    const previousSummary = getLatestSummary();
    chatData.value.lastSummaryAtMessageId = previousSummary?.upToMessageId ?? 0;

    if (removed) {
      chatData.value.dynamicProfiles = chatData.value.dynamicProfiles.filter(
        profile => profile.basedOnSummaryVersion !== removed.version,
      );
      // 撤回物品记忆
      if (chatData.value.itemMemories?.length) {
        chatData.value.itemMemories = removeItemHistoryByVersion(chatData.value.itemMemories, removed.version);
      }
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '存储',
        level: 'info',
        message: `已回退大总结 v${removed.version}`,
      });
    }

    doPersist();
    rebuildAssembled();
    return removed;
  }

  function restoreLastSummary(): GrandSummary | undefined {
    if (chatData.value.summaryHistory.length === 0) {
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '存储',
        level: 'info',
        message: '没有可恢复的大总结',
      });
      return undefined;
    }
    const restored = chatData.value.summaryHistory.pop()!;
    chatData.value.summaries.push(restored);
    chatData.value.lastSummaryAtMessageId = Math.max(
      chatData.value.lastSummaryAtMessageId,
      restored.upToMessageId ?? 0,
    );
    doPersist();
    rebuildAssembled();
    pushCodeLog({
      id: _codeLogIdCounter++,
      timestamp: new Date().toISOString(),
      module: '存储',
      level: 'info',
      message: `已恢复大总结 v${restored.version}`,
    });
    return restored;
  }

  function getHiddenFloors(): HiddenFloor[] {
    return getHiddenFloorsFromChat();
  }

  function updateSummaryRawText(version: number, newRawText: string): boolean {
    const idx = chatData.value.summaries.findIndex(s => s.version === version);
    if (idx === -1 || !newRawText.trim()) return false;
    const summary = chatData.value.summaries[idx];

    try {
      const parsed: ParsedSummary = parseSummaryOutput(newRawText, version);

      // 校验：如果解析后角色记忆为空但原本有数据，保留旧角色记忆（用户可能只编辑了剧情摘要）
      const memsEmpty = parsed.characterMemories.length === 0 && summary.characterMemories.length > 0;
      if (memsEmpty) {
        pushCodeLog({
          id: _codeLogIdCounter++,
          timestamp: new Date().toISOString(),
          module: '存储',
          level: 'warn',
          message: '角色记忆解析为空，保留旧角色记忆',
        });
      }

      summary.rawText = newRawText;
      summary.timeline = parsed.timeline;
      for (const event of summary.timeline || []) {
        if (event.triggers?.characters) {
          event.triggers.characters = resolveKnownCharacterNames(event.triggers.characters, true);
        }
      }
      if (!memsEmpty) {
        summary.characterMemories = normalizeIncomingCharacterMemories(parsed.characterMemories);
        summary.characterTable = normalizeIncomingCharacterTable(parsed.characterTable);
      }

      // 同步 nsfwMemories（偏好+行为覆盖，其余增量合并）
      if (parsed.nsfwMemories && parsed.nsfwMemories.length > 0) {
        const mergeSet = (target: string[], source: string[]) => {
          const exist = new Set(target);
          for (const s of source) { if (!exist.has(s)) target.push(s); }
        };
        for (const mem of parsed.nsfwMemories) {
          mem.characterName = resolveKnownCharacterName(mem.characterName, true);
          const existing = chatData.value.nsfwMemories.find(m =>
            normalizeMemoryCharacterName(m.characterName) === normalizeMemoryCharacterName(mem.characterName),
          );
          if (existing) {
            mergeSet(existing.sensitivePoints, mem.sensitivePoints);
            mergeSet(existing.memories, mem.memories);
            existing.preferences = mem.preferences;
            existing.behaviors = mem.behaviors;
            existing.lastUpdatedAt = new Date().toISOString();
          } else {
            chatData.value.nsfwMemories.push(mem);
          }
        }
      }


      // 强制替换 summary 对象引用触发 Vue 响应式
      chatData.value.summaries[idx] = { ...summary };
      // 强制持久化：当前聊天写回自己的聊天变量，STABLE_ID 只保留全局设置
      allChatsData.value[currentChatId] = klona(chatData.value);
      writeChatScopeCurrent(currentChatId, chatData.value);
      writeStableSettings(scriptData.value);
      rebuildAssembled();
      return true;
    } catch (error) {
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '存储',
        level: 'error',
        message: '重新解析失败，保留原结构',
      });
      return false;
    }
  }

  // ========== 时间线手动编辑 ==========

  /** 获取事件的唯一 key */
  function getTimelineEventKey(evt: TimelineEvent): string {
    return `${evt.time}|${evt.event.slice(0, 30)}`;
  }

  /** 更新/新增时间线事件的手动覆盖 */
  function updateTimelineOverride(key: string, event: TimelineEvent & { _deleted?: boolean }) {
    chatData.value.timelineOverrides = {
      ...chatData.value.timelineOverrides,
      [key]: event,
    };
    doPersist();
  }

  /** 删除时间线事件的手动覆盖 */
  function removeTimelineOverride(key: string) {
    const newOverrides = { ...chatData.value.timelineOverrides };
    const deltas = chatData.value.summaries;
    const existsInDelta = deltas.some(d => d.timeline.some(e => `${e.time}|${e.event.slice(0, 30)}` === key));
    if (existsInDelta) {
      newOverrides[key] = { _deleted: true } as any;
    } else {
      delete newOverrides[key];
    }
    chatData.value.timelineOverrides = newOverrides;
    doPersist();
    rebuildAssembled();
  }

  function removeTimelineEvent(evt: TimelineEvent): boolean {
    const key = getTimelineEventKey(evt);
    let removed = false;
    const removeFrom = (summary: GrandSummary | undefined | null) => {
      if (!summary?.timeline) return false;
      const idx = summary.timeline.findIndex(e => getTimelineEventKey(e) === key);
      if (idx < 0) return false;
      summary.timeline.splice(idx, 1);
      return true;
    };
    if (typeof evt.summaryVersion === 'number') {
      removed = removeFrom(chatData.value.summaries.find(s => s.version === evt.summaryVersion));
    }
    if (!removed) {
      for (let i = chatData.value.summaries.length - 1; i >= 0; i--) {
        if (removeFrom(chatData.value.summaries[i])) { removed = true; break; }
      }
    }
    const newOverrides = { ...chatData.value.timelineOverrides };
    delete newOverrides[key];
    if (!removed) newOverrides[key] = { ...evt, _deleted: true } as any;
    chatData.value.timelineOverrides = newOverrides;
    doPersist();
    rebuildAssembled();
    return removed;
  }
  function replaceTimelineOverride(oldKey: string, event: TimelineEvent) {
    const overrides = { ...chatData.value.timelineOverrides };
    const newKey = getTimelineEventKey(event);

    // 解析实际的存储 key：oldKey 可能不直接是 override key（如之前编辑过改了时间）
    let storageKey = oldKey;
    if (!overrides[oldKey] || overrides[oldKey]?._deleted) {
      for (const [k, v] of Object.entries(overrides)) {
        if (!v._deleted && getTimelineEventKey(v as TimelineEvent) === oldKey) {
          storageKey = k;
          break;
        }
      }
    }

    // 始终存在 storageKey 上，装配时能匹配到 delta 原始位置（不会跑到末尾）
    overrides[storageKey] = event;
    // 清理可能残留的旧 key 条目
    if (oldKey !== storageKey) delete overrides[oldKey];
    if (newKey !== storageKey && newKey !== oldKey) delete overrides[newKey];

    chatData.value.timelineOverrides = overrides;
    doPersist();
    rebuildAssembled();
  }

  /** 新增时间线事件（用户手动添加） */
  function addTimelineEvent(event: TimelineEvent) {
    const key = getTimelineEventKey(event);
    chatData.value.timelineOverrides = {
      ...chatData.value.timelineOverrides,
      [key]: event,
    };
    doPersist();
    rebuildAssembled();
  }

  // ========== 动态人设相关 ==========

  function updateDynamicProfile(profile: DynamicProfile) {
    profile.characterName = resolveKnownCharacterName(profile.characterName, true);
    // 拦截污染数据：内容为角色记忆格式的拒绝写入
    if (/^(别名[:：]|态度[:：]|关键词[:：]|- \[)/m.test(profile.dynamicContent?.trim() || '')) {
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '存储',
        level: 'warn',
        message: `拒绝写入污染的动态人设: ${profile.characterName}`,
      });
      return;
    }
    // 无新变化 / 无实质内容 → 不覆盖已有记录
    const trimmed = profile.dynamicContent?.trim() || '';
    if (/^(无新变化|行为模式与原人设一致|无明显变化|暂无变化|无变化|无)\s*$/i.test(trimmed)) {

      return;
    }
    const existingIdx = chatData.value.dynamicProfiles.findIndex(
      p => normalizeMemoryCharacterName(p.characterName) === normalizeMemoryCharacterName(profile.characterName),
    );
    if (existingIdx >= 0) {
      const existing = chatData.value.dynamicProfiles[existingIdx];
      const oldVersion = existing.basedOnSummaryVersion;
      chatData.value.dynamicProfiles[existingIdx] = {
        ...existing,
        dynamicContent: profile.dynamicContent,
        lastUpdatedAt: new Date().toISOString(),
        basedOnSummaryVersion: oldVersion, // 保留首次创建的版本号
      };
    } else {
      chatData.value.dynamicProfiles.push(profile);
    }
  }

  function removeDynamicProfile(characterName: string) {
    const target = normalizeMemoryCharacterName(resolveKnownCharacterName(characterName, true));
    chatData.value.dynamicProfiles = chatData.value.dynamicProfiles.filter(
      p => normalizeMemoryCharacterName(p.characterName) !== target,
    );
  }

  // ========== 记忆库相关 ==========

  /**
   * 融合记忆：运行时遍历所有版本，输出完整的融合列表
   * - 近期窗口（最近 N 版本）：核心+近期全部注入
   * - 远期窗口：核心记忆语义召回（有queryEmb时）或全量注入（无queryEmb时）
   * @param characterName 角色名
   * @param recentVersions 最近几个版本窗口（默认用 settings 中的值）
   * @param queryEmb 查询向量（提供时对远期核心做语义召回）
   * @param recallLimit 召回上限（默认用角色设置或全局 memoryRecallLimit）
   */
  // ⭐ getFusedMemories 缓存：避免 UI 渲染时重复计算（仅缓存无 queryEmb 的调用）
  const _fusedCache = new Map<string, {
    summariesLen: number;
    recentVer: number;
    recallLim: number;
    wpLen: number;
    wpFloor: number;
    result: any[];
  }>();

  function getFusedMemories(
    characterName: string,
    recentVersions?: number,
    queryEmb?: number[],
    recallLimit?: number,
    queryText?: string,
  ): Array<{ text: string; isCore: boolean; time?: string; sourceVersion?: number; source?: string; id?: string; floor?: number }> {
    const versions = recentVersions ?? scriptData.value.settings.recentMemoryVersions ?? 1;
    const summaries = chatData.value.summaries;
    const wpFloor = getWorldProgressMemoryActiveFloor();
    const wpLen = chatData.value.worldProgressMemories?.length || 0;

    // 缓存命中检查（仅无 queryEmb 时，即 UI 渲染路径）
    if (!queryEmb) {
      const cacheKey = normalizeMemoryCharacterName(characterName);
      const recallLim = recallLimit ?? (scriptData.value.settings as any).memoryRecallLimit ?? 10;
      const cached = _fusedCache.get(cacheKey);
      if (
        cached
        && cached.summariesLen === summaries.length
        && cached.recentVer === versions
        && cached.recallLim === recallLim
        && cached.wpLen === wpLen
        && cached.wpFloor === wpFloor
      ) {
        return cached.result;
      }
      // 缓存未命中，计算后存入
      const result = _computeFusedMemories(characterName, versions, queryEmb, recallLimit, queryText, summaries);
      _fusedCache.set(cacheKey, { summariesLen: summaries.length, recentVer: versions, recallLim: recallLim, wpLen, wpFloor, result });
      return result;
    }

    return _computeFusedMemories(characterName, versions, queryEmb, recallLimit, queryText, summaries);
  }

  /** getFusedMemories 的实际计算体 */
  function _computeFusedMemories(
    characterName: string,
    versions: number,
    queryEmb: number[] | undefined,
    recallLimit: number | undefined,
    queryText: string | undefined,
    summaries: any[],
  ): Array<{ text: string; isCore: boolean; time?: string; sourceVersion?: number; source?: string; id?: string; floor?: number }> {
    // versions=0 → 仅远期核心，跳过近期窗口（供 reranker 拆分使用）
    const recentStart = versions === 0 ? summaries.length : Math.max(0, summaries.length - Math.max(1, versions));

    // 查找角色时归一化名称匹配（Qingyue (清月) ↔ Qingyue），并兼容 aliases。
    const normName = normalizeMemoryCharacterName(characterName);
    function findMem(summary: any) {
      if (!summary?.characterMemories) return undefined;
      return summary.characterMemories.find((m: any) => {
        const names = [m.characterName, ...(m.aliases || [])].map(normalizeMemoryCharacterName);
        return names.includes(normName);
      });
    }

    // ⭐ 手动编辑过的角色：只用最新版本的 orderedNewMemories，完全跳过所有旧版本
    const latestMem = findMem(summaries[summaries.length - 1]);
    if (latestMem && (latestMem as any)._manuallyEdited === true) {
      const ordered = (latestMem as any).orderedNewMemories as
        | Array<{ text: string; isCore: boolean; time?: string }>
        | undefined;
      const srcVer = summaries[summaries.length - 1].version;
      const base = (ordered || []).map(item => ({ text: item.text, isCore: item.isCore, time: item.time, sourceVersion: srcVer }));
      return versions === 0 ? [] : appendActiveWorldProgressMemories(characterName, base);
    }

    // 获取角色召回上限
    const limit = recallLimit ?? (latestMem as any)?.recallLimit ?? scriptData.value.settings.memoryRecallLimit ?? 10;

    // 1. 收集旧窗口的核心（去重，保持首次出现顺序，同时收集 embedding + 版本号）
    type OldCore = { text: string; embedding?: number[]; time?: string; versionIndex: number };
    const oldCores: OldCore[] = [];
    const oldCoreSet = new Set<string>();
    for (let i = 0; i < recentStart; i++) {
      const mem = findMem(summaries[i]);
      if (!mem) continue;
      const ordered = (mem as any).orderedNewMemories as
        | Array<{ text: string; isCore: boolean; time?: string }>
        | undefined;
      if (!ordered) continue;
      // 构建 coreMemories 的 text→embedding/时间 映射
      const embMap = new Map<string, number[]>();
      const timeMap = new Map<string, string>();
      const coreItems: any[] = mem.coreMemories || [];
      for (const ci of coreItems) {
        const t = typeof ci === 'string' ? ci : ci?.text || '';
        if (t && ci?.embedding) embMap.set(t, ci.embedding);
        if (t && ci?.time) timeMap.set(t, ci.time);
      }
      for (const item of ordered) {
        if (item.isCore && !oldCoreSet.has(item.text)) {
          oldCoreSet.add(item.text);
          oldCores.push({
            text: item.text,
            embedding: embMap.get(item.text),
            time: item.time || timeMap.get(item.text),
            versionIndex: summaries[i].version, // 记录记忆所属的总结版本号
          });
        }
      }
    }

    // 2. 远期核心：语义召回 or 全量
    // 检查角色是否关闭召回（recallEnabled=false → 全量注入）
    const recallOn = (latestMem as any)?.recallEnabled !== false;
    let oldCoreResult: Array<{ text: string; isCore: boolean; time?: string; sourceVersion?: number }>;
    if (queryEmb && recallOn && oldCores.some(c => c.embedding)) {
      // ═══ 混合检索路径（语义 + 词汇匹配 + 时间衰减） ═══
      const hybridW = scriptData.value.settings.hybridWeight ?? 0.7;
      const timeDecayOn = scriptData.value.settings.timeDecayEnabled !== false;
      const decayRate = scriptData.value.settings.timeDecayRate ?? 0.05;
      const decayBoost = scriptData.value.settings.timeDecayBoost ?? 0.3;
      const totalVersions = summaries.length;

      // 候选放大（供重排阶段筛选）
      const candidateMult = scriptData.value.settings.rerankEnabled
        ? (scriptData.value.settings.rerankCandidateMultiplier ?? 3)
        : 1;
      const candidateLimit = Math.max(limit, Math.min(oldCores.length, limit * candidateMult));

      const scored = oldCores.map(c => {
        let denseSim = 0;
        if (c.embedding && queryEmb) {
          denseSim = cosineSimilarity(c.embedding, queryEmb);
        }
        // 词汇匹配分量（字符二元组 Jaccard）
        const lexSim = queryText ? charBigramSimilarity(queryText, c.text) : 0;
        // 混合分数：有 embedding 的用加权混合，无 embedding 的纯词汇
        let hybridSim = c.embedding ? hybridW * denseSim + (1 - hybridW) * lexSim : lexSim;
        // 时间衰减：越旧的记忆分数越低，但语义匹配度高的仍能胜出
        if (timeDecayOn) {
          const versionAge = totalVersions - 1 - c.versionIndex;
          const timeDecay = Math.exp(-decayRate * versionAge);
          const timeWeight = 1 + decayBoost * timeDecay;
          hybridSim *= timeWeight;
        }
        return { ...c, sim: hybridSim, denseSim, lexSim };
      });
      // 有 embedding 的按混合分排前，无 embedding 的放后面
      scored.sort((a, b) => {
        const aHas = a.embedding ? 1 : 0;
        const bHas = b.embedding ? 1 : 0;
        if (aHas !== bHas) return bHas - aHas;
        return b.sim - a.sim;
      });

      // 第一轮粗筛：取候选池
      const candidates = scored.slice(0, candidateLimit);

      // 第一轮粗筛结果（重排在注入层异步完成，此处只取候选池）
      const topN = candidates.slice(0, Math.max(1, limit));

      oldCoreResult = topN.map(c => ({ text: c.text, isCore: true, time: c.time, sourceVersion: c.versionIndex }));
      const withoutEmb = oldCores.length - oldCores.filter(c => c.embedding).length;
      const timeDecayInfo = timeDecayOn ? ` 时间衰减:开(率${decayRate},增强${decayBoost})` : '';
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '记忆召回',
        level: 'info',
        message: `${characterName}: 远期核心 ${oldCores.length} 条 → 召回 ${oldCoreResult.length} 条 (混合权重=${(hybridW * 100).toFixed(0)}%语义/${((1 - hybridW) * 100).toFixed(0)}%词汇 有向量:${oldCores.length - withoutEmb} 无向量:${withoutEmb}${timeDecayInfo})`,
      });
    } else {
      // ═══ 全量路径（无 queryEmb / 无 embedding 数据 / 角色关闭召回） ═══
      if (!recallOn) {

      }
      oldCoreResult = oldCores.map(c => ({ text: c.text, isCore: true, time: c.time, sourceVersion: c.versionIndex }));
    }

    // 3. 输出：远期核心 + 近期窗口各版本按 AI 原序追加
    const result: Array<{ text: string; isCore: boolean; time?: string; sourceVersion?: number }> = [...oldCoreResult];

    for (let i = recentStart; i < summaries.length; i++) {
      const mem = findMem(summaries[i]);
      if (!mem) continue;
      const ordered = (mem as any).orderedNewMemories as
        | Array<{ text: string; isCore: boolean; time?: string }>
        | undefined;
      if (!ordered) continue;
      // 近期窗口内用 resultSet 去重（旧核心已占的条目跳过）
      const resultSet = new Set(result.map(r => r.text));
      for (const item of ordered) {
        if (resultSet.has(item.text)) continue; // 旧核心已有，跳过
        resultSet.add(item.text);
        result.push({
          text: item.text,
          isCore: item.isCore && !oldCoreSet.has(item.text),
          time: item.time,
          sourceVersion: summaries[i].version,
        });
      }
    }

    return versions === 0 ? result : appendActiveWorldProgressMemories(characterName, result);
  }

  function getWorldProgressMemoryActiveFloor(): number {
    const captured = chatData.value.capturedContents || [];
    const lastCaptured = captured.length > 0
      ? Math.max(...captured.map(c => Number(c.messageId ?? -1)))
      : -1;
    return Math.max(
      lastCaptured,
      chatData.value.lastWorldProgressFloor ?? -1,
      chatData.value.lastSmallSummaryFloor ?? -1,
      chatData.value.lastSummaryAtMessageId ?? -1,
      0,
    );
  }

  function getActiveWorldProgressMemories(
    characterName: string,
    floor: number = getWorldProgressMemoryActiveFloor(),
  ): WorldProgressMemory[] {
    const targetName = normalizeMemoryCharacterName(characterName);
    if (!targetName) return [];
    const seen = new Set<string>();
    const result: WorldProgressMemory[] = [];
    for (const mem of (chatData.value.worldProgressMemories || [])
      .filter(m =>
        normalizeMemoryCharacterName(m.characterName) === targetName
        && !(m as any).archivedInSummaryVersion,
      )
      .sort((a, b) => (a.floor ?? 0) - (b.floor ?? 0))) {
      const key = `${targetName}|${mem.text}`;
      if (!mem.text || seen.has(key)) continue;
      seen.add(key);
      result.push(mem);
    }
    return result;
  }

  function appendActiveWorldProgressMemories<T extends { text: string; isCore: boolean; time?: string }>(
    characterName: string,
    base: T[],
  ): Array<T | { text: string; isCore: boolean; time?: string; source: 'world_progress'; id: string; floor: number }> {
    const result: Array<T | { text: string; isCore: boolean; time?: string; source: 'world_progress'; id: string; floor: number }> = [...base];
    const seen = new Set(result.map(item => item.text));
    for (const mem of getActiveWorldProgressMemories(characterName)) {
      if (!mem.text || seen.has(mem.text)) continue;
      seen.add(mem.text);
      result.push({
        text: mem.text,
        isCore: false,
        time: mem.time,
        source: 'world_progress',
        id: mem.id,
        floor: mem.floor,
      });
    }
    return result;
  }

  function addWorldProgressMemories(record: WorldProgressRecord, floor?: number): number {
    if (!record || record.status !== 'ready') return 0;
    const baseFloor = floor ?? record.basedOnFloorRange?.end ?? getWorldProgressMemoryActiveFloor();
    const existing = new Set((chatData.value.worldProgressMemories || []).map(m =>
      `${normalizeMemoryCharacterName(m.characterName)}|${m.text}`,
    ));
    const additions: WorldProgressMemory[] = [];
    for (const c of record.advancedCharacters || []) {
      const memText = (c.memoryText || c.action || '').trim();
      const rawName = (c.characterName || '').trim();
      const characterName = resolveKnownCharacterName(rawName, true);
      if (!characterName || !memText) continue;
      c.characterName = characterName;

      // 拼接 result，并把该角色本名/别名替换成"我"（记忆是角色第一人称写的）
      let text = memText;
      if (c.result && c.result.trim()) {
        let r = c.result.trim();
        const mem = (chatData.value.characterMemories || []).find(m =>
          normalizeMemoryCharacterName(m.characterName) === normalizeMemoryCharacterName(characterName));
        const names = Array.from(new Set(
          [characterName, rawName, ...(mem?.aliases || [])]
            .filter(Boolean).map(s => s.trim()).filter(Boolean),
        ));
        names.sort((a, b) => b.length - a.length); // 长名优先，避免子串短路
        for (const n of names) {
          const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (esc) r = r.replace(new RegExp(esc, 'g'), '我');
        }
        text = `${memText}${r}`;
      }

      const key = `${normalizeMemoryCharacterName(characterName)}|${text}`;
      if (existing.has(key)) continue;
      existing.add(key);
      additions.push({
        id: `wpm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        characterName,
        text,
        time: record.currentTime || record.mainTimeline?.storyTime || record.generatedAt,
        floor: baseFloor,
        expiresAtFloor: baseFloor + WORLD_PROGRESS_MEMORY_TTL_FLOORS,
        source: 'world_progress',
        recordId: record.id,
      });
    }
    if (additions.length === 0) return 0;
    chatData.value.worldProgressMemories = [
      ...(chatData.value.worldProgressMemories || []),
      ...additions,
    ];
    dedupeWorldProgressMemories();
    _fusedCache.clear();
    touchAssembled();
    return additions.length;
  }

  function dedupeWorldProgressMemories(): void {
    const seen = new Set<string>();
    const result: WorldProgressMemory[] = [];
    for (const mem of chatData.value.worldProgressMemories || []) {
      const key = [
        normalizeMemoryCharacterName(mem.characterName),
        mem.text,
        (mem as any).archivedInSummaryVersion || '',
      ].join('|');
      if (!mem.characterName || !mem.text || seen.has(key)) continue;
      seen.add(key);
      result.push(mem);
    }
    chatData.value.worldProgressMemories = result;
  }

  function ensureWorldProgressMemoriesFromRecords(): number {
    let added = 0;
    for (const record of chatData.value.worldProgressRecords || []) {
      if (record?.status !== 'ready') continue;
      added += addWorldProgressMemories(record, record.basedOnFloorRange?.end);
    }
    if (added > 0) doPersist();
    return added;
  }

  function profileToBrief(profile?: CharacterProfile): string {
    if (!profile) return '';
    const parts = [
      profile.basicInfo?.identity ? `身份：${profile.basicInfo.identity}` : '',
      profile.basicInfo?.relationToUser ? `与主角关系：${profile.basicInfo.relationToUser}` : '',
      profile.colorPalette?.base ? `底色：${profile.colorPalette.base}` : '',
      profile.colorPalette?.primary ? `主色调：${profile.colorPalette.primary}` : '',
      profile.corePersonality?.surfaceDesire ? `表层欲望：${profile.corePersonality.surfaceDesire}` : '',
      profile.corePersonality?.deepLack ? `深层缺失：${profile.corePersonality.deepLack}` : '',
      profile.imagery ? `意象：${profile.imagery}` : '',
    ].filter(Boolean);
    return parts.join('；');
  }

  function getDynamicProfileV2Brief(characterName: string): string {
    const target = normalizeMemoryCharacterName(characterName);
    if (!target) return '';
    const profile = (chatData.value.dynamicProfilesV2 || []).find((p: any) =>
      normalizeMemoryCharacterName(p.characterName) === target,
    );
    if (!profile) return '';
    return [
      profile.factualState ? `当前事实：${String(profile.factualState).replace(/\s+/g, ' ').trim()}` : '',
      profile.dynamicProfile ? `动态人设：${String(profile.dynamicProfile).replace(/\s+/g, ' ').trim()}` : '',
    ].filter(Boolean).join('；').slice(0, 700);
  }

  function countTextMentions(text: string, terms: string[]): number {
    if (!text) return 0;
    const source = text.toLowerCase();
    let count = 0;
    for (const term of terms) {
      const normalized = (term || '').trim().toLowerCase();
      if (normalized.length < 2) continue;
      let index = source.indexOf(normalized);
      while (index !== -1) {
        count++;
        index = source.indexOf(normalized, index + normalized.length);
      }
    }
    return count;
  }

  function getLocationNameFromId(locId?: string): string {
    if (!locId) return '';
    const graph = chatData.value.knowledgeGraph;
    const loc = graph?.locations?.find(l => l.id === locId || l.name === locId);
    return loc?.name || locId;
  }

  function resolveCharacterLocationId(name: string): string | undefined {
    const map = chatData.value.characterLocations || {};
    const direct = map[name];
    if (direct) return direct;
    const norm = normalizeMemoryCharacterName(name);
    for (const [key, loc] of Object.entries(map)) {
      if (normalizeMemoryCharacterName(key) === norm) return loc;
    }
    const graphChar = chatData.value.knowledgeGraph?.characters?.find(c =>
      normalizeMemoryCharacterName(c.name) === norm || (c.aliases || []).some(a => normalizeMemoryCharacterName(a) === norm),
    );
    return graphChar?.location ? buildStableId(graphChar.location) : undefined;
  }

  function getLatestPresentFallback(currentFloor: number): Set<string> {
    const latest = (chatData.value.smallSummaries || [])
      .filter(s => (s.status === 'ready' || s.status === 'hidden-active') && (s.floorRange?.end ?? -1) <= currentFloor)
      .sort((a, b) => (b.floorRange?.end ?? -1) - (a.floorRange?.end ?? -1))[0];
    return new Set((latest?.presentCharacters || []).map(normalizeMemoryCharacterName).filter(Boolean));
  }

  function getLatestInteractingCharactersSet(currentFloor: number): Set<string> {
    const latest = (chatData.value.smallSummaries || [])
      .filter(s => (s.status === 'ready' || s.status === 'hidden-active') && (s.floorRange?.end ?? -1) <= currentFloor)
      .sort((a, b) => (b.floorRange?.end ?? -1) - (a.floorRange?.end ?? -1))[0];
    return new Set((latest?.interactingCharacters || []).map(normalizeMemoryCharacterName).filter(Boolean));
  }

  /** 取最近一条小总结里"角色→地点"明细，作为兜底判在场用（绕过 characterLocations 字典可能滞后）。返回 Map<normName, location> */
  function getLatestSmallSummaryCharacterLocations(currentFloor: number): Map<string, string> {
    const latest = (chatData.value.smallSummaries || [])
      .filter(s => (s.status === 'ready' || s.status === 'hidden-active') && (s.floorRange?.end ?? -1) <= currentFloor)
      .sort((a, b) => (b.floorRange?.end ?? -1) - (a.floorRange?.end ?? -1))[0];
    const map = new Map<string, string>();
    for (const cl of latest?.characterLocations || []) {
      const norm = normalizeMemoryCharacterName(cl.name);
      if (norm && cl.location) map.set(norm, cl.location);
    }
    return map;
  }

  function findLastWorldProgressFloorForCharacter(name: string): number {
    const target = normalizeMemoryCharacterName(name);
    let last = -1;
    for (const record of chatData.value.worldProgressRecords || []) {
      if (record.status !== 'ready') continue;
      if ((record.advancedCharacters || []).some(c => normalizeMemoryCharacterName(c.characterName) === target)) {
        last = Math.max(last, record.basedOnFloorRange?.end ?? -1);
      }
    }
    return last;
  }

  /**
   * 查找该角色上次「产出入场引导」时刻对应的推演尝试序号（worldProgressAttempts）。
   * 用于入场引导冷却A/B 判定：距上次入场引导经过了几次"推演尝试"——
   * 即使本次因为没候选/冷却被跳过没真推，只要 attempt 推进了，冷却就跟着递减。
   * 匹配容错：主名 + 别名（normalize 后），AI 输出别名也算同一条入场引导历史。
   * 旧记录没有 basedOnAttempt 时回退用 basedOnFloorRange.end 做兼容。
   */
  function findLastEntryHintAttemptForCharacter(name: string, aliases: string[] = []): number {
    const targets = new Set<string>();
    const add = (raw?: string) => {
      const k = normalizeMemoryCharacterName(raw);
      if (k) targets.add(k);
    };
    add(name);
    for (const a of aliases) add(a);
    if (targets.size === 0) return -1;
    let last = -1;
    let lastHasAttempt = false; // 最近一条匹配记录是否带 basedOnAttempt（旧记录没填视为 attempt 历史中断）
    for (const record of chatData.value.worldProgressRecords || []) {
      if (record.status !== 'ready') continue;
      const recName = normalizeMemoryCharacterName(record.entryHint?.characterName || '');
      if (!recName || !targets.has(recName)) continue;
      const hasAttempt = typeof record.basedOnAttempt === 'number';
      const a = hasAttempt ? record.basedOnAttempt! : (record.basedOnFloorRange?.end ?? -1);
      if (a > last) { last = a; lastHasAttempt = hasAttempt; }
    }
    // -1 = 从未产出入场引导；-2 = 有旧入场引导记录但缺少 attempt 序号（历史无效），调用方视为"已解封"
    if (last < 0) return -1;
    return lastHasAttempt ? last : -2;
  }

  /**
   * 统计角色「近期被推演次数」（仅统计近 TTL 楼层内的就绪记录出现次数）。
   * 用于推演疲劳衰减：被推得越多，距离优势越弱；超过 TTL 未被推演则疲劳自动恢复。
   */
  function countWorldProgressForCharacter(name: string, currentFloor: number): number {
    const target = normalizeMemoryCharacterName(name);
    let count = 0;
    const floorLow = currentFloor - WORLD_PROGRESS_MEMORY_TTL_FLOORS;
    for (const record of chatData.value.worldProgressRecords || []) {
      if (record.status !== 'ready') continue;
      const endF = record.basedOnFloorRange?.end ?? -1;
      if (endF < floorLow) continue; // 超出 TTL 的不再计疲劳
      if ((record.advancedCharacters || []).some(c => normalizeMemoryCharacterName(c.characterName) === target)) {
        count++;
      }
    }
    return count;
  }

  function makeCandidate(
    name: string,
    mem: CharacterMemory | undefined,
    currentFloor: number,
    manual = false,
  ): WorldProgressCandidate | null {
    const userName = getUserName();
    const normName = normalizeMemoryCharacterName(name);
    if (!normName) return null;
    if (normName === normalizeMemoryCharacterName(userName) || normName === 'user') return null;

    const profile = chatData.value.characterProfiles?.[name] || chatData.value.characterProfiles?.[normName];
    const fused = mem ? getFusedMemories(name, undefined, undefined, undefined, '') : [];

    const locId = resolveCharacterLocationId(name);
    const playerLocId = resolveCharacterLocationId(userName) || resolveCharacterLocationId('{{user}}');
    const presentFallback = getLatestPresentFallback(currentFloor);
    const interactingSet = getLatestInteractingCharactersSet(currentFloor);
    // 强在场：本轮正文实际互动出现 → 不论地点记录如何，都视为在场
    if (interactingSet.has(normName)) return null;
    // 兜底：用最新小总结 record.characterLocations 比对该角色与玩家是否同地点（绕过 characterLocations 字典可能滞后）
    const latestSSCharLocs = getLatestSmallSummaryCharacterLocations(currentFloor);
    if (latestSSCharLocs.size > 0) {
      const myLoc = latestSSCharLocs.get(normalizeMemoryCharacterName(userName));
      const theirLoc = latestSSCharLocs.get(normName);
      if (myLoc && theirLoc && myLoc === theirLoc) return null;
    }
    const isPresent = playerLocId && locId
      ? playerLocId === locId
      : presentFallback.has(normName);
    if (isPresent) return null;

    const aliases = Array.from(new Set([...(mem?.aliases || []), name].filter(Boolean)));
    const terms = aliases.length > 0 ? aliases : [name];
    let score = manual ? 1000 : 0;
    const reasons: string[] = [];

    if (manual) reasons.push('用户手动指定');
    if (mem) {
      score += 8;
      reasons.push('有角色记忆');
    }
    if (profile) {
      score += 6;
      reasons.push('有人设档案');
    }
    if (locId) score += 2;

    const recentRecords = (chatData.value.userInputRecords || []).slice(-DREAMTALK_RECORD_LIMIT);
    let previousAiMentioned = false;
    recentRecords.forEach((record, idx) => {
      const recencyBoost = 1 + idx / Math.max(1, recentRecords.length);
      const userMentions = countTextMentions(record.userInput || '', terms);
      const aiMentions = countTextMentions(record.aiResponse || '', terms);
      if (userMentions > 0) {
        score += userMentions * 18 * recencyBoost;
        reasons.push('用户近期提及');
      }
      if (previousAiMentioned && userMentions > 0) {
        score += 10 * recencyBoost;
        reasons.push('承接AI提及');
      }
      if (aiMentions > 0) score += Math.min(aiMentions, 3) * 3 * recencyBoost;
      previousAiMentioned = aiMentions > 0;
    });

    for (const summary of (chatData.value.smallSummaries || []).slice(-12)) {
      if ((summary.presentCharacters || []).some(n => normalizeMemoryCharacterName(n) === normName)) {
        score += 4;
      }
    }

    const lastProgress = findLastWorldProgressFloorForCharacter(name);
    if (lastProgress >= 0) {
      const age = currentFloor - lastProgress;
      if (age <= WORLD_PROGRESS_MEMORY_TTL_FLOORS / 2) {
        score -= 14;
        reasons.push('近期已推演降权');
      } else {
        score += Math.min(8, age / 4);
        reasons.push('较久未推演');
      }
    } else {
      score += 5;
      reasons.push('尚未推演');
    }

    // 距离加权：离玩家越近越容易推到（按知识图谱 connected 边 BFS 跳数）
    // 同地点（0 跳）已被在场过滤排除，实际最小跳数是 1（相邻连通地点）
    const graph = chatData.value.knowledgeGraph || null;
    if (graph && playerLocId && locId && playerLocId !== locId) {
      const hops = computeLocationHopDistance(graph, playerLocId, locId);
      if (Number.isFinite(hops) && hops > 0) {
        const proximityScore = Math.max(0, 12 - hops * 3); // 1跳+9, 2跳+6, 3跳+3, 4跳+0
        if (proximityScore > 0) {
          // 推演疲劳衰减：该角色近期被推得越多，距离优势越弱
          const pushCount = countWorldProgressForCharacter(name, currentFloor);
          const fatigueFactor = Math.pow(0.6, pushCount); // 推1次×0.6, 2次×0.36…
          score += proximityScore * fatigueFactor;
          if (hops <= 2) reasons.push(`近距加权(${hops}跳)`);
        }
      }
    }

    if (!profile && fused.length <= 1) {
      score -= 6;
      reasons.push('普通NPC降权');
    }

    return {
      characterName: name,
      aliases: mem?.aliases || [],
      attitude: mem?.attitude,
      locationId: locId,
      locationName: getLocationNameFromId(locId),
      score,
      reason: Array.from(new Set(reasons)).slice(0, 4).join('、'),
      manual,
      memories: fused.map(item => item.text).filter(Boolean).slice(-10),
      profileBrief: profileToBrief(profile),
    };
  }

  function selectWorldProgressCandidates(
    currentFloor: number,
    manualChars?: string,
    limit = 2,
    currentAttempt?: number,
  ): WorldProgressCandidate[] {
    // 入场引导冷却A：角色产出入场引导后 N 次"推演尝试"内不再被推演（取代旧的永久 excludeNorm）
    const entryCooldownAttempts = scriptData.value.settings.entryCooldownRounds || 1;
    // 入场引导冷却B：距上次入场引导 < entryHintCooldownRounds 次推演尝试 → 该角色这轮仍可推演但禁入场引导
    const entryHintCooldownAttempts = scriptData.value.settings.entryHintCooldownRounds || 3;
    // 当前推演尝试序号：取传入参数；回退到 store 里 worldProgressAttempts；若仍是 -1（尚未触发过），用 currentFloor 作起点对齐（避免与老记录 basedOnFloorRange.end 量级错位）
    const storedAttempts = chatData.value.worldProgressAttempts ?? -1;
    const attempt = typeof currentAttempt === 'number' && currentAttempt >= 0
      ? currentAttempt
      : (storedAttempts >= 0 ? storedAttempts : currentFloor);
    const latest = getLatestSummary();
    const memByNorm = new Map<string, CharacterMemory>();
    const registerMemory = (mem?: CharacterMemory) => {
      if (!mem?.characterName) return;
      const names = [mem.characterName, ...(mem.aliases || [])];
      for (const raw of names) {
        const norm = normalizeMemoryCharacterName(raw);
        if (norm && !memByNorm.has(norm)) memByNorm.set(norm, mem);
      }
    };

    for (const mem of chatData.value.characterMemories || []) registerMemory(mem);
    for (const summary of chatData.value.summaries || []) {
      for (const mem of summary.characterMemories || []) registerMemory(mem);
    }
    for (const mem of latest?.characterMemories || []) registerMemory(mem);

    const manualNames = (manualChars || '')
      .split(/[,，、]/)
      .map(s => s.trim())
      .filter(Boolean);

    const knownByNorm = new Map<string, string>();
    const addKnownName = (raw?: string) => {
      const name = (raw || '').trim();
      const norm = normalizeMemoryCharacterName(name);
      if (!name || !norm) return;
      const existing = knownByNorm.get(norm);
      if (!existing || name.length < existing.length) knownByNorm.set(norm, name);
    };

    // 与角色库 UI 对齐：历史总结 + 当前组装记忆（不含动态人设，避免动态人设反向污染世界推进）。
    for (const summary of chatData.value.summaries || []) {
      for (const mem of summary.characterMemories || []) addKnownName(mem.characterName);
    }
    for (const mem of latest?.characterMemories || []) addKnownName(mem.characterName);
    for (const mem of chatData.value.characterMemories || []) addKnownName(mem.characterName);

    // 设定档案也是角色库的一部分；开局有档案但无记忆时也能被推演。
    for (const name of Object.keys(chatData.value.characterProfiles || {})) addKnownName(name);

    // 手动输入相当于临时加入候选名单（不限数量，仅增权重），最终仍只推 limit 个；后面仍会做玩家/忽略/在场过滤。
    for (const name of manualNames) addKnownName(name);

    const resolveName = (raw: string): string | null => {
      const norm = normalizeMemoryCharacterName(raw);
      if (!norm) return null;
      return knownByNorm.get(norm) || memByNorm.get(norm)?.characterName || raw.trim() || null;
    };

    const selected: WorldProgressCandidate[] = [];
    const selectedNorm = new Set<string>();
    for (const raw of manualNames) {
      const name = resolveName(raw);
      if (!name) continue;
      const norm = normalizeMemoryCharacterName(name);
      if (selectedNorm.has(norm)) continue;
      // 入场引导冷却A：距上次入场引导经过的"推演尝试次数" < N → 跳过
      const aliases = memByNorm.get(norm)?.aliases || [];
      const lastEntryAttempt = findLastEntryHintAttemptForCharacter(name, aliases);
      const passedAttempts = lastEntryAttempt >= 0 ? attempt - lastEntryAttempt : Infinity;
      if (passedAttempts < entryCooldownAttempts) continue;
      const candidate = makeCandidate(name, memByNorm.get(norm), currentFloor, true);
      if (!candidate) continue;
      // 入场引导冷却B：过了推演冷却（A）但仍 < entryHintCooldownRounds 次 → 允许推演但禁入场引导
      if (passedAttempts < entryHintCooldownAttempts) {
        candidate.inEntryHintCooldown = true;
      }
      selected.push(candidate);
      selectedNorm.add(norm);
      if (selected.length >= limit) return selected;
    }

    const autoCandidates: WorldProgressCandidate[] = [];
    for (const name of knownByNorm.values()) {
      const norm = normalizeMemoryCharacterName(name);
      if (selectedNorm.has(norm)) continue;
      // 入场引导冷却A：距上次入场引导经过的"推演尝试次数" < N → 跳过
      const aliases = memByNorm.get(norm)?.aliases || [];
      const lastEntryAttempt = findLastEntryHintAttemptForCharacter(name, aliases);
      const passedAttempts = lastEntryAttempt >= 0 ? attempt - lastEntryAttempt : Infinity;
      if (passedAttempts < entryCooldownAttempts) continue;
      const candidate = makeCandidate(name, memByNorm.get(norm), currentFloor, false);
      if (!candidate) continue;
      // 入场引导冷却B：过了推演冷却（A）但仍 < entryHintCooldownRounds 次 → 允许推演但禁入场引导
      if (passedAttempts < entryHintCooldownAttempts) {
        candidate.inEntryHintCooldown = true;
      }
      if (candidate) autoCandidates.push(candidate);
    }
    autoCandidates.sort((a, b) => (b.score || 0) - (a.score || 0));

    if (selected.length === 0 && autoCandidates.length > 0) {
      const first = autoCandidates.shift()!;
      selected.push(first);
      selectedNorm.add(normalizeMemoryCharacterName(first.characterName));
    }

    while (selected.length < limit && autoCandidates.length > 0) {
      const pool = autoCandidates
        .filter(c => !selectedNorm.has(normalizeMemoryCharacterName(c.characterName)))
        .slice(0, Math.min(6, autoCandidates.length));
      if (pool.length === 0) break;
      const cooled = pool.filter(c => currentFloor - findLastWorldProgressFloorForCharacter(c.characterName) > WORLD_PROGRESS_MEMORY_TTL_FLOORS / 2);
      const opportunityPool = cooled.length > 0 ? cooled : pool;
      const idx = opportunityPool.length > 1 ? Math.abs(currentFloor) % opportunityPool.length : 0;
      const picked = opportunityPool[idx];
      selected.push(picked);
      selectedNorm.add(normalizeMemoryCharacterName(picked.characterName));
      const removeIdx = autoCandidates.findIndex(c => normalizeMemoryCharacterName(c.characterName) === normalizeMemoryCharacterName(picked.characterName));
      if (removeIdx >= 0) autoCandidates.splice(removeIdx, 1);
    }

    return selected.slice(0, limit);
  }
  /**
   * 异步重排增强召回：在 getFusedMemories 粗筛基础上，调用 reranker API 精排。
   * 仅用于注入路径（index.ts），同步调用方不受影响。
   */
  async function rerankEnhancedRecall(
    characterNames: string[],
    queryText: string,
  ): Promise<Map<string, Array<{ text: string; isCore: boolean; time?: string }>>> {
    const result = new Map<string, Array<{ text: string; isCore: boolean; time?: string }>>();
    if (!scriptData.value.settings.rerankEnabled) return result;
    if (!queryText || characterNames.length === 0) return result;

    const candidateMult = scriptData.value.settings.rerankCandidateMultiplier ?? 3;
    const limit = scriptData.value.settings.memoryRecallLimit ?? 10;

    // ★ 拆分两路：
    //   - 远期核心：走 reranker 语义排序，受 recallLimit 约束
    //   - 近期窗口：全部保留，不受任何上限约束，不参与重排
    const recentMap = new Map<string, Array<{ text: string; isCore: boolean; time?: string }>>();
    const candidateMap = new Map<string, Array<{ text: string; isCore: boolean; time?: string }>>();

    for (const name of characterNames) {
      // 远期核心（recentVersions=0 → 仅旧核心，无近期窗口）
      const oldCores = getFusedMemories(name, 0, undefined, limit * candidateMult, queryText);
      // 完整集（远期核心 + 近期窗口）
      const full = getFusedMemories(name, undefined, undefined, limit * candidateMult, queryText);

      // 提取近期窗口（完整集中去掉远期核心已有的部分）
      const oldSet = new Set(oldCores.map(r => r.text));
      const recentOnly = full.filter(r => !oldSet.has(r.text));

      recentMap.set(name, recentOnly);

      if (oldCores.length > limit) {
        candidateMap.set(name, oldCores);
      } else {
        // 候选不足，直接合并远期+近期
        result.set(name, [...oldCores, ...recentOnly]);
      }
    }

    if (candidateMap.size === 0) return result;

    // 一次性收集所有候选文本并调用 reranker
    const allCandidates: { char: string; idx: number; text: string }[] = [];
    const charTexts: string[] = [];
    for (const [name, candidates] of candidateMap) {
      for (let i = 0; i < candidates.length; i++) {
        const text = `${name}: ${candidates[i].text}`;
        allCandidates.push({ char: name, idx: i, text });
        charTexts.push(text);
      }
    }

    try {
      const { rerankCandidates } = await import('../core/embedding');
      const reranked = await rerankCandidates(
        queryText,
        charTexts,
        charTexts.length,
        scriptData.value.settings.embeddingApiUrl,
        scriptData.value.settings.embeddingApiKey,
        scriptData.value.settings.rerankModel,
      );
      if (!reranked?.length) return result;

      // 按角色分组，每组取 top-N
      const scoredByChar = new Map<string, Array<{ idx: number; score: number; text: string }>>();
      for (const r of reranked) {
        const c = allCandidates.find(x => x.text === r.text);
        if (!c) continue;
        const arr = scoredByChar.get(c.char) || [];
        arr.push({ idx: c.idx, score: r.score ?? 0, text: r.text });
        scoredByChar.set(c.char, arr);
      }

      for (const [name, candidates] of candidateMap) {
        const scored = scoredByChar.get(name);
        const recent = recentMap.get(name) || [];
        if (scored && scored.length > 0) {
          scored.sort((a, b) => b.score - a.score);
          const top = scored.slice(0, limit).map(s => candidates[s.idx]);
          // ★ 远期重排 top-N + 近期全保留
          result.set(name, [...top, ...recent]);
        } else {
          result.set(name, [...candidates.slice(0, limit), ...recent]);
        }
      }
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '记忆召回',
        level: 'info',
        message: `批量重排完成: ${candidateMap.size}角色, ${charTexts.length}候选 + 近期全保留`,
      });
    } catch (e) {
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '记忆召回',
        level: 'warn',
        message: `批量重排失败，回退粗筛: ${(e as Error).message}`,
      });
      for (const [name, candidates] of candidateMap) {
        const recent = recentMap.get(name) || [];
        result.set(name, [...candidates.slice(0, limit), ...recent]);
      }
    }

    return result;
  }

  function getCharacterMemoryArchive(characterName: string): Array<{
    version: number;
    generatedAt: string;
    label?: string;
    memories: Array<{ text: string; isCore: boolean; time?: string; source?: string; id?: string; floor?: number }>;
  }> {
    const normName = normalizeMemoryCharacterName(characterName);
    const data = chatData.value.summaries.map(summary => {
      const mem = summary.characterMemories.find(m => {
        const names = [m.characterName, ...(m.aliases || [])].map(normalizeMemoryCharacterName);
        return names.includes(normName);
      });
      const ordered = (mem as any)?.orderedNewMemories as
        | Array<{ text: string; isCore: boolean; time?: string }>
        | undefined;
      let archiveMemories: Array<{ text: string; isCore: boolean; time?: string }>;
      if (ordered && ordered.length > 0) {
        archiveMemories = ordered.map(o => ({ text: o.text, isCore: o.isCore, time: o.time }));
      } else if (mem) {
        const coreItems: Array<{ text: string; isCore: boolean; time?: string }> = [];
        for (const c of (mem.coreMemories || [])) {
          const text = typeof c === 'string' ? c : c?.text || '';
          if (text) coreItems.push({ text, isCore: true, time: (c as any)?.time });
        }
        const recentItems = (mem.recentMemories || []).map(t => ({ text: t, isCore: false }));
        archiveMemories = [...coreItems, ...recentItems];
      } else {
        archiveMemories = [];
      }
      return { version: summary.version, generatedAt: summary.generatedAt, memories: archiveMemories };
    });
    const wpArchive = (chatData.value.worldProgressMemories || [])
      .filter(m => normalizeMemoryCharacterName(m.characterName) === normalizeMemoryCharacterName(characterName))
      .sort((a, b) => (a.floor ?? 0) - (b.floor ?? 0))
      .map(m => ({
        version: -100000 - (m.floor ?? 0),
        label: `世界推进 #${m.floor}`,
        generatedAt: m.time || '',
        memories: [{
          text: m.text,
          isCore: false,
          time: m.time,
          source: 'world_progress',
          id: m.id,
          floor: m.floor,
        }],
      }));
    const allData = [...data, ...wpArchive];
    try {
      return structuredClone(allData);
    } catch {
      return JSON.parse(JSON.stringify(allData));
    }
  }

  function normalizeMemoryCharacterName(name?: string): string {
    return normalizeCharacterNameKey(name);
  }

  function getMemoryItemText(item: any): string {
    return (typeof item === 'string' ? item : item?.text || '').trim();
  }

  function removeCharacterMemoryItem(options: { characterName: string; text: string; sourceVersion?: number; source?: string; id?: string }): boolean {
    const targetName = normalizeMemoryCharacterName(options.characterName);
    const targetText = (options.text || '').trim();
    if (!targetName || !targetText) return false;
    let removed = false;
    const wpBefore = chatData.value.worldProgressMemories?.length || 0;
    chatData.value.worldProgressMemories = (chatData.value.worldProgressMemories || []).filter((item: any) => {
      const sameId = options.id && item.id === options.id;
      const sameText = normalizeMemoryCharacterName(item.characterName) === targetName && item.text === targetText;
      return !(sameId || (options.source === 'world_progress' && sameText));
    });
    if ((chatData.value.worldProgressMemories?.length || 0) !== wpBefore) removed = true;
    const removeFromMem = (mem: any) => {
      if (normalizeMemoryCharacterName(mem?.characterName) !== targetName) return;
      const ordered = mem.orderedNewMemories;
      if (Array.isArray(ordered)) { const before = ordered.length; mem.orderedNewMemories = ordered.filter((item: any) => getMemoryItemText(item) !== targetText); if (mem.orderedNewMemories.length !== before) removed = true; }
      const cores = mem.coreMemories;
      if (Array.isArray(cores)) { const before = cores.length; mem.coreMemories = cores.filter((item: any) => getMemoryItemText(item) !== targetText); if (mem.coreMemories.length !== before) removed = true; }
      const recent = mem.recentMemories;
      if (Array.isArray(recent)) { const before = recent.length; mem.recentMemories = recent.filter((item: any) => getMemoryItemText(item) !== targetText); if (mem.recentMemories.length !== before) removed = true; }
    };
    const summaries = typeof options.sourceVersion === 'number' ? chatData.value.summaries.filter(s => s.version === options.sourceVersion) : [...chatData.value.summaries].reverse();
    summaries.forEach(summary => (summary.characterMemories || []).forEach(removeFromMem));
    (chatData.value.characterMemories || []).forEach(removeFromMem);
    if (removed) { rebuildAssembled(); _fusedCache.clear(); doPersist(); }
    return removed;
  }
  function getCharacterMemories(
    characterName: string,
  ):
    | (CharacterMemory & { memories: string[]; _orderedItems?: { text: string; isCore: boolean; time?: string; source?: string; id?: string; floor?: number }[] })
    | undefined {
    ensureWorldProgressMemoriesFromRecords();
    const hasCharacterNameSource = () => {
      const target = normalizeMemoryCharacterName(characterName);
      if (!target) return false;
      if (findCharacterMemoryByName(chatData.value.characterMemories, characterName)) return true;
      if ((chatData.value.dynamicProfiles || []).some(p => normalizeMemoryCharacterName(p.characterName) === target)) return true;
      if ((chatData.value.dynamicProfilesV2 || []).some(p => normalizeMemoryCharacterName(p.characterName) === target)) return true;
      if ((chatData.value.nsfwMemories || []).some(m => normalizeMemoryCharacterName(m.characterName) === target)) return true;
      if ((chatData.value.nsfwDynamicProfiles || []).some(p => normalizeMemoryCharacterName(p.characterName) === target)) return true;
      if ((chatData.value.worldProgressMemories || []).some(m => normalizeMemoryCharacterName(m.characterName) === target)) return true;
      if ((chatData.value.worldProgressRecords || []).some(record =>
        (record.advancedCharacters || []).some(ch => normalizeMemoryCharacterName(ch.characterName) === target)
        || (record.presentCharacters || []).some(name => normalizeMemoryCharacterName(name) === target)
        || normalizeMemoryCharacterName(record.entryHint?.characterName) === target
        || (record.resolvedHooks || []).some(hook => (hook.characterNames || []).some(name => normalizeMemoryCharacterName(name) === target)),
      )) return true;
      if ((chatData.value.knowledgeGraph?.characters || []).some(ch => {
        const names = [ch.name, ...(ch.aliases || [])].map(normalizeMemoryCharacterName);
        return names.includes(target);
      })) return true;
      if ((chatData.value.knowledgeGraphVersions || []).some(version =>
        (version.graph?.characters || []).some(ch => {
          const names = [ch.name, ...(ch.aliases || [])].map(normalizeMemoryCharacterName);
          return names.includes(target);
        }),
      )) return true;
      if (Object.keys(chatData.value.characterProfiles || {}).some(name => normalizeMemoryCharacterName(name) === target)) return true;
      if ((chatData.value.savedCharacterProfiles || []).some(item => normalizeMemoryCharacterName(item.name) === target)) return true;
      if (Object.keys(chatData.value.characterLocations || {}).some(name => normalizeMemoryCharacterName(name) === target)) return true;
      if ((chatData.value.relationshipProfiles || []).some(profile =>
        (profile.from !== '__zhino_user__' && normalizeMemoryCharacterName(profile.fromName || profile.from) === target)
        || (profile.to !== '__zhino_user__' && normalizeMemoryCharacterName(profile.toName || profile.to) === target),
      )) return true;
      return false;
    };

    const makeLightweightMemory = () => {
      const wpItems = getActiveWorldProgressMemories(characterName).map(m => ({
        text: m.text,
        isCore: false,
        time: m.time,
        source: 'world_progress' as const,
        id: m.id,
        floor: m.floor,
      }));
      const standalone = findCharacterMemoryByName(chatData.value.characterMemories, characterName);
      const aliases = cleanCharacterAliases([
        ...(standalone?.aliases || []),
        ...collectCharacterAliases(characterName),
      ], characterName);
      if (wpItems.length === 0 && !standalone && aliases.length === 0 && !hasCharacterNameSource()) return undefined;
      return {
        characterName,
        aliases,
        attitude: standalone?.attitude || 'neutral' as const,
        coreMemories: [...(standalone?.coreMemories || [])],
        recentMemories: wpItems.map(m => m.text),
        keywords: [...(standalone?.keywords || [])],
        recallLimit: standalone?.recallLimit,
        recallEnabled: standalone?.recallEnabled,
        orderedNewMemories: standalone?.orderedNewMemories ? [...standalone.orderedNewMemories] : [],
        profile: standalone?.profile,
        _orderedItems: wpItems,
        memories: wpItems.map(m => `[近期]${m.text}`),
      } as CharacterMemory & { memories: string[]; _orderedItems: typeof wpItems };
    };

    const latest = getLatestSummary();
    if (!latest) return makeLightweightMemory();
    const targetName = normalizeMemoryCharacterName(characterName);
    const mem = latest.characterMemories.find(m => normalizeMemoryCharacterName(m.characterName) === targetName);
    if (mem) {
      mem.aliases = cleanCharacterAliases([...(mem.aliases || []), ...collectCharacterAliases(mem.characterName)], mem.characterName);
      // ⭐ 手动编辑过的角色：直接使用 orderedNewMemories，跳过融合避免旧数据复活
      if ((mem as any)._manuallyEdited) {
        const ordered = (mem as any).orderedNewMemories as
          | Array<{ text: string; isCore: boolean; time?: string }>
          | undefined;
        if (ordered && ordered.length > 0) {
          const withWorldProgress = appendActiveWorldProgressMemories(characterName, ordered);
          (mem as any)._orderedItems = withWorldProgress;
          (mem as any).memories = withWorldProgress.map(m => `[${m.isCore ? '核心' : '近期'}]${m.text}`);
          return mem as any;
        }
      }
      // 运行时融合：旧核心 → 最近N版近期
      const fused = getFusedMemories(characterName);
      if (fused.length > 0) {
        (mem as any)._orderedItems = fused;
        (mem as any).memories = fused.map(m => `[${m.isCore ? '核心' : '近期'}]${m.text}`);
      } else {
        // 兜底：核心在前、近期在后（兼容旧 string[] 和新 CoreMemoryItem[] 格式）
        const items: { text: string; isCore: boolean; time?: string }[] = [
          ...(mem.coreMemories || []).map((t: any) => ({
            text: typeof t === 'string' ? t : t?.text || '',
            isCore: true,
            time: t?.time,
          })),
          ...(mem.recentMemories || []).map(t => ({ text: t, isCore: false })),
        ];
        (mem as any)._orderedItems = items;
        (mem as any).memories = items.map(m => `[${m.isCore ? '核心' : '近期'}]${m.text}`);
      }
    }
    return (mem as any) || makeLightweightMemory();
  }

  function getAllCharacterNames(): string[] {
    return getCharacterNameEntries().map(entry => entry.name);
  }

  function isUserCharacterName(name?: string): boolean {
    const norm = normalizeMemoryCharacterName(name).toLowerCase();
    if (!norm) return false;
    const userNorm = normalizeMemoryCharacterName(getUserName()).toLowerCase();
    return norm === userNorm || norm === 'user' || norm === normalizeMemoryCharacterName('{{user}}').toLowerCase();
  }

  function getCharacterNameEntries(options: { includeUser?: boolean } = {}): CharacterNameEntry[] {
    const byNorm = new Map<string, { name: string; aliases: Set<string> }>();
    const sameLookupName = (a?: string, b?: string) => {
      const rawA = String(a || '').trim();
      const rawB = String(b || '').trim();
      const normA = normalizeMemoryCharacterName(rawA);
      const normB = normalizeMemoryCharacterName(rawB);
      return !!rawA && !!rawB && (
        rawA === rawB
        || normA === normB
        || rawA.toLowerCase() === rawB.toLowerCase()
        || normA.toLowerCase() === normB.toLowerCase()
      );
    };
    const findExistingEntry = (name: string, aliases: string[] = []) => {
      const candidates = [name, ...aliases].filter(Boolean);
      const direct = byNorm.get(normalizeMemoryCharacterName(name));
      if (direct) return direct;
      for (const entry of byNorm.values()) {
        const values = [entry.name, ...entry.aliases];
        if (candidates.some(candidate => values.some(value => sameLookupName(candidate, value)))) {
          return entry;
        }
      }
      return undefined;
    };

    const addEntry = (name?: string, aliases: string[] = []) => {
      const originalName = String(name || '').trim();
      const rawName = normalizeMemoryCharacterName(originalName);
      const norm = normalizeMemoryCharacterName(rawName);
      if (!rawName || !norm) return;
      if (!options.includeUser && isUserCharacterName(originalName || rawName)) return;
      const existing = findExistingEntry(rawName, [originalName, ...aliases.filter(a => !MEANINGLESS_ALIASES.has(a))]);
      const entry = existing || { name: rawName, aliases: new Set<string>() };
      if (existing && normalizeMemoryCharacterName(entry.name) !== norm) entry.aliases.add(rawName);
      for (const alias of cleanCharacterAliases([originalName, ...aliases], entry.name)) entry.aliases.add(alias);
      if (rawName !== entry.name) entry.aliases.add(rawName);
      byNorm.set(normalizeMemoryCharacterName(entry.name), entry);
    };

    const addMemory = (mem?: Partial<CharacterMemory>) => {
      if (!mem?.characterName) return;
      addEntry(mem.characterName, mem.aliases || []);
    };

    for (const mem of chatData.value.characterMemories || []) addMemory(mem);
    for (const summary of chatData.value.summaries || []) {
      for (const mem of summary.characterMemories || []) addMemory(mem);
      for (const entry of summary.characterTable || []) addEntry(entry.name, entry.aliases || []);
    }
    const latest = getLatestSummary();
    for (const mem of latest?.characterMemories || []) addMemory(mem);
    for (const entry of latest?.characterTable || []) addEntry(entry.name, entry.aliases || []);

    for (const profile of chatData.value.dynamicProfiles || []) addEntry(profile.characterName);
    for (const profile of chatData.value.dynamicProfilesV2 || []) addEntry(profile.characterName);
    for (const mem of chatData.value.nsfwMemories || []) addEntry(mem.characterName);
    for (const profile of chatData.value.nsfwDynamicProfiles || []) addEntry(profile.characterName);
    for (const interaction of chatData.value.dreamtalk?.characterInteractions || []) addEntry(interaction.characterName);
    for (const mem of chatData.value.worldProgressMemories || []) addEntry(mem.characterName);
    for (const record of chatData.value.worldProgressRecords || []) {
      for (const ch of record.advancedCharacters || []) addEntry(ch.characterName, (ch as any).aliases || []);
      for (const name of record.presentCharacters || []) addEntry(name);
      addEntry(record.entryHint?.characterName);
      for (const hook of record.resolvedHooks || []) {
        for (const name of hook.characterNames || []) addEntry(name);
      }
    }
    for (const ch of chatData.value.knowledgeGraph?.characters || []) addEntry(ch.name, ch.aliases || []);
    for (const version of chatData.value.knowledgeGraphVersions || []) {
      for (const ch of version.graph?.characters || []) addEntry(ch.name, ch.aliases || []);
    }
    for (const name of Object.keys(chatData.value.characterProfiles || {})) addEntry(name);
    for (const item of chatData.value.savedCharacterProfiles || []) addEntry(item.name);
    for (const name of Object.keys(chatData.value.characterLocations || {})) addEntry(name);
    for (const profile of chatData.value.relationshipProfiles || []) {
      if (profile.from !== '__zhino_user__') addEntry(profile.fromName || profile.from);
      if (profile.to !== '__zhino_user__') addEntry(profile.toName || profile.to);
    }

    const finalByNorm = new Map<string, { name: string; aliases: Set<string> }>();
    for (const entry of byNorm.values()) {
      const name = normalizeMemoryCharacterName(entry.name);
      const key = name.toLowerCase();
      if (!name || !key) continue;
      const existing = finalByNorm.get(key);
      if (existing) {
        existing.aliases.add(entry.name);
        for (const alias of entry.aliases) existing.aliases.add(alias);
      } else {
        finalByNorm.set(key, { name, aliases: new Set(entry.aliases) });
      }
    }

    return [...finalByNorm.values()]
      .map(entry => ({
        name: entry.name,
        aliases: cleanCharacterAliases([...entry.aliases], entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  /**
   * 从现有 13+ 处存储点的角色名收集结果，一次性迁移建注册表。
   * 聚类策略保守：归一化后严格相等才合并为一个 record（宁可多建 id 也不错并）。
   * P1 阶段：纯增量，不改任何读写路径。
   */
  function buildRegistryFromExistingData(): CharacterRegistry {
    const entries = getCharacterNameEntries({ includeUser: true });
    // preferredNames：characterMemories 里已确立的主名（用户/AI 已在用）
    // 迁移时优先作 primaryName，避免"主名变排序先到的陌生名字"，保证发给 AI 的名字稳定
    const preferredNames = new Set<string>();
    const addPreferred = (name?: string) => {
      const n = normalizeMemoryCharacterName(name || '');
      if (n) preferredNames.add(n);
    };
    for (const mem of chatData.value.characterMemories || []) addPreferred(mem.characterName);
    const latest = getLatestSummary();
    for (const mem of latest?.characterMemories || []) addPreferred(mem.characterName);
    for (const delta of chatData.value.summaries || []) {
      for (const mem of delta.characterMemories || []) addPreferred(mem.characterName);
    }
    const registry = buildRegistryFromEntries(entries, preferredNames);
    const stats = getRegistryStats(registry);
    pushCodeLog({
      id: _codeLogIdCounter++,
      timestamp: new Date().toISOString(),
      module: '存储',
      level: 'info',
      message: `角色注册表迁移完成：${stats.total} 角色（active ${stats.active}）`,
    });
    return registry;
  }

  /**
   * 确保角色注册表已构建（lazy 初始化）。
   * 旧存档无此字段（prefault=null），首次访问时从现有数据迁移建表，迁移后随 chatData 自动持久化。
   * P1 阶段：供调试/后续阶段使用，现有读写路径暂不调用。
   */
  function ensureCharacterRegistry(): CharacterRegistry {
    if (!chatData.value.characterRegistry) {
      chatData.value.characterRegistry = buildRegistryFromExistingData();
      doPersist();
    }
    return chatData.value.characterRegistry;
  }

  function resolveKnownCharacterName(rawName: string, fallbackToNormalized = false): string {
    const raw = String(rawName || '').trim();
    if (!raw) return '';
    if (isUserCharacterName(raw)) return getUserName();
    // P3 读取收口：优先用 registry 按 id 仲裁（解决原 buildCharacterNameIndex "先注册先占" 的别名录错传染）
    // registry 为空时回退原逻辑（双轨兜底，保证旧存档/未迁移时不崩）
    const registry = chatData.value.characterRegistry;
    if (registry && registry.records && Object.keys(registry.records).length > 0) {
      const result = resolveOrPending(raw, registry);
      if (result.status === 'resolved' && result.record) {
        return result.record.primaryName;
      }
      // ambiguous/unknown → 回退原逻辑兜底（仍走"先注册先占"）
    }
    return resolveCharacterNameFromEntries(
      raw,
      getCharacterNameEntries({ includeUser: true }),
      fallbackToNormalized,
    );
  }

  /**
   * P3 读取收口：用名字解析到稳定 characterId。
   * 返回空串表示未命中（registry 未建或该名未知/歧义）。
   * 供 P4 改名/合并、UI 选中态使用。
   */
  function resolveKnownCharacterId(rawName: string): string {
    const raw = String(rawName || '').trim();
    if (!raw) return '';
    if (isUserCharacterName(raw)) return '__zhino_user__';
    const registry = chatData.value.characterRegistry;
    if (!registry || !registry.records) return '';
    const result = resolveOrPending(raw, registry);
    if (result.status === 'resolved' && result.record) return result.record.id;
    return '';
  }

  function resolveKnownCharacterNames(names: string[] | undefined, fallbackToNormalized = false): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const raw of names || []) {
      const name = resolveKnownCharacterName(raw, fallbackToNormalized).trim();
      const key = normalizeMemoryCharacterName(name);
      if (!name || seen.has(key)) continue;
      seen.add(key);
      result.push(name);
    }
    return result;
  }

  /**
   * P2 写入收口：AI 输出的角色记忆归并入库。
   * - resolved（命中唯一角色）→ 按 characterId 归并，mem 标记 _characterId
   * - ambiguous/unknown → 旧 fallback 逻辑入库（不丢数据，不再挂待仲裁队列）
   * 双轨期：resolved 的同时保留 characterName（兼容旧读取）+ 加 _characterId（P3/P4 用）。
   */
  function normalizeIncomingCharacterMemories(memories: CharacterMemory[] = []): CharacterMemory[] {
    const registry = ensureCharacterRegistry();
    const byKey = new Map<string, CharacterMemory>();
    for (const rawMem of memories) {
      const mem = normalizeCharacterMemoryArrays(rawMem);
      const rawName = mem.characterName;
      const result = resolveOrPending(rawName, registry);

      let canonical: string;
      let mergeKey: string;

      if (result.status === 'resolved' && result.record) {
        canonical = result.record.primaryName;
        mergeKey = `id:${result.record.id}`;
        mem.characterName = canonical;
        mem.aliases = cleanCharacterAliases([...(mem.aliases || []), rawName], canonical);
        (mem as any)._characterId = result.record.id;
      } else {
        canonical = resolveKnownCharacterName(rawName, true);
        if (!canonical) continue;
        mergeKey = `name:${normalizeMemoryCharacterName(canonical)}`;
        mem.characterName = canonical;
        mem.aliases = cleanCharacterAliases([...(mem.aliases || []), rawName], canonical);
      }

      const existing = byKey.get(mergeKey);
      if (!existing) {
        byKey.set(mergeKey, mem);
        continue;
      }

      // resolved 的 _characterId 优先保留（旧条目可能没标）
      if ((mem as any)._characterId && !(existing as any)._characterId) {
        (existing as any)._characterId = (mem as any)._characterId;
      }
      existing.aliases = cleanCharacterAliases([...(existing.aliases || []), ...(mem.aliases || [])], existing.characterName);
      existing.keywords = [...new Set([...(existing.keywords || []), ...(mem.keywords || [])])];
      const coreSeen = new Set((existing.coreMemories || []).map((c: any) => typeof c === 'string' ? c : c?.text || ''));
      for (const core of mem.coreMemories || []) {
        const text = typeof core === 'string' ? core : ((core as any)?.text || '');
        if (text && !coreSeen.has(text)) {
          existing.coreMemories.push(core);
          coreSeen.add(text);
        }
      }
      const recentSeen = new Set(existing.recentMemories || []);
      for (const recent of mem.recentMemories || []) {
        if (recent && !recentSeen.has(recent)) {
          existing.recentMemories.push(recent);
          recentSeen.add(recent);
        }
      }
      const ordered = ((existing as any).orderedNewMemories || []) as any[];
      const orderedSeen = new Set(ordered.map(item => item?.text).filter(Boolean));
      for (const item of ((mem as any).orderedNewMemories || []) as any[]) {
        if (item?.text && !orderedSeen.has(item.text)) {
          ordered.push(item);
          orderedSeen.add(item.text);
        }
      }
      (existing as any).orderedNewMemories = ordered;
    }
    return [...byKey.values()];
  }

  function normalizeIncomingCharacterTable(table: CharacterEntry[] = []): CharacterEntry[] {
    const byNorm = new Map<string, CharacterEntry>();
    for (const entry of table || []) {
      const rawName = entry.name;
      const canonical = resolveKnownCharacterName(rawName, true);
      if (!canonical) continue;
      const key = normalizeMemoryCharacterName(canonical);
      const normalized = {
        ...entry,
        name: canonical,
        aliases: cleanCharacterAliases([...(entry.aliases || []), rawName], canonical),
      };
      const existing = byNorm.get(key);
      if (existing) {
        existing.aliases = cleanCharacterAliases([...(existing.aliases || []), ...(normalized.aliases || [])], existing.name);
        existing.identity = existing.identity || normalized.identity;
        existing.relationship = existing.relationship || normalized.relationship;
        existing.status = existing.status || normalized.status;
      } else {
        byNorm.set(key, normalized);
      }
    }
    return [...byNorm.values()];
  }

  /**
   * 设置角色设定档案（独立存储，不依赖 characterMemories）
   */
  function setCharacterProfile(characterName: string, profile: CharacterProfile): boolean {
    characterName = resolveKnownCharacterName(characterName, true);
    if (!characterName) return false;
    if (!chatData.value.characterProfiles) {
      chatData.value.characterProfiles = {};
    }
    chatData.value.characterProfiles[characterName] = profile;
    doPersist();
    return true;
  }

  /**
   * 删除角色设定档案
   */
  function removeCharacterProfile(characterName: string): boolean {
    characterName = resolveKnownCharacterName(characterName, true);
    if (!characterName) return false;
    if (!chatData.value.characterProfiles) return false;
    if (!(characterName in chatData.value.characterProfiles)) return false;
    delete chatData.value.characterProfiles[characterName];
    doPersist();
    return true;
  }

  /**
   * 获取角色设定档案（独立存储读取）
   */
  function getCharacterProfile(characterName: string): CharacterProfile | undefined {
    characterName = resolveKnownCharacterName(characterName, true);
    if (!characterName) return undefined;
    if (!chatData.value.characterProfiles) return undefined;
    return chatData.value.characterProfiles[characterName];
  }

  /**
   * 保存角色设定到历史（手动点"保存人设"按钮调用）
   */
  function saveCharacterProfileToHistory(characterName: string, profile: CharacterProfile): boolean {
    characterName = resolveKnownCharacterName(characterName, true);
    if (!characterName || !profile) return false;
    if (!chatData.value.savedCharacterProfiles) {
      chatData.value.savedCharacterProfiles = [];
    }
    chatData.value.savedCharacterProfiles.push({
      name: characterName,
      profile,
      savedAt: new Date().toISOString(),
    });
    doPersist();
    return true;
  }

  /**
   * 删除某条历史角色设定
   */
  function removeSavedCharacterProfile(index: number): boolean {
    if (!chatData.value.savedCharacterProfiles) return false;
    if (index < 0 || index >= chatData.value.savedCharacterProfiles.length) return false;
    chatData.value.savedCharacterProfiles.splice(index, 1);
    doPersist();
    return true;
  }

  /**
   * 从历史加载某条角色设定到当前
   */
  function loadSavedCharacterProfile(index: number): CharacterProfile | undefined {
    if (!chatData.value.savedCharacterProfiles) return undefined;
    const item = chatData.value.savedCharacterProfiles[index];
    if (!item) return undefined;
    return item.profile;
  }

  function findCharacterMemoryByName(memories: CharacterMemory[] | undefined, characterName: string): CharacterMemory | undefined {
    const targetName = normalizeMemoryCharacterName(characterName);
    if (!targetName) return undefined;
    return (memories || []).find(m => {
      const names = [m.characterName, ...(m.aliases || [])].map(normalizeMemoryCharacterName);
      return names.includes(targetName);
    });
  }

  function findCharacterMemoryIndexByName(memories: CharacterMemory[] | undefined, characterName: string): number {
    const targetName = normalizeMemoryCharacterName(characterName);
    if (!targetName) return -1;
    return (memories || []).findIndex(m => {
      const names = [m.characterName, ...(m.aliases || [])].map(normalizeMemoryCharacterName);
      return names.includes(targetName);
    });
  }

  function cleanCharacterAliases(aliases: string[] | undefined, characterName: string): string[] {
    return cleanCharacterAliasList(aliases, characterName);
  }

  function collectCharacterAliases(characterName: string): string[] {
    const targetName = normalizeMemoryCharacterName(characterName);
    if (!targetName) return [];
    const aliases = new Set<string>();
    const remember = (values?: string[]) => {
      for (const raw of values || []) {
        const alias = String(raw || '').trim();
        if (!alias || normalizeMemoryCharacterName(alias) === targetName) continue;
        aliases.add(alias);
      }
    };
    const scanMemory = (mem?: CharacterMemory) => {
      if (!mem?.characterName) return;
      const names = [mem.characterName, ...(mem.aliases || [])].map(normalizeMemoryCharacterName);
      if (names.includes(targetName)) remember(mem.aliases);
    };

    for (const mem of chatData.value.characterMemories || []) scanMemory(mem);
    for (const summary of chatData.value.summaries || []) {
      for (const mem of summary.characterMemories || []) scanMemory(mem);
    }
    const assembled = getLatestSummary();
    for (const mem of assembled?.characterMemories || []) scanMemory(mem);
    const graphChar = chatData.value.knowledgeGraph?.characters?.find(ch => {
      const names = [ch.name, ...(ch.aliases || [])].map(normalizeMemoryCharacterName);
      return names.includes(targetName);
    });
    remember(graphChar?.aliases || []);

    return cleanCharacterAliases([...aliases], characterName);
  }

  function normalizeCharacterMemoryArrays(mem: CharacterMemory): CharacterMemory {
    mem.aliases = Array.isArray(mem.aliases) ? mem.aliases : [];
    mem.keywords = Array.isArray(mem.keywords) ? mem.keywords : [];
    mem.coreMemories = Array.isArray(mem.coreMemories) ? mem.coreMemories : [];
    mem.recentMemories = Array.isArray(mem.recentMemories) ? mem.recentMemories : [];
    if (!mem.attitude) mem.attitude = 'neutral';
    return mem;
  }

  function cloneCharacterMemoryForManualEdit(characterName: string): CharacterMemory {
    const source = getCharacterMemories(characterName) as any;
    const orderedRuntime = Array.isArray(source?._orderedItems)
      ? source._orderedItems
      : Array.isArray(source?.orderedNewMemories)
        ? source.orderedNewMemories
        : [];
    const orderedSource = orderedRuntime.filter((item: any) => item?.source !== 'world_progress');
    const onlyWorldProgress = orderedRuntime.length > 0 && orderedSource.length === 0;
    return normalizeCharacterMemoryArrays({
      characterName,
      aliases: [...(source?.aliases || [])],
      keywords: [...(source?.keywords || [])],
      attitude: source?.attitude || 'neutral',
      coreMemories: [...(source?.coreMemories || [])],
      recentMemories: onlyWorldProgress ? [] : [...(source?.recentMemories || [])],
      recallLimit: source?.recallLimit,
      recallEnabled: source?.recallEnabled,
      orderedNewMemories: orderedSource.map((item: any) => ({ ...item })),
      profile: source?.profile,
    });
  }

  function ensureLatestCharacterMemoryForEdit(characterName: string): CharacterMemory | undefined {
    const latestDelta = getLatestDelta();
    if (!latestDelta) return undefined;
    const existing = findCharacterMemoryByName(latestDelta.characterMemories, characterName);
    if (existing) return normalizeCharacterMemoryArrays(existing);

    const mem = cloneCharacterMemoryForManualEdit(characterName);
    latestDelta.characterMemories.push(mem);
    return mem;
  }

  function updateCharacterAliases(characterName: string, aliases: string[]): boolean {
    const name = resolveKnownCharacterName((characterName || '').trim(), true);
    if (!name) return false;
    let mem = ensureLatestCharacterMemoryForEdit(name);
    const cleaned = cleanCharacterAliases(aliases, mem?.characterName || name);
    let wroteLatestDelta = false;

    if (mem) {
      mem.aliases = cleaned;
      (mem as any)._manuallyEdited = true;
      const latestDelta = getLatestDelta();
      const lastIdx = chatData.value.summaries.length - 1;
      if (latestDelta && lastIdx >= 0) {
        chatData.value.summaries[lastIdx] = { ...latestDelta };
        wroteLatestDelta = true;
      }
    }

    let standalone = findCharacterMemoryByName(chatData.value.characterMemories, name);
    if (!standalone) {
      standalone = normalizeCharacterMemoryArrays({
        characterName: mem?.characterName || name,
        aliases: [],
        attitude: mem?.attitude || 'neutral',
        coreMemories: mem?.coreMemories ? [...mem.coreMemories] : [],
        recentMemories: mem?.recentMemories ? [...mem.recentMemories] : [],
        keywords: mem?.keywords ? [...mem.keywords] : [],
        recallLimit: mem?.recallLimit,
        recallEnabled: mem?.recallEnabled,
        orderedNewMemories: mem?.orderedNewMemories ? mem.orderedNewMemories.map(item => ({ ...item })) : [],
        profile: mem?.profile,
      });
      chatData.value.characterMemories.push(standalone);
    }
    standalone.aliases = cleaned;
    (standalone as any)._manuallyEdited = true;

    updateGraphCharacterAliases(standalone.characterName || name, cleaned);
    const rewriteNorms = new Set([characterName, name, ...cleaned].map(normalizeMemoryCharacterName).filter(Boolean));
    for (const wpMem of chatData.value.worldProgressMemories || []) {
      if (rewriteNorms.has(normalizeMemoryCharacterName(wpMem.characterName))) {
        wpMem.characterName = name;
      }
    }
    for (const record of chatData.value.worldProgressRecords || []) {
      for (const ch of record.advancedCharacters || []) {
        if (rewriteNorms.has(normalizeMemoryCharacterName(ch.characterName))) ch.characterName = name;
      }
      record.presentCharacters = (record.presentCharacters || []).map(raw =>
        rewriteNorms.has(normalizeMemoryCharacterName(raw)) ? name : raw,
      );
      if (record.entryHint && rewriteNorms.has(normalizeMemoryCharacterName(record.entryHint.characterName))) {
        record.entryHint.characterName = name;
      }
      for (const hook of record.resolvedHooks || []) {
        hook.characterNames = (hook.characterNames || []).map(raw =>
          rewriteNorms.has(normalizeMemoryCharacterName(raw)) ? name : raw,
        );
      }
    }
    dedupeWorldProgressMemories();
    if (wroteLatestDelta) rebuildAssembled();
    else touchAssembled();
    _fusedCache.clear();
    forcePersist();
    return true;
  }

  /**
   * 手动新建角色：写入空 CharacterMemory 到顶层 characterMemories（最权威的"角色存在"标记），
   * 可选写入所在地（复用 setCharacterLocation，同步 characterLocations 字典 + graph.characters[].location 两层）。
   * 名称/别名命中已有角色则拒绝（避免重复）。
   */
  function addCharacter(name: string, aliases: string[] = [], locationName?: string): boolean {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;
    const canonical = resolveKnownCharacterName(trimmed, true);
    const normName = normalizeMemoryCharacterName(canonical || trimmed);
    if (!normName) return false;

    // 查重：主名或别名命中已有角色则拒绝
    const existingByNorm = findCharacterMemoryByName(chatData.value.characterMemories, canonical || trimmed)
      || findCharacterMemoryByName(chatData.value.characterMemories, normName);
    if (existingByNorm) {
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '存储',
        level: 'warn',
        message: `新建角色失败：已存在同名角色「${existingByNorm.characterName}」`,
      });
      return false;
    }

    const cleanedAliases = cleanCharacterAliases(aliases, canonical || trimmed);
    const mem = normalizeCharacterMemoryArrays({
      characterName: canonical || trimmed,
      aliases: cleanedAliases,
      attitude: 'neutral',
      coreMemories: [],
      recentMemories: [],
      keywords: [],
      orderedNewMemories: [],
    });
    (mem as any)._manuallyEdited = true;
    chatData.value.characterMemories.push(mem);

    if (locationName && String(locationName).trim()) {
      setCharacterLocation(canonical || trimmed, String(locationName).trim());
    }

    rebuildAssembled();
    forcePersist({ settings: false });
    pushCodeLog({
      id: _codeLogIdCounter++,
      timestamp: new Date().toISOString(),
      module: '存储',
      level: 'info',
      message: `已手动新建角色: ${canonical || trimmed}${cleanedAliases.length ? `（别名: ${cleanedAliases.join('、')}）` : ''}${locationName ? ` @ ${locationName}` : ''}`,
    });
    return true;
  }

  // ========== 角色合并 ==========

  /**
   * 将副角色（source）的所有数据合并到主角色（target）中。
   * 在每个 delta 内部合并记忆，并把所有旧 delta 的记忆汇总到最新 delta，
   * 确保 assembledSummary（对 _manuallyEdited 角色只读最新 delta）能读到全部记忆。
   */
  function mergeCharacters(targetName: string, sourceName: string, mode: 'merge' | 'rename' = 'merge'): boolean {
    const targetRaw = (targetName || '').trim();
    const sourceRaw = (sourceName || '').trim();
    // rename 模式不对 target 做主名归一化：新名可能正是本角色自己的别名（别名提升为主名），
    // 若归一化会被 resolve 回 source 导致 target===source 提前失败。
    let resolvedTarget = mode === 'rename' ? targetRaw : resolveKnownCharacterName(targetRaw, true);
    let resolvedSource = resolveKnownCharacterName(sourceRaw, true);
    // 别名提前吃掉对方主名时，归一会把两个独立角色解析成同一主名（例如玄音的别名里残留
    // "玄音仙子"，把 target=玄音仙子 也解析成玄音），导致合并/改名直接失败。
    // 此时退回到用户传入的原始名字（来自 UI 角色列表，本身就是主名），保留两个独立身份去合并。
    if (normalizeMemoryCharacterName(resolvedTarget) === normalizeMemoryCharacterName(resolvedSource)) {
      resolvedTarget = targetRaw;
      resolvedSource = sourceRaw;
    }
    targetName = resolvedTarget;
    sourceName = resolvedSource;
    if (!targetName || !sourceName || targetName === sourceName) return false;
    if (normalizeMemoryCharacterName(targetName) === normalizeMemoryCharacterName(sourceName)) return false;
    const targetNorm = normalizeMemoryCharacterName(targetName);
    const sourceNorm = normalizeMemoryCharacterName(sourceName);
    const matchesSource = (name?: string) => normalizeMemoryCharacterName(name) === sourceNorm;
    const matchesTarget = (name?: string) => normalizeMemoryCharacterName(name) === targetNorm;
    const rewriteName = (name?: string) => matchesSource(name) ? targetName : (name || '');
    const rewriteNameList = (names?: string[]) => {
      const result: string[] = [];
      const seen = new Set<string>();
      for (const raw of names || []) {
        const name = rewriteName(raw).trim();
        const key = normalizeMemoryCharacterName(name);
        if (!name || seen.has(key)) continue;
        seen.add(key);
        result.push(name);
      }
      return result;
    };

    // 合并前先做一次持久化（备份）
    doPersist();
    pushCodeLog({
      id: _codeLogIdCounter++,
      timestamp: new Date().toISOString(),
      module: '存储',
      level: 'info',
      message: (mode === 'rename' ? `开始改名: "${sourceName}" → "${targetName}"` : `开始合并: "${sourceName}" → "${targetName}"`),
    });

    // 确保最新 delta 中存在主角色条目（用于汇总所有旧 delta 的记忆）
    const latestDelta = chatData.value.summaries[chatData.value.summaries.length - 1];
    let latestTargetMem: any = ensureLatestCharacterMemoryForEdit(targetName);
    if (latestTargetMem) (latestTargetMem as any)._manuallyEdited = true;

    // 1. 遍历所有 delta，在每个 delta 内合并角色记忆
    for (const delta of [...chatData.value.summaries, ...chatData.value.summaryHistory]) {
      const targetIdx = findCharacterMemoryIndexByName(delta.characterMemories, targetName);
      const sourceIdx = findCharacterMemoryIndexByName(delta.characterMemories, sourceName);

      if (sourceIdx === -1) continue; // 该 delta 中无副角色，跳过

      const sourceMem = normalizeCharacterMemoryArrays(delta.characterMemories[sourceIdx]);

      if (targetIdx === -1) {
        // 该 delta 中只有副角色没有主角色 → 直接重命名
        sourceMem.characterName = targetName;
        // 把副角色原名加入 aliases
        sourceMem.aliases = cleanCharacterAliases([...(sourceMem.aliases || []), sourceName], targetName);
        // 标记手动编辑（确保 assembledSummary 跳过旧 delta，使用最新 delta 汇总数据）
        (sourceMem as any)._manuallyEdited = true;
      } else {
        // 该 delta 中两者都有 → 合并记忆到主角色
        const targetMem = normalizeCharacterMemoryArrays(delta.characterMemories[targetIdx]);

        // 合并 aliases
        targetMem.aliases = cleanCharacterAliases([...(targetMem.aliases || []), ...(sourceMem.aliases || []), sourceName], targetName);

        // 合并 keywords（去重）
        const allKeywords = new Set([...(targetMem.keywords || []), ...(sourceMem.keywords || [])]);
        targetMem.keywords = [...allKeywords];

        // 合并 attitude（优先取非 neutral）
        const tAtt = (targetMem as any).attitude;
        const sAtt = (sourceMem as any).attitude;
        if (tAtt === 'neutral' || !tAtt) {
          if (sAtt && sAtt !== 'neutral') (targetMem as any).attitude = sAtt;
        }

        // 合并 coreMemories（去重追加）
        const existingCoreTexts = new Set(
          (targetMem.coreMemories || []).map((c: any) => typeof c === 'string' ? c : (c?.text || '')),
        );
        for (const core of (sourceMem.coreMemories || [])) {
          const text = typeof core === 'string' ? core : ((core as any)?.text || '');
          if (text && !existingCoreTexts.has(text)) {
            targetMem.coreMemories.push(core);
            existingCoreTexts.add(text);
          }
        }

        // 合并 recentMemories（去重追加）
        const existingRecent = new Set(targetMem.recentMemories || []);
        for (const r of (sourceMem.recentMemories || [])) {
          if (r && !existingRecent.has(r)) {
            targetMem.recentMemories.push(r);
            existingRecent.add(r);
          }
        }

        // 合并 orderedNewMemories（去重追加到末尾）
        const targetOrdered = (targetMem as any).orderedNewMemories as Array<{ text: string; isCore: boolean; time?: string }> | undefined;
        const sourceOrdered = (sourceMem as any).orderedNewMemories as Array<{ text: string; isCore: boolean; time?: string }> | undefined;
        if (sourceOrdered && sourceOrdered.length > 0) {
          const existing = targetOrdered || [];
          const existingTexts = new Set(existing.map(o => o.text));
          const merged = [...existing];
          for (const item of sourceOrdered) {
            if (item.text && !existingTexts.has(item.text)) {
              merged.push(item);
              existingTexts.add(item.text);
            }
          }
          (targetMem as any).orderedNewMemories = merged;
        }

        // 标记手动编辑
        (targetMem as any)._manuallyEdited = true;

        // 删除副角色条目
        delta.characterMemories.splice(sourceIdx, 1);
      }
    }

    // ⭐ 关键修复：assembledSummary 对于 _manuallyEdited 的角色只使用最新 delta 的数据。
    // 因此需要把所有旧 delta 中合并到 target 的 orderedNewMemories 汇总到最新 delta。
    if (latestDelta && latestTargetMem) {
      const latestOrdered = (latestTargetMem as any).orderedNewMemories as Array<{ text: string; isCore: boolean; time?: string }> | undefined;
      const aggregatedTexts = new Set((latestOrdered || []).map(o => o.text));
      const aggregatedList = [...(latestOrdered || [])];

      // 同样汇总 coreMemories
      const latestCoreTexts = new Set(
        (latestTargetMem.coreMemories || []).map((c: any) => typeof c === 'string' ? c : (c?.text || '')),
      );

      // 遍历所有 delta（除最新），把 target 的 orderedNewMemories 和 coreMemories 汇总到最新
      for (let i = 0; i < chatData.value.summaries.length - 1; i++) {
        const delta = chatData.value.summaries[i];
        const targetMem = findCharacterMemoryByName(delta.characterMemories, targetName);
        if (!targetMem) continue;

        // 汇总 orderedNewMemories
        const ordered = (targetMem as any).orderedNewMemories as Array<{ text: string; isCore: boolean; time?: string }> | undefined;
        if (ordered && ordered.length > 0) {
          for (const item of ordered) {
            if (item.text && !aggregatedTexts.has(item.text)) {
              aggregatedList.push(item);
              aggregatedTexts.add(item.text);
            }
          }
        }

        // 汇总 coreMemories
        for (const core of (targetMem.coreMemories || [])) {
          const text = typeof core === 'string' ? core : ((core as any)?.text || '');
          if (text && !latestCoreTexts.has(text)) {
            latestTargetMem.coreMemories.push(core);
            latestCoreTexts.add(text);
          }
        }
      }

      (latestTargetMem as any).orderedNewMemories = aggregatedList;

      // 同步 aliases / keywords（取所有 delta 的并集）
      const allAliases = new Set<string>();
      const allKeywords = new Set<string>();
      for (const delta of chatData.value.summaries) {
        const mem = findCharacterMemoryByName(delta.characterMemories, targetName);
        if (mem) {
          (mem.aliases || []).forEach(a => allAliases.add(a));
          (mem.keywords || []).forEach(k => allKeywords.add(k));
        }
      }
      allAliases.add(sourceName); // 确保副角色原名一定在别名中
      latestTargetMem.aliases = cleanCharacterAliases([...allAliases], targetName);
      latestTargetMem.keywords = [...allKeywords];
    }

    const standaloneTarget = findCharacterMemoryByName(chatData.value.characterMemories, targetName);
    const standaloneSourceIdx = findCharacterMemoryIndexByName(chatData.value.characterMemories, sourceName);
    if (standaloneSourceIdx >= 0) {
      const sourceMem = normalizeCharacterMemoryArrays(chatData.value.characterMemories[standaloneSourceIdx]);
      if (standaloneTarget && standaloneTarget !== sourceMem) {
        standaloneTarget.aliases = cleanCharacterAliases([...(standaloneTarget.aliases || []), ...(sourceMem.aliases || []), sourceName], targetName);
        standaloneTarget.keywords = [...new Set([...(standaloneTarget.keywords || []), ...(sourceMem.keywords || [])])];
        const coreSeen = new Set((standaloneTarget.coreMemories || []).map((c: any) => typeof c === 'string' ? c : c?.text || ''));
        for (const core of sourceMem.coreMemories || []) {
          const text = typeof core === 'string' ? core : ((core as any)?.text || '');
          if (text && !coreSeen.has(text)) {
            standaloneTarget.coreMemories.push(core);
            coreSeen.add(text);
          }
        }
        const recentSeen = new Set(standaloneTarget.recentMemories || []);
        for (const item of sourceMem.recentMemories || []) {
          if (item && !recentSeen.has(item)) {
            standaloneTarget.recentMemories.push(item);
            recentSeen.add(item);
          }
        }
        chatData.value.characterMemories.splice(standaloneSourceIdx, 1);
      } else {
        sourceMem.characterName = targetName;
        sourceMem.aliases = cleanCharacterAliases([...(sourceMem.aliases || []), sourceName], targetName);
      }
    }

    const mergeCharacterNamedArray = <T extends { characterName: string }>(
      list: T[],
      mergeIntoTarget?: (target: T, source: T) => void,
    ): T[] => {
      const targetItem = list.find(item => matchesTarget(item.characterName));
      const result: T[] = [];
      for (const item of list) {
        if (matchesSource(item.characterName)) {
          if (targetItem && targetItem !== item) {
            mergeIntoTarget?.(targetItem, item);
            continue;
          }
          item.characterName = targetName;
        }
        const duplicateTarget = matchesTarget(item.characterName)
          && result.some(existing => matchesTarget(existing.characterName));
        if (!duplicateTarget) result.push(item);
      }
      return result;
    };

    chatData.value.dynamicProfilesV2 = mergeCharacterNamedArray(chatData.value.dynamicProfilesV2 || [], (target: any, source: any) => {
      if (!target.factualState && source.factualState) target.factualState = source.factualState;
      if (!target.dynamicProfile && source.dynamicProfile) target.dynamicProfile = source.dynamicProfile;
      target.lastUpdatedAt = target.lastUpdatedAt || source.lastUpdatedAt;
    });
    chatData.value.dynamicProfiles = mergeCharacterNamedArray(chatData.value.dynamicProfiles || [], (target: any, source: any) => {
      if (!target.dynamicContent && source.dynamicContent) target.dynamicContent = source.dynamicContent;
      target.lastUpdatedAt = target.lastUpdatedAt || source.lastUpdatedAt;
    });

    if (chatData.value.characterProfiles) {
      const sourceProfile = chatData.value.characterProfiles[sourceName];
      const targetProfile = chatData.value.characterProfiles[targetName];
      if (sourceProfile && !targetProfile) chatData.value.characterProfiles[targetName] = sourceProfile;
      if (sourceProfile) delete chatData.value.characterProfiles[sourceName];
    }
    for (const item of chatData.value.savedCharacterProfiles || []) {
      if (matchesSource(item.name)) item.name = targetName;
    }
    if (chatData.value.dreamtalk?.characterInteractions) {
      chatData.value.dreamtalk.characterInteractions = mergeCharacterNamedArray(
        chatData.value.dreamtalk.characterInteractions,
        (target, source) => {
          const seen = new Set((target.entries || []).map(e => `${e.text}|${e.prevent}|${e.scenario || ''}`));
          for (const entry of source.entries || []) {
            const key = `${entry.text}|${entry.prevent}|${entry.scenario || ''}`;
            if (!seen.has(key)) {
              seen.add(key);
              target.entries.push(entry);
            }
          }
        },
      );
    }

    // 3. NSFW 记忆：合并
    const targetNsfw = chatData.value.nsfwMemories.find(m => matchesTarget(m.characterName));
    const sourceNsfw = chatData.value.nsfwMemories.find(m => matchesSource(m.characterName));
    if (sourceNsfw) {
      if (targetNsfw) {
        // 合并去重
        const mergeArr = (a: string[], b: string[]) => [...new Set([...a, ...b])];
        targetNsfw.sensitivePoints = mergeArr(targetNsfw.sensitivePoints, sourceNsfw.sensitivePoints);
        targetNsfw.preferences = mergeArr(targetNsfw.preferences, sourceNsfw.preferences);
        targetNsfw.behaviors = mergeArr(targetNsfw.behaviors, sourceNsfw.behaviors);
        targetNsfw.memories = mergeArr(targetNsfw.memories, sourceNsfw.memories);
      } else {
        // 副角色有但主角色没有 → 重命名
        sourceNsfw.characterName = targetName;
      }
      // 删除副角色的 NSFW（如果已合并到主角色）
      if (targetNsfw) {
        chatData.value.nsfwMemories = chatData.value.nsfwMemories.filter(
          m => !matchesSource(m.characterName),
        );
      }
    }
    chatData.value.nsfwDynamicProfiles = mergeCharacterNamedArray(chatData.value.nsfwDynamicProfiles || [], (target, source) => {
      if (!target.sexualBehavior && source.sexualBehavior) target.sexualBehavior = source.sexualBehavior;
      target.lastUpdatedAt = target.lastUpdatedAt || source.lastUpdatedAt;
    });

    // 4. 关系档案：更新引用
    for (const rel of chatData.value.relationshipProfiles) {
      if (matchesSource(rel.from) || matchesSource(rel.fromName)) {
        rel.from = targetName;
        rel.fromName = targetName;
      }
      if (matchesSource(rel.to) || matchesSource(rel.toName)) {
        rel.to = targetName;
        rel.toName = targetName;
      }
      if (rel.from === '__zhino_user__' || rel.to === '__zhino_user__') {
        const charName = rel.from === '__zhino_user__' ? rel.to : rel.from;
        rel.id = `__zhino_user__::${charName}`;
      } else {
        rel.id = [rel.from, rel.to].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')).join('::');
      }
    }
    const relById = new Map<string, RelationshipProfile>();
    for (const rel of chatData.value.relationshipProfiles) {
      if (!relById.has(rel.id)) relById.set(rel.id, rel);
    }
    chatData.value.relationshipProfiles = [...relById.values()];

    for (const record of chatData.value.worldProgressRecords || []) {
      record.presentCharacters = rewriteNameList(record.presentCharacters);
      for (const ch of record.advancedCharacters || []) {
        if (matchesSource(ch.characterName)) ch.characterName = targetName;
      }
      for (const hook of record.resolvedHooks || []) {
        hook.characterNames = rewriteNameList(hook.characterNames);
      }
      if (record.entryHint && matchesSource(record.entryHint.characterName)) {
        record.entryHint.characterName = targetName;
      }
    }
    chatData.value.worldProgressMemories = (chatData.value.worldProgressMemories || []).map(mem => {
      if (matchesSource(mem.characterName)) mem.characterName = targetName;
      return mem;
    });
    for (const summary of chatData.value.smallSummaries || []) {
      summary.presentCharacters = rewriteNameList(summary.presentCharacters);
    }

    const rewriteCharacterTable = (table: CharacterEntry[] = []) =>
      table
        .map((c: CharacterEntry) => matchesSource(c.name)
          ? { ...c, name: targetName, aliases: cleanCharacterAliases([...(c.aliases || []), sourceName], targetName) }
          : c)
        .filter((c: CharacterEntry, idx: number, arr: CharacterEntry[]) =>
          !matchesSource(c.name)
          && arr.findIndex(x => normalizeMemoryCharacterName(x.name) === normalizeMemoryCharacterName(c.name)) === idx,
        );
    for (const delta of chatData.value.summaries || []) {
      delta.characterTable = rewriteCharacterTable(delta.characterTable || []);
    }
    for (const summary of chatData.value.summaryHistory || []) {
      summary.characterTable = rewriteCharacterTable(summary.characterTable || []);
    }

    // 6b. 角色位置映射：仅删除副角色 key，主角色位置保持不变。
    // 语义：A 合并到 B → B 是真身，B 留在自己的位置上；A 只是 B 的别名，
    //      不应该用 A 那个旧位置去覆盖 B 的当前真实位置。
    // 图谱节点视图层从 characterLocations 渲染，必须删 A 的 key，
    // 否则"师尊"会残留在旧地点边上。
    const rewriteCharacterLocationMap = (locations?: Record<string, string>) => {
      const locMap = { ...(locations || {}) };
      let sourceLoc = '';
      let hasTargetLoc = false;
      for (const [name, loc] of Object.entries(locMap)) {
        if (matchesTarget(name)) hasTargetLoc = true;
        if (matchesSource(name) || name === buildStableId(sourceName)) {
          sourceLoc = sourceLoc || loc;
          delete locMap[name];
        }
      }
      if (!hasTargetLoc && sourceLoc) locMap[targetName] = sourceLoc;
      return locMap;
    };
    chatData.value.characterLocations = rewriteCharacterLocationMap(chatData.value.characterLocations);

    // 6c. 知识图谱：归并角色节点、迁移 belongs_to 边、合并 aliases。
    // 同步处理 knowledgeGraph / knowledgeGraphVersions / knowledgeGraphHistory / knowledgeGraphUndoHistory，
    // 防止回滚/楼层图谱把副角色又带回来。
    const rewriteGraph = (g: KnowledgeGraph | null): KnowledgeGraph | null => {
      if (!g) return g;
      const ng: KnowledgeGraph = JSON.parse(JSON.stringify(g));
      const sourceId = buildStableId(sourceName);
      const targetId = buildStableId(targetName);
      // 6c-1 角色节点归并
      const targetExisting = ng.characters?.find(c =>
        c.id === targetId
        || matchesTarget(c.name)
        || (c.aliases || []).some(a => matchesTarget(a)),
      );
      const sourceExisting = ng.characters?.find(c =>
        c.id === sourceId
        || matchesSource(c.name)
        || (c.aliases || []).some(a => matchesSource(a)),
      );
      if (sourceExisting) {
        if (targetExisting) {
          // 合并 aliases：把副角色 aliases 和副角色原名并入主角色
          targetExisting.aliases = cleanCharacterAliases([
            ...(targetExisting.aliases || []),
            ...(sourceExisting.aliases || []),
            sourceName,
            sourceExisting.name,
          ], targetName);
          // location 优先取主角色，空了取副角色
          if (!targetExisting.location && sourceExisting.location) {
            targetExisting.location = sourceExisting.location;
          }
        } else {
          // 主角色不存在 → 把副角色节点重命名为主角色
          sourceExisting.id = targetId;
          sourceExisting.name = targetName;
          sourceExisting.aliases = cleanCharacterAliases([...(sourceExisting.aliases || []), sourceName], targetName);
        }
        // 删除副角色节点（仅保留主角色那一条）
        ng.characters = (ng.characters || []).filter(c =>
          c !== sourceExisting || c === targetExisting,
        );
        // 上面 (c !== sourceExisting || c === targetExisting) 的语义：
        // 保留所有非副角色节点 + 主角色节点（若主角色===副角色引用后者已被改名）。
      }
      // 6c-2 edges：belongs_to.to 指向副角色名的，改写为主角色名并去重
      const seenBelongsTo = new Set<string>();
      ng.edges = (ng.edges || []).map(e => {
        if (e.type === 'belongs_to' && (matchesSource(e.to) || e.to === sourceId)) {
          e.to = targetName;
        }
        return e;
      }).filter(e => {
        if (e.type !== 'belongs_to') return true;
        const key = `${e.from}|${e.to}`;
        if (seenBelongsTo.has(key)) return false; // 去重：合并后可能出现重复
        seenBelongsTo.add(key);
        return true;
      });
      // 6c-3 物品新字段同步：item.owner / item.location 指向副角色名的，改写为主角色名
      ng.items = (ng.items || []).map(it => {
        const newOwner = matchesSource(it.owner) || it.owner === sourceId ? targetName : it.owner;
        const newLocation = matchesSource(it.location) || it.location === sourceId ? targetName : it.location;
        if (newOwner === it.owner && newLocation === it.location) return it;
        return { ...it, owner: newOwner, location: newLocation };
      });
      return ng;
    };
    chatData.value.knowledgeGraph = rewriteGraph(chatData.value.knowledgeGraph);
    chatData.value.knowledgeGraphVersions = (chatData.value.knowledgeGraphVersions || []).map(v => ({
      ...v,
      graph: rewriteGraph(v.graph) as KnowledgeGraph,
      characterLocations: rewriteCharacterLocationMap(v.characterLocations),
    }));
    chatData.value.knowledgeGraphHistory = (chatData.value.knowledgeGraphHistory || []).map(g => rewriteGraph(g) as KnowledgeGraph);
    chatData.value.knowledgeGraphUndoHistory = (chatData.value.knowledgeGraphUndoHistory || []).map(g => rewriteGraph(g) as KnowledgeGraph);

    // 强制触发 Vue 响应式更新：替换所有 delta 引用，确保 assembledSummary 重算
    chatData.value.summaries = chatData.value.summaries.map(d => ({ ...d }));

    // P4: 同步 registry 成真相源（13 处字符串替换完成后，registry 与快照双轨一致）
    // rename 模式：source(旧主名) 的 record 改 primaryName 为 target(新名)，旧名自动进 aliases
    // merge 模式：source(副角色) 标记 mergedInto target，source 主名+别名并入 target aliases
    // —— 从 registry 层面保证"改名旧名进别名""合并副角色名进主角色别名"必定生效
    const _registry = chatData.value.characterRegistry;
    if (_registry && _registry.records) {
      if (mode === 'rename') {
        const sourceId = resolveKnownCharacterId(sourceName);
        if (sourceId) {
          renameInRegistry(_registry, sourceId, targetName);
        }
      } else {
        const targetId = resolveKnownCharacterId(targetName);
        const sourceId = resolveKnownCharacterId(sourceName);
        if (targetId && sourceId) {
          mergeInRegistry(_registry, targetId, sourceId);
        }
      }
    }

    // 持久化
    doPersist();
    rebuildAssembled();
    pushCodeLog({
      id: _codeLogIdCounter++,
      timestamp: new Date().toISOString(),
      module: '存储',
      level: 'info',
      message: (mode === 'rename' ? `改名完成: "${sourceName}" → "${targetName}"` : `合并完成: "${sourceName}" → "${targetName}"`),
    });
    return true;
  }

  // ========== 角色改名 ==========

  /**
   * 将角色 oldName 改名为 newName。
   * 内部复用 mergeCharacters 的全源重写逻辑（当 target 是空位时走纯改名分支）：
   * 主名全部改为 newName，旧名自动保留为 aliases。
   * 若 newName（按归一化判断）已命中角色库其它角色，返回 false — 由 UI 引导用户改用合并功能。
   */
  function renameCharacter(oldName: string, newName: string): boolean {
    const oldCanonical = resolveKnownCharacterName((oldName || '').trim(), true);
    if (!oldCanonical) return false;
    if (isUserCharacterName(oldCanonical)) return false;
    const newNormed = (newName || '').trim();
    if (!newNormed || isUserCharacterName(newNormed)) return false;
    const oldNorm = normalizeMemoryCharacterName(oldCanonical);
    const newNorm = normalizeMemoryCharacterName(newNormed);
    if (!oldNorm || !newNorm || oldNorm === newNorm) return false;
    // 撞名校验：判断"新名"是否被角色库里【除了本角色以外】的其它角色占用了主名或别名。
    //   resolveKnownCharacterName(newNormed) 默认 fallback=false，未命中时返回 newNormed 原文（非空），
    //   不能直接据其非空判为"撞别人"。正确判法：解析结果若等于新名自身归一化 → 未命中既有角色 → 放行；
    //   若命中某既有角色且其主名归一化≠本角色 oldNorm → 撞别人 → 拒绝。
    const resolvedNew = resolveKnownCharacterName(newNormed);
    const resolvedIsSelf = normalizeMemoryCharacterName(resolvedNew) === newNorm;
    if (resolvedNew && !resolvedIsSelf && normalizeMemoryCharacterName(resolvedNew) !== oldNorm) return false;
    // 复用 mergeCharacters 全源重写：target 为空位（或本角色别名）时走纯改名分支，
    // mergeCharacters 内 mode==='rename' 时不再对 target 归一化，旧名自动进 aliases。
    return mergeCharacters(newNormed, oldCanonical, 'rename');
  }

  // ========== 角色删除管理 ==========

  /**
   * 彻底删除角色：从所有 13+ 数据源清除该角色的全部信息。
   * 物品保留，但归属（owner/location）命中该角色名时置空。
   * 此操作不可撤销，不再走「忽略+备份」机制。
   */
  function deleteCharacter(name: string) {
    const resolved = resolveKnownCharacterName(name, true);
    const normName = normalizeMemoryCharacterName(resolved || name);
    if (!resolved || !normName) return;
    // 名字匹配器：归一化后相等，或原名直接相等
    const matches = (n?: string) => {
      if (!n) return false;
      if (n === resolved || n === name) return true;
      return normalizeMemoryCharacterName(n) === normName;
    };

    // 1. 顶层 characterMemories
    chatData.value.characterMemories = (chatData.value.characterMemories || []).filter(m => !matches(m.characterName));

    // 2. summaries 各 delta：characterMemories + characterTable
    for (const summary of chatData.value.summaries || []) {
      summary.characterMemories = (summary.characterMemories || []).filter(m => !matches(m.characterName));
      if (summary.characterTable) {
        summary.characterTable = summary.characterTable.filter((e: any) => !matches(e.name));
      }
    }

    // 3. 动态人设 V1 + V2
    chatData.value.dynamicProfiles = (chatData.value.dynamicProfiles || []).filter(p => !matches(p.characterName));
    chatData.value.dynamicProfilesV2 = (chatData.value.dynamicProfilesV2 || []).filter(p => !matches(p.characterName));

    // 4. 人设档案 + 已保存人设档案
    if (chatData.value.characterProfiles) {
      for (const key of Object.keys(chatData.value.characterProfiles)) {
        if (matches(key)) delete chatData.value.characterProfiles[key];
      }
    }
    chatData.value.savedCharacterProfiles = (chatData.value.savedCharacterProfiles || []).filter(p => !matches(p.name));

    // 5. 关系档案：移除 from/to 命中该角色的条目
    chatData.value.relationshipProfiles = (chatData.value.relationshipProfiles || []).filter(p =>
      !matches(p.fromName) && !matches(p.from) && !matches(p.toName) && !matches(p.to),
    );

    // 6. 角色位置
    if (chatData.value.characterLocations) {
      for (const key of Object.keys(chatData.value.characterLocations)) {
        if (matches(key)) delete chatData.value.characterLocations[key];
      }
    }

    // 7. NSFW
    chatData.value.nsfwMemories = (chatData.value.nsfwMemories || []).filter(m => !matches(m.characterName));
    chatData.value.nsfwDynamicProfiles = (chatData.value.nsfwDynamicProfiles || []).filter(p => !matches(p.characterName));

    // 8. 梦呓
    if (chatData.value.dreamtalk?.characterInteractions) {
      chatData.value.dreamtalk.characterInteractions = chatData.value.dreamtalk.characterInteractions.filter(
        i => !matches(i.characterName),
      );
    }

    // 9. 世界推进
    chatData.value.worldProgressMemories = (chatData.value.worldProgressMemories || []).filter(m => !matches(m.characterName));
    for (const record of chatData.value.worldProgressRecords || []) {
      if (record.advancedCharacters) {
        record.advancedCharacters = record.advancedCharacters.filter((c: any) => !matches(c.characterName));
      }
      if (record.presentCharacters) {
        record.presentCharacters = record.presentCharacters.filter((n: string) => !matches(n));
      }
      if (record.entryHint && matches(record.entryHint.characterName)) {
        record.entryHint.characterName = '';
      }
      for (const hook of record.resolvedHooks || []) {
        if (hook.characterNames) {
          hook.characterNames = hook.characterNames.filter((n: string) => !matches(n));
        }
      }
    }

    // 10. 知识图谱：移除角色节点 + 物品 owner/location 命中则置空（不删物品）
    const cleanGraph = (g: KnowledgeGraph | null): KnowledgeGraph | null => {
      if (!g) return g;
      const ng: KnowledgeGraph = JSON.parse(JSON.stringify(g));
      ng.characters = (ng.characters || []).filter(c => !matches(c.name) && !(c.aliases || []).some(a => matches(a)));
      ng.items = (ng.items || []).map(it => {
        let changed = false;
        let owner = it.owner;
        let location = it.location;
        if (matches(it.owner)) { owner = ''; changed = true; }
        if (matches(it.location)) { location = ''; changed = true; }
        return changed ? { ...it, owner, location } : it;
      });
      // edges：移除涉及该角色的 belongs_to/关系边（to 或 from 命中）
      ng.edges = (ng.edges || []).filter(e =>
        !matches(e.from) && !matches(e.to) && !matches(e.fromName) && !matches(e.toName),
      );
      return ng;
    };
    chatData.value.knowledgeGraph = cleanGraph(chatData.value.knowledgeGraph);
    chatData.value.knowledgeGraphVersions = (chatData.value.knowledgeGraphVersions || []).map(v => ({
      ...v,
      graph: cleanGraph(v.graph || null),
    }));
    if (chatData.value.knowledgeGraphHistory) {
      chatData.value.knowledgeGraphHistory = chatData.value.knowledgeGraphHistory.map(v => ({
        ...v,
        graph: cleanGraph(v.graph || null),
      }));
    }
    if (chatData.value.knowledgeGraphUndoHistory) {
      chatData.value.knowledgeGraphUndoHistory = chatData.value.knowledgeGraphUndoHistory.map(v => ({
        ...v,
        graph: cleanGraph(v.graph || null),
      }));
    }

    // 11. 物品记忆库：currentOwner/currentLocation 命中则置空（保留物品条目）
    for (const item of chatData.value.itemMemories || []) {
      if (matches(item.currentOwner)) item.currentOwner = '';
      if (matches(item.currentLocation)) item.currentLocation = '';
      if (item.relatedCharacters) {
        item.relatedCharacters = item.relatedCharacters.filter(n => !matches(n));
      }
      for (const h of item.history || []) {
        if (matches(h.owner)) h.owner = '';
      }
    }

    // 12. 角色注册表：移除该角色 record（含别名命中）
    const _registry = chatData.value.characterRegistry;
    if (_registry && _registry.records) {
      for (const id of Object.keys(_registry.records)) {
        const rec = _registry.records[id];
        if (matches(rec.primaryName) || (rec.aliases || []).some(a => matches(a))) {
          delete _registry.records[id];
        }
      }
    }

    rebuildAssembled();
    pushCodeLog({
      id: _codeLogIdCounter++,
      timestamp: new Date().toISOString(),
      module: '存储',
      level: 'info',
      message: `已删除角色: ${resolved}（全部关联数据已清除，物品归属置空）`,
    });
  }

  // ========== 梦呓相关 ==========

  function updateDreamtalk(data: DreamtalkData) {
    if (data?.characterInteractions?.length) {
      const byNorm = new Map<string, DreamtalkData['characterInteractions'][number]>();
      for (const interaction of data.characterInteractions) {
        const rawName = interaction.characterName;
        const canonical = resolveKnownCharacterName(rawName, true);
        if (!canonical) continue;
        interaction.characterName = canonical;
        const key = normalizeMemoryCharacterName(canonical);
        const existing = byNorm.get(key);
        if (existing && existing !== interaction) {
          const seen = new Set((existing.entries || []).map(e => `${e.text}|${e.prevent}|${e.scenario || ''}`));
          for (const entry of interaction.entries || []) {
            const entryKey = `${entry.text}|${entry.prevent}|${entry.scenario || ''}`;
            if (!seen.has(entryKey)) {
              existing.entries.push(entry);
              seen.add(entryKey);
            }
          }
        } else {
          byNorm.set(key, interaction);
        }
      }
      data.characterInteractions = [...byNorm.values()];
    }
    if (chatData.value.dreamtalk) {
      chatData.value.dreamtalkHistory.push(JSON.parse(JSON.stringify(chatData.value.dreamtalk)));
      if (chatData.value.dreamtalkHistory.length > 5) {
        chatData.value.dreamtalkHistory.shift();
      }
    }
    chatData.value.dreamtalk = data;
    doPersist(); // 立即落盘
  }

  function rollbackDreamtalk(): DreamtalkData | null {
    if (!chatData.value.dreamtalk || chatData.value.dreamtalkHistory.length === 0) {

      return null;
    }
    chatData.value.dreamtalkUndoHistory.push(JSON.parse(JSON.stringify(chatData.value.dreamtalk)));
    if (chatData.value.dreamtalkUndoHistory.length > 5) {
      chatData.value.dreamtalkUndoHistory.shift();
    }
    const restored = chatData.value.dreamtalkHistory.pop()!;
    chatData.value.dreamtalk = restored;

    return restored;
  }

  function restoreDreamtalk(): DreamtalkData | null {
    if (!chatData.value.dreamtalk || chatData.value.dreamtalkUndoHistory.length === 0) {

      return null;
    }
    chatData.value.dreamtalkHistory.push(JSON.parse(JSON.stringify(chatData.value.dreamtalk)));
    if (chatData.value.dreamtalkHistory.length > 5) {
      chatData.value.dreamtalkHistory.shift();
    }
    const restored = chatData.value.dreamtalkUndoHistory.pop()!;
    chatData.value.dreamtalk = restored;

    return restored;
  }

  function getDreamtalkCharacterNames(): string[] {
    if (!chatData.value.dreamtalk) return [];
    return resolveKnownCharacterNames(
      chatData.value.dreamtalk.characterInteractions.map(i => i.characterName),
      true,
    );
  }

  // ========== NSFW隔离层相关 ==========

  const nsfwMemories = computed(() => chatData.value.nsfwMemories);
  const nsfwDreamtalk = computed(() => chatData.value.nsfwDreamtalk);
  const nsfwDynamicProfiles = computed(() => chatData.value.nsfwDynamicProfiles);

  function updateNsfwMemories(memories: NsfwCharacterMemory[]) {
    for (const mem of memories) {
      mem.characterName = resolveKnownCharacterName(mem.characterName, true);
      const existing = chatData.value.nsfwMemories.find(m =>
        normalizeMemoryCharacterName(m.characterName) === normalizeMemoryCharacterName(mem.characterName),
      );
      if (existing) {
        const mergeSet = (target: string[], source: string[]) => {
          const exist = new Set(target);
          for (const s of source) { if (!exist.has(s)) target.push(s); }
        };
        mergeSet(existing.sensitivePoints, mem.sensitivePoints);
        mergeSet(existing.memories, mem.memories);
        // 性爱偏好和行为模式：覆盖（每次大总结输出完整当前值）
        existing.preferences = mem.preferences;
        existing.behaviors = mem.behaviors;
        existing.lastUpdatedAt = new Date().toISOString();
      } else {
        chatData.value.nsfwMemories.push(mem);
      }
    }
  }

  function updateNsfwDreamtalk(data: NsfwDreamtalkData) {
    chatData.value.nsfwDreamtalk = data;
    doPersist();
  }

  function updateNsfwDynamicProfile(profile: NsfwDynamicProfile) {
    profile.characterName = resolveKnownCharacterName(profile.characterName, true);
    const existing = chatData.value.nsfwDynamicProfiles.find(p =>
      normalizeMemoryCharacterName(p.characterName) === normalizeMemoryCharacterName(profile.characterName),
    );
    if (existing) {
      Object.assign(existing, profile);
    } else {
      chatData.value.nsfwDynamicProfiles.push(profile);
    }
  }

  // ========== 世界推进相关 ==========

  const worldProgressManualChars = computed(() => chatData.value.worldProgressManualChars);

  function updateWorldProgressManualChars(val: string) {
    chatData.value.worldProgressManualChars = val;
    forcePersist();
  }

  // ========== 世界书蒸馏相关 ==========

  const distillRecords = computed(() => scriptData.value.settings.distillRecords || []);

  function upsertDistillRecord(record: DistillRecord) {
    const list = scriptData.value.settings.distillRecords || [];
    const byId = new Map(list.map(r => [r.id, r]));
    byId.set(record.id, record);
    scriptData.value.settings.distillRecords = [...byId.values()];
    saveSettingsToLocal(scriptData.value);
  }

  function updateDistillRecord(updated: DistillRecord) {
    upsertDistillRecord(updated);
  }

  function removeDistillRecord(id: string) {
    const list = scriptData.value.settings.distillRecords || [];
    scriptData.value.settings.distillRecords = list.filter(r => r.id !== id);
    saveSettingsToLocal(scriptData.value);
  }

  function clearDistillRecords() {
    scriptData.value.settings.distillRecords = [];
    saveSettingsToLocal(scriptData.value);
  }

  // ========== 关系档案相关 ==========

  const relationshipProfiles = computed(() => chatData.value.relationshipProfiles);

  function updateRelationshipProfiles(profiles: RelationshipProfile[]) {
    const byId = new Map(chatData.value.relationshipProfiles.map(profile => [profile.id, profile]));
    for (const profile of profiles) {
      if (profile.from !== '__zhino_user__') {
        profile.from = resolveKnownCharacterName(profile.fromName || profile.from, true);
        profile.fromName = profile.from;
      } else {
        profile.fromName = getUserName();
      }
      if (profile.to !== '__zhino_user__') {
        profile.to = resolveKnownCharacterName(profile.toName || profile.to, true);
        profile.toName = profile.to;
      } else {
        profile.toName = getUserName();
      }
      if (profile.from === '__zhino_user__' || profile.to === '__zhino_user__') {
        const charName = profile.from === '__zhino_user__' ? profile.to : profile.from;
        profile.id = `__zhino_user__::${charName}`;
      } else {
        profile.id = [profile.from, profile.to].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')).join('::');
      }
      byId.set(profile.id, profile);
    }
    chatData.value.relationshipProfiles = [...byId.values()];
    doPersist();
  }

  function removeRelationshipProfile(id: string) {
    chatData.value.relationshipProfiles = chatData.value.relationshipProfiles.filter(profile => profile.id !== id);
    doPersist();
  }

  function clearRelationshipProfiles() {
    chatData.value.relationshipProfiles = [];
    doPersist();
  }

  // ========== 知识图谱相关 ==========

	  /** 当前图谱快照（只读 computed；首次访问时顺带做旧版数据迁移） */
	  const knowledgeGraph = computed(() => {
	    const raw = chatData.value.knowledgeGraph;
	    chatData.value.knowledgeGraphEmbeddingCache = ensureKnowledgeGraphEmbeddingCache(
	      chatData.value.knowledgeGraphEmbeddingCache,
	    );
// 旧版数据迁移：有 knowledgeGraph 但无 knowledgeGraphVersions → 创建初始版本
		    if (raw && (!chatData.value.knowledgeGraphVersions || chatData.value.knowledgeGraphVersions.length === 0)) {
		      chatData.value.knowledgeGraphVersions = [{
		        floor: 0,
		        graph: stripEmbeddingsFromGraph(raw),
		        characterLocations: { ...(chatData.value.characterLocations || {}) },
		      }];
		    }
		    // 一次性瘦身：旧存档可能因早期版本无封顶累积了超量版本数组（致内存暴涨），加载时截到最近 6 份
		    const _versions = chatData.value.knowledgeGraphVersions;
		    if (_versions && _versions.length > KNOWLEDGE_GRAPH_VERSION_LIMIT) {
		      chatData.value.knowledgeGraphVersions = _versions.slice(_versions.length - KNOWLEDGE_GRAPH_VERSION_LIMIT);
		      forcePersist();
		    }
	    if (!raw) return raw;
	    // 一次性迁移：检测到旧字段（category/important/adjacent）则归一化并写回
	    const needs =
	      raw.locations.some(l => (l as any).category !== undefined) ||
	      raw.items.some(i => (i as any).category !== undefined || (i as any).important !== undefined) ||
	      raw.edges.some(e => (e as any).type === 'adjacent');
	    if (needs) {
	      const normalized = normalizeLegacyGraph(raw);
	      if (normalized) {
	        chatData.value.knowledgeGraph = normalized;
	        // 同步更新版本数组中最新的图谱
	        const versions = chatData.value.knowledgeGraphVersions;
	        if (versions && versions.length > 0) {
	          versions[versions.length - 1].graph = normalized;
	        }
	        forcePersist();
	      }
	      return normalized;
	    }
	    // 物品归属字段迁移：旧 belongs_to 边 → item.owner/location/status/statusDetail
	    // 检测条件：图谱里还有 belongs_to 边，且物品尚未挂上新字段（典型旧数据）
	    const hasLegacyBelongEdges = (raw.edges || []).some(e => e.type === 'belongs_to');
	    const anyItemMissingNewFields = (raw.items || []).some(
	      it => it.owner === undefined && it.location === undefined && it.status === undefined && it.statusDetail === undefined,
	    );
	    if (hasLegacyBelongEdges && anyItemMissingNewFields) {
	      const migrated = migrateItemPlacement(raw);
	      if (migrated) {
	        chatData.value.knowledgeGraph = migrated;
	        // 同步更新版本数组中最新的图谱
	        const versions = chatData.value.knowledgeGraphVersions;
	        if (versions && versions.length > 0) {
	          versions[versions.length - 1].graph = stripEmbeddingsFromGraph(migrated);
	        }
	        forcePersist();
	      }
	      return migrated;
	    }
	    return raw;
	  });
  /** 角色位置映射（只读 computed） */
  const characterLocations = computed(() => chatData.value.characterLocations);

  function cloneCharacterLocations(map?: Record<string, string> | null): Record<string, string> {
    return { ...(map || {}) };
  }

  function sanitizeCharacterLocationsForGraph(
    map: Record<string, string> | undefined | null,
    graph: KnowledgeGraph | null,
  ): Record<string, string> {
    if (!map) return {};
    if (!graph) return cloneCharacterLocations(map);
    const locIds = new Set((graph.locations || []).map(l => l.id));
    const result: Record<string, string> = {};
    for (const [name, locId] of Object.entries(map)) {
      if (locId && locIds.has(locId)) result[name] = locId;
    }
    return result;
  }

  function pruneKnowledgeGraphVectorCache(): void {
    const cache = ensureKnowledgeGraphEmbeddingCache(chatData.value.knowledgeGraphEmbeddingCache);
    chatData.value.knowledgeGraphEmbeddingCache = cache;
    pruneKnowledgeGraphEmbeddingCache(cache, [
      chatData.value.knowledgeGraph,
      ...(chatData.value.knowledgeGraphVersions || []).map(v => v.graph),
    ]);
  }

  function normalizeKnowledgeGraphCharacterNames(graph: KnowledgeGraph): void {
    const characters = graph.characters || [];
    const byNorm = new Map<string, typeof characters[number]>();
    const lookup = new Map<string, string>();
    const remember = (raw: string | undefined, canonical: string) => {
      const value = String(raw || '').trim();
      if (!value) return;
      lookup.set(value, canonical);
      lookup.set(buildStableId(value), canonical);
      lookup.set(normalizeMemoryCharacterName(value), canonical);
    };

    const normalizedCharacters: typeof characters = [];
    for (const ch of characters) {
      const rawName = ch.name;
      const canonical = resolveKnownCharacterName(rawName, true);
      if (!canonical) continue;
      remember(rawName, canonical);
      remember(ch.id, canonical);
      for (const alias of ch.aliases || []) remember(alias, canonical);

      const key = normalizeMemoryCharacterName(canonical);
      const aliases = cleanCharacterAliases([...(ch.aliases || []), rawName], canonical);
      const existing = byNorm.get(key);
      if (existing) {
        existing.aliases = cleanCharacterAliases([...(existing.aliases || []), ...aliases], canonical);
        if (!existing.location && ch.location) existing.location = ch.location;
        continue;
      }

      ch.name = canonical;
      ch.id = buildStableId(canonical);
      ch.aliases = aliases.length > 0 ? aliases : undefined;
      byNorm.set(key, ch);
      normalizedCharacters.push(ch);
    }

    graph.characters = normalizedCharacters;
    for (const edge of graph.edges || []) {
      if (edge.type !== 'belongs_to') continue;
      const canonical = lookup.get(edge.to)
        || lookup.get(buildStableId(edge.to))
        || lookup.get(normalizeMemoryCharacterName(edge.to));
      if (canonical) edge.to = canonical;
    }
    // 物品 owner / location 同步重写为规范化角色名
    for (const item of graph.items || []) {
      for (const field of ['owner', 'location'] as const) {
        const raw = (item as any)[field];
        if (typeof raw !== 'string' || !raw) continue;
        const canonical = lookup.get(raw)
          || lookup.get(buildStableId(raw))
          || lookup.get(normalizeMemoryCharacterName(raw));
        if (canonical && canonical !== raw) (item as any)[field] = canonical;
      }
    }
  }

	  /**
	   * 提交新版本图谱：按楼层截断版本数组（重roll/回退场景自动作废旧版），
	   * 旧版进撤回栈（≤6），清空恢复栈，赋值新版，立即落盘。
	   */
function commitKnowledgeGraph(
				    nextGraph: KnowledgeGraph,
				    floor?: number,
				    characterLocationsSnapshot?: Record<string, string>,
				    presentCharacterNames?: ReadonlySet<string> | string[] | null,
				  ): void {
          normalizeKnowledgeGraphCharacterNames(nextGraph);
          // 离场降级（A 方案兜底）：不在本轮在场集合中的角色身上的瞬时持有态
          // （held/worn/carried）→ 清 status / statusDetail，location 回填为 owner
          // （东西还在该角色那儿，但当下持有方式不明）。必须在 hydrateKnowledgeGraphEmbeddingsFromCache
          // 之前执行：向量缓存按降级后的新 textHash 查询，命中即用、未命中走 lazy 重算。
          // 空集合/null → 跳过（回滚分支不降级，避免回退时再"清理"在场历史）。
          if (presentCharacterNames) {
            const names: string[] = Array.isArray(presentCharacterNames)
              ? [...presentCharacterNames]
              : Array.from(presentCharacterNames);
            try {
              const userName = getUserName();
              if (userName) names.push(userName);
            } catch {
              /* getUserName 访问 store 依赖，理论不抛，此处兜底 */
            }
            demoteAbsentItems(nextGraph, names);
          }
			    const cache = ensureKnowledgeGraphEmbeddingCache(chatData.value.knowledgeGraphEmbeddingCache);
			    chatData.value.knowledgeGraphEmbeddingCache = cache;
			    const cur = chatData.value.knowledgeGraph;
			    syncKnowledgeGraphEmbeddingCache(cur, cache);
			    hydrateKnowledgeGraphEmbeddingsFromCache(nextGraph, cache);
			    const history = chatData.value.knowledgeGraphHistory || [];
			    if (cur) {
			      // 撤回栈不需要 embedding：用 strip 克隆入栈，保留原图在主图谱做召回
			      history.push(stripEmbeddingsFromGraph(cur));
			      if (history.length > KNOWLEDGE_GRAPH_VERSION_LIMIT) history.shift();
			      chatData.value.knowledgeGraphHistory = history;
			    }
			    chatData.value.knowledgeGraphUndoHistory = [];
			    // 楼层感知：截断 >= floor 的旧版本，追加新版，版本号对齐楼层
			    if (floor !== undefined) {
			      const versions = chatData.value.knowledgeGraphVersions || [];
			      const truncated = versions.filter(v => v.floor < floor);
			      nextGraph.version = floor;
			      const locSnapshot = sanitizeCharacterLocationsForGraph(
			        characterLocationsSnapshot ?? chatData.value.characterLocations,
			        nextGraph,
			      );
			      // 版本栈只存结构，strip embedding（召回统一走主图谱）
			      truncated.push({
			        floor,
			        graph: stripEmbeddingsFromGraph(nextGraph),
			        characterLocations: locSnapshot,
			      });
			      // 封顶 ≤6：丢弃最旧版本，防止每轮 push 整图快照无界累积导致内存暴涨
			      if (truncated.length > KNOWLEDGE_GRAPH_VERSION_LIMIT) {
			        truncated.splice(0, truncated.length - KNOWLEDGE_GRAPH_VERSION_LIMIT);
			      }
			      chatData.value.knowledgeGraphVersions = truncated;
			    }
			    chatData.value.knowledgeGraph = nextGraph;
		    // 同步 graph.characters → characterLocations（UI 角色节点渲染依赖 characterLocations，
		    // 但 applyKnowledgeGraphDiff 只写 graph.characters 不写 characterLocations，导致
		    // 世界推进中的不在场角色被加进图谱却不出现在 UI 上）
		    // 收紧：只补缺失项，且要求 ch.location 非空、对应的稳定 id 真实存在于
		    // nextGraph.locations 里——避免把空 location 或已删地点当作"游离地点"塞回映射，
		    // 让旧角色-地点边在清空图谱/重 roll 后继续残留。
		    if (nextGraph.characters && nextGraph.characters.length > 0) {
		      const locIdSet = new Set((nextGraph.locations || []).map(l => l.id));
		      const locMap = sanitizeCharacterLocationsForGraph(
		        characterLocationsSnapshot ?? chatData.value.characterLocations,
		        nextGraph,
		      );
		      for (const ch of nextGraph.characters) {
		        if (!ch.location) continue;
		        const locId = buildStableId(ch.location);
		        if (!locIdSet.has(locId)) continue; // 地点不存在 → 不写映射，避免游离地点边
		        if (!locMap[ch.name]) locMap[ch.name] = locId;
		      }
		      chatData.value.characterLocations = locMap;
		    } else if (characterLocationsSnapshot) {
		      chatData.value.characterLocations = sanitizeCharacterLocationsForGraph(characterLocationsSnapshot, nextGraph);
		    }
		    syncKnowledgeGraphEmbeddingCache(nextGraph, cache);
		    pruneKnowledgeGraphVectorCache();
		    forcePersist();
		  }

	  /**
	   * 取指定楼层之前的最新图谱版本（用于注入时楼层感知）。
	   * 只返回 floor < targetFloor 的最新版本；无合适版本返回 null。
	   */
	  function getKnowledgeGraphStateForFloor(targetFloor: number): KnowledgeGraphState {
	    const versions = chatData.value.knowledgeGraphVersions;
	    if (!versions || versions.length === 0) return { graph: null, characterLocations: {} };
	    let best: KnowledgeGraphVersion | null = null;
	    for (const v of versions) {
	      if (v.floor < targetFloor && (!best || v.floor > best.floor)) {
	        best = v;
	      }
	    }
	    if (!best?.graph) return { graph: null, characterLocations: {} };
	    const snapshot = best.characterLocations && Object.keys(best.characterLocations).length > 0
	      ? best.characterLocations
	      : sanitizeCharacterLocationsForGraph(chatData.value.characterLocations || {}, best.graph);
	    return {
	      graph: best.graph,
	      characterLocations: sanitizeCharacterLocationsForGraph(snapshot, best.graph),
	    };
	  }

	  function getKnowledgeGraphForFloor(targetFloor: number): KnowledgeGraph | null {
	    return getKnowledgeGraphStateForFloor(targetFloor).graph;
	  }

	  /** 撤回上一版图谱（旧版还原，当前版入恢复栈） */
	  function rollbackKnowledgeGraph(): boolean {
	    const history = chatData.value.knowledgeGraphHistory || [];
	    if (history.length === 0) return false;
	    const cur = chatData.value.knowledgeGraph;
	    const undoHist = chatData.value.knowledgeGraphUndoHistory || [];
	    if (cur) {
	      undoHist.push(cur);
	      if (undoHist.length > KNOWLEDGE_GRAPH_VERSION_LIMIT) undoHist.shift();
	      chatData.value.knowledgeGraphUndoHistory = undoHist;
	    }
	    const prev = history.pop()!;
	    chatData.value.knowledgeGraphHistory = history;
	    chatData.value.knowledgeGraph = prev;
	    // 同步版本数组：移除最后一项
	    const versions = chatData.value.knowledgeGraphVersions;
	    if (versions && versions.length > 0) {
	      versions.pop();
	    }
	    forcePersist();
	    return true;
	  }

	  /** 恢复被撤回的图谱（与 rollback 反向） */
	  function restoreKnowledgeGraph(): boolean {
	    const undoHist = chatData.value.knowledgeGraphUndoHistory || [];
	    if (undoHist.length === 0) return false;
	    const cur = chatData.value.knowledgeGraph;
	    const history = chatData.value.knowledgeGraphHistory || [];
	    if (cur) {
	      history.push(cur);
	      if (history.length > KNOWLEDGE_GRAPH_VERSION_LIMIT) history.shift();
	      chatData.value.knowledgeGraphHistory = history;
	    }
	    const next = undoHist.pop()!;
	    chatData.value.knowledgeGraphUndoHistory = undoHist;
	    chatData.value.knowledgeGraph = next;
	    // 同步版本数组：追加被恢复的版本（楼层用当前最大+2 近似）
const versions = chatData.value.knowledgeGraphVersions || [];
		    const maxFloor = versions.length > 0 ? versions[versions.length - 1].floor : 0;
		    versions.push({
		      floor: maxFloor + 2,
		      graph: stripEmbeddingsFromGraph(next),
		      characterLocations: sanitizeCharacterLocationsForGraph(chatData.value.characterLocations, next),
		    });
		    // 同 commit 封顶 ≤6，防止恢复操作累积
		    if (versions.length > KNOWLEDGE_GRAPH_VERSION_LIMIT) {
		      versions.splice(0, versions.length - KNOWLEDGE_GRAPH_VERSION_LIMIT);
		    }
		    chatData.value.knowledgeGraphVersions = versions;
	    forcePersist();
	    return true;
	  }

/**
   * 清空图谱（含撤回/恢复栈及版本数组）。
   * 必须同步清 characterLocations：图谱节点视图层是从 characterLocations 渲染的，
   * 只清 knowledgeGraph 会让旧角色-地点边残留（且地点已不在 locations 里 → 出现游离地点节点）。
   * 关系档案 relationshipProfiles 不在此处清，它属于关系网，不是地点图谱，
   * 如需清关系网走"清空关系网"。
   */
  function clearKnowledgeGraph(): void {
    chatData.value.knowledgeGraph = null;
    chatData.value.knowledgeGraphVersions = [];
    chatData.value.knowledgeGraphEmbeddingCache = createEmptyKnowledgeGraphEmbeddingCache();
    chatData.value.knowledgeGraphHistory = [];
    chatData.value.knowledgeGraphUndoHistory = [];
    chatData.value.characterLocations = {};
    forcePersist();
  }

	  /** 内联编辑后直接覆盖当前图谱（不入撤回栈，同步更新版本数组最新版，立即落盘） */
	  function setKnowledgeGraphWithoutHistory(graph: KnowledgeGraph): void {
	    const cache = ensureKnowledgeGraphEmbeddingCache(chatData.value.knowledgeGraphEmbeddingCache);
	    hydrateKnowledgeGraphEmbeddingsFromCache(graph, cache);
	    chatData.value.knowledgeGraph = graph;
	    // 同步更新版本数组中最新的图谱
	    const versions = chatData.value.knowledgeGraphVersions;
	    if (versions && versions.length > 0) {
	      versions[versions.length - 1].graph = stripEmbeddingsFromGraph(graph);
	      versions[versions.length - 1].characterLocations = sanitizeCharacterLocationsForGraph(
	        chatData.value.characterLocations,
	        graph,
	      );
	    }
	    syncKnowledgeGraphEmbeddingCache(graph, cache);
	    pruneKnowledgeGraphVectorCache();
	    forcePersist();
	  }

	  /**
	   * 内联编辑图谱角色节点的别名列表。
	   * @param characterName 角色正式名（GraphCharacter.name）
	   * @param aliases       新的别名数组（已去重、去空白、不含正式名）
	   * 走 setKnowledgeGraphWithoutHistory：不入撤回栈，直接覆盖最新图谱，立即落盘。
	   */
	  function updateGraphCharacterAliases(characterName: string, aliases: string[]): boolean {
	    const g = chatData.value.knowledgeGraph;
	    if (!g || !characterName) return false;
      const resolvedName = resolveKnownCharacterName(characterName, true);
      const target = normalizeMemoryCharacterName(resolvedName);
	    const ch = g.characters.find(c =>
        normalizeMemoryCharacterName(c.name) === target
        || (c.aliases || []).some(a => normalizeMemoryCharacterName(a) === target),
      );
	    if (!ch) return false;
	    // 过滤掉空白和与正式名重复的别名
	    const cleaned = cleanCharacterAliases(aliases, ch.name);
	    ch.aliases = cleaned.length > 0 ? cleaned : undefined;
	    setKnowledgeGraphWithoutHistory(g);
	    return true;
	  }

  /**
   * 手动修正某角色当前位置（用户在图谱详情里就地编辑）。
   * 同步写两层：characterLocations 字典（makeCandidate 等实时读取）+ graph.characters[].location（图谱落库）。
   * 下一轮 AI 推断不改地点则保留此修正；AI 主动改地点则覆盖（场景真变了就让 AI 接管）。
   * 返回写入的地地点对象（{id,name}）；找不到角色或不合法入参返回 null。
   */
  function setCharacterLocation(characterName: string, locationName: string): { id: string; name: string } | null {
    if (!characterName) return null;
    const locStr = String(locationName || '').trim();
    if (!locStr) return null;
    const canonicalName = resolveKnownCharacterName(characterName, true);
    // 地点归一：先在 graph.locations 找匹配，找到直接用其 id；找不到则 buildStableId 作为新 locId
    const g = chatData.value.knowledgeGraph;
    let locId: string;
    let locDisplay: string;
    const byId = g?.locations?.find(l => l.id === locStr || normalizeMemoryCharacterName(l.id) === normalizeMemoryCharacterName(locStr));
    const byName = g?.locations?.find(l =>
      normalizeMemoryCharacterName(l.name) === normalizeMemoryCharacterName(locStr)
      || (l.aliases || []).some(a => normalizeMemoryCharacterName(a) === normalizeMemoryCharacterName(locStr)),
    );
    if (byId) { locId = byId.id; locDisplay = byId.name || byId.id; }
    else if (byName) { locId = byName.id; locDisplay = byName.name || byName.id; }
    else {
      locId = buildStableId(locStr);
      locDisplay = locStr;
    }

    // 1) characterLocations 字典：写规范名 + 清别名键残留
    const map = { ...(chatData.value.characterLocations || {}) };
    const target = normalizeMemoryCharacterName(canonicalName || characterName);
    // 清掉指向同一规范的旧键（别名键残留）
    for (const key of Object.keys(map)) {
      if (normalizeMemoryCharacterName(key) === target) delete map[key];
    }
    map[canonicalName || characterName] = locId; // canonicalName 为空时回退原始入参名（玩家无规范名）
    chatData.value.characterLocations = map;

    // 2) graph.characters[].location：找到匹配角色节点，写 location 字段（locId 字符串）
    if (g) {
      const ch = g.characters.find(c =>
        normalizeMemoryCharacterName(c.name) === target
        || (c.aliases || []).some(a => normalizeMemoryCharacterName(a) === target),
      );
      if (ch) {
        ch.location = locId;
        setKnowledgeGraphWithoutHistory(g);
      }
      // 玩家节点 id 是 USER_NODE_ID，玩家位置由 characterLocations['{{user}}'] 或 [userName] 记录，graph.characters 通常不含玩家；不动 graph
    }

    forcePersist({ settings: false });
    return { id: locId, name: locDisplay };
  }

  /**
   * 更新角色当前位置：把本次小总结的在场角色映射到指定地点名（归一为稳定 id）。
   * 在别处未提及的角色映射保持不动（其位置靠后续轮次或世界推进 advancedCharacters 更新）。
   */
  function updateCharacterLocations(presentChars: string[], locationName?: string): void {
    if (!locationName) return;
    const locId = buildStableId(locationName);
    const map = { ...(chatData.value.characterLocations || {}) };
    for (const name of presentChars || []) {
      const canonicalName = resolveKnownCharacterName(name, true);
      if (canonicalName) {
        map[canonicalName] = locId;
        if (name && name !== canonicalName) delete map[name];
      }
    }
    chatData.value.characterLocations = map;
    // 不单独 persist，由调用方在 commitKnowledgeGraph 后统一 forcePersist
  }

  /**
   * 批量更新角色位置（一个小结里多个场景、每个角色各自归属）。
   * 入参：[{name, location, ...}]。location 为空的角色位置保持不变。
   * 含玩家：userName 也作为一条 entry 直接 map[userName] = locId（供下游 charLoc[userName] 查询）。
   */
  function batchUpdateCharacterLocations(entries: Array<{ name: string; location: string }>): void {
    const map = { ...(chatData.value.characterLocations || {}) };
    for (const e of entries || []) {
      if (!e?.name || !e?.location) continue;
      const canonicalName = resolveKnownCharacterName(e.name, true);
      if (canonicalName) {
        map[canonicalName] = buildStableId(e.location);
        if (e.name !== canonicalName) delete map[e.name];
      }
    }
    chatData.value.characterLocations = map;
  }

	  /** 查询某角色当前所在地点对象（找不到返回 null） */
	  function getCharacterLocation(name: string): { id: string; name: string } | null {
      const canonicalName = resolveKnownCharacterName(name, true);
	    const locId = chatData.value.characterLocations?.[canonicalName]
        || chatData.value.characterLocations?.[name];
	    if (!locId) return null;
	    const loc = chatData.value.knowledgeGraph?.locations.find(l => l.id === locId);
	    return loc ? { id: loc.id, name: loc.name } : { id: locId, name: locId };
	  }

	  /**
	   * 截断世界推进记录：过滤掉 basedOnFloorRange.end >= floor 的旧记录，
	   * 并重算 lastWorldProgressFloor。用于回退/重roll场景自动作废过期记录。
	   * 返回被移除的记录数。
	   */
	  function truncateWorldProgressRecords(floor: number): number {
	    const records = chatData.value.worldProgressRecords || [];
	    const before = records.length;
	    const truncated = records.filter((r: any) => (r.basedOnFloorRange?.end ?? -1) < floor);
      const memBefore = chatData.value.worldProgressMemories?.length || 0;
      chatData.value.worldProgressMemories = (chatData.value.worldProgressMemories || [])
        .filter((m: any) => (m.floor ?? -1) < floor);
      const removedMems = memBefore - (chatData.value.worldProgressMemories?.length || 0);
	    if (truncated.length < before || removedMems > 0) {
	      chatData.value.worldProgressRecords = truncated;
	      chatData.value.lastWorldProgressFloor = truncated.length > 0
	        ? Math.max(...truncated.map((r: any) => r.basedOnFloorRange?.end ?? -1))
	        : -1;
        if ((chatData.value.pendingWorldProgressFloor ?? -1) >= floor) {
          chatData.value.pendingWorldProgress = false;
          chatData.value.pendingWorldProgressFloor = -1;
        }
        _fusedCache.clear();
	      forcePersist();
	    }
	    return before - truncated.length;
	  }

  /**
   * 获取当前用户名
   * 优先智脑自定义角色名 → SillyTavern.name1 → '{{user}}'
   */
  function getUserName(): string {
    const personaName = scriptData.value.personas.find(p => p.id === scriptData.value.activePersonaId)?.name;
    if (personaName) {

      return personaName;
    }
    if (typeof SillyTavern !== 'undefined' && SillyTavern.name1) {

      return SillyTavern.name1 as string;
    }

    return '{{user}}';
  }

  // ========== 批量总结状态（持久化在 store 中，避免切 tab 丢失） ==========

  const showBatchPanel = ref(false);
  const batchRunning = ref(false);
  const batchAbortRequested = ref(false);
  const batchStart = ref(0);
  const batchEnd = ref(0);
  const batchSize = ref(20);
  const batchProgress = reactive({
    status: 'idle' as 'idle' | 'running' | 'done' | 'cancelled' | 'paused',
    currentBatch: 0,
    totalBatches: 0,
    totalMessages: 0,
    startFloor: 0,
    endFloor: 0,
    batchSize: 20,
    currentBatchFloorStart: undefined as number | undefined,
    currentBatchFloorEnd: undefined as number | undefined,
    currentBatchCount: undefined as number | undefined,
    errors: [] as Array<{ batch: number; message: string; retries: number }>,
  });

  function resetBatchProgress() {
    Object.assign(batchProgress, {
      status: 'idle',
      currentBatch: 0,
      totalBatches: 0,
      totalMessages: 0,
      startFloor: 0,
      endFloor: 0,
      batchSize: 20,
      currentBatchFloorStart: undefined,
      currentBatchFloorEnd: undefined,
      currentBatchCount: undefined,
      errors: [],
    });
  }

  // ========== API 重试弹窗 ==========

  /** 当前重试状态（null = 无重试进行中） */
  const apiRetryStatus = ref<{
    analysisName: string;
    attempt: number;
    maxRetries: number;
    error: string;
    delaySec: number;
  } | null>(null);

  function showApiRetry(info: {
    analysisName: string;
    attempt: number;
    maxRetries: number;
    error: string;
    delaySec: number;
  }) {
    apiRetryAborted = false; // 每次开始重试前清掉旧的取消信号
    apiRetryStatus.value = info;
  }

  function clearApiRetry() {
    // 连同中止信号一起清干净，避免用户点过一次"取消重试"后，
    // aborted 永久停在 true，导致后续每次调用在 attempt=0 顶部直接被卡、
    // 秒抛"用户已取消重试"（showApiRetry 只在重试时才重置，救不回首次调用）。
    apiRetryAborted = false;
    apiRetryStatus.value = null;
  }

  /** 用户是否已点击"取消重试"（showApiRetry 时自动重置） */
  let apiRetryAborted = false;

  /** 用户点击"取消重试"按钮 → 置位中止信号，重试循环下一轮顶部检测到后抛错停手 */
  function stopApiRetry() {
    apiRetryAborted = true;
    apiRetryStatus.value = null;
  }

  function isApiRetryAborted(): boolean {
    return apiRetryAborted;
  }

  // ========== 大总结重试弹窗 ==========
  // 失败后自动重试同一批楼层，弹窗展示倒计时;"停止重试"按钮可中断，转为需手动重新总结。

  const summaryRetryStatus = ref<{
    floors: number;
    attempt: number;
    maxAttempts: number;
    error: string;
    countdownSec: number;
  } | null>(null);

  /** 用户是否已点击"停止重试"（每次新一轮重试前置 false） */
  let summaryRetryAborted = false;

  function startSummaryRetry(info: { floors: number; attempt: number; maxAttempts: number; error: string; countdownSec: number }) {
    summaryRetryAborted = false;
    summaryRetryStatus.value = { ...info };
  }

  function updateSummaryRetryCountdown(sec: number) {
    if (summaryRetryStatus.value) {
      summaryRetryStatus.value = { ...summaryRetryStatus.value, countdownSec: sec };
    }
  }

  function clearSummaryRetry() {
    // 同 clearApiRetry：清掉中止信号，避免下次大总结 attempt=1 顶部直接被卡死
    summaryRetryAborted = false;
    summaryRetryStatus.value = null;
  }

  /** 用户点击"停止重试" */
  function stopSummaryRetry() {
    summaryRetryAborted = true;
    summaryRetryStatus.value = null;
  }

  function isSummaryRetryAborted(): boolean {
    return summaryRetryAborted;
  }

  // ========== 大总结引导弹窗 ==========

  const showSummaryGuidance = ref(false);
  const summaryPendingFloors = ref(0);
  const lastSubmittedGuidance = ref('');
  let summaryGuidanceResolve: ((guidance: string | null) => void) | null = null;

  function requestSummaryGuidance(pendingFloors: number, initialGuidance?: string): Promise<string | null> {
    // settings 是 computed ref，setup 内必须用 .value 取真实值
    if ((settings.value as any)?.summaryGuidanceEnabled === false) {
      return Promise.resolve('');
    }
    // initialGuidance 传入 → 预填（重新总结）；未传入 → 清空（新总结）
    lastSubmittedGuidance.value = initialGuidance ?? '';
    summaryPendingFloors.value = pendingFloors;
    showSummaryGuidance.value = true;
    return new Promise(resolve => {
      summaryGuidanceResolve = resolve;
    });
  }

  function resolveSummaryGuidance(guidance: string) {
    showSummaryGuidance.value = false;
    lastSubmittedGuidance.value = guidance;
    summaryGuidanceResolve?.(guidance);
    summaryGuidanceResolve = null;
  }

  function skipSummaryGuidance() {
    showSummaryGuidance.value = false;
    lastSubmittedGuidance.value = '';
    summaryGuidanceResolve?.('');
    summaryGuidanceResolve = null;
  }

  function cancelSummaryGuidance() {
    showSummaryGuidance.value = false;
    // 取消时不清理 guidance，下次弹窗还能看到
    summaryGuidanceResolve?.(null);
    summaryGuidanceResolve = null;
  }

  // ========== 数据管理 ==========

  function exportAllData(): string {
    return JSON.stringify({ _exportVersion: 'A5.0.5', scriptData: klona(scriptData.value), chatData: slimChatDataForPersist(chatData.value) }, null, 2);
  }

  /** 导入前预检：对比当前数据与导入数据，返回警告列表（空数组=无风险） */
  function checkImportData(jsonStr: string): string[] {
    const warnings: string[] = [];
    try {
      const parsed = JSON.parse(jsonStr);
      // personas 空数据风险
      if (parsed.scriptData) {
        const importedScript = ScriptSettingsSchema.parse(parsed.scriptData);
        const currentCount = (scriptData.value.personas || []).length;
        const importedCount = (importedScript.personas || []).length;
        if (currentCount > 0 && importedCount === 0) {
          warnings.push(`导入文件没有用户人格数据（当前有 ${currentCount} 个），导入后将被清空。`);
        }
      }
      // 角色数据空数据风险
      if (parsed.chatData) {
        const importedChat = ChatDataSchema.parse(parsed.chatData);
        const currentCharCount = getAllCharacterNames().length;
        // 临时替换 chatData 以计算导入文件的角色数
        const savedChat = chatData.value;
        chatData.value = importedChat;
        const importedCharCount = getAllCharacterNames().length;
        chatData.value = savedChat;
        if (currentCharCount > 0 && importedCharCount === 0) {
          warnings.push(`导入文件没有角色数据（当前有 ${currentCharCount} 个角色），导入后角色库将被清空。`);
        } else if (importedCharCount > 0 && importedCharCount < currentCharCount) {
          warnings.push(`导入文件包含 ${importedCharCount} 个角色（当前有 ${currentCharCount} 个），部分角色可能不在导入文件中。`);
        }
      }
    } catch {
      // JSON 解析失败由 importAllData 抛出，这里不处理
    }
    return warnings;
  }

  function importAllData(jsonStr: string) {
    try {
      const parsed = JSON.parse(jsonStr);

      // ===== DEBUG: 导入前快照 =====
      const preImportCharCount = getAllCharacterNames().length;
      const preImportPersonasCount = (scriptData.value.personas || []).length;
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '导入调试',
        level: 'info',
        message: `导入前快照: 角色数=${preImportCharCount}, personas=${preImportPersonasCount}, 当前chatId=${currentChatId}`,
      });

      if (parsed.scriptData) {
        const importedScript = ScriptSettingsSchema.parse(parsed.scriptData);
        pushCodeLog({
          id: _codeLogIdCounter++,
          timestamp: new Date().toISOString(),
          module: '导入调试',
          level: 'info',
          message: `scriptData解析: personas=${(importedScript.personas || []).length}, personaNames=[${(importedScript.personas || []).map((p: any) => p.name).join(',')}]`,
        });
        scriptData.value = importedScript;
      }
      if (parsed.chatData) {
        const importedChat = ChatDataSchema.parse(parsed.chatData);

        // ===== DEBUG: 导入数据结构详情 =====
        const sumCount = (importedChat.summaries || []).length;
        const topMems = (importedChat.characterMemories || []).length;
        const dpV2 = (importedChat.dynamicProfilesV2 || []).length;
        const nsfwMems = (importedChat.nsfwMemories || []).length;
        const worldProgMems = (importedChat.worldProgressMemories || []).length;
        const wpRecords = (importedChat.worldProgressRecords || []).length;
        const charProfiles = Object.keys(importedChat.characterProfiles || {}).length;
        const charLocs = Object.keys(importedChat.characterLocations || {}).length;
        const relProfiles = (importedChat.relationshipProfiles || []).length;
        const kgChars = (importedChat.knowledgeGraph?.characters || []).length;
        const savedCP = (importedChat.savedCharacterProfiles || []).length;

        // 每个 summary 的角色表详情
        const sumDetails = (importedChat.summaries || []).map((s: any, i: number) => {
          const tbl = (s.characterTable || []).map((e: any) => e.name);
          const mems = (s.characterMemories || []).map((m: any) => m.characterName);
          return `s${i}(tbl:[${tbl}],mems:[${mems}])`;
        });

        pushCodeLog({
          id: _codeLogIdCounter++,
          timestamp: new Date().toISOString(),
          module: '导入调试',
          level: 'info',
          message: `chatData解析: summaries=${sumCount}, characterMemories(顶层)=${topMems}, dynamicProfilesV2=${dpV2}, nsfwMemories=${nsfwMems}, worldProgressMemories=${worldProgMems}, wpRecords=${wpRecords}, characterProfiles=${charProfiles}, characterLocations=${charLocs}, relationshipProfiles=${relProfiles}, kgChars=${kgChars}, savedCharProfiles=${savedCP}`,
        });

        // 每条 summary 的角色信息
        for (const detail of sumDetails) {
          pushCodeLog({
            id: _codeLogIdCounter++,
            timestamp: new Date().toISOString(),
            module: '导入调试',
            level: 'info',
            message: detail,
          });
        }

        // ===== DEBUG: 设置 chatData 后的角色数 =====
        chatData.value = importedChat;
        chatData.value.chatId = currentChatId;

        const afterSetCount = getAllCharacterNames().length;
        const afterSetNames = getAllCharacterNames();
        pushCodeLog({
          id: _codeLogIdCounter++,
          timestamp: new Date().toISOString(),
          module: '导入调试',
          level: 'info',
          message: `设置chatData后: 角色数=${afterSetCount}, 角色名=[${afterSetNames.join(',')}]`,
        });

        // 逐源追踪角色来源
        const sourceTrace: Record<string, string[]> = {};
        const traceSource = (name: string, source: string) => {
          if (!sourceTrace[name]) sourceTrace[name] = [];
          sourceTrace[name].push(source);
        };

        for (const m of importedChat.characterMemories || []) {
          if (m.characterName) traceSource(m.characterName, 'top-characterMemories');
        }
        for (const s of importedChat.summaries || []) {
          for (const m of s.characterMemories || []) {
            if (m.characterName) traceSource(m.characterName, `sum-mems`);
          }
          for (const e of s.characterTable || []) {
            if (e.name) traceSource(e.name, `sum-table`);
          }
        }
        for (const p of importedChat.dynamicProfilesV2 || []) {
          if (p.characterName) traceSource(p.characterName, 'dynamicProfilesV2');
        }
        for (const m of importedChat.nsfwMemories || []) {
          if (m.characterName) traceSource(m.characterName, 'nsfwMemories');
        }

        for (const [name, sources] of Object.entries(sourceTrace)) {
          pushCodeLog({
            id: _codeLogIdCounter++,
            timestamp: new Date().toISOString(),
            module: '导入调试',
            level: 'info',
            message: `角色来源 [${name}]: ${[...new Set(sources)].join(', ')}`,
          });
        }

        // 同步当前聊天变量，STABLE_ID 只保留全局设置
        allChatsData.value[currentChatId] = klona(chatData.value);
        writeChatScopeCurrent(currentChatId, chatData.value);
        writeStableSettings(scriptData.value);

        // ===== DEBUG: 写入存储后再查一次 =====
        const afterWriteCount = getAllCharacterNames().length;
        pushCodeLog({
          id: _codeLogIdCounter++,
          timestamp: new Date().toISOString(),
          module: '导入调试',
          level: 'info',
          message: `写入存储后: 角色数=${afterWriteCount}, allChatsData key=${currentChatId}, chatData.chatId=${chatData.value.chatId}`,
        });

        // ===== DEBUG: 延迟1秒检查，捕获导入后被覆盖的情况 =====
        setTimeout(() => {
          const delayedCount = getAllCharacterNames().length;
          const delayedNames = getAllCharacterNames();
          const delayedSumCount = (chatData.value.summaries || []).length;
          const delayedTopMems = (chatData.value.characterMemories || []).length;
          const delayedDpV2 = (chatData.value.dynamicProfilesV2 || []).length;
          pushCodeLog({
            id: _codeLogIdCounter++,
            timestamp: new Date().toISOString(),
            module: '导入调试',
            level: 'warn',
            message: `[延迟1s检查] 角色数=${delayedCount}, 角色名=[${delayedNames.join(',')}], summaries=${delayedSumCount}, characterMemories=${delayedTopMems}, dynamicProfilesV2=${delayedDpV2}`,
          });
          // 进一步：检查 allChatsData 中的数据
          const stored = allChatsData.value[currentChatId];
          if (stored) {
            const storedCount = (() => {
              try {
                const tmp = chatData.value;
                chatData.value = stored;
                const c = getAllCharacterNames().length;
                chatData.value = tmp;
                return c;
              } catch { return -1; }
            })();
            pushCodeLog({
              id: _codeLogIdCounter++,
              timestamp: new Date().toISOString(),
              module: '导入调试',
              level: 'warn',
              message: `[延迟1s] allChatsData中的角色数=${storedCount}`,
            });
          } else {
            pushCodeLog({
              id: _codeLogIdCounter++,
              timestamp: new Date().toISOString(),
              module: '导入调试',
              level: 'error',
              message: `[延迟1s] allChatsData中没有当前聊天的数据! key=${currentChatId}`,
            });
          }
        }, 1000);

        pushCodeLog({
          id: _codeLogIdCounter++,
          timestamp: new Date().toISOString(),
          module: '存储',
          level: 'info',
          message: `数据导入成功 (总结: ${importedChat.summaries.length}, 梦呓: ${importedChat.dreamtalk ? '有' : '无'}, 捕获: ${importedChat.capturedContents.length})`,
        });
        return;
      }
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '存储',
        level: 'info',
        message: '数据导入成功（无 chatData）',
      });
    } catch (e) {
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '存储',
        level: 'error',
        message: '数据导入失败',
        detail: String(e),
      });
      throw e;
    }
  }

  /** 只恢复聊天数据（世界书读档用，不影响脚本设置） */
  function importChatData(data: ChatData) {
    try {
      chatData.value = ChatDataSchema.parse(data);
      if (!chatData.value.chatId) {
        chatData.value.chatId = currentChatId;
      }
      allChatsData.value[currentChatId] = klona(chatData.value);
      writeChatScopeCurrent(currentChatId, chatData.value);
      writeStableSettings(scriptData.value);
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '存储',
        level: 'info',
        message: `世界书读档成功 (总结: ${chatData.value.summaries.length}, 捕获: ${chatData.value.capturedContents.length})`,
      });
    } catch (e) {
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '存储',
        level: 'error',
        message: '世界书读档失败',
        detail: String(e),
      });
      throw e;
    }
  }

  function clearChatData() {
    chatData.value = ChatDataSchema.parse({});
    allChatsData.value[currentChatId] = klona(chatData.value);
    // type:'chat' 清掉当前聊天这条智脑记录（其它字段保留）
    writeChatScopeCurrent(currentChatId, chatData.value);
    writeStableSettings(scriptData.value);
    pushCodeLog({
      id: _codeLogIdCounter++,
      timestamp: new Date().toISOString(),
      module: '存储',
      level: 'info',
      message: '聊天数据已清空',
    });
  }

  function clearAllData() {
    scriptData.value = ScriptSettingsSchema.parse({});
    chatData.value = ChatDataSchema.parse({});
    allChatsData.value = { [currentChatId]: klona(chatData.value) };
    writeChatScopeCurrent(currentChatId, chatData.value);
    writeStableSettings(scriptData.value);
    pushCodeLog({
      id: _codeLogIdCounter++,
      timestamp: new Date().toISOString(),
      module: '存储',
      level: 'info',
      message: '所有数据已清空',
    });
  }

  /**
   * 删除某聊天在智脑内存汇总里的数据（监听酒馆 CHAT_DELETED 事件后调用）。
   * 仅清理内存 allChatsData，并同步写空 STABLE_ID 聊天池；不碰当前聊天文件变量
   * （删除的就是那个聊天文件，酒馆本身已清掉，无需脚本多写）。
   * @param rawName 酒馆传来的 chat_file_name，可能带 .jsonl/.json 后缀和前缀
   */
  function removeDeletedChatData(rawName: string): void {
    if (!rawName) return;
    // 归一化：去掉常见后缀
    const norm = String(rawName).replace(/\.(jsonl?|json)$/i, '').trim();
    // 候选 key 集合（兼容酒馆不同版本传文件名 vs chatId）
    const candidates = new Set<string>([norm, rawName]);
    let removed = 0;
    for (const key of Object.keys(allChatsData.value)) {
      if (candidates.has(key)) {
        delete allChatsData.value[key];
        removed++;
      }
    }
    if (removed > 0) {
      writeStableSettings(scriptData.value);
      pushCodeLog({
        id: _codeLogIdCounter++,
        timestamp: new Date().toISOString(),
        module: '存储',
        level: 'info',
        message: `已删除聊天 ${norm} 的智脑数据`,
      });
    }
  }

  // ========== Claude 模型检测 ==========

  function getCurrentModel(): string {
    try {
      return SillyTavern.getChatCompletionModel();
    } catch {
      return '';
    }
  }

  function isClaudeModel(): boolean {
    const model = getCurrentModel();
    return /claude/i.test(model);
  }

  return {
    // 原始数据
    scriptData,
    chatData,
    // 便捷访问器
    personas,
    activePersonaId,
    persona,
    settings,
    capturedContents,
    summaries,
    dynamicProfiles,
    dreamtalk,
    userInputRecords,
    lastSummaryAtMessageId,
    storyDateFormat,
    chatContentRevision,
    // 用户人格
    addPersona,
    removePersona,
    setActivePersona,
    updatePersonaRaw,
    updatePersonaProfile,
    renamePersona,
    // 设置
    updateSettings,
    // 正文捕获
    captureContent,
    captureFloorZero,
    recordUserInput,
    touchChatContent,
    // 大总结
    addSummary,
    getLatestSummary,
    timelineOverrides: computed(() => chatData.value.timelineOverrides),
    updateTimelineOverride,
    removeTimelineOverride,
    removeTimelineEvent,
    replaceTimelineOverride,
    addTimelineEvent,
    getTimelineEventKey,
    getLatestDelta,
    getCoveredFloorsDisplay,
    rollbackSummary,
    // 持久化（forcePersist=立即落盘，schedulePersist=防抖1秒）
    forcePersist,
    schedulePersist,
    // assembledSummary 缓存控制
    rebuildAssembled,
    touchAssembled,
    restoreLastSummary,
    updateSummaryRawText,
    getHiddenFloors,
    // 记忆仓热投影协同
    prepareSummaryForCommit,
    previewSummarySequence,
    replaceSummaryRangeAtomically,
    invalidateSummaryProjectionsFromFloor,
    // 动态人设
    updateDynamicProfile,
    removeDynamicProfile,
    // 记忆库
    getFusedMemories,
    rerankEnhancedRecall,
    getCharacterMemoryArchive,
    removeCharacterMemoryItem,
    getCharacterMemories,
    getAllCharacterNames,
    getCharacterNameEntries,
    resolveKnownCharacterName,
    resolveKnownCharacterNames,
    updateCharacterAliases,
    addCharacter,
    // 角色设定档案
    setCharacterProfile,
    removeCharacterProfile,
    getCharacterProfile,
    saveCharacterProfileToHistory,
    removeSavedCharacterProfile,
    loadSavedCharacterProfile,
    // 角色合并
    mergeCharacters,
    // 角色改名
    renameCharacter,
    // 角色删除管理
    deleteCharacter,
    // 角色名字系统重构：稳定 ID 注册表（P1/P3/P5）
    characterRegistry,
    ensureCharacterRegistry,
    buildRegistryFromExistingData,
    resolveKnownCharacterId,
    // 梦呓
    updateDreamtalk,
    rollbackDreamtalk,
    restoreDreamtalk,
    getDreamtalkCharacterNames,
    // NSFW隔离层
    nsfwMemories,
    nsfwDreamtalk,
    nsfwDynamicProfiles,
    updateNsfwMemories,
    updateNsfwDreamtalk,
    updateNsfwDynamicProfile,
    // 后台行动推演
    worldProgressManualChars,
    updateWorldProgressManualChars,
    selectWorldProgressCandidates,
    addWorldProgressMemories,
    ensureWorldProgressMemoriesFromRecords,
    getActiveWorldProgressMemories,
    // 世界书蒸馏
    distillRecords,
    upsertDistillRecord,
    updateDistillRecord,
    removeDistillRecord,
    clearDistillRecords,
    // 关系档案
    relationshipProfiles,
    updateRelationshipProfiles,
    removeRelationshipProfile,
    clearRelationshipProfiles,
	    // 知识图谱
	    knowledgeGraph,
	    characterLocations,
	    commitKnowledgeGraph,
	    getKnowledgeGraphForFloor,
	    getKnowledgeGraphStateForFloor,
	    rollbackKnowledgeGraph,
	    restoreKnowledgeGraph,
	    clearKnowledgeGraph,
	    setKnowledgeGraphWithoutHistory,
	    updateGraphCharacterAliases,
	    updateCharacterLocations,
    batchUpdateCharacterLocations,
	    getCharacterLocation,
	    setCharacterLocation,
	    truncateWorldProgressRecords,
    createEmptyKnowledgeGraph,
    getUserName,
    getLatestInteractingCharactersSet,
    getLatestSmallSummaryCharacterLocations,
    normalizeMemoryCharacterName,
    // 批量总结
    showBatchPanel,
    batchRunning,
    batchAbortRequested,
    batchStart,
    batchEnd,
    batchSize,
    batchProgress,
    resetBatchProgress,
    // 大总结引导弹窗
    showSummaryGuidance,
    summaryPendingFloors,
    requestSummaryGuidance,
    resolveSummaryGuidance,
    skipSummaryGuidance,
    cancelSummaryGuidance,
    // API 重试弹窗
    apiRetryStatus,
    showApiRetry,
    clearApiRetry,
    stopApiRetry,
    isApiRetryAborted,
    // 大总结重试弹窗
    summaryRetryStatus,
    startSummaryRetry,
    updateSummaryRetryCountdown,
    clearSummaryRetry,
    stopSummaryRetry,
    isSummaryRetryAborted,
    // 数据管理
    exportAllData,
    checkImportData,
    importAllData,
    importChatData,
    clearChatData,
    clearAllData,
    removeDeletedChatData,
    worldBookRawCache,
    // 模型检测
    getCurrentModel,
    isClaudeModel,
    // 运行状态
    summaryInProgress,
    dreamtalkInProgress,
    characterMemoryInProgress,
    _isRealChatMessage, // MESSAGE_SENT 触发为 true，仅正常聊天注入梦呓
    _isBackgroundCall, // generateRaw 期间为 true，CHAT_COMPLETION_SETTINGS_READY 入口跳过注入
    markBgNativeCall, // native generateRaw 前调用
    consumeBgNativeCall, // CHAT_COMPLETION_SETTINGS_READY 中消费标记
    setSummaryInProgress,
    setDreamtalkInProgress,
    setCharacterMemoryInProgress,
    // API 监听器
    apiMonitorLogs,
    pushApiMonitorLog,
    clearApiMonitorLogs,
    // 代码日志
    codeLogs,
    pushCodeLog,
    clearCodeLogs,
    // 关系档案分析状态
    relAnalyzing,
    relStatus,
    relError,
    relSelectedNodeId,
    relSelectedEdgeId,
  };
});
