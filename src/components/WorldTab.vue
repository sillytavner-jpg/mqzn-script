<script setup lang="ts">
import { useMainStore } from '../stores/mainStore';
import { executeOutlineConversation, createEmptyOutline, activateOutline, abandonOutline, advanceOutlineStage, buildMultiSummaryInjection } from '../core/plotDirector';
import { executeWorldProgress, injectWorldProgress, createFailedWorldProgressRecord, type WorldProgressRecord } from '../core/worldProgress';
import { enqueueAnalysis } from '../core/backgroundQueue';
import type { PlotOutline } from '../core/plotDirector';
import { hydrateSelectedWorldBookEntries } from '../core/worldBookSelection';
import WorldBookTagsTab from './WorldBookTagsTab.vue';
import { SubTabNav, ConfirmButton, EmptyHint } from './ui';
import { logInfo, logError } from '../utils/logger';
import { readAssistantContentsInRange } from '../utils/chatContent';

const store = useMainStore();

// ─── 子面板切换 ───
type SubPanel = 'world_progress' | 'plot_director' | 'worldbook_tags';
const activePanel = ref<SubPanel>('world_progress');
const items = [
  { key: 'world_progress', label: '世界推进' },
  { key: 'plot_director', label: '剧情导演' },
  { key: 'worldbook_tags', label: '世界书标签（施工中）' },
];

// ═══════════════════════════════════════
// 世界推进面板
// ═══════════════════════════════════════

const worldRecords = computed(() => {
  const raw = store.chatData.worldProgressRecords || [];
  return [...raw].reverse();
});

const wpManualNames = computed(() => (store.worldProgressManualChars || '')
  .split(/[,，、]/)
  .map(s => s.trim())
  .filter(Boolean));
const wpManualCharCount = computed(() => wpManualNames.value.length);

const currentKnownFloor = computed(() => {
  // 关键：依赖 chatContentRevision 触发重算（每次 MESSAGE_RECEIVED 时 ++），否则
  // 楼层会一直停在 lastWorldProgressFloor / 上次小总结楼层等陈旧值上不前进，
  // 冷却剩轮数也不会跟着新对话楼层递减。
  void store.chatContentRevision;
  let liveFloor = 0;
  try { liveFloor = getLastMessageId(); } catch { liveFloor = 0; }
  if (!Number.isFinite(liveFloor) || liveFloor < 0) liveFloor = 0;
  return Math.max(
    liveFloor,
    store.chatData.lastWorldProgressFloor ?? -1,
    store.chatData.lastSmallSummaryFloor ?? -1,
    store.chatData.lastSummaryAtMessageId ?? -1,
    0,
  );
});

const activeWPMemories = computed(() => {
  const floor = currentKnownFloor.value;
  return (store.chatData.worldProgressMemories || [])
    .filter((m: any) => (m.expiresAtFloor ?? -1) >= floor)
    .sort((a: any, b: any) => (b.floor ?? 0) - (a.floor ?? 0));
});

const wpMemoryTotal = computed(() => (store.chatData.worldProgressMemories || []).length);
	const wpCandidatePreview = computed(() => {
	  if (!store.settings.worldProgressEnabled) return [];
	  const list = store.selectWorldProgressCandidates(currentKnownFloor.value, store.worldProgressManualChars || '', 2);
	  // 角色名规范化为主名（避免别名出现在 UI）
	  return list.map(c => ({ ...c, characterName: (store.resolveKnownCharacterName(c.characterName, true) || c.characterName) }));
	});

	// 当前在场角色：合并互动/同地两种信号，同一角色只显示一次（标记同时命中两种）
	const wpPresentPreview = computed(() => {
	  if (!store.settings.worldProgressEnabled) return [] as Array<{ name: string; type: 'interact' | 'sameLoc' | 'both' }>;
	  const floor = currentKnownFloor.value;
	  const interactingSet = store.getLatestInteractingCharactersSet(floor);
	  const charLocs = store.getLatestSmallSummaryCharacterLocations(floor);
	  const userNorm = store.normalizeMemoryCharacterName(store.getUserName());
	  const myLoc = charLocs.get(userNorm);
	  const byLocSet = new Set<string>();
	  if (myLoc) {
	    for (const [norm, loc] of charLocs.entries()) {
	      if (norm !== userNorm && loc === myLoc) byLocSet.add(norm);
	    }
	  }
	  // 合并 + 规范化为已知主名，按 norm 去重
	  const seen = new Set<string>();
	  const merged: Array<{ name: string; type: 'interact' | 'sameLoc' | 'both' }> = [];
	  const pushOne = (norm: string, type: 'interact' | 'sameLoc' | 'both') => {
	    const canonical = store.resolveKnownCharacterName(norm, true) || norm;
	    const key = store.normalizeMemoryCharacterName(canonical);
	    if (!canonical || seen.has(key)) return;
	    seen.add(key);
	    merged.push({ name: canonical, type });
	  };
	  // 先推 both：两个集合都命中的角色
	  for (const norm of byLocSet) {
	    if (interactingSet.has(norm)) pushOne(norm, 'both');
	  }
	  // 再补仅互动
	  for (const norm of interactingSet) {
	    if (!byLocSet.has(norm)) pushOne(norm, 'interact');
	  }
	  // 再补仅同地
	  for (const norm of byLocSet) {
	    if (!interactingSet.has(norm)) pushOne(norm, 'sameLoc');
	  }
	  return merged;
	});

	// 推演记录里的角色名也规范化为主名（避免别名出现在历史记录里）
	const wpRecordCharName = (rawName: string) => (store.resolveKnownCharacterName(rawName, true) || rawName);

	// ── 推演冷却可视化数据 ──
	// 冷却设置次数（单位：推演尝试次数）
	const wpEntryCooldownRounds = computed(() => store.settings.entryCooldownRounds || 1);
	const wpEntryHintCooldownRounds = computed(() => store.settings.entryHintCooldownRounds || 3);
	// 当前推演尝试序号（首次启用 attempt 机制、store 里还是 -1 时，对齐到当前已知楼层）
	const wpCurrentAttempt = computed(() => {
		const a = store.chatData.worldProgressAttempts ?? -1;
		return a >= 0 ? a : currentKnownFloor.value;
	});

	// 收集所有产生过入场引导的角色 → 最近一次入场引导对应的 attempt 序号（按规范化主名去重，取最大）
	// 旧记录没有 basedOnAttempt 时记为 -2（历史无效），UI 冷却列表跳过这类角色（视为已解封）
	const wpEntryHintAttemptsByChar = computed(() => {
		const records = store.chatData.worldProgressRecords || [];
		const map = new Map<string, { name: string; attempt: number }>();
		for (let i = records.length - 1; i >= 0; i--) {
			const r = records[i];
			if (r?.status !== 'ready' || !r.entryHint?.characterName) continue;
			const rawName = r.entryHint.characterName;
			const name = store.resolveKnownCharacterName(rawName, true) || rawName;
			const norm = store.normalizeMemoryCharacterName(name);
			let a: number;
			if (typeof (r as any).basedOnAttempt === 'number') {
				a = (r as any).basedOnAttempt;
			} else {
				a = -2; // 旧记录无 attempt → 视为已解封，不进冷却列表
			}
			const ex = map.get(norm);
			// -2 比任何有效 attempt 都低，只要有更晚的真 attempt 会被覆盖；其他情况取大
			if (!ex || a > ex.attempt) map.set(norm, { name, attempt: a });
		}
		return map;
	});

	// 冷却A 列表：仍在推演冷却中的角色（距上次入场引导经过的"推演尝试次数" < entryCooldownRounds）
	const wpCoolingAList = computed(() => {
		const rounds = wpEntryCooldownRounds.value;
		const cur = wpCurrentAttempt.value;
		const list: Array<{ name: string; remaining: number }> = [];
		for (const { name, attempt } of wpEntryHintAttemptsByChar.value.values()) {
			if (attempt < 0) continue;
			const remaining = rounds - (cur - attempt);
			if (remaining > 0) list.push({ name, remaining });
		}
		return list.sort((a, b) => a.remaining - b.remaining);
	});

	// 冷却B 列表：仍在入场引导冷却中的角色（距上次入场引导经过的"推演尝试次数" < entryHintCooldownRounds）
	const wpCoolingBList = computed(() => {
		const rounds = wpEntryHintCooldownRounds.value;
		const cur = wpCurrentAttempt.value;
		const list: Array<{ name: string; remaining: number }> = [];
		for (const { name, attempt } of wpEntryHintAttemptsByChar.value.values()) {
			if (attempt < 0) continue;
			const remaining = rounds - (cur - attempt);
			if (remaining > 0) list.push({ name, remaining });
		}
		return list.sort((a, b) => a.remaining - b.remaining);
	});

function getWPStatusLabel(status: WorldProgressRecord['status']): string {
  if (status === 'ready') return '就绪';
  if (status === 'failed') return '失败';
  if (status === 'absorbed') return '已吸收';
  if (status === 'ignored') return '已忽略';
  return status;
}

function getEntryLevelLabel(level?: number): string {
  const n = Math.max(0, Math.min(3, Number(level ?? 0)));
  if (n === 0) return '不暴露';
  if (n === 1) return '痕迹/传闻';
  if (n === 2) return '口信/通讯';
  return '本人短暂入场';
}

function getWPInjectionLabel(r: WorldProgressRecord): string {
  return r.entryHint ? '入场位 + 其余D0' : 'D0';
}

function getWPRecordTitle(r: WorldProgressRecord): string {
  const time = r.mainTimeline?.storyTime || formatWPDate(r.generatedAt);
  const count = r.advancedCharacters?.length || 0;
  return `${time || '未知时间'} | 精推${count}人`;
}

function formatWPDate(value?: string): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

function getWPRecordMemoryCount(r: WorldProgressRecord): number {
  return (r.advancedCharacters || []).filter(c => (c.memoryText || c.action || '').trim()).length;
}

function findWPStoredMemory(r: WorldProgressRecord, c: WorldProgressRecord['advancedCharacters'][number]) {
  const text = (c.memoryText || c.action || '').trim();
  const name = (c.characterName || '').trim();
  if (!text || !name) return null;
  return (store.chatData.worldProgressMemories || []).find((m: any) =>
    m.recordId === r.id
    && (m.characterName || '').trim() === name
    && (m.text || '').trim() === text,
  ) || null;
}

