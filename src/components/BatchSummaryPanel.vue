<template>
  <div class="zhino-batch-wrap">
    <Collapsible v-model="showBatchPanel" title="批量总结">
      <!-- 楼层范围 -->
      <div class="zhino-batch-row">
        <span class="zhino-batch-label">楼层范围</span>
        <input v-model.number="batchStart" type="number" class="zhino-batch-input" min="0" :disabled="batchRunning" />
        <span class="zhino-batch-dash">—</span>
        <input v-model.number="batchEnd" type="number" class="zhino-batch-input" min="0" :disabled="batchRunning" />
      </div>

      <!-- 每批层数 -->
      <div class="zhino-batch-row">
        <span class="zhino-batch-label">每批</span>
        <input v-model.number="batchSize" type="number" class="zhino-batch-input small" min="5" max="100" :disabled="batchRunning" />
        <span class="zhino-batch-label">层</span>
      </div>

      <!-- 总结内容：三个可勾选项 -->
      <div class="zhino-batch-row zhino-batch-checks">
        <span class="zhino-batch-label">总结内容</span>
        <label class="zhino-batch-check">
          <input type="checkbox" v-model="batchDoEvent" :disabled="batchRunning" />
          <span>事件总结</span>
        </label>
        <label class="zhino-batch-check">
          <input type="checkbox" v-model="batchDoMemory" :disabled="batchRunning" />
          <span>角色记忆总结</span>
        </label>
        <label class="zhino-batch-check">
          <input type="checkbox" v-model="batchDoGraph" :disabled="batchRunning" />
          <span>图谱总结</span>
        </label>
      </div>

      <!-- 仅勾了图谱时出现：强制重跑开关 -->
      <div v-if="batchDoGraph" class="zhino-batch-row zhino-batch-checks">
        <span class="zhino-batch-label"></span>
        <label class="zhino-batch-check">
          <input type="checkbox" v-model="batchGraphIgnoreExisting" :disabled="batchRunning" />
          <span>忽略已有小总结，重跑范围内全部楼层</span>
        </label>
      </div>

      <div class="zhino-batch-tip">
        💡 建议：<b>图谱总结</b>单独跑，一次 <b>20 层</b>左右；<b>大总结</b>（事件 + 角色记忆）一次 <b>40 层</b>左右。<br>
        图谱总结把<b>一整批楼层一次性发出去</b>（每批 = 一次请求 = 一份图谱，补地点 / 物品 / 人物）。
        若范围内已有小总结，<b>只从「已有小总结的最后一层」之后发送材料</b>，避免同一层重复入库。<br>
        <b>清空图谱后重建</b>时会自动忽略这条规则、把范围内全部楼层重发一遍；图谱还在但想重跑某段，
        就勾上「忽略已有小总结」。<br>
        某批失败时<b>不会自动重试</b>（重试交给右上角的重试弹窗），会停下来等你决定：点「继续总结」从失败那批重来，
        点「停止总结」结束本次批量。
      </div>

      <div class="zhino-batch-actions">
        <button
          v-if="!anyPaused"
          class="zhino-batch-start-btn"
          :disabled="batchRunning || !batchEnd"
          @click="startBatch()"
        >{{ batchRunning ? '运行中…' : '开始批量总结' }}</button>
        <button
          v-if="anyPaused"
          class="zhino-batch-start-btn"
          @click="resumeBatch()"
        >▶ 继续总结</button>
        <button
          v-if="anyPaused || batchRunning"
          class="zhino-batch-stop-btn"
          :disabled="batchAbortRequested"
          @click="stopBatch()"
        >{{ batchAbortRequested ? '停止中…' : '⏹ 停止总结' }}</button>
      </div>

      <!-- ── 大总结（事件 / 角色记忆）进度 ── -->
      <div v-if="batchProgress.status !== 'idle'" class="zhino-batch-progress">
        <div class="zhino-batch-progress-title">事件 / 角色记忆</div>
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
        <div v-if="batchProgress.errors.length > 0" class="zhino-batch-errors">
          <div v-for="(err, i) in batchProgress.errors" :key="i" class="zhino-batch-error-item">
            第{{ err.batch }}批: {{ err.message.slice(0, 80) }}
          </div>
        </div>
      </div>

      <!-- ── 图谱总结进度 ── -->
      <div v-if="batchGraphProgress.status !== 'idle'" class="zhino-batch-progress">
        <div class="zhino-batch-progress-title">图谱总结</div>
        <div v-if="batchGraphProgress.totalMessages > 0" class="zhino-batch-info">
          {{ batchGraphProgress.startFloor }}-{{ batchGraphProgress.endFloor }} 层 · 共 {{ batchGraphProgress.totalMessages }} 条 · {{ batchGraphProgress.totalBatches }} 批（每批 {{ batchGraphProgress.batchSize }} 层）
          <span v-if="batchGraphProgress.skippedFloors > 0">（已跳过前 {{ batchGraphProgress.skippedFloors }} 层已有小总结）</span>
        </div>
        <div v-if="batchGraphProgress.totalBatches > 0 && batchGraphProgress.status === 'running'" class="zhino-batch-progress-bar">
          <div class="zhino-batch-progress-fill" :style="{ width: (batchGraphProgress.currentBatch / batchGraphProgress.totalBatches * 100) + '%' }"></div>
        </div>
        <div class="zhino-batch-status">
          <template v-if="batchGraphProgress.totalMessages === 0 && batchGraphProgress.status === 'done'">
            ⚠ 没有可补跑的楼层：范围内没有正文，或起点已越过结束楼层（若图谱已清空，会自动忽略已有小总结重新跑）
          </template>
          <template v-else-if="batchGraphProgress.status === 'running'">
            第 {{ batchGraphProgress.currentBatch }}/{{ batchGraphProgress.totalBatches }} 批
            (<template v-if="batchGraphProgress.currentBatchFloorStart !== undefined">#{{ batchGraphProgress.currentBatchFloorStart }}-#{{ batchGraphProgress.currentBatchFloorEnd }}<template v-if="batchGraphProgress.currentBatchCount !== undefined">, {{ batchGraphProgress.currentBatchCount }} 层</template></template>)
          </template>
          <template v-else-if="batchGraphProgress.status === 'paused'">
            ⚠ 第 {{ batchGraphProgress.currentBatch }}/{{ batchGraphProgress.totalBatches }} 批重试耗尽，已暂停
          </template>
          <template v-else-if="batchGraphProgress.status === 'cancelled'">
            ⏹ 已停止（完成 {{ batchGraphProgress.summarizedBatches }} 批）
          </template>
          <template v-else>
            已完成 {{ batchGraphProgress.summarizedBatches }}/{{ batchGraphProgress.totalBatches }} 批<span v-if="batchGraphProgress.committedFloor !== undefined">，图谱提交到 v{{ batchGraphProgress.committedFloor }}</span>
          </template>
        </div>
        <div v-if="batchGraphProgress.errors.length > 0" class="zhino-batch-errors">
          <div v-for="(err, i) in batchGraphProgress.errors" :key="i" class="zhino-batch-error-item">
            第{{ err.batch }}批: {{ err.message.slice(0, 80) }}
          </div>
        </div>
      </div>
    </Collapsible>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useMainStore } from '../stores/mainStore';
