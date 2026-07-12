<template>
  <div class="wt-panel">
    <div class="wt-panel-header">
      <span class="wt-panel-title">地点库</span>
      <span class="wt-count">{{ locationSearch.trim() ? `${filteredLocations.length} / ${locations.length}` : locations.length }} 处</span>
      <button class="wt-btn-add" @click="startNew">＋ 新增</button>
    </div>

    <EmptyHint v-if="locations.length === 0" text="暂无地点。小总结生成时顺带从正文自动提取，或点新增手动添加。" />

    <div v-else class="wt-search-row">
      <input v-model="locationSearch" class="wt-search-input" placeholder="搜索地点、别名、描述、关系、物品、角色" />
      <button v-if="locationSearch" class="wt-search-clear" @click="locationSearch = ''">清空</button>
    </div>

    <EmptyHint v-if="locations.length > 0 && filteredLocations.length === 0" text="没有匹配地点。" />

    <div v-if="filteredLocations.length > 0" class="wt-list">
      <div v-for="{ loc, index } in filteredLocations" :key="loc.id" class="wt-loc-card">
        <!-- 查看模式 -->
        <div v-if="editingIdx !== index" class="wt-loc-view">
          <div class="wt-loc-top">
            <span class="wt-loc-name">{{ loc.name }}</span>
            <span v-if="loc.aliases?.length" class="wt-loc-aliases">{{ loc.aliases.join(' / ') }}</span>
            <div class="wt-loc-actions">
              <button class="wt-btn-xs" @click="startEdit(index)">编辑</button>
              <ConfirmButton @confirm="removeLoc(index)" />
            </div>
          </div>
          <div v-if="loc.brief" class="wt-loc-brief">{{ loc.brief }}</div>

          <!-- 关系区 -->
          <div v-if="relationsOf(loc.id).length > 0" class="wt-loc-section">
            <span class="wt-section-label">关系</span>
            <div class="wt-rel-list">
              <span v-for="r in relationsOf(loc.id)" :key="r.key" class="wt-rel-tag" :class="`wt-rel-${r.type}`">
                {{ r.label }}
              </span>
            </div>
          </div>

          <!-- 物品区 -->
          <div v-if="itemsHere(loc.id).length > 0" class="wt-loc-section">
            <span class="wt-section-label">物品</span>
            <div class="wt-item-chips">
              <span v-for="it in itemsHere(loc.id)" :key="it.id" class="wt-chip">
                {{ it.name }}<span v-if="it.state" class="wt-chip-state">·{{ it.state }}</span>
              </span>
            </div>
          </div>

          <!-- 角色区 -->
          <div v-if="charsHere(loc.id).length > 0" class="wt-loc-section">
            <span class="wt-section-label">角色</span>
            <div class="wt-char-chips">
              <span v-for="c in charsHere(loc.id)" :key="c" class="wt-chip wt-chip-char">{{ c }}</span>
            </div>
          </div>
        </div>

        <!-- 编辑模式 -->
        <div v-else class="wt-loc-edit">
          <div class="wt-edit-row">
            <span class="wt-edit-label">名称</span>
            <input v-model="editName" class="wt-edit-input" />
          </div>
          <div class="wt-edit-row">
            <span class="wt-edit-label">别名</span>
            <input v-model="editAliases" class="wt-edit-input" placeholder="斜杠分隔" />
          </div>
          <div class="wt-edit-row">
            <span class="wt-edit-label">描述</span>
            <input v-model="editBrief" class="wt-edit-input" />
          </div>

          <!-- 关系编辑 -->
          <div class="wt-rel-edit">
            <div class="wt-rel-edit-title">关系</div>
            <div v-for="(r, ri) in editRelations" :key="ri" class="wt-rel-edit-row">
              <select v-model="r.type" class="wt-rel-select">
                <option value="contains">包含</option>
                <option value="connected">连通</option>
              </select>
              <input v-model="r.target" class="wt-rel-input" :placeholder="r.type === 'contains' ? '子地点名' : '连通目标名'" />
              <input v-if="r.type === 'connected'" v-model="r.path" class="wt-rel-path" placeholder="路径（如 走过小路推开石门）" />
              <button class="wt-rel-del" @click="editRelations.splice(ri, 1)">✕</button>
            </div>
            <button class="wt-rel-add" @click="editRelations.push({ type: 'contains', target: '', path: '' })">＋ 添加关系</button>
          </div>

          <div class="wt-edit-actions">
            <button class="wt-btn-xs-save" @click="saveEdit(index)">保存</button>
            <button class="wt-btn-xs" @click="cancelEdit">取消</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 新增弹窗 -->
    <Modal :visible="showNewModal" title="新增地点" @close="cancelNew">
      <div class="wt-edit-col">
        <div class="wt-edit-row">
          <span class="wt-edit-label">名称</span>
          <input v-model="editName" class="wt-edit-input" />
        </div>
        <div class="wt-edit-row">
          <span class="wt-edit-label">别名</span>
          <input v-model="editAliases" class="wt-edit-input" placeholder="斜杠分隔" />
        </div>
        <div class="wt-edit-row">
          <span class="wt-edit-label">描述</span>
          <input v-model="editBrief" class="wt-edit-input" />
        </div>

        <!-- 关系编辑 -->
        <div class="wt-rel-edit">
          <div class="wt-rel-edit-title">关系</div>
          <div v-for="(r, ri) in editRelations" :key="ri" class="wt-rel-edit-row">
            <select v-model="r.type" class="wt-rel-select">
              <option value="contains">包含</option>
              <option value="connected">连通</option>
            </select>
            <input v-model="r.target" class="wt-rel-input" :placeholder="r.type === 'contains' ? '子地点名' : '连通目标名'" />
            <input v-if="r.type === 'connected'" v-model="r.path" class="wt-rel-path" placeholder="路径（如 走过小路推开石门）" />
            <button class="wt-rel-del" @click="editRelations.splice(ri, 1)">✕</button>
          </div>
          <button class="wt-rel-add" @click="editRelations.push({ type: 'contains', target: '', path: '' })">＋ 添加关系</button>
        </div>
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
import type { KnowledgeGraph, GraphLocation, GraphEdge } from '../core/knowledgeGraph';
import { buildStableId, createEmptyKnowledgeGraph } from '../core/knowledgeGraph';

