<script setup lang="ts">
import { ref, nextTick, reactive } from 'vue';
import { useMainStore } from '../stores/mainStore';
import { fetchAvailableModels } from '../utils/apiCaller';
import { useIsMobile } from '../composables/useIsMobile';
import { Modal, Collapsible } from './ui';
import RecallSettingsPanel from './RecallSettingsPanel.vue';
import { logInfo, logError } from '../utils/logger';
import {
  JAILBREAK_PROMPT_TYPES,
  getDefaultJailbreakPrompt,
  normalizePromptText,
  type JailbreakPromptField,
  type JailbreakPromptOverride,
} from '../utils/jailbreakPrompts';
import {
  measureStorageUsage,
  formatBytes,
  formatPercent,
  type StorageDiagnosticResult,
} from '../utils/storageDiagnostic';
import {
  archiveChatData,
  restoreChatData,
  listArchives,
  deleteArchive,
  updateArchiveName,
  hasArchive,
  hasWorldBookApi,
  getCurrentCharName,
  buildArchiveName,
  type ArchiveListItem,
} from '../core/worldBookArchive';

const store = useMainStore();
const isMobile = useIsMobile();

const currentSetTab = ref('general');

// API 监听器
const showApiMonitor = ref(false);
const monitorSelectedIndex = ref(0);

function formatMonitorTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return iso.slice(11, 19); }
}

