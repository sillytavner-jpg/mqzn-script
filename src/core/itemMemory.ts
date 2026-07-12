/**
 * 物品记忆库 (Item Memory)
 * 独立的物品实体库，跨大总结版本累积物品历史。
 * 数据来源：大总结V2事件（当前已不输出物品，此模块保留用于旧数据兼容+撤回）。
 * 知识图谱物品向量化已迁移至 knowledgeGraph.ts 的 embedKnowledgeGraphNodes()。
 */

// ======== 数据结构 ==========

export interface ItemHistoryEntry {
  storyTime: string;
  event: string;
  owner?: string;
  state?: string;
  floorRange?: string;
  summaryVersion?: number;
}

export interface ItemMemory {
  id: string;
  itemName: string;
  aliases: string[];
  currentOwner: string;
  currentLocation: string;
  currentState: string;
  description: string;
  history: ItemHistoryEntry[];
  relatedCharacters: string[];
  openQuestions: string[];
  lastUpdatedAt: string;
  status: 'active' | 'ignored' | 'merged';
  mergedInto?: string; // 合并目标的 id
  embedding?: number[]; // 语义向量（旧版，已不再使用；KG 物品改用 GraphItem.embedding）
}

// ========== 撤回逻辑 ==========

/**
 * 清理指定版本号产生的物品历史。
 * 重总结/撤回大总结时调用，防止物品重复。
 * 如果某物品清理后无历史，则移除该物品。
 */
export function removeItemHistoryByVersion(
  items: ItemMemory[],
  version: number,
): ItemMemory[] {
  return items.filter(item => {
    item.history = item.history.filter(h => h.summaryVersion !== version);
    // 清理后无历史 + 无向量的新建物品 → 移除
    if (item.history.length === 0 && !item.embedding) return false;
    // 清理后只剩其他版本的历史 → 用次新历史恢复状态
    if (item.history.length > 0) {
      const latest = item.history[item.history.length - 1];
      if (latest.owner) item.currentOwner = latest.owner;
      if (latest.state) item.currentState = latest.state;
    }
    return true;
  });
}
