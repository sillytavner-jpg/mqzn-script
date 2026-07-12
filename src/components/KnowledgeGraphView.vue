<script setup lang="ts">
import { computed, ref, shallowRef, triggerRef, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide } from 'd3-force';
import type { Simulation, SimulationNodeDatum, SimulationLinkDatum } from 'd3-force';
import type { KnowledgeGraph } from '../core/knowledgeGraph';
import { useIsMobile } from '../composables/useIsMobile';
import {
  buildGraphViewData, computeEdgePath, edgeStyle,
  nodeHalfWidth, nodeHalfHeight, nodeCollisionRadius,
  EDGE_TYPE_LABELS, NODE_TYPE_LABELS,
  type VNode, type VEdge, type VEdgeType, type VNodeType,
} from '../utils/graphBuilder';
import { USER_NODE_ID } from '../core/relationshipAnalysis';
import type { RelationshipProfile } from '../stores/mainStore';

const props = defineProps<{
  graph: KnowledgeGraph;
  characterLocations: Record<string, string>;
  relationshipProfiles: RelationshipProfile[];
  userName: string;
}>();

const emit = defineEmits<{ (e: 'clear'): void; (e: 'merge', source: string): void; (e: 'updateAliases', name: string, aliases: string[]): void; (e: 'setLocation', name: string, location: string): void }>();

const isMobile = useIsMobile();

// ─── 别名内联编辑 ───
// 进入节点详情时把当前 aliases 复制到可编辑文本；保存时切分并 emit 给上层 store。
const editingAliases = ref('');
const isEditingAliases = ref(false);
function startEditAliases() {
  const al = selectedNode.value?.aliases || [];
  editingAliases.value = al.join('、');
  isEditingAliases.value = true;
}
function saveAliases() {
  const name = selectedNode.value?.name;
  if (!name) { isEditingAliases.value = false; return; }
  const list = editingAliases.value
    .split(/[,，、\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
  emit('updateAliases', name, list);
  isEditingAliases.value = false;
}
function cancelEditAliases() {
  isEditingAliases.value = false;
}

// ─── 角色地点内联编辑 ───
const editingLocation = ref('');
const isEditingLocation = ref(false);
function startEditLocation() {
  // 初始填当前显示名（有 currentLocationName 用之，否则空）
  editingLocation.value = selectedNode.value?.currentLocationName || '';
  isEditingLocation.value = true;
}
function saveLocation() {
  const name = selectedNode.value?.name;
  if (!name) { isEditingLocation.value = false; return; }
  const locStr = editingLocation.value.trim();
  // 允许空（清空地点）；非空调用 setLocation
  if (locStr) {
    emit('setLocation', name, locStr);
  }
  isEditingLocation.value = false;
}
function cancelEditLocation() {
  isEditingLocation.value = false;
}

// ─── 视图数据 ───
const showItems = ref(true);
const data = computed(() => buildGraphViewData({
  graph: props.graph,
  characterLocations: props.characterLocations,
  relationshipProfiles: props.relationshipProfiles,
  userName: props.userName,
  showItems: showItems.value,
}));

const MAX_NODES = 80;
// shallowRef：d3-force tick 期间频繁改 n.x/n.y，避免每属性都穿透 Vue Proxy 触发依赖追踪
const nodes = shallowRef<VNode[]>([]);
const edges = shallowRef<VEdge[]>([]);
const truncated = ref(false);

let simulation: Simulation<VNode, VEdge> | null = null;
let nodeIds = new Set<string>();

// ─── 力模拟 ───
function rebuild() {
  if (simulation) simulation.stop();
  draggingNode.value = null;
  panning.value = false;

  let arr = [...data.value.nodes];
  const allEdges = [...data.value.edges];

  // 截断保护
  truncated.value = arr.length > MAX_NODES;
  if (arr.length > MAX_NODES) {
    arr.sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name));
    const kept = new Set(arr.slice(0, MAX_NODES).map(n => n.id));
    arr = arr.filter(n => kept.has(n.id));
    nodeIds = new Set(arr.map(n => n.id));
  } else {
    nodeIds = new Set(arr.map(n => n.id));
  }

  const cx = 400, cy = 300;
  arr.forEach((n, i) => {
    const a = (i / Math.max(1, arr.length)) * Math.PI * 2;
    n.x = cx + Math.cos(a) * 160 + (Math.random() - 0.5) * 30;
    n.y = cy + Math.sin(a) * 120 + (Math.random() - 0.5) * 30;
    n.fx = null; n.fy = null;
  });

  nodes.value = arr;

  // 仅保留视图内的边
  edges.value = allEdges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));

  // d3-force link 需要的接口：source/target/index
  interface ForceLinkLike extends SimulationLinkDatum<VNode> { type: VEdgeType; }
  const forceLinks: ForceLinkLike[] = edges.value
    .filter(e => e.type !== 'interaction' && e.type !== 'located_in') // 仅地点骨架边参与 force
    .map(e => ({ source: e.from, target: e.to, type: e.type }));

  // 角色→父地点引力（自定义力）
  function charAttract(alpha: number) {
    for (const n of nodes.value) {
      if (n.type === 'loc' || n.type === 'item' || !n.parentLocId) continue;
      const loc = nodes.value.find(l => l.id === n.parentLocId);
      if (!loc) continue;
      const dx = loc.x - n.x, dy = loc.y - n.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      // 目标距离 35（更短），强度 0.25（更紧贴）
      const k = (d - 35) * 0.25 * alpha;
      n.vx += (dx / d) * k;
      n.vy += (dy / d) * k;
    }
  }

  simulation = forceSimulation<VNode>(nodes.value)
    .force('charge', forceManyBody<VNode>().strength(-180))   // 斥力 -420→-180，没连边的节点不再飘远
    .force('link', forceLink<VNode, ForceLinkLike>(forceLinks)
      .id(d => d.id)
      .distance(l => l.type === 'contains' ? 60 : 80)
      .strength(l => l.type === 'contains' ? 0.7 : 0.6))       // 父子拉得更紧
    .force('center', forceCenter(400, 300).strength(0.08))    // 中心引力 0.04→0.08
    .force('collide', forceCollide<VNode>().radius(n => nodeCollisionRadius(n)))
    .force('char-attract', charAttract)
    .alpha(1)
    .alphaMin(0.003)
    .alphaDecay(0.022)
    .stop();  // 先 stop，下面同步 tick 到接近稳态再以 alpha(0) 启动

  // ★ 同步推进到接近稳态，避免进图谱时节点从圆周初始位置被斥力推开"弹一下"
  // alphaDecay 0.022 → 跑 150 次 tick 后 alpha 已接近 0，节点已就位
  for (let i = 0; i < 150; i++) simulation.tick();
  triggerRef(nodes); // shallowRef 不同步 tick 内逐属性变更，结束后一次性通知 Vue

  // tick 节流：拖拽/模拟期间用 rAF 节流到 ~30fps，避免每 tick 都 triggerRef
  let tickRaf: number | null = null;
  simulation.on('tick', () => {
    if (tickRaf === null) {
      tickRaf = requestAnimationFrame(() => {
        triggerRef(nodes);
        tickRaf = null;
      });
    }
  });

  // alpha(0).restart()：节点显示在稳态位置不动；用户拖节点时会 reheat 触发动画
  simulation.alpha(0).restart();
}

