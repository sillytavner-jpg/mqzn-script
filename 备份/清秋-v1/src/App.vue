<template>
  <div class="zhino-root">
    <!-- FAB 悬浮按钮 -->
    <Transition name="zhino-fab">
      <button
        v-if="!isPanelOpen"
        class="zhino-fab"
        :class="{ 'is-dragging': isDragging }"
        :style="fabStyle"
        @pointerdown="onFabPointerDown"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      </button>
    </Transition>

    <!-- 面板 -->
    <Transition name="zhino-panel">
      <div v-if="isPanelOpen" class="zhino-panel" :class="{ mobile: isMobile }" :style="panelStyle">
        <!-- 手机下拉关闭指示条 -->
        <div v-if="isMobile" class="zhino-swipe-hint" @pointerdown="onSwipeDown">
          <div class="zhino-swipe-bar" />
        </div>

        <!-- 顶栏 -->
        <div
          class="zhino-panel-top"
          :class="{ dragging: isPanelDragging }"
          @pointerdown="!isMobile && onPanelPointerDown($event)"
        >
          <span class="zhino-panel-title">智脑</span>
          <span class="zhino-panel-model">{{ currentModelDisplay }}</span>
          <button class="zhino-btn-icon" @click="isPanelOpen = false" @pointerdown.stop>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <!-- Tab 切换 -->
        <div class="zhino-tab-switch">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            class="zhino-tab-btn"
            :class="{ active: currentTab === tab.key }"
            @click="currentTab = tab.key"
          >{{ tab.label }}</button>
        </div>

        <!-- 内容区域 -->
        <div class="zhino-panel-content">
          <OverviewTab v-if="currentTab === 'overview'" />
          <CharacterTab v-else-if="currentTab === 'character'" />
          <DreamtalkTab v-else-if="currentTab === 'dreamtalk'" />
          <SettingsTab v-else-if="currentTab === 'settings'" />
        </div>

        <!-- 手机底部关闭栏 -->
        <div v-if="isMobile" class="zhino-mobile-close-bar">
          <button class="zhino-mobile-close-btn" @click="isPanelOpen = false">收起面板</button>
        </div>

        <!-- PC 可调整大小手柄 -->
        <div v-if="!isMobile" class="zhino-resize-handle" @pointerdown="onResizePointerDown" />
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { useMainStore } from './stores/mainStore';
import OverviewTab from './components/OverviewTab.vue';
import CharacterTab from './components/CharacterTab.vue';
import DreamtalkTab from './components/DreamtalkTab.vue';
import SettingsTab from './components/SettingsTab.vue';

const store = useMainStore();

// ─── 常量 ───
const FAB_SIZE = 44;
const EDGE_GAP = 8;
const DRAG_THRESHOLD = 4;
const MIN_PANEL_W = 380;
const MIN_PANEL_H = 400;
const DEFAULT_PANEL_W = 520;
const DEFAULT_PANEL_H = 600;
const STORAGE_KEY = 'zhino_fab_pos';
const PANEL_SIZE_KEY = 'zhino_panel_size';

// ─── 宿主窗口 ───
const hostWindow = window.parent;
const windowWidth = ref(hostWindow.innerWidth);
const windowHeight = ref(hostWindow.innerHeight);
const safeViewHeight = ref(hostWindow.innerHeight);
const isMobile = computed(() => windowWidth.value <= 768);

// ─── Tab 定义 ───
const tabs = [
  { key: 'overview' as const, label: '总览', icon: '' },
  { key: 'character' as const, label: '角色库', icon: '' },
  { key: 'dreamtalk' as const, label: '梦呓', icon: '' },
  { key: 'settings' as const, label: '设置', icon: '' },
];
const currentTab = ref<'overview' | 'character' | 'dreamtalk' | 'settings'>('overview');

// ─── 面板状态 ───
const isPanelOpen = ref(false);

// ─── 模型显示 ───
const currentModelDisplay = computed(() => {
  const model = store.getCurrentModel();
  if (!model) return '';
  // 截短显示
  if (model.length > 20) return model.slice(0, 20) + '…';
  return model;
});

// ─── 面板尺寸 ───
function readPanelSize() {
  try {
    const raw = hostWindow.localStorage.getItem(PANEL_SIZE_KEY);
    if (raw) return JSON.parse(raw) as { w: number; h: number };
  } catch { /* ignore */ }
  return { w: DEFAULT_PANEL_W, h: DEFAULT_PANEL_H };
}
function savePanelSize(size: { w: number; h: number }) {
  try { hostWindow.localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(size)); } catch { /* ignore */ }
}
const panelSize = reactive(readPanelSize());

