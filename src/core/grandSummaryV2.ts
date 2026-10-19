/**
 * 大总结V2 — 白描事实时间线
 * 步骤1：纯客观白描大总结（不含调色盘/角色分析）
 * 步骤2：角色记忆+NSFW（独立调用，见 characterMemoryUpdate.ts）
 * 输出用 <grand_summary> 标签包裹，固定格式文本。
 * 解析失败时直接拿标签内原始文本存储。
 */

import { buildBrainAccept, buildBrainHead } from '../utils/jailbreakIdentity';
import type { SmallSummaryRecord, CapturedContent } from '../stores/mainStore';
import { callGenerateRaw } from '../utils/apiCaller';
import { logInfo, logWarn } from '../utils/logger';
import { extractJson, safeJsonParse } from '../utils/jsonParse';
import { GrandSummaryV2Schema } from '../utils/schemas';
import { patchToGrandSummaryEvents } from './timelinePatchBridge';
import { parsePatchArray } from '../utils/stateDoc';
import {
  buildCharacterRosterSection,
  normalizeCharacterName,
  type CharacterNameEntry,
} from '../utils/characterNames';
import { formatThinkingChainForAnalysis } from '../utils/messageParser';

// ======== 破限常量（通用） ==========

// 破限身份（参考星光预设）：小左 主理本任务
function buildJailbreakHead(_userName: string): string {
  return buildBrainHead('小左', '理时间线', 'grand_summary');
}

function buildMoralAttack(_userName: string): string {
  return buildBrainAccept('小左', '时间线我来理，一条都不落', 'grand_summary');
}

const ASSISTANT_PREFILL = '<thinking>';

// ========== 时间工具 ==========

/** 解析 "XX年X月X日" 为 {year, month, day} */
function parseStoryDate(time: string): { year: number; month: number; day: number } | null {
  const m = time.match(/(\d+)年(\d+)月(\d+)日/);
  if (!m) return null;
  return { year: parseInt(m[1]), month: parseInt(m[2]), day: parseInt(m[3]) };
}

/** 粗略计算两个剧情日期之间的天数差（简化：每月30天） */
export function calcDaysBetween(
  from: { year: number; month: number; day: number },
  to: { year: number; month: number; day: number },
): number {
  const fromDays = from.year * 360 + from.month * 30 + from.day;
  const toDays = to.year * 360 + to.month * 30 + to.day;
  return Math.abs(toDays - fromDays);
}

/** 从时间字符串计算距今天数标注（需要当前剧情时间） */
export function annotateTimeDist(eventTime: string, currentTime: string): string {
  const eventDate = parseStoryDate(eventTime);
  const currentDate = parseStoryDate(currentTime);
  if (!eventDate || !currentDate) return eventTime;
  const days = calcDaysBetween(eventDate, currentDate);
  if (days === 0) return `${eventTime}（今日）`;
  if (days === 1) return `${eventTime}（昨日）`;
  return `${eventTime}（距今${days}天前）`;
}

// ======== 提示词构建 ==========

/** webpack 环境下 `require` 由运行时提供（项目未装 @types/node） */
declare const require: (id: string) => any;

/** 是否启用 patch 输出（灰度开关，缺省关 → 走旧的全量 JSON） */
function isPatchEnabled(): boolean {
  try {
    const mod = require('../stores/mainStore');
    const store = mod.useMainStore ? mod.useMainStore() : null;
    return store?.settings?.statePatchEnabled?.grand_summary === true;
  } catch {
    return false;
  }
}

