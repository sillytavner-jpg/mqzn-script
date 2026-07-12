<template>
  <div class="wb-tags-tab">
    <div class="zhino-section wb-card">
      <div class="zhino-section-header">
        <div class="zhino-section-title">世界书标签编排</div>
        <span class="wb-meta">{{ selectedCount }}/{{ filteredEntries.length }} 已选</span>
      </div>

      <div class="wb-toolbar">
        <input v-model="searchText" class="zhino-input wb-search" placeholder="搜索条目或世界书" />
        <button class="zhino-btn-sm" :disabled="selectedIds.size === 0" @click="clearSelection">清空选择</button>
      </div>

      <div class="wb-entry-list">
        <label
          v-for="entry in filteredEntries"
          :key="entryIdentity(entry)"
          class="wb-entry"
          :class="{ active: selectedIds.has(entryIdentity(entry)) }"
        >
          <input
            type="checkbox"
            :checked="selectedIds.has(entryIdentity(entry))"
            @change="toggleEntry(entry)"
          />
          <span class="wb-entry-main">
            <span class="wb-entry-title">{{ entry.key || entry.entryName || '未命名条目' }}</span>
            <span class="wb-entry-sub">{{ entry.book || '未分组' }}<template v-if="entry.uid !== undefined"> · uid {{ entry.uid }}</template></span>
          </span>
        </label>
        <div v-if="filteredEntries.length === 0" class="wb-empty">
          当前没有可选择的世界书条目。先在酒馆里触发或开启对应世界书后再回来。
        </div>
      </div>
    </div>

    <div class="zhino-section wb-card">
      <div class="zhino-section-header">
        <div class="zhino-section-title">绑定标签</div>
      </div>

      <div class="wb-form-grid">
        <label class="wb-field">
          <span>类型</span>
          <select v-model="bindingKind" class="zhino-input">
            <option value="world">世界观/背景</option>
            <option value="character">角色人设</option>
          </select>
        </label>

        <label v-if="bindingKind === 'character'" class="wb-field">
          <span>角色名</span>
          <input v-model="characterName" class="zhino-input" placeholder="例如：秋青" />
        </label>

        <label class="wb-field">
          <span>标签名</span>
          <input v-model="tagLabel" class="zhino-input" :placeholder="bindingKind === 'world' ? '世界背景' : '基础人设'" />
        </label>
      </div>

      <label class="wb-field wb-meaning">
        <span>标签含义</span>
        <textarea
          v-model="meaning"
          class="zhino-input wb-textarea"
          placeholder="写清这个 tag 代表什么，之后智脑会把它作为快速召回索引。"
        />
      </label>

      <div class="wb-preview">
        <span>预览标签</span>
        <code>&lt;{{ previewTagName }}&gt;</code>
      </div>

      <div class="wb-actions">
        <button class="zhino-btn-sm zhino-btn-save" :disabled="!canAddBindings" @click="addSelectedBindings">
          加入智脑索引
        </button>
        <button class="zhino-btn-sm zhino-btn-save" :disabled="bindings.length === 0 || applying" @click="applyBindings">
          {{ applying ? '写回中...' : '写回世界书' }}
        </button>
      </div>

      <div v-if="statusText" class="wb-status">{{ statusText }}</div>
      <div v-if="errorText" class="wb-error">{{ errorText }}</div>
    </div>

    <div class="zhino-section wb-card wb-bindings">
      <div class="zhino-section-header">
        <div class="zhino-section-title">当前索引</div>
        <span class="wb-meta">{{ bindings.length }} 条</span>
      </div>

      <div v-if="bindings.length === 0" class="wb-empty">
        还没有绑定标签。
      </div>

      <div v-for="binding in bindings" :key="binding.id" class="wb-binding">
        <div class="wb-binding-head">
          <code>&lt;{{ binding.tagName }}&gt;</code>
          <span class="wb-position">{{ binding.kind === 'world' ? '角色定义前' : '角色定义后' }}</span>
          <button class="zhino-btn-sm wb-remove" @click="removeBinding(binding.id)">删除</button>
        </div>
        <div class="wb-binding-source">{{ binding.book || '未分组' }} / {{ binding.displayKey }}</div>
        <div class="wb-binding-meaning">{{ binding.meaning }}</div>
        <div v-if="binding.lastError" class="wb-binding-error">{{ binding.lastError }}</div>
        <div v-else-if="binding.lastAppliedAt" class="wb-binding-ok">已写回：{{ formatTime(binding.lastAppliedAt) }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMainStore } from '../stores/mainStore';
