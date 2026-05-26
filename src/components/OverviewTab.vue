<script setup lang="ts">
import { useMainStore, type CapturedContent } from '../stores/mainStore';
import { executeGrandSummary, getContentsSinceLast, PRESERVE_RECENT_COUNT } from '../core/summary';
import { executeDreamtalkAnalysis } from '../core/dreamtalk';
import {
  ensureRecentFloorsVisible,
  getCapturedContentMessageIds,
  hideCapturedContentsWithUsers,
  parseFloorRange,
  setFloorsHidden,
} from '../core/floorVisibility';

const store = useMainStore();

const isSummarizing = ref(false);
const isRedoingSummary = ref(false);
const isSelectedSummarizing = ref(false);
const isDreamtalkAnalyzing = ref(false);
const isLoadingHistory = ref(false);
const historyLoadResult = ref('');
const showSummaryEditor = ref(false);
const editingSummaryText = ref('');
const selectedSummaryRange = ref('');
const selectedSummaryResult = ref('');
const manualHideRange = ref('');
const hiddenFloorActionResult = ref('');
const hiddenFloorRefreshKey = ref(0);

// 状态计算
const currentFloor = computed(() => {
  try { return getLastMessageId(); } catch { return 0; }
});

const pendingCount = computed(() => {
  const newContents = store.capturedContents.filter(c => c.messageId > store.lastSummaryAtMessageId);
  return newContents.length;
});

const summarizableCount = computed(() =>
  Math.max(0, pendingCount.value - PRESERVE_RECENT_COUNT),
);

const nextSummaryIn = computed(() => {
  const remaining = store.settings.summaryInterval - pendingCount.value;
  return Math.max(0, remaining);
});

const activeCharacters = computed(() => store.getAllCharacterNames());

const dreamtalkStatus = computed(() => {
  if (!store.dreamtalk) return '未分析';
  return `v${store.dreamtalk.version} (${store.dreamtalk.characterInteractions.length} 角色)`;
});

const summaryCount = computed(() => store.summaries.length);
const summaryBusy = computed(() => isSummarizing.value || isRedoingSummary.value || isSelectedSummarizing.value);

const hiddenFloors = computed(() => {
  void hiddenFloorRefreshKey.value;
  return store.getHiddenFloors();
});

const manualHideCount = computed(() => getParsedFloorIds(manualHideRange.value).length);
const selectedSummaryCount = computed(() => getSelectedCapturedContents().length);

// 大总结编辑
const latestSummary = computed(() => store.getLatestSummary());

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
  return store.capturedContents
    .filter(content => selectedIds.has(content.messageId))
    .slice()
    .sort((a, b) => a.messageId - b.messageId);
}

function getRoleLabel(role: string): string {
  if (role === 'assistant') return 'AI';
  if (role === 'user') return '用户';
  if (role === 'system') return '系统';
  return role;
}

function openSummaryEditor() {
  showSummaryEditor.value = !showSummaryEditor.value;
  if (showSummaryEditor.value) {
    const summary = latestSummary.value;
    if (summary) {
      editingSummaryText.value = summary.rawText;
    }
  }
}

function saveSummaryEdit() {
  const summary = latestSummary.value;
  if (summary && editingSummaryText.value.trim()) {
    store.updateSummaryRawText(summary.version, editingSummaryText.value);
    showSummaryEditor.value = false;
  }
}

async function runGrandSummaryAndHide(
  contents: CapturedContent[],
  logPrefix: string,
) {
  const summarizedMessageIds = getCapturedContentMessageIds(contents);
  const summarizedUpTo = Math.max(
    store.lastSummaryAtMessageId,
    summarizedMessageIds[summarizedMessageIds.length - 1] ?? store.lastSummaryAtMessageId,
  );
  const previousSummary = store.getLatestSummary();
  const { summary, dynamicProfiles } = await executeGrandSummary(contents, previousSummary);

  store.addSummary(summary, summarizedUpTo, summarizedMessageIds);
  for (const profile of dynamicProfiles) {
    store.updateDynamicProfile(profile);
  }

  const hiddenIds = await hideCapturedContentsWithUsers(contents, 'affected');
  await ensureRecentFloorsVisible('affected');
  refreshHiddenFloors();
  console.info(`[智脑] ${logPrefix}大总结 v${summary.version} 完成，已隐藏 ${hiddenIds.length} 个楼层`);
  return { summary, hiddenIds };
}

