/// @file provider-registry.ts
/// @brief Multi-model Provider registry — manages API configuration and model definitions for all model providers
///
/// Unified registry supporting 7 providers and 20+ models.
/// All model information (ID, capabilities, context window, pricing) is defined centrally for use by the routing engine and UI.
///
/// @Design principles:
///   - Pure data layer, zero external dependencies (no OpenAI SDK, no HEX4 internal modules)
///   - Static registration, determined at compile time, no runtime loading
///   - All prices in USD per million tokens ($ per 1M tokens)

// ── Provider 标识符 ──────────────────────────────────────────────
export type ModelProvider =
  | "deepseek"
  | "openai"
  | "qwen"
  | "gemini"
  | "ernie"
  | "minimax"
  | "glm"
  | "anthropic"
  | "groq"
  | "mistral"
  | "custom";

/** 模型能力标签 — 用于任务-模型匹配 */
export type ModelCapability = "code" | "reasoning" | "analysis" | "chat" | "fast" | "fim";

// ── 模型定义 ─────────────────────────────────────────────────────
export type ModelDef = {
  /** 模型唯一标识符（如 "qwen-max", "gpt-4o", "deepseek-v4-pro"） */
  id: string;
  /** 所属Provider */
  provider: ModelProvider;
  /** 人类可读的显示名称 */
  label: string;
  /** 能力标签 */
  capabilities: ModelCapability[];
  /** 上下文窗口大小（token数） */
  contextWindow: number;
  /** 输入价格（美元/百万token） */
  costPer1MInput: number;
  /** 输出价格（美元/百万token） */
  costPer1MOutput: number;
};

// ── Provider 配置 ────────────────────────────────────────────────
export type ProviderConfig = {
  /** Provider 标识符 */
  id: ModelProvider;
  /** 人类可读的显示名称 */
  name: string;
  /** 环境变量名（用于读取 API Key） */
  apiKeyEnv: string;
  /** 默认API基础URL */
  defaultBaseURL: string;
  /** 是否支持流式输出 */
  supportsStreaming: boolean;
  /** 是否支持thinking/推理 */
  supportsThinking: boolean;
  /** 是否支持多模态 */
  supportsMultimodal: boolean;
  /** 该Provider下的所有模型 */
  models: ModelDef[];
};

