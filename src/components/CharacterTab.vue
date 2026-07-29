<script setup lang="ts">
import { useMainStore } from '../stores/mainStore';
import type { CharacterMemory } from '../stores/mainStore';
import type { NsfwCharacterMemory } from '../core/nsfwIsolation';
import type { DynamicProfileV2 } from '../core/dynamicProfileV2';
import { executeDynamicProfileV2 } from '../core/dynamicProfileV2';
import { useIsMobile } from '../composables/useIsMobile';
import { Modal, SubTabNav } from './ui';
import { logError } from '../utils/logger';
import { readRecentAssistantContents } from '../utils/chatContent';
import CharacterSheetHeader from './CharacterSheetHeader.vue';
import InventoryGrid from './InventoryGrid.vue';
import ItemEditModal from './ItemEditModal.vue';
import type { KnowledgeGraph, OwnedItem } from '../core/knowledgeGraph';
import { getItemsBelongingTo, createEmptyKnowledgeGraph } from '../core/knowledgeGraph';
const store = useMainStore();
const isMobile = useIsMobile();

onMounted(() => {
  store.ensureWorldProgressMemoriesFromRecords();
});

// 列表数据计算异常提示（与"暂无数据"区分，让用户知道是出错而非真空）
const charactersError = ref('');
const archiveError = ref('');

const selectedCharacter = ref('');
// 视图切换：记忆 vs 人设V2
const viewMode = ref<'memory' | 'profileV2'>('memory');
// 合并角色弹窗状态
const showMergePopup = ref(false);
const mergeSourceName = ref('');  // 被合并的角色（副角色）
const mergeTargetName = ref('');  // 合并目标（主角色）

const isDeleting = ref(false); // 编辑角色模式：显示删除按钮
const isAnalyzingProfile = ref(false); // 手动分析动态人设中

// RPG 角色卡/背包数据
const graph = computed<KnowledgeGraph>(() => store.chatData.knowledgeGraph || createEmptyKnowledgeGraph());
const characterOwnedItems = computed<OwnedItem[]>(() => {
  if (!selectedCharacter.value) return [];
  const names = [selectedCharacter.value, ...(selectedMemory.value?.aliases || [])];
  return getItemsBelongingTo(graph.value, names);
});

const showItemModal = ref(false);
const itemModalMode = ref<'edit' | 'add'>('add');
const editingItem = ref<OwnedItem | undefined>(undefined);
const modalDefaultOwner = ref('');

function onEditItem(item: OwnedItem) {
  editingItem.value = item;
  itemModalMode.value = 'edit';
  modalDefaultOwner.value = selectedCharacter.value;
  showItemModal.value = true;
}
function onAddItem() {
  editingItem.value = undefined;
  itemModalMode.value = 'add';
  modalDefaultOwner.value = selectedCharacter.value;
  showItemModal.value = true;
}

// 从知识图谱中删除指定物品（深拷贝 → splice → 清旧边 → 提交）
function onDeleteItem(item: OwnedItem) {
  const g = graph.value;
  const next: KnowledgeGraph = JSON.parse(JSON.stringify(g));
  const idx = next.items.findIndex(i => i.id === item.item.id);
  if (idx < 0) return;
  next.items.splice(idx, 1);
  const itemId = item.item.id;
  next.edges = (next.edges || []).filter(e => !(e.type === 'belongs_to' && e.from === itemId));
  next.updatedAt = new Date().toISOString();
  store.setKnowledgeGraphWithoutHistory(next);
}
function onUpdateLocation(locationName: string) {
  if (!selectedCharacter.value || !locationName.trim()) return;
  store.setCharacterLocation(selectedCharacter.value, locationName.trim());
}

// 角色详情内 tab：档案 / 背包
const activeTab = ref<'profile' | 'inventory'>('profile');
const tabItems = [
  { key: 'profile', label: '档案' },
  { key: 'inventory', label: '背包' },
];

function deleteMemoryItem(item: any) {
  if (!selectedCharacter.value || !item?.text) return;
  store.removeCharacterMemoryItem({
    characterName: selectedCharacter.value,
    text: item.text,
    sourceVersion: item.sourceVersion,
    source: item.source,
    id: item.id,
  });
}
// NSFW 记忆
const showNsfw = ref(false);
const editingNsfwSensitivePoints = ref('');
const editingNsfwPreferences = ref('');
const editingNsfwBehaviors = ref('');
const editingNsfwMemories = ref('');

// 语义召回上限（每角色）
const editingRecallLimit = ref(store.settings.memoryRecallLimit);
const editingRecallEnabled = ref(true);
const selectedRecallLimit = computed(() => {
  if (!selectedCharacter.value) return store.settings.memoryRecallLimit;
  const delta = store.getLatestDelta();
  if (!delta) return store.settings.memoryRecallLimit;
  const mem = delta.characterMemories.find(m => m.characterName === selectedCharacter.value);
  return (mem as any)?.recallLimit ?? store.settings.memoryRecallLimit;
});
const selectedRecallEnabled = computed(() => {
  if (!selectedCharacter.value) return true;
  const delta = store.getLatestDelta();
  if (!delta) return true;
  const mem = delta.characterMemories.find(m => m.characterName === selectedCharacter.value);
  return (mem as any)?.recallEnabled ?? true;
});

// 当前选中角色的 NSFW 记忆
const selectedNsfwMem = computed((): NsfwCharacterMemory | undefined => {
  if (!selectedCharacter.value) return undefined;
  return store.nsfwMemories.find(m => m.characterName === selectedCharacter.value);
});
// 是否有实际 NSFW 内容（不只是空壳）
const hasNsfwContent = computed(() => {
  const m = selectedNsfwMem.value;
  if (!m) return false;
  return m.sensitivePoints.length > 0 || m.preferences.length > 0 || m.behaviors.length > 0 || m.memories.length > 0;
});

// 记忆控制弹窗
const showMemoryControl = ref(false);
const memoryMinLocal = ref(store.settings.memoryMinPerChar);
const memoryMaxLocal = ref(store.settings.memoryMaxPerChar);
const recentVersionsLocal = ref(store.settings.recentMemoryVersions ?? 1);
const corePreview = computed(() => Math.max(1, Math.ceil(memoryMaxLocal.value / 3)));

function saveMemoryControl() {
  if (memoryMaxLocal.value < memoryMinLocal.value) {
    memoryMaxLocal.value = memoryMinLocal.value;
  }
  if (recentVersionsLocal.value < 1) recentVersionsLocal.value = 1;
  if (recentVersionsLocal.value > 5) recentVersionsLocal.value = 5;
  store.updateSettings({
    memoryMinPerChar: memoryMinLocal.value,
    memoryMaxPerChar: memoryMaxLocal.value,
    recentMemoryVersions: recentVersionsLocal.value,
  });
  showMemoryControl.value = false;
}

function resetMemoryControl() {
  memoryMinLocal.value = 4;
  memoryMaxLocal.value = 8;
  recentVersionsLocal.value = 1;
}

function openMemoryControl() {
  memoryMinLocal.value = store.settings.memoryMinPerChar;
  memoryMaxLocal.value = store.settings.memoryMaxPerChar;
  recentVersionsLocal.value = store.settings.recentMemoryVersions ?? 1;
  showMemoryControl.value = true;
}

// 追忆弹窗
const showArchive = ref(false);
const archiveCharacter = ref('');

// 追忆编辑
const editingArchiveText = ref('');
const editingArchiveVersion = ref(-1);
const editingArchiveIdx = ref(-1);

function openArchive(name: string) {
  archiveCharacter.value = name;
  showArchive.value = true;
  editingArchiveVersion.value = -1;
}

// 归档数据用 computed 缓存，跳过无记忆记录的版本
const archiveData = computed(() => {
  if (!showArchive.value || !archiveCharacter.value) return [];
  try {
    archiveError.value = '';
    return store.getCharacterMemoryArchive(archiveCharacter.value).filter(v => v.memories.length > 0);
  } catch (e) { logError('角色', '追忆数据获取失败', String(e)); archiveError.value = '追忆数据读取异常，请刷新页面重试'; return []; }
});

