/**
 * 角色注册表 (Character Registry)
 *
 * 角色身份的唯一真相源。每个角色有稳定 characterId，名字/别名只是展示属性。
 *
 * 设计动机：原系统用"名字字符串"做角色主键，散落 13+ 存储点，导致：
 *   - 改名要同步十几处，漏一处就残留旧名
 *   - 识别靠"先注册先占"的别名索引，别名录错就传染
 *   - AI 输出名字稍有差异就当新角色入库 → 同人多名重复
 * 引入稳定 ID 后，改名/合并只动注册表一处，识别按 ID 仲裁。
 *
 * 阶段：P1 只建表+发ID+迁移，不改任何读写路径（纯增量）。
 *       P2 写入收口、P3 读取收口、P4 改名/合并重写、P5 清理+UI。
 */

import {
  normalizeCharacterName,
  cleanCharacterAliases,
  MEANINGLESS_ALIASES,
  type CharacterNameEntry,
} from '../utils/characterNames';

// ===== 类型定义 =====

export type CharacterStatus = 'active' | 'ignored' | 'merged';

export interface CharacterRecord {
  /** 稳定 ID，一旦生成永不变更（即使改名 id 不变） */
  id: string;
  /** 当前主名（用户可改） */
  primaryName: string;
  /** 别名（含历史主名） */
  aliases: string[];
  status: CharacterStatus;
  /** status=merged 时，指向主角色 id */
  mergedInto?: string;
  createdAt: string;
  /** 最近一次被 AI 提到的时间，用于冷数据清理（P5） */
  lastSeenAt: string;
  /** 来源：migrated=迁移自旧数据, ai=AI 新建, manual=用户手动 */
  source?: 'migrated' | 'ai' | 'manual';
}

export interface CharacterRegistry {
  /** id → record */
  records: Record<string, CharacterRecord>;
  /** schema 版本，便于未来迁移 */
  version: number;
}

// ===== ID 生成 =====

/** djb2 字符串 hash，返回 6 位 base36（非负） */
function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36).padStart(6, '0').slice(-6);
}

/** slug：primaryName 去零宽空格/括号后缀/标点/空格，lowercase */
function makeSlug(name: string): string {
  const cleaned = normalizeCharacterName(name).trim().toLowerCase();
  const slug = cleaned.replace(/[\s\p{P}]+/gu, '_').replace(/^_+|_+$/g, '');
  return slug || 'char';
}

/**
 * 生成稳定 characterId
 * 格式：chr_<slug>_<6位hash>
 * hash 基于 primaryName 本身（迁移可重现）；冲突加数字后缀
 */
export function generateCharacterId(
  primaryName: string,
  existingIds: Set<string>,
  salt = '',
): string {
  const slug = makeSlug(primaryName);
  const hash = djb2Hash(primaryName + salt);
  const base = `chr_${slug}_${hash}`;
  let candidate = base;
  let suffix = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix++;
  }
  return candidate;
}

// ===== 运行期查找索引（不持久化，按需构建） =====

export interface NameLookupIndex {
  byId: Map<string, CharacterRecord>;
  /** 名字（归一化）→ 候选 records（可能多个，需仲裁） */
  byNameKey: Map<string, CharacterRecord[]>;
  /** 别名（归一化）→ 候选 records */
  byAliasKey: Map<string, CharacterRecord[]>;
}

const normKey = (s?: string): string =>
  normalizeCharacterName(s || '').trim().toLowerCase();

export function buildNameLookupIndex(
  registry: CharacterRegistry | null | undefined,
): NameLookupIndex {
  const idx: NameLookupIndex = {
    byId: new Map(),
    byNameKey: new Map(),
    byAliasKey: new Map(),
  };
  if (!registry?.records) return idx;
  const add = (
    map: Map<string, CharacterRecord[]>,
    key: string,
    rec: CharacterRecord,
  ) => {
    if (!key) return;
    const arr = map.get(key);
    if (arr) arr.push(rec);
    else map.set(key, [rec]);
  };
  for (const rec of Object.values(registry.records)) {
    // 已合并的不参与名字查找（调用方应沿 mergedInto 找真身）
    if (rec.status === 'merged') continue;
    idx.byId.set(rec.id, rec);
    add(idx.byNameKey, normKey(rec.primaryName), rec);
    // 主名也进 byAliasKey，方便统一查找
    add(idx.byAliasKey, normKey(rec.primaryName), rec);
    for (const a of rec.aliases || []) add(idx.byAliasKey, normKey(a), rec);
  }
  return idx;
}