function stopSim() { simulation?.stop(); }
function reheat() { simulation?.alpha(0.4).restart(); }

// ─── 节点尺寸/视觉 ───
function nodeRadius(n: VNode) {
  if (n.type === 'loc') return 16 + Math.min(12, n.degree * 2) + (isParentNode(n) ? 4 : 0);
  if (n.type === 'player') return 12;
  if (n.type === 'item') return 10;
  return 8;
}
function nodeGradientId(n: VNode) {
  if (n.type === 'player') return 'grad-player';
  if (n.type === 'loc') return 'grad-loc';
  if (n.type === 'item') return 'grad-item';
  return 'grad-char';
}
function hexagramPath(r: number): string {
  const R = r + 5;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    pts.push({ x: Math.cos(a) * R, y: Math.sin(a) * R });
  }
  return `M ${pts[0].x} ${pts[0].y} L ${pts[2].x} ${pts[2].y} L ${pts[4].x} ${pts[4].y} Z M ${pts[1].x} ${pts[1].y} L ${pts[3].x} ${pts[3].y} L ${pts[5].x} ${pts[5].y} Z`;
}

// 节点 id → VNode 映射（边路径计算用）
const nodesById = computed(() => new Map(nodes.value.map(n => [n.id, n])));

// 父地点集合（用于加大父节点尺寸）
const parentLocSet = computed(() => {
  const s = new Set<string>();
  for (const e of edges.value) if (e.type === 'contains') s.add(e.from);
  return s;
});
function isParentNode(n: VNode) { return n.type === 'loc' && parentLocSet.value.has(n.id); }

const locCount = computed(() => nodes.value.filter(n => n.type === 'loc').length);
const charCount = computed(() => nodes.value.filter(n => n.type === 'char' || n.type === 'player').length);
const itemCount = computed(() => nodes.value.filter(n => n.type === 'item').length);
const edgeCount = computed(() => edges.value.length);
const graphVersion = computed(() => props.graph.version || 0);

// ─── 星尘背景 ───
interface Star { x: number; y: number; r: number; opacity: number; twinkle: boolean; delay: number; dur: number; }
const stars = computed<Star[]>(() => {
  let seed = 137;
  const rng = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const result: Star[] = [];
  for (let i = 0; i < 8; i++) result.push({ x: rng() * 800, y: rng() * 600, r: 0.25 + rng() * 0.9, opacity: 0.06 + rng() * 0.3, twinkle: rng() > 0.7, delay: rng() * 5, dur: 2.5 + rng() * 3 });
  for (let i = 0; i < 5; i++) result.push({ x: rng() * 800, y: rng() * 600, r: 0.5 + rng() * 1.3, opacity: 0.2 + rng() * 0.55, twinkle: rng() > 0.45, delay: rng() * 4, dur: 1.8 + rng() * 2.5 });
  for (let i = 0; i < 2; i++) result.push({ x: 60 + rng() * 680, y: 50 + rng() * 500, r: 1.0 + rng() * 1.0, opacity: 0.5 + rng() * 0.5, twinkle: true, delay: rng() * 3, dur: 2 + rng() * 2 });
  return result;
});

// ─── 缩放平移（用 viewBox 控制，避免 CSS transform 与 viewBox 双层导致 getScreenCTM 失真）───
const zoomScale = ref(1);
const panX = ref(0); // viewBox 起点 X（用户坐标）
const panY = ref(0);
const viewBox = computed(() => {
  const w = 800 / zoomScale.value;
  const h = 600 / zoomScale.value;
  return `${panX.value} ${panY.value} ${w} ${h}`;
});

function zoomBy(f: number) {
  // 以 viewBox 中心为锚点缩放
  const newZoom = Math.max(0.3, Math.min(3, zoomScale.value * f));
  const cx = panX.value + (800 / zoomScale.value) / 2;
  const cy = panY.value + (600 / zoomScale.value) / 2;
  zoomScale.value = newZoom;
  panX.value = cx - (800 / newZoom) / 2;
  panY.value = cy - (600 / newZoom) / 2;
}
function resetView() { zoomScale.value = 1; panX.value = 0; panY.value = 0; }

// ─── 选中（仅点击选中，hover 不触发任何高亮/信息面板） ───
const selectedId = ref<string | null>(null);

const selectedNode = computed(() => selectedId.value ? nodes.value.find(n => n.id === selectedId.value) || null : null);
const selectedLinks = computed(() =>
  selectedId.value ? edges.value.filter(l => l.from === selectedId.value || l.to === selectedId.value) : []
);

// ─── 节点详情面板内容 ───
const nodeByNameMap = computed(() => {
  const m = new Map<string, VNode>();
  for (const n of nodes.value) m.set(n.name, n);
  return m;
});
const locChainNames = computed(() => {
  if (!selectedNode.value || selectedNode.value.type !== 'loc' || !selectedNode.value.parentChain) return [];
  return selectedNode.value.parentChain.map(id => data.value.locationNameMap.get(id) || id);
});
const relatedCharacters = computed(() => {
  if (!selectedNode.value) return [];
  if (selectedNode.value.type === 'char' || selectedNode.value.type === 'player') {
    return selectedLinks.value
      .filter(l => l.type === 'interaction')
      .map(l => {
        const otherId = l.from === selectedNode.value!.id ? l.to : l.from;
        const other = nodes.value.find(n => n.id === otherId);
        return { name: other?.name || otherId, label: l.label };
      });
  }
  return [];
});

// ─── 交互（Pointer Events + d3-force 拖拽 pin） ───
const draggingNode = ref<VNode | null>(null);
const panning = ref(false);
const lastScreen = ref({ x: 0, y: 0 });
const moved = ref(false);
const DRAG_THRESHOLD = 5;
let dragStartSvg = { x: 0, y: 0 };
let panStartX = 0; let panStartY = 0;
let nodeWasClicked = false; // 标记刚点了节点，防止 onBgClick 误清 selectedId

type ScreenPoint = { x: number; y: number };
type PinchState = ScreenPoint & { dist: number };
const activePointers = new Map<number, ScreenPoint>();
let lastPinch: PinchState | null = null;

function toSvgPoint(e: { clientX: number; clientY: number }, svg: SVGSVGElement) {
  const pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}
