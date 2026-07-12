/**
 * 摘要替代层 (Context Replacement)
 * 职责：在 CHAT_COMPLETION_SETTINGS_READY 时，将隐藏楼层对应的小总结
 * 插入到聊天历史区域，替代被隐藏的原文。
 *
 * 规则：
 * - 楼层仍可见（未隐藏）：不插入摘要
 * - 楼层已隐藏，有对应小总结（status='ready'/'hidden-active'）：插入小总结
 * - 楼层已被大总结吸收：不插入小总结，由大总结注入覆盖（阶段5实现）
 * - 最新保留楼层：不改变
 */

import type { SmallSummaryRecord } from '../stores/mainStore';

/**
 * 构建摘要替代文本块
 * 返回一个 system 消息内容，包含所有需要替代的小总结
 */
export function buildReplacementBlock(
  smallSummaries: SmallSummaryRecord[],
  hiddenFloorIds: Set<number>,
): string | null {
  // 筛选：已隐藏楼层且有就绪小总结（未被大总结吸收）
  const activeSummaries = smallSummaries.filter(s => {
    if (s.status === 'absorbed' || s.status === 'ignored' || s.status === 'failed' || s.status === 'pending') {
      return false;
    }
    // 检查该小总结覆盖的楼层是否至少有一个被隐藏
    const start = s.floorRange.start;
    const end = s.floorRange.end;
    for (let i = start; i <= end; i++) {
      if (hiddenFloorIds.has(i)) return true;
    }
    return false;
  });

  if (activeSummaries.length === 0) return null;

  // 按楼层范围正序排列
  activeSummaries.sort((a, b) => a.floorRange.start - b.floorRange.start);

  // 组装替代文本
  const lines: string[] = [];
  lines.push('<context_summary type="hidden_floor_replacement">');

  for (const s of activeSummaries) {
    const range = `#${s.floorRange.start}~${s.floorRange.end}`;
    const time = s.storyTime ? `[${s.storyTime}]` : '';
    const loc = s.location ? `@${s.location}` : '';
    const chars = (s.presentCharacters || []).length > 0
      ? `(${s.presentCharacters.join('、')})`
      : '';
    const header = [range, time, loc, chars].filter(Boolean).join(' ');

    lines.push(`${header}: ${s.mainEvent || '(无摘要)'}`);
  }

  lines.push('</context_summary>');

  return lines.join('\n');
}

/**
 * 将小总结替代文本注入到 completion messages 中
 * 策略：在 <chathistory> 标记之后、最早的可见聊天记录之前插入。
 * 这样 AI 在读聊天历史时，先看到被隐藏楼层的摘要，再看到可见楼层原文。
 */
export function injectContextReplacement(
  messages: any[],
  smallSummaries: SmallSummaryRecord[],
  hiddenFloorIds: Set<number>,
): boolean {
  const block = buildReplacementBlock(smallSummaries, hiddenFloorIds);
  if (!block) {
    return false;
  }

  // 找到 <chathistory> 所在的消息，在其后插入
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    if (typeof content !== 'string') continue;

    if (content.includes('<chathistory>')) {
      // 在 <chathistory> 之后紧跟插入摘要块
      messages[i].content = content.replace(
        '<chathistory>',
        '<chathistory>\n' + block,
      );
      return true;
    }
  }

  // 备选：找 </chathistory> 前插入
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    if (typeof content !== 'string') continue;

    if (content.includes('</chathistory>')) {
      messages[i].content = content.replace(
        '</chathistory>',
        block + '\n</chathistory>',
      );
      return true;
    }
  }

  // 兜底：splice 为独立 system 消息
  const idx = Math.max(0, messages.length - 3);
  messages.splice(idx, 0, { role: 'system', content: block });
  return true;
}

/**
 * 更新小总结状态：将已隐藏楼层对应的 ready 小总结标记为 hidden-active
 * 将不再隐藏的楼层对应的 hidden-active 小总结恢复为 ready
 */
export function syncSmallSummaryStatus(
  smallSummaries: SmallSummaryRecord[],
  hiddenFloorIds: Set<number>,
): void {
  for (const s of smallSummaries) {
    if (s.status === 'absorbed' || s.status === 'ignored' || s.status === 'failed' || s.status === 'pending') {
      continue;
    }

    const isHidden = (() => {
      for (let i = s.floorRange.start; i <= s.floorRange.end; i++) {
        if (hiddenFloorIds.has(i)) return true;
      }
      return false;
    })();

    if (isHidden && s.status === 'ready') {
      s.status = 'hidden-active';
    } else if (!isHidden && s.status === 'hidden-active') {
      s.status = 'ready';
    }
  }
}
