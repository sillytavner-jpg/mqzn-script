<template>
  <div class="npc-wb-tab">
    <div class="zhino-section npc-card">
      <div class="zhino-section-header">
        <div class="zhino-section-title">NPC 小传入世书（施工中）</div>
        <span class="npc-meta" v-if="maxFloor > 0">当前最大楼层 #{{ maxFloor }}</span>
      </div>

      <div class="npc-form">
        <label class="npc-field">
          <span>选择 NPC</span>
          <select v-model="selectedNpc" class="zhino-input">
            <option value="">请选择 NPC</option>
            <option v-for="name in characterNames" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>

        <div class="npc-row">
          <label class="npc-field">
            <span>起始楼层</span>
            <input v-model.number="startFloor" class="zhino-input" type="number" min="0" />
          </label>
          <label class="npc-field">
            <span>结束楼层</span>
            <input v-model.number="endFloor" class="zhino-input" type="number" min="0" />
          </label>
        </div>

        <label class="npc-field">
          <span>写入世界书</span>
          <select v-model="targetBookName" class="zhino-input">
            <option value="">聊天世界书（自动创建）</option>
            <option v-for="book in targetBooks" :key="book" :value="book">{{ book }}</option>
          </select>
        </label>

        <label class="npc-check">
          <input type="checkbox" v-model="fullMode" />
          <span>全套模式（核心人格层 + 意象）</span>
        </label>

        <div class="npc-actions">
          <button class="zhino-btn-sm zhino-btn-save" :disabled="!canGenerate || working" @click="generateAndWrite">
            {{ working ? '处理中...' : '生成并写入世界书' }}
          </button>
          <button class="zhino-btn-sm" :disabled="!canWriteCurrent || working" @click="writeCurrentProfile">
            写入当前缓存
          </button>
        </div>
      </div>

      <div v-if="statusText" class="npc-status">{{ statusText }}</div>
      <div v-if="errorText" class="npc-error">{{ errorText }}</div>
    </div>

    <div v-if="writeResult" class="zhino-section npc-card">
      <div class="zhino-section-header">
        <div class="zhino-section-title">写入结果</div>
        <span class="npc-meta">{{ writeResult.bookName }}</span>
      </div>
      <div class="npc-tags">
        <code>&lt;{{ writeResult.indexTagName }}&gt;</code>
        <code>&lt;{{ writeResult.profileTagName }}&gt;</code>
      </div>
      <pre class="npc-preview">{{ writeResult.content }}</pre>
    </div>

    <div v-else class="npc-empty">
      选择 NPC 和楼层范围后，会把无详细设定的 NPC 补成“小传 + 采访”，并写入世界书。
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMainStore, type CharacterProfile } from '../stores/mainStore';
import { executeCharacterProfile } from '../core/characterProfile';
import {
  hasNpcWorldbookApi,
  writeNpcProfileToWorldbook,
  type NpcWorldbookWriteResult,
} from '../core/npcWorldbook';
import { logError } from '../utils/logger';

const store = useMainStore();

const selectedNpc = ref('');
const startFloor = ref(0);
const endFloor = ref(0);
const fullMode = ref(true);
const targetBookName = ref('');
const working = ref(false);
const statusText = ref('');
const errorText = ref('');
const writeResult = ref<NpcWorldbookWriteResult | null>(null);