function formatArchiveTime(value?: string) {
  if (!value) return '无时间';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function startArchiveEdit(version: number, idx: number, currentText: string) {
  editingArchiveVersion.value = version;
  editingArchiveIdx.value = idx;
  editingArchiveText.value = currentText;
}

function saveArchiveEdit() {
  const version = editingArchiveVersion.value;
  const idx = editingArchiveIdx.value;
  if (version < 0 || idx < 0) return;
  const summary = store.chatData.summaries.find((s: any) => s.version === version);
  if (!summary) return;
  const mem = summary.characterMemories.find((m: any) => m.characterName === archiveCharacter.value);
  if (!mem) return;
  const ordered = (mem as any).orderedNewMemories as Array<{ text: string; isCore: boolean }> | undefined;
  if (!ordered || idx >= ordered.length) return;
  ordered[idx] = { text: editingArchiveText.value.trim(), isCore: ordered[idx].isCore, time: (ordered[idx] as any).time };
  const sIdx = store.chatData.summaries.findIndex((s: any) => s.version === version);
  if (sIdx >= 0) store.chatData.summaries[sIdx] = { ...store.chatData.summaries[sIdx] };
  store.rebuildAssembled();
  store.forcePersist();
  editingArchiveVersion.value = -1;
}

function cancelArchiveEdit() {
  editingArchiveVersion.value = -1;
}

function deleteArchiveItem(version: number, item: any) {
  if (!archiveCharacter.value || !item?.text) return;
  store.removeCharacterMemoryItem({
    characterName: archiveCharacter.value,
    text: item.text,
    sourceVersion: version >= 0 ? version : undefined,
    source: item.source,
    id: item.id,
  });
  editingArchiveVersion.value = -1;
}
function toggleArchiveCore(version: number, idx: number) {
  if (version < 0) return;
  const summary = store.chatData.summaries.find((s: any) => s.version === version);
  if (!summary) return;
  const mem = summary.characterMemories.find((m: any) => m.characterName === archiveCharacter.value);
  if (!mem) return;
  const ordered = (mem as any).orderedNewMemories as Array<{ text: string; isCore: boolean }> | undefined;
  if (!ordered || idx >= ordered.length) return;
  const wasCore = ordered[idx].isCore;
  const newCore = !wasCore;
  ordered[idx] = { text: ordered[idx].text, isCore: newCore, time: (ordered[idx] as any).time };

  // 同步 coreMemories 数组（用于 embedding 存储）
  const text = ordered[idx].text;
  const cores: any[] = mem.coreMemories || [];
  if (newCore) {
    // 转为核心：添加到 coreMemories（若已存在则不重复）
    const exists = cores.some((c: any) => (typeof c === 'string' ? c : c.text) === text);
    if (!exists) cores.push({ text });
  } else {
    // 转为近期：从 coreMemories 移除（删除 embedding 也一并清除）
    const rmIdx = cores.findIndex((c: any) => (typeof c === 'string' ? c : c.text) === text);
    if (rmIdx >= 0) cores.splice(rmIdx, 1);
  }
  mem.coreMemories = cores;
  const sIdx = store.chatData.summaries.findIndex((s: any) => s.version === version);
  if (sIdx >= 0) store.chatData.summaries[sIdx] = { ...store.chatData.summaries[sIdx] };
  store.rebuildAssembled();
  store.forcePersist();
}

// 角色记忆逐条内联编辑
const editingItemIdx = ref(-1);
const editingItemText = ref('');
const editingItemTime = ref('');
const editingItemIsCore = ref(false);

function startItemEdit(idx: number) {
  const item = memoryDisplayItems.value[idx];
  if (!item) return;
  if ((item as any).source === 'world_progress') return;
  editingItemIdx.value = idx;
  editingItemText.value = item.text;
  editingItemTime.value = (item as any).time || '';
  editingItemIsCore.value = item.isCore;
}

function saveItemEdit() {
  const idx = editingItemIdx.value;
  if (idx < 0) return;
  const item = memoryDisplayItems.value[idx];
  if (!item) return;
  if ((item as any).source === 'world_progress') { cancelItemEdit(); return; }
  const srcVer = (item as any).sourceVersion as number | undefined;
  const newText = editingItemText.value.trim();
  const newTime = editingItemTime.value.trim();
  const newIsCore = editingItemIsCore.value;
  if (!newText) { cancelItemEdit(); return; }

  // 按 sourceVersion 找到所属 delta，写回 orderedNewMemories
  const summary = srcVer != null
    ? store.chatData.summaries.find((s: any) => s.version === srcVer)
    : store.getLatestDelta();
  if (!summary) { cancelItemEdit(); return; }
  const selectedName = store.resolveKnownCharacterName(selectedCharacter.value, true);
  const mem = summary.characterMemories.find((m: any) => {
    const names = [m.characterName, ...(m.aliases || [])];
    return names.some(name => store.resolveKnownCharacterName(name, true) === selectedName);
  });
  if (!mem) { cancelItemEdit(); return; }
  const ordered = (mem as any).orderedNewMemories as Array<{ text: string; isCore: boolean; time?: string }> | undefined;
  if (!ordered) { cancelItemEdit(); return; }

  // 按文本匹配找到原始条目（同一版本内可能有重复文本，按首次匹配）
  const matchIdx = ordered.findIndex(o => o.text === item.text);
  if (matchIdx >= 0) {
    ordered[matchIdx] = { text: newText, isCore: newIsCore, time: newTime || undefined };
  } else {
    // 未匹配到 → 追加
    ordered.push({ text: newText, isCore: newIsCore, time: newTime || undefined });
  }

  // 同步 coreMemories
  const cores: any[] = mem.coreMemories || [];
  if (newIsCore) {
    const exists = cores.some((c: any) => (typeof c === 'string' ? c : c.text) === newText);
    if (!exists) cores.push({ text: newText, time: newTime || undefined });
    // 旧文本从 coreMemories 移除（如果变了）
    if (item.text !== newText) {
      const rmIdx = cores.findIndex((c: any) => (typeof c === 'string' ? c : c.text) === item.text);
      if (rmIdx >= 0) cores.splice(rmIdx, 1);
    }
  } else {
    const rmIdx = cores.findIndex((c: any) => (typeof c === 'string' ? c : c.text) === item.text || (typeof c === 'string' ? c : c.text) === newText);
    if (rmIdx >= 0) cores.splice(rmIdx, 1);
  }
  mem.coreMemories = cores;

  const sIdx = store.chatData.summaries.findIndex((s: any) => s.version === summary.version);
  if (sIdx >= 0) store.chatData.summaries[sIdx] = { ...store.chatData.summaries[sIdx] };
  store.rebuildAssembled();
  store.forcePersist();
  editingItemIdx.value = -1;
}

function cancelItemEdit() {
  editingItemIdx.value = -1;
}

// NSFW 独立编辑
const isEditingNsfw = ref(false);

function startEditNsfw() {
  const nsfw = selectedNsfwMem.value;
  editingNsfwSensitivePoints.value = (nsfw?.sensitivePoints || []).join('\n');
  editingNsfwPreferences.value = (nsfw?.preferences || []).join('\n');
  editingNsfwBehaviors.value = (nsfw?.behaviors || []).join('\n');
  editingNsfwMemories.value = (nsfw?.memories || []).join('\n');
  isEditingNsfw.value = true;
}

function saveEditNsfw() {
  if (!selectedCharacter.value) return;
  const nsfwLinesFn = (str: string) => str.split('\n').map(l => l.trim()).filter(Boolean);
  const nsfwNew: NsfwCharacterMemory = {
    characterName: selectedCharacter.value,
    sensitivePoints: nsfwLinesFn(editingNsfwSensitivePoints.value),
    preferences: nsfwLinesFn(editingNsfwPreferences.value),
    behaviors: nsfwLinesFn(editingNsfwBehaviors.value),
    memories: nsfwLinesFn(editingNsfwMemories.value),
    lastUpdatedAt: new Date().toISOString(),
  };
  const canonicalName = store.resolveKnownCharacterName(selectedCharacter.value, true);
  nsfwNew.characterName = canonicalName;
  const nsfwIdx = store.chatData.nsfwMemories.findIndex(
    m => store.resolveKnownCharacterName(m.characterName, true) === canonicalName,
  );
  if (nsfwIdx >= 0) {
    store.chatData.nsfwMemories[nsfwIdx] = nsfwNew;
  } else {
    store.chatData.nsfwMemories.push(nsfwNew);
  }
  store.forcePersist();
  isEditingNsfw.value = false;
}

function cancelEditNsfw() {
  isEditingNsfw.value = false;
}

// 召回上限弹窗
const showRecallPopup = ref(false);
const recallPopupChar = ref('');

function openRecallLimit(name: string) {
  recallPopupChar.value = name;
  editingRecallLimit.value = selectedRecallLimit.value;
  editingRecallEnabled.value = selectedRecallEnabled.value;
  showRecallPopup.value = true;
}

function saveRecallLimit() {
  const delta = store.getLatestDelta();
  if (!delta) return;
  const mem = delta.characterMemories.find(m => m.characterName === recallPopupChar.value);
  if (mem) {
    (mem as any).recallLimit = editingRecallLimit.value;
    (mem as any).recallEnabled = editingRecallEnabled.value;
  }
  showRecallPopup.value = false;
  const lastIdx = store.chatData.summaries.length - 1;
  if (lastIdx >= 0) store.chatData.summaries[lastIdx] = { ...store.chatData.summaries[lastIdx] };
  store.rebuildAssembled();
  store.forcePersist();
}

// 所有角色名：统一走 store 角色索引，排除已忽略/用户自身。
const allCharacters = computed(() => {
  try {
    return store.getAllCharacterNames();
  } catch (e) { logError('角色', '角色数据读取异常', String(e)); charactersError.value = '角色数据读取异常，请刷新页面重试'; return []; }
});

// 当前选中角色的记忆（融合后）
const selectedMemory = computed((): CharacterMemory | undefined => {
  if (!selectedCharacter.value) return undefined;
  return store.getCharacterMemories(selectedCharacter.value);
});


// 当前选中角色的动态人设V2
const selectedProfileV2 = computed((): DynamicProfileV2 | undefined => {
  if (!selectedCharacter.value) return undefined;
  return (store.chatData.dynamicProfilesV2 || []).find(
    (p: DynamicProfileV2) => p.characterName === selectedCharacter.value,
  );
});

// 动态人设V2编辑
const editingFactualState = ref('');
const editingDynamicProfileV2 = ref('');
const isEditingV2 = ref(false);

function startEditV2() {
  const p = selectedProfileV2.value;
  editingFactualState.value = p?.factualState?.replace(/<\/?factual_state>/g, '').trim() || '';
  editingDynamicProfileV2.value = p?.dynamicProfile?.replace(/<\/?dynamic_profile>/g, '').trim() || '';
  isEditingV2.value = true;
}

function saveEditV2() {
  if (!selectedCharacter.value) return;
  const profiles = store.chatData.dynamicProfilesV2 || [];
  const idx = profiles.findIndex((p: DynamicProfileV2) => p.characterName === selectedCharacter.value);
  const newProfile: DynamicProfileV2 = {
    characterName: selectedCharacter.value,
    factualState: editingFactualState.value.trim() ? `<factual_state>\n${editingFactualState.value.trim()}\n</factual_state>` : '',
    dynamicProfile: editingDynamicProfileV2.value.trim() ? `<dynamic_profile>\n${editingDynamicProfileV2.value.trim()}\n</dynamic_profile>` : '',
    lastUpdatedAt: new Date().toISOString(),
  };
  if (idx >= 0) {
    profiles[idx] = newProfile;
  } else {
    profiles.push(newProfile);
  }
  store.chatData.dynamicProfilesV2 = [...profiles];
  store.forcePersist();
  isEditingV2.value = false;
}

function cancelEditV2() {
  isEditingV2.value = false;
}

// 记忆条目的排序展示列表
const memoryDisplayItems = computed(() => {
  const mem = selectedMemory.value;
  if (!mem) return [];
  const ordered = (mem as any)._orderedItems as Array<{ text: string; isCore: boolean; time?: string; source?: string; id?: string; floor?: number }> | undefined;
  if (ordered && ordered.length > 0) return ordered;
  return (mem.memories || []).map((m: string) => {
    const match = m.match(/^\[(核心|近期)\](.*)/);
    return match
      ? { text: match[2].trim(), isCore: match[1] === '核心' }
      : { text: m, isCore: false };
  });
});

async function triggerDynamicProfileV2() {
  if (isAnalyzingProfile.value) return;
  isAnalyzingProfile.value = true;
  try {
    const contents = readRecentAssistantContents(2, undefined, store.chatData.capturedContents);
    if (contents.length === 0) {
      try { (window as any).toastr?.warning('没有可读取的有效正文，请先进行对话', '⚠️', { timeOut: 3000 }); } catch (_) {}
      return;
    }
    const characterEntries = store.getCharacterNameEntries();
    const result = await executeDynamicProfileV2(
      contents,
      store.chatData.dynamicProfilesV2 || [],
      store.getUserName(),
      undefined,
      characterEntries,
    );
    store.chatData.dynamicProfilesV2 = result.profiles;
    store.chatData.lastDynamicProfileFloor = Math.max(...contents.map(c => c.messageId), store.chatData.lastDynamicProfileFloor ?? 0);
    store.forcePersist();
    try { (window as any).toastr?.success(`动态人设分析完成: ${result.profiles.length} 角色`, '✅', { timeOut: 3000 }); } catch (_) {}
  } catch (e) {
    logError('动态人设', '手动分析失败', String(e));
    try { (window as any).toastr?.error('动态人设分析失败: ' + String(e), '❌', { timeOut: 4000 }); } catch (_) {}
  } finally {
    isAnalyzingProfile.value = false;
  }
}

function selectCharacter(name: string) {
  selectedCharacter.value = name;
  editingItemIdx.value = -1;
  isEditingNsfw.value = false;
}

function removeCharacter(name: string) {
  if (confirm(`确定要删除角色「${name}」吗？\n\n删除后：\n- 该角色的所有信息（记忆/人设/关系/位置等）将被彻底清除\n- 物品保留，但归属该角色的物品 owner/位置 会置空\n- 此操作不可撤销`)) {
    // 移除角色后，如果当前选中的就是这个角色，清除选中
    if (selectedCharacter.value === name) {
      selectedCharacter.value = '';
    }
    store.deleteCharacter(name);
    store.forcePersist();
  }
}

// 合并角色
function openMergePopup(sourceName: string) {
  mergeSourceName.value = sourceName;
  mergeTargetName.value = '';
  showMergePopup.value = true;
}

function confirmMerge() {
  if (!mergeTargetName.value || !mergeSourceName.value) return;
  if (mergeTargetName.value === mergeSourceName.value) return;
  const ok = store.mergeCharacters(mergeTargetName.value, mergeSourceName.value);
  if (ok) {
    showMergePopup.value = false;
    // 如果当前选中的是被合并的角色，切换到目标角色
    if (selectedCharacter.value === mergeSourceName.value) {
      selectedCharacter.value = mergeTargetName.value;
      editingItemIdx.value = -1;
      isEditingNsfw.value = false;
    }
    try { (window as any).toastr?.success(`已将「${mergeSourceName.value}」合并到「${mergeTargetName.value}」`, '✅ 合并成功', { timeOut: 3000 }); } catch (_) {}
  }
}

// 角色改名弹窗状态
const showRenamePopup = ref(false);
const renameOldName = ref('');
const renameNewName = ref('');

// 新建角色弹窗状态
const showAddPopup = ref(false);
const newCharName = ref('');
const newCharAliases = ref('');
const newCharLocation = ref('');
const newCharCustomLoc = ref('');
const newCharError = ref('');

function openRenamePopup(name: string) {
  renameOldName.value = name;
  renameNewName.value = '';
  showRenamePopup.value = true;
}

function confirmRename() {
  const newName = renameNewName.value.trim();
  if (!newName || !renameOldName.value) return;
  const ok = store.renameCharacter(renameOldName.value, newName);
  if (ok) {
    // 若当前选中的是被改名的角色，切换到新名
    if (selectedCharacter.value === renameOldName.value) {
      selectedCharacter.value = newName;
      editingItemIdx.value = -1;
      isEditingNsfw.value = false;
    }
    showRenamePopup.value = false;
    try { (window as any).toastr?.success(`已将「${renameOldName.value}」改名为「${newName}」`, '✅ 改名成功', { timeOut: 3000 }); } catch (_) {}
  } else {
    try { (window as any).toastr?.error('改名失败：新名已存在或非法。\n若新名已是角色库里的其它角色，请改用「合并角色」功能。',
      '❌ 改名失败', { timeOut: 4000, extendedTimeOut: 2000, escapeHtml: false }); } catch (_) {}
  }
}

function openAddPopup() {
  newCharName.value = '';
  newCharAliases.value = '';
  newCharLocation.value = '';
  newCharCustomLoc.value = '';
  newCharError.value = '';
  showAddPopup.value = true;
}

function confirmAddCharacter() {
  const name = newCharName.value.trim();
  if (!name) {
    newCharError.value = '名称不能为空';
    return;
  }
  const aliases = newCharAliases.value
    .split('\n')
    .map(a => a.trim())
    .filter(Boolean);
  let locationName = '';
  if (newCharLocation.value === '__custom__') {
    locationName = newCharCustomLoc.value.trim();
  } else if (newCharLocation.value) {
    locationName = newCharLocation.value;
  }
  const ok = store.addCharacter(name, aliases, locationName || undefined);
  if (ok) {
    selectedCharacter.value = name;
    editingItemIdx.value = -1;
    isEditingNsfw.value = false;
    showAddPopup.value = false;
    try { (window as any).toastr?.success(`已新建角色「${name}」`, '✅ 新建成功', { timeOut: 3000 }); } catch (_) {}
  } else {
    newCharError.value = '新建失败：该名称或别名已存在角色';
  }
}

</script>

<template>
  <div class="zhino-character">
    <!-- 滚动内容区 -->
    <div class="zhino-char-scroll">
      <!-- 顶部按钮栏 -->
      <div class="zhino-char-topbar">
        <button class="zhino-memory-ctrl-btn" @click="openMemoryControl" title="记忆控制">
          记忆控制
        </button>
        <button
          class="zhino-memory-ctrl-btn"
          :disabled="isAnalyzingProfile"
          @click="triggerDynamicProfileV2"
          title="用最新正文重新分析所有角色的动态人设"
        >
          {{ isAnalyzingProfile ? '分析中…' : '分析动态人设' }}
        </button>
        <button
          v-if="allCharacters.length > 0"
          class="zhino-btn-sm zhino-edit-role-btn"
          :class="{ 'zhino-btn-delete-mode': isDeleting }"
          @click="isDeleting = !isDeleting"
        >
          {{ isDeleting ? '结束编辑' : '编辑角色' }}
        </button>
        <button
          class="zhino-btn-sm zhino-edit-role-btn"
          @click="openAddPopup"
          title="手动新建一个角色（名称+别名+所在地）"
        >
          ＋ 新建角色
        </button>
      </div>

      <!-- 角色列表 -->
      <div class="zhino-section">
        <div class="zhino-section-header">
          <div class="zhino-section-title">角色列表 ({{ allCharacters.length }})</div>
        </div>
        <div v-if="allCharacters.length === 0" class="zhino-empty-hint">
          <template v-if="charactersError">{{ charactersError }}</template>
          <template v-else>暂无角色数据（完成首次大总结后显示）</template>
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
            <span v-if="isDeleting" class="zhino-char-merge" title="合并到其他角色" @click.stop="openMergePopup(name)">⇄</span>
            <span v-if="isDeleting" class="zhino-char-delete" title="忽略此角色" @click.stop="removeCharacter(name)">✕</span>
          </button>
        </div>
      </div>


      <!-- 角色详情 -->
      <template v-if="selectedCharacter">
        <div class="zhino-section">
          <div class="zhino-section-header">
            <div class="zhino-section-title">{{ selectedCharacter }} 详情</div>
            <div class="zhino-btn-group">
              <button class="zhino-btn-sm zhino-btn-archive" @click="openArchive(selectedCharacter)">追忆</button>
              <button v-if="store.settings.embeddingEnabled" class="zhino-btn-sm" @click="openRecallLimit(selectedCharacter)">召回</button>
              <button class="zhino-btn-sm" @click="openRenamePopup(selectedCharacter)">改名</button>
            </div>
          </div>

          <!-- RPG 角色卡头部 -->
          <CharacterSheetHeader
            :character-name="selectedCharacter"
            :aliases="selectedMemory?.aliases"
            :attitude="selectedMemory?.attitude"
            :location="store.getCharacterLocation(selectedCharacter)"
            @update-location="onUpdateLocation"
          />

          <SubTabNav
            :model-value="activeTab"
            :items="tabItems"
            class="zhino-subtab"
            @update:model-value="activeTab = $event as CharTab"
          />

          <div v-show="activeTab === 'profile'" class="zhino-profile-body">

          <div class="zhino-detail-block">
            <div class="zhino-detail-label">记忆条目：</div>
            <div v-if="memoryDisplayItems.length > 0" class="zhino-memory-list">
              <div v-for="(item, idx) in memoryDisplayItems" :key="idx" class="zhino-memory-item" :class="{ 'is-core': item.isCore, 'is-recent': !item.isCore }">
                <template v-if="editingItemIdx === idx">
                  <button
                    class="zhino-memory-edit-core"
                    :class="{ active: editingItemIsCore }"
                    @click="editingItemIsCore = !editingItemIsCore"
                    :title="editingItemIsCore ? '核心记忆' : '近期记忆'"
                  >
                    {{ editingItemIsCore ? '核心' : '近期' }}
                  </button>
                  <input
                    v-model="editingItemTime"
                    class="zhino-memory-edit-time"
                    placeholder="日期"
                  />
                  <textarea
                    v-model="editingItemText"
                    class="zhino-memory-edit-text"
                    rows="1"
                    placeholder="记忆内容（第一人称）"
                  />
                  <button class="zhino-memory-edit-save" @click="saveItemEdit" title="保存">✓</button>
                  <button class="zhino-memory-edit-del" @click="cancelItemEdit" title="取消">✕</button>
                </template>
                <template v-else>
                  <span class="zhino-memory-badge">{{ (item as any).source === 'world_progress' ? '推' : item.isCore ? '核心' : '近期' }}</span>
                  <span v-if="(item as any).time" class="zhino-memory-time">{{ (item as any).time }}</span>
                  <span class="zhino-memory-text">{{ item.text }}</span>
                  <button v-if="(item as any).source !== 'world_progress'" class="zhino-memory-edit-btn" @click="startItemEdit(idx)" title="编辑此条">✎</button>
                  <button class="zhino-memory-edit-del" @click="deleteMemoryItem(item)" title="delete">X</button>
                </template>
              </div>
            </div>
            <div v-else class="zhino-empty-hint">无记忆数据</div>
          </div>

          <div class="zhino-detail-block">
            <div class="zhino-detail-label">激活关键词：</div>
            <div v-if="selectedMemory && selectedMemory.keywords.length > 0" class="zhino-tag-list">
              <span v-for="kw in selectedMemory.keywords" :key="kw" class="zhino-tag">{{ kw }}</span>
            </div>
            <div v-else class="zhino-empty-hint">无关键词</div>
          </div>

          <div class="zhino-detail-block">
            <div class="zhino-detail-label">
              动态人设：
              <button v-if="selectedProfileV2 && !isEditingV2" class="zhino-btn-sm" style="margin-left:8px;font-size:10px;padding:1px 6px" @click="startEditV2">编辑</button>
            </div>
            <!-- V2 查看 -->
            <template v-if="selectedProfileV2 && !isEditingV2">
              <template v-if="selectedProfileV2.factualState">
                <div class="zhino-detail-label" style="font-size:10px;margin-top:2px">事实状态层</div>
                <div class="zhino-profile-text" style="margin-bottom:6px">{{ selectedProfileV2.factualState.replace(/<\/?factual_state[^>]*>/g, '').trim() }}</div>
              </template>
              <template v-if="selectedProfileV2.dynamicProfile">
                <div class="zhino-detail-label" style="font-size:10px;margin-top:2px">表现层</div>
                <div class="zhino-profile-text">{{ selectedProfileV2.dynamicProfile.replace(/<\/?dynamic_profile[^>]*>/g, '').trim() }}</div>
              </template>
              <div style="font-size:10px;color:var(--zn-text-muted);margin-top:4px">更新于 {{ selectedProfileV2.lastUpdatedAt?.slice(0, 16) }}</div>
            </template>
            <!-- V2 编辑 -->
            <template v-else-if="selectedProfileV2 && isEditingV2">
              <div class="zhino-detail-label" style="font-size:10px;margin-top:2px">事实状态层</div>
              <textarea v-model="editingFactualState" class="zhino-textarea" rows="4" placeholder="服装：白色长裙&#10;位置：庭院&#10;身体状态：轻微疲倦&#10;持有物品：无&#10;已知信息：..." />
              <div class="zhino-detail-label" style="font-size:10px;margin-top:8px">表现层</div>
              <textarea v-model="editingDynamicProfileV2" class="zhino-textarea" rows="4" placeholder="行为倾向：会主动找话题 = 想延长相处时间 | 不要理解为黏人&#10;禁止假设：&#10;- 不要假设她已经..." />
              <div style="margin-top:6px">
                <button class="zhino-btn-sm zhino-btn-save" @click="saveEditV2">保存</button>
                <button class="zhino-btn-sm" @click="cancelEditV2" style="margin-left:4px">取消</button>
              </div>
            </template>
          </div>

        <!-- NSFW 记忆 -->
          <div class="zhino-detail-block">
            <Collapsible v-model="showNsfw" title="NSFW 记忆">
              <template #actions>
                <span v-if="hasNsfwContent" class="zhino-nsfw-has-data">有数据</span>
                <button v-if="showNsfw && !isEditingNsfw" class="zhino-btn-sm zhino-nsfw-edit-btn" @click.stop="startEditNsfw">编辑</button>
              </template>
              <template v-if="isEditingNsfw">
                <div class="zhino-nsfw-field">
                  <span class="zhino-detail-label">身体敏感点：</span>
                  <textarea v-model="editingNsfwSensitivePoints" class="zhino-textarea" rows="2" placeholder="每行一个" />
                </div>
                <div class="zhino-nsfw-field">
                  <span class="zhino-detail-label">性爱偏好：</span>
                  <textarea v-model="editingNsfwPreferences" class="zhino-textarea" rows="2" placeholder="每行一个" />
                </div>
                <div class="zhino-nsfw-field">
                  <span class="zhino-detail-label">行为模式：</span>
                  <textarea v-model="editingNsfwBehaviors" class="zhino-textarea" rows="2" placeholder="每行一个（主动/被动等）" />
                </div>
                <div class="zhino-nsfw-field">
                  <span class="zhino-detail-label">细节记忆：</span>
                  <textarea v-model="editingNsfwMemories" class="zhino-textarea" rows="3" placeholder="每行一条（第一人称）" />
                </div>
                <div style="margin-top:6px">
                  <button class="zhino-btn-sm zhino-btn-save" @click="saveEditNsfw">保存</button>
                  <button class="zhino-btn-sm" @click="cancelEditNsfw" style="margin-left:4px">取消</button>
                </div>
              </template>
              <template v-else>
                <div v-if="hasNsfwContent">
                  <div v-if="selectedNsfwMem.sensitivePoints.length > 0" class="zhino-nsfw-row">
                    <span class="zhino-detail-label">身体敏感点：</span>
                    <span class="zhino-tag-list">
                      <span v-for="(sp, i) in selectedNsfwMem.sensitivePoints" :key="'sp-'+i" class="zhino-tag zhino-tag-nsfw">{{ sp }}</span>
                    </span>
                  </div>
                  <div v-if="selectedNsfwMem.preferences.length > 0" class="zhino-nsfw-row">
                    <span class="zhino-detail-label">性爱偏好：</span>
                    <span class="zhino-tag-list">
                      <span v-for="(p, i) in selectedNsfwMem.preferences" :key="'p-'+i" class="zhino-tag zhino-tag-nsfw">{{ p }}</span>
                    </span>
                  </div>
                  <div v-if="selectedNsfwMem.behaviors.length > 0" class="zhino-nsfw-row">
                    <span class="zhino-detail-label">行为模式：</span>
                    <span class="zhino-tag-list">
                      <span v-for="(b, i) in selectedNsfwMem.behaviors" :key="'b-'+i" class="zhino-tag zhino-tag-nsfw">{{ b }}</span>
                    </span>
                  </div>
                  <div v-if="selectedNsfwMem.memories.length > 0" class="zhino-nsfw-row">
                    <span class="zhino-detail-label">细节记忆：</span>
                    <div class="zhino-memory-list" style="margin-top:2px">
                      <div v-for="(m, i) in selectedNsfwMem.memories" :key="'m-'+i" class="zhino-memory-item zhino-nsfw-memory-item">{{ m }}</div>
                    </div>
                  </div>
                  <div class="zhino-nsfw-updated" v-if="selectedNsfwMem.lastUpdatedAt">
                    更新于 {{ new Date(selectedNsfwMem.lastUpdatedAt).toLocaleString() }}
                  </div>
                </div>
                <div v-else class="zhino-empty-hint">该角色暂无 NSFW 记忆数据</div>
              </template>
            </Collapsible>
          </div>

        </div>

        <!-- 背包 tab -->
        <div v-show="activeTab === 'inventory'" class="zhino-inventory-body">
          <InventoryGrid
            :items="characterOwnedItems"
            @edit="onEditItem"
            @add="onAddItem"
          />
        </div>
      </div>
      </template>
    </div>

    <!-- 追忆弹窗 -->
    <Modal :visible="showArchive" :is-mobile="isMobile" :title="`追忆：${archiveCharacter}`" @close="showArchive = false">
      <div class="zhino-archive-list">
        <div v-if="archiveData.length === 0" class="zhino-empty-hint">
          <template v-if="archiveError">{{ archiveError }}</template>
          <template v-else>该角色暂无记忆记录</template>
        </div>
        <div v-for="ver in archiveData" :key="ver.version" class="zhino-archive-version">
          <div class="zhino-archive-ver-header">
            {{ ver.label || `大总结 v${ver.version}` }}（{{ formatArchiveTime(ver.generatedAt) }}）
          </div>
          <div v-for="(item, idx) in ver.memories" :key="idx" class="zhino-archive-item" :class="{ 'is-core': item.isCore }">
            <span class="zhino-memory-badge">{{ (item as any).source === 'world_progress' ? '推' : item.isCore ? '核心' : '近期' }}</span>
            <span v-if="(item as any).time" class="zhino-memory-time">{{ (item as any).time }}</span>
            <template v-if="editingArchiveVersion === ver.version && editingArchiveIdx === idx">
              <textarea v-model="editingArchiveText" class="zhino-archive-input" @keydown.ctrl.enter="saveArchiveEdit" @keydown.escape="cancelArchiveEdit" autofocus rows="3"></textarea>
              <div class="zhino-archive-item-actions">
                <button class="zhino-btn-sm zhino-btn-save" @click="saveArchiveEdit">✓</button>
                <button class="zhino-btn-sm" @click="cancelArchiveEdit">✗</button>
              </div>
            </template>
            <template v-else>
              <span class="zhino-memory-text">{{ item.text }}</span>
              <div class="zhino-archive-item-actions">
                <button v-if="(item as any).source !== 'world_progress'" class="zhino-btn-sm zhino-btn-toggle" @click="toggleArchiveCore(ver.version, idx)" :title="item.isCore ? '转为近期' : '转为核心'">↻</button>
                <button v-if="(item as any).source !== 'world_progress'" class="zhino-btn-sm zhino-btn-edit" @click="startArchiveEdit(ver.version, idx, item.text)" title="编辑">✎</button>
                <button class="zhino-btn-sm zhino-btn-delete" @click="deleteArchiveItem(ver.version, item)" title="delete">X</button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </Modal>

    <!-- 召回上限弹窗 -->
    <Modal :visible="showRecallPopup" :is-mobile="isMobile" :title="`${recallPopupChar} · 召回上限`" @close="showRecallPopup = false">
      <div class="zhino-memory-ctrl-desc">远期核心记忆语义召回时，该角色最多返回多少条</div>
      <div class="zhino-memory-ctrl-row">
        <span class="zhino-memory-ctrl-label">上限</span>
        <input type="range" class="zhino-slider" v-model.number="editingRecallLimit" min="1" max="30" />
        <span class="zhino-memory-ctrl-value">{{ editingRecallLimit }}</span>
      </div>
      <div class="zhino-memory-ctrl-row" style="margin-top:12px">
        <span class="zhino-memory-ctrl-label">召回开关</span>
        <label class="zhino-recall-toggle">
          <input type="checkbox" v-model="editingRecallEnabled" />
          <span class="zhino-recall-toggle-slider"></span>
        </label>
        <span class="zhino-recall-toggle-label">{{ editingRecallEnabled ? '语义召回' : '全量注入' }}</span>
      </div>
      <div class="zhino-memory-ctrl-preview">全局默认 {{ store.settings.memoryRecallLimit }} 条</div>
      <div class="zhino-memory-ctrl-preview" style="color:rgba(var(--zn-success-rgb),0.7)">💡 关闭召回 = 远期核心记忆全部注入（适合重要角色）</div>
      <template #footer>
        <button class="zhino-btn-sm" @click="showRecallPopup = false">取消</button>
        <button class="zhino-btn-sm zhino-btn-save" @click="saveRecallLimit">保存</button>
      </template>
    </Modal>

    <!-- 角色合并弹窗 -->
    <Modal :visible="showMergePopup" :is-mobile="isMobile" title="合并角色" @close="showMergePopup = false">
      <div class="zhino-merge-desc">
        将「<strong>{{ mergeSourceName }}</strong>」的所有记忆、关键词、别名合并到目标角色中，副角色将被移除。
      </div>
      <div class="zhino-merge-field">
        <span class="zhino-detail-label">合并到：</span>
        <select v-model="mergeTargetName" class="zhino-merge-select">
          <option value="" disabled>选择目标角色</option>
          <option
            v-for="name in allCharacters.filter(n => n !== mergeSourceName)"
            :key="name"
            :value="name"
          >{{ name }}</option>
        </select>
      </div>
      <div v-if="mergeTargetName" class="zhino-merge-preview">
        「{{ mergeSourceName }}」→「{{ mergeTargetName }}」<br/>
        <span class="zhino-merge-hint">• 副角色的记忆去重追加到主角色<br/>• 副角色名加入主角色别名<br/>• 动态人设保留主角色的版本<br/>• 操作不可撤销（已自动备份）</span>
      </div>
      <template #footer>
        <button class="zhino-btn-sm" @click="showMergePopup = false">取消</button>
        <button
          class="zhino-btn-sm zhino-btn-save"
          :disabled="!mergeTargetName"
          @click="confirmMerge"
        >确认合并</button>
      </template>
    </Modal>

    <!-- 角色改名弹窗 -->
    <Modal :visible="showRenamePopup" :is-mobile="isMobile" title="改名为" @close="showRenamePopup = false">
      <div class="zhino-merge-desc">
        将「<strong>{{ renameOldName }}</strong>」改名为新主名。原名会保留为别名，之后 AI/正文用旧名仍能匹配到该角色。
      </div>
      <div class="zhino-merge-field">
        <span class="zhino-detail-label">新名：</span>
        <input class="zhino-input" v-model="renameNewName" placeholder="输入新的主名" style="flex:1"
               @keydown.enter="confirmRename" @keydown.escape="showRenamePopup = false" autofocus />
      </div>
      <div v-if="renameNewName.trim()" class="zhino-merge-preview">
        「{{ renameOldName }}」→「{{ renameNewName.trim() }}」<br/>
        <span class="zhino-merge-hint">• 原名保留为别名<br/>• 所有记忆/人设/关系/图谱引用同步更新<br/>• 若新名已是角色库里的其它角色，请改用「合并角色」</span>
      </div>
      <template #footer>
        <button class="zhino-btn-sm" @click="showRenamePopup = false">取消</button>
        <button
          class="zhino-btn-sm zhino-btn-save"
          :disabled="!renameNewName.trim()"
          @click="confirmRename"
        >确认改名</button>
      </template>
    </Modal>

    <!-- 新建角色弹窗 -->
    <Modal :visible="showAddPopup" :is-mobile="isMobile" title="新建角色" @close="showAddPopup = false">
      <div class="zhino-merge-desc">
        手动新建一个角色并加入角色库。新建后该角色的记忆/人设将由后续大总结自动生成。
      </div>
      <div class="zhino-merge-field">
        <span class="zhino-detail-label">名称：</span>
        <input class="zhino-input" v-model="newCharName" placeholder="输入角色主名（必填）" style="flex:1"
               @keydown.enter="confirmAddCharacter" @keydown.escape="showAddPopup = false" autofocus />
      </div>
      <div class="zhino-merge-field" style="align-items: flex-start;">
        <span class="zhino-detail-label">别名：</span>
        <textarea class="zhino-input" v-model="newCharAliases" placeholder="每行一个别名，可留空" rows="3" style="flex:1; resize: vertical;"></textarea>
      </div>
      <div class="zhino-merge-field">
        <span class="zhino-detail-label">所在地：</span>
        <select v-model="newCharLocation" class="zhino-merge-select" style="flex:1">
          <option value="">不指定</option>
          <option v-for="loc in graph.locations" :key="loc.id" :value="loc.name">{{ loc.name }}</option>
          <option value="__custom__">＋ 输入新地点</option>
        </select>
      </div>
      <div v-if="newCharLocation === '__custom__'" class="zhino-merge-field">
        <span class="zhino-detail-label">新地点：</span>
        <input class="zhino-input" v-model="newCharCustomLoc" placeholder="输入地点名" style="flex:1" />
      </div>
      <div v-if="newCharError" class="zhino-merge-hint" style="color: var(--zn-danger-rgb, #e06c75);">
        {{ newCharError }}
      </div>
      <div v-if="newCharName.trim()" class="zhino-merge-preview">
        新建「{{ newCharName.trim() }}」
        <span v-if="newCharAliases.trim()">（别名: {{ newCharAliases.split('\n').map(s=>s.trim()).filter(Boolean).join('、') }}）</span>
        <span v-if="(newCharLocation === '__custom__' ? newCharCustomLoc.trim() : newCharLocation)"> @ {{ newCharLocation === '__custom__' ? newCharCustomLoc.trim() : newCharLocation }}</span>
      </div>
      <template #footer>
        <button class="zhino-btn-sm" @click="showAddPopup = false">取消</button>
        <button
          class="zhino-btn-sm zhino-btn-save"
          :disabled="!newCharName.trim()"
          @click="confirmAddCharacter"
        >确认新建</button>
      </template>
    </Modal>

    <!-- 记忆控制弹窗 -->
    <Modal :visible="showMemoryControl" :is-mobile="isMobile" title="记忆控制" @close="showMemoryControl = false">
      <div class="zhino-memory-ctrl-desc">控制每次大总结时每个角色生成的记忆条目数量</div>
      <div class="zhino-memory-ctrl-row">
        <span class="zhino-memory-ctrl-label">最少记忆</span>
        <input type="range" class="zhino-slider" :value="memoryMinLocal" min="3" max="10" @input="memoryMinLocal = Number(($event.target as HTMLInputElement).value)" />
        <span class="zhino-memory-ctrl-value">{{ memoryMinLocal }}</span>
      </div>
      <div class="zhino-memory-ctrl-row">
        <span class="zhino-memory-ctrl-label">最多记忆</span>
        <input type="range" class="zhino-slider" :value="memoryMaxLocal" min="3" max="12" @input="memoryMaxLocal = Number(($event.target as HTMLInputElement).value)" />
        <span class="zhino-memory-ctrl-value">{{ memoryMaxLocal }}</span>
      </div>
      <div class="zhino-section-title" style="margin-top:12px">角色记忆力</div>
      <div class="zhino-memory-ctrl-desc">（核心记忆永远保留，近期记忆逐渐遗忘）</div>
      <div class="zhino-memory-ctrl-row">
        <span class="zhino-memory-ctrl-label">记忆量</span>
        <input type="range" class="zhino-slider" :value="recentVersionsLocal" min="1" max="5" @input="recentVersionsLocal = Number(($event.target as HTMLInputElement).value)" />
        <span class="zhino-memory-ctrl-value">{{ recentVersionsLocal }}</span>
      </div>
      <div class="zhino-memory-ctrl-preview">保留最近 <strong>{{ recentVersionsLocal }}</strong> 次总结的近期记忆</div>
      <div class="zhino-memory-ctrl-preview" style="margin-top:6px">每次生成 <strong>{{ memoryMinLocal }}-{{ memoryMaxLocal }}</strong> 条记忆，其中核心 <strong>1-{{ corePreview }}</strong> 条</div>
      <template #footer>
        <div class="zhino-modal-footer-spread">
          <button class="zhino-btn-sm" @click="resetMemoryControl">恢复默认</button>
          <div class="zhino-btn-group">
            <button class="zhino-btn-sm" @click="showMemoryControl = false">取消</button>
            <button class="zhino-btn-sm zhino-btn-save" @click="saveMemoryControl">保存</button>
          </div>
        </div>
      </template>
    </Modal>

    <!-- 物品编辑/新增弹窗 -->
    <ItemEditModal
      :visible="showItemModal"
      :mode="itemModalMode"
      :item="editingItem"
      :default-owner="modalDefaultOwner"
      @close="showItemModal = false"
      @delete="onDeleteItem"
    />
  </div>
</template>

<style scoped>
.zhino-character {
  flex: 1;
  min-height: 0;
  position: relative;
}

/* 内部滚动容器 */
.zhino-char-scroll {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 顶部按钮栏 */
.zhino-char-topbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-bottom: 8px;
}

/* 记忆控制按钮 */
.zhino-memory-ctrl-btn {
  padding: 2px 10px;
  font-size: 11px;
  border-radius: 10px;
  border: 1px solid var(--zn-border-base);
  background: var(--zn-bg-surface1);
  color: var(--zn-text-muted);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-memory-ctrl-btn:hover {
  background: rgba(var(--zn-accent-rgb), 0.12);
  border-color: rgba(var(--zn-accent-rgb), 0.3);
  color: rgba(var(--zn-accent-rgb), 0.8);
}

/* 编辑角色按钮 */
.zhino-edit-role-btn {
/* 视图切换 */
.zhino-view-toggle {
  display: flex;
  gap: 0;
  border: 1px solid var(--zn-border-base);
  border-radius: 6px;
  overflow: hidden;
}
.zhino-view-btn {
  padding: 3px 12px;
  font-size: 11px;
  border: none;
  background: var(--zn-bg-surface1);
  color: var(--zn-text-muted);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-view-btn:hover { color: var(--zn-text-primary); }
.zhino-view-btn.active {
  background: rgba(var(--zn-accent-rgb), 0.15);
  color: rgba(var(--zn-accent-rgb), 0.9);
}

/* 动态人设V2 */
.zhino-v2-display {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.zhino-v2-block {
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-light);
  border-radius: 6px;
  padding: 8px 10px;
}
.zhino-v2-pre {
  font-size: 11px;
  color: var(--zn-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
  margin: 4px 0 0 0;
  font-family: inherit;
}
.zhino-v2-meta {
  font-size: 10px;
  color: var(--zn-text-muted);
}
.zhino-v2-edit {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

  margin-left: 0 !important;
}

/* Modal footer 两端分布（恢复默认靠左 / 取消+保存 靠右） */
.zhino-modal-footer-spread {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 8px;
}
.zhino-merge-desc {
  font-size: 12px;
  color: var(--zn-text-regular);
  margin-bottom: 12px;
  line-height: 1.5;
}
.zhino-merge-desc strong {
  color: rgba(var(--zn-accent-rgb), 0.9);
}
.zhino-merge-field {
  margin-bottom: 10px;
}
.zhino-merge-select {
  width: 100%;
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-base);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--zn-text-primary);
  outline: none;
  cursor: pointer;
  margin-top: 4px;
}
.zhino-merge-select:focus {
  border-color: var(--zn-primary);
}
.zhino-merge-preview {
  padding: 8px 10px;
  background: rgba(var(--zn-accent-rgb), 0.06);
  border: 1px solid rgba(var(--zn-accent-rgb), 0.15);
  border-radius: 6px;
  font-size: 12px;
  color: rgba(var(--zn-accent-rgb), 0.85);
  line-height: 1.5;
}
.zhino-merge-hint {
  font-size: 11px;
  color: var(--zn-text-muted);
  line-height: 1.6;
}

.zhino-memory-ctrl-desc {
  font-size: 11px;
  color: var(--zn-text-muted);
  margin-bottom: 12px;
}
.zhino-memory-ctrl-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.zhino-memory-ctrl-label {
  font-size: 12px;
  color: var(--zn-text-regular);
  white-space: nowrap;
}
.zhino-memory-ctrl-value {
  font-size: 14px;
  font-weight: 600;
  color: rgba(var(--zn-accent-rgb), 0.9);
  min-width: 20px;
  text-align: center;
}
.zhino-memory-ctrl-preview {
  font-size: 11px;
  color: var(--zn-text-muted);
  padding: 6px 10px;
  background: var(--zn-bg-surface1);
  border-radius: 6px;
  border: 1px solid var(--zn-border-light);
}
.zhino-memory-ctrl-preview strong {
  color: rgba(var(--zn-accent-rgb), 0.8);
}

/* 滑块 */
.zhino-slider {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 2px;
  background: var(--zn-border-base);
  outline: none;
}
.zhino-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(var(--zn-accent-rgb), 0.9);
  border: 2px solid #1e1e2e;
  cursor: pointer;
}
.zhino-slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(var(--zn-accent-rgb), 0.9);
  border: 2px solid #1e1e2e;
  cursor: pointer;
}

.zhino-section {
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-light);
  border-radius: 8px;
  padding: 10px 12px;
}
.zhino-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--zn-text-regular);
  margin-bottom: 8px;
  letter-spacing: 0.5px;
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
  border: 1px solid var(--zn-border-base);
  background: var(--zn-bg-surface1);
  color: var(--zn-text-regular);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
}
.zhino-char-merge {
  color: rgba(var(--zn-accent-rgb), 0.5);
  font-size: 16px;
  font-weight: bold;
  margin-left: 6px;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  line-height: 1;
  flex-shrink: 0;
  padding: 0 3px;
  cursor: pointer;
}
.zhino-char-merge:hover {
  color: rgba(var(--zn-accent-rgb), 0.9);
}
.zhino-char-delete {
  color: var(--zn-text-muted);
  font-size: 22px;
  font-weight: bold;
  margin-left: 10px;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  line-height: 1;
  flex-shrink: 0;
  padding: 0 4px;
}
.zhino-char-delete:hover {
  color: var(--zn-danger);
}
.zhino-btn-delete-mode {
  background: rgba(var(--zn-danger-rgb), 0.2);
  border-color: rgba(var(--zn-danger-rgb), 0.35);
  color: var(--zn-danger);
}
.zhino-char-item:hover {
  background: rgba(var(--zn-accent-rgb), 0.08);
  border-color: rgba(var(--zn-accent-rgb), 0.2);
}
.zhino-char-item.active {
  background: rgba(var(--zn-accent-rgb), 0.15);
  border-color: rgba(var(--zn-accent-rgb), 0.3);
  color: rgba(var(--zn-accent-rgb), 0.9);
}
.zhino-char-attitude {
  font-size: 10px;
}
.zhino-char-attitude.like { color: var(--zn-success); }
.zhino-char-attitude.dislike { color: var(--zn-danger); }
.zhino-char-attitude.neutral { color: var(--zn-text-muted); }