function buildGrandSummaryInstruction(
  previousSummaryText: string | undefined,
  userName: string,
  usePatch = false,
  characterRoster?: CharacterNameEntry[],
): string {
  // 角色名册：给模型「谁是正式名、哪些称呼属于谁」的硬锚点。
  // 空名册返回空串（旧存档 / 首轮尚无角色），不影响原行为。
  const rosterSection = buildCharacterRosterSection(characterRoster || [], userName);

  const parts: string[] = [
    `${userName}: 现在需要你把以下剧情内容整理为完整连续时间线。`,
    '',
    '## 任务说明',
    '',
    '你需要阅读我提供的楼层原文材料，将其整理为客观事实时间线。',
    '这不是创作，是数据整理。只记录发生了什么。',
    '',
  ];

  if (rosterSection) {
    parts.push(rosterSection);
  }

  parts.push(
    '## 思维链要求',
    '',
    '在<thinking>中你必须按以下顺序思考（顺序不可调换）：',
    '',
    '0. **先建人，再写事**：通读材料，逐个列出出现的所有角色，对照「角色名册」确定每人唯一的正式名。',
    '   这一步禁止合并任何人——三个人就是三个人，两个角色名字再像也是两个人。',
    '1. 按时间顺序梳理所有事件',
    '2. 标记原文中的错误（名字不一致、时间矛盾、遗漏关键信息）',
    '3. 确认哪些事件是同一件事的不同描述。可以合并**事件**，但禁止合并**角色**；合并后的在场名单必须是各事件角色的并集。',
    '4. 检查上次大总结是否有未完成线索，本次是否有结局',
    '5. 逐个事件核对在场角色：这条事件里有几个人在做事/说话，presentCharacters 就要写几个，禁止只写主角。',
    '6. 检查时间格式是否规范（阿拉伯数字+标准时段）',
    '',
    '</thinking>后在<grand_summary>标签内输出正式结果。',
    '',
    '## 输出格式',
    '',
  );
  parts.push(
    ...(usePatch
      ? [
          '**第一行先写「本次涉及角色：A、B、C」**（把材料里出现的所有角色列全，禁止合并），',
          '**再写最多 3 行人话说明**（只列关键变化），最后输出增量补丁。',
          '',
          '```json 代码块，数组，**紧凑单行输出、禁止缩进换行美化**：',
          '[{"op":"set","path":"/timeline/1","value":{"time":"2025年2月5日晨","location":"咖啡馆","presentCharacters":["疏影"],"summary":"1-2句速览","event":"完整经过。5级4-6句(≤150字)/4级3-5句(≤120字)/3级2-4句(≤80字)/2级1-3句(≤60字)/1级1-2句(≤40字)。起因→经过→结果。保留关键对话原文用「」括起。禁止心理描写和修辞比喻。","importance":4,"keywords":["关键词1","关键词2"]}}]',
          '```',
          '',
          '**路径规范**：`/timeline/{序号}`，序号从 1 开始、按事件时间顺序递增。',
          '- 每条事件一个 set，不要输出空事件。',
          '- presentCharacters 只能取「本次涉及角色」里出现过的名字。',
          '- 与下面时间格式规则、铁律同时生效。',
        ]
      : [
          '**必须先列人，再写事件。**',
          '',
          '`castInMaterial` = 本次材料中出现的**所有角色**的正式名（**含玩家本人**，玩家统一写成 ' + userName + '）。这一步禁止合并任何人。',
          '`events[].presentCharacters` = 该事件实际出场的角色（**不含玩家本人**），只能从 `castInMaterial` 里取，不得出现没点过名的角色。',
          '',
          '输出以下JSON格式（用```json```代码块包裹）：',
          '',
          '```json',
          '{',
          '  "castInMaterial": ["本次材料中出现的所有角色正式名"],',
          '  "events": [',
          '    {',
          '      "time": "2025年2月5日晨",',
          '      "location": "咖啡馆",',
          '      "presentCharacters": ["疏影"],',
          '      "summary": "1-2句速览",',
          '      "event": "完整经过。5级4-6句(≤150字)/4级3-5句(≤120字)/3级2-4句(≤80字)/2级1-3句(≤60字)/1级1-2句(≤40字)。起因→经过→结果。保留关键对话原文用「」括起。禁止心理描写和修辞比喻。",',
          '      "importance": 1-5,',
          '      "keywords": ["关键词1","关键词2"]',
          '    }',
          '  ]',
          '}',
          '```',
        ]),
  );

  parts.push(
    '',
    '## 时间格式规则',
    '',
    '- 标准时段：晨/上午/午/下午/暮/夜/深夜',
    '- 中文数字→阿拉伯数字：九百四十二→942、一万三千→13000',
    '- 传统时辰→标准时段：卯时/辰时→上午、巳时/午时→午、未时/申时→下午、酉时→暮、戌时/亥时→夜、子时/丑时/寅时→深夜',
    '- 去掉纪元前缀（天元/混沌/洪荒等），只保留阿拉伯数字年份',
    '- 正确示例："2025年2月5日晨"、"94200年9月3日暮"',
    '',
    '## 铁律',
    '',
    '- 禁止创作新内容，只整理已有信息',
    '- 禁止心理描写、修辞比喻、情感修饰词',
    '- 保留关键对话原文用「」括起',
    '- 角色名必须用正式名称',
    '- **角色身份铁律**：不同角色永远是不同的人。禁止把多个角色写成同一个名字，禁止把 A 的行为归到 B 名下。',
    '- **在场名单铁律**：presentCharacters 必须是该事件中实际出场的全部角色。禁止只写主角；禁止用「众人」「师徒三人」「几名弟子」等集合称谓代替具体角色。',
    '- 无独立剧情线、无实质对话的一次性背景角色不保留',
    `- ${userName}始终在场，禁止列入在场名单`,
    `[重要] 必须称呼我为"${userName}"，禁止换成"哥哥""主人""他"等其他称呼`,
    '- 事件数量约束：4-12个（太少检查遗漏，太多合并相邻同类事件；**但合并事件不等于合并角色，合并后在场名单取并集，一个都不能少**）',
    '- 如果前一次大总结有未完成事件线索，本次需要补充结局',
  );

  if (previousSummaryText) {
    // 只取 Section 1（剧情时间线），去掉角色记忆和 NSFW
    const section1 = previousSummaryText.split(/---SECTION---/i)[0]?.trim() || previousSummaryText;
    parts.push('');
    parts.push('## 上次大总结（时间线续写参考）');
    parts.push('');
    parts.push(section1);
  }

  return parts.join('\n');
}

