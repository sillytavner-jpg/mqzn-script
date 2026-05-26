<script setup lang="ts">
import { useMainStore } from '../stores/mainStore';
import { analyzePersona } from '../core/persona';

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


// 导入导出
const importInput = ref('');
const showImport = ref(false);

// 当前模型
const currentModel = computed(() => store.getCurrentModel());
const isClaudeModel = computed(() => store.isClaudeModel());

// 新建人设
function addPersona() {
  const name = newPersonaName.value.trim();
  if (!name) return;
  const id = store.addPersona(name);
  store.setActivePersona(id);
  newPersonaName.value = '';
  isAddingPersona.value = false;
  console.info(`[智脑] 新建人设: ${name}`);
}

// 删除人设
function removePersona(id: string) {
  store.removePersona(id);
  console.info('[智脑] 人设已删除');
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
    console.info('[智脑] 请先填写用户人设');
    return;
  }

  isAnalyzing.value = true;
  console.info('[智脑] 正在分析用户人格...');

  try {
    const profile = await analyzePersona(editingPersona.value);
    store.updatePersonaProfile(profile);
    console.info('[智脑] 人格分析完成');
  } catch (error) {
    console.error('[智脑] 人格分析失败:', error);
  } finally {
    isAnalyzing.value = false;
  }
}

function savePersonaOnly() {
  store.updatePersonaRaw(editingPersona.value);
  console.info('[智脑] 人设已保存');
}


