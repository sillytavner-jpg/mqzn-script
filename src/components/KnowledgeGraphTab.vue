<template>
  <div class="kg-tab">
    <KnowledgeGraphView
      :graph="g"
      :characterLocations="charLoc"
      :relationshipProfiles="relProfiles"
      :userName="userName"
      @clear="onClearRequest"
      @merge="onMergeRequest"
      @updateAliases="onUpdateAliases"
      @setLocation="onSetLocation"
    />

    <!-- 清空二次确认 -->
    <Modal :visible="confirmVisible" title="清空图谱" :isMobile="isMobile" @close="confirmVisible = false">
      <div class="kg-confirm-body">
        是否清空当前图谱？此操作 <span class="kg-confirm-danger">不可恢复</span>。
      </div>
      <template #footer>
        <button class="kg-btn kg-btn-cancel" @click="confirmVisible = false">取消</button>
        <button class="kg-btn kg-btn-danger" @click="confirmClear">确认清空</button>
      </template>
    </Modal>

    <!-- 合并角色：从图谱节点详情触发，把副角色合并到主角色 -->
    <Modal :visible="mergeVisible" title="合并角色" :isMobile="isMobile" @close="mergeVisible = false">
      <div class="kg-merge-body">
        将「<strong>{{ mergeSourceName }}</strong>」合并到目标角色。
        副角色名会进入主角色的别名，副角色的物品归属改写到主角色名下；主角色位置保持不变。
        <div class="kg-merge-row">
          <span class="kg-merge-label">合并到</span>
          <select v-model="mergeTargetName" class="kg-merge-select">
            <option value="" disabled>选择目标角色…</option>
            <option
              v-for="name in mergeCandidateNames"
              :key="name"
              :value="name"
            >{{ name }}</option>
          </select>
        </div>
        <div v-if="mergeTargetName" class="kg-merge-preview">
          「{{ mergeSourceName }}」→「{{ mergeTargetName }}」<br />
          <span class="kg-merge-hint">提示：选择"被合并的身份"作为来源，"保留的真身"作为目标。例如师尊是清月的分身，来源填"师尊"，目标填"清月"。</span>
        </div>
      </div>
      <template #footer>
        <button class="kg-btn kg-btn-cancel" @click="mergeVisible = false">取消</button>
        <button
          class="kg-btn kg-btn-merge"
          :disabled="!mergeTargetName"
          @click="confirmMerge"
        >确认合并</button>
      </template>
    </Modal>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMainStore } from '../stores/mainStore';
import KnowledgeGraphView from './KnowledgeGraphView.vue';
import Modal from './ui/Modal.vue';
import { useIsMobile } from '../composables/useIsMobile';
import type { KnowledgeGraph } from '../core/knowledgeGraph';
import { createEmptyKnowledgeGraph } from '../core/knowledgeGraph';
import type { RelationshipProfile } from '../stores/mainStore';

const store = useMainStore();
const isMobile = useIsMobile();

const g = computed<KnowledgeGraph>(() => store.chatData.knowledgeGraph || createEmptyKnowledgeGraph());
const charLoc = computed<Record<string, string>>(() => store.chatData.characterLocations || {});
const relProfiles = computed<RelationshipProfile[]>(() => store.relationshipProfiles || []);
const userName = computed(() => store.getUserName());

const confirmVisible = ref(false);
function onClearRequest() { confirmVisible.value = true; }
function confirmClear() {
  store.clearKnowledgeGraph();
  confirmVisible.value = false;
}

// ===== 合并角色（图谱节点详情入口） =====
const mergeVisible = ref(false);
const mergeSourceName = ref('');   // 被合并的副角色
const mergeTargetName = ref('');  // 合并目标主角色

// 候选目标：所有已知角色名（角色库全集），排除副角色自己和玩家
const mergeCandidateNames = computed<string[]>(() => {
  const source = mergeSourceName.value;
  const user = store.getUserName();
  const names = store.getAllCharacterNames().filter(n => n !== source && n !== user);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'zh'));
});

function onMergeRequest(sourceName: string) {
  if (!sourceName) return;
  mergeSourceName.value = sourceName;
  mergeTargetName.value = '';
  mergeVisible.value = true;
}

function confirmMerge() {
  const source = mergeSourceName.value;
  const target = mergeTargetName.value;
  if (!source || !target || source === target) return;
  const ok = store.mergeCharacters(target, source);
  if (ok) {
    mergeVisible.value = false;
    try { (window as any).toastr?.success(`已将「${source}」合并到「${target}」`, '✅ 合并成功', { timeOut: 3000 }); } catch (_) {}
  } else {
    try { (window as any).toastr?.error('合并失败：可能目标或来源不存在', '❌ 合并失败', { timeOut: 4000 }); } catch (_) {}
  }
}

