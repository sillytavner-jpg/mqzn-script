<template>
  <div class="inv-panel">
    <div class="inv-header">
      <span class="inv-title">背包</span>
      <span class="inv-count">{{ items.length }} 件</span>
    </div>
    <div class="inv-grid">
      <button
        type="button"
        v-for="it in pagedItems"
        :key="it.item.id"
        class="inv-slot inv-item"
        :class="{ consumed: it.item.consumed }"
        :aria-label="`编辑物品：${it.item.name}`"
        @click.stop.prevent="emit('edit', it)"
      >
        <span class="inv-name">{{ it.item.name }}</span>
        <span v-if="it.item.quantity" class="inv-qty">{{ formatQuantity(it.item.quantity) }}</span>
      </button>

      <button
        type="button"
        v-for="n in emptyCount"
        :key="'empty-' + n"
        class="inv-slot inv-empty"
        :aria-label="`空槽位 ${n}`"
        @click.stop.prevent="emit('add')"
      />

      <button type="button" class="inv-slot inv-add" title="新增物品" :aria-label="'新增物品'" @click.stop.prevent="emit('add')">＋</button>
    </div>

    <div v-if="pageCount > 1" class="inv-pagination">
      <button class="inv-page-btn" :disabled="currentPage <= 1" @click="currentPage--">上一页</button>
      <span class="inv-page-info">{{ currentPage }} / {{ pageCount }}</span>
      <button class="inv-page-btn" :disabled="currentPage >= pageCount" @click="currentPage++">下一页</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { OwnedItem } from '../core/knowledgeGraph';

const props = withDefaults(defineProps<{
  items: OwnedItem[];
  pageSize?: number;
}>(), {
  pageSize: 24,
});

const emit = defineEmits<{
  (e: 'edit', item: OwnedItem): void;
  (e: 'add'): void;
}>();

const currentPage = ref(1);

const pageCount = computed(() => Math.max(1, Math.ceil(props.items.length / props.pageSize)));
const pagedItems = computed(() => props.items.slice((currentPage.value - 1) * props.pageSize, currentPage.value * props.pageSize));
const emptyCount = computed(() => Math.max(0, props.pageSize - pagedItems.value.length));

watch(() => props.items.length, () => {
  if (currentPage.value > pageCount.value) currentPage.value = pageCount.value;
});

function formatQuantity(q: string): string {
  const s = String(q).trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) return `×${s}`;
  return s;
}

function tooltip(it: OwnedItem): string {
  const lines = [it.item.name];
  if (it.item.quantity) lines.push(`数量：${it.item.quantity}`);
  if (it.item.owner) lines.push(`归属：${it.item.owner}`);
  if (it.item.location && it.item.location !== it.item.owner) lines.push(`当前位置：${it.item.location}`);
  if (it.item.status) lines.push(`方式：${it.item.status}`);
  if (it.item.statusDetail) lines.push(`细节：${it.item.statusDetail}`);
  else if (it.state) lines.push(`细节：${it.state}`);
  if (it.item.brief) lines.push(it.item.brief);
  if (it.item.consumed) lines.push('【已消耗】');
  return lines.join('\n');
}
</script>

<style scoped>
.inv-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.inv-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.inv-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--zn-text-regular);
}
.inv-count {
  font-size: 11px;
  color: var(--zn-text-muted);
}

.inv-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.inv-slot {
  width: 64px;
  height: 64px;
  border-radius: 8px;
  border: 1px solid var(--zn-border-light);
  background: var(--zn-bg-surface1);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
  user-select: none;
  -webkit-user-select: none;
  touch-action: manipulation;
  /* button 复位（点击 div → button 无障碍） */
  font: inherit;
  color: inherit;
  text-align: center;
  padding: 0;
  appearance: none;
  -webkit-appearance: none;
}
@media (hover: hover) {
  .inv-slot:hover {
    border-color: var(--zn-accent);
    background: rgba(var(--zn-accent-rgb), 0.06);
  }
  .inv-slot:active {
    transform: scale(0.97);
  }
}
@media (hover: none) {
  .inv-slot:active {
    background: rgba(var(--zn-accent-rgb), 0.1);
  }
}

.inv-item {
  flex-direction: column;
  padding: 4px;
  overflow: hidden;
}
.inv-name {
  font-size: 11px;
  color: var(--zn-text-primary);
  text-align: center;
  line-height: 1.3;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}
.inv-qty {
  position: absolute;
  right: 3px;
  bottom: 3px;
  font-size: 10px;
  color: #fff;
  background: rgba(var(--zn-accent-rgb), 0.85);
  border-radius: 4px;
  padding: 1px 4px;
  line-height: 1;
}

.inv-empty {
  border-style: dashed;
  opacity: 0.45;
}
@media (hover: hover) {
  .inv-empty:hover {
    opacity: 0.75;
  }
}

.inv-add {
  color: var(--zn-text-muted);
  font-size: 20px;
  font-weight: 300;
}
@media (hover: hover) {
  .inv-add:hover {
    color: var(--zn-accent);
  }
}

.inv-item.consumed {
  opacity: 0.55;
}
.inv-item.consumed .inv-name {
  text-decoration: line-through;
}
.inv-item.consumed .inv-qty {
  background: var(--zn-text-muted);
}

.inv-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 4px;
}
.inv-page-btn {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 4px;
  border: 1px solid var(--zn-border-light);
  background: var(--zn-bg-surface2);
  color: var(--zn-text-regular);
  cursor: pointer;
}
.inv-page-btn:hover:not(:disabled) {
  color: var(--zn-accent);
  border-color: var(--zn-accent);
}
.inv-page-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.inv-page-info {
  font-size: 11px;
  color: var(--zn-text-muted);
  min-width: 50px;
  text-align: center;
}

@media (max-width: 520px) {
  .inv-slot {
    width: 56px;
    height: 56px;
  }
}
</style>
