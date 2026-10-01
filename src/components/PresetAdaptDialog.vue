<template>
  <Modal :visible="visible" :is-mobile="isMobile" title="预设适配" max-width="760px" @close="emit('close')">
    <div class="zn-adapt-wrap">
      <!-- ① 插入智脑条目 -->
      <section class="zn-adapt-block">
        <div class="zn-adapt-block-title"><span class="zn-adapt-step">1</span>插入智脑条目</div>
        <p class="zn-adapt-desc">
          把智脑的槽位条目插进「当前正在使用的预设」的合适位置，生成一个「原名（智脑适配）」的新预设。
          <b>不会改动你的原预设</b>，适配完去预设列表切过去即可。
        </p>
        <button class="zn-adapt-btn" :disabled="adapting" @click="adaptPreset">
          {{ adapting ? '适配中…' : '适配当前预设' }}
        </button>
        <div v-if="adaptResult" class="zn-adapt-result" :class="adaptOk ? 'is-ok' : 'is-bad'">{{ adaptResult }}</div>
        <details v-if="adaptDetails.length" class="zn-adapt-details">
          <summary>插入明细（{{ adaptDetails.length }} 条）</summary>
          <div v-for="(d, i) in adaptDetails" :key="i" class="zn-adapt-row">
            <span class="zn-adapt-name">{{ d.name }}</span>
            <span class="zn-adapt-arrow">→</span>
            <span :class="{ 'is-weak': !d.confident }">{{ d.target }}</span>
          </div>
          <div class="zn-adapt-desc" style="margin-top:4px">
            黄色 = 该组没找到锚点，用了兜底位置，可能需要手动挪一下。
          </div>
        </details>
      </section>

      <!-- ② 输出标签 -->
      <section class="zn-adapt-block">
        <div class="zn-adapt-block-title"><span class="zn-adapt-step">2</span>输出标签（按你的预设填）</div>
        <p class="zn-adapt-desc">
          智脑靠标签从 AI 回复里切出<b>思维链 / 正文 / 时间</b>三块。填了智脑就能读懂你的预设；
          <b>留空 = 用智脑内置默认</b>。同一类填多个时，<b>只要正文里出现其中任意一个标签，智脑就会读它</b>。
        </p>

        <div class="zn-adapt-field">
          <label class="zn-adapt-label">思维链标签</label>
          <textarea
            v-model="tagThinking"
            class="zn-adapt-input"
            rows="2"
            placeholder="如 thinking_left, thinking_right（留空 = 内置默认）"
            aria-label="思维链标签"
          />
        </div>
        <div class="zn-adapt-field">
          <label class="zn-adapt-label">正文标签</label>
          <textarea
            v-model="tagContent"
            class="zn-adapt-input"
            rows="2"
            placeholder="如 content（留空 = 默认 content）"
            aria-label="正文标签"
          />
        </div>
        <div class="zn-adapt-field">
          <label class="zn-adapt-label">时间标签</label>
          <textarea
            v-model="tagTime"
            class="zn-adapt-input"
            rows="2"
            placeholder="如 time（留空 = 默认 time）"
            aria-label="时间标签"
          />
        </div>

        <details class="zn-adapt-details" open>
          <summary>填什么格式？（示例）</summary>
          <div class="zn-adapt-demo">
            <div class="zn-adapt-demo-row">
              <code>content</code><span>→ 读取 &lt;content&gt;正文&lt;/content&gt;</span>
            </div>
            <div class="zn-adapt-demo-row">
              <code>time</code><span>→ 读取 &lt;time&gt;时间&lt;/time&gt;</span>
            </div>
            <div class="zn-adapt-demo-row">
              <code>thinking_left</code><span>→ 读取 &lt;thinking_left&gt;…&lt;/thinking_left&gt;</span>
            </div>
          </div>
          <ul class="zn-adapt-tips">
            <li>只写标签名，<b>尖括号不用写</b>（填 &lt;content&gt; 也会自动认）。</li>
            <li>多个标签：<b>换行、逗号、顿号</b> 分隔都行。</li>
            <li>
              填了是「<b>追加</b>」而不是替换 —— 内置默认（星光预设的 thinking_left / thinking_right /
              thinking_love / thinking_director，老预设的 [metacognition] 那套）依然生效，不会把老预设搞丢。
            </li>
            <li>存的是<b>全局设置</b>，换聊天、换角色卡都保留。</li>
          </ul>
        </details>

        <div class="zn-adapt-current">
          <div>当前生效 · 正文：<code>{{ activeTags.contentTags.join(' / ') }}</code></div>
          <div>当前生效 · 时间：<code>{{ activeTags.timeTags.join(' / ') }}</code></div>
          <div>当前生效 · 思维链：<code>{{ activeTags.angleChainTags.join(' / ') }}</code></div>
        </div>

        <div class="zn-adapt-actions">
          <button class="zn-adapt-btn" @click="saveTags">保存</button>
          <button class="zn-adapt-btn zn-adapt-btn-ghost" @click="resetTags">恢复默认</button>
          <span v-if="saveHint" class="zn-adapt-save-hint">{{ saveHint }}</span>
        </div>
      </section>
    </div>
  </Modal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import Modal from './ui/Modal.vue';
