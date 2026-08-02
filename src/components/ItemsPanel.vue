<template>
  <div class="wt-panel">
    <div class="wt-panel-header">
      <span class="wt-panel-title">物品库</span>
      <span class="wt-count">{{ itemSearch.trim() ? `${filteredItems.length} / ${items.length}` : items.length }} 件</span>
      <button class="wt-btn-add" @click="startNew">＋ 新增</button>
    </div>

    <EmptyHint v-if="items.length === 0" text="暂无物品记录。小总结生成时顺带从正文自动提取有意义的重要物品。" />

    <div v-else class="wt-search-row">
      <input v-model="itemSearch" class="wt-search-input" placeholder="搜索物品、别名、描述、数量、归属、状态、已消耗" aria-label="搜索物品、别名、描述、数量、归属、状态、已消耗" />
      <button v-if="itemSearch" class="wt-search-clear" @click="itemSearch = ''">清空</button>
    </div>

    <EmptyHint v-if="items.length > 0 && filteredItems.length === 0" text="没有匹配物品。" />

    <div v-if="filteredItems.length > 0" class="wt-list">
      <div v-for="item in filteredItems" :key="item.id" class="wt-item">
        <!-- 查看模式 -->
        <div v-if="editingIdx !== item.sourceIndex" class="wt-item-view">
          <div class="wt-item-top">
            <span class="wt-item-name">{{ item.name }}</span>
            <span v-if="item.aliases?.length" class="wt-item-aliases">{{ item.aliases.join(' / ') }}</span>
            <div class="wt-item-actions">
              <button class="wt-btn-xs" @click="startEdit(item.sourceIndex)">编辑</button>
              <ConfirmButton @confirm="removeItem(item.sourceIndex)" />
            </div>
          </div>
          <div v-if="item.brief" class="wt-item-brief">{{ item.brief }}</div>
          <div class="wt-item-meta">
            <span class="wt-meta-label">归属</span>
            <span class="wt-meta-value wt-meta-belong">{{ item.owner || item.belongName || '未指定' }}</span>
            <template v-if="item.location && item.location !== (item.owner || item.belongName)">
              <span class="wt-meta-sep">·</span>
              <span class="wt-meta-label">当前位置</span>
              <span class="wt-meta-value">{{ item.location }}</span>
            </template>
            <span v-if="item.quantity" class="wt-meta-sep">·</span>
            <span v-if="item.quantity" class="wt-meta-label">数量</span>
            <span v-if="item.quantity" class="wt-meta-value">{{ item.quantity }}</span>
            <span v-if="item.status" class="wt-meta-sep">·</span>
            <span v-if="item.status" class="wt-meta-label">方式</span>
            <span v-if="item.status" class="wt-meta-value">{{ item.status }}</span>
            <span v-if="item.statusDetail || item.state" class="wt-meta-sep">·</span>
            <span v-if="item.statusDetail || item.state" class="wt-meta-label">细节</span>
            <span v-if="item.statusDetail || item.state" class="wt-meta-value">{{ item.statusDetail || item.state }}</span>
            <span v-if="item.consumed" class="wt-meta-sep">·</span>
            <span v-if="item.consumed" class="wt-meta-value wt-meta-consumed">已消耗</span>
          </div>
        </div>
        <!-- 编辑模式 -->
        <div v-else class="wt-item-edit">
          <div class="wt-edit-row">
            <span class="wt-edit-label">名称</span>
            <input v-model="editName" class="wt-edit-input" />
          </div>
          <div class="wt-edit-row">
            <span class="wt-edit-label">别名</span>
            <input v-model="editAliases" class="wt-edit-input" placeholder="斜杠分隔，如 别名1/别名2" aria-label="斜杠分隔，如 别名1/别名2" />
          </div>
          <div class="wt-edit-row">
            <span class="wt-edit-label">描述</span>
            <input v-model="editBrief" class="wt-edit-input" />
          </div>
          <div class="wt-edit-row">
            <span class="wt-edit-label">数量</span>
            <input v-model="editQuantity" class="wt-edit-input" placeholder="如 1把 / 3枚 / 半瓶 / 若干" aria-label="如 1把 / 3枚 / 半瓶 / 若干" />
          </div>
          <div class="wt-edit-row">
            <span class="wt-edit-label">归属</span>
            <input v-model="editOwner" class="wt-edit-input" placeholder="角色名或地点名（仅在易主时改）" aria-label="角色名或地点名（仅在易主时改）" list="kg-owner-list" />
          </div>
          <div class="wt-edit-row">
            <span class="wt-edit-label">当前位置</span>
            <input v-model="editLocation" class="wt-edit-input" placeholder="放下/拿起/转交即改" aria-label="放下/拿起/转交即改" list="kg-loc-list" />
          </div>
          <div class="wt-edit-row">
            <span class="wt-edit-label">持有方式</span>
            <select v-model="editStatus" class="wt-edit-input">
              <option value="">未指定</option>
              <option value="owned">专属持有（默认）</option>
              <option value="held">拿在手上</option>
              <option value="worn">穿/佩戴身上</option>
              <option value="carried">随行携带</option>
              <option value="placed">放在某地</option>
              <option value="stored">装入容器/收纳</option>
              <option value="lost">遗失/去向不明</option>
            </select>
          </div>
          <div class="wt-edit-row">
            <span class="wt-edit-label">位置细节</span>
            <input v-model="editStatusDetail" class="wt-edit-input" placeholder="如 草棚边的石凳上 / 床头的木盒中 / 损坏一角" aria-label="如 草棚边的石凳上 / 床头的木盒中 / 损坏一角" />
          </div>
          <label class="wt-edit-row wt-edit-check">
            <span class="wt-edit-label">消耗</span>
            <input v-model="editConsumed" type="checkbox" class="wt-edit-checkbox" />
            <span class="wt-check-text">已消耗，不再作为当前可用物品注入</span>
          </label>
          <div class="wt-edit-actions">
            <button class="wt-btn-xs-save" @click="saveEdit(item.sourceIndex)">保存</button>
            <button class="wt-btn-xs" @click="cancelEdit">取消</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 新增弹窗 -->
    <Modal :visible="showNewModal" title="新增物品" @close="cancelNew">
      <div class="wt-edit-col">
        <div class="wt-edit-row">
          <span class="wt-edit-label">名称</span>
          <input v-model="editName" class="wt-edit-input" />
        </div>
        <div class="wt-edit-row">
          <span class="wt-edit-label">别名</span>
          <input v-model="editAliases" class="wt-edit-input" placeholder="斜杠分隔，如 别名1/别名2" aria-label="斜杠分隔，如 别名1/别名2" />
        </div>
        <div class="wt-edit-row">
          <span class="wt-edit-label">描述</span>
          <input v-model="editBrief" class="wt-edit-input" />
        </div>
        <div class="wt-edit-row">
          <span class="wt-edit-label">数量</span>
          <input v-model="editQuantity" class="wt-edit-input" placeholder="如 1把 / 3枚 / 半瓶 / 若干" aria-label="如 1把 / 3枚 / 半瓶 / 若干" />
        </div>
        <div class="wt-edit-row">
          <span class="wt-edit-label">归属</span>
          <input v-model="editOwner" class="wt-edit-input" placeholder="角色名或地点名（仅在易主时改）" aria-label="角色名或地点名（仅在易主时改）" list="kg-owner-list" />
        </div>
        <div class="wt-edit-row">
          <span class="wt-edit-label">当前位置</span>
          <input v-model="editLocation" class="wt-edit-input" placeholder="放下/拿起/转交即改" aria-label="放下/拿起/转交即改" list="kg-loc-list" />
        </div>
        <div class="wt-edit-row">
          <span class="wt-edit-label">持有方式</span>
          <select v-model="editStatus" class="wt-edit-input">
            <option value="">未指定</option>
            <option value="owned">专属持有（默认）</option>
            <option value="held">拿在手上</option>
            <option value="worn">穿/佩戴身上</option>
            <option value="carried">随行携带</option>
            <option value="placed">放在某地</option>
            <option value="stored">装入容器/收纳</option>
            <option value="lost">遗失/去向不明</option>
          </select>
        </div>
        <div class="wt-edit-row">
          <span class="wt-edit-label">位置细节</span>
          <input v-model="editStatusDetail" class="wt-edit-input" placeholder="如 草棚边的石凳上 / 床头的木盒中 / 损坏一角" aria-label="如 草棚边的石凳上 / 床头的木盒中 / 损坏一角" />
        </div>
        <label class="wt-edit-row wt-edit-check">
          <span class="wt-edit-label">消耗</span>
          <input v-model="editConsumed" type="checkbox" class="wt-edit-checkbox" />
          <span class="wt-check-text">已消耗，不再作为当前可用物品注入</span>
        </label>
      </div>
      <template #footer>
        <button class="wt-btn-xs" @click="cancelNew">取消</button>
        <button class="wt-btn-xs-save" @click="saveNew">保存</button>
      </template>
    </Modal>
    <!-- 归属/位置 datalist（角色名+地点名+characterLocations 顶层键去重） -->
    <datalist id="kg-owner-list">
      <option v-for="n in ownerAndLocationCandidates" :key="n" :value="n" />
    </datalist>
    <datalist id="kg-loc-list">
      <option v-for="n in ownerAndLocationCandidates" :key="n" :value="n" />
    </datalist>
  </div>
