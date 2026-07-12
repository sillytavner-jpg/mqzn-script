<template>
  <div class="zn-progress" :class="{ indeterminate: indeterminate }">
    <div v-if="label" class="zn-progress-label">{{ label }}</div>
    <div class="zn-progress-track">
      <div v-if="!indeterminate" class="zn-progress-fill" :style="{ width: percent + '%' }" />
      <div v-else class="zn-progress-fill zn-progress-indet" />
    </div>
    <div v-if="!indeterminate && showValue" class="zn-progress-value">{{ percent }}%</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

defineOptions({ name: 'ProgressBar' });

const props = withDefaults(defineProps<{
  value?: number;
  total?: number;
  percent?: number;
  label?: string;
  showValue?: boolean;
  indeterminate?: boolean;
}>(), { value: 0, total: 100, showValue: false, indeterminate: false });

const percent = computed(() => {
  if (props.percent !== undefined) return Math.max(0, Math.min(100, props.percent));
  if (!props.total) return 0;
  return Math.max(0, Math.min(100, Math.round((props.value / props.total) * 100)));
});
</script>

<style scoped>
.zn-progress { display: flex; flex-direction: column; gap: 4px; }
.zn-progress-label { font-size: var(--zn-fs-label); color: var(--zn-text-muted); }
.zn-progress-track {
  position: relative;
  height: 6px;
  background: var(--zn-bg-surface2);
  border-radius: var(--zn-radius-pill);
  overflow: hidden;
}
.zn-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, rgba(var(--zn-accent-rgb), 0.6), var(--zn-accent));
  border-radius: var(--zn-radius-pill);
  box-shadow: 0 0 8px var(--zn-accent-glow);
  transition: width 0.3s var(--zn-ease);
}
.zn-progress-indet {
  width: 40%;
  animation: zn-progress-indet 1.2s var(--zn-ease) infinite;
}
@keyframes zn-progress-indet {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(350%); }
}
.zn-progress-value {
  font-size: var(--zn-fs-data);
  font-variant-numeric: tabular-nums;
  color: var(--zn-text-muted);
  align-self: flex-end;
}
</style>
