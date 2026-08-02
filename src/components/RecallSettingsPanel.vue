<template>
  <div class="zhino-recall-wrap">
    <Collapsible v-model="showRecallSettings" title="召回设置">
      <!-- 召回设置面板 -->
      <div class="zhino-recall-row">
        <span class="zhino-recall-label">最近</span>
        <input
          type="number"
          class="zhino-recall-input"
          :value="store.settings.eventRecallRecent"
          min="0"
          max="20"
          @change="store.updateSettings({ eventRecallRecent: Number(($event.target as HTMLInputElement).value) })"
        />
        <span class="zhino-recall-label">轮总结全注入</span>
      </div>
      <div class="zhino-recall-row">
        <span class="zhino-recall-label">远期召回上限</span>
        <input
          type="number"
          class="zhino-recall-input"
          :value="store.settings.eventRecallLimit"
          min="1"
          max="30"
          @change="store.updateSettings({ eventRecallLimit: Number(($event.target as HTMLInputElement).value) })"
        />
        <span class="zhino-recall-label">条</span>
      </div>
      <div class="zhino-recall-hint">
        近期事件直接注入，远期事件触发匹配后多维打分排序（匹配质量/时间近度/词密度/角色重叠），取上限条数
      </div>

      <!-- 语义向量召回 -->
      <div class="zhino-recall-sep"></div>
      <div class="zhino-recall-section-title">智能语义召回</div>
      <div class="zhino-recall-hint">
        大总结后自动生成事件+核心记忆语义向量；小总结后自动为新增图谱节点（地点+物品）生成向量。注入时混合检索（语义相似度+词汇匹配）进行远期召回。
        <br/>生成向量时自动添加角色上下文注释，提高跨场景语义命中率。
        <br/>默认使用 SiliconFlow <code>BAAI/bge-m3</code>（1024维）。<br/>也可自定义节点地址，接入其他兼容 OpenAI Embedding API 的服务。
      </div>
      <label class="zhino-toggle-row">
        <span class="zhino-toggle-label">开启语义召回</span>
        <input type="checkbox"
          :checked="store.settings.embeddingEnabled"
          @change="store.updateSettings({ embeddingEnabled: ($event.target as HTMLInputElement).checked })"
        />
      </label>
      <label class="zhino-toggle-row" style="padding-left:16px">
        <span class="zhino-toggle-label">图谱节点向量化</span>
        <span class="zhino-toggle-desc">关闭后图谱节点不再生成向量，召回降级为名称+bigram匹配，省储存</span>
        <input type="checkbox"
          :checked="store.settings.kgEmbeddingEnabled !== false"
          @change="store.updateSettings({ kgEmbeddingEnabled: ($event.target as HTMLInputElement).checked })"
        />
      </label>
      <!-- 图谱向量化独立维度（0 = 跟随全局） -->
      <div class="zhino-recall-row" style="padding-left:16px" v-if="store.settings.embeddingEnabled && store.settings.kgEmbeddingEnabled !== false">
        <span class="zhino-recall-label">图谱维度</span>
        <select
          class="zhino-recall-input"
          :value="store.settings.kgEmbeddingDimensions"
          @change="store.updateSettings({ kgEmbeddingDimensions: Number(($event.target as HTMLSelectElement).value) })"
        >
          <option :value="0">跟随全局（{{ store.settings.embeddingDimensions }}维）</option>
          <option
            v-for="opt in kgDimOptions()"
            :key="opt.value"
            :value="opt.value"
          >{{ opt.label }}</option>
        </select>
        <span class="zhino-recall-hint" v-if="store.settings.kgEmbeddingDimensions !== 0" style="margin-left:8px">
          ⚠️ 改维度后需重新向量化图谱节点才能生效
        </span>
      </div>
      <template v-if="store.settings.embeddingEnabled">
        <div class="zhino-recall-row">
          <span class="zhino-recall-label">节点地址</span>
          <input
            class="zhino-recall-input url"
            :value="store.settings.embeddingApiUrl"
            @change="store.updateSettings({ embeddingApiUrl: ($event.target as HTMLInputElement).value })"
            placeholder="https://api.siliconflow.cn/v1/embeddings" aria-label="https://api.siliconflow.cn/v1/embeddings"
          />
        </div>
        <div class="zhino-recall-row">
          <span class="zhino-recall-label">API Key</span>
          <input
            type="password"
            class="zhino-recall-input key"
            :value="store.settings.embeddingApiKey"
            @change="store.updateSettings({ embeddingApiKey: ($event.target as HTMLInputElement).value })"
            placeholder="sk-..." aria-label="sk-..."
          />
        </div>
        <div class="zhino-recall-row">
          <span class="zhino-recall-label">模型</span>
          <input
            class="zhino-recall-input model-name"
            :value="store.settings.embeddingModel"
            @input="onModelChange(($event.target as HTMLInputElement).value)"
            placeholder="BAAI/bge-m3" aria-label="BAAI/bge-m3"
          />
        </div>
        <div class="zhino-recall-row">
          <span class="zhino-recall-label">维度</span>
          <select
            class="zhino-recall-input"
            :value="store.settings.embeddingDimensions"
            @change="store.updateSettings({ embeddingDimensions: Number(($event.target as HTMLSelectElement).value) })"
          >
            <option
              v-for="opt in embeddingDimOptions()"
              :key="opt.value"
              :value="opt.value"
            >{{ opt.label }}</option>
          </select>
        </div>
        <!-- 未知 / 已知不支持降维的模型：用户手动声明此模型实际支持 Matryoshka 降维 -->
        <label class="zhino-toggle-row" style="padding-left:16px" v-if="!modelSupportsMatryoshkaByDefault()">
          <span class="zhino-toggle-label">此模型支持 Matryoshka 降维</span>
          <span class="zhino-toggle-desc">仅当你的模型/渠道实际支持 dimensions 参数时勾选，勾选后展开降维档位并真正发送 dimensions</span>
          <input type="checkbox"
            :checked="store.settings.embeddingManualMatryoshka"
            @change="store.updateSettings({ embeddingManualMatryoshka: ($event.target as HTMLInputElement).checked })"
          />
        </label>
        <div class="zhino-recall-row">
          <span class="zhino-recall-label">相似度阈值</span>
          <input
            type="range" min="30" max="80" step="5"
            :value="Math.round(store.settings.embeddingSimilarityThreshold * 100)"
            @input="store.updateSettings({ embeddingSimilarityThreshold: Number(($event.target as HTMLInputElement).value) / 100 })"
            style="width:100px;vertical-align:middle;"
          />
          <span class="zhino-recall-label" style="margin-left:8px">{{ (store.settings.embeddingSimilarityThreshold * 100).toFixed(0) }}%</span>
        </div>
        <div class="zhino-recall-hint">
          阈值越低召回越多（可能噪音），越高越精准（可能漏掉）。推荐 50-60%。
        </div>
        <div class="zhino-recall-row">
          <span class="zhino-recall-label">混合检索权重</span>
          <input
            type="range" min="0" max="100" step="5"
            :value="Math.round(store.settings.hybridWeight * 100)"
            @input="store.updateSettings({ hybridWeight: Number(($event.target as HTMLInputElement).value) / 100 })"
            style="width:100px;vertical-align:middle;"
          />
          <span class="zhino-recall-label" style="margin-left:8px">{{ (store.settings.hybridWeight * 100).toFixed(0) }}%语义 / {{ ((1 - store.settings.hybridWeight) * 100).toFixed(0) }}%词汇</span>
        </div>
        <div class="zhino-recall-hint">
          语义（dense）擅长理解含义，词汇（sparse）擅长匹配专有名词。<br/>推荐 70%语义+30%词汇，纯语义=100%，纯词汇=0%。
        </div>
        <label class="zhino-toggle-row" style="margin-top:8px">
          <div class="zhino-toggle-info">
            <span class="zhino-toggle-label">增强重排 (Reranker)</span>
            <span class="zhino-toggle-desc">粗筛后调用 Reranker 精排，提升精准度。复用上方 API Key</span>
          </div>
          <input type="checkbox"
            :checked="store.settings.rerankEnabled"
            @change="store.updateSettings({ rerankEnabled: ($event.target as HTMLInputElement).checked })"
          />
        </label>
        <div v-if="store.settings.rerankEnabled" class="zhino-recall-row">
          <span class="zhino-recall-label">模型</span>
          <input
            class="zhino-recall-input model-name"
            :value="store.settings.rerankModel"
            @input="store.updateSettings({ rerankModel: ($event.target as HTMLInputElement).value })"
            placeholder="BAAI/bge-reranker-v2-m3" aria-label="BAAI/bge-reranker-v2-m3"
          />
          <button class="zhino-recall-action-btn" style="margin-left:4px;padding:1px 6px;font-size:9px" @click="testRerankConnection">测试</button>
        </div>
        <div v-if="rerankTestResult" class="zhino-recall-msg" :class="{ ok: rerankTestResult.ok, fail: !rerankTestResult.ok }">
          {{ rerankTestResult.message }}
        </div>
        <div class="zhino-recall-actions">
          <button class="zhino-recall-action-btn" :disabled="isGeneratingEmbeddings || isReembedding" @click="generateAllEmbeddings">
            {{ isGeneratingEmbeddings ? '生成中…' : '为旧数据生成向量' }}
          </button>
          <button class="zhino-recall-action-btn" :disabled="isReembedding" @click="showReembedConfirm = true">
            {{ isReembedding ? '重新向量化中…' : '重新向量化' }}
          </button>
          <button class="zhino-recall-action-btn" @click="scanEmbeddingStats">统计</button>
          <button class="zhino-recall-action-btn" @click="testEmbeddingConnection">测试连接</button>
        </div>
        <div v-if="showReembedConfirm" class="zhino-reembed-confirm">
          <span class="zhino-reembed-warn">⚠️ 将清空所有语义向量并重新生成，适用于换了模型。当前设置：</span>
          <span class="zhino-reembed-model">{{ store.settings.embeddingModel }}（全局{{ store.settings.embeddingDimensions }}维<span v-if="store.settings.kgEmbeddingDimensions > 0">/ 图谱{{ store.settings.kgEmbeddingDimensions }}维</span>）</span>
          <div class="zhino-reembed-actions">
            <button class="zhino-action-btn confirm" @click="reembedAll()">确认重新向量化</button>
            <button class="zhino-action-btn cancel" @click="showReembedConfirm = false">取消</button>
          </div>
        </div>
        <div v-if="embTestResult" class="zhino-recall-msg" :class="{ ok: embTestResult.ok, fail: !embTestResult.ok }">
          {{ embTestResult.message }}
        </div>
        <div v-if="embeddingGenMsg" class="zhino-recall-msg" :class="{ ok: embeddingGenMsg.startsWith('✅'), fail: embeddingGenMsg.startsWith('❌') }">
          {{ embeddingGenMsg }}
        </div>
        <div v-if="embeddingStats.total > 0" class="zhino-recall-hint" style="margin-top:4px">
          共 {{ embeddingStats.total }} 条，{{ embeddingStats.withEmb }} 已有向量，{{ embeddingStats.without }} 待生成
        </div>
        <div v-if="eventEmbStats.total > 0 || memEmbStats.total > 0" class="zhino-recall-hint">
          事件：{{ eventEmbStats.total }} 条（{{ eventEmbStats.withEmb }} 已向量化）｜ 核心记忆：{{ memEmbStats.total }} 条（{{ memEmbStats.withEmb }} 已向量化）
        </div>
        <div v-if="kgEmbStats.locTotal > 0 || kgEmbStats.itemTotal > 0" class="zhino-recall-hint">
          知识图谱节点：{{ kgEmbStats.locTotal }} 地点（{{ kgEmbStats.locWithEmb }} 已向量化），{{ kgEmbStats.itemTotal }} 物品（{{ kgEmbStats.itemWithEmb }} 已向量化）
        </div>
        <!-- 各轮总结向量进度 -->
        <div v-if="summaryEmbStats.length > 0" class="zhino-emb-progress-list">
          <div
            v-for="s in summaryEmbStats"
            :key="s.version"
            class="zhino-emb-progress-row"
            :class="{ done: s.withEmb === s.total, partial: s.withEmb > 0 && s.withEmb < s.total }"
          >
            <span class="zhino-emb-progress-label">v{{ s.version }}</span>
            <div class="zhino-emb-progress-bar-wrap">
              <div
                class="zhino-emb-progress-bar"
                :style="{ width: s.total > 0 ? (s.withEmb / s.total * 100) + '%' : '0%' }"
              ></div>
            </div>
            <span class="zhino-emb-progress-num">{{ s.withEmb }}/{{ s.total }}</span>
          </div>
        </div>
        <!-- 每角色核心记忆向量进度 -->
        <div v-if="charEmbStats.length > 0" class="zhino-emb-char-title">角色核心记忆向量：</div>
        <div v-if="charEmbStats.length > 0" class="zhino-emb-progress-list">
          <div
            v-for="c in charEmbStats"
            :key="c.name"
            class="zhino-emb-progress-row"
            :class="{ done: c.withEmb === c.total, partial: c.withEmb > 0 && c.withEmb < c.total }"
          >
            <span class="zhino-emb-progress-label" :title="c.name">{{ c.name.length > 6 ? c.name.slice(0, 6) + '…' : c.name }}</span>
            <div class="zhino-emb-progress-bar-wrap">
              <div
                class="zhino-emb-progress-bar"
                :style="{ width: c.total > 0 ? (c.withEmb / c.total * 100) + '%' : '0%' }"
              ></div>
            </div>
            <span class="zhino-emb-progress-num">{{ c.withEmb }}/{{ c.total }}</span>
          </div>
        </div>
        <!-- 知识图谱节点向量进度 -->
        <div v-if="kgEmbStats.locTotal > 0 || kgEmbStats.itemTotal > 0" class="zhino-emb-char-title">知识图谱节点向量：</div>
        <div v-if="kgEmbStats.locTotal > 0" class="zhino-emb-progress-list">
          <div
            class="zhino-emb-progress-row"
            :class="{ done: kgEmbStats.locWithEmb === kgEmbStats.locTotal, partial: kgEmbStats.locWithEmb > 0 && kgEmbStats.locWithEmb < kgEmbStats.locTotal }"
          >
            <span class="zhino-emb-progress-label">地点</span>
            <div class="zhino-emb-progress-bar-wrap">
              <div
                class="zhino-emb-progress-bar"
                :style="{ width: kgEmbStats.locTotal > 0 ? (kgEmbStats.locWithEmb / kgEmbStats.locTotal * 100) + '%' : '0%' }"
              ></div>
            </div>
            <span class="zhino-emb-progress-num">{{ kgEmbStats.locWithEmb }}/{{ kgEmbStats.locTotal }}</span>
          </div>
        </div>
        <div v-if="kgEmbStats.itemTotal > 0" class="zhino-emb-progress-list">
          <div
            class="zhino-emb-progress-row"
            :class="{ done: kgEmbStats.itemWithEmb === kgEmbStats.itemTotal, partial: kgEmbStats.itemWithEmb > 0 && kgEmbStats.itemWithEmb < kgEmbStats.itemTotal }"
          >
            <span class="zhino-emb-progress-label">物品</span>
            <div class="zhino-emb-progress-bar-wrap">
              <div
                class="zhino-emb-progress-bar"
                :style="{ width: kgEmbStats.itemTotal > 0 ? (kgEmbStats.itemWithEmb / kgEmbStats.itemTotal * 100) + '%' : '0%' }"
              ></div>
            </div>
            <span class="zhino-emb-progress-num">{{ kgEmbStats.itemWithEmb }}/{{ kgEmbStats.itemTotal }}</span>
          </div>
        </div>
      </template>
    </Collapsible>
  </div>
