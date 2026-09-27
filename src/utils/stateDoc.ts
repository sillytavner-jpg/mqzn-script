/**
 * 智脑状态文档 —— Patch 化输出的协议层与执行器
 * （P0 基础设施，不碰任何现有写入逻辑）
 *
 * ── 它解决什么 ──
 * 智脑 10 个分析模块原本各写各的容器（chatData 里 20+ 个并列字段），
 * AI 每轮重写整个对象。改成 patch 后，AI 只输出「哪些路径变了、变成什么」，
 * 由本模块统一执行。
 *
 * ── 为什么需要「统一命名空间」 ──
 * AI 看到的是一个统一状态文档（/world/time、/graph/item/xxx、/cast/江念/memory），
 * 但存储层其实仍是各写各的分片 —— 路由表负责把路径前缀映射到真正的写入器。
 * 这样就不必合并物理存储（避开大重构、并发锁、老数据迁移三重风险）。
 *
 * ── 协议：只对 AI 暴露两个 op ──
 *   set —— upsert：不存在则建、存在则替换（合并了 RFC 6902 的 add + replace）
 *   del —— 删除
 * 不给标准三件套，因为 RFC 里 replace 要求路径已存在、add 要求父路径已存在，
 * 而 **AI 判断不了存在性** —— 少一个判断维度就少一类失败。
 * 执行器内部仍兼容 AI 写成 add/replace/remove（统一映射到 set/del）。
 *
 * ── 执行风格：逐条容错 ──
 * 某条坏了只记 skipped，不影响其余条目。
 * 相比「全量 JSON 一截断就全废」，patch 即使被截断，前面的条目依然生效。
 *
 * ── 用法（P1 起）──
 * ```ts
 * const result = applyStatePatch(ops, { chatData, moduleName: 'small_summary', notes });
 * ```
 * 路由实现由各阶段陆续注册（见 registerRoute）；未实现的路由会被安全跳过。
 */

// ========== 类型 ==========

/** webpack 环境下 `require` 由运行时提供（项目未装 @types/node） */
declare const require: (id: string) => any;

/** 归一的 op 词汇 */
export type PatchOpKind = 'set' | 'del';

/** AI 原样输出的单条补丁 */
export interface PatchOp {
  op: string;
  path: string;
  value?: unknown;
}

/** 执行上下文 */
export interface ApplyContext {
  /** pinia 的 chatData（响应式对象，已 unwrap） */
  chatData: any;
  /** 来源模块名，写审计用 */
  moduleName: string;
  /** 来源楼层区间，写审计用 */
  floorRange?: { start: number; end: number };
  /** AI 的人话层说明（notes），写审计用 */
  notes?: string;
}

/** 执行结果 */
export interface ApplyResult {
  /** 成功执行的条数 */
  applied: number;
  /** 被跳过的条目 + 原因（**可观测性核心**：调试时一眼看出哪些没落上） */
  skipped: Array<{ op: PatchOp; reason: string }>;
  /** 实际变更的路径 */
  touched: string[];
  /** 新建的实体路径 */
  created: string[];
}

/**
 * 路由：把某个路径前缀映射到真正的写入器。
 * 各阶段（P1~P4）按模块陆续实现并注册。
 */
export interface Route {
  /** 前缀，如 '/graph/item'（不含尾斜杠） */
  prefix: string;
  /** label 仅供日志/调试 */
  label: string;
  /** 前缀占用的路径段数（'/graph/item' → 2），剩余段作为 sub 传给 handler */
  depth: number;
  /** upsert 写入 */
  set(sub: string[], value: unknown, ctx: ApplyContext, result: ApplyResult): void;
  /** 删除 */
  del(sub: string[], ctx: ApplyContext): void;
}

/** 审计日志条目 */
export interface StateAuditEntry {
  at: string;
  module: string;
  floorRange?: { start: number; end: number };
  applied: number;
  skippedCount: number;
  /** 跳过原因摘要（最多 5 条，避免撑爆存储） */
  skipReasons: string[];
  touched: string[];
  created: string[];
  /** AI 的人话层说明（面向「一眼看出改了什么」） */
  notes?: string;
}

// ========== 常量 ==========

/** 单轮最多执行多少条 op（超出截断并告警） */
export const MAX_OPS = 40;

/** 审计日志保留条数 */
export const MAX_AUDIT_ENTRIES = 200;

/**
 * 统一命名空间清单。
 * 这份表也是 P1+ 生成 prompt「路径对照表」的来源（中文名 → 英文 key）。
 */
