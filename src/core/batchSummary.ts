/**
 * 批量总结引擎 (V2)
 *
 * 从捕获记录中按楼层范围 + 每批N层，连续自动运行大总结。
 * 使用 V2 流水线：白描时间线 → 角色记忆+NSFW。
 * 单批失败自动重试3次（指数退避）。
 * 不做动态人设/梦呓/生态系统/世界进度/剧情导演。
 */

import { logInfo, logWarn, logError } from '../utils/logger';

import { runSummaryChain } from './summaryChain';
import { executeSmallSummary } from './smallSummary';
import {
  applyKnowledgeGraphDiff,
  buildStableId,
  createEmptyKnowledgeGraph,
  embedKnowledgeGraphNodes,
} from './knowledgeGraph';
import type { KnowledgeGraph } from './knowledgeGraph';
import { embedTimelineEvents, embedCharacterMemories } from './embedding';
import { buildMemorySectionText } from './summary';
import { readLatestUserInputBefore } from '../utils/chatContent';
import { formatThinkingChainForAnalysis } from '../utils/messageParser';
import type {
  CapturedContent,
  GrandSummary,
  TimelineEvent,
  CharacterMemory,
  SmallSummaryRecord,
} from '../stores/mainStore';

export interface BatchProgress {
  status: 'idle' | 'running' | 'done' | 'cancelled' | 'paused';
  currentBatch: number;
  totalBatches: number;
  totalMessages: number;
  startFloor: number;
  endFloor: number;
  batchSize: number;
  /** 当前批次实际楼层范围 */
  currentBatchFloorStart?: number;
  currentBatchFloorEnd?: number;
  /** 当前批次捕获条数 */
  currentBatchCount?: number;
  errors: Array<{ batch: number; message: string; retries: number }>;
}

// ⚠️ 批量总结**不做自己的重试**：失败即暂停，重试统一交给「智脑整体」那套
//   （callGenerateRaw 的重试弹窗，用户能看到失败原因并决定重试或放弃）。
//   两层重试叠在一起时，用户点一次「取消重试」，外层立刻又发起新一轮、又弹一次窗。

/** 批量总结要跑哪几项（对应 UI 上的三个勾选框） */
export interface BatchSummaryOptions {
  /** 事件总结（大总结时间线） */
  event: boolean;
  /** 角色记忆总结 */
  memory: boolean;
}

/**
 * 大总结版本号续接：取**历史最大版本 + 1**。
 *
 * 旧实现用 `getLatestSummary().version + 1`，在「已有 v1 但 latest 读不到」等场景下会从 v1 重来，
 * 与既有版本号撞车。这里改成扫全量 `summaries` 取最大值，更能保证「往下延续」。
 */
function nextSummaryVersion(store: any): number {
  let max = 0;
  for (const s of (store?.chatData?.summaries || []) as Array<{ version?: number }>) {
    const v = Number(s?.version);
    if (Number.isFinite(v) && v > max) max = v;
  }
  try {
    const latest = Number(store?.getLatestSummary?.()?.version);
    if (Number.isFinite(latest) && latest > max) max = latest;
  } catch { /* ignore */ }
  return max + 1;
}

/** 按楼层范围将捕获记录分配到各批次 */
function computeBatchMap(
  contents: CapturedContent[],
  startFloor: number,
  endFloor: number,
  batchSize: number,
): Map<number, CapturedContent[]> {
  const totalFloors = endFloor - startFloor + 1;
  const totalBatches = Math.ceil(totalFloors / batchSize);
  const map = new Map<number, CapturedContent[]>();
  for (let b = 0; b < totalBatches; b++) map.set(b, []);

  for (const c of contents) {
    const batchIdx = Math.floor((c.messageId - startFloor) / batchSize);
    if (batchIdx >= 0 && batchIdx < totalBatches) {
      map.get(batchIdx)!.push(c);
    }
  }
  return map;
}

/**
 * 将 V2 大总结 + 角色记忆结果组装为 GrandSummary（统一存储格式）
 * 复刻 index.ts 和 OverviewTab.vue 中的组装逻辑
 */