</template>

<script setup lang="ts">
import { useMainStore } from '../stores/mainStore';
import { ConfirmButton, EmptyHint, Modal } from './ui';
import type { KnowledgeGraph, GraphItem } from '../core/knowledgeGraph';
import { buildStableId, createEmptyKnowledgeGraph } from '../core/knowledgeGraph';

const store = useMainStore();

// ═══════════════════════════════════════
// 物品库 — 读知识图谱 items（迁移后归属信息在 item.owner/location/status/statusDetail）
// 仍兼容旧 belongs_to 边
// ═══════════════════════════════════════

const graph = computed<KnowledgeGraph>(() => store.chatData.knowledgeGraph || createEmptyKnowledgeGraph());

/** 物品 + 归属/位置的合并视图 */
interface ItemView {
  sourceIndex: number;
  id: string;
  name: string;
  brief: string;
  quantity?: string;
  aliases?: string[];
  // 新字段
  owner?: string;          // 静态所有权（角色名/地点名）
  location?: string;       // 当前动态位置（角色名/地点名）
  status?: string;         // 持有/存放方式枚举
  statusDetail?: string;   // 位置/状态细节
  // 兼容旧字段
  belongTo?: string;       // 旧 belongs_to 边的 to
  belongName?: string;     // 归属显示名（地点名或角色名）
  state?: string;          // 旧 belongs_to 边的 detail
  consumed?: boolean;
}