function clampZoom(v: number) { return Math.max(0.3, Math.min(3, v)); }
function zoomAt(svg: SVGSVGElement, clientX: number, clientY: number, newZoom: number) {
  const oldZoom = zoomScale.value;
  const zoom = clampZoom(newZoom);
  if (zoom === oldZoom) return;
  const anchor = toSvgPoint({ clientX, clientY }, svg);
  const oldW = 800 / oldZoom;
  const oldH = 600 / oldZoom;
  const rx = (anchor.x - panX.value) / oldW;
  const ry = (anchor.y - panY.value) / oldH;
  zoomScale.value = zoom;
  panX.value = anchor.x - rx * (800 / zoom);
  panY.value = anchor.y - ry * (600 / zoom);
}
function currentPinchState(): PinchState | null {
  const pts = Array.from(activePointers.values());
  if (pts.length < 2) return null;
  const [a, b] = pts;
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    dist: Math.hypot(a.x - b.x, a.y - b.y),
  };
}
function releaseDraggingNode() {
  if (!draggingNode.value) return;
  draggingNode.value.fx = null;
  draggingNode.value.fy = null;
  draggingNode.value = null;
}

function onNodePointerDown(e: PointerEvent, n: VNode) {
  e.stopPropagation();
  cancelFocusAnim();
  // capture 到外层 svg（不是节点 g），保证后续 pointermove 仍能被 svg 自身的 listener 收到
  const svg = (e.currentTarget as Element).closest('svg') as SVGSVGElement;
  svg?.setPointerCapture?.(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size >= 2) {
    releaseDraggingNode();
    panning.value = false;
    lastPinch = currentPinchState();
    moved.value = true;
    return;
  }
  draggingNode.value = n;
  moved.value = false;
  const pt = toSvgPoint(e, svg);
  dragStartSvg = { x: pt.x, y: pt.y };
  n.fx = n.x; n.fy = n.y;
}
function onBgPointerDown(e: PointerEvent) {
  cancelFocusAnim();
  const svg = (e.currentTarget as Element) as SVGSVGElement;
  svg?.setPointerCapture?.(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size >= 2) {
    releaseDraggingNode();
    panning.value = false;
    lastPinch = currentPinchState();
    moved.value = true;
    return;
  }
  panning.value = true;
  moved.value = false;
  lastScreen.value = { x: e.clientX, y: e.clientY };
  panStartX = panX.value; panStartY = panY.value;
}
function onPointerMove(e: PointerEvent) {
  const svg = (e.currentTarget as Element) as SVGSVGElement;
  if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (activePointers.size >= 2) {
    const cur = currentPinchState();
    if (cur && lastPinch && lastPinch.dist > 0) {
      zoomAt(svg, cur.x, cur.y, zoomScale.value * (cur.dist / lastPinch.dist));
      panX.value -= (cur.x - lastPinch.x) * (800 / zoomScale.value) / Math.max(1, svg.getBoundingClientRect().width);
      panY.value -= (cur.y - lastPinch.y) * (600 / zoomScale.value) / Math.max(1, svg.getBoundingClientRect().height);
      moved.value = true;
    }
    lastPinch = cur;
    return;
  }

  if (draggingNode.value) {
    const p = toSvgPoint(e, svg);
    const dist = Math.hypot(p.x - dragStartSvg.x, p.y - dragStartSvg.y);
    if (dist > DRAG_THRESHOLD) {
      moved.value = true;
      draggingNode.value.fx = p.x;
      draggingNode.value.fy = p.y;
      simulation?.alpha(0.3).restart();
    }
  } else if (panning.value) {
    const prev = toSvgPoint({ clientX: lastScreen.value.x, clientY: lastScreen.value.y }, svg);
    const cur = toSvgPoint(e, svg);
    panX.value = panStartX - (cur.x - prev.x);
    panY.value = panStartY - (cur.y - prev.y);
    moved.value = true;
  }
}
function onPointerUp(e: PointerEvent) {
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) lastPinch = null;

  if (draggingNode.value) {
    if (!moved.value) { selectedId.value = draggingNode.value.id; nodeWasClicked = true; }
    draggingNode.value.fx = null;
    draggingNode.value.fy = null;
    if (moved.value) simulation?.alpha(0.15).alphaTarget(0);
    draggingNode.value = null;
  }
  if (activePointers.size === 1) {
    const [rest] = Array.from(activePointers.values());
    lastScreen.value = { x: rest.x, y: rest.y };
    panStartX = panX.value; panStartY = panY.value;
    panning.value = true;
  } else {
    panning.value = false;
  }
  const svg = (e.currentTarget as Element) as SVGSVGElement;
  svg?.releasePointerCapture?.(e.pointerId);
}
function onBgClick() {
  // pointerup 之后浏览器会补一个 click 事件，若刚点了节点则跳过（selectedId 已在 onPointerUp 设置）
  if (nodeWasClicked) { nodeWasClicked = false; return; }
  if (!moved.value && activePointers.size === 0) selectedId.value = null;
}
function onWheel(e: WheelEvent) {
  cancelFocusAnim();
  e.preventDefault();
  const svg = (e.currentTarget as Element) as SVGSVGElement;
  const f = e.deltaY > 0 ? 0.9 : 1.1;
  zoomAt(svg, e.clientX, e.clientY, zoomScale.value * f);
}

// ─── 视角聚焦（点列表项触发；平滑过渡到以目标节点为中心） ───
const rosterActiveId = ref<string | null>(null);
let animFrame: number | null = null;

// targetZoom > 0 表示同时缩放到该值；animate=false 表示瞬时定位（用于初始化）
function focusOnNode(targetId: string, targetZoom = 1.6, animate = true, select = true) {
  const target = nodes.value.find(n => n.id === targetId);
  if (!target) return;
  if (select) selectedId.value = targetId;
  rosterActiveId.value = targetId;

  // 目标 viewBox：以 target.x/y 为中心
  const zoom = Math.max(0.3, Math.min(3, targetZoom));
  const targetW = 800 / zoom;
  const targetH = 600 / zoom;
  const endX = target.x - targetW / 2;
  const endY = target.y - targetH / 2;
  const endZoom = zoom;

  if (!animate) {
    panX.value = endX; panY.value = endY; zoomScale.value = endZoom;
    return;
  }

  // 平滑过渡（300ms，ease-out）
  const startX = panX.value, startY = panY.value, startZoom = zoomScale.value;
  const t0 = performance.now();
  const DURATION = 300;
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / DURATION);
    const e = ease(p);
    panX.value = startX + (endX - startX) * e;
    panY.value = startY + (endY - startY) * e;
    // zoom 用对数空间插值，缩放观感更自然
    zoomScale.value = Math.exp(Math.log(startZoom) + (Math.log(endZoom) - Math.log(startZoom)) * e);
    if (p < 1) animFrame = requestAnimationFrame(step);
    else animFrame = null;
  };
  if (animFrame) cancelAnimationFrame(animFrame);
  animFrame = requestAnimationFrame(step);
}

// 滚轮缩放时取消正在跑的 focus 动画
function cancelFocusAnim() {
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
}