const store = useMainStore();

const graph = computed<KnowledgeGraph>(() => store.chatData.knowledgeGraph || createEmptyKnowledgeGraph());
const locations = computed(() => graph.value.locations);
const locationSearch = ref('');
const filteredLocations = computed(() => {
  const q = normalizeSearch(locationSearch.value);
  const entries = locations.value.map((loc, index) => ({ loc, index }));
  if (!q) return entries;
  return entries.filter(({ loc }) => normalizeSearch(locationSearchText(loc)).includes(q));
});

// ── 编辑状态 ──
const editingIdx = ref(-1);
const showNewModal = ref(false);
const editName = ref('');
const editAliases = ref('');
const editBrief = ref('');
const editRelations = ref<Array<{ type: 'contains' | 'connected'; target: string; path: string }>>([]);

function startNew(): void {
  showNewModal.value = true;
  editingIdx.value = -1;
  editName.value = '';
  editAliases.value = '';
  editBrief.value = '';
  editRelations.value = [];
}

function cancelNew(): void {
  showNewModal.value = false;
}

function startEdit(idx: number): void {
  showNewModal.value = false;
  editingIdx.value = idx;
  const l = locations.value[idx];
  editName.value = l.name;
  editAliases.value = (l.aliases || []).join('/');
  editBrief.value = l.brief || '';
  // 加载现有关系
  editRelations.value = graph.value.edges
    .filter(e => (e.type === 'contains' || e.type === 'connected') && (e.from === l.id || e.to === l.id))
    .map(e => {
      if (e.from === l.id) {
        const target = graph.value.locations.find(x => x.id === e.to);
        return { type: e.type as 'contains' | 'connected', target: target?.name || e.to, path: e.detail || '' };
      } else {
        const source = graph.value.locations.find(x => x.id === e.from);
        // to 方向的关系反转展示（连通反向也需保留路径）
        return { type: e.type as 'contains' | 'connected', target: source?.name || e.from, path: e.detail || '' };
      }
    });
}

function cancelEdit(): void {
  editingIdx.value = -1;
  showNewModal.value = false;
}

function commitGraph(next: KnowledgeGraph): void {
  store.setKnowledgeGraphWithoutHistory(next);
}

function resolveLocId(name: string, next: KnowledgeGraph): string {
  const trimmed = name.trim();
  for (const l of next.locations) {
    if (l.name === trimmed || (l.aliases || []).includes(trimmed)) return l.id;
  }
  return buildStableId(trimmed);
}

function saveEdit(existingIdx: number): void {
  const name = editName.value.trim();
  if (!name) { cancelEdit(); return; }
  const aliases = editAliases.value.split('/').map(s => s.trim()).filter(Boolean);
  const g = graph.value;
  const next: KnowledgeGraph = JSON.parse(JSON.stringify(g));

  const l = next.locations[existingIdx];
  if (!l) { cancelEdit(); return; }
  const locId = l.id;
  l.name = name;
  l.brief = editBrief.value.trim();
  l.aliases = aliases.length ? aliases : undefined;

  rebuildEdges(next, locId);
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

  const locId = buildStableId(name);
  if (!next.locations.find(l => l.id === locId)) {
    next.locations.push({
      id: locId, name,
      brief: editBrief.value.trim(),
      aliases: aliases.length ? aliases : undefined,
    });
  }

  rebuildEdges(next, locId);
  next.updatedAt = new Date().toISOString();
  commitGraph(next);
  cancelNew();
}

