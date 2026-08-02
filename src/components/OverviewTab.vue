<script setup lang="ts">
import { useMainStore, type CapturedContent, type GrandSummary, type TimelineEvent } from '../stores/mainStore';
import { buildMemorySectionText } from '../core/summary';
import {
  countPendingAssistantContents,
  readAssistantContentsInRange,
  readPendingSummaryContents,
  readAssistantExtractedContentAtFloor,
} from '../utils/chatContent';
import { executeDreamtalkAnalysis } from '../core/dreamtalk';
import { executeGrandSummaryV2 } from '../core/grandSummaryV2';
import { executeCharacterMemoryUpdate } from '../core/characterMemoryUpdate';
import { embedTimelineEvents, embedCharacterMemories } from '../core/embedding';
import {
  getCapturedContentMessageIds,
  hideSummaryFloors,
  parseFloorRange,
  setFloorsHidden,
} from '../core/floorVisibility';
import { enqueueAnalysis, clearSchedulerQueue } from '../core/backgroundQueue';
import { syncSmallSummaryStatus } from '../core/contextReplacement';
import { logInfo, logWarn, logError } from '../utils/logger';
import { executeSmallSummary, type SmallSummaryKgOptions } from '../core/smallSummary';
import { createEmptyKnowledgeGraph, applyKnowledgeGraphDiff } from '../core/knowledgeGraph';
import { cleanCharacterAliases } from '../utils/characterNames';
import { isValidMainContent } from '../utils/messageParser';
import { commitRealtimeMemoryTransaction } from '../core/memoryCommitCoordinator';
import BatchSummaryPanel from './BatchSummaryPanel.vue';
import SchedulerPanel from './SchedulerPanel.vue';
import { useIsMobile } from '../composables/useIsMobile';

const store = useMainStore();
const isMobile = useIsMobile();

function getCurrentChatIdSafe(): string {
  try {
    return SillyTavern.getCurrentChatId()?.trim() || store.chatData.chatId || '';
  } catch {
    return store.chatData.chatId || '';
  }
}

// 当前角色卡名（读 SillyTavern 上下文，跨域/打包环境失败时回退 '—'）
const charCardName = computed(() => {
  try {
    const s: any = (typeof SillyTavern !== 'undefined') ? SillyTavern : (window as any).SillyTavern;
    if (s && typeof s.getContext === 'function') {
      const ctx = s.getContext();
      if (ctx && typeof ctx.name2 === 'string' && ctx.name2) return ctx.name2;
    }
  } catch { /* ignore */ }
  return '—';
});

// 大总结引导弹窗（直接调用 store 方法，store.requestSummaryGuidance）

const selectedSummaryRange = ref('');
const selectedSummaryResult = ref('');
const manualHideRange = ref('');
const hiddenFloorActionResult = ref('');
const hiddenFloorRefreshKey = ref(0);
const openingGraphBusy = ref(false);
const floorSummaryBusy = ref(false);

// 状态计算
const currentFloor = computed(() => {
  void store.chatContentRevision;
  try { return getLastMessageId(); } catch { return 0; }
});

const pendingCount = computed(() => {
  void store.chatContentRevision;
  return countPendingAssistantContents(
    store.lastSummaryAtMessageId,
    store.settings.preserveRecentFloors,
    store.chatData.capturedContents,
  );
});

const summarizableCount = computed(() => pendingCount.value);

const nextSummaryIn = computed(() =>
  Math.max(0, store.settings.summaryInterval - pendingCount.value),
);

const activeCharacters = computed(() => store.getAllCharacterNames());

const dreamtalkStatus = computed(() => {
  if (!store.dreamtalk) return '未分析';
  return `v${store.dreamtalk.version} (${store.dreamtalk.characterInteractions.length} 角色)`;
});

const summaryCount = computed(() => store.summaries.length);
const summaryBusy = computed(() => store.summaryInProgress);

const hiddenFloors = computed(() => {
  void hiddenFloorRefreshKey.value;
  return store.getHiddenFloors();
});

const manualHideCount = computed(() => getParsedFloorIds(manualHideRange.value).length);
const selectedSummaryCount = computed(() => getSelectedCapturedContents().length);
const effectiveContentCount = computed(() => {
  void store.chatContentRevision;
  return readAssistantContentsInRange(0, currentFloor.value, store.chatData.capturedContents).length;
});

// 大总结编辑 → 已迁移到时光轴
const latestSummary = computed(() => store.getLatestSummary());

// 当前楼层的小总结记录（用于判断按钮是否可点）
const currentFloorSummary = computed(() => {
  void store.chatContentRevision;
  const floor = currentFloor.value;
  return (store.chatData.smallSummaries || [])
    .find((s: any) => (s.floorRange?.end ?? s.floorRange?.start ?? -1) === floor);
});
// 只有当当前楼层无小总结、或小总结失败/被忽略时按钮才可点
const canTriggerFloorSummary = computed(() => {
  void store.chatContentRevision;
  const r = currentFloorSummary.value;
  return !r || r.status === 'failed' || r.status === 'ignored';
});

function refreshHiddenFloors() {
  hiddenFloorRefreshKey.value++;
}

function getParsedFloorIds(input: string): number[] {
  try {
    return parseFloorRange(input);
  } catch {
    return [];
  }
}

