/**
 * 统一 API 调用封装
 *
 * 通过 API 库 (apiLibrary) 路由不同分析类型到不同的 API 配置。
 * 所有请求均使用 OpenAI-compatible 格式。
 */

import { useMainStore, type ApiConfig } from '../stores/mainStore';
import { logError } from '../utils/logger';
import {
  applyJailbreakOverrideToOrderedPrompts,
  applyJailbreakOverrideToUserInput,
} from './jailbreakPrompts';

// 模块级 API 失败追踪（供 enqueueSourceChangeReconcile 等模块查询系统稳定性）
let _lastApiFailureTime = 0;

/** 记录 API 失败时间（fetch 失败、HTTP 错误、空响应等） */
export function recordApiFailure(): void {
  _lastApiFailureTime = Date.now();
}

/** 获取最后一次 API 失败的时间戳（0 = 从未失败） */
export function getLastApiFailureTime(): number {
  return _lastApiFailureTime;
}

interface OrderedPrompt {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface GenerateRawParams {
  user_input: string;
  ordered_prompts: (OrderedPrompt | 'user_input')[];
  should_silence?: boolean;
  max_chat_history?: number;
  /** 监听器用：分析类型标签（如"大总结""梦呓"等） */
  _monitorLabel?: string;
  /** 分析类型 key，用于从 API 库中查找对应配置（如 'grand_summary', 'small_summary' 等） */
  _analysisType?: string;
  /** 中止信号：外部可通过 AbortController 取消正在进行的请求 */
  _abortSignal?: AbortSignal;
  /** 最大重试次数，默认3。设为0跳过自动重试（如批量总结已有外层重试） */
  _maxRetries?: number;
  /** 响应格式：json_object 要求API以JSON格式返回（用于大总结/角色记忆等结构化解析） */
  _responseFormat?: 'json_object' | 'text';
  /** 温度，默认 0.7 */
  _temperature?: number;
  /** 最大 token 数，默认 65536 */
  _maxTokens?: number;
  [key: string]: unknown;
}

/** 分析类型 → API 配置 路由 */
function getApiConfigForType(analysisType?: string): ApiConfig | null {
  const store = useMainStore();
  const settings = store.settings as any;
  const library: ApiConfig[] = settings.apiLibrary || [];
  if (library.length === 0) return null;

  // 查找分配的 API ID
  const assignments: Record<string, string> = settings.apiAssignments || {};
  const assignedId = analysisType ? assignments[analysisType] : undefined;

  // 优先用分配的配置，找不到则用第一个
  if (assignedId) {
    const found = library.find(a => a.id === assignedId);
    if (found) return found;
  }
  return library[0];
}

/**
 * 调用 LLM 生成（通过 API 库路由）
 * 返回原始响应字符串，与 generateRaw() 返回格式一致
 * 默认自动重试3次（可通过 _maxRetries 覆盖，设为0跳过重试）
 */
export async function callGenerateRaw(params: GenerateRawParams): Promise<string> {
  const store = useMainStore();
  const settingsMaxRetries = (store.settings as any).apiMaxRetries;
  const maxRetries = params._maxRetries ?? (typeof settingsMaxRetries === 'number' ? settingsMaxRetries : 3);
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 循环顶部检查用户是否点了"取消重试"
    if (store.isApiRetryAborted()) {
      store.clearApiRetry();
      throw new Error('用户已取消重试');
    }
    if (attempt > 0) {
      const delay = 0;
      const delaySec = delay / 1000;
      const errMsg = lastError?.message || String(lastError || '');
      store.showApiRetry({
        analysisName: params._monitorLabel || '后台分析',
        attempt,
        maxRetries,
        error: errMsg,
        delaySec,
      });
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const result = await doCallGenerateRaw(params);
      if (attempt > 0) store.clearApiRetry();
      return result;
    } catch (err: any) {
      lastError = err;
      if (err?.name === 'AbortError') {
        store.clearApiRetry();
        throw err;
      }
      // 用户主动取消，不继续重试，直接外抛由调用方按失败处理
      if (err?.message === '用户已取消重试') {
        store.clearApiRetry();
        throw err;
      }
      if (attempt >= maxRetries) {
        store.clearApiRetry();
        logError('API调用', `重试${maxRetries}次后放弃`, errMsg);
        throw err;
      }
    }
  }
  throw lastError;
}

