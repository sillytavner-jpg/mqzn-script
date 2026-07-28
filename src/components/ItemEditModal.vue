<template>
  <Modal :visible="visible" :title="title" :is-mobile="isMobile" @close="close">
    <div class="item-form">
      <div class="form-row">
        <span class="form-label">名称</span>
        <input v-model="editName" class="form-input" placeholder="物品名称" />
      </div>
      <div class="form-row">
        <span class="form-label">别名</span>
        <input v-model="editAliases" class="form-input" placeholder="斜杠分隔，如 别名1/别名2" />
      </div>
      <div class="form-row">
        <span class="form-label">描述</span>
        <input v-model="editBrief" class="form-input" placeholder="基本描述" />
      </div>
      <div class="form-row">
        <span class="form-label">数量</span>
        <input v-model="editQuantity" class="form-input" placeholder="如 1把 / 3枚 / 半瓶" />
      </div>
      <div class="form-row">
        <span class="form-label">归属</span>
        <input v-model="editOwner" class="form-input" placeholder="角色名或地点名（仅在易主时改）" list="kg-owner-list" />
      </div>
      <div class="form-row">
        <span class="form-label">当前位置</span>
        <input v-model="editLocation" class="form-input" placeholder="角色名或地点名（放下/拿起/转交即改）" list="kg-loc-list" />
      </div>
      <div class="form-row">
        <span class="form-label">持有方式</span>
        <select v-model="editStatus" class="form-input">
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
      <div class="form-row">
        <span class="form-label">位置细节</span>
        <input v-model="editStatusDetail" class="form-input" placeholder="如 草棚边的石凳上 / 床头的木盒中 / 损坏一角" />
      </div>
      <label class="form-row form-check">
        <span class="form-label">消耗</span>
        <input v-model="editConsumed" type="checkbox" class="form-checkbox" />
        <span class="form-check-text">已消耗，不再作为当前可用物品注入</span>
      </label>
    </div>
    <!-- 给归属/位置输入框做自动补全的 datalist，可选不强制 -->
    <datalist id="kg-owner-list">
      <option v-for="n in ownerAndLocationCandidates" :key="n" :value="n" />
    </datalist>
    <datalist id="kg-loc-list">
      <option v-for="n in ownerAndLocationCandidates" :key="n" :value="n" />
    </datalist>

    <template #footer>
      <button
        v-if="mode === 'edit' && item"
        class="form-btn form-btn-delete"
        :class="{ 'form-btn-delete-confirm': confirmDelete }"
        @click="onDeleteClick"
        @mouseleave="confirmDelete = false"
      >{{ confirmDelete ? '确认删除？' : '删除' }}</button>
      <button class="form-btn" @click="close">取消</button>
      <button class="form-btn form-btn-primary" @click="save">保存</button>
    </template>
  </Modal>
</template>

<script setup lang="ts">
import { useMainStore } from '../stores/mainStore';
import { Modal } from './ui';
import type { KnowledgeGraph, GraphItem, OwnedItem } from '../core/knowledgeGraph';
import { buildStableId, createEmptyKnowledgeGraph } from '../core/knowledgeGraph';

const props = defineProps<{
  visible: boolean;
  mode: 'edit' | 'add';
  item?: OwnedItem;
  defaultOwner?: string;
  isMobile?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'delete', item: OwnedItem): void;
}>();

const store = useMainStore();
const graph = computed<KnowledgeGraph>(() => store.chatData.knowledgeGraph || createEmptyKnowledgeGraph());

const editName = ref('');
const editAliases = ref('');
const editBrief = ref('');
const editQuantity = ref('');
const editOwner = ref('');
const editLocation = ref('');
const editStatus = ref('');
const editStatusDetail = ref('');
const editConsumed = ref(false);
const confirmDelete = ref(false);

const title = computed(() => (props.mode === 'edit' ? '编辑物品' : '新增物品'));

// 归属/当前位置 datalist 候选：角色名 + 地点名 + 玩家名（去重，按字母序）
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
  // 玩家角色通常会登记在 characterLocations 顶层，但 graph.characters 不一定有
  for (const k of Object.keys(store.chatData?.characterLocations || {})) names.add(k);
  return Array.from(names).filter(n => n).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
});

watch(() => props.visible, (visible) => {
  if (visible) resetForm();
});

function resetForm() {
  confirmDelete.value = false;
  if (props.mode === 'edit' && props.item) {
    const it = props.item.item;
    editName.value = it.name;
    editAliases.value = (it.aliases || []).join('/');
    editBrief.value = it.brief || '';
    editQuantity.value = it.quantity || '';
    editOwner.value = it.owner || props.item.owner || props.item.belongTo || props.defaultOwner || '';
    editLocation.value = it.location || props.item.location || props.item.belongTo || '';
    editStatus.value = it.status || '';
    editStatusDetail.value = it.statusDetail || props.item.statusDetail || props.item.state || '';
    editConsumed.value = it.consumed === true;
  } else {
    editName.value = '';
    editAliases.value = '';
    editBrief.value = '';
    editQuantity.value = '';
    editOwner.value = props.defaultOwner || '';
    editLocation.value = props.defaultOwner || '';
    editStatus.value = '';
    editStatusDetail.value = '';
    editConsumed.value = false;
  }
}