.zhino-detail-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  margin-bottom: 6px;
}
.zhino-detail-label {
  color: var(--zn-text-muted);
  font-size: 11px;
  margin-bottom: 4px;
}
.zhino-detail-value {
  color: var(--zn-text-primary);
}
.attitude-like { color: var(--zn-success); }
.attitude-dislike { color: var(--zn-danger); }
.attitude-neutral { color: var(--zn-text-muted); }

.zhino-detail-block {
  margin-top: 10px;
}

.zhino-memory-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.zhino-memory-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  color: var(--zn-text-regular);
  padding: 4px 8px;
  background: var(--zn-bg-surface1);
  border-radius: 4px;
  border-left: 2px solid rgba(var(--zn-accent-rgb), 0.3);
}
.zhino-memory-item.is-core {
  border-left-color: rgba(var(--zn-success-rgb), 0.5);
  background: rgba(var(--zn-success-rgb), 0.04);
}
.zhino-memory-item.is-recent {
  border-left-color: rgba(var(--zn-warn-rgb), 0.4);
}
.zhino-memory-badge {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 8px;
  line-height: 1.5;
}
.is-core .zhino-memory-badge {
  background: rgba(var(--zn-success-rgb), 0.15);
  color: rgba(var(--zn-success-rgb), 0.85);
}
.is-recent .zhino-memory-badge {
  background: rgba(var(--zn-warn-rgb), 0.12);
  color: rgba(var(--zn-warn-rgb), 0.8);
}
.zhino-memory-time {
  flex-shrink: 0;
  font-size: 10px;
  color: rgba(var(--zn-accent-rgb), 0.7);
  padding: 1px 4px;
  background: rgba(var(--zn-accent-rgb), 0.08);
  border-radius: 4px;
  line-height: 1.4;
}
.zhino-memory-text {
  flex: 1;
  line-height: 1.5;
}

