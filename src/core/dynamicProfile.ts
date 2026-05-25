/**
 * 动态人设注入系统
 *
 * 使用 injectPrompts 固定注入到 D0 顺序0
 * 按当前正文中出现的角色名条件注入
 * 只注入新的变化部分，不是完整人设
 */

import type { DynamicProfile } from '../stores/mainStore';
import { scanCharacterNamesFromContent } from './dreamtalk';

/**
 * 构建动态人设注入文本
 * 只注入当前正文中出现的角色的动态人设
 */
export function buildDynamicProfileInjection(
  dynamicProfiles: DynamicProfile[],
  currentCharacterNames: string[],
): string | null {
  // 只取当前在场角色的动态人设
  const relevantProfiles = dynamicProfiles.filter(p =>
    currentCharacterNames.includes(p.characterName),
  );

  if (relevantProfiles.length === 0) return null;

  const parts: string[] = [];

  for (const profile of relevantProfiles) {
    parts.push(`<dynamic_profile_${profile.characterName}>`);
    parts.push(`**以下是${profile.characterName}基于剧情发展产生的新变化，与原始人设冲突时优先以此为准：**`);
    parts.push(profile.dynamicContent);
    parts.push(`</dynamic_profile_${profile.characterName}>`);
  }

  return parts.join('\n');
}

/**
 * 注入动态人设到提示词中
 * 使用 injectPrompts 固定在 D0 顺序0
 */
let currentInjection: { uninject: () => void } | null = null;

export function injectDynamicProfiles(
  dynamicProfiles: DynamicProfile[],
  latestContent: string,
  allCharacterNames: string[],
): void {
  // 先移除旧的注入
  if (currentInjection) {
    currentInjection.uninject();
    currentInjection = null;
  }

  // 扫描当前在场角色
  const currentCharacters = scanCharacterNamesFromContent(latestContent, allCharacterNames);

  // 构建注入文本
  const injectionText = buildDynamicProfileInjection(dynamicProfiles, currentCharacters);
  if (!injectionText) return;

  // 使用 injectPrompts 注入到 D0
  currentInjection = injectPrompts([
    {
      id: 'zhino_dynamic_profile',
      position: 'in_chat',
      depth: 0,
      role: 'system',
      content: injectionText,
      should_scan: true,
    },
  ]);

  console.info(`[智脑] 动态人设已注入 (${currentCharacters.length} 角色)`);
}

/**
 * 移除动态人设注入
 */
export function removeDynamicProfileInjection(): void {
  if (currentInjection) {
    currentInjection.uninject();
    currentInjection = null;
  }
}
