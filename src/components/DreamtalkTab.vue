<script setup lang="ts">
import { useMainStore } from '../stores/mainStore';
import { executeDreamtalkAnalysis } from '../core/dreamtalk';

const store = useMainStore();

// 编辑状态
const editingSection = ref<string | null>(null); // 'bodyContact' | 'speech' | 'emotion' | 'char:name'
const selectedInteractionChar = ref('');
const editingText = ref('');

const isEditingRollLikes = ref(false);
const isEditingRollDislikes = ref(false);
const editingRollLikes = ref('');
const editingRollDislikes = ref('');

const dreamtalk = computed(() => store.dreamtalk);

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
  const dt = dreamtalk.value;

  if (section === 'bodyContact') {
    editingText.value = [
      '--- 行为 ---',
      ...dt.bodyContact.patterns,
      '--- 禁止误读 ---',
      ...dt.bodyContact.prevent,
    ].join('\n');
  } else if (section === 'speech') {
    editingText.value = [
      '--- 行为 ---',
      ...dt.speechStyle.patterns,
      '--- 禁止误读 ---',
      ...dt.speechStyle.prevent,
    ].join('\n');
  } else if (section === 'emotion') {
    editingText.value = Object.entries(dt.emotionExpression)
      .map(([name, e]) => `${name}: ${e.shows} | ${e.prevent}`)
      .join('\n');
  } else if (section.startsWith('char:')) {
    const charName = section.slice(5);
    selectedInteractionChar.value = charName;
    const interaction = dt.characterInteractions.find(i => i.characterName === charName);
    if (interaction) {
      editingText.value = [
        '--- 行为 ---',
        ...interaction.behaviors,
        '--- 禁止误读 ---',
        ...interaction.prevent,
      ].join('\n');
    }
  }
  editingSection.value = section;
}

