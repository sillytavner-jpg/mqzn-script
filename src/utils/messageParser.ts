export const MIN_VALID_CONTENT_TEXT_LENGTH = 200;

export function countContentTextLength(text: string): number {
  return (text || '').replace(/\s+/g, '').length;
}

export function isValidMainContent(text: string): boolean {
  return countContentTextLength(text) >= MIN_VALID_CONTENT_TEXT_LENGTH;
}

// ============================================================
// 思维链解析
//
// 角色扮演正文的实际结构（来自真实落盘数据）：
//
//   [metacognition]            ← 思维链（开启标签常被 assistant prefill 吃掉）
//   - 第一人称视角扮演秋夜。
//   - 当前时间地点：…… 人物：秋夜、苏白霜、洛红尘。
//   - 角色引擎：……
//   </thinking>                ← 只剩闭合标签
//   <time>```…```</time>
//   <content>……正文……</content>
//
// 另有第二套预设（注释式）：
//   <!-- begin_of_Subtext_think -->…<!-- end_of_Subtext_think -->
//   </thinking>
//   正文……（正文里还夹着 <!-- 模拟段落… --> 之类的元注释）
//
// 正文 = 纯叙事文本；思维链 = 角色/视角/在场锚点。
// 后者只投递给「认人」类分析（角色记忆/角色小传/动态人设），
// 事件类分析（小总结/大总结/世界推进/剧情导演）不吃——防止把
// 思维链里的「构思草稿」当成已发生事件。
// ============================================================

/** 成对出现的思维链包裹标记 */
const CHAIN_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['<!-- begin_of_Subtext_think -->', '<!-- end_of_Subtext_think -->'],
  ['<thinking>', '</thinking>'],
  ['<think>', '</think>'],
  ['[thinking]', '[/thinking]'],
  ['[reasoning]', '[/reasoning]'],
  ['<noodbox>', '</noodbox>'],
];

/** 只有闭合标记的残缺形态（开启标记被 prefill 吃掉） */
const CHAIN_LONE_CLOSERS: readonly string[] = [
  '</thinking>',
  '</think>',
  '[/thinking]',
  '[/reasoning]',
  '</noodbox>',
  '<!-- end_of_Subtext_think -->',
];

/** 残留标记（含 prefill 吃掉 "<" 后剩下的 `thinking>`） */
const CHAIN_RESIDUE_RE =
  /<\/?(?:think(?:ing)?)>|\[\/?(?:thinking|reasoning)\]|<\/?noodbox>|<!--\s*(?:begin|end)_of_Subtext_think\s*-->|^thinking>\s*/gim;

/** 思维链开头的特征标记（用于识别被截断、无闭合标签的思维链） */
const CHAIN_HEADS: readonly string[] = [
  '[metacognition]',
  '<!-- begin_of_Subtext_think -->',
  'thinking>',
  '<thinking>',
  '<think>',
  '[thinking]',
  '[reasoning]',
  '<noodbox>',
];

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const TIME_BLOCK_RE = /<time>[\s\S]*?<\/time>/gi;

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
    const matchedHead = CHAIN_HEADS.find(h => head.startsWith(h));
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
    content = body;
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