const items = computed<ItemView[]>(() => {
  const g = graph.value;
  const locMap = new Map(g.locations.map(l => [l.id, l.name]));
  return g.items.map((it, sourceIndex) => {
    const edge = g.edges.find(e => e.type === 'belongs_to' && e.from === it.id);
    const belongTo = edge?.to;
    const belongName = belongTo ? (locMap.get(belongTo) || belongTo) : undefined;
    return {
      sourceIndex,
      id: it.id,
      name: it.name,
      brief: it.brief,
      quantity: it.quantity,
      aliases: it.aliases,
      owner: it.owner,
      location: it.location,
      status: it.status,
      statusDetail: it.statusDetail,
      belongTo,
      belongName,
      state: edge?.detail,
      consumed: it.consumed === true,
    };
  });
});

// 归属/位置 datalist 候选：角色名 + 角色别名 + 地点名 + 地点别名 + 玩家键
const ownerAndLocationCandidates = computed(() => {
  const g = graph.value;
  const names = new Set<string>();
  for (const ch of (g.characters || [])) {
    names.add(ch.name);
    for (const a of (ch.aliases || [])) names.add(a);
  }
  for (const l of (g.locations || [])) {
    names.add(l.name);
    for (const a of (l.aliases || [])) names.add(a);
  }
  for (const k of Object.keys(store.chatData?.characterLocations || {})) names.add(k);
  return Array.from(names).filter(n => n).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
});

const itemSearch = ref('');
const filteredItems = computed(() => {
  const q = normalizeSearch(itemSearch.value);
  if (!q) return items.value;
  return items.value.filter(item => normalizeSearch(itemSearchText(item)).includes(q));
});

// ── 编辑状态 ──
const editingIdx = ref(-1);
const showNewModal = ref(false);
const editName = ref('');
const editAliases = ref('');
const editBrief = ref('');
const editQuantity = ref('');
const editOwner = ref('');
const editLocation = ref('');
const editStatus = ref('');
const editStatusDetail = ref('');
const editConsumed = ref(false);

function startNew(): void {
  showNewModal.value = true;
  editingIdx.value = -1;
  editName.value = '';
  editAliases.value = '';
  editBrief.value = '';
  editQuantity.value = '';
  editOwner.value = '';
  editLocation.value = '';
  editStatus.value = '';
  editStatusDetail.value = '';
  editConsumed.value = false;
}

function cancelNew(): void {
  showNewModal.value = false;
}

function startEdit(idx: number): void {
  showNewModal.value = false;
  editingIdx.value = idx;
  const v = items.value[idx];
  editName.value = v.name;
  editAliases.value = (v.aliases || []).join('/');
  editBrief.value = v.brief || '';
  editQuantity.value = v.quantity || '';
  editOwner.value = v.owner || v.belongName || '';
  editLocation.value = v.location || v.belongName || '';
  editStatus.value = v.status || '';
  editStatusDetail.value = v.statusDetail || v.state || '';
  editConsumed.value = v.consumed === true;
}