function getWPMemoryStateLabel(r: WorldProgressRecord, c: WorldProgressRecord['advancedCharacters'][number]): string {
  const mem: any = findWPStoredMemory(r, c);
  if (!mem) return '未入库';
  return (mem.expiresAtFloor ?? -1) >= currentKnownFloor.value ? `推忆至 #${mem.expiresAtFloor}` : '已转追忆';
}

function getWPMemoryStateClass(r: WorldProgressRecord, c: WorldProgressRecord['advancedCharacters'][number]): string {
  const mem: any = findWPStoredMemory(r, c);
  if (!mem) return 'missing';
  return (mem.expiresAtFloor ?? -1) >= currentKnownFloor.value ? 'active' : 'expired';
}

const expandedWPId = ref<string | null>(null);

function toggleWPExpand(r: WorldProgressRecord) {
  expandedWPId.value = expandedWPId.value === r.id ? null : r.id;
}

function deleteWorldRecord(id: string) {
  const idx = store.chatData.worldProgressRecords?.findIndex((r: any) => r.id === id);
  if (idx != null && idx >= 0) {
    store.chatData.worldProgressRecords.splice(idx, 1);
    store.chatData.worldProgressRecords = [...store.chatData.worldProgressRecords];
    const remaining = store.chatData.worldProgressRecords;
    if (remaining.length > 0) {
      store.chatData.lastWorldProgressFloor = Math.max(
        ...remaining.map((r: any) => r.basedOnFloorRange?.end ?? 0),
      );
    } else {
      store.chatData.lastWorldProgressFloor = -1;
    }
    store.forcePersist();
  }
}

// 重新推进（失败记录重试）
const retryingWPIds = ref<Set<string>>(new Set());
function retryWorldProgress(r: WorldProgressRecord) {
  if (retryingWPIds.value.has(r.id)) return;
  retryingWPIds.value.add(r.id);
  const currentFloor = r.basedOnFloorRange.end;
  enqueueAnalysis('world_progress', async () => {
    try {
      const latestSummary = store.getLatestSummary() || undefined;
      const wpWorldBook = hydrateSelectedWorldBookEntries(
        store.chatData.worldProgressWorldBookKeys,
        store.chatData.savedWPWB,
        store.worldBookRawCache,
      );
      store.chatData.savedWPWB = wpWorldBook;
      const candidates = store.selectWorldProgressCandidates(currentFloor, store.worldProgressManualChars || '', 2);
      const retryContents = readAssistantContentsInRange(
        Math.max(0, currentFloor - 6),
        currentFloor,
        store.chatData.capturedContents,
      );
      const record = await executeWorldProgress(
        latestSummary,
        store.chatData.smallSummaries,
        store.worldProgressManualChars || '',
        retryContents,
        currentFloor,
        store.getUserName(),
        undefined,
        store.chatData.plotOutline,
        wpWorldBook,
        store.chatData.worldProgressRecords,
        store.chatData.knowledgeGraph || null,
        store.chatData.characterLocations,
        store.settings.kgInjectTopK,
        candidates,
        undefined,
        store.getBlacklistedCharacters(),
      );
      // 用新记录替换失败记录（保持位置）
      const idx = store.chatData.worldProgressRecords.findIndex((x: any) => x.id === r.id);
      if (idx !== -1) store.chatData.worldProgressRecords[idx] = record;
      else store.chatData.worldProgressRecords.push(record);
      if (record.status === 'ready') store.addWorldProgressMemories(record, currentFloor);
      store.forcePersist();
      injectWorldProgress(store.chatData.worldProgressRecords, currentFloor + 1);
      logInfo('世界推进', '重新推进完成');
    } catch (error) {
      logError('世界推进', '重新推进失败', String(error));
      const failed = createFailedWorldProgressRecord(currentFloor, String((error as any)?.message || error || ''));
      const idx = store.chatData.worldProgressRecords.findIndex((x: any) => x.id === r.id);
      if (idx !== -1) store.chatData.worldProgressRecords[idx] = failed;
      else store.chatData.worldProgressRecords.push(failed);
      store.forcePersist();
    } finally {
      retryingWPIds.value.delete(r.id);
    }
  });
}

// 世界推进的世界书选择
const showWPWorldBook = ref(false);
const wpWorldBookSearch = ref('');
const filteredWPWorldBookEntries = computed(() => {
  const q = wpWorldBookSearch.value.trim().toLowerCase();
  let entries = worldBookEntries.value;
  if (q) {
    entries = entries.filter(e => e.key.toLowerCase().includes(q) || (e.book || '').toLowerCase().includes(q));
  }
  return entries;
});
const wpSavedKeys = computed(() => store.chatData.worldProgressWorldBookKeys || []);
const draftWPWBKeys = ref<Set<string>>(new Set());
// 按世界书分组（book 为空归"未分组"）
const wpWBGroups = computed(() => {
  const map = new Map<string, any[]>();
  for (const e of filteredWPWorldBookEntries.value) {
    const b = (e.book || '').trim() || '未分组';
    if (!map.has(b)) map.set(b, []);
    map.get(b)!.push(e);
  }
  return [...map.entries()].map(([book, entries]) => ({ book, entries }));
});
// 分组展开态（首次打开时默认全展开）
const wpWBGroupExpanded = ref<Record<string, boolean>>({});
function wpGroupOpen(book: string): boolean {
  // 搜索时强制命中组展开，否则按用户折叠态（默认展开）
  if (wpWorldBookSearch.value.trim()) return true;
  return wpWBGroupExpanded.value[book] !== false;
}
function toggleWPGroupExpand(book: string) {
  wpWBGroupExpanded.value = { ...wpWBGroupExpanded.value, [book]: !(wpWBGroupExpanded.value[book] !== false) };
  wpWBGroupExpanded.value = { ...wpWBGroupExpanded.value };
}
function wpGroupCheckedState(book: string): 'all' | 'some' | 'none' {
  const g = wpWBGroups.value.find(x => x.book === book);
  if (!g || g.entries.length === 0) return 'none';
  const marked = g.entries.filter(e => draftWPWBKeys.value.has(e.key)).length;
  if (marked === 0) return 'none';
  return marked === g.entries.length ? 'all' : 'some';
}
function toggleWPGroupAll(book: string) {
  const g = wpWBGroups.value.find(x => x.book === book);
  if (!g) return;
  const s = new Set(draftWPWBKeys.value);
  const allChecked = wpGroupCheckedState(book) === 'all';
  if (allChecked) { for (const e of g.entries) s.delete(e.key); }
  else { for (const e of g.entries) s.add(e.key); }
  draftWPWBKeys.value = s;
}
function openWPWorldBook() {
  showWPWorldBook.value = true;
  draftWPWBKeys.value = new Set(wpSavedKeys.value);
  wpWBGroupExpanded.value = {};
}
function closeWPWorldBook() {
  showWPWorldBook.value = false;
  wpWorldBookSearch.value = '';
  wpWBGroupExpanded.value = {};
}
function toggleWPWorldBookKey(key: string) {
  const s = draftWPWBKeys.value;
  if (s.has(key)) s.delete(key); else s.add(key);
  draftWPWBKeys.value = new Set(s);
}
function saveWPWBKeys() {
  // 用当前现存条目 key 集合过滤草稿，清掉源已被关/删的陈旧 key
  const liveKeys = worldBookKeySetWP.value;
  const cleaned = [...draftWPWBKeys.value].filter(k => liveKeys.has(k));
  store.chatData.worldProgressWorldBookKeys = cleaned;
  // 草稿 key 反查运行时 raw cache 正文，录入 savedWPWB（点保存才入库，未勾的不存）
  const cache = store.worldBookRawCache || [];
  store.chatData.savedWPWB = hydrateSelectedWorldBookEntries(cleaned, store.chatData.savedWPWB, cache);
  store.forcePersist();
  closeWPWorldBook();
}
const worldBookKeySetWP = computed(() => new Set(worldBookEntries.value.map(e => e.key)));

// 优先推演角色编辑
const showWpSettings = ref(false);
const showWpManualChars = ref(false);
const draftWpManualChars = ref('');

function openWpManualChars() {
  draftWpManualChars.value = store.worldProgressManualChars || '';
  showWpManualChars.value = true;
}

function saveWpManualChars() {
  const trimmed = draftWpManualChars.value.split(/[,，、]/).map(s => s.trim()).filter(Boolean).join('、');
  store.updateWorldProgressManualChars(trimmed);
  showWpManualChars.value = false;
}

function closeWpManualChars() {
  showWpManualChars.value = false;
}

// ═══════════════════════════════════════
// 剧情导演面板
// ═══════════════════════════════════════

const plotOutline = computed(() => store.chatData.plotOutline as PlotOutline | null);
const plotConversing = ref(false);
const plotUserInput = ref('');
const plotOutlineType = ref<'short' | 'medium' | 'long'>('medium');
const plotMessages = ref<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
const showWorldBookSelector = ref(false);

// 大总结注入控制（来自 settings）
const summaryCount = computed({
  get: () => store.settings.plotDirectorSummaryCount ?? 1,
  set: (v) => { store.settings.plotDirectorSummaryCount = v; store.forcePersist(); },
});
const summaryMode = computed<'detail' | 'overview'>({
  get: () => (store.settings.plotDirectorSummaryMode === 'detail' ? 'detail' : 'overview'),
  set: (v) => { store.settings.plotDirectorSummaryMode = v; store.forcePersist(); },
});
// 可用的总轮数
const totalSummaryVersions = computed(() => (store.chatData.summaries || []).length);

// 防剧透模式
const spoilerMode = computed({
  get: () => store.settings.plotDirectorSpoilerMode ?? false,
  set: (v) => { store.settings.plotDirectorSpoilerMode = v; store.forcePersist(); },
});

/**
 * 防剧透：移除 AI 回复中的 <plot_outline> 块
 * 正常对话内容保留，只隐藏大纲 JSON
 */
