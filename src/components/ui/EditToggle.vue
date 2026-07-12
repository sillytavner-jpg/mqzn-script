<template>
  <div class="zn-edit-toggle">
    <div class="zn-edit-bar">
      <div class="zn-edit-bar-label"><slot name="label" /></div>
      <div class="zn-edit-actions">
        <button v-if="!modelValue" class="zn-edit-btn" @click="start">编辑</button>
        <template v-else>
          <button class="zn-edit-btn zn-edit-save" @click="save">保存</button>
          <button class="zn-edit-btn zn-edit-cancel" @click="cancel">取消</button>
        </template>
      </div>
    </div>
    <div class="zn-edit-body">
      <slot v-if="!modelValue" name="view" :edit="start" />
      <slot v-else name="edit" />
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'EditToggle' });

defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'save'): void;
  (e: 'cancel'): void;
}>();

const start = () => emit('update:modelValue', true);
const save = () => { emit('save'); emit('update:modelValue', false); };
const cancel = () => { emit('cancel'); emit('update:modelValue', false); };
</script>

<style scoped>
.zn-edit-toggle { display: flex; flex-direction: column; gap: var(--zn-space-2); }
.zn-edit-bar { display: flex; align-items: center; justify-content: space-between; gap: var(--zn-space-2); min-height: 24px; }
.zn-edit-bar-label { font-size: var(--zn-fs-body); font-weight: 600; color: var(--zn-text-primary); }
.zn-edit-actions { display: flex; gap: var(--zn-space-1); }

.zn-edit-btn {
  font-size: var(--zn-fs-label);
  padding: 2px 10px;
  border-radius: var(--zn-radius-sm);
  cursor: pointer;
  transition: all var(--zn-dur) var(--zn-ease);
  white-space: nowrap;
  color: var(--zn-text-regular);
  background: var(--zn-bg-surface2);
  border: 1px solid var(--zn-border-base);
}
.zn-edit-btn:hover { color: var(--zn-text-primary); }
.zn-edit-save {
  color: var(--zn-accent);
  background: var(--zn-accent-dim);
  border-color: rgba(var(--zn-accent-rgb), 0.3);
}
.zn-edit-save:hover { box-shadow: var(--zn-glow-accent); }
.zn-edit-cancel:hover { color: var(--zn-danger); border-color: rgba(var(--zn-danger-rgb), 0.3); }
</style>
