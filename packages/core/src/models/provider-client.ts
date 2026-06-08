/// @file provider-client.ts
/// @brief Multi-model Provider client factory — creates API clients based on model ID
///
/// Supported Provider types:
///   - OpenAI-compatible APIs: DeepSeek, OpenAI, Qwen, ERNIE, MiniMax, GLM
///     -> Unified via OpenAI SDK (openai)
///   - Google AI: Gemini
///     -> Uses Google Generative AI SDK (@google/generative-ai)
///
/// @Design principles:
///   - Factory pattern, callers do not directly depend on specific SDKs
///   - Gemini adapter provides an interface signature compatible with OpenAI
///   - 所有客户端懒加载（只在首次使用时创建）

import { getProviderByModel } from "./provider-registry";

// ── OpenAI SDK 类型引用（用于类型导出，避免直接导入） ──────────
// 实际import在函数内部懒加载，确保启动时不阻塞
import OpenAI from "openai";

// ── Gemini 适配器类型 ───────────────────────────────────────────
/**
 * Gemini 适配器提供与 OpenAI SDK 兼容的接口签名，
 * 使调用方无需为Gemini写特殊逻辑。
 */
export type GeminiClient = {
  chat: {
    completions: {
      create: (params: GeminiChatParams) => Promise<GeminiResponse>;
    };
  };
};

export type GeminiChatParams = {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
};

export type GeminiResponse = {
  choices: Array<{
    message: {
      content: string | null;
      role: "assistant";
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

// ── 统一客户端类型 ─────────────────────────────────────────────
/**
 * 统一客户端类型 = OpenAI SDK 客户端 | Gemini 适配器
 * 调用方可以统一使用 chat.completions.create API
 */
export type UnifiedClient = OpenAI | GeminiClient;

// ── Provider 特定配置 ──────────────────────────────────────────
export type ClientConfig = {
  /** 模型ID */
  modelId: string;
  /** API Key */
  apiKey: string;
  /** API基础URL（可选，覆盖默认） */
  baseURL?: string;
};

// ── 工厂函数 ─────────────────────────────────────────────────────

/**
 * 根据模型ID和API Key创建对应的API客户端。
 *
 * @param config - 客户端配置（模型ID + API Key + 可选BaseURL）
 * @returns 统一的API客户端，或 null（当参数无效时）
 *
 * @example
 * const client = createClient({
 *   modelId: "deepseek-v4-flash",
 *   apiKey: "sk-xxx",
 * });
 * const response = await client.chat.completions.create({
 *   model: "deepseek-v4-flash",
 *   messages: [{ role: "user", content: "Hello" }],
 * });
 */
export function createClient(config: ClientConfig): UnifiedClient | null {
  const { modelId, apiKey, baseURL: baseURLOverride } = config;

  if (!modelId || !apiKey) {
    return null;
  }

  const provider = getProviderByModel(modelId);
  if (!provider) {
    if (baseURLOverride) {
      return createOpenAICompatibleClient(apiKey, baseURLOverride);
    }
    return null;
  }

  const baseURL = baseURLOverride || provider.defaultBaseURL;

  switch (provider.id) {
    case "gemini":
      return createGeminiClient(apiKey, baseURL);

    // 所有其他Provider使用OpenAI兼容API
    default:
      return createOpenAICompatibleClient(apiKey, baseURL);
  }
}

// ── OpenAI 兼容客户端 ───────────────────────────────────────────

function createOpenAICompatibleClient(apiKey: string, baseURL: string): OpenAI {
  // 动态导入OpenAI SDK（懒加载）

  return new OpenAI({ apiKey, baseURL });
}

// ── Gemini 适配器 ───────────────────────────────────────────────

function createGeminiClient(apiKey: string, baseURL: string): GeminiClient {
  return new GeminiAdapter(apiKey, baseURL);
}

/**
 * Gemini API 适配器。
 * 将 Google Generative AI SDK 的调用封装为 OpenAI-compatible 接口，
 * 使 session.ts 和其他调用方可统一使用 chat.completions.create。
 */
class GeminiAdapter implements GeminiClient {
  private apiKey: string;
  private baseURL: string;

  constructor(apiKey: string, baseURL: string) {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
  }

  chat = {
    completions: {
      create: async (params: GeminiChatParams): Promise<GeminiResponse> => {
        // Gemini API 的消息格式转换
        const systemMsg = params.messages.find((m) => m.role === "system")?.content || "";
        const history = params.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role === "assistant" ? ("model" as const) : ("user" as const),
            parts: [{ text: m.content }],
          }));

        // 构造 Gemini API 请求体
        const requestBody: Record<string, unknown> = {
          contents: history,
          generationConfig: {
            maxOutputTokens: params.max_tokens ?? 4096,
            temperature: params.temperature ?? 0.7,
          },
          systemInstruction: systemMsg ? { parts: [{ text: systemMsg }] } : undefined,
        };

        // 调用 Gemini API
        const response = await fetch(`${this.baseURL}/models/${params.model}:generateContent?key=${this.apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Gemini API error (${response.status}): ${errorText}`);
        }

        const data = (await response.json()) as GeminiRawResponse;

        // 转换为 OpenAI-compatible 响应格式
        const content =
          data.candidates?.[0]?.content?.parts
            ?.map((p: { text?: string }) => p.text)
            .filter(Boolean)
            .join("") || null;

        return {
          choices: [
            {
              message: {
                content,
                role: "assistant",
              },
              finish_reason: data.candidates?.[0]?.finishReason ?? null,
            },
          ],
          usage: data.usageMetadata
            ? {
                prompt_tokens: data.usageMetadata.promptTokenCount ?? 0,
                completion_tokens: data.usageMetadata.candidatesTokenCount ?? 0,
                total_tokens:
                  (data.usageMetadata.promptTokenCount ?? 0) + (data.usageMetadata.candidatesTokenCount ?? 0),
              }
            : undefined,
        };
      },
    },
  };
}

/** Gemini API 原始响应类型 */
interface GeminiRawResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
      role?: string;
    };
    finishReason?: string;
    safetyRatings?: unknown[];
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

// ── 辅助函数 ─────────────────────────────────────────────────────

/**
 * 判断一个客户端是否为Gemini适配器。
 * 用于调用方需要特殊处理Gemini的场景（如thinking参数）。
 */
export function isGeminiClient(client: UnifiedClient): client is GeminiClient {
  return !("apiKey" in client) || ("chat" in client && !("baseURL" in client));
}

/**
 * 判断一个模型是否需要Gemini适配器。
 */
export function needsGeminiAdapter(modelId: string): boolean {
  const provider = getProviderByModel(modelId);
  return provider?.id === "gemini";
}

/**
 * 获取模型对应的API Key环境变量名。
 * 用于UI显示或配置提示。
 */
export function getApiKeyEnvForModel(modelId: string): string | undefined {
  const provider = getProviderByModel(modelId);
  return provider?.apiKeyEnv;
}
