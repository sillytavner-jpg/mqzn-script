/**
 * 预设适配器 —— 把智脑的槽位条目自动插进任意 SillyTavern 预设
 *
 * ── 背景 ──
 * 智脑靠「槽位标记」（`<!--ZHINO_XXX-->`）往上下文里注入内容。
 * 这些标记需要以条目形式存在于预设里，但**每个预设结构不同**，
 * 手动加 13 条很麻烦，所以做自动适配。
 *
 * ── ⚠️ 两套结构必须同时支持（踩过的坑）──
 * 「预设文件 JSON」与「酒馆助手 API 返回的 Preset」**是两种形状**：
 *
 * | | 文件 JSON | 酒馆助手 API |
 * |---|---|---|
 * | 条目字段 | `identifier` | **`id`** |
 * | 顺序 | `prompt_order[0].order` 数组 | **`prompts` 数组本身就是顺序** |
 * | 未启用条目 | 混在 order（`enabled:false`） | **`prompts_unused` 单独放** |
 * | 插入位置 | — | `position: {type:'relative'}` / `{type:'in_chat',depth,order}` |
 *
 * 所以先用 `normalizePreset()` 把两者**归一到同一个模型**（顺序化列表），
 * 规则层只跟归一模型打交道，最后按原结构写回。
 *
 * ── 插入位置的规律（从「星光预设 v0.8.1」归纳）──
 * 智脑条目不是随便放的，而是按**语义分区**插：
 *   组 A（角色信息区）：玩家人格 / 动态人设 / 关系档案 / 记忆链 / 梦呓 → 「世界书结束」之后
 *   组 B（历史区之前）：剧情大总结                                      → `chatHistory` 之前
 *   组 C（历史区之后）：场景图谱 / 场外动态 / 隐藏楼摘要                  → 「历史结束」之后
 *   组 D（尾部）      ：剧情导演 / 入场引导                              → 靠后
 *   另有：变量定义（靠前）、NSFW 隔离层（跟随 NSFW 规则）
 */

// ========== 类型 ==========

export interface PresetOrderEntry {
  identifier?: string;
  id?: string;
  enabled?: boolean;
  [k: string]: any;
}

export interface PresetJson {
  prompts?: any[];
  prompt_order?: Array<{ character_id?: number | string; order: PresetOrderEntry[] }>;
  prompts_unused?: any[];
  [k: string]: any;
}

/** 归一后的单个条目（顺序 = 在预设里的位置） */
export interface NormalizedItem {
  /** 统一 id（文件结构取 identifier，API 结构取 id） */
  id: string;
  name: string;
  enabled: boolean;
  /**
   * 是否在 `prompt_order` 里**真正有位置**。
   *
   * ⚠️ 这个字段救过一次大坑：文件结构的预设里存在「在 prompts 里、但不在 order 里」的条目
   * （实测 `智脑-Z(3.78f特调)` 有 13 条这种，包括 `3.1p世界书结束`『历史开始』等**关键锚点**）。
   * 归一化时它们被补到 items 末尾，规则层就会"以为"锚点存在，
   * 但写回时 `order.indexOf` 找不到 → 整组被甩到预设最后。
   * **所以：定位锚点只用 `inOrder=true` 的条目；存在性判断才不管这个标志。**
   */
  inOrder: boolean;
  /** 原始条目对象 */
  raw: any;
}

/** 归一后的预设模型 */
export interface NormalizedPreset {
  items: NormalizedItem[];
  /** 来源结构 */
  kind: 'file' | 'api';
  /** 原始预设对象（写回时用） */
  raw: PresetJson;
}

/** 一个智脑槽位的定义 */
export interface ZhinoSlot {
  key: string;
  identifier: string;
  name: string;
  content: string;
  direct?: boolean;
}

