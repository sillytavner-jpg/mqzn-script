import { klona } from 'klona';
import { getCapturedContentMessageIds, getHiddenFloorsFromChat, type HiddenFloor } from '../core/floorVisibility';
import type { DreamtalkData } from '../core/dreamtalk';
import type { NsfwCharacterMemory, NsfwDreamtalkData, NsfwDynamicProfile } from '../core/nsfwIsolation';
import type { PlotFateState } from '../core/plotFate';
import type { EmotionAccumulationState } from '../core/emotionAccumulation';
import { parseSummaryOutput, type ParsedSummary } from '../core/summary';
import { extractContentFromMessage } from '../utils/messageParser';

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

export interface CharacterMemory {
  characterName: string;
  aliases: string[];
  attitude: 'like' | 'dislike' | 'neutral';
  coreMemories: string[];    // 核心记忆（永久，3-5条，第一次大总结时生成）
  recentMemories: string[];  // 近期记忆（滚动，5-8条，最近2-3次大总结产生）
  keywords: string[];
}

export interface TimelineEvent {
  time: string;
  event: string;
  details: string;
  actions: string;
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
  upToMessageId?: number;
  coveredMessageIds?: number[];
  characterMemories: CharacterMemory[];
  timeline: TimelineEvent[];
  characterTable: CharacterEntry[];
  rawText: string;
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
  dynamicProfiles: DynamicProfile[];
  dreamtalk: DreamtalkData | null;
  dreamtalkHistory: DreamtalkData[];
  dreamtalkUndoHistory: DreamtalkData[];
  lastSummaryAtMessageId: number;
  // NSFW隔离层
  nsfwMemories: NsfwCharacterMemory[];
  nsfwDreamtalk: NsfwDreamtalkData | null;
  nsfwDynamicProfiles: NsfwDynamicProfile[];
  // 倒果为因
  plotFate: PlotFateState | null;
  // 情绪积累
  emotionState: EmotionAccumulationState | null;
}

// ========== 存储拆分：脚本变量（全局共享） ==========

export interface ScriptSettings {
  personas: UserPersona[];
  activePersonaId: string;
  settings: {
    personaEnabled: boolean;
    dynamicProfileEnabled: boolean;
    captureEnabled: boolean;
    memoryActivationEnabled: boolean;
    dreamtalkEnabled: boolean;
    plotFateEnabled: boolean;
    emotionEnabled: boolean;
    emotionInterval: number;
    summaryInterval: number;
    // 自定义API
    apiMode: string;
    customApiUrl: string;
    customApiKey: string;
    customApiModel: string;
  };
}

// ========== Zod Schema ==========

const ChatDataSchema = z
  .object({
    chatId: z.string().prefault(''),
    capturedContents: z.array(z.any()).prefault([]),
    userInputRecords: z.array(z.any()).prefault([]),
    summaries: z.array(z.any()).prefault([]),
    summaryHistory: z.array(z.any()).prefault([]),
    dynamicProfiles: z.array(z.any()).prefault([]),
    dreamtalk: z.any().prefault(null),
    dreamtalkHistory: z.array(z.any()).prefault([]),
    dreamtalkUndoHistory: z.array(z.any()).prefault([]),
    lastSummaryAtMessageId: z.coerce.number().prefault(0),
    // NSFW隔离层
    nsfwMemories: z.array(z.any()).prefault([]),
    nsfwDreamtalk: z.any().prefault(null),
    nsfwDynamicProfiles: z.array(z.any()).prefault([]),
    // 倒果为因
    plotFate: z.any().prefault(null),
    // 情绪积累
    emotionState: z.any().prefault(null),
  })
  .prefault({});