function assembleGrandSummary(
  v2Events: Array<{
    time: string;
    location: string;
    presentCharacters: string[];
    summary: string;
    event: string;
    importance: number;
    keywords: string[];
  }>,
  memResult: { characterMemories: CharacterMemory[]; nsfwMemories: any[] },
  summaryVersion: number,
  previousSummary?: GrandSummary,
): GrandSummary {
  // V2 事件 → TimelineEvent[]（summary=速览用于召回，detail=完整经过用于注入）
  const timeline: TimelineEvent[] = v2Events.map(e => ({
    time: e.time,
    event: e.summary || e.event.slice(0, 50),
    detail: e.event,
    importance: e.importance,
    triggers: {
      characters: e.presentCharacters,
      keywords: e.keywords,
    },
  }));

  // 事件编号续接上次大总结
  const offset = previousSummary
    ? (() => {
        let max = 0;
        const s1 = previousSummary.rawText.split(/---SECTION---/i)[0] || '';
        for (const m of s1.matchAll(/\[#(\d+)\]/g)) max = Math.max(max, parseInt(m[1], 10));
        return max;
      })()
    : 0;
  let eventNum = offset;
  const s1Lines: string[] = [];
  for (const e of timeline) {
    eventNum++;
    s1Lines.push(`[#${eventNum}] [${e.time}] ${e.event}`);
    s1Lines.push(`重要性: ${e.importance || 3}`);
    if (e.detail) s1Lines.push(e.detail);
    if (e.triggers?.characters?.length) s1Lines.push(`[角色: ${e.triggers.characters.join(', ')}]`);
    if (e.triggers?.keywords?.length) s1Lines.push(`[关键词: ${e.triggers.keywords.join(', ')}]`);
    s1Lines.push('');
  }

  // Section 2: 角色记忆
  const section2 = buildMemorySectionText(memResult.characterMemories);

  // Section 3: NSFW
  let section3 = '[NSFW记录]\n无NSFW内容';
  if (memResult.nsfwMemories.length > 0) {
    const nsfwParts: string[] = [];
    for (const n of memResult.nsfwMemories) {
      nsfwParts.push(`### ${n.characterName}`);
      nsfwParts.push(`敏感点: ${n.sensitivePoints.join(', ')}`);
      nsfwParts.push(`偏好: ${n.preferences.join(', ')}`);
      nsfwParts.push(`行为模式: ${n.behaviors.join(', ')}`);
      nsfwParts.push('记忆:');
      for (const m of n.memories) nsfwParts.push(`- ${m}`);
    }
    section3 = nsfwParts.join('\n');
  }

  const rawText = [
    s1Lines.join('\n').trim() || '[剧情摘要]',
    '---SECTION---',
    section2.trim() || '[角色记忆]',
    '---SECTION---',
    section3,
  ].join('\n');

  return {
    version: summaryVersion,
    generatedAt: new Date().toISOString(),
    characterMemories: memResult.characterMemories,
    timeline,
    characterTable: memResult.characterMemories.map(m => ({
      name: m.characterName,
      aliases: m.keywords.slice(0, 3),
      identity: '',
      relationship: m.attitude === 'like' ? '好感' : m.attitude === 'dislike' ? '厌恶' : '中立',
      status: '活跃',
    })),
    rawText,
  };
}

export async function executeBatchSummary(
  startFloor: number,
  endFloor: number,
  batchSize: number,
  capturedContents: CapturedContent[],
  store: any,
  onProgress: (progress: BatchProgress) => void,
  /** 外部可设置此 ref 为 true 来中止批量（停止按钮） */
  abortSignal?: { value: boolean },
  /** 要跑哪几项；缺省 = 事件 + 角色记忆（保持旧行为） */
  options?: BatchSummaryOptions,
): Promise<void> {
  const doEvent = options?.event !== false;
  const doMemory = options?.memory !== false;
  if (!doEvent && !doMemory) {
    logWarn('批量总结', '事件总结与角色记忆总结都未勾选，跳过');
    onProgress({
      status: 'done', currentBatch: 0, totalBatches: 0, totalMessages: 0,
      startFloor, endFloor, batchSize, errors: [],
    });
    return;
  }
  const progress: BatchProgress = {
    status: 'running',
    currentBatch: 0,
    totalBatches: 0,
    totalMessages: 0,
    startFloor,
    endFloor,
    batchSize,
    errors: [],
  };

  // 创建 AbortController：当外部设置 abortSignal.value=true 时真正中断 fetch 请求
  const controller = new AbortController();
  const pollAbort = () => {
    if (abortSignal?.value) controller.abort();
  };
  // 每 200ms 检查一次，有变化立即中止
  const abortPollTimer = setInterval(pollAbort, 200);

  try {
    // 1. 从捕获记录中筛选范围 + 按 messageId 排序
    const rangeContents = capturedContents
      .filter(c => c.messageId >= startFloor && c.messageId <= endFloor)
      .sort((a, b) => a.messageId - b.messageId);

    if (rangeContents.length === 0) {
      progress.status = 'done';
      onProgress(progress);
      logWarn('批量总结', `楼层 ${startFloor}-${endFloor} 内无捕获记录`);
      return;
    }

    progress.totalMessages = rangeContents.length;
    const totalFloors = endFloor - startFloor + 1;
    const totalBatches = Math.ceil(totalFloors / batchSize);
    progress.totalBatches = totalBatches;
    const batchContentsByFloor = computeBatchMap(rangeContents, startFloor, endFloor, batchSize);
    onProgress({ ...progress });
    logInfo('批量总结', `开始: 楼层 ${startFloor}-${endFloor}, ${rangeContents.length}条, ${totalBatches}批`);

    // 2. 逐批处理（按楼层范围）
    for (let b = 0; b < totalBatches; b++) {
      // 外部中止检查
      if (abortSignal?.value) {
        progress.status = 'cancelled';
        onProgress({ ...progress });
        return;
      }
      const batchStartFloor = startFloor + b * batchSize;
      const batchEndFloor = Math.min(startFloor + (b + 1) * batchSize - 1, endFloor);
      const batchContents = batchContentsByFloor.get(b) || [];

      progress.currentBatch = b + 1;
      progress.currentBatchFloorStart = batchStartFloor;
      progress.currentBatchFloorEnd = batchEndFloor;
      progress.currentBatchCount = batchContents.length;
      onProgress({ ...progress });

      if (batchContents.length === 0) {
        continue;
      }

      const lastMsgId = batchContents[batchContents.length - 1].messageId;
      const batchCoveredIds = batchContents.map(c => c.messageId);

      // 每批只跑一次 —— 重试统一交给「智脑整体」那套（callGenerateRaw 的重试弹窗），
      // 这里不再自己套一层指数退避：两层重试叠在一起时，用户点一次「取消重试」，
      // 外层立刻又发起新一轮、又弹一次窗，看起来就是"点了没用"。
      {
        if (abortSignal?.value) {
          progress.status = 'cancelled';
          onProgress({ ...progress });
          return;
        }

        try {
          // 获取上次总结作为上下文（每批自动续接）
          const previousSummary = store.getLatestSummary();
          const existingMemories: CharacterMemory[] = previousSummary?.characterMemories || [];
          // 版本号续接：取历史最大版本 + 1（不是简单 latest+1，避免与已有版本撞车）
          const summaryVersion = nextSummaryVersion(store);

          // === 统一走 core/summaryChain：大总结 + 角色记忆并发 ===
          // 批量总结与其他入口共用同一条链，行为一致（并发 + 耗时日志 + signal 透传）。
          // 每批只跑一次 —— 重试统一交给「智脑整体」那套（callGenerateRaw 的重试弹窗）。
          const chainResult = await runSummaryChain(
            batchContents,
            [],  // 批量总结无小总结，走 buildInputMaterial 的兜底模式
            previousSummary?.rawText,  // 续接上次事件编号
            existingMemories,
            store.getUserName(),
            {
              event: doEvent,
              memory: doMemory,
              memoryMin: 4,
              memoryMax: 8,
              abortSignal: controller.signal,
              extraGenerateParams: { _responseFormat: 'json_object' },
              blacklistedNames: store.getBlacklistedCharacters(),
              logScope: '批量总结',
            },
          );
          const v2Events: any[] = chainResult.v2Result?.events || [];
          const memResult: { characterMemories: CharacterMemory[]; nsfwMemories: any[] } =
            chainResult.memResult || { characterMemories: [], nsfwMemories: [] };

          // AI 调用完成后立即检查中止
          if (abortSignal?.value) {
            progress.status = 'cancelled';
            onProgress({ ...progress });
            return;
          }

          // === 组装 GrandSummary 并存储 ===
          const summary = assembleGrandSummary(
            v2Events,
            memResult,
            summaryVersion,
            previousSummary,
          );

          store.addSummary(summary, lastMsgId, batchCoveredIds);

          // NSFW 记忆存储
          if (memResult.nsfwMemories.length > 0) {
            store.updateNsfwMemories(memResult.nsfwMemories);
            store.forcePersist();
            logInfo('批量总结', `NSFW记忆已更新 (${memResult.nsfwMemories.length} 角色)`);
          }

          // === 后台生成向量（不阻塞批量流程） ===
          if (store.settings.embeddingEnabled && store.settings.embeddingApiKey) {
            // 时间线事件向量
            if (summary.timeline.length > 0) {
              embedTimelineEvents(
                summary.timeline,
                store.settings.embeddingApiUrl,
                store.settings.embeddingApiKey,
                store.settings.embeddingModel,
                store.settings.embeddingDimensions,
                undefined,
                store.settings.embeddingManualMatryoshka,
              ).then(() => {
                store.syncCharacterMemoryBatchEmbeddings(summary.version, memResult.characterMemories);
                store.forcePersist();
              }).catch(() => {});
            }

            // 核心记忆向量
            const totalCores = memResult.characterMemories.reduce(
              (s: number, m: any) => s + (m.coreMemories?.length || 0),
              0,
            );
            if (totalCores > 0) {
              embedCharacterMemories(
                memResult.characterMemories,
                store.settings.embeddingApiUrl,
                store.settings.embeddingApiKey,
                store.settings.embeddingModel,
                store.settings.embeddingDimensions,
                store.settings.embeddingManualMatryoshka,
              ).then(() => store.forcePersist()).catch(() => {});
            }

          }

        } catch (err: any) {
          // 中止请求 / 用户在重试弹窗里点了「取消重试」→ 整个批量结束
          if (err?.name === 'AbortError' || err?.message === '用户已取消重试') {
            logWarn('批量总结', `第${b + 1}/${totalBatches}批中止（${err?.message || 'AbortError'}）`);
            progress.status = 'cancelled';
            onProgress({ ...progress });
            clearInterval(abortPollTimer);
            return;
          }
          // 只跑一次：不再自己重试，直接暂停等用户点「继续总结」
          progress.errors.push({
            batch: b + 1,
            message: String(err?.message || err),
            retries: 0,
          });
          logError('批量总结', `第${b + 1}/${totalBatches}批失败，已暂停`);
          progress.status = 'paused';
          onProgress({ ...progress });
          return;
        }
      }
    }

    progress.status = 'done';
    onProgress({ ...progress });
    const okCount = totalBatches - progress.errors.length;
    logInfo('批量总结', `完成: ${okCount}/${totalBatches}批成功, ${progress.errors.length}次错误`);
  } catch (err: any) {
    clearInterval(abortPollTimer);
    if (err?.name === 'AbortError') {
      progress.status = 'cancelled';
    } else {
      progress.status = 'done';
      progress.errors.push({
        batch: 0,
        message: `致命错误: ${err?.message || err}`,
        retries: 0,
      });
      logError('批量总结', `致命错误: ${err?.message || err}`);
    }
    onProgress({ ...progress });
  } finally {
    clearInterval(abortPollTimer);
  }
}

// ========== 批量图谱总结（一遍多层，一次出一份图谱） ==========

/**
 * 图谱总结：把一整批楼层（建议 20 层左右）**一次性**发给 AI，产出一份图谱（地点 / 物品 / 人物）。
 *
 * ── 发送的材料 ──
 * 该批每一层的「用户输入 + AI 正文（+ 思维链锚点）」，按楼层顺序拼成一份可一次读完的材料，
 * 走的仍是 `executeSmallSummary`（只是换成多轮材料模式），所以判重规则、别名合并、
 * 瞬时持有态降级这些行为跟逐轮小总结一致，产出的图谱能和自动跑出来的混在一起不打架。
 *
 * ── 续接规则 ──
 * 若聊天里已有小总结，**只发送「已有小总结覆盖的最后楼层」之后的数据** ——
 * 把同一层重复喂一遍会让图谱把同一件事记两次，还可能把已经降级的持有态又拉回来。
 *
 * ── 版本号 ──
 * 每批结束时把累积图谱 commit 一次，版本号 = **该批最后一层的楼层号**；
 * 但不会低于「现有最大图谱版本」—— `commitKnowledgeGraph` 会截断 >= 该版本的历史，
 * 补跑旧楼层时若直接用小楼层号，会把之后的图谱历史全部抹掉。
 *
 * ── 向量化 ──
 * 全部跑完后对最终图谱做一次完整向量化（仅在 embeddingEnabled 时）。
 */
export interface BatchGraphProgress {
  status: 'idle' | 'running' | 'done' | 'cancelled' | 'paused';
  /** 当前批次（从 1 起） */
  currentBatch: number;
  totalBatches: number;
  /** 待补跑的总层数 */
  totalMessages: number;
  /** 当前批次的楼层范围 */
  currentBatchFloorStart?: number;
  currentBatchFloorEnd?: number;
  currentBatchCount?: number;
  /** 实际起点（已按已有小总结自动后移） */
  startFloor: number;
  endFloor: number;
  batchSize: number;
  /** 已成功完成的批次数 */
  summarizedBatches: number;
  /** 图谱最近一次提交到的楼层号 */
  committedFloor?: number;
  /** 因已有小总结而被跳过的楼层数 */
  skippedFloors: number;
  errors: Array<{ batch: number; message: string; retries: number }>;
}

/**
 * 一批材料成倍变多，输出条目也成倍变多 —— 默认的 3072 太容易被截断，
 * 这里放宽到 16384（截断会导致图谱只落一半，比慢更糟）。
 */
const BATCH_GRAPH_MAX_TOKENS = 16384;

/** 把一批楼层拼成一份「可一次读完」的材料（含楼层分节与阅读约定） */
function buildBatchMaterial(chunk: CapturedContent[], store: any): string {
  const head = chunk[0].messageId;
  const tail = chunk[chunk.length - 1].messageId;
  const lines: string[] = [
    `[本批材料 · 共 ${chunk.length} 层（#${head}–#${tail}）]`,
    '',
    '阅读约定：规则里说的"本轮 / 本段"一律指**这批材料整体**；请按时间顺序通读。',
    '同一实体在多楼里反复出现时**合并成一条最新状态**（不要每楼 add 一次）；',
    '输出的地点 / 物品 / 人物状态取**本批结束时**的最新状态。',
    '',
  ];

  for (const c of chunk) {
    const floor = Number(c.messageId);
    // 用户输入：优先从酒馆当前聊天读取，回落 userInputRecords
    let userText = '';
    try {
      userText = readLatestUserInputBefore(floor)?.content || '';
    } catch { /* ignore */ }
    if (!userText) {
      const rec = ((store?.chatData?.userInputRecords || []) as any[]).find(r => r.messageId === floor - 1);
      userText = rec?.userInput || '';
    }

    lines.push(`—— 第 ${floor} 层 ——`);
    if (userText.trim()) lines.push('[用户输入]', userText.trim());
    lines.push('[AI回复]', c.content);
    const chain = (c.thinkingChain || '').trim();
    if (chain) lines.push(formatThinkingChainForAnalysis(chain));
    lines.push('');
  }

  return lines.join('\n');
}

/** 批量图谱总结的可选项 */
export interface BatchGraphOptions {
  /**
   * 忽略「已有小总结」的续接规则，强制把范围内**全部**楼层重新发送一遍。
   *
   * 适用：图谱被清空后要重建，或觉得某段图谱跑得不好要重来。
   * 注意：即便不开这个开关，**图谱为空时也会自动忽略**（见下方 graphEmpty 判定），
   * 否则「清空图谱 → 批量补跑」会一层都跑不了。
   */
  ignoreExistingSummaries?: boolean;
}

/** 图谱节点总数（用于判断图谱是不是空的） */
function countGraphNodes(graph: KnowledgeGraph | null | undefined): number {
  if (!graph) return 0;
  return (graph.locations?.length || 0) + (graph.items?.length || 0) + (graph.characters?.length || 0);
}

export async function executeBatchGraphSummary(
  startFloor: number,
  endFloor: number,
  batchSize: number,
  capturedContents: CapturedContent[],
  store: any,
  onProgress: (progress: BatchGraphProgress) => void,
  abortSignal?: { value: boolean },
  options?: BatchGraphOptions,
): Promise<void> {
  const size = Math.max(1, Math.floor(batchSize) || 20);
  const progress: BatchGraphProgress = {
    status: 'running',
    currentBatch: 0,
    totalBatches: 0,
    totalMessages: 0,
    startFloor: Math.max(0, Math.floor(startFloor)),
    endFloor: Math.floor(endFloor),
    batchSize: size,
    summarizedBatches: 0,
    skippedFloors: 0,
    errors: [],
  };

  const bail = (status: BatchGraphProgress['status']) => {
    progress.status = status;
    onProgress({ ...progress });
  };

  // 中止传播：外部只设 abortSignal.value，这里轮询后真正 abort 掉 fetch，
  // 否则点了「停止总结」要等当前请求跑完才生效（体感就是"点了没反应"）。
  const controller = new AbortController();
  const abortPollTimer = setInterval(() => {
    if (abortSignal?.value) controller.abort();
  }, 200);

  try {
    // ── 1. 计算实际起点：跳过已有小总结覆盖的楼层 ──
    const existingRecords = (store?.chatData?.smallSummaries || []) as SmallSummaryRecord[];
    const coveredFloors = new Set<number>();
    let summarizedEnd = -1;
    for (const r of existingRecords) {
      const s = Number(r?.floorRange?.start);
      const e = Number(r?.floorRange?.end);
      if (Number.isFinite(e)) summarizedEnd = Math.max(summarizedEnd, e);
      if (Number.isFinite(s) && Number.isFinite(e) && e >= s) {
        for (let f = s; f <= e; f++) coveredFloors.add(f);
      }
    }

    // ★ 图谱为空（被清空过 / 从没跑过）时，必须忽略续接规则：
    //   「跳过已有小总结」是为了防止重复喂同一层导致图谱重复入库，
    //   但图谱既然已经空了，那些记录对应的图谱内容早已不在，再跳过就一层都补不回来。
    const graphNodeCount = countGraphNodes(store?.chatData?.knowledgeGraph);
    const graphEmpty = graphNodeCount === 0;
    const forceRerun = !!options?.ignoreExistingSummaries || graphEmpty;

    let from = Math.max(0, Math.floor(startFloor));
    if (!forceRerun && summarizedEnd >= from) {
      logInfo('批量图谱', `已有小总结覆盖到 #${summarizedEnd}，本次只发送其后的聊天数据（从 #${summarizedEnd + 1} 起）`);
      progress.skippedFloors = summarizedEnd - from + 1;
      from = summarizedEnd + 1;
    } else if (forceRerun && summarizedEnd >= from) {
      logInfo(
        '批量图谱',
        graphEmpty
          ? `图谱为空，忽略「已有小总结覆盖到 #${summarizedEnd}」，范围内全部楼层重新发送`
          : `已开启「忽略已有小总结」，范围内全部楼层重新发送（已有小总结覆盖到 #${summarizedEnd}）`,
      );
    }
    progress.startFloor = from;

    if (from > endFloor) {
      bail('done');
      logWarn('批量图谱', `起点 #${from} 已超过结束楼层 #${endFloor}，无需补跑`);
      return;
    }

    const targets = capturedContents
      .filter(c => c.messageId >= from && c.messageId <= endFloor && (forceRerun || !coveredFloors.has(c.messageId)))
      .sort((a, b) => a.messageId - b.messageId);

    if (targets.length === 0) {
      bail('done');
      logWarn('批量图谱', `楼层 #${from}-#${endFloor} 内没有可总结的正文`);
      return;
    }

    // ── 2. 按批切分（一批 = 一次请求 = 一份图谱） ──
    const chunks: CapturedContent[][] = [];
    for (let i = 0; i < targets.length; i += size) chunks.push(targets.slice(i, i + size));

    progress.totalMessages = targets.length;
    progress.totalBatches = chunks.length;
    onProgress({ ...progress });
    logInfo('批量图谱', `开始: 楼层 ${from}-${endFloor}, ${targets.length} 层, 分 ${chunks.length} 批（每批 ${size} 层）`);

    // ── 3. 基底图谱：在当前主图谱上增量累积 ──
    const settings = store.settings || {};
    const userName = store.getUserName();
    const characterEntries = store.getCharacterNameEntries();
    const allNames = characterEntries.map((e: any) => e.name);
    const blacklist = store.getBlacklistedCharacters();

    let graph: KnowledgeGraph = store.chatData.knowledgeGraph
      ? (JSON.parse(JSON.stringify(store.chatData.knowledgeGraph)) as KnowledgeGraph)
      : createEmptyKnowledgeGraph();
    const locSnapshot: Record<string, string> = { ...(store.chatData.characterLocations || {}) };
    const presentSet = new Set<string>();

    /** 把累积图谱落盘：版本号 = 该批最后一层的楼层号（但不得低于现有最大版本，避免截断历史） */
    const commitAccumulated = (batchEndFloor: number) => {
      const maxVerFloor = ((store.chatData.knowledgeGraphVersions || []) as any[])
        .reduce((m: number, v: any) => Math.max(m, Number(v?.floor) || 0), 0);
      const commitFloor = Math.max(batchEndFloor, maxVerFloor);
      try {
        store.commitKnowledgeGraph(graph, commitFloor, locSnapshot, presentSet);
        progress.committedFloor = commitFloor;
        logInfo('知识图谱', `批量图谱已提交 v${commitFloor}（本批至 #${batchEndFloor}）`);
      } catch (e: any) {
        logWarn('批量图谱', `图谱提交失败（已写入的小总结不受影响）: ${e?.message || e}`);
      }
    };

    // ── 4. 逐批总结（每批一次请求，产出一份图谱） ──
    for (let b = 0; b < chunks.length; b++) {
      if (abortSignal?.value) { bail('cancelled'); return; }

      const chunk = chunks[b];
      const batchStartFloor = Number(chunk[0].messageId);
      const batchEndFloor = Number(chunk[chunk.length - 1].messageId);

      progress.currentBatch = b + 1;
      progress.currentBatchFloorStart = batchStartFloor;
      progress.currentBatchFloorEnd = batchEndFloor;
      progress.currentBatchCount = chunk.length;
      onProgress({ ...progress });

      const material = buildBatchMaterial(chunk, store);

      // 上一条小总结的在场角色 → 判重上下文（与逐轮小总结一致）
      const records = (store.chatData.smallSummaries || []) as SmallSummaryRecord[];
      const lastRec = records.length > 0 ? records[records.length - 1] : null;
      const previousContext = lastRec?.presentCharacters?.length
        ? { presentCharacters: lastRec.presentCharacters, characterLocations: lastRec.characterLocations || [] }
        : undefined;

      const kgOptions = {
        knowledgeGraph: graph,
        vectorGraph: (store.chatData.knowledgeGraph as KnowledgeGraph) || null,
        embeddingCache: store.chatData.knowledgeGraphEmbeddingCache || null,
        embeddingEnabled: settings.embeddingEnabled,
        embeddingApiUrl: settings.embeddingApiUrl,
        embeddingApiKey: settings.embeddingApiKey,
        embeddingModel: settings.embeddingModel,
        embeddingDimensions: settings.kgEmbeddingDimensions > 0 ? settings.kgEmbeddingDimensions : settings.embeddingDimensions,
        embeddingManualMatryoshka: settings.embeddingManualMatryoshka,
        kgInjectTopK: settings.kgInjectTopK ?? 8,
        characterLocations: store.chatData.characterLocations || {},
        centerCharacterNames: [userName, ...(lastRec?.presentCharacters || [])].filter(Boolean),
        centerLocationNames: [] as string[],
      };

      // 每批只跑一次 —— 重试统一交给「智脑整体」那套（callGenerateRaw 的重试弹窗）。
      // 这里不再自己套指数退避：两层重试叠在一起时，用户点一次「取消重试」，
      // 外层立刻又发起新一轮、又弹一次窗，看起来就是"点了没用"。
      if (abortSignal?.value) { bail('cancelled'); return; }

      let result: Awaited<ReturnType<typeof executeSmallSummary>> | null = null;
      try {
        result = await executeSmallSummary(
          '', '',                                   // 多轮模式：单轮的输入/正文区块不参与
          batchStartFloor, batchEndFloor,           // record 的 floorRange = 整批
          allNames, userName, kgOptions as any, characterEntries, previousContext,
          blacklist, '', '',
          {
            multiRoundMaterial: material,
            maxTokens: BATCH_GRAPH_MAX_TOKENS,
            // 失败必须抛出来：默认吞错返回 status:'failed' 的记录，会被当成成功写进小总结
            throwOnError: true,
            // 让「停止总结」能真正掐断正在进行的 fetch
            abortSignal: controller.signal,
          },
        );
      } catch (e: any) {
        // 中止请求 / 用户在重试弹窗里点了「取消重试」→ 整个批量结束
        if (e?.name === 'AbortError' || e?.message === '用户已取消重试') {
          logWarn('批量图谱', `第${b + 1}/${chunks.length}批中止（${e?.message || 'AbortError'}）`);
          bail('cancelled');
          return;
        }
        progress.errors.push({ batch: b + 1, message: String(e?.message || e), retries: 0 });
        logError('批量图谱', `第${b + 1}/${chunks.length}批失败，已暂停`);
        bail('paused');
        return;
      }

      if (!result) {
        progress.errors.push({ batch: b + 1, message: '未返回结果', retries: 0 });
        bail('paused');
        return;
      }

      // 写入小总结记录（覆盖整批楼层；清掉与之重叠的旧记录，避免重复）
      const record = result.record;
      try {
        record.presentCharacters = store.resolveKnownCharacterNames(record.presentCharacters, true);
        if (record.interactingCharacters?.length) {
          record.interactingCharacters = store.resolveKnownCharacterNames(record.interactingCharacters, true);
        }
      } catch { /* ignore */ }

      store.chatData.smallSummaries = ((store.chatData.smallSummaries || []) as any[]).filter((s: any) => {
        const sEnd = s?.floorRange?.end ?? s?.floorRange?.start ?? -1;
        return sEnd < batchStartFloor || sEnd > batchEndFloor;
      });
      store.chatData.smallSummaries.push(record);
      progress.summarizedBatches++;

      // 累积图谱增量
      if (result.graphDiff) {
        try {
          graph = applyKnowledgeGraphDiff(graph, result.graphDiff, {
            reservedCharacterNames: store.collectReservedCharacterNames(),
          });
        } catch (e: any) {
          logWarn('批量图谱', `第${b + 1}批图谱增量合并失败: ${e?.message || e}`);
        }
      }
      for (const l of (result.characterLocations || [])) {
        if (l?.name && l?.location) locSnapshot[l.name] = buildStableId(l.location);
      }
      for (const n of (record.presentCharacters || [])) presentSet.add(n);
      for (const n of (record.interactingCharacters || [])) presentSet.add(n);

      // 批尾提交
      commitAccumulated(batchEndFloor);
      store.forcePersist();

      const kgStats = result.graphDiff
        ? `地点+${result.graphDiff.add?.locations?.length || 0}/物品+${result.graphDiff.add?.items?.length || 0}/人物+${result.graphDiff.add?.characters?.length || 0}`
        : '无图谱变更';
      logInfo('批量图谱', `第${b + 1}/${chunks.length}批完成（#${batchStartFloor}-#${batchEndFloor}）: ${kgStats}`);
    }

    // ── 5. 收尾：全量向量化 ──
    progress.status = 'done';
    onProgress({ ...progress });
    logInfo('批量图谱', `完成: ${progress.summarizedBatches}/${chunks.length} 批, 图谱提交到 v${progress.committedFloor}`);

    if (progress.summarizedBatches > 0 && settings.embeddingEnabled && settings.embeddingApiKey) {
      try {
        await embedKnowledgeGraphNodes(graph, {
          enabled: true,
          apiUrl: settings.embeddingApiUrl,
          apiKey: settings.embeddingApiKey,
          model: settings.embeddingModel,
          dimensions: settings.kgEmbeddingDimensions > 0 ? settings.kgEmbeddingDimensions : settings.embeddingDimensions,
          manualMatryoshka: settings.embeddingManualMatryoshka,
          similarityThreshold: settings.embeddingSimilarityThreshold,
        }, undefined, store.chatData.knowledgeGraphEmbeddingCache);
        store.forcePersist();
        logInfo('批量图谱', '图谱向量化完成');
      } catch (e: any) {
        logWarn('批量图谱', `图谱向量化失败: ${e?.message || e}`);
      }
    }
  } catch (err: any) {
    if (err?.name === 'AbortError' || err?.message === '用户已取消重试') {
      bail('cancelled');
    } else {
      progress.errors.push({ batch: 0, message: `致命错误: ${err?.message || err}`, retries: 0 });
      logError('批量图谱', `致命错误: ${err?.message || err}`);
      bail('done');
    }
  } finally {
    clearInterval(abortPollTimer);
  }
}
