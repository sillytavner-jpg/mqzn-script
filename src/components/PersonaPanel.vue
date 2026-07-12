<template>
  <div class="zhino-section">
    <div class="zhino-section-header">
      <div class="zhino-section-title">用户人设</div>
      <button class="zhino-btn-sm" @click="isAddingPersona = !isAddingPersona">
        {{ isAddingPersona ? '取消' : '+ 新建' }}
      </button>
    </div>

    <!-- 新建人设输入 -->
    <div v-if="isAddingPersona" class="zhino-add-persona">
      <input
        v-model="newPersonaName"
        class="zhino-input"
        placeholder="人设名称（如：日常角色、战斗角色）"
        @keyup.enter="addPersona"
      />
      <button class="zhino-btn-sm zhino-btn-save" @click="addPersona">创建</button>
    </div>

    <!-- 人设列表 -->
    <EmptyHint
      v-if="store.personas.length === 0"
      text="暂无人设，点击「+ 新建」创建第一个"
      action-text="+ 新建"
      @action="isAddingPersona = true"
    />
    <div v-else class="zhino-persona-list zn-stagger">
      <div
        v-for="p in store.personas"
        :key="p.id"
        class="zhino-persona-item"
        :class="{ active: store.activePersonaId === p.id }"
        @click="switchPersona(p.id)"
      >
        <div class="zhino-persona-item-left">
          <span v-if="renamingId !== p.id" class="zhino-persona-name">{{ p.name || '未命名' }}</span>
          <input
            v-else
            v-model="renamingName"
            class="zhino-input zhino-input-inline"
            @keyup.enter="confirmRename"
            @blur="confirmRename"
            @click.stop
          />
          <span v-if="store.activePersonaId === p.id" class="zhino-persona-badge">激活</span>
        </div>
        <div class="zhino-persona-item-right" @click.stop>
          <button class="zhino-btn-xs" @click="startRename(p.id, p.name)">改名</button>
          <ConfirmButton @confirm="removePersona(p.id)" />
        </div>
      </div>
    </div>

    <!-- 当前激活人设编辑 -->
    <template v-if="store.persona.id">
      <div class="zhino-persona-edit-header">
        编辑: {{ store.persona.name || '未命名' }}
      </div>
      <textarea
        v-model="editingPersona"
        class="zhino-textarea"
        rows="5"
        placeholder="填写你的角色人设（性格、行为模式、说话风格等）"
      />
      <div class="zhino-btn-row">
        <button class="zhino-btn-sm" @click="savePersonaOnly">仅保存</button>
        <button
          class="zhino-btn-sm zhino-btn-save"
          :disabled="isAnalyzing || !editingPersona.trim()"
          @click="saveAndAnalyzePersona"
        >
          {{ isAnalyzing ? '分析中...' : '保存并分析' }}
        </button>
      </div>
      <div v-if="store.persona.analyzedProfile" class="zhino-profile-preview">
        <div class="zhino-detail-label">分析结果（可直接编辑）：</div>
        <textarea
          class="zhino-textarea"
          rows="6"
          :value="store.persona.analyzedProfile"
          @change="store.updatePersonaProfile(($event.target as HTMLTextAreaElement).value)"
        />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useMainStore } from '../stores/mainStore';
import { analyzePersona } from '../core/persona';
import { EmptyHint, ConfirmButton } from './ui';
import { logInfo, logError } from '../utils/logger';

const store = useMainStore();

// 多人设管理
const editingPersona = ref('');
const isAnalyzing = ref(false);
const newPersonaName = ref('');
const isAddingPersona = ref(false);
const renamingId = ref('');
const renamingName = ref('');

// 同步当前激活人设到编辑框
watch(() => store.persona, (p) => {
  editingPersona.value = p.rawInput;
}, { immediate: true });

// 新建人设
function addPersona() {
  const name = newPersonaName.value.trim();
  if (!name) return;
  const id = store.addPersona(name);
  store.setActivePersona(id);
  newPersonaName.value = '';
  isAddingPersona.value = false;
}

// 删除人设
function removePersona(id: string) {
  store.removePersona(id);
}

// 切换激活人设
function switchPersona(id: string) {
  store.setActivePersona(id);
}

// 开始重命名
function startRename(id: string, currentName: string) {
  renamingId.value = id;
  renamingName.value = currentName;
}

function confirmRename() {
  if (renamingId.value && renamingName.value.trim()) {
    store.renamePersona(renamingId.value, renamingName.value.trim());
  }
  renamingId.value = '';
}

