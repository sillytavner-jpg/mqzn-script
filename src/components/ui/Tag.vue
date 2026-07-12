<template>
  <span class="zn-tag" :class="`zn-tag-${variant}`">
    {{ text }}<slot />
    <button v-if="closable" class="zn-tag-close" aria-label="移除" @click.stop="$emit('close')">×</button>
  </span>
</template>

<script setup lang="ts">
defineOptions({ name: 'Tag' });
withDefaults(defineProps<{
  text?: string;
  variant?: 'default' | 'accent' | 'success' | 'warn' | 'danger';
  closable?: boolean;
}>(), { variant: 'default', closable: false });
defineEmits<{ (e: 'close'): void }>();
</script>

<style scoped>
.zn-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  font-size: var(--zn-fs-label);
  border-radius: var(--zn-radius-sm);
  background: var(--zn-bg-surface2);
  color: var(--zn-text-regular);
  border: 1px solid var(--zn-border-light);
  white-space: nowrap;
  line-height: 1.6;
}
.zn-tag-accent { color: var(--zn-accent); background: var(--zn-accent-dim); border-color: rgba(var(--zn-accent-rgb), 0.3); }
.zn-tag-success { color: var(--zn-success); background: rgba(var(--zn-success-rgb), 0.12); border-color: rgba(var(--zn-success-rgb), 0.3); }
.zn-tag-warn { color: var(--zn-warn); background: rgba(var(--zn-warn-rgb), 0.12); border-color: rgba(var(--zn-warn-rgb), 0.3); }
.zn-tag-danger { color: var(--zn-danger); background: rgba(var(--zn-danger-rgb), 0.12); border-color: rgba(var(--zn-danger-rgb), 0.3); }
.zn-tag-close { background: none; border: none; color: inherit; cursor: pointer; font-size: 0.9rem; line-height: 1; padding: 0 0 0 2px; opacity: 0.7; }
.zn-tag-close:hover { opacity: 1; }
</style>