</template>

<script setup lang="ts">
import { useMainStore } from '../stores/mainStore';
import { embedTimelineEvents, embedCharacterMemories, getEmbedding } from '../core/embedding';
import { embedKnowledgeGraphNodes } from '../core/knowledgeGraph';
import { lookupModelCapability, getReductionStepsFor } from '../core/embeddingCapabilities';
import { Collapsible } from './ui';

const store = useMainStore();

// ─── 召回设置 ───
const showRecallSettings = ref(false);

// ─── 语义向量 ───
const embeddingStats = reactive({ total: 0, withEmb: 0, without: 0 });
const eventEmbStats = reactive({ total: 0, withEmb: 0 });
const memEmbStats = reactive({ total: 0, withEmb: 0 });
const kgEmbStats = reactive({ locTotal: 0, locWithEmb: 0, itemTotal: 0, itemWithEmb: 0 });
const summaryEmbStats = reactive<Array<{ version: number; total: number; withEmb: number }>>([]);
const charEmbStats = reactive<Array<{ name: string; total: number; withEmb: number }>>([]);
const isGeneratingEmbeddings = ref(false);
const embeddingGenMsg = ref('');
const embTestResult = ref<{ ok: boolean; message: string } | null>(null);
const rerankTestResult = ref<{ ok: boolean; message: string } | null>(null);
const showReembedConfirm = ref(false);
const isReembedding = ref(false);