export interface SlotGroup {
  id: string;
  label: string;
  slots: ZhinoSlot[];
  anchor: {
    afterIdentifiers?: string[];
    afterNameKeywords?: string[];
    beforeIdentifiers?: string[];
    beforeNameKeywords?: string[];
    /**
     * 多个候选命中时取哪个位置：
     * - `true`（默认）= 取**插入位置最靠后**的候选 —— 适合「贴区段末尾」的锚点，
     *   如「世界书结束」「历史结束」「NSFW 规则之后」。
     * - `false` = 取**最靠前**的候选 —— 适合「贴区段起点之前」的锚点，
     *   如「思维链之前」。
     *
     * ⚠️ 这条曾经踩过大坑：`before 关键词:'思维链'` 在预设里会命中
     * 「思维链开始 / 思维链 / 思维链结束」三个条目，若按"取最靠后"就会插到
     * **思维链结束之后**（错），而正确语义是贴在**思维链区起点之前**。
     */
    preferLast?: boolean;
    /**
     * 锚定到**同一批要插入的另一个智脑槽位**（传槽位 identifier，如 `zhino_dreamtalk`）。
     *
     * 用途：主人要求这几条的位置**固定可预期**，不跟着各预设的花式命名跑：
     * - NSFW 隔离层 → 梦呓下方
     * - 入场引导   → 场外动态后面
     * - 剧情导演   → 入场引导后面
     *
     * 生效前提：被依赖的组必须排在**它前面**（`ZHINO_GROUPS` 的顺序即处理顺序），
     * 这样写回时前一组已经插好了，`order.indexOf` 能找到它。
     */
    afterSlot?: string;
    beforeSlot?: string;
    /**
     * `true` = **系统 identifier 锚点优先**：只要 identifier 候选命中，就完全忽略名称关键词候选。
     *
     * 用于「关键词太容易误命中」的组。例如 tail 组的「思维链」，
     * 实测会命中 `plug_love` 的名字「🔌NSFW总开关，包含nsfw指导，**nsfw思维链**」——
     * 而 `think_open` 这种系统锚点是确定无疑的，应当压倒启发式关键词。
     */
    systemFirst?: boolean;
    fallback: 'early' | 'after-charinfo' | 'before-history' | 'after-history' | 'late' | 'end';
  };
}

export interface InsertionPlanItem {
  groupId: string;
  identifier: string;
  insertAfter?: string;
  insertBefore?: string;
  matchedBy: string;
  confident: boolean;
}

// ========== 槽位定义（对齐星光预设 v0.8.1） ==========

const VAR_KEYS = [
  'user_persona',
  'dynamic_profile',
  'relationship_profiles',
  'memory_chain',
  'dreamtalk',
  // ⚠️ 这里**故意没有** context_summary（隐藏楼摘要）：
  // 它在智脑里没有数据源（`index.ts` 的 slotTexts 从未赋值，`contextReplacement.ts` 的注入函数也没接线），
  // 插进预设只会得到一条永远为空的条目，所以不再适配它。
  // 但 `slotInjection.ts` 里**保留了它的 tag 定义** —— 那是为了清理**旧版预设里已存在的残留标记**。
  'grand_summary',
  'world_graph',
  'world_state',
  'plot_guidance',
  'world_entry_hint',
];

const NAMES: Record<string, string> = {
  user_persona: '🧠智脑 · 玩家人格',
  dynamic_profile: '🧠智脑 · 角色动态人设',
  relationship_profiles: '🧠智脑 · 角色关系档案',
  memory_chain: '🧠智脑 · 角色记忆链',
  dreamtalk: '🧠智脑 · 梦呓',
  grand_summary: '🧠智脑 · 剧情大总结',
  world_graph: '🧠智脑 · 场景图谱',
  world_state: '🧠智脑 · 场外动态',
  plot_guidance: '🧠智脑 · 剧情导演',
  world_entry_hint: '🧠智脑 · 入场引导',
};

function makeSlot(key: string): ZhinoSlot {
  return {
    key,
    identifier: `zhino_${key}`,
    name: NAMES[key] || `🧠智脑 · ${key}`,
    content: `{{getvar::zhino_${key}}}\n{{trim}}`,
  };
}

export const ZHINO_DEFINE_SLOT: ZhinoSlot = {
  key: '__define',
  identifier: 'plug_zhino',
  name: '智脑总开关',
  content: VAR_KEYS.map((k) => `{{setvar::zhino_${k}::<!--ZHINO_${k.toUpperCase()}-->}}`).join('\n') + '\n{{trim}}',
};

export const ZHINO_NSFW_SLOT: ZhinoSlot = {
  key: 'nsfw_isolation',
  identifier: 'zhino_nsfw_isolation',
  name: '智脑 · NSFW 隔离层',
  content: '<!--ZHINO_NSFW_ISOLATION-->',
  direct: true,
};

