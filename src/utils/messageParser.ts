export const MIN_VALID_CONTENT_TEXT_LENGTH = 200;

export function countContentTextLength(text: string): number {
  return (text || '').replace(/\s+/g, '').length;
}

export function isValidMainContent(text: string): boolean {
  return countContentTextLength(text) >= MIN_VALID_CONTENT_TEXT_LENGTH;
}

// ============================================================
// 标签配置 —— 换预设不用改代码
//
// 不同预设的「思维链标签」差异很大，白名单跟不上就会出现
// 「思维链被当正文喂给事件分析」这类污染。所以这里把标签表集中，
// 并开放 configureMessageParser() 允许运行时覆盖：
//
//   configureMessageParser({ angleChainTags: [...新标签...] })
//
// 当前已适配的两套：
//
// ① 旧预设（[metacognition] 式）
//      [metacognition]            ← 开启标签常被 assistant prefill 吃掉
//      - 当前时间地点：……
//      </thinking>                ← 只剩闭合标签
//      <time>```…```</time>
//      <content>……正文……</content>
//
// ② 星光预设 v0.7.5.5+（四段流水线式）
//      <thinking_left>（小左 · 记忆与逻辑）</thinking_left>
//      <thinking_right>（小右 · 情感与关系）</thinking_right>
//      <thinking_love>（小爱，可选）</thinking_love>
//      <thinking_director>（前额叶）</thinking_director>
//      <time>```地点·日期·时间```</time>
//      <content>正文…<inner>她的心里话</inner>…</content>
//      <thinking_left>（小左自查）</thinking_left>   ← 第二次出现，在正文之后
//      <elapsed>…</elapsed> <choice>…</choice> <UpdateVariable>…</UpdateVariable>
//   注意 thinking_left 会出现两次，成对剥离会一并处理，不影响正文取值。
//
// 正文 = 纯叙事文本；思维链 = 角色/视角/在场锚点。
// 后者只投递给「认人」类分析（角色记忆/角色小传/动态人设），
// 事件类分析（小总结/大总结/世界推进/剧情导演）不吃——防止把
// 思维链里的「构思草稿」当成已发生事件。
// ============================================================

export interface MessageParserTags {
  /**
   * 尖括号包裹的思维链标签名（不含尖括号）。
   * 成对形态 `<name>…</name>` 与「只剩闭合标签」的残缺形态都会自动识别。
   */
  angleChainTags: readonly string[];
  /** 方括号包裹的思维链标签名，如 'thinking' → `[thinking]…[/thinking]` */
  bracketChainTags: readonly string[];
  /** 注释形式的思维链成对标记 */
  commentChainPairs: ReadonlyArray<readonly [string, string]>;
  /**
   * 正文之外的结构性块标签。仅在「整条消息没有 <content> 标签、走兜底」时剥掉，
   * 避免变量更新／剧情选项／时间结算／防截断尾巴被当成叙事。
   */
  structureTags: readonly string[];
}

export const DEFAULT_MESSAGE_PARSER_TAGS: MessageParserTags = {
  angleChainTags: [
    // 星光预设四段流水线
    'thinking_left',
    'thinking_right',
    'thinking_love',
    'thinking_director',
    // 常见通用形态
    'thinking',
    'think',
    'noodbox',
  ],
  bracketChainTags: ['thinking', 'reasoning'],
  commentChainPairs: [
    ['<!-- begin_of_Subtext_think -->', '<!-- end_of_Subtext_think -->'],
  ],
  structureTags: [
    'UpdateVariable',
    'choice',
    'elapsed',
    'safe',
    'theater',
    'recap',
    'parallel_world',
    'branches',
    'meow_FM',
    'plot_outline',
  ],
};

/** 思维链开头的裸特征（无标签、用于识别被截断的思维链） */
const CHAIN_HEAD_LITERALS: readonly string[] = ['[metacognition]'];

let activeTags: MessageParserTags = DEFAULT_MESSAGE_PARSER_TAGS;

// 以下均由 rebuildTagTables() 根据 activeTags 重建
let CHAIN_PAIRS: ReadonlyArray<readonly [string, string]> = [];
let CHAIN_LONE_CLOSERS: readonly string[] = [];
let CHAIN_HEADS: readonly string[] = [];
let CHAIN_RESIDUE_RE: RegExp = /$^/;
let STRUCTURE_BLOCK_RE: RegExp = /$^/;
let STRUCTURE_BARE_RE: RegExp = /$^/;

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const TIME_BLOCK_RE = /<time>[\s\S]*?<\/time>/gi;