/**
 * 根据当前嵌入模型 + 用户 manual 声明返回可用的维度选项。
 * - 已知支持 Matryoshka：展示 reductionSteps（含原生维度）
 * - 未知模型 + 用户勾选 manual：展示全集 ≤ cur 的档位（cur 也并入）
 * - 不支持降维（已知不支持 OR 未知且未勾 manual）：只展示一个选项 = 原生维度（未知则展示当前值）
 */
function embeddingDimOptions(): { value: number; label: string }[] {
  const model = store.settings.embeddingModel;
  const cap = lookupModelCapability(model);
  const manual = store.settings.embeddingManualMatryoshka === true;
  const supports = cap?.supportsMatryoshka ?? manual;
  const cur = store.settings.embeddingDimensions;
  if (!supports) {
    // 不支持降维：只显示一个 option = 当前/原生维度
    const show = cap?.nativeDim ?? cur;
    return [{ value: show, label: String(show) + (cap ? '（原生）' : '（未知模型，当前值）') }];
  }
  // 支持降维：展示候选档位（≤ nativeDim），未知模型则用全集
  const steps = cap?.reductionSteps ?? getReductionStepsFor(model);
  const max = cap?.nativeDim ?? Infinity;
  const filtered = steps.filter(d => d <= max);
  const set = new Set(filtered);
  set.add(cur); // 当前值即便不在表里也并入
  return [...set].sort((a, b) => a - b).map(d => ({ value: d, label: String(d) }));
}

