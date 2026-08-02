<template>
  <span class="zn-confirm" :class="{ confirming: armed }" ref="rootEl">
    <button
      v-if="!armed"
      class="zn-confirm-trigger"
      :disabled="disabled"
      @click.stop="arm"
    >{{ label }}</button>
    <template v-else>
      <button class="zn-confirm-cancel" @click.stop="disarm">{{ cancelText }}</button>
      <button class="zn-confirm-go" @click.stop="confirm">{{ confirmText }}</button>
    </template>
  </span>
</template>

<script setup lang="ts">
import { ref, nextTick, onBeforeUnmount } from 'vue';

defineOptions({ name: 'ConfirmButton' });

withDefaults(defineProps<{
  label?: string;
  confirmText?: string;
  cancelText?: string;
  disabled?: boolean;
}>(), {
  label: '删除',
  confirmText: '确认删除',
  cancelText: '取消',
  disabled: false,
});

const emit = defineEmits<{ (e: 'confirm'): void }>();
const armed = ref(false);
const rootEl = ref<HTMLElement | null>(null);
let cleanup: (() => void) | null = null;

const arm = () => {
  armed.value = true;
  nextTick(() => {
    const handler = (e: PointerEvent) => {
      // 点击落在组件外部 → 取消确认
      if (rootEl.value && !rootEl.value.contains(e.target as Node)) disarm();
    };
    const keyHandler = (e: KeyboardEvent) => {
      // 键盘用户按 Esc 取消确认
      if (e.key === 'Escape') disarm();
    };
    document.addEventListener('pointerdown', handler);
    document.addEventListener('keydown', keyHandler);
    cleanup = () => {
      document.removeEventListener('pointerdown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  });
};
const disarm = () => { armed.value = false; cleanup?.(); cleanup = null; };
const confirm = () => { armed.value = false; cleanup?.(); cleanup = null; emit('confirm'); };

onBeforeUnmount(() => cleanup?.());
</script>

<style scoped>
.zn-confirm { display: inline-flex; gap: var(--zn-space-1); align-items: center; }

.zn-confirm-trigger, .zn-confirm-cancel, .zn-confirm-go {
  font-size: var(--zn-fs-label);
  padding: 2px 10px;
  border-radius: var(--zn-radius-sm);
  cursor: pointer;
  transition: all var(--zn-dur) var(--zn-ease);
  white-space: nowrap;
}
.zn-confirm-trigger {
  color: rgba(var(--zn-danger-rgb), 0.85);
  background: rgba(var(--zn-danger-rgb), 0.08);
  border: 1px solid rgba(var(--zn-danger-rgb), 0.25);
}
.zn-confirm-trigger:hover:not(:disabled) {
  background: rgba(var(--zn-danger-rgb), 0.18);
  color: var(--zn-danger);
}
.zn-confirm-trigger:disabled { opacity: 0.4; cursor: not-allowed; }

.zn-confirm-cancel {
  color: var(--zn-text-muted);
  background: var(--zn-bg-surface2);
  border: 1px solid var(--zn-border-base);
}
.zn-confirm-cancel:hover { color: var(--zn-text-primary); }

.zn-confirm-go {
  color: #fff;
  background: rgba(var(--zn-danger-rgb), 0.85);
  border: 1px solid var(--zn-danger);
  font-weight: 600;
}
.zn-confirm-go:hover { background: var(--zn-danger); box-shadow: 0 0 12px rgba(var(--zn-danger-rgb), 0.4); }
</style>