const ScriptSettingsSchema = z
  .object({
    personas: z.array(z.object({
      id: z.string().prefault(''),
      name: z.string().prefault(''),
      rawInput: z.string().prefault(''),
      analyzedProfile: z.string().prefault(''),
      lastAnalyzedAt: z.string().prefault(''),
    })).prefault([]),
    activePersonaId: z.string().prefault(''),
    settings: z
      .object({
        personaEnabled: z.boolean().prefault(true),
        dynamicProfileEnabled: z.boolean().prefault(true),
        captureEnabled: z.boolean().prefault(true),
        memoryActivationEnabled: z.boolean().prefault(true),
        dreamtalkEnabled: z.boolean().prefault(true),
        plotFateEnabled: z.boolean().prefault(true),
        emotionEnabled: z.boolean().prefault(true),
        emotionInterval: z.coerce.number().prefault(6),
        summaryInterval: z.coerce.number().prefault(10),
        // 自定义API
        apiMode: z.string().prefault('default'),
        customApiUrl: z.string().prefault(''),
        customApiKey: z.string().prefault(''),
        customApiModel: z.string().prefault(''),
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
  console.info('[智脑] 检测到旧格式聊天数据，正在迁移...');
  return ChatDataSchema.parse(oldData);
}

const GLOBAL_CHAT_KEY = 'mqzn_chat_data';
const GLOBAL_SETTINGS_KEY = 'mqzn_settings';

export const useMainStore = defineStore('main', () => {
  // ========== 数据加载（global 优先，兼容旧格式迁移） ==========

  // 加载聊天数据：先试 global，没有再试 type:'chat'（旧格式）
  const globalVars = getVariables({ type: 'global' }) ?? {};
  let rawChatData = globalVars[GLOBAL_CHAT_KEY];
  let migratedFromOld = false;

  if (!rawChatData) {
    // global 里没有 → 尝试从旧 type:'chat' 读取并迁移
    const oldChatData = getVariables({ type: 'chat' });
    if (oldChatData && Object.keys(oldChatData).length > 0) {
      console.info('[智脑] 从旧存储迁移聊天数据到 global...');
      rawChatData = oldChatData;
      migratedFromOld = true;
    }
  }

  // 加载设置：先试 global，没有再试 type:'script'
  let rawSettings = globalVars[GLOBAL_SETTINGS_KEY];
  if (!rawSettings) {
    rawSettings = getVariables({ type: 'script', script_id: getScriptId() });
    if (rawSettings && Object.keys(rawSettings).length > 0) {
      console.info('[智脑] 从旧存储迁移设置到 global...');
      migratedFromOld = true;
    }
  }

  const currentChatId = SillyTavern.getCurrentChatId();

  // 旧格式迁移：旧版直接存扁平 ChatData，新版存 Record<chatId, ChatData>
  const needsMigration = rawChatData &&
    (rawChatData.summaries !== undefined || rawChatData.capturedContents !== undefined);

  const allChatsData = ref<Record<string, ChatData>>(
    needsMigration
      ? { [currentChatId]: migrateOldFormatToChatData(rawChatData) }
      : (rawChatData ?? {}),
  );

  const scriptData = ref<ScriptSettings>(ScriptSettingsSchema.parse(rawSettings ?? {}));

  // 立即将迁移后的数据写入 global，防止丢失
  if (migratedFromOld || needsMigration) {
    replaceVariables({
      [GLOBAL_CHAT_KEY]: klona(allChatsData.value),
      [GLOBAL_SETTINGS_KEY]: klona(scriptData.value),
    }, { type: 'global' });
    console.info('[智脑] 数据已写入 global 存储');
  }

  // 从 allChatsData 中提取当前聊天的数据（不存在则初始化）
  const chatData = ref<ChatData>(
    allChatsData.value[currentChatId]
      ? ChatDataSchema.parse(allChatsData.value[currentChatId])
      : ChatDataSchema.parse({}),
  );

  // 首次初始化时记录当前聊天ID
  if (!chatData.value.chatId) {
    chatData.value.chatId = currentChatId;
  }

  // ========== 运行状态（不持久化，脚本重载后重置） ==========

  const summaryInProgress = ref(false);
  const dreamtalkInProgress = ref(false);

  function setSummaryInProgress(v: boolean) { summaryInProgress.value = v; }
  function setDreamtalkInProgress(v: boolean) { dreamtalkInProgress.value = v; }

  // 自动保存到 global 存储（不绑定 script_id，换版本/刷新不丢数据）
  watchEffect(() => {
    const globals = getVariables({ type: 'global' }) ?? {};
    // 先把当前聊天数据同步回 allChatsData
    allChatsData.value[currentChatId] = klona(chatData.value);
    globals[GLOBAL_CHAT_KEY] = klona(allChatsData.value);
    globals[GLOBAL_SETTINGS_KEY] = klona(scriptData.value);
    replaceVariables(globals, { type: 'global' });
  });

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
  const dynamicProfiles = computed(() => chatData.value.dynamicProfiles);
  const dreamtalk = computed(() => chatData.value.dreamtalk);
  const userInputRecords = computed(() => chatData.value.userInputRecords);
  const lastSummaryAtMessageId = computed(() => chatData.value.lastSummaryAtMessageId);

  // ========== 用户人格相关 ==========

  function addPersona(name: string): string {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    scriptData.value.personas.push({ id, name, rawInput: '', analyzedProfile: '', lastAnalyzedAt: '' });
    if (!scriptData.value.activePersonaId) {
      scriptData.value.activePersonaId = id;
    }
    return id;
  }

  function removePersona(id: string) {
    scriptData.value.personas = scriptData.value.personas.filter(p => p.id !== id);
    if (scriptData.value.activePersonaId === id) {
      scriptData.value.activePersonaId = scriptData.value.personas[0]?.id ?? '';
    }
  }

  function setActivePersona(id: string) {
    scriptData.value.activePersonaId = id;
  }

  function updatePersonaRaw(rawInput: string) {
    const p = scriptData.value.personas.find(x => x.id === scriptData.value.activePersonaId);
    if (p) p.rawInput = rawInput;
  }

  function updatePersonaProfile(analyzedProfile: string) {
    const p = scriptData.value.personas.find(x => x.id === scriptData.value.activePersonaId);
    if (p) {
      p.analyzedProfile = analyzedProfile;
      p.lastAnalyzedAt = new Date().toISOString();
    }
  }

  function renamePersona(id: string, name: string) {
    const p = scriptData.value.personas.find(x => x.id === id);
    if (p) p.name = name;
  }

  // ========== 设置相关 ==========

  function updateSettings(partial: Partial<ScriptSettings['settings']>) {
    Object.assign(scriptData.value.settings, partial);
  }

  // ========== 正文捕获相关 ==========

  function captureContent(messageId: number, content: string) {
    const existing = chatData.value.capturedContents.find(c => c.messageId === messageId);
    if (existing) {
      existing.content = content;
      existing.capturedAt = new Date().toISOString();
      existing.swipeCount++;
    } else {
      chatData.value.capturedContents.push({
        messageId,
        content,
        capturedAt: new Date().toISOString(),
        swipeCount: 0,
      });
    }
  }

  // ========== 用户输入记录 ==========

  function recordUserInput(messageId: number, userInput: string, aiResponse: string) {
    const existing = chatData.value.userInputRecords.find(r => r.messageId === messageId);
    if (existing) {
      if (existing.aiResponse !== aiResponse && existing.aiResponse) {
        existing.rolledResponses.push(existing.aiResponse);
      }
      existing.aiResponse = aiResponse;
    } else {
      chatData.value.userInputRecords.push({
        messageId,
        userInput,
        aiResponse,
        rolledResponses: [],
      });
    }
  }

  // ========== 大总结相关 ==========

  function addSummary(summary: GrandSummary, upToMessageId?: number, coveredMessageIds?: number[]) {
    const previousSummary = getLatestSummary();

    // 记忆分层合并逻辑
    if (summary.version === 1) {
      // 第一次大总结：合并 core + recent（AI可能输出[核心]或[近期]或无标记），全部归为核心
      for (const mem of summary.characterMemories) {
        const allMemories = [...mem.coreMemories, ...mem.recentMemories];
        mem.coreMemories = allMemories.slice(0, 5);
        mem.recentMemories = [];
      }
    } else if (previousSummary) {
      // 后续大总结：保留之前的核心记忆不变，新生成的记忆标记为近期
      for (const mem of summary.characterMemories) {
        const prevMem = previousSummary.characterMemories.find(
          m => m.characterName === mem.characterName,
        );
        if (prevMem) {
          // 保留之前的核心记忆
          mem.coreMemories = prevMem.coreMemories;
          // 新生成的记忆作为近期记忆（最多保留8条，不混入旧核心）
          mem.recentMemories = (mem.recentMemories || []).slice(0, 8);
        } else {
          // 新角色：合并解析出的core+recent，前3条作为核心，其余作为近期
          const allMemories = [...mem.coreMemories, ...mem.recentMemories];
          mem.coreMemories = allMemories.slice(0, 3);
          mem.recentMemories = allMemories.slice(3, 11);
        }
      }
    }

    const normalizedCoveredIds = coveredMessageIds ?? getCapturedContentMessageIds(chatData.value.capturedContents);
    summary.coveredMessageIds = normalizedCoveredIds;
    summary.upToMessageId =
      upToMessageId ?? normalizedCoveredIds[normalizedCoveredIds.length - 1] ?? chatData.value.lastSummaryAtMessageId;

    chatData.value.summaries.push(summary);
    // 只保留最近3个版本的大总结，方便回退
    if (chatData.value.summaries.length > 3) {
      chatData.value.summaries = chatData.value.summaries.slice(-3);
    }
    chatData.value.lastSummaryAtMessageId = Math.max(
      chatData.value.lastSummaryAtMessageId,
      summary.upToMessageId ?? 0,
    );
  }

  function getLatestSummary(): GrandSummary | undefined {
    return chatData.value.summaries[chatData.value.summaries.length - 1];
  }

  function getCoveredFloorsDisplay(): string {
    const summary = getLatestSummary();
    if (!summary?.coveredMessageIds?.length) return '';
    const ids = [...summary.coveredMessageIds].sort((a, b) => a - b);
    return ` (#${ids[0]}${ids.length > 1 ? `-#${ids[ids.length - 1]}` : ''}, ${ids.length}层)`;
  }

  function rollbackSummary(force = false, saveToHistory = true): GrandSummary | undefined {
    if (!force && chatData.value.summaries.length <= 1) {
      console.info('[智脑] 无法撤回，至少保留一条总结');
      return undefined;
    }
    const removed = chatData.value.summaries.pop();
    if (removed && saveToHistory) {
      chatData.value.summaryHistory.push(removed);
      if (chatData.value.summaryHistory.length > 3) {
        chatData.value.summaryHistory.shift();
      }
    }
    const previousSummary = getLatestSummary();
    chatData.value.lastSummaryAtMessageId = previousSummary?.upToMessageId ?? 0;

    if (removed) {
      chatData.value.dynamicProfiles = chatData.value.dynamicProfiles.filter(
        profile => profile.basedOnSummaryVersion !== removed.version,
      );
      console.info(`[智脑] 已回退大总结 v${removed.version}`);
    }

    return removed;
  }

  function restoreLastSummary(): GrandSummary | undefined {
    if (chatData.value.summaryHistory.length === 0) {
      console.info('[智脑] 没有可恢复的大总结');
      return undefined;
    }
    const restored = chatData.value.summaryHistory.pop()!;
    chatData.value.summaries.push(restored);
    chatData.value.lastSummaryAtMessageId = Math.max(
      chatData.value.lastSummaryAtMessageId,
      restored.upToMessageId ?? 0,
    );
    console.info(`[智脑] 已恢复大总结 v${restored.version}`);
    return restored;
  }

  function getHiddenFloors(): HiddenFloor[] {
    return getHiddenFloorsFromChat();
  }

  /** 更新大总结原文（用户手动编辑后调用），完整重新解析所有 SECTION 并同步 */
  function updateSummaryRawText(version: number, newRawText: string) {
    const summary = chatData.value.summaries.find(s => s.version === version);
    if (!summary || !newRawText.trim()) return;

    try {
      const parsed: ParsedSummary = parseSummaryOutput(newRawText, version);

      // 校验：如果解析后角色记忆为空但原本有数据，拒绝写入
      if (parsed.characterMemories.length === 0 && summary.characterMemories.length > 0) {
        throw new Error('解析结果异常：角色记忆为空');
      }

      summary.rawText = newRawText;
      summary.characterMemories = parsed.characterMemories;
      summary.timeline = parsed.timeline;
      summary.characterTable = parsed.characterTable;

      // 同步 dynamicProfiles
      for (const profile of parsed.dynamicProfiles) {
        const existing = chatData.value.dynamicProfiles.find(
          p => p.characterName === profile.characterName,
        );
        if (existing) {
          Object.assign(existing, profile);
        } else {
          chatData.value.dynamicProfiles.push(profile);
        }
      }

      // 同步 nsfwMemories
      if (parsed.nsfwMemories && parsed.nsfwMemories.length > 0) {
        for (const mem of parsed.nsfwMemories) {
          const existing = chatData.value.nsfwMemories.find(
            m => m.characterName === mem.characterName,
          );
          if (existing) {
            Object.assign(existing, mem);
          } else {
            chatData.value.nsfwMemories.push(mem);
          }
        }
      }

      console.info(`[智脑] 大总结 v${version} 手动编辑后已完整重新解析并同步`);
    } catch (error) {
      console.error('[智脑] 重新解析失败，保留原结构', error);
    }
  }

  // ========== 动态人设相关 ==========

  function updateDynamicProfile(profile: DynamicProfile) {
    const existing = chatData.value.dynamicProfiles.find(
      p => p.characterName === profile.characterName,
    );
    if (existing) {
      Object.assign(existing, profile);
    } else {
      chatData.value.dynamicProfiles.push(profile);
    }
  }

  // ========== 记忆库相关 ==========

  function getCharacterMemories(characterName: string): CharacterMemory & { memories: string[] } | undefined {
    const latest = getLatestSummary();
    if (!latest) return undefined;
    const mem = latest.characterMemories.find(m => m.characterName === characterName);
    if (mem) {
      // 兼容性：合并 coreMemories + recentMemories 为 memories 字段
      (mem as any).memories = [...(mem.coreMemories || []), ...(mem.recentMemories || [])];
    }
    return mem as any;
  }

  function getAllCharacterNames(): string[] {
    const latest = getLatestSummary();
    if (!latest) return [];
    return latest.characterMemories.map(m => m.characterName);
  }

  // ========== 梦呓相关 ==========

  function updateDreamtalk(data: DreamtalkData) {
    if (chatData.value.dreamtalk) {
      chatData.value.dreamtalkHistory.push(JSON.parse(JSON.stringify(chatData.value.dreamtalk)));
      if (chatData.value.dreamtalkHistory.length > 5) {
        chatData.value.dreamtalkHistory.shift();
      }
    }
    chatData.value.dreamtalk = data;
  }

  function rollbackDreamtalk(): DreamtalkData | null {
    if (!chatData.value.dreamtalk || chatData.value.dreamtalkHistory.length === 0) {
      console.info('[智脑] 没有可撤回的梦呓');
      return null;
    }
    chatData.value.dreamtalkUndoHistory.push(JSON.parse(JSON.stringify(chatData.value.dreamtalk)));
    if (chatData.value.dreamtalkUndoHistory.length > 5) {
      chatData.value.dreamtalkUndoHistory.shift();
    }
    const restored = chatData.value.dreamtalkHistory.pop()!;
    chatData.value.dreamtalk = restored;
    console.info('[智脑] 梦呓已撤回');
    return restored;
  }

  function restoreDreamtalk(): DreamtalkData | null {
    if (!chatData.value.dreamtalk || chatData.value.dreamtalkUndoHistory.length === 0) {
      console.info('[智脑] 没有可恢复的梦呓');
      return null;
    }
    chatData.value.dreamtalkHistory.push(JSON.parse(JSON.stringify(chatData.value.dreamtalk)));
    if (chatData.value.dreamtalkHistory.length > 5) {
      chatData.value.dreamtalkHistory.shift();
    }
    const restored = chatData.value.dreamtalkUndoHistory.pop()!;
    chatData.value.dreamtalk = restored;
    console.info('[智脑] 梦呓已恢复');
    return restored;
  }

  function getDreamtalkCharacterNames(): string[] {
    if (!chatData.value.dreamtalk) return [];
    return chatData.value.dreamtalk.characterInteractions.map(i => i.characterName);
  }

  // ========== NSFW隔离层相关 ==========

  const nsfwMemories = computed(() => chatData.value.nsfwMemories);
  const nsfwDreamtalk = computed(() => chatData.value.nsfwDreamtalk);
  const nsfwDynamicProfiles = computed(() => chatData.value.nsfwDynamicProfiles);

  function updateNsfwMemories(memories: NsfwCharacterMemory[]) {
    for (const mem of memories) {
      const existing = chatData.value.nsfwMemories.find(m => m.characterName === mem.characterName);
      if (existing) {
        Object.assign(existing, mem);
      } else {
        chatData.value.nsfwMemories.push(mem);
      }
    }
  }

  function updateNsfwDreamtalk(data: NsfwDreamtalkData) {
    chatData.value.nsfwDreamtalk = data;
  }

  function updateNsfwDynamicProfile(profile: NsfwDynamicProfile) {
    const existing = chatData.value.nsfwDynamicProfiles.find(p => p.characterName === profile.characterName);
    if (existing) {
      Object.assign(existing, profile);
    } else {
      chatData.value.nsfwDynamicProfiles.push(profile);
    }
  }

  // ========== 倒果为因相关 ==========

  const plotFate = computed(() => chatData.value.plotFate);

  function updatePlotFate(state: PlotFateState) {
    chatData.value.plotFate = state;
  }

  // ========== 情绪积累相关 ==========

  const emotionState = computed(() => chatData.value.emotionState);

  function updateEmotionState(state: EmotionAccumulationState) {
    chatData.value.emotionState = state;
  }

  // ========== 读取历史楼层 ==========

  async function loadHistoryFloors(): Promise<number> {
    const lastId = getLastMessageId();
    if (lastId < 0) {
      console.info('[智脑] 当前没有聊天楼层');
      return 0;
    }

    // 获取所有 AI 回复楼层
    const aiMessages = getChatMessages(`0-${lastId}`, { role: 'assistant' });
    // 获取所有用户楼层
    const userMessages = getChatMessages(`0-${lastId}`, { role: 'user' });

    let loadedCount = 0;

    for (const msg of aiMessages) {
      // 跳过已存在的楼层
      if (chatData.value.capturedContents.some(c => c.messageId === msg.message_id)) {
        continue;
      }

      // 使用统一的 extractContentFromMessage（含 <time> 标签提取）
        const extractedContent = extractContentFromMessage(msg.message);
        if (!extractedContent) continue;

      // 存入 capturedContents
      chatData.value.capturedContents.push({
        messageId: msg.message_id,
        content: extractedContent,
        capturedAt: new Date().toISOString(),
        swipeCount: 0,
      });

      // 查找对应的用户输入（AI楼层的前一楼通常是用户输入）
      const userMsg = userMessages.find(u => u.message_id === msg.message_id - 1);
      if (userMsg && !chatData.value.userInputRecords.some(r => r.messageId === msg.message_id)) {
        chatData.value.userInputRecords.push({
          messageId: msg.message_id,
          userInput: userMsg.message,
          aiResponse: extractedContent,
          rolledResponses: [],
        });
      }

      loadedCount++;
    }

    console.info(`[智脑] 读取历史楼层完成，共补录 ${loadedCount} 条`);
    return loadedCount;
  }

  // ========== 数据管理 ==========

  function exportAllData(): string {
    return JSON.stringify({ scriptData: klona(scriptData.value), chatData: klona(chatData.value) }, null, 2);
  }

  function importAllData(jsonStr: string) {
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.scriptData) {
        scriptData.value = ScriptSettingsSchema.parse(parsed.scriptData);
      }
      if (parsed.chatData) {
        chatData.value = ChatDataSchema.parse(parsed.chatData);
        // 旧版备份没有 chatId，补填当前聊天ID
        if (!chatData.value.chatId) {
          chatData.value.chatId = currentChatId;
        }
        console.info(`[智脑] 数据导入成功 (总结: ${chatData.value.summaries.length}, 梦呓: ${chatData.value.dreamtalk ? '有' : '无'}, 捕获: ${chatData.value.capturedContents.length})`);
        return;
      }
      console.info('[智脑] 数据导入成功');
    } catch (e) {
      console.error('[智脑] 数据导入失败:', e);
      throw e;
    }
  }

  function clearChatData() {
    chatData.value = ChatDataSchema.parse({});
    console.info('[智脑] 聊天数据已清空');
  }

  function clearAllData() {
    scriptData.value = ScriptSettingsSchema.parse({});
    chatData.value = ChatDataSchema.parse({});
    console.info('[智脑] 所有数据已清空');
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
    recordUserInput,
    // 大总结
    addSummary,
    getLatestSummary,
    getCoveredFloorsDisplay,
    rollbackSummary,
    restoreLastSummary,
    updateSummaryRawText,
    getHiddenFloors,
    // 动态人设
    updateDynamicProfile,
    // 记忆库
    getCharacterMemories,
    getAllCharacterNames,
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
    // 倒果为因
    plotFate,
    updatePlotFate,
    // 情绪积累
    emotionState,
    updateEmotionState,
    // 数据管理
    exportAllData,
    importAllData,
    clearChatData,
    clearAllData,
    // 历史楼层
    loadHistoryFloors,
    // 模型检测
    getCurrentModel,
    isClaudeModel,
    // 运行状态
    summaryInProgress,
    dreamtalkInProgress,
    setSummaryInProgress,
    setDreamtalkInProgress,
  };
});
