<script setup lang="ts">
import { useMainStore } from '../stores/mainStore';
import { executeDreamtalkAnalysis } from '../core/dreamtalk';

const store = useMainStore();

const editingGeneralBehaviors = ref('');
const editingCharInteraction = ref('');
const selectedInteractionChar = ref('');
const isEditingGeneral = ref(false);
const isEditingInteraction = ref(false);
const isEditingRollLikes = ref(false);
const isEditingRollDislikes = ref(false);
const editingRollLikes = ref('');
const editingRollDislikes = ref('');

// 梦呓数据
const dreamtalk = computed(() => store.dreamtalk);

// 角色交互列表
const interactionCharacters = computed(() => {
  if (!dreamtalk.value) return [];
  return dreamtalk.value.characterInteractions.map(i => i.characterName);
});

// 当前选中角色的交互模式
const selectedInteraction = computed(() => {
  if (!dreamtalk.value || !selectedInteractionChar.value) return null;
  return dreamtalk.value.characterInteractions.find(
    i => i.characterName === selectedInteractionChar.value,
  ) || null;
});

// 开始编辑通用行为
function startEditGeneral() {
  if (!dreamtalk.value) return;
  editingGeneralBehaviors.value = dreamtalk.value.generalBehaviors.join('\n');
  isEditingGeneral.value = true;
}

function saveGeneralBehaviors() {
  if (!dreamtalk.value) return;
  dreamtalk.value.generalBehaviors = editingGeneralBehaviors.value
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  store.updateDreamtalk({ ...dreamtalk.value });
  isEditingGeneral.value = false;
  console.info('[智脑] 通用行为模式已保存');
}

// 开始编辑角色交互
function startEditInteraction(charName: string) {
  selectedInteractionChar.value = charName;
  const interaction = dreamtalk.value?.characterInteractions.find(i => i.characterName === charName);
  editingCharInteraction.value = interaction?.interactions.join('\n') || '';
  isEditingInteraction.value = true;
}

function saveInteraction() {
  if (!dreamtalk.value || !selectedInteractionChar.value) return;
  const idx = dreamtalk.value.characterInteractions.findIndex(
    i => i.characterName === selectedInteractionChar.value,
  );
  if (idx !== -1) {
    dreamtalk.value.characterInteractions[idx].interactions = editingCharInteraction.value
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    store.updateDreamtalk({ ...dreamtalk.value });
  }
  isEditingInteraction.value = false;
  console.info(`[智脑] ${selectedInteractionChar.value} 交互模式已保存`);
}

// Roll偏好编辑
function startEditRollLikes() {
  if (!dreamtalk.value) return;
  editingRollLikes.value = dreamtalk.value.rollLikes.join('\n');
  isEditingRollLikes.value = true;
}

function saveRollLikes() {
  if (!dreamtalk.value) return;
  dreamtalk.value.rollLikes = editingRollLikes.value
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  store.updateDreamtalk({ ...dreamtalk.value });
  isEditingRollLikes.value = false;
  console.info('[智脑] Roll喜欢已保存');
}

function startEditRollDislikes() {
  if (!dreamtalk.value) return;
  editingRollDislikes.value = dreamtalk.value.rollDislikes.join('\n');
  isEditingRollDislikes.value = true;
}

function saveRollDislikes() {
  if (!dreamtalk.value) return;
  dreamtalk.value.rollDislikes = editingRollDislikes.value
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  store.updateDreamtalk({ ...dreamtalk.value });
  isEditingRollDislikes.value = false;
  console.info('[智脑] Roll不喜欢已保存');
}

// 手动触发分析
async function triggerAnalysis() {
  if (store.userInputRecords.length === 0) {
    console.info('[智脑] 没有可用的用户输入记录');
    return;
  }

  store.setDreamtalkInProgress(true);
  console.info('[智脑] 手动触发梦呓分析...');

  try {
    const { dreamtalk: result, nsfwDreamtalk } = await executeDreamtalkAnalysis(store.userInputRecords, store.persona.rawInput || '');
    store.updateDreamtalk(result);
    if (nsfwDreamtalk) {
      store.updateNsfwDreamtalk(nsfwDreamtalk);
    }
    console.info(`[智脑] 梦呓分析完成 (${result.characterInteractions.length} 角色交互模式)`);
  } catch (error) {
    console.error('[智脑] 梦呓分析失败:', error);
  } finally {
    store.setDreamtalkInProgress(false);
  }
}
</script>

