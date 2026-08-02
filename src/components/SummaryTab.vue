<script setup lang="ts">
import { useMainStore, type TimelineEvent, type TimelineEventTrigger } from '../stores/mainStore';
import { embedTimelineEvents } from '../core/embedding';
import { logInfo, logWarn } from '../utils/logger';

const store = useMainStore();

// ─── 展开状态 ───
const expandedDetails = ref<Set<string>>(new Set());

// ─── 编辑状态 ───
const editingKey = ref<string | null>(null);
const deleteConfirmKey = ref<string | null>(null); // 删除二次确认
const editDraft = reactive({
  time: '',
  event: '',
  detail: '',
  importance: 3 as number,
  triggers: { characters: '', keywords: '' },
});

// ─── 数据 ───
const summary = computed(() => store.getLatestSummary());
const allEvents = computed(() => summary.value?.timeline || []);

// ─── 搜索 ───
const searchQuery = ref('');
const sortOrder = ref<'asc' | 'desc'>('asc');

const filteredEvents = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return allEvents.value;
  return allEvents.value.filter(evt => {
    const fields = [
      evt.time,
      evt.event,
      evt.detail,
      ...(evt.triggers?.characters || []),
      ...(evt.triggers?.keywords || []),
    ];
    return fields.some(f => f?.toLowerCase().includes(q));
  });
});

const sortedEvents = computed(() => {
  const events = filteredEvents.value;
  return sortOrder.value === 'desc' ? [...events].reverse() : events;
});

// ─── 工具 ───
function getEventKey(evt: TimelineEvent): string {
  return `${evt.time}|${evt.event.slice(0, 30)}`;
}

function toggleDetail(key: string) {
  const s = new Set(expandedDetails.value);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  expandedDetails.value = s;
}

// ─── 编辑操作 ───
function startEdit(evt: TimelineEvent) {
  const key = getEventKey(evt);
  editingKey.value = key;
  editDraft.time = evt.time;
  editDraft.event = evt.event;
  editDraft.detail = evt.detail || '';
  editDraft.importance = evt.importance || 3;
  editDraft.triggers.characters = evt.triggers?.characters?.join('、') || '';
  editDraft.triggers.keywords = evt.triggers?.keywords?.join('、') || '';
}

function cancelEdit() {
  editingKey.value = null;
}