function monitorInputText(entry: typeof store.apiMonitorLogs[number]) {
  return entry.messages.map(m => `[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n---\n\n');
}

// 代码日志
const showCodeLog = ref(false);
const expandedId = ref<number | null>(null);

function formatCodeLogTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return iso.slice(11, 19); }
}

function toggleExpand(id: number) {
  expandedId.value = expandedId.value === id ? null : id;
}

// 储存诊断
const storageDiagResult = ref<StorageDiagnosticResult | null>(null);
const storageDiagLoading = ref(false);
const storageDiagExpanded = ref<Record<string, boolean>>({});

function toggleDiagModule(key: string) {
  storageDiagExpanded.value[key] = !storageDiagExpanded.value[key];
}

function runStorageDiagnostic() {
  storageDiagLoading.value = true;
  storageDiagResult.value = null;
  // 用 requestAnimationFrame 让 loading 状态先渲染
  requestAnimationFrame(() => {
    try {
      storageDiagResult.value = measureStorageUsage(
        store.chatData,
        store.scriptData,
      );
    } catch (e: any) {
      logError('储存诊断失败: ' + (e?.message ?? String(e)));
    } finally {
      storageDiagLoading.value = false;
    }
  });
}

/** 根据大小返回 CSS 颜色类 */
function diagSizeClass(bytes: number): string {
  if (bytes >= 1024 * 1024) return 'zhino-diag-red';      // ≥1MB
  if (bytes >= 100 * 1024) return 'zhino-diag-yellow';     // ≥100KB
  return 'zhino-diag-green';
}

// 导入导出
const fileInput = ref<HTMLInputElement>();

// API 库管理
const showApiLibrary = ref(false);
const editingApiId = ref<string | null>(null);
const apiDraft = ref({ id: '', name: '', url: '', key: '', model: '' });
const apiModelList = ref<Record<string, string[]>>({});
const apiModelLoading = ref<Record<string, boolean>>({});
const apiModelError = ref<Record<string, string>>({});
const showJailbreakSettings = ref(false);
const jailbreakExpanded = ref<Record<string, boolean>>({});

const ANALYSIS_TYPES: Array<{ key: string; label: string }> = [
  { key: 'grand_summary', label: '大总结' },
  { key: 'small_summary', label: '小总结' },
  { key: 'dreamtalk', label: '梦呓分析' },
  { key: 'dynamic_profile', label: '动态人设' },
  { key: 'character_memory', label: '角色记忆' },
  { key: 'relationship', label: '关系档案' },
  { key: 'world_progress', label: '世界推进' },
  { key: 'plot_director', label: '剧情导演' },
  { key: 'persona', label: '人设分析' },
  { key: 'character_profile', label: '角色设定' },
  { key: 'character_extract', label: '世界书提取角色' },
];

function addApi() {
  const id = 'api_' + Date.now().toString(36);
  const lib = (store.settings as any).apiLibrary || [];
  store.updateSettings({ apiLibrary: [...lib, { id, name: '新API', url: '', key: '', model: '' }] } as any);
  startEditApi(id);
}

function startEditApi(id: string) {
  const api = ((store.settings as any).apiLibrary || []).find((a: any) => a.id === id);
  if (api) {
    apiDraft.value = { ...api };
    editingApiId.value = id;
  }
}

function saveApi() {
  const id = editingApiId.value;
  if (!id) return;
  const lib = (store.settings as any).apiLibrary || [];
  store.updateSettings({ apiLibrary: lib.map((a: any) => a.id === id ? { ...apiDraft.value } : a) } as any);
  editingApiId.value = null;
}

function cancelEditApi() {
  editingApiId.value = null;
}

function deleteApi(id: string) {
  if (!confirm('确定删除这个API配置吗？')) return;
  const lib = (store.settings as any).apiLibrary || [];
  store.updateSettings({ apiLibrary: lib.filter((a: any) => a.id !== id) } as any);
  const assignments = { ...((store.settings as any).apiAssignments || {}) };
  for (const [type, apiId] of Object.entries(assignments)) {
    if (apiId === id) delete assignments[type];
  }
  store.updateSettings({ apiAssignments: assignments } as any);
}

function assignApi(type: string, apiId: string) {
  const assignments = { ...((store.settings as any).apiAssignments || {}), [type]: apiId };
  store.updateSettings({ apiAssignments: assignments } as any);
}

function getAssignedApiId(type: string): string {
  const assignments = (store.settings as any).apiAssignments || {};
  return assignments[type] || ((store.settings as any).apiLibrary?.[0]?.id ?? '');
}

async function loadApiModels(id: string) {
  // 编辑中的API从草稿读取，已保存的从store读取
  let url: string, key: string;
  if (editingApiId.value === id) {
    url = apiDraft.value.url?.trim() || '';
    key = apiDraft.value.key?.trim() || '';
  } else {
    const api = ((store.settings as any).apiLibrary || []).find((a: any) => a.id === id);
    url = api?.url?.trim() || '';
    key = api?.key?.trim() || '';
  }
  if (!url || !key) {
    apiModelError.value[id] = '请先填写API地址和Key';
    return;
  }
  apiModelLoading.value = { ...apiModelLoading.value, [id]: true };
  apiModelError.value = { ...apiModelError.value, [id]: '' };
  try {
    const models = await fetchAvailableModels(url, key);
    apiModelList.value = { ...apiModelList.value, [id]: models };
  } catch (e: any) {
    apiModelError.value = { ...apiModelError.value, [id]: e?.message || '获取失败' };
  } finally {
    apiModelLoading.value = { ...apiModelLoading.value, [id]: false };
  }
}

function getJailbreakOverrides(): Record<string, JailbreakPromptOverride> {
  return ((store.settings as any).jailbreakOverrides || {}) as Record<string, JailbreakPromptOverride>;
}

function hasJailbreakField(override: JailbreakPromptOverride | undefined, field: JailbreakPromptField): boolean {
  return !!override && Object.prototype.hasOwnProperty.call(override, field);
}

function getJailbreakValue(typeKey: string, field: JailbreakPromptField): string {
  const override = getJailbreakOverrides()[typeKey];
  if (hasJailbreakField(override, field)) {
    return normalizePromptText(override?.[field] ?? '');
  }
  return getDefaultJailbreakPrompt(typeKey)[field];
}

function updateJailbreakValue(typeKey: string, field: JailbreakPromptField, value: string) {
  const normalized = normalizePromptText(value);
  const defaults = getDefaultJailbreakPrompt(typeKey);
  const overrides = { ...getJailbreakOverrides() };
  const current = { ...(overrides[typeKey] || {}) };

  if (normalized === defaults[field]) {
    delete current[field];
  } else {
    current[field] = normalized;
  }

  if (!hasJailbreakField(current, 'head') && !hasJailbreakField(current, 'tail')) {
    delete overrides[typeKey];
  } else {
    overrides[typeKey] = current;
  }

  store.updateSettings({ jailbreakOverrides: overrides } as any);
}

function resetJailbreakType(typeKey: string) {
  const overrides = { ...getJailbreakOverrides() };
  delete overrides[typeKey];
  store.updateSettings({ jailbreakOverrides: overrides } as any);
}

function isJailbreakCustomized(typeKey: string): boolean {
  const override = getJailbreakOverrides()[typeKey];
  return hasJailbreakField(override, 'head') || hasJailbreakField(override, 'tail');
}

function setSchedulerMode(mode: 'concurrent' | 'serial') {
  store.updateSettings({ schedulerMode: mode } as any);
}


// 数据管理
function exportData() {
  const warnings: string[] = [];
  if ((store.scriptData.personas || []).length === 0) {
    warnings.push('当前没有用户人格数据（personas 为空）。');
  }
  if (store.getAllCharacterNames().length === 0) {
    warnings.push('当前没有角色数据（角色库为空）。');
  }
  if (warnings.length > 0) {
    if (!confirm('⚠️ 导出提醒：\n\n' + warnings.join('\n') + '\n\n导出文件可能不完整，是否继续？')) return;
  }
  const data = store.exportAllData();
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `zhino_data_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// 文件选择导入
function handleFileImport(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const content = e.target?.result as string;
    if (!content) return;
    try {
      // 先预检，有警告让用户确认
      const warnings = store.checkImportData(content);
      if (warnings.length > 0) {
        if (!confirm('⚠️ 数据兼容性警告：\n\n' + warnings.join('\n\n') + '\n\n是否继续导入？')) {
          input.value = '';
          return;
        }
      }
      store.importAllData(content);
      logInfo('存储', '数据导入成功');
      try { window.toastr?.success('数据导入成功', '✅ 导入成功', { timeOut: 3000 }); } catch(_) {}
    } catch (err: any) {
      logError('存储', '导入失败', String(err));
      const msg = err?.message || String(err);
      try { window.toastr?.error(msg, '❌ 导入失败', { timeOut: 8000, extendedTimeOut: 3000 }); } catch(_) {}
    }
  };
  reader.readAsText(file);
  input.value = '';
}

// ─── 世界书存档（多存档） ───
const archiveBusy = ref(false);
const archiveMsg = ref('');
const archiveList = ref<ArchiveListItem[]>([]);
const archiveNamePreview = ref('');
// 新建存档弹窗
const showArchiveDialog = ref(false);
const archiveDialogName = ref('');

// 内联编辑存档名称
const editingArchiveId = ref<string | null>(null);
const editingArchiveName = ref('');

async function startEditArchiveName(item: ArchiveListItem) {
  editingArchiveId.value = item.archiveId;
  editingArchiveName.value = item.customName || '';
  await nextTick();
  const input = document.querySelector('.zhino-archive-name-input') as HTMLInputElement | null;
  input?.focus();
  input?.select();
}

async function saveEditArchiveName(archiveId: string) {
  const newName = editingArchiveName.value.trim();
  if (newName === archiveList.value.find(a => a.archiveId === archiveId)?.customName) {
    editingArchiveId.value = null;
    return;
  }
  const r = await updateArchiveName(archiveId, newName, undefined, (store.chatData as any).chatId || '');
  if (r.ok) {
    await refreshArchiveStatus();
  } else {
    archiveMsg.value = `❌ ${r.error || '重命名失败'}`;
  }
  editingArchiveId.value = null;
}

function cancelEditArchiveName() {
  editingArchiveId.value = null;
}

/** 点击"新建存档"→弹出命名弹窗 */
function openArchiveDialog() {
  archiveDialogName.value = '';
  showArchiveDialog.value = true;
  nextTick(() => {
    const input = document.querySelector('.zhino-archive-dialog-input') as HTMLInputElement | null;
    input?.focus();
  });
}

/** 确认存档 */
async function confirmArchive() {
  showArchiveDialog.value = false;
  const customName = archiveDialogName.value.trim() || undefined;
  await doArchive(customName);
}

/** 取消弹窗 */
function cancelArchiveDialog() {
  showArchiveDialog.value = false;
}

async function doArchive(customName?: string) {
  if (archiveBusy.value) return;
  archiveBusy.value = true;
  archiveMsg.value = '';
  try {
    const savedAtFloor = getLatestFloor();
    const result = await archiveChatData(
      store.chatData as any,
      undefined,
      (store.chatData as any).chatId || '',
      customName,
      savedAtFloor,
    );
    if (result.ok) {
      archiveMsg.value = `✅ 已存档 ${result.archiveId}（${formatSize(result.meta?.originalSize || 0)}→${formatSize(result.meta?.compressedSize || 0)}）`;
      try { window.toastr?.success('存档成功', '✅', { timeOut: 3000 }); } catch (_) {}
    } else {
      archiveMsg.value = `❌ ${result.error || '存档失败'}`;
      try { window.toastr?.error(result.error || '存档失败', '❌', { timeOut: 6000 }); } catch (_) {}
    }
    await refreshArchiveStatus();
  } finally {
    archiveBusy.value = false;
  }
}

function refreshArchivePreview() {
  const cName = getCurrentCharName();
  const cId = (store as any).chatData?.chatId || '';
  archiveNamePreview.value = cName ? buildArchiveName(cName, cId) : '（未检测到角色卡）';
}

function formatArchiveTime(iso: string): string {
  try { return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

function formatSize(n: number): string {
  if (n > 10000) return (n / 1024).toFixed(1) + 'KB';
  return n + '字';
}

/** 获取当前最新楼层号 */
function getLatestFloor(): number {
  try {
    const msgs = getChatMessages(-1);
    return msgs.length > 0 ? msgs[0].message_id : 0;
  } catch { return 0; }
}

async function doRestore(archiveId: string) {
  if (archiveBusy.value) return;
  if (!confirm(`确定读取存档 ${archiveId} 吗？当前聊天数据将被覆盖。`)) return;
  archiveBusy.value = true;
  archiveMsg.value = '';
  try {
    const result = await restoreChatData(archiveId, undefined, (store.chatData as any).chatId || '');
    if (result.ok && result.data) {
      (store as any).importChatData(result.data);
      archiveMsg.value = `✅ 已读取存档 ${archiveId}`;
      try { window.toastr?.success('读档成功', '✅', { timeOut: 3000 }); } catch (_) {}
    } else {
      archiveMsg.value = `❌ ${result.error || '读档失败'}`;
      try { window.toastr?.error(result.error || '读档失败', '❌', { timeOut: 6000 }); } catch (_) {}
    }
  } finally {
    archiveBusy.value = false;
  }
}

async function refreshArchiveStatus() {
  refreshArchivePreview();
  archiveList.value = await listArchives(undefined, (store.chatData as any).chatId || '');
}

async function doDeleteArchive(archiveId: string) {
  if (!confirm(`确定删除存档 ${archiveId} 吗？`)) return;
  const r = await deleteArchive(archiveId, undefined, (store.chatData as any).chatId || '');
  if (r.ok) {
    archiveMsg.value = `✅ 已删除存档 ${archiveId}`;
  } else {
    archiveMsg.value = `❌ ${r.error || '删除失败'}`;
  }
  await refreshArchiveStatus();
}

const archiveApiAvailable = hasWorldBookApi();

// ─── 选择性删除数据 ───
const showDeletePanel = ref(false);
const showDeleteConfirm = ref(false);
const deleteSelection = reactive({
  world: false,
  grandSummary: false,
  relationships: false,
  dreamtalk: false,
  smallSummary: false,
});
const deleteResultMsg = ref('');

const deleteBlocks = [
  {
    key: 'world' as const,
    label: '世界',
    desc: '生态推演 · 世界进展 · 剧情导演 · 物品记忆',
    count(): number {
      const cd = store.chatData;
      const wr = (cd.worldProgressRecords || []).length;
      const plot = cd.plotOutline ? 1 : 0;
      const items = (cd.itemMemories || []).length;
      return wr + plot + items;
    },
  },
  {
    key: 'grandSummary' as const,
    label: '大总结',
    desc: '时间线 · 角色记忆 · 正文捕获 · 动态人设 · NSFW',
    count(): number {
      const cd = store.chatData;
      const summaries = (cd.summaries || []).length + (cd.summaryHistory || []).length;
      const caps = (cd.capturedContents || []).length;
      const dp2 = (cd.dynamicProfilesV2 || []).length;
      const dp1 = (cd.dynamicProfiles || []).length;
      const nsfw = (cd.nsfwMemories || []).length;
      return summaries + caps + dp2 + dp1 + nsfw;
    },
  },
  {
    key: 'relationships' as const,
    label: '关系网',
    desc: '关系档案',
    count(): number { return (store.chatData.relationshipProfiles || []).length; },
  },
  {
    key: 'dreamtalk' as const,
    label: '梦呓',
    desc: '梦境碎语',
    count(): number {
      const cd = store.chatData;
      const main = cd.dreamtalk ? 1 : 0;
      const hist = (cd.dreamtalkHistory || []).length;
      const undo = (cd.dreamtalkUndoHistory || []).length;
      return main + hist + undo;
    },
  },
  {
    key: 'smallSummary' as const,
    label: '小总结',
    desc: '每轮楼层小总结',
    count(): number { return (store.chatData.smallSummaries || []).length; },
  },
];

function toggleSelectAll() {
  const allSelected = deleteBlocks.every(b => deleteSelection[b.key]);
  for (const b of deleteBlocks) deleteSelection[b.key] = !allSelected;
}

function resetDeletePanel() {
  for (const b of deleteBlocks) deleteSelection[b.key] = false;
  showDeleteConfirm.value = false;
  deleteResultMsg.value = '';
}

function requestDelete() {
  const selected = deleteBlocks.filter(b => deleteSelection[b.key]);
  if (selected.length === 0) {
    deleteResultMsg.value = '❌ 未选择任何模块';
    return;
  }
  showDeleteConfirm.value = true;
}

function executeSelectiveDelete() {
  const selected = deleteBlocks.filter(b => deleteSelection[b.key]);
  if (selected.length === 0) return;

  try {
    const cd = store.chatData;

    for (const b of selected) {
      switch (b.key) {
        case 'world':
          cd.worldProgressRecords = [];
          (cd as any).worldProgressMemories = [];
          cd.lastWorldProgressFloor = 0;
          (cd as any).pendingWorldProgress = false;
          (cd as any).pendingWorldProgressFloor = -1;
          cd.plotOutline = null;
          cd.lastPlotCheckFloor = 0;
          cd.lastPlotCheckResult = null;
          cd.itemMemories = [];
          break;
        case 'grandSummary':
          cd.summaries = [];
          cd.summaryHistory = [];
          cd.lastSummaryAtMessageId = 0;
          cd.capturedContents = [];
          cd.userInputRecords = [];
          cd.storyDateFormat = '';
          cd.dynamicProfiles = [];
          cd.dynamicProfilesV2 = [];
          cd.lastDynamicProfileFloor = 0;
          cd.pendingDynamicProfile = false;
          cd.nsfwMemories = [];
          cd.nsfwDreamtalk = null;
          cd.nsfwDynamicProfiles = [];
          cd.timelineOverrides = {};
          break;
        case 'relationships':
          cd.relationshipProfiles = [];
          break;
        case 'dreamtalk':
          cd.dreamtalk = null;
          cd.dreamtalkHistory = [];
          cd.dreamtalkUndoHistory = [];
          break;
        case 'smallSummary':
          cd.smallSummaries = [];
          break;
      }
    }
    store.rebuildAssembled();
    store.forcePersist();

    const names = selected.map(b => b.label).join('、');
    deleteResultMsg.value = `✅ 已删除：${names}`;
    resetDeletePanel();
    showDeletePanel.value = false;
  } catch (err: any) {
    deleteResultMsg.value = `❌ 删除失败: ${err?.message || err}`;
  }
}
</script>

<template>
  <div class="zhino-settings-layout">
    <!-- Inner Sidebar -->
    <div class="zhino-settings-sidebar">
      <button class="zhino-settings-nav-btn" :class="{ active: currentSetTab === 'general' }" @click="currentSetTab = 'general'">常规设置</button>
      <button class="zhino-settings-nav-btn" :class="{ active: currentSetTab === 'network' }" @click="currentSetTab = 'network'">网络与 API</button>
      <button class="zhino-settings-nav-btn" :class="{ active: currentSetTab === 'data' }" @click="currentSetTab = 'data'; refreshArchiveStatus()">数据管理</button>
    </div>

    <!-- Content Area -->
    <div class="zhino-settings-content">
      <!-- ============ 常规设置 ============ -->
      <div v-if="currentSetTab === 'general'">
        <!-- 自动分析分区 -->
        <div class="zhino-section">
          <div class="zhino-section-title">自动分析</div>

          <!-- 小总结 -->
          <label class="zhino-toggle-row">
            <div class="zhino-toggle-info">
              <span class="zhino-toggle-label">小总结</span>
              <span class="zhino-toggle-desc">更新角色、物品、地点信息，并录入图谱</span>
            </div>
            <input type="checkbox" :checked="store.settings.smallSummaryEnabled"
              @change="store.updateSettings({ smallSummaryEnabled: ($event.target as HTMLInputElement).checked })" />
          </label>

          <!-- 大总结 -->
          <div class="zhino-sub-block">
            <label class="zhino-toggle-row">
              <div class="zhino-toggle-info">
                <span class="zhino-toggle-label">大总结（精神链记忆库）</span>
                <span class="zhino-toggle-desc">按间隔生成客观事实时间线，是记忆激活的核心数据源</span>
              </div>
              <input type="checkbox" :checked="store.settings.grandSummaryEnabled"
                @change="store.updateSettings({ grandSummaryEnabled: ($event.target as HTMLInputElement).checked })" />
            </label>
            <div class="zhino-inline-setting" style="margin-top:4px;padding-left:16px">
              <span class="zhino-setting-desc">触发间隔：每隔</span>
              <input type="number" class="zhino-input-num" :value="store.settings.summaryInterval" min="5" max="50"
                @change="store.updateSettings({ summaryInterval: Number(($event.target as HTMLInputElement).value) })" />
              <span class="zhino-setting-desc">轮对话</span>
            </div>
            <div class="zhino-inline-setting" style="margin-top:4px;padding-left:16px">
              <span class="zhino-setting-desc">保留最新</span>
              <input type="number" class="zhino-input-num" :value="store.settings.preserveRecentFloors" min="1" max="20"
                @change="store.updateSettings({ preserveRecentFloors: Number(($event.target as HTMLInputElement).value) })" />
              <span class="zhino-setting-desc">条AI回复不总结</span>
            </div>
            <label class="zhino-toggle-row" style="padding-left:16px">
              <div class="zhino-toggle-info">
                <span class="zhino-toggle-label">大总结注入</span>
                <span class="zhino-toggle-desc">把时间线注入到 AI 上下文</span>
              </div>
              <input type="checkbox" :checked="store.settings.summaryInjectionEnabled"
                @change="store.updateSettings({ summaryInjectionEnabled: ($event.target as HTMLInputElement).checked })" />
            </label>
            <label class="zhino-toggle-row" style="padding-left:16px">
              <div class="zhino-toggle-info">
                <span class="zhino-toggle-label">大总结引导弹窗</span>
                <span class="zhino-toggle-desc">总结前弹窗让你填写记忆要点</span>
              </div>
              <input type="checkbox" :checked="store.settings.summaryGuidanceEnabled"
                @change="store.updateSettings({ summaryGuidanceEnabled: ($event.target as HTMLInputElement).checked })" />
            </label>
            <label class="zhino-toggle-row" style="padding-left:16px">
              <div class="zhino-toggle-info">
                <span class="zhino-toggle-label">角色记忆更新</span>
                <span class="zhino-toggle-desc">与大总结同步触发，更新每个角色的记忆条目</span>
              </div>
              <input type="checkbox" :checked="store.settings.characterMemoryEnabled"
                @change="store.updateSettings({ characterMemoryEnabled: ($event.target as HTMLInputElement).checked })" />
            </label>
            <label class="zhino-toggle-row" style="padding-left:16px">
              <div class="zhino-toggle-info">
                <span class="zhino-toggle-label">记忆激活注入</span>
                <span class="zhino-toggle-desc">每轮 AI 生成前融合角色记忆，按相关性召回注入（本地计算）</span>
              </div>
              <input type="checkbox" :checked="store.settings.memoryActivationEnabled"
                @change="store.updateSettings({ memoryActivationEnabled: ($event.target as HTMLInputElement).checked })" />
            </label>
          </div>

          <!-- 梦呓 -->
          <div class="zhino-sub-block">
            <label class="zhino-toggle-row">
              <div class="zhino-toggle-info">
                <span class="zhino-toggle-label">梦呓系统</span>
                <span class="zhino-toggle-desc">分析用户行为模式，生成用户行为翻译手册</span>
              </div>
              <input type="checkbox" :checked="store.settings.dreamtalkEnabled"
                @change="store.updateSettings({ dreamtalkEnabled: ($event.target as HTMLInputElement).checked })" />
            </label>
            <div class="zhino-inline-setting" style="margin-top:4px;padding-left:16px">
              <span class="zhino-setting-desc">触发间隔：每隔</span>
              <input type="number" class="zhino-input-num" :value="store.settings.dreamtalkInterval" min="1" max="20"
                @change="store.updateSettings({ dreamtalkInterval: Number(($event.target as HTMLInputElement).value) })" />
              <span class="zhino-setting-desc">轮对话</span>
            </div>
            <div class="zhino-inline-setting" style="margin-top:4px;padding-left:16px">
              <span class="zhino-setting-desc">抢话风格：</span>
              <select class="zhino-input zhino-model-select" style="max-width:120px"
                :value="(store.settings as any).preferredPlayStyle || ''"
                @change="store.updateSettings({ preferredPlayStyle: ($event.target as HTMLSelectElement).value } as any)">
                <option value="">自动判定</option>
                <option value="不抢话">不抢话</option>
                <option value="抢话">抢话</option>
                <option value="混合">混合</option>
              </select>
            </div>
            <label class="zhino-toggle-row" style="padding-left:16px">
              <div class="zhino-toggle-info">
                <span class="zhino-toggle-label">梦呓注入</span>
                <span class="zhino-toggle-desc">把用户行为手册注入到最后一条用户消息</span>
              </div>
              <input type="checkbox" :checked="store.settings.dreamtalkInjectionEnabled"
                @change="store.updateSettings({ dreamtalkInjectionEnabled: ($event.target as HTMLInputElement).checked })" />
            </label>
          </div>

          <!-- 动态人设 -->
          <div class="zhino-sub-block">
            <label class="zhino-toggle-row">
              <div class="zhino-toggle-info">
                <span class="zhino-toggle-label">动态人设 V2</span>
                <span class="zhino-toggle-desc">按间隔分析在场角色的状态变化</span>
              </div>
              <input type="checkbox" :checked="store.settings.dynamicProfileEnabled"
                @change="store.updateSettings({ dynamicProfileEnabled: ($event.target as HTMLInputElement).checked })" />
            </label>
            <div class="zhino-inline-setting" style="margin-top:4px;padding-left:16px">
              <span class="zhino-setting-desc">触发间隔：每隔</span>
              <input type="number" class="zhino-input-num" :value="store.settings.dynamicProfileInterval" min="3" max="20"
                @change="store.updateSettings({ dynamicProfileInterval: Number(($event.target as HTMLInputElement).value) })" />
              <span class="zhino-setting-desc">轮对话分析</span>
            </div>
            <label class="zhino-toggle-row" style="padding-left:16px">
              <div class="zhino-toggle-info">
                <span class="zhino-toggle-label">动态人设注入</span>
                <span class="zhino-toggle-desc">把动态人设注入到 AI 上下文，优先于原人设</span>
              </div>
              <input type="checkbox" :checked="store.settings.dynamicProfileInjectionEnabled"
                @change="store.updateSettings({ dynamicProfileInjectionEnabled: ($event.target as HTMLInputElement).checked })" />
            </label>
          </div>

          <!-- 世界推进 -->
          <div class="zhino-sub-block">
            <label class="zhino-toggle-row">
              <div class="zhino-toggle-info">
                <span class="zhino-toggle-label">世界推进</span>
                <span class="zhino-toggle-desc">按时间切片推演不在场角色行动</span>
              </div>
              <input type="checkbox" :checked="store.settings.worldProgressEnabled"
                @change="store.updateSettings({ worldProgressEnabled: ($event.target as HTMLInputElement).checked })" />
            </label>
            <div class="zhino-inline-setting" style="margin-top:4px;padding-left:16px">
              <span class="zhino-setting-desc">触发间隔：每隔</span>
              <input type="number" class="zhino-input-num" :value="store.settings.worldProgressInterval" min="1" max="10"
                @change="store.updateSettings({ worldProgressInterval: Number(($event.target as HTMLInputElement).value) })" />
              <span class="zhino-setting-desc">轮对话</span>
            </div>
            <div class="zhino-inline-setting" style="padding-left:16px">
              <span class="zhino-setting-desc">推演冷却：产生入场引导后</span>
              <input type="number" class="zhino-input-num" :value="store.settings.entryCooldownRounds" min="1" max="30"
                @change="store.updateSettings({ entryCooldownRounds: Number(($event.target as HTMLInputElement).value) })" />
              <span class="zhino-setting-desc">次推演尝试内不再推该角色</span>
            </div>
            <div class="zhino-inline-setting" style="padding-left:16px">
              <span class="zhino-setting-desc">入场引导冷却：产生入场引导后</span>
              <input type="number" class="zhino-input-num" :value="store.settings.entryHintCooldownRounds" min="1" max="30"
                @change="store.updateSettings({ entryHintCooldownRounds: Number(($event.target as HTMLInputElement).value) })" />
              <span class="zhino-setting-desc">次推演尝试内不再为该角色注入入场引导</span>
            </div>
            <label class="zhino-toggle-row" style="padding-left:16px">
              <div class="zhino-toggle-info">
                <span class="zhino-toggle-label">世界推进注入</span>
                <span class="zhino-toggle-desc">把世界状态注入到 AI 上下文</span>
              </div>
              <input type="checkbox" :checked="store.settings.worldProgressInjectionEnabled"
                @change="store.updateSettings({ worldProgressInjectionEnabled: ($event.target as HTMLInputElement).checked })" />
            </label>
          </div>

          <!-- 剧情导演 -->
          <div class="zhino-sub-block">
            <label class="zhino-toggle-row">
              <div class="zhino-toggle-info">
                <span class="zhino-toggle-label">剧情导演</span>
                <span class="zhino-toggle-desc">设定剧情大纲后定期校对偏离度</span>
              </div>
              <input type="checkbox" :checked="store.settings.plotDirectorEnabled"
                @change="store.updateSettings({ plotDirectorEnabled: ($event.target as HTMLInputElement).checked })" />
            </label>
            <div class="zhino-inline-setting" style="margin-top:4px;padding-left:16px">
              <span class="zhino-setting-desc">校对间隔：每隔</span>
              <input type="number" class="zhino-input-num" :value="store.settings.plotCheckInterval" min="3" max="20"
                @change="store.updateSettings({ plotCheckInterval: Number(($event.target as HTMLInputElement).value) })" />
              <span class="zhino-setting-desc">轮对话</span>
            </div>
            <label class="zhino-toggle-row" style="padding-left:16px">
              <div class="zhino-toggle-info">
                <span class="zhino-toggle-label">剧情引导注入</span>
                <span class="zhino-toggle-desc">把当前阶段描述、预期角色、结局方向注入到 AI 上下文</span>
              </div>
              <input type="checkbox" :checked="store.settings.plotGuidanceInjectionEnabled"
                @change="store.updateSettings({ plotGuidanceInjectionEnabled: ($event.target as HTMLInputElement).checked })" />
            </label>
          </div>
        </div>

        <!-- 注入项分区 -->
        <div class="zhino-section">
          <div class="zhino-section-title">注入项</div>

          <label class="zhino-toggle-row">
            <div class="zhino-toggle-info">
              <span class="zhino-toggle-label">用户人格注入</span>
              <span class="zhino-toggle-desc">把用户人格画像注入到 AI 上下文（需先在人格页手动分析）</span>
            </div>
            <input type="checkbox" :checked="store.settings.personaEnabled"
              @change="store.updateSettings({ personaEnabled: ($event.target as HTMLInputElement).checked })" />
          </label>

          <label class="zhino-toggle-row">
            <div class="zhino-toggle-info">
              <span class="zhino-toggle-label">关系档案注入</span>
              <span class="zhino-toggle-desc">把在场角色间的稳定关系档案注入到 AI 上下文（需先手动分析）</span>
            </div>
            <input type="checkbox" :checked="store.settings.relationshipInjectionEnabled"
              @change="store.updateSettings({ relationshipInjectionEnabled: ($event.target as HTMLInputElement).checked })" />
          </label>

          <div class="zhino-sub-block">
            <label class="zhino-toggle-row">
              <div class="zhino-toggle-info">
                <span class="zhino-toggle-label">知识图谱召回</span>
                <span class="zhino-toggle-desc">按正文召回 top-K 相关地点/物品注入到 AI 上下文</span>
              </div>
              <input type="checkbox" :checked="store.settings.kgAutoEnabled"
                @change="store.updateSettings({ kgAutoEnabled: ($event.target as HTMLInputElement).checked })" />
            </label>
            <div class="zhino-inline-setting" style="margin-top:4px;padding-left:16px">
              <span class="zhino-setting-desc">召回条数：</span>
              <input type="number" class="zhino-input-num" :value="(store.settings as any).kgInjectTopK ?? 8" min="1" max="30"
                @change="store.updateSettings({ kgInjectTopK: Number(($event.target as HTMLInputElement).value) } as any)" />
              <span class="zhino-setting-desc">条</span>
            </div>
          </div>

          <label class="zhino-toggle-row">
            <div class="zhino-toggle-info">
              <span class="zhino-toggle-label">NSFW 隔离层</span>
              <span class="zhino-toggle-desc">NSFW 场景激活时注入隔离记忆/人设/梦呓（由剧情自动判定）</span>
            </div>
            <input type="checkbox" :checked="store.settings.nsfwIsolationEnabled"
              @change="store.updateSettings({ nsfwIsolationEnabled: ($event.target as HTMLInputElement).checked })" />
          </label>
        </div>

        <!-- 界面分区 -->
        <div class="zhino-section">
          <div class="zhino-section-title">界面</div>
          <div class="zhino-inline-setting">
            <span class="zhino-setting-desc">界面缩放：</span>
            <div class="zhino-size-btns">
              <button v-for="level in [1, 2, 3]" :key="level" class="zhino-size-btn"
                :class="{ active: store.settings.fontSize === level }"
                @click="store.updateSettings({ fontSize: level })">{{ level }}</button>
            </div>
          </div>
          <div class="zhino-inline-setting" style="margin-top:8px">
            <span class="zhino-setting-desc">主题：</span>
            <div class="zhino-size-btns">
              <button class="zhino-size-btn" :class="{ active: store.settings.colorMode !== 'light' }"
                @click="store.updateSettings({ colorMode: 'dark' })">深色</button>
              <button class="zhino-size-btn" :class="{ active: store.settings.colorMode === 'light' }"
                @click="store.updateSettings({ colorMode: 'light' })">浅色</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ============ 网络与 API ============ -->
      <div v-if="currentSetTab === 'network'">
        <!-- API 库 -->
        <div class="zhino-section">
          <div class="zhino-section-header">
            <div class="zhino-section-title">API 库</div>
            <div class="zhino-section-actions">
              <button class="zhino-btn-sm" @click="showJailbreakSettings = true">自定义破限词</button>
              <button class="zhino-btn-sm" @click="showApiLibrary = true">管理 API</button>
            </div>
          </div>
          <div class="zhino-setting-hint" style="margin-bottom:8px">
            已配置 {{ (store.settings as any).apiLibrary?.length || 0 }} 个 API。点击「管理 API」添加配置、分配分析类型。
          </div>
          <!-- 调度模式 -->
          <div class="zhino-inline-setting" style="margin-top:6px">
            <span class="zhino-setting-desc">调度模式：</span>
            <select
              class="zhino-input zhino-model-select"
              :value="(store.settings as any).schedulerMode || 'concurrent'"
              @change="setSchedulerMode(($event.target as HTMLSelectElement).value as 'concurrent' | 'serial')"
            >
              <option value="concurrent">并发模式（5个同时）</option>
              <option value="serial">排队模式（1个1个）</option>
            </select>
          </div>
        </div>

        <!-- API 重试 -->
        <div class="zhino-section">
          <div class="zhino-section-title">API 重试</div>
          <div class="zhino-inline-setting">
            <span class="zhino-setting-desc">失败重试次数：</span>
            <input
              type="number"
              class="zhino-input-num"
              :value="(store.settings as any).apiMaxRetries ?? 3"
              min="0"
              max="10"
              @change="store.updateSettings({ apiMaxRetries: Number(($event.target as HTMLInputElement).value) } as any)"
            />
            <span class="zhino-setting-desc">次（0=不重试，默认3）</span>
          </div>
          <div class="zhino-api-warn" style="margin-top:6px">
            智脑所有后台 API 调用失败时会自动重试。重试时会弹窗提示，采用指数退避（2s/4s/8s...）。
          </div>
        </div>

        <!-- API 监听器（始终开启） -->
        <div class="zhino-section">
          <div class="zhino-section-title">API 监听器</div>
          <div class="zhino-api-monitor-desc">
            记录最近 5 次后台分析的输入和输出，方便调试自定义API（始终开启）
          </div>
          <button
            v-if="store.apiMonitorLogs.length > 0"
            class="zhino-btn-sm zhino-btn-save"
            style="margin-top:8px"
            @click="showApiMonitor = true"
          >
            查看日志 ({{ store.apiMonitorLogs.length }})
          </button>
          <div v-else class="zhino-empty-hint">
            暂无日志，等待后台分析触发...
          </div>
        </div>

        <!-- 代码日志 -->
        <div class="zhino-section">
          <div class="zhino-section-title">代码日志</div>
          <div class="zhino-api-monitor-desc">
            实时记录智脑各模块的运行状态和异常，方便排查问题。最多保留 100 条，刷新页面后清空。
          </div>
          <button
            v-if="store.codeLogs.length > 0"
            class="zhino-btn-sm zhino-btn-save"
            style="margin-top:8px"
            @click="showCodeLog = true"
          >
            查看日志 ({{ store.codeLogs.length }})
          </button>
          <div v-else class="zhino-empty-hint">暂无日志，等待功能触发...</div>
        </div>

        <!-- 召回/向量设置 -->
        <RecallSettingsPanel />
      </div>

      <!-- ============ 数据管理（含存档） ============ -->
      <div v-if="currentSetTab === 'data'">
        <!-- 世界书存档 -->
        <div class="zhino-section">
          <div class="zhino-section-title">世界书存档</div>
          <div v-if="!archiveApiAvailable" class="zhino-api-warn">
            世界书写入 API 不可用，请确认酒馆助手扩展（JS-Slash-Runner）已启用。
          </div>
          <template v-else>
            <div class="zhino-setting-hint" style="margin-bottom:8px">
              把当前聊天的智脑数据存到世界书里（不含全局设置）。每个聊天一本世界书，可存多个快照。纯备份，不影响内存。
            </div>
            <div class="zhino-inline-setting" style="margin-bottom:8px">
              <span class="zhino-setting-desc">世界书：</span>
              <span class="zhino-info-value">{{ archiveNamePreview }}</span>
            </div>
            <div class="zhino-btn-row">
              <button class="zhino-btn-sm zhino-btn-save" :disabled="archiveBusy" @click="openArchiveDialog">
                {{ archiveBusy ? '处理中...' : '新建存档' }}
              </button>
              <button class="zhino-btn-sm" :disabled="archiveBusy" @click="refreshArchiveStatus">刷新列表</button>
            </div>
            <!-- 新建存档弹窗 -->
            <div v-if="showArchiveDialog" class="zhino-archive-dialog-overlay" @click.self="cancelArchiveDialog">
              <div class="zhino-archive-dialog">
                <div class="zhino-archive-dialog-title">新建存档</div>
                <input
                  v-model="archiveDialogName"
                  class="zhino-input zhino-archive-dialog-input"
                  placeholder="存档名称（可选，留空用时间戳）" aria-label="存档名称（可选，留空用时间戳）"
                  @keyup.enter="confirmArchive"
                  @keyup.escape="cancelArchiveDialog"
                />
                <div class="zhino-btn-row" style="margin-top:10px;justify-content:flex-end">
                  <button class="zhino-btn-sm" @click="cancelArchiveDialog">取消</button>
                  <button class="zhino-btn-sm zhino-btn-save" @click="confirmArchive">确认存档</button>
                </div>
              </div>
            </div>
            <div v-if="archiveMsg" class="zhino-delete-msg" :class="{ ok: archiveMsg.startsWith('✅'), fail: archiveMsg.startsWith('❌') }" style="margin-top:6px">
              {{ archiveMsg }}
            </div>
          </template>
        </div>

        <!-- 存档列表 -->
        <div class="zhino-section" v-if="archiveApiAvailable && archiveList.length > 0">
          <div class="zhino-section-title">存档列表 ({{ archiveList.length }})</div>
          <div v-for="item in archiveList" :key="item.archiveId" class="zhino-archive-row">
            <div class="zhino-archive-info">
              <!-- 编辑模式 -->
              <template v-if="editingArchiveId === item.archiveId">
                <input
                  v-model="editingArchiveName"
                  class="zhino-input zhino-archive-name-input"
                  style="width:160px;margin-bottom:2px"
                  placeholder="存档名称（留空清除）" aria-label="存档名称（留空清除）"
                  @keyup.enter="saveEditArchiveName(item.archiveId)"
                  @keyup.escape="cancelEditArchiveName"
                  @blur="saveEditArchiveName(item.archiveId)"
                />
              </template>
              <!-- 显示模式 -->
              <template v-else>
                <span
                  class="zhino-archive-char"
                  style="cursor:pointer"
                  title="点击编辑名称"
                  @click="startEditArchiveName(item)"
                >{{ item.customName || item.archiveId }} ✎</span>
              </template>
              <span class="zhino-archive-chatid">
                {{ formatArchiveTime(item.savedAt) }} · {{ formatSize(item.originalSize) }}
                <template v-if="item.savedAtFloor !== undefined"> · 第{{ item.savedAtFloor }}层</template>
                <template v-if="item.customName"> · {{ item.archiveId }}</template>
              </span>
            </div>
            <div class="zhino-btn-row" style="margin-top:0">
              <button class="zhino-btn-sm zhino-btn-save" :disabled="archiveBusy" @click="doRestore(item.archiveId)">读取</button>
              <button class="zhino-btn-sm zhino-btn-danger" :disabled="archiveBusy" @click="doDeleteArchive(item.archiveId)">删除</button>
            </div>
          </div>
        </div>

        <!-- 导入导出 + 数据删除 -->
        <div class="zhino-section">
          <div class="zhino-section-title">本地数据</div>
          <div class="zhino-btn-row">
            <button class="zhino-btn-sm" @click="exportData">导出数据</button>
            <input
              ref="fileInput"
              type="file"
              accept=".json"
              style="display:none"
              @change="handleFileImport"
            />
            <button class="zhino-btn-sm" @click="fileInput?.click()">导入数据</button>
            <button class="zhino-btn-sm zhino-btn-danger" @click="showDeletePanel = !showDeletePanel; resetDeletePanel()">数据删除</button>
          </div>

          <!-- 选择性删除面板 -->
          <div v-if="showDeletePanel" class="zhino-delete-panel">
            <div class="zhino-delete-header">
              <span class="zhino-delete-title">选择要删除的数据块</span>
              <label class="zhino-delete-select-all">
                <input type="checkbox" :checked="deleteBlocks.every(b => deleteSelection[b.key])" @change="toggleSelectAll" />
                <span>全选</span>
              </label>
            </div>
            <div v-for="block in deleteBlocks" :key="block.key" class="zhino-delete-row">
              <label class="zhino-delete-label">
                <input type="checkbox" v-model="deleteSelection[block.key]" />
                <span class="zhino-delete-block-name">{{ block.label }}</span>
                <span class="zhino-delete-block-desc">{{ block.desc }}</span>
                <span class="zhino-delete-block-count">({{ block.count() }})</span>
              </label>
            </div>
            <div class="zhino-delete-confirm">
              <template v-if="!showDeleteConfirm">
                <button class="zhino-btn-sm zhino-btn-danger" @click="requestDelete">确认删除</button>
                <button class="zhino-btn-sm" @click="showDeletePanel = false; resetDeletePanel()">取消</button>
              </template>
              <template v-else>
                <span class="zhino-delete-confirm-text">确认删除所选数据？此操作不可撤销。</span>
                <button class="zhino-btn-sm zhino-btn-danger" @click="executeSelectiveDelete">确认</button>
                <button class="zhino-btn-sm" @click="showDeleteConfirm = false">取消</button>
              </template>
            </div>
            <div v-if="deleteResultMsg" class="zhino-delete-msg" :class="{ ok: deleteResultMsg.startsWith('✅'), fail: deleteResultMsg.startsWith('❌') }">
              {{ deleteResultMsg }}
            </div>
          </div>
        </div>

        <!-- 储存诊断 -->
        <div class="zhino-section">
          <div class="zhino-section-title">储存诊断</div>
          <div class="zhino-setting-hint" style="margin-bottom:8px">
            检测当前聊天智脑各模块的数据体积，帮助定位内存占用大户。体积按 JSON 序列化后的字符数估算（含 embedding 向量时可能偏大）。
          </div>
          <button
            class="zhino-btn-sm zhino-btn-save"
            :disabled="storageDiagLoading"
            @click="runStorageDiagnostic"
          >
            {{ storageDiagLoading ? '检测中...' : '🔍 检测储存大小' }}
          </button>

          <!-- 诊断结果 -->
          <div v-if="storageDiagResult" style="margin-top:12px">
            <!-- 总体概览 -->
            <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px;font-size:12px;color:var(--zhino-text-muted)">
              <span>📦 当前聊天总计: <b style="color:var(--zhino-text)">{{ formatBytes(storageDiagResult.totalBytes) }}</b></span>
              <span>⚙ 设置 (localStorage): <b style="color:var(--zhino-text)">{{ formatBytes(storageDiagResult.settingsLocalBytes) }}</b></span>
              <span v-if="storageDiagResult.hasEmbeddings" style="color:#e8a020">⚠ 检测到 embedding 向量，体积可能虚高</span>
            </div>

            <!-- 模块列表 -->
            <div class="zhino-diag-table">
              <div class="zhino-diag-header">
                <span class="zhino-diag-col-module">模块</span>
                <span class="zhino-diag-col-size">体积</span>
                <span class="zhino-diag-col-pct">占比</span>
                <span class="zhino-diag-col-bar"></span>
              </div>
              <div
                v-for="m in storageDiagResult.modules"
                :key="m.key"
                class="zhino-diag-row"
              >
                <!-- 主行：可点击展开 -->
                <div
                  class="zhino-diag-main"
                  :class="diagSizeClass(m.totalBytes)"
                  @click="toggleDiagModule(m.key)"
                >
                  <span class="zhino-diag-col-module">
                    <span class="zhino-diag-expand-icon">{{ storageDiagExpanded[m.key] ? '▼' : '▶' }}</span>
                    {{ m.name }}
                    <span v-if="m.fields.some(f => f.count !== undefined)" class="zhino-diag-item-count">
                      ({{ m.fields.filter(f => f.count !== undefined).map(f => f.count + '条').join(' + ') }})
                    </span>
                  </span>
                  <span class="zhino-diag-col-size">{{ formatBytes(m.totalBytes) }}</span>
                  <span class="zhino-diag-col-pct">{{ formatPercent(m.percent) }}</span>
                  <span class="zhino-diag-col-bar">
                    <span class="zhino-diag-bar-fill" :style="{ width: Math.max(m.percent, 0.5) + '%' }"></span>
                  </span>
                </div>
                <!-- 子字段明细 -->
                <div v-if="storageDiagExpanded[m.key]" class="zhino-diag-detail">
                  <div v-for="f in m.fields" :key="f.label" class="zhino-diag-sub">
                    <div class="zhino-diag-sub-row">
                      <span class="zhino-diag-sub-label">{{ f.label }}</span>
                      <span class="zhino-diag-sub-size">{{ formatBytes(f.bytes) }}</span>
                      <span v-if="f.count !== undefined" class="zhino-diag-sub-count">{{ f.count }} 条</span>
                    </div>
                    <div v-if="f.hint" class="zhino-diag-sub-hint">{{ f.hint }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- API 库管理弹窗 -->
    <Modal :visible="showApiLibrary" :is-mobile="isMobile" max-width="540px" title="API 库管理" @close="showApiLibrary = false">
        <!-- API 列表 -->
        <div class="zhino-api-lib-section">
          <div class="zhino-api-lib-subtitle">API 配置列表</div>
          <div v-for="api in (store.settings as any).apiLibrary || []" :key="api.id" class="zhino-api-lib-card">
            <template v-if="editingApiId === api.id">
              <div class="zhino-api-lib-edit">
                <input class="zhino-input" v-model="apiDraft.name" placeholder="名称（如 DeepSeek Pro）" aria-label="名称（如 DeepSeek Pro）" />
                <input class="zhino-input" v-model="apiDraft.url" placeholder="API地址（如 https://api.deepseek.com/v1）" aria-label="API地址（如 https://api.deepseek.com/v1）" />
                <input class="zhino-input" type="password" v-model="apiDraft.key" placeholder="API Key" aria-label="API Key" />
                <div class="zhino-model-row">
                  <select class="zhino-input zhino-model-select" v-model="apiDraft.model">
                    <option value="" disabled>选择模型</option>
                    <option v-for="m in apiModelList[api.id] || []" :key="m" :value="m">{{ m }}</option>
                    <option v-if="apiDraft.model && !(apiModelList[api.id] || []).includes(apiDraft.model)" :value="apiDraft.model">{{ apiDraft.model }}</option>
                  </select>
                  <button class="zhino-btn-sm" :disabled="apiModelLoading[api.id]" @click="loadApiModels(api.id)">
                    {{ apiModelLoading[api.id] ? '...' : '获取' }}
                  </button>
                </div>
                <div v-if="apiModelError[api.id]" class="zhino-api-warn">{{ apiModelError[api.id] }}</div>
                <div class="zhino-btn-row" style="margin-top:6px">
                  <button class="zhino-btn-sm zhino-btn-save" @click="saveApi">保存</button>
                  <button class="zhino-btn-sm" @click="cancelEditApi">取消</button>
                </div>
              </div>
            </template>
            <template v-else>
              <div class="zhino-api-lib-card-info">
                <span class="zhino-api-lib-card-name">{{ api.name || '未命名' }}</span>
                <span class="zhino-api-lib-card-model">{{ api.model || '未设置模型' }}</span>
                <span class="zhino-api-lib-card-url">{{ api.url || '未设置URL' }}</span>
              </div>
              <div class="zhino-btn-row">
                <button class="zhino-btn-sm" @click="startEditApi(api.id)">编辑</button>
                <button class="zhino-btn-sm zhino-btn-delete" @click="deleteApi(api.id)">删除</button>
              </div>
            </template>
          </div>
          <button class="zhino-btn-sm" style="margin-top:8px" @click="addApi">+ 添加 API</button>
          <div v-if="!(store.settings as any).apiLibrary?.length" class="zhino-empty-hint" style="margin-top:8px">
            尚未配置任何 API，点击「添加 API」开始
          </div>
        </div>

        <!-- 分析类型分配 -->
        <div class="zhino-api-lib-section" v-if="(store.settings as any).apiLibrary?.length">
          <div class="zhino-api-lib-subtitle">分析类型分配</div>
          <div v-for="t in ANALYSIS_TYPES" :key="t.key" class="zhino-api-lib-assign-row">
            <span class="zhino-api-lib-assign-label">{{ t.label }}</span>
            <select
              class="zhino-input zhino-model-select"
              :value="getAssignedApiId(t.key)"
              @change="assignApi(t.key, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="api in (store.settings as any).apiLibrary" :key="api.id" :value="api.id">
                {{ api.name || '未命名' }} ({{ api.model || '?' }})
              </option>
            </select>
          </div>
        </div>
    </Modal>

    <!-- 自定义破限词弹窗 -->
    <Modal :visible="showJailbreakSettings" :is-mobile="isMobile" max-width="760px" title="自定义破限词" @close="showJailbreakSettings = false">
      <div class="zhino-jailbreak-list">
        <div class="zhino-jailbreak-note">
          <code>&#123;&#123;user&#125;&#125;</code> 会在实际发送前替换为当前用户名（智脑人设名 / 酒馆用户名）。
        </div>
        <Collapsible
          v-for="type in JAILBREAK_PROMPT_TYPES"
          :key="type.key"
          v-model="jailbreakExpanded[type.key]"
          :title="type.label"
          :count="isJailbreakCustomized(type.key) ? '已自定义' : '默认'"
        >
          <div class="zhino-jailbreak-toolbar">
            <button
              class="zhino-btn-sm"
              :disabled="!isJailbreakCustomized(type.key)"
              @click="resetJailbreakType(type.key)"
            >
              恢复默认
            </button>
          </div>
          <label class="zhino-jailbreak-field">
            <span class="zhino-jailbreak-label">头部</span>
            <textarea
              class="zhino-input zhino-jailbreak-textarea"
              spellcheck="false"
              :value="getJailbreakValue(type.key, 'head')"
              @input="updateJailbreakValue(type.key, 'head', ($event.target as HTMLTextAreaElement).value)"
            ></textarea>
          </label>
          <label class="zhino-jailbreak-field">
            <span class="zhino-jailbreak-label">尾部</span>
            <textarea
              class="zhino-input zhino-jailbreak-textarea small"
              spellcheck="false"
              :value="getJailbreakValue(type.key, 'tail')"
              @input="updateJailbreakValue(type.key, 'tail', ($event.target as HTMLTextAreaElement).value)"
            ></textarea>
          </label>
        </Collapsible>
      </div>
    </Modal>

    <!-- API 监听器日志弹窗 -->
    <Modal :visible="showApiMonitor" :is-mobile="isMobile" max-width="700px" title="API 监听日志" @close="showApiMonitor = false">
      <div class="zhino-monitor-tabs">
          <button
            v-for="(entry, i) in store.apiMonitorLogs"
            :key="i"
            class="zhino-monitor-tab"
            :class="{ active: monitorSelectedIndex === i }"
            @click="monitorSelectedIndex = i"
          >
            {{ formatMonitorTime(entry.timestamp) }}
            <span class="zhino-monitor-tab-sub">{{ entry.analysisName }}</span>
          </button>
        </div>
        <template v-if="store.apiMonitorLogs.length > 0">
          <div class="zhino-monitor-body">
            <div class="zhino-monitor-meta">
              <span>模型: {{ store.apiMonitorLogs[monitorSelectedIndex]?.model }}</span>
              <span>耗时: {{ store.apiMonitorLogs[monitorSelectedIndex]?.durationMs }}ms</span>
            </div>
            <div class="zhino-monitor-section">
              <div class="zhino-monitor-label">输入 (发送给 AI 的消息)</div>
              <pre class="zhino-monitor-pre">{{
                monitorInputText(store.apiMonitorLogs[monitorSelectedIndex])
              }}</pre>
            </div>
            <div class="zhino-monitor-section">
              <div class="zhino-monitor-label">输出 (AI 返回)</div>
              <pre class="zhino-monitor-pre">{{
                store.apiMonitorLogs[monitorSelectedIndex]?.response || '(空)'
              }}</pre>
            </div>
          </div>
        </template>
        <div v-else class="zhino-empty-hint" style="padding:40px">暂无日志</div>
      <template v-if="store.apiMonitorLogs.length > 0" #footer>
        <button class="zhino-btn-sm zhino-btn-save" @click="store.clearApiMonitorLogs()">清空日志</button>
      </template>
    </Modal>

    <!-- 代码日志弹窗 -->
    <Modal :visible="showCodeLog" :is-mobile="isMobile" max-width="700px" title="代码日志" @close="showCodeLog = false">
      <div v-if="store.codeLogs.length > 0" class="zhino-codelog-list">
        <div
          v-for="entry in store.codeLogs"
          :key="entry.id"
          class="zhino-codelog-entry"
          :class="`zhino-codelog-entry--${entry.level}`"
          @click="toggleExpand(entry.id)"
        >
          <div class="zhino-codelog-row">
            <span class="zhino-codelog-time">{{ formatCodeLogTime(entry.timestamp) }}</span>
            <span class="zhino-codelog-module">{{ entry.module }}</span>
            <span class="zhino-codelog-msg">{{ entry.message }}</span>
            <span v-if="entry.detail" class="zhino-codelog-chevron">{{ expandedId === entry.id ? '▾' : '▸' }}</span>
          </div>
          <div v-if="expandedId === entry.id && entry.detail" class="zhino-codelog-detail">
            <pre class="zhino-codelog-pre">{{ entry.detail }}</pre>
          </div>
        </div>
      </div>
      <div v-else class="zhino-empty-hint" style="padding:40px">暂无日志</div>
      <template v-if="store.codeLogs.length > 0" #footer>
        <span class="zhino-codelog-count">{{ store.codeLogs.length }} 条</span>
        <button class="zhino-btn-sm zhino-btn-save" @click="store.clearCodeLogs()">清空日志</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.zhino-settings-layout {
  display: flex;
  flex-direction: row;
  height: 100%;
  gap: 16px;
  overflow: hidden;
}
@media (max-width: 768px) {
  .zhino-settings-layout { flex-direction: column; }
}
.zhino-settings-sidebar {
  width: 140px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
  overflow-y: auto;
}
.zhino-settings-nav-btn {
  text-align: left;
  padding: 8px 12px;
  border-radius: 8px;
  background: transparent;
  color: var(--zn-text-muted);
  border: none;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-settings-nav-btn:hover { background: var(--zn-bg-surface1); color: var(--zn-text-regular); }
.zhino-settings-nav-btn.active { background: var(--zn-bg-surface2); color: var(--zn-text-primary); font-weight: 600; }

.zhino-settings-content {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-right: 4px;
}
@media (max-width: 768px) {
  .zhino-settings-sidebar { width: 100%; flex-direction: row; overflow-x: auto; white-space: nowrap; padding-bottom: 8px; border-bottom: 1px solid var(--zn-border-light); }
  .zhino-settings-nav-btn { text-align: center; flex: none; }
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
}
.zhino-sub-block {
  padding: 8px 0;
  border-top: 1px solid var(--zn-border-light);
  margin-top: 8px;
}
.zhino-sub-block:first-of-type {
  border-top: none;
  margin-top: 0;
  padding-top: 4px;
}

.zhino-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
  cursor: pointer;
}
.zhino-toggle-label {
  font-size: 12px;
  color: var(--zn-text-regular);
}
.zhino-toggle-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.zhino-toggle-desc {
  font-size: 10px;
  color: var(--zn-text-muted);
  line-height: 1.3;
}
/* Hide default checkbox */
.zhino-toggle-row input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 32px;
  height: 18px;
  border-radius: 999px;
  background: var(--zn-bg-surface2);
  border: 1px solid var(--zn-border-base);
  position: relative;
  cursor: pointer;
  outline: none;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  flex-shrink: 0;
}
/* The toggle thumb */
.zhino-toggle-row input[type="checkbox"]::after {
  content: '';
  position: absolute;
  top: 1px;
  left: 1px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--zn-text-muted);
  box-shadow: 0 1px 2px rgba(10, 8, 30, 0.2);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
/* Checked state */
.zhino-toggle-row input[type="checkbox"]:checked {
  background: var(--zn-primary);
  border-color: var(--zn-primary);
}
.zhino-toggle-row input[type="checkbox"]:checked::after {
  transform: translateX(14px);
  background: #fff;
}

.zhino-inline-setting {
  display: flex;
  align-items: center;
  gap: 8px;
}
.zhino-setting-desc {
  font-size: 12px;
  color: var(--zn-text-regular);
}
.zhino-input-num {
  width: 50px;
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-base);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--zn-text-primary);
  text-align: center;
  outline: none;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-input-num:focus {
  border-color: var(--zn-primary);
}

.zhino-manual-chars {
  margin-top: 10px;
  padding: 12px;
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-light);
  border-radius: 8px;
}
.zhino-setting-label {
  font-size: 12px;
  color: var(--zn-text-regular);
  margin-bottom: 4px;
}
.zhino-setting-hint {
  font-size: 10px;
  color: var(--zn-text-muted);
  margin-bottom: 8px;
  line-height: 1.4;
}
.zhino-manual-chars input {
  width: 100%;
  box-sizing: border-box;
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-base);
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--zn-text-primary);
  outline: none;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-manual-chars input::placeholder {
  color: var(--zn-text-muted);
}
.zhino-manual-chars input:focus {
  border-color: var(--zn-primary);
}

