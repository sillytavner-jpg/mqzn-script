/**
 * 图谱视图构建工具（纯函数，给 KnowledgeGraphView 用）
 *
 * 把 store 里的 KnowledgeGraph + characterLocations + relationshipProfiles + userName
 * 在运行时拼成 View 用的 VNode / VEdge。**不写入 store**，刷新即丢。
 *
 * 设计要点：
 * - 节点 4 类：loc(地点矩形) / char(角色球) / player(玩家球+六芒星) / item(物品菱形)
 * - 边 5 类：contains(蓝实线) / connected(绿虚线) / belongs_to(橙虚线)
 *           located_in(紫细实线,角色→所在地点) / interaction(蓝紫曲线,角色↔角色关系)
 * - 地点层级(level/parentChain/childrenCount) 从 contains 边反推，不入 store
 */

import type { KnowledgeGraph, GraphLocation, GraphItem, GraphCharacter, GraphEdge } from '../core/knowledgeGraph';
import { buildStableId } from '../core/knowledgeGraph';
import { USER_NODE_ID } from '../core/relationshipAnalysis';
import type { RelationshipProfile } from '../stores/mainStore';

// ─── View 层类型 ───────────────────────────────────────────
export type VNodeType = 'loc' | 'char' | 'player' | 'item';
export type VEdgeType = 'contains' | 'connected' | 'belongs_to' | 'located_in' | 'interaction';

export interface VNode {
  id: string;
  name: string;
  type: VNodeType;
  brief: string;
  aliases: string[];
  // 力模拟字段
  x: number; y: number; vx: number; vy: number;
  fx?: number | null; fy?: number | null; index?: number;
  degree: number;
  // 语义关联
  parentLocId?: string;
  parentChain?: string[];   // 父地点面包屑（root→自己），仅 loc
  level?: number;            // 地点层级（root=1）
  childrenCount?: number;    // 地点直接子数
  currentLocationName?: string; // 角色/玩家当前所在地名
  updatedAt?: string;
}

export interface VEdge {
  id: string;
  from: string;
  to: string;
  type: VEdgeType;
  label?: string;
  detail?: string;
}

// ─── 工具 ──────────────────────────────────────────────────
const slugName = (id: string, fallback = ''): string => fallback || id;

/** 从 contains 边反推每个地点的父 id 映射 */
function buildParentMap(edges: GraphEdge[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of edges) if (e.type === 'contains' && e.from && e.to) map.set(e.to, e.from);
  return map;
}

/** 从 contains 边统计每个地点的直接子数 */
function buildChildrenCount(edges: GraphEdge[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of edges) if (e.type === 'contains' && e.from) m.set(e.from, (m.get(e.from) || 0) + 1);
  return m;
}

/** 计算地点层级（root=1）+ 父链面包屑（含自己） */
function locLineage(locId: string, parentMap: Map<string, string>): { level: number; chain: string[] } {
  const chain: string[] = [locId];
  let cur = locId;
  let guard = 20;
  while (guard-- > 0) {
    const p = parentMap.get(cur);
    if (!p || chain.includes(p)) break;
    chain.unshift(p);
    cur = p;
  }
  return { level: chain.length, chain };
}

/** 由 id 找到对应的稳定名（在 graph 里查） */
function nameOfLoc(locId: string, locs: GraphLocation[]): string {
  return locs.find(l => l.id === locId)?.name || locId;
}

// ─── 主入口：构建视图数据 ──────────────────────────────────
export interface BuildGraphInput {
  graph: KnowledgeGraph;
  characterLocations: Record<string, string>;
  relationshipProfiles: RelationshipProfile[];
  userName: string;
  showItems: boolean;
}

export interface BuildGraphResult {
  nodes: VNode[];
  edges: VEdge[];
  locationNameMap: Map<string, string>; // locId -> locName（详情面板用）
}