function sanitizeSpoiler(content: string): string {
  // 移除 <plot_outline>...</plot_outline> 块（含前后可能的多余空行）
  const cleaned = content.replace(/<plot_outline>[\s\S]*?<\/plot_outline>/gi, '');
  // 如果移除后内容为空，返回占位提示
  const trimmed = cleaned.trim();
  if (!trimmed) return '';
  // 清理多余连续空行
  return trimmed.replace(/\n{3,}/g, '\n\n');
}

// 世界书条目（供剧情导演勾选）
const worldBookEntries = computed(() => store.chatData.worldBookEntries || []);
const worldBookSearch = ref('');
const filteredWorldBookEntries = computed(() => {
  const q = worldBookSearch.value.trim().toLowerCase();
  let entries = worldBookEntries.value;
  if (q) {
    entries = entries.filter(e => e.key.toLowerCase().includes(q) || (e.book || '').toLowerCase().includes(q));
  }
  return entries;
});
// 有效条目的 key 集合
const worldBookKeySet = computed(() => new Set(worldBookEntries.value.map(e => e.key)));
// 已保存的选中 key（仅过滤展示，原始数组由 save 时清理）
const selectedWorldBookKeys = computed(() => {
  const keys = store.chatData.selectedWorldBookKeys || [];
  return keys.filter(k => worldBookKeySet.value.has(k));
});
// 草稿：本地勾选状态，点了保存才提交到 store
const draftPlotWBKeys = ref<Set<string>>(new Set());
// 按世界书分组
const plotWBGroups = computed(() => {
  const map = new Map<string, any[]>();
  for (const e of filteredWorldBookEntries.value) {
    const b = (e.book || '').trim() || '未分组';
    if (!map.has(b)) map.set(b, []);
    map.get(b)!.push(e);
  }
  return [...map.entries()].map(([book, entries]) => ({ book, entries }));
});
const plotWBGroupExpanded = ref<Record<string, boolean>>({});
function plotGroupOpen(book: string): boolean {
  if (worldBookSearch.value.trim()) return true;
  return plotWBGroupExpanded.value[book] !== false;
}
function togglePlotGroupExpand(book: string) {
  plotWBGroupExpanded.value = { ...plotWBGroupExpanded.value, [book]: !(plotWBGroupExpanded.value[book] !== false) };
  plotWBGroupExpanded.value = { ...plotWBGroupExpanded.value };
}
function plotGroupCheckedState(book: string): 'all' | 'some' | 'none' {
  const g = plotWBGroups.value.find(x => x.book === book);
  if (!g || g.entries.length === 0) return 'none';
  const marked = g.entries.filter(e => draftPlotWBKeys.value.has(e.key)).length;
  if (marked === 0) return 'none';
  return marked === g.entries.length ? 'all' : 'some';
}
function togglePlotGroupAll(book: string) {
  const g = plotWBGroups.value.find(x => x.book === book);
  if (!g) return;
  const s = new Set(draftPlotWBKeys.value);
  const allChecked = plotGroupCheckedState(book) === 'all';
  if (allChecked) { for (const e of g.entries) s.delete(e.key); }
  else { for (const e of g.entries) s.add(e.key); }
  draftPlotWBKeys.value = s;
}
function openPlotWorldBook() {
  showWorldBookSelector.value = true;
  draftPlotWBKeys.value = new Set(selectedWorldBookKeys.value);
  plotWBGroupExpanded.value = {};
}
function closePlotWorldBook() {
  showWorldBookSelector.value = false;
  worldBookSearch.value = '';
  plotWBGroupExpanded.value = {};
}
function toggleWorldBookKey(key: string) {
  const s = draftPlotWBKeys.value;
  if (s.has(key)) s.delete(key); else s.add(key);
  // 触发响应式
  draftPlotWBKeys.value = new Set(s);
}
function savePlotWBKeys() {
  // 用当前现存条目 key 集合过滤草稿，清掉源已被关/删的陈旧 key
  const liveKeys = worldBookKeySet.value;
  const cleaned = [...draftPlotWBKeys.value].filter(k => liveKeys.has(k));
  store.chatData.selectedWorldBookKeys = cleaned;
  // 草稿 key 反查运行时 raw cache 正文，录入 savedPlotWB（点保存才入库，未勾的不存）
  const cache = store.worldBookRawCache || [];
  store.chatData.savedPlotWB = hydrateSelectedWorldBookEntries(cleaned, store.chatData.savedPlotWB, cache);
  store.forcePersist();
  closePlotWorldBook();
}

// 选中的世界书内容（正文取自点保存时录入的 savedPlotWB）
const selectedWorldBookContent = computed(() => store.chatData.savedPlotWB || []);

// 切 tab 后组件重新挂载时 plotMessages 会丢失，从 store 恢复
watch(plotOutline, (outline) => {
  if (outline?.conversationHistory && outline.conversationHistory.length > 0) {
    plotMessages.value = [...outline.conversationHistory];
  }
}, { immediate: true });

function startNewOutline() {
  const outline = createEmptyOutline(plotOutlineType.value);
  store.chatData.plotOutline = outline;
  plotMessages.value = outline.conversationHistory || [];
  store.forcePersist();
}

async function sendPlotMessage() {
  if (!plotUserInput.value.trim() || plotConversing.value) return;
  const msg = plotUserInput.value.trim();
  plotUserInput.value = '';
  plotConversing.value = true;

  plotMessages.value.push({ role: 'user', content: msg });

  try {
    const existingChars = store.getAllCharacterNames();
    // 构建多轮大总结注入文本
    const deltas = (store.chatData.summaries || []) as any[];
    const multiSummaryText = buildMultiSummaryInjection(
      deltas,
      summaryCount.value,
      summaryMode.value,
    );

    const { reply, outline: newOutline } = await executeOutlineConversation(
      msg,
      plotMessages.value,
      plotOutlineType.value,
      existingChars,
      multiSummaryText,
      store.getUserName(),
      undefined,
      selectedWorldBookContent.value,
    );

    plotMessages.value.push({ role: 'assistant', content: reply });

    if (newOutline && store.chatData.plotOutline) {
      store.chatData.plotOutline = {
        ...newOutline,
        conversationHistory: [...plotMessages.value],
      };
    }

    if (store.chatData.plotOutline) {
      (store.chatData.plotOutline as any).conversationHistory = [...plotMessages.value];
    }
    store.forcePersist();
  } catch (e: any) {
    plotMessages.value.push({ role: 'assistant', content: `[错误] ${e?.message || e}` });
  } finally {
    plotConversing.value = false;
  }
}

function doActivateOutline() {
  if (store.chatData.plotOutline) {
    store.chatData.plotOutline = activateOutline(store.chatData.plotOutline as PlotOutline);
    store.forcePersist();
  }
}

function doAbandonOutline() {
  if (store.chatData.plotOutline) {
    store.chatData.plotOutline = abandonOutline(store.chatData.plotOutline as PlotOutline);
    store.forcePersist();
  }
}

function doAdvanceStage() {
  if (store.chatData.plotOutline) {
    store.chatData.plotOutline = advanceOutlineStage(store.chatData.plotOutline as PlotOutline);
    store.forcePersist();
  }
}

</script>

