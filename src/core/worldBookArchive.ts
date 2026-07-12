/**
 * 世界书存档模块 (WorldBook Archive)
 * 职责：把聊天数据(chatData)序列化压缩后存到世界书里，作为手动存档/读档手段。
 * 每个聊天对应一本世界书，名字 = "智脑存档-" + 角色名 + "-" + 聊天id。
 * 一本世界书内可存多个存档快照（按 archiveId 分组），每个可独立读取/删除。
 * 存档 = 纯备份，不影响内存(allChatsData)；读档 = 从世界书恢复覆盖当前 chatData。
 * 依赖 JS-Slash-Runner 的 TavernHelper worldbook 写入 API（createOrReplaceWorldbook 等）。
 */

import LZString from 'lz-string';
import type { ChatData } from '../stores/mainStore';
import { logInfo, logWarn, logError } from '../utils/logger';

// ========== TavernHelper API 桥接 ==========

/** 获取 TavernHelper 对象（展平到 globalThis 或挂在 TavernHelper 上） */
function getApi(): any {
  const g = globalThis as any;
  return g.TavernHelper || g;
}

/** 检查世界书写入 API 是否可用 */
export function hasWorldBookApi(): boolean {
  const api = getApi();
  return typeof api.createOrReplaceWorldbook === 'function'
    && typeof api.getWorldbook === 'function'
    && typeof api.deleteWorldbook === 'function';
}

// ========== 命名 ==========

/** 存档世界书名前缀，用于区分存档世界书与普通世界书 */
const ARCHIVE_PREFIX = '智脑存档-';

/**
 * 把聊天id转成安全的世界书名。
 * chatId 格式本身是 "角色名 - 时间戳"（酒馆 getCurrentChatId 返回值），
 * 已含角色名，不再前置 charName，避免重复。
 */
