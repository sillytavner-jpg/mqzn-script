<template>
  <div class="zn-info-row">
    <span class="zn-info-label">{{ label }}</span>
    <span class="zn-info-value"><slot /></span>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'InfoRow' });
defineProps<{ label: string }>();
</script>

<style scoped>
.zn-info-row {
  display: flex;
  align-items: baseline;
  gap: var(--zn-space-2);
  padding: 3px 0;
  font-size: var(--zn-fs-body);
}
.zn-info-label {
  flex-shrink: 0;
  min-width: 5em;
  color: var(--zn-text-muted);
  font-size: var(--zn-fs-label);
}
.zn-info-value {
  flex: 1;
  min-width: 0;
  color: var(--zn-text-regular);
  word-break: break-word;
}
</style>