<template>
  <div class="world-tab">
    <!-- 子面板导航 -->
    <SubTabNav
      :model-value="activePanel"
      :items="items"
      class="wt-subnav"
      @update:model-value="activePanel = $event as SubPanel"
    />

    <!-- ═══ 世界推进面板 ═══ -->
    <div v-if="activePanel === 'world_progress'" class="wt-panel">
      <div class="wt-panel-header">
        <span class="wt-panel-title">世界推进 · 场外短期记忆</span>
        <span class="wt-count">{{ worldRecords.length }} 条记录 · {{ activeWPMemories.length }}/{{ wpMemoryTotal }} 推忆生效</span>
      </div>

      <!-- 折叠设置：推演冷却 + 优先角色 + 世界书选择 -->
      <div class="wt-wp-settings-fold" :class="{ open: showWpSettings }">
        <div class="wt-wp-settings-toggle" @click="showWpSettings = !showWpSettings">
          <span>设置（优先角色 · 世界书）</span>
          <span class="wt-plot-worldbook-arrow">{{ showWpSettings ? '▲' : '▼' }}</span>
        </div>
        <div v-if="showWpSettings" class="wt-wp-settings-body">
          <!-- 推演冷却 -->
          <div class="wt-wp-cooldown-card">
            <div class="wt-wp-cd-head">
              <span class="wt-wp-cd-title">推演冷却</span>
              <span class="wt-wp-cd-sub">入场引导后限定若干次推演尝试内不再推同一角色 / 不再注入其入场引导</span>
            </div>
            <div class="wt-wp-cd-grid">
              <!-- 冷却A：N 次推演内不再推演 -->
              <div class="wt-wp-cd-item">
                <div class="wt-wp-cd-item-head">
                  <span class="wt-wp-cd-item-name">推演冷却 A</span>
                  <input type="number" class="wt-wp-cd-num" :value="store.settings.entryCooldownRounds" min="1" max="30"
                    @change="store.updateSettings({ entryCooldownRounds: Number(($event.target as HTMLInputElement).value) })" />
                  <span class="wt-wp-cd-unit">次</span>
                </div>
                <div class="wt-wp-cd-item-desc">产生入场引导后 N 次推演尝试内不再推该角色</div>
                <div class="wt-wp-cd-list">
                  <template v-if="wpCoolingAList.length > 0">
                    <div v-for="c in wpCoolingAList" :key="'cdA_' + c.name" class="wt-wp-cd-chip">
                      <span class="wt-wp-cd-chip-name">{{ c.name }}</span>
                      <span class="wt-wp-cd-chip-tail">剩 {{ c.remaining }} 次</span>
                    </div>
                  </template>
                  <span v-else class="wt-wp-row-empty">无冷却中角色</span>
                </div>
              </div>
              <!-- 冷却B：N 次推演内不再注入入场引导 -->
              <div class="wt-wp-cd-item">
                <div class="wt-wp-cd-item-head">
                  <span class="wt-wp-cd-item-name">入场引导冷却 B</span>
                  <input type="number" class="wt-wp-cd-num" :value="store.settings.entryHintCooldownRounds" min="1" max="30"
                    @change="store.updateSettings({ entryHintCooldownRounds: Number(($event.target as HTMLInputElement).value) })" />
                  <span class="wt-wp-cd-unit">次</span>
                </div>
                <div class="wt-wp-cd-item-desc">产生入场引导后 N 次推演尝试内不再为该角色注入入场引导</div>
                <div class="wt-wp-cd-list">
                  <template v-if="wpCoolingBList.length > 0">
                    <div v-for="c in wpCoolingBList" :key="'cdB_' + c.name" class="wt-wp-cd-chip">
                      <span class="wt-wp-cd-chip-name">{{ c.name }}</span>
                      <span class="wt-wp-cd-chip-tail">剩 {{ c.remaining }} 次</span>
                    </div>
                  </template>
                  <span v-else class="wt-wp-row-empty">无冷却中角色</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 优先推演角色 -->
          <div class="wt-plot-worldbook">
            <div class="wt-plot-worldbook-toggle" @click="showWpManualChars ? closeWpManualChars() : openWpManualChars()">
              <span>优先推演角色 ({{ wpManualCharCount }})</span>
              <span class="wt-plot-worldbook-arrow">{{ showWpManualChars ? '▲' : '▼' }}</span>
            </div>
            <div v-if="showWpManualChars" class="wt-plot-worldbook-list">
              <div class="wt-wb-header">
                <span class="wt-wb-hint">逗号分隔角色名（不限数量），手动角色权重最高，最终仅推 2 个且过滤在场角色</span>
                <button class="wt-wb-save-btn" @click="saveWpManualChars">保存</button>
              </div>
              <input
                v-model="draftWpManualChars"
                class="wt-plot-worldbook-search"
                style="font-size:11px"
                placeholder="例：秋青、张伟" aria-label="例：秋青、张伟"
                maxlength="60"
              />
            </div>
          </div>

          <!-- 世界书选择 -->
          <div class="wt-plot-worldbook">
            <div class="wt-plot-worldbook-toggle" @click="showWPWorldBook ? closeWPWorldBook() : openWPWorldBook()">
              <span>世界书参考 ({{ wpSavedKeys.length }}/{{ worldBookEntries.length }})</span>
              <span class="wt-plot-worldbook-arrow">{{ showWPWorldBook ? '▲' : '▼' }}</span>
            </div>
            <div v-if="showWPWorldBook" class="wt-plot-worldbook-list wt-wb-list-wrap">
              <div class="wt-wb-toolbar">
                <input v-model="wpWorldBookSearch" class="wt-plot-worldbook-search" placeholder="搜索条目/世界书..." aria-label="搜索条目/世界书..." />
                <button class="wt-wb-save-btn" @click="saveWPWBKeys">保存</button>
              </div>
              <div class="wt-wb-groups">
                <template v-if="wpWBGroups.length > 0">
                  <div v-for="g in wpWBGroups" :key="g.book" class="wt-wb-group">
                    <div class="wt-wb-group-head" @click="toggleWPGroupExpand(g.book)">
                      <input
                        type="checkbox"
                        :checked="wpGroupCheckedState(g.book) === 'all'"
                        :indeterminate.prop="wpGroupCheckedState(g.book) === 'some'"
                        @click.stop=""
                        @change.stop="toggleWPGroupAll(g.book)"
                      />
                      <span class="wt-wb-group-name">{{ g.book }} ({{ g.entries.filter(e => draftWPWBKeys.has(e.key)).length }}/{{ g.entries.length }})</span>
                      <span class="wt-wb-group-arrow">{{ wpGroupOpen(g.book) ? '▲' : '▼' }}</span>
                    </div>
                    <div v-if="wpGroupOpen(g.book)" class="wt-wb-group-body">
                      <label v-for="entry in g.entries" :key="entry.key" class="wt-plot-worldbook-item">
                        <input type="checkbox" :checked="draftWPWBKeys.has(entry.key)" @change="toggleWPWorldBookKey(entry.key)" />
                        <span>{{ entry.key }}</span>
                      </label>
                    </div>
                  </div>
                </template>
                <div v-else class="wt-placeholder">{{ wpWorldBookSearch ? '无匹配条目' : '暂无世界书条目' }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 顶部信息条：触发态 + 精推人数（合并到一行精简条） -->
      <div class="wt-wp-topbar" :class="{ active: store.chatData.pendingWorldProgress }">
        <span class="wt-wp-topbar-tag">{{ store.chatData.pendingWorldProgress ? `待玩家发言后推 #${store.chatData.pendingWorldProgressFloor}` : '空闲' }}</span>
        <span class="wt-wp-topbar-tag">{{ store.chatData.pendingWorldProgress ? '本次待推候选' : '下次候选预估' }} · 2 个不在场角色</span>
      </div>

      <!-- 当前在场 + 候选预览 合并到一个紧凑 box -->
      <div v-if="store.settings.worldProgressEnabled" class="wt-wp-predict-box">
        <!-- 当前在场角色（合并后的 badge 行） -->
        <div class="wt-wp-present-row">
          <span class="wt-wp-row-label">在场</span>
          <template v-if="wpPresentPreview.length > 0">
            <span
              v-for="p in wpPresentPreview"
              :key="'wp_pres_' + p.name"
              class="wt-wp-present-badge"
              :class="p.type"
              :title="p.type === 'both' ? '互动且同地点' : p.type === 'interact' ? '正文实际互动' : '与玩家同地点'"
            >{{ p.name }}</span>
          </template>
          <span v-else class="wt-wp-row-empty">无</span>
        </div>
        <!-- 下次候选预览 -->
        <div class="wt-wp-candidate-row">
          <span class="wt-wp-row-label">候选</span>
          <template v-if="wpCandidatePreview.length > 0">
            <div v-for="c in wpCandidatePreview" :key="c.characterName" class="wt-wp-candidate">
              <span class="wt-wp-candidate-name">{{ c.characterName }}</span>
              <span v-if="c.manual" class="wt-wp-mini-badge manual">手动</span>
              <span v-if="c.inEntryHintCooldown" class="wt-wp-mini-badge cooldown">禁入场引导</span>
              <span class="wt-wp-candidate-loc">{{ c.locationName || c.locationId || '未知地点' }}</span>
            </div>
          </template>
          <span v-else class="wt-wp-row-empty">暂无可推演的不在场角色</span>
        </div>
      </div>

      <EmptyHint v-if="!store.settings.worldProgressEnabled" text="世界推进功能未开启。请在「设置」中启用。" />
      <div v-else-if="worldRecords.length === 0" class="wt-placeholder">
        暂无世界推进记录。满足每{{ store.settings.worldProgressInterval }}轮对话的间隔后，会先标记待推演，并在玩家下一次发送消息时后台精推。
      </div>

      <template v-else>
        <div class="wt-list">
          <div
            v-for="r in worldRecords"
            :key="r.id"
            class="wt-item"
            :class="[{ expanded: expandedWPId === r.id }, `wt-status-${r.status}`]"
          >
            <div class="wt-item-header" @click="toggleWPExpand(r)">
              <span class="wt-item-floor">#{{ r.basedOnFloorRange.start }}~{{ r.basedOnFloorRange.end }}</span>
              <span class="wt-item-badge" :class="r.status">{{ getWPStatusLabel(r.status) }}</span>
              <span class="wt-item-event">{{ getWPRecordTitle(r) }}</span>
              <span v-if="r.entryHint" class="wt-item-chars">L{{ r.entryHint.level }} / {{ getWPInjectionLabel(r) }}</span>
              <span v-else class="wt-item-chars">{{ getWPInjectionLabel(r) }}</span>
            </div>

            <div v-if="expandedWPId === r.id" class="wt-item-detail">
              <div v-if="r.status === 'failed'" class="wt-wp-failed-hint">
                ⚠ 推进失败{{ r.rawJson ? `：${r.rawJson.slice(0, 120)}` : '' }}，可点击下方「重新推进」重试
              </div>
              <template v-else>
                <div class="wt-wp-record-meta">
                  <div v-if="r.mainTimeline.storyTime || r.mainTimeline.location" class="wt-detail-row">
                    <span class="wt-detail-label">旧版切片:</span>
                    <span>{{ r.mainTimeline.storyTime || '未知时间' }} · {{ r.mainTimeline.location || '未知地点' }}</span>
                  </div>
                  <div v-if="r.mainTimeline.event || r.mainTimeline.worldStateOneLine" class="wt-detail-row">
                    <span class="wt-detail-label">旧版正文信息:</span>
                    <span>{{ r.mainTimeline.event || r.mainTimeline.worldStateOneLine || '未记录' }}</span>
                  </div>
                  <div v-if="r.presentCharacters.length > 0" class="wt-detail-row">
                    <span class="wt-detail-label">旧版在场过滤:</span>
                    <span>{{ (r.presentCharacters || []).map(wpRecordCharName).join('、') || '无' }}</span>
                  </div>
                  <div class="wt-detail-row">
                    <span class="wt-detail-label">记忆入库:</span>
                    <span>{{ getWPRecordMemoryCount(r) }} 条，保存 20 楼层后转入追忆</span>
                  </div>
                </div>

                <div v-if="r.advancedCharacters.length > 0" class="wt-wp-chars">
                  <div class="wt-wp-section-head">
                    <span>不在场角色近期记忆</span>
                    <span>正文注入不带“推”，角色库标记为推忆</span>
                  </div>
                  <div v-for="(c, i) in r.advancedCharacters" :key="i" class="wt-wp-char-card">
                    <div class="wt-wp-char-head">
                      <div>
                        <span class="wt-wp-char-name">{{ wpRecordCharName(c.characterName) }}</span>
                        <span class="wt-wp-char-location">{{ c.location || '未知地点' }}</span>
                      </div>
                      <span class="wt-wp-memory-state" :class="getWPMemoryStateClass(r, c)">
                        {{ getWPMemoryStateLabel(r, c) }}
                      </span>
                    </div>
                    <div class="wt-wp-memory-text">{{ c.memoryText || c.action || '无记忆文本' }}</div>
                    <div v-if="c.result" class="wt-wp-char-result">结果：{{ c.result }}</div>
                    <div v-if="c.reason" class="wt-wp-char-reason">旧字段原因：{{ c.reason }}</div>
                    <div v-if="c.possibleEncounter" class="wt-wp-char-encounter">旧字段相遇：{{ c.possibleEncounter }}</div>
                    <div v-if="c.newFacts?.length" class="wt-wp-facts">
                      <span v-for="fact in c.newFacts" :key="fact">{{ fact }}</span>
                    </div>
                  </div>
                </div>

                <div v-if="r.entryHint" class="wt-wp-hooks">
                  <div class="wt-wp-section-head">
                    <span>入场引导</span>
                    <span>{{ getEntryLevelLabel(r.entryHint.level) }} · 梦呓位置上方</span>
                  </div>
                  <div class="wt-wp-hook-item">
                    <div class="wt-wp-hook-title">{{ wpRecordCharName(r.entryHint.characterName) }} · level {{ r.entryHint.level }}</div>
                    <div>{{ r.entryHint.hint }}</div>
                    <div v-if="r.entryHint.avoid" class="wt-wp-hook-avoid">避免：{{ r.entryHint.avoid }}</div>
                  </div>
                </div>

                <div v-if="r.backgroundEvents.length > 0" class="wt-wp-bg">
                  <div class="wt-detail-label" style="margin-top:8px">旧版背景事件:</div>
                  <div v-for="(evt, i) in r.backgroundEvents" :key="i" class="wt-wp-bg-item">{{ evt }}</div>
                </div>
              </template>
              <div style="margin-top:8px;text-align:right">
                <button
                  v-if="r.status === 'failed'"
                  class="wt-btn-retry wt-btn-inline"
                  :disabled="retryingWPIds.has(r.id)"
                  @click.stop="retryWorldProgress(r)"
                >{{ retryingWPIds.has(r.id) ? '推进中...' : '重新推进' }}</button>
                <ConfirmButton @click.stop @confirm="deleteWorldRecord(r.id)" />
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- ═══ 剧情导演面板 ═══ -->
    <div v-if="activePanel === 'plot_director'" class="wt-panel">
      <div class="wt-panel-header">
        <span class="wt-panel-title">剧情导演</span>
        <span v-if="plotOutline" class="wt-badge" :class="plotOutline.status">{{ plotOutline.status }}</span>
        <label class="wt-spoiler-toggle" title="防剧透：隐藏AI规划内容">
          <input type="checkbox" v-model="spoilerMode" />
          <span class="wt-spoiler-label">防剧透</span>
        </label>
      </div>

      <EmptyHint v-if="!store.settings.plotDirectorEnabled" text="剧情导演功能未开启。请在「设置」中启用。" />

      <!-- 无大纲：创建入口 -->
      <template v-else-if="!plotOutline || plotOutline.status === 'abandoned' || plotOutline.status === 'completed'">
        <div class="wt-plot-create">
          <div class="wt-detail-label">创建剧情大纲</div>
          <div class="wt-plot-type-row">
            <button
              v-for="t in (['short', 'medium', 'long'] as const)"
              :key="t"
              class="wt-plot-type-btn"
              :class="{ active: plotOutlineType === t }"
              @click="plotOutlineType = t"
            >{{ t === 'short' ? '短篇' : t === 'medium' ? '中篇' : '长篇' }}</button>
          </div>
          <button class="wt-btn-primary" @click="startNewOutline">开始创建</button>
          <div v-if="plotOutline?.status === 'completed'" class="wt-plot-complete-note">
            上一个大纲已完成 ({{ plotOutline.stages.length }} 阶段)
          </div>
        </div>
      </template>

      <!-- 草稿中：对话界面 -->
      <template v-else-if="plotOutline.status === 'drafting'">
        <div class="wt-plot-chat">
          <!-- 世界书条目选择 -->
          <div class="wt-plot-worldbook">
            <div class="wt-plot-worldbook-toggle" @click="showWorldBookSelector ? closePlotWorldBook() : openPlotWorldBook()">
              <span>世界书参考 ({{ selectedWorldBookKeys.length }}/{{ worldBookEntries.length }})</span>
              <span class="wt-plot-worldbook-arrow">{{ showWorldBookSelector ? '▲' : '▼' }}</span>
            </div>
            <div v-if="showWorldBookSelector" class="wt-plot-worldbook-list wt-wb-list-wrap">
              <div class="wt-wb-toolbar">
                <input v-model="worldBookSearch" class="wt-plot-worldbook-search" placeholder="搜索条目/世界书..." aria-label="搜索条目/世界书..." />
                <button class="wt-wb-save-btn" @click="savePlotWBKeys">保存</button>
              </div>
              <div class="wt-wb-groups">
                <template v-if="plotWBGroups.length > 0">
                  <div v-for="g in plotWBGroups" :key="g.book" class="wt-wb-group">
                    <div class="wt-wb-group-head" @click="togglePlotGroupExpand(g.book)">
                      <input
                        type="checkbox"
                        :checked="plotGroupCheckedState(g.book) === 'all'"
                        :indeterminate.prop="plotGroupCheckedState(g.book) === 'some'"
                            @click.stop=""
                            @change.stop="togglePlotGroupAll(g.book)"
                      />
                      <span class="wt-wb-group-name">{{ g.book }} ({{ g.entries.filter(e => draftPlotWBKeys.has(e.key)).length }}/{{ g.entries.length }})</span>
                      <span class="wt-wb-group-arrow">{{ plotGroupOpen(g.book) ? '▲' : '▼' }}</span>
                    </div>
                    <div v-if="plotGroupOpen(g.book)" class="wt-wb-group-body">
                      <label v-for="entry in g.entries" :key="entry.key" class="wt-plot-worldbook-item">
                        <input type="checkbox" :checked="draftPlotWBKeys.has(entry.key)" @change="toggleWorldBookKey(entry.key)" />
                        <span>{{ entry.key }}</span>
                      </label>
                    </div>
                  </div>
                </template>
                <div v-else class="wt-placeholder">{{ worldBookSearch ? '无匹配条目' : '暂无世界书条目' }}</div>
              </div>
            </div>
          </div>
          <!-- 大总结注入控制 -->
          <div class="wt-plot-summary-cfg">
            <div class="wt-summary-cfg-row">
              <span class="wt-summary-cfg-label">大总结轮数</span>
              <input
                type="number"
                class="wt-summary-cfg-num"
                :value="summaryCount"
                @input="summaryCount = $event.target ? Math.max(1, parseInt(($event.target as HTMLInputElement).value) || 1) : 1"
                min="1"
              />
              <span class="wt-summary-cfg-hint">/ {{ totalSummaryVersions }} 轮可用</span>
              <button
                v-if="summaryCount !== totalSummaryVersions && totalSummaryVersions > 0"
                class="wt-summary-cfg-all"
                @click="summaryCount = totalSummaryVersions"
              >全部</button>
            </div>
            <div class="wt-summary-cfg-row">
              <span class="wt-summary-cfg-label">注入模式</span>
              <label class="wt-summary-cfg-radio">
                <input type="radio" value="detail" v-model="summaryMode" />
                <span>详情</span>
              </label>
              <label class="wt-summary-cfg-radio">
                <input type="radio" value="overview" v-model="summaryMode" />
                <span>速览</span>
              </label>
            </div>
          </div>
          <div class="wt-plot-messages">
            <div
              v-for="(msg, i) in plotMessages"
              :key="i"
              class="wt-plot-msg"
              :class="msg.role"
            >
              <div v-if="msg.role === 'user'" class="wt-plot-msg-content">{{ msg.content }}</div>
              <div v-else-if="spoilerMode" class="wt-plot-msg-content">
                <template v-if="sanitizeSpoiler(msg.content)">
                  {{ sanitizeSpoiler(msg.content) }}
                </template>
                <span v-if="/<plot_outline>/i.test(msg.content)" class="wt-spoiler-inline">[大纲已隐藏]</span>
              </div>
              <div v-else class="wt-plot-msg-content">{{ msg.content }}</div>
            </div>
              <EmptyHint v-if="plotMessages.length === 0" text="告诉AI你想玩什么类型的剧情、哪些角色参与、大致结局方向。AI会帮你产出大纲。" />
          </div>
          <div class="wt-plot-input-row">
            <input
              v-model="plotUserInput"
              class="wt-plot-input"
              placeholder="描述你想要的剧情方向..." aria-label="描述你想要的剧情方向..."
              :disabled="plotConversing"
              @keyup.enter="sendPlotMessage"
            />
            <button class="wt-btn-primary" :disabled="plotConversing || !plotUserInput.trim()" @click="sendPlotMessage">
              {{ plotConversing ? '...' : '发送' }}
            </button>
          </div>
          <div class="wt-plot-actions">
            <button v-if="plotOutline.stages.length > 0" class="wt-btn-save" @click="doActivateOutline">激活大纲</button>
            <button class="wt-btn-danger" @click="doAbandonOutline">放弃</button>
          </div>
        </div>
      </template>

      <!-- 活跃中：进度展示 -->
      <template v-else-if="plotOutline.status === 'active'">
        <div class="wt-plot-active">
          <div class="wt-plot-progress">
            <div class="wt-detail-label">阶段进度: {{ plotOutline.currentStageIndex + 1 }} / {{ plotOutline.stages.length }}</div>
            <div class="wt-plot-progress-bar">
              <div class="wt-plot-progress-fill" :style="{ width: ((plotOutline.currentStageIndex + 1) / plotOutline.stages.length * 100) + '%' }"></div>
            </div>
          </div>

          <!-- 防剧透模式：隐藏结局、阶段详情、校对结果 -->
          <template v-if="spoilerMode">
            <div class="wt-spoiler-notice">🔒 大纲运行中（防剧透模式）</div>
          </template>
          <template v-else>
            <div class="wt-plot-ending">结局方向: {{ plotOutline.targetEnding }}</div>

            <div class="wt-plot-stages">
              <div
                v-for="(stage, i) in plotOutline.stages"
                :key="i"
                class="wt-plot-stage"
                :class="{ current: i === plotOutline.currentStageIndex, done: stage.completed }"
              >
                <span class="wt-plot-stage-idx">{{ i + 1 }}</span>
                <span class="wt-plot-stage-desc">{{ stage.description }}</span>
                <span v-if="stage.keyCharacters.length > 0" class="wt-plot-stage-chars">{{ stage.keyCharacters.join(', ') }}</span>
              </div>
            </div>

            <!-- 最新校对结果 -->
            <div v-if="store.chatData.lastPlotCheckResult" class="wt-plot-check">
              <div class="wt-detail-label">最新校对:</div>
              <div class="wt-plot-check-status" :class="store.chatData.lastPlotCheckResult.stageProgress">
                {{ store.chatData.lastPlotCheckResult.stageProgress === 'on_track' ? '正轨' :
                   store.chatData.lastPlotCheckResult.stageProgress === 'ahead' ? '超前' :
                   store.chatData.lastPlotCheckResult.stageProgress === 'behind' ? '落后' : '偏离' }}
              </div>
              <div v-if="store.chatData.lastPlotCheckResult.suggestedGuidance" class="wt-plot-check-guidance">
                {{ store.chatData.lastPlotCheckResult.suggestedGuidance }}
              </div>
            </div>
          </template>

          <div class="wt-plot-actions">
            <button class="wt-btn-save" @click="doAdvanceStage">推进阶段</button>
            <button class="wt-btn-danger" @click="doAbandonOutline">放弃大纲</button>
          </div>
        </div>
      </template>
    </div>

    <!-- ═══ 世界书标签面板 ═══ -->
    <WorldBookTagsTab v-if="activePanel === 'worldbook_tags'" />
  </div>
</template>

<style scoped>
.world-tab {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 子面板导航（SubTabNav 原语） */
.wt-subnav { margin-bottom: var(--zn-space-3); flex-shrink: 0; }

/* 通用面板 */
.wt-panel {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wt-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.wt-panel-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--zn-text-regular);
}
.wt-count {
  font-size: 11px;
  color: rgba(var(--zn-accent-rgb), 0.7);
}
.wt-placeholder {
  font-size: 12px;
  color: var(--zn-text-muted);
  line-height: 1.6;
  padding: 12px;
  background: var(--zn-surface-sunken);
  border-radius: 6px;
  border: 1px dashed var(--zn-border-light);
}

/* 翻页 */
.wt-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 4px 0;
  flex-shrink: 0;
}
.wt-page-btn {
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid rgba(var(--zn-accent-rgb), 0.2);
  background: rgba(var(--zn-accent-rgb), 0.06);
  color: rgba(var(--zn-accent-rgb), 0.8);
  cursor: pointer;
}
.wt-page-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.wt-page-info { font-size: 11px; color: var(--zn-text-muted); }

