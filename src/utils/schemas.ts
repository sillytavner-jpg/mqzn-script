import { z } from 'zod';

// ========== 大总结V2 输出 Schema ==========

export const GrandSummaryV2Schema = z.object({
  events: z.array(z.object({
    time: z.string(),
    location: z.string().optional().default(''),
    presentCharacters: z.array(z.string()).optional().default([]),
    summary: z.string(),
    event: z.string(),
    importance: z.number().min(1).max(5).optional().default(3),
	    keywords: z.array(z.string()).optional().default([]),
  })),
});

// ========== 角色记忆更新 输出 Schema ==========

export const CharacterMemoryUpdateSchema = z.object({
  characterMemories: z.array(z.object({
    characterName: z.string(),
    aliases: z.array(z.string()).optional().default([]),
    attitude: z.enum(['like', 'dislike', 'neutral']).optional().default('neutral'),
    keywords: z.array(z.string()).optional().default([]),
    memories: z.array(z.object({
      date: z.string().optional().default(''),
      content: z.string(),
    })).optional().default([]),
    coreReasons: z.array(z.string()).optional().default([]),
    coreIndices: z.array(z.number()).optional().default([]),
  })),
  nsfwMemories: z.array(z.object({
    characterName: z.string(),
    sensitivePoints: z.array(z.string()).optional().default([]),
    preferences: z.array(z.string()).optional().default([]),
    behaviors: z.array(z.string()).optional().default([]),
    memories: z.array(z.string()).optional().default([]),
  })).optional().default([]),
}).optional().default({ characterMemories: [], nsfwMemories: [] });

// ========== 关系分析 输出 Schema ==========

export const RelationshipSchema = z.object({
  relationships: z.array(z.object({
    id: z.string(),
    characterA: z.string(),
    characterB: z.string(),
    type: z.string(),
    description: z.string(),
    intensity: z.number().min(1).max(5).optional(),
  })),
});

// ========== 动态人设V2 输出 Schema ==========

export const DynamicProfileV2Schema = z.object({
  profiles: z.array(z.object({
    characterName: z.string(),
    updates: z.object({
      factualState: z.string().optional().default(''),
      dynamicProfile: z.string().optional().default(''),
    }).optional().default({ factualState: '', dynamicProfile: '' }),
  })),
});

// ========== 角色设定档案 输出 Schema ==========
// 用于 characterProfile.ts 校验 AI 输出
// 轻量模式：corePersonality / imagery 为 optional
// 全套模式：由调用方在解析后校验是否存在
// 注意：accents / derivatives 加了预处理容错，AI 输出字符串时自动包装成数组

// 辅助：字符串自动包装成单元素数组
const stringOrArray = z.preprocess(
  (val) => (typeof val === 'string' ? [val] : val),
  z.array(z.string()),
);

export const CharacterProfileSchema = z.object({
  basicInfo: z.object({
    identity: z.string(),
    appearance: z.string(),
    background: z.string(),
    relationToUser: z.string(),
  }),
  colorPalette: z.object({
    explanation: z.string(),
    base: z.string(),
    primary: z.string(),
    accents: stringOrArray.optional().default([]),
    derivatives: stringOrArray.optional().default([]),
  }),
  secondaryExplanation: z.array(z.object({
    topic: z.string(),
    content: z.string(),
  })).optional().default([]),
  corePersonality: z.object({
    surfaceDesire: z.string(),
    deepLack: z.string(),
    coreFear: z.string(),
    defenseMechanism: z.string(),
    coreConflict: z.string(),
    moralBottomLine: z.string(),
    selfAwareness: z.string(),
  }).optional(),
  imagery: z.string().optional(),
  literaryReferences: z.array(z.object({
    character: z.string(),
    work: z.string(),
    borrowedTraits: z.string(),
  })).optional().default([]),
});

// ========== 世界推进 输出 Schema ==========

export const WorldProgressSchema = z.object({
  currentTime: z.string().optional().default(''),
  mainTimeline: z.object({
    storyTime: z.string().optional().default(''),
    location: z.string().optional().default(''),
    event: z.string().optional().default(''),
    worldStateOneLine: z.string().optional().default(''),
  }).optional().default({ storyTime: '', location: '', event: '', worldStateOneLine: '' }),
  presentCharacters: z.array(z.string()).optional().default([]),
  advancedCharacters: z.array(z.object({
    characterName: z.string(),
    location: z.string().optional().default(''),
    action: z.string().optional().default(''),
    reason: z.string().optional().default(''),
    possibleEncounter: z.string().optional().default(''),
    newFacts: z.array(z.string()).optional().default([]),
    memoryText: z.string().optional().default(''),
    result: z.string().optional().default(''),
  })).optional().default([]),
  backgroundEvents: z.array(z.string()).optional().default([]),
  pendingHooks: z.array(z.string()).optional().default([]),
  resolvedHooks: z.array(z.object({
    chain: z.string(),
    characterNames: z.array(z.string()).optional().default([]),
  })).optional().default([]),
  entryHint: z.object({
    characterName: z.string().optional().default(''),
    level: z.coerce.number().optional().default(0),
    hint: z.string().optional().default(''),
    avoid: z.string().optional().default(''),
  }).nullable().optional().default(null),
});

// ========== 知识图谱 diff 输出 Schema（小总结顺带输出） ==========

export const KnowledgeGraphDiffSchema = z.object({
  add: z.object({
    locations: z.array(z.object({
      name: z.string(),
	      brief: z.string().optional().default(''),
	      aliases: z.array(z.string()).optional().default([]),
    })).optional().default([]),
    items: z.array(z.object({
      name: z.string(),
	      brief: z.string().optional().default(''),
	      aliases: z.array(z.string()).optional().default([]),
	      quantity: z.string().optional(),
	      belongTo: z.string().optional().default(''),
	      state: z.string().optional().default(''),
	      consumed: z.boolean().optional(),
    })).optional().default([]),
    edges: z.array(z.object({
      type: z.string().optional().default('contains'),
      from: z.string(),
      to: z.string(),
      detail: z.string().optional().default(''),
    })).optional().default([]),
    characters: z.array(z.object({
      name: z.string(),
      location: z.string().optional().default(''),
      aliases: z.array(z.string()).optional().default([]),
    })).optional().default([]),
  }).optional().default({ locations: [], items: [], edges: [], characters: [] }),
  update: z.array(z.object({
    id: z.string(),
    field: z.string(),
    value: z.any(),
  })).optional().default([]),
  delete: z.array(z.string()).optional().default([]),
}).optional().default({ add: { locations: [], items: [], edges: [], characters: [] }, update: [], delete: [] });