function saveEdit() {
  if (!dreamtalk.value) return;
  const dt = dreamtalk.value as any;

  const lines = editingText.value.split('\n').map(l => l.trim());
  let inBehavior = false;
  let inPrevent = false;
  const patterns: string[] = [];
  const prevent: string[] = [];

  for (const line of lines) {
    if (!line) continue;
    if (line === '--- 行为 ---') { inBehavior = true; inPrevent = false; continue; }
    if (line === '--- 禁止误读 ---') { inBehavior = false; inPrevent = true; continue; }
    if (inBehavior) patterns.push(line);
    else if (inPrevent) prevent.push(line);
  }

  const section = editingSection.value;
  if (section === 'bodyContact') {
    dt.bodyContact = { patterns, prevent };
  } else if (section === 'speech') {
    dt.speechStyle = { patterns, prevent };
  } else if (section === 'emotion') {
    const emotions: Record<string, any> = {};
    for (const line of lines) {
      const m = line.match(/^([^:：]+)[:：]\s*(.+?)\s*\|\s*(.+)/);
      if (m) {
        const name = m[1].trim();
        if (name) emotions[name] = { shows: m[2].trim(), prevent: m[3].trim() };
      }
    }
    dt.emotionExpression = emotions;
  } else if (section?.startsWith('char:')) {
    const idx = dt.characterInteractions.findIndex(
      (i: any) => i.characterName === selectedInteractionChar.value,
    );
    if (idx !== -1) {
      dt.characterInteractions[idx].behaviors = patterns;
      dt.characterInteractions[idx].prevent = prevent;
    }
  }

  store.updateDreamtalk({ ...dt });
  editingSection.value = null;
  console.info('[智脑] 已保存');
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

// 手动触发分析
async function triggerAnalysis() {
  if (store.userInputRecords.length === 0) {
    console.info('[智脑] 没有可用的用户输入记录');
    return;
  }
  store.setDreamtalkInProgress(true);
  console.info('[智脑] 手动触发梦呓分析...');
  try {
    const { dreamtalk: result, nsfwDreamtalk } = await executeDreamtalkAnalysis(store.userInputRecords, store.persona.rawInput || '');
    store.updateDreamtalk(result);
    if (nsfwDreamtalk) store.updateNsfwDreamtalk(nsfwDreamtalk);
    console.info(`[智脑] 梦呓分析完成 (${result.characterInteractions.length} 角色交互模式)`);
  } catch (error) {
    console.error('[智脑] 梦呓分析失败:', error);
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
      <button class="zhino-btn" :disabled="store.dreamtalkInProgress || store.userInputRecords.length === 0" @click="triggerAnalysis">
        {{ store.dreamtalkInProgress ? '分析中...' : '手动分析' }}
      </button>
    </div>

    <template v-else>
      <!-- 游玩类型 -->
      <div class="zhino-section">
        <div class="zhino-section-title">游玩类型</div>
        <div class="zhino-info-value">{{ dreamtalk.playStyle }}</div>
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
          <div v-if="dreamtalk.bodyContact.patterns.length > 0" class="zhino-v2-block">
            <div class="zhino-v2-label">行为：</div>
            <div v-for="(p, i) in dreamtalk.bodyContact.patterns" :key="i" class="zhino-behavior-item zhino-behavior-pattern">{{ p }}</div>
            <template v-if="dreamtalk.bodyContact.prevent.length > 0">
              <div class="zhino-v2-label zhino-v2-prevent-label">禁止误读：</div>
              <div v-for="(p, i) in dreamtalk.bodyContact.prevent" :key="i" class="zhino-behavior-item zhino-behavior-prevent">{{ p }}</div>
            </template>
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
          <div v-if="dreamtalk.speechStyle.patterns.length > 0" class="zhino-v2-block">
            <div class="zhino-v2-label">行为：</div>
            <div v-for="(p, i) in dreamtalk.speechStyle.patterns" :key="i" class="zhino-behavior-item zhino-behavior-pattern">{{ p }}</div>
            <template v-if="dreamtalk.speechStyle.prevent.length > 0">
              <div class="zhino-v2-label zhino-v2-prevent-label">禁止误读：</div>
              <div v-for="(p, i) in dreamtalk.speechStyle.prevent" :key="i" class="zhino-behavior-item zhino-behavior-prevent">{{ p }}</div>
            </template>
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
              <div v-if="selectedInteraction.behaviors.length > 0">
                <div v-for="(b, i) in selectedInteraction.behaviors" :key="i" class="zhino-behavior-item zhino-behavior-pattern">{{ b }}</div>
              </div>
              <template v-if="selectedInteraction.prevent.length > 0">
                <div class="zhino-v2-label zhino-v2-prevent-label">禁止误读：</div>
                <div v-for="(p, i) in selectedInteraction.prevent" :key="i" class="zhino-behavior-item zhino-behavior-prevent">{{ p }}</div>
              </template>
              <div v-if="selectedInteraction.behaviors.length === 0 && selectedInteraction.prevent.length === 0" class="zhino-empty-hint">暂无数据</div>
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
.zhino-dreamtalk { display: flex; flex-direction: column; gap: 12px; }
.zhino-section { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; padding: 10px 12px; }
.zhino-section-title { font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.6); margin-bottom: 8px; }
.zhino-section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.zhino-info-value { font-size: 13px; color: rgba(167,139,250,0.9); font-weight: 500; }
.zhino-behavior-list { display: flex; flex-direction: column; gap: 4px; }
.zhino-behavior-item { font-size: 12px; color: rgba(255,255,255,0.7); padding: 4px 8px; background: rgba(255,255,255,0.03); border-radius: 4px; }

/* v2 样式 */
.zhino-v2-block { display: flex; flex-direction: column; gap: 3px; }
.zhino-v2-label { font-size: 10px; color: rgba(255,255,255,0.3); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px; }
.zhino-v2-prevent-label { color: rgba(248,113,113,0.4); margin-top: 6px; }
.zhino-behavior-pattern { border-left: 2px solid rgba(167,139,250,0.3); }
.zhino-behavior-prevent { border-left: 2px solid rgba(248,113,113,0.25); font-size: 11px; color: rgba(248,113,113,0.55); font-style: italic; }

/* 情绪表达 */
.zhino-emotion-row { display: flex; align-items: baseline; gap: 6px; padding: 3px 8px; background: rgba(255,255,255,0.02); border-radius: 4px; border-left: 2px solid rgba(252,211,77,0.3); margin-bottom: 2px; font-size: 12px; }
.zhino-emotion-name { color: rgba(252,211,77,0.8); font-weight: 500; min-width: 32px; }
.zhino-emotion-shows { color: rgba(255,255,255,0.7); flex: 1; }
.zhino-emotion-prevent { color: rgba(248,113,113,0.45); font-size: 10px; font-style: italic; }

.zhino-behavior-item.zhino-roll-like { border-left-color: rgba(74,222,128,0.4); }
.zhino-behavior-item.zhino-roll-dislike { border-left-color: rgba(248,113,113,0.4); }
.zhino-roll-block { margin-bottom: 10px; }
.zhino-roll-block:last-child { margin-bottom: 0; }
.zhino-roll-label { font-weight: 500; font-size: 12px; flex-shrink: 0; }
.zhino-roll-label.like { color: #4ade80; }
.zhino-roll-label.dislike { color: #f87171; }
.zhino-char-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.zhino-char-tab { padding: 3px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03); color: rgba(255,255,255,0.6); cursor: pointer; transition: all 0.15s; }
.zhino-char-tab:hover { background: rgba(167,139,250,0.08); }
.zhino-char-tab.active { background: rgba(167,139,250,0.15); border-color: rgba(167,139,250,0.3); color: rgba(167,139,250,0.9); }
.zhino-interaction-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.zhino-meta { font-size: 10px; color: rgba(255,255,255,0.3); margin-top: 6px; }
.zhino-empty-hint { font-size: 12px; color: rgba(255,255,255,0.3); margin-bottom: 8px; }
.zhino-textarea { width: 100%; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 8px; font-size: 12px; color: rgba(255,255,255,0.85); resize: vertical; outline: none; font-family: inherit; box-sizing: border-box; }
.zhino-textarea:focus { border-color: rgba(167,139,250,0.4); }
.zhino-detail-label { color: rgba(255,255,255,0.4); font-size: 11px; }
.zhino-btn { padding: 6px 14px; font-size: 12px; font-weight: 500; border-radius: 6px; border: 1px solid rgba(167,139,250,0.25); background: rgba(167,139,250,0.08); color: rgba(167,139,250,0.9); cursor: pointer; transition: all 0.15s; }
.zhino-btn:hover:not(:disabled) { background: rgba(167,139,250,0.18); border-color: rgba(167,139,250,0.4); }
.zhino-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.zhino-btn-sm { padding: 3px 10px; font-size: 11px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.6); cursor: pointer; transition: all 0.15s; }
.zhino-btn-sm:hover { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.9); }
.zhino-btn-save { border-color: rgba(167,139,250,0.3); color: rgba(167,139,250,0.9); }
.zhino-btn-save:hover { background: rgba(167,139,250,0.15); }
.zhino-btn-group { display: flex; gap: 4px; }
</style>