// ─── 角色名册 ───
// 玩家排第一，其余按 degree 降序
const rosterNodes = computed<VNode[]>(() => {
  const players = nodes.value.filter(n => n.type === 'player');
  const chars = nodes.value.filter(n => n.type === 'char');
  chars.sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name));
  return [...players, ...chars];
});
const rosterCollapsed = ref(false);
const mobileRosterOpen = ref(false);
function toggleMobileRoster() {
  mobileRosterOpen.value = !mobileRosterOpen.value;
  if (mobileRosterOpen.value) selectedId.value = null;
}
function focusMobileRosterNode(targetId: string) {
  focusOnNode(targetId, 1.6, true, false);
  mobileRosterOpen.value = false;
}

// ─── 生命周期 ───
onMounted(() => {
  rebuild();
  // 初始 viewBox 以玩家为中心、zoom=1.5，一次性设置（无动画，进图谱不"弹一下"）
  nextTick(() => focusOnNode(USER_NODE_ID, 1.5, false));
  // ↑ 用 nextTick 保证 rebuild 里 nodes.value 已填充，玩家节点 x/y 已初始化
});
onBeforeUnmount(() => { stopSim(); if (animFrame) cancelAnimationFrame(animFrame); if (rebuildTimer) clearTimeout(rebuildTimer); });

// watcher 加 150ms debounce：commitKnowledgeGraph 一次更新 graph + characterLocations
// 会先后触发两次 rebuild，debounce 合并为一次
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuild(), 150);
}
watch(() => [props.graph, props.characterLocations, props.relationshipProfiles, showItems.value],
  () => debouncedRebuild(), { deep: false });
</script>

