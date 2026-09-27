/**
 * patch ↔ KnowledgeGraphDiff 桥接
 *
 * ── 为什么需要它 ──
 * 小总结原本输出的**本来就是一个 diff**（add / update / delete + 数组），
 * 由 index.ts 走 `applyKnowledgeGraphDiff(baseGraph, diff)` → `commitKnowledgeGraph` 落库。
 *
 * 改成 patch 输出后形状变了、但**语义没变**：
 *
 *   add.locations[i]   →  set /graph/loc/{name}        value={brief,aliases}
 *   add.characters[i]  →  set /graph/char/{name}       value="位置"（或对象）
 *   add.items[i]       →  set /graph/item/{name}       value={brief,owner,...}
 *   add.edges[i]       →  set /graph/edge/{type}:{from}>{to}
 *   update[i]          →  set /graph/{kind}/{id}.{field}
 *   delete[i]          →  del /graph/{kind}/{id}
 *
 * 本模块负责把这个形状换回去 —— 于是**完全复用现有写入链路**：
 * 判重、别名合并、离场降级、embedding 补算全都在 applyKnowledgeGraphDiff 里，零重写。
 * 这比「路由直接改图谱结构」风险低得多。
 *
 * ── 已知取舍 ──
 * 路径里的 key 既可能是 id 也可能是正式名，本模块统一当 `name` 传下去，
 * 由 applyKnowledgeGraphDiff 内部做「id 优先 → name/aliases 兜底」的解析。
 */

import type { KnowledgeGraphDiff } from './knowledgeGraph';

/** 与 stateDoc.PatchOp 结构一致（此处独立声明，避免 core 反向依赖 utils） */
export interface PatchLike {
  op: string;
  path: string;
  value?: unknown;
}

export interface BridgeResult {
  diff: KnowledgeGraphDiff;
  /** 未能识别的路径（留给日志，不影响其余条目） */
  errors: string[];
}

type GraphKind = 'loc' | 'item' | 'char' | 'edge';

/** 用户/模型可能写的各种叫法 → 标准 kind */
const KIND_ALIASES: Record<string, GraphKind> = {
  loc: 'loc', location: 'loc', locations: 'loc', 地点: 'loc',
  item: 'item', items: 'item', 物品: 'item',
  char: 'char', characters: 'char', character: 'char', 人物: 'char', 角色: 'char',
  edge: 'edge', edges: 'edge', 关系: 'edge',
};

function emptyDiff(): KnowledgeGraphDiff {
  return {
    add: { locations: [], items: [], edges: [], characters: [] },
    update: [],
    delete: [],
  };
}

function parseKind(raw: string): GraphKind | null {
  const t = String(raw || '').trim();
  return KIND_ALIASES[t] || KIND_ALIASES[t.toLowerCase()] || null;
}

/** 拆 `i_7c21.status` → { key: 'i_7c21', field: 'status' } */
function splitKeyField(seg: string): { key: string; field: string } {
  const i = seg.indexOf('.');
  if (i < 0) return { key: seg, field: '' };
  return { key: seg.slice(0, i), field: seg.slice(i + 1) };
}

function asObject(v: unknown): Record<string, any> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null;
}

function isDeleteOp(op: string): boolean {
  const v = String(op || '').trim().toLowerCase();
  return v === 'del' || v === 'delete' || v === 'remove';
}

/**
 * 把一批 patch ops 翻译回 KnowledgeGraphDiff。
 * 只处理 `/graph/**`，其余路径计入 errors（调用方决定怎么处理）。
 */
