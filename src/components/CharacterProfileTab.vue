<template>
  <div class="character-profile-tab">
    <!-- 操作区 -->
    <div class="zhino-section">
      <div class="zhino-section-header">
        <div class="zhino-section-title">生成角色设定</div>
      </div>

      <div class="cp-form">
        <div class="cp-form-row">
          <label class="cp-label">选择角色</label>
          <select class="zhino-input cp-select" v-model="selectedNpc">
            <option value="">— 请选择 NPC —</option>
            <option v-for="name in characterNames" :key="name" :value="name">{{ name }}</option>
          </select>
        </div>

        <div class="cp-form-row">
          <label class="cp-label">楼层范围</label>
          <input
            class="zhino-input cp-floor-input"
            type="number"
            v-model.number="startFloor"
            placeholder="起始"
            min="0"
          />
          <span class="cp-floor-sep">—</span>
          <input
            class="zhino-input cp-floor-input"
            type="number"
            v-model.number="endFloor"
            placeholder="结束"
            min="0"
          />
          <span class="cp-floor-hint" v-if="maxFloor > 0">当前最大楼层 #{{ maxFloor }}</span>
        </div>

        <div class="cp-form-row">
          <label class="cp-label">生成范围</label>
          <label class="cp-checkbox-label">
            <input type="checkbox" v-model="fullMode" />
            全套模式（追加核心人格层 + 意象）
          </label>
          <span class="cp-mode-hint">{{ fullMode ? '5项完整版' : '3项轻量版（默认）' }}</span>
        </div>

        <div class="cp-form-row">
          <button
            class="zhino-btn-sm zhino-btn-save cp-generate-btn"
            :disabled="!canGenerate || isGenerating"
            @click="generateProfile"
          >
            {{ isGenerating ? '生成中...' : (hasCurrentProfile ? '重新生成（覆盖当前）' : '生成角色设定') }}
          </button>
          <button
            v-if="hasCurrentProfile && !isGenerating"
            class="zhino-btn-sm cp-save-btn"
            @click="saveToHistory"
          >保存人设</button>
          <button
            v-if="!isGenerating"
            class="zhino-btn-sm cp-history-btn"
            @click="showHistory = true"
          >历史人设</button>
        </div>
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="errorMsg" class="cp-error">
      {{ errorMsg }}
    </div>

    <!-- 保存成功提示 -->
    <div v-if="savedMsg" class="cp-saved-msg">
      {{ savedMsg }}
    </div>

    <!-- 结果展示 -->
    <div v-if="hasCurrentProfile" class="zhino-section cp-result">
      <div class="zhino-section-header">
        <div class="zhino-section-title">{{ selectedNpc }} 的角色设定</div>
        <span class="cp-meta">{{ currentProfile.fullMode ? '全套' : '轻量' }} · {{ formatTime(currentProfile.generatedAt) }}</span>
      </div>

      <!-- 基础信息 -->
      <div class="zhino-detail-block">
        <div class="zhino-detail-label">基础信息</div>
        <div class="cp-field"><span class="cp-field-label">身份：</span>{{ currentProfile.basicInfo.identity }}</div>
        <div class="cp-field"><span class="cp-field-label">外貌：</span><pre class="cp-pre">{{ currentProfile.basicInfo.appearance }}</pre></div>
        <div class="cp-field"><span class="cp-field-label">背景：</span><pre class="cp-pre">{{ currentProfile.basicInfo.background }}</pre></div>
        <div class="cp-field"><span class="cp-field-label">与玩家关系：</span>{{ currentProfile.basicInfo.relationToUser }}</div>
      </div>

      <!-- 调色盘 -->
      <div class="zhino-detail-block">
        <div class="zhino-detail-label">调色盘</div>
        <div class="cp-palette-explanation">{{ currentProfile.colorPalette.explanation }}</div>
        <div class="cp-palette-colors">
          <div class="cp-palette-color"><span class="cp-color-label">底色</span><span class="cp-color-value">{{ currentProfile.colorPalette.base }}</span></div>
          <div class="cp-palette-color"><span class="cp-color-label">主色调</span><span class="cp-color-value">{{ currentProfile.colorPalette.primary }}</span></div>
          <div class="cp-palette-color" v-for="(acc, i) in currentProfile.colorPalette.accents" :key="i">
            <span class="cp-color-label">点缀</span><span class="cp-color-value">{{ acc }}</span>
          </div>
        </div>
        <div class="cp-derivatives">
          <div class="cp-derivatives-label">衍生画面</div>
          <div v-for="(d, i) in currentProfile.colorPalette.derivatives" :key="i" class="cp-derivative-item">{{ d }}</div>
        </div>
      </div>

      <!-- 二次解释 -->
      <div class="zhino-detail-block">
        <div class="zhino-detail-label">二次解释</div>
        <div v-for="(item, i) in currentProfile.secondaryExplanation" :key="i" class="cp-explanation-item">
          <div class="cp-explanation-topic">{{ item.topic }}</div>
          <div class="cp-explanation-content">{{ item.content }}</div>
        </div>
      </div>

      <!-- 核心人格层（全套才显示） -->
      <div v-if="currentProfile.corePersonality" class="zhino-detail-block">
        <div class="zhino-detail-label">核心人格层</div>
        <div class="cp-field"><span class="cp-field-label">表层欲望：</span>{{ currentProfile.corePersonality.surfaceDesire }}</div>
        <div class="cp-field"><span class="cp-field-label">深层缺失：</span>{{ currentProfile.corePersonality.deepLack }}</div>
        <div class="cp-field"><span class="cp-field-label">核心恐惧：</span>{{ currentProfile.corePersonality.coreFear }}</div>
        <div class="cp-field"><span class="cp-field-label">防御机制：</span>{{ currentProfile.corePersonality.defenseMechanism }}</div>
        <div class="cp-field"><span class="cp-field-label">核心矛盾：</span>{{ currentProfile.corePersonality.coreConflict }}</div>
        <div class="cp-field"><span class="cp-field-label">道德底线：</span>{{ currentProfile.corePersonality.moralBottomLine }}</div>
        <div class="cp-field"><span class="cp-field-label">自我认知：</span>{{ currentProfile.corePersonality.selfAwareness }}</div>
      </div>

      <!-- 意象（全套才显示） -->
      <div v-if="currentProfile.imagery" class="zhino-detail-block">
        <div class="zhino-detail-label">意象</div>
        <pre class="cp-pre cp-imagery">{{ currentProfile.imagery }}</pre>
      </div>

      <!-- 参考角色溯源 -->
      <div v-if="currentProfile.literaryReferences.length > 0" class="zhino-detail-block">
        <div class="zhino-detail-label">参考角色溯源</div>
        <div v-for="(ref, i) in currentProfile.literaryReferences" :key="i" class="cp-ref-item">
          <span class="cp-ref-character">{{ ref.character }}</span>
          <span class="cp-ref-work">《{{ ref.work }}》</span>
          <div class="cp-ref-traits">借鉴：{{ ref.borrowedTraits }}</div>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else-if="!isGenerating && !errorMsg" class="cp-empty">
      选择 NPC 和楼层范围后，点击「生成角色设定」
    </div>

    <!-- 历史人设弹窗 -->
    <div v-if="showHistory" class="cp-modal-overlay" @click.self="showHistory = false">
      <div class="cp-modal">
        <div class="cp-modal-header">
          <span>历史人设</span>
          <button class="cp-modal-close" @click="showHistory = false">×</button>
        </div>
        <div class="cp-modal-body">
          <div v-if="savedProfiles.length === 0" class="cp-empty">暂无保存的人设</div>
          <div v-for="(item, i) in savedProfiles" :key="i" class="cp-history-item">
            <div class="cp-history-info">
              <span class="cp-history-name">{{ item.name }}</span>
              <span class="cp-history-meta">{{ item.profile.fullMode ? '全套' : '轻量' }} · {{ formatTime(item.savedAt) }}</span>
            </div>
            <div class="cp-history-actions">
              <button class="zhino-btn-sm" @click="loadHistory(i)">加载</button>
              <button class="zhino-btn-sm cp-clear-btn" @click="deleteHistory(i)">删除</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useMainStore } from '../stores/mainStore';
