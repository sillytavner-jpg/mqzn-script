/**
 * 知识图谱注入（<world_graph>）— 用于在每次生成请求时把当前场景地点/物品/相关条目
 * 注入到上下文。
 *
 * 注入位置：直接写入本轮 completion.messages，把 <world_graph> 块塞进含 <chathistory> 的
 * 那条消息的 </chathistory> 之后，与角色记忆（神经链 depth 0）同处聊天记录之后的区域。
 * 不走 injectPrompts —— 否则句柄更新会落到下一轮，图谱慢一版。
 *
 * 正文注入顺序：
 * 1. 当前可用物品：玩家物品、同场角色物品、玩家所在地点物品（排除 consumed=true）。
 * 2. 当前地点：地点描述 + 一跳相连地点 + 路径描述 + 相连地点描述。
 * 3. 玩家输入提及地点：预载该地点最近变化的可用物品，最多 10 个。
 * 4. 相关召回：正文/玩家输入提到的物品与地点，各最多 10 个；物品可包含已消耗项。
 */
import type {
  GraphCharacter,
  GraphItem,
  GraphLocation,
  KnowledgeGraph,
  KnowledgeGraphEmbeddingCache,
  RecalledEntity,
} from './knowledgeGraph';
import {
  buildStableId,
  recallKnowledgeGraph,
} from './knowledgeGraph';
import { logInfo, logWarn } from '../utils/logger';

/** 注入所需的外部依赖（由 index.ts 在调用现场收集后传入） */
export interface WorldGraphInjectCtx {
  /** 当前楼层对应的图谱快照（已按楼层感知取好，用于场景展开 + 召回名称过滤） */
  graph: KnowledgeGraph;
  /** 主图谱（含 embedding，用于召回打分；不传则降级用 graph 直接召回） */
  mainGraph?: KnowledgeGraph | null;
  /** 旧图谱节点向量缓存；只用于打分，不用于注入正文。 */
  embeddingCache?: KnowledgeGraphEmbeddingCache | null;
  /** 图谱版本快照，用于判断某地点下哪些物品最近新增或更新。 */
  graphVersions?: Array<{ floor: number; graph: KnowledgeGraph }>;
  /** 当前玩家视角角色名。正文里的"我"在图谱里会被小总结归一到这个名字。 */
  userName?: string;
  /** 最近一条小总结的在场角色名列表；当玩家位置缺失时用于兜底推断当前场景。 */
  presentCharacters: string[];
  /** 角色名 → 当前所在地点 id 的映射（来自楼层感知图谱状态） */
  characterLocations: Record<string, string>;
  /** 用户本轮输入文本 */
  userText: string;
  /** 召回查询文本（一般取当前可见正文 + 本轮输入） */
  queryText: string;
  /** 召回查询向量（可选，启用 embedding 时传入，否则召回走 bigram 降级） */
  queryEmb: number[] | null;
  /** 召回注入条数设置；正文图谱会额外硬限制为每类最多 10 个。 */
  topK: number;
}

interface ItemEntry {
  item: GraphItem;
  state?: string;
  belongName?: string;
  changedFloor?: number;
}

const PLAYER_OWNER_NAMES = ['我', '玩家', '用户', '主角', '{{user}}', 'user'];

function keyOf(value?: string): string {
  return buildStableId((value || '').trim());
}

function addNameKeys(keys: Set<string>, name?: string, aliases: string[] = []): void {
  const values = [name, ...aliases].map(v => (v || '').trim()).filter(Boolean);
  for (const v of values) {
    keys.add(v);
    keys.add(keyOf(v));
  }
}

function resolveLocationId(graph: KnowledgeGraph, location?: string): string | undefined {
  const raw = (location || '').trim();
  if (!raw || raw === '未提及') return undefined;
  const stable = keyOf(raw);
  const loc = graph.locations.find(l =>
    l.id === raw
    || l.id === stable
    || l.name === raw
    || (l.aliases || []).includes(raw),
  );
  return loc?.id;
}