// ========== 输入材料构建 ==========

/**
 * 大总结输入材料：直接按楼层顺序铺原文，不再依赖小总结。
 *
 * 历史背景：A5.x 起小总结不再产出剧情摘要（不输出 mainEvent/storyTime），
 * 场景信息改由知识图谱承载，事件记忆全交大总结负责。同时小总结受后台队列
 * 「同类型最多1并发」限制，10 轮里多半被静默丢弃，smallSummaries 常年残缺。
 * 旧实现按 ready 小总结的 floorRange 反查原文，没小总结 anchor 的楼层会被
 * 静默丢弃 → 大总结只拿到第 1 轮原文。故彻底解耦，改为直接全量铺原文，
 * 与角色记忆（characterMemoryUpdate）行为一致。
 */
function buildInputMaterial(capturedContents: CapturedContent[]): string {
  const parts: string[] = [];
  parts.push(`## 本次待整理材料（共 ${capturedContents.length} 条楼层原文）`);
  parts.push('');

  const sorted = [...capturedContents].sort((a, b) => a.messageId - b.messageId);
  for (const c of sorted) {
    if (!c.content.trim()) continue;
    parts.push(`### 楼层 #${c.messageId}`);
    // 思维链锚点：与角色记忆（characterMemoryUpdate）保持一致。
    // 此前大总结不注入思维链，等于比角色记忆少一半「谁在说话/谁在场」的线索，
    // 群像场景更容易把不同角色并成一个人。
    const chain = formatThinkingChainForAnalysis(c.thinkingChain || '');
    if (chain) {
      parts.push(chain);
      parts.push('');
    }
    parts.push(`原文：${c.content.trim()}`);
    parts.push('');
  }

  return parts.join('\n');
}

// ======== 输出解析 ==========

export interface GrandSummaryV2Event {
  time: string;
  location: string;
  presentCharacters: string[];
  summary: string; // 1-2句速览，用于语义召回
  event: string;   // 完整经过（按重要性分级）
  importance: number;
  keywords: string[];
}

export interface GrandSummaryV2Result {
  events: GrandSummaryV2Event[];
  rawText: string;
  absorbedSmallSummaryIds: string[];
  /** 模型在写事件前先点名的角色清单（可能为空：旧格式输出或模型未遵守） */
  castInMaterial: string[];
}

/**
 * AI 输出最低限度校验：剔除思维链后判断是否为空响应/纯乱码。
 *
 * 注：AI 已被要求以 ```json``` 代码块输出结构化结果，是否"有效"完全由
 * 后续的 JSON 解析（extractJson + schema 校验）判定；此处不再用"道歉/拒绝"
 * 等词语列表做内容识别——合法 JSON 即使夹带这些词也是有效输出，词语列表只会误杀。
 */
function isEmptyOrGarbage(text: string): boolean {

  // 去掉思维链后内容太短（不是正常的事件输出）
  const stripped = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
  if (stripped.length < 20) return true;

  // 完全没有中文也没有英文单词 = 纯符号/乱码
  const hasChinese = /[\u4e00-\u9fff]/.test(stripped);
  const hasWord = /\b[a-zA-Z]{3,}\b/.test(stripped);
  if (!hasChinese && !hasWord) return true;

  return false;
}

