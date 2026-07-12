<template>
  <div class="world-tab">
    <!-- 子面板导航 -->
    <SubTabNav
      :model-value="activePanel"
      :items="items"
      class="wt-subnav"
      @update:model-value="activePanel = $event as SubPanel"
    />

    <CharacterTab v-if="activePanel === 'character'" />
    <RelationshipTab v-else-if="activePanel === 'relationship'" />
    <NpcWorldbookTab v-else-if="activePanel === 'profile'" />
  </div>
</template>

<script setup lang="ts">
import { SubTabNav } from './ui';
import CharacterTab from './CharacterTab.vue';
import RelationshipTab from './RelationshipTab.vue';
import NpcWorldbookTab from './NpcWorldbookTab.vue';

// ─── 子面板切换 ───
type SubPanel = 'character' | 'relationship' | 'profile';
const activePanel = ref<SubPanel>('character');
const items = [
  { key: 'character', label: '角色库' },
  { key: 'relationship', label: '关系网' },
  { key: 'profile', label: 'NPC小传入世书（施工中）' },
];
</script>

<style scoped>
.world-tab {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.wt-subnav { margin-bottom: var(--zn-space-3); flex-shrink: 0; }
</style>
