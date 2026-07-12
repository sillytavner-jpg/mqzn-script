/**
 * 嵌入模型能力表
 *
 * 不同 provider/模型对 `dimensions`（Matryoshka 降维）参数的支持不同：
 * - bge-m3 / Qwen3-Embedding-* 系列原生支持，可在请求体传 dimensions 降维
 * - bge-large/base/small-zh-v1.5 等仅原生维度，传 dimensions 会被部分 provider 拒绝
 * - 未知模型：用户可手动勾选「支持 Matryoshka 降维」声明
 *
 * 仅靠 model 名字匹配（不依赖 baseURL）。SiliconFlow / DashScope / OpenAI 等均使用同样的模型名，
 * 故按 model 匹配即可覆盖主流场景。当模型名在能力表外时返回 null，由调用方决定降级行为。
 */

export interface EmbeddingModelCapability {
  /** 模型名（精确或前缀，匹配时用 startsWith / ===） */
  pattern: string;
  /** 原生维度（不传 dimensions 时的默认维度） */
  nativeDim: number;
  /** 是否支持 Matryoshka 降维（即可在请求体传 dimensions） */
  supportsMatryoshka: boolean;
  /** 推荐降维档位（可选，用于 UI 下拉展示；缺省时调用方回退到全集 ≤ nativeDim 的档位） */
  reductionSteps?: number[];
}

export const EMBEDDING_MODEL_CAPS: EmbeddingModelCapability[] = [
  // bge-m3：原版设计支持 Matryoshka，但 SiliconFlow 渠道的 bge-m3 实测不接受 dimensions 参数
  // （发 dimensions 会 400 code 20015 "The parameter is invalid"）。
  // 默认按「不支持」处理：不发 dimensions，维度回退原生 1024。
  // 若你的部署用的是支持 dimensions 的渠道（如自部署版），可在 UI 手动勾选「此模型支持 Matryoshka 降维」覆盖。
  { pattern: 'BAAI/bge-m3',               nativeDim: 1024, supportsMatryoshka: false },
  { pattern: 'Pro/BAAI/bge-m3',           nativeDim: 1024, supportsMatryoshka: false },
  // Qwen3-Embedding 系列：DashScope / SiliconFlow 官方明确支持 Matryoshka 降维
  { pattern: 'Qwen/Qwen3-Embedding-0.6B', nativeDim: 1024, supportsMatryoshka: true,  reductionSteps: [256, 512, 768, 1024] },
  { pattern: 'Qwen/Qwen3-Embedding-4B',   nativeDim: 2560, supportsMatryoshka: true,  reductionSteps: [1024, 1536, 2048, 2560] },
  { pattern: 'Qwen/Qwen3-Embedding-8B',   nativeDim: 4096, supportsMatryoshka: true,  reductionSteps: [1024, 2048, 3072, 4096] },
  { pattern: 'BAAI/bge-large-zh-v1.5',    nativeDim: 1024, supportsMatryoshka: false },
  { pattern: 'BAAI/bge-base-zh-v1.5',     nativeDim: 768,  supportsMatryoshka: false },
  { pattern: 'BAAI/bge-small-zh-v1.5',    nativeDim: 512,  supportsMatryoshka: false },
];

/** 全局降维候选集（未知模型 / 用户手动开启时展示的兜底档位） */
export const DEFAULT_REDUCTION_STEPS = [64, 128, 256, 384, 512, 768, 1024, 2048, 2560, 4096];

/**
 * 查询模型的能力。先精确匹配，再前缀匹配，最后返回 null。
 */
export function lookupModelCapability(model: string): EmbeddingModelCapability | null {
  if (!model) return null;
  // 精确匹配优先
  for (const cap of EMBEDDING_MODEL_CAPS) {
    if (cap.pattern === model) return cap;
  }
  // 前缀匹配（如 'Qwen/Qwen3-Embedding-4B' 含 namespace 完整匹配；这里兜底兼容前缀）
  for (const cap of EMBEDDING_MODEL_CAPS) {
    if (model.startsWith(cap.pattern)) return cap;
  }
  return null;
}

/**
 * 返回该模型可用的降维档位（用于 UI 维度下拉）。已包含原生维度。
 * - 已知支持降维模型：用 reductionSteps（已含 nativeDim）
 * - 未知模型（返回 null）：回退 DEFAULT_REDUCTION_STEPS
 * 注意：调用方应进一步按「该模型是否被声明支持降维」决定是否过滤；这里只返回候选集。
 */
export function getReductionStepsFor(model: string): number[] {
  const cap = lookupModelCapability(model);
  if (cap?.reductionSteps?.length) return cap.reductionSteps;
  return DEFAULT_REDUCTION_STEPS;
}

/**
 * 决定请求体里要不要发 `dimensions`，以及发什么值。
 *
 * @param model 当前模型名
 * @param requestedDim 用户选的维度；0 / 未设置 → 跟随原生（不发）
 * @param manualMatryoshka 用户手动声明该未知模型支持降维
 * @returns 要塞进 body.dimensions 的数值，undefined 表示不发该字段
 */
export function decideDimToSend(
  model: string,
  requestedDim: number | undefined,
  manualMatryoshka: boolean,
): number | undefined {
  const cap = lookupModelCapability(model);
  const supports = manualMatryoshka || (cap?.supportsMatryoshka ?? false);
  // 不支持降维：不发 dimensions，让 provider 按原生维度产出
  if (!supports) return undefined;
  // 0 / 未设置 = 跟随原生（也不发，依赖 provider 默认）
  if (!requestedDim || requestedDim <= 0) return undefined;
  // 超过原生维度不发，避免 provider 返回 400
  if (cap && requestedDim > cap.nativeDim) return undefined;
  return requestedDim;
}