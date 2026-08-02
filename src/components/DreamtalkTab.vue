<script setup lang="ts">
import { useMainStore } from '../stores/mainStore';
import { executeDreamtalkAnalysis } from '../core/dreamtalk';
import { logInfo, logError } from '../utils/logger';

const store = useMainStore();

// 编辑状态
const editingSection = ref<string | null>(null);
const selectedInteractionChar = ref('');
const editingText = ref('');

const isEditingRollLikes = ref(false);
const isEditingRollDislikes = ref(false);
const editingRollLikes = ref('');
const editingRollDislikes = ref('');

const dreamtalk = computed(() => store.dreamtalk);
const isSpeakForUser = computed(() => dreamtalk.value?.playStyle === '抢话' || dreamtalk.value?.playStyle === '混合');

// 角色交互列表
const interactionCharacters = computed(() => {
  if (!dreamtalk.value) return [];
  return dreamtalk.value.characterInteractions.map(i => i.characterName);
});

// 当前选中角色的交互
const selectedInteraction = computed(() => {
  if (!dreamtalk.value || !selectedInteractionChar.value) return null;
  return dreamtalk.value.characterInteractions.find(
    i => i.characterName === selectedInteractionChar.value,
  ) || null;
});

// === 编辑函数 ===

function startEdit(section: string) {
  if (!dreamtalk.value) return;
  const dt = dreamtalk.value as any;

  if (section === 'userInfo') {
    editingText.value = `基本信息: ${dt.userInfo?.basic || ''}\n外貌特征: ${dt.userInfo?.appearance || ''}\n背景设定: ${dt.userInfo?.background || ''}\n关系设定: ${dt.userInfo?.relationship || ''}`;
  } else if (section === 'personality') {
    const p = dt.personality || {};
    editingText.value = `底色: ${p.baseColor || ''}\n主色调: ${p.mainColor || ''}\n点缀: ${p.accent || ''}\n衍生:\n${(p.derivations || []).map((d: string) => `- ${d}`).join('\n')}\n边界: ${p.boundary || ''}`;
  } else if (section === 'bodyContact') {
    editingText.value = (dt.bodyContact.entries || []).map((e: any) => `- ${e.text}` + (e.prevent ? ` | ${e.prevent}` : '')).join('\n');
  } else if (section === 'speech') {
    editingText.value = (dt.speechStyle.entries || []).map((e: any) => `- ${e.text}` + (e.prevent ? ` | ${e.prevent}` : '')).join('\n');
  } else if (section === 'emotion') {
    editingText.value = Object.entries(dt.emotionExpression).map(([name, e]: [string, any]) => `${name}: ${e.shows} | ${e.prevent}`).join('\n');
  } else if (section.startsWith('char:')) {
    const charName = section.slice(5);
    selectedInteractionChar.value = charName;
    const interaction = dt.characterInteractions.find((i: any) => i.characterName === charName);
    if (interaction) {
      editingText.value = (interaction.entries || []).map((e: any) => {
        const text = e.scenario ? `${e.scenario}: ${e.text}` : e.text;
        return `- ${text}` + (e.prevent ? ` | ${e.prevent}` : '');
      }).join('\n');
    }
  }
  editingSection.value = section;
}

