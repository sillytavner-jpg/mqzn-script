/**
 * 统一 API 调用封装
 *
 * 通过 API 库 (apiLibrary) 路由不同分析类型到不同的 API 配置。
 * 所有请求均使用 OpenAI-compatible 格式。
 */

import { useMainStore, type ApiConfig } from '../stores/mainStore';
import { logError } from '../utils/logger';
import { isFlashMode, buildFlashTail } from './jailbreakIdentity';

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
      // 标记为「重试也没用」的错误（如内容被过滤拦截 / 输出被截断）——
      // 同样的请求再发一次结果不会变，只会白等三轮
      if ((err as any)?._noRetry) {
        store.clearApiRetry();
        logError('API调用', '该错误重试无意义，直接放弃', err?.message || String(err || ''));
        throw err;
      }
      if (attempt >= maxRetries) {
        store.clearApiRetry();
        logError('API调用', `重试${maxRetries}次后放弃`, err?.message || String(err || ''));
        throw err;
      }
    }
  }
  throw lastError;
}

/**
 * flash 模式的破限投放 —— 两件事：
 *
 *  ① **摘掉末尾的 assistant prefill（卡思维链）**
 *     智脑各模块原本都以 `{role:'assistant', content:'<thinking>'}` 收尾，
 *     用「已经替它开了个头」的方式把模型按进思维链里。
 *     这招对老模型好使，但对 3.7f / 3.8f 这类自带推理机制的新模型是有害的 ——
 *     强行替它起头会**劫持它的原生思维链**，所以 flash 模式绝对不能加。
 *     （预设里那条 prefill 的 identifier 就叫 `cot_hijack`，标注为「3.1 Pro 破限」）
 *
 *  ② **把「重申 + 输出契约」压到最末**
 *     位置对应预设里的 jb_tail / output_contract（排在第 62/63 位，紧贴输出点）。
 *     不再靠 prefill 起头，改由契约文本约束它自己以 `<thinking>` 开头。
 *
 * legacy 模式原样返回（老模型继续吃 prefill 这一套）。
 */
function applyFlashJailbreak(
  prompts: Array<OrderedPrompt | 'user_input'>,
  analysisType?: string,
): Array<OrderedPrompt | 'user_input'> {
  if (!isFlashMode(analysisType)) return prompts;
  const tail = buildFlashTail(analysisType);
  if (!tail) return prompts;

  const next = [...prompts];

  // ① 摘掉末尾的 assistant prefill（只在它确实位于最末时动手）
  let lastIdx = -1;
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] !== 'user_input') {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx >= 0) {
    const last = next[lastIdx];
    if (last !== 'user_input' && last.role === 'assistant') {
      next.splice(lastIdx, 1);
    }
  }

  // ② 尾部破限压到最末
  next.push({ role: 'system', content: tail });
  return next;
}

/** 把 prompt 里的 {{user}} 换成实际玩家名（酒馆不会替脚本注入的文本做宏替换） */
function fillUserToken(prompts: Array<OrderedPrompt | 'user_input'>, userName: string): void {
  if (!userName) return;
  for (const p of prompts) {
    if (p === 'user_input') continue;
    if (p.content.includes('{{user}}')) {
      p.content = p.content.replace(/\{\{user\}\}/g, userName);
    }
  }
}

