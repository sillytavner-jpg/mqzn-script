/**
 * MVU 额外模型解析守卫 —— 给持久注入（injectPrompts）用。
 *
 * 背景：injectPrompts 注册的注入是持久句柄，每一轮主 API 调用都会生效，
 * 包括 MVU 变量框架"额外模型解析变量"那轮（type='normal'，与正常聊天相同）。
 * 仅在 CHAT_COMPLETION_SETTINGS_READY 入口 return 拦不住已注册的持久注入
 * （那只能跳过本轮"重新注入/更新句柄"的逻辑，旧句柄还在挂着继续注入）。
 *
 * 而且酒馆 IN_CHAT 类型注入的 filter 求值有 bug：
 * script.js 的 getExtensionPrompt 用 Array.filter(filterByFunction)，
 * 但 filterByFunction 是 async 返回 Promise，Array.filter 把 Promise 当 truthy，
 * 导致 filter 返回 false 仍被保留——filter 形同虚设。
 *
 * 解法：在 CHAT_COMPLETION_SETTINGS_READY 回调里检测到 MVU 解析轮
 * （Mvu.isDuringExtraAnalysis() === true）时，直接清洗 generate_data.messages
 * 里已注入的智脑标签块。此时消息已组装完但 fetch 未发，改 messages.content 能生效
 * （sendOpenAIRequest 在 emit 之后才 JSON.stringify(generate_data) 发 fetch）。
 * 没装 MVU 时 typeof Mvu === 'undefined'，零副作用。
 */

/**
 * 智脑注入到上下文的标签块清单（开闭标签名）。
 * 这些是智脑各模块通过 injectPrompts 或直接改 messages 塞进上下文的标签，
 * MVU 解析轮需从 generate_data.messages 里剥离。
 *
 * 注意：neural_chain 的实际标签是 memory_chain（可能带角色名后缀，如 memory_chain_江念），
 * 用正则 <memory_chain[\s>] 匹配以覆盖带后缀变体。
 */
const ZHINO_INJECTION_TAGS: string[] = [
  'world_state',
  'world_entry_hint',
  'factual_state',
  'dynamic_profile',
  'memory_chain',
  'neural_chain',
  'world_graph',
  'worldbook_tag_index',
  'before_character_definition_tags',
  'after_character_definition_tags',
  'grand_summary',
  'plot_guidance',
  'plot_check',
  'plot_outline',
  'relationship_profiles',
  'nsfw_memory',
  'nsfw_dynamic_profile',
  'nsfw_dreamtalk',
  'nsfw_isolation',
  'dreamtalk',
  'user_persona',
  'character_memory',
  'context_summary',
  'knowledge_graph',
  'world_progress',
];

/**
 * 智脑注入时写在标签块之外的固定引导句（整行匹配删除）。
 * 这些是各模块在 push 标签前后加的中文说明/提示行，不含动态数据，
 * 标签块清洗正则匹配不到，需单独整行删除。
 * 引导句里可能含 {{user}} 等酒馆宏，匹配时按字面量（已转义）。
 * 每项是正则源串片段（已转义特殊字符），整行匹配（行首可选空白、行尾可有冒号变体等）。
 */
const ZHINO_INJECTION_LEAD_LINES: string[] = [
  // dynamicProfileV2.ts:364
  '\\*\\*以下优先于原人设，出现OC时融合原人设兜底：\\*\\*',
  // neuralChain.ts:153
  '\\*\\*以下是当前场景相关的可用记忆链，正文创作时可自然引用这些记忆作为角色行为的依据：\\*\\*',
  // relationshipAnalysis.ts:611
  '\\*\\*以下是当前在场角色之间的稳定关系档案（已整理确认，直接作为角色互动的设定参考）：\\*\\*',
  // worldBookTags.ts:186
  '以下是用户手动绑定的世界书标签索引。看到同名标签时，优先按这里的含义召回对应设定；索引用于辅助思考，不要直接输出。',
  // worldGraphInject.ts:491
  '当前场景图谱（保持地点、物品归属和可用性一致）：',
  // plotDirector.ts:391 / 572
  '\\[剧情导演提示 — 仅供创作参考，不要直接复述\\]',
  '\\[剧情导演提示 — 仅供创作参考\\]',
  // plotDirector.ts:401 / 592
  '\\[注意：自然过渡，不要生硬推进，让剧情有机发展\\]',
  '\\[自然过渡，不要生硬\\]',
  // worldProgress.ts:759 / 816
  '\\[场外角色动态\\]',
  '\\[自然入场引导\\]',
  // worldProgress.ts:817
  '- 以下为入场参考，非强制指令。仅当当前正文场景可自然衔接、且该角色尚未登场时才采纳入场；若场景已变、角色已登场或无合理衔接，请忽略本提示，照常推进原有剧情。',
  // dreamtalk.ts:898 / 900
  '以下信息供AI扮演\\{\\{user\\}\\}角色的参考，不是给\\{\\{user\\}\\}对面的角色看的。',
  '以下信息用于校准AI对\\{\\{user\\}\\}行为方式的正确理解，不是角色设定。',
  // plotDirector.ts:583 / 587 / 591
  '\\[引导提示\\].*',
  '\\[角色登场提示\\].*',
  '\\[进度提示\\].*',
  // dynamicProfileV2.ts:131（构建正文材料用的引导句，注入路径可能不出现，兜底）
  '以下是正文和上次的角色状态，你必须仔细阅读',
];