<template>
  <div class="kgv-wrap">
    <svg
      class="kgv-svg"
      :viewBox="viewBox"
      preserveAspectRatio="xMidYMid meet"
      @pointerdown="onBgPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @click="onBgClick"
      @wheel="onWheel"
    >
      <defs>
        <linearGradient id="kgv-bg-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#05060a" />
          <stop offset="100%" stop-color="#0b0f1c" />
        </linearGradient>
        <radialGradient id="grad-loc" cx="35%" cy="35%" r="65%">
          <stop offset="0%" stop-color="#9bb5ff" />
          <stop offset="65%" stop-color="#7aa2ff" />
          <stop offset="100%" stop-color="#4a6ab5" />
        </radialGradient>
        <radialGradient id="grad-player" cx="35%" cy="35%" r="65%">
          <stop offset="0%" stop-color="#b5f9ff" />
          <stop offset="60%" stop-color="#7df9ff" />
          <stop offset="100%" stop-color="#3da8b8" />
        </radialGradient>
        <radialGradient id="grad-char" cx="35%" cy="35%" r="65%">
          <stop offset="0%" stop-color="#e0a8ff" />
          <stop offset="60%" stop-color="#c8a2ff" />
          <stop offset="100%" stop-color="#8a5fd0" />
        </radialGradient>
        <radialGradient id="grad-item" cx="35%" cy="35%" r="65%">
          <stop offset="0%" stop-color="#ffe9a8" />
          <stop offset="60%" stop-color="#f0c060" />
          <stop offset="100%" stop-color="#a87830" />
        </radialGradient>
        <radialGradient id="nebula-purple" cx="30%" cy="40%" r="45%">
          <stop offset="0%" stop-color="rgba(139,108,255,0.025)" />
          <stop offset="100%" stop-color="rgba(139,108,255,0)" />
        </radialGradient>
        <radialGradient id="nebula-blue" cx="65%" cy="55%" r="40%">
          <stop offset="0%" stop-color="rgba(107,197,255,0.02)" />
          <stop offset="100%" stop-color="rgba(107,197,255,0)" />
        </radialGradient>
      </defs>

      <!-- 背景渐变 / 星云靠 .kgv-svg 的 CSS 提供，不画 SVG rect，避免 viewBox 平移后露出黑边 -->
      <!--
      <rect x="0" y="0" width="800" height="600" fill="url(#kgv-bg-grad)" />
      <rect x="0" y="0" width="800" height="600" fill="url(#nebula-purple)" />
      <rect x="0" y="0" width="800" height="600" fill="url(#nebula-blue)" />
      -->

      <g class="kgv-stars">
        <circle v-for="(s, i) in stars" :key="'s' + i"
          :cx="s.x" :cy="s.y" :r="s.r"
          :fill="'rgba(255,255,255,' + s.opacity + ')'"
          :class="{ 'star-twinkle': s.twinkle }"
          :style="s.twinkle ? { '--tw-base': s.opacity, '--tw-dur': s.dur + 's', '--tw-delay': s.delay + 's' } : {}"
        />
      </g>

      <!-- 边 -->
      <g class="kgv-edges">
        <path v-for="(l, i) in edges" :key="'e' + i"
          :d="computeEdgePath(l.from, l.to, nodesById, l.type)"
          :stroke="edgeStyle(l.type).color"
          :stroke-width="edgeStyle(l.type).width"
          :stroke-dasharray="edgeStyle(l.type).dash"
          fill="none" stroke-linecap="round"
        />
      </g>

      <!-- 节点 -->
      <g class="kgv-nodes">
        <g v-for="n in nodes" :key="n.id"
          :transform="`translate(${n.x}, ${n.y})`"
          class="kgv-node"
          :class="[`kgv-node-${n.type}`, { selected: selectedId === n.id }]"
          @pointerdown="onNodePointerDown($event, n)"
        >
          <!-- 矩形地点节点 -->
          <g v-if="n.type === 'loc'">
            <rect
              :x="-nodeHalfWidth(n)" :y="-nodeHalfHeight(n)"
              :width="nodeHalfWidth(n) * 2" :height="nodeHalfHeight(n) * 2"
              rx="8" ry="8"
              :fill="`url(#${nodeGradientId(n)})`"
              stroke="rgba(122,162,255,0.45)" stroke-width="1.5"
            />
            <text :y="2" text-anchor="middle" class="kgv-node-icon">🗺</text>
            <text :y="nodeHalfHeight(n) + 13" text-anchor="middle" class="kgv-node-label kgv-label-loc">
              {{ n.name.length > 8 ? n.name.slice(0, 8) + '…' : n.name }}
            </text>
          </g>

          <!-- 玩家节点 -->
          <g v-else-if="n.type === 'player'">
            <circle :r="nodeRadius(n)" :fill="`url(#${nodeGradientId(n)})`"
              stroke="rgba(125,249,255,0.45)" stroke-width="1.8" />
            <g class="player-hexagram-wrap">
              <polygon :points="hexagramPath(nodeRadius(n))"
                fill="none" stroke="rgba(125,249,255,0.42)" stroke-width="1.2" class="player-hexagram" />
            </g>
            <text :y="nodeRadius(n) + 13" text-anchor="middle" class="kgv-node-label kgv-label-player">
              {{ n.name.length > 8 ? n.name.slice(0, 8) + '…' : n.name }}
            </text>
          </g>

          <!-- 角色节点 -->
          <g v-else-if="n.type === 'char'">
            <circle :r="nodeRadius(n)" :fill="`url(#${nodeGradientId(n)})`"
              stroke="rgba(200,162,255,0.5)" stroke-width="1.2" />
            <text :y="nodeRadius(n) + 12" text-anchor="middle" class="kgv-node-label kgv-label-char">
              {{ n.name.length > 8 ? n.name.slice(0, 8) + '…' : n.name }}
            </text>
          </g>

          <!-- 物品节点（菱形） -->
          <g v-else>
            <rect :x="-nodeHalfWidth(n)" :y="-nodeHalfHeight(n)"
              :width="nodeHalfWidth(n) * 2" :height="nodeHalfHeight(n) * 2"
              rx="2" ry="2"
              :fill="`url(#${nodeGradientId(n)})`"
              stroke="rgba(240,192,96,0.4)" stroke-width="0.8"
              transform="rotate(45)" />
            <text :y="nodeRadius(n) + 14" text-anchor="middle" class="kgv-node-label kgv-label-item">
              {{ n.name.length > 8 ? n.name.slice(0, 8) + '…' : n.name }}
            </text>
          </g>
        </g>
      </g>
    </svg>

    <!-- 左侧角色名册 -->
    <div v-if="!isMobile && rosterNodes.length" class="kgv-roster" :class="{ 'kgv-roster-fold': rosterCollapsed }">
      <div class="kgv-roster-head">
        <button class="kgv-roster-toggle" @click="rosterCollapsed = !rosterCollapsed"
          :title="rosterCollapsed ? '展开角色栏' : '收起角色栏'">
          {{ rosterCollapsed ? '▶' : '◀' }}
        </button>
        <span v-show="!rosterCollapsed">角色</span>
        <span v-show="!rosterCollapsed" class="kgv-roster-count">{{ rosterNodes.length }}</span>
      </div>
      <div v-show="!rosterCollapsed" class="kgv-roster-list">
        <div v-for="n in rosterNodes" :key="n.id"
          class="kgv-roster-item"
          :class="{ 'is-active': rosterActiveId === n.id, 'is-player': n.type === 'player' }"
          @click="focusOnNode(n.id, 1.6, true, false)"
        >
          <span class="kgv-roster-dot" :class="n.type"></span>
          <span class="kgv-roster-name">{{ n.name.length > 8 ? n.name.slice(0, 8) + '…' : n.name }}</span>
        </div>
      </div>
    </div>

    <!-- 手机版：角色按钮 + 底部抽屉 -->
    <button v-if="isMobile && rosterNodes.length" class="kgv-roster-mobile-btn"
      :class="{ 'is-raised': selectedNode }"
      @click="toggleMobileRoster">
      角色 {{ rosterNodes.length }}
    </button>
    <Transition name="kgv-roster-drawer">
      <div v-if="isMobile && rosterNodes.length && mobileRosterOpen" class="kgv-roster-h">
        <div v-for="n in rosterNodes" :key="n.id"
          class="kgv-roster-h-item"
          :class="{ 'is-active': rosterActiveId === n.id, 'is-player': n.type === 'player' }"
          @click="focusMobileRosterNode(n.id)"
        >
          <span class="kgv-roster-dot" :class="n.type"></span>
          <span class="kgv-roster-name">{{ n.name.length > 6 ? n.name.slice(0, 6) + '…' : n.name }}</span>
        </div>
      </div>
    </Transition>

    <!-- 左上操作栏 -->
    <div class="kgv-bar" :class="{ 'kgv-bar-mobile': isMobile }">
      <button class="kgv-bar-btn kgv-bar-btn-danger" title="清空" @click="emit('clear')">✕</button>
      <span class="kgv-bar-div">·</span>
      <button class="kgv-bar-btn" :class="{ 'kgv-bar-on': showItems, 'kgv-bar-off': !showItems }"
        title="显示/隐藏物品节点" @click="showItems = !showItems">📦</button>
      <button class="kgv-bar-btn" @click="zoomBy(1.2)" title="放大">+</button>
      <button class="kgv-bar-btn" @click="zoomBy(0.83)" title="缩小">−</button>
      <button class="kgv-bar-btn" @click="resetView" title="重置视图">⤾</button>
      <span class="kgv-bar-div">·</span>
      <span class="kgv-bar-stat">v{{ graphVersion }}</span>
      <span class="kgv-bar-div">·</span>
      <span class="kgv-bar-stat">{{ locCount }}区 {{ charCount }}角 {{ itemCount }}物 {{ edgeCount }}线</span>
      <span v-if="truncated" class="kgv-bar-warn">显示前{{ MAX_NODES }}个</span>
    </div>

    <!-- 图例（左下） -->
    <div class="kgv-legend" :class="{ 'kgv-legend-mobile': isMobile }">
      <span class="kgv-legend-item"><i class="kgv-dot loc"></i>地点</span>
      <span class="kgv-legend-item"><i class="kgv-dot char"></i>角色</span>
      <span class="kgv-legend-item"><i class="kgv-dot player"></i>玩家</span>
      <span v-if="showItems" class="kgv-legend-item"><i class="kgv-dot item"></i>物品</span>
      <span class="kgv-bar-div">·</span>
      <span class="kgv-legend-line wrap"><i></i>包含</span>
      <span class="kgv-legend-line conn"><i></i>连通</span>
      <span class="kgv-legend-line bto"><i></i>归属</span>
      <span class="kgv-legend-line loc2"><i></i>所在</span>
      <span class="kgv-legend-line int"><i></i>关系</span>
    </div>

    <!-- 详情面板（电脑右上 / 手机底部抽屉） -->
    <Transition name="kgv-slide">
      <div v-if="selectedNode" class="kgv-detail" :class="{ 'kgv-detail-mobile': isMobile }">
        <div class="kgv-detail-head">
          <span class="kgv-detail-type" :class="`kgv-detail-type-${selectedNode.type}`">{{ NODE_TYPE_LABELS[selectedNode.type] }}</span>
          <span class="kgv-detail-name">{{ selectedNode.name }}</span>
          <button class="kgv-detail-close" @click="selectedId = null">✕</button>
        </div>
        <div v-if="selectedNode.brief" class="kgv-detail-brief">{{ selectedNode.brief }}</div>
        <div class="kgv-detail-row kgv-detail-aliases-row">
          <span class="kgv-detail-label">别名</span>
          <template v-if="!isEditingAliases">
            <span class="kgv-aliases-text">{{ selectedNode.aliases?.length ? selectedNode.aliases.join('、') : '（无）' }}</span>
            <button class="kgv-aliases-edit-btn" title="编辑别名" @click="startEditAliases">✎</button>
          </template>
          <template v-else>
            <input
              v-model="editingAliases"
              class="kgv-aliases-input"
              placeholder="多个别名用 、 或逗号分隔"
              @keyup.enter="saveAliases"
              @keyup.esc="cancelEditAliases"
            />
            <button class="kgv-aliases-save-btn" title="保存" @click="saveAliases">✓</button>
            <button class="kgv-aliases-cancel-btn" title="取消" @click="cancelEditAliases">✕</button>
          </template>
        </div>

        <!-- 地点专属 -->
        <div v-if="selectedNode.type === 'loc'">
          <div v-if="selectedNode.level" class="kgv-detail-row">
            <span class="kgv-detail-label">层级</span> L{{ selectedNode.level }}
          </div>
          <div v-if="locChainNames.length > 1" class="kgv-detail-row kgv-detail-bread">
            <span class="kgv-detail-label">归属链</span>
            <span class="kgv-bread">{{ locChainNames.join(' › ') }}</span>
          </div>
          <div v-if="selectedNode.childrenCount" class="kgv-detail-row">
            <span class="kgv-detail-label">直接子地点</span> {{ selectedNode.childrenCount }}
          </div>
        </div>

        <!-- 角色/玩家专属 -->
        <div v-if="selectedNode.type === 'char' || selectedNode.type === 'player'">
          <div class="kgv-detail-row kgv-detail-loc-row">
            <span class="kgv-detail-label">当前所在</span>
            <template v-if="!isEditingLocation">
              <span class="kgv-loc-text">{{ selectedNode.currentLocationName || '（未知）' }}</span>
              <button class="kgv-loc-edit-btn" title="修改地点" @click="startEditLocation">✎</button>
            </template>
            <template v-else>
              <input
                v-model="editingLocation"
                class="kgv-loc-input"
                placeholder="输入地点名"
                @keyup.enter="saveLocation"
                @keyup.esc="cancelEditLocation"
              />
              <button class="kgv-loc-save-btn" title="保存" @click="saveLocation">✓</button>
              <button class="kgv-loc-cancel-btn" title="取消" @click="cancelEditLocation">✕</button>
            </template>
          </div>
          <div v-if="relatedCharacters.length" class="kgv-detail-links">
            <div class="kgv-detail-label">关联人物</div>
            <div v-for="(r, i) in relatedCharacters" :key="i" class="kgv-detail-link">
              {{ r.name }} <span v-if="r.label" class="kgv-detail-link-detail">（{{ r.label }}）</span>
            </div>
          </div>
          <!-- 合并到其他角色：仅 NPC 角色节点显示（玩家节点不合并） -->
          <button
            v-if="selectedNode.type === 'char'"
            class="kgv-detail-merge-btn"
            @click="emit('merge', selectedNode.name)"
            title="把这个角色合并到另一个角色，被合并者会变成主角色的别名"
          >⇄ 合并到其他角色…</button>
        </div>

        <!-- 通用：连线列表 -->
        <div v-if="selectedLinks.length" class="kgv-detail-links">
          <div class="kgv-detail-label">连线 {{ selectedLinks.length }} 条</div>
          <div v-for="(l, i) in selectedLinks" :key="i" class="kgv-detail-link">
            {{ l.from === selectedNode.id ? '→' : '←' }}
            {{ EDGE_TYPE_LABELS[l.type] }}
            {{ l.from === selectedNode.id
                ? (nodes.find(n => n.id === l.to)?.name || l.to)
                : (nodes.find(n => n.id === l.from)?.name || l.from) }}
            <span v-if="l.label" class="kgv-detail-link-detail">（{{ l.label }}）</span>
            <span v-else-if="l.detail" class="kgv-detail-link-detail">（{{ l.detail }}）</span>
          </div>
        </div>
      </div>
    </Transition>

    <div v-if="nodes.length === 0" class="kgv-empty">暂无图谱数据</div>
  </div>