// ── 预注册的Provider列表 ─────────────────────────────────────────
//
// 数据来源：各Provider官方文档（2026年5月）
// 价格基准：公开API定价，可能随市场调整
//
export const PROVIDERS: ProviderConfig[] = [
  // ── DeepSeek ─────────────────────────────────────────────────────
  // 默认Provider，HEX4原生支持，拥有最大上下文窗口(1M)
  {
    id: "deepseek",
    name: "DeepSeek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultBaseURL: "https://api.deepseek.com",
    supportsStreaming: true,
    supportsThinking: true,
    supportsMultimodal: false,
    models: [
      {
        id: "deepseek-v4-pro",
        provider: "deepseek",
        label: "DeepSeek V4 Pro",
        capabilities: ["code", "reasoning", "analysis", "chat"],
        contextWindow: 1_000_000,
        costPer1MInput: 0.5,
        costPer1MOutput: 2.0,
      },
      {
        id: "deepseek-v4-flash",
        provider: "deepseek",
        label: "DeepSeek V4 Flash",
        capabilities: ["code", "chat", "fast"],
        contextWindow: 1_000_000,
        costPer1MInput: 0.14,
        costPer1MOutput: 0.42,
      },
      {
        id: "deepseek-chat",
        provider: "deepseek",
        label: "DeepSeek Chat",
        capabilities: ["code", "chat"],
        contextWindow: 128_000,
        costPer1MInput: 0.14,
        costPer1MOutput: 0.28,
      },
      {
        id: "deepseek-reasoner",
        provider: "deepseek",
        label: "DeepSeek Reasoner",
        capabilities: ["reasoning", "analysis"],
        contextWindow: 128_000,
        costPer1MInput: 0.55,
        costPer1MOutput: 2.19,
      },
      {
        id: "deepseek-coder-v2",
        provider: "deepseek",
        label: "DeepSeek Coder V2",
        capabilities: ["code", "fim", "fast"],
        contextWindow: 128_000,
        costPer1MInput: 0.14,
        costPer1MOutput: 0.42,
      },
    ],
  },

  // ── OpenAI ───────────────────────────────────────────────────────
  // 行业标杆，安全审查和复杂推理的首选
  {
    id: "openai",
    name: "OpenAI",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultBaseURL: "https://api.openai.com/v1",
    supportsStreaming: true,
    supportsThinking: true,
    supportsMultimodal: true,
    models: [
      {
        id: "gpt-4o",
        provider: "openai",
        label: "GPT-4o",
        capabilities: ["code", "reasoning", "analysis", "chat"],
        contextWindow: 128_000,
        costPer1MInput: 2.5,
        costPer1MOutput: 10.0,
      },
      {
        id: "gpt-4o-mini",
        provider: "openai",
        label: "GPT-4o Mini",
        capabilities: ["code", "chat", "fast"],
        contextWindow: 128_000,
        costPer1MInput: 0.15,
        costPer1MOutput: 0.6,
      },
    ],
  },

  // ── 通义千问 (Qwen) ─────────────────────────────────────────────
  // 阿里云百炼平台，中文理解和代码生成能力强
  {
    id: "qwen",
    name: "通义千问",
    apiKeyEnv: "QWEN_API_KEY",
    defaultBaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    supportsStreaming: true,
    supportsThinking: false,
    supportsMultimodal: true,
    models: [
      {
        id: "qwen-max",
        provider: "qwen",
        label: "Qwen Max",
        capabilities: ["code", "reasoning", "analysis", "chat"],
        contextWindow: 128_000,
        costPer1MInput: 0.8,
        costPer1MOutput: 2.0,
      },
      {
        id: "qwen-plus",
        provider: "qwen",
        label: "Qwen Plus",
        capabilities: ["code", "chat", "fast"],
        contextWindow: 128_000,
        costPer1MInput: 0.4,
        costPer1MOutput: 1.2,
      },
      {
        id: "qwen-turbo",
        provider: "qwen",
        label: "Qwen Turbo",
        capabilities: ["code", "chat", "fast"],
        contextWindow: 128_000,
        costPer1MInput: 0.2,
        costPer1MOutput: 0.6,
      },
    ],
  },

  // ── Gemini (Google) ──────────────────────────────────────────────
  // 超长上下文(1M)，超大代码库分析首选
  // 注意：Gemini 使用 Google AI SDK，非OpenAI兼容API
  {
    id: "gemini",
    name: "Gemini",
    apiKeyEnv: "GEMINI_API_KEY",
    defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
    supportsStreaming: true,
    supportsThinking: true,
    supportsMultimodal: true,
    models: [
      {
        id: "gemini-2.5-pro",
        provider: "gemini",
        label: "Gemini 2.5 Pro",
        capabilities: ["code", "reasoning", "analysis", "chat"],
        contextWindow: 1_000_000,
        costPer1MInput: 1.25,
        costPer1MOutput: 5.0,
      },
      {
        id: "gemini-2.5-flash",
        provider: "gemini",
        label: "Gemini 2.5 Flash",
        capabilities: ["code", "chat", "fast"],
        contextWindow: 1_000_000,
        costPer1MInput: 0.1,
        costPer1MOutput: 0.4,
      },
    ],
  },

  // ── 文心一言 (ERNIE) ─────────────────────────────────────────────
  // 百度千帆平台，中文理解优化
  // ERNIE 使用独立的access_token认证机制（API Key + Secret Key）
  {
    id: "ernie",
    name: "文心一言",
    apiKeyEnv: "ERNIE_API_KEY",
    defaultBaseURL: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop",
    supportsStreaming: true,
    supportsThinking: false,
    supportsMultimodal: false,
    models: [
      {
        id: "ernie-4.5",
        provider: "ernie",
        label: "ERNIE 4.5",
        capabilities: ["code", "reasoning", "chat"],
        contextWindow: 128_000,
        costPer1MInput: 0.6,
        costPer1MOutput: 1.8,
      },
    ],
  },

  // ── MiniMax ──────────────────────────────────────────────────────
  // 高性价比，适合补全和简单对话场景
  {
    id: "minimax",
    name: "MiniMax",
    apiKeyEnv: "MINIMAX_API_KEY",
    defaultBaseURL: "https://api.minimax.chat/v1",
    supportsStreaming: true,
    supportsThinking: false,
    supportsMultimodal: false,
    models: [
      {
        id: "minimax-text-01",
        provider: "minimax",
        label: "MiniMax Text-01",
        capabilities: ["code", "chat", "fast"],
        contextWindow: 128_000,
        costPer1MInput: 0.2,
        costPer1MOutput: 0.6,
      },
    ],
  },

  // ── 智谱GLM ──────────────────────────────────────────────────────
  // 清华系，中文理解和推理能力强
  {
    id: "glm",
    name: "智谱GLM",
    apiKeyEnv: "GLM_API_KEY",
    defaultBaseURL: "https://open.bigmodel.cn/api/paas/v4",
    supportsStreaming: true,
    supportsThinking: true,
    supportsMultimodal: true,
    models: [
      {
        id: "glm-5",
        provider: "glm",
        label: "GLM-5",
        capabilities: ["code", "reasoning", "analysis", "chat"],
        contextWindow: 128_000,
        costPer1MInput: 0.5,
        costPer1MOutput: 1.5,
      },
    ],
  },

  // ── Anthropic (Claude) ──────────────────────────────────────────
  // 代码生成和复杂推理能力业界领先
  // 注意：使用 Anthropic API（非 OpenAI 兼容），需通过 provider-client.ts 适配
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultBaseURL: "https://api.anthropic.com/v1",
    supportsStreaming: true,
    supportsThinking: true,
    supportsMultimodal: true,
    models: [
      {
        id: "claude-opus-4",
        provider: "anthropic",
        label: "Claude Opus 4",
        capabilities: ["code", "reasoning", "analysis", "chat"],
        contextWindow: 200_000,
        costPer1MInput: 15.0,
        costPer1MOutput: 75.0,
      },
      {
        id: "claude-sonnet-4",
        provider: "anthropic",
        label: "Claude Sonnet 4",
        capabilities: ["code", "reasoning", "analysis", "chat"],
        contextWindow: 200_000,
        costPer1MInput: 3.0,
        costPer1MOutput: 15.0,
      },
      {
        id: "claude-haiku-4",
        provider: "anthropic",
        label: "Claude Haiku 4",
        capabilities: ["code", "chat", "fast"],
        contextWindow: 200_000,
        costPer1MInput: 0.8,
        costPer1MOutput: 4.0,
      },
    ],
  },

  // ── Groq ─────────────────────────────────────────────────────────
  // 超低延迟推理，开源模型托管
  // API 兼容 OpenAI 格式
  {
    id: "groq",
    name: "Groq",
    apiKeyEnv: "GROQ_API_KEY",
    defaultBaseURL: "https://api.groq.com/openai/v1",
    supportsStreaming: true,
    supportsThinking: false,
    supportsMultimodal: false,
    models: [
      {
        id: "llama-4-scout",
        provider: "groq",
        label: "Llama 4 Scout",
        capabilities: ["code", "chat", "fast"],
        contextWindow: 256_000,
        costPer1MInput: 0.1,
        costPer1MOutput: 0.4,
      },
      {
        id: "llama-4-maverick",
        provider: "groq",
        label: "Llama 4 Maverick",
        capabilities: ["code", "reasoning", "chat"],
        contextWindow: 256_000,
        costPer1MInput: 0.2,
        costPer1MOutput: 0.6,
      },
      {
        id: "mixtral-8x7b",
        provider: "groq",
        label: "Mixtral 8x7B",
        capabilities: ["code", "chat", "fast"],
        contextWindow: 32_000,
        costPer1MInput: 0.27,
        costPer1MOutput: 0.27,
      },
    ],
  },

  // ── Mistral (Codestral) ──────────────────────────────────────────
  // FIM 补全能力业界领先，专为代码生成优化
  {
    id: "mistral",
    name: "Mistral (Codestral)",
    apiKeyEnv: "MISTRAL_API_KEY",
    defaultBaseURL: "https://api.mistral.ai/v1",
    supportsStreaming: true,
    supportsThinking: false,
    supportsMultimodal: false,
    models: [
      {
        id: "codestral-latest",
        provider: "mistral",
        label: "Codestral (FIM)",
        capabilities: ["code", "fim", "reasoning"],
        contextWindow: 256_000,
        costPer1MInput: 0.0,
        costPer1MOutput: 0.0,
      },
    ],
  },

  {
    id: "custom",
    name: "Custom (OpenAI Compatible)",
    apiKeyEnv: "CUSTOM_API_KEY",
    defaultBaseURL: "http://localhost:11434/v1",
    supportsStreaming: true,
    supportsThinking: false,
    supportsMultimodal: true,
    models: [],
  },
];