import {
  executeBatchSummary,
  executeBatchGraphSummary,
  type BatchProgress,
  type BatchGraphProgress,
} from '../core/batchSummary';
import { Collapsible } from './ui';
import { readAssistantContentsInRange } from '../utils/chatContent';

const store = useMainStore();

// ─── 批量总结（状态在 store 中，切 tab 不丢失）───
const {
  showBatchPanel, batchRunning, batchAbortRequested, batchStart, batchEnd, batchSize, batchProgress,
  batchDoEvent, batchDoMemory, batchDoGraph, batchGraphIgnoreExisting, batchGraphProgress,
} = storeToRefs(store);

const anyPaused = computed(() =>
  batchProgress.value.status === 'paused' || batchGraphProgress.value.status === 'paused',
);

// 批量总结按需从酒馆聊天读取正文，capturedContents 只作旧数据 fallback。
const capturedContents = computed(() => {
  void store.chatContentRevision;
  return readAssistantContentsInRange(batchStart.value, batchEnd.value, store.chatData.capturedContents);
});

function onBatchProgress(p: BatchProgress) {
  Object.assign(batchProgress.value, p);
  if (p.status === 'done' || p.status === 'cancelled' || p.status === 'paused') batchRunning.value = false;
}

function onGraphProgress(p: BatchGraphProgress) {
  Object.assign(batchGraphProgress.value, p);
  if (p.status === 'done' || p.status === 'cancelled' || p.status === 'paused') batchRunning.value = false;
}

/** 只跑图谱（从暂停处续跑时用，避免把已完成的大总结再写一遍） */
async function runGraphOnly(fromFloor: number) {
  batchRunning.value = true;
  batchAbortRequested.value = false;
  await executeBatchGraphSummary(
    fromFloor,
    batchEnd.value,
    batchSize.value,
    capturedContents.value,
    store,
    onGraphProgress,
    batchAbortRequested,
    { ignoreExistingSummaries: batchGraphIgnoreExisting.value },
  );
  batchRunning.value = false;
}

/**
 * @param fromFloor 起始楼层（续跑时用）
 * @param mode      'auto' = 按勾选跑；'graph-only' = 只续跑图谱
 */