export const STATE_NAMESPACES: Array<{ path: string; label: string; writer: string }> = [
  { path: '/world/',              label: '世界标量状态（时间/地点/在场）', writer: '小总结 · 世界推进' },
  { path: '/graph/loc/',          label: '地点节点',                     writer: '小总结' },
  { path: '/graph/item/',         label: '物品节点',                     writer: '小总结' },
  { path: '/graph/char/',         label: '人物节点',                     writer: '小总结' },
  { path: '/graph/edge/',         label: '地点关系边',                   writer: '小总结' },
  { path: '/cast/',               label: '角色档案（memory/profile/dynamic/factual）', writer: '多模块' },
  { path: '/rel/',                label: '关系档案',                     writer: '关系分析' },
  { path: '/timeline/',           label: '时间线事件',                   writer: '大总结' },
  { path: '/recap/',              label: '大总结叙事段',                 writer: '大总结' },
  { path: '/director/',           label: '剧情导演',                     writer: '剧情导演' },
  { path: '/dream/',              label: '梦呓',                         writer: '梦呓' },
  { path: '/persona/',            label: '用户人格',                     writer: '用户人格' },
];

/**
 * 路径别名 —— 容忍 AI 的常见错写。
 * 用 `*` 匹配任意一段（实体段），`~` 段本身不能是别名目标。
 * 规则：**先做整条路径的模式匹配**，命中就替换成标准写法。
 */
const PATH_ALIASES: Array<{ pattern: string[]; target: string[] }> = [
  // 世界标量
  { pattern: ['world', '地点'],        target: ['world', 'place'] },
  { pattern: ['world', 'location'],    target: ['world', 'place'] },
  { pattern: ['world', 'address'],     target: ['world', 'place'] },
  { pattern: ['world', '时间'],        target: ['world', 'time'] },
  { pattern: ['world', 'currentTime'], target: ['world', 'time'] },
  { pattern: ['world', 'date'],        target: ['world', 'time'] },
  // 角色档案子字段
  { pattern: ['cast', '*', 'memories'],  target: ['cast', '*', 'memory'] },
  { pattern: ['cast', '*', '记忆'],      target: ['cast', '*', 'memory'] },
  { pattern: ['cast', '*', '小传'],      target: ['cast', '*', 'profile'] },
  { pattern: ['cast', '*', '动态人设'],   target: ['cast', '*', 'dynamic'] },
  { pattern: ['cast', '*', '事实状态'],   target: ['cast', '*', 'factual'] },
  // 图谱
  { pattern: ['graph', 'locations'],   target: ['graph', 'loc'] },
  { pattern: ['graph', 'items'],       target: ['graph', 'item'] },
  { pattern: ['graph', 'characters'],  target: ['graph', 'char'] },
  { pattern: ['graph', 'edges'],       target: ['graph', 'edge'] },
  { pattern: ['graph', '地点'],         target: ['graph', 'loc'] },
  { pattern: ['graph', '物品'],         target: ['graph', 'item'] },
  { pattern: ['graph', '人物'],         target: ['graph', 'char'] },
];

// ========== 归一 ==========

/**
 * op 词汇归一。
 * 兼容 AI 写成标准 RFC 6902 的三件套：
 *   add / replace  → set
 *   remove         → del
 * move / copy / test 一律不支持（不返回，交由调用方记 skipped）。
 */
export function normalizeOpKind(raw: string): PatchOpKind | null {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'set' || v === 'add' || v === 'replace') return 'set';
  if (v === 'del' || v === 'delete' || v === 'remove') return 'del';
  return null;
}

/**
 * JSON Pointer 转义解码：`~1` → `/`，`~0` → `~`（RFC 6901，注意顺序）
 */