// ── 索引（用于快速查找） ──────────────────────────────────────────

/** 所有模型ID → ModelDef 的映射（运行前构建） */
const MODEL_BY_ID: Map<string, ModelDef> = new Map();

/** Provider ID → ProviderConfig 的映射 */
const PROVIDER_BY_ID: Map<ModelProvider, ProviderConfig> = new Map();

// 构建索引
for (const provider of PROVIDERS) {
  PROVIDER_BY_ID.set(provider.id, provider);
  for (const model of provider.models) {
    MODEL_BY_ID.set(model.id, model);
  }
}

// ── 查询函数 ──────────────────────────────────────────────────────

/** 按模型ID查找模型定义 */
export function getModelDef(modelId: string): ModelDef | undefined {
  return MODEL_BY_ID.get(modelId);
}

/** 判断模型 ID 是否已在内置注册表中。 */
export function isRegisteredModel(modelId: string): boolean {
  return MODEL_BY_ID.has(modelId);
}

/** 按Provider ID查找Provider配置 */
export function getProvider(providerId: ModelProvider): ProviderConfig | undefined {
  return PROVIDER_BY_ID.get(providerId);
}

/** 查找包含某个模型ID的Provider */
export function getProviderByModel(modelId: string): ProviderConfig | undefined {
  const def = MODEL_BY_ID.get(modelId);
  if (!def) return undefined;
  return PROVIDER_BY_ID.get(def.provider);
}

