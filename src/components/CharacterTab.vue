<script setup lang="ts">
import { useMainStore } from '../stores/mainStore';
import type { CharacterMemory, DynamicProfile } from '../stores/mainStore';

const store = useMainStore();

const selectedCharacter = ref('');
const editingMemory = ref('');
const editingKeywords = ref('');
const editingDynamicProfile = ref('');
const isEditing = ref(false);

// 所有角色名（从记忆库 + 动态人设合并）
const allCharacters = computed(() => {
  const names = new Set<string>();
  const latestSummary = store.getLatestSummary();
  if (latestSummary) {
    for (const m of latestSummary.characterMemories) {
      names.add(m.characterName);
    }
  }
  for (const p of store.dynamicProfiles) {
    names.add(p.characterName);
  }
  return Array.from(names);
});

// 当前选中角色的记忆
const selectedMemory = computed((): CharacterMemory | undefined => {
  if (!selectedCharacter.value) return undefined;
  return store.getCharacterMemories(selectedCharacter.value);
});

// 当前选中角色的动态人设
const selectedProfile = computed((): DynamicProfile | undefined => {
  if (!selectedCharacter.value) return undefined;
  return store.dynamicProfiles.find(p => p.characterName === selectedCharacter.value);
});

// 选择角色
function selectCharacter(name: string) {
  selectedCharacter.value = name;
  isEditing.value = false;
  loadEditFields();
}

function loadEditFields() {
  const mem = selectedMemory.value;
  if (mem) {
    editingMemory.value = mem.memories.join('\n');
    editingKeywords.value = mem.keywords.join(', ');
  } else {
    editingMemory.value = '';
    editingKeywords.value = '';
  }
  const prof = selectedProfile.value;
  editingDynamicProfile.value = prof?.dynamicContent || '';
}

// 保存编辑
function saveEdits() {
  const latestSummary = store.getLatestSummary();
  if (!latestSummary || !selectedCharacter.value) return;

  // 更新记忆
  const memIdx = latestSummary.characterMemories.findIndex(
    m => m.characterName === selectedCharacter.value,
  );
  if (memIdx !== -1) {
    latestSummary.characterMemories[memIdx].memories = editingMemory.value
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    latestSummary.characterMemories[memIdx].keywords = editingKeywords.value
      .split(/[,，、]/)
      .map(k => k.trim())
      .filter(Boolean);
  }

  // 更新动态人设
  if (editingDynamicProfile.value.trim()) {
    store.updateDynamicProfile({
      characterName: selectedCharacter.value,
      dynamicContent: editingDynamicProfile.value.trim(),
      lastUpdatedAt: new Date().toISOString(),
      basedOnSummaryVersion: latestSummary.version,
    });
  }

  isEditing.value = false;
  console.info(`[智脑] 角色 ${selectedCharacter.value} 数据已保存`);
}

function cancelEdit() {
  isEditing.value = false;
  loadEditFields();
}
</script>