function saveEdit() {
  if (!dreamtalk.value) return;
  const dt = dreamtalk.value as any;

  const section = editingSection.value;
  if (section === 'userInfo') {
    const lines = editingText.value.split('\n');
    const info: any = { basic: '', appearance: '', background: '', relationship: '' };
    for (const line of lines) {
      const m = line.match(/^([^:：]+)[:：]\s*(.+)/);
      if (m) {
        const key = m[1].trim();
        const val = m[2].trim();
        if (key === '基本信息') info.basic = val;
        else if (key === '外貌特征') info.appearance = val;
        else if (key === '背景设定') info.background = val;
        else if (key === '关系设定') info.relationship = val;
      }
    }
    dt.userInfo = info;
  } else if (section === 'personality') {
    const lines = editingText.value.split('\n');
    let baseColor = '', mainColor = '', accent = '', boundary = '';
    const derivations: string[] = [];
    let inDeriv = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('底色:')) baseColor = trimmed.replace(/^底色[:：]\s*/, '');
      else if (trimmed.startsWith('主色调:')) mainColor = trimmed.replace(/^主色调[:：]\s*/, '');
      else if (trimmed.startsWith('点缀:')) accent = trimmed.replace(/^点缀[:：]\s*/, '');
      else if (trimmed.startsWith('边界:')) boundary = trimmed.replace(/^边界[:：]\s*/, '');
      else if (trimmed === '衍生:' || trimmed === '衍生：') inDeriv = true;
      else if (inDeriv && trimmed.startsWith('- ')) derivations.push(trimmed.slice(2));
    }
    dt.personality = { baseColor, mainColor, accent, derivations, boundary };
  } else {
    // 行为翻译块：每行 "- [情境: ]text | prevent"
    const entries: any[] = [];
    const lines = editingText.value.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith('- ')) continue;
      let content = line.slice(2).trim();

      // 尝试提取情境前缀（如"靠近时: 行为"）
      let scenario: string | undefined;
      const scenarioMatch = content.match(/^(.+?)[：:]\s*(.+)/);
      if (scenarioMatch) {
        scenario = scenarioMatch[1].trim();
        content = scenarioMatch[2].trim();
      }

      const pipeIdx = content.lastIndexOf('|');
      if (pipeIdx === -1) {
        if (content) {
          const entry: any = { text: content, prevent: '' };
          if (scenario) entry.scenario = scenario;
          entries.push(entry);
        }
      } else {
        const text = content.slice(0, pipeIdx).trim();
        const prevent = content.slice(pipeIdx + 1).trim();
        if (text) {
          const entry: any = { text, prevent };
          if (scenario) entry.scenario = scenario;
          entries.push(entry);
        }
      }
    }
    if (section === 'bodyContact') dt.bodyContact = { entries };
    else if (section === 'speech') dt.speechStyle = { entries };
    else if (section === 'emotion') {
      const emotions: Record<string, any> = {};
      for (const rawLine of lines) {
        const line = rawLine.trim();
        const m = line.match(/^([^:：]+)[:：]\s*(.+?)\s*\|\s*(.+)/);
        if (m) { const name = m[1].trim(); if (name) emotions[name] = { shows: m[2].trim(), prevent: m[3].trim() }; }
      }
      dt.emotionExpression = emotions;
    } else if (section?.startsWith('char:')) {
      const idx = dt.characterInteractions.findIndex((i: any) => i.characterName === selectedInteractionChar.value);
      if (idx !== -1) dt.characterInteractions[idx].entries = entries;
    }
  }

  store.updateDreamtalk({ ...dt });
  editingSection.value = null;
}

// Roll 编辑
function startEditRollLikes() {
  if (!dreamtalk.value) return;
  editingRollLikes.value = dreamtalk.value.rollLikes.join('\n');
  isEditingRollLikes.value = true;
}
function saveRollLikes() {
  if (!dreamtalk.value) return;
  dreamtalk.value.rollLikes = editingRollLikes.value.split('\n').map(l => l.trim()).filter(Boolean);
  store.updateDreamtalk({ ...dreamtalk.value });
  isEditingRollLikes.value = false;
}
function startEditRollDislikes() {
  if (!dreamtalk.value) return;
  editingRollDislikes.value = dreamtalk.value.rollDislikes.join('\n');
  isEditingRollDislikes.value = true;
}
function saveRollDislikes() {
  if (!dreamtalk.value) return;
  dreamtalk.value.rollDislikes = editingRollDislikes.value.split('\n').map(l => l.trim()).filter(Boolean);
  store.updateDreamtalk({ ...dreamtalk.value });
  isEditingRollDislikes.value = false;
}