function getSelectedCapturedContents(input = selectedSummaryRange.value) {
  const selectedIds = new Set(getParsedFloorIds(input));
  if (selectedIds.size === 0) return [];
  const ids = Array.from(selectedIds);
  return readAssistantContentsInRange(
    Math.min(...ids),
    Math.max(...ids),
    store.chatData.capturedContents,
  ).filter(content => selectedIds.has(content.messageId));
}

function getRoleLabel(role: string): string {
  if (role === 'assistant') return 'AI';
  if (role === 'user') return '用户';
  if (role === 'system') return '系统';
  return role;
}

async function runGrandSummaryAndHide(
  contents: CapturedContent[],
  logPrefix: string,
  userGuidance?: string,
  replaceBundleIds: string[] = [],
) {
  const previousSummary = store.getLatestSummary();
  const existingMemories = previousSummary?.characterMemories || [];

  // V2: 步骤1 — 白描事实时间线
  const v2Result = await executeGrandSummaryV2(
    store.chatData.smallSummaries || [],
    contents,
    previousSummary?.rawText,
    store.getUserName(),
    undefined,
    undefined,
    store.getBlacklistedCharacters(),
  );

  // V2: 步骤2 — 角色记忆+NSFW（调色盘分析）
  const memResult = await executeCharacterMemoryUpdate(
    contents,
    existingMemories,
    store.settings.memoryMinPerChar,
    store.settings.memoryMaxPerChar,
    store.getUserName(),
    undefined,
    undefined,
    store.getBlacklistedCharacters(),
  );

  // === 组装 GrandSummary ===
  const summarizedMessageIds = getCapturedContentMessageIds(contents);
  const summarizedUpTo = Math.max(
    store.lastSummaryAtMessageId,
    summarizedMessageIds[summarizedMessageIds.length - 1] ?? store.lastSummaryAtMessageId,
  );
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

  // 事件编号
  let eventNum = 0;
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

  // Section 2: 角色记忆
  const section2 = buildMemorySectionText(memResult.characterMemories);

  // Section 3: NSFW
  let section3 = '[NSFW记录]\n无NSFW内容';
  if (memResult.nsfwMemories.length > 0) {
    const nsfwParts: string[] = [];
    for (const n of memResult.nsfwMemories) {
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
    characterMemories: memResult.characterMemories,
    timeline,
    characterTable: memResult.characterMemories.map(m => ({
      name: m.characterName,
      aliases: m.keywords.slice(0, 3),
      identity: '',
      relationship: m.attitude === 'like' ? '好感' : m.attitude === 'dislike' ? '厌恶' : '中立',
      status: '活跃',
    })),
    rawText,
  };

  const nsfwMemories = memResult.nsfwMemories;
  store.prepareSummaryForCommit(summary);
  const summarizedIdSet = new Set(summarizedMessageIds);
  const bundleSmallSummaries = (store.chatData.smallSummaries || []).filter((record: any) => {
    const endFloor = record?.floorRange?.end ?? record?.floorRange?.start;
    return Number.isFinite(endFloor) && summarizedIdSet.has(endFloor);
  });
  await commitRealtimeMemoryTransaction({
    chatId: getCurrentChatIdSafe(),
    smallSummaries: bundleSmallSummaries,
    grandSummary: summary,
    assistantContents: contents,
    settings: {
      embeddingApiUrl: store.settings.embeddingApiUrl,
      embeddingModel: store.settings.embeddingModel,
      embeddingDimensions: store.settings.embeddingDimensions,
    },
    bundleType: 'realtime',
    replaceBundleIds,
    onCommitted: () => store.addSummary(summary, summarizedUpTo, summarizedMessageIds),
  });
  const syncCommittedMemoryBundle = async () => {
    await commitRealtimeMemoryTransaction({
      chatId: getCurrentChatIdSafe(),
      smallSummaries: bundleSmallSummaries,
      grandSummary: summary,
      assistantContents: contents,
      settings: {
        embeddingApiUrl: store.settings.embeddingApiUrl,
        embeddingModel: store.settings.embeddingModel,
        embeddingDimensions: store.settings.embeddingDimensions,
      },
      bundleType: 'realtime',
      expectedBundleId: summary.memoryBundleId,
    });
  };

  // 存储 NSFW 记忆
  if (nsfwMemories.length > 0) {
    store.updateNsfwMemories(nsfwMemories);
    store.forcePersist();
    logInfo('大总结', `NSFW记忆已更新 (${nsfwMemories.length} 角色)`);
  }

  // === 后台生成向量（不阻塞主流程） ===
  if (store.settings.embeddingEnabled && store.settings.embeddingApiKey) {
    // 时间线事件向量
    if (summary.timeline.length > 0) {
      embedTimelineEvents(
        summary.timeline,
        store.settings.embeddingApiUrl,
        store.settings.embeddingApiKey,
        store.settings.embeddingModel,
        store.settings.embeddingDimensions,
        undefined,
        store.settings.embeddingManualMatryoshka,
      ).then(async () => {
        store.syncCharacterMemoryBatchEmbeddings(summary.version, memResult.characterMemories);
        store.forcePersist();
        await syncCommittedMemoryBundle();
      }).catch(() => {});
    }

    // 核心记忆向量
    const totalCores = memResult.characterMemories.reduce(
      (s, m) => s + (m.coreMemories?.length || 0),
      0,
    );
    if (totalCores > 0) {
      embedCharacterMemories(
        memResult.characterMemories,
        store.settings.embeddingApiUrl,
        store.settings.embeddingApiKey,
        store.settings.embeddingModel,
        store.settings.embeddingDimensions,
        store.settings.embeddingManualMatryoshka,
      ).then(async () => {
        store.forcePersist();
        await syncCommittedMemoryBundle();
      }).catch(() => {});
    }

  }

  let hiddenIds: number[] = [];
  try {
    hiddenIds = await hideSummaryFloors(summarizedUpTo, 0, 'affected');
    refreshHiddenFloors();
    // ★ 立刻同步小总结状态（隐藏的 → hidden-active），不等下次发消息
    syncSmallSummaryStatus(store.chatData.smallSummaries, new Set(hiddenIds));
  } catch (error) {
    // 记忆与热投影已经提交成功；隐藏失败不能伪装成“总结失败”再写失败占位。
    logWarn('大总结', '总结已提交，但自动隐藏楼层失败', String(error));
  }
  logInfo('大总结', `v${summary.version} 完成，已隐藏 ${hiddenIds.length} 个楼层`);
  return { summary, hiddenIds };
}

// 手动触发大总结（排除最新 N 条不总结的 AI 回复）
function triggerManualSummary() {
  const pending = readPendingSummaryContents(
    store.lastSummaryAtMessageId,
    store.settings.preserveRecentFloors,
    store.chatData.capturedContents,
  );
  if (pending.length === 0) {
    logInfo('大总结', '没有待总结的正文日志');
    return;
  }

  enqueueAnalysis('summary_chain', async () => {
    store.setSummaryInProgress(true);
    logInfo('大总结', '手动触发');

    try {
      // 大总结引导弹窗（容错：弹窗异常时跳过，直接执行总结）
      let guidance = '';
      try {
        guidance = await store.requestSummaryGuidance(pending.length);
      } catch (e) {
        logWarn('大总结', '引导弹窗异常', String(e));
      }
      if (guidance === null) {
        logInfo('大总结', '用户取消');
        return;
      }

      const { summary } = await runGrandSummaryAndHide(pending, '手动', guidance ?? '');
      logInfo('大总结', `v${summary.version} 完成 (${summary.characterMemories.length} 角色)`);
    } catch (error: any) {
      logError('大总结', '失败', String(error));
      clearSchedulerQueue();
      const version = (latestSummary.value?.version ?? 0) + 1;
      const summarizedMessageIds = getCapturedContentMessageIds(pending);
      const failedSummary: GrandSummary = {
        version,
        generatedAt: new Date().toISOString(),
        upToMessageId: summarizedMessageIds[summarizedMessageIds.length - 1],
        coveredMessageIds: summarizedMessageIds,
        characterMemories: [],
        timeline: [],
        characterTable: [],
        rawText: '总结失败，请重新总结',
        isFailed: true, // 失败占位：不推进游标、不参与组装、不回喂下一轮AI
      };
      store.addSummary(failedSummary, failedSummary.upToMessageId, summarizedMessageIds);
      const msg = error?.message || String(error);
      try { window.toastr?.error(msg, '❌ 大总结失败：请重新总结', { timeOut: 8000, extendedTimeOut: 3000 }); } catch(_) {}
    } finally {
      store.setSummaryInProgress(false);
    }
  });
}

function triggerRedoSummary() {
  if (!latestSummary.value || summaryBusy.value) return;

  enqueueAnalysis('summary_chain', async () => {
    // 保存旧总结的 upToMessageId，失败时用于恢复
    const oldUpToMessageId = store.lastSummaryAtMessageId;

    // 引导弹窗（预填上次提交的指引内容）
    const guidance = await store.requestSummaryGuidance(
      latestSummary.value!.coveredMessageIds?.length ?? 0,
      store.lastSubmittedGuidance || undefined,
    );
    if (guidance === null) {
      return;
    }

    store.setSummaryInProgress(true);
    logInfo('大总结', '回退并重新生成');

    let removedSummary: ReturnType<typeof store.rollbackSummary> = undefined;

    try {
      removedSummary = store.rollbackSummary(true, false);
      if (!removedSummary) return;

      const coveredIds = new Set(removedSummary.coveredMessageIds ?? []);
      const contents = coveredIds.size > 0
        ? readAssistantContentsInRange(
            Math.min(...Array.from(coveredIds)),
            Math.max(...Array.from(coveredIds)),
            store.chatData.capturedContents,
          ).filter(content => coveredIds.has(content.messageId))
        : readPendingSummaryContents(
            store.lastSummaryAtMessageId,
            store.settings.preserveRecentFloors,
            store.chatData.capturedContents,
          );

      if (contents.length === 0) {
        logInfo('大总结', '回退后无内容可重新总结，已恢复旧版');
        store.addSummary(removedSummary, oldUpToMessageId, removedSummary.coveredMessageIds);
        return;
      }

      const { summary } = await runGrandSummaryAndHide(
        contents,
        '重新',
        guidance || undefined,
        removedSummary.memoryBundleId ? [removedSummary.memoryBundleId] : [],
      );

      // 清除基于旧 V4 产生的后续总结（version > 被替换版本的全部失效）
      store.chatData.summaryHistory = store.chatData.summaryHistory.filter(
        s => s.version < removedSummary.version,
      );

      logInfo('大总结', `已重新生成 v${summary.version}`);
    } catch (error: any) {
      logError('大总结', '重新总结失败', String(error));
      clearSchedulerQueue();
      if (removedSummary) {
        store.addSummary(removedSummary, oldUpToMessageId, removedSummary.coveredMessageIds);
        logInfo('大总结', '已恢复旧版');
      }
      const msg = error?.message || String(error);
      try { window.toastr?.error(msg, '❌ 重新总结失败：请重新总结', { timeOut: 8000, extendedTimeOut: 3000 }); } catch(_) {}
    } finally {
      store.setSummaryInProgress(false);
    }
  });
}

function triggerSelectedSummary() {
  const selectedContents = getSelectedCapturedContents();
  if (selectedContents.length === 0) {
    selectedSummaryResult.value = '没有匹配到已捕获正文的 AI 楼层';
    logInfo('大总结', '选定楼层未匹配到正文日志');
    return;
  }

  enqueueAnalysis('summary_chain', async () => {
    store.setSummaryInProgress(true);
    selectedSummaryResult.value = '';
    logInfo('大总结', `选定楼层总结: ${selectedContents.map(c => `#${c.messageId}`).join(', ')}`);

    try {
      let guidance = '';
      try {
        guidance = await store.requestSummaryGuidance(selectedContents.length);
      } catch (e) {
        logWarn('大总结', '引导弹窗异常', String(e));
      }
      if (guidance === null) {
        logInfo('大总结', '用户取消');
        return;
      }

      const { summary, hiddenIds } = await runGrandSummaryAndHide(selectedContents, '选定楼层', guidance ?? '');
      selectedSummaryResult.value = `已生成 v${summary.version}，隐藏 ${hiddenIds.length} 个楼层`;
    } catch (error: any) {
      selectedSummaryResult.value = '选定楼层总结失败：请重新总结';
      logError('大总结', '选定楼层总结失败', String(error));
      clearSchedulerQueue();
      const version = (latestSummary.value?.version ?? 0) + 1;
      const summarizedMessageIds = getCapturedContentMessageIds(selectedContents);
      const failedSummary: GrandSummary = {
        version,
        generatedAt: new Date().toISOString(),
        upToMessageId: summarizedMessageIds[summarizedMessageIds.length - 1],
        coveredMessageIds: summarizedMessageIds,
        characterMemories: [],
        timeline: [],
        characterTable: [],
        rawText: '总结失败，请重新总结',
        isFailed: true, // 失败占位：不推进游标、不参与组装、不回喂下一轮AI
      };
      store.addSummary(failedSummary, failedSummary.upToMessageId, summarizedMessageIds);
      const msg = error?.message || String(error);
      try { window.toastr?.error(msg, '❌ 选定楼层总结失败：请重新总结', { timeOut: 8000, extendedTimeOut: 3000 }); } catch(_) {}
    } finally {
      store.setSummaryInProgress(false);
    }
  });
}

async function triggerManualHideFloors() {
  const ids = getParsedFloorIds(manualHideRange.value);
  if (ids.length === 0) {
    hiddenFloorActionResult.value = '请输入有效楼层号或范围';
    return;
  }

  try {
    const hiddenIds = await setFloorsHidden(ids, true, 'affected');
    hiddenFloorActionResult.value = `已隐藏 ${hiddenIds.length} 个楼层`;
    refreshHiddenFloors();
  } catch (error) {
    hiddenFloorActionResult.value = '隐藏失败';
    logError('大总结', '手动隐藏楼层失败', String(error));
  }
}

async function unhideFloor(messageId: number) {
  try {
    await setFloorsHidden([messageId], false, 'affected');
    hiddenFloorActionResult.value = `已取消隐藏 #${messageId}`;
    refreshHiddenFloors();
  } catch (error) {
    hiddenFloorActionResult.value = `取消隐藏 #${messageId} 失败`;
    logError('大总结', '取消隐藏楼层失败', String(error));
  }
}

// 手动触发梦呓分析
async function triggerManualDreamtalk() {
  if (store.userInputRecords.length === 0) {
    logInfo('梦呓', '没有可用的用户输入记录');
    return;
  }

  store.setDreamtalkInProgress(true);
  logInfo('梦呓', '手动触发分析');

  try {
    const { dreamtalk: result, nsfwDreamtalk } = await executeDreamtalkAnalysis(store.userInputRecords, store.persona.rawInput, store.dreamtalk, undefined, store.getUserName(), store.getBlacklistedCharacters());
    store.updateDreamtalk(result);
    if (nsfwDreamtalk) {
      store.updateNsfwDreamtalk(nsfwDreamtalk);
    }
    logInfo('梦呓', `分析完成 (${result.characterInteractions.length} 角色)`);
  } catch (error: any) {
    logError('梦呓', '分析失败', String(error));
    const msg = error?.message || String(error);
    try { window.toastr?.error(msg, '❌ 梦呓分析失败', { timeOut: 8000, extendedTimeOut: 3000 }); } catch(_) {}
  } finally {
    store.setDreamtalkInProgress(false);
  }
}

// 手动为第0层开场白生成小总结+知识图谱（自动流程会跳过第0层，避免玩家填写信息界面浪费API）
async function triggerOpeningGraph() {
  const content = readAssistantExtractedContentAtFloor(0);
  if (!content || !isValidMainContent(content)) {
    try { window.toastr?.warning('第0层没有可处理的开场白正文', '为开场白生成图谱'); } catch (_) {}
    return;
  }
  if (openingGraphBusy.value) return;
  openingGraphBusy.value = true;
  logInfo('小总结', '手动为第0层开场白生成图谱');

  enqueueAnalysis('small_summary', async () => {
    try {
      const characterEntries = store.getCharacterNameEntries();
      const allNames = characterEntries.map(entry => entry.name);
      const userNameNorm = store.getUserName();
      const kgAutoOn = store.settings.kgAutoEnabled !== false;
      const baseGraphState = kgAutoOn
        ? store.getKnowledgeGraphStateForFloor(0)
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
            worldProgressMaterial: '',
          }
        : undefined;
      let { record, graphDiff, characterLocations: parsedCharLocs } = await executeSmallSummary(
        '', content, -1, 0, allNames, userNameNorm, kgOptions, characterEntries, undefined,
        store.getBlacklistedCharacters(),
      );
      record.presentCharacters = store.resolveKnownCharacterNames(record.presentCharacters, true);
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

      // 替换旧的第0层小总结（如果有）
      store.chatData.smallSummaries = (store.chatData.smallSummaries || []).filter(
        (s: any) => (s.floorRange?.end ?? s.floorRange?.start ?? -1) !== 0,
      );
      store.chatData.smallSummaries.push(record);

      if (kgAutoOn) {
        const baseGraph = baseGraphState.graph || createEmptyKnowledgeGraph();
        try {
          let nextGraph = baseGraph;
          if (graphDiff) {
            if (userNameNorm && graphDiff.add?.characters?.length) {
              graphDiff.add.characters = graphDiff.add.characters.filter(
                (c: any) => c.name && c.name.trim() !== userNameNorm,
              );
            }
            nextGraph = applyKnowledgeGraphDiff(baseGraph, graphDiff);
          }
          store.commitKnowledgeGraph(nextGraph, 0);
          logInfo('知识图谱', '开场白图谱已生成');
          try { window.toastr?.success('开场白图谱已生成', '为开场白生成图谱'); } catch (_) {}
        } catch (e) {
          logWarn('知识图谱', '开场白图谱合并失败', String(e));
          try { window.toastr?.error('开场白图谱合并失败', '为开场白生成图谱'); } catch (_) {}
        }
      } else {
        // 没开自动图谱，也同步一下角色位置
        if (parsedCharLocs?.length) {
          store.batchUpdateCharacterLocations(parsedCharLocs);
        } else if (record.presentCharacters?.length && record.location && record.location !== '未提及') {
          store.updateCharacterLocations(record.presentCharacters, record.location);
        }
      }
      store.forcePersist({ settings: false });
    } catch (error: any) {
      logError('小总结', '开场白图谱生成失败', String(error));
      try { window.toastr?.error(error?.message || String(error), '开场白图谱生成失败'); } catch (_) {}
    } finally {
      openingGraphBusy.value = false;
    }
  }, '0');
}

// 手动为当前楼层生成小总结（已有 ready 记录时按钮禁用；失败后可重试）
async function triggerFloorSummary() {
  const floor = currentFloor.value;
  const content = readAssistantExtractedContentAtFloor(floor);
  if (!content || !isValidMainContent(content)) {
    try { window.toastr?.warning(`第${floor}层没有可处理的正文`, '为当前楼层生成小总结'); } catch (_) {}
    return;
  }
  if (floorSummaryBusy.value) return;
  floorSummaryBusy.value = true;
  logInfo('小总结', `手动为第${floor}层生成小总结`);

  enqueueAnalysis('small_summary', async () => {
    try {
      const characterEntries = store.getCharacterNameEntries();
      const allNames = characterEntries.map(entry => entry.name);
      const userNameNorm = store.getUserName();
      const kgAutoOn = store.settings.kgAutoEnabled !== false;
      const baseGraphState = kgAutoOn
        ? store.getKnowledgeGraphStateForFloor(floor)
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
            worldProgressMaterial: '',
          }
        : undefined;
      let { record, graphDiff, characterLocations: parsedCharLocs } = await executeSmallSummary(
        '', content, floor, floor, allNames, userNameNorm, kgOptions, characterEntries, undefined,
        store.getBlacklistedCharacters(),
      );
      record.presentCharacters = store.resolveKnownCharacterNames(record.presentCharacters, true);
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

      // 替换该楼层的旧小总结（如果有）
      store.chatData.smallSummaries = (store.chatData.smallSummaries || []).filter(
        (s: any) => (s.floorRange?.end ?? s.floorRange?.start ?? -1) !== floor,
      );
      store.chatData.smallSummaries.push(record);

      if (record.status === 'failed') {
        logWarn('小总结', `第${floor}层小总结失败`, record.error || '');
        try { window.toastr?.error(record.error || '小总结失败', `第${floor}层小总结失败`); } catch (_) {}
      } else if (kgAutoOn) {
        const baseGraph = baseGraphState.graph || createEmptyKnowledgeGraph();
        try {
          let nextGraph = baseGraph;
          if (graphDiff) {
            if (userNameNorm && graphDiff.add?.characters?.length) {
              graphDiff.add.characters = graphDiff.add.characters.filter(
                (c: any) => c.name && c.name.trim() !== userNameNorm,
              );
            }
            nextGraph = applyKnowledgeGraphDiff(baseGraph, graphDiff);
          }
          store.commitKnowledgeGraph(nextGraph, floor);
          logInfo('知识图谱', `第${floor}层小总结已生成`);
          try { window.toastr?.success(`第${floor}层小总结已生成`, '为当前楼层生成小总结'); } catch (_) {}
        } catch (e) {
          logWarn('知识图谱', `第${floor}层图谱合并失败`, String(e));
          try { window.toastr?.error(`第${floor}层图谱合并失败`, '为当前楼层生成小总结'); } catch (_) {}
        }
      } else {
        // 没开自动图谱，也同步一下角色位置
        if (parsedCharLocs?.length) {
          store.batchUpdateCharacterLocations(parsedCharLocs);
        } else if (record.presentCharacters?.length && record.location && record.location !== '未提及') {
          store.updateCharacterLocations(record.presentCharacters, record.location);
        }
      }
      store.forcePersist({ settings: false });
    } catch (error: any) {
      logError('小总结', `第${floor}层小总结生成失败`, String(error));
      try { window.toastr?.error(error?.message || String(error), `第${floor}层小总结生成失败`); } catch (_) {}
    } finally {
      floorSummaryBusy.value = false;
    }
  }, String(floor));
}
</script>