function findCharacter(graph: KnowledgeGraph, name?: string): GraphCharacter | undefined {
  const raw = (name || '').trim();
  if (!raw) return undefined;
  const stable = keyOf(raw);
  return (graph.characters || []).find(ch =>
    ch.id === raw
    || ch.id === stable
    || ch.name === raw
    || keyOf(ch.name) === stable
    || (ch.aliases || []).some(a => a === raw || keyOf(a) === stable),
  );
}

function getCharacterOwnerKeys(graph: KnowledgeGraph, name?: string): Set<string> {
  const keys = new Set<string>();
  const ch = findCharacter(graph, name);
  addNameKeys(keys, name);
  if (ch) {
    addNameKeys(keys, ch.name, ch.aliases || []);
    addNameKeys(keys, ch.id);
  }
  return keys;
}

function getPlayerOwnerKeys(graph: KnowledgeGraph, userName?: string): Set<string> {
  const keys = getCharacterOwnerKeys(graph, userName);
  for (const name of PLAYER_OWNER_NAMES) addNameKeys(keys, name);
  return keys;
}

function getCharacterLocationId(
  graph: KnowledgeGraph,
  characterLocations: Record<string, string>,
  name?: string,
): string | undefined {
  const ch = findCharacter(graph, name);
  const candidates = [
    name,
    ch?.name,
    ch?.id,
    ...(ch?.aliases || []),
  ].map(v => (v || '').trim()).filter(Boolean);

  for (const candidate of candidates) {
    const direct = characterLocations?.[candidate];
    const byStable = characterLocations?.[keyOf(candidate)];
    const locId = resolveLocationId(graph, direct || byStable);
    if (locId) return locId;
  }

  return resolveLocationId(graph, ch?.location);
}

function ownerMatches(owner: string | undefined, keys: Set<string>): boolean {
  if (!owner) return false;
  const raw = owner.trim();
  return keys.has(raw) || keys.has(keyOf(raw));
}

function isConsumedItem(item?: GraphItem): boolean {
  return item?.consumed === true;
}

function getBelongDisplayName(graph: KnowledgeGraph, to?: string): string {
  if (!to) return '';
  return graph.locations.find(l => l.id === to)?.name || to;
}

function getLegacyItemOwnerCandidates(item: GraphItem): string[] {
  const raw = item as any;
  return [
    raw.belongTo,
    raw.owner,
    raw.currentOwner,
    raw.holder,
    raw.carriedBy,
    raw.ownerName,
    raw.belongName,
    raw.location,
    raw.currentLocation,
  ]
    .filter((v): v is string => typeof v === 'string')
    .map(v => v.trim())
    .filter(Boolean);
}

function getLegacyItemState(item: GraphItem): string | undefined {
  const raw = item as any;
  const state = raw.state ?? raw.currentState ?? raw.status ?? raw.position ?? raw.detail;
  return typeof state === 'string' && state.trim() ? state.trim() : undefined;
}

function getOwnedItems(
  graph: KnowledgeGraph,
  ownerKeys: Set<string>,
  injectedItemIds: Set<string>,
  includeConsumed: boolean,
): ItemEntry[] {
  const entries: ItemEntry[] = [];
  const seenItems = new Set<string>();
  for (const edge of graph.edges || []) {
    if (edge.type !== 'belongs_to' || !ownerMatches(edge.to, ownerKeys)) continue;
    if (injectedItemIds.has(edge.from)) continue;
    if (seenItems.has(edge.from)) continue;
    const item = graph.items.find(it => it.id === edge.from);
    if (!item) continue;
    if (!includeConsumed && isConsumedItem(item)) continue;
    seenItems.add(edge.from);
    entries.push({
      item,
      state: edge.detail,
      belongName: getBelongDisplayName(graph, edge.to),
    });
  }
  for (const item of graph.items || []) {
    if (injectedItemIds.has(item.id)) continue;
    if (seenItems.has(item.id)) continue;
    if (!includeConsumed && isConsumedItem(item)) continue;
    const legacyOwner = getLegacyItemOwnerCandidates(item).find(owner => ownerMatches(owner, ownerKeys));
    if (!legacyOwner) continue;
    seenItems.add(item.id);
    entries.push({
      item,
      state: getLegacyItemState(item),
      belongName: getBelongDisplayName(graph, legacyOwner),
    });
  }
  return entries;
}