import { useMainStore } from '../stores/mainStore';
import { adaptCurrentPresetInTavern } from '../core/presetAdapter';
import { applyCustomOutputTags, getMessageParserTags, type MessageParserTags } from '../utils/messageParser';
import { logInfo } from '../utils/logger';

const props = withDefaults(defineProps<{ visible: boolean; isMobile?: boolean }>(), { isMobile: false });
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useMainStore();

// ── ① 插入智脑条目 ──
const adapting = ref(false);
const adaptResult = ref('');
const adaptOk = ref(false);
const adaptDetails = ref<Array<{ name: string; target: string; confident: boolean }>>([]);

async function adaptPreset() {
  if (adapting.value) return;
  adapting.value = true;
  adaptResult.value = '';
  adaptDetails.value = [];
  try {
    const r = await adaptCurrentPresetInTavern();
    adaptOk.value = r.ok;
    adaptResult.value = r.message;
    adaptDetails.value = (r.details || []).map((d) => ({ name: d.name, target: d.target, confident: d.confident }));
    logInfo('预设适配', r.message);
  } catch (e: any) {
    adaptOk.value = false;
    adaptResult.value = `适配失败：${e?.message || e}`;
  } finally {
    adapting.value = false;
  }
}

// ── ② 输出标签 ──
const tagThinking = ref('');
const tagContent = ref('');
const tagTime = ref('');
const saveHint = ref('');
const activeTags = ref<MessageParserTags>(getMessageParserTags());

function loadTagsFromSettings() {
  const t = (store.settings as any).outputTags || {};
  tagThinking.value = (t.thinking || []).join(', ');
  tagContent.value = (t.content || []).join(', ');
  tagTime.value = (t.time || []).join(', ');
  saveHint.value = '';
  activeTags.value = getMessageParserTags();
}

/** 支持换行 / 逗号 / 顿号 / 分号分隔 */
function splitTags(text: string): string[] {
  return String(text || '')
    .split(/[\n,，、;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function saveTags() {
  const outputTags = {
    thinking: splitTags(tagThinking.value),
    content: splitTags(tagContent.value),
    time: splitTags(tagTime.value),
  };
  store.updateSettings({ outputTags } as any);
  applyCustomOutputTags(outputTags);
  activeTags.value = getMessageParserTags();
  saveHint.value = '已保存并立即生效';
  logInfo(
    '预设适配',
    `输出标签已保存：正文 ${outputTags.content.length} 项 / 时间 ${outputTags.time.length} 项 / 思维链 ${outputTags.thinking.length} 项（留空项走内置默认）`,
  );
}

function resetTags() {
  tagThinking.value = '';
  tagContent.value = '';
  tagTime.value = '';
  saveTags();
  saveHint.value = '已恢复内置默认';
}

// 每次打开时同步一次当前设置（别的会话/设备改过也能刷新到）
watch(() => props.visible, (v) => {
  if (v) loadTagsFromSettings();
});
</script>

<style scoped>
.zn-adapt-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--zn-space-5);
}

.zn-adapt-block {
  display: flex;
  flex-direction: column;
  gap: var(--zn-space-2);
}

.zn-adapt-block-title {
  display: flex;
  align-items: center;
  gap: var(--zn-space-2);
  font-size: var(--zn-fs-title);
  font-weight: 600;
  color: var(--zn-text-primary);
}

.zn-adapt-step {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--zn-radius-pill);
  background: rgba(var(--zn-accent-rgb), 0.18);
  color: rgba(var(--zn-accent-rgb), 1);
  font-size: 11px;
  font-weight: 700;
}

