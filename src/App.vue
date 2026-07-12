<template>
  <div class="zhino-root" :data-theme="colorMode">
    <!-- FAB 悬浮按钮 -->
    <Transition name="zhino-fab">
      <button
        v-if="!isPanelOpen"
        class="zhino-fab"
        :class="{ 'is-dragging': isDragging }"
        :style="[fabStyle, { transform: `scale(${uiScale})`, transformOrigin: 'center' }]"
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
      <div v-if="isPanelOpen" id="zhino-panel" class="zhino-panel" :class="{ mobile: isMobile }" :style="[panelStyle, { transform: `scale(${uiScale})`, transformOrigin: 'center center' }]">
        <div class="zhino-panel-inner" :class="{ 'mobile-layout': isMobile, 'desktop-layout': !isMobile }">
          <!-- Desktop Sidebar -->
          <div v-if="!isMobile" class="zhino-sidebar">
            <div class="zhino-sidebar-header" :class="{ dragging: isPanelDragging }" @pointerdown="onPanelPointerDown">
              <span class="zhino-panel-title">智脑</span>
              <button class="zhino-panel-close" @click="isPanelOpen = false" @pointerdown.stop @click.stop>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div class="zhino-sidebar-nav">
              <button v-for="tab in tabs" :key="tab.key" class="zhino-sidebar-btn" :class="{ active: currentTab === tab.key }" @click="currentTab = tab.key">{{ tab.label }}</button>
            </div>
            <div class="zhino-sidebar-footer">
              <SchedulerPanel compact />
            </div>
          </div>

          <!-- Mobile Top Bar -->
          <div v-if="isMobile" class="zhino-mobile-top">
            <div class="zhino-swipe-hint" @pointerdown="onSwipeDown"><div class="zhino-swipe-bar" /></div>
            <div class="zhino-mobile-header">
              <span class="zhino-panel-title">智脑</span>
              <span class="zhino-panel-model">{{ currentModelDisplay }}</span>
              <button class="zhino-btn-icon" @click="isPanelOpen = false" @pointerdown.stop>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Mobile Nav -->
          <div v-if="isMobile" class="zhino-mobile-nav">
            <button v-for="tab in tabs" :key="tab.key" class="zhino-mobile-nav-btn" :class="{ active: currentTab === tab.key }" @click="currentTab = tab.key">{{ tab.label }}</button>
          </div>

          <!-- 内容区域 -->
          <div class="zhino-panel-content">
            <OverviewTab v-if="currentTab === 'overview'" />
            <NotebookTab v-else-if="currentTab === 'notebook'" />
            <CharactersTab v-else-if="currentTab === 'characters'" />
            <WorldTab v-else-if="currentTab === 'world'" />
            <PlayerTab v-else-if="currentTab === 'player'" />
            <SettingsTab v-else-if="currentTab === 'settings'" />
          </div>
        </div>

        <!-- PC 可调整大小手柄 -->
        <div v-if="!isMobile" class="zhino-resize-handle" @pointerdown="onResizePointerDown" />
      </div>
    </Transition>

    <!-- 大总结引导弹窗 -->
    <SummaryGuidanceModal
      :visible="store.showSummaryGuidance"
      :pending-floors="store.summaryPendingFloors"
      :initial-guidance="store.lastSubmittedGuidance"
      :is-mobile="isMobile"
      @confirm="store.resolveSummaryGuidance"
      @skip="store.skipSummaryGuidance"
      @cancel="store.cancelSummaryGuidance"
    />

    <!-- API 重试弹窗 -->
    <Transition name="zhino-retry">
      <div v-if="store.apiRetryStatus" class="zhino-retry-toast">
        <div class="zhino-retry-toast-icon">⚠</div>
        <div class="zhino-retry-toast-body">
          <div class="zhino-retry-toast-title">{{ store.apiRetryStatus.analysisName }} 重试中 ({{ store.apiRetryStatus.attempt }}/{{ store.apiRetryStatus.maxRetries }})</div>
          <div class="zhino-retry-toast-error">{{ store.apiRetryStatus.error }}</div>
          <div class="zhino-retry-toast-actions">
            <button class="zhino-retry-stop-btn" @click="store.stopApiRetry">取消重试</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 大总结重试弹窗（带"停止重试"按钮） -->
    <Transition name="zhino-retry">
      <div v-if="store.summaryRetryStatus" class="zhino-retry-toast">
        <div class="zhino-retry-toast-icon">⚠</div>
        <div class="zhino-retry-toast-body">
          <div class="zhino-retry-toast-title">
            大总结生成失败，{{ store.summaryRetryStatus.countdownSec }}s 后自动重试
            ({{ store.summaryRetryStatus.attempt }}/{{ store.summaryRetryStatus.maxAttempts }})
          </div>
          <div class="zhino-retry-toast-error">{{ store.summaryRetryStatus.error }}</div>
          <div class="zhino-retry-toast-actions">
            <button class="zhino-retry-stop-btn" @click="store.stopSummaryRetry">停止重试</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { useMainStore } from './stores/mainStore';