// 手动触发大总结（排除最新4条AI发言）
async function triggerManualSummary() {
  const pending = getContentsSinceLast(store.capturedContents, store.lastSummaryAtMessageId);
  if (pending.length === 0) {
    console.info('[智脑] 排除最新楼层后没有待总结的正文日志');
    return;
  }

  isSummarizing.value = true;
  console.info('[智脑] 手动触发大总结...');

  try {
    const { summary } = await runGrandSummaryAndHide(pending, '手动');
    console.info(`[智脑] 大总结 v${summary.version} 完成 (${summary.characterMemories.length} 角色)`);
  } catch (error) {
    console.error('[智脑] 大总结失败:', error);
  } finally {
    isSummarizing.value = false;
  }
}

async function triggerRedoSummary() {
  if (!latestSummary.value || summaryBusy.value) return;

  isRedoingSummary.value = true;
  console.info('[智脑] 正在回退并重新生成最新大总结...');

  try {
    const removedSummary = store.rollbackSummary(true, false);
    if (!removedSummary) return;

    const coveredIds = new Set(removedSummary.coveredMessageIds ?? []);
    const contents = coveredIds.size > 0
      ? store.capturedContents.filter(content => coveredIds.has(content.messageId)).sort((a, b) => a.messageId - b.messageId)
      : getContentsSinceLast(store.capturedContents, store.lastSummaryAtMessageId);

    if (contents.length === 0) {
      console.info('[智脑] 回退后没有可重新总结的正文日志');
      return;
    }

    const { summary } = await runGrandSummaryAndHide(contents, '重新');
    console.info(`[智脑] 已重新生成大总结 v${summary.version}`);
  } catch (error) {
    console.error('[智脑] 重新总结失败:', error);
  } finally {
    isRedoingSummary.value = false;
  }
}

async function triggerSelectedSummary() {
  const selectedContents = getSelectedCapturedContents();
  if (selectedContents.length === 0) {
    selectedSummaryResult.value = '没有匹配到已捕获正文的 AI 楼层';
    console.info('[智脑] 选定楼层总结未匹配到正文日志');
    return;
  }

  isSelectedSummarizing.value = true;
  selectedSummaryResult.value = '';
  console.info(`[智脑] 选定楼层总结：${selectedContents.map(content => `#${content.messageId}`).join(', ')}`);

  try {
    const { summary, hiddenIds } = await runGrandSummaryAndHide(selectedContents, '选定楼层');
    selectedSummaryResult.value = `已生成 v${summary.version}，隐藏 ${hiddenIds.length} 个楼层`;
  } catch (error) {
    selectedSummaryResult.value = '选定楼层总结失败';
    console.error('[智脑] 选定楼层总结失败:', error);
  } finally {
    isSelectedSummarizing.value = false;
  }
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
    console.error('[智脑] 手动隐藏楼层失败:', error);
  }
}

async function unhideFloor(messageId: number) {
  try {
    await setFloorsHidden([messageId], false, 'affected');
    hiddenFloorActionResult.value = `已取消隐藏 #${messageId}`;
    refreshHiddenFloors();
  } catch (error) {
    hiddenFloorActionResult.value = `取消隐藏 #${messageId} 失败`;
    console.error('[智脑] 取消隐藏楼层失败:', error);
  }
}

// 读取历史楼层
async function triggerLoadHistory() {
  isLoadingHistory.value = true;
  historyLoadResult.value = '';
  try {
    const count = await store.loadHistoryFloors();
    historyLoadResult.value = `补录 ${count} 条`;
    console.info(`[智脑] 历史楼层读取完成，补录 ${count} 条`);
  } catch (error) {
    historyLoadResult.value = '读取失败';
    console.error('[智脑] 读取历史楼层失败:', error);
  } finally {
    isLoadingHistory.value = false;
  }
}

// 手动触发梦呓分析
async function triggerManualDreamtalk() {
  if (store.userInputRecords.length === 0) {
    console.info('[智脑] 没有可用的用户输入记录');
    return;
  }

  isDreamtalkAnalyzing.value = true;
  console.info('[智脑] 手动触发梦呓分析...');

  try {
    const { dreamtalk: result, nsfwDreamtalk } = await executeDreamtalkAnalysis(store.userInputRecords, store.persona.rawInput);
    store.updateDreamtalk(result);
    if (nsfwDreamtalk) {
      store.updateNsfwDreamtalk(nsfwDreamtalk);
    }
    console.info(`[智脑] 梦呓分析完成 (${result.characterInteractions.length} 角色交互模式)`);
  } catch (error) {
    console.error('[智脑] 梦呓分析失败:', error);
  } finally {
    isDreamtalkAnalyzing.value = false;
  }
}
</script>