function unescapePointerSegment(seg: string): string {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * 路径归一：拆段 → 反转义 → 别名替换。
 *
 * 接受 `/world/time` 也可接受不带前导斜杠的 `world/time`。
 * 返回 null 表示路径非法（空、只有根、段数超限）。
 */
export function normalizePath(raw: string): string[] | null {
  const text = String(raw || '').trim();
  if (!text) return null;

  const segments = text
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(unescapePointerSegment);

  if (segments.length === 0) return null;
  if (segments.length > 4) return null; // 深度 ≤ 4 段（越深越容易写错、越费 token）

  return applyAlias(segments);
}

/** 整条路径的模式匹配别名替换（`*` 匹配任意一段） */
function applyAlias(segments: string[]): string[] {
  for (const rule of PATH_ALIASES) {
    if (rule.pattern.length !== segments.length) continue;
    let hit = true;
    for (let i = 0; i < rule.pattern.length; i++) {
      const p = rule.pattern[i];
      if (p === '*') continue;
      if (p !== segments[i]) { hit = false; break; }
    }
    if (!hit) continue;

    // 命中：保留 `*` 位置上的原值
    return rule.target.map((t, i) => (t === '*' ? segments[i] : t));
  }
  return segments;
}

/** 段数组还原成可读路径 */
export function pathToString(segments: string[]): string {
  return '/' + segments.join('/');
}

// ========== 路由 ==========

/** 未实现的路由占位原因（会被记进 skipped，不污染存储） */
export const NOT_IMPLEMENTED = '路由尚未实现（P0 只搭骨架）';

/**
 * 内置路由表 —— **P0 只搭骨架，handler 留空**。
 * 各阶段用 registerRoute 覆盖成真实实现（P1 图谱、P2 角色档案、P3 叙事流…）。
 * 骨架阶段调用会抛错 → 被 applyStatePatch 逐条捕获进 skipped，不会崩。
 */
function placeholderRoute(prefix: string, label: string): Route {
  const depth = prefix.split('/').filter(Boolean).length;
  const notYet = () => { throw new Error(NOT_IMPLEMENTED); };
  return { prefix, label, depth, set: notYet, del: notYet };
}

const routes: Route[] = [
  placeholderRoute('/world', '世界标量状态'),
  placeholderRoute('/graph/loc', '地点节点'),
  placeholderRoute('/graph/item', '物品节点'),
  placeholderRoute('/graph/char', '人物节点'),
  placeholderRoute('/graph/edge', '地点关系边'),
  placeholderRoute('/cast', '角色档案'),
  placeholderRoute('/rel', '关系档案'),
  placeholderRoute('/timeline', '时间线事件'),
  placeholderRoute('/recap', '大总结叙事段'),
  placeholderRoute('/director', '剧情导演'),
  placeholderRoute('/dream', '梦呓'),
  placeholderRoute('/persona', '用户人格'),
];

/** 注册（或覆盖）一条路由。前缀长的优先匹配，所以注册顺序不敏感。 */
export function registerRoute(route: Route): void {
  const idx = routes.findIndex((r) => r.prefix === route.prefix);
  if (idx >= 0) routes[idx] = route;
  else routes.push(route);
}

/** 供测试/调试读取当前路由表 */
export function getRoutes(): Route[] {
  return routes;
}

/** 按前缀匹配路由（最长前缀优先） */
export function matchRoute(segments: string[], table: Route[] = routes): Route | undefined {
  let best: Route | undefined;
  for (const r of table) {
    if (r.depth > segments.length) continue;
    let ok = true;
    for (let i = 0; i < r.depth; i++) {
      if (r.prefix.split('/').filter(Boolean)[i] !== segments[i]) { ok = false; break; }
    }
    if (!ok) continue;
    if (!best || r.depth > best.depth) best = r;
  }
  return best;
}

// ========== 执行 ==========

/**
 * 执行一批 patch。
 *
 * 全程同步（不 await）—— 在 JS 单线程里天然原子，不会与其它模块交错。
 * 逐条 try/catch：任何一条失败只记 skipped，其余照常执行。
 *
 * @param ops    AI 输出的补丁数组
 * @param ctx    执行上下文（至少要有 chatData 和 moduleName）
 * @param table  路由表（默认用内置的；测试可注入 mock）
 */
export function applyStatePatch(
  ops: PatchOp[],
  ctx: ApplyContext,
  table?: Route[],
): ApplyResult {
  const result: ApplyResult = { applied: 0, skipped: [], touched: [], created: [] };

  const list = Array.isArray(ops) ? ops : [];
  if (list.length > MAX_OPS) {
    result.skipped.push({
      op: { op: '?', path: '?' },
      reason: `ops 数量 ${list.length} 超过上限 ${MAX_OPS}，已截断`,
    });
  }

  for (const raw of list.slice(0, MAX_OPS)) {
    if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string') {
      result.skipped.push({ op: raw as PatchOp, reason: '条目结构非法（缺 path）' });
      continue;
    }

    try {
      const kind = normalizeOpKind(raw.op);
      if (!kind) {
        result.skipped.push({ op: raw, reason: `不支持的 op: ${raw.op}` });
        continue;
      }

      const segments = normalizePath(raw.path);
      if (!segments) {
        result.skipped.push({ op: raw, reason: `路径非法: ${raw.path}` });
        continue;
      }

      const route = matchRoute(segments, table);
      if (!route) {
        result.skipped.push({ op: raw, reason: `路径不在白名单: ${pathToString(segments)}` });
        continue;
      }

      const sub = segments.slice(route.depth);

      if (kind === 'del') {
        route.del(sub, ctx);
      } else {
        route.set(sub, raw.value, ctx, result);
      }

      result.applied++;
      result.touched.push(pathToString(segments));
    } catch (e) {
      result.skipped.push({ op: raw, reason: (e as Error)?.message || String(e) });
    }
  }

  writeAudit(ctx, result);
  return result;
}