// ─── FAB 位置 ───
function defaultFabPos() {
  return { x: hostWindow.innerWidth - FAB_SIZE - 16, y: hostWindow.innerHeight * 0.35 };
}
function readFabPos() {
  try {
    const raw = hostWindow.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as { x: number; y: number };
  } catch { /* ignore */ }
  return defaultFabPos();
}
function saveFabPos(pos: { x: number; y: number }) {
  try { hostWindow.localStorage.setItem(STORAGE_KEY, JSON.stringify(pos)); } catch { /* ignore */ }
}
function clampPos(x: number, y: number) {
  const vw = hostWindow.innerWidth;
  const vh = hostWindow.innerHeight;
  return {
    x: _.clamp(x, EDGE_GAP, Math.max(EDGE_GAP, vw - FAB_SIZE - EDGE_GAP)),
    y: _.clamp(y, EDGE_GAP, Math.max(EDGE_GAP, vh - FAB_SIZE - EDGE_GAP)),
  };
}
const fabPos = reactive(clampPos(readFabPos().x, readFabPos().y));
const fabStyle = computed(() => ({ left: `${fabPos.x}px`, top: `${fabPos.y}px` }));
function setFabPos(x: number, y: number) {
  const c = clampPos(x, y);
  fabPos.x = c.x;
  fabPos.y = c.y;
  saveFabPos(c);
}

// ─── FAB 拖动 ───
const isDragging = ref(false);
let dragStart = { x: 0, y: 0 };
let dragBase = { x: 0, y: 0 };
let hasMoved = false;

function onFabPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  isDragging.value = false;
  hasMoved = false;
  dragStart = { x: e.clientX, y: e.clientY };
  dragBase = { x: fabPos.x, y: fabPos.y };
  hostWindow.addEventListener('pointermove', onFabPointerMove);
  hostWindow.addEventListener('pointerup', onFabPointerUp);
}
function onFabPointerMove(e: PointerEvent) {
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  if (!hasMoved && Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) return;
  hasMoved = true;
  isDragging.value = true;
  setFabPos(dragBase.x + dx, dragBase.y + dy);
}
function onFabPointerUp() {
  hostWindow.removeEventListener('pointermove', onFabPointerMove);
  hostWindow.removeEventListener('pointerup', onFabPointerUp);
  isDragging.value = false;
  if (!hasMoved) {
    isPanelOpen.value = true;
  }
}

// ─── 面板拖动 ───
const isPanelDragging = ref(false);
const panelOffset = ref<{ x: number; y: number } | null>(null);
let panelDragStart = { x: 0, y: 0 };
let panelDragBase = { x: 0, y: 0 };
let panelHasMoved = false;

function calcPanelInitPos() {
  if (isMobile.value) return { x: 0, y: 0 };
  const vw = hostWindow.innerWidth;
  const vh = hostWindow.innerHeight;
  return {
    x: Math.max(EDGE_GAP, (vw - panelSize.w) / 2),
    y: Math.max(EDGE_GAP, (vh - panelSize.h) / 2),
  };
}

const panelStyle = computed(() => {
  if (isMobile.value) {
    const vh = safeViewHeight.value || hostWindow.innerHeight;
    const h = Math.floor(vh * 0.92);
    const topPos = vh - h;
    return { left: '0', top: topPos + 'px', width: '100vw', height: h + 'px' };
  }
  const pos = panelOffset.value ?? calcPanelInitPos();
  const vh = hostWindow.innerHeight;
  const clampedH = Math.min(panelSize.h, Math.floor(vh * 0.9));
  return {
    left: `${pos.x}px`,
    top: `${pos.y}px`,
    width: `${panelSize.w}px`,
    height: `${clampedH}px`,
  };
});

watch(isPanelOpen, open => { if (open) panelOffset.value = null; });

function onPanelPointerDown(e: PointerEvent) {
  if (e.button !== 0 || isMobile.value) return;
  e.preventDefault();
  isPanelDragging.value = false;
  panelHasMoved = false;
  panelDragStart = { x: e.clientX, y: e.clientY };
  const cur = panelOffset.value ?? calcPanelInitPos();
  panelDragBase = { x: cur.x, y: cur.y };
  hostWindow.addEventListener('pointermove', onPanelPointerMove);
  hostWindow.addEventListener('pointerup', onPanelPointerUp);
}
function onPanelPointerMove(e: PointerEvent) {
  const dx = e.clientX - panelDragStart.x;
  const dy = e.clientY - panelDragStart.y;
  if (!panelHasMoved && Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) return;
  panelHasMoved = true;
  isPanelDragging.value = true;
  const vw = hostWindow.innerWidth;
  const vh = hostWindow.innerHeight;
  panelOffset.value = {
    x: _.clamp(panelDragBase.x + dx, EDGE_GAP, Math.max(EDGE_GAP, vw - panelSize.w - EDGE_GAP)),
    y: _.clamp(panelDragBase.y + dy, EDGE_GAP, Math.max(EDGE_GAP, vh - panelSize.h - EDGE_GAP)),
  };
}
function onPanelPointerUp() {
  hostWindow.removeEventListener('pointermove', onPanelPointerMove);
  hostWindow.removeEventListener('pointerup', onPanelPointerUp);
  isPanelDragging.value = false;
}