function getItemBelongEdge(graph: KnowledgeGraph, itemId: string) {
  return (graph.edges || []).find(e => e.type === 'belongs_to' && e.from === itemId);
}

function buildItemSignature(graph: KnowledgeGraph, itemId: string): string {
  const item = graph.items.find(it => it.id === itemId);
  if (!item) return '';
  const edge = getItemBelongEdge(graph, itemId);
  return JSON.stringify({
    name: item.name || '',
    brief: item.brief || '',
    aliases: [...(item.aliases || [])].sort(),
    quantity: item.quantity || '',
    consumed: item.consumed === true,
    belongTo: edge?.to || '',
    state: edge?.detail || '',
  });
}

function buildItemChangeFloorMap(ctx: WorldGraphInjectCtx): Map<string, number> {
  const byFloor = new Map<number, KnowledgeGraph>();
  for (const version of ctx.graphVersions || []) {
    if (!version?.graph) continue;
    byFloor.set(version.floor, version.graph);
  }

  const currentFloor = typeof ctx.graph.version === 'number' && ctx.graph.version > 0
    ? ctx.graph.version
    : Math.max(0, ...Array.from(byFloor.keys()), 0) + 1;
  byFloor.set(currentFloor, ctx.graph);

  const versions = Array.from(byFloor.entries())
    .filter(([floor]) => floor <= currentFloor)
    .sort((a, b) => a[0] - b[0]);

  const prevSig = new Map<string, string>();
  const changedAt = new Map<string, number>();
  for (const [floor, graph] of versions) {
    for (const item of graph.items || []) {
      const sig = buildItemSignature(graph, item.id);
      if (!sig) continue;
      if (prevSig.get(item.id) !== sig) {
        changedAt.set(item.id, floor);
        prevSig.set(item.id, sig);
      }
    }
  }
  return changedAt;
}

function findMentionedLocationsInText(text: string, graph: KnowledgeGraph): GraphLocation[] {
  if (!text) return [];
  const matched: GraphLocation[] = [];
  const seen = new Set<string>();
  for (const loc of graph.locations || []) {
    const names = [loc.name, ...(loc.aliases || [])].map(n => (n || '').trim()).filter(n => n.length >= 2);
    if (names.some(n => text.includes(n))) {
      if (seen.has(loc.id)) continue;
      seen.add(loc.id);
      matched.push(loc);
    }
  }
  return matched;
}

function getLocationOwnerKeys(loc: GraphLocation): Set<string> {
  const keys = new Set([loc.id, keyOf(loc.id)]);
  addNameKeys(keys, loc.name, loc.aliases || []);
  return keys;
}

function getRecentlyChangedLocationItems(
  graph: KnowledgeGraph,
  loc: GraphLocation,
  changedAt: Map<string, number>,
  injectedItemIds: Set<string>,
  includeConsumed: boolean,
  limit: number,
): ItemEntry[] {
  return getOwnedItems(graph, getLocationOwnerKeys(loc), injectedItemIds, includeConsumed)
    .map(entry => ({
      ...entry,
      changedFloor: changedAt.get(entry.item.id) || 0,
    }))
    .sort((a, b) => {
      const floorDiff = (b.changedFloor || 0) - (a.changedFloor || 0);
      if (floorDiff !== 0) return floorDiff;
      return a.item.name.localeCompare(b.item.name, 'zh-Hans-CN');
    })
    .slice(0, limit);
}

function formatItemLine(entry: ItemEntry, includeBelong = false): string {
  const { item, state, belongName } = entry;
  const brief = item.brief ? `：${item.brief}` : '';
  const quantity = item.quantity ? ` 数量:${item.quantity}` : '';
  const belong = includeBelong && belongName ? ` 归属:${belongName}` : '';
  const stateText = state ? ` 状态:${state}` : '';
  const consumed = item.consumed ? ' 已消耗' : '';
  return `- [物品]${item.name}${brief}${quantity}${belong}${stateText}${consumed}`;
}

function addItemSection(
  lines: string[],
  title: string,
  entries: ItemEntry[],
  injectedItemIds: Set<string>,
  includeBelong = false,
): boolean {
  if (entries.length === 0) return false;
  lines.push('');
  lines.push(title);
  for (const entry of entries) {
    lines.push(formatItemLine(entry, includeBelong));
    injectedItemIds.add(entry.item.id);
  }
  return true;
}

