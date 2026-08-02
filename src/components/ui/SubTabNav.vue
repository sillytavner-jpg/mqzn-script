<template>
  <div class="zn-subnav" role="tablist">
    <button
      v-for="item in items"
      :key="item.key"
      class="zn-subnav-btn"
      :class="{ active: modelValue === item.key }"
      role="tab"
      :aria-selected="modelValue === item.key"
      @click="$emit('update:modelValue', item.key)"
    >{{ item.label }}</button>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'SubTabNav' });
interface NavItem { key: string; label: string; }
defineProps<{
  items: NavItem[];
  modelValue: string;
}>();
defineEmits<{ (e: 'update:modelValue', key: string): void }>();
</script>

<style scoped>
.zn-subnav {
  display: flex;
  gap: var(--zn-space-1);
  padding: var(--zn-space-1);
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-light);
  border-radius: var(--zn-radius);
  overflow-x: auto;
}
.zn-subnav::-webkit-scrollbar { display: none; }

.zn-subnav-btn {
  flex-shrink: 0;
  padding: var(--zn-space-1) var(--zn-space-3);
  font-size: var(--zn-fs-body);
  font-weight: 500;
  color: var(--zn-text-regular);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--zn-radius-sm);
  cursor: pointer;
  white-space: nowrap;
  transition: all var(--zn-dur) var(--zn-ease);
}
.zn-subnav-btn:hover {
  color: var(--zn-text-primary);
  background: var(--zn-bg-surface2);
}
.zn-subnav-btn:active { transform: scale(0.98); }
.zn-subnav-btn.active {
  color: var(--zn-accent);
  background: var(--zn-accent-dim);
  border-color: rgba(var(--zn-accent-rgb), 0.3);
  text-shadow: 0 0 8px var(--zn-accent-glow);
}
</style>