</template>

<style scoped>
.kgv-wrap {
  position: relative; flex: 1; min-height: 280px;
  background:
    radial-gradient(ellipse at 30% 35%, rgba(139,108,255,0.04) 0%, transparent 55%),
    radial-gradient(ellipse at 68% 60%, rgba(107,197,255,0.035) 0%, transparent 50%),
    radial-gradient(ellipse at 45% 25%, rgba(125,249,255,0.03) 0%, transparent 45%),
    linear-gradient(180deg, #05060a 0%, #0b0f1c 100%);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  overflow: hidden; display: flex;
}
.kgv-svg {
  width: 100%; height: 100%; cursor: grab; touch-action: none; display: block;
  background:
    radial-gradient(ellipse at 30% 35%, rgba(139,108,255,0.04) 0%, transparent 55%),
    radial-gradient(ellipse at 68% 60%, rgba(107,197,255,0.035) 0%, transparent 50%),
    radial-gradient(ellipse at 45% 25%, rgba(125,249,255,0.03) 0%, transparent 45%),
    linear-gradient(180deg, #05060a 0%, #0b0f1c 100%);
}
.kgv-svg:active { cursor: grabbing; }

/* ── 节点 ── */
.kgv-node { cursor: pointer; }
/* 悬停反馈：标签变亮 + 形状加亮描边，仅视觉提示可点击，不显示信息面板 */
.kgv-node:hover .kgv-node-label { fill: rgba(255,255,255,0.95); }
.kgv-node:hover rect, .kgv-node:hover circle:first-of-type {
  stroke: rgba(255,255,255,0.55) !important;
}
/* 不能给 SVG <g> 设 CSS transform：会覆盖 SVG transform="translate(x,y)" 导致节点跳到原点。 */
.kgv-node.selected .kgv-node-label { fill: rgba(255,255,255,0.95); }
.kgv-node.selected rect, .kgv-node.selected circle:first-of-type {
  stroke: rgba(255, 255, 255, 0.78) !important;
  stroke-width: 2.4 !important;
}

/* 节点底色遮罩：visually 把边压在节点下的部分遮挡掉 */
.kgv-node rect, .kgv-node circle:first-of-type { paint-order: fill; }

.kgv-node-icon { font-size: 14px; pointer-events: none; user-select: none; fill: rgba(255,255,255,0.9); }
.kgv-node-label {
  fill: rgba(255, 255, 255, 0.72); font-size: 11.5px;
  pointer-events: none; user-select: none;
  paint-order: stroke; stroke: rgba(5, 6, 10, 0.78); stroke-width: 2.8;
}
.kgv-label-loc { font-size: 11.5px; fill: rgba(189, 211, 255, 0.92); font-weight: 500; }
.kgv-label-char { font-size: 10.5px; fill: rgba(220, 185, 255, 0.9); }
.kgv-label-player { font-size: 11px; fill: rgba(165, 249, 255, 0.95); font-weight: 600; }
.kgv-label-item { font-size: 10px; fill: rgba(255, 230, 160, 0.88); }

/* ── 边 ── */

/* ── 玩家六芒星动画 ── */
.player-hexagram-wrap { pointer-events: none; transform-origin: 0 0; animation: hexSpin 20s linear infinite; }
.player-hexagram { animation: playerPulse 2.5s ease-in-out infinite; }
@keyframes hexSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes playerPulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.85; } }