/** callGenerateRaw 的单次执行体 */
async function doCallGenerateRaw(params: GenerateRawParams): Promise<string> {
  const store = useMainStore();
  const settings = store.settings;

  const apiConfig = getApiConfigForType(params._analysisType);
  if (!apiConfig || !apiConfig.url || !apiConfig.key) {
    throw new Error('API未配置：请在设置的API库中添加并分配API配置');
  }

  const modelName = apiConfig.model || '';
  const userName = typeof store.getUserName === 'function' ? store.getUserName() : '{{user}}';
  const customizedPrompts = applyJailbreakOverrideToOrderedPrompts(
    params.ordered_prompts,
    params._analysisType,
    (settings as any).jailbreakOverrides,
    userName,
  );
  const orderedPrompts = adaptClaudePrefill(customizedPrompts, modelName);
  const userInput = applyJailbreakOverrideToUserInput(
    params.user_input,
    params._analysisType,
    (settings as any).jailbreakOverrides,
  );
  const messages = buildOpenAIMessages(orderedPrompts, userInput);
  const apiUrl = normalizeApiUrl(apiConfig.url.trim());

  const startTime = Date.now();
  const analysisName = params._monitorLabel || '后台分析';
  const temperature = params._temperature ?? 0.7;
  const maxTokens = params._maxTokens ?? 65536;

  // 失败分支统一记录到 API 监听后再抛错（成功路径在末尾单独 push）
  function recordFailAndThrow(responseText: string, errorSummary: string, err: Error): never {
    const durationMs = Date.now() - startTime;
    store.pushApiMonitorLog({
      timestamp: new Date().toISOString(),
      analysisName,
      model: modelName || '?',
      messages,
      response: responseText,
      durationMs,
      error: errorSummary,
    });
    throw err;
  }

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.key}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(params._responseFormat ? { response_format: { type: params._responseFormat } } : {}),
      }),
      signal: params._abortSignal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    recordApiFailure();
    logError('API调用', 'fetch失败（CORS或网络问题）', String(err.message || err));
    const netErr = new Error(`网络请求失败: ${err.message || err}\n提示：如果酒馆通过HTTPS加载，API也需要HTTPS；本地API可能需要配置CORS。`);
    recordFailAndThrow('', `网络请求失败: ${err.message || err}`, netErr);
  }

  if (!response.ok) {
    recordApiFailure();
    const errorText = await response.text().catch(() => '(无法读取响应)');
    logError('API调用', `返回错误: ${response.status} ${response.statusText}`);

    if (response.status === 404) {
      const err404 = new Error(
        `API 404 Not Found\n` +
        `请求地址: ${apiUrl}\n` +
        `提示: 请确认URL是否包含完整路径（通常以 /v1/chat/completions 结尾）`
      );
      recordFailAndThrow(errorText, `API 404 Not Found: ${apiUrl}`, err404);
    }

    const httpErr = new Error(`API请求失败 (${response.status}): ${errorText}`);
    recordFailAndThrow(errorText, `API ${response.status} ${response.statusText}`, httpErr);
  }

  const data = await response.json().catch(() => null);
  if (!data) {
    recordApiFailure();
    const emptyErr = new Error('API返回了空响应或非JSON格式');
    recordFailAndThrow('', 'API返回了空响应或非JSON格式', emptyErr);
  }

  const rawContent = data?.choices?.[0]?.message?.content;
  if (!rawContent) {
    logError('API调用', '返回结构异常', JSON.stringify(data).slice(0, 500));
    const structErr = new Error(`API返回格式异常，未找到 choices[0].message.content`);
    recordFailAndThrow(JSON.stringify(data).slice(0, 500), '返回结构异常，未找到 choices[0].message.content', structErr);
  }

  const content = stripThinking(rawContent);

  const durationMs = Date.now() - startTime;
  store.pushApiMonitorLog({
    timestamp: new Date().toISOString(),
    analysisName,
    model: modelName || '?',
    messages,
    response: rawContent,
    durationMs,
  });

  return content;
}

