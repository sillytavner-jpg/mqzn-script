/**
 * 储存诊断工具 — 测量智脑各模块数据的体积
 * 用于在设置面板中展示各模块占用的储存空间，定位内存大户
 */
import type { ChatData } from '../stores/mainStore';

// ---- 类型定义 ----

export interface FieldSize {
  /** 字段名（英文 key） */
  field: string;
  /** 中文标签 */
  label: string;
  /** JSON 序列化后的字节数 */
  bytes: number;
  /** 数组元素个数（仅数组字段） */
  count?: number;
  /** 额外提示文本 */
  hint?: string;
}

export interface ModuleSize {
  /** 模块唯一标识 */
  key: string;
  /** 模块中文名 */
  name: string;
  /** 子字段明细 */
  fields: FieldSize[];
  /** 模块总字节数 */
  totalBytes: number;
  /** 占总体的百分比 (0-100) */
  percent: number;
}

export interface StorageDiagnosticResult {
  /** 各模块体积明细（按体积降序） */
  modules: ModuleSize[];
  /** 总字节数 */
  totalBytes: number;
  /** localStorage 设置体积 */
  settingsLocalBytes: number;
  /** 是否包含 embedding 向量（提示可能存在虚高） */
  hasEmbeddings: boolean;
}

// ---- 工具函数 ----

/**
 * 把任意值 JSON 序列化后估算字节数
 * 返回 -1 表示无法序列化（如循环引用）
 */
function measureField(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return -1;
  }
}

/**
 * 测量数组字段：体积 + 元素个数
 */
function measureArray(arr: unknown[] | undefined | null, label: string): FieldSize {
  const safe = arr ?? [];
  const bytes = measureField(safe);
  return {
    field: '',
    label,
    bytes: Math.max(0, bytes),
    count: safe.length,
  };
}

/**
 * 测量单个值字段
 */
function measureValue(val: unknown, label: string): FieldSize {
  const bytes = measureField(val);
  return {
    field: '',
    label,
    bytes: Math.max(0, bytes),
  };
}

/**
 * 测量对象字段（Record<k,v>），返回 bytes + key 数量
 */
function measureRecord(rec: Record<string, unknown> | undefined | null, label: string): FieldSize {
  const safe = rec ?? {};
  const bytes = measureField(safe);
  return {
    field: '',
    label,
    bytes: Math.max(0, bytes),
    count: Object.keys(safe).length,
  };
}

/** 格式化字节为人类可读 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/** 格式化百分比 */
export function formatPercent(p: number): string {
  if (p < 0.1) return '<0.1%';
  return p.toFixed(1) + '%';
}

// ---- 诊断函数 ----

/**
 * 检测智能体在 body 中的 embedding 向量出现次数，
 * 用于估算 embedding 对体积的影响（每个向量 1024 个 float ≈ 4KB 序列化后约 8KB 左右）
 */
function hasEmbeddingVectors(obj: unknown): boolean {
  try {
    const s = JSON.stringify(obj);
    // embedding 在 JSON 中表现为长度约 1024 的浮点数数组
    // 简单策略：检查是否有极长的数字数组出现在 JSON 中
    // 更可靠的方式：检测 "[数字,数字,数字,...]" 模式
    let count = 0;
    let idx = 0;
    while ((idx = s.indexOf('"embedding":[', idx + 1)) !== -1) {
      count++;
      if (count >= 5) return true; // 有5处以上就是有embedding
    }
    return count > 0;
  } catch {
    return false;
  }
}

/**
 * 测量当前聊天的储存体积
 * @param chatData 当前聊天数据
 * @param scriptData 全局设置数据（用于测量设置体积）
 * @returns 诊断结果
 */