export function patchToGraphDiff(ops: PatchLike[]): BridgeResult {
  const diff = emptyDiff();
  const errors: string[] = [];
  const list = Array.isArray(ops) ? ops : [];

  for (const raw of list) {
    if (!raw || typeof raw.path !== 'string') {
      errors.push('条目结构非法');
      continue;
    }

    const segs = raw.path.split('/').map((s) => s.trim()).filter(Boolean);
    if (segs.length < 3 || segs[0] !== 'graph') {
      errors.push(`非图谱路径: ${raw.path}`);
      continue;
    }

    const kind = parseKind(segs[1]);
    if (!kind) {
      errors.push(`未知图谱类型: ${segs[1]}`);
      continue;
    }

    const { key, field } = splitKeyField(segs[2]);
    if (!key) {
      errors.push(`缺实体名: ${raw.path}`);
      continue;
    }

    // ── 删 ──
    if (isDeleteOp(raw.op)) {
      // 删整个实体 → diff.delete；删单个字段 → 转 update 置空（现有 diff 没有"删字段"）
      if (field) diff.update!.push({ id: key, field, value: '' });
      else diff.delete!.push(key);
      continue;
    }

    // ── 写字段（子路径）→ diff.update ──
    if (field) {
      diff.update!.push({ id: key, field, value: raw.value });
      continue;
    }

    // ── 写整个实体 → diff.add ──
    const obj = asObject(raw.value);

    if (kind === 'char') {
      // 角色最常见的用法是「只报位置」：value 直接是字符串
      if (typeof raw.value === 'string') {
        diff.add!.characters!.push({ name: key, location: raw.value });
      } else if (obj) {
        diff.add!.characters!.push({
          name: String(obj.name || key),
          location: String(obj.location || ''),
          aliases: obj.aliases,
        });
      } else {
        errors.push(`角色节点缺位置: ${raw.path}`);
      }
      continue;
    }

    if (kind === 'loc') {
      diff.add!.locations!.push({
        name: String(obj?.name || key),
        brief: typeof raw.value === 'string' ? raw.value : obj?.brief,
        aliases: obj?.aliases,
      });
      continue;
    }

    if (kind === 'item') {
      diff.add!.items!.push({
        name: String(obj?.name || key),
        brief: typeof raw.value === 'string' ? raw.value : obj?.brief,
        aliases: obj?.aliases,
        quantity: obj?.quantity,
        owner: obj?.owner,
        location: obj?.location,
        status: obj?.status,
        statusDetail: obj?.statusDetail,
        consumed: obj?.consumed,
      });
      continue;
    }

    // edge：无 name 概念，key 仅用于区分
    if (obj) {
      diff.add!.edges!.push({
        type: obj.type,
        from: String(obj.from || ''),
        to: String(obj.to || ''),
        detail: obj.detail,
      });
    } else {
      errors.push(`边缺对象值: ${raw.path}`);
    }
  }

  return { diff, errors };
}

/**
 * 反向：diff → patch（**仅用于往返一致性测试**，运行时不需要）。
 * 注意 add 节点把 name 挪进了 path，所以往返后 value 里不再有 name —— 属预期差异。
 */
export function graphDiffToPatch(diff: KnowledgeGraphDiff): PatchLike[] {
  const ops: PatchLike[] = [];
  const add = diff?.add || {};

  for (const l of add.locations || []) {
    const { name, ...rest } = l as any;
    ops.push({ op: 'set', path: `/graph/loc/${name}`, value: rest });
  }
  for (const c of add.characters || []) {
    const { name, location, ...rest } = c as any;
    ops.push({ op: 'set', path: `/graph/char/${name}`, value: { location, ...rest } });
  }
  for (const it of add.items || []) {
    const { name, ...rest } = it as any;
    ops.push({ op: 'set', path: `/graph/item/${name}`, value: rest });
  }
  for (const e of add.edges || []) {
    ops.push({ op: 'set', path: `/graph/edge/${e.type}:${e.from}>${e.to}`, value: e });
  }
  for (const u of diff.update || []) {
    ops.push({ op: 'set', path: `/graph/item/${u.id}.${u.field}`, value: u.value });
  }
  for (const id of diff.delete || []) {
    ops.push({ op: 'del', path: `/graph/item/${id}` });
  }
  return ops;
}
