/**
 * 明月秋青脚本 - 智脑系统入口
 *
 * 功能：
 * 1. 用户人格分析与注入
 * 2. 动态人设生成与注入
 * 3. 正文捕获与记录
 * 4. 精准大总结（精神链记忆库）
 * 5. 记忆激活系统
 * 6. 梦呓系统
 * 7. 调度系统（队列）
 */
import { createScriptIdDiv, reloadOnChatChange, teleportStyle } from '@util/script';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './components/ui'; // UI 原语库（统一出口，强制参与编译）
import App from './App.vue';
import { buildDreamtalkInjection, executeDreamtalkAnalysis, scanCharacterNamesFromContent } from './core/dreamtalk';
import { injectPersonaIntoCompletion } from './core/persona';
import { injectNeuralChain, removeNeuralChainInjection } from './core/neuralChain';
import { injectNsfwData, isNsfwActive, removeNsfwInjection } from './core/nsfwIsolation';

import {
  buildMemorySectionText,
} from './core/summary';
import { mergeWorldProgressIntoSummary } from './core/memoryMerge';
import {
  ensureRecentFloorsVisible as ensureRecentFloorsVisibleCore,
  getCapturedContentMessageIds,
  hideSummaryFloors,
} from './core/floorVisibility';
import { enqueueAnalysis, clearSchedulerQueue } from './core/backgroundQueue';
import { embedTimelineEvents, embedCharacterMemories, getEmbedding, rerankCandidates } from './core/embedding';
import { executeSmallSummary, type SmallSummaryKgOptions, type PreviousRoundContext } from './core/smallSummary';
import { applyKnowledgeGraphDiff, createEmptyKnowledgeGraph, embedKnowledgeGraphNodes, hasMissingEmbedding, buildStableId } from './core/knowledgeGraph';
import type { KnowledgeGraph } from './core/knowledgeGraph';
import { buildWorldGraphInjection, injectWorldGraphIntoCompletion, removeWorldGraphInjection } from './core/worldGraphInject';
import { getHiddenFloorsFromChat } from './core/floorVisibility';
import { injectRelationshipProfiles, removeRelationshipInjection, updateRelationshipWorldbookCacheFromLore } from './core/relationshipAnalysis';
import {
  countContentTextLength,
  isValidMainContent,
  MIN_VALID_CONTENT_TEXT_LENGTH,
} from './utils/messageParser';
import { cleanCharacterAliases, normalizeCharacterName } from './utils/characterNames';
import { logInfo, logWarn, logError } from './utils/logger';
import { isMvuExtraAnalysis, stripZhinoInjectionsFromCompletion } from './utils/mvuGuard';
import { useMainStore, type CapturedContent, type CharacterMemory, type GrandSummary, type TimelineEvent } from './stores/mainStore';
import {
  fingerprintMemorySourceContents,
  installMemoryWarehouseDebugApi,
  reconcileMemoryWarehouseSourceChange,
  recallCharacterMemoriesFromWarehouse,
  recallTimelineEventsFromWarehouse,
} from './core/memoryWarehouseRuntime';
import { commitRealtimeMemoryTransaction } from './core/memoryCommitCoordinator';
import { rawChatReader } from './core/rawChatReader';
import { SourceChangeTracker } from './core/sourceChangeTracker';
import { deleteMemoryWarehouseForChat } from './core/memoryWarehouse';

// ========== 新模块导入 ==========
import { executeGrandSummaryV2 } from './core/grandSummaryV2';
import { executeCharacterMemoryUpdate } from './core/characterMemoryUpdate';
import { executeDynamicProfileV2, injectDynamicProfileV2, removeDynamicProfileV2Injection } from './core/dynamicProfileV2';
import {
  buildWorldProgressEntryInjection,
  createFailedWorldProgressRecord,
  executeWorldProgress,
  injectWorldProgress,
  normalizeWorldProgressMemoryForGraph,
  removeWorldProgressInjection,
  shouldTriggerWorldProgress,
} from './core/worldProgress';
import { injectPlotGuidance, executePlotCheck, removePlotInjection, shouldTriggerPlotCheck, advanceOutlineStage } from './core/plotDirector';

import { injectWorldBookTagIndex, removeWorldBookTagIndexInjection } from './core/worldBookTags';
import { hydrateSelectedWorldBookEntries } from './core/worldBookSelection';
import {
  countPendingAssistantContents,
  getLatestValidAssistantFloorBefore,
  isAssistantContentCurrent,
  readAssistantContentAtFloor,
  readAssistantContentsInRange,
  readAssistantExtractedContentAtFloor,
  readDreamtalkPair,
  readLatestAssistantContent,
  readLatestUserInputBefore,
  readPendingSummaryContents,
  readRecentAssistantContents,
} from './utils/chatContent';

const MQZN_BUILD_MARK = 'context-fold-final-a-20260717';

try {
  (window as any).__MQZN_BUILD_MARK = MQZN_BUILD_MARK;
} catch {
  // ignore
}

function getSmallSummaryEndFloor(record: any): number {
  return record?.floorRange?.end ?? record?.floorRange?.start ?? -1;
}

function isCapturedContentCurrent(
  store: ReturnType<typeof useMainStore>,
  aiFloor: number,
  expectedContent: string,
): boolean {
  return isAssistantContentCurrent(aiFloor, expectedContent, store.chatData.capturedContents);
}

function getLatestValidCapturedFloorBefore(store: ReturnType<typeof useMainStore>, aiFloor: number): number {
  return getLatestValidAssistantFloorBefore(aiFloor, store.chatData.capturedContents);
}

function truncateMainResponseArtifactsFromFloor(
  store: ReturnType<typeof useMainStore>,
  aiFloor: number,
): {
  captured: number;
  userRecords: number;
  smallSummaries: number;
  kgVersions: number;
  worldProgress: number;
  dynamicProfiles: number;
  dreamtalk: number;
  cursors: number;
} {
  const captured = 0;

  const userFloor = aiFloor - 1;
  const recordsBefore = store.chatData.userInputRecords.length;
  store.chatData.userInputRecords = store.chatData.userInputRecords.filter(r => r.messageId < userFloor);
  const userRecords = recordsBefore - store.chatData.userInputRecords.length;

  const obsoleteSmallSummaries = (store.chatData.smallSummaries || []).filter(
    (s: any) => getSmallSummaryEndFloor(s) >= aiFloor,
  );
  for (const ss of obsoleteSmallSummaries) clearWPConsumedFlag(store, ss);
  if (obsoleteSmallSummaries.length > 0) {
    store.chatData.smallSummaries = (store.chatData.smallSummaries || []).filter(
      (s: any) => getSmallSummaryEndFloor(s) < aiFloor,
    );
  }

  const obsoleteKgVersions = (store.chatData.knowledgeGraphVersions || []).filter(v => v.floor >= aiFloor);
  if (obsoleteKgVersions.length > 0) {
    const baseGraphState = store.getKnowledgeGraphStateForFloor(aiFloor);
    store.commitKnowledgeGraph(
      baseGraphState.graph || createEmptyKnowledgeGraph(),
      aiFloor,
      baseGraphState.characterLocations || {},
    );
  }

  const worldProgress = store.truncateWorldProgressRecords(aiFloor);
  let dynamicProfiles = 0;
  let dreamtalk = 0;
  let cursors = 0;
  if (store.chatData.lastWorldProgressFloor >= aiFloor) {
    const records = store.chatData.worldProgressRecords || [];
    store.chatData.lastWorldProgressFloor = records.length > 0
      ? Math.max(...records.map((r: any) => r.basedOnFloorRange?.end ?? -1))
      : -1;
    cursors++;
  }
  if (store.chatData.lastDreamtalkFloor >= aiFloor) {
    store.chatData.lastDreamtalkFloor = getLatestValidCapturedFloorBefore(store, aiFloor);
    dreamtalk = (store.chatData.dreamtalk ? 1 : 0) + (store.chatData.dreamtalkHistory?.length || 0);
    store.chatData.dreamtalk = null;
    store.chatData.dreamtalkHistory = [];
    cursors++;
  }
  if (store.chatData.lastPlotCheckFloor >= aiFloor) {
    store.chatData.lastPlotCheckFloor = -1;
    store.chatData.lastPlotCheckResult = null;
    cursors++;
  }
  if (store.chatData.pendingDynamicProfile) {
    const lastId = (() => {
      try { return getLastMessageId(); } catch { return -1; }
    })();
    const newDynamicCount = lastId >= 0
      ? readAssistantContentsInRange(
          store.chatData.lastDynamicProfileFloor + 1,
          lastId,
          store.chatData.capturedContents,
        ).length
      : 0;
    if (newDynamicCount < store.settings.dynamicProfileInterval) {
      store.chatData.pendingDynamicProfile = false;
      cursors++;
    }
  }
  if (store.chatData.lastDynamicProfileFloor >= aiFloor) {
    dynamicProfiles = store.chatData.dynamicProfilesV2?.length || 0;
    store.chatData.dynamicProfilesV2 = [];
    store.chatData.lastDynamicProfileFloor = getLatestValidCapturedFloorBefore(store, aiFloor);
    store.chatData.pendingDynamicProfile = store.settings.dynamicProfileEnabled;
    cursors++;
  }
  if (store.chatData.pendingWorldProgress && (store.chatData.pendingWorldProgressFloor ?? -1) >= aiFloor) {
    store.chatData.pendingWorldProgress = false;
    store.chatData.pendingWorldProgressFloor = -1;
    cursors++;
  }

  if (captured || userRecords || obsoleteSmallSummaries.length || worldProgress || dynamicProfiles || dreamtalk || cursors) {
    store.forcePersist({ settings: false });
  }

  return {
    captured,
    userRecords,
    smallSummaries: obsoleteSmallSummaries.length,
    kgVersions: obsoleteKgVersions.length,
    worldProgress,
    dynamicProfiles,
    dreamtalk,
    cursors,
  };
}

function blockInvalidMainContent(
  store: ReturnType<typeof useMainStore>,
  aiFloor: number,
  content: string,
  source: 'received' | 'swiped',
): void {
  const textLength = countContentTextLength(content);
  const removed = truncateMainResponseArtifactsFromFloor(store, aiFloor);
  logWarn(
    '正文回空检测',
    `楼层 ${aiFloor} 正文字数 ${textLength}/${MIN_VALID_CONTENT_TEXT_LENGTH}，已拦截后续机制`,
    `source=${source}; cleanup=${JSON.stringify(removed)}`,
  );
  try {
    window.toastr?.warning(
      `本次 AI 正文只有 ${textLength} 字，少于 ${MIN_VALID_CONTENT_TEXT_LENGTH}，已视为回空并停止智脑后处理。请重 roll 或重新生成。`,
      '正文回空拦截',
      { timeOut: 6000, extendedTimeOut: 3000 },
	    );
	  } catch (_) { /* ignore */ }
}

function buildMemoryActivationList(store: ReturnType<typeof useMainStore>): CharacterMemory[] {
  const normalizeName = (name: string) => normalizeCharacterName(name);
  const entryByNorm = new Map(
    store.getCharacterNameEntries({ includeUser: false })
      .map(entry => [normalizeName(entry.name), entry]),
  );
  const collectAliases = (characterName: string): string[] => {
    const canonical = store.resolveKnownCharacterName(characterName, true);
    const target = normalizeName(canonical || characterName);
    return cleanCharacterAliases(entryByNorm.get(target)?.aliases || [], canonical || characterName);
  };

  const base = (store.getLatestSummary()?.characterMemories || []).map(m => ({
    ...m,
    aliases: [...new Set([...(m.aliases || []), ...collectAliases(m.characterName)])],
  }));
  const seen = new Set(base.map(m => normalizeName(m.characterName || '')));
  for (const mem of store.chatData.worldProgressMemories || []) {
    if (!mem?.characterName || (mem as any).archivedInSummaryVersion) continue;
    const name = normalizeName(mem.characterName);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    base.push({
      characterName: mem.characterName,
      aliases: collectAliases(mem.characterName),
      attitude: 'neutral',
      coreMemories: [],
      recentMemories: [],
      keywords: [],
      orderedNewMemories: [],
    });
  }
  return base;
}

// ========== 关键词模糊匹配（子串命中） ==========

/**
 * 检查关键词是否在文本中命中（支持子串模糊匹配）
 *
 * 动机：AI 生成的关键词常为多字复合词（腥臭爱液、神魂共鸣、永恒山脉），
 * 但对话中极少完整复现，只会自然提到片段（爱液、共鸣、山脉）。
 *
 * 策略：
 * 1. 精确匹配优先（快路径）
 * 2. 长关键词（≥4字）提取 2-3 字子串，任一子串出现在文本中即命中
 * 3. 短关键词（≤3字）仅精确匹配（避免误触发）
 *
 * 注意：此方法只处理连续子串匹配，非连续的缩写（如 开辟空窍→开窍）
 * 需 AI 在关键词中同时包含缩写形式。
 */
function fuzzyMatchKeyword(keyword: string, text: string): boolean {
  const kw = keyword.toLowerCase();
  const t = text;
  // 1. 精确匹配
  if (t.includes(kw)) return true;
  // 2. 子串匹配：仅对 ≥4 字的关键词，提取 2-3 字滑动窗口
  if (kw.length >= 4) {
    for (let len = 3; len >= 2; len--) {
      for (let i = 0; i <= kw.length - len; i++) {
        const sub = kw.slice(i, i + len);
        if (t.includes(sub)) return true;
      }
    }
  }
  return false;
}