function getCharactersAtLocations(
  graph: KnowledgeGraph,
  characterLocations: Record<string, string>,
  locIds: Set<string>,
): GraphCharacter[] {
  if (locIds.size === 0) return [];
  const result: GraphCharacter[] = [];
  const seen = new Set<string>();
  for (const ch of graph.characters || []) {
    const locId = getCharacterLocationId(graph, characterLocations, ch.name);
    if (!locId || !locIds.has(locId) || seen.has(ch.id)) continue;
    seen.add(ch.id);
    result.push(ch);
  }
  return result;
}

function isSameCharacter(graph: KnowledgeGraph, left?: string, right?: string): boolean {
  if (!left || !right) return false;
  const leftKeys = getCharacterOwnerKeys(graph, left);
  const rightKeys = getCharacterOwnerKeys(graph, right);
  for (const key of leftKeys) {
    if (rightKeys.has(key)) return true;
  }
  return false;
}

function formatCurrentLocationInfo(
  graph: KnowledgeGraph,
  locId: string,
  injectedLocIds: Set<string>,
): string {
  const loc = graph.locations.find(l => l.id === locId);
  if (!loc) return '';

  const lines: string[] = [];
  lines.push(`[地点]${loc.name}${loc.brief ? '：' + loc.brief : ''}`);
  injectedLocIds.add(loc.id);

  const children = (graph.edges || [])
    .filter(e => e.type === 'contains' && e.from === loc.id)
    .map(e => graph.locations.find(l => l.id === e.to))
    .filter((l): l is GraphLocation => !!l);
  if (children.length > 0) {
    lines.push('  包含地点:');
    for (const child of children) {
      lines.push(`  - ${child.name}${child.brief ? '：' + child.brief : ''}`);
      injectedLocIds.add(child.id);
    }
  }

  const connectedLines: string[] = [];
  const seenConnected = new Set<string>();
  for (const edge of graph.edges || []) {
    if (edge.type !== 'connected' || (edge.from !== loc.id && edge.to !== loc.id)) continue;
    const otherId = edge.from === loc.id ? edge.to : edge.from;
    const other = graph.locations.find(l => l.id === otherId);
    if (!other) continue;
    const key = other.id;
    if (seenConnected.has(key)) continue;
    seenConnected.add(key);
    const path = edge.detail ? `（路径：${edge.detail}）` : '';
    connectedLines.push(`  - 通往${other.name}${other.brief ? '：' + other.brief : ''}${path}`);
    injectedLocIds.add(other.id);
  }
  if (connectedLines.length > 0) {
    lines.push('  相连地点:');
    lines.push(...connectedLines);
  }

  return lines.join('\n');
}

function findSceneLocationIds(ctx: WorldGraphInjectCtx): Set<string> {
  const ids = new Set<string>();
  const playerLocId = getCharacterLocationId(ctx.graph, ctx.characterLocations || {}, ctx.userName);
  if (playerLocId) {
    ids.add(playerLocId);
    return ids;
  }

  for (const name of ctx.presentCharacters || []) {
    const locId = getCharacterLocationId(ctx.graph, ctx.characterLocations || {}, name);
    if (locId) ids.add(locId);
  }
  return ids;
}

function recallLocationLine(graph: KnowledgeGraph, recalled: RecalledEntity): string {
  const versionLoc = graph.locations.find(l => l.id === recalled.id);
  const brief = versionLoc?.brief || recalled.brief;
  return `- [地点]${recalled.name}${brief ? '：' + brief : ''}`;
}

function recallItemEntry(graph: KnowledgeGraph, recalled: RecalledEntity): ItemEntry | null {
  const item = graph.items.find(it => it.id === recalled.id);
  if (!item) return null;
  const edge = (graph.edges || []).find(e => e.type === 'belongs_to' && e.from === item.id);
  return {
    item,
    state: edge?.detail || recalled.state,
    belongName: edge ? getBelongDisplayName(graph, edge.to) : recalled.belongTo,
  };
}

