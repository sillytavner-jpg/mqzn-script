<template>
  <div class="world-tab">
    <!-- 子面板导航 -->
    <SubTabNav
      :model-value="activePanel"
      :items="items"
      class="wt-subnav"
      @update:model-value="activePanel = $event as SubPanel"
    />

    <!-- 状态/背包 -->
    <PlayerInventoryPanel v-if="activePanel === 'status'" />
    <!-- 梦呓：整 tab 组件，自带 flex:1 填充 -->
    <DreamtalkTab v-else-if="activePanel === 'dreamtalk'" />
    <!-- 用户人设：section 组件，套滚动容器 -->
    <div v-else-if="activePanel === 'persona'" class="wt-tab-scroll">
      <PersonaPanel />
    </div>
  </div>
</template>

<script setup lang="ts">
import { SubTabNav } from './ui';
import PersonaPanel from './PersonaPanel.vue';
import DreamtalkTab from './DreamtalkTab.vue';
import PlayerInventoryPanel from './PlayerInventoryPanel.vue';

// ─── 子面板切换 ───
type SubPanel = 'status' | 'dreamtalk' | 'persona';
const activePanel = ref<SubPanel>('status');
const items = [
  { key: 'status', label: '状态/背包' },
  { key: 'dreamtalk', label: '梦呓' },
  { key: 'persona', label: '用户人设' },
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

/* section 子面板的滚动容器 */
.wt-tab-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--zn-space-3);
  display: flex;
  flex-direction: column;
  gap: var(--zn-space-2);
}
</style>