import {
  applyWorldBookTagBindings,
  buildCharacterTagName,
  buildWorldBookBindingId,
  buildWorldTagName,
  hasWorldBookTagApi,
  type WorldBookEntryInfo,
  type WorldBookTagBinding,
  type WorldBookTagKind,
} from '../core/worldBookTags';
import { logError } from '../utils/logger';

const store = useMainStore();

const searchText = ref('');
const selectedIds = ref<Set<string>>(new Set());
const bindingKind = ref<WorldBookTagKind>('world');
const characterName = ref('');
const tagLabel = ref('世界背景');
const meaning = ref('');
const applying = ref(false);
const statusText = ref('');
const errorText = ref('');

const entries = computed<WorldBookEntryInfo[]>(() => store.chatData.worldBookEntries || []);
const bindings = computed<WorldBookTagBinding[]>(() => store.chatData.worldBookTagBindings || []);

const filteredEntries = computed(() => {
  const q = searchText.value.trim().toLowerCase();
  if (!q) return entries.value;
  return entries.value.filter(entry => {
    const text = `${entry.key || ''} ${entry.entryName || ''} ${entry.book || ''}`.toLowerCase();
    return text.includes(q);
  });
});

const selectedCount = computed(() => selectedIds.value.size);

const previewTagId = computed(() => getNextTagId(bindingKind.value, characterName.value));
const previewTagName = computed(() => {
  if (bindingKind.value === 'character') {
    return buildCharacterTagName(characterName.value || '角色', previewTagId.value, tagLabel.value || '基础人设');
  }
  return buildWorldTagName(previewTagId.value, tagLabel.value || '世界背景');
});

const canAddBindings = computed(() => {
  if (selectedIds.value.size === 0) return false;
  if (bindingKind.value === 'character' && !characterName.value.trim()) return false;
  return !!(tagLabel.value.trim() && meaning.value.trim());
});

function entryIdentity(entry: WorldBookEntryInfo): string {
  return buildWorldBookBindingId(entry);
}

