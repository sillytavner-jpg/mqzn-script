import type { WorldBookEntryInfo } from './worldBookTags';

export type SavedWorldBookEntry = WorldBookEntryInfo & { content: string };

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeUid(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function buildWorldBookSelectionId(entry: Partial<WorldBookEntryInfo> | undefined): string {
  if (!entry) return '';
  const book = normalizeText(entry.book);
  const uid = normalizeUid(entry.uid);
  const entryName = normalizeText(entry.entryName);
  const key = normalizeText(entry.key);
  if (book && uid !== undefined) return `${book}::uid:${uid}`;
  if (book && entryName) return `${book}::name:${entryName}`;
  return key;
}

function matchesSelectedKey(entry: Partial<WorldBookEntryInfo> | undefined, selectedKey: string): boolean {
  if (!entry) return false;
  const selected = normalizeText(selectedKey);
  if (!selected) return false;
  return selected === normalizeText(entry.key)
    || selected === buildWorldBookSelectionId(entry)
    || selected === normalizeText(entry.entryName);
}

function findEntryBySelectedKey(
  entries: Array<Partial<SavedWorldBookEntry>> | undefined,
  selectedKey: string,
): Partial<SavedWorldBookEntry> | undefined {
  return (entries || []).find(entry => matchesSelectedKey(entry, selectedKey));
}

export function getEffectiveWorldBookKeys(
  selectedKeys: string[] | undefined,
  savedEntries: Array<Partial<SavedWorldBookEntry>> | undefined,
): string[] {
  const explicit = (selectedKeys || []).map(normalizeText).filter(Boolean);
  if (explicit.length > 0) return explicit;
  return (savedEntries || []).map(entry => normalizeText(entry.key)).filter(Boolean);
}

export function hydrateSelectedWorldBookEntries(
  selectedKeys: string[] | undefined,
  savedEntries: Array<Partial<SavedWorldBookEntry>> | undefined,
  rawCache: Array<Partial<SavedWorldBookEntry>> | undefined,
): SavedWorldBookEntry[] {
  const keys = getEffectiveWorldBookKeys(selectedKeys, savedEntries);
  const result: SavedWorldBookEntry[] = [];
  const seen = new Set<string>();

  for (const selectedKey of keys) {
    const fromCache = findEntryBySelectedKey(rawCache, selectedKey);
    const fromSaved = findEntryBySelectedKey(savedEntries, selectedKey);
    const source = fromCache || fromSaved;
    if (!source) continue;

    const content = normalizeText(fromCache?.content) || normalizeText(fromSaved?.content);
    if (!content) continue;

    const entry: SavedWorldBookEntry = {
      key: normalizeText(source.key) || selectedKey,
      book: normalizeText(source.book),
      uid: normalizeUid(source.uid),
      entryName: normalizeText(source.entryName) || normalizeText(source.key) || selectedKey,
      content,
    };
    const id = buildWorldBookSelectionId(entry) || entry.key;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(entry);
  }

  return result;
}