async function runBatch(fromFloor: number, mode: 'auto' | 'graph-only' = 'auto') {
  if (batchRunning.value) return;

  const isGraphOnly = mode === 'graph-only';
  const doEvent = isGraphOnly ? false : batchDoEvent.value;
  const doMemory = isGraphOnly ? false : batchDoMemory.value;
  const doGraph = isGraphOnly ? true : batchDoGraph.value;

  if (!doEvent && !doMemory && !doGraph) {
    try { window.toastr?.warning('至少要勾选一项总结内容', '批量总结'); } catch (_) { /* ignore */ }
    return;
  }

  batchRunning.value = true;
  batchAbortRequested.value = false;
  if (fromFloor === batchStart.value) {
    store.resetBatchProgress();
    store.resetBatchGraphProgress();
    Object.assign(batchProgress.value, {
      startFloor: batchStart.value,
      endFloor: batchEnd.value,
      batchSize: batchSize.value,
    });
    Object.assign(batchGraphProgress.value, {
      startFloor: batchStart.value,
      endFloor: batchEnd.value,
      batchSize: batchSize.value,
    });
  }

  // 先跑大总结（事件 / 角色记忆），再补图谱 —— 图谱补跑是"补缺"，放后面不抢流程
  if (doEvent || doMemory) {
    await executeBatchSummary(
      fromFloor,
      batchEnd.value,
      batchSize.value,
      capturedContents.value,
      store,
      onBatchProgress,
      batchAbortRequested,
      { event: doEvent, memory: doMemory },
    );
  }

  if (doGraph && !batchAbortRequested.value) {
    await executeBatchGraphSummary(
      fromFloor,
      batchEnd.value,
      batchSize.value,
      capturedContents.value,
      store,
      onGraphProgress,
      batchAbortRequested,
      { ignoreExistingSummaries: batchGraphIgnoreExisting.value },
    );
  }

  batchRunning.value = false;
}

async function startBatch() {
  await runBatch(batchStart.value);
}

function resumeBatch() {
  // 图谱管线暂停 → 只续跑图谱，从「暂停那一批的首层」重来
  // （大总结管线此时必然已结束，重跑它只会重复写一版）
  if (batchGraphProgress.value.status === 'paused') {
    const from = batchGraphProgress.value.currentBatchFloorStart ?? batchGraphProgress.value.startFloor;
    void runGraphOnly(from);
    return;
  }
  // 大总结管线暂停 → 计算失败批次的首层
  const failedErr = batchProgress.value.errors.find(e => e.retries > 3);
  const resumeFloor = failedErr
    ? batchProgress.value.startFloor + (failedErr.batch - 1) * batchProgress.value.batchSize
    : batchProgress.value.currentBatchFloorStart || batchProgress.value.startFloor;
  void runBatch(resumeFloor);
}

function stopBatch() {
  if (batchRunning.value) {
    batchAbortRequested.value = true;
  } else {
    if (batchProgress.value.status === 'running') batchProgress.value.status = 'cancelled';
    if (batchGraphProgress.value.status === 'running') batchGraphProgress.value.status = 'cancelled';
    if (batchProgress.value.status === 'paused') batchProgress.value.status = 'cancelled';
    if (batchGraphProgress.value.status === 'paused') batchGraphProgress.value.status = 'cancelled';
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

/* ─── 三个可勾选项 ─── */
.zhino-batch-checks {
  flex-wrap: wrap;
  gap: 6px 12px;
}

.zhino-batch-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--zn-text-regular);
  cursor: pointer;
  user-select: none;
}

.zhino-batch-check input[type='checkbox'] {
  width: 12px;
  height: 12px;
  accent-color: var(--zn-primary);
  cursor: pointer;
  margin: 0;
}

.zhino-batch-check input[type='checkbox']:disabled {
  opacity: 0.4;
  cursor: default;
}

.zhino-batch-tip {
  margin: 2px 0 10px;
  padding: 6px 8px;
  font-size: 10.5px;
  line-height: 1.7;
  color: var(--zn-text-muted);
  background: var(--zn-bg-surface1);
  border-left: 2px solid var(--zn-primary);
  border-radius: 3px;
}

.zhino-batch-tip b {
  color: var(--zn-text-regular);
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
.zhino-batch-stop-btn:hover:not(:disabled) {
  background: rgba(var(--zn-danger-rgb), 0.22);
}

.zhino-batch-stop-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

/* ─── 批量进度 ─── */
.zhino-batch-progress {
  margin-top: 4px;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--zn-bg-surface1);
}

.zhino-batch-progress-title {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--zn-text-regular);
  margin-bottom: 6px;
}

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
