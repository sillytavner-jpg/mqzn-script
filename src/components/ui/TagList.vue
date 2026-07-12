<template>
  <div v-if="items.length" class="zn-tag-list">
    <Tag v-for="(item, i) in items" :key="i" :text="typeof item === 'string' ? item : item.text" :variant="(typeof item === 'string' ? variant : item.variant) || variant" :closable="closable" @close="$emit('remove', i)" />
  </div>
</template>

<script setup lang="ts">
import Tag from './Tag.vue';

defineOptions({ name: 'TagList' });

type Item = string | { text: string; variant?: 'default' | 'accent' | 'success' | 'warn' | 'danger' };

withDefaults(defineProps<{
  items: Item[];
  variant?: 'default' | 'accent' | 'success' | 'warn' | 'danger';
  closable?: boolean;
}>(), { variant: 'default', closable: false });
defineEmits<{ (e: 'remove', index: number): void }>();
</script>

<style scoped>
.zn-tag-list { display: flex; flex-wrap: wrap; gap: var(--zn-space-1); }
</style>
