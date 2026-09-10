/**
 * 世界书角色提取模块 (Worldbook Character Extract)
 *
 * 用途：玩家在「角色库」手动选一本世界书 → 调一次 API → 提取角色名+别名 → 录入角色库。
 * 目的：把世界书里权威的名字/别名喂进角色注册表，从源头减少「分析认错人」。
 *
 * 分批策略：总字符数 ≤ 10 万 → 一次性调用；超过则按 10 万字切块分批调用后合并去重。
 * 提取范围：**只有名字和别名**，不提取简介/所在地（最省 token、幻觉最少）。
 */

import { z } from 'zod';
import { callGenerateRaw } from '../utils/apiCaller';
import { extractJson, safeJsonParse } from '../utils/jsonParse';
import { logInfo, logWarn } from '../utils/logger';

/** 单批字符上限：10 万字以内一次调用，超过则每 10 万字一批 */
export const WORLDBOOK_CHUNK_CHAR_LIMIT = 100_000;

export interface WorldbookCharacterItem {
  name: string;
  aliases: string[];
}

interface RawWorldbookEntry {
  name?: unknown;
  comment?: unknown;
  content?: unknown;
  enabled?: unknown;
  /** 主触发词（世界书 key）——别名常在这里 */
  key?: unknown;
  /** 次触发词 */
  keysecondary?: unknown;
}

/** 提取模式：fast = 标题+触发词+正文前 N 字；full = 标题+触发词+全正文 */
export type WorldbookExtractMode = 'fast' | 'full';

/** fast 模式下每条目附带的正文预览长度 */
export const WORLDBOOK_PREVIEW_CHAR_LIMIT = 300;

/** 批次并发数（仅多批时生效） */
export const WORLDBOOK_BATCH_CONCURRENCY = 3;

/**
 * 列出当前所有世界书（优先酒馆助手的 getWorldbookNames，失败返回空数组）
 */
export async function listWorldbookNames(): Promise<string[]> {
  try {
    const api = globalThis as any;
    if (typeof api.getWorldbookNames === 'function') {
      const names = await api.getWorldbookNames();
      if (Array.isArray(names)) {
        return [...new Set(names.filter(n => typeof n === 'string' && n.trim()))]
          .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
      }
    }
  } catch (error) {
    logWarn('世界书提取', '列出世界书失败', String(error));
  }
  return [];
}

/** 读取一本世界书的全部条目 */
async function readWorldbookEntries(bookName: string): Promise<RawWorldbookEntry[]> {
  const api = globalThis as any;
  if (typeof api.getWorldbook !== 'function') {
    throw new Error('世界书读取 API 不可用，请确认酒馆助手扩展（JS-Slash-Runner）已启用');
  }
  const entries = await api.getWorldbook(bookName);
  return Array.isArray(entries) ? (entries as RawWorldbookEntry[]) : [];
}

/** 条目标题 */
function entryTitle(entry: RawWorldbookEntry): string {
  return String(entry.comment || entry.name || '').trim() || '未命名条目';
}

/**
 * 判断条目是否是「非世界观内容」——其他脚本的产物或代码，不参与角色提取。
 * 依据：历史实测世界书里混有 TavernDB 导出条目、JS/模板代码块。
 */