<template>
  <div class="zhino-dreamtalk">
    <!-- 未分析状态 -->
    <div v-if="!dreamtalk" class="zhino-section">
      <div class="zhino-empty-hint">
        梦呓数据尚未生成。大总结完成后会自动分析，或手动触发。
      </div>
      <button
        class="zhino-btn"
        :disabled="store.dreamtalkInProgress || store.userInputRecords.length === 0"
        @click="triggerAnalysis"
      >
        {{ store.dreamtalkInProgress ? '分析中...' : '手动分析' }}
      </button>
    </div>

    <!-- 已有数据 -->
    <template v-else>
      <!-- 游玩类型 -->
      <div class="zhino-section">
        <div class="zhino-section-title">游玩类型</div>
        <div class="zhino-info-value">{{ dreamtalk.playStyle }}</div>
      </div>

      <!-- 通用行为模式 -->
      <div class="zhino-section">
        <div class="zhino-section-header">
          <div class="zhino-section-title">通用行为模式</div>
          <button v-if="!isEditingGeneral" class="zhino-btn-sm" @click="startEditGeneral">编辑</button>
          <div v-else class="zhino-btn-group">
            <button class="zhino-btn-sm zhino-btn-save" @click="saveGeneralBehaviors">保存</button>
            <button class="zhino-btn-sm" @click="isEditingGeneral = false">取消</button>
          </div>
        </div>
        <template v-if="isEditingGeneral">
          <textarea
            v-model="editingGeneralBehaviors"
            class="zhino-textarea"
            rows="6"
            placeholder="每行一条行为模式"
          />
        </template>
        <template v-else>
          <div class="zhino-behavior-list">
            <div v-for="(b, idx) in dreamtalk.generalBehaviors" :key="idx" class="zhino-behavior-item">
              {{ b }}
            </div>
          </div>
        </template>
      </div>

      <!-- 角色交互模式 -->
      <div class="zhino-section">
        <div class="zhino-section-title">角色交互模式 ({{ interactionCharacters.length }})</div>
        <div class="zhino-char-tabs">
          <button
            v-for="name in interactionCharacters"
            :key="name"
            class="zhino-char-tab"
            :class="{ active: selectedInteractionChar === name }"
            @click="selectedInteractionChar = name; isEditingInteraction = false"
          >{{ name }}</button>
        </div>

        <template v-if="selectedInteraction">
          <div class="zhino-interaction-header">
            <span class="zhino-detail-label">与 {{ selectedInteractionChar }} 的交互：</span>
            <button v-if="!isEditingInteraction" class="zhino-btn-sm" @click="startEditInteraction(selectedInteractionChar)">编辑</button>
            <div v-else class="zhino-btn-group">
              <button class="zhino-btn-sm zhino-btn-save" @click="saveInteraction">保存</button>
              <button class="zhino-btn-sm" @click="isEditingInteraction = false">取消</button>
            </div>
          </div>
          <template v-if="isEditingInteraction">
            <textarea
              v-model="editingCharInteraction"
              class="zhino-textarea"
              rows="5"
              placeholder="每行一条交互模式"
            />
          </template>
          <template v-else>
            <div class="zhino-behavior-list">
              <div v-for="(item, idx) in selectedInteraction.interactions" :key="idx" class="zhino-behavior-item">
                {{ item }}
              </div>
            </div>
          </template>
        </template>
      </div>

      <!-- Roll偏好 -->
      <div class="zhino-section">
        <div class="zhino-section-title">Roll偏好</div>

        <!-- 喜欢 -->
        <div class="zhino-roll-block">
          <div class="zhino-interaction-header">
            <span class="zhino-roll-label like">喜欢：</span>
            <button v-if="!isEditingRollLikes" class="zhino-btn-sm" @click="startEditRollLikes">编辑</button>
            <div v-else class="zhino-btn-group">
              <button class="zhino-btn-sm zhino-btn-save" @click="saveRollLikes">保存</button>
              <button class="zhino-btn-sm" @click="isEditingRollLikes = false">取消</button>
            </div>
          </div>
          <template v-if="isEditingRollLikes">
            <textarea
              v-model="editingRollLikes"
              class="zhino-textarea"
              rows="4"
              placeholder="每行一条喜欢的正文类型"
            />
          </template>
          <template v-else>
            <div v-if="dreamtalk.rollLikes.length > 0" class="zhino-behavior-list">
              <div v-for="(item, idx) in dreamtalk.rollLikes" :key="idx" class="zhino-behavior-item zhino-roll-like">
                {{ item }}
              </div>
            </div>
            <div v-else class="zhino-empty-hint">暂无数据</div>
          </template>
        </div>

        <!-- 不喜欢 -->
        <div class="zhino-roll-block">
          <div class="zhino-interaction-header">
            <span class="zhino-roll-label dislike">不喜欢：</span>
            <button v-if="!isEditingRollDislikes" class="zhino-btn-sm" @click="startEditRollDislikes">编辑</button>
            <div v-else class="zhino-btn-group">
              <button class="zhino-btn-sm zhino-btn-save" @click="saveRollDislikes">保存</button>
              <button class="zhino-btn-sm" @click="isEditingRollDislikes = false">取消</button>
            </div>
          </div>
          <template v-if="isEditingRollDislikes">
            <textarea
              v-model="editingRollDislikes"
              class="zhino-textarea"
              rows="4"
              placeholder="每行一条不喜欢的正文类型"
            />
          </template>
          <template v-else>
            <div v-if="dreamtalk.rollDislikes.length > 0" class="zhino-behavior-list">
              <div v-for="(item, idx) in dreamtalk.rollDislikes" :key="idx" class="zhino-behavior-item zhino-roll-dislike">
                {{ item }}
              </div>
            </div>
            <div v-else class="zhino-empty-hint">暂无数据</div>
          </template>
        </div>
      </div>

      <!-- 重新分析 -->
      <div class="zhino-section">
        <button
          class="zhino-btn-sm"
          style="color:#ff6b6b;border:1px solid rgba(255,100,100,0.3)"
          @click="store.rollbackDreamtalk()"
        >撤回梦呓</button>
        <button
          class="zhino-btn-sm"
          style="color:#4caf50;border:1px solid rgba(76,175,80,0.3)"
          @click="store.restoreDreamtalk()"
        >恢复梦呓</button>
        <button
          class="zhino-btn"
          :disabled="store.dreamtalkInProgress || store.userInputRecords.length === 0"
          @click="triggerAnalysis"
        >
          {{ store.dreamtalkInProgress ? '分析中...' : '重新分析' }}
        </button>
        <div class="zhino-meta">
          v{{ dreamtalk.version }} · {{ dreamtalk.generatedAt }}
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.zhino-dreamtalk {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
.zhino-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.zhino-info-value {
  font-size: 13px;
  color: rgba(167, 139, 250, 0.9);
  font-weight: 500;
}

.zhino-behavior-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.zhino-behavior-item {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 4px;
  border-left: 2px solid rgba(167, 139, 250, 0.3);
}
.zhino-behavior-item.zhino-roll-like {
  border-left-color: rgba(74, 222, 128, 0.4);
}
.zhino-behavior-item.zhino-roll-dislike {
  border-left-color: rgba(248, 113, 113, 0.4);
}

.zhino-roll-block {
  margin-bottom: 10px;
}
.zhino-roll-block:last-child {
  margin-bottom: 0;
}
.zhino-roll-label {
  font-weight: 500;
  font-size: 12px;
  flex-shrink: 0;
}
.zhino-roll-label.like { color: #4ade80; }
.zhino-roll-label.dislike { color: #f87171; }

.zhino-char-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}
.zhino-char-tab {
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  transition: all 0.15s;
}
.zhino-char-tab:hover {
  background: rgba(167, 139, 250, 0.08);
}
.zhino-char-tab.active {
  background: rgba(167, 139, 250, 0.15);
  border-color: rgba(167, 139, 250, 0.3);
  color: rgba(167, 139, 250, 0.9);
}

.zhino-interaction-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.zhino-roll-row {
  display: flex;
  gap: 6px;
  font-size: 12px;
  margin-bottom: 4px;
}
.zhino-roll-label {
  font-weight: 500;
  flex-shrink: 0;
}
.zhino-roll-label.like { color: #4ade80; }
.zhino-roll-label.dislike { color: #f87171; }
.zhino-roll-value {
  color: rgba(255, 255, 255, 0.7);
}

.zhino-meta {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.3);
  margin-top: 6px;
}

.zhino-empty-hint {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.3);
  margin-bottom: 8px;
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
  font-family: inherit;
}
.zhino-textarea:focus {
  border-color: rgba(167, 139, 250, 0.4);
}

.zhino-detail-label {
  color: rgba(255, 255, 255, 0.4);
  font-size: 11px;
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

.zhino-btn-sm {
  padding: 3px 10px;
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
.zhino-btn-save {
  border-color: rgba(167, 139, 250, 0.3);
  color: rgba(167, 139, 250, 0.9);
}
.zhino-btn-save:hover {
  background: rgba(167, 139, 250, 0.15);
}
.zhino-btn-group {
  display: flex;
  gap: 4px;
}
</style>