/**
 * 七个分组（**数组顺序 = 处理顺序**，也是被 `afterSlot` 依赖的前提）。
 *
 * 最终布局（主人 2026-09-28 定）：
 * ```
 *   靠前            plug_zhino（变量定义）
 *   世界书结束 ─┐
 *              ├ 玩家人格 / 动态人设 / 关系档案 / 记忆链 / 梦呓
 *              └ NSFW 隔离层            ← 紧跟梦呓下方
 *   历史开始  ──  剧情大总结
 *   chatHistory
 *              场景图谱 / 场外动态
 *              入场引导                  ← 紧跟场外动态后面
 *              剧情导演                  ← 紧跟入场引导后面
 * ```
 */
export const ZHINO_GROUPS: SlotGroup[] = [
  {
    id: 'define',
    label: '变量定义（必须靠前）',
    slots: [ZHINO_DEFINE_SLOT],
    anchor: {
      afterIdentifiers: ['var_init'],
      afterNameKeywords: ['变量初始化', '变量清零'],
      beforeIdentifiers: ['core_rules'],
      beforeNameKeywords: ['核心创作规则', '核心规则'],
      fallback: 'early',
    },
  },
  {
    id: 'char-info',
    label: '角色信息区（世界书 / 情景之后）',
    slots: ['user_persona', 'dynamic_profile', 'relationship_profiles', 'memory_chain', 'dreamtalk'].map(makeSlot),
    anchor: {
      // 只认「角色信息区」锚点。**不要**把 chatHistory 列进来 ——
      // 它在「历史开始」之后，会让整组越过历史区边界（实测踩过）。
      afterIdentifiers: ['worldInfoAfter', 'worldInfoBefore'],
      // ⚠️ 只写「世界书结束」，**不要**写「界书结束」——
      // 后者会命中「📌3.7/8f界书结束」（3.7/8F 破限那套的配套条目，在预设尾部），
      // 取最靠后就把整组甩到尾部去了。
      afterNameKeywords: ['世界书结束', '世界书（角色定义之后）', '世界书（角色定义之前）'],
      fallback: 'after-charinfo',
    },
  },
  {
    // ★ 固定位置：梦呓下方（不再跟随各预设的 NSFW 规则命名，位置可预期）
    id: 'nsfw-isolation',
    label: 'NSFW 隔离层（梦呓下方）',
    slots: [ZHINO_NSFW_SLOT],
    anchor: {
      afterSlot: 'zhino_dreamtalk',
      // 万一梦呓没插（极端情况）→ 退回跟随 NSFW 规则
      afterIdentifiers: ['plug_love', 'nsfw'],
      afterNameKeywords: ['NSFW', 'nsfw', '色情', '性爱', '限制级', 'R18'],
      fallback: 'late',
    },
  },
  {
    id: 'before-history',
    label: '历史区之前（大总结）',
    slots: [makeSlot('grand_summary')],
    anchor: {
      // ⚠️ 关键词必须精确：「聊天记录」这种宽词会同时命中「聊天记录开始」与
      // 「聊天记录结束」，取最靠后就会跑到 chatHistory **之后**去。
      beforeIdentifiers: ['chatHistory'],
      beforeNameKeywords: ['聊天记录开始', '历史开始'],
      fallback: 'before-history',
    },
  },
  {
    id: 'after-history',
    label: '历史区之后（图谱 / 场外动态）',
    slots: ['world_graph', 'world_state'].map(makeSlot),
    anchor: {
      afterIdentifiers: ['chatHistory'],
      afterNameKeywords: ['历史结束', '聊天记录结束', '故事结束'],
      fallback: 'after-history',
    },
  },
  {
    // ★ 固定位置：场外动态后面
    id: 'entry-hint',
    label: '入场引导（场外动态后面）',
    slots: [makeSlot('world_entry_hint')],
    anchor: {
      afterSlot: 'zhino_world_state',
      fallback: 'end',
    },
  },
  {
    // ★ 固定位置：入场引导后面
    id: 'plot-guidance',
    label: '剧情导演（入场引导后面）',
    slots: [makeSlot('plot_guidance')],
    anchor: {
      afterSlot: 'zhino_world_entry_hint',
      fallback: 'end',
    },
  },
];