export function buildGraphViewData(input: BuildGraphInput): BuildGraphResult {
  const { graph, characterLocations, relationshipProfiles, userName, showItems } = input;
  const nodeMap = new Map<string, VNode>();
  const edges: VEdge[] = [];

  // 地点节点
  for (const loc of graph.locations || []) {
    nodeMap.set(loc.id, {
      id: loc.id, name: loc.name, type: 'loc',
      brief: loc.brief || '', aliases: loc.aliases || [],
      x: 0, y: 0, vx: 0, vy: 0, degree: 0,
    });
  }

  const parentMap = buildParentMap(graph.edges);
  const childCount = buildChildrenCount(graph.edges);

  // 给每个地点补 level / parentChain / childrenCount
  for (const loc of graph.locations || []) {
    const node = nodeMap.get(loc.id);
    if (!node) continue;
    const { level, chain } = locLineage(loc.id, parentMap);
    node.level = level;
    node.parentChain = chain;
    node.childrenCount = childCount.get(loc.id) || 0;
    node.parentLocId = parentMap.get(loc.id);
  }

  // ★ 无条件先建玩家节点。index.ts 在两处显式把玩家从 characterLocations / graph.characters 里
  // 剔除掉了（注释说"图谱 UI 有专用 userNode"），但图谱这边必须自己补这个 userNode，
  // 否则一旦 relationshipProfiles 为空，玩家节点整个消失。仿 RelationshipTab.vue 的做法。
  nodeMap.set(USER_NODE_ID, {
    id: USER_NODE_ID, name: userName || '{{user}}', type: 'player',
    brief: '', aliases: [],
    x: 0, y: 0, vx: 0, vy: 0, degree: 0,
  });

  // 兜底：根据地名补一个游离地点节点（characterLocations 的 locId 在主图谱里找不到对应地点时）
  const addGhostLoc = (locName: string): string => {
    const id = buildStableId(locName);
    if (nodeMap.has(id)) return id;
    nodeMap.set(id, {
      id, name: locName, type: 'loc',
      brief: '(游离地点)', aliases: [],
      x: 0, y: 0, vx: 0, vy: 0, degree: 0,
      level: 1, childrenCount: 0,
    });
    return id;
  };

  // 把「角色 → 真正能找到的地点 id」统一成一个查询函数（兼容 id 直配 / 名匹配 / alias 匹配）
  const resolveLocId = (rawLocId?: string, locNameHint?: string): string | undefined => {
    if (!rawLocId && !locNameHint) return undefined;
    // 1) 直 id 匹配
    if (rawLocId && nodeMap.has(rawLocId) && nodeMap.get(rawLocId)!.type === 'loc') return rawLocId;
    // 2) 用 locNameHint 在 locations 里找 name / alias（先转 id 再查）
    if (locNameHint) {
      const byName = (graph.locations || []).find(l => l.name === locNameHint || l.aliases?.includes(locNameHint));
      if (byName) return byName.id;
      const byStableId = (graph.locations || []).find(l => l.id === buildStableId(locNameHint));
      if (byStableId) return byStableId.id;
    }
    // 3) 兜底：创建一个游离地点节点
    if (locNameHint) return addGhostLoc(locNameHint);
    if (rawLocId) return addGhostLoc(rawLocId); // 此时 rawLocId 是个 id，但 graph.locations 缺这个地点；用 id 反推不出原名，直接以 id 当名补
    return undefined;
  };

  // 玩家特殊处理 — characterLocations 里玩家的 entry 的 key 应为 userName
  // （实际有些人格名 via characterLocations 也会被登记）
  // 角色 + 玩家节点（来自 characterLocations：角色名 → 地点 id）
  for (const [name, rawLocId] of Object.entries(characterLocations || {})) {
    const isPlayer = name === userName;
    const id = isPlayer ? USER_NODE_ID : name; // 角色名直接当 id（与 makeRelationshipId 口径一致）
    if (nodeMap.has(id)) {
      // 已存在则补充所在
      const n = nodeMap.get(id)!;
      if (!n.parentLocId) n.parentLocId = resolveLocId(rawLocId || undefined);
      continue;
    }
    const resolved = resolveLocId(rawLocId || undefined);
    nodeMap.set(id, {
      id, name, type: isPlayer ? 'player' : 'char',
      brief: '', aliases: [],
      x: 0, y: 0, vx: 0, vy: 0, degree: 0,
      parentLocId: resolved,
    });
  }

  // 同时也把 graph.characters 里登记的角色补进来（characterLocations 可能漏）
  for (const ch of graph.characters || []) {
    const isPlayer = ch.name === userName;
    const id = isPlayer ? USER_NODE_ID : ch.name;
    if (nodeMap.has(id)) {
      // 补 brief / aliases
      const n = nodeMap.get(id)!;
      if (!n.aliases?.length && ch.aliases?.length) n.aliases = ch.aliases;
      if (!n.parentLocId) n.parentLocId = resolveLocId(undefined, ch.location);
      continue;
    }
    const locId = resolveLocId(undefined, ch.location);
    nodeMap.set(id, {
      id, name: ch.name, type: isPlayer ? 'player' : 'char',
      brief: '', aliases: ch.aliases || [],
      x: 0, y: 0, vx: 0, vy: 0, degree: 0,
      parentLocId: locId,
    });
  }

  // 物品节点（受 showItems 开关）
  if (showItems) {
    for (const it of graph.items || []) {
      nodeMap.set(it.id, {
        id: it.id, name: it.name, type: 'item',
        brief: it.brief || '', aliases: it.aliases || [],
        x: 0, y: 0, vx: 0, vy: 0, degree: 0,
      });
    }
  }

  // ── 边 ──
  // belongs_to.to 可能是地点 id、角色名、或玩家名。玩家名字符串不是节点 id
  //（玩家节点 id 是 USER_NODE_ID），不归一会让边找不到端点 → 物品飘着不连线。
  // 角色 NPC 名当 id 是 graphBuilder 的一贯口径，无需改；只把玩家名映射到 USER_NODE_ID。
  // 物品归属对象可能是地点名/地点id/角色名；地点名→用地点 id 作端点；地点 id 直用；否则原样（角色名当 id）。
  const resolveEdgeEndpoint = (rawTo: string, isBelongTo: boolean): string => {
    if (!rawTo) return rawTo;
    if (isBelongTo && rawTo === (userName || '{{user}}')) return USER_NODE_ID;
    // 地点名 → 转地点 id 作端点
    const byName = (graph.locations || []).find(l => l.name === rawTo || l.aliases?.includes(rawTo));
    if (byName) return byName.id;
    // 地点 id 直配
    if (nodeMap.has(rawTo) && nodeMap.get(rawTo)!.type === 'loc') return rawTo;
    return rawTo;
  };
  const pushEdge = (e: VEdge) => {
    // 仅当两端节点都在视图里才保留
    if (nodeMap.has(e.from) && nodeMap.has(e.to)) edges.push(e);
  };

  // contains / connected
  for (const e of graph.edges || []) {
    if (e.type === 'contains') {
      pushEdge({ id: `e_contains_${e.from}_${e.to}`, from: e.from, to: e.to, type: 'contains' });
    } else if (e.type === 'connected') {
      pushEdge({ id: `e_connected_${e.from}_${e.to}`, from: e.from, to: e.to, type: 'connected', detail: e.detail });
    } else if (e.type === 'belongs_to' && showItems) {
      // 旧结构 fallback：from=物品id, to=角色名或地点id（玩家名→USER_NODE_ID）
      const toResolved = resolveEdgeEndpoint(e.to, true);
      pushEdge({ id: `e_bto_${e.from}_${toResolved}`, from: e.from, to: toResolved, type: 'belongs_to', detail: e.detail });
    }
  }

  // 物品归属边（新结构）：item.owner / item.location 命中节点即建边
  // owner 与 location 都画一条边（owner 静态所有权、location 当前持有/存放点）；
  // 相同则只画一条。pushEdge 自动去重（同 from + 同 to 同 id 会被 Map/数组跳过，但 edges 是数组，
  // 这里靠 id 字符串重复也会重复 push——下面用临时集合做去重）。
  if (showItems) {
    const addedBelongIds = new Set<string>(edges.filter(e => e.type === 'belongs_to').map(e => e.id));
    for (const it of graph.items || []) {
      const targets = new Set<string>();
      if (it.owner) targets.add(it.owner);
      if (it.location) targets.add(it.location);
      for (const rawTo of targets) {
        const toResolved = resolveEdgeEndpoint(rawTo, true);
        if (toResolved === it.id) continue; // 防自环
        const eid = `e_bto_${it.id}_${toResolved}`;
        if (addedBelongIds.has(eid)) continue;
        addedBelongIds.add(eid);
        pushEdge({
          id: eid, from: it.id, to: toResolved, type: 'belongs_to',
          detail: it.statusDetail,
        });
      }
    }
  }

  // located_in：从角色/玩家节点 → 所在地点
  // 同时补 currentLocationName
  const locNameMap = new Map<string, string>();
  for (const loc of graph.locations || []) locNameMap.set(loc.id, loc.name);

  for (const n of nodeMap.values()) {
    if (n.type === 'char' || n.type === 'player') {
      if (!n.parentLocId) continue;
      const target = nodeMap.get(n.parentLocId);
      if (!target || target.type !== 'loc') continue;
      // 玩家的 location 边也画出来
      pushEdge({
        id: `e_loc_${n.id}_${n.parentLocId}`,
        from: n.id, to: n.parentLocId, type: 'located_in',
      });
      n.currentLocationName = locNameMap.get(n.parentLocId) || target.name;
    }
  }

  // interaction：从 relationshipProfiles 转
  // profile.from / profile.to 是角色名或 USER_NODE_ID
  for (const p of relationshipProfiles || []) {
    const fid = p.from === USER_NODE_ID ? USER_NODE_ID : p.from;
    const tid = p.to === USER_NODE_ID ? USER_NODE_ID : p.to;
    // 端点必须存在于节点表内（玩家已在前面无条件创建过，这里只补 NPC）
    if (!nodeMap.has(fid)) {
      // 临时创建一个角色节点（玩家已在前面创建，这里 fallback 只会是 NPC → char）
      nodeMap.set(fid, {
        id: fid, name: p.fromName || fid, type: fid === USER_NODE_ID ? 'player' : 'char',
        brief: '', aliases: [],
        x: 0, y: 0, vx: 0, vy: 0, degree: 0,
      });
    }
    if (!nodeMap.has(tid)) {
      nodeMap.set(tid, {
        id: tid, name: p.toName || tid, type: tid === USER_NODE_ID ? 'player' : 'char',
        brief: '', aliases: [],
        x: 0, y: 0, vx: 0, vy: 0, degree: 0,
      });
    }
    pushEdge({
      id: `e_int_${fid}_${tid}`,
      from: fid, to: tid, type: 'interaction',
      label: p.relationType,
      detail: p.currentState,
    });
  }

  // 统计 degree（参与 force 的边的两端 +1）
  for (const e of edges) {
    const s = nodeMap.get(e.from); const t = nodeMap.get(e.to);
    if (s) s.degree++;
    if (t) t.degree++;
  }

  return { nodes: [...nodeMap.values()], edges, locationNameMap: locNameMap };
}