/* ---- 记忆编辑逐条模式 ---- */
.zhino-memory-edit-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.zhino-memory-edit-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 4px;
  border: 1px solid var(--zn-border-light);
  border-radius: 6px;
  background: var(--zn-bg-surface1);
}

.zhino-memory-edit-time {
  width: 120px;
  flex-shrink: 0;
  padding: 4px 6px;
  border: 1px solid var(--zn-border-base);
  border-radius: 4px;
  background: var(--zn-bg-surface1);
  color: rgba(var(--zn-accent-rgb), 0.9);
  font-size: 11px;
  font-family: var(--zn-font-mono);
  outline: none;
}
.zhino-memory-edit-time:focus {
  border-color: rgba(var(--zn-accent-rgb), 0.4);
}
.zhino-memory-edit-time::placeholder {
  color: var(--zn-text-muted);
}

.zhino-memory-edit-text {
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid var(--zn-border-base);
  border-radius: 4px;
  background: var(--zn-bg-surface1);
  color: var(--zn-text-primary);
  font-size: 12px;
  font-family: inherit;
  resize: vertical;
  outline: none;
  line-height: 1.45;
}
.zhino-memory-edit-text:focus {
  border-color: rgba(var(--zn-danger-rgb), 0.35);
}

.zhino-memory-edit-core {
  flex-shrink: 0;
  padding: 3px 7px;
  border: 1px solid var(--zn-border-base);
  border-radius: 4px;
  background: var(--zn-bg-surface1);
  color: var(--zn-text-muted);
  font-size: 10px;
  cursor: pointer;
  white-space: nowrap;
}
.zhino-memory-edit-core.active {
  border-color: rgba(var(--zn-warn-rgb), 0.4);
  background: rgba(var(--zn-warn-rgb), 0.1);
  color: rgba(var(--zn-warn-rgb), 0.85);
}