/**
 * 用名字解析到候选 record 列表。
 * 返回 0/1/多条：多条时需仲裁（P5 人工/规则）。
 * 只返回 active/ignored 状态的 record（已合并的沿 mergedInto 在 resolveTrueRecord 找）。
 */
export function resolveNameToRecords(
  rawName: string,
  registry: CharacterRegistry | null | undefined,
): CharacterRecord[] {
  const key = normKey(rawName);
  if (!key) return [];
  const idx = buildNameLookupIndex(registry);
  const byName = idx.byNameKey.get(key) || [];
  if (byName.length) return byName;
  return idx.byAliasKey.get(key) || [];
}

// ===== 从现有数据一次性迁移建表（P1 核心） =====

/**
 * 从收集到的 { name, aliases }[] 列表构建 registry。
 *
 * 聚类策略（保守，宁可多建 id 也不错并）：
 *   normalizeCharacterName 后严格相等（lowercase）才合并为一个 record。
 *
 * primaryName 选取（关键，影响发给 AI 的名字稳定性）：
 *   优先取 preferredNames 命中的字面（通常是 characterMemories 里已确立的主名，
 *   即用户/AI 已在用的名字），避免迁移后"主名变排序先到的陌生名字"。
 *   preferredNames 未命中时才取 candidates 第一个。
 *
 * @param entries 来自 getCharacterNameEntries 的收集结果（13 处存储点的并集）
 * @param preferredNames 优先主名集合（归一化后的 characterMemories 主名），可选
 */
export function buildRegistryFromEntries(
  entries: CharacterNameEntry[],
  preferredNames?: Set<string>,
  nowIso: string = new Date().toISOString(),
): CharacterRegistry {
  const registry: CharacterRegistry = { records: {}, version: 1 };
  const existingIds = new Set<string>();
  // 聚类：归一化同 key 的合并；candidates 记录所有字面候选（用于 primaryName 选取）
  const byNorm = new Map<string, { candidates: string[]; aliases: Set<string> }>();

  for (const entry of entries) {
    const name = String(entry.name || '').trim();
    if (!name) continue;
    const key = normKey(name);
    if (!key) continue;
    let bucket = byNorm.get(key);
    if (!bucket) {
      bucket = { candidates: [], aliases: new Set() };
      byNorm.set(key, bucket);
    }
    bucket.candidates.push(name);
    for (const a of entry.aliases || []) {
      const alias = String(a || '').trim();
      if (alias && !MEANINGLESS_ALIASES.has(alias)) bucket.aliases.add(alias);
    }
  }

  for (const { candidates, aliases } of byNorm.values()) {
    if (candidates.length === 0) continue;
    // primaryName 选取：优先 preferredNames 命中（用户/AI 已在用的主名），否则取第一个
    let primaryName = candidates[0];
    if (preferredNames && preferredNames.size > 0) {
      for (const c of candidates) {
        if (preferredNames.has(normKey(c))) { primaryName = c; break; }
      }
    }
    // 其余字面候选进 aliases（字面不同但归一化同的也记入，保证匹配覆盖）
    for (const c of candidates) {
      if (c !== primaryName) aliases.add(c);
    }
    const id = generateCharacterId(primaryName, existingIds);
    existingIds.add(id);
    registry.records[id] = {
      id,
      primaryName,
      aliases: cleanCharacterAliases([...aliases], primaryName),
      status: 'active',
      createdAt: nowIso,
      lastSeenAt: nowIso,
      source: 'migrated',
    };
  }
  return registry;
}

// ===== 改名 / 合并（P4 用，P1 先占位导出，确保接口稳定） =====

/**
 * 改名：只动 registry 一处。旧主名自动进 aliases。
 * P4 时 renameCharacter 重写为调用此函数。
 */
export function renameInRegistry(
  registry: CharacterRegistry,
  id: string,
  newPrimaryName: string,
): boolean {
  const rec = registry.records[id];
  if (!rec || rec.status === 'merged') return false;
  const newName = String(newPrimaryName || '').trim();
  if (!newName || newName === rec.primaryName) return false;
  const oldName = rec.primaryName;
  rec.aliases = cleanCharacterAliases([...rec.aliases, oldName], newName);
  rec.primaryName = newName;
  return true;
}