/* 列表 */
.wt-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wt-item {
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.15);
  transition: border-color 0.15s;
}
.wt-item.expanded { border-color: rgba(var(--zn-accent-rgb), 0.2); }
.wt-item.wt-status-failed { border-left: 2px solid rgba(var(--zn-danger-rgb), 0.5); }
.wt-item.wt-status-ready { border-left: 2px solid rgba(var(--zn-success-rgb), 0.3); }
.wt-item.wt-status-absorbed { border-left: 2px solid rgba(var(--zn-accent-rgb), 0.35); opacity: 0.82; }
.wt-item.wt-status-ignored { border-left: 2px solid rgba(255, 255, 255, 0.12); opacity: 0.7; }
.wt-wp-failed-hint {
  font-size: 12px;
  color: rgba(var(--zn-danger-rgb), 0.85);
  background: rgba(var(--zn-danger-rgb), 0.06);
  border: 1px solid rgba(var(--zn-danger-rgb), 0.2);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
  line-height: 1.5;
  word-break: break-all;
}

.wt-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  cursor: pointer;
  font-size: 12px;
}
.wt-item-header:hover { background: rgba(255, 255, 255, 0.02); }
.wt-item-floor {
  flex-shrink: 0;
  color: rgba(var(--zn-accent-rgb), 0.9);
  font-weight: 600;
  font-size: 11px;
  min-width: 52px;
}
.wt-item-badge {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--zn-bg-surface2);
  color: var(--zn-text-regular);
}
.wt-item-badge.ready { color: rgba(var(--zn-success-rgb), 0.8); background: rgba(var(--zn-success-rgb), 0.08); }
.wt-item-badge.failed { color: rgba(var(--zn-danger-rgb), 0.8); background: rgba(var(--zn-danger-rgb), 0.08); }
.wt-item-badge.pending { color: rgba(var(--zn-warn-rgb), 0.8); background: rgba(var(--zn-warn-rgb), 0.08); }
.wt-item-badge.absorbed { color: rgba(var(--zn-accent-rgb), 0.78); background: rgba(var(--zn-accent-rgb), 0.08); }
.wt-item-badge.ignored { color: var(--zn-text-muted); background: rgba(255, 255, 255, 0.04); }
.wt-item-event {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--zn-text-regular);
}
.wt-item-chars {
  flex-shrink: 0;
  font-size: 10px;
  color: rgba(var(--zn-accent-rgb), 0.5);
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 物品库专用样式（固定列宽对齐） */
.wt-item-name {
  width: 110px;
  flex-shrink: 0;
  color: rgba(var(--zn-accent-rgb), 0.9);
  font-weight: 600;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wt-item-desc {
  width: 190px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--zn-text-regular);
  font-size: 11px;
}
.wt-item-owner {
  width: 72px;
  flex-shrink: 0;
  color: rgba(var(--zn-success-rgb), 0.7);
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wt-item-state {
  width: 48px;
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--zn-bg-surface2);
  color: var(--zn-text-regular);
  text-align: center;
}
.wt-item-source {
  flex: 1;
  min-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--zn-text-muted);
  font-size: 10px;
}
/* 物品编辑模式 */
.wt-item-edit {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
}
.wt-edit-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.wt-edit-label {
  flex-shrink: 0;
  width: 42px;
  font-size: 10px;
  color: var(--zn-text-muted);
}
.wt-edit-input {
  flex: 1;
  background: var(--zn-bg-surface2);
  border: 1px solid var(--zn-border-light);
  border-radius: 4px;
  color: var(--zn-text-primary);
  font-size: 11px;
  padding: 3px 6px;
  outline: none;
}
.wt-edit-input:focus {
  border-color: rgba(var(--zn-accent-rgb), 0.4);
}
.wt-edit-actions {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}