// ========== 归一（两套结构 → 单一模型） ==========

function idOf(p: any): string {
  return String(p?.identifier ?? p?.id ?? '');
}

/**
 * 把「预设文件结构」或「酒馆助手 API 结构」归一到统一模型。
 * 返回 null 表示结构无法识别。
 */
export function normalizePreset(preset: any): NormalizedPreset | null {
  if (!preset || typeof preset !== 'object') return null;

  const hasOrder = Array.isArray(preset.prompt_order) && preset.prompt_order.length > 0;

  // ① 文件结构：prompts(identifier) + prompt_order
  if (Array.isArray(preset.prompts) && hasOrder) {
    const order = preset.prompt_order[0]?.order || [];
    const byId = new Map<string, any>();
    for (const p of preset.prompts) {
      const id = idOf(p);
      if (id) byId.set(id, p);
    }
    const items: NormalizedItem[] = [];
    const seen = new Set<string>();
    for (const e of order) {
      const id = idOf(e);
      if (!id || seen.has(id)) continue;
      const p = byId.get(id) || {};
      items.push({ id, name: String(p.name || ''), enabled: e.enabled !== false, inOrder: true, raw: p });
      seen.add(id);
    }
    // order 里没有、但 prompts 里存在的，补到末尾（inOrder=false，不可作锚点）
    for (const p of preset.prompts) {
      const id = idOf(p);
      if (id && !seen.has(id)) {
        items.push({ id, name: String(p.name || ''), enabled: p.enabled !== false, inOrder: false, raw: p });
        seen.add(id);
      }
    }
    return { items, kind: 'file', raw: preset };
  }

  // ② 酒馆助手 API 结构：prompts 数组本身就是顺序
  if (Array.isArray(preset.prompts)) {
    const items: NormalizedItem[] = [];
    for (const p of preset.prompts) {
      const id = idOf(p);
      if (!id) continue;
      items.push({ id, name: String(p.name || ''), enabled: p.enabled !== false, inOrder: true, raw: p });
    }
    return { items, kind: 'api', raw: preset };
  }

  return null;
}

// ========== 规则层 ==========

/** 任意位置查找（含「在 prompts 但不在 order」的条目）—— 用于「是否已存在」判断 */
function indexOfAny(np: NormalizedPreset, id: string): number {
  return np.items.findIndex((it) => it.id === id);
}

/**
 * 查找**在 order 里真正有位置**的条目下标 —— 用于锚点定位。
 * 返回 -1 = 不存在**或**没有位置（都不能作为插入参照）。
 */
function indexOfItem(np: NormalizedPreset, id: string): number {
  const i = np.items.findIndex((it) => it.id === id);
  return i >= 0 && np.items[i].inOrder ? i : -1;
}

/** 返回**所有**名称命中该关键词的「有位置」条目下标（需要"最靠前/最靠后"的取舍空间） */
function allIndexesByKeyword(np: NormalizedPreset, kw: string): number[] {
  const out: number[] = [];
  np.items.forEach((it, i) => {
    if (it.inOrder && it.name.includes(kw)) out.push(i);
  });
  return out;
}

/** 尾部系统条目（Agent 框架 / 破限收尾）—— 不该被当成「区段末尾」的落点 */
function isTailSystemItem(id: string): boolean {
  if (/^agent/i.test(id)) return true;
  return ['output_contract', 'cot_hijack', 'jb_tail', 'input_emphasis', 'output_format'].includes(id);
}

/** 从「有位置」的条目里，从后往前跳过尾部系统件，返回下标 */
function lastNonSystemIndex(pool: NormalizedItem[]): number {
  let i = pool.length - 1;
  while (i > 0 && isTailSystemItem(pool[i].id)) i--;
  return i;
}