function saveEdit(originalEvent: TimelineEvent) {
  // 用 editingKey 作为 oldKey，因为 startEdit 时已经算过一次
  const oldKey = editingKey.value || getEventKey(originalEvent);
  if (!oldKey || oldKey.startsWith('__new__')) {
    logWarn('大总结', '编辑保存: 无效的oldKey', oldKey);
    editingKey.value = null;
    return;
  }
  const chars = editDraft.triggers.characters
    .split(/[,，、]/)
    .map(s => s.trim())
    .filter(Boolean);
  const keywords = editDraft.triggers.keywords
    .split(/[,，、]/)
    .map(s => s.trim())
    .filter(Boolean);

  const triggers: TimelineEventTrigger | undefined =
    chars.length > 0 || keywords.length > 0
      ? { characters: chars, keywords }
      : undefined;

  const newEvent: TimelineEvent = {
    time: editDraft.time,
    event: editDraft.event,
    detail: editDraft.detail || undefined,
    importance: editDraft.importance,
    summaryVersion: originalEvent.summaryVersion,
    triggers,
    // 不携带 embedding（内容已变，旧向量作废，稍后异步重新生成）
  };

  // 优先直接在 delta 中修改（和角色记忆编辑一样），保证事件留在原位
  const summaries = store.chatData.summaries;
  let foundInDelta = false;

  // 从最后一条 delta 往前找：先在最新 delta 中匹配 oldKey
  for (let i = summaries.length - 1; i >= 0; i--) {
    const delta = summaries[i];
    if (!delta.timeline) continue;
    const idx = delta.timeline.findIndex(
      (e: TimelineEvent) => `${e.time}|${e.event.slice(0, 30)}` === oldKey,
    );
    if (idx >= 0) {
      // 直接修改 delta 中的事件
      delta.timeline[idx] = newEvent;
      // 替换对象引用触发 Vue 响应式（和角色记忆编辑同模式）
      store.chatData.summaries[i] = { ...delta };
      foundInDelta = true;
      break;
    }
  }

  if (foundInDelta) {
    // 清理旧版本代码留下的相关 override（_deleted 标记、旧key覆盖、新key残留）
    const overrides = store.chatData.timelineOverrides;
    if (overrides && Object.keys(overrides).length > 0) {
      const newEventKey = `${newEvent.time}|${newEvent.event.slice(0, 30)}`;
      const newOverrides: Record<string, any> = {};
      let cleaned = false;
      for (const [k, v] of Object.entries(overrides)) {
        const vKey = v._deleted ? null : `${(v.time || '')}|${(v.event || '').slice(0, 30)}`;
        if (k !== oldKey && vKey !== oldKey && k !== newEventKey) {
          newOverrides[k] = v;
        } else {
          cleaned = true;
        }
      }
      if (cleaned) {
        store.chatData.timelineOverrides = newOverrides;
      }
    }
  } else {
    // 没在 delta 中直接找到 — 可能是旧代码留下的 override 对（_deleted + newKey）
    const overrides = store.chatData.timelineOverrides || {} as Record<string, any>;
    // 找 _deleted 标记的原始 delta key，和匹配 oldKey 的覆盖
    for (const [delKey, delVal] of Object.entries(overrides)) {
      if (!delVal._deleted) continue; // 只关心 _deleted 条目
      // 检查是否有另一个 override 的内容 key 匹配 oldKey
      for (const [ovKey, ovVal] of Object.entries(overrides)) {
        if (ovVal._deleted || ovKey === delKey) continue;
        const ovContentKey = `${(ovVal.time || '')}|${(ovVal.event || '').slice(0, 30)}`;
        if (ovContentKey !== oldKey) continue;
        // 找到了！delKey 是原始 delta key，ovKey 是旧代码的编辑覆盖
        // 直接修改 delta 中 delKey 的事件，清理所有相关 override
        for (let i = summaries.length - 1; i >= 0; i--) {
          const delta = summaries[i];
          if (!delta.timeline) continue;
          const idx = delta.timeline.findIndex(
            (e: TimelineEvent) => `${e.time}|${e.event.slice(0, 30)}` === delKey,
          );
          if (idx >= 0) {
            delta.timeline[idx] = newEvent;
            store.chatData.summaries[i] = { ...delta };
            foundInDelta = true;
            // 清理相关 override（delKey _deleted + ovKey 覆盖 + oldKey 残留）
            const cleaned: Record<string, any> = {};
            for (const [k, v] of Object.entries(overrides)) {
              if (k !== delKey && k !== ovKey && k !== oldKey) cleaned[k] = v;
            }
            store.chatData.timelineOverrides = cleaned;
            break;
          }
        }
        break;
      }
      if (foundInDelta) break;
    }
    if (!foundInDelta) {
      store.replaceTimelineOverride(oldKey, newEvent);
    }
  }

  // delta 直接修改后需要持久化（override 路径的 replaceTimelineOverride 内部已有 doPersist）
  if (foundInDelta) { store.rebuildAssembled(); store.forcePersist(); }
  editingKey.value = null;

  // 异步重新生成该事件的向量（内容已修改，旧向量已清空）
  if (store.settings.embeddingEnabled && store.settings.embeddingApiKey) {
    const curDelta = store.getLatestDelta();
    if (curDelta?.timeline) {
      setTimeout(() => {
        embedTimelineEvents(
          curDelta.timeline,
          store.settings.embeddingApiUrl,
          store.settings.embeddingApiKey,
          store.settings.embeddingModel,
          store.settings.embeddingDimensions,
          undefined,
          store.settings.embeddingManualMatryoshka,
        ).then(() => {
          const li = store.chatData.summaries.length - 1;
          store.chatData.summaries[li] = { ...store.chatData.summaries[li] };
          store.rebuildAssembled();
          store.forcePersist();
          logInfo('Embedding', '编辑后时间线事件向量化完成');
        }).catch(err => {
          logWarn('Embedding', '编辑后向量化失败（非致命）', String(err));
        });
      }, 100);
    }
  }
}

function deleteEvent(evt: TimelineEvent) {
  const key = getEventKey(evt);
  // 二次确认
  if (deleteConfirmKey.value !== key) {
    deleteConfirmKey.value = key;
    return;
  }
  // 确认删除
  store.removeTimelineEvent(evt);
  if (editingKey.value === key) editingKey.value = null;
  deleteConfirmKey.value = null;
}
function cancelDelete() { deleteConfirmKey.value = null; }

function startAdd() {
  const newKey = `__new__${Date.now()}`;
  editingKey.value = newKey;
  editDraft.time = '';
  editDraft.event = '';
  editDraft.detail = '';
  editDraft.importance = 3;
  editDraft.triggers.characters = '';
  editDraft.triggers.keywords = '';
}

