import { logError, logInfo, logWarn } from '../utils/logger';

export type WorldBookTagKind = 'world' | 'character';

export interface WorldBookEntryInfo {
  key: string;
  book: string;
  uid?: number;
  entryName?: string;
  content?: string;
}

export interface WorldBookTagBinding {
  id: string;
  book: string;
  uid?: number;
  entryName: string;
  displayKey: string;
  kind: WorldBookTagKind;
  tagId: number;
  tagLabel: string;
  tagName: string;
  characterName?: string;
  meaning: string;
  updatedAt: string;
  lastAppliedAt?: string;
  lastError?: string;
}

export interface ApplyWorldBookTagResult {
  ok: boolean;
  applied: number;
  errors: Array<{ bindingId: string; message: string }>;
}

function getApi(): any {
  const g = globalThis as any;
  return g.TavernHelper || g;
}

export function hasWorldBookTagApi(): boolean {
  const api = getApi();
  return typeof api.updateWorldbookWith === 'function';
}

export function normalizeTagPart(input: string): string {
  const safe = (input || '')
    .trim()
    .replace(/[<>"'`/\\\s]+/g, '_')
    .replace(/[^\w\u4e00-\u9fa5]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || '未命名';
}

export function buildWorldTagName(tagId: number, label: string): string {
  return `tag_id${Math.max(1, Math.floor(tagId || 1))}_${normalizeTagPart(label || '世界背景')}`;
}

export function buildCharacterTagName(characterName: string, tagId: number, label: string): string {
  return `${normalizeTagPart(characterName || '角色')}_id${Math.max(1, Math.floor(tagId || 1))}_${normalizeTagPart(label || '设定')}`;
}

export function buildWorldBookBindingId(entry: Pick<WorldBookEntryInfo, 'book' | 'uid' | 'key' | 'entryName'>): string {
  const source = entry.uid !== undefined ? `uid:${entry.uid}` : `name:${entry.entryName || entry.key}`;
  return `${entry.book || '未分组'}::${source}`;
}

function stripOuterManagedTag(content: string): string {
  const text = (content || '').trim();
  const match = text.match(
    /^<((?:tag_id\d+|[\w\u4e00-\u9fa5]+_id\d+)_[\w\u4e00-\u9fa5]+)>\s*([\s\S]*?)\s*<\/\1>$/u,
  );
  return match ? match[2].trim() : text;
}

export function wrapTaggedContent(binding: WorldBookTagBinding, content: string): string {
  const body = stripOuterManagedTag(content);
  return `<${binding.tagName}>\n${body}\n</${binding.tagName}>`;
}

function matchesEntry(entry: any, binding: WorldBookTagBinding): boolean {
  if (binding.uid !== undefined && Number(entry?.uid) === binding.uid) return true;
  const names = [
    entry?.name,
    entry?.comment,
    Array.isArray(entry?.key) ? entry.key.join(', ') : entry?.key,
  ]
    .filter(Boolean)
    .map((v: any) => String(v));
  return names.includes(binding.entryName) || names.includes(binding.displayKey);
}

function applyBindingToEntry(entry: any, binding: WorldBookTagBinding): any {
  const positionType = binding.kind === 'world'
    ? 'before_character_definition'
    : 'after_character_definition';
  return {
    ...entry,
    enabled: true,
    content: wrapTaggedContent(binding, String(entry?.content || '')),
    position: {
      ...(entry?.position || {}),
      type: positionType,
      order: typeof entry?.position?.order === 'number' ? entry.position.order : 100,
    },
    extra: {
      ...(entry?.extra || {}),
      zhinoTagBinding: {
        bindingId: binding.id,
        kind: binding.kind,
        tagName: binding.tagName,
        meaning: binding.meaning,
        updatedAt: binding.updatedAt,
      },
    },
  };
}

export async function applyWorldBookTagBindings(bindings: WorldBookTagBinding[]): Promise<ApplyWorldBookTagResult> {
  const api = getApi();
  const errors: ApplyWorldBookTagResult['errors'] = [];
  let applied = 0;

  if (!hasWorldBookTagApi()) {
    return { ok: false, applied: 0, errors: [{ bindingId: '__api__', message: '当前环境没有可用的世界书写回 API' }] };
  }

  const valid = (bindings || []).filter(b => b.book && b.tagName && b.entryName);
  const byBook = new Map<string, WorldBookTagBinding[]>();
  for (const binding of valid) {
    if (!byBook.has(binding.book)) byBook.set(binding.book, []);
    byBook.get(binding.book)!.push(binding);
  }

  for (const [book, list] of byBook.entries()) {
    try {
      await api.updateWorldbookWith(
        book,
        (entries: any[]) => {
          const next = entries.map(entry => {
            const binding = list.find(item => matchesEntry(entry, item));
            if (!binding) return entry;
            applied += 1;
            return applyBindingToEntry(entry, binding);
          });

          for (const binding of list) {
            const found = entries.some(entry => matchesEntry(entry, binding));
            if (!found) {
              errors.push({ bindingId: binding.id, message: `在世界书「${book}」中找不到条目「${binding.entryName}」` });
            }
          }

          return next;
        },
        { render: 'immediate' },
      );
    } catch (error: any) {
      const message = error?.message || String(error);
      for (const binding of list) {
        errors.push({ bindingId: binding.id, message: `世界书「${book}」写回失败：${message}` });
      }
      logError('世界书标签', '写回失败', message);
    }
  }

  if (applied > 0) {
    logInfo('世界书标签', `已写回 ${applied} 个条目`);
  } else if (errors.length === 0) {
    logWarn('世界书标签', '没有可写回的条目');
  }

  return { ok: errors.length === 0, applied, errors };
}

export function buildWorldBookTagIndex(bindings: WorldBookTagBinding[]): string {
  const active = (bindings || []).filter(b => b.tagName && b.meaning);
  if (active.length === 0) return '';

  const world = active.filter(b => b.kind === 'world');
  const characters = active.filter(b => b.kind === 'character');
  const lines: string[] = [];

  lines.push('<worldbook_tag_index>');
  lines.push('以下是用户手动绑定的世界书标签索引。看到同名标签时，优先按这里的含义召回对应设定；索引用于辅助思考，不要直接输出。');

  if (world.length > 0) {
    lines.push('');
    lines.push('<before_character_definition_tags>');
    for (const binding of world) {
      lines.push(`- <${binding.tagName}>：${binding.meaning}`);
    }
    lines.push('</before_character_definition_tags>');
  }

  if (characters.length > 0) {
    lines.push('');
    lines.push('<after_character_definition_tags>');
    for (const binding of characters) {
      const owner = binding.characterName ? `${binding.characterName}；` : '';
      lines.push(`- <${binding.tagName}>：${owner}${binding.meaning}`);
    }
    lines.push('</after_character_definition_tags>');
  }

  lines.push('</worldbook_tag_index>');
  return lines.join('\n');
}

let currentWorldBookTagIndexInjection: { uninject: () => void } | null = null;

export function injectWorldBookTagIndex(bindings: WorldBookTagBinding[]): void {
  if (currentWorldBookTagIndexInjection) {
    currentWorldBookTagIndexInjection.uninject();
    currentWorldBookTagIndexInjection = null;
  }

  const content = buildWorldBookTagIndex(bindings);
  if (!content) return;

  currentWorldBookTagIndexInjection = injectPrompts([
    {
      id: 'zhino_worldbook_tag_index',
      position: 'in_chat',
      depth: 0,
      role: 'system',
      content,
      should_scan: false,
    },
  ]);
}

export function removeWorldBookTagIndexInjection(): void {
  if (currentWorldBookTagIndexInjection) {
    currentWorldBookTagIndexInjection.uninject();
    currentWorldBookTagIndexInjection = null;
  }
}
