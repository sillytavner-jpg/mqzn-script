/**
 * 统一 API 调用封装
 *
 * 通过 API 库 (apiLibrary) 路由不同分析类型到不同的 API 配置。
 * 所有请求均使用 OpenAI-compatible 格式。
 */

import { useMainStore, type ApiConfig } from '../stores/mainStore';
import { logError, logInfo, logWarn } from '../utils/logger';
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
  /**
   * @deprecated A5.4.0 起 `callGenerateRaw` 不再自带重试，本参数已无效。
   * 重试统一由后台队列负责。保留字段仅为兼容旧调用签名，新代码请勿使用。
   */
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
 *
 * ⚠️ **本函数只发一次请求，不做任何重试** ——
 * 重试统一由外层负责（后台队列 `backgroundQueue` 的 runTask，或调用方自己的循环）。
 * 这样保证任何调用链上「重试」只发生在一个地方，不会出现 3×3 = 9 次的叠加放大。
 *
 * `_maxRetries` / `apiMaxRetries` 已不再在此生效，保留参数仅为兼容旧调用签名。
 */
export async function callGenerateRaw(params: GenerateRawParams): Promise<string> {
  return doCallGenerateRaw(params);
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
// ========== 流式（SSE）支持 ==========
//
// 为什么改用流式：非流式请求发出后要干等到全部生成完（大总结实测 31 秒），
// 中间浏览器收不到任何一个字节 —— 代理软件 / 网关 / 中转站的"静默超时"
// 经常会在这段真空期把连接掐掉，表现为 `Failed to fetch`。
// 流式让连接持续有数据流动，各层都会视其为活跃连接，同时也能拿到实时进度。

export interface StreamProgress {
  /** 已累积的正文字符数 */
  chars: number;
  /** 从开始接收至今的毫秒数 */
  elapsedMs: number;
}

/**
 * 解析 OpenAI 兼容的 SSE 流，累积正文与思维链。
 *
 * 兼容性说明（都是实际踩过的坑）：
 * - 正文在 `choices[0].delta.content`，但个别渠道用 `message.content` 一次性给全 → 两者都认
 * - 思维链字段各家不同：`reasoning_content` / `reasoning` / `thinking` → 都收集
 * - 结束标记是 `data: [DONE]`；也有渠道直接断流 → 断流即视为结束
 * - 流中可能夹 `data: {"error": ...}` → 抛出交给上层按错误处理
 * - TCP 分块会把一行切成两半 → 用 buffer 累积到换行再解析
 * - 看门狗：首字节 60 秒、后续每两个分块之间 120 秒 —— 超时就主动断开，
 *   否则连接建立了但不再吐数据时会永久挂住
 */
async function readSSEStream(
  response: Response,
  onProgress?: (p: StreamProgress) => void,
): Promise<{ content: string; thinking: string; finishReason: string; usage: any }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('响应没有可读流（该渠道可能不支持流式）');

  const FIRST_BYTE_TIMEOUT_MS = 60_000;
  const IDLE_TIMEOUT_MS = 120_000;

  const decoder = new TextDecoder('utf-8');
  const startedAt = Date.now();
  let buffer = '';
  let content = '';
  let thinking = '';
  let finishReason = '';
  let usage: any = null;
  let streamError: any = null;
  let gotAnyChunk = false;
  let lastNotify = 0;
  /** 是否解析到过 SSE 事件（一条都没有 = 响应根本不是 SSE 格式 → 抛错交给上层重试） */
  let sawSseEvent = false;
  /** 是否收到过 `data: [DONE]` 结束标记（判断"流被掐断"用） */
  let sawDone = false;

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      const timeoutMs = gotAnyChunk ? IDLE_TIMEOUT_MS : FIRST_BYTE_TIMEOUT_MS;
      chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error(`流式超时：${Math.round(timeoutMs / 1000)} 秒内没有收到数据`)),
          timeoutMs,
        )),
      ]);
    } catch (err) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw err;
    }

    if (chunk.done) break;
    gotAnyChunk = true;
    buffer += decoder.decode(chunk.value, { stream: true });

    let nlIdx = buffer.indexOf('\n');
    while (nlIdx >= 0) {
      const line = buffer.slice(0, nlIdx).replace(/\r$/, '');
      buffer = buffer.slice(nlIdx + 1);
      nlIdx = buffer.indexOf('\n');

      if (!line || line.startsWith(':')) continue;          // 空行 / 注释心跳
      if (!line.startsWith('data:')) continue;
      sawSseEvent = true;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') { sawDone = true; continue; }

      let json: any;
      try { json = JSON.parse(payload); } catch { continue; }

      if (json?.error) { streamError = json.error; break; }
      if (json?.usage) usage = json.usage;

      const choice = json?.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = String(choice.finish_reason);

      const delta = choice.delta || choice.message || {};
      if (typeof delta.content === 'string' && delta.content) content += delta.content;
      const rc = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
      if (typeof rc === 'string' && rc) thinking += rc;
    }
    if (streamError) break;

    // 进度回调节流（~150ms）：高频触发响应式更新会把界面拖卡
    const now = Date.now();
    if (onProgress && now - lastNotify > 150) {
      lastNotify = now;
      onProgress({ chars: content.length, elapsedMs: now - startedAt });
    }
  }

  if (streamError) {
    const msg = typeof streamError === 'string'
      ? streamError
      : (streamError.message || JSON.stringify(streamError));
    throw new Error(`流式返回错误：${msg}`);
  }
  // 响应不是 SSE（一条 data: 事件都没有）→ 直接抛错，交给上层重试。
  // ⚠️ **故意不做"猜格式"的兼容**：渠道不规范是渠道的问题，
  //    智脑只需把失败如实暴露、让用户去 API 日志看清现场 —— 猜多了反而更难排查。
  if (!sawSseEvent) {
    throw new Error('响应不是 SSE 格式（该渠道可能不支持流式），可在设置里关闭流式改用非流式');
  }

  // ⚠️ 截断检测：流正常结束时，要么带 finish_reason，要么发过 [DONE] 结束标记。
  //    两者都没有 = 连接在中途被掐断（网络中断 / 代理超时 / 渠道主动断开），
  //    此时内容是不完整的 —— **绝不能当完整结果录入**，抛错交给上层重试。
  if (!finishReason && !sawDone) {
    throw new Error(
      '流式响应疑似被截断：连接已结束，但既没有 finish_reason 也没有 [DONE] 结束标记'
      + `（已收到 ${content.length} 字）。可能是网络中断、代理 / 网关超时，或渠道主动断开。`,
    );
  }

  if (onProgress) onProgress({ chars: content.length, elapsedMs: Date.now() - startedAt });

  return { content, thinking, finishReason, usage };
}

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

  // ── 流式请求（默认路径）──
  //    理由见 readSSEStream 上方注释（非流式的长静默期会被代理 / 网关掐断）。
  //    ⚠️ **不做自动降级**：失败就如实抛错 → 上层重试 → 仍失败则提示用户看 API 日志。
  //    只有用户在设置里手动关掉流式（streamingEnabled = false）时才走下面的非流式分支。
  let data: any = null;
  const streamingOn = (store.settings as any)?.streamingEnabled !== false;

  if (streamingOn) {
    try {
      const sResp = await fetch(apiUrl, {
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
          stream: true,
          ...(params._responseFormat ? { response_format: { type: params._responseFormat } } : {}),
        }),
        signal: params._abortSignal,
      });
      if (!sResp.ok) throw new Error(`HTTP ${sResp.status} ${sResp.statusText}`);

      const streamed = await readSSEStream(sResp, (p) => {
        store.setApiProgress({ analysisName, chars: p.chars, elapsedMs: p.elapsedMs });
      });

      // 拼成与非流式**等价**的 data → 后面的「空内容判定 + finish_reason 分类」原样复用
      data = {
        choices: [{
          index: 0,
          message: { role: 'assistant', content: streamed.content },
          finish_reason: streamed.finishReason || 'stop',
        }],
        usage: streamed.usage || { completion_tokens: 0 },
        _streamed: true,
      };
      logInfo(
        'API调用',
        `流式完成：正文 ${streamed.content.length} 字（${analysisName}）`,
        `finish=${streamed.finishReason || '?'}`,
      );
      // ⚠️ 撞上 token 上限：内容虽然拿到了，但很可能是"写一半就断"。
      //    这种通常紧接着就报 JSON 解析失败 —— 在这里先说清原因，
      //    免得用户/我们把它误判成"格式跑偏"。
      if (streamed.finishReason === 'length') {
        logWarn(
          'API调用',
          `⚠️ 输出被 token 上限截断（finish_reason=length，已生成 ${streamed.content.length} 字，${analysisName}）`
          + '：内容可能不完整',
        );
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      recordApiFailure();
      // ⚠️ **不降级、不猜格式**：渠道不规范是渠道的问题 ——
      //    这里如实抛错，由上层 callGenerateRaw 的重试机制兜住（默认 3 次）；
      //    重试仍失败时用户看到的就是这条（自带模型、地址与排查入口）。
      const streamErr = new Error(
        `API 流式请求失败：${err?.message || err}\n`
        + `模型：${modelName}｜请求地址：${apiUrl}\n`
        + '会自动重试；若反复失败，请到「总览 → API 监听」查看完整请求与响应，或看「代码日志」面板。',
      );
      recordFailAndThrow('', `流式请求失败: ${err?.message || err}`, streamErr);
    } finally {
      store.setApiProgress(null);
    }
  }

  // ── 非流式（仅当用户在设置里手动关掉流式时才会走这里）──
  if (!data) {
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

    data = await response.json().catch(() => null);
    if (!data) {
      recordApiFailure();
      const emptyErr = new Error('API返回了空响应或非JSON格式');
      recordFailAndThrow('', 'API返回了空响应或非JSON格式', emptyErr);
    }
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
