/**
 * 神经链记忆激活系统
 *
 * 不是把所有记忆一次全塞进来，而是按关系链精准注入：
 * - 用户↔自己
 * - 用户↔角色A
 * - 角色A↔角色B
 *
 * 锚点是各个在场角色，只激活与当前场景相关的记忆链。
 * 插入位置：人设后面，使用 injectPrompts D1
 */

import type { CharacterMemory } from '../stores/mainStore';
import type { CharacterNameEntry } from './dreamtalk';
import { scanCharacterNamesFromContent } from './dreamtalk';

/**
 * 构建神经链记忆注入文本
 *
 * 逻辑：
 * 1. 扫描当前正文中出现的角色
 * 2. 只取这些角色的记忆
 * 3. 按关系链组织：用户↔角色、角色↔角色
 * 4. 不在场的角色记忆不注入
 */
export function buildNeuralChainInjection(
  characterMemories: CharacterMemory[],
  currentCharacterNames: string[],
  userName: string,
): string | null {
  // 只取当前在场角色的记忆
  const relevantMemories = characterMemories.filter(m => currentCharacterNames.includes(m.characterName));

  if (relevantMemories.length === 0) return null;

  const parts: string[] = [];

  parts.push('<neural_chain>');
  parts.push('**以下是当前场景相关的可用记忆链，正文创作时可自然引用这些记忆作为角色行为的依据：**');
  parts.push('');

  // 链1：用户↔各在场角色
  for (const memory of relevantMemories) {
    const chainId = `${userName}_${memory.characterName}`.replace(/\s+/g, '_');
    parts.push(`<memory_chain_${chainId}>`);
    parts.push(
      `${memory.characterName}对${userName}的记忆（态度：${memory.attitude === 'like' ? '好感' : memory.attitude === 'dislike' ? '厌恶' : '中立'}）：`,
    );
    if (memory.coreMemories.length > 0) {
      parts.push('  [核心记忆]');
      for (const item of memory.coreMemories) {
        parts.push(`  - ${item}`);
      }
    }
    if (memory.recentMemories.length > 0) {
      parts.push('  [近期记忆]');
      for (const item of memory.recentMemories) {
        parts.push(`  - ${item}`);
      }
    }
    parts.push(`</memory_chain_${chainId}>`);
    parts.push('');
  }

  // 链2：在场角色之间的交叉记忆（如果有多个在场角色）
  if (relevantMemories.length > 1) {
    for (let i = 0; i < relevantMemories.length; i++) {
      for (let j = i + 1; j < relevantMemories.length; j++) {
        const a = relevantMemories[i];
        const b = relevantMemories[j];
        // 检查A的记忆中是否提到B，或B的记忆中是否提到A
        const allMemsA = [...a.coreMemories, ...a.recentMemories];
        const allMemsB = [...b.coreMemories, ...b.recentMemories];
        const aMemsAboutB = allMemsA.filter(m => m.includes(b.characterName));
        const bMemsAboutA = allMemsB.filter(m => m.includes(a.characterName));

        if (aMemsAboutB.length > 0 || bMemsAboutA.length > 0) {
          const crossId = `${a.characterName}_${b.characterName}`.replace(/\s+/g, '_');
          parts.push(`<memory_chain_${crossId}>`);
          if (aMemsAboutB.length > 0) {
            parts.push(`${a.characterName}关于${b.characterName}的记忆：`);
            for (const item of aMemsAboutB) {
              parts.push(`- ${item}`);
            }
          }
          if (bMemsAboutA.length > 0) {
            parts.push(`${b.characterName}关于${a.characterName}的记忆：`);
            for (const item of bMemsAboutA) {
              parts.push(`- ${item}`);
            }
          }
          parts.push(`</memory_chain_${crossId}>`);
          parts.push('');
        }
      }
    }
  }

  parts.push('</neural_chain>');

  return parts.join('\n');
}

/**
 * 注入神经链记忆
 * 使用 injectPrompts 注入到 D1（人设后面）
 */
let currentNeuralInjection: { uninject: () => void } | null = null;

export function injectNeuralChain(
  characterMemories: CharacterMemory[],
  latestContent: string,
  allCharacterNames: string[],
  characterEntries: CharacterNameEntry[],
  userName: string,
): void {
  // 先移除旧的注入
  if (currentNeuralInjection) {
    currentNeuralInjection.uninject();
    currentNeuralInjection = null;
  }

  // 扫描当前在场角色（支持别名）
  const currentCharacters = scanCharacterNamesFromContent(latestContent, allCharacterNames, characterEntries);

  if (currentCharacters.length === 0) return;

  // 构建注入文本
  const injectionText = buildNeuralChainInjection(characterMemories, currentCharacters, userName);
  if (!injectionText) return;

  // 使用 injectPrompts 注入到 D1（紧跟人设后面）
  currentNeuralInjection = injectPrompts([
    {
      id: 'zhino_neural_chain',
      position: 'in_chat',
      depth: 0,
      role: 'system',
      content: injectionText,
      should_scan: false,
    },
  ]);

  console.info(`[智脑] 神经链记忆已激活 (${currentCharacters.length} 角色)`);
}

/**
 * 移除神经链注入
 */
export function removeNeuralChainInjection(): void {
  if (currentNeuralInjection) {
    currentNeuralInjection.uninject();
    currentNeuralInjection = null;
  }
}
