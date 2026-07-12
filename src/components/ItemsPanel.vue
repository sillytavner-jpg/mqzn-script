<template>
  <div class="wt-panel">
    <div class="wt-panel-header">
      <span class="wt-panel-title">物品库</span>
      <span class="wt-count">{{ itemSearch.trim() ? `${filteredItems.length} / ${items.length}` : items.length }} 件</span>
      <button class="wt-btn-add" @click="startNew">＋ 新增</button>
    </div>

    <EmptyHint v-if="items.length === 0" text="暂无物品记录。小总结生成时顺带从正文自动提取有意义的重要物品。" />

    <div v-else class="wt-search-row">
      <input v-model="itemSearch" class="wt-search-input" placeholder="搜索物品、别名、描述、数量、归属、状态、已消耗" />
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
            <span class="wt-meta-value wt-meta-belong">{{ item.belongName || '未指定' }}</span>
            <span v-if="item.quantity" class="wt-meta-sep">·</span>
            <span v-if="item.quantity" class="wt-meta-label">数量</span>
            <span v-if="item.quantity" class="wt-meta-value">{{ item.quantity }}</span>
            <span v-if="item.state" class="wt-meta-sep">·</span>
            <span v-if="item.state" class="wt-meta-label">状态</span>
            <span v-if="item.state" class="wt-meta-value">{{ item.state }}</span>
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
            <input v-model="editAliases" class="wt-edit-input" placeholder="斜杠分隔，如 别名1/别名2" />
          </div>
          <div class="wt-edit-row">
            <span class="wt-edit-label">描述</span>
            <input v-model="editBrief" class="wt-edit-input" />
          </div>
          <div class="wt-edit-row">
            <span class="wt-edit-label">数量</span>
            <input v-model="editQuantity" class="wt-edit-input" placeholder="如 1把 / 3枚 / 半瓶 / 若干" />
          </div>
          <div class="wt-edit-row">
            <span class="wt-edit-label">归属</span>
            <input v-model="editBelong" class="wt-edit-input" placeholder="角色名或地点名" />
          </div>
          <div class="wt-edit-row">
            <span class="wt-edit-label">状态</span>
            <input v-model="editState" class="wt-edit-input" placeholder="如 拿在手上 / 床头的木盒中" />
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
          <input v-model="editAliases" class="wt-edit-input" placeholder="斜杠分隔，如 别名1/别名2" />
        </div>
        <div class="wt-edit-row">
          <span class="wt-edit-label">描述</span>
          <input v-model="editBrief" class="wt-edit-input" />
        </div>
        <div class="wt-edit-row">
          <span class="wt-edit-label">数量</span>
          <input v-model="editQuantity" class="wt-edit-input" placeholder="如 1把 / 3枚 / 半瓶 / 若干" />
        </div>
        <div class="wt-edit-row">
          <span class="wt-edit-label">归属</span>
          <input v-model="editBelong" class="wt-edit-input" placeholder="角色名或地点名" />
        </div>
        <div class="wt-edit-row">
          <span class="wt-edit-label">状态</span>
          <input v-model="editState" class="wt-edit-input" placeholder="如 拿在手上 / 床头的木盒中" />
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
  </div>
</template>

<script setup lang="ts">
import { useMainStore } from '../stores/mainStore';
import { ConfirmButton, EmptyHint, Modal } from './ui';
import type { KnowledgeGraph, GraphItem } from '../core/knowledgeGraph';
import { buildStableId, createEmptyKnowledgeGraph } from '../core/knowledgeGraph';

const store = useMainStore();

// ═══════════════════════════════════════
// 物品库 — 读知识图谱 items + belongs_to 边
// ═══════════════════════════════════════

const graph = computed<KnowledgeGraph>(() => store.chatData.knowledgeGraph || createEmptyKnowledgeGraph());

/** 物品 + 归属/状态的合并视图 */
interface ItemView {
  sourceIndex: number;
  id: string;
  name: string;
  brief: string;
  quantity?: string;
  aliases?: string[];
  belongTo?: string;   // belongs_to 边的 to（地点 id 或角色名）
  belongName?: string;  // 归属显示名（地点名或角色名）
  state?: string;       // belongs_to 边的 detail
  consumed?: boolean;   // 是否已消耗/毁坏/用尽
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
      belongTo,
      belongName,
      state: edge?.detail,
      consumed: it.consumed === true,
    };
  });
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
const editBelong = ref('');
const editState = ref('');
const editConsumed = ref(false);

function startNew(): void {
  showNewModal.value = true;
  editingIdx.value = -1;
  editName.value = '';
  editAliases.value = '';
  editBrief.value = '';
  editQuantity.value = '';
  editBelong.value = '';
  editState.value = '';
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
  editBelong.value = v.belongName || '';
  editState.value = v.state || '';
  editConsumed.value = v.consumed === true;
}

function cancelEdit(): void {
  editingIdx.value = -1;
  showNewModal.value = false;
}

function commitGraph(next: KnowledgeGraph): void {
  store.setKnowledgeGraphWithoutHistory(next);
}

/** 根据 belongTo 名称解析为地点 id 或保留角色名 */
function resolveBelongTo(belongName: string, next: KnowledgeGraph): string {
  const trimmed = belongName.trim();
  if (!trimmed) return '';
  // 先按地点名/别名匹配
  for (const l of next.locations) {
    if (l.name === trimmed || (l.aliases || []).includes(trimmed)) return l.id;
  }
  // 未命中地点 → 视为角色名，保留原文
  return trimmed;
}

function upsertBelongEdge(next: KnowledgeGraph, itemId: string, belongTo: string, state: string): void {
  // 先删旧边
  next.edges = next.edges.filter(e => !(e.type === 'belongs_to' && e.from === itemId));
  if (belongTo) {
    next.edges.push({ type: 'belongs_to', from: itemId, to: belongTo, detail: state || undefined });
  }
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
    const belongTo = resolveBelongTo(editBelong.value, next);
    upsertBelongEdge(next, it.id, belongTo, editState.value.trim());
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
    };
    next.items.push(newItem);
    const belongTo = resolveBelongTo(editBelong.value, next);
    upsertBelongEdge(next, id, belongTo, editState.value.trim());
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