<template>
  <div class="zhino-overview">
    <!-- 顶部：角色卡名标题 -->
    <div class="zhino-overview-header">
      <svg class="zhino-overview-header-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      <span class="zhino-overview-header-name">{{ charCardName }}</span>
    </div>

    <!-- 移动端：调度队列（桌面端在侧栏底部） -->
    <SchedulerPanel v-if="isMobile" />

    <!-- 状态仪表盘 -->
    <div class="zhino-stats-grid zn-stagger">
      <div class="zhino-stat-card">
        <svg class="zhino-stat-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12l6 3 6-3-6-3-6 3zM2 16l6 3 6-3"/></svg>
        <div class="zhino-stat-value">{{ currentFloor }}</div>
        <div class="zhino-stat-label">当前楼层</div>
      </div>
      <div class="zhino-stat-card">
        <svg class="zhino-stat-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        <div class="zhino-stat-value">{{ nextSummaryIn }}</div>
        <div class="zhino-stat-label">距下次总结</div>
      </div>
      <div class="zhino-stat-card">
        <svg class="zhino-stat-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10" /></svg>
        <div class="zhino-stat-value">{{ summaryCount }}</div>
        <div class="zhino-stat-label">总结次数</div>
      </div>
      <div class="zhino-stat-card">
        <svg class="zhino-stat-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4V3z" /></svg>
        <div class="zhino-stat-value">{{ effectiveContentCount }}</div>
        <div class="zhino-stat-label">有效正文</div>
      </div>
      <div class="zhino-stat-card">
        <svg class="zhino-stat-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" /></svg>
        <div class="zhino-stat-value">{{ store.chatData.worldProgressRecords?.length || 0 }}</div>
        <div class="zhino-stat-label">世界推进</div>
      </div>
      <div class="zhino-stat-card">
        <svg class="zhino-stat-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 15h18M9 4v16M15 4v16" /></svg>
        <div class="zhino-stat-value">{{ store.chatData.plotOutline?.status === 'active' ? '活跃' : store.chatData.plotOutline?.status || '无' }}</div>
        <div class="zhino-stat-label">剧情导演</div>
      </div>
      <div class="zhino-stat-card">
        <svg class="zhino-stat-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>
        <div class="zhino-stat-value">{{ store.chatData.dynamicProfilesV2?.length || 0 }}</div>
        <div class="zhino-stat-label">人设V2</div>
      </div>
      <div class="zhino-stat-card">
        <svg class="zhino-stat-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l9-4 9 4v10l-9 4-9-4V7zM3 7l9 4 9-4M12 11v10" /></svg>
        <div class="zhino-stat-value">{{ store.chatData.knowledgeGraph?.items?.length || 0 }}</div>
        <div class="zhino-stat-label">物品库</div>
      </div>
    </div>

    <!-- 已激活角色 -->
    <div class="zhino-section zhino-icon-section">
      <div class="zhino-section-title">
        <svg class="zhino-section-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        已激活角色
      </div>
      <div v-if="activeCharacters.length === 0" class="zhino-empty-hint">暂无（完成首次大总结后显示）</div>
      <div v-else class="zhino-tag-list">
        <span v-for="name in activeCharacters" :key="name" class="zhino-tag">{{ name }}</span>
      </div>
    </div>

    <!-- 梦呓状态 -->
    <div class="zhino-section zhino-icon-section">
      <div class="zhino-section-title">
        <svg class="zhino-section-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        梦呓状态
      </div>
      <div class="zhino-info-row">
        <span class="zhino-info-label">分析状态：</span>
        <span class="zhino-info-value">{{ dreamtalkStatus }}</span>
      </div>
      <div v-if="store.dreamtalk" class="zhino-info-row">
        <span class="zhino-info-label">游玩类型：</span>
        <span class="zhino-info-value">{{ store.dreamtalk.playStyle }}</span>
      </div>
    </div>

    <!-- 大总结状态 -->
    <div v-if="latestSummary" class="zhino-section">
      <div class="zhino-section-header">
        <div class="zhino-section-title">
          <svg class="zhino-section-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/><path d="M19 14l2 2-4 4"/></svg>
          大总结 v{{ latestSummary.version }}{{ store.getCoveredFloorsDisplay() }}
        </div>
        <div class="zhino-section-actions">
          <button
            class="zhino-btn-sm"
            style="color:#ff6b6b;border:1px solid rgba(255,100,100,0.3)"
            @click="store.rollbackSummary()"
          >撤回</button>
          <button
            class="zhino-btn-sm"
            style="color:#4caf50;border:1px solid rgba(76,175,80,0.3)"
            @click="store.restoreLastSummary()"
          >恢复</button>
          <button
            class="zhino-btn-sm zhino-btn-warn"
            :disabled="summaryBusy"
            @click="triggerRedoSummary"
          >
            {{ summaryBusy ? '重做中...' : '重新总结' }}
          </button>
        </div>
      </div>
      <div class="zhino-info-row">
        <span class="zhino-info-label">生成时间:</span>
        <span class="zhino-info-value">{{ latestSummary.generatedAt?.slice(0, 16) }}</span>
      </div>
      <div class="zhino-info-row">
        <span class="zhino-info-label">角色数:</span>
        <span class="zhino-info-value">{{ latestSummary.characterMemories?.length || 0 }}</span>
        <span class="zhino-info-label" style="margin-left:12px">事件数:</span>
        <span class="zhino-info-value">{{ latestSummary.timeline?.length || 0 }}</span>
      </div>
    </div>

    <!-- 批量总结 -->
    <BatchSummaryPanel />

    <!-- 手动触发按钮 -->
    <div class="zhino-section">
      <div class="zhino-section-title">手动触发</div>
      <div class="zhino-btn-row">
        <button
          class="zhino-btn"
          :disabled="summaryBusy || summarizableCount === 0"
          @click="triggerManualSummary"
        >
          {{ summaryBusy ? '总结中...' : `大总结 (${summarizableCount} 条可总结)` }}
        </button>
        <button
          class="zhino-btn"
          :disabled="store.dreamtalkInProgress || store.userInputRecords.length === 0"
          @click="triggerManualDreamtalk"
        >
          {{ store.dreamtalkInProgress ? '分析中...' : '梦呓分析' }}
        </button>
        <button
          class="zhino-btn"
          :disabled="!canTriggerFloorSummary || floorSummaryBusy"
          @click="triggerFloorSummary"
        >
          {{ floorSummaryBusy ? '生成中...' : (currentFloorSummary?.status === 'failed' ? '重试当前楼层小总结' : '为当前楼层生成小总结') }}
        </button>
      </div>

      <div class="zhino-sub-control">
        <div class="zhino-sub-title">选定楼层总结</div>
        <div class="zhino-input-row">
          <input
            v-model="selectedSummaryRange"
            class="zhino-input"
            placeholder="如 2-16 或 1,3,5,7-10" aria-label="如 2-16 或 1,3,5,7-10"
          >
          <button
            class="zhino-btn"
            :disabled="summaryBusy || selectedSummaryCount === 0"
            @click="triggerSelectedSummary"
          >
            {{ summaryBusy ? '总结中...' : `总结 (${selectedSummaryCount})` }}
          </button>
        </div>
        <div v-if="selectedSummaryResult" class="zhino-load-result">{{ selectedSummaryResult }}</div>
      </div>
    </div>

    <details class="zhino-section zhino-hidden-section">
      <summary class="zhino-hidden-summary">
        <span>已隐藏楼层</span>
        <span class="zhino-hidden-count">{{ hiddenFloors.length }}</span>
      </summary>

      <div class="zhino-sub-control zhino-sub-control-compact">
        <div class="zhino-input-row">
          <input
            v-model="manualHideRange"
            class="zhino-input"
            placeholder="输入楼层号或范围" aria-label="输入楼层号或范围"
          >
          <button
            class="zhino-btn"
            :disabled="manualHideCount === 0"
            @click="triggerManualHideFloors"
          >
            隐藏 ({{ manualHideCount }})
          </button>
        </div>
        <div v-if="hiddenFloorActionResult" class="zhino-load-result">{{ hiddenFloorActionResult }}</div>
      </div>

      <div v-if="hiddenFloors.length === 0" class="zhino-empty-hint">暂无隐藏楼层</div>
      <div v-else class="zhino-hidden-list">
        <div
          v-for="floor in hiddenFloors"
          :key="floor.messageId"
          class="zhino-hidden-item"
        >
          <div class="zhino-hidden-main">
            <span class="zhino-hidden-id">#{{ floor.messageId }}</span>
            <span class="zhino-hidden-role">{{ getRoleLabel(floor.role) }}</span>
            <span class="zhino-hidden-text">{{ floor.summary }}</span>
          </div>
          <button class="zhino-btn-sm" @click="unhideFloor(floor.messageId)">取消隐藏</button>
        </div>
      </div>
    </details>
  </div>
