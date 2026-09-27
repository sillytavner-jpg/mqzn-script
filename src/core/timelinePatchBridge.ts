/**
 * patch ↔ 大总结时间线桥接
 *
 * 大总结的输出是「一串新增事件」（events[]），改成 patch 后：
 *   { op:'set', path:'/timeline/1', value:{time,location,presentCharacters,summary,event,importance,keywords} }
 *
 * 序号 /timeline/{n} 表示「本轮第 n 条事件」（从 1 开始，按时间顺序），
 * 不是全局数组索引 —— 每轮的事件集合相互独立，所以不存在「一插一删索引全错」的问题。
 *
 * 本模块刻意零依赖，可裸测。
 */

export interface PatchLike {
  op: string;
  path: string;
  value?: unknown;
}

export interface TimelineBridgeResult {
  events: any[] | null;
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
 * patch ops → events 数组（按 /timeline/{n} 的 n 升序排列）。
 * 未提供合法序号的条目，按出现顺序追加到末尾。
 */
export function patchToGrandSummaryEvents(ops: PatchLike[]): TimelineBridgeResult {
  const errors: string[] = [];
  const numbered: Array<{ n: number; seq: number; evt: Record<string, any> }> = [];
  const list = Array.isArray(ops) ? ops : [];
  let seq = 0;

  for (const raw of list) {
    if (!raw || typeof raw.path !== 'string') {
      errors.push('条目结构非法');
      continue;
    }
    if (isDeleteOp(raw.op)) continue;

    const segs = raw.path.split('/').map((s) => s.trim()).filter(Boolean);
    if (segs.length < 2 || segs[0] !== 'timeline') {
      errors.push(`非时间线路径: ${raw.path}`);
      continue;
    }

    const evt = asObject(raw.value);
    if (!evt) {
      errors.push(`事件值必须是对象: ${raw.path}`);
      continue;
    }

    // 缺关键字段的条目直接丢弃（防止垃圾数据入库）
    if (!evt.time && !evt.event) {
      errors.push(`事件缺 time/event: ${raw.path}`);
      continue;
    }

    const parsed = Number(segs[1]);
    numbered.push({
      n: Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER,
      seq: seq++,
      evt,
    });
  }

  if (numbered.length === 0) return { events: null, errors };

  numbered.sort((a, b) => (a.n === b.n ? a.seq - b.seq : a.n - b.n));
  return { events: numbered.map((x) => x.evt), errors };
}
