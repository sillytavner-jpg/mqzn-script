<template>
  <span class="zn-skeleton" :style="{ width: width, height: height }" />
</template>

<script setup lang="ts">
defineOptions({ name: 'SkeletonLine' });
withDefaults(defineProps<{
  width?: string;
  height?: string;
}>(), { width: '100%', height: '0.9em' });
</script>

<style scoped>
.zn-skeleton {
  display: inline-block;
  border-radius: var(--zn-radius-sm);
  background: linear-gradient(
    90deg,
    var(--zn-bg-surface1) 25%,
    var(--zn-bg-surface2) 37%,
    var(--zn-bg-surface1) 63%
  );
  background-size: 400% 100%;
  animation: zn-skeleton 1.4s ease infinite;
  vertical-align: middle;
}
@keyframes zn-skeleton {
  0% { background-position: 100% 50%; }
  100% { background-position: 0 50%; }
}
</style>