</template>

<style scoped>
.zhino-overview {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 4px;
}

/* 顶部角色卡名标题 */
.zhino-overview-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 2px 6px;
  flex-shrink: 0;
}
.zhino-overview-header-icon {
  color: var(--zn-accent);
  flex-shrink: 0;
}
.zhino-overview-header-name {
  font-size: 16px;
  font-weight: 700;
  color: var(--zn-text-primary);
  letter-spacing: 0.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.zhino-stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--zn-space-2);
}
.zhino-stat-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--zn-space-1);
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-light);
  border-radius: var(--zn-radius);
  padding: var(--zn-space-3) var(--zn-space-2);
  text-align: center;
  transition: transform var(--zn-dur) var(--zn-ease), border-color var(--zn-dur) var(--zn-ease), box-shadow var(--zn-dur) var(--zn-ease), background var(--zn-dur) var(--zn-ease);
}
.zhino-stat-card:hover {
  background: var(--zn-bg-surface2);
  border-color: rgba(var(--zn-accent-rgb), 0.4);
  box-shadow: var(--zn-glow-accent);
  transform: translateY(-2px);
}
.zhino-stat-icon {
  color: var(--zn-text-muted);
  transition: color var(--zn-dur) var(--zn-ease);
}
.zhino-stat-card:hover .zhino-stat-icon { color: var(--zn-accent); }
.zhino-stat-value {
  font-size: var(--zn-fs-display);
  font-weight: 700;
  color: var(--zn-accent);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.zhino-stat-label {
  font-size: var(--zn-fs-label);
  letter-spacing: 0.04em;
  color: var(--zn-text-muted);
}
@media (max-width: 768px) {
  .zhino-stats-grid { grid-template-columns: repeat(2, 1fr); }
}

.zhino-section {
  background: var(--zn-glass-bg, var(--zn-bg-surface1));
  border: 1px solid var(--zn-border-light);
  border-radius: 12px;
  padding: 12px;
}
.zhino-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--zn-text-regular);
  margin-bottom: 8px;
  letter-spacing: 0.5px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.zhino-section-icon {
  color: var(--zn-text-muted);
  flex-shrink: 0;
}
.zhino-icon-section .zhino-section-icon { color: var(--zn-accent); }

