import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';
import { logWarn } from './logger';

/**
 * 给"解析不出来"的输出做一份体检报告 —— 目的是让人一眼看出 AI 到底吐了什么：
 * 是只回了一句道歉、还是 JSON 写一半被截断了、还是格式整个跑偏。
 *
 * 之前解析失败只返回 null，调用方顶多报一句"格式错误"，完全看不到现场。
 */
export function describeUnparsableOutput(text: string): string {
  const raw = (text || '').trim();
  if (!raw) return '输出为空（一个字都没有）';

  const len = raw.length;
  const HEAD = 150;
  const TAIL = 150;
  const head = raw.slice(0, HEAD).replace(/\s+/g, ' ');
  const tail = len > HEAD + TAIL ? raw.slice(-TAIL).replace(/\s+/g, ' ') : '';

  const notes: string[] = [];
  const startsWithJson = /^[[{]/.test(raw);
  const hasCodeBlock = raw.includes('```');

  if (!startsWithJson && !hasCodeBlock) {
    notes.push('开头既不是 JSON 也不是代码块 → 模型多半在"说人话"（比如拒绝、道歉、解释）');
  } else {
    // 括号配平检查：不配平通常意味着写到一半就断了
    const openBrace = (raw.match(/\{/g) || []).length;
    const closeBrace = (raw.match(/\}/g) || []).length;
    const openBracket = (raw.match(/\[/g) || []).length;
    const closeBracket = (raw.match(/\]/g) || []).length;
    if (openBrace !== closeBrace || openBracket !== closeBracket) {
      notes.push(
        `花括号 ${openBrace}开/${closeBrace}闭、方括号 ${openBracket}开/${closeBracket}闭，`
        + '**不配平 → 疑似写一半就断了**',
      );
    }
    if (hasCodeBlock && !raw.trimEnd().endsWith('```')) {
      notes.push('代码块没有闭合（结尾缺 ```）→ 同样是"写一半断了"的特征');
    }
  }

  let out = `输出长度 ${len} 字`;
  if (notes.length > 0) out += `｜${notes.join('；')}`;
  out += `\n开头：${head}`;
  if (tail) out += `\n结尾：…${tail}`;
  return out;
}

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
      // 修复也失败 —— 把现场记下来（调用方只会看到 null，所以线索必须留在这里）
      logWarn('JSON解析', '解析失败，输出内容不合规', describeUnparsableOutput(text));
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