import OverviewTab from './components/OverviewTab.vue';
import WorldTab from './components/WorldTab.vue';
import NotebookTab from './components/NotebookTab.vue';
import CharactersTab from './components/CharactersTab.vue';
import PlayerTab from './components/PlayerTab.vue';
import SettingsTab from './components/SettingsTab.vue';
import SummaryGuidanceModal from './components/SummaryGuidanceModal.vue';
import SchedulerPanel from './components/SchedulerPanel.vue';

const store = useMainStore();

// ─── 大总结引导弹窗（状态和逻辑都在 store 中）───

// 暴露给外部（index.ts 通过 app 实例访问）
defineExpose({ requestSummaryGuidance: store.requestSummaryGuidance });

// ─── 主题模式（深色夜空 / 浅色樱花） ───
const colorMode = computed<'dark' | 'light'>(() => (store.settings.colorMode === 'light' ? 'light' : 'dark'));

// ─── 界面缩放 ───
const uiScale = computed(() => {
  const level = store.settings.fontSize;
  const scales: Record<number, number> = { 1: 1, 2: 1.2, 3: 1.3 };
  return scales[level] ?? 1;
});

// ─── 常量 ───
const FAB_SIZE = 44;
const EDGE_GAP = 8;
const DRAG_THRESHOLD = 4;
const MIN_PANEL_W = 760;
const DEFAULT_PANEL_W = 1120;
const PANEL_ASPECT_RATIO = 16 / 9;
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
  { key: 'overview' as const, label: '总览' },
  { key: 'notebook' as const, label: '记事本' },
  { key: 'characters' as const, label: '人物志' },
  { key: 'world' as const, label: '世界' },
  { key: 'player' as const, label: '玩家' },
  { key: 'settings' as const, label: '设置' },
];
const currentTab = ref<'overview' | 'notebook' | 'characters' | 'world' | 'player' | 'settings'>('overview');

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
    if (raw) {
      const parsed = JSON.parse(raw) as { w: number; h: number };
      if (parsed.w >= MIN_PANEL_W) return parsed;
    }
  } catch { /* ignore */ }
  return { w: DEFAULT_PANEL_W, h: Math.round(DEFAULT_PANEL_W / PANEL_ASPECT_RATIO) };
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
  // ⭐ 使用 screen 坐标（跨 iframe 一致），避免 iframe 内与父窗口坐标系混合
  dragStart = { x: e.screenX, y: e.screenY };
  dragBase = { x: fabPos.x, y: fabPos.y };
  hostWindow.addEventListener('pointermove', onFabPointerMove);
  hostWindow.addEventListener('pointerup', onFabPointerUp);
}
function onFabPointerMove(e: PointerEvent) {
  const dx = e.screenX - dragStart.x;
  const dy = e.screenY - dragStart.y;
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
  const size = getDesktopPanelSize();
  return {
    x: Math.max(EDGE_GAP, (vw - size.w) / 2),
    y: Math.max(EDGE_GAP, (vh - size.h) / 2),
  };
}