.zhino-empty-hint {
  font-size: 12px;
  color: var(--zn-text-muted);
}

.zhino-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.zhino-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(var(--zn-accent-rgb), 0.12);
  color: rgba(var(--zn-accent-rgb), 0.8);
  border: 1px solid rgba(var(--zn-accent-rgb), 0.2);
}

.zhino-info-row {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  margin-bottom: 4px;
}
.zhino-info-label {
  color: var(--zn-text-muted);
}
.zhino-info-value {
  color: var(--zn-text-primary);
}

.zhino-btn-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.zhino-btn {
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid var(--zn-border-base);
  background: transparent;
  color: var(--zn-text-regular);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-btn:hover:not(:disabled) {
  background: var(--zn-bg-surface2);
  color: var(--zn-text-primary);
  border-color: var(--zn-border-light);
}
.zhino-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.zhino-btn-primary {
  background: var(--zn-primary);
  color: #000;
  border: 1px solid var(--zn-primary);
  font-weight: 600;
}
.zhino-btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
  background: var(--zn-primary);
  color: #000;
}

.zhino-load-result {
  margin-top: 6px;
  font-size: 11px;
  color: var(--zn-text-muted);
}

.zhino-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  gap: 8px;
}

.zhino-section-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.zhino-btn-sm {
  padding: 4px 10px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: var(--zn-bg-surface2);
  color: var(--zn-text-regular);
  cursor: pointer;
  transition: all 0.15s;
}
.zhino-btn-sm:hover {
  background: var(--zn-bg-surface2);
  color: var(--zn-text-primary);
}
.zhino-btn-sm:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.zhino-btn-save {
  border-color: rgba(var(--zn-accent-rgb), 0.3);
  color: rgba(var(--zn-accent-rgb), 0.9);
}
.zhino-btn-save:hover {
  background: rgba(var(--zn-accent-rgb), 0.15);
}
.zhino-btn-warn {
  border-color: rgba(245, 158, 11, 0.28);
  color: rgba(var(--zn-warn-rgb), 0.9);
}
.zhino-btn-warn:hover:not(:disabled) {
  background: rgba(245, 158, 11, 0.12);
}