export function measureStorageUsage(
  chatData: ChatData | null | undefined,
  scriptData: unknown,
): StorageDiagnosticResult {
  const cd = chatData ?? ({} as ChatData);
  const modules: ModuleSize[] = [];

  // 辅助：快捷定义模块
  function mod(key: string, name: string, fields: FieldSize[]) {
    const totalBytes = fields.reduce((s, f) => s + f.bytes, 0);
    modules.push({ key, name, fields, totalBytes, percent: 0 });
  }

  // ---- 按模块测量 ----

  // 1. 正文捕获
  mod('capture', '正文捕获', [
    measureArray(cd.capturedContents, 'capturedContents'),
    measureArray(cd.userInputRecords, 'userInputRecords'),
  ]);

  // 2. 小总结
  mod('smallSummary', '小总结', [
    measureArray(cd.smallSummaries, 'smallSummaries'),
  ]);

  // 3. 大总结
  mod('grandSummary', '大总结', [
    measureArray(cd.summaries, 'summaries'),
    measureArray(cd.summaryHistory, 'summaryHistory'),
    measureRecord(cd.timelineOverrides, 'timelineOverrides'),
  ]);

  // 4. 角色记忆
  mod('characterMemory', '角色记忆', [
    measureArray(cd.characterMemories, 'characterMemories'),
    measureArray(cd.nsfwMemories, 'nsfwMemories'),
    measureArray(cd._ignoredBackup, '_ignoredBackup'),
  ]);

  // 5. 动态人设
  mod('dynamicProfile', '动态人设', [
    measureArray(cd.dynamicProfilesV2, 'dynamicProfilesV2'),
    measureArray(cd.dynamicProfiles, 'dynamicProfiles (旧版)'),
    measureArray(cd.nsfwDynamicProfiles, 'nsfwDynamicProfiles'),
  ]);

  // 6. 梦呓系统
  mod('dreamtalk', '梦呓系统', [
    measureValue(cd.dreamtalk, 'dreamtalk'),
    measureArray(cd.dreamtalkHistory, 'dreamtalkHistory'),
    measureArray(cd.dreamtalkUndoHistory, 'dreamtalkUndoHistory'),
    measureValue(cd.nsfwDreamtalk, 'nsfwDreamtalk'),
  ]);

  // 7. 知识图谱（含节点数 & 实测 embedding 体积）
  const kg = cd.knowledgeGraph;
  const kgFields: FieldSize[] = [];
  if (kg) {
    const locCnt = kg.locations?.length ?? 0;
    const itemCnt = kg.items?.length ?? 0;
    const charCnt = kg.characters?.length ?? 0;
    const edgeCnt = kg.edges?.length ?? 0;
    const totalNodes = locCnt + itemCnt + charCnt;
    // 统计有 embedding 的节点数
    const nodesWithEmb = (kg.locations ?? []).filter(n => n.embedding?.length).length
      + (kg.items ?? []).filter(n => n.embedding?.length).length
      + (kg.characters ?? []).filter(n => n.embedding?.length).length;

    const totalBytes = measureField(kg);

    // 实测：剥离 embedding 后重算结构体大小，差值即 embedding 真实体积
    let structuralBytes = 0;
    let actualEmbeddingBytes = 0;
    try {
      const stripped = JSON.parse(JSON.stringify(kg)) as typeof kg;
      for (const arr of [stripped.locations, stripped.items, stripped.characters]) {
        for (const n of arr ?? []) { delete (n as any).embedding; }
      }
      structuralBytes = JSON.stringify(stripped).length;
      actualEmbeddingBytes = Math.max(0, totalBytes - structuralBytes);
    } catch { /* ignore */ }

    // 取第一个有 embedding 的节点，获取实际维度
    let actualDim = 0;
    for (const arr of [kg.locations, kg.items]) {
      for (const n of arr ?? []) {
        if (n.embedding?.length) { actualDim = n.embedding.length; break; }
      }
      if (actualDim) break;
    }

    kgFields.push({
      field: '',
      label: 'knowledgeGraph',
      bytes: Math.max(0, totalBytes),
      count: totalNodes,
      hint: nodesWithEmb > 0
        ? `${locCnt}地点 ${itemCnt}物品 ${charCnt}人物 · ${edgeCnt}边 · ${nodesWithEmb}节点含embedding(${actualDim}维 实测${formatBytes(actualEmbeddingBytes)}) · 纯结构${formatBytes(structuralBytes)}`
        : `${locCnt}地点 ${itemCnt}物品 ${charCnt}人物 · ${edgeCnt}边`,
    });
  } else {
    kgFields.push({
      field: '',
      label: 'knowledgeGraph',
      bytes: 0,
      count: 0,
      hint: '未构建',
    });
  }
  // 图谱 embedding 缓存：旧版本/召回用的向量副本，可能很大
  const kgCache = cd.knowledgeGraphEmbeddingCache;
  let kgCacheCount = 0;
  if (kgCache) {
    for (const bucket of [kgCache.locations, kgCache.items]) {
      for (const group of Object.values(bucket ?? {})) {
        kgCacheCount += Object.keys(group ?? {}).length;
      }
    }
  }
  kgFields.push(
    {
      field: '',
      label: 'knowledgeGraphEmbeddingCache',
      bytes: Math.max(0, measureField(kgCache)),
      count: kgCacheCount,
      hint: kgCacheCount > 0 ? '旧图/召回用 embedding 缓存' : undefined,
    },
    measureArray(cd.knowledgeGraphVersions, 'knowledgeGraphVersions'),
    measureArray(cd.knowledgeGraphHistory, 'knowledgeGraphHistory'),
    measureArray(cd.knowledgeGraphUndoHistory, 'knowledgeGraphUndoHistory'),
    measureRecord(cd.characterLocations, 'characterLocations'),
  );
  mod('knowledgeGraph', '知识图谱', kgFields);

  // 8. 世界推进
  mod('worldProgress', '世界推进', [
    measureArray(cd.worldProgressRecords, 'worldProgressRecords'),
    measureArray(cd.worldProgressMemories, 'worldProgressMemories'),
    measureArray(cd.savedWPWB, 'savedWPWB'),
  ]);

  // 9. 剧情导演
  mod('plotDirector', '剧情导演', [
    measureValue(cd.plotOutline, 'plotOutline'),
    measureValue(cd.lastPlotCheckResult, 'lastPlotCheckResult'),
    measureArray(cd.savedPlotWB, 'savedPlotWB'),
  ]);

  // 10. 关系分析
  mod('relationship', '关系分析', [
    measureArray(cd.relationshipProfiles, 'relationshipProfiles'),
  ]);

  // 11. 物品记忆
  mod('itemMemory', '物品记忆', [
    measureArray(cd.itemMemories, 'itemMemories'),
  ]);

  // 12. 角色档案
  mod('characterProfile', '角色档案', [
    measureRecord(cd.characterProfiles, 'characterProfiles'),
    measureArray(cd.savedCharacterProfiles, 'savedCharacterProfiles'),
  ]);

  // 13. 世界书
  mod('worldBook', '世界书', [
    measureArray(cd.worldBookEntries, 'worldBookEntries'),
    measureArray(cd.worldBookTagBindings, 'worldBookTagBindings'),
    measureArray(cd.selectedWorldBookKeys, 'selectedWorldBookKeys'),
    measureArray(cd.worldProgressWorldBookKeys, 'worldProgressWorldBookKeys'),
  ]);

  // ---- 计算总大小 & 占比 ----
  const totalBytes = modules.reduce((s, m) => s + m.totalBytes, 0);
  for (const m of modules) {
    m.percent = totalBytes > 0 ? (m.totalBytes / totalBytes) * 100 : 0;
  }

  // 按体积降序排列
  modules.sort((a, b) => b.totalBytes - a.totalBytes);

  // 设置体积（localStorage）
  const settingsLocalBytes = measureField(scriptData);

  // 检查是否有 embedding 向量
  const hasEmbeddings = hasEmbeddingVectors(cd.characterMemories)
    || hasEmbeddingVectors(cd.knowledgeGraph)
    || hasEmbeddingVectors(cd.knowledgeGraphVersions);

  return {
    modules,
    totalBytes,
    settingsLocalBytes,
    hasEmbeddings,
  };
}

/**
 * 快速测量：返回总量字节数（用于轻量展示）
 */
export function quickMeasure(chatData: ChatData | null | undefined): number {
  if (!chatData) return 0;
  try {
    return JSON.stringify(chatData).length;
  } catch {
    return -1;
  }
}