function getDesktopPanelSize() {
  const maxWByViewport = Math.floor(hostWindow.innerWidth * 0.92);
  const maxWByHeight = Math.floor(hostWindow.innerHeight * 0.86 * PANEL_ASPECT_RATIO);
  const maxW = Math.max(MIN_PANEL_W, Math.min(maxWByViewport, maxWByHeight));
  const w = _.clamp(panelSize.w || DEFAULT_PANEL_W, MIN_PANEL_W, maxW);
  const h = Math.round(w / PANEL_ASPECT_RATIO);
  return { w, h };
}

const panelStyle = computed(() => {
  if (isMobile.value) {
    const vh = safeViewHeight.value || hostWindow.innerHeight;
    const h = Math.floor(vh * 0.92);
    const topPos = vh - h;
    return { left: '0', top: topPos + 'px', width: '100vw', height: h + 'px' };
  }
  const pos = panelOffset.value ?? calcPanelInitPos();
  const size = getDesktopPanelSize();
  return {
    left: `${pos.x}px`,
    top: `${pos.y}px`,
    width: `${size.w}px`,
    height: `${size.h}px`,
  };
});

watch(isPanelOpen, open => { if (open) panelOffset.value = null; });

function onPanelPointerDown(e: PointerEvent) {
  if (e.button !== 0 || isMobile.value) return;
  e.preventDefault();
  isPanelDragging.value = false;
  panelHasMoved = false;
  panelDragStart = { x: e.screenX, y: e.screenY };
  const cur = panelOffset.value ?? calcPanelInitPos();
  panelDragBase = { x: cur.x, y: cur.y };
  hostWindow.addEventListener('pointermove', onPanelPointerMove);
  hostWindow.addEventListener('pointerup', onPanelPointerUp);
}
function onPanelPointerMove(e: PointerEvent) {
  const dx = e.screenX - panelDragStart.x;
  const dy = e.screenY - panelDragStart.y;
  if (!panelHasMoved && Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) return;
  panelHasMoved = true;
  isPanelDragging.value = true;
  const vw = hostWindow.innerWidth;
  const vh = hostWindow.innerHeight;
  const size = getDesktopPanelSize();
  panelOffset.value = {
    x: _.clamp(panelDragBase.x + dx, EDGE_GAP, Math.max(EDGE_GAP, vw - size.w - EDGE_GAP)),
    y: _.clamp(panelDragBase.y + dy, EDGE_GAP, Math.max(EDGE_GAP, vh - size.h - EDGE_GAP)),
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

function onResizePointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  resizeStart = { x: e.screenX, y: e.screenY };
  const size = getDesktopPanelSize();
  resizeBaseW = size.w;
  hostWindow.addEventListener('pointermove', onResizePointerMove);
  hostWindow.addEventListener('pointerup', onResizePointerUp);
}
function onResizePointerMove(e: PointerEvent) {
  const delta = Math.abs(e.screenX - resizeStart.x) > Math.abs(e.screenY - resizeStart.y)
    ? e.screenX - resizeStart.x
    : (e.screenY - resizeStart.y) * PANEL_ASPECT_RATIO;
  const maxWByViewport = Math.floor(hostWindow.innerWidth * 0.92);
  const maxWByHeight = Math.floor(hostWindow.innerHeight * 0.86 * PANEL_ASPECT_RATIO);
  const maxW = Math.max(MIN_PANEL_W, Math.min(maxWByViewport, maxWByHeight));
  panelSize.w = _.clamp(resizeBaseW + delta, MIN_PANEL_W, maxW);
  panelSize.h = Math.round(panelSize.w / PANEL_ASPECT_RATIO);
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
/* 设计 token 与根样式已迁移至 src/styles/tokens.css 与 base.css */


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
  box-shadow: 0 0 16px rgba(var(--zn-accent-rgb), 0.15), 0 3px 14px rgba(0, 0, 0, 0.4);
  color: var(--zn-primary);
  z-index: 9999;
  user-select: none;
  touch-action: none;
  padding: 0;
  transition: box-shadow 0.2s, filter 0.15s;
}
.zhino-fab:hover {
  box-shadow: 0 0 28px rgba(var(--zn-accent-rgb), 0.3), 0 5px 24px rgba(0, 0, 0, 0.5);
  filter: brightness(1.15);
}
.zhino-fab:active,
.zhino-fab.is-dragging {
  cursor: grabbing;
  filter: brightness(1);
}

/* ═══ Panel ═══ */
.zhino-panel {
  position: fixed;
  border-radius: 12px;
  background: var(--zn-glass-bg);
  backdrop-filter: var(--zn-glass-blur);
  -webkit-backdrop-filter: var(--zn-glass-blur);
  border: 1px solid var(--zn-glass-border);
  box-shadow: var(--zn-shadow-glass), var(--zn-glass-highlight);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 9999;
  color: var(--zn-text-regular);
}
.zhino-panel.mobile {
  border-radius: 16px 16px 0 0;
  border: none;
  border-top: 1px solid var(--zn-glass-border);
  box-shadow: 0 -4px 24px rgba(10, 8, 30, 0.35);
}

.zhino-panel-title {
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--zn-text-primary);
}
.zhino-panel-model {
  font-size: 12px;
  color: var(--zn-text-muted);
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
  color: var(--zn-text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-btn-icon:hover {
  background: var(--zn-bg-surface1);
  color: var(--zn-text-primary);
}

/* ═══ 面板布局：桌面左侧栏 + 右侧内容 ═══ */
.zhino-panel-inner.desktop-layout {
  display: flex;
  flex-direction: row;
  height: 100%;
}

/* ═══ 桌面端关闭按钮：侧栏头部标题行右侧 ═══ */
.zhino-panel-close {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--zn-text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-panel-close:hover {
  background: var(--zn-bg-surface1);
  color: var(--zn-text-primary);
}
.zhino-panel-inner.mobile-layout .zhino-panel-close { display: none; }

/* ═══ Desktop Sidebar ═══ */
.zhino-sidebar {
  width: 180px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--zn-border-light);
  background: var(--zn-surface-sunken);
  flex-shrink: 0;
}
.zhino-sidebar-header {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--zn-border-light);
  gap: 6px;
  cursor: grab;
  user-select: none;
  touch-action: none;
  flex-shrink: 0;
}
.zhino-sidebar-header.dragging {
  cursor: grabbing;
}
.zhino-sidebar-nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 8px;
  gap: 4px;
  overflow-y: auto;
}
.zhino-sidebar-btn {
  display: block;
  width: 100%;
  padding: 10px 14px;
  font-size: 14px;
  font-weight: 500;
  color: var(--zn-text-regular);
  background: transparent;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-sidebar-btn:hover {
  color: var(--zn-text-primary);
  background: var(--zn-bg-surface2);
}
.zhino-sidebar-btn.active {
  color: var(--zn-text-primary);
  background: var(--zn-primary-dim);
  text-shadow: 0 0 8px var(--zn-primary-dim);
}
.zhino-sidebar-footer {
  padding: 8px;
  border-top: 1px solid var(--zn-border-light);
  display: flex;
  justify-content: stretch;
  align-items: flex-end;
}

/* ═══ 面板布局：手机顶部 + 内容 + 底部导航 ═══ */
.zhino-panel-inner.mobile-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* ═══ Mobile Top Bar ═══ */
.zhino-mobile-top {
  flex-shrink: 0;
}
.zhino-mobile-header {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--zn-border-light);
  gap: 8px;
}