import type { CharacterProfile } from '../stores/mainStore';
import { executeCharacterProfile } from '../core/characterProfile';
import { logError } from '../utils/logger';
import { readAssistantContentsInRange } from '../utils/chatContent';

const store = useMainStore();

// 表单状态
const selectedNpc = ref('');
const startFloor = ref(0);
const endFloor = ref(0);
const fullMode = ref(false);

// 生成状态
const isGenerating = ref(false);
const errorMsg = ref('');
const savedMsg = ref('');

// 历史弹窗
const showHistory = ref(false);

// 角色列表：统一走 store 角色索引。
const characterNames = computed(() => {
  try {
    return store.getAllCharacterNames();
  } catch (e) {
    logError('角色设定', '角色列表读取异常', String(e));
    return [];
  }
});

// 当前最大楼层
const maxFloor = computed(() => {
  void store.chatContentRevision;
  let lastId = 0;
  try { lastId = getLastMessageId(); } catch { lastId = 0; }
  const contents = readAssistantContentsInRange(0, lastId, store.chatData.capturedContents);
  if (!contents || contents.length === 0) return 0;
  return Math.max(...contents.map(c => c.messageId));
});

// 当前角色设定（从 store 读取，切页面不丢失）
const currentProfile = computed<CharacterProfile | undefined>(() => {
  if (!selectedNpc.value) return undefined;
  return store.getCharacterProfile(selectedNpc.value);
});