.zn-adapt-desc {
  margin: 0;
  font-size: var(--zn-fs-body);
  line-height: 1.7;
  color: var(--zn-text-muted);
}

.zn-adapt-desc b {
  color: var(--zn-text-regular);
}

.zn-adapt-btn {
  align-self: flex-start;
  padding: 6px 14px;
  font-size: var(--zn-fs-body);
  color: var(--zn-text-primary);
  background: var(--zn-bg-surface2);
  border: 1px solid var(--zn-border-base);
  border-radius: var(--zn-radius-sm);
  cursor: pointer;
  transition: all var(--zn-dur) var(--zn-ease);
}

.zn-adapt-btn:hover:not(:disabled) {
  background: rgba(var(--zn-accent-rgb), 0.16);
  border-color: var(--zn-accent);
}

.zn-adapt-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.zn-adapt-btn-ghost {
  background: transparent;
}

.zn-adapt-result {
  font-size: var(--zn-fs-body);
  line-height: 1.7;
  padding: var(--zn-space-2) var(--zn-space-3);
  border-radius: var(--zn-radius-sm);
  background: var(--zn-bg-surface1);
}

.zn-adapt-result.is-ok {
  color: rgba(var(--zn-accent-rgb), 1);
}

.zn-adapt-result.is-bad {
  color: rgba(var(--zn-warn-rgb), 1);
}

.zn-adapt-details {
  font-size: var(--zn-fs-body);
  color: var(--zn-text-muted);
}

.zn-adapt-details > summary {
  cursor: pointer;
  color: var(--zn-text-regular);
  padding: 2px 0;
}

.zn-adapt-row {
  display: flex;
  align-items: baseline;
  gap: var(--zn-space-2);
  padding: 3px 0;
  border-bottom: 1px dashed var(--zn-border-base);
}

.zn-adapt-name {
  flex: 0 0 auto;
  color: var(--zn-text-regular);
}

.zn-adapt-arrow {
  color: var(--zn-text-muted);
}

.zn-adapt-row .is-weak {
  color: rgba(var(--zn-warn-rgb), 1);
}

.zn-adapt-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: var(--zn-space-1);
}

.zn-adapt-label {
  font-size: var(--zn-fs-body);
  color: var(--zn-text-regular);
}

.zn-adapt-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  font-family: var(--zn-font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--zn-text-primary);
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-base);
  border-radius: var(--zn-radius-sm);
  outline: none;
  resize: vertical;
}

.zn-adapt-input:focus {
  border-color: var(--zn-accent);
}

.zn-adapt-input::placeholder {
  color: var(--zn-text-muted);
}

.zn-adapt-demo {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--zn-space-2) 0;
}

.zn-adapt-demo-row {
  display: flex;
  align-items: baseline;
  gap: var(--zn-space-2);
}

.zn-adapt-demo-row code,
.zn-adapt-current code {
  font-family: var(--zn-font-mono);
  font-size: 12px;
  color: rgba(var(--zn-accent-rgb), 1);
}

.zn-adapt-tips {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  line-height: 1.7;
}

.zn-adapt-tips b {
  color: var(--zn-text-regular);
}

.zn-adapt-current {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--zn-space-2);
  padding: var(--zn-space-2) var(--zn-space-3);
  font-size: 12px;
  color: var(--zn-text-muted);
  background: var(--zn-bg-surface1);
  border-radius: var(--zn-radius-sm);
  word-break: break-all;
}

.zn-adapt-actions {
  display: flex;
  align-items: center;
  gap: var(--zn-space-3);
  margin-top: var(--zn-space-2);
}

.zn-adapt-save-hint {
  font-size: 12px;
  color: rgba(var(--zn-accent-rgb), 1);
}
</style>
