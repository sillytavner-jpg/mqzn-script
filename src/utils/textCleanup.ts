/**
 * 文本清理工具
 *
 * AI 输出中可能包含 "user" / "{{user}}" / "User" 等占位符，
 * 统一替换为实际玩家名。
 */

/**
 * 将 AI 输出中的 {{user}} / 独立单词 user 替换为实际玩家名。
 * 用 lookbehind/ahead 确保不误伤 username / misuser 等复合词。
 */
export function replaceUserReferences(text: string, userName: string): string {
  if (userName === '{{user}}') {
    return text;
  }
  const step1 = text.replace(/\{\{user\}\}/gi, userName);
  const step2 = step1.replace(/(?<![\{a-zA-Z])user(?![a-zA-Z\}])/gi, userName);
  const step3 = step2.replace(/明月/g, userName);
  const step4 = step3.replace(/Mingyue/g, userName);
  return step4;
}
