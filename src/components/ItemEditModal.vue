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
        <input v-model="editBelong" class="form-input" placeholder="角色名或地点名" />
      </div>
      <div class="form-row">
        <span class="form-label">状态</span>
        <input v-model="editState" class="form-input" placeholder="如 拿在手上 / 床头的木盒中" />
      </div>
      <label class="form-row form-check">
        <span class="form-label">消耗</span>
        <input v-model="editConsumed" type="checkbox" class="form-checkbox" />
        <span class="form-check-text">已消耗，不再作为当前可用物品注入</span>
      </label>
    </div>

    <template #footer>
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
}>();

const store = useMainStore();
const graph = computed<KnowledgeGraph>(() => store.chatData.knowledgeGraph || createEmptyKnowledgeGraph());

const editName = ref('');
const editAliases = ref('');
const editBrief = ref('');
const editQuantity = ref('');
const editBelong = ref('');
const editState = ref('');
const editConsumed = ref(false);

const title = computed(() => (props.mode === 'edit' ? '编辑物品' : '新增物品'));

watch(() => props.visible, (visible) => {
  if (visible) resetForm();
});

function resetForm() {
  if (props.mode === 'edit' && props.item) {
    editName.value = props.item.item.name;
    editAliases.value = (props.item.item.aliases || []).join('/');
    editBrief.value = props.item.item.brief || '';
    editQuantity.value = props.item.item.quantity || '';
    editBelong.value = props.item.belongTo || props.defaultOwner || '';
    editState.value = props.item.state || '';
    editConsumed.value = props.item.item.consumed === true;
  } else {
    editName.value = '';
    editAliases.value = '';
    editBrief.value = '';
    editQuantity.value = '';
    editBelong.value = props.defaultOwner || '';
    editState.value = '';
    editConsumed.value = false;
  }
}

function close() {
  emit('close');
}

function resolveBelongTo(belongName: string, next: KnowledgeGraph): string {
  const trimmed = belongName.trim();
  if (!trimmed) return '';
  for (const l of next.locations) {
    if (l.name === trimmed || (l.aliases || []).includes(trimmed)) return l.id;
  }
  return trimmed;
}

function upsertBelongEdge(next: KnowledgeGraph, itemId: string, belongTo: string, state: string): void {
  next.edges = next.edges.filter(e => !(e.type === 'belongs_to' && e.from === itemId));
  if (belongTo) {
    next.edges.push({ type: 'belongs_to', from: itemId, to: belongTo, detail: state || undefined });
  }
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

  if (props.mode === 'edit' && props.item) {
    const idx = next.items.findIndex(i => i.id === props.item!.item.id);
    const it = idx >= 0 ? next.items[idx] : undefined;
    if (it) {
      it.name = name;
      it.brief = editBrief.value.trim();
      it.quantity = editQuantity.value.trim() || undefined;
      it.aliases = aliases.length ? aliases : undefined;
      it.consumed = editConsumed.value ? true : undefined;
      const belongTo = resolveBelongTo(editBelong.value, next);
      upsertBelongEdge(next, it.id, belongTo, editState.value.trim());
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
      };
      next.items.push(newItem);
      const belongTo = resolveBelongTo(editBelong.value, next);
      upsertBelongEdge(next, id, belongTo, editState.value.trim());
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
</style>