function saveAdd() {
  const chars = editDraft.triggers.characters
    .split(/[,，、]/)
    .map(s => s.trim())
    .filter(Boolean);
  const keywords = editDraft.triggers.keywords
    .split(/[,，、]/)
    .map(s => s.trim())
    .filter(Boolean);

  const triggers: TimelineEventTrigger | undefined =
    chars.length > 0 || keywords.length > 0
      ? { characters: chars, keywords }
      : undefined;

  const newEvent: TimelineEvent = {
    time: editDraft.time || '未指定时间',
    event: editDraft.event || '(空事件)',
    detail: editDraft.detail || undefined,
    importance: editDraft.importance,
    triggers,
  };

  store.addTimelineEvent(newEvent);
  editingKey.value = null;
}

function isEditing(evt: TimelineEvent): boolean {
  return editingKey.value === getEventKey(evt);
}
</script>

<template>
  <div class="zhino-summary-scroll">
    <!-- 工具栏（始终可见） -->
    <div class="zhino-toolbar">
      <div class="zhino-toolbar-title">时光轴</div>
      <div class="zhino-toolbar-search">
        <input
          v-model="searchQuery"
          class="zhino-search-input"
          placeholder="搜索事件…" aria-label="搜索事件…"
        />
      </div>
    </div>

    <!-- 总结概览（有总结时显示） -->
    <div v-if="summary" class="zhino-summary-meta">
      <div class="zhino-meta-left">
        <span class="zhino-meta-label">#{{ summary.version }}</span>
        <span class="zhino-meta-sep">·</span>
        <span class="zhino-meta-label">{{ summary.generatedAt?.slice(0, 16) || '未知' }}</span>
        <span class="zhino-meta-sep">·</span>
        <span class="zhino-meta-label">{{ summary.coveredMessageIds?.length || 0 }} 层</span>
        <span class="zhino-meta-sep">·</span>
        <span class="zhino-meta-label">
          {{ summary.timeline?.length || 0 }} 事件
          <button class="zhino-sort-btn" @click="sortOrder = sortOrder === 'asc' ? 'desc' : 'asc'" :title="sortOrder === 'asc' ? '正序（旧→新）' : '倒序（新→旧）'">
            {{ sortOrder === 'asc' ? '↓' : '↑' }}
          </button>
        </span>
      </div>
    </div>

    <!-- 事件列表 -->
    <template v-if="summary">
      <div v-if="sortedEvents.length === 0 && editingKey?.startsWith('__new__') !== true" class="zhino-empty-hint" style="margin-top:12px">
        {{ searchQuery ? '无匹配事件' : '暂无事件' }}
      </div>

      <!-- 现有事件 -->
      <div
        v-for="(evt, idx) in sortedEvents"
        :key="getEventKey(evt)"
        class="zhino-timeline-card"
        :class="'imp-' + (evt.importance || 3)"
      >
        <!-- 显示模式 -->
        <template v-if="!isEditing(evt)">
          <div class="zhino-event-header">
            <div class="zhino-header-left">
              <span class="zhino-timeline-time">{{ evt.time }}</span>
              <span v-if="evt.summaryVersion" class="zhino-version-badge">v{{ evt.summaryVersion }}</span>
              <span v-if="evt.importance" class="zhino-imp-badge" :class="'imp-' + evt.importance">
                {{ ['','☆','★★','★★★','★★★★','★★★★★'][evt.importance] }}
              </span>
            </div>
            <div class="zhino-event-actions">
              <template v-if="deleteConfirmKey === getEventKey(evt)">
                <button class="zhino-action-btn confirm" @click="deleteEvent(evt)">确认删除</button>
                <button class="zhino-action-btn cancel" @click="cancelDelete()">取消</button>
              </template>
              <template v-else>
                <button class="zhino-action-btn" @click="startEdit(evt)">✎ 编辑</button>
                <button class="zhino-action-btn del" @click="deleteEvent(evt)">✕ 删除</button>
              </template>
            </div>
          </div>
          <div class="zhino-timeline-event">{{ evt.event }}</div>
          <!-- 触发器 -->
          <div v-if="evt.triggers" class="zhino-trigger-row">
            <span v-if="evt.triggers.characters?.length" class="zhino-trigger-tag chars">
              {{ evt.triggers.characters.join(' · ') }}
            </span>
            <span v-if="evt.triggers.keywords?.length" class="zhino-trigger-tag keys">
              {{ evt.triggers.keywords.join(' · ') }}
            </span>
          </div>
          <!-- 详情展开 -->
          <div
            v-if="evt.detail"
            class="zhino-detail-toggle"
            @click="toggleDetail(getEventKey(evt))"
          >
            {{ expandedDetails.has(getEventKey(evt)) ? '收起 ▾' : '展开详情 ▸' }}
          </div>
          <div v-if="expandedDetails.has(getEventKey(evt))" class="zhino-timeline-detail">
            {{ evt.detail }}
          </div>
        </template>

        <!-- 编辑模式 -->
        <template v-else>
          <div class="zhino-edit-row">
            <label class="zhino-edit-label">时间</label>
            <input v-model="editDraft.time" class="zhino-edit-input" placeholder="剧情日期" aria-label="剧情日期" />
          </div>
          <div class="zhino-edit-row">
            <label class="zhino-edit-label">事件</label>
            <textarea v-model="editDraft.event" class="zhino-edit-textarea" rows="2" placeholder="事件内容" aria-label="事件内容" />
          </div>
          <div class="zhino-edit-row">
            <label class="zhino-edit-label">重要度</label>
            <div class="zhino-imp-selector">
              <button v-for="n in 5" :key="n"
                class="zhino-imp-star" :class="{ active: editDraft.importance >= n }"
                @click="editDraft.importance = n"
              >★</button>
              <span class="zhino-imp-label">{{ ['','☆','★★','★★★','★★★★','★★★★★'][editDraft.importance] }}</span>
            </div>
          </div>
          <div class="zhino-edit-row">
            <label class="zhino-edit-label">激活角色</label>
            <input v-model="editDraft.triggers.characters" class="zhino-edit-input" placeholder="逗号分隔" aria-label="逗号分隔" />
          </div>
          <div class="zhino-edit-row">
            <label class="zhino-edit-label">激活关键词</label>
            <input v-model="editDraft.triggers.keywords" class="zhino-edit-input" placeholder="逗号分隔" aria-label="逗号分隔" />
          </div>
          <div class="zhino-edit-row">
            <label class="zhino-edit-label">完整详情</label>
            <textarea v-model="editDraft.detail" class="zhino-edit-textarea" rows="3" placeholder="事件详细过程" aria-label="事件详细过程" />
          </div>
          <div class="zhino-edit-actions">
            <button class="zhino-edit-save" @click="saveEdit(evt)">保存</button>
            <button class="zhino-edit-cancel" @click="cancelEdit()">取消</button>
          </div>
        </template>
      </div>

      <!-- 添加中的新事件 -->
      <div v-if="editingKey?.startsWith('__new__')" class="zhino-timeline-card">
        <div class="zhino-edit-row">
          <label class="zhino-edit-label">时间</label>
          <input v-model="editDraft.time" class="zhino-edit-input" placeholder="剧情日期" aria-label="剧情日期" />
        </div>
        <div class="zhino-edit-row">
          <label class="zhino-edit-label">事件</label>
          <textarea v-model="editDraft.event" class="zhino-edit-textarea" rows="2" placeholder="事件内容" aria-label="事件内容" />
        </div>
        <div class="zhino-edit-row">
          <label class="zhino-edit-label">重要度</label>
          <div class="zhino-imp-selector">
            <button v-for="n in 5" :key="n"
              class="zhino-imp-star" :class="{ active: editDraft.importance >= n }"
              @click="editDraft.importance = n"
            >★</button>
            <span class="zhino-imp-label">{{ ['','☆','★★','★★★','★★★★','★★★★★'][editDraft.importance] }}</span>
          </div>
        </div>
        <div class="zhino-edit-row">
          <label class="zhino-edit-label">激活角色</label>
          <input v-model="editDraft.triggers.characters" class="zhino-edit-input" placeholder="逗号分隔" aria-label="逗号分隔" />
        </div>
        <div class="zhino-edit-row">
          <label class="zhino-edit-label">激活关键词</label>
          <input v-model="editDraft.triggers.keywords" class="zhino-edit-input" placeholder="逗号分隔" aria-label="逗号分隔" />
        </div>
        <div class="zhino-edit-row">
          <label class="zhino-edit-label">完整详情</label>
          <textarea v-model="editDraft.detail" class="zhino-edit-textarea" rows="3" placeholder="事件详细过程" aria-label="事件详细过程" />
        </div>
        <div class="zhino-edit-actions">
          <button class="zhino-edit-save" @click="saveAdd()">添加</button>
          <button class="zhino-edit-cancel" @click="cancelEdit()">取消</button>
        </div>
      </div>

      <!-- 添加按钮 -->
      <button
        v-if="!editingKey?.startsWith('__new__')"
        class="zhino-add-event-btn"
        @click="startAdd()"
      >+ 添加事件</button>
    </template>
  </div>
