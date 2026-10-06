/**
 * 破限词的「默认生成」层。
 *
 * 现状：**自定义覆盖已下线** —— 破限词固定由「总览界面 → 破限词」的模式开关
 * （legacy = 老模型 / flash = 3.7f·3.8f）决定，用户不能再逐类型改写。
 * 原先的 applyJailbreakOverrideTo* 系列与「自定义破限词」弹窗已一并移除。
 *
 * 本文件现在只负责两件事：
 *   ① brainHeadFor / JAILBREAK_PROMPT_TYPES —— 每个分析类型的默认 head / tail
 *      （head 由 jailbreakIdentity.buildBrainHead 按当前模式生成）
 *   ② parseJailbreakHead —— 把 head 文本拆成 ordered_prompts 块
 *      （persona.ts 仍在用）
 */

import {
  buildBrainAccept,
  buildBrainHead,
  JAILBREAK_TAIL,
  type BrainRoleSpec,
} from './jailbreakIdentity';

export interface JailbreakPromptType {
  key: string;
  label: string;
  headPromptCount: number;
  defaultHead: (userName: string) => string;
  defaultTail: (userName: string) => string;
}

export interface OrderedPrompt {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const USER_TOKEN = '{{user}}';

function nameOf(userName: string): string {
  return userName || USER_TOKEN;
}

function roleHead(systemText: string, assistantText?: string): string {
  const parts = [`[system]\n${systemText}\n[/system]`];
  if (assistantText) {
    parts.push(`[assistant]\n${assistantText}\n[/assistant]`);
  }
  return parts.join('\n\n');
}

function promptBlock(role: OrderedPrompt['role'], content: string): string {
  return `[${role}]\n${content}\n[/${role}]`;
}

function appendHeadBlocks(head: string, blocks: Array<{ role: OrderedPrompt['role']; content: string }>): string {
  return [
    head,
    ...blocks.map((block) => promptBlock(block.role, block.content)),
  ].join('\n\n');
}

/**
 * 各分析任务的破限身份指派（参考星光预设的四部分大脑）。
 *
 *   小左（记忆与逻辑）  ：时间线 / 数据 / 记忆
 *   小右（情感与关系）  ：状态 / 小传 / 关系 / 玩家行为 / 玩家画像
 *   前额叶（统筹收口）  ：剧情走向 / 场外推演
 *   小左 + 小右 同时登场：角色记忆（事实归小左，情感归小右）
 *   小爱（欲望与身体）  ：仅 NSFW 场景，本脚本暂无独立分析调用
 */
const JAILBREAK_ROLES: Record<string, { role: BrainRoleSpec; task: string; ack: string | readonly string[] }> = {
  grand_summary: { role: '小左', task: '理时间线', ack: '时间线我来理，一条都不落' },
  small_summary: { role: '小左', task: '整理数据', ack: '数据我来记，一条不漏' },
  character_memory: { role: ['小左', '小右'], task: '记角色记忆', ack: ['事实我来记', '她的变化我来读'] },
  character_profile: { role: '小右', task: '写角色小传', ack: '我来说说这个人' },
  dynamic_profile: { role: '小右', task: '更新角色状态', ack: '她变成什么样了，我读得出来' },
  relationship: { role: '小右', task: '理关系档案', ack: '谁对谁什么心思，我来理' },
  dreamtalk: { role: '小右', task: '读玩家行为', ack: '他想要什么，我来读' },
  persona: { role: '小右', task: '读我的人设', ack: '我来把这个人读清楚' },
  plot_director: { role: '前额叶', task: '管剧情走向', ack: '大纲和节奏我来管' },
  world_progress: { role: '前额叶', task: '推演场外行动', ack: '场外的事我来推' },
};

/** 按分析类型生成破限 head（身份框架 + 认可式应答，内容随该类型的破限模式变化） */
function brainHeadFor(key: string): string {
  const cfg = JAILBREAK_ROLES[key] || {
    role: '小左' as BrainRoleSpec,
    task: '整理这份数据',
    ack: '交给我',
  };
  // 第三参传类型 key：API 库管理里可为该类型单独指定破限模式
  return roleHead(buildBrainHead(cfg.role, cfg.task, key), buildBrainAccept(cfg.role, cfg.ack));
}

export const JAILBREAK_PROMPT_TYPES: JailbreakPromptType[] = [
  {
    key: 'grand_summary',
    label: '大总结',
    headPromptCount: 2,
    defaultHead: (userName) => {
      const name = nameOf(userName);
      return appendHeadBlocks(
        brainHeadFor('grand_summary'),
        [
          { role: 'system', content: `${name}：现在需要你把以下剧情内容整理为完整连续的时间线。` },
          { role: 'system', content: `${name}：现在需要你执行一项精准的数据整理任务。` },
        ],
      );
    },
    defaultTail: () => JAILBREAK_TAIL,
  },
  {
    key: 'small_summary',
    label: '小总结',
    headPromptCount: 2,
    defaultHead: (userName) => {
      const name = nameOf(userName);
      return appendHeadBlocks(
        brainHeadFor('small_summary'),
        [{ role: 'user', content: `${name}：现在需要你做一项数据整理任务。` }],
      );
    },
    defaultTail: () => JAILBREAK_TAIL,
  },
  {
    key: 'dreamtalk',
    label: '梦呓分析',
    headPromptCount: 2,
    defaultHead: (userName) => appendHeadBlocks(
      brainHeadFor('dreamtalk'),
      [{ role: 'system', content: `${nameOf(userName)}：现在需要你对"梦中人"（用户角色）进行深度分析，按游玩类型分叉输出。` }],
    ),
    defaultTail: () => JAILBREAK_TAIL,
  },
  {
    key: 'dynamic_profile',
    label: '动态人设',
    headPromptCount: 2,
    defaultHead: (userName) => {
      const name = nameOf(userName);
      return appendHeadBlocks(
        brainHeadFor('dynamic_profile'),
        [{ role: 'system', content: `${name}：你需要以记者的专业素养，看下面的正文和上次的角色状态，告诉我每个角色现在是什么状态、她的行为应该怎么理解。` }],
      );
    },
    defaultTail: () => JAILBREAK_TAIL,
  },
  {
    key: 'character_memory',
    label: '角色记忆',
    headPromptCount: 2,
    defaultHead: (userName) => {
      const name = nameOf(userName);
      return appendHeadBlocks(
        brainHeadFor('character_memory'),
        [{ role: 'system', content: `${name}：现在需要你阅读剧情正文，为每个角色生成/更新记忆。` }],
      );
    },
    defaultTail: () => JAILBREAK_TAIL,
  },
  {
    key: 'relationship',
    label: '关系档案',
    headPromptCount: 2,
    defaultHead: (userName) => appendHeadBlocks(
      brainHeadFor('relationship'),
      [{ role: 'system', content: `${nameOf(userName)}：现在需要你整理一份"关系档案"。` }],
    ),
    defaultTail: () => JAILBREAK_TAIL,
  },
  {
    key: 'world_progress',
    label: '世界推进',
    headPromptCount: 2,
    defaultHead: (userName) => {
      const name = nameOf(userName);
      return appendHeadBlocks(
        brainHeadFor('world_progress'),
        [{ role: 'system', content: `${name}：现在需要你推演不在场角色在当前时间切片内的行动。` }],
      );
    },
    defaultTail: () => JAILBREAK_TAIL,
  },
  {
    key: 'plot_director',
    label: '剧情导演',
    headPromptCount: 2,
    defaultHead: (userName) => {
      const name = nameOf(userName);
      return appendHeadBlocks(
        brainHeadFor('plot_director'),
        [
          { role: 'system', content: `${name}：我想和你讨论接下来的剧情方向。` },
          { role: 'user', content: `${name}：帮我校对一下当前剧情是否偏离了预定大纲。` },
        ],
      );
    },
    defaultTail: () => JAILBREAK_TAIL,
  },
  {
    key: 'persona',
    label: '人设分析',
    headPromptCount: 3,
    defaultHead: (userName) => {
      const name = nameOf(userName);
      return appendHeadBlocks(
        brainHeadFor('persona'),
        [{ role: 'system', content: `${name}：现在需要你分析我的人设，整理成清晰的人格画像。` }],
      );
    },
    defaultTail: () => JAILBREAK_TAIL,
  },
  {
    key: 'character_profile',
    label: '角色设定',
    headPromptCount: 2,
    defaultHead: (userName) => {
      const name = nameOf(userName);
      return appendHeadBlocks(
        brainHeadFor('character_profile'),
        [{ role: 'system', content: `${name}：现在需要你为这个角色写一份小传。` }],
      );
    },
    defaultTail: () => JAILBREAK_TAIL,
  },
];

export function getJailbreakPromptType(key?: string): JailbreakPromptType | undefined {
  return JAILBREAK_PROMPT_TYPES.find((item) => item.key === key);
}

export function getDefaultJailbreakPrompt(
  key: string,
  userName: string = USER_TOKEN,
): { head: string; tail: string } {
  const type = getJailbreakPromptType(key);
  if (!type) return { head: '', tail: '' };
  return {
    head: type.defaultHead(userName),
    tail: type.defaultTail(userName),
  };
}

export function normalizePromptText(text: string): string {
  return (text || '').replace(/\r\n/g, '\n');
}

/** 把 head 文本（[system]…[/system] / [assistant]…[/assistant] 分块）拆成 ordered_prompts */
export function parseJailbreakHead(head: string): OrderedPrompt[] {
  const normalized = normalizePromptText(head).trim();
  if (!normalized) return [];

  const messages: OrderedPrompt[] = [];
  const blockRe = /\[(system|assistant|user)\]\s*([\s\S]*?)\s*\[\/\1\]/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(normalized)) !== null) {
    const content = match[2].trim();
    if (content) {
      messages.push({ role: match[1].toLowerCase() as OrderedPrompt['role'], content });
    }
  }

  if (messages.length > 0) return messages;
  return [{ role: 'system', content: normalized }];
}