function isNonLoreEntry(entry: RawWorldbookEntry): boolean {
  const title = entryTitle(entry);
  const content = String(entry.content || '');
  if (/taverndb/i.test(title)) return true;
  // 模板/脚本味：整套变量插值或脚本标签
  if (/<%_|\{\{setvar|\{\{getvar|<script\b/i.test(content)) return true;
  // 纯代码块条目（含函数定义且没有中文正文）
  if (/function\s+\w+\s*\(|=>\s*\{/.test(content) && !/[\u4e00-\u9fa5]{8,}/.test(content)) return true;
  return false;
}

export interface PreparedWorldbook {
  chunks: string[];
  totalChars: number;
  usedEntries: number;
  skippedEntries: number;
  mode: WorldbookExtractMode;
}

/** 世界书里的结构性词（调色盘/基础信息/楼层区间之类），不是角色名 */
const STRUCTURAL_TOKEN_RE = /^(?:小总结|NSFW|nsfw|调色盘|性格调色盘|基础信息|基本信息|角色档案|角色|NPC|npc|世界观|区域|势力|组织|地点|物品|事件|规则|设定|Prompt|prompt)$|^楼层?\s*\d|^\d+\s*[-~]\s*\d+$/;

/** 把条目里的"名字信号"切出来：标题路径段 + 触发词（二次切分中文逗号/顿号等） */
export function extractEntryTokens(entry: RawWorldbookEntry): string[] {
  const out: string[] = [];
  const push = (raw: unknown) => {
    const text = String(raw ?? '').trim();
    if (!text || text.length > 24) return;
    if (STRUCTURAL_TOKEN_RE.test(text)) return;
    out.push(text);
  };

  // 1) 标题路径：角色/林翩翩/性格调色盘 → 各段
  for (const seg of String(entry.comment || entry.name || '').split(/[/｜|]/)) push(seg);

  // 2) 触发词：'苏婉儿，婉儿' 这种一个字符串装两个名字，要二次切
  for (const field of [entry.key, entry.keysecondary]) {
    const list = Array.isArray(field) ? field : (field ? [field] : []);
    for (const item of list) {
      for (const part of String(item).split(/[，,、；;/／\n]/)) push(part);
    }
  }
  return [...new Set(out)];
}

/**
 * 预处理 + 切块（纯代码、零 API）：
 * 过滤脚本/代码/空条目；把 **标题路径 + 触发词(key)** 一并带上（别名常只在触发词里），
 * fast 模式再附正文前 300 字，full 模式附全正文；按上限贪心切块（不切碎单条条目）。
 */
export function prepareWorldbookText(
  rawEntries: RawWorldbookEntry[],
  options: { mode?: WorldbookExtractMode } = {},
): PreparedWorldbook {
  const mode: WorldbookExtractMode = options.mode === 'full' ? 'full' : 'fast';
  const blocks: string[] = [];
  let totalChars = 0;
  let skipped = 0;

  for (const entry of rawEntries) {
    if (!entry || entry.enabled === false) { skipped++; continue; }
    if (isNonLoreEntry(entry)) { skipped++; continue; }

    const content = String(entry.content || '').trim();
    if (!content) { skipped++; continue; }

    const tokens = extractEntryTokens(entry);
    const lines = [`【条目】${entryTitle(entry)}`];
    if (tokens.length > 0) lines.push(`触发词/名字：${tokens.join('、')}`);
    if (mode === 'full') {
      lines.push(`正文：${content}`);
    } else {
      lines.push(`正文（前 ${WORLDBOOK_PREVIEW_CHAR_LIMIT} 字）：${content.slice(0, WORLDBOOK_PREVIEW_CHAR_LIMIT)}`);
    }
    const block = lines.join('\n');
    blocks.push(block);
    totalChars += block.length;
  }

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  const flush = () => {
    if (current.length > 0) {
      chunks.push(current.join('\n\n'));
      current = [];
      currentLen = 0;
    }
  };
  for (const block of blocks) {
    // 单条就超过一整批：先冲刷当前批，再按上限硬切（保证每批都不越界）
    if (block.length > WORLDBOOK_CHUNK_CHAR_LIMIT) {
      flush();
      for (let i = 0; i < block.length; i += WORLDBOOK_CHUNK_CHAR_LIMIT) {
        chunks.push(block.slice(i, i + WORLDBOOK_CHUNK_CHAR_LIMIT));
      }
      continue;
    }
    if (currentLen > 0 && currentLen + block.length > WORLDBOOK_CHUNK_CHAR_LIMIT) flush();
    current.push(block);
    currentLen += block.length + 2;
  }
  flush();

  return { chunks, totalChars, usedEntries: blocks.length, skippedEntries: skipped, mode };
}

// ========== 提示词 ==========

const ExtractSchema = z.object({
  characters: z.array(z.object({
    name: z.string().min(1),
    aliases: z.array(z.string()).default([]),
  })).default([]),
});

/**
 * 提取指令。设计取向：这是**纯搬运**任务，最大的风险不是提不全而是编造，
 * 所以全程压「宁可缺不可错」，并把地名/物品/头衔明确列为禁止项。
 */
function buildExtractInstruction(entriesText: string, userName: string): string {
  return [
    `${userName}: 秋青子，现在需要你做一项「角色名录提取」任务。`,
    '',
    '## 输入材料说明（重要）',
    '',
    '每条材料形如：',
    '',
    '```',
    '【条目】角色/林翩翩/性格调色盘',
    '触发词/名字：林翩翩、林悔儿、花街、翩翩、悔儿',
    '正文（前 300 字）：……',
    '```',
    '',
    '- **「触发词/名字」是作者手工维护的索引词**，同一行的多个词**通常指向同一个角色**，',
    '  是别名的最可靠来源，**优先级高于正文**。',
    '- 但触发词里**混有地点、组织、物品与通用称谓**（如「花街」「漕帮」「码头」「书生」），',
    '  必须甄别后剔除，不能整行照抄成别名。',
    '- 标题里的路径段（`角色/林翩翩/性格调色盘`）中间那一段通常是角色名。',
    '',
    '## 任务说明',
    '',
    '阅读下方世界书条目，提取其中出现的【角色】的名字与别名，按要求输出 JSON。',
    '这是纯提取任务：只搬运材料里已经写明的名字，不做推理、联想或补全。',
    '',
    '## 什么算角色',
    '',
    '有独立人格、会说话、会行动的具体个体。',
    '',
    '以下禁止输出（不算角色）：',
    '- 地点、组织/门派/势力、物品/功法/法宝、事件、规则设定、种族/物种',
    '- 纯头衔或称谓（师尊、掌门、殿下、师父、公子）——除非世界书把它绑定到某具体角色当固定称呼',
    '- 只被一笔带过、无任何具体行为的泛称（众弟子、路人、士兵、村民们）',
    '- 旁白、作者、系统等非剧中实体',
    '',
    '## 别名规则（最重要）',
    '',
    '- 别名 = 世界书中【明确指向同一角色】的其他称呼：本名 / 小名 / 曾用名 / 称号 / 绰号 / 敬称 / 简称 / 外文名',
    '- 同一角色的多种写法 → **合并成一条**：name 取最常用的正式全名，其余全部进 aliases',
    '- 需要推理才能确认是同一人的 → 不要放进别名',
    '- 别名不得与 name 重复；不同角色不得混进同一个 aliases',
    '',
    '## 硬性约束',
    '',
    '- 只提取文本里出现过的名字，禁止编造，禁止带入你自己的知识',
    '- 不确定的角色或别名，直接不输出（宁缺勿错）',
    '- 同名反复出现只输出一次',
    '- 最多输出 200 个角色；超出时按出现频次取前 200',
    '',
    '## 输出格式',
    '',
    '只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码块包裹：',
    '{"characters":[{"name":"正式全名","aliases":["别名1","别名2"]},{"name":"另一角色","aliases":[]}]}',
    '',
    '## 世界书条目',
    '',
    entriesText,
  ].join('\n');
}

// ========== 跨批合并去重 ==========

/** 名字归一化（用于判同）。导出以便 UI 侧复用同一套归一化规则。 */
export function normalizeWorldbookToken(text: string): string {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[\s·・．.。、,，'"'"「」『』《》()（）\[\]【】]/g, '');
}

const normKey = normalizeWorldbookToken;

/** 归一化一批条目里出现过的所有名字 token（用于 UI 标记"本批新增"） */
function tokenizeItems(items: WorldbookCharacterItem[]): string[] {
  const out = new Set<string>();
  for (const item of items) {
    const nameKey = normKey(item.name);
    if (nameKey) out.add(nameKey);
    for (const alias of item.aliases || []) {
      const aliasKey = normKey(alias);
      if (aliasKey) out.add(aliasKey);
    }
  }
  return [...out];
}

/**
 * 跨批合并：同名或互为别名的条目合并成一条（并查集）。
 * 主名取「出现次数最多的 name 写法」，其余全部进 aliases。
 * （导出以便单测）
 */
export function mergeAcrossBatches(raw: WorldbookCharacterItem[]): WorldbookCharacterItem[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    // 路径压缩
    let cur = x;
    while (parent.get(cur) !== undefined && parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // 建点 + 同条目内 name↔aliases 相连
  const nameVote = new Map<string, Map<string, number>>(); // root token -> 原始 name 写法 -> 次数
  for (const item of raw) {
    const nameKey = normKey(item.name);
    if (!nameKey) continue;
    if (!parent.has(nameKey)) parent.set(nameKey, nameKey);
    const votes = nameVote.get(nameKey) || new Map<string, number>();
    votes.set(item.name, (votes.get(item.name) || 0) + 1);
    nameVote.set(nameKey, votes);

    for (const alias of item.aliases || []) {
      const aliasKey = normKey(alias);
      if (!aliasKey || aliasKey === nameKey) continue;
      if (!parent.has(aliasKey)) parent.set(aliasKey, aliasKey);
      union(aliasKey, nameKey);
    }
  }

  // 跨条目：某条的 name 命中别人已登记的别名 → 合并
  for (const item of raw) {
    const nameKey = normKey(item.name);
    if (!nameKey) continue;
    for (const alias of item.aliases || []) {
      const aliasKey = normKey(alias);
      if (aliasKey && parent.has(aliasKey)) union(nameKey, aliasKey);
    }
  }

  // 汇总 root → tokens
  const groups = new Map<string, { tokens: string[]; original: Map<string, string> }>();
  for (const token of parent.keys()) {
    const root = find(token);
    const g = groups.get(root) || { tokens: [], original: new Map<string, string>() };
    g.tokens.push(token);
    groups.set(root, g);
  }

  const out: WorldbookCharacterItem[] = [];
  for (const g of groups.values()) {
    // 选主名：合并所有 name 投票
    const votes = new Map<string, number>();
    for (const token of g.tokens) {
      const v = nameVote.get(token);
      if (!v) continue;
      for (const [written, count] of v) votes.set(written, (votes.get(written) || 0) + count);
    }
    let primary = '';
    let bestScore: [number, number, number] = [-1, -1, -1];
    for (const [written, count] of votes) {
      // 评分：出现次数 → 是否含中文（中文优先，罗马音/外文名退作别名）→ 长度（正式全名通常更长）
      const hasCjk = /[\u4e00-\u9fa5]/.test(written) ? 1 : 0;
      const score: [number, number, number] = [count, hasCjk, written.length];
      if (
        score[0] > bestScore[0]
        || (score[0] === bestScore[0] && score[1] > bestScore[1])
        || (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] > bestScore[2])
      ) {
        primary = written;
        bestScore = score;
      }
    }
    if (!primary) {
      // 没有 name 投票（只作为别名出现）→ 取该组里最长的 token
      primary = g.tokens.slice().sort((a, b) => b.length - a.length)[0] || '';
    }
    if (!primary) continue;

    // 别名 = 组内除主名外的所有 token，优先用「出现过的原始写法」
    const aliasSet = new Set<string>();
    for (const token of g.tokens) {
      const written = (nameVote.get(token) && [...nameVote.get(token)!.keys()][0]) || token;
      if (normKey(written) === normKey(primary)) continue;
      aliasSet.add(written);
    }
    out.push({ name: primary, aliases: [...aliasSet] });
  }

  // 主名长得像真的优先（含有中英文字符），避免残留的归一化 token 当主名
  return out.sort((a, b) => b.name.length - a.name.length);
}

// ========== 主流程 ==========

export interface ExtractWorldbookCharactersResult {
  items: WorldbookCharacterItem[];
  /** 实际调用的批次数 */
  batches: number;
  /** 已跑完的批次数（暂停时 < batches） */
  doneBatches: number;
  totalChars: number;
  usedEntries: number;
  skippedEntries: number;
  /** 失败的批次数（部分失败不影响整体） */
  failedBatches: number;
  /** 是否被用户暂停（暂停时保留已完成批次的结果） */
  aborted: boolean;
  /** 实际使用的提取模式 */
  mode: WorldbookExtractMode;
}

export interface ExtractWorldbookCharactersParams {
  bookName: string;
  userName?: string;
  abortSignal?: AbortSignal;
  /** 提取模式：fast（默认，标题+触发词+正文前 300 字）/ full（全正文） */
  mode?: WorldbookExtractMode;
  /** 进度回调：预处理完成时一次，之后每批结束（成功或失败）各一次 */
  onProgress?: (progress: ExtractProgress) => void;
}

/** 进度事件（判别联合） */
export type ExtractProgress =
  | {
      phase: 'prepared';
      /** 总批次数 */
      total: number;
      usedEntries: number;
      skippedEntries: number;
      totalChars: number;
      mode: WorldbookExtractMode;
    }
  | {
      phase: 'batch';
      /** 已结束的批次数（含失败） */
      done: number;
      total: number;
      /** 本批序号（1 起） */
      batchIndex: number;
      /** 本批提取到的角色数（失败为 0） */
      batchCount: number;
      /** 本批是否失败 */
      failed: boolean;
      /** 本批出现过的名字 token（归一化），供 UI 标记"本批新增" */
      batchTokens: string[];
      /** 截至本批、跨批合并去重后的完整清单（可直接渲染） */
      items: WorldbookCharacterItem[];
    };

export async function extractCharactersFromWorldbook(
  params: ExtractWorldbookCharactersParams,
): Promise<ExtractWorldbookCharactersResult> {
  const bookName = String(params.bookName || '').trim();
  if (!bookName) throw new Error('未选择世界书');

  const rawEntries = await readWorldbookEntries(bookName);
  if (rawEntries.length === 0) throw new Error(`世界书「${bookName}」没有可读取的条目`);

  const mode: WorldbookExtractMode = params.mode === 'full' ? 'full' : 'fast';
  const prepared = prepareWorldbookText(rawEntries, { mode });
  if (prepared.chunks.length === 0) {
    throw new Error(`世界书「${bookName}」过滤后没有可用的世界观内容（可能全是脚本产物或空条目）`);
  }

  // 按索引存放各批结果 → 并发下仍能保证累计顺序确定（主名投票依赖顺序）
  const results: Array<{ items: WorldbookCharacterItem[] } | null> =
    new Array(prepared.chunks.length).fill(null);
  const totalBatches = prepared.chunks.length;
  let failedBatches = 0;
  let aborted = false;

  params.onProgress?.({
    phase: 'prepared',
    total: totalBatches,
    usedEntries: prepared.usedEntries,
    skippedEntries: prepared.skippedEntries,
    totalChars: prepared.totalChars,
    mode,
  });

  /** 按索引顺序累积（保证并发下结果顺序稳定） */
  const accumulate = (): WorldbookCharacterItem[] => {
    const acc: WorldbookCharacterItem[] = [];
    for (const r of results) if (r) acc.push(...r.items);
    return acc;
  };
  const loadedCount = () => results.filter(Boolean).length;

  /** 把「截至当前」的合并结果推给 UI */
  const emitBatch = (batchIndex: number, batchCount: number, failed: boolean, tokens: string[]) => {
    const acc = accumulate();
    params.onProgress?.({
      phase: 'batch',
      done: loadedCount(),
      total: totalBatches,
      batchIndex,
      batchCount,
      failed,
      batchTokens: tokens,
      items: acc.length > 0 ? mergeAcrossBatches(acc) : [],
    });
  };

  /** 跑一批（返回该批的角色；失败返回 null） */
  const runBatch = async (i: number): Promise<WorldbookCharacterItem[] | null> => {
    const instruction = buildExtractInstruction(prepared.chunks[i], params.userName || '{{user}}');
    const raw = await callGenerateRaw({
      user_input: instruction,
      _monitorLabel: `世界书提取角色(${i + 1}/${totalBatches})`,
      _analysisType: 'character_extract',
      _temperature: 0.2,
      _maxTokens: 8192,
      _maxRetries: 2,
      _responseFormat: 'json_object',
      max_chat_history: 0,
      ordered_prompts: ['user_input'],
      _abortSignal: params.abortSignal,
    });
    const cleaned = String(raw || '').replace(/<\/?(?:think(?:ing)?)>/gi, '').trim();
    const jsonText = extractJson(cleaned);
    const parsed = jsonText ? safeJsonParse(jsonText, ExtractSchema) : null;
    const items = parsed?.characters || [];
    const batchItems: WorldbookCharacterItem[] = [];
    for (const item of items) {
      const name = String(item.name || '').trim();
      if (!name) continue;
      batchItems.push({
        name,
        aliases: (item.aliases || []).map(a => String(a || '').trim()).filter(Boolean),
      });
    }
    return batchItems;
  };

  // 批次并发（仅多批时生效）：worker 按 stride 取批，保证顺序无关但结果按索引归位
  const workerCount = Math.min(WORLDBOOK_BATCH_CONCURRENCY, totalBatches);
  const worker = async (startIndex: number) => {
    for (let i = startIndex; i < totalBatches; i += workerCount) {
      // 暂停语义：已完成的批次结果保留，直接停手
      if (params.abortSignal?.aborted) { aborted = true; return; }
      try {
        const batchItems = await runBatch(i);
        results[i] = { items: batchItems || [] };
        logInfo('世界书提取', `第 ${i + 1}/${totalBatches} 批完成，提取 ${(batchItems || []).length} 个角色`);
        emitBatch(i + 1, (batchItems || []).length, false, tokenizeItems(batchItems || []));
      } catch (error) {
        if ((error as any)?.name === 'AbortError' || params.abortSignal?.aborted) {
          aborted = true;
          return;
        }
        failedBatches++;
        results[i] = { items: [] };
        logWarn('世界书提取', `第 ${i + 1}/${totalBatches} 批失败`, String(error));
        emitBatch(i + 1, 0, true, []);
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, (_, k) => worker(k)));

  const collected = accumulate();
  const doneBatches = loadedCount();

  if (collected.length === 0 && !aborted) {
    throw new Error(
      failedBatches > 0
        ? `提取失败（${failedBatches}/${prepared.chunks.length} 批出错），请检查 API 配置`
        : '未从该世界书中提取到任何角色',
    );
  }

  return {
    items: collected.length > 0 ? mergeAcrossBatches(collected) : [],
    batches: prepared.chunks.length,
    doneBatches,
    totalChars: prepared.totalChars,
    usedEntries: prepared.usedEntries,
    skippedEntries: prepared.skippedEntries,
    aborted,
    failedBatches,
    mode,
  };
}
