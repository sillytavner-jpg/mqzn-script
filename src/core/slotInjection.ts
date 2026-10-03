import { logInfo, logWarn } from '../utils/logger';

/**
 * 槽位注入（Slot Injection）
 *
 * ── 为什么有这个东西 ──
 * 智脑以往靠"猜自然文本"定位注入点：大总结找 <chathistory>、梦呓找"从此处开始"、
 * 用户人格找 <深度2>……这些锚点全是预设里的自然语言，预设一改版（或换个预设）
 * 就静默失效，注入退化成"塞到整条消息最前面"，位置全乱。
 *
 * ── 新机制 ──
 * 预设作者在预设里放一行 HTML 注释作为**占位标记**：
 *
 *     <!--ZHINO_DREAMTALK-->
 *
 * 智脑在组装本轮 completion 时扫描 messages：
 *   1. 标记 + 有数据   → 原地替换成内容块
 *   2. 标记 + 没数据   → 整行删掉（不留空壳，免得模型模仿）
 *   3. 压根没有标记     → 退回原有的锚点 / depth 注入（兼容没用新机制的预设）
 *
 * ── 为什么用 HTML 注释 ──
 * - 不渲染、不显示，模型倾向于当注释忽略
 * - 项目已有先例（后台上游守护标记 <!--ZHINO_BG-->，同款惯例）
 * - 即便模型学着输出注释，messageParser 解析正文时本来就会剥掉 <!-- -->
 * - 常见预设的正则清理一般不删 HTML 注释；万一某个预设会删，标记失效并
 *   自动退回兜底逻辑，不会把数据弄丢
 */

/** 12 个槽位：key = 内部标识，value = 预设里写的标记名（不含 <!-- -->） */
export const ZHINO_SLOT_TAGS = {
  user_persona: 'ZHINO_USER_PERSONA',
  dynamic_profile: 'ZHINO_DYNAMIC_PROFILE',
  relationship_profiles: 'ZHINO_RELATIONSHIP_PROFILES',
  memory_chain: 'ZHINO_MEMORY_CHAIN',
  grand_summary: 'ZHINO_GRAND_SUMMARY',
  world_graph: 'ZHINO_WORLD_GRAPH',
  world_state: 'ZHINO_WORLD_STATE',
  context_summary: 'ZHINO_CONTEXT_SUMMARY',
  dreamtalk: 'ZHINO_DREAMTALK',
  world_entry_hint: 'ZHINO_WORLD_ENTRY_HINT',
  nsfw_isolation: 'ZHINO_NSFW_ISOLATION',
  plot_guidance: 'ZHINO_PLOT_GUIDANCE',
} as const;

export type ZhinoSlotKey = keyof typeof ZHINO_SLOT_TAGS;

/** 槽位中文名（仅用于日志/排查） */
export const ZHINO_SLOT_LABELS: Record<ZhinoSlotKey, string> = {
  user_persona: '玩家人格',
  dynamic_profile: '角色动态人设',
  relationship_profiles: '角色关系档案',
  memory_chain: '角色记忆链',
  grand_summary: '剧情大总结',
  world_graph: '场景图谱',
  world_state: '场外动态',
  context_summary: '隐藏楼摘要',
  dreamtalk: '梦呓',
  world_entry_hint: '入场引导',
  nsfw_isolation: 'NSFW隔离层',
  plot_guidance: '剧情导演',
};

const SLOT_KEYS = Object.keys(ZHINO_SLOT_TAGS) as ZhinoSlotKey[];

/** 匹配槽位标记本身（容忍内部空白与大小写） */
function slotRegex(tag: string): RegExp {
  return new RegExp('<!--\\s*' + tag + '\\s*-->', 'gi');
}

/** 匹配"整行只有槽位标记"（连行尾换行一起吃掉），用于无数据时整行删除 */
function slotLineRegex(tag: string): RegExp {
  return new RegExp('^[ \\t]*<!--\\s*' + tag + '\\s*-->[ \\t]*\\r?\\n?', 'gim');
}

export interface SlotApplyResult {
  /**
   * 在上下文里发现了标记的槽位。
   * 语义 = "这个模块归槽位机制管" —— 调用方对这些 key 不应再做锚点/depth 注入，
   * 即便本次没数据（found 但没 filled）也不该退回，否则内容会跑到别的位置去。
   */
  found: Set<ZhinoSlotKey>;
  /** 实际填进了内容的槽位 */
  filled: Set<ZhinoSlotKey>;
}

/**
 * 槽位内容：直接给字符串，或给一个惰性构建函数。
 * 用函数形式时，只有该槽位标记**确实出现在上下文里**才会被调用，避免白算
 * （图谱检索、记忆召回这类构建都不便宜）。
 */
export type SlotContent = string | (() => string);

function resolveSlotContent(value?: SlotContent): string {
  if (typeof value === 'function') {
    try {
      return String(value() || '').trim();
    } catch (err) {
      logWarn('槽位注入', '内容构建失败，该槽位按空处理', String(err));
      return '';
    }
  }
  return String(value || '').trim();
}