// ─── 面板可调整大小 ───
let resizeStart = { x: 0, y: 0 };
let resizeBaseW = 0;
let resizeBaseH = 0;

function onResizePointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  resizeStart = { x: e.clientX, y: e.clientY };
  resizeBaseW = panelSize.w;
  resizeBaseH = panelSize.h;
  hostWindow.addEventListener('pointermove', onResizePointerMove);
  hostWindow.addEventListener('pointerup', onResizePointerUp);
}
function onResizePointerMove(e: PointerEvent) {
  panelSize.w = Math.max(MIN_PANEL_W, resizeBaseW + (e.clientX - resizeStart.x));
  panelSize.h = Math.max(MIN_PANEL_H, resizeBaseH + (e.clientY - resizeStart.y));
}
function onResizePointerUp() {
  hostWindow.removeEventListener('pointermove', onResizePointerMove);
  hostWindow.removeEventListener('pointerup', onResizePointerUp);
  savePanelSize({ w: panelSize.w, h: panelSize.h });
}

// ─── 手机下拉关闭手势 ───
let swipeStartY = 0;
let swipeStartTime = 0;

function onSwipeDown(e: PointerEvent) {
  if (!isMobile.value) return;
  e.preventDefault();
  swipeStartY = e.clientY;
  swipeStartTime = Date.now();
  hostWindow.addEventListener('pointermove', onSwipeMove);
  hostWindow.addEventListener('pointerup', onSwipeUp);
}
function onSwipeMove(_e: PointerEvent) { /* 只响应向下 */ }
function onSwipeUp(e: PointerEvent) {
  hostWindow.removeEventListener('pointermove', onSwipeMove);
  hostWindow.removeEventListener('pointerup', onSwipeUp);
  const dy = e.clientY - swipeStartY;
  const dt = Date.now() - swipeStartTime;
  if (dy > 60 || (dy > 30 && dt < 200)) {
    isPanelOpen.value = false;
  }
}

// ─── 安全高度 & resize ───
function updateSafeViewHeight() {
  const vv = (hostWindow as any).visualViewport;
  safeViewHeight.value = vv ? vv.height : hostWindow.innerHeight;
}
const onResize = () => {
  windowWidth.value = hostWindow.innerWidth;
  windowHeight.value = hostWindow.innerHeight;
  updateSafeViewHeight();
  setFabPos(fabPos.x, fabPos.y);
};
onMounted(() => {
  hostWindow.addEventListener('resize', onResize);
  updateSafeViewHeight();
  const vv = (hostWindow as any).visualViewport;
  if (vv) vv.addEventListener('resize', updateSafeViewHeight);
});
onUnmounted(() => {
  hostWindow.removeEventListener('resize', onResize);
  const vv = (hostWindow as any).visualViewport;
  if (vv) vv.removeEventListener('resize', updateSafeViewHeight);
});
</script>

<style scoped>
.zhino-root {
  --zn-bg: #050810;
  --zn-primary: #a78bfa;
  --zn-primary-dim: rgba(167, 139, 250, 0.15);
  --zn-text: rgba(255, 255, 255, 0.88);
  --zn-text-dim: rgba(255, 255, 255, 0.4);
  --zn-border: rgba(167, 139, 250, 0.15);

  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  line-height: 1.5;
}

/* ═══ FAB ═══ */
.zhino-fab {
  position: fixed;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px solid var(--zn-border);
  background: var(--zn-bg);
  cursor: grab;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 16px rgba(167, 139, 250, 0.15), 0 3px 14px rgba(0, 0, 0, 0.4);
  color: var(--zn-primary);
  z-index: 9999;
  user-select: none;
  touch-action: none;
  padding: 0;
  transition: box-shadow 0.2s, transform 0.15s;
}
.zhino-fab:hover {
  box-shadow: 0 0 24px rgba(167, 139, 250, 0.25), 0 5px 20px rgba(0, 0, 0, 0.5);
  transform: scale(1.08);
}
.zhino-fab:active,
.zhino-fab.is-dragging {
  cursor: grabbing;
  transform: scale(1);
}