// ========== 审计 ==========

/**
 * 简化审计入口 —— 不走 applyStatePatch 的模块（例如小总结用 bridge 直接翻译成 diff）
 * 也能把「本轮改了什么」留痕，供面板/日志展示。
 */
export function writeAuditEntry(
  chatData: any,
  entry: Partial<StateAuditEntry> & { module: string },
): void {
  try {
    if (!chatData) return;
    if (!Array.isArray(chatData.stateAuditLog)) chatData.stateAuditLog = [];

    const full: StateAuditEntry = {
      at: new Date().toISOString(),
      module: entry.module,
      floorRange: entry.floorRange,
      applied: entry.applied ?? 0,
      skippedCount: entry.skippedCount ?? 0,
      skipReasons: entry.skipReasons ?? [],
      touched: entry.touched ?? [],
      created: entry.created ?? [],
      notes: entry.notes,
    };

    chatData.stateAuditLog.push(full);
    if (chatData.stateAuditLog.length > MAX_AUDIT_ENTRIES) {
      chatData.stateAuditLog.splice(0, chatData.stateAuditLog.length - MAX_AUDIT_ENTRIES);
    }
  } catch {
    // 审计失败绝不能影响主流程
  }
}

/**
 * 把一轮 applyStatePatch 的结果追加进 chatData.stateAuditLog。
 * 这是「好调试」目标的落地载体 —— 面板可直接渲染 notes + touched。
 */
export function writeAudit(ctx: ApplyContext, result: ApplyResult): void {
  writeAuditEntry(ctx.chatData, {
    module: ctx.moduleName || 'unknown',
    floorRange: ctx.floorRange,
    applied: result.applied,
    skippedCount: result.skipped.length,
    skipReasons: result.skipped.slice(0, 5).map((s) => s.reason),
    touched: result.touched.slice(0, MAX_OPS),
    created: result.created.slice(0, MAX_OPS),
    notes: ctx.notes,
  });
}

// ========== 诊断上报（「出问题能不能被发现」的答案） ==========

/** 一次 patch 解析/执行的诊断摘要 */
export interface PatchDiag {
  /** 成功应用的条目数 */
  applied?: number;
  /** 被丢弃的条目数 */
  skipped?: number;
  /** 丢弃原因（最多 5 条） */
  reasons?: string[];
  /** 输出是否被截断过（parsePatchArray.repaired） */
  repaired?: boolean;
  /** 人话层说明 */
  notes?: string;
}

/**
 * 各模块在 patch 分支里调用它上报诊断。
 *
 * ── 为什么要它 ──
 * patch 模式最怕的是「**静默漏记**」：AI 少写了一条、路径写错了、输出被截断，
 * 而代码安安静静地继续跑 —— 事后根本看不出这一轮丢了东西。
 *
 * 所以每次解析都留一条痕：修过没有、丢了几条、为什么丢。
 * 正常的轮次（repaired=false 且没丢条目）**不写审计**，避免刷屏；
 * 只有出现过异常才落一条，面板就能提示「这几轮有 patch 被丢弃」。
 *
 * 惰性读 store 拿 chatData（避免与 mainStore 形成循环依赖）。
 */
export function reportPatchDiag(module: string, diag: PatchDiag): void {
  const hasIssue = diag.repaired === true || (diag.skipped ?? 0) > 0 || (diag.reasons?.length ?? 0) > 0;
  if (!hasIssue) return;   // 一切正常就不留痕

  try {
    let chatData: any = null;
    try {
      const mod = require('../stores/mainStore');
      const store = mod.useMainStore ? mod.useMainStore() : null;
      chatData = store?.chatData ?? null;
    } catch { /* ignore */ }
    if (!chatData) return;

    writeAuditEntry(chatData, {
      module,
      applied: diag.applied ?? 0,
      skippedCount: diag.skipped ?? diag.reasons?.length ?? 0,
      skipReasons: [
        ...(diag.repaired ? ['⚠️ 输出曾被截断，已修复'] : []),
        ...(diag.reasons || []).slice(0, 5),
      ],
      touched: [],
      created: [],
      notes: diag.notes,
    });
  } catch { /* 诊断失败不影响主流程 */ }
}