/* 详情 */
.wt-item-detail {
  padding: 8px 10px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  font-size: 12px;
}
.wt-detail-row {
  display: flex;
  gap: 4px;
  margin-bottom: 3px;
  color: rgba(255, 255, 255, 0.65);
}
.wt-detail-label {
  color: var(--zn-text-muted);
  flex-shrink: 0;
  font-size: 11px;
}

/* 顶部精简条 */
.wt-wp-topbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.18);
  border: 1px solid rgba(255, 255, 255, 0.04);
  flex-shrink: 0;
  transition: border-color 0.15s;
}
.wt-wp-topbar.active {
  border-color: rgba(var(--zn-warn-rgb), 0.35);
  background: rgba(var(--zn-warn-rgb), 0.05);
}
.wt-wp-topbar-tag {
  font-size: 11px;
  color: var(--zn-text-regular);
  white-space: nowrap;
}
.wt-wp-topbar-tag:first-child {
  color: rgba(var(--zn-accent-rgb), 0.9);
  font-weight: 600;
}
.wt-wp-topbar.active .wt-wp-topbar-tag:first-child {
  color: rgba(var(--zn-warn-rgb), 0.9);
}

/* 在场 + 候选 预览合并 box */
.wt-wp-predict-box {
  background: rgba(0, 0, 0, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}
.wt-wp-row-label {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: var(--zn-text-muted);
  padding-top: 3px;
  min-width: 28px;
}
.wt-wp-row-empty {
  font-size: 11px;
  color: var(--zn-text-muted);
  font-style: italic;
}
.wt-wp-present-row {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 4px;
}
.wt-wp-present-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(var(--zn-accent-rgb), 0.08);
  color: rgba(var(--zn-accent-rgb), 0.8);
  border: 1px solid rgba(var(--zn-accent-rgb), 0.12);
  white-space: nowrap;
}
.wt-wp-present-badge.both {
  background: rgba(var(--zn-success-rgb), 0.1);
  color: rgba(var(--zn-success-rgb), 0.9);
  border-color: rgba(var(--zn-success-rgb), 0.2);
}
.wt-wp-present-badge.interact {
  background: rgba(var(--zn-warn-rgb), 0.08);
  color: rgba(var(--zn-warn-rgb), 0.85);
  border-color: rgba(var(--zn-warn-rgb), 0.18);
}
.wt-wp-present-badge.sameLoc {
  background: rgba(var(--zn-accent-rgb), 0.06);
  color: rgba(var(--zn-accent-rgb), 0.65);
  border-color: rgba(var(--zn-accent-rgb), 0.1);
}
.wt-wp-candidate-row {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 6px;
}
.wt-wp-candidate {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.wt-wp-candidate-name {
  font-weight: 600;
  color: var(--zn-text-regular);
}
.wt-wp-candidate-loc {
  color: var(--zn-text-muted);
  font-size: 10px;
}

/* 推演冷却卡片 */
.wt-wp-cooldown-card {
  margin-bottom: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(var(--zn-accent-rgb), 0.04);
  border: 1px solid rgba(var(--zn-accent-rgb), 0.12);
}
.wt-wp-cd-head {
  margin-bottom: 8px;
}
.wt-wp-cd-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--zn-text-regular);
}
.wt-wp-cd-sub {
  display: block;
  font-size: 10px;
  color: var(--zn-text-muted);
  margin-top: 2px;
}
.wt-wp-cd-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wt-wp-cd-item-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.wt-wp-cd-item-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--zn-text-regular);
}
.wt-wp-cd-unit {
  font-size: 10px;
  color: var(--zn-text-muted);
}
.wt-wp-cd-item-desc {
  font-size: 10px;
  color: var(--zn-text-muted);
  line-height: 1.6;
  margin-bottom: 4px;
}
.wt-wp-cd-num {
  width: 42px;
  font-size: 11px;
  text-align: center;
  padding: 1px 2px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: var(--zn-text-regular);
}
.wt-wp-cd-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.wt-wp-cd-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 8px;
  background: rgba(var(--zn-warn-rgb), 0.1);
  border: 1px solid rgba(var(--zn-warn-rgb), 0.2);
}
.wt-wp-cd-chip-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--zn-text-regular);
}
.wt-wp-cd-chip-tail {
  font-size: 10px;
  color: rgba(var(--zn-warn-rgb), 0.9);
}