.zhino-slider {
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

.zhino-size-btns {
  display: flex;
  gap: 4px;
}
.zhino-size-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--zn-border-base);
  background: var(--zn-bg-surface1);
  color: var(--zn-text-regular);
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  padding: 0;
}
.zhino-size-btn:hover {
  background: var(--zn-bg-surface2);
  color: var(--zn-text-primary);
}
.zhino-size-btn.active {
  border-color: rgba(var(--zn-accent-rgb), 0.4);
  background: rgba(var(--zn-accent-rgb), 0.15);
  color: var(--zn-accent);
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
  margin-bottom: 6px;
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

.zhino-btn-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.zhino-btn-sm {
  padding: 4px 12px;
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
.zhino-btn-danger {
  border-color: rgba(var(--zn-danger-rgb), 0.3);
  color: rgba(var(--zn-danger-rgb), 0.8);
}
.zhino-btn-danger:hover {
  background: rgba(var(--zn-danger-rgb), 0.12);
}

.zhino-profile-preview {
  margin-top: 8px;
  padding: 8px;
  background: var(--zn-bg-surface1);
  border-radius: 6px;
}
.zhino-profile-text {
  font-size: 11px;
  color: var(--zn-text-regular);
  white-space: pre-wrap;
  line-height: 1.5;
  max-height: 120px;
  overflow-y: auto;
}
.zhino-detail-label {
  font-size: 11px;
  color: var(--zn-text-muted);
  margin-bottom: 4px;
}

.zhino-info-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.zhino-info-label {
  color: var(--zn-text-muted);
}
.zhino-info-value {
  color: var(--zn-text-primary);
  font-family: var(--zn-font-mono);
  font-size: 11px;
}

.zhino-warning {
  margin-top: 8px;
  padding: 8px;
  background: rgba(var(--zn-warn-rgb), 0.08);
  border: 1px solid rgba(var(--zn-warn-rgb), 0.2);
  border-radius: 4px;
  font-size: 11px;
  color: rgba(var(--zn-warn-rgb), 0.9);
}


.zhino-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.zhino-section-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}

.zhino-empty-hint {
  font-size: 12px;
  color: var(--zn-text-muted);
}

.zhino-add-persona {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}

.zhino-persona-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}
.zhino-persona-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--zn-border-light);
  background: var(--zn-bg-surface1);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-persona-item:hover {
  background: rgba(var(--zn-accent-rgb), 0.06);
  border-color: rgba(var(--zn-accent-rgb), 0.15);
}
.zhino-persona-item.active {
  background: rgba(var(--zn-accent-rgb), 0.12);
  border-color: rgba(var(--zn-accent-rgb), 0.3);
}
.zhino-persona-item-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.zhino-persona-name {
  font-size: 12px;
  color: var(--zn-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zhino-persona-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 8px;
  background: rgba(var(--zn-accent-rgb), 0.2);
  color: rgba(var(--zn-accent-rgb), 0.9);
  flex-shrink: 0;
}
.zhino-persona-item-right {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.zhino-persona-edit-header {
  font-size: 11px;
  color: var(--zn-text-regular);
  margin-bottom: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--zn-border-light);
}

.zhino-btn-xs {
  padding: 2px 8px;
  font-size: 10px;
  border-radius: 4px;
  border: 1px solid var(--zn-border-base);
  background: var(--zn-bg-surface1);
  color: var(--zn-text-regular);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-btn-xs:hover {
  background: var(--zn-bg-surface2);
  color: var(--zn-text-primary);
}
.zhino-btn-xs.zhino-btn-danger {
  border-color: rgba(var(--zn-danger-rgb), 0.2);
  color: rgba(var(--zn-danger-rgb), 0.7);
}
.zhino-btn-xs.zhino-btn-danger:hover {
  background: rgba(var(--zn-danger-rgb), 0.1);
}

.zhino-input-inline {
  width: auto;
  max-width: 120px;
  padding: 2px 6px;
  font-size: 11px;
}

.zhino-api-field {
  margin-top: 6px;
}
.zhino-model-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.zhino-model-select {
  flex: 1;
  min-width: 0;
}
.zhino-api-result {
  margin-top: 8px;
  padding: 8px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.5;
}
.zhino-api-result.ok {
  background: rgba(52, 211, 153, 0.08);
  border: 1px solid rgba(52, 211, 153, 0.2);
  color: rgba(52, 211, 153, 0.9);
}
.zhino-api-result.fail {
  background: rgba(var(--zn-danger-rgb), 0.08);
  border: 1px solid rgba(var(--zn-danger-rgb), 0.2);
  color: rgba(var(--zn-danger-rgb), 0.9);
}

.zhino-api-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(var(--zn-accent-rgb), 0.15);
  color: rgba(var(--zn-accent-rgb), 0.85);
  flex-shrink: 0;
}

.zhino-api-warn {
  margin-top: 8px;
  padding: 8px;
  background: rgba(var(--zn-warn-rgb), 0.08);
  border: 1px solid rgba(var(--zn-warn-rgb), 0.2);
  border-radius: 4px;
  font-size: 11px;
  color: rgba(var(--zn-warn-rgb), 0.85);
  line-height: 1.5;
}

/* ===== API 监听器 ===== */
.zhino-api-monitor-desc {
  font-size: 10px;
  color: var(--zn-text-muted);
  margin-top: 4px;
}
/* 监听日志：tabs/body 在 Modal 内，遮罩+卡片+头部+关闭 由 Modal 提供 */
.zhino-monitor-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--zn-border-light);
  flex-shrink: 0;
  overflow-x: auto;
}
.zhino-monitor-tab {
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-light);
  border-radius: 6px;
  color: var(--zn-text-regular);
  cursor: pointer;
  padding: 6px 12px;
  font-size: 11px;
  text-align: center;
  white-space: nowrap;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-monitor-tab:hover { color: var(--zn-text-primary); }