/* ═══ Mobile Bottom Nav ═══ */
.zhino-mobile-nav {
  display: flex;
  flex-direction: row;
  border-bottom: 1px solid var(--zn-border-light);
  background: var(--zn-surface-sunken);
  padding: 6px 4px;
  flex-shrink: 0;
  overflow-x: auto;
}
.zhino-mobile-nav::-webkit-scrollbar {
  display: none;
}
.zhino-mobile-nav-btn {
  flex: 1;
  padding: 8px 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--zn-text-regular);
  background: transparent;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  text-align: center;
  white-space: nowrap;
}
.zhino-mobile-nav-btn:hover {
  color: var(--zn-text-primary);
  background: var(--zn-bg-surface1);
}
.zhino-mobile-nav-btn.active {
  color: var(--zn-text-primary);
  background: var(--zn-primary-dim);
  text-shadow: 0 0 8px var(--zn-primary-dim);
}

/* ═══ 面板内容 ═══ */
.zhino-panel-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 16px;
  display: flex;
  flex-direction: column;
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
  border-right: 2px solid rgba(var(--zn-accent-rgb), 0.25);
  border-bottom: 2px solid rgba(var(--zn-accent-rgb), 0.25);
}
.zhino-resize-handle:hover::after {
  border-color: rgba(var(--zn-accent-rgb), 0.5);
}