</template>

<style scoped>
.zhino-summary-scroll {
  flex: 1;
  min-height: 0;
  padding: 10px 12px;
  overflow-y: auto;
}

/* ─── 工具栏 ─── */
.zhino-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.zhino-toolbar-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--zn-text-muted);
  letter-spacing: 1px;
  flex-shrink: 0;
}

.zhino-toolbar-search {
  flex: 1;
  min-width: 0;
}

.zhino-search-input {
  width: 100%;
  height: 28px;
  padding: 0 10px;
  font-size: 11px;
  border: 1px solid var(--zn-border-base);
  border-radius: 6px;
  background: var(--zn-bg-surface1);
  color: var(--zn-text-regular);
  outline: none;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-search-input:focus {
  border-color: var(--zn-primary);
}
.zhino-search-input::placeholder {
  color: var(--zn-text-muted);
}

/* ─── 概览 ─── */
.zhino-summary-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 2px 0;
  font-size: 10.5px;
  color: var(--zn-text-muted);
  margin-bottom: 12px;
}

.zhino-meta-left {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}

.zhino-meta-label {
  color: var(--zn-text-muted);
}

.zhino-meta-sep {
  margin: 0 5px;
  color: var(--zn-border-light);
}

.zhino-sort-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: 4px;
  border: 1px solid var(--zn-border-base);
  border-radius: 4px;
  background: var(--zn-bg-surface1);
  color: var(--zn-text-muted);
  font-size: 12px;
  cursor: pointer;
  vertical-align: middle;
  line-height: 1;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-sort-btn:hover {
  background: var(--zn-bg-surface2);
  color: var(--zn-text-primary);
}

