/**
 * 知识图谱（地点 + 物品 + 人物）
 *
 * 设计参考 A5.1 的"本体驱动 + 边建模"思路，但改为**搭车小总结**：
 * - 不再单独 API 调用建图，而是每轮小总结顺带输出 graphDiff（一次调用两份产物）。
 * - 提示词不再全量铺开整个图谱清单（A5.1 的 token 爆炸根源），
 *   而是用 embedding 召回 top-K 相关已有实体（带 brief 供 update 判断），
 *   不在召回清单内的实体 AI 不需要管；本次正文新出现的地点/物品/人物直接 add。
 * - 节点（地点/物品/人物）只承载自身属性，关系全部下沉为边。
 *   包含关系 = contains 边；连通关系 = connected 边（带路径+方向）；物品归属 = belongs_to 边。
 * - AI 输出 diff 式增量（add/update/delete），由代码端按 id 去重合并。
 * - 人物节点只记录当前位置（location），不参与边关系。
 *
 * 存储位置：ChatData.knowledgeGraph（每条聊天独立）。
 */

import { extractJson, safeJsonParse } from '../utils/jsonParse';
import { KnowledgeGraphDiffSchema } from '../utils/schemas';
import { charBigramSimilarity, cosineSimilarity, getBatchEmbeddings, type EmbeddingSettings } from './embedding';
import { logInfo, logWarn } from '../utils/logger';

/** 地点节点 */
export interface GraphLocation {
  /** 稳定键：slug(name)，代码端归一化生成 */
  id: string;
  /** 正式名称 */
  name: string;
  /** 简述 */
  brief: string;
  /** 别名（非正式名，匹配用） */
  aliases?: string[];
  /** 语义向量（召回用，可选；未补算时降级 charBigram） */
  embedding?: number[];
}

/** 物品节点 */
export interface GraphItem {
  /** 稳定键：slug(name) */
  id: string;
  /** 正式名称 */
  name: string;
  /** 基本描述 */
  brief: string;
  aliases?: string[];
  /** 数量，单独记录，不写入 brief */
  quantity?: string;
  /** 已消耗/已毁/已用尽，不能再作为当前可用物品注入 */
  consumed?: boolean;
  /** 语义向量（召回用，可选） */
  embedding?: number[];
}

/** 人物节点 — 只记录当前位置 */
export interface GraphCharacter {
  /** 稳定键：slug(name) */
  id: string;
  /** 正式名称 */
  name: string;
  /** 当前所在地点名 */
  location: string;
  aliases?: string[];
  /** 语义向量（召回用，可选） */
  embedding?: number[];
}

/** 边：地点包含 / 地点连通 / 物品归属 */
export interface GraphEdge {
  type: 'contains' | 'connected' | 'belongs_to';
  /** 起点 id（父地点 / 连通起点 / 物品） */
  from: string;
  /** 终点 id 或角色正式名（子地点 / 连通终点 / 归属对象） */
  to: string;
  /**
   * 细节描述：
   * - contains：留空
   * - connected：从 from 到 to 的路径描述（如"走过一段小路，推开石门"）；from→to 表方向
   * - belongs_to：具体状态/位置细节（如"拿在手上"/"床头的木盒中"/"已被user喝光"）
   */
  detail?: string;
}

/** 完整知识图谱快照（每次更新后整体替换；旧版进撤回栈） */
export interface KnowledgeGraph {
  locations: GraphLocation[];
  items: GraphItem[];
  characters: GraphCharacter[];
  edges: GraphEdge[];
  version: number;
  updatedAt: string;
}

/** AI 输出的 diff 式增量（小总结顺带输出，挂在 graphDiff 字段） */
export interface KnowledgeGraphDiff {
  add: {
    locations?: Array<{
      name: string;
      brief?: string;
      aliases?: string[];
    }>;
    items?: Array<{
      name: string;
      brief?: string;
      aliases?: string[];
      quantity?: string;
      belongTo?: string;
      state?: string;
      consumed?: boolean;
    }>;
    edges?: Array<{
      type?: string;
      from: string;
      to: string;
      detail?: string;
    }>;
    characters?: Array<{
      name: string;
      location: string;
      aliases?: string[];
    }>;
  };
  update?: Array<{
    id: string;
    field: string;
    value: any;
  }>;
  delete?: string[];
}

/** 召回的单个实体（带相似度分数，供消费点格式化） */
export interface RecalledEntity {
  kind: 'location' | 'item' | 'character';
  id: string;
  name: string;
  brief: string;
  aliases?: string[];
  /** 物品归属对象名（角色名/地点名，来自 belongs_to 边） */
  belongTo?: string;
  /** 物品具体状态/位置细节（belongs_to 边的 detail） */
  state?: string;
  /** 物品数量 */
  quantity?: string;
  /** 已消耗/已毁/已用尽，召回时可作为历史事实提示 */
  consumed?: boolean;
  sim: number;
}

export type KnowledgeGraphVectorKind = 'location' | 'item';

export interface KnowledgeGraphEmbeddingCacheEntry {
  textHash: string;
  embedding: number[];
  updatedAt?: string;
}

export interface KnowledgeGraphEmbeddingCache {
  locations?: Record<string, Record<string, KnowledgeGraphEmbeddingCacheEntry>>;
  items?: Record<string, Record<string, KnowledgeGraphEmbeddingCacheEntry>>;
}

export interface KnowledgeGraphRecallOptions {
  /** Optional node-name whitelist kept for backward compatibility. */
  nodeFilter?: Set<string>;
  /** Latest graph that may carry embeddings; candidates still come from the structure graph. */
  vectorGraph?: KnowledgeGraph | null;
  /** Exact old-node vectors keyed by node id + embed-text hash. */
  embeddingCache?: KnowledgeGraphEmbeddingCache | null;
}

export interface SmallSummaryKgDigestOptions {
  query: string;
  graph: KnowledgeGraph;
  topK?: number;
  queryEmb?: number[] | null;
  vectorGraph?: KnowledgeGraph | null;
  embeddingCache?: KnowledgeGraphEmbeddingCache | null;
  /** 小总结中心角色：主角 + 本次后台推演角色。 */
  centerCharacterNames?: string[];
  /** 小总结中心地点：后台推演角色地点，或调用方显式传入的地点。 */
  centerLocationNames?: string[];
  /** 楼层感知角色位置快照；玩家通常不在 graph.characters 中，需要从这里取位置。 */
  characterLocations?: Record<string, string>;
  /** 中心角色/地点展开的物品上限，防止小总结材料膨胀。 */
  centerItemLimit?: number;
  /** 正文直接命中的旧实体上限。 */
  exactMatchLimit?: number;
}

// ========== 工具函数 ==========

/** 把任意字符串归一化为稳定 id（小写、去空白标点） */
export function buildStableId(name: string, parent?: string): string {
  const slug = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[【】\[\]()（）《》<>、，,.。·\-_]/g, '')
      .replace(/\s+/g, '');
  return parent ? `${slug(name)}@${slug(parent)}` : slug(name);
}

/** 创建空图谱 */
export function createEmptyKnowledgeGraph(): KnowledgeGraph {
  return {
    locations: [],
    items: [],
    characters: [],
    edges: [],
    version: 0,
    updatedAt: '',
  };
}

export function createEmptyKnowledgeGraphEmbeddingCache(): KnowledgeGraphEmbeddingCache {
  return { locations: {}, items: {} };
}

export function ensureKnowledgeGraphEmbeddingCache(cache?: KnowledgeGraphEmbeddingCache | null): KnowledgeGraphEmbeddingCache {
  if (!cache) return createEmptyKnowledgeGraphEmbeddingCache();
  cache.locations ||= {};
  cache.items ||= {};
  return cache;
}

function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function getNodeEmbedText(kind: KnowledgeGraphVectorKind, node: GraphLocation | GraphItem): string {
  return kind === 'location'
    ? buildLocationEmbedText(node as GraphLocation)
    : buildKgItemEmbedText(node as GraphItem);
}

function getNodeTextHash(kind: KnowledgeGraphVectorKind, node: GraphLocation | GraphItem): string {
  return hashText(getNodeEmbedText(kind, node));
}

function getCacheBucket(
  cache: KnowledgeGraphEmbeddingCache,
  kind: KnowledgeGraphVectorKind,
): Record<string, Record<string, KnowledgeGraphEmbeddingCacheEntry>> {
  const normalized = ensureKnowledgeGraphEmbeddingCache(cache);
  return kind === 'location' ? normalized.locations! : normalized.items!;
}

