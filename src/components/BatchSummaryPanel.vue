<template>
  <div class="zhino-batch-wrap">
    <Collapsible v-model="showBatchPanel" title="批量总结">
      <!-- 批量总结面板 -->
      <div class="zhino-batch-row">
        <span class="zhino-batch-label">楼层范围</span>
        <input v-model.number="batchStart" type="number" class="zhino-batch-input" min="0" :disabled="batchRunning" />
        <span class="zhino-batch-dash">—</span>
        <input v-model.number="batchEnd" type="number" class="zhino-batch-input" min="0" :disabled="batchRunning" />
      </div>
      <div class="zhino-batch-row">
        <span class="zhino-batch-label">每批</span>
        <input v-model.number="batchSize" type="number" class="zhino-batch-input small" min="5" max="100" :disabled="batchRunning" />
        <span class="zhino-batch-label">层</span>
      </div>
      <div class="zhino-batch-actions">
        <button
          v-if="batchProgress.status !== 'paused'"
          class="zhino-batch-start-btn"
          :disabled="batchRunning || !batchEnd"
          @click="startBatch()"
        >{{ batchRunning ? '运行中…' : '开始批量总结' }}</button>
        <button
          v-if="batchProgress.status === 'paused'"
          class="zhino-batch-start-btn"
          @click="resumeBatch()"
        >▶ 继续总结</button>
        <button
          v-if="batchProgress.status === 'paused'"
          class="zhino-batch-stop-btn"
          @click="stopBatch()"
        >⏹ 停止总结</button>
        <button
          v-if="batchRunning"
          class="zhino-batch-stop-btn"
          @click="stopBatch()"
        >⏹ 停止</button>
      </div>
      <!-- 进度 -->
      <div v-if="batchProgress.status !== 'idle'" class="zhino-batch-progress">
        <div v-if="batchProgress.totalMessages > 0" class="zhino-batch-info">
          {{ batchProgress.startFloor }}-{{ batchProgress.endFloor }} 层 · 共 {{ batchProgress.totalMessages }} 条捕获 · {{ batchProgress.totalBatches }} 批
        </div>
        <div v-if="batchProgress.currentBatch > 0 && batchProgress.status === 'running'" class="zhino-batch-progress-bar">
          <div class="zhino-batch-progress-fill" :style="{ width: (batchProgress.currentBatch / batchProgress.totalBatches * 100) + '%' }"></div>
        </div>
        <div class="zhino-batch-status">
          <template v-if="batchProgress.status === 'running'">
            第 {{ batchProgress.currentBatch }}/{{ batchProgress.totalBatches }} 批 ({{ batchProgress.currentBatchFloorStart }}-{{ batchProgress.currentBatchFloorEnd }}层{{ batchProgress.currentBatchCount !== undefined ? ', ' + batchProgress.currentBatchCount + '条' : '' }})
          </template>
          <template v-else-if="batchProgress.status === 'paused'">
            ⚠ 第 {{ batchProgress.currentBatch }}/{{ batchProgress.totalBatches }} 批重试耗尽，已暂停
          </template>
          <template v-else-if="batchProgress.status === 'cancelled'">
            ⏹ 已停止 ({{ batchProgress.currentBatch - 1 }}/{{ batchProgress.totalBatches }} 批)
          </template>
          <template v-else>
            已完成 {{ batchProgress.currentBatch }}/{{ batchProgress.totalBatches }} 批
          </template>
        </div>
        <!-- 错误列表 -->
        <div v-if="batchProgress.errors.length > 0" class="zhino-batch-errors">
          <div v-for="(err, i) in batchProgress.errors" :key="i" class="zhino-batch-error-item">
            第{{ err.batch }}批: {{ err.message.slice(0, 80) }}
            <span v-if="err.retries <= 3">（已重试{{ err.retries }}次）</span>
            <span v-else class="zhino-batch-error-final">（重试耗尽）</span>
          </div>
        </div>
      </div>
    </Collapsible>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useMainStore } from '../stores/mainStore';
import { executeBatchSummary, type BatchProgress } from '../core/batchSummary';
import { Collapsible } from './ui';
import { readAssistantContentsInRange } from '../utils/chatContent';

const store = useMainStore();

// ─── 批量总结（状态在 store 中，切 tab 不丢失）───
const {
  showBatchPanel, batchRunning, batchAbortRequested, batchStart, batchEnd, batchSize, batchProgress,
} = storeToRefs(store);