function resolveFallback(np: NormalizedPreset, mode: SlotGroup['anchor']['fallback']): { after?: string; before?: string } {
  // ⚠️ 兜底也必须落在「order 里有位置」的条目旁边，否则写回时同样会甩到最后
  const pool = np.items.filter((it) => it.inOrder);
  const n = pool.length;
  if (n === 0) return {};
  switch (mode) {
    case 'early': {
      // 优先落在身份声明（main）之后，其次第一条之后。
      // 旧实现写死 `items[3]` —— 遇到条目数少于 4 或前几条是别的结构时位置很怪。
      const mi = pool.findIndex((it) => it.id === 'main');
      return { after: pool[mi >= 0 ? mi : 0].id };
    }
    case 'after-charinfo':
    case 'before-history':
      return { after: pool[Math.max(0, Math.floor(n * 0.6))].id };
    case 'after-history':
      return { after: pool[Math.max(0, n - 2)].id };
    case 'late':
      // 靠后，但跳过尾部系统件（NSFW 隔离层的兜底）
      return { after: pool[Math.max(0, lastNonSystemIndex(pool) - 2)].id };
    case 'end':
    default:
      return { after: pool[lastNonSystemIndex(pool)].id };
  }
}

/**
 * 规则层：为每个分组定位插入点。
 *
 * 策略：**收集所有候选锚点，取「插入位置最靠后」的那个** ——
 * 一个区块常有"起点锚点"（系统 `worldInfoAfter`）和"终点锚点"（作者命名的「世界书结束」），
 * 智脑内容应贴在**区末尾**（紧邻使用点）。
 */
export function planZhinoInsertions(preset: any): InsertionPlanItem[] {
  const np = normalizePreset(preset);
  const plan: InsertionPlanItem[] = [];
  if (!np) return plan;

  /** 本轮已排定的智脑槽位（供 afterSlot / beforeSlot 依赖 —— 被依赖组必须排在前面） */
  const slotPlan = new Set<string>();

  for (const group of ZHINO_GROUPS) {
    const existing = group.slots.some((s) => indexOfAny(np, s.identifier) >= 0);
    const preferLast = group.anchor.preferLast !== false;

    // ★ 槽位依赖优先：主人指定的固定相对位置（如「NSFW 隔离层紧跟梦呓」），
    //   命中就完全不再看其他锚点 —— 位置固定可预期，不跟着各预设的花式命名跑。
    let slotDep: { pos: number; after?: string; before?: string; tag: string } | undefined;
    const depId = group.anchor.afterSlot || group.anchor.beforeSlot;
    if (depId && (indexOfItem(np, depId) >= 0 || slotPlan.has(depId))) {
      const isAfter = !!group.anchor.afterSlot;
      slotDep = isAfter
        ? { pos: 0, after: depId, tag: `紧跟「${slotNameById(depId)}」之后` }
        : { pos: 0, before: depId, tag: `紧跟「${slotNameById(depId)}」之前` };
    }

    interface Cand { pos: number; after?: string; before?: string; tag: string }
    const sysCands: Cand[] = [];
    const kwCands: Cand[] = [];

    for (const id of group.anchor.afterIdentifiers || []) {
      const i = indexOfItem(np, id);
      if (i >= 0) sysCands.push({ pos: i + 1, after: id, tag: `系统锚点 after:${id}` });
    }
    for (const id of group.anchor.beforeIdentifiers || []) {
      const i = indexOfItem(np, id);
      if (i >= 0) sysCands.push({ pos: i, before: id, tag: `系统锚点 before:${id}` });
    }
    // 名称关键词：**收集全部命中**，再按 preferLast 取舍
    // （`思维链` 会命中 开始/主体/结束 三条，只取第一条是不够的）
    for (const kw of group.anchor.afterNameKeywords || []) {
      for (const i of allIndexesByKeyword(np, kw)) {
        kwCands.push({ pos: i + 1, after: np.items[i].id, tag: `名称 after:「${kw}」` });
      }
    }
    for (const kw of group.anchor.beforeNameKeywords || []) {
      for (const i of allIndexesByKeyword(np, kw)) {
        kwCands.push({ pos: i, before: np.items[i].id, tag: `名称 before:「${kw}」` });
      }
    }

    // 置信度分层：systemFirst 的组，系统锚点一旦命中就完全忽略关键词
    const candidates = group.anchor.systemFirst && sysCands.length > 0
      ? sysCands
      : [...sysCands, ...kwCands];

    let chosen: Cand | undefined = slotDep;
    if (!slotDep) {
      for (const c of candidates) {
        if (!chosen) { chosen = c; continue; }
        if (preferLast ? c.pos > chosen.pos : c.pos < chosen.pos) chosen = c;
      }
    }

    let insertAfter = chosen?.after;
    let insertBefore = chosen?.before;
    let matchedBy = chosen?.tag || '';
    const confident = !!chosen;
    if (!confident) {
      const fb = resolveFallback(np, group.anchor.fallback);
      insertAfter = fb.after;
      insertBefore = fb.before;
      matchedBy = `兜底(${group.anchor.fallback})`;
    }

    for (const slot of group.slots) {
      plan.push({
        groupId: group.id,
        identifier: slot.identifier,
        insertAfter,
        insertBefore,
        matchedBy: existing ? '已存在，跳过' : matchedBy,
        confident: existing ? true : confident,
      });
      // 登记给后面的组当锚点用（afterSlot / beforeSlot）
      slotPlan.add(slot.identifier);
    }
  }

  return plan;
}

