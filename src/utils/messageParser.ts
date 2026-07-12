export const MIN_VALID_CONTENT_TEXT_LENGTH = 200;

export function countContentTextLength(text: string): number {
  return (text || '').replace(/\s+/g, '').length;
}

export function isValidMainContent(text: string): boolean {
  return countContentTextLength(text) >= MIN_VALID_CONTENT_TEXT_LENGTH;
}

/**
 * 从AI消息中提取正文内容，并前置 <time> 标签信息
 */
export function extractContentFromMessage(messageText: string): string {
  // 先统一剥离思维链（成对块 + 残留闭合/开启标签 + 旧版 noodbox）
  const stripped = messageText
    .replace(/<think(?:ing)?>[\s\S]*?<\/(?:think|thinking)>/g, '')
    .replace(/<\/?(?:think(?:ing)?)>/g, '')
    .replace(/<noodbox>[\s\S]*?<\/noodbox>/g, '')
    .replace(/<\/?noodbox>/g, '')
    .replace(/\[reasoning\][\s\S]*?\[\/reasoning\]/g, '')
    .replace(/\[thinking\][\s\S]*?\[\/thinking\]/g, '');

  const matches = Array.from(stripped.matchAll(/<content\b[^>]*>([\s\S]*?)<\/content>/gi));
  const content = matches.length > 0
    ? matches.map(m => m[1].trim()).filter(Boolean).join('\n\n')
    : stripped.trim();

  if (!content) return '';

  // 提取 <time> 标签并前置
  const timeMatch = stripped.match(/<time>([\s\S]*?)<\/time>/i);
  return timeMatch ? `[时间 ${timeMatch[1].trim()}]\n${content}` : content;
}