// 批量总结按需从酒馆聊天读取正文，capturedContents 只作旧数据 fallback。
const capturedContents = computed(() => {
  void store.chatContentRevision;
  return readAssistantContentsInRange(batchStart.value, batchEnd.value, store.chatData.capturedContents);
});

function onBatchProgress(p: BatchProgress) {
  Object.assign(batchProgress.value, p);
  if (p.status === 'done' || p.status === 'cancelled') batchRunning.value = false;
  if (p.status === 'paused') batchRunning.value = false;
}

async function runBatch(fromFloor: number) {
  if (batchRunning.value) return;
  batchRunning.value = true;
  batchAbortRequested.value = false;
  if (fromFloor === batchStart.value) {
    store.resetBatchProgress();
    Object.assign(batchProgress.value, {
      startFloor: batchStart.value,
      endFloor: batchEnd.value,
      batchSize: batchSize.value,
    });
  }
  await executeBatchSummary(
    fromFloor,
    batchEnd.value,
    batchSize.value,
    capturedContents.value,
    store,
    onBatchProgress,
    batchAbortRequested,
  );
  batchRunning.value = false;
}

async function startBatch() {
  await runBatch(batchStart.value);
}

function resumeBatch() {
  // 计算失败批次的首层：startFloor + (failedBatch - 1) * batchSize
  const failedErr = batchProgress.value.errors.find(e => e.retries > 3);
  const resumeFloor = failedErr
    ? batchProgress.value.startFloor + (failedErr.batch - 1) * batchProgress.value.batchSize
    : batchProgress.value.currentBatchFloorStart || batchProgress.value.startFloor;
  runBatch(resumeFloor);
}

function stopBatch() {
  if (batchRunning.value) {
    batchAbortRequested.value = true;
  } else {
    batchProgress.value.status = 'cancelled';
    batchRunning.value = false;
  }
}
</script>

<style scoped>
.zhino-batch-wrap {
  margin-bottom: 12px;
}

/* 折叠头部 + 面板外壳由 <Collapsible> 提供，此处仅保留内部行样式 */

.zhino-batch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 11px;
}

.zhino-batch-label {
  color: var(--zn-text-muted);
  white-space: nowrap;
}

.zhino-batch-dash {
  color: var(--zn-text-muted);
}

.zhino-batch-input {
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-base);
  border-radius: 4px;
  color: var(--zn-text-regular);
  font-size: 11px;
  padding: 4px 8px;
  width: 80px;
  outline: none;
  font-family: inherit;
  text-align: center;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-batch-input:focus {
  border-color: var(--zn-primary);
}

.zhino-batch-input.small {
  width: 50px;
}

.zhino-batch-input:disabled {
  opacity: 0.4;
}

.zhino-batch-actions {
  margin-bottom: 8px;
}

.zhino-batch-start-btn {
  padding: 5px 16px;
  font-size: 11px;
  font-weight: 600;
  background: var(--zn-primary-dim);
  color: var(--zn-text-primary);
  border: 1px solid var(--zn-primary);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.zhino-batch-start-btn:hover:not(:disabled) {
  filter: brightness(1.15);
}

.zhino-batch-start-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.zhino-batch-stop-btn {
  padding: 5px 16px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(var(--zn-danger-rgb), 0.12);
  color: rgba(var(--zn-danger-rgb), 0.75);
  border: 1px solid rgba(var(--zn-danger-rgb), 0.18);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  margin-left: 8px;
}
.zhino-batch-stop-btn:hover {
  background: rgba(var(--zn-danger-rgb), 0.22);
}

/* ─── 批量进度 ─── */
.zhino-batch-info {
  font-size: 10.5px;
  color: var(--zn-text-muted);
  margin-bottom: 8px;
}

.zhino-batch-progress-bar {
  height: 3px;
  background: var(--zn-bg-surface2);
  border-radius: 2px;
  margin-bottom: 8px;
  overflow: hidden;
}

.zhino-batch-progress-fill {
  height: 100%;
  background: var(--zn-primary);
  border-radius: 2px;
  transition: width 0.3s ease;
}

.zhino-batch-status {
  font-size: 10.5px;
  color: var(--zn-text-muted);
  margin-bottom: 4px;
}

.zhino-batch-errors {
  margin-top: 8px;
  max-height: 120px;
  overflow-y: auto;
}

.zhino-batch-error-item {
  font-size: 10px;
  color: rgba(var(--zn-danger-rgb), 0.55);
  padding: 4px 0;
  border-bottom: 1px solid var(--zn-border-light);
}

.zhino-batch-error-final {
  color: rgba(var(--zn-danger-rgb), 0.7);
  font-weight: 600;
}
</style>