/**
 * 读取「最近一小时的 patch 异常」条目（供面板展示）。
 * 只返回带 skipReasons 的条目 —— 也就是出过问题的那些轮次。
 */
export function getRecentPatchIssues(chatData: any, withinMs = 3600_000): StateAuditEntry[] {
  const log = getAuditLog(chatData);
  const since = Date.now() - withinMs;
  return log
    .filter((e) => Array.isArray(e.skipReasons) && e.skipReasons.length > 0)
    .filter((e) => {
      const t = Date.parse(e.at);
      return Number.isFinite(t) ? t >= since : true;
    })
    .slice(-20);
}

/** 读取审计日志（缺字段时返回空数组） */
export function getAuditLog(chatData: any): StateAuditEntry[] {
  const v = chatData?.stateAuditLog;
  return Array.isArray(v) ? v : [];
}

// ========== 宽容解析（「防掉格式」的落地） ==========

export interface LenientParseResult {
  ops: PatchOp[];
  /** 是否经过了修复（= 原始输出被截断/写坏） */
  repaired: boolean;
}

/**
 * 宽容解析 patch 数组。
 *
 * ── 为什么需要它 ──
 * 这是 patch 化**比省 token 更重要的价值**：防掉格式。
 * 全量 JSON 是**一个大对象**，输出一旦被 max_tokens 截断或写坏 → 整批报废；
 * 而 patch 是**数组**，每个元素都是独立的 `{...}`，
 * 所以「截断到最后一个完整的 `}` 再补上 `]`」就能把前面的条目**全部救回来**。
 *
 * 三层策略：
 *   ① 直接 JSON.parse
 *   ② 截断修复：切到最后一个完整 `}`，补 `]`
 *   ③ 单个对象被截断成 `[{...` 的情况：先补 `}` 再补 `]`
 * 全部失败返回 null（调用方落回旧的全量解析，不抛错）。
 *
 * @param moduleName 传了就自动上报「曾被截断」的诊断（见 reportPatchDiag）
 */
export function parsePatchArray(text: string, moduleName?: string): LenientParseResult | null {
  const r = parsePatchArrayInner(text);
  if (r?.repaired && moduleName) {
    reportPatchDiag(moduleName, { repaired: true, notes: '输出曾被截断，已尽力修复' });
  }
  return r;
}

function parsePatchArrayInner(text: string): LenientParseResult | null {
  const t = String(text || '').trim();
  if (!t) return null;

  // ① 原样
  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) return { ops: v as PatchOp[], repaired: false };
  } catch { /* 继续修复 */ }

  // ② 截断修复：最后一个完整的 } 之后补 ]
  const lastBrace = t.lastIndexOf('}');
  if (lastBrace > 0) {
    try {
      const v = JSON.parse(t.slice(0, lastBrace + 1) + ']');
      if (Array.isArray(v) && v.length > 0) return { ops: v as PatchOp[], repaired: true };
    } catch { /* 继续 */ }
  }

  // ③ 单对象被截断（`[{...` 还没闭合）
  const openBrace = t.indexOf('{');
  if (openBrace >= 0 && lastBrace < openBrace) {
    try {
      const v = JSON.parse(t.slice(openBrace) + '}]');
      if (Array.isArray(v) && v.length > 0) return { ops: v as PatchOp[], repaired: true };
    } catch { /* 放弃 */ }
  }

  // ④ 兜底：逐条抠出顶层对象
  //    仅当原文确实以 `[` 开头时才启用 —— 否则会把普通的 JSON 对象误当成补丁数组
  if (openBrace >= 0 && t.startsWith('[')) {
    const items: any[] = [];
    let depth = 0;
    let start = -1;
    let inStr = false;
    let esc = false;
    for (let i = openBrace; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') { if (depth === 0) start = i; depth++; }
      else if (c === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            const obj = JSON.parse(t.slice(start, i + 1));
            if (obj && typeof obj === 'object') items.push(obj);
          } catch { /* 这一条坏了，跳过 */ }
          start = -1;
        }
      }
    }
    if (items.length > 0) return { ops: items as PatchOp[], repaired: true };
  }

  return null;
}