/** 图谱向量化维度选项（独立于全局；0 = 跟随全局放在 UI 上做特殊 option） */
function kgDimOptions(): { value: number; label: string }[] {
  const model = store.settings.embeddingModel;
  const cap = lookupModelCapability(model);
  const manual = store.settings.embeddingManualMatryoshka === true;
  const supports = cap?.supportsMatryoshka ?? manual;
  if (!supports) return []; // 不支持降维时只有「跟随全局」可用
  const steps = cap?.reductionSteps ?? getReductionStepsFor(model);
  const max = cap?.nativeDim ?? Infinity;
  return [...new Set(steps.filter(d => d <= max))].sort((a, b) => a - b).map(d => ({ value: d, label: String(d) + '维' }));
}

/** 当前模型是否默认支持 Matryoshka（已知支持的就不显示手动勾选） */
function modelSupportsMatryoshkaByDefault(): boolean {
  return lookupModelCapability(store.settings.embeddingModel)?.supportsMatryoshka === true;
}

/** 切换嵌入模型时：能力表内自动重置为该模型原生维度；同时按需重置 manual */
function onModelChange(newModel: string) {
  const cap = lookupModelCapability(newModel);
  const patch: Record<string, unknown> = { embeddingModel: newModel };
  if (cap) {
    // 已知模型：把维度对齐到原生维度（降维档位用户后续自己选）
    patch.embeddingDimensions = cap.nativeDim;
    // 切到已知不支持降维的模型时清掉 manual（已知不支持 + manual 同时为 true 可能误导 UI）
    if (!cap.supportsMatryoshka) patch.embeddingManualMatryoshka = false;
  }
  store.updateSettings(patch as any);
}