.zhino-monitor-tab.active {
  background: rgba(52, 211, 153, 0.12);
  border-color: rgba(52, 211, 153, 0.3);
  color: rgba(52, 211, 153, 0.9);
}
.zhino-monitor-tab-sub {
  display: block;
  font-size: 9px;
  opacity: 0.6;
  margin-top: 2px;
}
.zhino-monitor-body {
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.zhino-monitor-meta {
  display: flex;
  gap: 20px;
  font-size: 11px;
  color: var(--zn-text-muted);
}
.zhino-monitor-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.zhino-monitor-label {
  font-size: 12px;
  color: var(--zn-text-regular);
  font-weight: 500;
}
.zhino-monitor-pre {
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-light);
  border-radius: 6px;
  padding: 10px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--zn-text-regular);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
  margin: 0;
  font-family: inherit;
}
/* 代码日志：竖向滚动列表 */
.zhino-codelog-list {
  max-height: 420px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.zhino-codelog-entry {
  cursor: pointer;
  transition: background 0.15s ease;
  border-left: 3px solid transparent;
  padding-left: 10px;
}
.zhino-codelog-entry:hover {
  background: var(--zn-bg-surface1);
}
.zhino-codelog-entry--info  { border-left-color: rgba(52, 211, 153, 0.6); }
.zhino-codelog-entry--warn  { border-left-color: rgba(251, 191, 36, 0.6); }
.zhino-codelog-entry--error { border-left-color: rgba(248, 113, 113, 0.6); }

.zhino-codelog-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 7px 12px 7px 0;
  font-size: 11px;
  line-height: 1.5;
}

