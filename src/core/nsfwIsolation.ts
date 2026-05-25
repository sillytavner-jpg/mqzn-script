/**
 * NSFW隔离系统
 *
 * 核心原则：性爱中的表现 ≠ 日常人格
 *
 * 功能：
 * 1. 检测预设中NSFW是否激活（通过 nsfw_thinking_chain 变量）
 * 2. 管理NSFW层独立数据（记忆、梦呓、动态人设）
 * 3. 条件注入：仅NSFW激活时注入NSFW层数据
 * 4. 提供NSFW导航页注入（告知AI两部分彻底切割）
 */

// ========== NSFW数据结构 ==========

export interface NsfwCharacterMemory {
  characterName: string;
  sensitivePoints: string[];   // 身体敏感点
  preferences: string[];       // 性爱偏好
  behaviors: string[];         // 性爱中的行为模式（主动/被动等）
  memories: string[];          // 性爱细节记忆（第一人称）
  lastUpdatedAt: string;
}

export interface NsfwDreamtalkData {
  xpPreferences: string[];     // 用户XP偏好
  pacePreference: string;      // 节奏偏好（温柔/粗暴/混合）
  rollLikes: string[];         // NSFW场景中喜欢的方向
  rollDislikes: string[];      // NSFW场景中不喜欢的方向
  generatedAt: string;
  version: number;
}

export interface NsfwDynamicProfile {
  characterName: string;
  sexualBehavior: string;      // 性爱中的角色表现描述
  lastUpdatedAt: string;
}

// ========== NSFW状态检测 ==========

/**
 * 检测预设中NSFW是否激活
 * 通过检测 nsfw_thinking_chain 变量是否有内容来判断
 */
export function isNsfwActive(): boolean {
  try {
    // 尝试从全局变量获取
    const globalVars = getVariables({ type: 'global' });
    if (globalVars?.nsfw_thinking_chain && String(globalVars.nsfw_thinking_chain).trim().length > 0) {
      return true;
    }
    // 也检查聊天变量（某些预设可能存在这里）
    const chatVars = getVariables({ type: 'chat' });
    if (chatVars?.nsfw_thinking_chain && String(chatVars.nsfw_thinking_chain).trim().length > 0) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ========== NSFW数据解析 ==========

/**
 * 从大总结的第四SECTION解析NSFW记忆数据
 */
export function parseNsfwSection(nsfwSection: string): NsfwCharacterMemory[] {
  const memories: NsfwCharacterMemory[] = [];
  if (!nsfwSection.trim() || nsfwSection.includes('无NSFW内容')) return memories;

  const characterBlocks = nsfwSection.split(/###\s+/).filter(Boolean);

  for (const block of characterBlocks) {
    const lines = block.trim().split('\n');
    if (lines.length === 0) continue;

    const characterName = lines[0].trim();
    if (!characterName || /^\[.*\]$/.test(characterName) || /NSFW记录|SECTION/i.test(characterName)) continue;

    const memory: NsfwCharacterMemory = {
      characterName,
      sensitivePoints: [],
      preferences: [],
      behaviors: [],
      memories: [],
      lastUpdatedAt: new Date().toISOString(),
    };

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('敏感点:') || line.startsWith('敏感点：')) {
        memory.sensitivePoints = line.replace(/^敏感点[:：]\s*/, '').split(/[,，、]/).map(s => s.trim()).filter(Boolean);
      } else if (line.startsWith('偏好:') || line.startsWith('偏好：')) {
        memory.preferences = line.replace(/^偏好[:：]\s*/, '').split(/[,，、]/).map(s => s.trim()).filter(Boolean);
      } else if (line.startsWith('行为模式:') || line.startsWith('行为模式：')) {
        memory.behaviors = line.replace(/^行为模式[:：]\s*/, '').split(/[,，、]/).map(s => s.trim()).filter(Boolean);
      } else if (line.startsWith('- ')) {
        memory.memories.push(line.slice(2).trim());
      }
    }

    if (memory.sensitivePoints.length > 0 || memory.preferences.length > 0 || memory.memories.length > 0) {
      memories.push(memory);
    }
  }

  return memories;
}

/**
 * 从梦呓输出的NSFW部分解析XP偏好
 */
export function parseNsfwDreamtalk(nsfwSection: string): NsfwDreamtalkData | null {
  if (!nsfwSection.trim() || nsfwSection.includes('无NSFW内容')) return null;

  const data: NsfwDreamtalkData = {
    xpPreferences: [],
    pacePreference: '混合',
    rollLikes: [],
    rollDislikes: [],
    generatedAt: new Date().toISOString(),
    version: 1,
  };

  const lines = nsfwSection.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('XP偏好:') || trimmed.startsWith('XP偏好：')) {
      data.xpPreferences = trimmed.replace(/^XP偏好[:：]\s*/, '').split(/[,，、；;]/).map(s => s.trim()).filter(Boolean);
    } else if (trimmed.startsWith('节奏偏好:') || trimmed.startsWith('节奏偏好：')) {
      data.pacePreference = trimmed.replace(/^节奏偏好[:：]\s*/, '').trim();
    } else if (trimmed.startsWith('喜欢:') || trimmed.startsWith('喜欢：')) {
      data.rollLikes.push(trimmed.replace(/^喜欢[:：]\s*/, ''));
    } else if (trimmed.startsWith('不喜欢:') || trimmed.startsWith('不喜欢：')) {
      data.rollDislikes.push(trimmed.replace(/^不喜欢[:：]\s*/, ''));
    } else if (trimmed.startsWith('- ')) {
      data.xpPreferences.push(trimmed.slice(2).trim());
    }
  }

  return data.xpPreferences.length > 0 || data.rollLikes.length > 0 ? data : null;
}