async function testEmbeddingConnection() {
  const key = store.settings.embeddingApiKey?.trim();
  if (!key) {
    embTestResult.value = { ok: false, message: '请先填写 API Key' };
    return;
  }
  embTestResult.value = null;
  try {
    const t0 = Date.now();
    await getEmbedding('测试连接', {
      enabled: true,
      apiUrl: store.settings.embeddingApiUrl,
      apiKey: key,
      model: store.settings.embeddingModel,
      dimensions: store.settings.embeddingDimensions,
      manualMatryoshka: store.settings.embeddingManualMatryoshka,
      similarityThreshold: 0,
    });
    const ms = Date.now() - t0;
    embTestResult.value = { ok: true, message: `✅ 连接成功 (${ms}ms)` };
  } catch (err: any) {
    embTestResult.value = { ok: false, message: `❌ 失败: ${err?.message || err}` };
  }
}

async function testRerankConnection() {
  const key = store.settings.embeddingApiKey?.trim();
  if (!key) {
    rerankTestResult.value = { ok: false, message: '请先填写 API Key' };
    return;
  }
  rerankTestResult.value = null;
  try {
    const t0 = Date.now();
    const apiUrl = store.settings.embeddingApiUrl || 'https://api.siliconflow.cn/v1/embeddings';
    const rerankUrl = apiUrl.replace(/\/embeddings\/?$/, '/rerank');
    const resp = await fetch(rerankUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: store.settings.rerankModel || 'BAAI/bge-reranker-v2-m3',
        query: '测试',
        documents: ['这是一条测试文档', '这是另一条测试'],
        top_n: 1,
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`${resp.status} ${errBody}`);
    }
    const ms = Date.now() - t0;
    rerankTestResult.value = { ok: true, message: `✅ 连接成功 (${ms}ms)` };
  } catch (err: any) {
    rerankTestResult.value = { ok: false, message: `❌ 失败: ${err?.message || err}` };
  }
}