/** 按能力过滤所有模型（返回按输入价格升序） */
export function getModelsByCapability(capability: ModelCapability): ModelDef[] {
  const result: ModelDef[] = [];
  for (const model of MODEL_BY_ID.values()) {
    if (model.capabilities.includes(capability)) {
      result.push(model);
    }
  }
  return result.sort((a, b) => a.costPer1MInput - b.costPer1MInput);
}

/** 获取某个Provider下的所有模型ID */
export function getModelsByProvider(providerId: ModelProvider): string[] {
  const provider = PROVIDER_BY_ID.get(providerId);
  if (!provider) return [];
  return provider.models.map((m) => m.id);
}

/** 判断模型是否有某个能力 */
export function modelHasCapability(modelId: string, capability: ModelCapability): boolean {
  const def = MODEL_BY_ID.get(modelId);
  if (!def) return false;
  return def.capabilities.includes(capability);
}

/** 获取推荐用于某种任务的模型列表（按性价比排序） */
export function getRecommendedModels(task: "completion" | "generation" | "analysis" | "review" | "chat" | "fim"): ModelDef[] {
  // 任务→所需能力的映射
  const requiredCapability: Record<string, ModelCapability> = {
    completion: "fast",
    generation: "reasoning",
    analysis: "analysis",
    review: "reasoning",
    chat: "chat",
    fim: "fim",
  };
  const cap = requiredCapability[task] || "chat";
  return getModelsByCapability(cap);
}

/** 获取默认路由（任务→最便宜的可用模型ID） */
export function getDefaultModelForTask(task: "completion" | "generation" | "analysis" | "review" | "chat" | "fim"): string {
  const recommended = getRecommendedModels(task);
  if (recommended.length === 0) return "deepseek-v4-flash";
  return recommended[0].id; // 最便宜
}

/** 获取环境变量名列表（用于检测用户配置了哪些Provider） */
export function getAllApiKeyEnvVars(): string[] {
  return PROVIDERS.map((p) => p.apiKeyEnv).filter(Boolean);
}