/**
 * 构造匹配智脑注入标签块（含后缀变体）的正则。
 * 匹配 <tag> ... </tag>（含角色名后缀如 <factual_state_江念>）。
 */
function buildTagBlockRegex(): RegExp {
  // 每个标签名作为前缀，后跟可选 _角色名 后缀，再跟 > 或空白
  // 用 \s\S 非贪婪匹配块内容
  const alternation = ZHINO_INJECTION_TAGS
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  // <tag 或 tag_suffix> ... </tag 或 tag_suffix>
  // 闭合标签同样允许后缀（实际闭合一般无后缀，但兜底）
  return new RegExp(
    '<(?:' + alternation + ')(?:_[^>]*)?>[\\s\\S]*?</(?:' + alternation + ')(?:_[^>]*)?>',
    'gi',
  );
}

/**
 * 构造匹配智脑注入固定引导句（整行）的正则。
 * 行首允许任意空白；匹配到行尾（含可能的尾随空白）。
 */
function buildLeadLineRegex(): RegExp {
  // 整行匹配：行首空白 + 引导句 + 行尾
  const alternation = ZHINO_INJECTION_LEAD_LINES.join('|');
  return new RegExp('^[ \\t]*(?:' + alternation + ')[ \\t]*$', 'gim');
}

/**
 * 当前是否为 MVU 额外模型解析轮。
 * - MVU 正在额外模型解析 → true
 * - 其它情况（正常聊天 / 没装 MVU / Mvu 未初始化）→ false
 */
export function isMvuExtraAnalysis(): boolean {
  try {
    if (typeof Mvu !== 'undefined' && (Mvu as any)?.isDuringExtraAnalysis?.()) {
      return true;
    }
  } catch (_) { /* Mvu 未初始化等异常，按非解析轮处理 */ }
  return false;
}

/**
 * 从 generate_data.messages 里剥离智脑注入的标签块。
 * 在 CHAT_COMPLETION_SETTINGS_READY 回调里检测到 MVU 解析轮时调用：
 * 遍历 messages 数组，把每条 message.content 里的智脑标签块（<world_state>...</world_state> 等）删掉。
 *
 * @param completion CHAT_COMPLETION_SETTINGS_READY 的 payload（generate_data）
 * @returns 是否做了清洗（true=有标签被剥离）
 */
export function stripZhinoInjectionsFromCompletion(completion: any): boolean {
  if (!completion || typeof completion !== 'object') return false;
  const messages = (completion as any).messages;
  if (!Array.isArray(messages)) return false;

  const blockRe = buildTagBlockRegex();
  const leadRe = buildLeadLineRegex();
  let stripped = false;

  const cleanContent = (content: string): string => {
    if (typeof content !== 'string' || !content.includes('<') && !/[*\u4e00-\u9fa5]/.test(content)) return content;
    // 先删标签块，再删标签外引导句，最后压多余空行
    let cleaned = content.replace(blockRe, '');
    cleaned = cleaned.replace(leadRe, '');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
    return cleaned;
  };

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const content = msg.content;
    if (typeof content !== 'string') continue;
    const cleaned = cleanContent(content);
    if (cleaned !== content) {
      msg.content = cleaned;
      stripped = true;
    }
  }

  // 兜底：有些注入走 ordered_prompts（custom_api 路径）
  const ordered = (completion as any).ordered_prompts;
  if (Array.isArray(ordered)) {
    for (const p of ordered) {
      if (!p || typeof p !== 'object') continue;
      const c = p.content;
      if (typeof c !== 'string') continue;
      const cleaned = cleanContent(c);
      if (cleaned !== c) {
        p.content = cleaned;
        stripped = true;
      }
    }
  }

  return stripped;
}