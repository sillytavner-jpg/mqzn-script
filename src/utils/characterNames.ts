export interface CharacterNameEntry {
  name: string;
  aliases?: string[];
}

export interface CharacterNameIndex {
  entries: CharacterNameEntry[];
  byLookupKey: Map<string, string>;
}

export function normalizeCharacterName(name?: string): string {
  return String(name || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s*\(.+?\)\s*$/g, '')
    .trim();
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