// ========== NSFW注入构建 ==========

/**
 * 构建NSFW导航页注入文本
 * 告知AI性爱与日常是彻底切割的两个维度
 */
export function buildNsfwNavigationInjection(): string {
  return `<nsfw_isolation>
【NSFW隔离声明】
性爱场景与日常场景是完全独立的两个维度，彻底切割：

1. 角色在性爱中的表现（主动/被动/敏感点/XP）不影响日常人格
2. 用户在性爱中的偏好（粗暴/温柔/特殊play）不代表日常行为模式
3. 性爱中的"求饶""失控"是情趣表演，不是人格改变
4. 日常的温柔不代表性爱中也温柔，反之亦然
5. 做爱前是什么性格，做爱后还是什么性格

以下NSFW数据仅在性爱场景中参考，日常场景中完全忽略。
</nsfw_isolation>`;
}

/**
 * 构建NSFW记忆注入文本
 */
export function buildNsfwMemoryInjection(nsfwMemories: NsfwCharacterMemory[], currentCharacters: string[]): string | null {
  const relevant = nsfwMemories.filter(m => currentCharacters.includes(m.characterName));
  if (relevant.length === 0) return null;

  const parts: string[] = [];
  parts.push('<nsfw_memory>');

  for (const mem of relevant) {
    parts.push(`### ${mem.characterName}`);
    if (mem.sensitivePoints.length > 0) {
      parts.push(`敏感点：${mem.sensitivePoints.join('、')}`);
    }
    if (mem.preferences.length > 0) {
      parts.push(`偏好：${mem.preferences.join('、')}`);
    }
    if (mem.behaviors.length > 0) {
      parts.push(`行为模式：${mem.behaviors.join('、')}`);
    }
    if (mem.memories.length > 0) {
      parts.push('记忆：');
      for (const m of mem.memories) {
        parts.push(`- ${m}`);
      }
    }
    parts.push('');
  }

  parts.push('</nsfw_memory>');
  return parts.join('\n');
}

/**
 * 构建NSFW动态人设注入文本
 */
export function buildNsfwDynamicProfileInjection(profiles: NsfwDynamicProfile[], currentCharacters: string[]): string | null {
  const relevant = profiles.filter(p => currentCharacters.includes(p.characterName));
  if (relevant.length === 0) return null;

  const parts: string[] = [];
  parts.push('<nsfw_dynamic_profile>');
  for (const p of relevant) {
    parts.push(`${p.characterName}在性爱中的表现：${p.sexualBehavior}`);
  }
  parts.push('</nsfw_dynamic_profile>');
  return parts.join('\n');
}

/**
 * 构建NSFW梦呓注入文本
 */
export function buildNsfwDreamtalkInjection(nsfwDreamtalk: NsfwDreamtalkData): string {
  const parts: string[] = [];
  parts.push('<nsfw_dreamtalk>');
  parts.push(`用户性爱节奏偏好：${nsfwDreamtalk.pacePreference}`);

  if (nsfwDreamtalk.xpPreferences.length > 0) {
    parts.push(`用户XP偏好：${nsfwDreamtalk.xpPreferences.join('、')}`);
  }
  if (nsfwDreamtalk.rollLikes.length > 0) {
    parts.push(`NSFW中喜欢：${nsfwDreamtalk.rollLikes.join('；')}`);
  }
  if (nsfwDreamtalk.rollDislikes.length > 0) {
    parts.push(`NSFW中不喜欢：${nsfwDreamtalk.rollDislikes.join('；')}`);
  }

  parts.push('</nsfw_dreamtalk>');
  return parts.join('\n');
}

// ========== NSFW注入管理 ==========

let currentNsfwInjection: { uninject: () => void } | null = null;

/**
 * 执行NSFW条件注入
 * 仅在NSFW激活时注入NSFW层数据
 */
export function injectNsfwData(
  nsfwMemories: NsfwCharacterMemory[],
  nsfwDreamtalk: NsfwDreamtalkData | null,
  nsfwProfiles: NsfwDynamicProfile[],
  currentCharacters: string[],
): void {
  // 先移除旧注入
  if (currentNsfwInjection) {
    currentNsfwInjection.uninject();
    currentNsfwInjection = null;
  }

  if (!isNsfwActive()) return;

  const parts: string[] = [];

  // 导航页
  parts.push(buildNsfwNavigationInjection());

  // NSFW记忆
  const memoryText = buildNsfwMemoryInjection(nsfwMemories, currentCharacters);
  if (memoryText) parts.push(memoryText);

  // NSFW动态人设
  const profileText = buildNsfwDynamicProfileInjection(nsfwProfiles, currentCharacters);
  if (profileText) parts.push(profileText);

  // NSFW梦呓
  if (nsfwDreamtalk) {
    parts.push(buildNsfwDreamtalkInjection(nsfwDreamtalk));
  }

  if (parts.length <= 1) return; // 只有导航页没有实际数据，不注入

  currentNsfwInjection = injectPrompts([
    {
      id: 'zhino_nsfw_isolation',
      position: 'in_chat',
      depth: 0,
      role: 'system',
      content: parts.join('\n\n'),
      should_scan: false,
    },
  ]);

  console.info(`[智脑] NSFW隔离数据已注入 (${currentCharacters.length} 角色)`);
}

export function removeNsfwInjection(): void {
  if (currentNsfwInjection) {
    currentNsfwInjection.uninject();
    currentNsfwInjection = null;
  }
}