.zhino-memory-edit-del {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid rgba(var(--zn-danger-rgb), 0.2);
  border-radius: 4px;
  background: rgba(var(--zn-danger-rgb), 0.06);
  color: rgba(var(--zn-danger-rgb), 0.6);
  font-size: 11px;
  cursor: pointer;
  line-height: 20px;
  text-align: center;
}
.zhino-memory-edit-del:hover {
  border-color: rgba(var(--zn-danger-rgb), 0.5);
  background: rgba(var(--zn-danger-rgb), 0.15);
  color: rgba(var(--zn-danger-rgb), 0.9);
}

.zhino-memory-edit-add {
  align-self: flex-start;
  padding: 5px 12px;
  border: 1px dashed rgba(var(--zn-accent-rgb), 0.25);
  border-radius: 4px;
  background: transparent;
  color: rgba(var(--zn-accent-rgb), 0.6);
  font-size: 11px;
  cursor: pointer;
}
.zhino-memory-edit-add:hover {
  border-color: rgba(var(--zn-accent-rgb), 0.5);
  background: rgba(var(--zn-accent-rgb), 0.06);
  color: rgba(var(--zn-accent-rgb), 0.9);
}

/* 逐条内联编辑按钮 */
.zhino-memory-edit-btn {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--zn-border-base);
  border-radius: 4px;
  background: transparent;
  color: var(--zn-text-muted);
  font-size: 12px;
  cursor: pointer;
  line-height: 20px;
  text-align: center;
  opacity: 0;
  transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1), color 0.2s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-memory-item:hover .zhino-memory-edit-btn {
  opacity: 1;
}
.zhino-memory-edit-btn:hover {
  border-color: rgba(var(--zn-accent-rgb), 0.5);
  color: rgba(var(--zn-accent-rgb), 0.85);
  background: rgba(var(--zn-accent-rgb), 0.08);
}