.zhino-codelog-time {
  flex-shrink: 0;
  color: var(--zn-text-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  min-width: 54px;
}

.zhino-codelog-module {
  flex-shrink: 0;
  font-weight: 500;
  color: var(--zn-text-primary);
  min-width: 42px;
  max-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.zhino-codelog-msg {
  flex: 1;
  color: var(--zn-text-regular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.zhino-codelog-chevron {
  flex-shrink: 0;
  color: var(--zn-text-muted);
  font-size: 10px;
  width: 14px;
  text-align: center;
}

.zhino-codelog-detail {
  padding: 0 12px 10px 0;
}

.zhino-codelog-pre {
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-light);
  border-radius: 6px;
  padding: 10px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--zn-text-regular);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 180px;
  overflow-y: auto;
  margin: 0;
  font-family: inherit;
}

.zhino-codelog-count {
  font-size: 11px;
  color: var(--zn-text-muted);
  margin-right: auto;
}
/* ─── 选择性删除面板 ─── */
.zhino-delete-panel {
  margin-top: 10px;
  padding: 12px;
  background: rgba(255, 80, 60, 0.04);
  border: 1px solid rgba(255, 80, 60, 0.15);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.zhino-delete-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2px;
}

.zhino-delete-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--zn-text-primary);
}

