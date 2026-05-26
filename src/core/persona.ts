/**
 * 用户人格系统
 *
 * 流程：
 * 1. 用户在面板填写原始人设
 * 2. 调用 analyzePersona() 用AI深度分析，生成结构化人格画像
 * 3. 在 CHAT_COMPLETION_SETTINGS_READY 中，调用 injectPersona() 将人格画像注入提示词
 */

import { callGenerateRaw } from '../utils/apiCaller';

/**
 * 分析用户人设，生成结构化人格画像
 */
export async function analyzePersona(rawInput: string): Promise<string> {
  if (!rawInput.trim()) {
    throw new Error('用户人设不能为空');
  }

  const systemPrompt = `你是一个专业的角色分析师。你的任务是将用户提供的角色人设进行深度分析，提取出结构化的人格画像。

分析要求：
1. 提取核心性格特征（内向/外向、理性/感性等维度）
2. 识别行为模式（面对冲突、压力、亲密关系时的典型反应）
3. 提取说话风格（用词习惯、语气、句式特点）
4. 识别价值观和底线（什么是角色绝对不会做的）
5. 提取情感表达方式（如何表达喜怒哀乐）
6. 识别社交模式（与不同人的互动方式差异）

输出格式要求：
- 使用简洁的条目式描述
- 每个维度2-4条核心特征
- 避免空泛描述，要具体可执行
- 总字数控制在300-500字`;

  const userPrompt = `请分析以下角色人设，生成结构化人格画像：

---
${rawInput}
---

请直接输出分析结果，不要有任何前言或解释。`;

  const result = await callGenerateRaw({
    user_input: userPrompt,
    ordered_prompts: [
      { role: 'system', content: systemPrompt },
      'user_input',
    ],
    should_silence: true,
    max_chat_history: 0,
  });

  return result.trim();
}

/**
 * 构建注入到提示词中的用户人格文本
 * 这段文本会替代酒馆原生的"玩家描述"
 */
export function buildPersonaInjection(analyzedProfile: string, rawInput: string): string {
  return `<user_persona type="analyzed">
【用户角色·人格画像】
以下是对<user>角色的深度分析，请据此理解<user>的行为逻辑和表达方式：

${analyzedProfile}

【原始人设参考】
${rawInput}
</user_persona>`;
}

/**
 * 获取消息的文本内容（兼容 string 和 Array 格式）
 */
function getMessageText(content: SillyTavern.SendingMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map(part => part.text)
      .join('\n');
  }
  return '';
}

/**
 * 在 CHAT_COMPLETION_SETTINGS_READY 中注入用户人格
 * 策略：找到提示词中包含玩家描述的消息，替换其内容为增强版人格描述
 */
export function injectPersonaIntoCompletion(
  messages: SillyTavern.SendingMessage[],
  analyzedProfile: string,
  rawInput: string,
): void {
  const injectionText = buildPersonaInjection(analyzedProfile, rawInput);

  // 策略：直接在聊天记录前（D2附近）注入
  // 找到 <深度2> 标记或 </additional_settings> 标记附近
  let injected = false;

  for (let i = 0; i < messages.length; i++) {
    const text = getMessageText(messages[i].content);
    if (!text) continue;

    // 找到包含 <深度2> 的消息，在其前面注入
    if (text.includes('<深度2>')) {
      messages.splice(i, 0, {
        role: 'system',
        content: injectionText,
      });
      injected = true;
      break;
    }
  }

  // 如果没找到深度2标记，尝试在聊天记录结束后注入
  if (!injected) {
    for (let i = 0; i < messages.length; i++) {
      const text = getMessageText(messages[i].content);
      if (!text) continue;

      if (text.includes('</chathistory>') || text.includes('</additional_settings>')) {
        messages.splice(i + 1, 0, {
          role: 'system',
          content: injectionText,
        });
        injected = true;
        break;
      }
    }
  }

  // 最后兜底：在倒数第4条消息前注入
  if (!injected && messages.length > 4) {
    messages.splice(messages.length - 4, 0, {
      role: 'system',
      content: injectionText,
    });
  }

  console.info(`[智脑] 用户人格已注入提示词 (injected=${injected})`);
}