/**
 * 扫描 messages，把槽位标记替换成对应内容。
 *
 * @param messages 本轮 completion 的消息数组（会被就地修改）
 * @param slots    槽位内容表：key → 待填文本 / 惰性构建函数（空 = 本模块没数据，删标记）
 */
export function applySlotInjections(
  messages: SillyTavern.SendingMessage[],
  slots: Partial<Record<ZhinoSlotKey, SlotContent>>,
): SlotApplyResult {
  const found = new Set<ZhinoSlotKey>();
  const filled = new Set<ZhinoSlotKey>();

  if (!Array.isArray(messages) || messages.length === 0) return { found, filled };

  const getContent = (msg: any): string | null =>
    typeof msg?.content === 'string' && msg.content.includes('<!--') ? msg.content : null;

  // 第一遍：确认哪些槽位真的出现在上下文里
  for (const msg of messages) {
    const content = getContent(msg);
    if (!content) continue;
    for (const key of SLOT_KEYS) {
      if (found.has(key)) continue;
      if (slotRegex(ZHINO_SLOT_TAGS[key]).test(content)) found.add(key);
    }
  }
  if (found.size === 0) return { found, filled };

  // 第二遍：原地替换 / 删除（只对确实出现的槽位求值）
  for (const msg of messages) {
    const content = getContent(msg);
    if (!content) continue;
    let next = content;

    for (const key of found) {
      const tag = ZHINO_SLOT_TAGS[key];
      if (!slotRegex(tag).test(next)) continue;
      const text = resolveSlotContent(slots[key]);

      if (text) {
        // 用函数式替换：避免内容里的 $& / $1 被当成替换模式
        next = next.replace(slotRegex(tag), () => text);
        filled.add(key);
      } else {
        // 没数据：整行删掉；若标记是混在文字里的则只删标记本身
        next = next.replace(slotLineRegex(tag), '');
        next = next.replace(slotRegex(tag), '');
      }
    }

    if (next !== content) {
      (msg as any).content = next;
    }
  }

  if (filled.size > 0) {
    const names = Array.from(filled).map(k => ZHINO_SLOT_LABELS[k]).join('、');
    logInfo('槽位注入', `已填充 ${filled.size} 个槽位：${names}`);
  }
  const empty = Array.from(found).filter(k => !filled.has(k));
  if (empty.length > 0) {
    logInfo('槽位注入', `以下槽位本轮无数据，标记已清除：${empty.map(k => ZHINO_SLOT_LABELS[k]).join('、')}`);
  }

  return { found, filled };
}

/**
 * 只检查槽位是否存在于上下文（不修改内容）。
 * 用在需要"先知道归谁管、再决定构建哪份文本"的场景。
 */
export function findPresentSlots(messages: SillyTavern.SendingMessage[]): Set<ZhinoSlotKey> {
  const found = new Set<ZhinoSlotKey>();
  if (!Array.isArray(messages)) return found;
  for (const msg of messages) {
    const content = (msg as any)?.content;
    if (typeof content !== 'string' || !content.includes('<!--')) continue;
    for (const key of SLOT_KEYS) {
      if (found.has(key)) continue;
      if (slotRegex(ZHINO_SLOT_TAGS[key]).test(content)) found.add(key);
    }
  }
  return found;
}

/** 清掉上下文里残留的槽位标记（比如本轮构建失败、标记没被填充时） */
export function stripResidualSlotMarkers(content: string): string {
  if (!content || !content.includes('<!--')) return content;
  let next = content;
  for (const key of SLOT_KEYS) {
    next = next.replace(slotLineRegex(ZHINO_SLOT_TAGS[key]), '');
    next = next.replace(slotRegex(ZHINO_SLOT_TAGS[key]), '');
  }
  return next;
}

/**
 * 最后一道保险：把 messages 里**还没被消费**的槽位标记删掉，并记名上报。
 *
 * 正常路径下 `applySlotInjections` 已经处理过了，这里只是防漏网
 * （标记一旦进了 prompt，模型会学着在回复里输出它，用户看到的就是
 * 「标签出现在提示词里、但智脑没注入内容」）。
 *
 * @returns 被清理的消息条数
 */
export function purgeResidualSlots(messages: SillyTavern.SendingMessage[]): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  const hitKeys = new Set<ZhinoSlotKey>();
  let cleanedMessages = 0;

  for (const msg of messages) {
    const content = (msg as any)?.content;
    if (typeof content !== 'string' || !content.includes('<!--')) continue;

    // 先记录残留的是哪些槽位（用于上报，即使后面清理失败也有线索）
    for (const key of SLOT_KEYS) {
      if (slotRegex(ZHINO_SLOT_TAGS[key]).test(content)) hitKeys.add(key);
    }

    const next = stripResidualSlotMarkers(content);
    if (next !== content) {
      (msg as any).content = next;
      cleanedMessages++;
    }
  }

  if (hitKeys.size > 0) {
    logWarn(
      '槽位注入',
      `兜底清理：${cleanedMessages} 条消息里残留了 ${hitKeys.size} 个槽位标记 → `
      + `${Array.from(hitKeys).map(k => ZHINO_SLOT_LABELS[k]).join('、')}。`
      + '正常不该出现，若反复发生请带上这条日志反馈',
    );
  }

  return cleanedMessages;
}
