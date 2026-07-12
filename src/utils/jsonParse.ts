import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';

/**
 * 安全解析 JSON：先尝试直接 parse，失败则用 jsonrepair 修复后再 parse
 * 如果提供了 schema，解析后会验证结构
 */
export function safeJsonParse<T>(text: string, schema?: z.ZodSchema<T>): T | null {
  // 1. 尝试直接 parse
  try {
    const data = JSON.parse(text);
    if (schema) {
      const result = schema.safeParse(data);
      if (result.success) return result.data;
      return null;
    }
    return data as T;
  } catch {
    // 2. 尝试 jsonrepair 修复
    try {
      const repaired = jsonrepair(text);
      const data = JSON.parse(repaired);
      if (schema) {
        const result = schema.safeParse(data);
        if (result.success) return result.data;
        return null;
      }
      return data as T;
    } catch (e) {
      return null;
    }
  }
}

/**
 * 从文本中提取 JSON 块（支持 ```json 代码块和裸 JSON）
 */
export function extractJson(text: string): string | null {
  // 先尝试从 ```json ``` 代码块提取（可能有多个，从后往前找第一个非空的）
  const codeBlockMatches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (codeBlockMatches.length > 0) {
    // 从后往前：AI 可能在前面导语里提到 ```json``` 格式说明（空壳），
    // 真正的 JSON 块在最后，且一定有内容
    for (let i = codeBlockMatches.length - 1; i >= 0; i--) {
      const content = codeBlockMatches[i][1]?.trim();
      if (content && (content.startsWith('{') || content.startsWith('['))) {
        return content;
      }
    }
    // 所有代码块都是空壳 → 继续走下面的兜底
  }

  // 尝试从第一个 { 到最后一个 } 提取
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.substring(firstBrace, lastBrace + 1);
  }

  // 尝试从第一个 [ 到最后一个 ] 提取（数组格式）
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    return text.substring(firstBracket, lastBracket + 1);
  }

  return null;
}
