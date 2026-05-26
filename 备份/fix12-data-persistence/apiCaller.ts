/**
 * 统一 API 调用封装
 *
 * 当 settings.apiMode === 'custom' 时，使用 OpenAI-compatible API 发送请求；
 * 否则使用酒馆原生的 generateRaw()。
 */

import { useMainStore } from '../stores/mainStore';

interface OrderedPrompt {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface GenerateRawParams {
  user_input: string;
  ordered_prompts: (OrderedPrompt | 'user_input')[];
  should_silence?: boolean;
  max_chat_history?: number;
  [key: string]: unknown;
}

/**
 * 调用 LLM 生成（自动选择 default/custom API）
 * 返回原始响应字符串，与 generateRaw() 返回格式一致
 */
export async function callGenerateRaw(params: GenerateRawParams): Promise<string> {
  const store = useMainStore();
  const settings = store.settings;

  if (settings.apiMode !== 'custom' || !settings.customApiUrl || !settings.customApiKey) {
    return generateRaw(params);
  }

  // 构建 OpenAI-compatible 请求
  const messages = buildOpenAIMessages(params.ordered_prompts, params.user_input);
  const apiUrl = normalizeApiUrl(settings.customApiUrl.trim());

  console.info(`[智脑] 自定义API请求 → ${apiUrl} (原始: ${settings.customApiUrl})`);
  console.info(`[智脑] 模型: ${settings.customApiModel}, 消息数: ${messages.length}`);

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.customApiKey}`,
      },
      body: JSON.stringify({
        model: settings.customApiModel,
        messages,
        temperature: 0.7,
        max_tokens: 65536,
      }),
    });
  } catch (err: any) {
    console.error('[智脑] fetch 失败（可能是CORS或网络问题）:', err.message || err);
    throw new Error(`网络请求失败: ${err.message || err}\n提示：如果酒馆通过HTTPS加载，自定义API也需要HTTPS；本地API可能需要配置CORS。`);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '(无法读取响应)');
    console.error(`[智脑] API返回错误: ${response.status} ${response.statusText}`);

    if (response.status === 404) {
      throw new Error(
        `自定义API 404 Not Found\n` +
        `请求地址: ${apiUrl}\n` +
        `提示: 请确认URL是否包含完整路径（通常以 /v1/chat/completions 结尾）`
      );
    }

    throw new Error(`自定义API请求失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json().catch(() => null);
  if (!data) {
    throw new Error('自定义API返回了空响应或非JSON格式');
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    console.error('[智脑] API返回结构异常:', JSON.stringify(data).slice(0, 500));
    throw new Error(`自定义API返回格式异常，未找到 choices[0].message.content`);
  }

  console.info(`[智脑] 自定义API返回 ${content.length} 字符`);
  return content;
}

/**
 * 规范化 API URL：模拟酒馆原生的自动补全行为
 * 如果 URL 未以 /chat/completions 结尾，自动追加
 */
function normalizeApiUrl(url: string): string {
  if (url.endsWith('/chat/completions')) return url;
  const trimmed = url.replace(/\/+$/, '');
  return `${trimmed}/chat/completions`;
}

/**
 * 将 ordered_prompts 转换为 OpenAI messages 数组
 * 'user_input' 占位符会被替换为实际的 user_input 内容
 */
function buildOpenAIMessages(
  orderedPrompts: (OrderedPrompt | 'user_input')[],
  userInput: string,
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];

  for (const item of orderedPrompts) {
    if (item === 'user_input') {
      messages.push({ role: 'user', content: userInput });
    } else {
      messages.push({ role: item.role, content: item.content });
    }
  }

  return messages;
}