// 保存人格
async function saveAndAnalyzePersona() {
  store.updatePersonaRaw(editingPersona.value);
  if (!editingPersona.value.trim()) {
    return;
  }

  isAnalyzing.value = true;
  logInfo('用户人格', '开始分析');

  try {
    const profile = await analyzePersona(editingPersona.value, store.getUserName());
    store.updatePersonaProfile(profile);
    logInfo('用户人格', '分析完成');
  } catch (error) {
    logError('用户人格', '分析失败', String(error));
  } finally {
    isAnalyzing.value = false;
  }
}

function savePersonaOnly() {
  store.updatePersonaRaw(editingPersona.value);
}
</script>

<style scoped>
.zhino-section {
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-light);
  border-radius: 8px;
  padding: 10px 12px;
}
.zhino-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--zn-text-regular);
  margin-bottom: 8px;
  letter-spacing: 0.5px;
}

.zhino-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.zhino-textarea {
  width: 100%;
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-base);
  border-radius: 6px;
  padding: 8px;
  font-size: 12px;
  color: var(--zn-text-primary);
  resize: vertical;
  outline: none;
  font-family: inherit;
  margin-bottom: 6px;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-textarea:focus {
  border-color: var(--zn-primary);
}

.zhino-input {
  width: 100%;
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-base);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--zn-text-primary);
  outline: none;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-input:focus {
  border-color: var(--zn-primary);
}

.zhino-input-inline {
  width: auto;
  max-width: 120px;
  padding: 2px 6px;
  font-size: 11px;
}

.zhino-empty-hint {
  font-size: 12px;
  color: var(--zn-text-muted);
}

.zhino-btn-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
}

.zhino-btn-sm {
  padding: 4px 10px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid var(--zn-border-base);
  background: var(--zn-bg-surface1);
  color: var(--zn-text-regular);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-btn-sm:hover {
  background: var(--zn-bg-surface2);
  color: var(--zn-text-primary);
}
.zhino-btn-sm:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.zhino-btn-save {
  border-color: rgba(var(--zn-accent-rgb), 0.3);
  color: rgba(var(--zn-accent-rgb), 0.9);
}
.zhino-btn-save:hover {
  background: rgba(var(--zn-accent-rgb), 0.15);
}
.zhino-btn-danger {
  border-color: rgba(var(--zn-danger-rgb), 0.3);
  color: rgba(var(--zn-danger-rgb), 0.8);
}
.zhino-btn-danger:hover {
  background: rgba(var(--zn-danger-rgb), 0.12);
}

.zhino-btn-xs {
  padding: 2px 8px;
  font-size: 10px;
  border-radius: 4px;
  border: 1px solid var(--zn-border-base);
  background: var(--zn-bg-surface1);
  color: var(--zn-text-regular);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-btn-xs:hover {
  background: var(--zn-bg-surface2);
  color: var(--zn-text-primary);
}
.zhino-btn-xs.zhino-btn-danger {
  border-color: rgba(var(--zn-danger-rgb), 0.2);
  color: rgba(var(--zn-danger-rgb), 0.7);
}
.zhino-btn-xs.zhino-btn-danger:hover {
  background: rgba(var(--zn-danger-rgb), 0.1);
}

.zhino-profile-preview {
  margin-top: 8px;
  padding: 8px;
  background: var(--zn-bg-surface1);
  border-radius: 6px;
}
.zhino-detail-label {
  font-size: 11px;
  color: var(--zn-text-muted);
  margin-bottom: 4px;
}

.zhino-add-persona {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}

.zhino-persona-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}
.zhino-persona-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--zn-border-light);
  background: var(--zn-bg-surface1);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-persona-item:hover {
  background: rgba(var(--zn-accent-rgb), 0.06);
  border-color: rgba(var(--zn-accent-rgb), 0.15);
}
.zhino-persona-item.active {
  background: rgba(var(--zn-accent-rgb), 0.12);
  border-color: rgba(var(--zn-accent-rgb), 0.3);
}
.zhino-persona-item-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.zhino-persona-name {
  font-size: 12px;
  color: var(--zn-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zhino-persona-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 8px;
  background: rgba(var(--zn-accent-rgb), 0.2);
  color: rgba(var(--zn-accent-rgb), 0.9);
  flex-shrink: 0;
}
.zhino-persona-item-right {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.zhino-persona-edit-header {
  font-size: 11px;
  color: var(--zn-text-regular);
  margin-bottom: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--zn-border-light);
}
</style>