/** 正则元字符转义（用于把标签名拼进正则） */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rebuildTagTables(): void {
  const tags = activeTags;

  CHAIN_PAIRS = [
    ...tags.commentChainPairs.map(p => [p[0], p[1]] as readonly [string, string]),
    ...tags.angleChainTags.map(n => [`<${n}>`, `</${n}>`] as readonly [string, string]),
    ...tags.bracketChainTags.map(n => [`[${n}]`, `[/${n}]`] as readonly [string, string]),
  ];

  CHAIN_LONE_CLOSERS = [
    ...tags.angleChainTags.map(n => `</${n}>`),
    ...tags.bracketChainTags.map(n => `[/${n}]`),
    ...tags.commentChainPairs.map(p => p[1]),
  ];

  CHAIN_HEADS = [
    ...CHAIN_HEAD_LITERALS,
    ...tags.commentChainPairs.map(p => p[0]),
    // 开启标签被 prefill 吃掉后剩下的裸形态（`thinking_left>`）也要认
    ...tags.angleChainTags.flatMap(n => [`${n}>`, `<${n}>`]),
    ...tags.bracketChainTags.map(n => `[${n}]`),
  ];

  const angleAlt = tags.angleChainTags.map(escapeRe).join('|');
  const bracketAlt = tags.bracketChainTags.map(escapeRe).join('|');
  const commentAlt = tags.commentChainPairs
    .map(p => `${escapeRe(p[0])}|${escapeRe(p[1])}`)
    .join('|');

  CHAIN_RESIDUE_RE = new RegExp(
    (angleAlt ? `<\\/?(?:${angleAlt})>|` : '')
    + (bracketAlt ? `\\[\\/?(?:${bracketAlt})\\]|` : '')
    + (commentAlt ? `(?:${commentAlt})|` : '')
    + (angleAlt ? `^(?:${angleAlt})>\\s*` : '^$^'),
    'gim',
  );

  const structAlt = tags.structureTags.map(escapeRe).join('|');
  STRUCTURE_BLOCK_RE = structAlt
    ? new RegExp(`<(${structAlt})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi')
    : /$^/;
  STRUCTURE_BARE_RE = structAlt
    ? new RegExp(`<\\/?(?:${structAlt})\\b[^>]*>`, 'gi')
    : /$^/;
}

rebuildTagTables();

/**
 * 覆盖标签配置（换预设时调用，不必改代码）。
 * 例如接入新预设的思维链标签：
 *   configureMessageParser({ angleChainTags: ['analysis', 'draft', 'thinking'] });
 */
export function configureMessageParser(patch: Partial<MessageParserTags>): void {
  activeTags = { ...activeTags, ...patch };
  rebuildTagTables();
}

/** 读取当前生效的标签配置 */
export function getMessageParserTags(): MessageParserTags {
  return activeTags;
}

/**
 * 剥掉「正文之外的结构性块」（变量更新／剧情选项／时间结算／防截断尾巴等）。
 * 仅在无 <content> 标签、整条消息走兜底时使用——实测这类泄漏在真实数据里有上百条。
 * 注意：不剥离 <inner>（星光预设的"心里话"，按约定保留在正文里）。
 */
export function stripStructureBlocks(text: string): string {
  if (!text) return text;
  let out = text.replace(STRUCTURE_BLOCK_RE, '');
  out = out.replace(STRUCTURE_BARE_RE, '');
  return out;
}

export interface ParsedAssistantMessage {
  /** 纯正文（已剥离思维链与元注释） */
  content: string;
  /** 思维链原文（已剥离包裹标记）；无则空串 */
  thinkingChain: string;
}

/** 大小写不敏感查找 */
function indexOfCI(haystack: string, needle: string, from = 0): number {
  return haystack.toLowerCase().indexOf(needle.toLowerCase(), from);
}

/** 去掉思维链残留标记后是否只剩空白 */
function isBlankAfterResidue(text: string): boolean {
  return text
    .replace(CHAIN_RESIDUE_RE, '')
    .replace(TIME_BLOCK_RE, '')
    .replace(HTML_COMMENT_RE, '')
    .replace(/\s+/g, '') === '';
}

/**
 * 把一条 AI 消息拆成「纯正文」+「思维链」。
 */
export function parseAssistantMessage(messageText: string): ParsedAssistantMessage {
  const raw = messageText || '';
  if (!raw) return { content: '', thinkingChain: '' };

  let body = raw;
  const chainParts: string[] = [];

  // 1) 成对思维链块
  for (const [open, close] of CHAIN_PAIRS) {
    let from = 0;
    for (;;) {
      const o = indexOfCI(body, open, from);
      if (o < 0) break;
      const c = indexOfCI(body, close, o + open.length);
      if (c < 0) break;
      chainParts.push(body.slice(o + open.length, c));
      body = body.slice(0, o) + body.slice(c + close.length);
      from = o;
    }
  }

  // 2) 残缺形态：只有闭合标记，标记之前的内容就是思维链
  //    仅在闭合标记出现在 <content> 之前时才认（避免误吞正文）
  const contentOpenIdx0 = indexOfCI(body, '<content');
  let loneIdx = -1;
  let loneTok = '';
  for (const tok of CHAIN_LONE_CLOSERS) {
    const i = indexOfCI(body, tok);
    if (i < 0) continue;
    if (contentOpenIdx0 >= 0 && i > contentOpenIdx0) continue;
    if (loneIdx < 0 || i < loneIdx) {
      loneIdx = i;
      loneTok = tok;
    }
  }
  if (loneIdx >= 0) {
    chainParts.push(body.slice(0, loneIdx));
    body = body.slice(loneIdx + loneTok.length);
  }

  // 2.5) 截断的思维链：整条消息从思维链开头起、既无闭合标记也无 <content>
  //      （生成被中断，正文压根没写出来）→ 全部归思维链，正文判空
  if (contentOpenIdx0 < 0 && loneIdx < 0) {
    const head = body.replace(/^\s+/, '').toLowerCase();
    const matchedHead = CHAIN_HEADS.find(h => head.startsWith(h.toLowerCase()));
    if (matchedHead) {
      chainParts.push(body);
      body = '';
    }
  }

  // 3) 取正文
  const contentOpenIdx = indexOfCI(body, '<content');
  let content: string;
  if (contentOpenIdx >= 0) {
    const matches = Array.from(body.matchAll(/<content\b[^>]*>([\s\S]*?)<\/content>/gi));
    content = matches.map(m => m[1].trim()).filter(Boolean).join('\n\n');
    // <content> 之前的残留（时间块除外）= 思维链尾巴，兜底收走
    const pre = body.slice(0, contentOpenIdx);
    if (!isBlankAfterResidue(pre)) chainParts.push(pre);
  } else {
    // 无 <content> 标签：整条消息兜底当正文，但先剥掉正文之外的结构性块
    // （变量更新／剧情选项／时间结算／防截断尾巴），否则会被当成叙事喂给分析
    content = stripStructureBlocks(body);
  }

  // 4) 清洗正文：元注释（草稿/杀比拟检查之类）与残留标记不进正文
  content = content
    .replace(HTML_COMMENT_RE, '')
    .replace(CHAIN_RESIDUE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // 5) 前置 <time> 时间信息
  const timeMatch = raw.match(/<time>([\s\S]*?)<\/time>/i);
  if (timeMatch) {
    content = `[时间 ${timeMatch[1].trim()}]\n${content}`;
  }

  // 6) 归一化思维链
  const thinkingChain = chainParts
    .join('\n')
    .replace(TIME_BLOCK_RE, '')
    .replace(CHAIN_RESIDUE_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { content, thinkingChain };
}

/**
 * 从AI消息中提取正文内容，并前置 <time> 标签信息
 * （思维链会被剥离；需要思维链请用 parseAssistantMessage）
 */
export function extractContentFromMessage(messageText: string): string {
  return parseAssistantMessage(messageText).content;
}

/**
 * 把思维链格式化成可投递给分析的文本块。
 * 标签里明确写清「仅供识别、勿当剧情」，压住模型把构思草稿当事实的倾向。
 */
export function formatThinkingChainForAnalysis(thinkingChain: string): string {
  const text = (thinkingChain || '').trim();
  if (!text) return '';
  return [
    '【思维链·角色与视角锚点（仅供识别说话人与在场角色，其中"草稿/构思/模拟段落"尚未发生，严禁当作剧情事实）】',
    text,
  ].join('\n');
}