/** 重建某地点的 contains/connected 边 */
function rebuildEdges(next: KnowledgeGraph, locId: string): void {
  next.edges = next.edges.filter(e =>
    !((e.type === 'contains' || e.type === 'connected') && (e.from === locId || e.to === locId)),
  );
  for (const r of editRelations.value) {
    const target = r.target.trim();
    if (!target) continue;
    const toId = resolveLocId(target, next);
    if (toId === locId) continue;
    const type = r.type;
    const dup = next.edges.find(x => x.type === type && x.from === locId && x.to === toId);
    if (dup) {
      if (r.path) dup.detail = r.path;
    } else {
      next.edges.push({ type, from: locId, to: toId, detail: r.path || undefined });
    }
  }
}

function removeLoc(idx: number): void {
  const g = graph.value;
  const next: KnowledgeGraph = JSON.parse(JSON.stringify(g));
  const id = next.locations[idx]?.id;
  if (!id) return;
  next.locations.splice(idx, 1);
  next.edges = next.edges.filter(e => e.from !== id && e.to !== id);
  // 清理角色位置映射里指向该地点的项
  const map = { ...store.chatData.characterLocations };
  for (const k of Object.keys(map)) if (map[k] === id) delete map[k];
  store.chatData.characterLocations = map;
  next.updatedAt = new Date().toISOString();
  commitGraph(next);
}

// ── 查看模式计算函数 ──

function normalizeSearch(text?: string): string {
  return String(text || '').trim().toLowerCase();
}

function locationSearchText(loc: GraphLocation): string {
  const relationText = relationsOf(loc.id).map(r => r.label).join(' ');
  const itemText = itemsHere(loc.id).map(it => `${it.name} ${it.state || ''}`).join(' ');
  const charText = charsHere(loc.id).join(' ');
  return [
    loc.name,
    loc.brief,
    ...(loc.aliases || []),
    relationText,
    itemText,
    charText,
  ].filter(Boolean).join(' ');
}

interface RelationView { key: string; type: string; label: string; }

function relationsOf(locId: string): RelationView[] {
  const g = graph.value;
  const res: RelationView[] = [];
  for (const e of g.edges) {
    if (e.type === 'contains' && e.from === locId) {
      const child = g.locations.find(l => l.id === e.to);
      if (child) res.push({ key: `c-${e.to}`, type: 'contains', label: `包含 → ${child.name}` });
    } else if (e.type === 'connected' && e.from === locId) {
      const target = g.locations.find(l => l.id === e.to);
      if (target) res.push({ key: `co-${e.to}`, type: 'connected', label: `连通 → ${target.name}${e.detail ? `（${e.detail}）` : ''}` });
    } else if (e.type === 'connected' && e.to === locId) {
      const source = g.locations.find(l => l.id === e.from);
      if (source) res.push({ key: `co-r-${e.from}`, type: 'connected', label: `← 连通 ${source.name}${e.detail ? `（${e.detail}）` : ''}` });
    } else if (e.type === 'contains' && e.to === locId) {
      const parent = g.locations.find(l => l.id === e.from);
      if (parent) res.push({ key: `c-r-${e.from}`, type: 'contains', label: `← 属于 ${parent.name}` });
    }
  }
  return res;
}

interface ItemHere { id: string; name: string; state?: string; }

function itemsHere(locId: string): ItemHere[] {
  const g = graph.value;
  return g.edges
    .filter(e => e.type === 'belongs_to' && e.to === locId)
    .map(e => {
      const item = g.items.find(i => i.id === e.from);
      return item ? { id: item.id, name: item.name, state: e.detail } : null;
    })
    .filter((x): x is ItemHere => !!x);
}