const characterNames = computed(() => {
  try {
    const ignored = new Set(store.chatData.ignoredCharacters || []);
    const names = new Set<string>();
    for (const name of store.getAllCharacterNames()) {
      if (name && !ignored.has(name)) names.add(name);
    }
    for (const profile of store.chatData.dynamicProfilesV2 || []) {
      if (profile.characterName && !ignored.has(profile.characterName)) names.add(profile.characterName);
    }
    for (const name of Object.keys(store.chatData.characterProfiles || {})) {
      if (name && !ignored.has(name)) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  } catch (error) {
    logError('NPC世界书', '角色列表读取失败', error);
    return [];
  }
});

const targetBooks = computed(() => {
  const books = new Set<string>();
  for (const entry of store.chatData.worldBookEntries || []) {
    if (entry.book) books.add(entry.book);
  }
  return [...books].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
});

const maxFloor = computed(() => {
  void store.chatContentRevision;
  const ids = (store.chatData.capturedContents || []).map(item => item.messageId);
  return ids.length > 0 ? Math.max(...ids) : 0;
});

const currentProfile = computed<CharacterProfile | undefined>(() => {
  if (!selectedNpc.value) return undefined;
  return store.getCharacterProfile(selectedNpc.value);
});

const canGenerate = computed(() => {
  return !!selectedNpc.value
    && Number.isFinite(startFloor.value)
    && Number.isFinite(endFloor.value)
    && startFloor.value <= endFloor.value
    && startFloor.value >= 0;
});

const canWriteCurrent = computed(() => !!selectedNpc.value && !!currentProfile.value);

watch(selectedNpc, name => {
  if (!name || maxFloor.value <= 0) return;
  startFloor.value = Math.max(0, maxFloor.value - 30);
  endFloor.value = maxFloor.value;
});

function nextNpcTagId(npcName: string): number {
  const existing = (store.chatData.worldBookTagBindings || []).find(
    binding => binding.kind === 'character' && binding.characterName === npcName,
  );
  if (existing?.tagId) return existing.tagId;
  const max = (store.chatData.worldBookTagBindings || []).reduce((acc, binding) => Math.max(acc, binding.tagId || 0), 0);
  return max + 1;
}

async function generateAndWrite(): Promise<void> {
  if (!canGenerate.value || working.value) return;
  if (!hasNpcWorldbookApi()) {
    errorText.value = '当前环境没有可用的世界书写入 API。';
    return;
  }
  working.value = true;
  statusText.value = '';
  errorText.value = '';
  writeResult.value = null;
  try {
    const profile = await executeCharacterProfile({
      npcName: selectedNpc.value,
      startFloor: startFloor.value,
      endFloor: endFloor.value,
      fullMode: fullMode.value,
      capturedContents: store.chatData.capturedContents,
      userName: store.getUserName(),
    });
    store.setCharacterProfile(selectedNpc.value, profile);
    await writeProfile(profile);
  } catch (error: any) {
    logError('NPC世界书', '生成或写入失败', error);
    errorText.value = `处理失败：${error?.message || String(error)}`;
  } finally {
    working.value = false;
  }
}

async function writeCurrentProfile(): Promise<void> {
  if (!currentProfile.value || working.value) return;
  if (!hasNpcWorldbookApi()) {
    errorText.value = '当前环境没有可用的世界书写入 API。';
    return;
  }
  working.value = true;
  statusText.value = '';
  errorText.value = '';
  writeResult.value = null;
  try {
    await writeProfile(currentProfile.value);
  } catch (error: any) {
    logError('NPC世界书', '写入缓存失败', error);
    errorText.value = `写入失败：${error?.message || String(error)}`;
  } finally {
    working.value = false;
  }
}

async function writeProfile(profile: CharacterProfile): Promise<void> {
  const result = await writeNpcProfileToWorldbook({
    npcName: selectedNpc.value,
    profile,
    tagId: nextNpcTagId(selectedNpc.value),
    targetBookName: targetBookName.value,
  });
  writeResult.value = result;
  upsertNpcBindings(result);
  statusText.value = `已写入「${result.bookName}」并登记智脑索引`;
}

function upsertNpcBindings(result: NpcWorldbookWriteResult): void {
  const byId = new Map((store.chatData.worldBookTagBindings || []).map(binding => [binding.id, binding]));
  for (const binding of result.bindings) {
    byId.set(binding.id, binding);
    const exists = (store.chatData.worldBookEntries || []).some(entry => entry.book === binding.book && entry.uid === binding.uid && entry.entryName === binding.entryName);
    if (!exists) {
      store.chatData.worldBookEntries.push({
        key: binding.displayKey,
        book: binding.book,
        uid: binding.uid,
        entryName: binding.entryName,
      });
    }
  }
  store.chatData.worldBookTagBindings = [...byId.values()];
  store.chatData.worldBookEntries = [...store.chatData.worldBookEntries];
  store.forcePersist();
}
</script>

<style scoped>
.npc-wb-tab {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
}
.npc-card {
  flex-shrink: 0;
}
.npc-meta {
  font-size: 11px;
  color: var(--zn-text-muted);
}
.npc-form {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.npc-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.npc-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--zn-text-muted);
}
.npc-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--zn-text-regular);
}
.npc-check input {
  accent-color: rgba(var(--zn-accent-rgb), 0.85);
}
.npc-actions,
.npc-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.npc-status,
.npc-error,
.npc-empty {
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
}
.npc-status {
  margin-top: 8px;
  color: rgba(var(--zn-success-rgb), 0.9);
  background: rgba(var(--zn-success-rgb), 0.08);
}
.npc-error {
  margin-top: 8px;
  color: rgba(var(--zn-danger-rgb), 0.9);
  background: rgba(var(--zn-danger-rgb), 0.08);
}
.npc-empty {
  color: var(--zn-text-muted);
  background: var(--zn-surface-sunken);
}
code {
  color: rgba(var(--zn-accent-rgb), 0.9);
  word-break: break-all;
}
.npc-preview {
  margin-top: 8px;
  max-height: 360px;
  overflow-y: auto;
  padding: 10px;
  border-radius: 6px;
  border: 1px solid var(--zn-border-light);
  background: var(--zn-surface-sunken);
  color: var(--zn-text-regular);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
}
@media (max-width: 680px) {
  .npc-row {
    grid-template-columns: 1fr;
  }
}
</style>