function adaptClaudePrefill(
  orderedPrompts: (OrderedPrompt | 'user_input')[],
  modelName: string,
): (OrderedPrompt | 'user_input')[] {
  if (!/claude/i.test(modelName)) return orderedPrompts;

  const prompts = [...orderedPrompts];
  for (let i = prompts.length - 1; i >= 0; i--) {
    const item = prompts[i];
    if (item !== 'user_input' && item.role === 'assistant') {
      prompts[i] = { ...item, role: 'system' };
      break;
    }
  }
  return prompts;
}

/**
 * 规范化 API URL：如果 URL 未以 /chat/completions 结尾，自动追加
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

/**
 * 剥离 AI 原生思维链/推理内容
 * 兼容：<think>...</think>、<thinking>...</thinking>、[reasoning]...[/reasoning]、[thinking]...[/thinking]
 */
function stripThinking(text: string): string {
  const closeTags = ['</think>', '</thinking>', '[/reasoning]', '[/thinking]'];
  let bestEnd = -1;
  for (const tag of closeTags) {
    const idx = text.lastIndexOf(tag);
    if (idx > bestEnd) bestEnd = idx;
  }
  if (bestEnd > 0) {
    return text.slice(bestEnd + (closeTags.find(t => text.lastIndexOf(t) === bestEnd)?.length || 0)).trim();
  }
  const openTags = ['<think>', '<thinking>', '[reasoning]', '[thinking]'];
  for (let i = 0; i < openTags.length; i++) {
    const openIdx = text.indexOf(openTags[i]);
    const closeIdx = text.indexOf(closeTags[i]);
    if (openIdx >= 0 && closeIdx > openIdx) {
      return text.slice(closeIdx + closeTags[i].length).trim();
    }
  }
  return text;
}

// ========== 模型列表获取 ==========

/**
 * 获取指定 API 的可用模型列表
 * 兼容 OpenAI / DeepSeek / 中转站等 /v1/models 接口
 */
export async function fetchAvailableModels(apiUrl: string, apiKey: string): Promise<string[]> {
  let modelsUrl = apiUrl.trim().replace(/\/+$/, '');
  if (modelsUrl.endsWith('/chat/completions')) {
    modelsUrl = modelsUrl.replace('/chat/completions', '/models');
  } else if (modelsUrl.endsWith('/v1')) {
    modelsUrl = modelsUrl + '/models';
  } else if (!modelsUrl.endsWith('/models')) {
    modelsUrl = modelsUrl + '/v1/models';
  }

  const store = useMainStore();
  const maxRetries = (store.settings as any).apiMaxRetries ?? 3;
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = 1000 * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const response = await fetch(modelsUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`获取模型列表失败 (${response.status}): ${errText.slice(0, 200)}`);
      }

      const data = await response.json();
      if (Array.isArray(data?.data)) {
        return data.data.map((m: any) => m.id || m.name || '').filter(Boolean).sort();
      }
      if (Array.isArray(data)) {
        return data.map((m: any) => (typeof m === 'string' ? m : m.id || m.name || '')).filter(Boolean).sort();
      }
      throw new Error('模型列表返回格式不支持');
    } catch (err: any) {
      lastError = err;
      if (err?.name === 'AbortError') throw err;
      if (attempt >= maxRetries) throw err;
    }
  }
  throw lastError;
}

export type { GenerateRawParams, OrderedPrompt };