function cancelEdit(): void {
  editingIdx.value = -1;
  showNewModal.value = false;
}

function commitGraph(next: KnowledgeGraph): void {
  store.setKnowledgeGraphWithoutHistory(next);
}

/** 把归属/位置输入字符串归一为正式名（地点命中→地点名；角色命中→角色名；都未命中→原文） */
function resolvePlaceOrCharName(belongName: string, next: KnowledgeGraph): string {
  const trimmed = belongName.trim();
  if (!trimmed) return '';
  for (const l of next.locations) {
    if (l.name === trimmed || (l.aliases || []).includes(trimmed)) return l.name;
  }
  for (const ch of next.characters || []) {
    if (ch.name === trimmed || (ch.aliases || []).includes(trimmed)) return ch.name;
  }
  return trimmed;
}

function saveEdit(existingIdx: number): void {
  const name = editName.value.trim();
  if (!name) { cancelEdit(); return; }
  const aliases = editAliases.value.split('/').map(s => s.trim()).filter(Boolean);
  const g = graph.value;
  const next: KnowledgeGraph = JSON.parse(JSON.stringify(g));

  const it = next.items[existingIdx];
  if (it) {
    it.name = name;
    it.brief = editBrief.value.trim();
    it.quantity = editQuantity.value.trim() || undefined;
    it.aliases = aliases.length ? aliases : undefined;
    it.consumed = editConsumed.value ? true : undefined;
    it.owner = resolvePlaceOrCharName(editOwner.value, next) || undefined;
    it.location = resolvePlaceOrCharName(editLocation.value, next) || undefined;
    it.status = (editStatus.value as GraphItem['status']) || undefined;
    it.statusDetail = editStatusDetail.value.trim() || undefined;
    it.existence = 'unique';
    // 清掉旧 belongs_to 边（迁移已迁移完，UI 编辑不再依赖边）
    next.edges = next.edges.filter(e => !(e.type === 'belongs_to' && e.from === it.id));
  }
  next.updatedAt = new Date().toISOString();
  commitGraph(next);
  cancelEdit();
}

function saveNew(): void {
  const name = editName.value.trim();
  if (!name) return;
  const aliases = editAliases.value.split('/').map(s => s.trim()).filter(Boolean);
  const g = graph.value;
  const next: KnowledgeGraph = JSON.parse(JSON.stringify(g));

  const id = buildStableId(name);
  if (!next.items.find(i => i.id === id)) {
    const newItem: GraphItem = {
      id, name,
      brief: editBrief.value.trim(),
      quantity: editQuantity.value.trim() || undefined,
      aliases: aliases.length ? aliases : undefined,
      consumed: editConsumed.value ? true : undefined,
      owner: resolvePlaceOrCharName(editOwner.value, next) || undefined,
      location: resolvePlaceOrCharName(editLocation.value, next) || undefined,
      status: (editStatus.value as GraphItem['status']) || undefined,
      statusDetail: editStatusDetail.value.trim() || undefined,
      existence: 'unique',
    };
    next.items.push(newItem);
  }
  next.updatedAt = new Date().toISOString();
  commitGraph(next);
  cancelNew();
}

function removeItem(idx: number): void {
  const g = graph.value;
  const next: KnowledgeGraph = JSON.parse(JSON.stringify(g));
  const id = next.items[idx]?.id;
  if (!id) return;
  next.items.splice(idx, 1);
  next.edges = next.edges.filter(e => !(e.type === 'belongs_to' && e.from === id));
  next.updatedAt = new Date().toISOString();
  commitGraph(next);
}

function normalizeSearch(text?: string): string {
  return String(text || '').trim().toLowerCase();
}

function itemSearchText(item: ItemView): string {
  return [
    item.name,
    item.brief,
    item.quantity,
    item.owner,
    item.location,
    item.status,
    item.statusDetail,
    item.belongName,
    item.state,
    item.consumed ? '已消耗' : '',
    ...(item.aliases || []),
  ].filter(Boolean).join(' ');
}
</script>