const hasCurrentProfile = computed(() => !!currentProfile.value);

// 历史保存的人设列表
const savedProfiles = computed(() => {
  return store.chatData.savedCharacterProfiles || [];
});

// 是否可生成
const canGenerate = computed(() => {
  return selectedNpc.value
    && Number.isFinite(startFloor.value)
    && Number.isFinite(endFloor.value)
    && startFloor.value <= endFloor.value
    && startFloor.value >= 0;
});

// 生成（直接覆盖当前，不保存旧的）
async function generateProfile() {
  if (!canGenerate.value || isGenerating.value) return;
  errorMsg.value = '';
  savedMsg.value = '';
  isGenerating.value = true;
  try {
    const contents = readAssistantContentsInRange(startFloor.value, endFloor.value, store.chatData.capturedContents);
    const profile = await executeCharacterProfile({
      npcName: selectedNpc.value,
      startFloor: startFloor.value,
      endFloor: endFloor.value,
      fullMode: fullMode.value,
      capturedContents: contents,
      userName: (store as any).userName || '{{user}}',
    });
    // 直接覆盖当前人设，不保存旧的
    store.setCharacterProfile(selectedNpc.value, profile);
  } catch (e: any) {
    logError('角色设定', '生成失败', e);
    errorMsg.value = `生成失败：${e?.message || String(e)}`;
  } finally {
    isGenerating.value = false;
  }
}

// 保存到历史
function saveToHistory() {
  if (!selectedNpc.value || !currentProfile.value) return;
  const ok = store.saveCharacterProfileToHistory(selectedNpc.value, currentProfile.value);
  if (ok) {
    savedMsg.value = '已保存到历史人设';
    setTimeout(() => { savedMsg.value = ''; }, 2000);
  } else {
    errorMsg.value = '保存失败';
  }
}

// 加载历史人设到当前
function loadHistory(index: number) {
  const profile = store.loadSavedCharacterProfile(index);
  if (profile && selectedNpc.value) {
    store.setCharacterProfile(selectedNpc.value, profile);
    showHistory.value = false;
    savedMsg.value = '已加载历史人设';
    setTimeout(() => { savedMsg.value = ''; }, 2000);
  }
}

// 删除历史人设
function deleteHistory(index: number) {
  if (!confirm('确定删除这条历史人设吗？')) return;
  store.removeSavedCharacterProfile(index);
}

// 删除当前人设
function clearProfile() {
  if (!selectedNpc.value) return;
  if (!confirm(`确定删除 ${selectedNpc.value} 的当前角色设定吗？`)) return;
  store.removeCharacterProfile(selectedNpc.value);
}

// 选中角色时自动填充楼层范围
watch(selectedNpc, (name) => {
  if (!name) return;
  // 默认填整个范围
  if (maxFloor.value > 0) {
    startFloor.value = Math.max(0, maxFloor.value - 20);
    endFloor.value = maxFloor.value;
  }
});

// 格式化时间
function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}
</script>

<style scoped>
.character-profile-tab {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--zn-space-3);
}

.cp-form {
  display: flex;
  flex-direction: column;
  gap: var(--zn-space-2);
}
.cp-form-row {
  display: flex;
  align-items: center;
  gap: var(--zn-space-2);
  flex-wrap: wrap;
}
.cp-label {
  font-size: 12px;
  color: var(--zn-text-secondary);
  min-width: 60px;
}
.cp-select {
  flex: 1;
  min-width: 150px;
}
.cp-floor-input {
  width: 80px;
}
.cp-floor-sep {
  color: var(--zn-text-tertiary);
}
.cp-floor-hint {
  font-size: 11px;
  color: var(--zn-text-tertiary);
}
.cp-checkbox-label {
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
}
.cp-mode-hint {
  font-size: 11px;
  color: var(--zn-text-tertiary);
}
.cp-generate-btn {
  padding: 4px 16px;
}
.cp-generate-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.cp-save-btn {
  margin-left: 8px;
}
.cp-history-btn {
  margin-left: 4px;
}
.cp-clear-btn {
  margin-left: 4px;
}