<template>
  <div class="zhino-character">
    <!-- 角色列表 -->
    <div class="zhino-section">
      <div class="zhino-section-title">角色列表 ({{ allCharacters.length }})</div>
      <div v-if="allCharacters.length === 0" class="zhino-empty-hint">
        暂无角色数据（完成首次大总结后显示）
      </div>
      <div v-else class="zhino-char-list">
        <button
          v-for="name in allCharacters"
          :key="name"
          class="zhino-char-item"
          :class="{ active: selectedCharacter === name }"
          @click="selectCharacter(name)"
        >
          <span class="zhino-char-name">{{ name }}</span>
          <span v-if="selectedMemory && selectedCharacter === name" class="zhino-char-attitude"
            :class="selectedMemory.attitude"
          >
            {{ selectedMemory.attitude === 'like' ? '♥' : selectedMemory.attitude === 'dislike' ? '✗' : '—' }}
          </span>
        </button>
      </div>
    </div>

    <!-- 角色详情 -->
    <template v-if="selectedCharacter">
      <div class="zhino-section">
        <div class="zhino-section-header">
          <div class="zhino-section-title">{{ selectedCharacter }} 详情</div>
          <button v-if="!isEditing" class="zhino-btn-sm" @click="isEditing = true">编辑</button>
          <div v-else class="zhino-btn-group">
            <button class="zhino-btn-sm zhino-btn-save" @click="saveEdits">保存</button>
            <button class="zhino-btn-sm" @click="cancelEdit">取消</button>
          </div>
        </div>

        <!-- 别名 -->
        <div v-if="selectedMemory?.aliases?.length" class="zhino-detail-row">
          <span class="zhino-detail-label">别名：</span>
          <span class="zhino-detail-value">{{ selectedMemory.aliases.join(', ') }}</span>
        </div>

        <!-- 态度 -->
        <div v-if="selectedMemory" class="zhino-detail-row">
          <span class="zhino-detail-label">态度：</span>
          <span class="zhino-detail-value" :class="'attitude-' + selectedMemory.attitude">
            {{ selectedMemory.attitude === 'like' ? '好感' : selectedMemory.attitude === 'dislike' ? '厌恶' : '中立' }}
          </span>
        </div>

        <!-- 记忆条目 -->
        <div class="zhino-detail-block">
          <div class="zhino-detail-label">记忆条目：</div>
          <template v-if="isEditing">
            <textarea
              v-model="editingMemory"
              class="zhino-textarea"
              rows="6"
              placeholder="每行一条记忆（第一人称）"
            />
          </template>
          <template v-else>
            <div v-if="selectedMemory && selectedMemory.memories.length > 0" class="zhino-memory-list">
              <div v-for="(mem, idx) in selectedMemory.memories" :key="idx" class="zhino-memory-item">
                {{ mem }}
              </div>
            </div>
            <div v-else class="zhino-empty-hint">无记忆数据</div>
          </template>
        </div>

        <!-- 关键词 -->
        <div class="zhino-detail-block">
          <div class="zhino-detail-label">激活关键词：</div>
          <template v-if="isEditing">
            <input
              v-model="editingKeywords"
              class="zhino-input"
              placeholder="逗号分隔"
            />
          </template>
          <template v-else>
            <div v-if="selectedMemory && selectedMemory.keywords.length > 0" class="zhino-tag-list">
              <span v-for="kw in selectedMemory.keywords" :key="kw" class="zhino-tag">{{ kw }}</span>
            </div>
            <div v-else class="zhino-empty-hint">无关键词</div>
          </template>
        </div>

        <!-- 动态人设 -->
        <div class="zhino-detail-block">
          <div class="zhino-detail-label">动态人设：</div>
          <template v-if="isEditing">
            <textarea
              v-model="editingDynamicProfile"
              class="zhino-textarea"
              rows="4"
              placeholder="角色当前状态描述"
            />
          </template>
          <template v-else>
            <div v-if="selectedProfile" class="zhino-profile-text">
              {{ selectedProfile.dynamicContent }}
            </div>
            <div v-else class="zhino-empty-hint">无动态人设</div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.zhino-character {
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

.zhino-char-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.zhino-char-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.zhino-char-item:hover {
  background: rgba(167, 139, 250, 0.08);
  border-color: rgba(167, 139, 250, 0.2);
}
.zhino-char-item.active {
  background: rgba(167, 139, 250, 0.15);
  border-color: rgba(167, 139, 250, 0.3);
  color: rgba(167, 139, 250, 0.9);
}
.zhino-char-attitude {
  font-size: 10px;
}
.zhino-char-attitude.like { color: #4ade80; }
.zhino-char-attitude.dislike { color: #f87171; }
.zhino-char-attitude.neutral { color: rgba(255, 255, 255, 0.3); }

.zhino-detail-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  margin-bottom: 6px;
}
.zhino-detail-label {
  color: rgba(255, 255, 255, 0.4);
  font-size: 11px;
  margin-bottom: 4px;
}
.zhino-detail-value {
  color: rgba(255, 255, 255, 0.8);
}
.attitude-like { color: #4ade80; }
.attitude-dislike { color: #f87171; }
.attitude-neutral { color: rgba(255, 255, 255, 0.5); }

.zhino-detail-block {
  margin-top: 10px;
}

.zhino-memory-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.zhino-memory-item {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 4px;
  border-left: 2px solid rgba(167, 139, 250, 0.3);
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

.zhino-profile-text {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  line-height: 1.6;
  white-space: pre-wrap;
}

.zhino-empty-hint {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.3);
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

.zhino-input {
  width: 100%;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.85);
  outline: none;
}
.zhino-input:focus {
  border-color: rgba(167, 139, 250, 0.4);
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