/* ─── 事件卡片 ─── */
.zhino-timeline-card {
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-light);
  border-left: 2px solid var(--zn-border-base);
  border-radius: 0 6px 6px 0;
  padding: 10px 12px;
  margin-bottom: 8px;
  transition: background 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.zhino-timeline-card:hover {
  background: var(--zn-bg-surface2);
}

.zhino-timeline-card.imp-5 { border-left-color: rgba(var(--zn-warn-rgb), 0.5); }
.zhino-timeline-card.imp-4 { border-left-color: rgba(var(--zn-warn-rgb), 0.35); }
.zhino-timeline-card.imp-3 { border-left-color: var(--zn-border-base); }
.zhino-timeline-card.imp-2 { border-left-color: var(--zn-border-light); }
.zhino-timeline-card.imp-1 { border-left-color: var(--zn-border-light); }

/* ─── 事件头部 ─── */
.zhino-event-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.zhino-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.zhino-timeline-time {
  font-size: 10.5px;
  color: var(--zn-text-muted);
}

.zhino-version-badge {
  font-size: 9px;
  color: rgba(var(--zn-accent-rgb), 0.45);
  padding: 1px 5px;
  border: 1px solid rgba(var(--zn-accent-rgb), 0.15);
  border-radius: 4px;
  background: rgba(var(--zn-accent-rgb), 0.06);
  font-family: var(--zn-font-mono);
}

.zhino-imp-badge {
  font-size: 9px;
  letter-spacing: 1px;
}

.zhino-imp-badge.imp-5 { color: rgba(var(--zn-warn-rgb), 0.75); }
.zhino-imp-badge.imp-4 { color: rgba(var(--zn-warn-rgb), 0.6); }
.zhino-imp-badge.imp-3 { color: var(--zn-text-muted); }
.zhino-imp-badge.imp-2 { color: var(--zn-text-muted); }
.zhino-imp-badge.imp-1 { color: var(--zn-text-muted); }

.zhino-event-actions {
  display: flex;
  flex-direction: column;
  gap: 3px;
  opacity: 0;
  transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.zhino-timeline-card:hover .zhino-event-actions {
  opacity: 1;
}

.zhino-action-btn {
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-base);
  color: var(--zn-text-muted);
  cursor: pointer;
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  white-space: nowrap;
}

.zhino-action-btn:hover {
  color: var(--zn-text-regular);
  border-color: var(--zn-border-light);
  background: var(--zn-bg-surface2);
}