/** 构造 <world_graph> 注入文本。无内容返回空串。 */
export function buildWorldGraphInjection(ctx: WorldGraphInjectCtx): string {
  const { graph, userName, userText, queryText, queryEmb, topK } = ctx;
  if (graph.locations.length + graph.items.length === 0) return '';

  try {
    const injectedLocIds = new Set<string>();
    const injectedItemIds = new Set<string>();
    const lines: string[] = ['<world_graph>'];
    lines.push('当前场景图谱（保持地点、物品归属和可用性一致）：');
    let hasContent = false;

    const sceneLocIds = findSceneLocationIds(ctx);

    // 1) 玩家物品（当前可用，排除已消耗）
    const playerItems = getOwnedItems(
      graph,
      getPlayerOwnerKeys(graph, userName),
      injectedItemIds,
      false,
    );
    hasContent = addItemSection(lines, '[玩家当前可用物品]', playerItems, injectedItemIds, true) || hasContent;

    // 2) 与玩家同场景角色的物品（当前可用，排除已消耗）
    const sameSceneCharacters = getCharactersAtLocations(graph, ctx.characterLocations || {}, sceneLocIds)
      .filter(ch => !isSameCharacter(graph, ch.name, userName));
    if (sameSceneCharacters.length > 0) {
      const groupedLines: string[] = [];
      for (const ch of sameSceneCharacters) {
        const entries = getOwnedItems(graph, getCharacterOwnerKeys(graph, ch.name), injectedItemIds, false);
        if (entries.length === 0) continue;
        groupedLines.push(`${ch.name}:`);
        for (const entry of entries) {
          groupedLines.push(`  ${formatItemLine(entry, false)}`);
          injectedItemIds.add(entry.item.id);
        }
      }
      if (groupedLines.length > 0) {
        lines.push('');
        lines.push('[同场角色当前可用物品]');
        lines.push(...groupedLines);
        hasContent = true;
      }
    }

    // 3) 玩家所在地点物品（当前可用，排除已消耗）
    for (const locId of sceneLocIds) {
      const loc = graph.locations.find(l => l.id === locId);
      const locOwnerKeys = new Set([locId, keyOf(locId)]);
      if (loc) addNameKeys(locOwnerKeys, loc.name, loc.aliases || []);
      const entries = getOwnedItems(graph, locOwnerKeys, injectedItemIds, false);
      hasContent = addItemSection(
        lines,
        loc ? `[当前地点可用物品：${loc.name}]` : '[当前地点可用物品]',
        entries,
        injectedItemIds,
        false,
      ) || hasContent;
    }

    // 4) 当前地点信息：只展开一跳相连地点，不递归。
    if (sceneLocIds.size > 0) {
      const locationBlocks: string[] = [];
      for (const locId of sceneLocIds) {
        const block = formatCurrentLocationInfo(graph, locId, injectedLocIds);
        if (block) locationBlocks.push(block);
      }
      if (locationBlocks.length > 0) {
        lines.push('');
        lines.push('[当前地点]');
        lines.push(...locationBlocks);
        hasContent = true;
      }
    }

    // 5) 玩家输入提及地点：预载该地点最近变化的可用物品，最多 10 个。
    const mentionedLocs = findMentionedLocationsInText(userText, graph)
      .filter(loc => !sceneLocIds.has(loc.id));
    if (mentionedLocs.length > 0) {
      const changedAt = buildItemChangeFloorMap(ctx);
      let titlePushed = false;
      for (const loc of mentionedLocs) {
        const entries = getRecentlyChangedLocationItems(graph, loc, changedAt, injectedItemIds, false, 10);
        if (entries.length === 0) continue;
        if (!titlePushed) {
          lines.push('');
          lines.push('[玩家输入提及地点的近期物品]');
          titlePushed = true;
        }
        lines.push(`[地点]${loc.name}${loc.brief ? '：' + loc.brief : ''}`);
        lines.push('  最近变化物品:');
        for (const entry of entries) {
          lines.push(`  ${formatItemLine(entry, false)}`);
          injectedItemIds.add(entry.item.id);
        }
        injectedLocIds.add(loc.id);
        hasContent = true;
      }
    }

    // 6) 正文/玩家输入召回：物品和地点各最多 10 个。
    const recallLimit = Math.min(10, Math.max(1, topK || 10));
    const recallQuery = [queryText, userText].map(t => (t || '').trim()).filter(Boolean).join('\n');
    const allRecalled = recallKnowledgeGraph(recallQuery, graph, recallLimit * 6, queryEmb, {
      vectorGraph: ctx.mainGraph || null,
      embeddingCache: ctx.embeddingCache || null,
    });

    const recalledItems = allRecalled
      .filter(r => r.kind === 'item' && !injectedItemIds.has(r.id))
      .slice(0, recallLimit);
    if (recalledItems.length > 0) {
      lines.push('');
      lines.push('[正文提及的相关物品]');
      for (const recalled of recalledItems) {
        const entry = recallItemEntry(graph, recalled);
        if (!entry) continue;
        lines.push(formatItemLine(entry, true));
        injectedItemIds.add(entry.item.id);
      }
      hasContent = true;
    }

    const recalledLocations = allRecalled
      .filter(r => r.kind === 'location' && !injectedLocIds.has(r.id))
      .slice(0, recallLimit);
    if (recalledLocations.length > 0) {
      lines.push('');
      lines.push('[正文提及的相关地点]');
      for (const recalled of recalledLocations) {
        lines.push(recallLocationLine(graph, recalled));
        injectedLocIds.add(recalled.id);
      }
      hasContent = true;
    }

    if (!hasContent) return '';
    lines.push('</world_graph>');
    return lines.join('\n');
  } catch (err) {
    logWarn('图谱注入', '构建跳过', String(err));
    return '';
  }
}