function scanEmbeddingStats() {
  let total = 0, totalMem = 0, withEmb = 0, withMemEmb = 0;
  const perSummary: typeof summaryEmbStats = [];
  for (const s of store.summaries) {
    let st = 0, se = 0;
    for (const e of s.timeline) {
      if (!e.event) continue;
      st++;
      if (e.embedding) se++;
    }
    // 核心记忆统计
    let mt = 0, me = 0;
    for (const m of s.characterMemories) {
      for (const c of m.coreMemories || []) {
        if (!(c as any).text && !(typeof c === 'string')) continue;
        mt++;
        if ((c as any).embedding) me++;
      }
    }
    total += st;
    withEmb += se;
    totalMem += mt;
    withMemEmb += me;
    perSummary.push({ version: s.version, total: st + mt, withEmb: se + me });
  }
  eventEmbStats.total = total;
  eventEmbStats.withEmb = withEmb;
  memEmbStats.total = totalMem;
  memEmbStats.withEmb = withMemEmb;
  // 知识图谱节点向量统计（地点 + 物品）
  const kg = store.chatData.knowledgeGraph;
  let locTotal = 0, locWithEmb = 0, itemTotal = 0, itemWithEmb = 0;
  if (kg) {
    for (const loc of kg.locations) {
      locTotal++;
      if (loc.embedding && loc.embedding.length > 0) locWithEmb++;
    }
    for (const it of kg.items) {
      itemTotal++;
      if (it.embedding && it.embedding.length > 0) itemWithEmb++;
    }
  }
  kgEmbStats.locTotal = locTotal;
  kgEmbStats.locWithEmb = locWithEmb;
  kgEmbStats.itemTotal = itemTotal;
  kgEmbStats.itemWithEmb = itemWithEmb;

  const kgTotal = locTotal + itemTotal;
  const kgWithEmb = locWithEmb + itemWithEmb;
  embeddingStats.total = total + totalMem + kgTotal;
  embeddingStats.withEmb = withEmb + withMemEmb + kgWithEmb;
  embeddingStats.without = embeddingStats.total - embeddingStats.withEmb;
  summaryEmbStats.length = 0;
  summaryEmbStats.push(...perSummary);

  // 每角色核心记忆向量统计（遍历所有版本，按角色名聚合）
  const charMap = new Map<string, { total: number; withEmb: number }>();
  for (const s of store.summaries) {
    for (const m of s.characterMemories) {
      const entry = charMap.get(m.characterName) || { total: 0, withEmb: 0 };
      for (const c of (m.coreMemories || []) as any[]) {
        const t = typeof c === 'string' ? c : (c?.text || '');
        if (!t) continue;
        entry.total++;
        if (c?.embedding) entry.withEmb++;
      }
      charMap.set(m.characterName, entry);
    }
  }
  charEmbStats.length = 0;
  for (const [name, stats] of charMap) {
    if (stats.total > 0) charEmbStats.push({ name, ...stats });
  }
  charEmbStats.sort((a, b) => b.total - a.total);
}

async function generateAllEmbeddings() {
  if (isGeneratingEmbeddings.value) return;
  scanEmbeddingStats();
  if (embeddingStats.without === 0) {
    embeddingGenMsg.value = '✅ 全部事件、核心记忆和图谱节点已有向量，无需生成';
    return;
  }
  isGeneratingEmbeddings.value = true;
  embeddingGenMsg.value = '';
  try {
    let totalGenerated = 0;
    for (const s of store.summaries) {
      // 事件向量
      const needEmb = s.timeline.filter(e => e.event && !e.embedding);
      if (needEmb.length > 0) {
        embeddingGenMsg.value = `事件… ${totalGenerated}/${embeddingStats.without}`;
        const n = await embedTimelineEvents(
          s.timeline,
          store.settings.embeddingApiUrl,
          store.settings.embeddingApiKey,
          store.settings.embeddingModel,
          store.settings.embeddingDimensions,
          undefined,
          store.settings.embeddingManualMatryoshka,
        );
        totalGenerated += n;
      }
      // 核心记忆向量
      if (s.characterMemories.length > 0) {
        embeddingGenMsg.value = `记忆… ${totalGenerated}/${embeddingStats.without}`;
        const n = await embedCharacterMemories(
          s.characterMemories,
          store.settings.embeddingApiUrl,
          store.settings.embeddingApiKey,
          store.settings.embeddingModel,
          store.settings.embeddingDimensions,
          store.settings.embeddingManualMatryoshka,
        );
        totalGenerated += n;
      }
    }
    // 知识图谱节点向量（地点 + 物品）
    if (store.settings.kgEmbeddingEnabled !== false) {
      const kg = store.chatData.knowledgeGraph;
      const kgWithout = (kgEmbStats.locTotal - kgEmbStats.locWithEmb) + (kgEmbStats.itemTotal - kgEmbStats.itemWithEmb);
      if (kg && kgWithout > 0) {
        embeddingGenMsg.value = `图谱节点… ${totalGenerated}/${embeddingStats.without}`;
        const n = await embedKnowledgeGraphNodes(kg, {
          enabled: store.settings.embeddingEnabled,
        apiUrl: store.settings.embeddingApiUrl,
        apiKey: store.settings.embeddingApiKey,
        model: store.settings.embeddingModel,
        dimensions: store.settings.kgEmbeddingDimensions > 0 ? store.settings.kgEmbeddingDimensions : store.settings.embeddingDimensions,
        manualMatryoshka: store.settings.embeddingManualMatryoshka,
        similarityThreshold: store.settings.embeddingSimilarityThreshold,
      }, undefined, store.chatData.knowledgeGraphEmbeddingCache);
      totalGenerated += n;
    }
    } // kgEmbeddingEnabled
    store.forcePersist();
    scanEmbeddingStats();
    embeddingGenMsg.value = `✅ 完成！新生成 ${totalGenerated} 条向量，剩余 ${embeddingStats.without} 条无向量`;
  } catch (err: any) {
    embeddingGenMsg.value = `❌ 失败: ${err?.message || err}`;
  } finally {
    isGeneratingEmbeddings.value = false;
  }
}

