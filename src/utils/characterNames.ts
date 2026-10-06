export interface CharacterNameEntry {
  name: string;
  aliases?: string[];
}

export interface CharacterNameIndex {
  entries: CharacterNameEntry[];
  byLookupKey: Map<string, string>;
}

/**
 * 角色名归一化（判重 / 匹配用的 key 口径）。**不用于显示**，只用于比较。
 *
 * 处理三件事：
 *   1. 去零宽字符（AI 输出常夹带不可见字符，会让「同一个名字」变成两个 key）
 *   2. 剥末尾括号注释：半角 () / 全角（）/ 半角 [] / 全角【】
 *      —— AI 常输出「清月（师尊）」「王芳(化名)」这类带注释的名字；
 *         原先只认半角圆括号，导致「王芳（化名）」与「王芳」判成两个角色（重复/认错人）
 *   3. 去首尾空白
 *
 * ⚠️ 空值保护：整个名字被一组括号包住时（如「【清月】」），末尾剥离会得到空串 ——
 *    此时保留原值。否则所有此类名字都会被归一化成空 key，互相判重（原实现有此隐患）。
 */
export function normalizeCharacterName(name?: string): string {
  const raw = String(name || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
  if (!raw) return '';
  const stripped = raw
    .replace(/\s*(?:\([^)]*\)|（[^）]*）|\[[^\]]*\]|【[^】]*】)\s*$/, '')
    .trim();
  return stripped || raw;
}

function lookupKeys(name?: string): string[] {
  const raw = String(name || '').trim();
  const normalized = normalizeCharacterName(raw);
  const lower = raw.toLowerCase();
  const normalizedLower = normalized.toLowerCase();
  return [...new Set([raw, normalized, lower, normalizedLower].filter(Boolean))];
}

export const MEANINGLESS_ALIASES = new Set(['无', '无', 'None', 'none', 'N/A', 'n/a', 'null', 'undefined', '0', '-']);

export function cleanCharacterAliases(aliases: string[] | undefined, characterName: string): string[] {
  const canonical = normalizeCharacterName(characterName);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of aliases || []) {
    const alias = String(raw || '').trim();
    if (!alias) continue;
    if (MEANINGLESS_ALIASES.has(alias)) continue;
    if (alias === characterName || normalizeCharacterName(alias) === canonical) continue;
    const key = normalizeCharacterName(alias).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(alias);
  }
  return result;
}

/** 归一化 lookup key（与 registry 的 normKey 口径一致：去括号 + lowercase） */
export function characterReservedKey(name?: string): string {
  return normalizeCharacterName(name).trim().toLowerCase();
}

/**
 * 防「认错人合并」守卫：从候选别名里剔除「已被其它独立角色占用的主名」。
 *
 * 动机（2026-10-06 玩家反馈的死锁）：
 *   本系统以「名字字符串」为主键。AI 偶发把两个不同角色当成同一人的别名，
 *   写成 `{ name: "甲", aliases: ["乙"] }`。这个名字一旦被吸收成别名：
 *     · 角色列表只渲染主名 → 玩家看不到它（以为角色消失）
 *     · 新建查重连别名一起匹配 → 拒绝创建（提示「名称或别名已存在」）
 *   而 registry 是名字解析的最高优先级且只在改名/合并时更新，配合起来会彻底锁死。
 *   本函数在**写入前**拦掉「把已确立的独立角色主名当别名吸收」这一个动作。
 *   非独立角色主名的普通别名（如「师尊」「月儿」）原样保留，不影响正常别名功能。
 *
 * @param aliases       候选别名（原值，未归一化）
 * @param selfName      当前条目自身的主名（永不被剔除）
 * @param reservedNames 已确立的独立角色主名 key 集合（由 characterReservedKey 生成）
 * @returns kept=保留的别名；stripped=被拦下的「实为独立角色」的别名
 */
export function stripReservedAliases(
  aliases: string[] | undefined,
  selfName: string,
  reservedNames?: Set<string>,
): { kept: string[]; stripped: string[] } {
  const list = (aliases || []).map(a => String(a || '').trim()).filter(Boolean);
  if (!reservedNames || reservedNames.size === 0) return { kept: list, stripped: [] };
  const self = characterReservedKey(selfName);
  const kept: string[] = [];
  const stripped: string[] = [];
  for (const alias of list) {
    const key = characterReservedKey(alias);
    if (key && key !== self && reservedNames.has(key)) {
      stripped.push(alias);
      continue;
    }
    kept.push(alias);
  }
  return { kept, stripped };
}

export function buildCharacterNameIndex(entries: CharacterNameEntry[]): CharacterNameIndex {
  const cleanedEntries = entries
    .map(entry => ({
      name: String(entry.name || '').trim(),
      aliases: cleanCharacterAliases(entry.aliases || [], entry.name),
    }))
    .filter(entry => entry.name);

  const byLookupKey = new Map<string, string>();
  for (const entry of cleanedEntries) {
    for (const value of [entry.name, ...(entry.aliases || [])]) {
      for (const key of lookupKeys(value)) {
        if (!byLookupKey.has(key)) byLookupKey.set(key, entry.name);
      }
    }
  }

  return { entries: cleanedEntries, byLookupKey };
}

export function resolveCharacterName(
  rawName: string | undefined,
  entries: CharacterNameEntry[],
  fallbackToNormalized = false,
): string {
  const raw = String(rawName || '').trim();
  if (!raw) return '';
  const index = buildCharacterNameIndex(entries);
  for (const key of lookupKeys(raw)) {
    const resolved = index.byLookupKey.get(key);
    if (resolved) return resolved;
  }
  return fallbackToNormalized ? normalizeCharacterName(raw) : raw;
}

export function scanCharacterNamesFromContent(
  content: string,
  knownCharacterNames: string[],
  characterEntries?: CharacterNameEntry[],
): string[] {
  const text = content || '';
  const entries = characterEntries && characterEntries.length > 0
    ? characterEntries
    : knownCharacterNames.map(name => ({ name, aliases: [] }));
  const index = buildCharacterNameIndex(entries);
  const matched = new Set<string>();

  for (const entry of index.entries) {
    const terms = [entry.name, normalizeCharacterName(entry.name), ...(entry.aliases || [])]
      .map(term => String(term || '').trim())
      .filter(term => term.length >= 2);
    if (terms.some(term => text.includes(term))) {
      matched.add(entry.name);
    }
  }

  return [...matched];
}

/**
 * 构建提示词中的「黑名单角色」提醒段（按分析类型定制话术）。
 * 黑名单角色已从智脑中移除，AI 在正文里可能仍看到其名字——按本次分析职责提醒其不要输出相关内容。
 * 无黑名单时返回空串（调用方直接拼接即可）。
 * @param blacklistedNames 黑名单角色名列表
 * @param hint 定制话术（不带角色名，如「本次不要生成以下角色的记忆」）
 */
export function buildBlacklistReminder(blacklistedNames: string[] | undefined, hint: string): string {
  const names = (blacklistedNames || []).filter(Boolean);
  if (names.length === 0) return '';
  return [
    '## 黑名单角色（已从智脑中移除）',
    `${hint}：${names.join('、')}`,
    '',
    '---',
    '',
  ].join('\n');
}