/* ── 星尘闪烁 ── */
.star-twinkle { animation: starTwinkle var(--tw-dur, 3s) ease-in-out infinite; animation-delay: var(--tw-delay, 0s); }
@keyframes starTwinkle {
  0%, 100% { opacity: var(--tw-base, 0.3); }
  35% { opacity: 1; }
  70% { opacity: calc(var(--tw-base, 0.3) * 1.6); }
}

/* ── 左侧角色名册 ── */
.kgv-roster {
  position: absolute; left: 8px; top: 44px; bottom: 44px;
  width: 160px;
  display: flex; flex-direction: column;
  background: rgba(8, 10, 18, 0.93);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 8px;
  overflow: hidden;
  z-index: 5;
}
.kgv-roster-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 12px;
  font-size: 11px; color: rgba(255, 255, 255, 0.42);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  flex-shrink: 0;
  letter-spacing: 0.5px;
}
.kgv-roster-fold .kgv-roster-head {
  border-bottom: none; padding: 8px 6px; justify-content: center;
}
.kgv-roster-toggle {
  background: none; border: none; color: rgba(255,255,255,0.35); cursor: pointer;
  font-size: 11px; padding: 2px 4px; border-radius: 3px; line-height: 1;
  transition: color 0.15s;
}
.kgv-roster-toggle:hover { color: rgba(255,255,255,0.7); }
.kgv-roster-fold { width: 32px; min-width: 32px; }
.kgv-roster-count {
  font-family: var(--zn-font-mono, monospace);
  color: rgba(255, 255, 255, 0.3);
}
.kgv-roster-list {
  flex: 1; min-height: 0; overflow-y: auto; padding: 4px 6px 8px;
}
.kgv-roster-list::-webkit-scrollbar { width: 5px; }
.kgv-roster-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
.kgv-roster-item {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; margin: 1px 0;
  border-radius: 5px;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.66);
  font-size: 11.5px;
  transition: background 0.15s, color 0.15s;
  position: relative;
  word-break: break-all;
}
.kgv-roster-item:hover { background: rgba(255, 255, 255, 0.06); color: rgba(255, 255, 255, 0.85); }
.kgv-roster-item.is-active {
  background: rgba(122, 162, 255, 0.18);
  color: rgba(255, 255, 255, 0.95);
  box-shadow: inset 2px 0 0 #7aa2ff;
}
.kgv-roster-item.is-player.is-active { box-shadow: inset 2px 0 0 #7df9ff; }
.kgv-roster-item.is-player { color: rgba(165, 249, 255, 0.92); font-weight: 500; }
.kgv-roster-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.kgv-roster-dot.player { background: #7df9ff; border-radius: 2px; }
.kgv-roster-dot.char { background: #c8a2ff; }
.kgv-roster-name { flex: 1; min-width: 0; }

/* 手机版：角色按钮 + 底部抽屉 */
.kgv-roster-mobile-btn {
  position: absolute; right: 8px; bottom: 42px; z-index: 6;
  height: 28px; padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 15px;
  background: rgba(8, 10, 18, 0.92);
  color: rgba(255, 255, 255, 0.72);
  font-size: 11px;
  cursor: pointer;
}
.kgv-roster-mobile-btn.is-raised { bottom: calc(50% + 8px); }
.kgv-roster-h {
  position: absolute; left: 8px; right: 8px; bottom: 42px;
  display: flex; gap: 6px; overflow-x: auto;
  padding: 6px 8px;
  background: rgba(8, 10, 18, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  z-index: 7;
}
.kgv-roster-h::-webkit-scrollbar { height: 4px; }
.kgv-roster-h::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
.kgv-roster-h-item {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 9px; flex-shrink: 0;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.62);
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.kgv-roster-h-item:hover { background: rgba(255, 255, 255, 0.1); }
.kgv-roster-h-item.is-active {
  background: rgba(122, 162, 255, 0.22);
  color: rgba(255, 255, 255, 0.95);
}
.kgv-roster-h-item.is-player { color: rgba(165, 249, 255, 0.95); }
.kgv-roster-drawer-enter-active, .kgv-roster-drawer-leave-active { transition: transform 0.18s ease, opacity 0.18s ease; }
.kgv-roster-drawer-enter-from, .kgv-roster-drawer-leave-to { transform: translateY(10px); opacity: 0; }

/* ── 操作栏 ── */
.kgv-bar {
  position: absolute; top: 7px; left: 8px;
  display: flex; align-items: center; gap: 3px;
  background: rgba(8, 10, 18, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 6px;
  padding: 3px 7px;
  flex-wrap: wrap; max-width: calc(100% - 16px);
}
.kgv-bar-mobile { gap: 1px; padding: 4px 6px; }
.kgv-bar-btn {
  width: 22px; height: 22px;
  border: none; background: transparent;
  color: rgba(255, 255, 255, 0.42); font-size: 13px; cursor: pointer;
  border-radius: 4px;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s, color 0.15s;
}
.kgv-bar-mobile .kgv-bar-btn { width: 28px; height: 28px; font-size: 15px; }
.kgv-bar-btn:hover { background: rgba(122, 162, 255, 0.12); color: rgba(122, 162, 255, 0.85); }
.kgv-bar-btn:active { transform: scale(0.92); }
.kgv-bar-btn-danger:hover { background: rgba(248, 113, 113, 0.18); color: rgba(248, 130, 130, 0.95); }
.kgv-bar-on { color: rgba(240, 192, 96, 0.9); background: rgba(240, 192, 96, 0.08); }
.kgv-bar-off { color: rgba(255, 255, 255, 0.22); }
.kgv-bar-div { color: rgba(255, 255, 255, 0.12); font-size: 10px; margin: 0 2px; user-select: none; }
.kgv-bar-stat { font-family: var(--zn-font-mono, monospace); font-size: 9.5px; color: rgba(255, 255, 255, 0.3); }
.kgv-bar-warn { font-size: 9px; color: rgba(240, 176, 96, 0.5); margin-left: 4px; }

/* ── 图例 ── */
.kgv-legend {
  position: absolute; bottom: 7px; left: 8px;
  display: flex; align-items: center; gap: 4px;
  background: rgba(8, 10, 18, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  padding: 3px 7px;
  font-size: 9.5px; color: rgba(255, 255, 255, 0.42);
  flex-wrap: wrap; max-width: calc(60% - 8px);
}
.kgv-legend-mobile { max-width: calc(100% - 16px); font-size: 9px; }
.kgv-legend-item { display: flex; align-items: center; gap: 3px; white-space: nowrap; }
.kgv-legend-line { display: flex; align-items: center; gap: 3px; white-space: nowrap; }
.kgv-legend-line i { display: inline-block; width: 12px; height: 0; border-top: 1.5px solid; }
.kgv-legend-line.wrap i { border-color: rgba(122,162,255,0.7); }
.kgv-legend-line.conn i { border-color: rgba(120,220,160,0.7); border-top-style: dashed; }
.kgv-legend-line.bto i { border-color: rgba(240,180,80,0.7); border-top-style: dashed; }
.kgv-legend-line.loc2 i { border-color: rgba(180,140,255,0.7); }
.kgv-legend-line.int i { border-color: rgba(160,120,255,0.7); }
.kgv-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.kgv-dot.loc { background: #7aa2ff; }
.kgv-dot.char { background: #c8a2ff; }
.kgv-dot.player { background: #7df9ff; border-radius: 2px; }
.kgv-dot.item { background: #f0c060; transform: rotate(45deg); }

/* ── 详情面板 ── */
.kgv-detail {
  position: absolute; top: 40px; right: 10px;
  width: 240px; max-width: 80%; max-height: 70%;
  overflow-y: auto;
  background: rgba(12, 14, 24, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 11px; color: rgba(255, 255, 255, 0.76);
}
.kgv-detail-mobile {
  top: auto; bottom: 0; right: 0; left: 0;
  width: 100%; max-width: 100%; max-height: 50%;
  border-radius: 12px 12px 0 0;
  padding: 12px 14px 18px;
  border-left: none; border-right: none; border-bottom: none;
}
.kgv-detail-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.kgv-detail-type { font-size: 9px; padding: 1px 6px; border-radius: 3px; color: #fff; }
.kgv-detail-type-loc { background: #7aa2ff; }
.kgv-detail-type-char { background: #c8a2ff; }
.kgv-detail-type-player { background: #7df9ff; color: #05060a; }
.kgv-detail-type-item { background: #f0c060; color: #05060a; }
.kgv-detail-name { font-weight: 600; flex: 1; word-break: break-all; }
.kgv-detail-close { background: none; border: none; color: rgba(255, 255, 255, 0.3); cursor: pointer; font-size: 13px; padding: 0; }
.kgv-detail-close:hover { color: rgba(255, 255, 255, 0.7); }

/* 合并到其他角色按钮（角色节点详情面板） */
.kgv-detail-merge-btn {
  margin-top: 10px;
  padding: 6px 10px;
  background: rgba(139, 108, 255, 0.14);
  border: 1px solid rgba(139, 108, 255, 0.35);
  border-radius: 6px;
  color: #c4b5fd;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s, transform 0.08s;
  width: 100%;
  text-align: left;
}
.kgv-detail-merge-btn:hover {
  background: rgba(139, 108, 255, 0.28);
  border-color: rgba(139, 108, 255, 0.6);
  color: #fff;
}
.kgv-detail-merge-btn:active { transform: scale(0.96); }

/* 别名内联编辑 */
.kgv-detail-aliases-row {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
}
.kgv-aliases-text { color: rgba(255,255,255,0.78); }
.kgv-aliases-edit-btn,
.kgv-aliases-save-btn,
.kgv-aliases-cancel-btn {
  background: none; border: none; cursor: pointer;
  padding: 0 4px; font-size: 12px; line-height: 1;
  transition: color 0.15s, transform 0.08s;
}
.kgv-aliases-edit-btn { color: rgba(255,255,255,0.4); }
.kgv-aliases-edit-btn:hover { color: #c4b5fd; }
.kgv-aliases-save-btn { color: #86efac; }
.kgv-aliases-save-btn:hover { color: #fff; }
.kgv-aliases-cancel-btn { color: rgba(248,113,113,0.7); }
.kgv-aliases-cancel-btn:hover { color: #fff; }
.kgv-aliases-save-btn:active, .kgv-aliases-cancel-btn:active, .kgv-aliases-edit-btn:active { transform: scale(0.92); }
.kgv-aliases-input {
  flex: 1; min-width: 0;
  background: rgba(255,255,255,0.06); color: #fff;
  border: 1px solid rgba(139,108,255,0.4); border-radius: 4px;
  padding: 3px 6px; font-size: 12px; outline: none;
}
.kgv-aliases-input:focus { border-color: rgba(139,108,255,0.7); }

/* 角色地点内联编辑（复用别名编辑风格） */
.kgv-detail-loc-row {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
}
.kgv-loc-text { color: rgba(255,255,255,0.78); }
.kgv-loc-edit-btn,
.kgv-loc-save-btn,
.kgv-loc-cancel-btn {
  background: none; border: none; cursor: pointer;
  padding: 0 4px; font-size: 12px; line-height: 1;
  transition: color 0.15s, transform 0.08s;
}
.kgv-loc-edit-btn { color: rgba(255,255,255,0.4); }
.kgv-loc-edit-btn:hover { color: #c4b5fd; }
.kgv-loc-save-btn { color: #86efac; }
.kgv-loc-save-btn:hover { color: #fff; }
.kgv-loc-cancel-btn { color: rgba(248,113,113,0.7); }
.kgv-loc-cancel-btn:hover { color: #fff; }
.kgv-loc-save-btn:active, .kgv-loc-cancel-btn:active, .kgv-loc-edit-btn:active { transform: scale(0.92); }
.kgv-loc-input {
  flex: 1; min-width: 0;
  background: rgba(255,255,255,0.06); color: #fff;
  border: 1px solid rgba(139,108,255,0.4); border-radius: 4px;
  padding: 3px 6px; font-size: 12px; outline: none;
}
.kgv-loc-input:focus { border-color: rgba(139,108,255,0.7); }
.kgv-detail-brief { color: rgba(255, 255, 255, 0.6); line-height: 1.5; margin-bottom: 6px; }
.kgv-detail-row { display: flex; gap: 4px; color: rgba(255, 255, 255, 0.55); margin-bottom: 4px; }
.kgv-detail-row.kgv-detail-bread { align-items: flex-start; flex-direction: column; gap: 2px; }
.kgv-bread { color: rgba(180, 200, 255, 0.72); font-size: 10.5px; word-break: break-all; }
.kgv-detail-label { color: rgba(255, 255, 255, 0.32); flex-shrink: 0; }
.kgv-detail-links { margin-top: 6px; }
.kgv-detail-link { color: rgba(255, 255, 255, 0.56); padding: 2px 0; font-size: 10.5px; }
.kgv-detail-link-detail { color: rgba(255, 255, 255, 0.32); }

/* 详情面板过场动画 */
.kgv-slide-enter-active, .kgv-slide-leave-active { transition: transform 0.22s ease, opacity 0.22s ease; }
.kgv-slide-enter-from, .kgv-slide-leave-to { transform: translateX(20px); opacity: 0; }
.kgv-detail-mobile.kgv-slide-enter-from, .kgv-detail-mobile.kgv-slide-leave-to { transform: translateY(40px); opacity: 0; }

/* ── 空状态 ── */
.kgv-empty {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  color: rgba(255, 255, 255, 0.16); font-size: 12px;
  pointer-events: none;
}
</style>
