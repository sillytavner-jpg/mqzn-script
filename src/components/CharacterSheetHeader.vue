<template>
  <div class="sheet-header">
    <div class="sheet-avatar" :style="avatarStyle">
      {{ avatarText }}
    </div>
    <div class="sheet-info">
      <div class="sheet-top">
        <span class="sheet-name">{{ characterName }}</span>
        <span v-if="attitude" class="sheet-attitude" :class="attitude">
          {{ attitude === 'like' ? '♥ 好感' : attitude === 'dislike' ? '✗ 厌恶' : '— 中立' }}
        </span>
      </div>
      <div class="sheet-aliases">
        <template v-if="!isEditingAliases">
          <span>别名：{{ aliases?.length ? aliases.join('、') : '（无）' }}</span>
          <button class="sheet-loc-btn" @click="startEditAliases">编辑</button>
        </template>
        <template v-else>
          <input
            v-model="editingAliasesText"
            class="sheet-alias-input"
            placeholder="逗号/斜杠分隔，如：小月、月儿" aria-label="逗号/斜杠分隔，如：小月、月儿"
            @keydown.enter="saveAliases"
            @keydown.escape="cancelEditAliases"
            autofocus
          />
          <button class="sheet-loc-btn sheet-loc-save" @click="saveAliases">保存</button>
          <button class="sheet-loc-btn" @click="cancelEditAliases">取消</button>
        </template>
      </div>
      <div class="sheet-location-row">
        <template v-if="!isEditingLoc">
          <span class="sheet-location-label">当前地点：</span>
          <span class="sheet-location-value">{{ location?.name || '未知' }}</span>
          <button class="sheet-loc-btn" @click="startEditLoc">修改</button>
        </template>
        <template v-else>
          <span class="sheet-location-label">当前地点：</span>
          <select v-model="locSelect" class="sheet-loc-select" @change="onLocSelectChange">
            <option value="">选择地点…</option>
            <option v-for="loc in locations" :key="loc.id" :value="loc.name">{{ loc.name }}</option>
            <option value="__custom__">＋ 输入新地点</option>
          </select>
          <input
            v-if="locSelect === '__custom__'"
            v-model="locCustom"
            class="sheet-loc-input"
            placeholder="输入地点名" aria-label="输入地点名"
            @keydown.enter="saveLoc"
            @keydown.escape="cancelEditLoc"
            autofocus
          />
          <button class="sheet-loc-btn sheet-loc-save" @click="saveLoc">保存</button>
          <button class="sheet-loc-btn" @click="cancelEditLoc">取消</button>
        </template>
      </div>
      <div v-if="locationBrief" class="sheet-loc-brief">
        {{ locationBrief }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useMainStore } from '../stores/mainStore';
import type { KnowledgeGraph } from '../core/knowledgeGraph';
import { createEmptyKnowledgeGraph } from '../core/knowledgeGraph';

const props = defineProps<{
  characterName: string;
  aliases?: string[];
  attitude?: 'like' | 'dislike' | 'neutral';
  location?: { id: string; name: string } | null;
}>();

const emit = defineEmits<{
  (e: 'updateLocation', locationName: string): void;
}>();

const store = useMainStore();
const graph = computed<KnowledgeGraph>(() => store.chatData.knowledgeGraph || createEmptyKnowledgeGraph());
const locations = computed(() => graph.value.locations);

const avatarText = computed(() => (props.characterName ? props.characterName.slice(0, 1) : '?'));
const avatarStyle = computed(() => {
  const seed = props.characterName.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const hue = seed % 360;
  return {
    background: `hsl(${hue}, 55%, 45%)`,
    color: '#fff',
  };
});

const locationBrief = computed(() => {
  const locId = props.location?.id;
  if (!locId) return '';
  const loc = graph.value.locations.find(l => l.id === locId);
  return loc?.brief || '';
});

const isEditingLoc = ref(false);
const locSelect = ref('');
const locCustom = ref('');