<template>
  <div class="zhino-overview">
    <!-- 状态仪表盘 -->
    <div class="zhino-stats-grid">
      <div class="zhino-stat-card">
        <div class="zhino-stat-value">{{ currentFloor }}</div>
        <div class="zhino-stat-label">当前楼层</div>
      </div>
      <div class="zhino-stat-card">
        <div class="zhino-stat-value">{{ nextSummaryIn }}</div>
        <div class="zhino-stat-label">距下次总结</div>
      </div>
      <div class="zhino-stat-card">
        <div class="zhino-stat-value">{{ summaryCount }}</div>
        <div class="zhino-stat-label">总结次数</div>
      </div>
      <div class="zhino-stat-card">
        <div class="zhino-stat-value">{{ store.capturedContents.length }}</div>
        <div class="zhino-stat-label">捕获记录</div>
      </div>
    </div>

    <!-- 已激活角色 -->
    <div class="zhino-section">
      <div class="zhino-section-title">已激活角色</div>
      <div v-if="activeCharacters.length === 0" class="zhino-empty-hint">暂无（完成首次大总结后显示）</div>
      <div v-else class="zhino-tag-list">
        <span v-for="name in activeCharacters" :key="name" class="zhino-tag">{{ name }}</span>
      </div>
    </div>

    <!-- 梦呓状态 -->
    <div class="zhino-section">
      <div class="zhino-section-title">梦呓状态</div>
      <div class="zhino-info-row">
        <span class="zhino-info-label">分析状态：</span>
        <span class="zhino-info-value">{{ dreamtalkStatus }}</span>
      </div>
      <div v-if="store.dreamtalk" class="zhino-info-row">
        <span class="zhino-info-label">游玩类型：</span>
        <span class="zhino-info-value">{{ store.dreamtalk.playStyle }}</span>
      </div>
    </div>

    <!-- 大总结编辑 -->
    <div v-if="latestSummary" class="zhino-section">
      <div class="zhino-section-header">
        <div class="zhino-section-title">大总结 v{{ latestSummary.version }}{{ store.getCoveredFloorsDisplay() }}</div>
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
          <button class="zhino-btn-sm" @click="openSummaryEditor">
            {{ showSummaryEditor ? '收起' : '查看/编辑' }}
          </button>
          <button
            class="zhino-btn-sm zhino-btn-warn"
            :disabled="summaryBusy"
            @click="triggerRedoSummary"
          >
            {{ isRedoingSummary ? '重做中...' : '重新总结' }}
          </button>
        </div>
      </div>
      <div class="zhino-info-row">
        <span class="zhino-info-label">生成时间：</span>
        <span class="zhino-info-value">{{ latestSummary.generatedAt?.slice(0, 16) }}</span>
      </div>
      <div class="zhino-info-row">
        <span class="zhino-info-label">角色数：</span>
        <span class="zhino-info-value">{{ latestSummary.characterMemories?.length || 0 }}</span>
      </div>
      <template v-if="showSummaryEditor">
        <textarea
          v-model="editingSummaryText"
          class="zhino-textarea zhino-textarea-lg"
          rows="12"
          placeholder="大总结原文（可直接编辑）"
        />
        <div class="zhino-btn-row">
          <button class="zhino-btn-sm zhino-btn-save" @click="saveSummaryEdit">保存修改</button>
          <button class="zhino-btn-sm" @click="showSummaryEditor = false">取消</button>
        </div>
      </template>
    </div>

    <!-- 手动触发按钮 -->
    <div class="zhino-section">
      <div class="zhino-section-title">手动触发</div>
      <div class="zhino-btn-row">
        <button
          class="zhino-btn"
          :disabled="summaryBusy || summarizableCount === 0"
          @click="triggerManualSummary"
        >
          {{ isSummarizing ? '总结中...' : `大总结 (${summarizableCount} 条可总结)` }}
        </button>
        <button
          class="zhino-btn"
          :disabled="isDreamtalkAnalyzing || store.userInputRecords.length === 0"
          @click="triggerManualDreamtalk"
        >
          {{ isDreamtalkAnalyzing ? '分析中...' : '梦呓分析' }}
        </button>
        <button
          class="zhino-btn"
          :disabled="isLoadingHistory"
          @click="triggerLoadHistory"
        >
          {{ isLoadingHistory ? '读取中...' : '读取历史楼层' }}
        </button>
      </div>
      <div v-if="historyLoadResult" class="zhino-load-result">{{ historyLoadResult }}</div>

      <div class="zhino-sub-control">
        <div class="zhino-sub-title">选定楼层总结</div>
        <div class="zhino-input-row">
          <input
            v-model="selectedSummaryRange"
            class="zhino-input"
            placeholder="如 2-16 或 1,3,5,7-10"
          >
          <button
            class="zhino-btn"
            :disabled="summaryBusy || selectedSummaryCount === 0"
            @click="triggerSelectedSummary"
          >
            {{ isSelectedSummarizing ? '总结中...' : `总结 (${selectedSummaryCount})` }}
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
            placeholder="输入楼层号或范围"
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
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.zhino-stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
.zhino-stat-card {
  background: rgba(167, 139, 250, 0.06);
  border: 1px solid rgba(167, 139, 250, 0.12);
  border-radius: 8px;
  padding: 12px;
  text-align: center;
}
.zhino-stat-value {
  font-size: 20px;
  font-weight: 700;
  color: rgba(167, 139, 250, 0.9);
}
.zhino-stat-label {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  margin-top: 2px;
}