/** 按槽位 identifier 找显示名（供 `紧跟「xxx」之后` 这类提示用） */
function slotNameById(id: string): string {
  for (const g of ZHINO_GROUPS) {
    const s = g.slots.find((x) => x.identifier === id);
    if (s) return s.name;
  }
  return id;
}

// ========== 应用层（按原结构写回） ==========

/** 一条槽位最终落到哪（供 UI 展示，便于人工核对） */
export interface InsertionDetail {
  identifier: string;
  name: string;
  /** 落点描述，如「🔀西式表达」之后 */
  target: string;
  matchedBy: string;
  confident: boolean;
}

export interface AdaptResult {
  preset: PresetJson;
  inserted: string[];
  skipped: string[];
  /** 清理掉的**已废弃**槽位（如隐藏楼摘要） */
  removed: string[];
  /** 识别到的结构类型（调试/提示用） */
  kind: 'file' | 'api';
  /** 每条新插入槽位的落点明细 */
  details: InsertionDetail[];
}

/**
 * **已废弃**的槽位：适配时从预设里清掉（旧的适配产物可能还留着）。
 *
 * 隐藏楼摘要在智脑里没有数据源（`index.ts` 的 slotTexts 从未赋值、
 * `contextReplacement.ts` 的注入函数也没接线），插进预设只会得到一条永远为空的条目。
 * 注意：`slotInjection.ts` 里**仍然保留**它的 tag 定义 —— 那是为了清理残留标记，别一起删。
 */
const DEPRECATED_SLOT_IDS = ['zhino_context_summary'];

/** 从预设里移除已废弃的槽位条目（同时清 `prompts` 与 `prompt_order`） */
function removeDeprecatedSlots(next: PresetJson, kind: 'file' | 'api'): string[] {
  const removed: string[] = [];
  if (!Array.isArray(next.prompts)) return removed;
  const list = next.prompts as any[];
  const order = kind === 'file' ? (next.prompt_order?.[0]?.order as any[] | undefined) : undefined;

  for (const dead of DEPRECATED_SLOT_IDS) {
    let hit = false;
    if (Array.isArray(order)) {
      for (let i = order.length - 1; i >= 0; i--) {
        if (idOf(order[i]) === dead) { order.splice(i, 1); hit = true; }
      }
    }
    for (let i = list.length - 1; i >= 0; i--) {
      if (idOf(list[i]) === dead) { list.splice(i, 1); hit = true; }
    }
    if (hit) removed.push(dead);
  }
  return removed;
}

/** 文件结构的新条目字段（照抄星光 v0.8.1 模板） */
function buildFileEntry(slot: ZhinoSlot) {
  return {
    identifier: slot.identifier,
    name: slot.name,
    content: slot.content,
    role: 'system',
    system_prompt: false,
    enabled: true,
    marker: false,
    forbid_overrides: false,
    injection_position: 0,
    injection_depth: 4,
    injection_order: 100,
    injection_trigger: [],
    attach_role: 'user',
    attach_side: 'end',
    attach_index: 1,
  };
}

/** 酒馆助手 API 结构的新条目字段（PresetPrompt） */
function buildApiEntry(slot: ZhinoSlot) {
  return {
    id: slot.identifier,
    name: slot.name,
    enabled: true,
    position: { type: 'relative' as const },
    role: 'system' as const,
    content: slot.content,
  };
}