/* ═══ Panel ═══ */
.zhino-panel {
  position: fixed;
  border-radius: 12px;
  border: 1px solid var(--zn-border);
  background: var(--zn-bg);
  box-shadow: 0 0 30px rgba(167, 139, 250, 0.08), 0 10px 40px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 9999;
  color: var(--zn-text);
}
.zhino-panel.mobile {
  border-radius: 16px 16px 0 0;
  border: none;
  border-top: 1px solid var(--zn-border);
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.3);
}

/* ═══ 顶栏 ═══ */
.zhino-panel-top {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--zn-border);
  background: rgba(5, 8, 16, 0.8);
  gap: 8px;
  cursor: grab;
  user-select: none;
  touch-action: none;
  flex-shrink: 0;
}
.mobile .zhino-panel-top {
  cursor: default;
  padding: 12px 14px;
}
.zhino-panel-top.dragging {
  cursor: grabbing;
}
.zhino-panel-title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--zn-primary);
}
.zhino-panel-model {
  font-size: 11px;
  color: var(--zn-text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.zhino-btn-icon {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--zn-text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s;
}
.zhino-btn-icon:hover {
  background: var(--zn-primary-dim);
  color: var(--zn-primary);
}

/* ═══ Tab 切换 ═══ */
.zhino-tab-switch {
  display: flex;
  gap: 0;
  flex-shrink: 0;
  border-bottom: 1px solid var(--zn-border);
  background: rgba(5, 8, 16, 0.6);
}
.zhino-tab-btn {
  flex: 1;
  padding: 7px 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--zn-text-dim);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
  text-align: center;
}
.zhino-tab-btn:hover {
  color: var(--zn-text);
  background: rgba(167, 139, 250, 0.04);
}
.zhino-tab-btn.active {
  color: var(--zn-primary);
  border-bottom-color: var(--zn-primary);
  background: var(--zn-primary-dim);
}
.mobile .zhino-tab-btn {
  padding: 10px 0;
  font-size: 13px;
}

/* ═══ 面板内容 ═══ */
.zhino-panel-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px;
}

/* ═══ 调整大小手柄 ═══ */
.zhino-resize-handle {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  z-index: 5;
}
.zhino-resize-handle::after {
  content: '';
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 8px;
  height: 8px;
  border-right: 2px solid rgba(167, 139, 250, 0.25);
  border-bottom: 2px solid rgba(167, 139, 250, 0.25);
}
.zhino-resize-handle:hover::after {
  border-color: rgba(167, 139, 250, 0.5);
}

/* ═══ 手机下拉关闭 ═══ */
.zhino-swipe-hint {
  display: flex;
  justify-content: center;
  padding: 6px 0 2px;
  cursor: pointer;
  flex-shrink: 0;
  background: rgba(5, 8, 16, 0.8);
  touch-action: none;
}
.zhino-swipe-bar {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.2);
}
.zhino-swipe-hint:active .zhino-swipe-bar {
  background: rgba(167, 139, 250, 0.5);
}

/* ═══ 手机底部关闭栏 ═══ */
.zhino-mobile-close-bar {
  flex-shrink: 0;
  padding: 8px 12px;
  padding-bottom: max(12px, env(safe-area-inset-bottom, 12px));
  border-top: 1px solid var(--zn-border);
  background: rgba(5, 8, 16, 0.9);
  display: flex;
  justify-content: center;
}
.zhino-mobile-close-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 24px;
  border-radius: 8px;
  border: 1px solid rgba(167, 139, 250, 0.2);
  background: rgba(167, 139, 250, 0.06);
  color: var(--zn-primary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  width: 100%;
  justify-content: center;
}
.zhino-mobile-close-btn:hover,
.zhino-mobile-close-btn:active {
  background: rgba(167, 139, 250, 0.15);
  border-color: rgba(167, 139, 250, 0.4);
}

/* ═══ 过渡动画 ═══ */
.zhino-fab-enter-active,
.zhino-fab-leave-active {
  transition: opacity 0.2s ease;
}
.zhino-fab-enter-from,
.zhino-fab-leave-to {
  opacity: 0;
}
.zhino-panel-enter-active,
.zhino-panel-leave-active {
  transition: all 0.25s ease;
}
.zhino-panel-enter-from {
  opacity: 0;
  transform: translateY(12px) scale(0.97);
}
.zhino-panel-leave-to {
  opacity: 0;
  transform: translateY(12px) scale(0.97);
}
.mobile.zhino-panel-enter-from {
  transform: translateY(100%);
}
.mobile.zhino-panel-leave-to {
  transform: translateY(100%);
}
</style>
