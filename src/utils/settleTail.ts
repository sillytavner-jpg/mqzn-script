/**
 * 收尾结算尾巴的定位工具（「收尾压力」机制的一部分）。
 *
 * ── 它解决什么问题 ──
 * 尾部破限会让模型在主体写完之后另起一行输出 `<TAIL>` 并填一份结算单。
 * apiCaller 要在流式阶段读到这个标签就断开连接，让结算单一个 token 都不生成。
 *
 * 但**判错就会把正文整段掐掉**，比不掐严重得多。所以判据必须同时满足：
 *
 *   ① 思维链已闭合：存在 </thinking>。
 *      模型在 <thinking> 里复述结构说明（「最后要写 <TAIL>」）是常态，
 *      那时出现的标签只是「提及」。若思维链开了但没闭合，一律不算。
 *   ② 标签位置在 </thinking> 之后。
 *   ③ 标签另起一行（前一个字符是 \n）——正文里顺带提到标签不算。
 *
 * 例外：整段输出里根本没有 <thinking>（违反输出契约），退化为「另起一行即算」。
 * 这种时候若还要求「过了 </thinking>」，兜底裁剪会彻底失效。
 *
 * ── 为什么分严格 / 宽松两版 ──
 * 流式阶段用严格版（判错代价高）；生成结束后的兜底裁剪用宽松版
 * （正文已经完整到手，只要标签在思维链之后就该切掉，不管有没有换行）。
 */

/** 结算尾巴标签名。改这里即可换标签（提示词与检测共用同一常量）。 */
export const SETTLE_TAG = 'TAIL';

const RE_SETTLE_TAG = new RegExp(
  `<\\s*\\/?\\s*${SETTLE_TAG}\\s*\\/?\\s*>|<\\s*结算[^>]*>`,
  'gi',
);

const RE_THINK_OPEN = /<\s*thinking\s*>|<\s*think\s*>/i;

/** 思维链闭合位置；-1 = 没有闭合标签 */
function thinkEndIndex(text: string): number {
  return Math.max(text.lastIndexOf('</thinking>'), text.lastIndexOf('</think>'));
}

/**
 * 严格版：返回真结算标签的起始下标；没有则 -1。
 * 用于流式阶段的「读到就断开」，误判会把正文掐没，所以三条判据一条都不能少。
 */
export function findSettleTagStart(text: string): number {
  const s = String(text || '');
  if (!s) return -1;

  const hasThinkOpen = RE_THINK_OPEN.test(s);
  const thinkEnd = thinkEndIndex(s);
  // 思维链开了但没闭合 → 还在思考，一切标签提及都不算
  if (hasThinkOpen && thinkEnd < 0) return -1;

  let best = -1;
  RE_SETTLE_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_SETTLE_TAG.exec(s))) {
    const at = m.index;
    if (thinkEnd >= 0 && at <= thinkEnd) continue;
    const before = at === 0 ? '\n' : s[at - 1];
    if (before !== '\n') continue;
    if (best < 0 || at < best) best = at;
  }
  return best;
}

/**
 * 宽松版：用于生成结束后的兜底裁剪。
 * 先试严格版；未命中时，只要标签在思维链之后、不管有没有换行都认。
 */
export function findSettleTagLoose(text: string): number {
  const s = String(text || '');
  const strict = findSettleTagStart(s);
  if (strict >= 0) return strict;

  const hasThinkOpen = RE_THINK_OPEN.test(s);
  const thinkEnd = thinkEndIndex(s);
  if (hasThinkOpen && thinkEnd < 0) return -1;

  RE_SETTLE_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_SETTLE_TAG.exec(s))) {
    if (thinkEnd >= 0 && m.index <= thinkEnd) continue;
    return m.index;
  }
  return -1;
}