// ─── 节点尺寸（用于碰撞 + 边避让）────────────────────────
export function nodeHalfWidth(n: VNode): number {
  // 矩形节点的半宽（loc 大些；item 菱形小些；player/char 圆按半径算）
  const nameLen = Math.min(10, n.name.length || 2);
  if (n.type === 'loc') return 28 + nameLen * 1.5;       // 矩形：icon + 名称
  if (n.type === 'item') return 14;                       // 菱形小
  if (n.type === 'player') return 14;                     // 圆
  return 11;                                               // char 圆
}

export function nodeHalfHeight(n: VNode): number {
  if (n.type === 'loc') return 22;     // 矩形高
  if (n.type === 'item') return 14;
  if (n.type === 'player') return 14;
  return 11;
}

/** 节点到包围盒边缘的"等效半径"（forceCollide 用，取对角线半长 + padding） */
export function nodeCollisionRadius(n: VNode): number {
  const hw = nodeHalfWidth(n);
  const hh = nodeHalfHeight(n);
  return Math.sqrt(hw * hw + hh * hh) / 2 + 6;
}

// ─── 边路径：贝塞尔 + 避让节点 ─────────────────────────────
export interface Point { x: number; y: number; }

/**
 * 计算边的 SVG path（二次贝塞尔），自动绕开途经的其他节点。
 * nodesById 用于查节点位置；excludeFrom/To 不参与避让。
 */