.zhino-sub-control {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--zn-border-light);
}
.zhino-sub-control-compact {
  margin-top: 8px;
  padding-top: 0;
  border-top: 0;
}
.zhino-sub-title {
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--zn-text-muted);
}
.zhino-input-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.zhino-input {
  min-width: 0;
  flex: 1;
  height: 30px;
  border: 1px solid var(--zn-border-base);
  border-radius: 4px;
  background: var(--zn-bg-surface1);
  color: var(--zn-text-regular);
  outline: none;
  padding: 0 9px;
  font-size: 12px;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-input:focus {
  border-color: var(--zn-primary);
  background: var(--zn-surface-sunken);
}
.zhino-input::placeholder {
  color: var(--zn-text-muted);
}

.zhino-hidden-section {
  padding-top: 0;
}
.zhino-hidden-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 10px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--zn-text-regular);
  list-style: none;
}
.zhino-hidden-summary::-webkit-details-marker {
  display: none;
}
.zhino-hidden-count {
  min-width: 24px;
  border-radius: 999px;
  background: rgba(var(--zn-accent-rgb), 0.12);
  color: rgba(var(--zn-accent-rgb), 0.9);
  text-align: center;
  font-size: 11px;
  line-height: 20px;
}
.zhino-hidden-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.zhino-hidden-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 0;
  border-top: 1px solid var(--zn-border-light);
}
.zhino-hidden-main {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
}
.zhino-hidden-id {
  flex: 0 0 auto;
  color: rgba(var(--zn-accent-rgb), 0.9);
  font-weight: 600;
}
.zhino-hidden-role {
  flex: 0 0 auto;
  color: var(--zn-text-muted);
}
.zhino-hidden-text {
  min-width: 0;
  overflow: hidden;
  color: var(--zn-text-regular);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.zhino-textarea {
  width: 100%;
  background: var(--zn-surface-sunken);
  border: 1px solid var(--zn-border-light);
  border-radius: 6px;
  padding: 8px;
  font-size: 12px;
  color: var(--zn-text-primary);
  resize: vertical;
  outline: none;
  font-family: var(--zn-font-mono);
  margin-top: 6px;
  margin-bottom: 6px;
}
.zhino-textarea:focus {
  border-color: rgba(var(--zn-accent-rgb), 0.4);
}
.zhino-textarea-lg {
  min-height: 200px;
}

.zhino-detail-label {
  font-size: 11px;
  color: var(--zn-text-muted);
  margin-bottom: 4px;
  margin-top: 6px;
}
</style>