.zhino-memory-edit-save {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid rgba(var(--zn-success-rgb), 0.3);
  border-radius: 4px;
  background: rgba(var(--zn-success-rgb), 0.08);
  color: rgba(var(--zn-success-rgb), 0.7);
  font-size: 12px;
  cursor: pointer;
  line-height: 20px;
  text-align: center;
}
.zhino-memory-edit-save:hover {
  border-color: rgba(var(--zn-success-rgb), 0.6);
  background: rgba(var(--zn-success-rgb), 0.18);
  color: rgba(var(--zn-success-rgb), 0.95);
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

.zhino-profile-text {
  font-size: 12px;
  color: var(--zn-text-regular);
  line-height: 1.6;
  white-space: pre-wrap;
}

.zhino-empty-hint {
  font-size: 12px;
  color: var(--zn-text-muted);
}

.zhino-textarea {
  width: 100%;
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-base);
  border-radius: 6px;
  padding: 8px;
  font-size: 12px;
  color: var(--zn-text-primary);
  resize: vertical;
  outline: none;
  font-family: inherit;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-textarea:focus {
  border-color: var(--zn-primary);
}

.zhino-input {
  width: 100%;
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-base);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--zn-text-primary);
  outline: none;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-input:focus {
  border-color: var(--zn-primary);
}