.cp-error {
  color: var(--zn-danger, #e24b4a);
  font-size: 12px;
  padding: var(--zn-space-2);
  margin-top: var(--zn-space-2);
  background: var(--zn-danger-bg, rgba(226,75,74,0.1));
  border-radius: var(--zn-radius, 6px);
}

.cp-saved-msg {
  color: var(--zn-success, #1d9e75);
  font-size: 12px;
  padding: var(--zn-space-2);
  margin-top: var(--zn-space-2);
  background: var(--zn-success-bg, rgba(29,158,117,0.1));
  border-radius: var(--zn-radius, 6px);
}

.cp-empty {
  text-align: center;
  color: var(--zn-text-tertiary);
  font-size: 13px;
  padding: var(--zn-space-4);
}

.cp-result {
  margin-top: var(--zn-space-3);
}
.cp-meta {
  font-size: 11px;
  color: var(--zn-text-tertiary);
  margin-left: auto;
}

.cp-field {
  font-size: 12px;
  line-height: 1.6;
  margin: 4px 0;
}
.cp-field-label {
  color: var(--zn-text-secondary);
  font-weight: 500;
}
.cp-pre {
  font-family: inherit;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-wrap: break-word;
  margin: 2px 0;
}
.cp-imagery {
  font-style: italic;
  padding: var(--zn-space-2);
  background: var(--zn-bg-secondary, rgba(0,0,0,0.03));
  border-radius: var(--zn-radius, 6px);
}

.cp-palette-explanation {
  font-size: 12px;
  color: var(--zn-text-secondary);
  font-style: italic;
  margin-bottom: var(--zn-space-2);
}
.cp-palette-colors {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--zn-space-2);
}
.cp-palette-color {
  display: flex;
  gap: 8px;
  font-size: 12px;
  align-items: baseline;
}
.cp-color-label {
  color: var(--zn-text-tertiary);
  min-width: 50px;
}
.cp-color-value {
  color: var(--zn-text-primary);
}
.cp-derivatives {
  margin-top: var(--zn-space-2);
}
.cp-derivatives-label {
  font-size: 11px;
  color: var(--zn-text-tertiary);
  margin-bottom: 4px;
}
.cp-derivative-item {
  font-size: 12px;
  line-height: 1.6;
  padding: 2px 0 2px 12px;
  border-left: 2px solid var(--zn-border, rgba(0,0,0,0.1));
  margin-bottom: 2px;
}

.cp-explanation-item {
  margin-bottom: var(--zn-space-2);
}
.cp-explanation-topic {
  font-size: 12px;
  font-weight: 500;
  color: var(--zn-text-secondary);
}
.cp-explanation-content {
  font-size: 12px;
  line-height: 1.6;
  color: var(--zn-text-primary);
  padding-left: 8px;
}

.cp-ref-item {
  font-size: 12px;
  margin-bottom: 6px;
}
.cp-ref-character {
  font-weight: 500;
}
.cp-ref-work {
  color: var(--zn-text-secondary);
  margin-left: 4px;
}
.cp-ref-traits {
  font-size: 11px;
  color: var(--zn-text-tertiary);
  padding-left: 12px;
}

/* 历史弹窗 */
.cp-modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.cp-modal {
  background: var(--zn-bg-primary, #fff);
  border-radius: var(--zn-radius-lg, 12px);
  max-width: 500px;
  width: 90%;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
}
.cp-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--zn-space-3);
  border-bottom: 1px solid var(--zn-border, rgba(0,0,0,0.1));
  font-size: 14px;
  font-weight: 500;
}
.cp-modal-close {
  background: none;
  border: none;
  font-size: 20px;
  cursor: pointer;
  color: var(--zn-text-tertiary);
  padding: 0 4px;
}
.cp-modal-body {
  padding: var(--zn-space-3);
  overflow-y: auto;
}
.cp-history-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--zn-border, rgba(0,0,0,0.05));
}
.cp-history-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cp-history-name {
  font-size: 13px;
  font-weight: 500;
}
.cp-history-meta {
  font-size: 11px;
  color: var(--zn-text-tertiary);
}
.cp-history-actions {
  display: flex;
  gap: 4px;
}
</style>