/* 折叠设置 */
.wt-wp-settings-fold {
  flex-shrink: 0;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.04);
  overflow: hidden;
}
.wt-wp-settings-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 11px;
  color: var(--zn-text-regular);
}
.wt-wp-settings-toggle:hover { background: rgba(255, 255, 255, 0.02); }
.wt-wp-settings-body {
  padding: 8px 10px 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.wt-wp-dashboard {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}
.wt-wp-stat {
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.14);
}
.wt-wp-stat.active {
  border-color: rgba(var(--zn-warn-rgb), 0.22);
  background: rgba(var(--zn-warn-rgb), 0.06);
}
.wt-wp-stat-label {
  display: block;
  font-size: 10px;
  color: var(--zn-text-muted);
  margin-bottom: 3px;
}
.wt-wp-stat-value {
  display: block;
  min-height: 16px;
  font-size: 11px;
  color: var(--zn-text-regular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wt-wp-candidate-box {
  padding: 8px 10px;
  border: 1px solid rgba(var(--zn-accent-rgb), 0.12);
  border-radius: 6px;
  background: rgba(var(--zn-accent-rgb), 0.035);
}
.wt-wp-section-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 11px;
  color: rgba(var(--zn-accent-rgb), 0.82);
}
.wt-wp-section-head span:last-child {
  color: var(--zn-text-muted);
  font-size: 10px;
  text-align: right;
}
.wt-wp-candidate-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.wt-wp-candidate {
  min-width: 0;
  padding: 6px 8px;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.04);
}
.wt-wp-candidate-main {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.wt-wp-candidate-name {
  min-width: 0;
  flex: 1;
  font-size: 11px;
  font-weight: 600;
  color: var(--zn-text-regular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wt-wp-mini-badge {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: 999px;
  font-size: 9px;
  color: rgba(var(--zn-accent-rgb), 0.76);
  background: rgba(var(--zn-accent-rgb), 0.08);
}
.wt-wp-mini-badge.manual {
  color: rgba(var(--zn-warn-rgb), 0.82);
  background: rgba(var(--zn-warn-rgb), 0.08);
}
.wt-wp-mini-badge.cooldown {
  color: rgba(var(--zn-info-rgb, 90, 160, 220), 0.85);
  background: rgba(var(--zn-info-rgb, 90, 160, 220), 0.1);
}
.wt-wp-candidate-sub {
  margin-top: 3px;
  font-size: 10px;
  line-height: 1.4;
  color: var(--zn-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wt-wp-candidate-empty {
  font-size: 11px;
  color: var(--zn-text-muted);
  line-height: 1.5;
}

.wt-wp-record-meta {
  padding: 7px 8px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.04);
}

.wt-edit-area { margin-top: 8px; }
.wt-textarea {
  width: 100%;
  background: var(--zn-surface-sunken);
  border: 1px solid var(--zn-border-light);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--zn-text-primary);
  resize: vertical;
  outline: none;
  margin-top: 4px;
}
.wt-textarea:focus { border-color: rgba(var(--zn-accent-rgb), 0.4); }

.wt-input-inline {
  flex: 1;
  padding: 3px 6px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid var(--zn-border-light);
  background: var(--zn-surface-sunken);
  color: #e0e0e0;
}
.wt-input-inline:focus { border-color: rgba(var(--zn-accent-rgb), 0.4); outline: none; }

.wt-edit-actions { display: flex; gap: 8px; margin-top: 6px; }
.wt-btn-save {
  padding: 3px 12px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid rgba(var(--zn-success-rgb), 0.3);
  background: rgba(var(--zn-success-rgb), 0.08);
  color: rgba(var(--zn-success-rgb), 0.9);
  cursor: pointer;
}
.wt-btn-retry {
  padding: 3px 12px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid rgba(var(--zn-warn-rgb), 0.3);
  background: rgba(var(--zn-warn-rgb), 0.08);
  color: rgba(var(--zn-warn-rgb), 0.9);
  cursor: pointer;
}
.wt-btn-primary {
  padding: 5px 14px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 4px;
  border: 1px solid rgba(var(--zn-accent-rgb), 0.3);
  background: rgba(var(--zn-accent-rgb), 0.12);
  color: rgba(var(--zn-accent-rgb), 0.9);
  cursor: pointer;
  transition: all 0.15s;
}
.wt-btn-primary:hover:not(:disabled) { background: rgba(var(--zn-accent-rgb), 0.22); }
.wt-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.wt-btn-danger {
  padding: 3px 12px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid rgba(var(--zn-danger-rgb), 0.3);
  background: rgba(var(--zn-danger-rgb), 0.08);
  color: rgba(var(--zn-danger-rgb), 0.8);
  cursor: pointer;
}
.wt-btn-xs {
  padding: 2px 6px;
  font-size: 10px;
  border-radius: 3px;
  border: 1px solid var(--zn-border-light);
  background: transparent;
  color: var(--zn-text-muted);
  cursor: pointer;
}
.wt-btn-xs:hover { color: var(--zn-text-regular); }
.wt-btn-xs-save {
  padding: 2px 6px;
  font-size: 10px;
  border-radius: 3px;
  border: 1px solid rgba(var(--zn-success-rgb), 0.2);
  background: rgba(var(--zn-success-rgb), 0.08);
  color: rgba(var(--zn-success-rgb), 0.8);
  cursor: pointer;
}
.wt-btn-xs-save:hover { background: rgba(var(--zn-success-rgb), 0.15); }
.wt-btn-xs-danger {
  padding: 2px 6px;
  font-size: 10px;
  border-radius: 3px;
  border: 1px solid rgba(var(--zn-danger-rgb), 0.2);
  background: transparent;
  color: rgba(var(--zn-danger-rgb), 0.7);
  cursor: pointer;
}

.wt-error {
  margin-top: 6px;
  padding: 4px 8px;
  font-size: 11px;
  color: rgba(var(--zn-danger-rgb), 0.8);
  background: rgba(var(--zn-danger-rgb), 0.06);
  border-radius: 4px;
  border: 1px solid rgba(var(--zn-danger-rgb), 0.15);
}

/* 剧情导演 */
.wt-badge {
  font-size: 10px;
  padding: 1px 8px;
  border-radius: 8px;
  background: var(--zn-bg-surface2);
  color: var(--zn-text-regular);
}
.wt-badge.active { color: rgba(var(--zn-success-rgb), 0.8); background: rgba(var(--zn-success-rgb), 0.08); }
.wt-badge.drafting { color: rgba(var(--zn-warn-rgb), 0.8); background: rgba(var(--zn-warn-rgb), 0.08); }
.wt-badge.completed { color: rgba(148, 163, 184, 0.6); }

.wt-plot-create { display: flex; flex-direction: column; gap: 10px; }
.wt-plot-type-row { display: flex; gap: 6px; }
.wt-plot-type-btn {
  padding: 4px 12px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid var(--zn-border-light);
  background: var(--zn-bg-surface1);
  color: var(--zn-text-regular);
  cursor: pointer;
}
.wt-plot-type-btn.active {
  border-color: rgba(var(--zn-accent-rgb), 0.4);
  background: rgba(var(--zn-accent-rgb), 0.12);
  color: rgba(var(--zn-accent-rgb), 0.9);
}
.wt-plot-complete-note { font-size: 10px; color: var(--zn-text-muted); }

.wt-plot-chat { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: 8px; }
.wt-plot-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background: var(--zn-surface-sunken);
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.04);
}
.wt-plot-msg { max-width: 85%; }
.wt-plot-msg.user { align-self: flex-end; }
.wt-plot-msg.assistant { align-self: flex-start; }
.wt-plot-msg-content {
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.wt-plot-msg.user .wt-plot-msg-content {
  background: rgba(var(--zn-accent-rgb), 0.15);
  color: var(--zn-text-primary);
}
.wt-plot-msg.assistant .wt-plot-msg-content {
  background: var(--zn-bg-surface2);
  color: var(--zn-text-regular);
}

.wt-plot-input-row { display: flex; gap: 6px; flex-shrink: 0; }
.wt-plot-input {
  flex: 1;
  height: 32px;
  padding: 0 10px;
  font-size: 12px;
  border: 1px solid var(--zn-border-light);
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.25);
  color: var(--zn-text-primary);
  outline: none;
}
.wt-plot-input:focus { border-color: rgba(var(--zn-accent-rgb), 0.4); }
.wt-plot-input::placeholder { color: var(--zn-text-muted); }

.wt-plot-actions { display: flex; gap: 8px; flex-shrink: 0; }

/* 世界书选择 */
.wt-plot-worldbook {
  flex-shrink: 0;
  border-bottom: 1px solid var(--zn-border-light);
  margin-bottom: 6px;
  padding-bottom: 6px;
}
.wt-plot-worldbook-toggle {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  font-size: 11px;
  color: var(--zn-text-muted);
  cursor: pointer;
  user-select: none;
}
.wt-plot-worldbook-toggle:hover { color: rgba(255, 255, 255, 0.65); }
.wt-plot-worldbook-arrow { font-size: 9px; }
.wt-plot-worldbook-list {
  padding: 0 10px 6px;
  max-height: 200px;
  overflow-y: auto;
}
.wt-wb-header {
  display: flex;
  gap: 4px;
  margin-bottom: 4px;
}
.wt-plot-worldbook-search {
  flex: 1;
  height: 26px;
  padding: 0 8px;
  font-size: 11px;
  border: 1px solid var(--zn-border-light);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.25);
  color: var(--zn-text-regular);
  outline: none;
  box-sizing: border-box;
}
.wt-plot-worldbook-search:focus { border-color: rgba(var(--zn-accent-rgb), 0.35); }
.wt-plot-worldbook-search::placeholder { color: var(--zn-text-muted); }
.wt-plot-worldbook-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: 11px;
  color: var(--zn-text-regular);
  cursor: pointer;
}
.wt-plot-worldbook-item input[type="checkbox"] { accent-color: rgba(var(--zn-accent-rgb), 0.8); }
.wt-wb-hint {
  flex: 1;
  font-size: 11px;
  color: var(--zn-text-muted);
}
.wt-wb-save-btn {
  flex-shrink: 0;
  height: 26px;
  padding: 0 10px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 4px;
  border: 1px solid rgba(var(--zn-success-rgb), 0.3);
  background: rgba(var(--zn-success-rgb), 0.08);
  color: rgba(var(--zn-success-rgb), 0.85);
  cursor: pointer;
  transition: all 0.15s;
}
.wt-wb-save-btn:hover { background: rgba(var(--zn-success-rgb), 0.18); }

