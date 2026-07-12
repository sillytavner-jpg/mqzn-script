<template>
  <span class="zn-spinner" :style="{ width: size + 'px', height: size + 'px' }" aria-label="加载中" />
</template>

<script setup lang="ts">
defineOptions({ name: 'Spinner' });
withDefaults(defineProps<{ size?: number; label?: string }>(), { size: 16 });
</script>

<style scoped>
.zn-spinner {
  display: inline-block;
  border: 2px solid var(--zn-bg-surface2);
  border-top-color: var(--zn-accent);
  border-radius: 50%;
  animation: zn-spin 0.7s linear infinite;
  vertical-align: middle;
}
@keyframes zn-spin { to { transform: rotate(360deg); } }
</style>