/** callGenerateRaw 的单次执行体 */
async function doCallGenerateRaw(params: GenerateRawParams): Promise<string> {
  const store = useMainStore();

  const apiConfig = getApiConfigForType(params._analysisType);
  if (!apiConfig || !apiConfig.url || !apiConfig.key) {
    throw new Error('API未配置：请在设置的API库中添加并分配API配置');
  }

  const modelName = apiConfig.model || '';
  const userName = typeof store.getUserName === 'function' ? store.getUserName() : '{{user}}';
  // 破限词按「分析类型」生效：API 库管理 → 分析类型分配里可逐条指定 legacy / flash，
  // 未指定的类型跟随全局默认（总览 → 智脑设置不再提供开关，已移入 API 库管理）。
  const basePrompts = [...params.ordered_prompts];
  // flash 破限：① 摘掉末尾卡思维链的 prefill ② 末尾压「重申 + 输出契约」
  const tailedPrompts = applyFlashJailbreak(basePrompts, params._analysisType);
  // 破限段里的 {{user}} 是脚本字面量，酒馆不会替我们替换，这里补上
  fillUserToken(tailedPrompts, userName);
  const orderedPrompts = adaptClaudePrefill(tailedPrompts, modelName);
  const userInput = params.user_input;
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
    // ⚠️ 这条文案会显示在右上角的重试浮层里 —— 必须**自带请求地址**，
    //    否则用户只知道"失败了"，不知道是哪个 API 挂了，也没法自己排查。
    const netErr = new Error(
      `网络请求失败：${err.message || err}\n`
      + `请求地址：${apiUrl}\n`
      + '可能原因：① 地址不通（服务未启动 / 端口写错）② 服务端未开启 CORS '
      + '③ HTTPS 页面调用 HTTP 接口被浏览器拦截（本地 API 常见）④ 网络中断，或被中转站掐断连接。\n'
      + '注意：这是浏览器层的连接失败，不是 API 返回的错误码；完整请求记录见「总览 → API 监听」。',
    );
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
    // ⚠️ 以前这里一律报「返回格式异常」，但空 content 其实有好几种完全不同的原因，
    //    误报会让用户以为是自己配置错了。现在按 finish_reason 分开说。
    const finishReason = String(data?.choices?.[0]?.finish_reason || '');
    const completionTokens = Number(data?.usage?.completion_tokens || 0);

    // ① 被供应商的内容审核拦截：模型其实生成了内容（completion_tokens > 0），
    //    但审核把它换成了空串，并给出一个"被拦"的 finish_reason。
    //    这不是格式问题，**重试也没用**（同样的内容还会被拦）。
    //
    // ⚠️ finish_reason 是**服务端**打的标记（OpenAI 规范字段），智脑只读不猜。
    //    不同渠道的写法不一样，所以这里收一份白名单：
    //      content_filter      —— OpenAI 官方 / 多数中转站（最常见的写法）
    //      safety / SAFETY     —— Google Gemini 原生
    //      prohibited_content  —— Gemini 1.5+ 的 PROHIBITED_CONTENT
    //      recitation / blocklist / spii / image_safety —— 其他审核类原因
    //    （统一 toLowerCase 比较，兼容下划线与驼峰）
    const FILTER_FINISH_REASONS = [
      'content_filter', 'safety', 'prohibited_content', 'blocked',
      'recitation', 'blocklist', 'spii', 'image_safety',
    ];
    if (FILTER_FINISH_REASONS.includes(finishReason.toLowerCase())) {
      // 只陈述事实（谁拦的、拦了多少），不给处置建议 —— 建议交给用户自己判断
      const filteredErr = new Error(
        `API 内容被过滤拦截（finish_reason: ${finishReason || 'content_filter'}）\n`
        + `模型：${modelName}｜请求地址：${apiUrl}\n`
        + (completionTokens > 0 ? `模型已生成 ${completionTokens} tokens，但被服务端安全审核拦下，内容未返回。` : ''),
      );
      (filteredErr as any)._noRetry = true;
      logError(
        'API调用',
        `内容被过滤拦截（content_filter）model=${modelName} completion_tokens=${completionTokens}`,
        JSON.stringify(data).slice(0, 500),
      );
      recordFailAndThrow(
        JSON.stringify(data).slice(0, 500),
        // 摘要里带上已生成的 token 数：让人一眼看出"模型其实写了，是被拦掉的"
        `内容被过滤拦截（${finishReason}，模型 ${modelName}${completionTokens > 0 ? `，已生成 ${completionTokens} tokens 但未返回` : ''}）`,
        filteredErr,
      );
    }

    // ② 输出被 max_tokens 截断
    if (finishReason === 'length') {
      const lenErr = new Error(
        `API 输出被长度上限截断（finish_reason: ${finishReason || 'length'}）\n`
        + `模型：${modelName}｜请求地址：${apiUrl}\n`
        + `输出 token 用尽仍未产出完整内容（completion_tokens：${completionTokens}）。`,
      );
      (lenErr as any)._noRetry = true;
      logError('API调用', `输出被截断（length）model=${modelName}`, JSON.stringify(data).slice(0, 300));
      recordFailAndThrow(JSON.stringify(data).slice(0, 300), '输出被长度上限截断（length）', lenErr);
    }

    // ③ 其他空响应：把 finish_reason / token 数一并带上，别只说"格式异常"
    logError('API调用', '返回结构异常', JSON.stringify(data).slice(0, 500));
    const structErr = new Error(
      'API 返回了空内容（未找到 choices[0].message.content）\n'
      + `模型：${modelName}｜请求地址：${apiUrl}\n`
      + `finish_reason：${finishReason || '(缺失)'}｜completion_tokens：${completionTokens}`,
    );
    // 这种多半是渠道抖动 → 允许重试（不设 _noRetry）
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