function startEditLoc() {
  isEditingLoc.value = true;
  const currentName = props.location?.name || '';
  const exists = locations.value.some(l => l.name === currentName);
  locSelect.value = exists ? currentName : (currentName ? '__custom__' : '');
  locCustom.value = currentName;
}

function onLocSelectChange() {
  if (locSelect.value !== '__custom__') {
    locCustom.value = locSelect.value;
  }
}

function saveLoc() {
  const name = locSelect.value === '__custom__' ? locCustom.value.trim() : locSelect.value.trim();
  if (name) {
    emit('updateLocation', name);
  }
  isEditingLoc.value = false;
  locSelect.value = '';
  locCustom.value = '';
}

function cancelEditLoc() {
  isEditingLoc.value = false;
  locSelect.value = '';
  locCustom.value = '';
}

// 别名编辑
const isEditingAliases = ref(false);
const editingAliasesText = ref('');

function startEditAliases() {
  editingAliasesText.value = (props.aliases || []).join('、');
  isEditingAliases.value = true;
}

function saveAliases() {
  if (!props.characterName) return;
  const newAliases = editingAliasesText.value.split(/[,，、/]/).map(s => s.trim()).filter(Boolean);
  const ok = store.updateCharacterAliases(props.characterName, newAliases);
  if (ok) {
    isEditingAliases.value = false;
  }
}

function cancelEditAliases() {
  isEditingAliases.value = false;
}

watch(() => props.characterName, () => {
  isEditingAliases.value = false;
});
</script>

<style scoped>
.sheet-header {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.sheet-avatar {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  font-weight: 600;
  flex-shrink: 0;
  user-select: none;
}
.sheet-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sheet-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sheet-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--zn-text-primary);
}
.sheet-attitude {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  font-weight: 500;
}
.sheet-attitude.like {
  background: rgba(var(--zn-success-rgb), 0.15);
  color: rgba(var(--zn-success-rgb), 0.9);
}
.sheet-attitude.dislike {
  background: rgba(var(--zn-danger-rgb), 0.15);
  color: rgba(var(--zn-danger-rgb), 0.9);
}
.sheet-attitude.neutral {
  background: var(--zn-bg-surface2);
  color: var(--zn-text-muted);
}
.sheet-aliases {
  font-size: 11px;
  color: var(--zn-text-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.sheet-location-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  flex-wrap: wrap;
}
.sheet-location-label {
  color: var(--zn-text-muted);
}
.sheet-location-value {
  color: var(--zn-text-primary);
  font-weight: 500;
}
.sheet-loc-brief {
  font-size: 11px;
  color: var(--zn-text-secondary);
  line-height: 1.4;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.sheet-loc-btn {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 4px;
  border: 1px solid var(--zn-border-light);
  background: var(--zn-bg-surface2);
  color: var(--zn-text-secondary);
  cursor: pointer;
}
.sheet-loc-btn:hover {
  color: var(--zn-accent);
  border-color: var(--zn-accent);
}
.sheet-loc-save {
  background: rgba(var(--zn-accent-rgb), 0.12);
  color: var(--zn-accent);
}
.sheet-loc-select,
.sheet-loc-input {
  background: var(--zn-bg-surface2);
  border: 1px solid var(--zn-border-light);
  border-radius: var(--zn-radius-sm);
  padding: 3px 6px;
  color: var(--zn-text-primary);
  font-size: 12px;
  min-width: 120px;
}
.sheet-loc-select:focus,
.sheet-loc-input:focus {
  border-color: var(--zn-accent);
  outline: none;
}
.sheet-loc-input {
  flex: 1;
  max-width: 180px;
}
.sheet-alias-input {
  flex: 1 1 200px;
  min-width: 160px;
  max-width: 100%;
  background: var(--zn-bg-surface2);
  border: 1px solid var(--zn-border-light);
  border-radius: var(--zn-radius-sm);
  padding: 3px 6px;
  color: var(--zn-text-primary);
  font-size: 11px;
  box-sizing: border-box;
}
.sheet-alias-input:focus {
  border-color: var(--zn-accent);
  outline: none;
}
</style>