function charsHere(locId: string): string[] {
  const map = store.chatData.characterLocations || {};
  return Object.entries(map).filter(([, v]) => v === locId).map(([k]) => k);
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
.wt-list { display: flex; flex-direction: column; gap: 8px; }

.wt-loc-card { background: var(--zn-bg-surface1); border: 1px solid var(--zn-border-light); border-radius: var(--zn-radius); padding: 10px 12px; transition: border-color 0.2s; }
.wt-loc-card:hover { border-color: var(--zn-border-base); }

.wt-loc-view { display: flex; flex-direction: column; gap: 6px; }
.wt-loc-top { display: flex; align-items: center; gap: 8px; }
.wt-loc-name { font-weight: 600; color: var(--zn-text-primary); font-size: var(--zn-fs-body); }
.wt-loc-aliases { font-size: var(--zn-fs-label); color: var(--zn-text-secondary); }
.wt-loc-actions { margin-left: auto; display: flex; gap: 4px; }
.wt-loc-brief { font-size: var(--zn-fs-label); color: var(--zn-text-regular); line-height: 1.5; }

.wt-loc-section { display: flex; flex-direction: column; gap: 3px; }
.wt-section-label { font-size: 10px; color: var(--zn-text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
.wt-rel-list { display: flex; flex-wrap: wrap; gap: 4px; }
.wt-rel-tag { font-size: var(--zn-fs-label); padding: 1px 8px; border-radius: 10px; }
.wt-rel-contains { background: rgba(var(--zn-accent-rgb), 0.12); color: var(--zn-accent); }
.wt-rel-connected { background: rgba(var(--zn-success-rgb), 0.12); color: rgba(var(--zn-success-rgb), 0.8); }

.wt-item-chips, .wt-char-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.wt-chip { font-size: var(--zn-fs-label); padding: 1px 8px; border-radius: var(--zn-radius-sm); background: var(--zn-bg-surface2); color: var(--zn-text-regular); }
.wt-chip-state { color: var(--zn-text-muted); }
.wt-chip-char { background: rgba(var(--zn-warn-rgb), 0.12); color: rgba(var(--zn-warn-rgb), 0.8); }

/* 编辑模式 */
.wt-loc-edit { display: flex; flex-direction: column; gap: var(--zn-space-1); }
.wt-edit-col { display: flex; flex-direction: column; gap: var(--zn-space-2); }
.wt-edit-row { display: flex; align-items: center; gap: var(--zn-space-2); }
.wt-edit-label { width: 42px; flex-shrink: 0; color: var(--zn-text-muted); font-size: var(--zn-fs-label); }
.wt-edit-input { flex: 1; background: var(--zn-bg-surface2); border: 1px solid var(--zn-border-light); border-radius: var(--zn-radius-sm); padding: 4px 8px; color: var(--zn-text-primary); font-size: var(--zn-fs-label); }
.wt-edit-input:focus { border-color: var(--zn-accent); outline: none; }

.wt-rel-edit { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
.wt-rel-edit-title { font-size: var(--zn-fs-label); color: var(--zn-text-muted); }
.wt-rel-edit-row { display: flex; align-items: center; gap: 4px; }
.wt-rel-select { background: var(--zn-bg-surface2); border: 1px solid var(--zn-border-light); border-radius: var(--zn-radius-sm); padding: 3px 6px; color: var(--zn-text-primary); font-size: var(--zn-fs-label); }
.wt-rel-input { flex: 1; min-width: 80px; background: var(--zn-bg-surface2); border: 1px solid var(--zn-border-light); border-radius: var(--zn-radius-sm); padding: 3px 6px; color: var(--zn-text-primary); font-size: var(--zn-fs-label); }
.wt-rel-path { flex: 1.5; min-width: 100px; background: var(--zn-bg-surface2); border: 1px solid var(--zn-border-light); border-radius: var(--zn-radius-sm); padding: 3px 6px; color: var(--zn-text-primary); font-size: var(--zn-fs-label); }
.wt-rel-del { background: transparent; border: none; color: var(--zn-danger); cursor: pointer; font-size: var(--zn-fs-label); padding: 2px 4px; }
.wt-rel-add { align-self: flex-start; background: var(--zn-bg-surface2); border: 1px dashed var(--zn-border-light); border-radius: var(--zn-radius-sm); color: var(--zn-text-secondary); padding: 2px 10px; cursor: pointer; font-size: var(--zn-fs-label); }
.wt-rel-add:hover { color: var(--zn-accent); border-color: var(--zn-accent); }

.wt-edit-actions { display: flex; gap: var(--zn-space-2); margin-top: 6px; }
.wt-btn-xs { background: var(--zn-bg-surface2); border: 1px solid var(--zn-border-light); border-radius: var(--zn-radius-sm); color: var(--zn-text-regular); padding: 2px 10px; cursor: pointer; font-size: var(--zn-fs-label); }
.wt-btn-xs:hover { color: var(--zn-accent); border-color: var(--zn-accent); }
.wt-btn-xs-save { background: rgba(var(--zn-accent-rgb), 0.18); border: 1px solid var(--zn-accent); border-radius: var(--zn-radius-sm); color: var(--zn-accent); padding: 2px 10px; cursor: pointer; font-size: var(--zn-fs-label); }
.wt-btn-xs-save:hover { background: rgba(var(--zn-accent-rgb), 0.28); }
</style>
