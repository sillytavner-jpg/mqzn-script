<template>
  <div class="wt-panel">
    <div class="player-card">
      <div class="player-avatar" :style="avatarStyle">我</div>
      <div class="player-info">
        <div class="player-name">{{ displayName }}</div>
        <div class="player-location-row">
          <template v-if="!isEditingLoc">
            <span class="player-location-label">当前地点：</span>
            <span class="player-location-value">{{ location?.name || '未知' }}</span>
            <button class="player-loc-btn" @click="startEditLoc">修改</button>
          </template>
          <template v-else>
            <span class="player-location-label">当前地点：</span>
            <select v-model="locSelect" class="player-loc-select" @change="onLocSelectChange">
              <option value="">选择地点…</option>
              <option v-for="loc in locations" :key="loc.id" :value="loc.name">{{ loc.name }}</option>
              <option value="__custom__">＋ 输入新地点</option>
            </select>
            <input
              v-if="locSelect === '__custom__'"
              v-model="locCustom"
              class="player-loc-input"
              placeholder="输入地点名"
              @keydown.enter="saveLoc"
              @keydown.escape="cancelEditLoc"
              autofocus
            />
            <button class="player-loc-btn player-loc-save" @click="saveLoc">保存</button>
            <button class="player-loc-btn" @click="cancelEditLoc">取消</button>
          </template>
        </div>
        <div v-if="locationBrief" class="player-loc-brief">{{ locationBrief }}</div>
      </div>
    </div>

    <InventoryGrid
      :items="items"
      @edit="onEditItem"
      @add="onAddItem"
    />

    <ItemEditModal
      :visible="showItemModal"
      :mode="itemModalMode"
      :item="editingItem"
      :default-owner="defaultOwner"
      @close="showItemModal = false"
    />
  </div>
</template>

<script setup lang="ts">
import { useMainStore } from '../stores/mainStore';
import InventoryGrid from './InventoryGrid.vue';
import ItemEditModal from './ItemEditModal.vue';
import type { KnowledgeGraph, OwnedItem } from '../core/knowledgeGraph';
import { getItemsBelongingTo, createEmptyKnowledgeGraph } from '../core/knowledgeGraph';

const PLAYER_OWNER_NAMES = ['我', '玩家', '用户', '主角', '{{user}}', 'user'];

const store = useMainStore();
const graph = computed<KnowledgeGraph>(() => store.chatData.knowledgeGraph || createEmptyKnowledgeGraph());
const locations = computed(() => graph.value.locations);

const userName = computed(() => store.getUserName());
const displayName = computed(() => userName.value || '{{user}}');

const location = computed(() => {
  const name = userName.value;
  return name ? store.getCharacterLocation(name) : null;
});

const locationBrief = computed(() => {
  const locId = location.value?.id;
  if (!locId) return '';
  const loc = graph.value.locations.find(l => l.id === locId);
  return loc?.brief || '';
});

const ownerNames = computed(() => {
  const names = new Set<string>();
  const un = userName.value?.trim();
  if (un) names.add(un);
  PLAYER_OWNER_NAMES.forEach(n => names.add(n));
  return Array.from(names);
});

const items = computed<OwnedItem[]>(() => getItemsBelongingTo(graph.value, ownerNames.value));

const defaultOwner = computed(() => userName.value || '{{user}}');

const showItemModal = ref(false);
const itemModalMode = ref<'edit' | 'add'>('add');
const editingItem = ref<OwnedItem | undefined>(undefined);

function onEditItem(item: OwnedItem) {
  editingItem.value = item;
  itemModalMode.value = 'edit';
  showItemModal.value = true;
}

function onAddItem() {
  editingItem.value = undefined;
  itemModalMode.value = 'add';
  showItemModal.value = true;
}

const isEditingLoc = ref(false);
const locSelect = ref('');
const locCustom = ref('');

const avatarStyle = computed(() => ({
  background: 'rgba(var(--zn-accent-rgb), 0.75)',
  color: '#fff',
}));

function startEditLoc() {
  isEditingLoc.value = true;
  const currentName = location.value?.name || '';
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
    store.setCharacterLocation(userName.value || '{{user}}', name);
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
</script>

<style scoped>
.wt-panel {
  display: flex;
  flex-direction: column;
  gap: var(--zn-space-3);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px;
}
.player-card {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-light);
  border-radius: 8px;
  padding: 10px 12px;
}
.player-avatar {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  font-weight: 600;
  flex-shrink: 0;
}
.player-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.player-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--zn-text-primary);
}
.player-location-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  flex-wrap: wrap;
}
.player-location-label {
  color: var(--zn-text-muted);
}
.player-location-value {
  color: var(--zn-text-primary);
  font-weight: 500;
}
.player-loc-brief {
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
.player-loc-btn {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 4px;
  border: 1px solid var(--zn-border-light);
  background: var(--zn-bg-surface2);
  color: var(--zn-text-secondary);
  cursor: pointer;
}
.player-loc-btn:hover {
  color: var(--zn-accent);
  border-color: var(--zn-accent);
}
.player-loc-save {
  background: rgba(var(--zn-accent-rgb), 0.12);
  color: var(--zn-accent);
}
.player-loc-select,
.player-loc-input {
  background: var(--zn-bg-surface2);
  border: 1px solid var(--zn-border-light);
  border-radius: var(--zn-radius-sm);
  padding: 3px 6px;
  color: var(--zn-text-primary);
  font-size: 12px;
  min-width: 120px;
}
.player-loc-select:focus,
.player-loc-input:focus {
  border-color: var(--zn-accent);
  outline: none;
}
.player-loc-input {
  flex: 1;
  max-width: 180px;
}
</style>