/**
 * 合并：source 并入 target。source 的主名+别名进 target 别名，source 标记 merged。
 * P4 时 mergeCharacters 重写为调用此函数。
 */
export function mergeInRegistry(
  registry: CharacterRegistry,
  targetId: string,
  sourceId: string,
): boolean {
  if (targetId === sourceId) return false;
  const target = registry.records[targetId];
  const source = registry.records[sourceId];
  if (!target || !source || source.status === 'merged') return false;
  target.aliases = cleanCharacterAliases(
    [...target.aliases, source.primaryName, ...source.aliases],
    target.primaryName,
  );
  source.status = 'merged';
  source.mergedInto = targetId;
  return true;
}

/**
 * 沿 mergedInto 链找真身 record。
 * 合并后所有引用 source id 的地方都应通过此函数定位真身。
 */
export function resolveTrueRecord(
  registry: CharacterRegistry,
  id: string,
): CharacterRecord | undefined {
  let rec = registry.records[id];
  if (!rec) return undefined;
  let guard = 0;
  while (rec.status === 'merged' && rec.mergedInto && guard < 32) {
    rec = registry.records[rec.mergedInto];
    if (!rec) return undefined;
    guard++;
  }
  return rec;
}

// ===== P2 写入收口：resolve 或挂起待仲裁 =====

export type ResolveStatus = 'resolved' | 'ambiguous' | 'unknown';

export interface ResolveResult {
  status: ResolveStatus;
  /** status=resolved 时，命中的真身 record（已沿 mergedInto 解过） */
  record?: CharacterRecord;
  /** status=ambiguous/unknown 时的候选 id 列表（unknown 时为空） */
  candidateIds: string[];
  candidateNames: string[];
}

/**
 * 用名字解析到角色 record，三态结果：
 *   resolved   — 命中唯一 record（沿 mergedInto 找过真身）
 *   ambiguous  — 命中多个候选（需 P5 人工/规则仲裁）
 *   unknown    — 未命中任何已知角色（旧逻辑会 fallback 新建，P2 改为挂入 pendingUnresolved）
 *
 * 这是 P2 止血核心：AI 输出的名字稍有差异时不再无脑新建角色，
 * 而是明确区分"已知/歧义/未知"，交给上层决定怎么处理。
 */
export function resolveOrPending(
  rawName: string,
  registry: CharacterRegistry | null | undefined,
): ResolveResult {
  const candidates = resolveNameToRecords(rawName, registry);
  if (candidates.length === 0) {
    return { status: 'unknown', candidateIds: [], candidateNames: [] };
  }
  if (candidates.length === 1) {
    // 沿 mergedInto 链找真身（理论上 resolveNameToRecords 已过滤 merged，双保险）
    const trueRec = resolveTrueRecord(registry!, candidates[0].id) || candidates[0];
    return {
      status: 'resolved',
      record: trueRec,
      candidateIds: [trueRec.id],
      candidateNames: [trueRec.primaryName],
    };
  }
  return {
    status: 'ambiguous',
    candidateIds: candidates.map(c => c.id),
    candidateNames: candidates.map(c => c.primaryName),
  };
}

/** 待仲裁条目（持久化到 chatData.pendingUnresolved） */
export interface PendingResolution {
  rawName: string;
  candidateIds: string[];
  candidateNames: string[];
  /** 首次出现时间 */
  firstSeenAt: string;
  /** 最近出现时间 */
  lastSeenAt: string;
  /** 累计出现次数（同 rawName 多次出现只累加 count，不重复入队） */
  count: number;
  /** 最近一次出现的上下文片段（便于人工判断归属） */
  snippet?: string;
}

/** 统计信息（调试/日志用） */
export function getRegistryStats(registry: CharacterRegistry | null | undefined): {
  total: number;
  active: number;
  merged: number;
  ignored: number;
} {
  const stats = { total: 0, active: 0, merged: 0, ignored: 0 };
  if (!registry?.records) return stats;
  for (const rec of Object.values(registry.records)) {
    stats.total++;
    if (rec.status === 'active') stats.active++;
    else if (rec.status === 'merged') stats.merged++;
    else if (rec.status === 'ignored') stats.ignored++;
  }
  return stats;
}