$(() => {
  const pinia = createPinia();
  const sourceChangeTracker = new SourceChangeTracker();
  let sourceChangeQueue: Promise<void> = Promise.resolve();
  let unresolvedSourceChangeFloor: number | null = null;

  // ========== 前端面板挂载（div模式，挂载到酒馆网页body） ==========

  let app: ReturnType<typeof createApp> | null = null;
  let $app: JQuery<HTMLDivElement> | null = null;
  let styleHandle: { destroy: () => void } | null = null;

  const mountAppAndInitStore = (options: { captureFloorZero?: boolean } = {}) => {
    if (app) return;
    app = createApp(App).use(pinia);
    $app = createScriptIdDiv().appendTo('body');
    styleHandle = teleportStyle();
    app.mount($app[0]);
    const store = useMainStore(pinia);
    sourceChangeTracker.reset(rawChatReader.readAllSourceContents());
    if (options.captureFloorZero !== false && getCurrentChatIdSafe()) {
      store.captureFloorZero();
    }
    installMemoryWarehouseDebugApi(() => ({
      chatId: store.chatData.chatId || getCurrentChatIdSafe(),
      smallSummaries: store.chatData.smallSummaries,
      grandSummaries: store.chatData.summaries,
      settings: {
        embeddingApiUrl: store.settings.embeddingApiUrl,
        embeddingModel: store.settings.embeddingModel,
        embeddingDimensions: store.settings.embeddingDimensions,
      },
    }));
    setTimeout(() => void auditCommittedMemorySources(store), 0);
  };

  // 捕获开场白（第0层不会触发 MESSAGE_RECEIVED 事件）
  // ⚠ 刷新时的时序修复：chat_metadata.variables 由 SillyTavern 在 'chatLoaded'
  // 事件触发前才完成 rehydrate。store 必须等聊天元数据就绪后再构造，
  // 否则 tryReadData 会读到空的 chat 变量并构造空壳。先探测是否已就绪，未就绪则等 'chatLoaded'；主页(无角色卡)
  // 刷新时 'chatLoaded' 可能已错过，于是用 'app_ready' + 轮询兜底；5 秒仍未就绪只记日志，不强行挂载。
  // 注：JS-Slash-Runner A3.6 的 tavern_events 手维护副本里没有 CHAT_LOADED/APP_READY
  // 这两个 key（值为 undefined），必须用字面字符串注册，否则监听是 no-op。

  const getCurrentChatIdSafe = (): string => {
    try {
      const s: any = (typeof SillyTavern !== 'undefined') ? SillyTavern : (window as any).SillyTavern;
      return (s && typeof s.getCurrentChatId === 'function') ? (s.getCurrentChatId() || '') : '';
    } catch {
      return '';
    }
  };

  const canReadChatVariables = (): boolean => {
    try {
      if (typeof getVariables !== 'function') return false;
      getVariables({ type: 'chat' });
      return true;
    } catch {
      return false;
    }
  };

  const getCurrentChatRuntime = (): {
    chatId: string;
    chatLength: number;
    hasMetadata: boolean;
    hasIntegrity: boolean;
    hasVariablesObject: boolean;
  } => {
    try {
      const st: any = (typeof SillyTavern !== 'undefined') ? SillyTavern : (window as any).SillyTavern;
      const ctx = st?.getContext?.() ?? st ?? {};
      const metadata = ctx?.chatMetadata;
      const chatId = st && typeof st.getCurrentChatId === 'function'
        ? (st.getCurrentChatId() || '')
        : (ctx?.chatId || '');
      return {
        chatId,
        chatLength: Array.isArray(ctx?.chat) ? ctx.chat.length : 0,
        hasMetadata: !!metadata && typeof metadata === 'object',
        hasIntegrity: !!metadata?.integrity,
        hasVariablesObject: !!metadata?.variables && typeof metadata.variables === 'object',
      };
    } catch {
      return { chatId: '', chatLength: 0, hasMetadata: false, hasIntegrity: false, hasVariablesObject: false };
    }
  };

  let lastReadyProbeChatId = getCurrentChatIdSafe();
  let lastReadyProbeAt = Date.now();
  const noteStableChatId = (): string => {
    const currentChatId = getCurrentChatIdSafe();
    if (currentChatId !== lastReadyProbeChatId) {
      lastReadyProbeChatId = currentChatId;
      lastReadyProbeAt = Date.now();
    }
    return currentChatId;
  };

  // 探测 chat 是否已就绪：当前 chatId 稳定 + chat 变量表可读取。
  // 不再用 chat.length 作为就绪条件；新建聊天时开场白会先出现，但变量表可能还没切稳。
  // 注意：chat_metadata 在脚本沙箱里不一定暴露为全局变量，不能把它作为硬门槛；
  // 变量里如果残留旧 chatId，不在入口卡死；由 mainStore 的 chatId 校验过滤，避免面板打不开。
  const getMountMode = (): 'chat' | 'home' | null => {
    const currentChatId = noteStableChatId();
    if (Date.now() - lastReadyProbeAt < 250) return null;
    if (!currentChatId) return Date.now() - lastReadyProbeAt >= 1000 ? 'home' : null;
    const runtime = getCurrentChatRuntime();
    if (!runtime.chatId || runtime.chatId !== currentChatId) return null;
    if (!runtime.hasMetadata || (!runtime.hasIntegrity && runtime.chatLength === 0)) {
      return null;
    }
    return canReadChatVariables() ? 'chat' : null;
  };

  const waitUntilChatReadyThenMount = () => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let poller: ReturnType<typeof setInterval> | null = null;
    let done = false;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (poller) { clearInterval(poller); poller = null; }
      try { (eventSource as any)?.off?.('chatLoaded' as any, onChat); } catch { /* noop */ }
      try { (eventSource as any)?.off?.('chat_id_changed' as any, onChat); } catch { /* noop */ }
      try { (eventSource as any)?.off?.('app_ready' as any, onChat); } catch { /* noop */ }
    };
    const tryMount = () => {
      if (done) return;
      const mode = getMountMode();
      if (!mode) return;
      done = true;
      cleanup();
      mountAppAndInitStore({ captureFloorZero: mode === 'chat' });
    };
    const onChat = () => window.setTimeout(tryMount, 0);

    tryMount();
    if (done) return;
    poller = setInterval(tryMount, 100);
    timer = setTimeout(() => {
      if (!done) logWarn('系统', '等待聊天变量切换完成中，暂缓初始化智脑面板');
    }, 5000);
    try { eventOn('chatLoaded' as any, onChat); } catch { /* noop */ }
    try { eventOn('chat_id_changed' as any, onChat); } catch { /* noop */ }
    try { eventOn('app_ready' as any, onChat); } catch { /* noop */ }
  };

  waitUntilChatReadyThenMount();

  // ========== 世界书角色名缓存 ==========

  /** 从世界书条目中提取的角色名集合（每次推演时实时更新） */
  let worldBookNames = new Set<string>();
  /** 世界书角色名→内容（用于手动注入到 callGenerateRaw 调用中） */
  let worldBookContents = new Map<string, string>();
  /** 原始世界书条目（保留用于后续重新扫描） */
  let worldBookRawEntries: any[] = [];

  function refreshWorldBookCache(store: ReturnType<typeof useMainStore>) {
    if (worldBookRawEntries.length === 0) return;
    const characterEntries = store.getCharacterNameEntries();
    const knownNames = [
      ...characterEntries.map(entry => entry.name),
      ...(store.worldProgressManualChars || '').split(',').map(s => s.trim()).filter(Boolean),
    ];
    const knownNamesSet = new Set(knownNames);
    if (knownNamesSet.size === 0) return;

    const names = new Set<string>();
    const contents = new Map<string, string>();

    for (const entry of worldBookRawEntries) {
      const entryContent: string = (entry as any).content || '';
      // entry.key / entry.keysecondary 可能是 string 或 string[]
      const rawKey = (entry as any).key;
      const rawKeySecondary = (entry as any).keysecondary;
      const keyStr = Array.isArray(rawKey) ? rawKey.join(',') : (rawKey || '');
      const keySecStr = Array.isArray(rawKeySecondary) ? rawKeySecondary.join(',') : (rawKeySecondary || '');
      const keys = [
        ...keyStr.split(',').map((k: string) => k.trim().toLowerCase()),
        ...keySecStr.split(',').map((k: string) => k.trim().toLowerCase()),
      ].filter(Boolean);
      const contentLower = entryContent.toLowerCase();

      for (const name of knownNamesSet) {
        const nameLower = name.toLowerCase();
        const nameNorm = nameLower.replace(/\s*\(.+?\)\s*/g, '').trim();
        if (keys.some(k => k.includes(nameNorm) || nameNorm.includes(k))
            || contentLower.includes(nameNorm)
            || contentLower.includes(nameLower)) {
          names.add(name);
          const existing = contents.get(name) || '';
          contents.set(name, existing ? existing + '\n---\n' + entryContent : entryContent);
        }
      }
    }

    if (names.size > 0) {
      worldBookNames = names;
      worldBookContents = contents;
    }
  }

  eventOn(tavern_events.WORLDINFO_ENTRIES_LOADED, (lores) => {
    updateRelationshipWorldbookCacheFromLore(lores);
    // 保存原始条目供后续重新扫描（过滤关闭的条目）
    const allRawEntries = [
      ...(lores.characterLore || []),
      ...(lores.globalLore || []),
      ...(lores.chatLore || []),
      ...(lores.personaLore || []),
    ];
    worldBookRawEntries = allRawEntries.filter((e: any) => e.enabled !== false);
    const store = useMainStore(pinia);
    // 轻量列表（条目名+所属世界书名）持久化进 chat 变量，供剧情导演/世界推进 UI 勾选；
    // 完整正文不入 chat 变量，改存 store 的非持久化运行时缓存 worldBookRawCache，
    // 供 WorldTab 点"保存"时按 key 反查录入 savedPlotWB/savedWPWB。
    store.chatData.worldBookEntries = worldBookRawEntries
      .map((e: any) => {
        const rawKey = e.key;
        const displayKey = e.comment || e.name || (Array.isArray(rawKey) ? rawKey.join(', ') : (rawKey || '未命名'));
        const book = typeof e.world === 'string' ? e.world : e.world_info_name || '';
        const uid = Number.isFinite(Number(e.uid)) ? Number(e.uid) : undefined;
        const entryName = e.name || e.comment || displayKey;
        return { key: displayKey, book, uid, entryName };
      })
      .filter((e: any) => e.key && e.key !== '未命名' ? true : !!e.book)
      .sort((a: any, b: any) => (b.key || '').localeCompare(a.key || ''));
    store.worldBookRawCache = worldBookRawEntries
      .map((e: any) => {
        const rawKey = e.key;
        const displayKey = e.comment || e.name || (Array.isArray(rawKey) ? rawKey.join(', ') : (rawKey || '未命名'));
        const book = typeof e.world === 'string' ? e.world : e.world_info_name || '';
        const uid = Number.isFinite(Number(e.uid)) ? Number(e.uid) : undefined;
        const entryName = e.name || e.comment || displayKey;
        const content = typeof e.content === 'string' ? e.content : String(e.content || '');
        return { key: displayKey, book, uid, entryName, content };
      })
      .filter((e: any) => e.content);
    store.chatData.savedWPWB = hydrateSelectedWorldBookEntries(
      store.chatData.worldProgressWorldBookKeys,
      store.chatData.savedWPWB,
      store.worldBookRawCache,
    );
    store.chatData.savedPlotWB = hydrateSelectedWorldBookEntries(
      store.chatData.selectedWorldBookKeys,
      store.chatData.savedPlotWB,
      store.worldBookRawCache,
    );
    store.schedulePersist({ settings: false });
    refreshWorldBookCache(store);
  });

  // ========== 正文捕获系统 ==========

  /**
   * 针对一条 AI 楼层跑小总结 + 图谱增量合并 + 角色位置更新。
   * 给 MESSAGE_RECEIVED（新回复）和 MESSAGE_SWIPED（重 roll / swipe 改了同一楼层正文）共用，
   * 确保任何时候该楼层正文变了，小总结和最新图谱都会基于新正文重算。
   *
   * 关键修正：图谱合并基底用「该 AI 楼层之前的图谱」 (getKnowledgeGraphForFloor(aiFloor))，
   * 不再用 store.chatData.knowledgeGraph 当基底——后者会带着旧重 roll 产生的地点/边
   * 一起叠加，造成重 roll 后旧地点残留。
   *
   * 替换场景（旧小总结已存在，或存在 >= aiFloor 的旧图谱版本）下，即使本轮 graphDiff 为空，
   * 也会把「楼层前图谱」commit 为该楼层的新最新图谱，清掉旧重 roll 带来的残留。
   */
  function buildCharacterLocationSnapshotForSmallSummary(
    baseLocations: Record<string, string>,
    graph: KnowledgeGraph,
    record: any,
    parsedCharLocs: Array<{ name: string; location: string }> | undefined,
    userName: string,
  ): Record<string, string> {
    const locIds = new Set((graph.locations || []).map(l => l.id));
    const resolveLocId = (location?: string): string | undefined => {
      if (!location || location === '未提及') return undefined;
      const loc = (graph.locations || []).find(l => l.name === location || (l.aliases || []).includes(location));
      const locId = loc?.id || buildStableId(location);
      return locIds.has(locId) ? locId : undefined;
    };
    const charNameMap = new Map<string, string>();
    for (const ch of graph.characters || []) {
      charNameMap.set(ch.name, ch.name);
      charNameMap.set(buildStableId(ch.name), ch.name);
      for (const a of ch.aliases || []) {
        charNameMap.set(a, ch.name);
        charNameMap.set(buildStableId(a), ch.name);
      }
    }
    if (userName) {
      charNameMap.set(userName, userName);
      charNameMap.set(buildStableId(userName), userName);
    }
    const resolveCharName = (name?: string): string | undefined => {
      if (!name) return undefined;
      return charNameMap.get(name) || charNameMap.get(buildStableId(name)) || name;
    };
    const next: Record<string, string> = {};
    for (const [name, locId] of Object.entries(baseLocations || {})) {
      if (locIds.has(locId)) next[name] = locId;
    }

    const write = (name?: string, location?: string) => {
      const canonicalName = resolveCharName(name);
      const locId = resolveLocId(location);
      if (canonicalName && locId) next[canonicalName] = locId;
    };

    for (const ch of graph.characters || []) {
      write(ch.name, ch.location);
    }

    if (parsedCharLocs?.length) {
      for (const entry of parsedCharLocs) write(entry.name, entry.location);
    } else if (record?.presentCharacters?.length && record.location) {
      for (const name of record.presentCharacters) {
        write(name, record.location);
      }
    }

    return next;
  }

  function runSmallSummaryForAiMessage(
    store: ReturnType<typeof useMainStore>,
    userFloor: number,
    aiFloor: number,
    userText: string,
    aiText: string,
  ) {
    if (!store.settings.captureEnabled || !store.settings.smallSummaryEnabled) return;
    // 第0层是开场白/玩家填写信息界面，自动流程不触发小总结，避免浪费API。
    // 如需为开场白建图谱，可去「总览」手动点击「为开场白生成图谱」。
    if (aiFloor <= 0) return;
    // dedupeKey 传 aiFloor 字符串：重roll同楼层时取消队列里等待中的旧任务（旧正文），
    // 让基于新swipe正文的小总结替换它；不同楼层则各自独立 FIFO 排队，不再被丢弃。
    enqueueAnalysis('small_summary', async () => {
      if (!isCapturedContentCurrent(store, aiFloor, aiText)) {
        logWarn('小总结', `跳过过期正文任务: 楼层 ${aiFloor}`);
        return;
      }
      const characterEntries = store.getCharacterNameEntries();
      const allNames = characterEntries.map(entry => entry.name);
      const userNameNorm = store.getUserName();
      const kgAutoOn = store.settings.kgAutoEnabled !== false;
      const wpMaterial = buildWorldProgressMaterialForSmallSummary(store, userFloor);
      const baseGraphState = kgAutoOn
        ? store.getKnowledgeGraphStateForFloor(aiFloor)
        : { graph: null, characterLocations: {} };
      const kgOptions: SmallSummaryKgOptions | undefined = kgAutoOn
        ? {
            knowledgeGraph: baseGraphState.graph || null,
            vectorGraph: store.chatData.knowledgeGraph || null,
            embeddingCache: store.chatData.knowledgeGraphEmbeddingCache || null,
            embeddingEnabled: store.settings.embeddingEnabled,
            embeddingApiUrl: store.settings.embeddingApiUrl,
            embeddingApiKey: store.settings.embeddingApiKey,
            embeddingModel: store.settings.embeddingModel,
            embeddingDimensions: store.settings.kgEmbeddingDimensions > 0 ? store.settings.kgEmbeddingDimensions : store.settings.embeddingDimensions,
            embeddingManualMatryoshka: store.settings.embeddingManualMatryoshka,
            kgInjectTopK: store.settings.kgInjectTopK ?? 8,
            characterLocations: baseGraphState.characterLocations || {},
            centerCharacterNames: [store.getUserName(), ...wpMaterial.centerCharacterNames].filter(Boolean),
            centerLocationNames: wpMaterial.centerLocationNames,
            worldProgressMaterial: wpMaterial.material,
          }
        : undefined;

      // 上一轮在场角色 + 物品快照，作为本轮小总结判重上下文
      let previousContext: PreviousRoundContext | undefined;
      try {
        const prevRecords = (store.chatData.smallSummaries || []).filter(
          r => r.floorRange && r.floorRange.end < aiFloor,
        );
        const prevRecord = prevRecords.length > 0 ? prevRecords[prevRecords.length - 1] : null;
        const presentCharacters = prevRecord?.presentCharacters || [];
        const characterLocations = prevRecord?.characterLocations || [];
        const items = ((baseGraphState.graph?.items) || [])
          .filter(it => !it.consumed)
          .slice(0, 30)
          .map(it => ({
            name: it.name,
            owner: it.owner,
            location: it.location,
            status: it.status,
          }));
        if (presentCharacters.length > 0 || items.length > 0) {
          previousContext = { presentCharacters, characterLocations, items };
        }
      } catch (e) {
        logWarn('小总结', '上一轮上下文组装失败，降级不带', String(e));
      }

      let { record, graphDiff, characterLocations: parsedCharLocs } = await executeSmallSummary(
        userText, aiText, userFloor, aiFloor, allNames, store.getUserName(), kgOptions, characterEntries, previousContext,
      );
      if (!isCapturedContentCurrent(store, aiFloor, aiText)) {
        logWarn('小总结', `分析完成时来源已变化，丢弃过期结果: 楼层 ${aiFloor}`);
        return;
      }
      record.presentCharacters = store.resolveKnownCharacterNames(record.presentCharacters, true);
      if (record.interactingCharacters && record.interactingCharacters.length > 0) {
        record.interactingCharacters = store.resolveKnownCharacterNames(record.interactingCharacters, true);
      }
      if (record.characterLocations && record.characterLocations.length > 0) {
        const normNames = store.resolveKnownCharacterNames(
          record.characterLocations.map(cl => cl.name),
          true,
        );
        if (Array.isArray(normNames) && normNames.length === record.characterLocations.length) {
          record.characterLocations = record.characterLocations.map((cl, idx) => ({ ...cl, name: normNames[idx] || cl.name }));
        }
      }
      if (parsedCharLocs?.length) {
        const locSeen = new Set<string>();
        parsedCharLocs = parsedCharLocs
          .map(entry => ({
            ...entry,
            name: store.resolveKnownCharacterName(entry.name, true),
          }))
          .filter(entry => {
            const key = `${entry.name}::${entry.location}`;
            if (!entry.name || !entry.location || locSeen.has(key)) return false;
            locSeen.add(key);
            return true;
          });
      }
      if (graphDiff?.add?.characters?.length) {
        graphDiff.add.characters = graphDiff.add.characters.map((character: any) => {
          const rawName = character.name;
          const canonicalName = store.resolveKnownCharacterName(rawName, true);
          return {
            ...character,
            name: canonicalName,
            aliases: cleanCharacterAliases([...(character.aliases || []), rawName], canonicalName),
          };
        }).filter((character: any) => character.name);
      }
      if (wpMaterial.consumedWPId) {
        record.consumedWorldProgressId = wpMaterial.consumedWPId;
      }
      // 重 roll 清理：清除被覆盖的旧小总结及其孤儿后代 + 对应 WP 消费标记
      const obsoleteSmallSummaries = (store.chatData.smallSummaries || []).filter(
        (s: any) => (s.floorRange?.end ?? s.floorRange?.start ?? -1) >= aiFloor,
      );
      const isReplacingSmallSummary = obsoleteSmallSummaries.length > 0;
      for (const ss of obsoleteSmallSummaries) clearWPConsumedFlag(store, ss);
      store.chatData.smallSummaries = (store.chatData.smallSummaries || []).filter(
        (s: any) => (s.floorRange?.end ?? s.floorRange?.start ?? -1) < aiFloor,
      );
      store.chatData.smallSummaries.push(record);

      // 知识图谱：基底用「该 AI 楼层之前的图谱」，把旧重 roll/swipe 的图谱版本隔离开。
      // commitKnowledgeGraph(floor=aiFloor) 会截断 versions >= aiFloor 的旧版本，
      // 因此 nextGraph 会取代旧重 roll 产生的最新图谱，不会叠加。
      if (kgAutoOn) {
        const baseGraph = baseGraphState.graph || createEmptyKnowledgeGraph();
        const hasObsoleteKgVersions = (store.chatData.knowledgeGraphVersions || [])
          .some(v => v.floor >= aiFloor);

        // 是否需要 commit 图谱（即使 graphDiff 为空也可能要清旧重 roll 残留）：
        //   isReplacingSmallSummary —— 该楼层已有旧小总结（重 roll/swipe 替换场景）；
        //   hasObsoleteKgVersions —— 存在 >= aiFloor 的旧图谱版本（commit 过但本轮要顶掉）。
        const shouldReplaceGraph = isReplacingSmallSummary || hasObsoleteKgVersions;
        const hasCharacterLocationUpdate = (parsedCharLocs?.length || 0) > 0
          || !!(record.presentCharacters?.length && record.location && record.location !== '未提及');

        try {
          let nextGraph: KnowledgeGraph | null = null;
          if (graphDiff) {
            // 过滤 AI 输出的 characters add 中的玩家名（含前后空格变体）
            if (userNameNorm && graphDiff.add?.characters?.length) {
              graphDiff.add.characters = graphDiff.add.characters.filter(
                (c: any) => c.name && c.name.trim() !== userNameNorm,
              );
            }
            nextGraph = applyKnowledgeGraphDiff(baseGraph, graphDiff);
          } else if (shouldReplaceGraph || hasCharacterLocationUpdate) {
            // 没有 graphDiff 但属于替换/位置变化场景 → 用楼层前图谱提交一版状态
            nextGraph = JSON.parse(JSON.stringify(baseGraph));
          }

          if (nextGraph) {
            const nextCharacterLocations = buildCharacterLocationSnapshotForSmallSummary(
              baseGraphState.characterLocations,
              nextGraph,
              record,
              parsedCharLocs,
              userNameNorm,
            );
            // 离场降级并集：presentCharacters ∪ interactingCharacters；玩家名由 commitKnowledgeGraph 内部补
            const presentSet = new Set<string>();
            for (const n of (record.presentCharacters || [])) if (n) presentSet.add(n);
            for (const n of (record.interactingCharacters || [])) if (n) presentSet.add(n);
            store.commitKnowledgeGraph(nextGraph, aiFloor, nextCharacterLocations, presentSet);
            logInfo('知识图谱', `顺风车更新 v${nextGraph.version}`);
            // 异步补嵌入（不阻塞主流程）
            if (store.settings.embeddingEnabled && store.settings.embeddingApiKey && store.settings.kgEmbeddingEnabled !== false) {
              const hasNewNodes = graphDiff
                ? (graphDiff.add?.locations?.length || 0) + (graphDiff.add?.items?.length || 0) > 0
                : false;
              const needReembed = hasMissingEmbedding(store.chatData.knowledgeGraph);
              if (hasNewNodes || needReembed) {
                enqueueAnalysis('embedding_kg', async () => {
                  await embedKnowledgeGraphNodes(store.chatData.knowledgeGraph!, {
                    enabled: true,
                    apiUrl: store.settings.embeddingApiUrl,
                    apiKey: store.settings.embeddingApiKey,
                    model: store.settings.embeddingModel,
                    dimensions: store.settings.kgEmbeddingDimensions > 0 ? store.settings.kgEmbeddingDimensions : store.settings.embeddingDimensions,
                    manualMatryoshka: store.settings.embeddingManualMatryoshka,
                    similarityThreshold: store.settings.embeddingSimilarityThreshold,
                  }, undefined, store.chatData.knowledgeGraphEmbeddingCache);
                  store.forcePersist({ settings: false });
                });
              }
            }
          }
        } catch (e) {
          logWarn('知识图谱', '增量合并失败', String(e));
        }
      }

      // 更新在场角色当前位置
      if (!kgAutoOn) {
        if (parsedCharLocs?.length) {
          store.batchUpdateCharacterLocations(parsedCharLocs);
        } else if (record.presentCharacters?.length && record.location && record.location !== '未提及') {
          store.updateCharacterLocations(record.presentCharacters, record.location);
        }
      }
      store.forcePersist({ settings: false });
    }, String(aiFloor));
  }

  function invalidateHotMemoryProjections(
    store: ReturnType<typeof useMainStore>,
    floor: number,
  ): { summaries: number; artifacts: ReturnType<typeof truncateMainResponseArtifactsFromFloor> } {
    clearSchedulerQueue();
    const summaries = store.invalidateSummaryProjectionsFromFloor(floor);
    const artifacts = truncateMainResponseArtifactsFromFloor(store, floor);
    store.touchChatContent();
    return { summaries, artifacts };
  }

  async function auditCommittedMemorySources(store: ReturnType<typeof useMainStore>): Promise<void> {
    const chatId = store.chatData.chatId || getCurrentChatIdSafe();
    if (!chatId) return;
    try {
      const result = await reconcileMemoryWarehouseSourceChange({
        chatId,
        floor: 0,
        reason: 'source_changed',
        currentSourceContents: rawChatReader.readAllSourceContents(),
      });
      if (!result.sourceChanged) return;
      const hot = invalidateHotMemoryProjections(store, 0);
      logWarn(
        '记忆来源',
        `启动核对发现过期来源，已作废 ${result.invalidatedBundleCount} 个 Bundle`,
        `hot=${JSON.stringify(hot)}`,
      );
    } catch (error) {
      unresolvedSourceChangeFloor = 0;
      logError('记忆来源', '启动来源核对失败，已暂停记忆注入', String(error));
    }
  }

  function enqueueSourceChangeReconcile(
    store: ReturnType<typeof useMainStore>,
    eventFloor: number,
    reason: Parameters<typeof reconcileMemoryWarehouseSourceChange>[0]['reason'],
    force = false,
    retryCount = 0,
  ): Promise<void> {
    const requestedFloor = Math.max(0, Math.floor(Number(eventFloor) || 0));
    const task = sourceChangeQueue.catch(() => undefined).then(async () => {
      const currentSources = rawChatReader.readSourceContentsInRange(
        requestedFloor,
        rawChatReader.getLastMessageId(),
      );
      const diff = sourceChangeTracker.diffAndReset(currentSources, requestedFloor);
      if (!force && !diff.changed) return;
      const floor = Math.max(0, Math.min(requestedFloor, diff.earliestChangedFloor ?? requestedFloor));
      unresolvedSourceChangeFloor = unresolvedSourceChangeFloor === null
        ? floor
        : Math.min(unresolvedSourceChangeFloor, floor);
      const chatId = store.chatData.chatId || getCurrentChatIdSafe();
      if (!chatId) return;
      try {
        const result = await reconcileMemoryWarehouseSourceChange({
          chatId,
          floor,
          reason,
          currentSourceContents: currentSources,
          cancelStaged: diff.changed || force,
        });
        const hot = invalidateHotMemoryProjections(store, floor);
        unresolvedSourceChangeFloor = null;
        logInfo(
          '记忆来源',
          `来源变化已处理: floor=${floor}, Bundle=${result.invalidatedBundleCount}, staged=${result.invalidatedStagedBundleCount}`,
          `changed=${diff.changedMessageIds.join(',') || 'forced'}; hot=${JSON.stringify(hot)}`,
        );
      } catch (error) {
        invalidateHotMemoryProjections(store, floor);
        sourceChangeTracker.reset([]);
        logError('记忆来源', `楼层 ${floor} 作废失败，已暂停记忆注入`, String(error));
        try {
          window.toastr?.error(
            `楼层 ${floor} 的旧记忆作废失败，智脑已暂停记忆注入以避免召回过期内容。请检查世界书保存状态。`,
            '记忆来源事务失败',
            { timeOut: 8000, extendedTimeOut: 4000 },
          );
        } catch { /* ignore */ }
        if (retryCount < 2) {
          setTimeout(() => {
            void enqueueSourceChangeReconcile(store, floor, reason, true, retryCount + 1);
          }, 1500 * (retryCount + 1));
        }
        throw error;
      }
    });
    sourceChangeQueue = task.catch(() => undefined);
    return task;
  }

  // 监听AI回复完成 → 捕获正文 + 记录用户输入 + 检查是否触发大总结 + 后台推演
  eventOn(tavern_events.MESSAGE_RECEIVED, (messageId, type) => {
    try {
      const store = useMainStore(pinia);
      if (!store.settings.captureEnabled) {
        return;
      }

      // 只跳过明确不需要捕获的类型
      if (type === 'quiet' || type === 'command' || type === 'extension') {
        return;
      }

      const extractedContent = readAssistantExtractedContentAtFloor(messageId);
      if (extractedContent === null) {
        return;
      }

      if (!isValidMainContent(extractedContent)) {
        blockInvalidMainContent(store, messageId, extractedContent, 'received');
        return;
      }
      const currentContent = readAssistantContentAtFloor(messageId, store.chatData.capturedContents);
      const content = currentContent?.content || extractedContent;
      if (content) {
        store.touchChatContent();

        // 记录用户输入
        const userInput = readLatestUserInputBefore(messageId);
        if (userInput) {
          store.recordUserInput(userInput.messageId, userInput.content, content);
        }

        // 检查是否应该触发大总结（通过调度器入队，角色记忆与大总结绑定）
        checkAndTriggerSummary(store);

        // 小总结：打开即每轮触发（记录场景地点+在场角色+图谱增量）
        {
          const userFloor = userInput?.messageId ?? messageId - 1;
          const aiFloor = messageId;
          const userText = userInput?.content ?? '';
          runSmallSummaryForAiMessage(store, userFloor, aiFloor, userText, content);
        }

        // 世界推进：每 N 轮对话（每个AI回复为一轮，开场白第0层单独算一轮）只标记 pending，等玩家下一次发送消息时触发
        if (store.settings.worldProgressEnabled) {
          // 先截断：回退/重roll场景自动作废 >= 当前楼层 的过期记录
          const trimmed = store.truncateWorldProgressRecords(messageId);
          if (trimmed > 0) {
            logInfo('世界推进', `楼层回退截断 ${trimmed} 条过期记录`);
          }
          const lastWPFloor = store.chatData.lastWorldProgressFloor;
          const roundsSinceLastWP = readAssistantContentsInRange(
            Math.max(0, lastWPFloor + 1),
            messageId,
            store.chatData.capturedContents,
          ).length;
          if (shouldTriggerWorldProgress(roundsSinceLastWP, store.settings.worldProgressInterval)) {
            store.chatData.pendingWorldProgress = true;
            store.chatData.pendingWorldProgressFloor = messageId;
            store.forcePersist({ settings: false });
            logInfo('世界推进', `已标记待推演: 截止楼层 ${messageId}`);
          }
        }

        // 梦呓：独立间隔触发（dreamtalkInterval > 0 时，不依赖大总结）
        if (store.settings.dreamtalkEnabled && store.settings.dreamtalkInterval > 0) {
          const lastDTFloor = store.chatData.lastDreamtalkFloor;
          const roundsSinceLastDT = readAssistantContentsInRange(
            Math.max(0, lastDTFloor + 1),
            messageId,
            store.chatData.capturedContents,
          ).length;
          if (roundsSinceLastDT >= store.settings.dreamtalkInterval) {
            store.chatData.lastDreamtalkFloor = messageId;
            enqueueAnalysis('dreamtalk_chain', async () => {
              if (!isCapturedContentCurrent(store, messageId, content)) {
                logWarn('梦呓', `跳过过期正文任务: 楼层 ${messageId}`);
                return;
              }
              await triggerDreamtalkAnalysis(store);
            });
          }
        }

        // 剧情校对：剧情导演开启且有活跃大纲时
        if (store.settings.plotDirectorEnabled && store.chatData.plotOutline?.status === 'active') {
          const lastCheckFloor = store.chatData.lastPlotCheckFloor;
          const roundsSinceLastPC = readAssistantContentsInRange(
            Math.max(0, lastCheckFloor + 1),
            messageId,
            store.chatData.capturedContents,
          ).length;
          if (shouldTriggerPlotCheck(roundsSinceLastPC, store.settings.plotCheckInterval)) {
            enqueueAnalysis('plot_check', async () => {
              if (!isCapturedContentCurrent(store, messageId, content)) {
                logWarn('剧情导演', `跳过过期正文任务: 楼层 ${messageId}`);
                return;
              }
              await triggerPlotCheck(store, messageId);
            });
          }
        }

        // 动态人设V2：达到间隔后标记 pending，等下次用户输入再触发（防重roll）
        if (store.settings.dynamicProfileEnabled && store.settings.dynamicProfileInterval > 0) {
          const newCount = readAssistantContentsInRange(
            store.chatData.lastDynamicProfileFloor + 1,
            messageId,
            store.chatData.capturedContents,
          ).length;
          if (newCount >= store.settings.dynamicProfileInterval) {
            store.chatData.pendingDynamicProfile = true;
          }
        }
      }
    } catch (err) {
    } finally {
      setTimeout(() => {
        const floor = Math.max(0, Math.floor(Number(messageId) || 0) - 1);
        sourceChangeTracker.updateFromFloor(
          rawChatReader.readSourceContentsInRange(floor, rawChatReader.getLastMessageId()),
          floor,
        );
      }, 0);
    }
  });

  // ========== 动态人设V2：用户发消息时检查pending并触发分析 ==========

  eventOn(tavern_events.MESSAGE_SENT, () => {
    const store = useMainStore(pinia);
    setTimeout(() => {
      const floor = Math.max(0, rawChatReader.getLastMessageId());
      sourceChangeTracker.updateFromFloor(
        rawChatReader.readSourceContentsInRange(floor, rawChatReader.getLastMessageId()),
        floor,
      );
    }, 0);
    const lastId = (() => {
      try { return getLastMessageId(); } catch { return -1; }
    })();

    if (store.settings.dynamicProfileEnabled && store.chatData.pendingDynamicProfile) {
      store.chatData.pendingDynamicProfile = false;
      const latestRounds = lastId >= 0
        ? readAssistantContentsInRange(
            store.chatData.lastDynamicProfileFloor + 1,
            lastId,
            store.chatData.capturedContents,
          )
        : [];

      if (latestRounds.length > 0) {
        enqueueAnalysis('dynamic_profile_v2', async () => {
          try {
            const characterEntries = store.getCharacterNameEntries();
            const result = await executeDynamicProfileV2(
              latestRounds,
              store.chatData.dynamicProfilesV2,
              store.getUserName(),
              undefined,
              characterEntries,
            );
            store.chatData.dynamicProfilesV2 = result.profiles;
            store.chatData.lastDynamicProfileFloor = Math.max(...latestRounds.map(c => c.messageId), store.chatData.lastDynamicProfileFloor);
            store.forcePersist({ settings: false });
            logInfo('动态人设', `更新完成: ${result.profiles.length} 角色, 截止楼层${store.chatData.lastDynamicProfileFloor}`);
          } catch (e) {
            logError('动态人设', '分析失败', String(e));
          }
        });
      }
    }

    if (store.settings.worldProgressEnabled && store.chatData.pendingWorldProgress) {
      const pendingFloor = store.chatData.pendingWorldProgressFloor ?? -1;
      store.chatData.pendingWorldProgress = false;
      store.chatData.pendingWorldProgressFloor = -1;

      const latestRounds = lastId >= 0
        ? readAssistantContentsInRange(
            Math.max(0, store.chatData.lastWorldProgressFloor + 1),
            lastId,
            store.chatData.capturedContents,
          )
        : [];
      const target = latestRounds
        .filter(c => pendingFloor < 0 || c.messageId <= pendingFloor)
        .slice(-1)[0]
        || latestRounds.slice(-1)[0];

      store.forcePersist({ settings: false });
      if (target) {
        enqueueAnalysis('world_progress', async () => {
          if (!isCapturedContentCurrent(store, target.messageId, target.content)) {
            logWarn('世界推进', `跳过过期正文任务: 楼层 ${target.messageId}`);
            return;
          }
          await triggerWorldProgress(store, target.messageId, latestRounds);
        });
      } else {
      }
    } else {
    }
  });

  // 监听消息被swipe（重 roll / 切到另一个 swipe 版本）→ 更新正文记录 + 重跑小总结 + 替换最新图谱
  // swipe 和重 roll 都会改变同一 AI 楼层正文，后处理流程必须和 MESSAGE_RECEIVED 一致，
  // 否则旧 swipe/swipe 带入的地点/角色边会残留在最新图谱里。
  eventOn(tavern_events.MESSAGE_SWIPED, messageId => {
    const store = useMainStore(pinia);
    if (!store.settings.captureEnabled) return;

    setTimeout(async () => {
      try {
        await enqueueSourceChangeReconcile(store, messageId, 'swipe');
      } catch {
        // 已进入 fail-closed；仍允许当前合法正文重建热场景数据。
      }
      const extractedContent = readAssistantExtractedContentAtFloor(messageId);
      if (extractedContent === null) return;

      if (!isValidMainContent(extractedContent)) {
        blockInvalidMainContent(store, messageId, extractedContent, 'swiped');
        return;
      }
      const currentContent = readAssistantContentAtFloor(messageId, store.chatData.capturedContents);
      const content = currentContent?.content || extractedContent;
      if (content) {
        store.touchChatContent();

        const dreamtalkPair = readDreamtalkPair(messageId, true);
        const userInput = dreamtalkPair
          ? { messageId: dreamtalkPair.userFloor, content: dreamtalkPair.userInput }
          : readLatestUserInputBefore(messageId);
        let userText = userInput?.content ?? '';
        if (userInput) {
          store.recordUserInput(
            userInput.messageId,
            userText,
            content,
            dreamtalkPair?.rolledResponses ?? [],
          );
        }

        // 重跑小总结 + 替换该楼层后的最新图谱（流程与 MESSAGE_RECEIVED 一致）
        runSmallSummaryForAiMessage(store, userInput?.messageId ?? messageId - 1, messageId, userText, content);
      }
    }, 500);
  });

  const handleEditedOrUpdatedMessage = (
    messageId: number,
    reason: 'source_changed' | 'message_deleted',
    rerunCurrentScene: boolean,
  ) => {
    const floor = Math.max(0, Math.floor(Number(messageId) || 0));
    setTimeout(async () => {
      const store = useMainStore(pinia);
      try {
        await enqueueSourceChangeReconcile(store, floor, reason);
      } catch {
        return;
      }
      if (!rerunCurrentScene) return;
      const assistant = rawChatReader.readRange(floor, rawChatReader.getLastMessageId(), 'assistant')
        .find(message => !message.ignored && isValidMainContent(message.content));
      if (!assistant) return;
      const user = rawChatReader.readLatestUserBefore(assistant.messageId);
      runSmallSummaryForAiMessage(
        store,
        user?.messageId ?? assistant.messageId - 1,
        assistant.messageId,
        user?.rawContent ?? '',
        assistant.content,
      );
    }, 250);
  };

  eventOn(tavern_events.MESSAGE_EDITED, messageId => {
    handleEditedOrUpdatedMessage(messageId, 'source_changed', true);
  });
  eventOn(tavern_events.MESSAGE_UPDATED, messageId => {
    handleEditedOrUpdatedMessage(messageId, 'source_changed', false);
  });
  eventOn(tavern_events.MESSAGE_DELETED, messageId => {
    handleEditedOrUpdatedMessage(messageId, 'message_deleted', false);
  });


  // ========== 提示词注入系统 ==========

  eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY, async completion => {
    const store = useMainStore(pinia);

    if (unresolvedSourceChangeFloor !== null) {
      removeDynamicProfileV2Injection();
      removeWorldGraphInjection();
      removeWorldProgressInjection();
      removeNeuralChainInjection();
      removeNsfwInjection();
      removeRelationshipInjection();
      removeWorldBookTagIndexInjection();
      removePlotInjection();
      logWarn('记忆来源', `楼层 ${unresolvedSourceChangeFloor} 的来源事务未完成，本次跳过智脑注入`);
      return;
    }

    // ═══ 后台分析守护 ═══
    // callGenerateRaw 在原生 API 模式下会在 prompt 头部注入 <!--ZHINO_BG--> 标记。
    // 遍历 completion 所有可搜索字段，只要标记出现在任何地方就跳过注入。
    let bgMarkerFound = false;
    for (const key of Object.keys(completion)) {
      try {
        const val = (completion as any)[key];
        if (typeof val === 'string' && val.includes('<!--ZHINO_BG-->')) {
          bgMarkerFound = true; break;
        }
        // 数组：如 messages, ordered_prompts
        if (Array.isArray(val)) {
          const arrStr = JSON.stringify(val);
          if (arrStr.includes('<!--ZHINO_BG-->')) { bgMarkerFound = true; break; }
        }
        // 嵌套对象可能有 content
        if (val && typeof val === 'object' && typeof (val as any).content === 'string') {
          if ((val as any).content.includes('<!--ZHINO_BG-->')) { bgMarkerFound = true; break; }
        }
	      } catch (_) { /* ignore */ }
	    }
	    // 兜底：JSON 序列化整个 completion
    if (!bgMarkerFound) {
      try {
        const full = JSON.stringify(completion);
        bgMarkerFound = full.includes('<!--ZHINO_BG-->');
	      } catch (_) { /* ignore */ }
    }

    if (bgMarkerFound) {
      return;
    }
    // 兼容旧逻辑：_isBackgroundCall 标记也检查（自定义 API 路径仍使用此标记）
    if (store._isBackgroundCall) {
      return;
    }

    // quiet/raw 调用守卫：CC_SR 的 payload 自带 type 字段（openai.js:2743 generate_data.type）。
    // 只有 normal/continue（真实聊天 / 用户主动续写）才注入智脑内容；
    // quiet/command/extension/impersonate 及无 type 的调用一律跳过，
    // 避免污染"解析变量"等仅用主 API 做轻量解析的后台调用。
    // 直接读 payload.type，时序无关、无残留风险（比监听 GENERATION_STARTED 预标记可靠）。
    if (store.quietInjectionGuard) {
      const completionType = ((completion as any)?.type || '').toString().toLowerCase();
      const REAL_CHAT_TYPES = new Set(['normal', 'continue']);
      if (!REAL_CHAT_TYPES.has(completionType)) {
        return;
      }
    }

    // ═══ MVU 额外模型解析守护 ═══
    // MVU 变量框架的"额外模型解析变量"功能用主 API 解析变量，
    // 虽然走 type='normal'（与正常聊天相同），但只是变量解析、不是聊天，
    // 不应注入智脑内容。靠 MVU 官方标志 Mvu.isDuringExtraAnalysis() 判别。
    // 没装 MVU 时 typeof Mvu === 'undefined'，本守卫无副作用。
    //
    // 注意：此处 return 只能拦住"直接改 messages"类注入（大总结/人格/图谱/世界推进
    // 入口/梦呓，这些本轮不执行就不会塞进去）+ "本轮重新注入"逻辑。
    // 但拦不住已注册的持久句柄（injectPrompts 的 in_chat 注入）——那些在
    // createGenerationParameters 里已被 getExtensionPrompt 塞进 generate_data.messages，
    // 等 CHAT_COMPLETION_SETTINGS_READY 触发时消息已组装完。
    // 因此 MVU 轮还要额外调用 stripZhinoInjectionsFromCompletion 清洗 messages。
    if (isMvuExtraAnalysis()) {
      // 清洗 generate_data.messages 里已注入的智脑标签块，
      // fetch 在 emit 之后才发（openai.js:3055 JSON.stringify(generate_data)），
      // 改 messages.content 能生效。
      stripZhinoInjectionsFromCompletion(completion);
      return;
    }

    // 标记为真实聊天消息（首次发送 / 重roll / swipe 都算）。
    // 不能放在 MESSAGE_SENT 中：MESSAGE_SENT 只在用户发送新消息时触发，
    // 重roll/swipe 不会触发 MESSAGE_SENT 但会触发本事件，放在这里才能覆盖。
    store._isRealChatMessage = true;

    const latestSummary = store.getLatestSummary();
    const activatedEventNames = new Set<string>();
    const currentLastMessageId = (() => {
      try { return getLastMessageId(); } catch { return -1; }
    })();
    const currentGeneratingFloor = currentLastMessageId >= 0 ? currentLastMessageId + 1 : 0;
    const latestAssistantRecord = readLatestAssistantContent(store.chatData.capturedContents);
    const latestScanText = latestAssistantRecord?.content || '';
    const latestUserInputRecord = readLatestUserInputBefore(currentGeneratingFloor);
    const latestUserInputText = latestUserInputRecord?.content
      || store.userInputRecords[store.userInputRecords.length - 1]?.userInput
      || '';

    // ─── 统一查询向量（事件召回 + 记忆召回共用） ───
    let sharedQueryEmb: number[] | null = null;
    let sharedQueryText: string = '';
    const useSemantic = store.settings.embeddingEnabled && store.settings.embeddingApiKey;
    if (useSemantic) {
      sharedQueryText = (latestUserInputText + '\n' + latestScanText).slice(0, 2000);
      try {
        sharedQueryEmb = await getEmbedding(sharedQueryText, {
          enabled: true,
          apiUrl: store.settings.embeddingApiUrl,
          apiKey: store.settings.embeddingApiKey,
          model: store.settings.embeddingModel,
          dimensions: store.settings.embeddingDimensions,
          similarityThreshold: 0,
        });
      } catch (e) {
      }
    }

    // --- 神经链记忆激活（提前执行，召回结果供后续大总结注入使用） ---
    if (store.settings.memoryActivationEnabled) {
      const latestMemory = buildMemoryActivationList(store);
      if (latestMemory.length > 0) {
        const scanText = [latestUserInputText, latestScanText].filter(Boolean).join('\n');
        const characterEntries = store.getCharacterNameEntries();
        const allNames = [...new Set([
          ...characterEntries.map(entry => entry.name),
          ...latestMemory.map(m => m.characterName).filter(Boolean),
        ])];
        const userName = store.getUserName();

        type NeuralRecallItem = { text: string; isCore: boolean; time?: string; source?: string; id?: string; floor?: number };
        const currentChars = scanCharacterNamesFromContent(scanText, allNames, characterEntries);
        let preReranked: Map<string, NeuralRecallItem[]> | undefined;
        let warehouseRecallAttempted = false;

        // 新记忆仓只负责提供候选记忆；神经链标签、说明文字和插入位置保持原样。
        if (currentChars.length > 0) {
          warehouseRecallAttempted = true;
          try {
            const recalledByCharacter = await Promise.all(currentChars.map(async characterName => {
              const characterMemory = latestMemory.find(memory => memory.characterName === characterName);
              const recallLimit = Number((characterMemory as any)?.recallLimit ?? store.settings.memoryRecallLimit ?? 10);
              const result = await recallCharacterMemoriesFromWarehouse(
                {
                  chatId: store.chatData.chatId || getCurrentChatIdSafe(),
                  settings: {
                    embeddingApiUrl: store.settings.embeddingApiUrl,
                    embeddingModel: store.settings.embeddingModel,
                    embeddingDimensions: store.settings.embeddingDimensions,
                  },
                },
                {
                  characterName,
                  queryText: sharedQueryText || scanText,
                  queryVector: sharedQueryEmb ?? undefined,
                  recentBundleCount: store.settings.recentMemoryVersions ?? 1,
                  recallLimit,
                  candidateMultiplier: store.settings.rerankEnabled
                    ? (store.settings.rerankCandidateMultiplier ?? 3)
                    : 1,
                  hybridWeight: 0.7,
                  minScore: 0,
                },
              );
              const recent: NeuralRecallItem[] = result.recent.map(record => ({
                text: record.text,
                isCore: record.memoryType === 'core',
                time: record.storyTime,
                source: 'memory_warehouse_recent',
                id: record.id,
                floor: record.floorEnd,
              }));
              const recalled: NeuralRecallItem[] = result.recalled
                .filter(item => item.record.kind === 'character_memory')
                .map(item => ({
                  text: item.record.kind === 'character_memory' ? item.record.text : '',
                  isCore: item.record.kind === 'character_memory' && item.record.memoryType === 'core',
                  time: item.record.storyTime,
                  source: 'memory_warehouse_recall',
                  id: item.record.id,
                  floor: item.record.floorEnd,
                }))
                .filter(item => item.text);
              return { characterName, recallLimit, recent, recalled };
            }));

            const warehouseMap = new Map<string, NeuralRecallItem[]>();
            for (const result of recalledByCharacter) {
              const seen = new Set<string>();
              const combined = [...result.recalled, ...result.recent].filter(item => {
                const text = item.text.trim();
                if (!text || seen.has(text)) return false;
                seen.add(text);
                return true;
              });
              if (combined.length > 0) warehouseMap.set(result.characterName, combined);
            }

            if (warehouseMap.size > 0 && store.settings.rerankEnabled && sharedQueryText) {
              try {
                const candidates = recalledByCharacter.flatMap(result =>
                  result.recalled.map((item, index) => ({
                    characterName: result.characterName,
                    recallLimit: result.recallLimit,
                    index,
                    item,
                    document: `${result.characterName}: ${item.text}`,
                  })),
                );
                if (candidates.length > 0) {
                  const reranked = await rerankCandidates(
                    sharedQueryText,
                    candidates.map(candidate => candidate.document),
                    candidates.length,
                    store.settings.embeddingApiUrl,
                    store.settings.embeddingApiKey,
                    store.settings.rerankModel,
                  );
                  const scoreByDocument = new Map(reranked.map(result => [result.text, result.score]));
                  for (const result of recalledByCharacter) {
                    const ranked = candidates
                      .filter(candidate => candidate.characterName === result.characterName)
                      .sort((left, right) => (
                        (scoreByDocument.get(right.document) ?? -1) - (scoreByDocument.get(left.document) ?? -1)
                        || left.index - right.index
                      ))
                      .slice(0, result.recallLimit)
                      .map(candidate => candidate.item);
                    const seen = new Set<string>();
                    const combined = [...ranked, ...result.recent].filter(item => {
                      const text = item.text.trim();
                      if (!text || seen.has(text)) return false;
                      seen.add(text);
                      return true;
                    });
                    if (combined.length > 0) warehouseMap.set(result.characterName, combined);
                  }
                }
              } catch (e) {
                logWarn('记忆仓召回', '仓库候选重排失败，保留混合粗排结果', String(e));
              }
            }
            if (warehouseMap.size > 0) {
              preReranked = warehouseMap;
              logInfo('记忆仓召回', `角色记忆命中 ${warehouseMap.size}/${currentChars.length} 个角色`);
            }
          } catch (e) {
            logWarn('记忆仓召回', '读取失败，本轮跳过角色记忆注入', String(e));
          }
        }

        // 正式链只从记忆仓读取角色历史；mainStore 仅保留当前热投影，不再承担旧历史召回。
        const neuralMemoryStore = warehouseRecallAttempted
          ? {
              getFusedMemories: (characterName: string) => preReranked?.get(characterName) ?? [],
              getActiveWorldProgressMemories: (characterName: string) => store.getActiveWorldProgressMemories(characterName),
            }
          : store;
        injectNeuralChain(neuralMemoryStore, latestMemory, scanText, allNames, characterEntries, userName, sharedQueryEmb ?? undefined, sharedQueryText || undefined, preReranked);

        // B4: 事件回忆注入 — 仓库近期全取 + 远期混合召回；手工覆盖最后应用
        const eventRecallChatId = SillyTavern.getCurrentChatId()?.trim() ?? '';
        if (eventRecallChatId) {
          try {
            const eventRecall = await recallTimelineEventsFromWarehouse(
              {
                chatId: eventRecallChatId,
                settings: {
                  embeddingApiUrl: store.settings.embeddingApiUrl,
                  embeddingModel: store.settings.embeddingModel,
                  embeddingDimensions: store.settings.embeddingDimensions,
                },
              },
              {
                queryText: sharedQueryText || `${latestUserInputText}\n${scanText}`,
                queryVector: sharedQueryEmb ?? undefined,
                recentBundleCount: store.settings.eventRecallRecent || 2,
                recallLimit: store.settings.eventRecallLimit || 8,
                hybridWeight: 0.7,
                minScore: sharedQueryEmb
                  ? Math.max(0.1, (store.settings.embeddingSimilarityThreshold || 0) * 0.7)
                  : 0.1,
              },
            );
            const overrides = store.timelineOverrides || {};
            const seenStorageKeys = new Set<string>();
            const applyOverride = (record: any): TimelineEvent | null => {
              const base: TimelineEvent = {
                time: record.storyTime || '',
                event: record.overview || '',
                detail: record.detail,
                summaryVersion: record.summaryVersion,
                importance: Number(record.payload?.importance ?? 3),
                triggers: record.payload?.triggers || undefined,
              };
              const storageKey = store.getTimelineEventKey(base);
              seenStorageKeys.add(storageKey);
              const override = overrides[storageKey];
              if (override?._deleted) return null;
              return override ? { ...base, ...override } : base;
            };
            const recalledEvents = [
              ...eventRecall.recent.map(record => applyOverride(record)),
              ...eventRecall.recalled.map(item => applyOverride(item.record)),
            ].filter((event): event is TimelineEvent => !!event?.event?.trim());
            const activated = new Set<string>();
            for (const event of recalledEvents) activated.add(event.event);

            // 用户新增事件没有仓库原始记录；保持旧语义：近期无条件，远期按触发词命中。
            const currentVersion = store.getLatestSummary()?.version || 0;
            const recentThreshold = currentVersion - (store.settings.eventRecallRecent || 2) + 1;
            const scanTextFull = `${latestUserInputText}\n${scanText}`.toLowerCase();
            for (const [storageKey, override] of Object.entries(overrides) as Array<[string, TimelineEvent & { _deleted?: boolean }]>) {
              if (seenStorageKeys.has(storageKey) || override._deleted || !override.event?.trim()) continue;
              const isRecent = (override.summaryVersion || 0) >= recentThreshold;
              const characters = override.triggers?.characters || [];
              const keywords = override.triggers?.keywords || [];
              const characterHit = characters.some(name => scanTextFull.includes(name.toLowerCase()));
              const keywordHits = keywords.filter(keyword => fuzzyMatchKeyword(keyword, scanTextFull)).length;
              if (isRecent || (characterHit && keywordHits >= 1) || (!characterHit && keywordHits >= 2)) {
                activated.add(override.event);
              }
            }
            for (const eventName of activated) activatedEventNames.add(eventName);
            if (recalledEvents.length > 0 || activated.size > 0) {
              logInfo(
                '记忆仓召回',
                `事件命中 近期${eventRecall.recent.length} + 远期${eventRecall.recalled.length}，手工覆盖已应用`,
              );
            }
          } catch (error) {
            logWarn('记忆仓召回', '事件读取失败，本轮跳过时间线记忆注入', String(error));
          }
        }
      }
    }

    // --- 大总结注入（每次生成请求时动态获取最新总结内容） ---
    if (store.settings.summaryInjectionEnabled && latestSummary && latestSummary.rawText) {
      injectSummaryIntoCompletion(completion.messages, latestSummary, activatedEventNames, store);
    }

    // --- 摘要替代层：已废弃（小总结不再注入正文） ---

    // --- 用户人设注入 ---
    if (store.settings.personaEnabled && store.persona.analyzedProfile) {
      injectPersonaIntoCompletion(
        completion.messages,
        store.persona.analyzedProfile,
        store.persona.rawInput,
        store.getUserName(),
      );
    }

    // --- 知识图谱注入 <world_graph>（塞在 </chathistory> 之后，与角色记忆/神经链同区）---
    // 直接写入本轮 completion.messages：把 <world_graph> 块插到含 <chathistory> 消息的
    // </chathistory> 之后，与角色记忆（神经链 depth 0）同处聊天记录之后的区域。
    // 不走 injectPrompts —— 否则句柄更新会落到下一轮，表现为图谱慢一版。
    if (store.settings.kgAutoEnabled !== false) {
      try {
        // 旧版图谱注入曾使用 injectPrompts；这里先清掉旧句柄，正文图谱改为直接写入本轮 completion.messages。
        removeWorldGraphInjection();
        const currentGeneratingFloorKG = currentGeneratingFloor;
        const kgStateForInjection = store.getKnowledgeGraphStateForFloor(currentGeneratingFloorKG);
        const versionGraphForInjection = kgStateForInjection.graph;
        const mainGraphForInjection = store.chatData.knowledgeGraph || null;
        const mainGraphFloor = mainGraphForInjection?.version ?? -1;
        const versionGraphFloor = versionGraphForInjection?.version ?? -1;
        // 版本快照用于防止读到未来楼层；但手动编辑或同楼层补写时，主图可能已经是同一版本的新内容。
        // 只要主图版本仍早于当前生成楼层，就优先使用不早于快照的主图，避免正文注入慢一版。
        const useMainGraphForInjection = !!(mainGraphForInjection
          && mainGraphFloor > 0
          && mainGraphFloor < currentGeneratingFloorKG
          && mainGraphFloor >= versionGraphFloor);
        const kgForInjection = useMainGraphForInjection ? mainGraphForInjection : versionGraphForInjection;
        const characterLocationsForInjection = useMainGraphForInjection
          ? store.chatData.characterLocations
          : kgStateForInjection.characterLocations;
        if (kgForInjection && kgForInjection.locations.length + kgForInjection.items.length > 0) {
          const presentNames = (store.chatData.smallSummaries.slice(-1)[0]?.presentCharacters) || [];
          // 阶段 B 需要纯用户输入做地点命中，从 userInputRecords 取（sharedQueryText 已混 AI 正文）
          const userTextKG = latestUserInputText;
          const kgText = buildWorldGraphInjection({
            graph: kgForInjection,
            mainGraph: mainGraphForInjection,
            embeddingCache: store.chatData.knowledgeGraphEmbeddingCache || null,
            graphVersions: (store.chatData.knowledgeGraphVersions || [])
              .filter(v => v.floor < currentGeneratingFloorKG)
              .map(v => ({ floor: v.floor, graph: v.graph })),
            userName: store.getUserName(),
            presentCharacters: presentNames,
            characterLocations: characterLocationsForInjection,
            userText: userTextKG,
            queryText: sharedQueryText || userTextKG,
            queryEmb: sharedQueryEmb,
            topK: store.settings.kgInjectTopK || 8,
            perCharacterItemLimit: store.settings.kgPerCharacterItemLimit || 0,
          });
          if (injectWorldGraphIntoCompletion(completion.messages, kgText)) {
            logInfo(
              '图谱注入',
              `已写入本轮上下文 source=${useMainGraphForInjection ? 'main' : 'version'} graph=${kgForInjection.version} target=${currentGeneratingFloorKG}`,
            );
          }
        }
      } catch (err) {
        logWarn('图谱注入', '注入跳过', String(err));
      }
    } else {
      removeWorldGraphInjection();
    }

    // --- 世界推进：无入场信息的场外动态注入 D0（在动态人设前） ---
    if (store.settings.worldProgressInjectionEnabled && store.chatData.worldProgressRecords.length > 0) {
      injectWorldProgress(store.chatData.worldProgressRecords, currentGeneratingFloor, store.settings.worldProgressInterval);
    }

    // --- 动态人设注入（V2优先，旧版兜底） ---
    if (store.settings.dynamicProfileInjectionEnabled) {
      const scanText = latestScanText;
      const dpEntries = store.getCharacterNameEntries();
      const allNamesDP = dpEntries.map(entry => entry.name);
      const uniqueNamesDP = Array.from(new Set(allNamesDP));

      if (store.chatData.dynamicProfilesV2.length > 0) {
        // V2 版本注入
        injectDynamicProfileV2(store.chatData.dynamicProfilesV2, scanText, uniqueNamesDP, dpEntries);
      }
      // V1 动态人设已移除，V2 即为唯一路径
    }


    // --- 世界书标签索引注入（用户手动绑定的 <tag> 含义表） ---
    if (store.chatData.worldBookTagBindings?.length > 0) {
      injectWorldBookTagIndex(store.chatData.worldBookTagBindings);
    }

	    // --- 剧情导演引导注入 ---
    if (store.settings.plotGuidanceInjectionEnabled && store.chatData.plotOutline?.status === 'active') {
      injectPlotGuidance(store.chatData.plotOutline, store.chatData.lastPlotCheckResult);
    }

    // --- 关系档案注入（手动分析后的稳定关系设定） ---
    if (store.settings.relationshipInjectionEnabled && store.relationshipProfiles.length > 0) {
      const relScanText = latestScanText;
      const relEntries = store.getCharacterNameEntries();
      const relAllNames = relEntries.map(entry => entry.name);
      const relChars = scanCharacterNamesFromContent(relScanText, relAllNames, relEntries);
      if (relChars.length > 0) {
        injectRelationshipProfiles(store.relationshipProfiles, relChars, store.getUserName());
      }
    }

    // --- 世界推进：有入场信息的角色贴近正文入口，插在梦呓上方 ---
    if (store.settings.worldProgressInjectionEnabled && store.chatData.worldProgressRecords.length > 0) {
      const entryText = buildWorldProgressEntryInjection(
        store.chatData.worldProgressRecords,
        currentGeneratingFloor,
        store.settings.worldProgressInterval,
        store.settings.entryHintCooldownRounds,
        store.chatData.worldProgressAttempts ?? -1,
      );
      if (entryText) {
        injectWorldProgressEntryIntoUserMessage(completion.messages, entryText);
      }
    }

    // --- 梦呓注入 ---
    if (store.settings.dreamtalkInjectionEnabled && store.dreamtalk) {
      injectDreamtalkIntoUserMessage(completion.messages, store);
    }

    // --- NSFW隔离层注入 ---
    if (store.settings.nsfwIsolationEnabled && isNsfwActive()) {
      const scanText2 = latestScanText;
      const nsfwEntries = store.getCharacterNameEntries();
      const allNames2 = nsfwEntries.map(entry => entry.name);
      const currentChars = scanCharacterNamesFromContent(scanText2, Array.from(new Set(allNames2)), nsfwEntries);
      injectNsfwData(store.nsfwMemories, store.nsfwDreamtalk, store.nsfwDynamicProfiles, currentChars);
    }
    // 重置真实聊天消息标记
    store._isRealChatMessage = false;
  });

  // ========== 大总结注入到 messages（splice 方式，确保在导出的上下文中可见） ==========

  function injectSummaryIntoCompletion(
    messages: SillyTavern.SendingMessage[],
    summary: GrandSummary,
    activatedEventNames: Set<string>,
    store: ReturnType<typeof useMainStore>,
  ): void {
    const injectionText = buildSummaryInjectionText(summary, store as any, activatedEventNames);
    if (!injectionText) {
      return;
    }

    let injected = false;

    // 策略：找到包含 <chathistory> 的消息，直接在它的 content 里把摘要塞在 <chathistory> 之前
    // 这样摘要才真正紧贴 <chathistory>，而不是隔着一整条世界书消息
    for (let i = 0; i < messages.length; i++) {
      const content = messages[i].content;
      if (typeof content !== 'string') continue;
      if (content.includes('<chathistory>')) {
        messages[i].content = content.replace('<chathistory>', injectionText + '\n<chathistory>');
        injected = true;
        break;
      }
    }

    // 备选：如果没找到 <chathistory>，找 </chathistory> 在其后紧贴注入
    if (!injected) {
      for (let i = 0; i < messages.length; i++) {
        const content = messages[i].content;
        if (typeof content !== 'string') continue;
        if (content.includes('</chathistory>')) {
          messages[i].content = content.replace('</chathistory>', '</chathistory>\n' + injectionText);
          injected = true;
          break;
        }
      }
    }

    // 兜底：splice 新消息
    if (!injected) {
      const idx = Math.max(0, messages.length - 2);
      messages.splice(idx, 0, { role: 'system', content: injectionText });
      injected = true;
    }

    logInfo('大总结', `剧情摘要已注入 (${injectionText.length}字)`);
  }

  // ========== 大总结注入文本构建 ==========

  function buildSummaryInjectionText(summary: GrandSummary, store: any, activatedEvents: Set<string>): string {
    try {
      if (!summary.rawText) { return ''; }

      const recentCount = store.settings?.eventRecallRecent || 2;
      const recentThreshold = summary.version - recentCount + 1;

      const parts: string[] = [];
      parts.push(`<grand_summary version="${summary.version}" generated_at="${summary.generatedAt}">`);

      if (summary.timeline && summary.timeline.length > 0) {
        // 提取日期部分辅助函数（"2025年2月5日晨" → date="2025年2月5日", period="晨"）
        const parseTime = (t: string) => {
          const m = t?.match(/^(\d+年\d+月\d+日)(.*)$/);
          return m ? { date: m[1], period: m[2] } : null;
        };
        const periodOrder: Record<string, number> = {
          '晨': 0, '上午': 1, '午': 2, '下午': 3, '暮': 4, '夜': 5, '深夜': 6,
        };

        // 按日期→时段两级分组，保持首次出现顺序
        const dateGroups: Array<{ date: string; periods: Map<string, Array<{ eventNum: number; text: string }>> }> = [];
        const dateMap = new Map<string, number>();
        const noTimeEvents: Array<{ eventNum: number; time: string; text: string }> = [];

        let eventNum = 0;
        let detailCount = 0;

        for (const e of summary.timeline) {
          eventNum++;
          const isRecent = (e.summaryVersion || 0) >= recentThreshold;
          const isActivated = activatedEvents?.has(e.event) ?? false;
          const useDetail = (isRecent || isActivated) && !!e.detail;
          if (useDetail) detailCount++;
          const text = useDetail ? e.detail! : (e.event || '[空事件]');

          const parsed = parseTime(e.time || '');
          if (!parsed?.date) {
            noTimeEvents.push({ eventNum, time: e.time || '?', text });
            continue;
          }

          let idx = dateMap.get(parsed.date);
          if (idx === undefined) {
            idx = dateGroups.length;
            dateMap.set(parsed.date, idx);
            dateGroups.push({ date: parsed.date, periods: new Map() });
          }
          const pm = dateGroups[idx].periods;
          if (!pm.has(parsed.period)) pm.set(parsed.period, []);
          pm.get(parsed.period)!.push({ eventNum, text });
        }

        parts.push('## 事件');

        for (const dg of dateGroups) {
          parts.push(`${dg.date}：`);
          const sortedPeriods = [...dg.periods.keys()].sort(
            (a, b) => (periodOrder[a] ?? 99) - (periodOrder[b] ?? 99),
          );
          for (const period of sortedPeriods) {
            const periodEvents = dg.periods.get(period)!;
            for (let i = 0; i < periodEvents.length; i++) {
              const evt = periodEvents[i];
              if (i === 0) {
                parts.push(`  [${period}] ${evt.text}`);
              } else {
                parts.push(`       ${evt.text}`);
              }
            }
          }
        }

        for (const evt of noTimeEvents) {
          parts.push(`[${evt.time}] ${evt.text}`);
        }

        parts.push('');
      } else {
        const sections = summary.rawText.split(/---SECTION---/i);
        const raw = sections[0] || '';
        if (!raw.trim()) { return ''; }
        parts.push(raw.trim());
      }

      parts.push('</grand_summary>');
      const text = parts.join('\n');
      if (!text.trim()) { return ''; }
      return text;
    } catch (err) {
      return '';
    }
  }

  function insertAtDreamtalkAnchor(content: string, injectionText: string): string {
    const block = `${injectionText}\n\n`;
    const sceneStartMarker = 'Qiuqingzi: 我即将开始创作';
    const sceneStartIdx = content.lastIndexOf(sceneStartMarker);
    if (sceneStartIdx !== -1) {
      return content.slice(0, sceneStartIdx) + block + content.slice(sceneStartIdx);
    }

    const altMarker = '从此处开始';
    const altIdx = content.lastIndexOf(altMarker);
    if (altIdx !== -1) {
      return content.slice(0, altIdx) + block + content.slice(altIdx);
    }

    const interactiveIdx = content.lastIndexOf('<interactive_input>');
    if (interactiveIdx !== -1) {
      return content.slice(0, interactiveIdx) + block + content.slice(interactiveIdx);
    }

    const resetMarker = '[RESET ALL OF THE ABOVE TO NULL]';
    const resetIdx = content.indexOf(resetMarker);
    if (resetIdx !== -1) {
      const afterReset = resetIdx + resetMarker.length;
      return content.slice(0, afterReset) + '\n\n' + block + content.slice(afterReset);
    }

    return block + content;
  }

  function injectWorldProgressEntryIntoUserMessage(
    messages: SillyTavern.SendingMessage[],
    entryText: string,
  ): void {
    if (!entryText) return;

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'user' || typeof messages[i].content !== 'string') continue;
      messages[i].content = insertAtDreamtalkAnchor(messages[i].content as string, entryText);
      logInfo('世界推进', '入场引导已注入到梦呓位置上方');
      return;
    }
  }

  // ========== 梦呓注入函数 ==========

  function injectDreamtalkIntoUserMessage(
    messages: SillyTavern.SendingMessage[],
    store: ReturnType<typeof useMainStore>,
  ) {
    // 仅对非后台的 completion 注入（首次发送/重roll/swipe 均会在 handler 中标记）
    if (!store._isRealChatMessage) return;

    const dreamtalkData = store.dreamtalk;
    if (!dreamtalkData) return;

    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return;

    const lastUserMsg = messages[lastUserIdx];
    if (typeof lastUserMsg.content !== 'string') return;

    let latestContent = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && typeof messages[i].content === 'string') {
        latestContent = messages[i].content as string;
        break;
      }
    }

    // 和神经链记忆激活用同一套判定：从 characterMemories 拿别名，扫名一致
    const characterEntries = store.getCharacterNameEntries();
    const allNames = characterEntries.map(entry => entry.name);
    const currentCharacters = scanCharacterNamesFromContent(
      latestContent + lastUserMsg.content,
      allNames,
      characterEntries,
    );

    const dreamtalkText = buildDreamtalkInjection(dreamtalkData, currentCharacters);
    // 插入到 "Qiuqingzi: 我即将开始创作" 正上方
    // 模板结构: ...</UpdateVariable> \n <dreamtalk> \n Qiuqingzi: 我即将开始创作...
    const sceneStartMarker = 'Qiuqingzi: 我即将开始创作';
    const sceneStartIdx = lastUserMsg.content.lastIndexOf(sceneStartMarker);
    if (sceneStartIdx !== -1) {
      lastUserMsg.content =
        lastUserMsg.content.slice(0, sceneStartIdx) +
        dreamtalkText + '\n\n' +
        lastUserMsg.content.slice(sceneStartIdx);
    } else {
      // 没找到，回退到 "从此处开始" 之前
      const altMarker = '从此处开始';
      const altIdx = lastUserMsg.content.lastIndexOf(altMarker);
      if (altIdx !== -1) {
        lastUserMsg.content =
          lastUserMsg.content.slice(0, altIdx) +
          dreamtalkText + '\n\n' +
          lastUserMsg.content.slice(altIdx);
      } else {
        // 回退到 <interactive_input> 之前
        const interactiveIdx = lastUserMsg.content.lastIndexOf('<interactive_input>');
        if (interactiveIdx !== -1) {
          lastUserMsg.content =
            lastUserMsg.content.slice(0, interactiveIdx) +
            dreamtalkText + '\n\n' +
            lastUserMsg.content.slice(interactiveIdx);
        } else {
          // 都没找到，回退到破限标记之后
          const resetMarker = '[RESET ALL OF THE ABOVE TO NULL]';
          const resetIdx = lastUserMsg.content.indexOf(resetMarker);
          if (resetIdx !== -1) {
            const afterReset = resetIdx + resetMarker.length;
            lastUserMsg.content =
              lastUserMsg.content.slice(0, afterReset) + '\n\n' + dreamtalkText +
              lastUserMsg.content.slice(afterReset);
          } else {
            // 兜底 prepend
            lastUserMsg.content = dreamtalkText + '\n\n' + lastUserMsg.content;
          }
        }
      }
    }
    logInfo('梦呓', `梦呓已注入用户消息 (${currentCharacters.length} 角色匹配)`);
  }

  // ========== 梦呓分析触发 ==========

  async function triggerDreamtalkAnalysis(store: ReturnType<typeof useMainStore>): Promise<void> {
    store.setDreamtalkInProgress(true);
    const style = (store.settings as any).preferredPlayStyle || undefined;
    try {
      logInfo('梦呓', '开始分析用户行为模式');
      const { dreamtalk, nsfwDreamtalk } = await executeDreamtalkAnalysis(store.userInputRecords, store.persona.rawInput, store.dreamtalk ?? undefined, style, store.getUserName());
      store.updateDreamtalk(dreamtalk);
      if (nsfwDreamtalk) {
        store.updateNsfwDreamtalk(nsfwDreamtalk);
      }
      store.forcePersist({ settings: false }); // 兜底（updateDynamicProfile 循环内有 N 次写入）
      logInfo('梦呓', `梦呓分析完成 (${dreamtalk.characterInteractions.length} 角色交互模式)`);
    } catch (error: any) {
      logError('梦呓', '分析失败', String(error));
      const msg = error?.message || String(error);
      try { window.toastr?.error(msg, '❌ 梦呓分析失败', { timeOut: 8000, extendedTimeOut: 3000 }); } catch(_) { /* ignore */ }
    } finally {
      store.setDreamtalkInProgress(false);
    }
  }

  async function ensureRecentFloorsVisible() {
    return ensureRecentFloorsVisibleCore('affected');
  }

  // ========== 大总结触发（通过调度器入队） ==========

  async function checkAndTriggerSummary(store: ReturnType<typeof useMainStore>) {
    if (store.summaryInProgress) return;

    const pendingCount = countPendingAssistantContents(
      store.lastSummaryAtMessageId,
      store.settings.preserveRecentFloors,
      store.chatData.capturedContents,
    );
    if (pendingCount < store.settings.summaryInterval) {
      return;
    }

    // 大总结触发（受 grandSummaryEnabled 开关控制；角色记忆与大总结绑定，在 executeSummaryChain 内并发执行）
    if (store.settings.grandSummaryEnabled) {
      enqueueAnalysis('summary_chain', async () => {
        await executeSummaryChain(store);
      });
    }
  }

  async function executeSummaryChain(store: ReturnType<typeof useMainStore>) {
    store.setSummaryInProgress(true);
    logInfo('大总结', '触发大总结');

    // 获取待总结内容（排除最新 N 条不总结的 AI 回复）
    const pendingContents = readPendingSummaryContents(
      store.lastSummaryAtMessageId,
      store.settings.preserveRecentFloors,
      store.chatData.capturedContents,
    );
    if (pendingContents.length === 0) {
      logInfo('大总结', '无可总结内容，跳过');
      store.setSummaryInProgress(false);
      return;
    }

    let retryOutcome: 'success' | 'failed' = 'failed'; // 默认失败，成功路径显式置 success
    try {
      // 大总结引导弹窗：用户可填写总结方向
      let userGuidance = '';
      if (store.requestSummaryGuidance) {
        const guidance = await store.requestSummaryGuidance(pendingContents.length);
        if (guidance === null) {
          // 用户点击取消，跳过本次总结
          logInfo('大总结', '用户取消');
          store.setSummaryInProgress(false);
          return;
        }
        userGuidance = guidance;
      }

      const previousSummary = store.getLatestSummary();

      // === V2 大总结：大总结(时间线) + 角色记忆更新 并发执行 ===
      // ★ 失败时自动重试（带重试弹窗+停止按钮），重试同一批楼层；耗尽或被停止则向上抛出，
      //   由外层 catch 落失败占位（isFailed，不推进游标、不喂下一轮AI）。
      const existingMemories = previousSummary?.characterMemories || [];
      const maxAttempts = (store.settings as any).apiMaxRetries ?? 3;
      let v2Result: any = null;
      let memResult: any = null;
      let lastGenError: any = null;
      let generateDone = false;
      const characterMemoryEnabled = store.settings.characterMemoryEnabled;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (store.isSummaryRetryAborted()) {
          // 用户在上一轮弹窗中点了"停止重试"，直接放弃
          store.clearSummaryRetry();
          throw lastGenError || new Error('用户已停止大总结重试');
        }
        try {
          const tasks: Array<{ key: 'summary' | 'memory'; name: string; promise: Promise<any> }> = [];
          if (!v2Result) {
            tasks.push({
              key: 'summary',
              name: '大总结V2',
              promise: executeGrandSummaryV2(
                store.chatData.smallSummaries || [],
                pendingContents,
                previousSummary?.rawText,
                store.getUserName(),
                undefined,
                { _responseFormat: 'json_object' },
              ),
            });
          }
          if (characterMemoryEnabled && !memResult) {
            tasks.push({
              key: 'memory',
              name: '角色记忆更新',
              promise: executeCharacterMemoryUpdate(
                pendingContents,
                existingMemories,
                store.settings.memoryMinPerChar,
                store.settings.memoryMaxPerChar,
                store.getUserName(),
                undefined,
                { _responseFormat: 'json_object' },
              ),
            });
          }

          const settled = await Promise.allSettled(tasks.map(task => task.promise));
          const failed: Array<{ name: string; reason: any }> = [];
          for (let i = 0; i < settled.length; i++) {
            const task = tasks[i];
            const result = settled[i];
            if (result.status === 'fulfilled') {
              if (task.key === 'summary') v2Result = result.value;
              if (task.key === 'memory') memResult = result.value;
            } else {
              failed.push({ name: task.name, reason: result.reason });
            }
          }

          if (failed.length > 0) {
            const abortError = failed.find(f => f.reason?.name === 'AbortError')?.reason;
            if (abortError) throw abortError;
            const firstFailed = failed[0];
            const reason = firstFailed.reason;
            const message = reason?.message || String(reason);
            throw new Error(`${firstFailed.name}失败：${message}`);
          }

          generateDone = !!v2Result && (!characterMemoryEnabled || !!memResult);
          store.clearSummaryRetry();
          if (generateDone) break;
        } catch (err: any) {
          lastGenError = err;
          if (err?.name === 'AbortError') {
            store.clearSummaryRetry();
            throw err;
          }
          if (attempt >= maxAttempts || store.isSummaryRetryAborted()) {
            // 已达上限或用户已点停止 → 放弃，交给外层 catch 落失败占位
            store.clearSummaryRetry();
            throw err;
          }
          // 失败：显示重试弹窗（带倒计时），给用户"停止重试"窗口。倒计时后自动继续。
          const countdownSec = 5;
          const errMsg = err?.message || String(err);
          store.startSummaryRetry({
            floors: pendingContents.length,
            attempt,
            maxAttempts,
            error: errMsg,
            countdownSec,
          });
          logWarn('大总结', `大总结生成失败(${errMsg})，${countdownSec}s 后重试 (${attempt}/${maxAttempts})...`);
          for (let sec = countdownSec; sec > 0; sec--) {
            if (store.isSummaryRetryAborted()) break;
            store.updateSummaryRetryCountdown(sec);
            await new Promise(r => setTimeout(r, 1000));
          }
          store.clearSummaryRetry();
          // 循环回到顶部，attempt++，若用户中途点了 stop，下轮顶部即检测并放弃
        }
      }
      if (!generateDone) {
        // 理论上不会到这里（上面已 throw），兜底
        store.clearSummaryRetry();
        throw lastGenError || new Error('大总结生成失败');
      }

      // === 组装 GrandSummary（统一存储格式） ===
      const summarizedMessageIds = getCapturedContentMessageIds(pendingContents);
      const summarizedUpTo = summarizedMessageIds[summarizedMessageIds.length - 1] ?? store.lastSummaryAtMessageId;
      const summaryVersion = (previousSummary?.version || 0) + 1;

      // V2 事件 → TimelineEvent[]（summary=速览用于召回，detail=完整经过用于注入）
      const timeline: TimelineEvent[] = v2Result.events.map(e => ({
        time: e.time,
        event: e.summary || e.event.slice(0, 50),
        detail: e.event,
        importance: e.importance,
        triggers: {
          characters: e.presentCharacters,
          keywords: e.keywords,
        },
      }));

      // 事件编号续接上次大总结
      const offset = previousSummary
        ? (() => { let max = 0; const s1 = previousSummary.rawText.split(/---SECTION---/i)[0] || ''; for (const m of s1.matchAll(/\[#(\d+)\]/g)) max = Math.max(max, parseInt(m[1], 10)); return max; })()
        : 0;
      let eventNum = offset;
      const s1Lines: string[] = [];
      for (const e of timeline) {
        eventNum++;
        s1Lines.push(`[#${eventNum}] [${e.time}] ${e.event}`);
        s1Lines.push(`重要性: ${e.importance || 3}`);
        if (e.detail) s1Lines.push(e.detail);
        if (e.triggers?.characters?.length) s1Lines.push(`[角色: ${e.triggers.characters.join(', ')}]`);
        if (e.triggers?.keywords?.length) s1Lines.push(`[关键词: ${e.triggers.keywords.join(', ')}]`);
        s1Lines.push('');
      }

      // Section 2: 角色记忆（从本次角色记忆更新结果读取）
      let memCharMemories = memResult?.characterMemories || store.chatData.characterMemories || [];

      // 把本次大总结覆盖楼层内的世界推进记忆合并进角色记忆，并按剧情时间排序
      const lastSummaryUpTo = previousSummary?.upToMessageId ?? 0;
      const wpMergeResult = mergeWorldProgressIntoSummary(
        memCharMemories,
        store.chatData.worldProgressMemories || [],
        {
          floorRange: { start: lastSummaryUpTo + 1, end: summarizedUpTo },
          summaryVersion,
        },
      );
      memCharMemories = wpMergeResult.memories;

      const section2 = buildMemorySectionText(memCharMemories);

      // Section 3: NSFW（从本次结果读取）
      const nsfwMemories = memResult?.nsfwMemories || [];
      let section3 = '[NSFW记录]\n无NSFW内容';
      if (nsfwMemories.length > 0) {
        const nsfwParts: string[] = [];
        for (const n of nsfwMemories) {
          nsfwParts.push(`### ${n.characterName}`);
          nsfwParts.push(`敏感点: ${n.sensitivePoints.join(', ')}`);
          nsfwParts.push(`偏好: ${n.preferences.join(', ')}`);
          nsfwParts.push(`行为模式: ${n.behaviors.join(', ')}`);
          nsfwParts.push('记忆:');
          for (const m of n.memories) nsfwParts.push(`- ${m}`);
        }
        section3 = nsfwParts.join('\n');
      }

      const rawText = [
        s1Lines.join('\n').trim() || '[剧情摘要]',
        '---SECTION---',
        section2.trim() || '[角色记忆]',
        '---SECTION---',
        section3,
      ].join('\n');

      const summary: GrandSummary = {
        version: summaryVersion,
        generatedAt: new Date().toISOString(),
        upToMessageId: summarizedUpTo,
        coveredMessageIds: summarizedMessageIds,
        characterMemories: memCharMemories,
        timeline,
        characterTable: memCharMemories.map(m => ({
          name: m.characterName,
          aliases: m.keywords.slice(0, 3),
          identity: '',
          relationship: m.attitude === 'like' ? '好感' : m.attitude === 'dislike' ? '厌恶' : '中立',
          status: '活跃',
        })),
        rawText,
      };
      store.prepareSummaryForCommit(summary);

      // 新记忆仓是正式提交边界：先把同一批楼层的场景投影、时间线和角色记忆
      // 作为一个 MemoryBundle 原子落盘，成功后才允许 mainStore 推进总结游标。
      const summarizedIdSet = new Set(summarizedMessageIds);
      const bundleSmallSummaries = (store.chatData.smallSummaries || []).filter((record: any) => {
        const endFloor = record?.floorRange?.end ?? record?.floorRange?.start;
        return Number.isFinite(endFloor) && summarizedIdSet.has(endFloor);
      });
      await commitRealtimeMemoryTransaction({
        chatId: store.chatData.chatId || getCurrentChatIdSafe(),
        smallSummaries: bundleSmallSummaries,
        grandSummary: summary,
        assistantContents: pendingContents,
        settings: {
          embeddingApiUrl: store.settings.embeddingApiUrl,
          embeddingModel: store.settings.embeddingModel,
          embeddingDimensions: store.settings.embeddingDimensions,
        },
        bundleType: 'realtime',
        onCommitted: () => {
          for (const memory of store.chatData.worldProgressMemories || []) {
            if (wpMergeResult.archivedIds.has(memory.id)) {
              (memory as any).archivedInSummaryVersion = summaryVersion;
            }
          }
          store.chatData.characterMemories = summary.characterMemories;
          store.addSummary(summary, summarizedUpTo, summarizedMessageIds);
        },
      });
      const syncCommittedMemoryBundle = async () => {
        await commitRealtimeMemoryTransaction({
          chatId: store.chatData.chatId || getCurrentChatIdSafe(),
          smallSummaries: bundleSmallSummaries,
          grandSummary: summary,
          assistantContents: pendingContents,
          settings: {
            embeddingApiUrl: store.settings.embeddingApiUrl,
            embeddingModel: store.settings.embeddingModel,
            embeddingDimensions: store.settings.embeddingDimensions,
          },
          bundleType: 'realtime',
          expectedBundleId: summary.memoryBundleId,
        });
      };

      // Toastr 弹窗警告：AI 输出的角色记忆为空
      const totalNewMemories = summary.characterMemories.reduce(
        (s, m) => s + (m.coreMemories?.length || 0) + (m.recentMemories?.length || 0),
        0,
      );
      if (totalNewMemories === 0) {
        logWarn('大总结', 'AI输出角色记忆为空，可能格式异常');
        try {
          window.toastr?.warning(
            'AI 输出的角色记忆为空！可能是格式异常，建议重新总结',
            '⚠️ 明月秋青',
            { timeOut: 8000, extendedTimeOut: 3000 },
          );
        } catch(e) { /* ignore */ }
      }

      // 增量模式：rawText Section 2 的合并由 assembledSummary 在读取时自动完成

      // 语义向量：大总结后批量生成事件 embedding（后台任务，不阻塞主流程）
      if (store.settings.embeddingEnabled && store.settings.embeddingApiKey && summary.timeline.length > 0) {
        enqueueAnalysis('embedding_timeline', async () => {
          await embedTimelineEvents(
            summary.timeline,
            store.settings.embeddingApiUrl,
            store.settings.embeddingApiKey,
            store.settings.embeddingModel,
            store.settings.embeddingDimensions,
          );
          store.forcePersist({ settings: false });
          await syncCommittedMemoryBundle();
        });
      }

      // 核心记忆向量：大总结后批量生成（后台任务，不阻塞主流程）
      if (store.settings.embeddingEnabled && store.settings.embeddingApiKey && summary.characterMemories.length > 0) {
        const totalCores = summary.characterMemories.reduce((s, m) => s + (m.coreMemories?.length || 0), 0);
        if (totalCores > 0) {
          enqueueAnalysis('embedding_mem', async () => {
            await embedCharacterMemories(
              summary.characterMemories,
              store.settings.embeddingApiUrl,
              store.settings.embeddingApiKey,
              store.settings.embeddingModel,
              store.settings.embeddingDimensions,
            );
            store.syncCharacterMemoryBatchEmbeddings(summary.version, summary.characterMemories);
            store.forcePersist({ settings: false });
            await syncCommittedMemoryBundle();
          });
        }
      }

      // 存储 NSFW 记忆
      if (nsfwMemories.length > 0) {
        store.updateNsfwMemories(nsfwMemories);
        store.forcePersist({ settings: false });
        logInfo('大总结', `NSFW记忆已更新 (${nsfwMemories.length} 角色)`);
      }

      logInfo('大总结', `大总结 v${summary.version} 完成 (${summary.timeline.length} 事件, ${summary.characterMemories.length} 角色)`);

      // ★ 成功：标记本次结果为成功（finally 据此决定是否补检下一轮）
      retryOutcome = 'success';

      // ★ 总结完成，立刻标记结束，避免后续后台任务阻塞 UI 进度显示
      store.setSummaryInProgress(false);

      const hiddenIds = await hideSummaryFloors(summarizedUpTo, 0, 'affected');
      if (hiddenIds.length > 0) {
        logInfo('大总结', `已隐藏 ${hiddenIds.length} 个已总结楼层`);
      } else {
        logInfo('大总结', '未隐藏任何楼层');
      }

    } catch (error: any) {
      logError('大总结', '大总结失败', String(error));
      // ★ 大总结失败 → 清空调度队列，后续任务无意义
      clearSchedulerQueue();
      logInfo('调度', '已清空队列（大总结失败）');
      // 创建空总结占位，方便用户点重新总结
      const version = (store.getLatestSummary()?.version ?? 0) + 1;
      const summarizedMessageIds = getCapturedContentMessageIds(pendingContents);
      const failedSummary: GrandSummary = {
        version,
        generatedAt: new Date().toISOString(),
        upToMessageId: summarizedMessageIds[summarizedMessageIds.length - 1],
        coveredMessageIds: summarizedMessageIds,
        characterMemories: [],
        timeline: [],
        characterTable: [],
        rawText: '总结失败，请重新总结',
        isFailed: true, // ★ 失败占位：不推进游标、不参与组装（不会回喂下一轮AI）
      };
      store.addSummary(failedSummary, failedSummary.upToMessageId, summarizedMessageIds);
      const msg = error?.message || String(error);
      try { window.toastr?.error(msg, '❌ 大总结失败：请重新总结', { timeOut: 8000, extendedTimeOut: 3000 }); } catch(_) { /* ignore */ }
    } finally {
      store.setSummaryInProgress(false);
      // ★ 仅在"上次成功推进了游标"的前提下补一次重检：
      //   - 成功：游标推进后执行期新累积的楼层可能已达阈值，需补检再触发下一轮；
      //   - 失败：游标未推进（isFailed 占位不前移），此时 shouldTrigger 仍对这一批为真，
      //     立即重检只会对同一批再触发→再失败→重试弹窗反复刷屏，因此失败后不再自动重检，
      //     需用户继续发够阈值"新"楼层或手动点"重新总结"才会再次执行。
      if (retryOutcome === 'success') {
        setTimeout(() => {
          checkAndTriggerSummary(store);
        }, 0);
      }
    }
  }



  // ========== 剧情校对触发 ==========

  async function triggerPlotCheck(store: ReturnType<typeof useMainStore>, currentFloor: number): Promise<void> {
    try {
      const outline = store.chatData.plotOutline;
      if (!outline || outline.status !== 'active') return;

      // 收集最近正文
      const recentContent = readRecentAssistantContents(3, currentFloor, store.chatData.capturedContents)
        .map(c => c.content)
        .join('\n---\n');

      const result = await executePlotCheck(outline, recentContent, store.getUserName());
      store.chatData.lastPlotCheckFloor = currentFloor;
      store.chatData.lastPlotCheckResult = result;

      // 如果需要推进阶段
      if (result.shouldAdvanceStage) {
        store.chatData.plotOutline = advanceOutlineStage(outline);
        logInfo('剧情导演', `阶段推进: ${outline.currentStageIndex} → ${outline.currentStageIndex + 1}`);
      }

      store.forcePersist({ settings: false });

      // 更新注入
      injectPlotGuidance(store.chatData.plotOutline, result);
      logInfo('剧情导演', `校对完成: progress=${result.stageProgress}, deviating=${result.isDeviating}`);
    } catch (error) {
      logError('剧情导演', '校对失败', String(error));
    }
  }

  // ========== 世界推进触发 ==========


/**
 * 为小总结构建世界推进辅助材料（只取最近一条未消费记录）。
 * 返回材料文本 + 消费的 WP 记录 ID（供重roll回退时清除标记）。
 */
function buildWorldProgressMaterialForSmallSummary(
  store: ReturnType<typeof useMainStore>,
  currentFloor: number,
): { material: string; consumedWPId: string | null; centerCharacterNames: string[]; centerLocationNames: string[] } {
  const empty = { material: '', consumedWPId: null, centerCharacterNames: [], centerLocationNames: [] };
  const pushUnique = (list: string[], value?: string) => {
    const text = (value || '').trim();
    if (text && !list.includes(text)) list.push(text);
  };
  const records = (store.chatData.worldProgressRecords || [])
    .filter((r: any) => r.status === 'ready' && (r.basedOnFloorRange?.end ?? -1) <= currentFloor)
    .sort((a: any, b: any) => (b.basedOnFloorRange?.end ?? -1) - (a.basedOnFloorRange?.end ?? -1));
  if (records.length === 0) return empty;

  const latest = records[0] as any;
  // 已消费过则跳过
  if (latest.smallSummaryConsumed) return empty;

  // 标记已消费
  latest.smallSummaryConsumed = true;

  const lines: string[] = [];
  const centerCharacterNames: string[] = [];
  const centerLocationNames: string[] = [];
  const currentTime = latest.currentTime || latest.mainTimeline?.storyTime || '?';
  if (currentTime && currentTime !== '?') {
    lines.push(`[当前时间] ${currentTime}`);
  }
  const loc = latest.mainTimeline?.location || '?';
  const groups = new Map<string, string[]>();
  for (const c of latest.advancedCharacters || []) {
    const charName = store.resolveKnownCharacterName(c.characterName || '', true) || '未知角色';
    if (charName !== '未知角色') c.characterName = charName;
    const charLoc = c.location || loc;
    pushUnique(centerCharacterNames, charName);
    pushUnique(centerLocationNames, charLoc);
    const action = normalizeWorldProgressMemoryForGraph(charName, c.memoryText || c.action || '');
    const result = c.result ? `；结果：${c.result}` : '';
    if (!groups.has(charLoc)) groups.set(charLoc, []);
    groups.get(charLoc)!.push(`  ${charName}: ${action}${result}`);
  }
  for (const [groupLoc, items] of groups) {
    lines.push(`@${groupLoc || loc}`);
    lines.push(...items);
  }
  return { material: lines.join('\n'), consumedWPId: latest.id || null, centerCharacterNames, centerLocationNames };
}

/** 清除小总结记录引用的 WP 记录的 smallSummaryConsumed 标记 */
function clearWPConsumedFlag(store: ReturnType<typeof useMainStore>, ssRecord: any): void {
  if (!ssRecord?.consumedWorldProgressId) return;
  const wp = (store.chatData.worldProgressRecords || []).find(
    (r: any) => r.id === ssRecord.consumedWorldProgressId,
  );
  if (wp) wp.smallSummaryConsumed = false;
}

  async function triggerWorldProgress(store: ReturnType<typeof useMainStore>, currentFloor: number, recentContents: CapturedContent[] = []): Promise<void> {
    try {
      const latestSummary = store.getLatestSummary() || undefined;

      // 世界推进选中的世界书条目：执行前再从运行时全文缓存补一次，兼容旧数据只有 key 没有 content 的情况。
      const wpWorldBook = hydrateSelectedWorldBookEntries(
        store.chatData.worldProgressWorldBookKeys,
        store.chatData.savedWPWB,
        store.worldBookRawCache,
      );
      const previousWPSignature = JSON.stringify((store.chatData.savedWPWB || []).map(e => ({
        key: e.key,
        book: e.book || '',
        uid: e.uid,
        entryName: e.entryName || '',
        content: e.content || '',
      })));
      const nextWPSignature = JSON.stringify(wpWorldBook.map(e => ({
        key: e.key,
        book: e.book || '',
        uid: e.uid,
        entryName: e.entryName || '',
        content: e.content || '',
      })));
      store.chatData.savedWPWB = wpWorldBook;
      if (previousWPSignature !== nextWPSignature) {
        store.schedulePersist({ settings: false });
      }
      // 关键：每次"到点排推"都先推进一次 attempt 序号 —— 不论随后是否真推演（被冷却跳过、或没候选跳过都算一次"尝试"）。
      // 这样基于 attempt 差的冷却才能在没候选/被冷却压制时仍逐轮递减，避免"只剩一个候选 → 被永久封锁"的死循环。
      // 初始对齐：老存档 worldProgressAttempts=-1（首次启用 attempt 机制），第一次起步对齐到当前楼层，
      // 否则 attempt 从 0 / 1 开始，而老记录的 basedOnFloorRange.end 是大楼数（50/60/...），
      // 会让 passedAttempts = cur−recordAttempt 算出负数、remaining 爆炸。
      let prevAttempt = store.chatData.worldProgressAttempts ?? -1;
      if (prevAttempt < 0) prevAttempt = currentFloor - 1;
      const thisAttempt = prevAttempt + 1;
      store.chatData.worldProgressAttempts = thisAttempt;

      const candidates = store.selectWorldProgressCandidates(
        currentFloor,
        store.worldProgressManualChars || '',
        2,
        thisAttempt,
      );

      if (candidates.length === 0) {
        // 没候选不推，但 attempt 已 +1 → 后续冷却逐步递减
        store.chatData.lastWorldProgressFloor = Math.max(store.chatData.lastWorldProgressFloor ?? -1, currentFloor);
        store.forcePersist({ settings: false });
        logInfo('世界推进', `跳过: 楼层 ${currentFloor} 没有可推演的不在场角色 (attempt=${thisAttempt})`);
        return;
      }

      const record = await executeWorldProgress(
        latestSummary,
        store.chatData.smallSummaries,
        store.worldProgressManualChars || '',
        recentContents,
        currentFloor,
        store.getUserName(),
        undefined,
        store.chatData.plotOutline,
        wpWorldBook,
        store.chatData.worldProgressRecords,
        store.chatData.knowledgeGraph || null,
        store.chatData.characterLocations,
        store.settings.kgInjectTopK,
        candidates,
        thisAttempt,
      );

      // 截断（双保险：push 前过滤掉 >= currentFloor 的过期记录）
      store.truncateWorldProgressRecords(currentFloor);
      store.chatData.worldProgressRecords.push(record);
      if (record.status === 'ready') {
        store.addWorldProgressMemories(record, currentFloor);
      }
      store.chatData.lastWorldProgressFloor = Math.max(store.chatData.lastWorldProgressFloor ?? -1, currentFloor);
      store.forcePersist({ settings: false });

      // 注入最新世界推进
      injectWorldProgress(store.chatData.worldProgressRecords, currentFloor + 1, store.settings.worldProgressInterval);
      logInfo('世界推进', `完成: ${record.advancedCharacters.length} 角色`);
    } catch (error) {
      logError('世界推进', '失败', String(error));
      // 失败也存一条 failed 记录，让用户能在列表里看到并点「重新推进」
      const failed = createFailedWorldProgressRecord(currentFloor, String((error as any)?.message || error || ''));
      store.truncateWorldProgressRecords(currentFloor);
      store.chatData.worldProgressRecords.push(failed);
      store.chatData.lastWorldProgressFloor = Math.max(store.chatData.lastWorldProgressFloor ?? -1, currentFloor);
      store.forcePersist({ settings: false });
    }
  }

  // ========== 聊天切换时重载 ==========

  reloadOnChatChange();

  // 聊天切换时清理：释放所有注入句柄 + 清空调度队列
  eventOn(tavern_events.CHAT_CHANGED, () => {
    clearSchedulerQueue();
    unresolvedSourceChangeFloor = null;
    setTimeout(() => sourceChangeTracker.reset(rawChatReader.readAllSourceContents()), 0);
    removeDynamicProfileV2Injection();
    removeWorldGraphInjection();
    removeWorldProgressInjection();
    removeNeuralChainInjection();
    removeNsfwInjection();
    removeRelationshipInjection();
    removeWorldBookTagIndexInjection();
    removePlotInjection();
    logInfo('系统', '聊天切换，已释放注入句柄');
  });

  // 删除聊天时清理智脑全量汇总(STABLE_ID)里对应的条目，避免残留堆积
  // （删除后酒馆会切到其它聊天触发 CHAT_CHANGED→reload，此处同步清完再走reload）
  eventOn(tavern_events.CHAT_DELETED, async (chatFileName: string) => {
    try {
      const store = useMainStore(pinia);
      store.removeDeletedChatData(chatFileName);
      await deleteMemoryWarehouseForChat(chatFileName);
    } catch (e) {
      logWarn('系统', 'CHAT_DELETED清理失败', String(e));
    }
  });

  // ========== 卸载清理 ==========

  $(window).on('pagehide', () => {
    clearSchedulerQueue();
    app?.unmount();
    $app?.remove();
    styleHandle?.destroy();
  });

  logInfo('系统', '明月秋青脚本已加载');
});