function toggleEntry(entry: WorldBookEntryInfo): void {
  const next = new Set(selectedIds.value);
  const id = entryIdentity(entry);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function clearSelection(): void {
  selectedIds.value = new Set();
}

function getNextTagId(kind: WorldBookTagKind, character: string): number {
  const normalizedCharacter = character.trim();
  if (kind === 'character' && normalizedCharacter) {
    const existing = bindings.value.find(binding => binding.kind === 'character' && binding.characterName === normalizedCharacter);
    if (existing) return existing.tagId;
  }
  const sameKind = bindings.value.filter(binding => binding.kind === kind);
  const max = sameKind.reduce((acc, binding) => Math.max(acc, binding.tagId || 0), 0);
  return max + 1;
}

function addSelectedBindings(): void {
  if (!canAddBindings.value) return;
  const selected = entries.value.filter(entry => selectedIds.value.has(entryIdentity(entry)));
  const now = new Date().toISOString();
  const tagId = previewTagId.value;
  const label = tagLabel.value.trim();
  const owner = characterName.value.trim();
  const tagName = bindingKind.value === 'character'
    ? buildCharacterTagName(owner, tagId, label)
    : buildWorldTagName(tagId, label);

  const byId = new Map(bindings.value.map(binding => [binding.id, binding]));
  for (const entry of selected) {
    const id = entryIdentity(entry);
    byId.set(id, {
      id,
      book: entry.book || '',
      uid: entry.uid,
      entryName: entry.entryName || entry.key || '未命名条目',
      displayKey: entry.key || entry.entryName || '未命名条目',
      kind: bindingKind.value,
      tagId,
      tagLabel: label,
      tagName,
      characterName: bindingKind.value === 'character' ? owner : undefined,
      meaning: meaning.value.trim(),
      updatedAt: now,
    });
  }

  store.chatData.worldBookTagBindings = [...byId.values()];
  store.forcePersist();
  statusText.value = `已加入 ${selected.length} 条索引`;
  errorText.value = '';
}

function removeBinding(id: string): void {
  store.chatData.worldBookTagBindings = bindings.value.filter(binding => binding.id !== id);
  store.forcePersist();
}

async function applyBindings(): Promise<void> {
  if (applying.value) return;
  if (!hasWorldBookTagApi()) {
    errorText.value = '当前环境没有可用的世界书写回 API。';
    return;
  }
  applying.value = true;
  statusText.value = '';
  errorText.value = '';
  try {
    const result = await applyWorldBookTagBindings(bindings.value);
    const now = new Date().toISOString();
    const errorsById = new Map(result.errors.map(error => [error.bindingId, error.message]));
    store.chatData.worldBookTagBindings = bindings.value.map(binding => {
      const lastError = errorsById.get(binding.id);
      if (lastError) return { ...binding, lastError };
      return { ...binding, lastAppliedAt: now, lastError: '' };
    });
    store.forcePersist();
    statusText.value = `已写回 ${result.applied} 个世界书条目`;
    if (!result.ok) {
      errorText.value = result.errors.map(error => error.message).join('\n');
    }
  } catch (error: any) {
    logError('世界书标签', '写回失败', error);
    errorText.value = error?.message || String(error);
  } finally {
    applying.value = false;
  }
}

function formatTime(iso: string): string {
  try {
    const date = new Date(iso);
    return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}
</script>

<style scoped>
.wb-tags-tab {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
}
.wb-card {
  flex-shrink: 0;
}
.wb-meta {
  font-size: 11px;
  color: var(--zn-text-muted);
}
.wb-toolbar,
.wb-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wb-search {
  flex: 1;
  min-width: 0;
}
.wb-entry-list {
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}
.wb-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--zn-border-light);
  border-radius: 6px;
  background: var(--zn-surface-sunken);
  cursor: pointer;
}
.wb-entry.active {
  border-color: rgba(var(--zn-accent-rgb), 0.35);
  background: rgba(var(--zn-accent-rgb), 0.08);
}
.wb-entry input {
  accent-color: rgba(var(--zn-accent-rgb), 0.85);
}
.wb-entry-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.wb-entry-title,
.wb-binding-source {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wb-entry-title {
  font-size: 12px;
  color: var(--zn-text-regular);
}
.wb-entry-sub,
.wb-binding-source,
.wb-binding-ok {
  font-size: 10px;
  color: var(--zn-text-muted);
}
.wb-form-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.wb-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--zn-text-muted);
}
.wb-meaning {
  margin-top: 8px;
}
.wb-textarea {
  min-height: 64px;
  resize: vertical;
  line-height: 1.5;
}
.wb-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
  font-size: 11px;
  color: var(--zn-text-muted);
}
code {
  color: rgba(var(--zn-accent-rgb), 0.9);
  word-break: break-all;
}
.wb-status,
.wb-error,
.wb-empty {
  margin-top: 8px;
  padding: 7px 9px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
}
.wb-status {
  color: rgba(var(--zn-success-rgb), 0.9);
  background: rgba(var(--zn-success-rgb), 0.08);
}
.wb-error,
.wb-binding-error {
  color: rgba(var(--zn-danger-rgb), 0.9);
}
.wb-error {
  background: rgba(var(--zn-danger-rgb), 0.08);
}
.wb-empty {
  color: var(--zn-text-muted);
  background: var(--zn-surface-sunken);
}
.wb-bindings {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wb-binding {
  border: 1px solid var(--zn-border-light);
  border-radius: 6px;
  background: var(--zn-surface-sunken);
  padding: 8px;
}
.wb-binding-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wb-position {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 10px;
  background: rgba(var(--zn-accent-rgb), 0.08);
  color: rgba(var(--zn-accent-rgb), 0.85);
}
.wb-remove {
  margin-left: auto;
}
.wb-binding-meaning {
  margin-top: 5px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--zn-text-regular);
  white-space: pre-wrap;
}
@media (max-width: 680px) {
  .wb-form-grid {
    grid-template-columns: 1fr;
  }
  .wb-toolbar,
  .wb-actions {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