function parseGrandSummaryOutput(rawText: string): { events: GrandSummaryV2Event[]; castInMaterial: string[] } {
  let text = rawText.trim();

  // 剥离思维链
  const thinkClose = Math.max(text.lastIndexOf('</think>'), text.lastIndexOf('</thinking>'));
  if (thinkClose > 0) {
    text = text.slice(thinkClose + (text.includes('</thinking>') ? 12 : 8)).trim();
  }

  // ★ 尝试 JSON 解析（新格式）
  // 基于 text（已截断到 </thinking> 之后），去掉残留标签后提取 JSON
  const cleaned = text.replace(/<\/?thinking>/gi, '').replace(/<\/?grand_summary>/gi, '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
  const jsonText = extractJson(cleaned);
  if (jsonText) {
    let data: any = safeJsonParse(jsonText, GrandSummaryV2Schema);

    // ★ patch 格式（数组）→ 翻译成 events 数组，复用下面的 map 归一逻辑
    if (!data) {
      const lenient = parsePatchArray(jsonText, '大总结');
      if (lenient) {
        const { events: bridged } = patchToGrandSummaryEvents(lenient.ops as any);
        if (bridged) data = { events: bridged };
      }
    }

    if (data?.events?.length > 0) {
      const events: any[] = data.events;
      return {
        events: events.map((e: any) => ({
          time: e.time,
          location: e.location || '',
          presentCharacters: e.presentCharacters || [],
          summary: e.summary,
          event: e.event,
          importance: e.importance || 3,
          keywords: e.keywords || [],
        })),
        castInMaterial: Array.isArray(data.castInMaterial)
          ? data.castInMaterial.map((n: any) => String(n || '').trim()).filter(Boolean)
          : [],
      };
    }
  }
  // 降级：旧格式解析

  // 提取 <grand_summary> 标签内容
  const tagMatch = text.match(/<grand_summary>([\s\S]*?)(?:<\/grand_summary>|$)/i);
  if (tagMatch) {
    text = tagMatch[1].trim();
  }

  // 按 --- 分割事件
  const blocks = text.split(/\n---\n/).map(b => b.trim()).filter(Boolean);
  const events: GrandSummaryV2Event[] = [];

  for (const block of blocks) {
    const timeMatch = block.match(/时间[：:]\s*(.+)/);
    const locMatch = block.match(/地点[：:]\s*(.+)/);
    const charsMatch = block.match(/在场[：:]\s*(.+)/);
    const summaryMatch = block.match(/摘要[：:]\s*(.+)/);
    const eventMatch = block.match(/事件[：:]\s*([\s\S]+?)(?=\n(?:重要性|关键词)[：:]|$)/);
    const impMatch = block.match(/重要性[：:]\s*(\d)/);
    const kwMatch = block.match(/关键词[：:]\s*(.+)/);

    const eventText = eventMatch?.[1]?.trim() || block.slice(0, 300);
    const summaryText = summaryMatch?.[1]?.trim() || eventText.slice(0, 50);

    // 跳过垃圾块：event 字段为空或纯符号
    if (!eventText || eventText.length < 5) continue;

    const evt: GrandSummaryV2Event = {
      time: timeMatch?.[1]?.trim() || '',
      location: locMatch?.[1]?.trim() || '',
      presentCharacters: charsMatch
        ? charsMatch[1].split(/[,，、]/).map(s => s.trim()).filter(Boolean)
        : [],
      summary: summaryText,
      event: eventText,
      importance: impMatch ? parseInt(impMatch[1]) : 3,
      keywords: kwMatch
        ? kwMatch[1].split(/[,，、]/).map(s => s.trim()).filter(Boolean)
        : [],
    };

    events.push(evt);
  }

  return { events, castInMaterial: [] };
}

// ========== 主函数 ==========

/**
 * 执行大总结V2 步骤1：白描事实时间线
 */
export async function executeGrandSummaryV2(
  _smallSummaries: SmallSummaryRecord[],
  capturedContents: CapturedContent[],
  previousSummaryText: string | undefined,
  userName: string = '{{user}}',
  abortSignal?: AbortSignal,
  extraGenerateParams?: { _responseFormat?: 'json_object' | 'text' },
  // 黑名单不用于时间线总结：时间线与单个角色无关，AI 按正文客观整理即可
  _blacklistedNames?: string[],
  /**
   * 角色名册（正式名 + 别名）。大总结此前完全不注入名册，模型只能从正文自由取名，
   * 群像场景会把多个角色坍缩成一个人。空数组/不传 = 行为与旧版一致。
   */
  characterRoster?: CharacterNameEntry[],
): Promise<GrandSummaryV2Result> {
  // A5.x 起大总结与小总结解耦：直接按正文楼层组织输入材料，
  // 不再用 smallSummaries 的 floorRange 反查原文（小总结已不产剧情摘要，
  // 且受后台队列去重影响经常残缺）。
  if (capturedContents.length === 0) {
    throw new Error('没有可总结的正文，无法生成大总结');
  }

  const instruction = buildGrandSummaryInstruction(
    previousSummaryText,
    userName,
    isPatchEnabled(),
    characterRoster,
  );
  const inputMaterial = buildInputMaterial(capturedContents);

  const orderedPrompts: Array<{ role: 'system' | 'user' | 'assistant'; content: string } | 'user_input'> = [
    { role: 'system', content: buildJailbreakHead(userName) },
    { role: 'assistant', content: buildMoralAttack(userName) },
    { role: 'system', content: instruction },
    'user_input',
    { role: 'assistant', content: ASSISTANT_PREFILL },
  ];

  const rawResult = await callGenerateRaw({
    user_input: inputMaterial,
    _monitorLabel: '大总结V2',
    _analysisType: 'grand_summary',
    _abortSignal: abortSignal,
    max_chat_history: 0,
    ordered_prompts: orderedPrompts,
    ...(extraGenerateParams || {}),
  });

  // 输出最低限度校验：只拦截空响应/纯乱码（是否有效JSON由后续解析判定）
  if (!rawResult || isEmptyOrGarbage(rawResult)) {
    const preview = (rawResult || '').slice(0, 200);
    throw new Error(`大总结V2返回无效输出（空响应/无有效JSON）: ${preview}`);
  }

  const { events, castInMaterial } = parseGrandSummaryOutput(rawResult || '');

  // 解析后校验：至少要有1个有效事件
  if (events.length === 0) {
    throw new Error('大总结V2解析失败：未提取到任何有效事件');
  }

  // 校验事件质量：不能全是空壳事件
  const meaningfulEvents = events.filter(e => e.event && e.event.length >= 10);
  if (meaningfulEvents.length === 0) {
    throw new Error('大总结V2解析失败：所有事件的event字段都无效或为空');
  }

  // ★ 角色一致性自检（只报可见，不阻断）：
  //   castInMaterial 是「先点名、再写事」的产物。事件的在场名单必须是它的子集，
  //   出现差集说明模型在写事件途中改口/合并了人——留下现场，便于定位是哪一轮出的问题。
  const castKeys = new Set(castInMaterial.map(n => normalizeCharacterName(n)));
  if (castKeys.size > 0) {
    const strays = new Set<string>();
    for (const e of events) {
      for (const n of e.presentCharacters) {
        const key = normalizeCharacterName(n);
        if (key && !castKeys.has(key)) strays.add(n);
      }
    }
    if (strays.size > 0) {
      logWarn('大总结', `在场名单出现未在 castInMaterial 声明的角色：${[...strays].join('、')}`);
    }
  }

  // 名册外角色 = 本轮新登场的人，按新角色保留，仅记一条便于观察
  if (characterRoster && characterRoster.length > 0 && castInMaterial.length > 0) {
    const rosterKeys = new Set<string>();
    for (const entry of characterRoster) {
      for (const n of [entry.name, ...(entry.aliases || [])]) {
        const key = normalizeCharacterName(n);
        if (key) rosterKeys.add(key);
      }
    }
    const fresh = castInMaterial.filter(n => !rosterKeys.has(normalizeCharacterName(n)));
    if (fresh.length > 0) {
      logInfo('大总结', `本轮出现名册外角色（按新角色保留）：${fresh.join('、')}`);
    }
  }

  logInfo('大总结', `完成: ${events.length} 个事件 (${meaningfulEvents.length} 有效)`);

  return {
    events,
    rawText: rawResult || '',
    // 小总结已不参与大总结（仅保留字段以兼容历史 schema），置空数组即可
    absorbedSmallSummaryIds: [],
    castInMaterial,
  };
}
