<template>
  <div class="world-tab">
    <!-- 子面板导航 -->
    <SubTabNav
      :model-value="activePanel"
      :items="items"
      class="wt-subnav"
      @update:model-value="activePanel = $event as SubPanel"
    />

    <SummaryTab v-if="activePanel === 'timeline'" />
    <ItemsPanel v-else-if="activePanel === 'items'" />
    <KnowledgeGraphTab v-else-if="activePanel === 'knowledge_graph'" />
    <LocationLibraryPanel v-else-if="activePanel === 'location_library'" />
  </div>
</template>

<script setup lang="ts">
import { SubTabNav } from './ui';
import SummaryTab from './SummaryTab.vue';
import ItemsPanel from './ItemsPanel.vue';
import KnowledgeGraphTab from './KnowledgeGraphTab.vue';
import LocationLibraryPanel from './LocationLibraryPanel.vue';

// ─── 子面板切换 ───
type SubPanel = 'timeline' | 'items' | 'knowledge_graph' | 'location_library';
const activePanel = ref<SubPanel>('timeline');
const items = [
  { key: 'timeline', label: '时光轴' },
  { key: 'items', label: '物品库' },
  { key: 'location_library', label: '地点库' },
  { key: 'knowledge_graph', label: '图谱' },
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