.zhino-delete-select-all {
  font-size: 11px;
  color: var(--zn-text-regular);
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.zhino-delete-select-all input {
  accent-color: #f5a623;
}

.zhino-delete-row {
  padding: 4px 0;
}

.zhino-delete-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 12px;
}

.zhino-delete-label input {
  accent-color: #f5a623;
  flex-shrink: 0;
}

.zhino-delete-block-name {
  color: var(--zn-text-primary);
  font-weight: 600;
  min-width: 48px;
}

.zhino-delete-block-desc {
  color: var(--zn-text-muted);
  font-size: 10.5px;
}

.zhino-delete-block-count {
  color: var(--zn-text-muted);
  font-size: 10.5px;
  margin-left: auto;
}

.zhino-delete-confirm {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}

.zhino-delete-confirm-text {
  font-size: 11px;
  color: rgba(255, 150, 120, 0.7);
}

.zhino-delete-msg {
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 4px;
}

.zhino-delete-msg.ok {
  color: rgba(100, 220, 150, 0.8);
  background: rgba(100, 220, 150, 0.06);
}

.zhino-delete-msg.fail {
  color: rgba(255, 150, 120, 0.8);
  background: rgba(255, 150, 120, 0.06);
}

/* API 库弹窗 */
/* API 库管理：section/card 在 Modal body 内，遮罩+卡片+头部+关闭 由 Modal 提供 */
.zhino-api-lib-section {
  margin-bottom: 16px;
}
.zhino-api-lib-subtitle {
  font-size: 12px;
  font-weight: 600;
  color: var(--zn-text-regular);
  margin-bottom: 8px;
  border-bottom: 1px solid var(--zn-border-light);
  padding-bottom: 4px;
}
.zhino-api-lib-card {
  background: var(--zn-bg-surface2);
  border: 1px solid var(--zn-border-light);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.zhino-api-lib-card-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
}
.zhino-api-lib-card-name {
  font-weight: 600;
  color: var(--zn-text-primary);
}
.zhino-api-lib-card-model {
  color: rgba(var(--zn-accent-rgb), 0.8);
}
.zhino-api-lib-card-url {
  color: var(--zn-text-muted);
  font-size: 10px;
}
.zhino-api-lib-edit {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.zhino-api-lib-assign-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.zhino-api-lib-assign-label {
  font-size: 12px;
  color: var(--zn-text-regular);
  min-width: 80px;
}
.zhino-btn-delete {
  color: rgba(255, 120, 120, 0.8);
  border-color: rgba(255, 120, 120, 0.2);
}
.zhino-btn-delete:hover {
  background: rgba(255, 120, 120, 0.1);
}

.zhino-jailbreak-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.zhino-jailbreak-note {
  padding: 8px 10px;
  border: 1px solid var(--zn-border-light);
  border-radius: 6px;
  background: var(--zn-bg-surface2);
  color: var(--zn-text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.zhino-jailbreak-note code {
  color: var(--zn-text-primary);
  font-family: var(--zn-font-mono);
}

.zhino-jailbreak-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}

.zhino-jailbreak-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 10px;
}

.zhino-jailbreak-field:last-child {
  margin-bottom: 0;
}

.zhino-jailbreak-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--zn-text-regular);
}