export function computeEdgePath(
  fromId: string, toId: string,
  nodesById: Map<string, VNode>,
  type: VEdgeType,
): string {
  const s = nodesById.get(fromId);
  const t = nodesById.get(toId);
  if (!s || !t) return '';

  // 直线连心
  const sx = s.x, sy = s.y, ex = t.x, ey = t.y;
  const dx = ex - sx, dy = ey - sy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;     // 连线方向单位向量
  const nx = -uy, ny = ux;                // 垂直方向单位向量

  // 中点
  const mx = (sx + ex) / 2, my = (sy + ey) / 2;

  // interaction 边恒走曲线（视觉区分）
  if (type === 'interaction') {
    const offset = 30;
    return `M ${sx} ${sy} Q ${mx + nx * offset} ${my + ny * offset} ${ex} ${ey}`;
  }

  // 直线/虚线：扫一遍其他节点，找"挡路"的
  let avoidance = 0;
  for (const n of nodesById.values()) {
    if (n.id === fromId || n.id === toId) continue;
    // 节点到连线的垂直距离
    const px = n.x - sx, py = n.y - sy;
    const along = px * ux + py * uy;          // 在连线上的投影长度
    if (along < 0 || along > len) continue;   // 投影不在线段内，跳过
    const perp = px * nx + py * ny;           // 带符号垂直距离（正负决定避让方向）
    const need = nodeHalfWidth(n) / 2 + 8;    // 节点半宽 + padding
    if (Math.abs(perp) < need) {
      // 沿"远离该节点"的方向偏移到刚好让出
      const sign = perp >= 0 ? -1 : 1;
      const want = (need + 12) * sign;
      if (Math.abs(want) > Math.abs(avoidance)) avoidance = want;
    }
  }

  if (Math.abs(avoidance) < 1) {
    // 无需避让——直线
    return `M ${sx} ${sy} L ${ex} ${ey}`;
  }

  return `M ${sx} ${sy} Q ${mx + nx * avoidance} ${my + ny * avoidance} ${ex} ${ey}`;
}

// ─── 边视觉样式 ────────────────────────────────────────────
export interface EdgeStyle { color: string; dash?: string; width: number; }

export function edgeStyle(type: VEdgeType): EdgeStyle {
  switch (type) {
    case 'contains':    return { color: 'rgba(122,162,255,0.65)', width: 1.4 };
    case 'connected':   return { color: 'rgba(120,220,160,0.55)', dash: '6 6', width: 1.3 };
    case 'belongs_to':  return { color: 'rgba(240,180,80,0.55)', dash: '4 4', width: 1.1 };
    case 'located_in':  return { color: 'rgba(180,140,255,0.45)', width: 1.1 };
    case 'interaction': return { color: 'rgba(160,120,255,0.7)', width: 1.6 };
  }
}

export const EDGE_TYPE_LABELS: Record<VEdgeType, string> = {
  contains: '包含',
  connected: '连通',
  belongs_to: '归属',
  located_in: '所在',
  interaction: '关系',
};

export const NODE_TYPE_LABELS: Record<VNodeType, string> = {
  loc: '地点', char: '角色', player: '玩家', item: '物品',
};