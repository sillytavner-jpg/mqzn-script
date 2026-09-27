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
    fallback: 'early' | 'after-charinfo' | 'before-history' | 'after-history' | 'end';
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
  'grand_summary',
  'world_graph',
  'world_state',
  'context_summary',
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
  context_summary: '🧠智脑 · 隐藏楼摘要',
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

/** 六个分组（顺序 = 组在预设里的相对先后） */
export const ZHINO_GROUPS: SlotGroup[] = [
  {
    id: 'define',
    label: '变量定义（必须靠前）',
    slots: [ZHINO_DEFINE_SLOT],
    anchor: {
      afterIdentifiers: ['var_init'],
      afterNameKeywords: ['变量清零'],
      beforeIdentifiers: ['core_rules'],
      fallback: 'early',
    },
  },
  {
    id: 'char-info',
    label: '角色信息区（世界书结束之后）',
    slots: ['user_persona', 'dynamic_profile', 'relationship_profiles', 'memory_chain', 'dreamtalk'].map(makeSlot),
    anchor: {
      // 只认「角色信息区」锚点。**不要**把 chatHistory 列进来 ——
      // 它在「历史开始」之后，会让整组越过历史区边界（实测踩过）。
      afterIdentifiers: ['worldInfoAfter', 'worldInfoBefore'],
      afterNameKeywords: ['世界书结束', '界书结束', '世界书（角色定义之后）'],
      fallback: 'after-charinfo',
    },
  },
  {
    id: 'before-history',
    label: '历史区之前（大总结）',
    slots: [makeSlot('grand_summary')],
    anchor: {
      beforeIdentifiers: ['chatHistory'],
      beforeNameKeywords: ['历史开始', '聊天记录'],
      afterIdentifiers: ['worldInfoAfter'],
      fallback: 'before-history',
    },
  },
  {
    id: 'after-history',
    label: '历史区之后（图谱 / 场外 / 摘要）',
    slots: ['world_graph', 'world_state', 'context_summary'].map(makeSlot),
    anchor: {
      afterIdentifiers: ['chatHistory'],
      afterNameKeywords: ['历史结束'],
      fallback: 'after-history',
    },
  },
  {
    id: 'nsfw-isolation',
    label: 'NSFW 隔离层（跟随 NSFW 规则）',
    slots: [ZHINO_NSFW_SLOT],
    anchor: {
      afterIdentifiers: ['plug_love'],
      afterNameKeywords: ['NSFW指导', 'NSFW 指导'],
      fallback: 'end',
    },
  },
  {
    id: 'tail',
    label: '尾部（导演 / 入场引导）',
    slots: ['plot_guidance', 'world_entry_hint'].map(makeSlot),
    anchor: {
      beforeIdentifiers: ['output_format', 'think_open'],
      beforeNameKeywords: ['输出格式', '思维链'],
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
      items.push({ id, name: String(p.name || ''), enabled: e.enabled !== false, raw: p });
      seen.add(id);
    }
    // order 里没有、但 prompts 里存在的，补到末尾
    for (const p of preset.prompts) {
      const id = idOf(p);
      if (id && !seen.has(id)) {
        items.push({ id, name: String(p.name || ''), enabled: p.enabled !== false, raw: p });
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
      items.push({ id, name: String(p.name || ''), enabled: p.enabled !== false, raw: p });
    }
    return { items, kind: 'api', raw: preset };
  }

  return null;
}

// ========== 规则层 ==========

function indexOfItem(np: NormalizedPreset, id: string): number {
  return np.items.findIndex((it) => it.id === id);
}

function findByKeyword(np: NormalizedPreset, keywords: string[]): string | undefined {
  for (const it of np.items) {
    if (keywords.some((k) => it.name.includes(k))) return it.id;
  }
  return undefined;
}

function resolveFallback(np: NormalizedPreset, mode: SlotGroup['anchor']['fallback']): { after?: string; before?: string } {
  const n = np.items.length;
  if (n === 0) return {};
  switch (mode) {
    case 'early':
      return { after: np.items[Math.min(3, n - 1)].id };
    case 'after-charinfo':
    case 'before-history':
      return { after: np.items[Math.max(0, Math.floor(n * 0.6))].id };
    case 'after-history':
      return { after: np.items[Math.max(0, n - 2)].id };
    case 'end':
    default:
      return { after: np.items[n - 1].id };
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

  for (const group of ZHINO_GROUPS) {
    const existing = group.slots.some((s) => indexOfItem(np, s.identifier) >= 0);

    const candidates: Array<{ id: string; tag: string; mode: 'after' | 'before' }> = [];
    for (const id of group.anchor.afterIdentifiers || []) {
      if (indexOfItem(np, id) >= 0) candidates.push({ id, tag: `系统锚点 after:${id}`, mode: 'after' });
    }
    for (const id of group.anchor.beforeIdentifiers || []) {
      if (indexOfItem(np, id) >= 0) candidates.push({ id, tag: `系统锚点 before:${id}`, mode: 'before' });
    }
    for (const kw of group.anchor.afterNameKeywords || []) {
      const hit = findByKeyword(np, [kw]);
      if (hit) candidates.push({ id: hit, tag: `名称 after:「${kw}」`, mode: 'after' });
    }
    for (const kw of group.anchor.beforeNameKeywords || []) {
      const hit = findByKeyword(np, [kw]);
      if (hit) candidates.push({ id: hit, tag: `名称 before:「${kw}」`, mode: 'before' });
    }

    let bestPos = -1;
    let insertAfter: string | undefined;
    let insertBefore: string | undefined;
    let matchedBy = '';
    for (const c of candidates) {
      const idx = indexOfItem(np, c.id);
      if (idx < 0) continue;
      const pos = c.mode === 'after' ? idx + 1 : idx;
      if (pos > bestPos) {
        bestPos = pos;
        insertAfter = c.mode === 'after' ? c.id : undefined;
        insertBefore = c.mode === 'before' ? c.id : undefined;
        matchedBy = c.tag;
      }
    }

    const confident = bestPos >= 0;
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
    }
  }

  return plan;
}

// ========== 应用层（按原结构写回） ==========

export interface AdaptResult {
  preset: PresetJson;
  inserted: string[];
  skipped: string[];
  /** 识别到的结构类型（调试/提示用） */
  kind: 'file' | 'api';
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
    return { preset: preset as PresetJson, inserted, skipped, kind: 'file' };
  }

  const next = JSON.parse(JSON.stringify(preset)) as PresetJson;
  const kind = np.kind;

  for (const group of ZHINO_GROUPS) {
    const items = plan.filter((p) => p.groupId === group.id);
    if (items.length === 0) continue;

    const allExist = group.slots.every((s) => indexOfItem(np, s.identifier) >= 0);
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

  return { preset: next, inserted, skipped, kind };
}

// ========== 一键适配酒馆当前预设 ==========

export interface AdaptTavernResult {
  ok: boolean;
  message: string;
  inserted?: string[];
  skipped?: string[];
  newName?: string;
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
  const { preset, inserted, skipped } = applyZhinoInsertions(usePreset, plan);

  if (inserted.length === 0) {
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

  return {
    ok: true,
    message: `已生成预设「${newName}」：新插入 ${inserted.length} 条，跳过 ${skipped.length} 条（结构：${np.kind === 'file' ? '预设文件' : '酒馆助手 API'}）。去预设列表切过去即可。`,
    inserted,
    skipped,
    newName,
  };
}