.zhino-jailbreak-textarea {
  width: 100%;
  min-height: 180px;
  resize: vertical;
  font-family: var(--zn-font-mono);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
}

.zhino-jailbreak-textarea.small {
  min-height: 92px;
}

/* 导航分组标题 */
.zhino-nav-group-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--zn-text-muted);
  letter-spacing: 0.5px;
  padding: 10px 12px 4px;
  text-transform: uppercase;
}
.zhino-nav-group-title:first-child {
  padding-top: 0;
}

/* 存档列表行 */
.zhino-archive-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid var(--zn-border-light);
}
.zhino-archive-row:last-child {
  border-bottom: none;
}
.zhino-archive-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.zhino-archive-char {
  font-size: 12px;
  color: var(--zn-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zhino-archive-chatid {
  font-size: 10px;
  color: var(--zn-text-muted);
  font-family: var(--zn-font-mono);
}

/* 存档新建弹窗 */
.zhino-archive-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}
.zhino-archive-dialog {
  background: var(--zn-bg-primary);
  border: 1px solid var(--zn-border);
  border-radius: 8px;
  padding: 20px 24px;
  min-width: 320px;
  max-width: 400px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.3);
}
.zhino-archive-dialog-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--zn-text-primary);
  margin-bottom: 12px;
}