function writeNodeEmbeddingCache(
  cache: KnowledgeGraphEmbeddingCache | null | undefined,
  kind: KnowledgeGraphVectorKind,
  node: GraphLocation | GraphItem,
): void {
  if (!cache || !node.embedding || node.embedding.length === 0) return;
  const bucket = getCacheBucket(cache, kind);
  const hash = getNodeTextHash(kind, node);
  bucket[node.id] ||= {};
  bucket[node.id][hash] = {
    textHash: hash,
    embedding: node.embedding,
    updatedAt: new Date().toISOString(),
  };
}

function readNodeEmbeddingCache(
  cache: KnowledgeGraphEmbeddingCache | null | undefined,
  kind: KnowledgeGraphVectorKind,
  node: GraphLocation | GraphItem,
): number[] | undefined {
  if (!cache) return undefined;
  const bucket = getCacheBucket(cache, kind);
  const hash = getNodeTextHash(kind, node);
  return bucket[node.id]?.[hash]?.embedding;
}

export function syncKnowledgeGraphEmbeddingCache(
  graph: KnowledgeGraph | null,
  cache: KnowledgeGraphEmbeddingCache | null | undefined,
): void {
  if (!graph || !cache) return;
  ensureKnowledgeGraphEmbeddingCache(cache);
  for (const loc of graph.locations || []) writeNodeEmbeddingCache(cache, 'location', loc);
  for (const it of graph.items || []) writeNodeEmbeddingCache(cache, 'item', it);
}

export function hydrateKnowledgeGraphEmbeddingsFromCache(
  graph: KnowledgeGraph | null,
  cache: KnowledgeGraphEmbeddingCache | null | undefined,
): number {
  if (!graph || !cache) return 0;
  let restored = 0;
  for (const loc of graph.locations || []) {
    if (loc.embedding && loc.embedding.length > 0) continue;
    const cached = readNodeEmbeddingCache(cache, 'location', loc);
    if (cached && cached.length > 0) {
      loc.embedding = cached;
      restored++;
    }
  }
  for (const it of graph.items || []) {
    if (it.embedding && it.embedding.length > 0) continue;
    const cached = readNodeEmbeddingCache(cache, 'item', it);
    if (cached && cached.length > 0) {
      it.embedding = cached;
      restored++;
    }
  }
  return restored;
}

export function pruneKnowledgeGraphEmbeddingCache(
  cache: KnowledgeGraphEmbeddingCache | null | undefined,
  graphs: Array<KnowledgeGraph | null | undefined>,
): void {
  if (!cache) return;
  const normalized = ensureKnowledgeGraphEmbeddingCache(cache);
  const keep = {
    location: new Map<string, Set<string>>(),
    item: new Map<string, Set<string>>(),
  };

  const remember = (kind: KnowledgeGraphVectorKind, node: GraphLocation | GraphItem) => {
    const map = kind === 'location' ? keep.location : keep.item;
    const hash = getNodeTextHash(kind, node);
    if (!map.has(node.id)) map.set(node.id, new Set<string>());
    map.get(node.id)!.add(hash);
  };

  for (const graph of graphs) {
    if (!graph) continue;
    for (const loc of graph.locations || []) remember('location', loc);
    for (const it of graph.items || []) remember('item', it);
  }

  const pruneBucket = (
    bucket: Record<string, Record<string, KnowledgeGraphEmbeddingCacheEntry>>,
    keepMap: Map<string, Set<string>>,
  ) => {
    for (const id of Object.keys(bucket)) {
      const allowedHashes = keepMap.get(id);
      if (!allowedHashes) {
        delete bucket[id];
        continue;
      }
      for (const hash of Object.keys(bucket[id])) {
        if (!allowedHashes.has(hash)) delete bucket[id][hash];
      }
      if (Object.keys(bucket[id]).length === 0) delete bucket[id];
    }
  };

  pruneBucket(normalized.locations!, keep.location);
  pruneBucket(normalized.items!, keep.item);
}

/** 判断 diff 是否为"空变更"（无 add/update/delete） */
export function isEmptyDiff(diff: KnowledgeGraphDiff): boolean {
  const addCount =
    (diff.add?.locations?.length || 0) +
    (diff.add?.items?.length || 0) +
    (diff.add?.characters?.length || 0) +
    (diff.add?.edges?.length || 0);
  return addCount === 0 && (diff.update?.length || 0) === 0 && (diff.delete?.length || 0) === 0;
}

/**
 * 生成一份深拷贝并剥离所有节点的 embedding 向量。
 * 用途：把图谱历史快照(versions/history/undoHistory)在持久化前瘦身——
 *   这些快照只用于"看一下旧版结构/回滚还原"，回滚后会变成当前图谱，
 *   届时由 hasMissingEmbedding + embedKnowledgeGraphNodes lazy 补算向量即可。
 * 当前图谱(knowledgeGraph)不经此函数，保留 embedding 供召回 cosine 用。
 */
export function stripEmbeddingsFromGraph(graph: KnowledgeGraph): KnowledgeGraph {
  const clone: KnowledgeGraph = JSON.parse(JSON.stringify(graph));
  for (const loc of clone.locations) {
    if (loc.embedding) loc.embedding = undefined;
  }
  for (const it of clone.items) {
    if (it.embedding) it.embedding = undefined;
  }
  for (const ch of clone.characters || []) {
    if (ch.embedding) ch.embedding = undefined;
  }
  return clone;
}

/**
 * 检测图谱是否有任意节点缺 embedding（用于 reload 后 lazy re-embed 触发）。
 * 任意 location/item/character 的 embedding 为 undefined 或空数组即视为缺失。
 */
export function hasMissingEmbedding(graph: KnowledgeGraph | null): boolean {
  if (!graph) return false;
  const hasEmb = (e?: number[]) => Array.isArray(e) && e.length > 0;
  for (const loc of graph.locations) {
    if (!hasEmb(loc.embedding)) return true;
  }
  for (const it of graph.items) {
    if (!hasEmb(it.embedding)) return true;
  }
  // 角色节点不再嵌入，不检查
  return false;
}

// ========== 输出解析（小总结 parseOutput 复用） ==========

/**
 * 从一段 AI 文本中抽取 graphDiff。
 * 兼容两种模式：
 * ① 小总结固定格式正文里独立的 graphDiff JSON 块（包在 ```json 或 <knowledge_graph> 标签内）
 * ② 小总结整体 JSON 输出里的一个 graphDiff 字段
 * 解析失败或为空结构时返回 null（调用方据此跳过 commit）。
 */