.wt-wb-list-wrap { padding: 0 10px 6px; max-height: 240px; overflow-y: auto; }
.wt-wb-toolbar { position: sticky; top: 0; z-index: 5; display: flex; gap: 6px; padding: 6px 0; background: var(--zn-bg, #050810); border-bottom: 1px solid rgba(var(--zn-accent-rgb), 0.12); }
.wt-wb-toolbar .wt-plot-worldbook-search { flex: 1; }
.wt-wb-groups { padding-top: 4px; }
.wt-wb-group { margin-bottom: 4px; border-left: 2px solid rgba(var(--zn-accent-rgb), 0.18); }
.wt-wb-group-head { display: flex; align-items: center; gap: 6px; padding: 4px 6px; cursor: pointer; user-select: none; color: rgba(var(--zn-accent-rgb), 0.85); font-size: 11px; font-weight: 600; }
.wt-wb-group-head:hover { color: rgba(var(--zn-accent-rgb), 1); }
.wt-wb-group-head input[type="checkbox"] { accent-color: rgba(var(--zn-accent-rgb), 0.8); }
.wt-wb-group-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-wb-group-arrow { font-size: 9px; }
.wt-wb-group-body { padding: 2px 0 4px 10px; }
.wt-wb-group-body .wt-plot-worldbook-item { padding-left: 14px; }

/* 大总结注入控制 */
.wt-plot-summary-cfg {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 0;
  border-bottom: 1px solid var(--zn-border-light);
}
.wt-summary-cfg-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.wt-summary-cfg-label {
  font-size: 10px;
  color: var(--zn-text-muted);
  flex-shrink: 0;
  width: 52px;
}
.wt-summary-cfg-num {
  width: 44px;
  height: 22px;
  padding: 0 4px;
  font-size: 11px;
  border: 1px solid var(--zn-border-light);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.25);
  color: var(--zn-text-regular);
  outline: none;
  text-align: center;
}
.wt-summary-cfg-num:focus { border-color: rgba(var(--zn-accent-rgb), 0.35); }
.wt-summary-cfg-hint {
  font-size: 10px;
  color: var(--zn-text-muted);
}
.wt-summary-cfg-all {
  padding: 1px 6px;
  font-size: 10px;
  border-radius: 3px;
  border: 1px solid rgba(var(--zn-accent-rgb), 0.25);
  background: rgba(var(--zn-accent-rgb), 0.08);
  color: rgba(var(--zn-accent-rgb), 0.7);
  cursor: pointer;
}
.wt-summary-cfg-all:hover { background: rgba(var(--zn-accent-rgb), 0.15); }
.wt-summary-cfg-radio {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--zn-text-regular);
  cursor: pointer;
}
.wt-summary-cfg-radio input[type="radio"] { accent-color: rgba(var(--zn-accent-rgb), 0.8); }

/* 防剧透 */
.wt-spoiler-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: rgba(var(--zn-danger-rgb), 0.6);
  cursor: pointer;
  margin-left: auto;
}
.wt-spoiler-toggle input[type="checkbox"] { accent-color: rgba(var(--zn-danger-rgb), 0.8); }
.wt-spoiler-label { user-select: none; }
.wt-spoiler-inline {
  font-size: 10px;
  color: rgba(var(--zn-danger-rgb), 0.5);
  font-style: italic;
}
.wt-spoiler-notice {
  text-align: center;
  font-size: 11px;
  color: rgba(var(--zn-danger-rgb), 0.5);
  padding: 8px;
  margin: 4px 0;
  background: rgba(var(--zn-danger-rgb), 0.04);
  border: 1px dashed rgba(var(--zn-danger-rgb), 0.15);
  border-radius: 6px;
}

/* 活跃大纲 */
.wt-plot-active { display: flex; flex-direction: column; gap: 10px; }
.wt-plot-progress-bar {
  height: 4px;
  background: var(--zn-bg-surface2);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 4px;
}
.wt-plot-progress-fill {
  height: 100%;
  background: rgba(var(--zn-accent-rgb), 0.6);
  border-radius: 2px;
  transition: width 0.3s;
}
.wt-plot-ending { font-size: 11px; color: var(--zn-text-regular); }
.wt-plot-stages { display: flex; flex-direction: column; gap: 4px; }
.wt-plot-stage {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
}
.wt-plot-stage.current {
  border-color: rgba(var(--zn-accent-rgb), 0.25);
  background: rgba(var(--zn-accent-rgb), 0.06);
}
.wt-plot-stage.done { opacity: 0.5; }
.wt-plot-stage-idx {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(var(--zn-accent-rgb), 0.15);
  color: rgba(var(--zn-accent-rgb), 0.8);
  font-size: 10px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}
.wt-plot-stage.done .wt-plot-stage-idx { background: rgba(var(--zn-success-rgb), 0.15); color: rgba(var(--zn-success-rgb), 0.8); }
.wt-plot-stage-desc { font-size: 11px; color: var(--zn-text-regular); line-height: 1.4; flex: 1; }
.wt-plot-stage-chars { font-size: 10px; color: rgba(var(--zn-accent-rgb), 0.5); flex-shrink: 0; }

.wt-plot-check { margin-top: 6px; padding: 8px; background: var(--zn-surface-sunken); border-radius: 6px; }
.wt-plot-check-status {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 8px;
  font-size: 10px;
  margin-top: 4px;
}
.wt-plot-check-status.on_track { color: rgba(var(--zn-success-rgb), 0.8); background: rgba(var(--zn-success-rgb), 0.08); }
.wt-plot-check-status.ahead { color: rgba(var(--zn-accent-rgb), 0.8); background: rgba(var(--zn-accent-rgb), 0.08); }
.wt-plot-check-status.behind { color: rgba(var(--zn-warn-rgb), 0.8); background: rgba(var(--zn-warn-rgb), 0.08); }
.wt-plot-check-status.deviated { color: rgba(var(--zn-danger-rgb), 0.8); background: rgba(var(--zn-danger-rgb), 0.08); }
.wt-plot-check-guidance { font-size: 11px; color: var(--zn-text-regular); margin-top: 4px; line-height: 1.4; }

/* 世界推进角色卡 */
.wt-wp-chars { margin-top: 8px; }
.wt-wp-char-card {
  padding: 8px 9px;
  margin-top: 6px;
  background: rgba(var(--zn-accent-rgb), 0.04);
  border: 1px solid rgba(var(--zn-accent-rgb), 0.10);
  border-left: 2px solid rgba(var(--zn-accent-rgb), 0.28);
  border-radius: 0 6px 6px 0;
}
.wt-wp-char-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.wt-wp-char-name { font-size: 11px; font-weight: 600; color: rgba(var(--zn-accent-rgb), 0.85); }
.wt-wp-char-location {
  margin-left: 6px;
  font-size: 10px;
  color: var(--zn-text-muted);
}
.wt-wp-memory-state {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 9px;
  color: var(--zn-text-muted);
  background: rgba(255, 255, 255, 0.04);
}
.wt-wp-memory-state.active {
  color: rgba(var(--zn-success-rgb), 0.85);
  background: rgba(var(--zn-success-rgb), 0.08);
}
.wt-wp-memory-state.expired {
  color: rgba(var(--zn-accent-rgb), 0.7);
  background: rgba(var(--zn-accent-rgb), 0.08);
}
.wt-wp-memory-state.missing {
  color: rgba(var(--zn-warn-rgb), 0.75);
  background: rgba(var(--zn-warn-rgb), 0.07);
}
.wt-wp-memory-text {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.14);
  color: rgba(255, 255, 255, 0.72);
  font-size: 11px;
  line-height: 1.55;
}
.wt-wp-char-result {
  font-size: 10px;
  color: rgba(var(--zn-success-rgb), 0.72);
  margin-top: 4px;
  line-height: 1.45;
}
.wt-wp-char-info { font-size: 11px; color: rgba(255, 255, 255, 0.65); margin-top: 2px; }
.wt-wp-char-reason { font-size: 10px; color: var(--zn-text-muted); margin-top: 2px; }
.wt-wp-char-encounter { font-size: 10px; color: rgba(var(--zn-warn-rgb), 0.6); margin-top: 2px; }
.wt-wp-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 5px;
}
.wt-wp-facts span {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 9px;
  color: rgba(var(--zn-accent-rgb), 0.68);
  background: rgba(var(--zn-accent-rgb), 0.07);
}
.wt-wp-bg { margin-top: 6px; }
.wt-wp-bg-item { font-size: 11px; color: var(--zn-text-regular); padding-left: 8px; }
.wt-wp-hooks { margin-top: 8px; }
.wt-wp-hook-item {
  font-size: 11px;
  color: rgba(var(--zn-warn-rgb), 0.7);
  padding: 7px 9px;
  margin-top: 2px;
  background: rgba(var(--zn-warn-rgb), 0.04);
  border-radius: 6px;
  border-left: 2px solid rgba(var(--zn-warn-rgb), 0.25);
  line-height: 1.4;
}
.wt-wp-hook-title {
  font-weight: 600;
  color: rgba(var(--zn-warn-rgb), 0.86);
  margin-bottom: 3px;
}
.wt-wp-hook-avoid {
  margin-top: 4px;
  color: var(--zn-text-muted);
}

/* ─── 手动补总结行 ─── */
.wt-manual-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  margin-bottom: 4px;
  border-bottom: 1px dashed var(--zn-border-light);
  flex-wrap: wrap;
}
.wt-manual-label {
  font-size: 12px;
  color: var(--zn-text-regular);
  white-space: nowrap;
}
.wt-manual-input {
  width: 70px;
  flex: 0 0 auto;
}
.wt-manual-hint {
  font-size: 11px;
  color: var(--zn-text-muted);
  white-space: nowrap;
}

/* ─── 条目内联"重新总结"按钮 ─── */
.wt-btn-inline {
  flex: 0 0 auto;
  margin-left: auto;
  padding: 2px 8px;
  font-size: 11px;
}
.wt-btn-inline:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