/** 清空所有向量并重新生成（换模型后使用） */
async function reembedAll() {
  if (isReembedding.value) return;
  showReembedConfirm.value = false;
  isReembedding.value = true;
  embeddingGenMsg.value = '';
  try {
    for (const s of store.summaries) {
      for (const e of s.timeline) delete (e as any).embedding;
      for (const m of s.characterMemories) {
        for (const c of (m.coreMemories || []) as any[]) delete c.embedding;
      }
    }
    // 清空知识图谱节点向量
    const kg = store.chatData.knowledgeGraph;
    if (kg) {
      for (const loc of kg.locations) delete loc.embedding;
      for (const it of kg.items) delete it.embedding;
    }
    store.chatData.knowledgeGraphEmbeddingCache = { locations: {}, items: {} };
    store.forcePersist();
    embeddingGenMsg.value = '✅ 旧向量已清空，开始重新生成…';
    scanEmbeddingStats();
    let totalGenerated = 0;
    for (const s of store.summaries) {
      const needEmb = s.timeline.filter(e => e.event && !e.embedding);
      if (needEmb.length > 0) {
        embeddingGenMsg.value = `事件… ${totalGenerated}/${embeddingStats.without}`;
        totalGenerated += await embedTimelineEvents(s.timeline, store.settings.embeddingApiUrl, store.settings.embeddingApiKey, store.settings.embeddingModel, store.settings.embeddingDimensions, undefined, store.settings.embeddingManualMatryoshka);
      }
      if (s.characterMemories.length > 0) {
        embeddingGenMsg.value = `记忆… ${totalGenerated}/${embeddingStats.without}`;
        totalGenerated += await embedCharacterMemories(s.characterMemories, store.settings.embeddingApiUrl, store.settings.embeddingApiKey, store.settings.embeddingModel, store.settings.embeddingDimensions, store.settings.embeddingManualMatryoshka);
      }
    }
    // 知识图谱节点向量
    if (store.settings.kgEmbeddingEnabled !== false && kg && ((kg.locations.length + kg.items.length) > 0)) {
      const kgDim = store.settings.kgEmbeddingDimensions > 0 ? store.settings.kgEmbeddingDimensions : store.settings.embeddingDimensions;
      embeddingGenMsg.value = `图谱节点… ${totalGenerated}/${embeddingStats.without}`;
      totalGenerated += await embedKnowledgeGraphNodes(kg, {
        enabled: true,
        apiUrl: store.settings.embeddingApiUrl,
        apiKey: store.settings.embeddingApiKey,
        model: store.settings.embeddingModel,
        dimensions: kgDim,
        manualMatryoshka: store.settings.embeddingManualMatryoshka,
        similarityThreshold: store.settings.embeddingSimilarityThreshold,
      }, undefined, store.chatData.knowledgeGraphEmbeddingCache);
    }
    store.forcePersist();
    scanEmbeddingStats();
    embeddingGenMsg.value = `✅ 重新向量化完成！共生成 ${totalGenerated} 条向量`;
  } catch (err: any) {
    embeddingGenMsg.value = `❌ 重新向量化失败: ${err?.message || err}`;
  } finally {
    isReembedding.value = false;
  }
}
</script>

<style scoped>
.zhino-recall-wrap {
  margin-bottom: 12px;
}

/* ─── 召回设置（折叠头部 + 面板外壳由 <Collapsible> 提供）─── */

.zhino-recall-row {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 4px;
}

.zhino-recall-row:last-of-type {
  margin-bottom: 6px;
}

.zhino-recall-label {
  font-size: 10px;
  color: var(--zn-text-muted);
  white-space: nowrap;
}

