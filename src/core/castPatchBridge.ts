/**
 * patch ↔ 角色档案（cast）桥接
 *
 * ── 覆盖的模块 ──
 *   角色记忆  characterMemoryUpdate  →  /cast/{名}/memory 、/cast/{名}/nsfw
 *   （后续 P2 扩展：动态人设 → /cast/{名}/dynamic、/cast/{名}/factual）
 *
 * ── 为什么这么做 ──
 * 与 graphPatchBridge 同思路：**把 patch 翻译回各模块原本的输出形状**，
 * 从而完全复用现有的落库/转换链路（coreIndices 拆核心近期、name 归一、filter user 等），
 * 零重写。
 *
 * 本模块刻意**不 import 任何业务模块**（保持零依赖、可裸测）。
 */

export interface PatchLike {
  op: string;
  path: string;
  value?: unknown;
}

/** 角色记忆模块的「原始输出形状」（与 AI 全量 JSON 一致） */
export interface CastMemoryData {
  characterMemories: any[];
  nsfwMemories: any[];
}

export interface CastBridgeResult {
  data: CastMemoryData | null;
  errors: string[];
}

function asObject(v: unknown): Record<string, any> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null;
}

function isDeleteOp(op: string): boolean {
  const v = String(op || '').trim().toLowerCase();
  return v === 'del' || v === 'delete' || v === 'remove';
}

/**
 * 解析「哪些记忆是核心」。
 *
 * 两条来源，优先级从高到低：
 *   ① 每条记忆上的 `core: true` 布尔标记 —— **首选，无歧义**
 *   ② 老的 `coreIndices` 编号数组 —— 兼容用。
 *      ⚠️ 实测踩坑：模型会在 1-based 与 0-based 之间摇摆（同一 prompt 一次给 [1]、一次给 [0]）。
 *      这里用「含 0 即判定为 0-based」自动纠正。
 *
 * 统一产出 **1-based** 的 coreIndices —— 下游 parseCharacterMemoryOutput 依赖这个约定。
 */
function resolveCoreIndices(obj: Record<string, any>, memories: any[]): number[] {
  // ① 布尔标记（首选）
  const byFlag: number[] = [];
  memories.forEach((m, i) => {
    if (m && typeof m === 'object' && (m.core === true || m.isCore === true)) byFlag.push(i + 1);
  });
  if (byFlag.length > 0) return byFlag;

  // ② 编号数组（兼容）
  const raw = Array.isArray(obj.coreIndices) ? obj.coreIndices : [];
  const nums = raw.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n));
  if (nums.length === 0) return [];
  const zeroBased = nums.some((n: number) => n === 0);
  return zeroBased ? nums.map((n: number) => n + 1) : nums;
}

/**
 * patch ops → 角色记忆模块的 data 形状。
 *
 * 支持：
 *   { op:'set', path:'/cast/江念/memory', value:{attitude,keywords,memories,coreReasons,coreIndices} }
 *   { op:'set', path:'/cast/江念/nsfw',   value:{sensitivePoints,preferences,behaviors,memories} }
 *
 * 不认识的路径只记 errors，不产生垃圾数据。
 * 返回 data 为 null 表示「没有可用的角色记忆条目」。
 */
