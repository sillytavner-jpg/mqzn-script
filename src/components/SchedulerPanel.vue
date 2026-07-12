<script setup lang="ts">
/**
 * 调度队列状态面板
 * - 默认（非 compact）：完整显示，用于移动端总览顶部
 * - compact=true：紧凑摘要，用于桌面侧栏底部窄列
 * 自带 1s 轮询 getQueueState，组件卸载时清理 interval。
 */
import { getQueueState } from '../core/backgroundQueue';

defineOptions({ name: 'SchedulerPanel' });
withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const queueState = ref(getQueueState());
let queueTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  queueTimer = setInterval(() => {
    queueState.value = getQueueState();
  }, 1000);
});

onUnmounted(() => {
  if (queueTimer) clearInterval(queueTimer);
});

const runningDisplay = computed(() => {
  const list: Array<{ label: string; sub?: boolean }> = [];
  for (const task of ((queueState.value as any).running || [])) {
    if (task.type === 'grand_summary') {
      list.push({ label: '大总结1（时间线）', sub: true });
      list.push({ label: '大总结2（角色记忆）', sub: true });
    } else {
      list.push({ label: task.label });
    }
  }
  return list;
});

const queueDisplayName = computed(() => {
  if (queueState.value.isGenerating) return '正文生成中（队列暂停）';
  if (queueState.value.isPaused) return '已暂停';
  if (runningDisplay.value.length === 0) return '空闲';
  return runningDisplay.value.map(t => t.label).join(' + ');
});

// 兼容旧模板引用
const schedulerStatus = computed(() => ({
  isProcessing: queueState.value.isProcessing,
  queueLength: queueState.value.queued.length,
  queueNames: queueState.value.queued.map((t: any) => t.label),
}));
</script>

<template>
  <!-- 紧凑模式：侧栏底部窄列 -->
  <div v-if="compact" class="zhino-scheduler-compact">
    <div class="zhino-scheduler-compact-head">
      <span class="zhino-scheduler-dot" :class="{ active: schedulerStatus.isProcessing || runningDisplay.length > 0 }"></span>
      <span class="zhino-scheduler-compact-title">调度队列</span>
      <span v-if="schedulerStatus.queueLength > 0" class="zhino-scheduler-compact-count">{{ schedulerStatus.queueLength }}</span>
    </div>
    <div v-if="runningDisplay.length > 0" class="zhino-scheduler-compact-running">
      <div v-for="(item, idx) in runningDisplay" :key="idx" class="zhino-scheduler-compact-line">
        <span class="zhino-scheduler-dot active"></span>
        <span class="zhino-scheduler-compact-text">{{ item.label }}…</span>
      </div>
    </div>
    <div v-else class="zhino-scheduler-compact-line">{{ queueDisplayName }}</div>
    <div v-if="schedulerStatus.queueLength > 0" class="zhino-scheduler-compact-queue">
      等待 {{ schedulerStatus.queueLength }} 个
    </div>
  </div>

  <!-- 完整模式：原总览样式 -->
  <div v-else class="zhino-section zhino-scheduler-section">
    <div class="zhino-section-title">调度队列</div>
    <div class="zhino-scheduler-status">
      <div class="zhino-scheduler-current" v-for="(item, idx) in runningDisplay" :key="idx">
        <span class="zhino-scheduler-dot active"></span>
        <span class="zhino-scheduler-text" :class="{ 'zhino-scheduler-sub': item.sub }">{{ item.label }}...</span>
      </div>
      <div v-if="runningDisplay.length === 0 && schedulerStatus.isProcessing" class="zhino-scheduler-current">
        <span class="zhino-scheduler-dot active"></span>
        <span class="zhino-scheduler-text">{{ queueDisplayName }}</span>
      </div>
      <div v-if="schedulerStatus.queueLength > 0" class="zhino-scheduler-queue">
        等待中：{{ schedulerStatus.queueLength }} 个任务
        <span class="zhino-scheduler-names">({{ schedulerStatus.queueNames.join(', ') }})</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 紧凑模式（侧栏底部） */
.zhino-scheduler-compact {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  width: 100%;
  font-size: 11px;
  color: var(--zn-text-muted);
}
.zhino-scheduler-compact-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.zhino-scheduler-compact-title {
  font-weight: 600;
  color: var(--zn-text-regular);
}
.zhino-scheduler-compact-count {
  margin-left: auto;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(var(--zn-accent-rgb), 0.15);
  color: var(--zn-accent);
  font-size: 10px;
  font-weight: 600;
}

.zhino-scheduler-compact-running {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.zhino-scheduler-compact-line {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.85;
}

.zhino-scheduler-compact-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

.zhino-scheduler-compact-queue {
  font-size: 10px;
  opacity: 0.7;
}

/* 完整模式 */
.zhino-scheduler-section {
  border-color: rgba(var(--zn-accent-rgb), 0.15);
  background: var(--zn-glass-bg, var(--zn-bg-surface1));
  border: 1px solid var(--zn-border-light);
  border-radius: 12px;
  padding: 12px;
}
.zhino-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--zn-text-regular);
  margin-bottom: 8px;
}
.zhino-scheduler-status {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.zhino-scheduler-current {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--zn-text-regular);
}
.zhino-scheduler-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--zn-bg-surface2);
  flex-shrink: 0;
}
.zhino-scheduler-dot.active {
  background: rgba(var(--zn-success-rgb), 0.8);
  box-shadow: 0 0 6px rgba(var(--zn-success-rgb), 0.4);
  animation: pulse-dot 1.2s infinite;
}
@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.zhino-scheduler-text {
  font-weight: 500;
}
.zhino-scheduler-queue {
  font-size: 11px;
  color: var(--zn-text-muted);
  padding-left: 14px;
}
.zhino-scheduler-names {
  color: rgba(var(--zn-accent-rgb), 0.6);
}
.zhino-scheduler-sub { font-size: 11px; padding-left: 12px; opacity: 0.7; }
</style>