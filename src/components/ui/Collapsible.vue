<template>
  <div class="zn-collapsible" :class="{ open: isOpen }">
    <button class="zn-collapsible-header" @click="toggle" :aria-expanded="isOpen" :aria-controls="bodyId">
      <span class="zn-caret">{{ isOpen ? '▾' : '▸' }}</span>
      <span class="zn-collapsible-title">{{ title }}</span>
      <span v-if="count !== undefined && count !== ''" class="zn-collapsible-count">{{ count }}</span>
      <slot name="actions" />
    </button>
    <Transition name="zn-collapse">
      <div v-show="isOpen" :id="bodyId" class="zn-collapsible-body">
        <slot />
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

defineOptions({ name: 'Collapsible' });

const props = withDefaults(defineProps<{
  title: string;
  count?: string | number;
  modelValue?: boolean;
  defaultOpen?: boolean;
}>(), { defaultOpen: false });

const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

const localOpen = ref(props.defaultOpen);
const bodyId = 'zn-collapsible-body-' + Math.random().toString(36).slice(2, 9);
const isControlled = computed(() => props.modelValue !== undefined);
const isOpen = computed(() => (isControlled.value ? props.modelValue! : localOpen.value));

function toggle() {
  const next = !isOpen.value;
  if (isControlled.value) emit('update:modelValue', next);
  else localOpen.value = next;
}
</script>

<style scoped>
.zn-collapsible {
  border: 1px solid var(--zn-border-light);
  border-radius: var(--zn-radius);
  background: var(--zn-bg-surface1);
  overflow: hidden;
  transition: border-color var(--zn-dur) var(--zn-ease);
}
.zn-collapsible.open { border-color: var(--zn-border-base); }

.zn-collapsible-header {
  display: flex;
  align-items: center;
  gap: var(--zn-space-2);
  width: 100%;
  padding: var(--zn-space-2) var(--zn-space-3);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  color: var(--zn-text-primary);
  font-size: var(--zn-fs-body);
  font-weight: 600;
  transition: background var(--zn-dur) var(--zn-ease);
}
.zn-collapsible-header:hover { background: var(--zn-bg-surface2); }

.zn-caret {
  font-size: 0.7rem;
  color: var(--zn-text-muted);
  transition: color var(--zn-dur) var(--zn-ease);
}
.zn-collapsible.open .zn-caret { color: var(--zn-accent); }

.zn-collapsible-title { flex: 1; }
.zn-collapsible-count {
  font-size: var(--zn-fs-label);
  color: var(--zn-text-muted);
  font-variant-numeric: tabular-nums;
  background: var(--zn-bg-surface2);
  padding: 1px 8px;
  border-radius: var(--zn-radius-pill);
}

.zn-collapsible-body {
  padding: var(--zn-space-3);
  border-top: 1px solid var(--zn-border-light);
}

.zn-collapse-enter-active, .zn-collapse-leave-active {
  transition: opacity var(--zn-dur) var(--zn-ease);
}
.zn-collapse-enter-from, .zn-collapse-leave-to { opacity: 0; }
</style>