<style scoped>
.wt-panel { display: flex; flex-direction: column; gap: var(--zn-space-2); flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px; }
.wt-panel-header { display: flex; align-items: center; gap: var(--zn-space-2); }
.wt-panel-title { font-size: var(--zn-fs-title); font-weight: 600; color: var(--zn-text-primary); }
.wt-count { color: var(--zn-text-secondary); font-size: var(--zn-fs-label); }
.wt-btn-add { margin-left: auto; background: rgba(var(--zn-accent-rgb), 0.12); border: 1px solid var(--zn-accent); border-radius: var(--zn-radius-sm); color: var(--zn-accent); padding: 2px 10px; cursor: pointer; font-size: var(--zn-fs-label); }
.wt-btn-add:hover { background: rgba(var(--zn-accent-rgb), 0.2); }
.wt-search-row { display: flex; align-items: center; gap: 6px; }
.wt-search-input { flex: 1; min-width: 0; background: var(--zn-bg-surface2); border: 1px solid var(--zn-border-light); border-radius: var(--zn-radius-sm); padding: 5px 9px; color: var(--zn-text-primary); font-size: var(--zn-fs-label); }
.wt-search-input:focus { border-color: var(--zn-accent); outline: none; }
.wt-search-input::placeholder { color: var(--zn-text-muted); }
.wt-search-clear { background: var(--zn-bg-surface2); border: 1px solid var(--zn-border-light); border-radius: var(--zn-radius-sm); color: var(--zn-text-secondary); padding: 4px 9px; cursor: pointer; font-size: var(--zn-fs-label); }
.wt-search-clear:hover { color: var(--zn-accent); border-color: var(--zn-accent); }
.wt-list { display: flex; flex-direction: column; gap: 6px; }
.wt-item { background: var(--zn-bg-surface1); border: 1px solid var(--zn-border-light); border-radius: var(--zn-radius-sm); padding: 8px 10px; transition: border-color 0.2s; }
.wt-item:hover { border-color: var(--zn-border-base); }

.wt-item-view { display: flex; flex-direction: column; gap: 4px; }
.wt-item-top { display: flex; align-items: center; gap: 8px; }
.wt-item-name { font-weight: 600; color: var(--zn-text-primary); font-size: var(--zn-fs-body); }
.wt-item-aliases { font-size: var(--zn-fs-label); color: var(--zn-text-secondary); }
.wt-item-actions { margin-left: auto; display: flex; gap: 4px; }
.wt-item-brief { font-size: var(--zn-fs-label); color: var(--zn-text-regular); line-height: 1.5; }
.wt-item-meta { display: flex; align-items: center; gap: 4px; font-size: var(--zn-fs-label); flex-wrap: wrap; }
.wt-meta-label { color: var(--zn-text-muted); }
.wt-meta-value { color: var(--zn-text-regular); }
.wt-meta-belong { color: rgba(var(--zn-success-rgb), 0.8); font-weight: 500; }
.wt-meta-consumed { color: rgba(var(--zn-danger-rgb), 0.82); font-weight: 500; }
.wt-meta-sep { color: var(--zn-border-strong); }

.wt-item-edit { display: flex; flex-direction: column; gap: var(--zn-space-1); }
.wt-edit-col { display: flex; flex-direction: column; gap: var(--zn-space-2); }
.wt-edit-row { display: flex; align-items: center; gap: var(--zn-space-2); }
.wt-edit-label { width: 42px; flex-shrink: 0; color: var(--zn-text-muted); font-size: var(--zn-fs-label); }
.wt-edit-input { flex: 1; background: var(--zn-bg-surface2); border: 1px solid var(--zn-border-light); border-radius: var(--zn-radius-sm); padding: 4px 8px; color: var(--zn-text-primary); font-size: var(--zn-fs-label); }
.wt-edit-input:focus { border-color: var(--zn-accent); outline: none; }
.wt-edit-check { cursor: pointer; }
.wt-edit-checkbox { accent-color: var(--zn-accent); }
.wt-check-text { color: var(--zn-text-secondary); font-size: var(--zn-fs-label); }
.wt-edit-actions { display: flex; gap: var(--zn-space-2); margin-top: 4px; }
.wt-btn-xs { background: var(--zn-bg-surface2); border: 1px solid var(--zn-border-light); border-radius: var(--zn-radius-sm); color: var(--zn-text-regular); padding: 2px 10px; cursor: pointer; font-size: var(--zn-fs-label); }
.wt-btn-xs:hover { color: var(--zn-accent); border-color: var(--zn-accent); }
.wt-btn-xs-save { background: rgba(var(--zn-accent-rgb), 0.18); border: 1px solid var(--zn-accent); border-radius: var(--zn-radius-sm); color: var(--zn-accent); padding: 2px 10px; cursor: pointer; font-size: var(--zn-fs-label); }
.wt-btn-xs-save:hover { background: rgba(var(--zn-accent-rgb), 0.28); }
</style>