/* ===== 储存诊断 ===== */
.zhino-diag-table {
  border: 1px solid var(--zn-border);
  border-radius: 6px;
  overflow: hidden;
}
.zhino-diag-header {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  font-size: 11px;
  color: var(--zhino-text-muted);
  background: var(--zn-bg-secondary);
  border-bottom: 1px solid var(--zn-border);
  gap: 8px;
}
.zhino-diag-row {
  border-bottom: 1px solid var(--zn-border);
}
.zhino-diag-row:last-child {
  border-bottom: none;
}
.zhino-diag-main {
  display: flex;
  align-items: center;
  padding: 7px 10px;
  cursor: pointer;
  gap: 8px;
  font-size: 12px;
  transition: background 0.15s;
  border-left: 3px solid transparent;
}
.zhino-diag-main:hover {
  background: var(--zn-bg-hover);
}
.zhino-diag-main.zhino-diag-green  { border-left-color: #4caf50; }
.zhino-diag-main.zhino-diag-yellow { border-left-color: #e8a020; }
.zhino-diag-main.zhino-diag-red    { border-left-color: #e04848; }

.zhino-diag-col-module { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; color: var(--zn-text-primary); }
.zhino-diag-col-size   { width: 70px; text-align: right; color: var(--zhino-text); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.zhino-diag-col-pct    { width: 48px; text-align: right; color: var(--zhino-text-muted); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.zhino-diag-col-bar    { width: 80px; height: 6px; background: var(--zn-bg-tertiary); border-radius: 3px; overflow: hidden; flex-shrink: 0; position: relative; }

.zhino-diag-bar-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--zhino-accent);
  transition: width 0.3s ease;
}

.zhino-diag-expand-icon {
  font-size: 9px;
  width: 12px;
  flex-shrink: 0;
  color: var(--zhino-text-muted);
}
.zhino-diag-item-count {
  font-size: 10px;
  color: var(--zhino-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 子字段明细 */
.zhino-diag-detail {
  padding: 4px 10px 8px 28px;
  background: var(--zn-bg-tertiary);
}
.zhino-diag-sub {
  display: flex;
  flex-direction: column;
  padding: 2px 0;
  font-size: 11px;
}
.zhino-diag-sub-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.zhino-diag-sub-label {
  flex: 1;
  color: var(--zhino-text-muted);
  font-family: monospace;
  font-size: 10px;
}
.zhino-diag-sub-size {
  width: 70px;
  text-align: right;
  color: var(--zhino-text);
  flex-shrink: 0;
}
.zhino-diag-sub-count {
  width: 50px;
  text-align: right;
  color: var(--zhino-text-muted);
  flex-shrink: 0;
  font-size: 10px;
}
.zhino-diag-sub-hint {
  color: var(--zhino-text-muted);
  font-size: 10px;
  padding-left: 4px;
  line-height: 1.5;
}
</style>