.zhino-btn-sm {
  padding: 4px 10px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid var(--zn-border-base);
  background: var(--zn-bg-surface1);
  color: var(--zn-text-regular);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-btn-sm:hover {
  background: var(--zn-bg-surface2);
  color: var(--zn-text-primary);
}
.zhino-btn-save {
  border-color: rgba(var(--zn-accent-rgb), 0.3);
  color: rgba(var(--zn-accent-rgb), 0.9);
}
.zhino-btn-save:hover {
  background: rgba(var(--zn-accent-rgb), 0.15);
}
.zhino-btn-group {
  display: flex;
  gap: 4px;
}

/* 追忆按钮 */
.zhino-btn-archive {
  border-color: rgba(var(--zn-warn-rgb), 0.3) !important;
  color: rgba(var(--zn-warn-rgb), 0.8) !important;
}
.zhino-btn-archive:hover {
  background: rgba(var(--zn-warn-rgb), 0.1) !important;
}

/* 追忆列表（Modal body 内） */
.zhino-archive-list {
  margin-top: 4px;
  padding-bottom: 4px;
}
.zhino-archive-version {
  margin-bottom: 16px;
}
.zhino-archive-ver-header {
  font-size: 11px;
  color: var(--zn-text-muted);
  border-bottom: 1px solid var(--zn-border-light);
  padding-bottom: 4px;
  margin-bottom: 6px;
}
.zhino-archive-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--zn-text-regular);
  padding: 4px 6px;
  background: var(--zn-bg-surface1);
  border-radius: 4px;
  margin-bottom: 3px;
  border-left: 2px solid rgba(var(--zn-accent-rgb), 0.3);
}
.zhino-archive-item.is-core {
  border-left-color: rgba(var(--zn-success-rgb), 0.5);
  background: rgba(var(--zn-success-rgb), 0.04);
}
.zhino-archive-item .zhino-memory-badge {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 8px;
  line-height: 1.5;
}
.zhino-archive-item.is-core .zhino-memory-badge {
  background: rgba(var(--zn-success-rgb), 0.15);
  color: rgba(var(--zn-success-rgb), 0.85);
}
.zhino-archive-item:not(.is-core) .zhino-memory-badge {
  background: rgba(var(--zn-warn-rgb), 0.12);
  color: rgba(var(--zn-warn-rgb), 0.8);
}
.zhino-archive-item .zhino-memory-time {
  flex-shrink: 0;
  font-size: 10px;
  color: rgba(var(--zn-accent-rgb), 0.7);
  padding: 1px 4px;
  background: rgba(var(--zn-accent-rgb), 0.08);
  border-radius: 4px;
  line-height: 1.4;
}
.zhino-memory-text {
  flex: 1;
  line-height: 1.5;
}
.zhino-archive-item-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-archive-item:hover .zhino-archive-item-actions {
  opacity: 1;
}
.zhino-btn-toggle {
  border-color: rgba(var(--zn-accent-rgb), 0.25) !important;
  color: rgba(var(--zn-accent-rgb), 0.7) !important;
  font-size: 14px !important;
  line-height: 1;
}
.zhino-btn-toggle:hover {
  background: rgba(var(--zn-accent-rgb), 0.15) !important;
}
.zhino-btn-edit {
  font-size: 12px !important;
}
.zhino-archive-input {
  flex: 1;
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-primary);
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 12px;
  color: var(--zn-text-primary);
  outline: none;
  font-family: inherit;
  resize: vertical;
  line-height: 1.5;
  white-space: pre-wrap;
}