function close() {
  confirmDelete.value = false;
  emit('close');
}

// 删除按钮：第一次点 → 切到"确认删除？"红色态；第二次点 → 真删除并 emit('delete')
function onDeleteClick() {
  if (!confirmDelete.value) {
    confirmDelete.value = true;
    return;
  }
  if (props.mode === 'edit' && props.item) {
    emit('delete', props.item);
  }
  confirmDelete.value = false;
  close();
}

// 把归属/位置输入字符串规整为正式名（地点命中名/别名 → 该地点正式名），其他原样保留
function resolvePlaceOrCharName(belongName: string, next: KnowledgeGraph): string {
  const trimmed = belongName.trim();
  if (!trimmed) return '';
  // 地点名/别名 → 地点正式名
  for (const l of next.locations) {
    if (l.name === trimmed || (l.aliases || []).includes(trimmed)) return l.name;
  }
  // 角色名/别名 → 角色正式名
  for (const ch of next.characters || []) {
    if (ch.name === trimmed || (ch.aliases || []).includes(trimmed)) return ch.name;
  }
  return trimmed;
}

function save() {
  const name = editName.value.trim();
  if (!name) {
    close();
    return;
  }
  const aliases = editAliases.value.split('/').map(s => s.trim()).filter(Boolean);
  const g = graph.value;
  const next: KnowledgeGraph = JSON.parse(JSON.stringify(g));

  const ownerRaw = resolvePlaceOrCharName(editOwner.value, next);
  const locationRaw = resolvePlaceOrCharName(editLocation.value, next);
  // 兼容旧 belongs_to 边：保存时也清理掉旧边（不再产生新边）
  const cleanLegacyBelongEdges = (itemId: string) => {
    next.edges = next.edges.filter(e => !(e.type === 'belongs_to' && e.from === itemId));
  };

  if (props.mode === 'edit' && props.item) {
    const idx = next.items.findIndex(i => i.id === props.item!.item.id);
    const it = idx >= 0 ? next.items[idx] : undefined;
    if (it) {
      it.name = name;
      it.brief = editBrief.value.trim();
      it.quantity = editQuantity.value.trim() || undefined;
      it.aliases = aliases.length ? aliases : undefined;
      it.consumed = editConsumed.value ? true : undefined;
      it.owner = ownerRaw || undefined;
      it.location = locationRaw || undefined;
      it.status = (editStatus.value as GraphItem['status']) || undefined;
      it.statusDetail = editStatusDetail.value.trim() || undefined;
      it.existence = 'unique';
      cleanLegacyBelongEdges(it.id);
    }
  } else {
    const id = buildStableId(name);
    if (!next.items.find(i => i.id === id)) {
      const newItem: GraphItem = {
        id, name,
        brief: editBrief.value.trim(),
        quantity: editQuantity.value.trim() || undefined,
        aliases: aliases.length ? aliases : undefined,
        consumed: editConsumed.value ? true : undefined,
        owner: ownerRaw || undefined,
        location: locationRaw || undefined,
        status: (editStatus.value as GraphItem['status']) || undefined,
        statusDetail: editStatusDetail.value.trim() || undefined,
        existence: 'unique',
      };
      next.items.push(newItem);
    }
  }

  next.updatedAt = new Date().toISOString();
  store.setKnowledgeGraphWithoutHistory(next);
  close();
}
</script>

<style scoped>
.item-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.form-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.form-label {
  width: 42px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--zn-text-muted);
}
.form-input {
  flex: 1;
  min-width: 0;
  background: var(--zn-bg-surface2);
  border: 1px solid var(--zn-border-light);
  border-radius: var(--zn-radius-sm);
  padding: 5px 9px;
  color: var(--zn-text-primary);
  font-size: 12px;
}
.form-input:focus {
  border-color: var(--zn-accent);
  outline: none;
}
.form-check {
  cursor: pointer;
}
.form-checkbox {
  accent-color: var(--zn-accent);
}
.form-check-text {
  font-size: 11px;
  color: var(--zn-text-secondary);
}

.form-btn {
  background: var(--zn-bg-surface2);
  border: 1px solid var(--zn-border-light);
  border-radius: var(--zn-radius-sm);
  color: var(--zn-text-regular);
  padding: 4px 12px;
  cursor: pointer;
  font-size: 12px;
}
.form-btn:hover {
  color: var(--zn-accent);
  border-color: var(--zn-accent);
}
.form-btn-primary {
  background: rgba(var(--zn-accent-rgb), 0.15);
  border-color: var(--zn-accent);
  color: var(--zn-accent);
}
.form-btn-primary:hover {
  background: rgba(var(--zn-accent-rgb), 0.25);
}
.form-btn-delete {
  margin-right: auto;
  color: var(--zn-text-muted);
}
.form-btn-delete:hover {
  color: #e05a5a;
  border-color: #e05a5a;
}
.form-btn-delete-confirm {
  color: #fff !important;
  background: #e05a5a;
  border-color: #e05a5a;
}
.form-btn-delete-confirm:hover {
  background: #c94444;
  border-color: #c94444;
}
</style>