// ===== 别名内联编辑（图谱节点详情入口） =====
function onUpdateAliases(name: string, aliases: string[]) {
  const ok = store.updateGraphCharacterAliases(name, aliases);
  if (ok) {
    try { (window as any).toastr?.success(`已更新「${name}」的别名`, '✅ 别名已保存', { timeOut: 2000 }); } catch (_) {}
  } else {
    try { (window as any).toastr?.error('别名更新失败：角色节点未找到', '❌ 保存失败', { timeOut: 3000 }); } catch (_) {}
  }
}

// ===== 角色地点内联编辑（图谱节点详情入口） =====
function onSetLocation(name: string, location: string) {
  const result = store.setCharacterLocation(name, location);
  if (result) {
    try { (window as any).toastr?.success(`已将「${name}」位置修正为「${result.name}」`, '✅ 地点已更新', { timeOut: 2500 }); } catch (_) {}
  } else {
    try { (window as any).toastr?.error('地点修正失败：角色未找到或地点名为空', '❌ 保存失败', { timeOut: 3500 }); } catch (_) {}
  }
}
</script>

<style scoped>
.kg-tab { display: flex; flex: 1; min-height: 0; }

.kg-confirm-body {
  font-size: 13px; line-height: 1.7; color: rgba(255,255,255,0.78);
  padding: 4px 2px;
}
.kg-confirm-danger { color: #f87171; font-weight: 600; }

.kg-btn {
  padding: 6px 16px; border-radius: 6px; border: none; cursor: pointer;
  font-size: 12px; font-weight: 500; transition: background 0.15s, transform 0.08s;
}
.kg-btn:active { transform: scale(0.94); }
.kg-btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }
.kg-btn-cancel {
  background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.7);
}
.kg-btn-cancel:hover { background: rgba(255,255,255,0.14); }
.kg-btn-danger {
  background: rgba(248,113,113,0.18); color: #fca5a5;
  border: 1px solid rgba(248,113,113,0.35);
}
.kg-btn-danger:hover { background: rgba(248,113,113,0.32); color: #fff; }
.kg-btn-merge {
  background: rgba(139,108,255,0.22); color: #c4b5fd;
  border: 1px solid rgba(139,108,255,0.4);
}
.kg-btn-merge:hover:not(:disabled) { background: rgba(139,108,255,0.38); color: #fff; }

.kg-merge-body {
  font-size: 13px; line-height: 1.7; color: rgba(255,255,255,0.78);
  padding: 2px 2px;
}
.kg-merge-row {
  display: flex; align-items: center; gap: 10px; margin-top: 12px;
}
.kg-merge-label { color: rgba(255,255,255,0.55); font-size: 12px; flex-shrink: 0; }
.kg-merge-select {
  flex: 1; background: rgba(255,255,255,0.06); color: #fff;
  border: 1px solid rgba(255,255,255,0.14); border-radius: 6px; padding: 6px 10px;
  font-size: 13px; outline: none;
}
.kg-merge-select:focus { border-color: rgba(139,108,255,0.5); }
.kg-merge-preview {
  margin-top: 12px; padding: 8px 10px;
  background: rgba(139,108,255,0.08); border: 1px solid rgba(139,108,255,0.2);
  border-radius: 6px; font-size: 13px; color: #c4b5fd;
}
.kg-merge-hint {
  display: block; margin-top: 6px;
  color: rgba(255,255,255,0.45); font-size: 11px; line-height: 1.6;
}
</style>

<style scoped>
.kg-tab { display: flex; flex: 1; min-height: 0; }

.kg-confirm-body {
  font-size: 13px; line-height: 1.7; color: rgba(255,255,255,0.78);
  padding: 4px 2px;
}
.kg-confirm-danger { color: #f87171; font-weight: 600; }

.kg-btn {
  padding: 6px 16px; border-radius: 6px; border: none; cursor: pointer;
  font-size: 12px; font-weight: 500; transition: background 0.15s, transform 0.08s;
}
.kg-btn:active { transform: scale(0.94); }
.kg-btn-cancel {
  background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.7);
}
.kg-btn-cancel:hover { background: rgba(255,255,255,0.14); }
.kg-btn-danger {
  background: rgba(248,113,113,0.18); color: #fca5a5;
  border: 1px solid rgba(248,113,113,0.35);
}
.kg-btn-danger:hover { background: rgba(248,113,113,0.32); color: #fff; }
</style>