.zhino-section {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 10px 12px;
}
.zhino-section-title {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: 8px;
}

.zhino-empty-hint {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.3);
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
  background: rgba(167, 139, 250, 0.12);
  color: rgba(167, 139, 250, 0.8);
  border: 1px solid rgba(167, 139, 250, 0.2);
}

.zhino-info-row {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  margin-bottom: 4px;
}
.zhino-info-label {
  color: rgba(255, 255, 255, 0.4);
}
.zhino-info-value {
  color: rgba(255, 255, 255, 0.8);
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
  border: 1px solid rgba(167, 139, 250, 0.25);
  background: rgba(167, 139, 250, 0.08);
  color: rgba(167, 139, 250, 0.9);
  cursor: pointer;
  transition: all 0.15s;
}
.zhino-btn:hover:not(:disabled) {
  background: rgba(167, 139, 250, 0.18);
  border-color: rgba(167, 139, 250, 0.4);
}
.zhino-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.zhino-load-result {
  margin-top: 6px;
  font-size: 11px;
  color: rgba(167, 139, 250, 0.7);
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
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  transition: all 0.15s;
}
.zhino-btn-sm:hover {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.9);
}
.zhino-btn-sm:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.zhino-btn-save {
  border-color: rgba(167, 139, 250, 0.3);
  color: rgba(167, 139, 250, 0.9);
}
.zhino-btn-save:hover {
  background: rgba(167, 139, 250, 0.15);
}
.zhino-btn-warn {
  border-color: rgba(245, 158, 11, 0.28);
  color: rgba(251, 191, 36, 0.9);
}
.zhino-btn-warn:hover:not(:disabled) {
  background: rgba(245, 158, 11, 0.12);
}

.zhino-sub-control {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
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
  color: rgba(255, 255, 255, 0.45);
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
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.25);
  color: rgba(255, 255, 255, 0.86);
  outline: none;
  padding: 0 9px;
  font-size: 12px;
}
.zhino-input:focus {
  border-color: rgba(167, 139, 250, 0.4);
}
.zhino-input::placeholder {
  color: rgba(255, 255, 255, 0.28);
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
  color: rgba(255, 255, 255, 0.62);
  list-style: none;
}
.zhino-hidden-summary::-webkit-details-marker {
  display: none;
}
.zhino-hidden-count {
  min-width: 24px;
  border-radius: 999px;
  background: rgba(167, 139, 250, 0.12);
  color: rgba(167, 139, 250, 0.9);
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
  border-top: 1px solid rgba(255, 255, 255, 0.05);
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
  color: rgba(167, 139, 250, 0.9);
  font-weight: 600;
}
.zhino-hidden-role {
  flex: 0 0 auto;
  color: rgba(255, 255, 255, 0.42);
}
.zhino-hidden-text {
  min-width: 0;
  overflow: hidden;
  color: rgba(255, 255, 255, 0.72);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.zhino-textarea {
  width: 100%;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 8px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.85);
  resize: vertical;
  outline: none;
  font-family: monospace;
  margin-top: 6px;
  margin-bottom: 6px;
}
.zhino-textarea:focus {
  border-color: rgba(167, 139, 250, 0.4);
}
.zhino-textarea-lg {
  min-height: 200px;
}
</style>