/**
 * 把 plan 应用到预设上，返回**新的**预设对象（深拷贝，不改原对象）。
 * 幂等：已存在的条目不重复插入。
 */
export function applyZhinoInsertions(preset: any, plan: InsertionPlanItem[]): AdaptResult {
  const np = normalizePreset(preset);
  const inserted: string[] = [];
  const skipped: string[] = [];

  if (!np) {
    return { preset: preset as PresetJson, inserted, skipped, removed: [], kind: 'file', details: [] };
  }

  const next = JSON.parse(JSON.stringify(preset)) as PresetJson;
  const kind = np.kind;
  // 先清废弃槽位（旧适配产物里可能还留着隐藏楼摘要那条空条目）
  const removed = removeDeprecatedSlots(next, kind);

  for (const group of ZHINO_GROUPS) {
    const items = plan.filter((p) => p.groupId === group.id);
    if (items.length === 0) continue;

    const allExist = group.slots.every((s) => indexOfAny(np, s.identifier) >= 0);
    if (allExist) {
      skipped.push(...group.slots.map((s) => s.identifier));
      continue;
    }

    const anchor = items[0];

    if (kind === 'file') {
      // ── 文件结构：写 prompts + prompt_order ──
      if (!Array.isArray(next.prompts)) next.prompts = [];
      if (!Array.isArray(next.prompt_order) || next.prompt_order.length === 0) {
        next.prompt_order = [{ character_id: 100001, order: [] }];
      }
      const order = next.prompt_order[0].order;
      const hasIdent = (id: string) => (next.prompts || []).some((p: any) => idOf(p) === id);
      const orderIdx = (id: string) => order.findIndex((e) => idOf(e) === id);

      for (const slot of group.slots) {
        if (!hasIdent(slot.identifier)) next.prompts.push(buildFileEntry(slot));
      }

      let insertAt = order.length;
      if (anchor.insertAfter) {
        const i = orderIdx(anchor.insertAfter);
        if (i >= 0) insertAt = i + 1;
      } else if (anchor.insertBefore) {
        const i = orderIdx(anchor.insertBefore);
        if (i >= 0) insertAt = i;
      }

      const toAdd = group.slots
        .filter((s) => orderIdx(s.identifier) < 0)
        .map((s) => ({ identifier: s.identifier, enabled: true }));
      if (toAdd.length > 0) order.splice(insertAt, 0, ...toAdd);
      inserted.push(...toAdd.map((e) => e.identifier));
    } else {
      // ── API 结构：直接写 prompts 数组（顺序即位置）──
      if (!Array.isArray(next.prompts)) next.prompts = [];
      const list = next.prompts as any[];
      const hasId = (id: string) => list.some((p) => idOf(p) === id);
      const idxOfId = (id: string) => list.findIndex((p) => idOf(p) === id);

      let insertAt = list.length;
      if (anchor.insertAfter) {
        const i = idxOfId(anchor.insertAfter);
        if (i >= 0) insertAt = i + 1;
      } else if (anchor.insertBefore) {
        const i = idxOfId(anchor.insertBefore);
        if (i >= 0) insertAt = i;
      }

      const toAdd = group.slots.filter((s) => !hasId(s.identifier)).map(buildApiEntry);
      if (toAdd.length > 0) list.splice(insertAt, 0, ...toAdd);
      inserted.push(...toAdd.map((e) => e.id));
    }
  }

  return { preset: next, inserted, skipped, removed, kind, details: describeInsertions(next, kind, inserted, plan) };
}

/**
 * 算出「每条新槽位最终落在哪」。
 * 跳过同一批插入的其他智脑条目，这样同组的 5 条会显示**同一个**参照物，便于核对。
 */