/* ═══ 手机下拉关闭 ═══ */
.zhino-swipe-hint {
  display: flex;
  justify-content: center;
  padding: 6px 0 2px;
  cursor: pointer;
  flex-shrink: 0;
  background: var(--zn-surface-sunken);
  touch-action: none;
}
.zhino-swipe-bar {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.2);
}
.zhino-swipe-hint:active .zhino-swipe-bar {
  background: rgba(var(--zn-accent-rgb), 0.5);
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
}
.zhino-panel-leave-to {
  opacity: 0;
}
.mobile.zhino-panel-enter-from {
  opacity: 0;
}
.mobile.zhino-panel-leave-to {
  opacity: 0;
}

/* ===== API 重试 toast ===== */
.zhino-retry-toast {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: var(--zn-z-toast);
  max-width: 360px;
  background: var(--zn-card-bg);
  border: 1px solid rgba(var(--zn-warn-rgb), 0.3);
  border-radius: var(--zn-radius);
  box-shadow: var(--zn-shadow-soft);
  padding: 10px 14px;
  display: flex;
  gap: 10px;
  align-items: flex-start;
  pointer-events: auto;
}
.zhino-retry-toast-icon { font-size: 16px; flex-shrink: 0; margin-top: 1px; }
.zhino-retry-toast-body { flex: 1; min-width: 0; }
.zhino-retry-toast-title { font-size: 13px; font-weight: 600; color: rgba(var(--zn-warn-rgb), 0.9); }
.zhino-retry-toast-error {
  font-size: 11px;
  color: rgba(var(--zn-danger-rgb), 0.75);
  margin-top: 4px;
  font-family: var(--zn-font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zhino-retry-toast-actions { margin-top: 8px; display: flex; justify-content: flex-end; }
.zhino-retry-stop-btn {
  border: 1px solid rgba(var(--zn-danger-rgb), 0.5);
  background: rgba(var(--zn-danger-rgb), 0.12);
  color: rgba(var(--zn-danger-rgb), 0.95);
  border-radius: var(--zn-radius-sm);
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
}
.zhino-retry-stop-btn:hover { background: rgba(var(--zn-danger-rgb), 0.22); }
.zhino-retry-enter-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.zhino-retry-leave-active { transition: opacity 0.15s ease; }
.zhino-retry-enter-from { opacity: 0; transform: translateX(20px); }
.zhino-retry-leave-to { opacity: 0; }
</style>