// 游玩类型选择（与 store.settings.preferredPlayStyle 双向绑定）
const preferredPlayStyle = computed({
  get: () => store.settings.preferredPlayStyle || '',
  set: (val: string) => store.updateSettings({ preferredPlayStyle: val }),
});

// 手动触发分析
async function triggerAnalysis() {
  if (store.userInputRecords.length === 0) {
    logInfo('梦呓', '没有可用的用户输入记录');
    return;
  }
  store.setDreamtalkInProgress(true);
  const style = preferredPlayStyle.value || undefined;
  logInfo('梦呓', '手动触发分析');
  try {
    const { dreamtalk: result, nsfwDreamtalk } = await executeDreamtalkAnalysis(
      store.userInputRecords,
      store.persona.rawInput || '',
      store.dreamtalk,
      style,
      store.getUserName(),
      store.getBlacklistedCharacters(),
    );
    store.updateDreamtalk(result);
    if (nsfwDreamtalk) store.updateNsfwDreamtalk(nsfwDreamtalk);
    logInfo('梦呓', `分析完成 (${result.characterInteractions.length} 角色)`);
  } catch (error: any) {
    logError('梦呓', '分析失败', String(error));
    const msg = error?.message || String(error);
    try { window.toastr?.error(msg, '❌ 梦呓分析失败', { timeOut: 8000, extendedTimeOut: 3000 }); } catch(_) {}
  } finally {
    store.setDreamtalkInProgress(false);
  }
}
</script>