export function patchToCharacterMemoryData(ops: PatchLike[]): CastBridgeResult {
  const characterMemories: any[] = [];
  const nsfwMemories: any[] = [];
  const errors: string[] = [];
  const list = Array.isArray(ops) ? ops : [];

  for (const raw of list) {
    if (!raw || typeof raw.path !== 'string') {
      errors.push('条目结构非法');
      continue;
    }

    const segs = raw.path.split('/').map((s) => s.trim()).filter(Boolean);
    // /cast/{角色名}/{字段}
    if (segs.length !== 3 || segs[0] !== 'cast') {
      errors.push(`非角色档案路径: ${raw.path}`);
      continue;
    }

    const who = segs[1];
    const field = segs[2].toLowerCase();

    if (!who) {
      errors.push(`缺角色名: ${raw.path}`);
      continue;
    }

    if (isDeleteOp(raw.op)) {
      // 删除某个角色的记忆 → 由调用方按「不出现在结果里」处理（现有链路是全量替换）
      continue;
    }

    const obj = asObject(raw.value);
    if (!obj) {
      errors.push(`值必须是对象: ${raw.path}`);
      continue;
    }

    if (field === 'memory' || field === 'memories') {
      const memories = Array.isArray(obj.memories) ? obj.memories : [];
      characterMemories.push({
        characterName: String(obj.characterName || who),
        aliases: Array.isArray(obj.aliases) ? obj.aliases : [],
        attitude: obj.attitude || 'neutral',
        keywords: Array.isArray(obj.keywords) ? obj.keywords : [],
        memories,
        coreReasons: Array.isArray(obj.coreReasons) ? obj.coreReasons : [],
        coreIndices: resolveCoreIndices(obj, memories),
      });
      continue;
    }

    if (field === 'nsfw') {
      nsfwMemories.push({
        characterName: String(obj.characterName || who),
        sensitivePoints: Array.isArray(obj.sensitivePoints) ? obj.sensitivePoints : [],
        preferences: Array.isArray(obj.preferences) ? obj.preferences : [],
        behaviors: Array.isArray(obj.behaviors) ? obj.behaviors : [],
        memories: Array.isArray(obj.memories) ? obj.memories : [],
      });
      continue;
    }

    errors.push(`未知字段: ${raw.path}`);
  }

  const hasAny = characterMemories.length > 0 || nsfwMemories.length > 0;
  return { data: hasAny ? { characterMemories, nsfwMemories } : null, errors };
}

// ========== 动态人设 ==========

/** 动态人设模块的「原始输出形状」 */
export interface CastDynamicData {
  profiles: Array<{ characterName: string; updates: { factualState?: string; dynamicProfile?: string } }>;
}

/**
 * 把事实层对象转回「一行一项」的文本（动态人设原有的 factualState 格式）。
 */
function factualToText(obj: Record<string, any>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    lines.push(`${k}：${Array.isArray(v) ? v.join('；') : v}`);
  }
  return lines.join('\n');
}

/** 把动态层对象转回文本；数组值展开成 `- item` 列表 */
function dynamicToText(obj: Record<string, any>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      lines.push(`${k}：`);
      for (const item of v) lines.push(`- ${item}`);
    } else {
      lines.push(`${k}：${v}`);
    }
  }
  return lines.join('\n');
}

/**
 * patch ops → 动态人设模块的 data 形状。
 *
 *   { op:'set', path:'/cast/江念/factual', value:{身体状态:'…',穿着:'…',…} }
 *   { op:'set', path:'/cast/江念/dynamic', value:{行为倾向:'…',禁止假设:['…']} }
 *
 * 同一角色的两条会合并成一个 profile 条目（与原 profiles[] 结构一致）。
 */
export function patchToDynamicProfiles(ops: PatchLike[]): { data: CastDynamicData | null; errors: string[] } {
  const map = new Map<string, { characterName: string; updates: { factualState?: string; dynamicProfile?: string } }>();
  const errors: string[] = [];
  const list = Array.isArray(ops) ? ops : [];

  for (const raw of list) {
    if (!raw || typeof raw.path !== 'string') {
      errors.push('条目结构非法');
      continue;
    }
    const segs = raw.path.split('/').map((s) => s.trim()).filter(Boolean);
    if (segs.length !== 3 || segs[0] !== 'cast') {
      errors.push(`非角色档案路径: ${raw.path}`);
      continue;
    }
    const who = segs[1];
    const field = segs[2].toLowerCase();
    if (!who) { errors.push(`缺角色名: ${raw.path}`); continue; }
    if (isDeleteOp(raw.op)) continue;

    const obj = asObject(raw.value);
    if (!obj) { errors.push(`值必须是对象: ${raw.path}`); continue; }

    const entry = map.get(who) || { characterName: who, updates: {} as any };
    if (field === 'factual') {
      entry.updates.factualState = factualToText(obj);
    } else if (field === 'dynamic') {
      entry.updates.dynamicProfile = dynamicToText(obj);
    } else {
      errors.push(`未知字段: ${raw.path}`);
      continue;
    }
    map.set(who, entry);
  }

  const profiles = [...map.values()].filter((p) => p.updates.factualState || p.updates.dynamicProfile);
  return { data: profiles.length ? { profiles } : null, errors };
}