export function parseKnowledgeGraphDiff(rawText: string): KnowledgeGraphDiff | null {
  if (!rawText) return null;
  let text = rawText.trim();

  // ① 优先尝试从整体 JSON 中取 graphDiff 字段
  const cleaned = text.replace(/<\/?thinking>/gi, '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
  const jsonText = extractJson(cleaned);
  if (jsonText) {
    try {
      const obj = JSON.parse(jsonText);
      if (obj && typeof obj === 'object' && obj.graphDiff) {
        const parsed = safeJsonParse(JSON.stringify(obj.graphDiff), KnowledgeGraphDiffSchema);
        if (parsed && !isEmptyDiff(parsed)) return parsed as KnowledgeGraphDiff;
      }
    } catch {
      // 继续走 ②
    }
  }

  // ② 尝试 <knowledge_graph> 标签内的 JSON
  const tagMatch = text.match(/<knowledge_graph>([\s\S]*?)(?:<\/knowledge_graph>|$)/i);
  if (tagMatch) {
    const innerJson = extractJson(tagMatch[1].trim());
    if (innerJson) {
      const parsed = safeJsonParse(innerJson, KnowledgeGraphDiffSchema);
      if (parsed && !isEmptyDiff(parsed)) return parsed as KnowledgeGraphDiff;
    }
  }

  return null;
}

// ========== 工具：合并去重 / 字段更新 / 归属边 ==========

function mergeUnique(...arrays: string[][]): string[] {
  const set = new Set<string>();
  for (const a of arrays) for (const x of a) if (x) set.add(x);
  return [...set];
}

const ALLOWED_UPDATE_FIELDS = ['name', 'brief', 'aliases', 'location'];

function applyFieldUpdate(node: any, field: string, value: any): void {
  if (!ALLOWED_UPDATE_FIELDS.includes(field)) return;
  node[field] = value;
}

function rememberEntityName(map: Map<string, string>, name: string | undefined, id: string): void {
  if (!name) return;
  map.set(name.trim(), id);
  map.set(buildStableId(name), id);
}

function resolveByNameOrAlias<T extends { id: string; name: string; aliases?: string[] }>(
  nodes: T[],
  lookup: Map<string, string>,
  name: string,
  aliases: string[] = [],
): T | undefined {
  const candidates = [name, ...aliases].map(s => s?.trim()).filter(Boolean);
  for (const c of candidates) {
    const id = lookup.get(c) || lookup.get(buildStableId(c));
    if (id) {
      const existing = nodes.find(n => n.id === id);
      if (existing) return existing;
    }
  }
  const id = buildStableId(name);
  return nodes.find(n => n.id === id);
}

function mergeAliasFromIncoming(existingName: string, incomingName: string, incomingAliases: string[] = []): string[] {
  const aliases = [...incomingAliases];
  if (incomingName && incomingName !== existingName) aliases.push(incomingName);
  return aliases;
}

/** 物品归属：插入或更新 belongs_to 边（to = 地点 id 或角色名，detail = 具体状态） */
function upsertBelongsTo(
  graph: KnowledgeGraph,
  itemId: string,
  belongTo: string,
  state: string,
  locNameToId: Map<string, string>,
  charNameToCanonical?: Map<string, string>,
): void {
  const target = belongTo.trim();
  if (!target) return;
  // 地点命中→用 id；否则视为角色名（角色不是图节点，保留原名）
  const to = locNameToId.get(target)
    || locNameToId.get(buildStableId(target))
    || charNameToCanonical?.get(target)
    || charNameToCanonical?.get(buildStableId(target))
    || target;
  const existing = graph.edges.find(e => e.type === 'belongs_to' && e.from === itemId);
  if (existing) {
    const targetChanged = existing.to !== to;
    existing.to = to;
    if (state) existing.detail = state;
    else if (targetChanged) existing.detail = undefined;
  } else {
    graph.edges.push({ type: 'belongs_to', from: itemId, to, detail: state || undefined });
  }
}

// ========== 增量合并 ==========

/**
 * 将 AI 输出的 diff 应用到图谱，返回新图谱（深拷贝，不污染撤回栈引用）。
 * - add：按 buildStableId(name) 去重，同名已存在→合并字段（update 语义），否则新增
 * - update：按 id 改单字段（白名单）
 * - delete：按 id 过滤地点/物品 + 清理引用被删节点的边
 */
export function applyKnowledgeGraphDiff(graph: KnowledgeGraph, diff: KnowledgeGraphDiff): KnowledgeGraph {
  const next: KnowledgeGraph = JSON.parse(JSON.stringify(graph));

  // 名称 → 地点 id 映射（含别名），用于 resolve edges/belongTo
  const locNameToId = new Map<string, string>();
  const locLookupToId = new Map<string, string>();
  for (const l of next.locations) {
    rememberEntityName(locNameToId, l.name, l.id);
    rememberEntityName(locLookupToId, l.name, l.id);
    rememberEntityName(locLookupToId, l.id, l.id);
    for (const a of l.aliases || []) {
      rememberEntityName(locNameToId, a, l.id);
      rememberEntityName(locLookupToId, a, l.id);
    }
  }
  const resolveLocId = (name: string): string => {
    const n = name.trim();
    return locNameToId.get(n) || locNameToId.get(buildStableId(n)) || buildStableId(n);
  };

  const itemLookupToId = new Map<string, string>();
  const rememberItem = (it: GraphItem) => {
    rememberEntityName(itemLookupToId, it.name, it.id);
    rememberEntityName(itemLookupToId, it.id, it.id);
    for (const a of it.aliases || []) rememberEntityName(itemLookupToId, a, it.id);
  };
  for (const it of next.items) rememberItem(it);

  const charLookupToName = new Map<string, string>();
  const rememberChar = (ch: GraphCharacter) => {
    rememberEntityName(charLookupToName, ch.name, ch.name);
    rememberEntityName(charLookupToName, ch.id, ch.name);
    for (const a of ch.aliases || []) rememberEntityName(charLookupToName, a, ch.name);
  };
  for (const ch of next.characters || []) rememberChar(ch);

  // —— add.locations ——
  for (const loc of diff.add?.locations || []) {
    if (!loc.name) continue;
    const id = buildStableId(loc.name);
    const existing = resolveByNameOrAlias(next.locations, locLookupToId, loc.name, loc.aliases || []);
    if (existing) {
      if (loc.brief) existing.brief = loc.brief;
      const aliases = mergeAliasFromIncoming(existing.name, loc.name, loc.aliases || []);
      if (aliases.length) existing.aliases = mergeUnique(existing.aliases || [], aliases);
      rememberEntityName(locNameToId, existing.name, existing.id);
      rememberEntityName(locLookupToId, existing.name, existing.id);
      for (const a of existing.aliases || []) {
        rememberEntityName(locNameToId, a, existing.id);
        rememberEntityName(locLookupToId, a, existing.id);
      }
    } else {
      const newNode: GraphLocation = {
        id,
        name: loc.name,
        brief: loc.brief || '',
        aliases: loc.aliases?.length ? [...loc.aliases] : undefined,
      };
      next.locations.push(newNode);
      rememberEntityName(locNameToId, newNode.name, newNode.id);
      rememberEntityName(locLookupToId, newNode.name, newNode.id);
      rememberEntityName(locLookupToId, newNode.id, newNode.id);
      for (const a of newNode.aliases || []) {
        rememberEntityName(locNameToId, a, newNode.id);
        rememberEntityName(locLookupToId, a, newNode.id);
      }
    }
  }

  // —— add.edges（地点 contains/connected）——
  for (const e of diff.add?.edges || []) {
    if (!e.from || !e.to) continue;
    const type: 'contains' | 'connected' = e.type === 'connected' ? 'connected' : 'contains';
    let from = resolveLocId(e.from);
    let to = resolveLocId(e.to);
    if (type === 'connected' && from > to) {
      [from, to] = [to, from];
    }
    const dup = type === 'connected'
      ? next.edges.find(x => x.type === type && (
          (x.from === from && x.to === to) || (x.from === to && x.to === from)
        ))
      : next.edges.find(x => x.type === type && x.from === from && x.to === to);
    if (dup) {
      if (e.detail && !dup.detail) dup.detail = e.detail;
      continue;
    }
    next.edges.push({ type, from, to, detail: e.detail || undefined });
  }

  // —— add.characters（同名覆盖：同一角色新位置替换旧位置）——
  for (const ch of diff.add?.characters || []) {
    if (!ch.name) continue;
    const id = buildStableId(ch.name);
    const canonical = charLookupToName.get(ch.name) || charLookupToName.get(buildStableId(ch.name));
    const existing = canonical
      ? next.characters.find(c => c.name === canonical)
      : resolveByNameOrAlias(next.characters, new Map([...next.characters.map(c => [c.id, c.id] as const), ...Array.from(charLookupToName.entries()).map(([k, v]) => [k, buildStableId(v)] as const)]), ch.name, ch.aliases || []);
    if (existing) {
      if (ch.location) existing.location = ch.location;
      const aliases = mergeAliasFromIncoming(existing.name, ch.name, ch.aliases || []);
      if (aliases.length) existing.aliases = mergeUnique(existing.aliases || [], aliases);
      rememberChar(existing);
    } else {
      const newNode: GraphCharacter = {
        id,
        name: ch.name,
        location: ch.location || '',
        aliases: ch.aliases?.length ? [...ch.aliases] : undefined,
      };
      next.characters.push(newNode);
      rememberChar(newNode);
    }
  }

  // —— add.items ——
  for (const it of diff.add?.items || []) {
    if (!it.name) continue;
    const id = buildStableId(it.name);
    const existing = resolveByNameOrAlias(next.items, itemLookupToId, it.name, it.aliases || []);
    if (existing) {
      if (it.brief) existing.brief = it.brief;
      if (typeof it.quantity === 'string') existing.quantity = it.quantity.trim() || undefined;
      if (typeof it.consumed === 'boolean') existing.consumed = it.consumed;
      const aliases = mergeAliasFromIncoming(existing.name, it.name, it.aliases || []);
      if (aliases.length) existing.aliases = mergeUnique(existing.aliases || [], aliases);
      rememberItem(existing);
      if (it.belongTo) upsertBelongsTo(next, existing.id, it.belongTo, it.state || '', locNameToId, charLookupToName);
    } else {
      const newNode: GraphItem = {
        id,
        name: it.name,
        brief: it.brief || '',
        aliases: it.aliases?.length ? [...it.aliases] : undefined,
        quantity: it.quantity?.trim() || undefined,
        consumed: it.consumed === true ? true : undefined,
      };
      next.items.push(newNode);
      rememberItem(newNode);
      if (it.belongTo) upsertBelongsTo(next, newNode.id, it.belongTo, it.state || '', locNameToId, charLookupToName);
    }
  }

  // —— update ——
  for (const u of diff.update || []) {
    const { id, field, value } = u;
    const itemOnlyField = ['quantity', 'count', 'amount', 'consumed', 'isConsumed', 'usedUp', 'depleted', 'belongTo', 'owner', 'currentOwner', 'state', 'currentState'].includes(field);
    const itemFirst = itemOnlyField ? next.items.find(i => i.id === id) : undefined;
    if (itemFirst) {
      if (['consumed', 'isConsumed', 'usedUp', 'depleted'].includes(field)) {
        itemFirst.consumed = value === true || value === 'true' || value === '已消耗' || value === '是';
      } else if (['quantity', 'count', 'amount'].includes(field)) {
        const text = String(value ?? '').trim();
        itemFirst.quantity = text || undefined;
      } else if (['belongTo', 'owner', 'currentOwner'].includes(field) && typeof value === 'string') {
        const current = next.edges.find(e => e.type === 'belongs_to' && e.from === itemFirst.id);
        upsertBelongsTo(next, itemFirst.id, value, current?.detail || '', locNameToId, charLookupToName);
      } else if (['state', 'currentState'].includes(field) && typeof value === 'string') {
        const current = next.edges.find(e => e.type === 'belongs_to' && e.from === itemFirst.id);
        if (current) current.detail = value;
      }
      continue;
    }
    const loc = next.locations.find(l => l.id === id);
    if (loc) { applyFieldUpdate(loc, field, value); continue; }
    const item = next.items.find(i => i.id === id);
    if (item) {
      if (['consumed', 'isConsumed', 'usedUp', 'depleted'].includes(field)) {
        item.consumed = value === true || value === 'true' || value === '已消耗' || value === '是';
      } else if (['quantity', 'count', 'amount'].includes(field)) {
        const text = String(value ?? '').trim();
        item.quantity = text || undefined;
      } else if (['belongTo', 'owner', 'currentOwner', 'location'].includes(field) && typeof value === 'string') {
        const current = next.edges.find(e => e.type === 'belongs_to' && e.from === item.id);
        upsertBelongsTo(next, item.id, value, current?.detail || '', locNameToId, charLookupToName);
      } else if (['state', 'currentState'].includes(field) && typeof value === 'string') {
        const current = next.edges.find(e => e.type === 'belongs_to' && e.from === item.id);
        if (current) current.detail = value;
      } else {
        applyFieldUpdate(item, field, value);
      }
      continue;
    }
    const ch = next.characters.find(c => c.id === id);
    if (ch) {
      applyFieldUpdate(ch, field, value);
      continue;
    }
    // 兜底：update 目标在 locations/items/characters 三处都找不到 →
    // 若 field === 'location' 则视为角色节点首次出现（常见于世界推进材料中的角色），
    // 自动创建最小角色节点，再执行 update 写入 location。
    if (field === 'location' && typeof value === 'string') {
      next.characters.push({ id, name: id, location: value });
      const created = next.characters.find(c => c.id === id);
      if (created) applyFieldUpdate(created, field, value);
      logInfo('知识图谱', `自动创建角色节点: ${id} @${value}`);
    }
  }

  // —— delete ——
  const delSet = new Set(diff.delete || []);
  if (delSet.size > 0) {
    next.locations = next.locations.filter(l => !delSet.has(l.id));
    next.items = next.items.filter(i => !delSet.has(i.id));
    next.characters = next.characters.filter(c => !delSet.has(c.id));
    // 清理引用被删节点的边（from 恒为 id；to 为 id 或角色名，角色名不在 delSet 内故保留）
    next.edges = next.edges.filter(e => !delSet.has(e.from) && !delSet.has(e.to));
  }

  next.version = (next.version || 0) + 1;
  next.updatedAt = new Date().toISOString();
  return next;
}

// ========== 召回：embedding 语义优先，降级 charBigram ==========

/**
 * 从图谱中按查询文本召回 top-k 地点/物品。
 * - 优先用 queryEmb 对各节点预存 embedding 做余弦相似度（精度高）
 * - queryEmb 为空或某节点无 embedding 时，降级用 charBigram Jaccard（同步、无 API）
 * 物品会顺带查 belongs_to 边带上归属名+状态，供格式化时直接展示。
 * 返回结构化数组（按相似度降序），供消费点自行格式化。
 */
function getRecallEmbedding(
  kind: KnowledgeGraphVectorKind,
  node: GraphLocation | GraphItem,
  options: KnowledgeGraphRecallOptions,
): number[] | undefined {
  if (node.embedding && node.embedding.length > 0) return node.embedding;

  const cached = readNodeEmbeddingCache(options.embeddingCache, kind, node);
  if (cached && cached.length > 0) return cached;

  const vectorNode = kind === 'location'
    ? options.vectorGraph?.locations?.find(l => l.id === node.id || l.name === node.name)
    : options.vectorGraph?.items?.find(it => it.id === node.id || it.name === node.name);
  return vectorNode?.embedding && vectorNode.embedding.length > 0 ? vectorNode.embedding : undefined;
}

export function recallKnowledgeGraph(
  query: string,
  graph: KnowledgeGraph | null,
  topK: number = 8,
  queryEmb?: number[] | null,
  /** 可选节点名白名单，或旧图结构+向量载体的召回选项 */
  nodeFilterOrOptions?: Set<string> | KnowledgeGraphRecallOptions,
): RecalledEntity[] {
  if (!graph) return [];
  const q = (query || '').trim();
  if (!q && !queryEmb) return [];
  const options: KnowledgeGraphRecallOptions = nodeFilterOrOptions instanceof Set
    ? { nodeFilter: nodeFilterOrOptions }
    : (nodeFilterOrOptions || {});

  // 物品 id → 归属名+状态（从 belongs_to 边推导）
  const itemBelong = new Map<string, { belongTo: string; state: string }>();
  for (const e of graph.edges) {
    if (e.type !== 'belongs_to') continue;
    const toName = graph.locations.find(l => l.id === e.to)?.name || e.to;
    itemBelong.set(e.from, { belongTo: toName, state: e.detail || '' });
  }

  const candidates: RecalledEntity[] = [];
  const useEmb = !!queryEmb && queryEmb.length > 0;
  const filterSet = options.nodeFilter ?? null;

  for (const l of graph.locations) {
    if (filterSet && !filterSet.has(l.name)) continue;
    let sim = 0;
    const emb = getRecallEmbedding('location', l, options);
    if (useEmb && emb && emb.length > 0) {
      // 维度防御：查询向量与节点向量维度不一致（混维度数据/跨维度未重嵌）→ 跳过该节点走 bigram
      if (queryEmb!.length === emb.length) {
        sim = cosineSimilarity(queryEmb!, emb);
      }
    }
    if (sim === 0) {
      const text = [l.name, l.brief, ...(l.aliases || [])].filter(Boolean).join(' ');
      sim = q ? charBigramSimilarity(q, text) : 0;
      // 子串命中加成：查询中包含节点名或别名时，至少给 0.6（精确名称匹配不依赖 embedding）
      if (sim < 0.6 && q) {
        const names = [l.name, ...(l.aliases || [])];
        if (names.some(n => q.includes(n))) sim = Math.max(sim, 0.6);
      }
    }
    candidates.push({
      kind: 'location',
      id: l.id,
      name: l.name,
      brief: l.brief || '',
      aliases: l.aliases,
      sim,
    });
  }

  for (const it of graph.items) {
    if (filterSet && !filterSet.has(it.name)) continue;
    let sim = 0;
    const emb = getRecallEmbedding('item', it, options);
    if (useEmb && emb && emb.length > 0) {
      // 维度防御
      if (queryEmb!.length === emb.length) {
        sim = cosineSimilarity(queryEmb!, emb);
      }
    }
    if (sim === 0) {
      const text = [it.name, it.brief, ...(it.aliases || [])].filter(Boolean).join(' ');
      sim = q ? charBigramSimilarity(q, text) : 0;
      // 子串命中加成：
      if (sim < 0.6 && q) {
        const names = [it.name, ...(it.aliases || [])];
        if (names.some(n => q.includes(n))) sim = Math.max(sim, 0.6);
      }
    }
    const belong = itemBelong.get(it.id);
    candidates.push({
      kind: 'item',
      id: it.id,
      name: it.name,
      brief: it.brief || '',
      aliases: it.aliases,
      quantity: it.quantity,
      belongTo: belong?.belongTo,
      state: belong?.state,
      consumed: it.consumed === true,
      sim,
    });
  }

  // 角色节点也参与召回：让 AI 知道"师尊"是"清月"的别名，避免把别名当新角色独立 add。
  // 角色节点的 brief 复用为「当前所在地点」，匹配文本 = 名字 + 别名 + 当前地点。
  for (const ch of graph.characters || []) {
    if (filterSet && !filterSet.has(ch.name)) continue;
    let sim = 0;
    if (useEmb && ch.embedding && ch.embedding.length > 0) {
      if (queryEmb!.length === ch.embedding.length) {
        sim = cosineSimilarity(queryEmb!, ch.embedding);
      }
    }
    if (sim === 0) {
      const text = [ch.name, ch.location, ...(ch.aliases || [])].filter(Boolean).join(' ');
      sim = q ? charBigramSimilarity(q, text) : 0;
      // 子串命中加成：正文中提到角色名或别名时强召回
      if (sim < 0.6 && q) {
        const names = [ch.name, ...(ch.aliases || [])];
        if (names.some(n => q.includes(n))) sim = Math.max(sim, 0.6);
      }
    }
    candidates.push({
      kind: 'character',
      id: ch.id,
      name: ch.name,
      brief: ch.location || '',
      aliases: ch.aliases,
      sim,
    });
  }

  if (candidates.length === 0) return [];

  candidates.sort((a, b) => b.sim - a.sim);
  const top = candidates.slice(0, topK).filter(c => c.sim > 0);
  return top;
}

/**
 * 把召回结果格式化为小总结提示词里拼入的"图谱精简清单"段。
 * 反 token 爆炸关键：只让 AI 看到本次正文相关的 top-K 实体（带 brief 供判断 update），
 * 不铺开全图清单。地点会补上其 contains/connected 关系（让 AI 知道现有关系，避免重复 add）。
 */
interface KgDigestFormatOptions {
  emptyMessage?: string;
  locationTitle?: string;
  itemTitle?: string;
  characterTitle?: string;
  includeOtherCharacters?: boolean;
  otherCharactersTitle?: string;
}

function buildItemBelongMap(graph: KnowledgeGraph): Map<string, { belongTo: string; state: string }> {
  const itemBelong = new Map<string, { belongTo: string; state: string }>();
  for (const e of graph.edges || []) {
    if (e.type !== 'belongs_to') continue;
    const toName = graph.locations.find(l => l.id === e.to)?.name || e.to;
    itemBelong.set(e.from, { belongTo: toName, state: e.detail || '' });
  }
  return itemBelong;
}

function locationToRecalled(loc: GraphLocation, sim = 1): RecalledEntity {
  return {
    kind: 'location',
    id: loc.id,
    name: loc.name,
    brief: loc.brief || '',
    aliases: loc.aliases,
    sim,
  };
}

function itemToRecalled(
  item: GraphItem,
  itemBelong: Map<string, { belongTo: string; state: string }>,
  sim = 1,
): RecalledEntity {
  const belong = itemBelong.get(item.id);
  return {
    kind: 'item',
    id: item.id,
    name: item.name,
    brief: item.brief || '',
    aliases: item.aliases,
    quantity: item.quantity,
    belongTo: belong?.belongTo,
    state: belong?.state,
    consumed: item.consumed === true,
    sim,
  };
}

function characterToRecalled(ch: GraphCharacter, sim = 1): RecalledEntity {
  return {
    kind: 'character',
    id: ch.id,
    name: ch.name,
    brief: ch.location || '',
    aliases: ch.aliases,
    sim,
  };
}

function pushUniqueRecalled(target: RecalledEntity[], seen: Set<string>, entity?: RecalledEntity | null): boolean {
  if (!entity) return false;
  const key = `${entity.kind}:${entity.id}`;
  if (seen.has(key)) return false;
  seen.add(key);
  target.push(entity);
  return true;
}

function addNameLookupKeys(keys: Set<string>, name?: string, aliases: string[] = []): void {
  const values = [name, ...aliases].map(v => (v || '').trim()).filter(Boolean);
  for (const value of values) {
    keys.add(value);
    keys.add(buildStableId(value));
  }
}

function targetMatchesLookup(target: string | undefined, keys: Set<string>): boolean {
  const raw = (target || '').trim();
  return !!raw && (keys.has(raw) || keys.has(buildStableId(raw)));
}

function findLocationNode(graph: KnowledgeGraph, raw?: string): GraphLocation | undefined {
  const name = (raw || '').trim();
  if (!name) return undefined;
  const stable = buildStableId(name);
  return (graph.locations || []).find(loc =>
    loc.id === name
    || loc.id === stable
    || loc.name === name
    || buildStableId(loc.name) === stable
    || (loc.aliases || []).some(a => a === name || buildStableId(a) === stable),
  );
}

function findCharacterNode(graph: KnowledgeGraph, raw?: string): GraphCharacter | undefined {
  const name = (raw || '').trim();
  if (!name) return undefined;
  const stable = buildStableId(name);
  return (graph.characters || []).find(ch =>
    ch.id === name
    || ch.id === stable
    || ch.name === name
    || buildStableId(ch.name) === stable
    || (ch.aliases || []).some(a => a === name || buildStableId(a) === stable),
  );
}

function resolveCharacterLocationNode(
  graph: KnowledgeGraph,
  characterLocations: Record<string, string> | undefined,
  rawName?: string,
): GraphLocation | undefined {
  const ch = findCharacterNode(graph, rawName);
  const names = [
    rawName,
    ch?.name,
    ch?.id,
    ...(ch?.aliases || []),
  ].map(v => (v || '').trim()).filter(Boolean);

  for (const name of names) {
    const direct = characterLocations?.[name] || characterLocations?.[buildStableId(name)];
    const loc = findLocationNode(graph, direct);
    if (loc) return loc;
  }

  return findLocationNode(graph, ch?.location);
}

function isNameMentioned(text: string, names: Array<string | undefined>): boolean {
  if (!text) return false;
  return names.some(raw => {
    const name = (raw || '').trim();
    return name.length >= 2 && text.includes(name);
  });
}

function formatKgDigestForSmallSummary(
  recalled: RecalledEntity[],
  graph: KnowledgeGraph | null,
  options: KgDigestFormatOptions = {},
): string[] {
  const lines: string[] = [];
  const locs = recalled.filter(c => c.kind === 'location');
  const items = recalled.filter(c => c.kind === 'item');
  const chars = recalled.filter(c => c.kind === 'character');
  if (recalled.length === 0 && options.emptyMessage) {
    lines.push(options.emptyMessage);
  }

  if (locs.length > 0) {
    lines.push(options.locationTitle || '### 已有相关地点（对应本次正文出现的：update/delete 回填其 id；本次正文新出现且不在此列 → add）');
    for (const l of locs) {
      const al = l.aliases?.length ? ` 别名:${l.aliases.join('/')}` : '';
      let line = `- id=${l.id} | ${l.name}${l.brief ? '：' + l.brief : ''}${al}`;
      // 补该地点的 contains/connected 关系（让 AI 知道现有边，避免重复 add）
      if (graph) {
        const rels: string[] = [];
        for (const e of graph.edges) {
          if (e.type === 'contains' && e.from === l.id) {
            const child = graph.locations.find(x => x.id === e.to);
            if (child) rels.push(`包含→${child.name}`);
          } else if (e.type === 'connected' && e.from === l.id) {
            const target = graph.locations.find(x => x.id === e.to);
            if (target) rels.push(`连通→${target.name}${e.detail ? `（${e.detail}）` : ''}`);
          } else if (e.type === 'connected' && e.to === l.id) {
            const source = graph.locations.find(x => x.id === e.from);
            if (source) rels.push(`←连通 ${source.name}${e.detail ? `（${e.detail}）` : ''}`);
          }
        }
        if (rels.length > 0) line += ` [${rels.join('，')}]`;
      }
      lines.push(line);
    }
  }
  if (items.length > 0) {
    lines.push(options.itemTitle || '### 已有相关物品（update/delete 回填其 id；本次正文新出现且不在此列 → add）');
    lines.push('⚠️ 列表里的"持有"即物品当前归属。本段若出现同名物品但持有者不同、且正文无"递给/送给/还给/抢走/转交"等明确转移证据时，按新实例 add，不要覆盖旧条目。');
    for (const it of items) {
      const al = it.aliases?.length ? ` 别名:${it.aliases.join('/')}` : '';
      const belong = it.belongTo ? ` [${it.belongTo}持有]` : '';
      const state = it.state ? ` 状态:${it.state}` : '';
      const quantity = it.quantity ? ` 数量:${it.quantity}` : '';
      const consumed = it.consumed ? ' 已消耗:true' : '';
      lines.push(`- id=${it.id} | ${it.name}${belong}${it.brief ? '：' + it.brief : ''}${quantity}${state}${consumed}${al}`);
    }
  }
  if (chars.length > 0) {
    lines.push(options.characterTitle || '### 已有相关角色（update/delete 回填其 id；本次正文新出现且不在此列 → add）');
    for (const ch of chars) {
      const al = ch.aliases?.length ? ` 别名:${ch.aliases.join('/')}` : '';
      const loc = ch.brief ? ` → 位于 ${ch.brief}` : '';
      lines.push(`- id=${ch.id} | ${ch.name}${loc}${al}`);
    }
  }

  // 全量角色别名清单（反"别名被当新角色"根源治理）：
  // top-K 召回可能漏掉某些已合并节点（比如"师尊"已并入"清月"作别名，但本轮正文又提到"师尊"），
  // AI 看不到的话会把"师尊"当新角色 add → 又造出一个重复节点。
  // 因此把图谱里所有角色的 name + aliases 全量列出（不带 brief 省 token），明确告诉 AI：
  // 这些名字都是已存在的角色，无论正文以哪个名字出现都必须 update，绝不能 add 同一个。
  if (options.includeOtherCharacters && graph && (graph.characters || []).length > 0) {
    const recalledCharIds = new Set(chars.map(c => c.id));
    const missingChars = (graph.characters || []).filter(ch => !recalledCharIds.has(ch.id));
    if (missingChars.length > 0) {
      lines.push(options.otherCharactersTitle || '### 其他已有角色（未在召回 top-K 里，但全量列出供别名识别——下列名字的任何变体出现，都按已存在角色处理，禁止 add）');
      for (const ch of missingChars) {
        const al = ch.aliases?.length ? ` 别名:${ch.aliases.join('/')}` : '';
        const loc = ch.location ? ` @${ch.location}` : '';
        lines.push(`- id=${ch.id} | ${ch.name}${loc}${al}`);
      }
    }
  }
  return lines;
}

export function buildKgDigestForSmallSummary(recalled: RecalledEntity[], graph: KnowledgeGraph | null): string {
  return formatKgDigestForSmallSummary(recalled, graph, {
    emptyMessage: '（本段没有命中高相关图谱条目；下方名称索引用于实体判重）',
    includeOtherCharacters: true,
  }).join('\n');
}

/**
 * 小总结专用图谱材料：
 * 中心角色/地点一跳快照打底，正文直接命中的旧实体防重复，语义召回只补漏。
 */
export function buildContextualKgDigestForSmallSummary(options: SmallSummaryKgDigestOptions): string {
  const {
    query,
    graph,
    queryEmb,
    vectorGraph,
    embeddingCache,
    characterLocations,
  } = options;
  if (!graph || ((graph.locations || []).length + (graph.items || []).length + (graph.characters || []).length === 0)) {
    return '';
  }

  const topK = Math.max(1, options.topK || 40);
  const centerItemLimit = Math.max(1, options.centerItemLimit || 24);
  const exactMatchLimit = Math.max(1, options.exactMatchLimit || Math.max(24, topK));
  const itemBelong = buildItemBelongMap(graph);

  const used = new Set<string>();
  const centered: RecalledEntity[] = [];
  const exact: RecalledEntity[] = [];
  const semantic: RecalledEntity[] = [];

  const centerLocIds = new Set<string>();
  const centerOwnerKeys = new Set<string>();
  const centerNames = mergeUnique(options.centerCharacterNames || [], options.centerLocationNames || []);
  addNameLookupKeys(centerOwnerKeys, '我', ['玩家', '用户', '主角', '{{user}}', 'user']);

  for (const rawName of options.centerCharacterNames || []) {
    addNameLookupKeys(centerOwnerKeys, rawName);
    const ch = findCharacterNode(graph, rawName);
    if (ch) {
      addNameLookupKeys(centerOwnerKeys, ch.name, ch.aliases || []);
      addNameLookupKeys(centerOwnerKeys, ch.id);
      pushUniqueRecalled(centered, used, characterToRecalled(ch, 1.2));
    }

    const loc = resolveCharacterLocationNode(graph, characterLocations, rawName);
    if (loc) {
      centerLocIds.add(loc.id);
      pushUniqueRecalled(centered, used, locationToRecalled(loc, 1.15));
    }
  }

  for (const rawLoc of options.centerLocationNames || []) {
    const loc = findLocationNode(graph, rawLoc);
    if (!loc) continue;
    centerLocIds.add(loc.id);
    pushUniqueRecalled(centered, used, locationToRecalled(loc, 1.1));
  }

  // 中心地点的一跳地点：contains 父子与 connected 邻接都列出，供地点/道路去重。
  const neighborLocs: GraphLocation[] = [];
  for (const edge of graph.edges || []) {
    if (edge.type === 'belongs_to') continue;
    const touchesCenter = centerLocIds.has(edge.from) || centerLocIds.has(edge.to);
    if (!touchesCenter) continue;
    const otherId = centerLocIds.has(edge.from) ? edge.to : edge.from;
    const loc = graph.locations.find(l => l.id === otherId);
    if (loc) neighborLocs.push(loc);
  }
  for (const loc of neighborLocs.slice(0, 12)) {
    pushUniqueRecalled(centered, used, locationToRecalled(loc, 1.05));
  }

  // 中心角色持有物 + 中心地点物品，统一限额，避免玩家背包/地点堆积撑爆 prompt。
  let centeredItemCount = 0;
  for (const edge of graph.edges || []) {
    if (edge.type !== 'belongs_to') continue;
    const ownedByCenterCharacter = targetMatchesLookup(edge.to, centerOwnerKeys);
    const locatedAtCenter = centerLocIds.has(edge.to);
    if (!ownedByCenterCharacter && !locatedAtCenter) continue;
    const item = graph.items.find(it => it.id === edge.from);
    if (!item) continue;
    if (pushUniqueRecalled(centered, used, itemToRecalled(item, itemBelong, 1.1))) {
      centeredItemCount++;
      if (centeredItemCount >= centerItemLimit) break;
    }
  }

  // 同地点角色只提供身份/位置，用于角色别名判重，不展开角色记忆。
  for (const ch of graph.characters || []) {
    const loc = resolveCharacterLocationNode(graph, characterLocations, ch.name);
    if (!loc || !centerLocIds.has(loc.id)) continue;
    pushUniqueRecalled(centered, used, characterToRecalled(ch, 1.05));
  }

  // 正文直接命中的旧实体强制加入，解决“旧物品没被召回 → 被当新物品 add”的重复问题。
  for (const item of graph.items || []) {
    if (exact.length >= exactMatchLimit) break;
    if (isNameMentioned(query, [item.name, ...(item.aliases || [])])) {
      pushUniqueRecalled(exact, used, itemToRecalled(item, itemBelong, 0.95));
    }
  }
  for (const loc of graph.locations || []) {
    if (exact.length >= exactMatchLimit) break;
    if (isNameMentioned(query, [loc.name, ...(loc.aliases || [])])) {
      pushUniqueRecalled(exact, used, locationToRecalled(loc, 0.95));
    }
  }
  for (const ch of graph.characters || []) {
    if (exact.length >= exactMatchLimit) break;
    if (isNameMentioned(query, [ch.name, ...(ch.aliases || [])])) {
      pushUniqueRecalled(exact, used, characterToRecalled(ch, 0.95));
    }
  }

  const recalled = recallKnowledgeGraph(query, graph, topK, queryEmb, {
    vectorGraph: vectorGraph || null,
    embeddingCache: embeddingCache || null,
  });
  for (const entity of recalled) {
    pushUniqueRecalled(semantic, used, entity);
  }

  const lines: string[] = [];
  if (centered.length > 0) {
    const centerLabel = centerNames.length > 0 ? `（${centerNames.slice(0, 6).join('、')}）` : '';
    lines.push(`### 中心角色/地点相关图谱${centerLabel}`);
    lines.push(...formatKgDigestForSmallSummary(centered, graph, {
      locationTitle: '#### 中心范围地点',
      itemTitle: '#### 中心范围物品',
      characterTitle: '#### 中心范围角色',
    }));
  }

  if (exact.length > 0) {
    lines.push('### 正文直接命中的旧图谱条目（优先 update，禁止同名/别名重复 add）');
    lines.push(...formatKgDigestForSmallSummary(exact, graph, {
      locationTitle: '#### 命中地点',
      itemTitle: '#### 命中物品',
      characterTitle: '#### 命中角色',
    }));
  }

  if (semantic.length > 0) {
    lines.push('### 语义召回补充（只作补漏；若与上方冲突，以上方 id 为准）');
    lines.push(...formatKgDigestForSmallSummary(semantic, graph, {
      locationTitle: '#### 召回地点',
      itemTitle: '#### 召回物品',
      characterTitle: '#### 召回角色',
    }));
  }

  if (lines.length === 0) {
    lines.push('（本段没有命中高相关图谱条目；下方名称索引用于实体判重）');
  }

  const contextCharIds = new Set(
    [...centered, ...exact, ...semantic]
      .filter(e => e.kind === 'character')
      .map(e => e.id),
  );
  const missingChars = (graph.characters || []).filter(ch => !contextCharIds.has(ch.id));
  if (missingChars.length > 0) {
    lines.push('### 其他已有角色（全量列出供别名识别——下列名字的任何变体出现，都按已存在角色处理，禁止 add）');
    for (const ch of missingChars) {
      const al = ch.aliases?.length ? ` 别名:${ch.aliases.join('/')}` : '';
      const loc = ch.location ? ` @${ch.location}` : '';
      lines.push(`- id=${ch.id} | ${ch.name}${loc}${al}`);
    }
  }

  return lines.join('\n');
}

// ========== 地点全量信息（供世界推进注入用） ==========

/**
 * 返回某地点的全量信息：简述 + 子地点（contains）+ 连通地点（connected，含路径）+ 该地点下物品（belongs_to，含状态）。
 * 按正式名或别名命中。找不到返回空串。
 */
export function getLocationFullInfo(graph: KnowledgeGraph | null, locationName: string): string {
  if (!graph || !locationName) return '';
  const name = locationName.trim();
  const loc = graph.locations.find(l => l.name === name || (l.aliases || []).includes(name));
  if (!loc) return '';

  const lines: string[] = [];
  lines.push(`[地点]${loc.name}${loc.brief ? '：' + loc.brief : ''}`);

  // 子地点（contains）
  const children = graph.edges
    .filter(e => e.type === 'contains' && e.from === loc.id)
    .map(e => graph.locations.find(l => l.id === e.to))
    .filter((l): l is GraphLocation => !!l);
  if (children.length > 0) {
    lines.push('  子地点:');
    for (const c of children) {
      lines.push(`  - ${c.name}${c.brief ? '：' + c.brief : ''}`);
    }
  }

  // 连通地点（connected，含路径+方向）
  const connected = graph.edges
    .filter(e => e.type === 'connected' && (e.from === loc.id || e.to === loc.id))
    .map(e => {
      if (e.from === loc.id) {
        const target = graph.locations.find(l => l.id === e.to);
        return target ? { name: target.name, path: e.detail || '', dir: '→' } : null;
      } else {
        const source = graph.locations.find(l => l.id === e.from);
        return source ? { name: source.name, path: e.detail || '', dir: '←' } : null;
      }
    })
    .filter((x): x is { name: string; path: string; dir: string } => !!x);
  if (connected.length > 0) {
    lines.push('  连通:');
    for (const c of connected) {
      lines.push(`  - ${c.dir}${c.name}${c.path ? `（路径：${c.path}）` : ''}`);
    }
  }

  // 此处物品（belongs_to，含状态）
  const itemsHere = graph.edges
    .filter(e => e.type === 'belongs_to' && e.to === loc.id)
    .map(e => ({ item: graph.items.find(i => i.id === e.from), state: e.detail }))
    .filter((x): x is { item: GraphItem; state?: string } => !!x.item);
  if (itemsHere.length > 0) {
    lines.push('  此处物品:');
    for (const { item, state } of itemsHere) {
      const quantity = item.quantity ? `（数量：${item.quantity}）` : '';
      lines.push(
        `  - ${item.name}${item.brief ? '：' + item.brief : ''}${quantity}${state ? `（${state}）` : ''}`,
      );
    }
  }

  return lines.join('\n');
}

// ========== 图谱注入辅助函数 ==========

/**
 * 获取某地点下的全部物品（belongs_to 边，无 top-K 截断）。
 * 供聊天上下文注入时全量展开。
 */
export function getLocationAllItems(graph: KnowledgeGraph, locationId: string): Array<{ item: GraphItem; state?: string }> {
  return graph.edges
    .filter(e => e.type === 'belongs_to' && e.to === locationId)
    .map(e => ({ item: graph.items.find(i => i.id === e.from), state: e.detail }))
    .filter((x): x is { item: GraphItem; state?: string } => !!x.item);
}

/** 归属于某所有者（角色/玩家/地点）的物品视图 */
export interface OwnedItem {
  item: GraphItem;
  state?: string;
  belongTo?: string;
}

function normalizeOwnerName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 查询归属于指定所有者集合的物品。
 * 所有者可以是角色名、玩家别名或地点 id/名称/别名；命中规则：
 * 1. belongs_to 边的 to 直接等于任一 ownerName（忽略大小写）
 * 2. belongs_to 的 to 是地点 id，且该地点的名称/别名匹配任一 ownerName
 */
export function getItemsBelongingTo(
  graph: KnowledgeGraph,
  ownerNames: string[],
): OwnedItem[] {
  const ownerSet = new Set(ownerNames.filter(Boolean).map(normalizeOwnerName));
  if (ownerSet.size === 0) return [];

  const locById = new Map(graph.locations.map(l => [normalizeOwnerName(l.id), l]));

  return graph.items
    .map(item => {
      const edge = graph.edges.find(e => e.type === 'belongs_to' && e.from === item.id);
      if (!edge) return null;

      const toRaw = edge.to;
      const toNorm = normalizeOwnerName(toRaw);
      if (ownerSet.has(toNorm)) {
        return { item, state: edge.detail, belongTo: toRaw };
      }

      const loc = locById.get(toNorm);
      if (loc) {
        const locNames = [loc.name, ...(loc.aliases || [])];
        if (locNames.some(n => ownerSet.has(normalizeOwnerName(n)))) {
          return { item, state: edge.detail, belongTo: loc.name };
        }
      }
      return null;
    })
    .filter((x): x is OwnedItem => !!x);
}

/**
 * 扫描文本中是否出现图谱中的地点名/别名，返回匹配到的地点节点。
 * 只匹配 length >= 2 的名称，避免短名误匹配。
 */
export function findMentionedLocations(text: string, graph: KnowledgeGraph, excludeIds?: Set<string>): GraphLocation[] {
  if (!text) return [];
  const matched: GraphLocation[] = [];
  for (const loc of graph.locations) {
    if (excludeIds?.has(loc.id)) continue;
    const names = [loc.name, ...(loc.aliases || [])];
    if (names.some(n => n.length >= 2 && text.includes(n))) {
      matched.push(loc);
    }
  }
  return matched;
}

// ========== 地点跳数 BFS（世界推进距离加权用） ==========

/**
 * 计算两个地点之间的图跳数（最短连通边数）。
 *
 * 用途：世界推进「距离玩家越近越容易推到」加权。角色与玩家同地点（0 跳）
 * 已被在场过滤排除，所以实际命中的最小跳数是 1（相邻连通地点）。
 *
 * 规则：
 * - from / to 同 id → 0
 * - 仅沿 edges 里 type === 'connected' 的双向边做 BFS
 * - 找不到路径 → Infinity（很近不可能，很远的含义由调用方解释）
 */
export function computeLocationHopDistance(
  graph: KnowledgeGraph | null | undefined,
  fromLocationId: string | undefined,
  toLocationId: string | undefined,
): number {
  if (!graph || !fromLocationId || !toLocationId) return Infinity;
  if (fromLocationId === toLocationId) return 0;
  const locIds = new Set(graph.locations.map(l => l.id));
  if (!locIds.has(fromLocationId) || !locIds.has(toLocationId)) return Infinity;

  // 构建无向邻接表（仅 connected 边）
  const adj = new Map<string, string[]>();
  for (const edge of graph.edges || []) {
    if (edge.type !== 'connected') continue;
    const [a, b] = [edge.from, edge.to];
    if (!locIds.has(a) || !locIds.has(b)) continue;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }

  // BFS：分层展开，hops 等于目标所在层数（from 为第 0 层）
  const visited = new Set<string>([fromLocationId]);
  let frontier: string[] = [fromLocationId];
  let hops = 0;
  const safetyCap = locIds.size + 2; // 防异常图死循环
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const node of frontier) {
      if (node === toLocationId) return hops;
      for (const neighbor of adj.get(node) || []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
    hops++;
    if (hops > safetyCap) return Infinity;
  }
  return Infinity;
}

// ========== 世界推进注入材料（候选角色所在地点全量 + 其余 top-k 召回） ==========

/**
 * 为世界推进构建图谱注入材料。
 * - 各候选上次所在地点全量展开（去重）
 * - 其余图谱条目按最近正文+候选名召回 top-k
 */
export function buildKnowledgeGraphMaterialForProgress(
  graph: KnowledgeGraph | null,
  candidateLastLocations: Array<{ name: string; lastLocation?: string }>,
  recentAiText: string,
  topK: number = 8,
  queryEmb?: number[] | null,
): string {
  if (!graph || (graph.locations.length === 0 && graph.items.length === 0)) return '';

  const parts: string[] = [];

  // ① 各候选上次所在地点全量（去重）
  const seenLoc = new Set<string>();
  for (const c of candidateLastLocations || []) {
    if (!c.lastLocation || seenLoc.has(c.lastLocation)) continue;
    seenLoc.add(c.lastLocation);
    const full = getLocationFullInfo(graph, c.lastLocation);
    if (full) {
      parts.push(`### 候选 ${c.name} 所在地点（${c.lastLocation}）`);
      parts.push(full);
    }
  }

  // ② 其余图谱条目 top-k 召回（query = 最近正文 + 候选名）
  const query = (recentAiText.slice(0, 500) || '') + ' ' + (candidateLastLocations || []).map(c => c.name).join(' ');
  const recalled = recallKnowledgeGraph(query, graph, topK, queryEmb);
  // 过滤掉已经全量展开的（候选所在地点），避免重复
  const filtered = recalled.filter(r => !seenLoc.has(r.name));
  if (filtered.length > 0) {
    parts.push('### 世界图谱（top-k 召回）');
    for (const r of filtered) {
      if (r.kind === 'location') {
        parts.push(`- [地点]${r.name}${r.brief ? '：' + r.brief : ''}`);
      } else if (r.kind === 'character') {
        parts.push(`- [人物]${r.name}${r.brief ? ` → 位于 ${r.brief}` : ''}`);
      } else {
        const belong = r.belongTo ? ` 归属:${r.belongTo}` : '';
        const quantity = r.quantity ? ` 数量:${r.quantity}` : '';
        const state = r.state ? ` 状态:${r.state}` : '';
        parts.push(`- [物品]${r.name}${r.brief ? '：' + r.brief : ''}${quantity}${belong}${state}`);
      }
    }
  }

  return parts.join('\n');
}

// ========== 图谱节点向量化 ==========

/** 构建地点的嵌入文本 */
function buildLocationEmbedText(loc: GraphLocation): string {
  const parts: string[] = [`[地点] ${loc.name}`];
  if (loc.brief) parts.push(loc.brief);
  if (loc.aliases?.length) parts.push(`别名:${loc.aliases.join('/')}`);
  return parts.join(' | ');
}

/** 构建图谱物品的嵌入文本 */
function buildKgItemEmbedText(item: GraphItem): string {
  const parts: string[] = [`[物品] ${item.name}`];
  if (item.brief) parts.push(item.brief);
  if (item.quantity) parts.push(`数量:${item.quantity}`);
  if (item.aliases?.length) parts.push(`别名:${item.aliases.join('/')}`);
  if (item.consumed) parts.push('已消耗');
  return parts.join(' | ');
}

/**
 * 为图谱中所有无向量的地点和物品生成 embedding。
 * 使用批量 API 以节省请求次数，完成后调用方需 persist。
 * @returns 本次生成的向量总数
 */
export async function embedKnowledgeGraphNodes(
  graph: KnowledgeGraph | null,
  settings: EmbeddingSettings,
  onProgress?: (done: number, total: number) => void,
  embeddingCache?: KnowledgeGraphEmbeddingCache | null,
): Promise<number> {
  if (!graph || (!graph.locations.length && !graph.items.length && !(graph.characters || []).length)) return 0;
  syncKnowledgeGraphEmbeddingCache(graph, embeddingCache);
  hydrateKnowledgeGraphEmbeddingsFromCache(graph, embeddingCache);

  // 收集所有待嵌入节点（仅地点和物品；角色节点不嵌入，通过 characterLocations 追踪）
  const toEmbed: Array<{ node: GraphLocation | GraphItem; text: string; kind: KnowledgeGraphVectorKind }> = [];
  let locCount = 0, itemCount = 0;
  for (const loc of graph.locations) {
    if (loc.embedding && loc.embedding.length > 0) continue;
    const text = buildLocationEmbedText(loc);
    if (text.trim()) { toEmbed.push({ node: loc, text, kind: 'location' }); locCount++; }
  }
  for (const it of graph.items) {
    if (it.embedding && it.embedding.length > 0) continue;
    const text = buildKgItemEmbedText(it);
    if (text.trim()) { toEmbed.push({ node: it, text, kind: 'item' }); itemCount++; }
  }

  if (toEmbed.length === 0) {
    logInfo('知识图谱', '图谱节点向量无需更新');
    syncKnowledgeGraphEmbeddingCache(graph, embeddingCache);
    return 0;
  }

  logInfo('知识图谱', `待嵌入图谱节点: ${toEmbed.length} 个 (${locCount} 地点 + ${itemCount} 物品)`);

  const texts = toEmbed.map(e => e.text);
  let done = 0;
  const vectors = await getBatchEmbeddings(texts, settings, (batchDone, total) => {
    done = batchDone;
    onProgress?.(done, total);
  });

  let embedded = 0;
  for (let i = 0; i < toEmbed.length; i++) {
    if (vectors[i] && vectors[i].length > 0) {
      toEmbed[i].node.embedding = vectors[i];
      writeNodeEmbeddingCache(embeddingCache, toEmbed[i].kind, toEmbed[i].node);
      embedded++;
    }
  }

  syncKnowledgeGraphEmbeddingCache(graph, embeddingCache);
  logInfo('知识图谱', `图谱节点向量完成: ${embedded}/${toEmbed.length}`);
  return embedded;
}

// ========== 旧版数据迁移 ==========

/**
 * 将旧版图谱结构归一化为当前结构：
 * - GraphLocation.category（open/sealed）→ 删除
 * - GraphItem.category/subCategory/important → 删除
 * - GraphEdge.type 'adjacent' → 'connected'
 * 返回归一化后的新图谱（深拷贝）。已是新结构则原样返回。
 */
export function normalizeLegacyGraph(graph: KnowledgeGraph | null): KnowledgeGraph | null {
  if (!graph) return null;
  let changed = false;
  const next: KnowledgeGraph = JSON.parse(JSON.stringify(graph));

  // 地点：剥离 category
  for (const l of next.locations) {
    if ((l as any).category !== undefined) {
      delete (l as any).category;
      changed = true;
    }
  }

  // 物品：剥离 category/subCategory/important
  for (const it of next.items) {
    if ((it as any).category !== undefined) { delete (it as any).category; changed = true; }
    if ((it as any).subCategory !== undefined) { delete (it as any).subCategory; changed = true; }
    if ((it as any).important !== undefined) { delete (it as any).important; changed = true; }
  }

  // 边：adjacent → connected
  for (const e of next.edges) {
    if (e.type === ('adjacent' as any)) {
      e.type = 'connected';
      changed = true;
    }
  }

  return changed ? next : graph;
}