// 数据管理
function exportData() {
  const data = store.exportAllData();
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `zhino_data_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  console.info('[智脑] 数据已导出');
}

function importData() {
  if (!importInput.value.trim()) return;
  try {
    store.importAllData(importInput.value);
    importInput.value = '';
    showImport.value = false;
    console.info('[智脑] 数据导入成功');
  } catch (e) {
    console.error('[智脑] 导入失败:', e);
  }
}

function clearChatData() {
  store.clearChatData();
}

function clearAllData() {
  store.clearAllData();
  editingPersona.value = '';
}
</script>

<template>
  <div class="zhino-settings">
    <!-- 功能开关 -->
    <div class="zhino-section">
      <div class="zhino-section-title">功能开关</div>

      <label class="zhino-toggle-row">
        <span class="zhino-toggle-label">用户人格注入</span>
        <input type="checkbox" :checked="store.settings.personaEnabled"
          @change="store.updateSettings({ personaEnabled: ($event.target as HTMLInputElement).checked })" />
      </label>

      <label class="zhino-toggle-row">
        <span class="zhino-toggle-label">动态人设</span>
        <input type="checkbox" :checked="store.settings.dynamicProfileEnabled"
          @change="store.updateSettings({ dynamicProfileEnabled: ($event.target as HTMLInputElement).checked })" />
      </label>

      <label class="zhino-toggle-row">
        <span class="zhino-toggle-label">正文捕获</span>
        <input type="checkbox" :checked="store.settings.captureEnabled"
          @change="store.updateSettings({ captureEnabled: ($event.target as HTMLInputElement).checked })" />
      </label>

      <label class="zhino-toggle-row">
        <span class="zhino-toggle-label">记忆激活</span>
        <input type="checkbox" :checked="store.settings.memoryActivationEnabled"
          @change="store.updateSettings({ memoryActivationEnabled: ($event.target as HTMLInputElement).checked })" />
      </label>

      <label class="zhino-toggle-row">
        <span class="zhino-toggle-label">梦呓注入</span>
        <input type="checkbox" :checked="store.settings.dreamtalkEnabled"
          @change="store.updateSettings({ dreamtalkEnabled: ($event.target as HTMLInputElement).checked })" />
      </label>

      <label class="zhino-toggle-row">
        <span class="zhino-toggle-label">倒果为因</span>
        <input type="checkbox" :checked="store.settings.plotFateEnabled"
          @change="store.updateSettings({ plotFateEnabled: ($event.target as HTMLInputElement).checked })" />
      </label>

      <label class="zhino-toggle-row">
        <span class="zhino-toggle-label">情绪积累</span>
        <input type="checkbox" :checked="store.settings.emotionEnabled"
          @change="store.updateSettings({ emotionEnabled: ($event.target as HTMLInputElement).checked })" />
      </label>
    </div>

    <!-- 间隔设置 -->
    <div class="zhino-section">
      <div class="zhino-section-title">间隔设置</div>
      <div class="zhino-inline-setting">
        <span class="zhino-setting-desc">大总结：每隔</span>
        <input
          type="number"
          class="zhino-input-num"
          :value="store.settings.summaryInterval"
          min="5"
          max="50"
          @change="store.updateSettings({ summaryInterval: Number(($event.target as HTMLInputElement).value) })"
        />
        <span class="zhino-setting-desc">AI楼触发</span>
      </div>
      <div class="zhino-inline-setting" style="margin-top:6px">
        <span class="zhino-setting-desc">情绪分析：每隔</span>
        <input
          type="number"
          class="zhino-input-num"
          :value="store.settings.emotionInterval"
          min="3"
          max="20"
          @change="store.updateSettings({ emotionInterval: Number(($event.target as HTMLInputElement).value) })"
        />
        <span class="zhino-setting-desc">用户楼触发</span>
      </div>
    </div>

    <!-- 自定义API -->
    <div class="zhino-section">
      <div class="zhino-section-title">自定义API（聊天补全）</div>

      <label class="zhino-toggle-row">
        <span class="zhino-toggle-label">使用自定义API</span>
        <input type="checkbox"
          :checked="store.settings.apiMode === 'custom'"
          @change="store.updateSettings({
            apiMode: ($event.target as HTMLInputElement).checked ? 'custom' : 'default'
          })" />
      </label>

      <template v-if="store.settings.apiMode === 'custom'">
        <div class="zhino-api-field">
          <div class="zhino-detail-label">API地址</div>
          <input
            class="zhino-input"
            :value="store.settings.customApiUrl"
            @change="store.updateSettings({ customApiUrl: ($event.target as HTMLInputElement).value })"
            placeholder="https://api.openai.com/v1"
          />
        </div>
        <div class="zhino-api-field">
          <div class="zhino-detail-label">API Key</div>
          <input
            class="zhino-input"
            type="password"
            :value="store.settings.customApiKey"
            @change="store.updateSettings({ customApiKey: ($event.target as HTMLInputElement).value })"
            placeholder="sk-..."
          />
        </div>
        <div class="zhino-api-field">
          <div class="zhino-detail-label">模型名称</div>
          <input
            class="zhino-input"
            :value="store.settings.customApiModel"
            @change="store.updateSettings({ customApiModel: ($event.target as HTMLInputElement).value })"
            placeholder="gpt-4o"
          />
        </div>
        <div class="zhino-api-hint">
          填写API基础地址即可（/chat/completions 会自动补全，与酒馆原生行为一致）。<br/>自建提示词序列（大总结/梦呓/倒果为因/人格分析）通过此API发送。
        </div>
      </template>
    </div>

    <!-- 用户人设（多配置） -->
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
      <div v-if="store.personas.length === 0" class="zhino-empty-hint">
        暂无人设，点击"+ 新建"创建第一个
      </div>
      <div v-else class="zhino-persona-list">
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
            <button class="zhino-btn-xs zhino-btn-danger" @click="removePersona(p.id)">删除</button>
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

    <!-- 模型检测 -->
    <div class="zhino-section">
      <div class="zhino-section-title">模型检测</div>
      <div class="zhino-info-row">
        <span class="zhino-info-label">当前模型：</span>
        <span class="zhino-info-value">{{ currentModel || '未检测到' }}</span>
      </div>
      <div v-if="isClaudeModel" class="zhino-warning">
        检测到 Claude 模型，已自动调整 prefill 策略（最后一条 assistant prefill → system）
      </div>
    </div>


    <!-- 数据管理 -->
    <div class="zhino-section">
      <div class="zhino-section-title">数据管理</div>
      <div class="zhino-btn-row">
        <button class="zhino-btn-sm" @click="exportData">导出数据</button>
        <button class="zhino-btn-sm" @click="showImport = !showImport">导入数据</button>
        <button class="zhino-btn-sm zhino-btn-danger" @click="clearChatData">清空聊天数据</button>
        <button class="zhino-btn-sm zhino-btn-danger" @click="clearAllData">清空全部</button>
      </div>
      <template v-if="showImport">
        <textarea
          v-model="importInput"
          class="zhino-textarea"
          rows="4"
          placeholder="粘贴导出的 JSON 数据"
        />
        <button class="zhino-btn-sm zhino-btn-save" @click="importData">确认导入</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.zhino-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.zhino-section {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 10px 12px;
}
.zhino-section-title {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: 8px;
}

.zhino-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 0;
  cursor: pointer;
}
.zhino-toggle-label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
}
.zhino-toggle-row input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: #a78bfa;
}

.zhino-inline-setting {
  display: flex;
  align-items: center;
  gap: 6px;
}
.zhino-setting-desc {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}
.zhino-input-num {
  width: 50px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  padding: 3px 6px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.85);
  text-align: center;
  outline: none;
}
.zhino-input-num:focus {
  border-color: rgba(167, 139, 250, 0.4);
}

.zhino-textarea {
  width: 100%;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 8px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.85);
  resize: vertical;
  outline: none;
  font-family: inherit;
  margin-bottom: 6px;
}
.zhino-textarea:focus {
  border-color: rgba(167, 139, 250, 0.4);
}

.zhino-input {
  width: 100%;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.85);
  outline: none;
}
.zhino-input:focus {
  border-color: rgba(167, 139, 250, 0.4);
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
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  transition: all 0.15s;
}
.zhino-btn-sm:hover {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.9);
}
.zhino-btn-sm:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.zhino-btn-save {
  border-color: rgba(167, 139, 250, 0.3);
  color: rgba(167, 139, 250, 0.9);
}
.zhino-btn-save:hover {
  background: rgba(167, 139, 250, 0.15);
}
.zhino-btn-danger {
  border-color: rgba(248, 113, 113, 0.3);
  color: rgba(248, 113, 113, 0.8);
}
.zhino-btn-danger:hover {
  background: rgba(248, 113, 113, 0.12);
}

.zhino-profile-preview {
  margin-top: 8px;
  padding: 8px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
}
.zhino-profile-text {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
  white-space: pre-wrap;
  line-height: 1.5;
  max-height: 120px;
  overflow-y: auto;
}
.zhino-detail-label {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  margin-bottom: 4px;
}

.zhino-info-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.zhino-info-label {
  color: rgba(255, 255, 255, 0.4);
}
.zhino-info-value {
  color: rgba(255, 255, 255, 0.8);
  font-family: monospace;
  font-size: 11px;
}

.zhino-warning {
  margin-top: 6px;
  padding: 6px 8px;
  background: rgba(251, 191, 36, 0.08);
  border: 1px solid rgba(251, 191, 36, 0.2);
  border-radius: 4px;
  font-size: 11px;
  color: rgba(251, 191, 36, 0.9);
}


.zhino-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.zhino-empty-hint {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.3);
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
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.02);
  cursor: pointer;
  transition: all 0.15s;
}
.zhino-persona-item:hover {
  background: rgba(167, 139, 250, 0.06);
  border-color: rgba(167, 139, 250, 0.15);
}
.zhino-persona-item.active {
  background: rgba(167, 139, 250, 0.12);
  border-color: rgba(167, 139, 250, 0.3);
}
.zhino-persona-item-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.zhino-persona-name {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.8);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zhino-persona-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 8px;
  background: rgba(167, 139, 250, 0.2);
  color: rgba(167, 139, 250, 0.9);
  flex-shrink: 0;
}
.zhino-persona-item-right {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.zhino-persona-edit-header {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
  margin-bottom: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.zhino-btn-xs {
  padding: 2px 6px;
  font-size: 10px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.03);
  color: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  transition: all 0.15s;
}
.zhino-btn-xs:hover {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.8);
}
.zhino-btn-xs.zhino-btn-danger {
  border-color: rgba(248, 113, 113, 0.2);
  color: rgba(248, 113, 113, 0.7);
}
.zhino-btn-xs.zhino-btn-danger:hover {
  background: rgba(248, 113, 113, 0.1);
}

.zhino-input-inline {
  width: auto;
  max-width: 120px;
  padding: 2px 6px;
  font-size: 11px;
}

.zhino-api-field {
  margin-top: 6px;
}
.zhino-api-hint {
  margin-top: 6px;
  padding: 6px 8px;
  background: rgba(167, 139, 250, 0.06);
  border: 1px solid rgba(167, 139, 250, 0.12);
  border-radius: 4px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  line-height: 1.5;
}
</style>