function describeInsertions(
  next: PresetJson,
  kind: 'file' | 'api',
  inserted: string[],
  plan: InsertionPlanItem[],
): InsertionDetail[] {
  const ids: string[] = kind === 'file'
    ? ((next.prompt_order?.[0]?.order || []) as any[]).map((e) => idOf(e))
    : ((next.prompts || []) as any[]).map((p) => idOf(p));

  const nameById = new Map<string, string>();
  for (const p of (next.prompts || []) as any[]) nameById.set(idOf(p), String(p.name || ''));

  const zhinoSet = new Set(ZHINO_GROUPS.flatMap((g) => g.slots.map((s) => s.identifier)));

  return inserted.map((id) => {
    const i = ids.indexOf(id);
    const item = plan.find((x) => x.identifier === id);
    let target: string;
    if (item?.insertAfter && zhinoSet.has(item.insertAfter)) {
      // ★ 槽位依赖：直接显示被依赖的槽位名（如「梦呓」之后），不要把整组跳过
      target = `「${nameById.get(item.insertAfter) || item.insertAfter}」之后`;
    } else if (item?.insertBefore && zhinoSet.has(item.insertBefore)) {
      target = `「${nameById.get(item.insertBefore) || item.insertBefore}」之前`;
    } else if (i >= 0) {
      // 跳过同一批插入的其他智脑条目，让同组的多条显示同一个参照物
      let k = i - 1;
      while (k >= 0 && zhinoSet.has(ids[k])) k--;
      target = k >= 0 ? `「${nameById.get(ids[k]) || ids[k]}」之后` : '(最前)';
    } else {
      target = '(未找到)';
    }
    return {
      identifier: id,
      name: nameById.get(id) || id,
      target,
      matchedBy: item?.matchedBy || '',
      confident: item?.confident !== false,
    };
  });
}

// ========== 一键适配酒馆当前预设 ==========

export interface AdaptTavernResult {
  ok: boolean;
  message: string;
  inserted?: string[];
  skipped?: string[];
  newName?: string;
  /** 每条槽位最终落在哪（UI 核对用） */
  details?: InsertionDetail[];
}

/**
 * 一键适配「酒馆当前正在使用的预设」。
 *
 * 流程：`getPreset('in_use')` → 归一 → 规则定位 → 应用 → `createOrReplacePreset` 新建预设。
 * **绝不改原预设** —— 只额外生成一个「原名（智脑适配）」。
 */
export async function adaptCurrentPresetInTavern(): Promise<AdaptTavernResult> {
  const api = globalThis as any;

  if (typeof api.getPreset !== 'function') {
    return { ok: false, message: '读不到预设：需要「酒馆助手」扩展（JS-Slash-Runner）' };
  }
  if (typeof api.createOrReplacePreset !== 'function') {
    return { ok: false, message: '无法创建预设：酒馆助手版本过低，请更新到带 createOrReplacePreset 的版本' };
  }

  let usePreset: any;
  try {
    usePreset = await api.getPreset('in_use');
  } catch (e: any) {
    return { ok: false, message: `读取当前预设失败：${e?.message || e}` };
  }

  const np = normalizePreset(usePreset);
  if (!np) {
    const keys = usePreset && typeof usePreset === 'object' ? Object.keys(usePreset).join(', ') : String(usePreset);
    return {
      ok: false,
      message: `识别不了当前预设的结构（既没有 prompts+prompt_order，也没有 prompts 数组）。实际字段：${keys}`,
    };
  }

  const plan = planZhinoInsertions(usePreset);
  const { preset, inserted, skipped, removed, details } = applyZhinoInsertions(usePreset, plan);

  if (inserted.length === 0 && removed.length === 0) {
    return { ok: false, message: '当前预设已包含全部智脑条目，无需适配', skipped };
  }

  const baseName = typeof api.getLoadedPresetName === 'function'
    ? String(api.getLoadedPresetName() || '当前预设')
    : '当前预设';
  const newName = `${baseName}（智脑适配）`;

  try {
    await api.createOrReplacePreset(newName, preset, { render: 'debounced' });
  } catch (e: any) {
    return { ok: false, message: `写入预设失败：${e?.message || e}`, inserted };
  }

  const weak = details.filter((d) => !d.confident).length;
  const parts = [
    `新插入 ${inserted.length} 条`,
    `跳过 ${skipped.length} 条`,
    removed.length > 0 ? `清理废弃槽位 ${removed.length} 条` : '',
    weak > 0 ? `其中 ${weak} 条靠兜底定位` : '',
  ].filter(Boolean);
  return {
    ok: true,
    message: `已生成预设「${newName}」：${parts.join('，')}（结构：${np.kind === 'file' ? '预设文件' : '酒馆助手 API'}）。去预设列表切过去即可。`,
    inserted,
    skipped,
    details,
    newName,
  };
}