export function buildArchiveName(charName: string, chatId: string): string {
  const safeChat = (chatId || '').replace(/[\\/:*?"<>|\s]/g, '_');
  if (safeChat) {
    return `${ARCHIVE_PREFIX}${safeChat}`;
  }
  // chatId 为空时兜底用角色名
  const safeChar = (charName || '未知角色').replace(/[\\/:*?"<>|\s]/g, '_');
  return `${ARCHIVE_PREFIX}${safeChar}`;
}

/** 获取当前角色卡名（与 OverviewTab 一致，走 SillyTavern.name2 / getContext().name2） */
export function getCurrentCharName(): string {
  try {
    const s: any = (typeof SillyTavern !== 'undefined') ? SillyTavern : (globalThis as any).SillyTavern;
    if (s && typeof s.name2 === 'string' && s.name2) return s.name2;
    // 兜底：走 getContext（与 OverviewTab 一致）
    if (s && typeof s.getContext === 'function') {
      const ctx = s.getContext();
      if (ctx && typeof ctx.name2 === 'string' && ctx.name2) return ctx.name2;
    }
  } catch { /* ignore */ }
  return '';
}

// ========== 存档元数据 ==========

export interface ArchiveMeta {
  archiveId: string;
  charName: string;
  chatId: string;
  savedAt: string;
  totalShards: number;
  originalSize: number;
  compressedSize: number;
  version: string;
  /** 用户自定义存档名（可选，为空则显示 archiveId） */
  customName?: string;
  /** 存档时的最新楼层号（可选） */
  savedAtFloor?: number;
}

export interface ArchiveListItem {
  archiveId: string;
  savedAt: string;
  originalSize: number;
  compressedSize: number;
  /** 用户自定义存档名（可选） */
  customName?: string;
  /** 存档时的最新楼层号（可选） */
  savedAtFloor?: number;
}

/** 最大保留存档数，超过自动删最旧的 */
const MAX_ARCHIVES = 10;

/** 生成 archiveId（时间戳简写，MMDD-HHMMSS） */
function makeArchiveId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ========== 条目 comment 标记 ==========

const INDEX_PREFIX = '存档索引@';
const SHARD_PREFIX = '存档分片@';

/** 从条目 comment 提取 archiveId */
function extractArchiveId(comment: string): string | null {
  if (!comment) return null;
  if (comment.startsWith(INDEX_PREFIX)) return comment.slice(INDEX_PREFIX.length);
  if (comment.startsWith(SHARD_PREFIX)) {
    // 格式：存档分片@archiveId i/N
    const rest = comment.slice(SHARD_PREFIX.length);
    const spaceIdx = rest.indexOf(' ');
    return spaceIdx > 0 ? rest.slice(0, spaceIdx) : rest;
  }
  return null;
}

// ========== 序列化 / 反序列化 ==========

/** 每个分片的最大字符数（~80KB，避免单条目过大） */
const SHARD_SIZE = 80000;

/**
 * 把 chatData 序列化成一组世界书条目（一个存档快照）：
 * - 索引条目：comment = "存档索引@{archiveId}"，content = 元数据 JSON
 * - 分片条目：comment = "存档分片@{archiveId} {i}/{N}"，content = base64 压缩片段
 * 所有条目 disable=true，确保不会被酒馆注入到 AI 上下文。
 */
function serializeArchive(chatData: ChatData, charName: string, chatId: string, archiveId: string, customName?: string, savedAtFloor?: number): { entries: any[]; meta: ArchiveMeta } {
  const json = JSON.stringify(chatData);
  // 用 base64 压缩，输出全 ASCII 字符（A-Za-z0-9+/=），整洁可读不乱码
  const compressed = LZString.compressToBase64(json);

  const totalShards = Math.max(1, Math.ceil(compressed.length / SHARD_SIZE));
  const entries: any[] = [];

  const meta: ArchiveMeta = {
    archiveId,
    charName,
    chatId,
    savedAt: new Date().toISOString(),
    totalShards,
    originalSize: json.length,
    compressedSize: compressed.length,
    version: '2',
    customName: customName || undefined,
    savedAtFloor: savedAtFloor !== undefined ? savedAtFloor : undefined,
  };
  // 索引条目
  entries.push({
    name: `${INDEX_PREFIX}${archiveId}`,
    comment: `${INDEX_PREFIX}${archiveId}`,
    content: JSON.stringify(meta),
    disable: true,
    constant: false,
    selective: true,
    keys: [],
  });

  // 数据分片
  for (let i = 0; i < totalShards; i++) {
    const shard = compressed.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
    entries.push({
      name: `${SHARD_PREFIX}${archiveId} ${i + 1}/${totalShards}`,
      comment: `${SHARD_PREFIX}${archiveId} ${i + 1}/${totalShards}`,
      content: shard,
      disable: true,
      constant: false,
      selective: true,
      keys: [],
    });
  }

  return { entries, meta };
}

/** 从世界书条目列表中提取指定 archiveId 的 chatData */
function deserializeArchive(entries: any[], archiveId: string): { data: ChatData | null; meta: ArchiveMeta | null } {
  // 收集该 archiveId 的分片
  const shards: Map<number, string> = new Map();
  let meta: ArchiveMeta | null = null;

  for (const e of entries) {
    const c = e?.comment || e?.name || '';
    if (c === `${INDEX_PREFIX}${archiveId}`) {
      try { meta = JSON.parse(e.content || '{}'); } catch { /* ignore */ }
      continue;
    }
    const shardMatch = c.match(new RegExp(`^${SHARD_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${archiveId} (\\d+)/(\\d+)$`));
    if (shardMatch) {
      const idx = parseInt(shardMatch[1], 10);
      shards.set(idx, e?.content || '');
    }
  }

  if (!meta) {
    logWarn('存档', `未找到存档 ${archiveId} 的索引`);
    return { data: null, meta: null };
  }

  if (!meta.totalShards || meta.totalShards < 1) {
    logWarn('存档', `存档 ${archiveId} 元数据无效`);
    return { data: null, meta };
  }

  // 按序拼接分片
  let compressed = '';
  for (let i = 1; i <= meta.totalShards; i++) {
    const shard = shards.get(i);
    if (shard === undefined) {
      logWarn('存档', `存档 ${archiveId} 缺少分片 ${i}/${meta.totalShards}`);
      return { data: null, meta };
    }
    compressed += shard;
  }

  // 解压并还原（base64）
  try {
    const json = LZString.decompressFromBase64(compressed);
    if (!json) {
      logWarn('存档', `存档 ${archiveId} 解压失败，数据可能损坏`);
      return { data: null, meta };
    }
    const data = JSON.parse(json) as ChatData;
    return { data, meta };
  } catch (e) {
    logError('存档', `存档 ${archiveId} 反序列化失败`, String(e));
    return { data: null, meta };
  }
}

/** 从所有条目中提取存档列表（按时间倒序） */
function extractArchiveList(entries: any[]): ArchiveListItem[] {
  const list: ArchiveListItem[] = [];
  for (const e of entries) {
    const c = e?.comment || e?.name || '';
    if (c.startsWith(INDEX_PREFIX)) {
      try {
        const meta = JSON.parse(e.content || '{}');
        if (meta.archiveId) {
          list.push({
            archiveId: meta.archiveId,
            savedAt: meta.savedAt || '',
            originalSize: meta.originalSize || 0,
            compressedSize: meta.compressedSize || 0,
            customName: meta.customName || undefined,
            savedAtFloor: meta.savedAtFloor !== undefined ? meta.savedAtFloor : undefined,
          });
        }
      } catch { /* ignore */ }
    }
  }
  // 按 savedAt 倒序（最新在前）
  list.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  return list;
}

// ========== 公开 API ==========

export interface ArchiveResult {
  ok: boolean;
  name: string;
  archiveId?: string;
  meta?: ArchiveMeta;
  error?: string;
}

/** 存档：把 chatData 追加到世界书（一本世界书多个存档快照） */
export async function archiveChatData(
  chatData: ChatData,
  charName?: string,
  chatId?: string,
  customName?: string,
  savedAtFloor?: number,
): Promise<ArchiveResult> {
  if (!hasWorldBookApi()) {
    return { ok: false, name: '', error: '世界书写入 API 不可用，请确认酒馆助手扩展已启用' };
  }

  const cName = charName ?? getCurrentCharName();
  const cId = chatId ?? '';
  const name = buildArchiveName(cName, cId);
  const archiveId = makeArchiveId();

  try {
    const { entries: newEntries, meta } = serializeArchive(chatData, cName, cId, archiveId, customName, savedAtFloor);
    const api = getApi();

    // 确保世界书存在（不存在才创建，存在则不动——避免覆盖已有存档）
    try {
      const existing = await api.getWorldbook(name);
      if (!existing || !Array.isArray(existing)) {
        await api.createOrReplaceWorldbook(name, [], { render: 'immediate' });
      }
    } catch {
      // getWorldbook 抛异常说明世界书不存在，创建
      await api.createOrReplaceWorldbook(name, [], { render: 'immediate' });
    }

    // 读-改-写：追加新存档到已有世界书，不覆盖已有存档
    await api.updateWorldbookWith(name, (existing: any[]) => {
      let combined = Array.isArray(existing) ? [...existing] : [];
      // 清理掉旧格式条目（v1 用"存档索引"/"存档分片 i/N"无 archiveId 的格式）
      combined = combined.filter((e: any) => {
        const c = e?.comment || e?.name || '';
        return c.startsWith(INDEX_PREFIX) || c.startsWith(SHARD_PREFIX);
      });
      // 追加新存档条目
      combined.push(...newEntries);
      // 超过上限：删最旧的存档
      const currentList = extractArchiveList(combined);
      if (currentList.length > MAX_ARCHIVES) {
        const toRemove = currentList.slice(MAX_ARCHIVES); // 这些是要删的（最旧的）
        const removeIds = new Set(toRemove.map(a => a.archiveId));
        combined = combined.filter((e: any) => {
          const id = extractArchiveId(e?.comment || e?.name || '');
          return !id || !removeIds.has(id);
        });
      }
      return combined;
    }, { render: 'immediate' });

    logInfo('存档', `已存档 ${archiveId} 到世界书「${name}」（${meta.totalShards} 片，${meta.originalSize}→${meta.compressedSize} 字）`);
    return { ok: true, name, archiveId, meta };
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    logError('存档', '存档失败', msg);
    return { ok: false, name, error: msg };
  }
}

export interface RestoreResult {
  ok: boolean;
  data: ChatData | null;
  meta: ArchiveMeta | null;
  error?: string;
}

/** 读档：从世界书恢复指定 archiveId 的 chatData */
export async function restoreChatData(
  archiveId: string,
  charName?: string,
  chatId?: string,
): Promise<RestoreResult> {
  if (!hasWorldBookApi()) {
    return { ok: false, data: null, meta: null, error: '世界书写入 API 不可用' };
  }

  const cName = charName ?? getCurrentCharName();
  const cId = chatId ?? '';
  const name = buildArchiveName(cName, cId);

  try {
    const api = getApi();
    const entries = await api.getWorldbook(name);
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return { ok: false, data: null, meta: null, error: `未找到存档世界书「${name}」` };
    }
    const { data, meta } = deserializeArchive(entries, archiveId);
    if (!data) {
      return { ok: false, data: null, meta, error: `存档 ${archiveId} 数据损坏或解析失败` };
    }
    logInfo('存档', `已从世界书「${name}」读取存档 ${archiveId}（${meta?.totalShards || 0} 片）`);
    return { ok: true, data, meta };
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    logError('存档', '读档失败', msg);
    return { ok: false, data: null, meta: null, error: msg };
  }
}

/** 列出当前聊天世界书里的所有存档（按时间倒序） */
export async function listArchives(
  charName?: string,
  chatId?: string,
): Promise<ArchiveListItem[]> {
  if (!hasWorldBookApi()) return [];
  const cName = charName ?? getCurrentCharName();
  const cId = chatId ?? '';
  const name = buildArchiveName(cName, cId);
  try {
    const api = getApi();
    const entries = await api.getWorldbook(name);
    if (!entries || !Array.isArray(entries)) return [];
    return extractArchiveList(entries);
  } catch {
    return [];
  }
}

/** 删除指定存档（从世界书移除该 archiveId 的所有条目） */
export async function deleteArchive(
  archiveId: string,
  charName?: string,
  chatId?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasWorldBookApi()) {
    return { ok: false, error: '世界书写入 API 不可用' };
  }
  const cName = charName ?? getCurrentCharName();
  const cId = chatId ?? '';
  const name = buildArchiveName(cName, cId);
  try {
    const api = getApi();
    await api.updateWorldbookWith(name, (existing: any[]) => {
      if (!Array.isArray(existing)) return [];
      return existing.filter((e: any) => {
        const id = extractArchiveId(e?.comment || e?.name || '');
        return id !== archiveId;
      });
    }, { render: 'immediate' });
    logInfo('存档', `已删除存档 ${archiveId}（世界书「${name}」）`);
	    return { ok: true };
	  } catch (e) {
	    return { ok: false, error: (e as Error)?.message || String(e) };
	  }
	}

	/** 修改指定存档的自定义名称 */
	export async function updateArchiveName(
	  archiveId: string,
	  customName: string,
	  charName?: string,
	  chatId?: string,
	): Promise<{ ok: boolean; error?: string }> {
	  if (!hasWorldBookApi()) {
	    return { ok: false, error: '世界书写入 API 不可用' };
	  }
	  const cName = charName ?? getCurrentCharName();
	  const cId = chatId ?? '';
	  const name = buildArchiveName(cName, cId);
	  try {
	    const api = getApi();
	    await api.updateWorldbookWith(name, (existing: any[]) => {
	      if (!Array.isArray(existing)) return [];
	      return existing.map((e: any) => {
	        const c = e?.comment || e?.name || '';
	        if (c.startsWith(INDEX_PREFIX) && extractArchiveId(c) === archiveId) {
	          const meta = JSON.parse(e.content || '{}');
	          meta.customName = customName || undefined;
	          return { ...e, content: JSON.stringify(meta) };
	        }
	        return e;
	      });
	    }, { render: 'immediate' });
	    logInfo('存档', `已更新存档 ${archiveId} 名称为「${customName || '(清除)'}」`);
	    return { ok: true };
	  } catch (e) {
	    return { ok: false, error: (e as Error)?.message || String(e) };
	  }
	}

	/** 检查当前聊天的世界书是否存在且有存档 */
export async function hasArchive(charName?: string, chatId?: string): Promise<boolean> {
  const list = await listArchives(charName, chatId);
  return list.length > 0;
}
