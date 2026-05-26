/**
 * 从AI消息中提取正文内容，并前置 <time> 标签信息
 */
export function extractContentFromMessage(messageText: string): string {
  const matches = Array.from(messageText.matchAll(/<content\b[^>]*>([\s\S]*?)<\/content>/gi));
  const content = matches.length > 0
    ? matches.map(m => m[1].trim()).filter(Boolean).join('\n\n')
    : messageText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  if (!content) return '';

  // 提取 <time> 标签并前置
  const timeMatch = messageText.match(/<time>([\s\S]*?)<\/time>/i);
  return timeMatch ? `[时间 ${timeMatch[1].trim()}]\n${content}` : content;
}