/* NSFW 记忆 */
.zhino-nsfw-field {
  margin-bottom: 8px;
}
.zhino-nsfw-field .zhino-textarea {
  margin-top: 2px;
}
.zhino-nsfw-row {
  margin-bottom: 8px;
}
.zhino-nsfw-row .zhino-detail-label {
  margin-bottom: 2px;
}
.zhino-nsfw-memory-item {
  border-left-color: rgba(var(--zn-danger-rgb), 0.4) !important;
  background: rgba(var(--zn-danger-rgb), 0.04) !important;
}
.zhino-nsfw-updated {
  font-size: 10px;
  color: var(--zn-text-muted);
  margin-top: 6px;
}
.zhino-tag-nsfw {
  background: rgba(var(--zn-danger-rgb), 0.1);
  border-color: rgba(var(--zn-danger-rgb), 0.2);
  color: rgba(var(--zn-danger-rgb), 0.8);
}

/* NSFW 折叠头：标题/箭头由 <Collapsible> 提供，此处仅状态徽标 + 编辑按钮 */
.zhino-nsfw-has-data {
  font-size: 10px;
  color: rgba(var(--zn-danger-rgb), 0.75);
  background: rgba(var(--zn-danger-rgb), 0.1);
  padding: 1px 6px;
  border-radius: 999px;
  line-height: 1.5;
}
.zhino-nsfw-edit-btn {
  margin-left: 8px;
  font-size: 10px;
  padding: 1px 6px;
}

/* 行为逻辑树 */
.zhino-behavior-tree {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}
.zhino-behavior-node {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  font-size: 11px;
  padding: 4px 8px;
  background: var(--zn-bg-surface1);
  border-radius: 4px;
  border-left: 2px solid rgba(var(--zn-accent-rgb), 0.25);
  flex-wrap: wrap;
  line-height: 1.5;
}
.zhino-behavior-fallback {
  border-left-color: rgba(var(--zn-warn-rgb), 0.4);
}
.zhino-behavior-condition {
  color: rgba(var(--zn-success-rgb), 0.8);
  font-weight: 500;
  word-break: break-word;
}
.zhino-behavior-fallback .zhino-behavior-condition {
  color: rgba(var(--zn-warn-rgb), 0.8);
}
.zhino-behavior-arrow {
  color: var(--zn-text-muted);
  flex-shrink: 0;
}
.zhino-behavior-action {
  color: var(--zn-text-primary);
  word-break: break-word;
}
.zhino-behavior-loc {
  color: var(--zn-text-muted);
  font-size: 10px;
  flex-shrink: 0;
}
.zhino-behavior-priority {
  color: rgba(var(--zn-accent-rgb), 0.5);
  font-size: 10px;
  flex-shrink: 0;
}

/* 召回开关 toggle */
.zhino-recall-toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
}
.zhino-recall-toggle input { display: none; }
.zhino-recall-toggle-slider {
  position: absolute;
  inset: 0;
  background: var(--zn-border-base);
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.2s;
}
.zhino-recall-toggle-slider::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  left: 2px;
  top: 2px;
  background: var(--zn-text-regular);
  border-radius: 50%;
  transition: transform 0.2s;
}
.zhino-recall-toggle input:checked + .zhino-recall-toggle-slider {
  background: rgba(var(--zn-success-rgb), 0.6);
}
.zhino-recall-toggle input:checked + .zhino-recall-toggle-slider::before {
  transform: translateX(16px);
  background: #fff;
}
.zhino-recall-toggle-label {
  font-size: 11px;
  color: var(--zn-text-muted);
  margin-left: 8px;
}

/* 角色详情内子 tab */
.zhino-subtab {
  margin: 8px 0 4px;
}
.zhino-profile-body,
.zhino-inventory-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.zhino-pending-section {
  border: 1px solid #EF9F27;
  background: rgba(250, 238, 218, 0.08);
}
.zhino-pending-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
  margin-top: 6px;
}
.zhino-pending-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
}
.zhino-pending-name { font-weight: 500; }
.zhino-pending-count { color: #888780; font-size: 11px; }
.zhino-pending-candidates { color: #B4B2A9; }
.zhino-pending-unknown { color: #E24B4A; }
.zhino-pending-snippet {
  color: #888780;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