.zhino-action-btn.del:hover {
  color: rgba(var(--zn-danger-rgb), 0.8);
  border-color: rgba(var(--zn-danger-rgb), 0.3);
}

.zhino-action-btn.confirm {
  color: rgba(var(--zn-danger-rgb), 0.8);
  border-color: rgba(var(--zn-danger-rgb), 0.3);
}

.zhino-action-btn.confirm:hover {
  color: var(--zn-text-primary);
  background: rgba(var(--zn-danger-rgb), 0.2);
}

.zhino-action-btn.cancel {
  color: var(--zn-text-muted);
}

.zhino-action-btn.cancel:hover {
  color: var(--zn-text-regular);
}

/* ─── 事件内容 ─── */
.zhino-timeline-event {
  font-size: 12px;
  color: var(--zn-text-regular);
  line-height: 1.55;
}

/* ─── 触发器 ─── */
.zhino-trigger-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.zhino-trigger-tag {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--zn-bg-surface1);
  line-height: 1.4;
}

.zhino-trigger-tag.chars {
  color: rgba(130, 170, 255, 0.5);
}

.zhino-trigger-tag.keys {
  color: rgba(var(--zn-accent-rgb), 0.45);
}

/* ─── 详情展开 ─── */
.zhino-detail-toggle {
  font-size: 10.5px;
  color: var(--zn-text-muted);
  cursor: pointer;
  margin-top: 6px;
  user-select: none;
  transition: color 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.zhino-detail-toggle:hover {
  color: var(--zn-text-regular);
}

.zhino-timeline-detail {
  font-size: 11.5px;
  color: var(--zn-text-regular);
  line-height: 1.6;
  margin-top: 6px;
  padding: 8px 10px;
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-light);
  border-radius: 6px;
  white-space: pre-wrap;
}

/* ─── 编辑表单 ─── */
.zhino-edit-row {
  margin-bottom: 6px;
}

.zhino-edit-label {
  display: block;
  font-size: 10px;
  color: var(--zn-text-muted);
  margin-bottom: 2px;
}

.zhino-edit-input,
.zhino-edit-select {
  width: 100%;
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-base);
  border-radius: 4px;
  color: var(--zn-text-regular);
  font-size: 12px;
  padding: 4px 6px;
  outline: none;
  font-family: inherit;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-edit-input:focus,
.zhino-edit-select:focus {
  border-color: var(--zn-primary);
}

.zhino-edit-select option {
  background: var(--zn-card-bg);
  color: var(--zn-text-regular);
}

.zhino-edit-textarea {
  width: 100%;
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-base);
  border-radius: 4px;
  color: var(--zn-text-regular);
  font-size: 12px;
  padding: 4px 6px;
  outline: none;
  resize: vertical;
  font-family: inherit;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-edit-textarea:focus {
  border-color: var(--zn-primary);
}

.zhino-imp-selector {
  display: flex;
  align-items: center;
  gap: 4px;
}
.zhino-imp-star {
  all: unset;
  font-size: 18px;
  cursor: pointer;
  color: var(--zn-text-muted);
  transition: color 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-imp-star.active {
  color: var(--zn-warn);
}
.zhino-imp-label {
  font-size: 12px;
  color: var(--zn-text-muted);
  margin-left: 8px;
  min-width: 50px;
}

.zhino-edit-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.zhino-edit-save {
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(var(--zn-success-rgb), 0.15);
  color: rgba(var(--zn-success-rgb), 0.8);
  border: 1px solid rgba(var(--zn-success-rgb), 0.2);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.zhino-edit-save:hover {
  background: rgba(var(--zn-success-rgb), 0.25);
}

.zhino-edit-cancel {
  padding: 3px 10px;
  font-size: 11px;
  background: var(--zn-bg-surface1);
  color: var(--zn-text-muted);
  border: 1px solid var(--zn-border-base);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.zhino-edit-cancel:hover {
  color: var(--zn-text-regular);
}

/* ─── 添加按钮 ─── */
.zhino-add-event-btn {
  width: 100%;
  padding: 6px 0;
  font-size: 11px;
  color: var(--zn-text-muted);
  background: var(--zn-bg-surface1);
  border: 1px dashed var(--zn-border-light);
  border-radius: 4px;
  cursor: pointer;
  margin-top: 4px;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.zhino-add-event-btn:hover {
  color: var(--zn-text-regular);
  border-color: var(--zn-border-base);
}

.zhino-empty-hint {
  font-size: 12px;
  color: var(--zn-text-muted);
}
</style>
