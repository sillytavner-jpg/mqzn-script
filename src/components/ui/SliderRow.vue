<template>
  <div class="zn-slider-row">
    <div class="zn-slider-head">
      <span class="zn-slider-label">{{ label }}</span>
      <span class="zn-slider-value">{{ modelValue }}{{ unit }}</span>
    </div>
    <input
      class="zn-slider"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      :disabled="disabled"
      :aria-label="label"
      @input="$emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
    />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'SliderRow' });
withDefaults(defineProps<{
  label: string;
  modelValue: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
}>(), { min: 0, max: 100, step: 1, unit: '', disabled: false });
defineEmits<{ (e: 'update:modelValue', v: number): void }>();
</script>

<style scoped>
.zn-slider-row { display: flex; flex-direction: column; gap: 6px; }
.zn-slider-head { display: flex; justify-content: space-between; align-items: baseline; }
.zn-slider-label { font-size: var(--zn-fs-body); color: var(--zn-text-regular); }
.zn-slider-value {
  font-size: var(--zn-fs-data);
  font-variant-numeric: tabular-nums;
  color: var(--zn-accent);
  font-weight: 600;
}
.zn-slider {
  width: 100%;
  height: 4px;
  accent-color: var(--zn-accent);
  cursor: pointer;
}
.zn-slider:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