<template>
  <div class="zhino-dreamtalk">
    <!-- 空状态 -->
    <div v-if="!dreamtalk" class="zhino-section">
      <div class="zhino-empty-hint">梦呓数据尚未生成。大总结完成后会自动分析，或手动触发。</div>
      <!-- 游玩类型选择 -->
      <div class="zhino-playstyle-row">
        <span class="zhino-playstyle-label">游玩类型：</span>
        <label class="zhino-playstyle-radio"><input type="radio" value="" v-model="preferredPlayStyle" name="playstyle" /> 自动判定</label>
        <label class="zhino-playstyle-radio"><input type="radio" value="不抢话" v-model="preferredPlayStyle" name="playstyle" /> 不抢话党</label>
        <label class="zhino-playstyle-radio"><input type="radio" value="抢话" v-model="preferredPlayStyle" name="playstyle" /> 抢话党</label>
        <label class="zhino-playstyle-radio"><input type="radio" value="混合" v-model="preferredPlayStyle" name="playstyle" /> 混合</label>
      </div>
      <button class="zhino-btn" :disabled="store.dreamtalkInProgress || store.userInputRecords.length === 0" @click="triggerAnalysis">
        {{ store.dreamtalkInProgress ? '分析中...' : '手动分析' }}
      </button>
    </div>

    <template v-else>
      <!-- 游玩类型选择 -->
      <div class="zhino-section">
        <div class="zhino-section-title">游玩类型</div>
        <div class="zhino-playstyle-row">
          <label class="zhino-playstyle-radio"><input type="radio" value="" v-model="preferredPlayStyle" name="playstyle" /> 自动判定</label>
          <label class="zhino-playstyle-radio"><input type="radio" value="不抢话" v-model="preferredPlayStyle" name="playstyle" /> 不抢话党</label>
          <label class="zhino-playstyle-radio"><input type="radio" value="抢话" v-model="preferredPlayStyle" name="playstyle" /> 抢话党</label>
          <label class="zhino-playstyle-radio"><input type="radio" value="混合" v-model="preferredPlayStyle" name="playstyle" /> 混合</label>
        </div>
        <div class="zhino-playstyle-hint">
          AI 分析结果: {{ dreamtalk.playStyle }} | 下次手动/自动分析时将使用上方选择
        </div>
      </div>

      <!-- 基础信息 -->
      <div class="zhino-section">
        <div class="zhino-section-header">
          <div class="zhino-section-title">基础信息</div>
          <button v-if="editingSection !== 'userInfo'" class="zhino-btn-sm" @click="startEdit('userInfo')">编辑</button>
          <div v-else class="zhino-btn-group">
            <button class="zhino-btn-sm zhino-btn-save" @click="saveEdit">保存</button>
            <button class="zhino-btn-sm" @click="editingSection = null">取消</button>
          </div>
        </div>
        <template v-if="editingSection === 'userInfo'">
          <textarea v-model="editingText" class="zhino-textarea" rows="5" />
        </template>
        <template v-else>
          <div class="zhino-userinfo-grid">
            <div v-if="dreamtalk.userInfo.basic" class="zhino-userinfo-row">
              <span class="zhino-userinfo-label">基本信息</span>
              <span class="zhino-userinfo-val">{{ dreamtalk.userInfo.basic }}</span>
            </div>
            <div v-if="dreamtalk.userInfo.appearance && dreamtalk.userInfo.appearance !== '待观察'" class="zhino-userinfo-row">
              <span class="zhino-userinfo-label">外貌</span>
              <span class="zhino-userinfo-val">{{ dreamtalk.userInfo.appearance }}</span>
            </div>
            <div v-if="dreamtalk.userInfo.background && dreamtalk.userInfo.background !== '待观察'" class="zhino-userinfo-row">
              <span class="zhino-userinfo-label">背景</span>
              <span class="zhino-userinfo-val">{{ dreamtalk.userInfo.background }}</span>
            </div>
            <div v-if="dreamtalk.userInfo.relationship && dreamtalk.userInfo.relationship !== '待观察'" class="zhino-userinfo-row">
              <span class="zhino-userinfo-label">关系</span>
              <span class="zhino-userinfo-val">{{ dreamtalk.userInfo.relationship }}</span>
            </div>
            <div v-if="!dreamtalk.userInfo.basic && !dreamtalk.userInfo.relationship" class="zhino-empty-hint">暂无数据</div>
          </div>
        </template>
      </div>

      <!-- 性格调色盘（抢话党专属） -->
      <div v-if="isSpeakForUser && dreamtalk.personality" class="zhino-section">
        <div class="zhino-section-header">
          <div class="zhino-section-title">性格调色盘</div>
          <button v-if="editingSection !== 'personality'" class="zhino-btn-sm" @click="startEdit('personality')">编辑</button>
          <div v-else class="zhino-btn-group">
            <button class="zhino-btn-sm zhino-btn-save" @click="saveEdit">保存</button>
            <button class="zhino-btn-sm" @click="editingSection = null">取消</button>
          </div>
        </div>
        <template v-if="editingSection === 'personality'">
          <textarea v-model="editingText" class="zhino-textarea" rows="7" />
        </template>
        <template v-else>
          <div class="zhino-palette">
            <div v-if="dreamtalk.personality.baseColor" class="zhino-palette-row"><span class="zhino-palette-label">底色</span><span class="zhino-palette-val">{{ dreamtalk.personality.baseColor }}</span></div>
            <div v-if="dreamtalk.personality.mainColor" class="zhino-palette-row"><span class="zhino-palette-label">主色调</span><span class="zhino-palette-val">{{ dreamtalk.personality.mainColor }}</span></div>
            <div v-if="dreamtalk.personality.accent" class="zhino-palette-row"><span class="zhino-palette-label">点缀</span><span class="zhino-palette-val">{{ dreamtalk.personality.accent }}</span></div>
            <div v-if="dreamtalk.personality.derivations.length > 0">
              <div class="zhino-v2-label" style="margin-top:4px">衍生</div>
              <div v-for="(d, i) in dreamtalk.personality.derivations" :key="i" class="zhino-behavior-item zhino-behavior-pattern">{{ d }}</div>
            </div>
            <div v-if="dreamtalk.personality.boundary" class="zhino-palette-row" style="margin-top:4px"><span class="zhino-palette-label">边界</span><span class="zhino-palette-val boundary">{{ dreamtalk.personality.boundary }}</span></div>
          </div>
        </template>
      </div>

      <!-- 肢体接触 -->
      <div class="zhino-section">
        <div class="zhino-section-header">
          <div class="zhino-section-title">肢体接触</div>
          <button v-if="editingSection !== 'bodyContact'" class="zhino-btn-sm" @click="startEdit('bodyContact')">编辑</button>
          <div v-else class="zhino-btn-group">
            <button class="zhino-btn-sm zhino-btn-save" @click="saveEdit">保存</button>
            <button class="zhino-btn-sm" @click="editingSection = null">取消</button>
          </div>
        </div>
        <template v-if="editingSection === 'bodyContact'">
          <textarea v-model="editingText" class="zhino-textarea" rows="6" />
        </template>
        <template v-else>
          <div v-if="dreamtalk.bodyContact.entries.length > 0" class="zhino-v2-block">
            <div v-for="(e, i) in dreamtalk.bodyContact.entries" :key="i" class="zhino-entry-row">
              <span class="zhino-entry-text">{{ e.text }}</span>
              <span v-if="e.prevent" class="zhino-entry-prevent">{{ e.prevent }}</span>
            </div>
          </div>
          <div v-else class="zhino-empty-hint">暂无数据</div>
        </template>
      </div>

      <!-- 说话方式 -->
      <div class="zhino-section">
        <div class="zhino-section-header">
          <div class="zhino-section-title">说话方式</div>
          <button v-if="editingSection !== 'speech'" class="zhino-btn-sm" @click="startEdit('speech')">编辑</button>
          <div v-else class="zhino-btn-group">
            <button class="zhino-btn-sm zhino-btn-save" @click="saveEdit">保存</button>
            <button class="zhino-btn-sm" @click="editingSection = null">取消</button>
          </div>
        </div>
        <template v-if="editingSection === 'speech'">
          <textarea v-model="editingText" class="zhino-textarea" rows="8" />
        </template>
        <template v-else>
          <div v-if="dreamtalk.speechStyle.entries.length > 0" class="zhino-v2-block">
            <div v-for="(e, i) in dreamtalk.speechStyle.entries" :key="i" class="zhino-entry-row">
              <span class="zhino-entry-text">{{ e.text }}</span>
              <span v-if="e.prevent" class="zhino-entry-prevent">{{ e.prevent }}</span>
            </div>
          </div>
          <div v-else class="zhino-empty-hint">暂无数据</div>
        </template>
      </div>

      <!-- 情绪表达 -->
      <div class="zhino-section">
        <div class="zhino-section-header">
          <div class="zhino-section-title">情绪表达</div>
          <button v-if="editingSection !== 'emotion'" class="zhino-btn-sm" @click="startEdit('emotion')">编辑</button>
          <div v-else class="zhino-btn-group">
            <button class="zhino-btn-sm zhino-btn-save" @click="saveEdit">保存</button>
            <button class="zhino-btn-sm" @click="editingSection = null">取消</button>
          </div>
        </div>
        <template v-if="editingSection === 'emotion'">
          <textarea v-model="editingText" class="zhino-textarea" rows="6" />
        </template>
        <template v-else>
          <div v-if="Object.keys(dreamtalk.emotionExpression).length > 0" class="zhino-v2-block">
            <div v-for="(e, name) in dreamtalk.emotionExpression" :key="name" class="zhino-emotion-row">
              <span class="zhino-emotion-name">{{ name }}</span>
              <span class="zhino-emotion-shows">{{ e.shows }}</span>
              <span class="zhino-emotion-prevent">{{ e.prevent }}</span>
            </div>
          </div>
          <div v-else class="zhino-empty-hint">暂无数据</div>
        </template>
      </div>

      <!-- 角色交互模式 -->
      <div class="zhino-section">
        <div class="zhino-section-title">角色交互模式 ({{ interactionCharacters.length }})</div>
        <div class="zhino-char-tabs">
          <button
            v-for="name in interactionCharacters"
            :key="name"
            class="zhino-char-tab"
            :class="{ active: selectedInteractionChar === name && !editingSection?.startsWith('char:') || editingSection === 'char:' + name }"
            @click="selectedInteractionChar = name; editingSection = null"
          >{{ name }}</button>
        </div>

        <template v-if="selectedInteraction">
          <div class="zhino-interaction-header">
            <span class="zhino-detail-label">与 {{ selectedInteractionChar }} 的交互：</span>
            <button v-if="editingSection !== 'char:' + selectedInteractionChar" class="zhino-btn-sm" @click="startEdit('char:' + selectedInteractionChar)">编辑</button>
            <div v-else class="zhino-btn-group">
              <button class="zhino-btn-sm zhino-btn-save" @click="saveEdit">保存</button>
              <button class="zhino-btn-sm" @click="editingSection = null">取消</button>
            </div>
          </div>
          <template v-if="editingSection === 'char:' + selectedInteractionChar">
            <textarea v-model="editingText" class="zhino-textarea" rows="5" />
          </template>
          <template v-else>
            <div class="zhino-v2-block">
              <div v-if="selectedInteraction.entries.length > 0">
                <div v-for="(e, i) in selectedInteraction.entries" :key="i" class="zhino-entry-row">
                  <span class="zhino-entry-text">{{ e.scenario ? e.scenario + ': ' + e.text : e.text }}</span>
                  <span v-if="e.prevent" class="zhino-entry-prevent">{{ e.prevent }}</span>
                </div>
              </div>
              <div v-else class="zhino-empty-hint">暂无数据</div>
            </div>
          </template>
        </template>
      </div>

      <!-- Roll偏好 -->
      <div class="zhino-section">
        <div class="zhino-section-title">Roll偏好</div>
        <div class="zhino-roll-block">
          <div class="zhino-interaction-header">
            <span class="zhino-roll-label like">喜欢：</span>
            <button v-if="!isEditingRollLikes" class="zhino-btn-sm" @click="startEditRollLikes">编辑</button>
            <div v-else class="zhino-btn-group">
              <button class="zhino-btn-sm zhino-btn-save" @click="saveRollLikes">保存</button>
              <button class="zhino-btn-sm" @click="isEditingRollLikes = false">取消</button>
            </div>
          </div>
          <template v-if="isEditingRollLikes">
            <textarea v-model="editingRollLikes" class="zhino-textarea" rows="4" />
          </template>
          <template v-else>
            <div v-if="dreamtalk.rollLikes.length > 0" class="zhino-behavior-list">
              <div v-for="(item, idx) in dreamtalk.rollLikes" :key="idx" class="zhino-behavior-item zhino-roll-like">{{ item }}</div>
            </div>
            <div v-else class="zhino-empty-hint">暂无数据</div>
          </template>
        </div>

        <div class="zhino-roll-block">
          <div class="zhino-interaction-header">
            <span class="zhino-roll-label dislike">不喜欢：</span>
            <button v-if="!isEditingRollDislikes" class="zhino-btn-sm" @click="startEditRollDislikes">编辑</button>
            <div v-else class="zhino-btn-group">
              <button class="zhino-btn-sm zhino-btn-save" @click="saveRollDislikes">保存</button>
              <button class="zhino-btn-sm" @click="isEditingRollDislikes = false">取消</button>
            </div>
          </div>
          <template v-if="isEditingRollDislikes">
            <textarea v-model="editingRollDislikes" class="zhino-textarea" rows="4" />
          </template>
          <template v-else>
            <div v-if="dreamtalk.rollDislikes.length > 0" class="zhino-behavior-list">
              <div v-for="(item, idx) in dreamtalk.rollDislikes" :key="idx" class="zhino-behavior-item zhino-roll-dislike">{{ item }}</div>
            </div>
            <div v-else class="zhino-empty-hint">暂无数据</div>
          </template>
        </div>
      </div>

      <!-- 底部操作 -->
      <div class="zhino-section">
        <button class="zhino-btn-sm" style="color:#ff6b6b;border:1px solid rgba(255,100,100,0.3)" @click="store.rollbackDreamtalk()">撤回梦呓</button>
        <button class="zhino-btn-sm" style="color:#4caf50;border:1px solid rgba(76,175,80,0.3)" @click="store.restoreDreamtalk()">恢复梦呓</button>
        <button class="zhino-btn" :disabled="store.dreamtalkInProgress || store.userInputRecords.length === 0" @click="triggerAnalysis">
          {{ store.dreamtalkInProgress ? '分析中...' : '重新分析' }}
        </button>
        <div class="zhino-meta">v{{ dreamtalk.version }} · {{ dreamtalk.generatedAt }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.zhino-dreamtalk { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.zhino-section { background: var(--zn-bg-surface1); border: 1px solid var(--zn-border-light); border-radius: 8px; padding: 10px 12px; }
.zhino-section-title { font-size: 12px; font-weight: 600; color: var(--zn-text-regular); margin-bottom: 8px; letter-spacing: 0.5px; }
.zhino-section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.zhino-info-value { font-size: 13px; color: rgba(var(--zn-accent-rgb), 0.9); font-weight: 500; }
.zhino-behavior-list { display: flex; flex-direction: column; gap: 4px; }
.zhino-behavior-item { font-size: 12px; color: var(--zn-text-regular); padding: 4px 8px; background: var(--zn-bg-surface1); border: 1px solid var(--zn-border-light); border-radius: 4px; }

/* v2 样式 */
.zhino-v2-block { display: flex; flex-direction: column; gap: 3px; }
.zhino-v2-label { font-size: 10px; color: var(--zn-text-muted); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px; }
.zhino-v2-prevent-label { color: rgba(var(--zn-danger-rgb), 0.4); margin-top: 6px; }

/* 配对条目 */
.zhino-entry-row { display: flex; flex-direction: column; gap: 1px; padding: 3px 8px; background: var(--zn-bg-surface1); border-radius: 4px; border-left: 2px solid rgba(var(--zn-accent-rgb), 0.3); margin-bottom: 2px; }
.zhino-entry-text { font-size: 12px; color: var(--zn-text-regular); }
.zhino-entry-prevent { font-size: 10px; color: rgba(var(--zn-danger-rgb), 0.5); font-style: italic; }

/* 情绪表达 */
.zhino-emotion-row { display: flex; align-items: baseline; gap: 6px; padding: 3px 8px; background: var(--zn-bg-surface1); border-radius: 4px; border-left: 2px solid rgba(var(--zn-warn-rgb), 0.3); margin-bottom: 2px; font-size: 12px; }
.zhino-emotion-name { color: rgba(var(--zn-warn-rgb), 0.8); font-weight: 500; min-width: 32px; }
.zhino-emotion-shows { color: var(--zn-text-regular); flex: 1; }
.zhino-emotion-prevent { color: rgba(var(--zn-danger-rgb), 0.45); font-size: 10px; font-style: italic; }

/* 基础信息 */
.zhino-userinfo-grid { display: flex; flex-direction: column; gap: 3px; }
.zhino-userinfo-row { display: flex; gap: 6px; align-items: baseline; padding: 2px 4px; font-size: 12px; }
.zhino-userinfo-label { color: rgba(var(--zn-accent-rgb), 0.5); font-size: 10px; min-width: 36px; }
.zhino-userinfo-val { color: var(--zn-text-regular); }

/* 性格调色盘 */
.zhino-palette { display: flex; flex-direction: column; gap: 2px; }
.zhino-palette-row { display: flex; gap: 6px; align-items: baseline; padding: 2px 4px; font-size: 12px; }
.zhino-palette-label { color: rgba(var(--zn-warn-rgb), 0.6); font-size: 10px; min-width: 36px; }
.zhino-palette-val { color: var(--zn-text-primary); }
.zhino-palette-val.boundary { color: rgba(var(--zn-warn-rgb), 0.7); font-style: italic; }

.zhino-behavior-item.zhino-roll-like { border-left-color: rgba(var(--zn-success-rgb), 0.4); }
.zhino-behavior-item.zhino-roll-dislike { border-left-color: rgba(var(--zn-danger-rgb), 0.4); }
.zhino-roll-block { margin-bottom: 10px; }
.zhino-roll-block:last-child { margin-bottom: 0; }
.zhino-roll-label { font-weight: 500; font-size: 12px; flex-shrink: 0; }
.zhino-roll-label.like { color: var(--zn-success); }
.zhino-roll-label.dislike { color: var(--zn-danger); }
.zhino-char-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.zhino-char-tab { padding: 3px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--zn-border-base); background: var(--zn-bg-surface1); color: var(--zn-text-regular); cursor: pointer; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
.zhino-char-tab:hover { background: rgba(var(--zn-accent-rgb), 0.08); }
.zhino-char-tab.active { background: rgba(var(--zn-accent-rgb), 0.15); border-color: rgba(var(--zn-accent-rgb), 0.3); color: rgba(var(--zn-accent-rgb), 0.9); }
.zhino-interaction-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.zhino-meta { font-size: 10px; color: var(--zn-text-muted); margin-top: 6px; }
.zhino-empty-hint { font-size: 12px; color: var(--zn-text-muted); margin-bottom: 8px; }
.zhino-textarea { width: 100%; background: var(--zn-bg-surface1); border: 1px solid var(--zn-border-base); border-radius: 6px; padding: 8px; font-size: 12px; color: var(--zn-text-primary); resize: vertical; outline: none; font-family: inherit; box-sizing: border-box; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
.zhino-textarea:focus { border-color: var(--zn-primary); }
.zhino-detail-label { color: var(--zn-text-muted); font-size: 11px; }

/* 按钮 */
.zhino-btn { padding: 6px 14px; font-size: 12px; font-weight: 500; border-radius: 6px; border: 1px solid var(--zn-border-base); background: transparent; color: var(--zn-text-regular); cursor: pointer; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
.zhino-btn:hover:not(:disabled) { background: var(--zn-bg-surface2); color: var(--zn-text-primary); border-color: var(--zn-border-light); }
.zhino-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.zhino-btn-sm { padding: 4px 10px; font-size: 11px; border-radius: 4px; border: 1px solid var(--zn-border-base); background: var(--zn-bg-surface1); color: var(--zn-text-regular); cursor: pointer; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
.zhino-btn-sm:hover { background: var(--zn-bg-surface2); color: var(--zn-text-primary); }
.zhino-btn-save { border-color: rgba(var(--zn-accent-rgb), 0.3); color: rgba(var(--zn-accent-rgb), 0.9); }
.zhino-btn-save:hover { background: rgba(var(--zn-accent-rgb), 0.15); }
.zhino-btn-group { display: flex; gap: 4px; }

/* 游玩类型选择 */
.zhino-playstyle-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; align-items: center; }
.zhino-playstyle-label { font-size: 12px; color: var(--zn-text-regular); }
.zhino-playstyle-radio { font-size: 11px; color: var(--zn-text-regular); cursor: pointer; display: flex; align-items: center; gap: 3px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--zn-border-base); background: var(--zn-bg-surface1); transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
.zhino-playstyle-radio:hover { background: var(--zn-bg-surface2); border-color: var(--zn-border-light); }
.zhino-playstyle-radio input[type="radio"] { accent-color: var(--zn-accent); margin: 0; }
.zhino-playstyle-hint { font-size: 10px; color: var(--zn-text-muted); margin-top: 4px; }
</style>