function stripWorldGraphBlocks(content: string): string {
  return content.replace(/\n*<world_graph>[\s\S]*?<\/world_graph>\n*/g, '\n').trim();
}

/**
 * 直接写入本轮 completion.messages。
 * 不能在 CHAT_COMPLETION_SETTINGS_READY 里只调用 injectPrompts：
 * 此时酒馆可能已经收集完扩展注入，句柄更新会落到下一轮，表现为图谱慢一版。
 */
export function injectWorldGraphIntoCompletion(
  messages: SillyTavern.SendingMessage[],
  text: string,
): boolean {
  const graphText = (text || '').trim();
  if (!graphText) return false;

  for (const msg of messages || []) {
    if (typeof msg.content === 'string' && msg.content.includes('<world_graph>')) {
      msg.content = stripWorldGraphBlocks(msg.content);
    }
  }

  // 1) 优先塞进含 <chathistory> 的那条消息，且在 </chathistory> 之后
  //    （与角色记忆/神经链同处聊天记录之后的区域）
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    if (typeof content !== 'string') continue;
    if (content.includes('</chathistory>')) {
      messages[i].content = content.replace('</chathistory>', `</chathistory>\n${graphText}`);
      return true;
    }
  }

  // 2) 兜底：某些模板只有开标签无闭标签时，塞在 <chathistory> 之前
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    if (typeof content !== 'string') continue;
    if (content.includes('<chathistory>')) {
      messages[i].content = content.replace('<chathistory>', `${graphText}\n<chathistory>`);
      return true;
    }
  }

  // 3)终极兜底：splice 新 system 消息
  const idx = Math.max(0, messages.length - 2);
  messages.splice(idx, 0, { role: 'system', content: graphText });
  return true;
}

// ========== 注入管理 ==========

let currentWorldGraphInjection: { uninject: () => void } | null = null;

/** 把图谱文本注入到上下文（position 与动态人设一致，调用先于动态人设即排其上方）。 */
export function injectWorldGraph(text: string): void {
  if (currentWorldGraphInjection) {
    currentWorldGraphInjection.uninject();
    currentWorldGraphInjection = null;
  }
  if (!text) return;
  currentWorldGraphInjection = injectPrompts([
    {
      id: 'zhino_world_graph',
      position: 'in_chat',
      depth: 0,
      role: 'system',
      content: text,
      should_scan: false,
    },
  ]);
  logInfo('图谱注入', '已注入');
}

/** 释放注入句柄（聊天切换时调用） */
export function removeWorldGraphInjection(): void {
  if (currentWorldGraphInjection) {
    currentWorldGraphInjection.uninject();
    currentWorldGraphInjection = null;
  }
}