.zhino-recall-input {
  width: 48px;
  padding: 1px 4px;
  font-size: 10px;
  text-align: center;
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-base);
  border-radius: 4px;
  color: var(--zn-text-regular);
  outline: none;
  font-family: inherit;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.zhino-recall-input:focus {
  border-color: var(--zn-primary);
}

.zhino-recall-hint {
  font-size: 9px;
  color: var(--zn-text-muted);
  line-height: 1.4;
}

/* ─── 召回面板内嵌样式 ─── */
.zhino-recall-sep {
  height: 1px;
  background: var(--zn-border-light);
  margin: 8px 0;
}

.zhino-recall-section-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--zn-text-muted);
  margin-bottom: 3px;
}

.zhino-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 0;
  cursor: pointer;
}

.zhino-toggle-label {
  font-size: 10px;
  color: var(--zn-text-regular);
}

.zhino-toggle-desc {
  font-size: 9px;
  color: var(--zn-text-muted);
}

.zhino-toggle-row input[type="checkbox"] {
  width: 14px;
  height: 14px;
  accent-color: var(--zn-accent);
}

.zhino-toggle-info {
  display: flex;
  flex-direction: column;
}

.zhino-recall-input.url {
  width: 280px;
  text-align: left;
}
.zhino-recall-input.key {
  width: 180px;
}

.zhino-recall-input.model-name {
  width: 200px;
}

/* ─── 向量进度列表 ─── */
.zhino-emb-progress-list {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--zn-border-light);
}

.zhino-emb-progress-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
}

.zhino-emb-progress-label {
  font-size: 10px;
  color: var(--zn-text-muted);
  min-width: 20px;
}

.zhino-emb-progress-row.done .zhino-emb-progress-label {
  color: rgba(var(--zn-success-rgb), 0.5);
}

.zhino-emb-progress-row.partial .zhino-emb-progress-label {
  color: rgba(240, 192, 96, 0.5);
}

.zhino-emb-progress-bar-wrap {
  flex: 1;
  height: 4px;
  background: var(--zn-bg-surface2);
  border-radius: 2px;
  overflow: hidden;
}

.zhino-emb-progress-bar {
  height: 100%;
  background: rgba(var(--zn-accent-rgb), 0.4);
  border-radius: 2px;
  transition: width 0.3s;
  min-width: 2px;
}

.zhino-emb-progress-row.done .zhino-emb-progress-bar {
  background: rgba(var(--zn-success-rgb), 0.4);
}

.zhino-emb-progress-row.partial .zhino-emb-progress-bar {
  background: rgba(240, 192, 96, 0.4);
}

.zhino-emb-progress-num {
  font-size: 10px;
  color: var(--zn-text-muted);
  min-width: 28px;
  text-align: right;
}

.zhino-emb-progress-row.done .zhino-emb-progress-num {
  color: rgba(var(--zn-success-rgb), 0.5);
}

.zhino-emb-progress-row.partial .zhino-emb-progress-num {
  color: rgba(240, 192, 96, 0.5);
}

.zhino-emb-char-title {
  font-size: 11px;
  color: var(--zn-text-muted);
  margin-top: 8px;
  margin-bottom: 2px;
}

.zhino-recall-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.zhino-recall-action-btn {
  padding: 3px 10px;
  font-size: 11px;
  color: var(--zn-text-muted);
  background: var(--zn-bg-surface1);
  border: 1px solid var(--zn-border-base);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.zhino-recall-action-btn:hover:not(:disabled) {
  color: var(--zn-text-primary);
  border-color: var(--zn-border-light);
  background: var(--zn-bg-surface2);
}

.zhino-recall-action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.zhino-recall-msg {
  font-size: 11px;
  margin-top: 6px;
  color: var(--zn-text-muted);
}

.zhino-recall-msg.ok {
  color: rgba(var(--zn-success-rgb), 0.8);
}

.zhino-recall-msg.fail {
  color: rgba(var(--zn-danger-rgb), 0.8);
}

/* ─── 重新向量化确认 ─── */
.zhino-reembed-confirm {
  margin-top: 8px;
  padding: 8px 10px;
  background: rgba(var(--zn-warn-rgb), 0.06);
  border: 1px solid rgba(var(--zn-warn-rgb), 0.15);
  border-radius: 5px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.zhino-reembed-warn {
  font-size: 10.5px;
  color: rgba(var(--zn-warn-rgb), 0.7);
  line-height: 1.4;
}

.zhino-reembed-model {
  font-size: 10.5px;
  color: var(--zn-text-muted);
  font-family: var(--zn-font-mono);
}

.zhino-reembed-actions {
  display: flex;
  gap: 6px;
}

/* ─── 通用动作按钮（reembed 确认用） ─── */
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
</style>
