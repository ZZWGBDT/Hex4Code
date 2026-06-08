/// @file model-router.ts
/// @brief Multi-model routing engine — routes requests to the optimal model based on task type, user configuration, and cost
///
/// Routing strategy (by priority):
///   1. User explicitly specifies a model -> use directly
///   2. User configured routing table -> look up by task
///   3. Match by capability among providers with configured keys + pick the cheapest
///   4. Fall back to DeepSeek V4 Flash (always has adapter)
///
/// @Design principles:
///   - Only depends on provider-registry.ts, does not depend on any HEX4 internal modules
///   - Pure functions, no side effects, unit-testable
///   - 路由决策是确定性的（给定相同输入返回相同结果）

import {
  type ModelProvider,
  type ModelDef,
  type ProviderConfig,
  getModelDef,
  getProvider,
  isRegisteredModel,
  PROVIDERS,
} from "./provider-registry";

// ── Task 类型（与 settings.ts 的 TaskType 保持同步） ──────────────
export type TaskType = "completion" | "fim" | "generation" | "analysis" | "review" | "chat";

// ── 路由结果 ─────────────────────────────────────────────────────
export type RouteResult = {
  /** 选中的模型ID */
  modelId: string;
  /** 所属Provider标识符 */
  provider: ModelProvider;
  /** API基础URL */
  baseURL: string;
  /** API Key的环境变量名 */
  apiKeyEnv: string;
  /** 是否支持thinking/推理 */
  supportsThinking: boolean;
  /** 模型定义（完整信息） */
  modelDef: ModelDef;
  /** 路由决策的说明（用于调试和日志） */
  reason: string;
};

// ── 路由配置 ─────────────────────────────────────────────────────
export type RouterConfig = {
  /** 用户显式指定的模型（优先级最高） */
  explicitModel?: string;
  /** 用户配置的任务→模型路由表 */
  routing?: Partial<Record<TaskType, string>>;
  /** 已配置API Key的Provider ID列表 */
  configuredProviders?: ModelProvider[];
  /** 显式Provider baseURL覆盖 */
  baseURLOverrides?: Partial<Record<ModelProvider, string>>;
};

export type ProviderRouteInput = {
  model?: string;
  routing?: Partial<Record<TaskType, string>>;
  env?: Record<string, string | undefined>;
  providers?: Partial<Record<ModelProvider, ProviderRouteSettings>>;
  legacyApiKeyProvider?: ModelProvider;
  legacyBaseURLProvider?: ModelProvider;
  processEnv?: Record<string, string | undefined>;
};

export type ProviderCompatibility = "openai-compatible" | "minimax" | "ollama";
export type CustomProviderEndpoint = {
  id: string;
  name?: string;
  apiKey?: string;
  baseURL: string;
  compatibility?: ProviderCompatibility;
  models: string[];
};
export type ProviderRouteSettings = {
  apiKey?: string;
  baseURL?: string;
  compatibility?: ProviderCompatibility;
  models?: string[];
  endpoints?: CustomProviderEndpoint[];
};

export type ProviderRouteResolution = RouteResult & {
  apiKey: string;
  apiKeySource: "settings.providers" | "settings.env.provider" | "process.env.provider" | "legacy.apiKey" | "missing";
  baseURLSource: "settings.providers" | "settings.env.provider" | "process.env.provider" | "legacy.baseURL" | "provider.default";
  configuredProviders: ModelProvider[];
  warnings: string[];
};

export type ProviderRuntimeModel = {
  providerId: ModelProvider;
  providerName: string;
  modelId: string;
  label: string;
  baseURL: string;
  apiKey: string;
  apiKeySource: ProviderRouteResolution["apiKeySource"];
  baseURLSource: ProviderRouteResolution["baseURLSource"];
  compatibility?: ProviderCompatibility;
};

function trimEnvValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function mergeRouteEnv(
  settingsEnv: Record<string, string | undefined> | undefined,
  processEnv: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === "string") {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(settingsEnv ?? {})) {
    if (typeof value === "string") {
      merged[key] = value;
    }
  }
  return merged;
}

function normalizeRouteProviders(
  providers: ProviderRouteInput["providers"],
): Partial<Record<ModelProvider, ProviderRouteSettings>> {
  const result: Partial<Record<ModelProvider, ProviderRouteSettings>> = {};
  for (const [providerId, providerSettings] of Object.entries(providers ?? {})) {
    if (!providerSettings || typeof providerSettings !== "object") {
      continue;
    }
    const apiKey = trimEnvValue(providerSettings.apiKey);
    const baseURL = trimEnvValue(providerSettings.baseURL);
    const compatibility = normalizeProviderCompatibility(providerSettings.compatibility) || inferProviderCompatibility(baseURL);
    const models = normalizeModelIds(providerSettings.models);
    const endpoints = normalizeCustomEndpoints(providerSettings.endpoints);
    if (apiKey || baseURL || compatibility || models.length > 0 || endpoints.length > 0) {
      result[providerId as ModelProvider] = {
        ...(apiKey ? { apiKey } : {}),
        ...(baseURL ? { baseURL } : {}),
        ...(compatibility ? { compatibility } : {}),
        ...(models.length > 0 ? { models } : {}),
        ...(endpoints.length > 0 ? { endpoints } : {}),
      };
    }
  }
  return result;
}

function normalizeProviderCompatibility(value: unknown): ProviderCompatibility | undefined {
  return value === "openai-compatible" || value === "minimax" || value === "ollama" ? value : undefined;
}

export function inferProviderCompatibility(baseURL: string): ProviderCompatibility {
  const normalized = baseURL.toLowerCase();
  if (normalized.includes("minimaxi.com")) return "minimax";
  if (normalized.includes("localhost:11434") || normalized.includes("127.0.0.1:11434") || normalized.includes("ollama")) {
    return "ollama";
  }
  return "openai-compatible";
}

function normalizeModelIds(value: unknown): string[] {
  return Array.isArray(value) ? Array.from(new Set(value.map((model) => trimEnvValue(model)).filter(Boolean))) : [];
}

function normalizeCustomEndpoints(value: unknown): CustomProviderEndpoint[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const endpoints: CustomProviderEndpoint[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const endpoint = item as CustomProviderEndpoint;
    const baseURL = trimEnvValue(endpoint.baseURL).replace(/\/+$/, "");
    const models = normalizeModelIds(endpoint.models);
    if (!baseURL || models.length === 0) {
      continue;
    }
    const id = trimEnvValue(endpoint.id) || buildEndpointId(baseURL);
    const name = trimEnvValue(endpoint.name);
    const apiKey = trimEnvValue(endpoint.apiKey);
    const compatibility = normalizeProviderCompatibility(endpoint.compatibility) || inferProviderCompatibility(baseURL);
    endpoints.push({
      id,
      ...(name ? { name } : {}),
      ...(apiKey ? { apiKey } : {}),
      baseURL,
      compatibility,
      models,
    });
  }
  return endpoints;
}

function buildEndpointId(baseURL: string): string {
  try {
    return new URL(baseURL).hostname.replace(/^www\./, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom";
  } catch {
    return "custom";
  }
}

function getCustomProviderEndpoints(customSettings?: ProviderRouteSettings): CustomProviderEndpoint[] {
  const endpoints = normalizeCustomEndpoints(customSettings?.endpoints);
  const legacyModels = normalizeModelIds(customSettings?.models);
  const legacyBaseURL = trimEnvValue(customSettings?.baseURL).replace(/\/+$/, "");
  if (legacyModels.length > 0 && legacyBaseURL) {
    endpoints.push({
      id: "legacy-custom",
      name: "Custom",
      ...(trimEnvValue(customSettings?.apiKey) ? { apiKey: trimEnvValue(customSettings?.apiKey) } : {}),
      baseURL: legacyBaseURL,
      compatibility: normalizeProviderCompatibility(customSettings?.compatibility) || inferProviderCompatibility(legacyBaseURL),
      models: legacyModels,
    });
  }
  return endpoints;
}

function findCustomEndpointForModel(
  modelId: string | undefined,
  customSettings?: ProviderRouteSettings,
): CustomProviderEndpoint | undefined {
  const normalizedModelId = trimEnvValue(modelId);
  if (!normalizedModelId) {
    return undefined;
  }
  return getCustomProviderEndpoints(customSettings).find((endpoint) => endpoint.models.includes(normalizedModelId));
}

function getProviderEnvPrefix(provider: ProviderConfig): string {
  return provider.apiKeyEnv.replace(/_API_KEY$/, "");
}

function getProviderBaseURL(provider: ProviderConfig, env: Record<string, string>): string {
  const prefix = getProviderEnvPrefix(provider);
  return trimEnvValue(env[`${prefix}_BASE_URL`]) || trimEnvValue(env[`${prefix}_BASEURL`]);
}

function getBaseURLOverrides(
  env: Record<string, string>,
  settingsProviders?: Partial<Record<ModelProvider, { apiKey?: string; baseURL?: string }>>,
): Partial<Record<ModelProvider, string>> {
  const overrides: Partial<Record<ModelProvider, string>> = {};
  for (const provider of PROVIDERS) {
    const baseURL = getProviderBaseURL(provider, env);
    if (baseURL) {
      overrides[provider.id] = baseURL;
    }
  }
  for (const [providerId, providerSettings] of Object.entries(settingsProviders ?? {})) {
    const baseURL = trimEnvValue(providerSettings?.baseURL);
    if (baseURL) {
      overrides[providerId as ModelProvider] = baseURL;
    }
  }
  return overrides;
}

function getConfiguredProviders(
  env: Record<string, string>,
  providers: Partial<Record<ModelProvider, ProviderRouteSettings>>,
): ModelProvider[] {
  const configured = new Set<ModelProvider>(detectConfiguredProviders(env));
  for (const [providerId, providerSettings] of Object.entries(providers)) {
    if (
      trimEnvValue(providerSettings?.apiKey) ||
      trimEnvValue(providerSettings?.baseURL) ||
      getCustomProviderEndpoints(providerSettings).length > 0
    ) {
      configured.add(providerId as ModelProvider);
    }
  }
  return Array.from(configured);
}

function isCustomProviderConfigured(
  configuredProviders?: ModelProvider[],
  baseURLOverrides?: Partial<Record<ModelProvider, string>>,
): boolean {
  return Boolean(configuredProviders?.includes("custom") || baseURLOverrides?.custom);
}

function buildCustomModelDef(modelId: string): ModelDef {
  return {
    id: modelId,
    provider: "custom",
    label: modelId,
    capabilities: ["chat"],
    contextWindow: 128_000,
    costPer1MInput: 0,
    costPer1MOutput: 0,
  };
}

function buildCustomModelRoute(
  modelId: string,
  baseURLOverrides?: Partial<Record<ModelProvider, string>>,
): RouteResult | null {
  const provider = getProvider("custom");
  if (!modelId || !provider) {
    return null;
  }
  return {
    modelId,
    provider: "custom",
    baseURL: baseURLOverrides?.custom || provider.defaultBaseURL,
    apiKeyEnv: provider.apiKeyEnv,
    supportsThinking: false,
    modelDef: buildCustomModelDef(modelId),
    reason: `Custom model: ${modelId}`,
  };
}

// ── 任务→所需能力的映射 ────────────────────────────────────────────
const TASK_CAPABILITY: Record<TaskType, string[]> = {
  completion: ["fast", "chat"],
  fim: ["fim", "code"],
  generation: ["reasoning", "code"],
  analysis: ["analysis", "code"],
  review: ["reasoning", "code"],
  chat: ["chat"],
};

// ── 路由函数 ─────────────────────────────────────────────────────

/**
 * 根据任务类型和配置将请求路由到最优模型。
 *
 * @param task - 任务类型
 * @param config - 路由配置（用户设置、已配置Provider等）
 * @returns 路由结果（模型ID、Provider、BaseURL等）
 *
 * @example
 * // 路由补全任务到已配置的最便宜模型
 * const route = routeTask("completion", {
 *   configuredProviders: ["deepseek", "openai"],
 * });
 * // → { modelId: "deepseek-v4-flash", provider: "deepseek", ... }
 *
 * @example
 * // 用户显式指定模型
 * const route = routeTask("generation", {
 *   explicitModel: "qwen-max",
 *   configuredProviders: ["deepseek", "qwen"],
 * });
 * // → { modelId: "qwen-max", provider: "qwen", ... }
 */
export function routeTask(task: TaskType, config: RouterConfig = {}): RouteResult {
  const { explicitModel, routing, configuredProviders, baseURLOverrides } = config;

  // ── 策略1：显式指定模型 ────────────────────────────────────────
  if (explicitModel) {
    const def = getModelDef(explicitModel);
    if (def) {
      const provider = getProvider(def.provider);
      if (provider) {
        return {
          modelId: def.id,
          provider: def.provider,
          baseURL: baseURLOverrides?.[def.provider] || provider.defaultBaseURL,
          apiKeyEnv: provider.apiKeyEnv,
          supportsThinking: provider.supportsThinking,
          modelDef: def,
          reason: `显式指定模型: ${def.id}`,
        };
      }
    }
    // 指定的模型未找到 → 回退到下一条策略
  }

  // ── 策略2：用户配置的路由表 ─────────────────────────────────────
  if (explicitModel && isCustomProviderConfigured(configuredProviders, baseURLOverrides)) {
    const customRoute = buildCustomModelRoute(explicitModel, baseURLOverrides);
    if (customRoute) {
      return customRoute;
    }
  }

  if (routing?.[task]) {
    const modelId = routing[task]!;
    const def = getModelDef(modelId);
    if (def) {
      const provider = getProvider(def.provider);
      if (provider) {
        return {
          modelId: def.id,
          provider: def.provider,
          baseURL: baseURLOverrides?.[def.provider] || provider.defaultBaseURL,
          apiKeyEnv: provider.apiKeyEnv,
          supportsThinking: provider.supportsThinking,
          modelDef: def,
          reason: `路由表配置: ${task} → ${def.id}`,
        };
      }
    }
  }

  // ── 策略3：从已配置的Provider中按能力匹配 ──────────────────────
  if (configuredProviders && configuredProviders.length > 0) {
    const neededCaps = TASK_CAPABILITY[task] || ["chat"];
    const candidates: ModelDef[] = [];

    // 收集所有已配置Provider的模型
    for (const providerId of configuredProviders) {
      const provider = getProvider(providerId);
      if (provider) {
        for (const model of provider.models) {
          // 检查模型是否具备所有必要能力
          const hasAllCaps = neededCaps.every((cap) => model.capabilities.includes(cap as any));
          if (hasAllCaps) {
            candidates.push(model);
          }
        }
      }
    }

    if (candidates.length > 0) {
      // 按输入价格升序排序，选最便宜的
      candidates.sort((a, b) => a.costPer1MInput - b.costPer1MInput);
      const best = candidates[0];
      const provider = getProvider(best.provider)!;
      return {
        modelId: best.id,
        provider: best.provider,
        baseURL: baseURLOverrides?.[best.provider] || provider.defaultBaseURL,
        apiKeyEnv: provider.apiKeyEnv,
        supportsThinking: provider.supportsThinking,
        modelDef: best,
        reason: `能力匹配 + 最便宜: ${best.id} ($${best.costPer1MInput}/M input)`,
      };
    }
  }

  // ── 策略4：回退到 DeepSeek ──────────────────────────────────────
  const fallbackDef = getModelDef("deepseek-v4-flash") || getModelDef("deepseek-chat");
  if (fallbackDef) {
    const provider = getProvider(fallbackDef.provider)!;
    return {
      modelId: fallbackDef.id,
      provider: fallbackDef.provider,
      baseURL: baseURLOverrides?.[fallbackDef.provider] || provider.defaultBaseURL,
      apiKeyEnv: provider.apiKeyEnv,
      supportsThinking: provider.supportsThinking,
      modelDef: fallbackDef,
      reason: `回退到默认: ${fallbackDef.id}（无其他Provider可用）`,
    };
  }

  // 极不可能到达这里（DeepSeek一定有定义）
  throw new Error("No model available for routing — provider-registry may be corrupted");
}

/**
 * 根据环境变量检测已配置的Provider列表。
 * 读取 process.env 中所有 Provider 的 API Key 环境变量，
 * 如果某个 Key 存在且非空，则该 Provider 被视为"已配置"。
 *
 * @param processEnv - 环境变量对象（默认 process.env）
 * @returns 已配置API Key的Provider ID列表
 */
export function detectConfiguredProviders(
  processEnv: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ModelProvider[] {
  const configured: ModelProvider[] = [];
  for (const provider of PROVIDERS) {
    const key = processEnv[provider.apiKeyEnv];
    if (key && key.trim().length > 0 && !key.startsWith("$")) {
      configured.push(provider.id);
    }
  }
  return configured;
}

/**
 * 获取任务的路由说明（用于调试和显示）。
 * 返回所有路由策略的详细解释。
 */
export function resolveProviderRoute(task: TaskType, input: ProviderRouteInput = {}): ProviderRouteResolution {
  const env = mergeRouteEnv(input.env, input.processEnv);
  const providers = normalizeRouteProviders(input.providers);
  const configuredProviders = getConfiguredProviders(env, providers);
  const route = routeTask(task, {
    explicitModel: input.model,
    routing: input.routing,
    configuredProviders,
    baseURLOverrides: getBaseURLOverrides(env, providers),
  });
  const provider = getProvider(route.provider);
  const providerSettings = providers[route.provider];
  const customEndpoint =
    route.provider === "custom" && !isRegisteredModel(route.modelId)
      ? findCustomEndpointForModel(route.modelId, providers.custom)
      : undefined;
  const settingsProviderApiKey = trimEnvValue(customEndpoint?.apiKey) || trimEnvValue(providerSettings?.apiKey);
  const providerEnvKey = provider?.apiKeyEnv;
  const settingsEnvProviderApiKey = providerEnvKey ? trimEnvValue(input.env?.[providerEnvKey]) : "";
  const processProviderApiKey = providerEnvKey ? trimEnvValue(input.processEnv?.[providerEnvKey]) : "";
  const legacyApiKey = trimEnvValue(env.API_KEY) || trimEnvValue(env.HEX4CODE_API_KEY);
  const legacyApiKeyAllowed =
    Boolean(legacyApiKey) &&
    (input.legacyApiKeyProvider === route.provider ||
      (configuredProviders.length <= 1 && configuredProviders[0] === route.provider) ||
      (configuredProviders.length === 0 && route.provider === "deepseek"));
  const apiKey = settingsProviderApiKey || settingsEnvProviderApiKey || processProviderApiKey || (legacyApiKeyAllowed ? legacyApiKey : "");
  const apiKeySource = settingsProviderApiKey
    ? "settings.providers"
    : settingsEnvProviderApiKey
      ? "settings.env.provider"
      : processProviderApiKey
        ? "process.env.provider"
        : legacyApiKeyAllowed
          ? "legacy.apiKey"
          : "missing";

  const settingsProviderBaseURL = trimEnvValue(customEndpoint?.baseURL) || trimEnvValue(providerSettings?.baseURL);
  const providerBaseURL = provider ? getProviderBaseURL(provider, env) : "";
  const legacyBaseURL = trimEnvValue(env.BASE_URL);
  const legacyBaseURLAllowed = Boolean(legacyBaseURL) && input.legacyBaseURLProvider === route.provider;
  const baseURL = settingsProviderBaseURL || providerBaseURL || (legacyBaseURLAllowed ? legacyBaseURL : "") || route.baseURL;
  const baseURLSource = settingsProviderBaseURL
    ? "settings.providers"
    : providerBaseURL
      ? input.env && provider && trimEnvValue(input.env[`${getProviderEnvPrefix(provider)}_BASE_URL`] ?? input.env[`${getProviderEnvPrefix(provider)}_BASEURL`])
        ? "settings.env.provider"
        : "process.env.provider"
      : legacyBaseURLAllowed
        ? "legacy.baseURL"
        : "provider.default";
  const warnings: string[] = [];
  if (legacyApiKey && !legacyApiKeyAllowed && !apiKey) {
    warnings.push(
      `Ignoring legacy API_KEY for provider "${route.provider}" because its ownership is unknown. Configure ${route.apiKeyEnv} or providers.${route.provider}.apiKey.`,
    );
  }

  return {
    ...route,
    baseURL,
    apiKey,
    apiKeySource,
    baseURLSource,
    configuredProviders,
    warnings,
  };
}

export function listConfiguredProviderRuntimeModels(
  task: TaskType,
  input: ProviderRouteInput = {},
): ProviderRuntimeModel[] {
  const routes: ProviderRuntimeModel[] = [];
  const usedProviders = new Set<ModelProvider>();

  for (const provider of PROVIDERS) {
    if (provider.id === "custom" && provider.models.length === 0) {
      const currentModel = trimEnvValue(input.model);
      const endpointModels = getCustomProviderEndpoints(input.providers?.custom).flatMap((endpoint) => endpoint.models);
      const customModels = new Set(
        [
          ...endpointModels,
          ...(input.providers?.custom?.models ?? []),
          ...(currentModel && !isRegisteredModel(currentModel) ? [currentModel] : []),
        ]
          .map((model) => trimEnvValue(model))
          .filter((model) => model && !isRegisteredModel(model)),
      );

      for (const customModel of customModels) {
        const route = resolveProviderRoute(task, { ...input, model: customModel });
        if (route.provider === "custom" && route.apiKey) {
          routes.push({
            providerId: "custom",
            providerName: provider.name,
            modelId: route.modelId,
            label: route.modelDef.label,
            baseURL: route.baseURL,
            apiKey: route.apiKey,
            apiKeySource: route.apiKeySource,
            baseURLSource: route.baseURLSource,
            compatibility: providersCompatibility(
              findCustomEndpointForModel(route.modelId, input.providers?.custom)?.compatibility ??
                input.providers?.custom?.compatibility,
              route.baseURL,
            ),
          });
        }
      }
      continue;
    }

    const model =
      provider.models.find((candidate) => candidate.capabilities.includes("chat" as any)) ?? provider.models[0];
    if (!model) {
      continue;
    }

    const route = resolveProviderRoute(task, {
      ...input,
      model: model.id,
    });
    if (!route.apiKey || usedProviders.has(route.provider)) {
      continue;
    }
    const routedProvider = getProvider(route.provider);
    routes.push({
      providerId: route.provider,
      providerName: routedProvider?.name ?? route.provider,
      modelId: route.modelId,
      label: route.modelDef.label,
      baseURL: route.baseURL,
      apiKey: route.apiKey,
      apiKeySource: route.apiKeySource,
      baseURLSource: route.baseURLSource,
      compatibility: providersCompatibility(input.providers?.[route.provider]?.compatibility, route.baseURL),
    });
    usedProviders.add(route.provider);
  }

  return routes;
}

function providersCompatibility(value: unknown, baseURL: string): ProviderCompatibility {
  return normalizeProviderCompatibility(value) || inferProviderCompatibility(baseURL);
}

export async function fetchOpenAICompatibleModels(
  baseURL: string,
  apiKey: string,
): Promise<{ models: string[]; compatibility: ProviderCompatibility }> {
  const normalizedBaseURL = trimEnvValue(baseURL).replace(/\/+$/, "");
  const normalizedApiKey = trimEnvValue(apiKey);
  if (!normalizedBaseURL) {
    throw new Error("Base URL is required.");
  }
  if (!normalizedApiKey) {
    throw new Error("API key is required.");
  }

  const response = await fetch(`${normalizedBaseURL}/models`, {
    headers: {
      Authorization: `Bearer ${normalizedApiKey}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to fetch models (${response.status}): ${text.slice(0, 200)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Model list response was not valid JSON.");
  }

  const data = (payload as { data?: unknown }).data;
  const models = Array.isArray(data)
    ? data
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
            return (item as { id: string }).id;
          }
          return "";
        })
        .map((id) => id.trim())
        .filter(Boolean)
    : [];

  if (models.length === 0) {
    throw new Error("No models were returned from /models.");
  }

  return {
    models: Array.from(new Set(models)),
    compatibility: inferProviderCompatibility(normalizedBaseURL),
  };
}

export function explainRouting(task: TaskType, config: RouterConfig = {}): string[] {
  const lines: string[] = [];
  lines.push(`任务: ${task}`);

  if (config.explicitModel) {
    lines.push(`  策略1: 显式指定 → ${config.explicitModel}`);
  }
  if (config.routing?.[task]) {
    lines.push(`  策略2: 路由表 → ${config.routing[task]}`);
  }
  if (config.configuredProviders?.length) {
    lines.push(`  策略3: 已配置Provider → ${config.configuredProviders.join(", ")}`);
  }

  const result = routeTask(task, config);
  lines.push(`  → 选中: ${result.modelId} (${result.provider})`);
  lines.push(`  原因: ${result.reason}`);

  return lines;
}

/**
 * 验证一个模型ID是否可用（存在且有对应的Provider）。
 */
export function isModelAvailable(modelId: string): boolean {
  const def = getModelDef(modelId);
  if (!def) return false;
  const provider = getProvider(def.provider);
  return provider !== undefined;
}

/**
 * 构建故障切换链。
 * 返回按优先级排序的模型路由列表（第一个是主选，后续是备选）。
 * 备选模型来自所有已配置的 Provider，按能力匹配并按价格升序排列。
 *
 * @param task - 任务类型
 * @param config - 路由配置
 * @returns 按优先级排序的路由结果列表
 */
export function buildFallbackChain(task: TaskType, config: RouterConfig = {}): RouteResult[] {
  const chain: RouteResult[] = [];

  // 主选：正常路由
  const primary = routeTask(task, config);
  chain.push(primary);
  const usedModelIds = new Set<string>([primary.modelId]);

  // 备选：从其他已配置 Provider 中按能力匹配
  const neededCaps = TASK_CAPABILITY[task] || ["chat"];
  const configuredProviders = config.configuredProviders || detectConfiguredProviders(process.env);

  const candidates: { model: ModelDef; provider: ReturnType<typeof getProvider> }[] = [];

  for (const providerId of configuredProviders) {
    const provider = getProvider(providerId);
    if (!provider) continue;
    for (const model of provider.models) {
      if (usedModelIds.has(model.id)) continue;
      const hasAllCaps = neededCaps.every((cap) => model.capabilities.includes(cap as any));
      if (hasAllCaps) {
        candidates.push({ model, provider });
      }
    }
  }

  // 按价格升序
  candidates.sort((a, b) => a.model.costPer1MInput - b.model.costPer1MInput);

  for (const { model, provider } of candidates) {
    if (usedModelIds.has(model.id)) continue;
    usedModelIds.add(model.id);
    chain.push({
      modelId: model.id,
      provider: model.provider,
      baseURL: config.baseURLOverrides?.[model.provider] || provider!.defaultBaseURL,
      apiKeyEnv: provider!.apiKeyEnv,
      supportsThinking: provider!.supportsThinking,
      modelDef: model,
      reason: `故障切换备选 #${chain.length}: ${model.id} ($${model.costPer1MInput}/M input)`,
    });
  }

  // 如果主选不是 fallback 且链太短，把 fallback 也加上
  if (primary.modelId !== "deepseek-v4-flash" && primary.modelId !== "deepseek-chat") {
    const fallbackDef = getModelDef("deepseek-v4-flash") || getModelDef("deepseek-chat");
    if (fallbackDef && !usedModelIds.has(fallbackDef.id)) {
      const fallbackProvider = getProvider(fallbackDef.provider)!;
      chain.push({
        modelId: fallbackDef.id,
        provider: fallbackDef.provider,
        baseURL: config.baseURLOverrides?.[fallbackDef.provider] || fallbackProvider.defaultBaseURL,
        apiKeyEnv: fallbackProvider.apiKeyEnv,
        supportsThinking: fallbackProvider.supportsThinking,
        modelDef: fallbackDef,
        reason: `最终回退: ${fallbackDef.id}`,
      });
    }
  }

  return chain;
}

/**
 * 测试 Provider 连接有效性。
 * 发送一条最小 API 请求验证 API Key 和网络连通性。
 *
 * @param modelId - 要测试的模型 ID
 * @param apiKey - API Key
 * @param baseURL - 可选的 Base URL 覆盖
 * @returns 成功返回 { ok: true, latencyMs: number }，失败返回 { ok: false, error: string }
 */
export async function testProviderConnection(
  modelId: string,
  apiKey: string,
  baseURL?: string,
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  if (!apiKey) {
    return { ok: false, error: "API Key is empty" };
  }

  const modelDef = getModelDef(modelId);
  if (!modelDef) {
    if (!baseURL) {
      return { ok: false, error: `Unknown model: ${modelId}` };
    }
  }

  const provider = modelDef ? getProvider(modelDef.provider) : getProvider("custom");
  if (!provider) {
    return { ok: false, error: `Unknown provider for model: ${modelId}` };
  }

  const resolvedBaseURL = baseURL || provider.defaultBaseURL;
  const startTime = Date.now();

  try {
    // 使用 import() 动态加载，避免顶层依赖 OpenAI SDK
    const { createClient } = await import("./provider-client");
    const client = createClient({ modelId, apiKey, baseURL: resolvedBaseURL });

    if (!client) {
      return { ok: false, error: "Failed to create client" };
    }

    // 尝试发送最小请求验证
    if ("chat" in client) {
      const response = await (client as any).chat.completions.create({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      });
      const latencyMs = Date.now() - startTime;
      if (response?.choices?.[0]) {
        return { ok: true, latencyMs };
      }
      return { ok: false, error: "Empty response from API" };
    }

    // Gemini 等非 OpenAI 兼容 API
    return { ok: false, error: "Provider not supported for connection test" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // 过滤敏感信息
    const sanitized = message.replace(apiKey, "***");
    return { ok: false, error: sanitized };
  }
}

/**
 * 获取模型的上下文窗口大小。
 */
export function getContextWindow(modelId: string): number {
  const def = getModelDef(modelId);
  return def?.contextWindow ?? 32000; // 默认 32K
}

/**
 * 计算一次 LLM 调用的成本（美元）。
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): { inputCost: number; outputCost: number; totalCost: number } {
  const def = getModelDef(modelId);
  if (!def) {
    return { inputCost: 0, outputCost: 0, totalCost: 0 };
  }
  const inputCost = (inputTokens / 1_000_000) * def.costPer1MInput;
  const outputCost = (outputTokens / 1_000_000) * def.costPer1MOutput;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}

/**
 * 智能模型推荐 — 根据任务类型、已配置Provider和用户偏好给出推荐排名。
 *
 * @param task - 任务类型
 * @param configuredProviders - 已配置API Key的Provider列表
 * @param preference - 偏好："cheapest" | "fastest" | "best" | "balanced"
 * @returns 推荐列表（含推荐理由）
 */
export function getSmartRecommendation(
  task: TaskType,
  configuredProviders: ModelProvider[],
  preference: "cheapest" | "fastest" | "best" | "balanced" = "balanced",
): Array<{
  modelId: string;
  label: string;
  provider: string;
  reason: string;
  costPer1MInput: number;
  contextWindow: number;
}> {
  const neededCaps = TASK_CAPABILITY[task] || ["chat"];

  // 收集所有候选模型
  const candidates: Array<{ model: ModelDef; provider: ProviderConfig }> = [];
  for (const providerId of configuredProviders) {
    const provider = getProvider(providerId);
    if (!provider) continue;
    for (const model of provider.models) {
      const hasAllCaps = neededCaps.every((cap) => model.capabilities.includes(cap as any));
      if (hasAllCaps) candidates.push({ model, provider });
    }
  }

  if (candidates.length === 0) {
    // 回退：从所有Provider中推荐
    for (const provider of PROVIDERS) {
      for (const model of provider.models) {
        const hasAllCaps = neededCaps.every((cap) => model.capabilities.includes(cap as any));
        if (hasAllCaps) candidates.push({ model, provider });
      }
    }
  }

  // 按偏好排序
  switch (preference) {
    case "cheapest":
      candidates.sort((a, b) => a.model.costPer1MInput - b.model.costPer1MInput);
      break;
    case "fastest":
      candidates.sort(
        (a, b) => a.model.costPer1MInput + a.model.costPer1MOutput - (b.model.costPer1MInput + b.model.costPer1MOutput),
      );
      break;
    case "best":
      candidates.sort((a, b) => b.model.costPer1MInput - a.model.costPer1MInput);
      break;
    case "balanced":
    default:
      // balanced: 按性价比排序 (能力/价格)
      candidates.sort((a, b) => a.model.costPer1MInput - b.model.costPer1MInput);
      break;
  }

  return candidates.slice(0, 5).map((c) => ({
    modelId: c.model.id,
    label: c.model.label,
    provider: c.provider.name,
    reason: generateRecommendationReason(c.model, c.provider, task, preference, configuredProviders),
    costPer1MInput: c.model.costPer1MInput,
    contextWindow: c.model.contextWindow,
  }));
}

/** 根据偏好和模型数据生成推荐原因 */
function generateRecommendationReason(
  model: ModelDef,
  _provider: ProviderConfig,
  _task: TaskType,
  preference: string,
  configured: ModelProvider[],
): string {
  const priceStr = `$${model.costPer1MInput}/${model.costPer1MOutput}/M`;
  const ctxStr = `${Math.round(model.contextWindow / 1000)}K ctx`;
  const capsStr = model.capabilities.join(", ");

  if (preference === "cheapest" && configured.includes(model.provider)) {
    return `${model.label} — 已配置 · 最便宜 (${priceStr}) · ${ctxStr}`;
  }
  if (preference === "best") {
    return `${model.label} — 最强推理能力 · ${ctxStr} · ${priceStr}`;
  }
  if (preference === "fastest") {
    return `${model.label} — 低延迟 (${priceStr}) · ${capsStr}`;
  }
  return `${model.label} — 均衡性价比 · ${ctxStr} · ${priceStr}`;
}

/**
 * 获取模型上下文使用率。
 * 返回当前活跃token占上下文窗口的百分比，以及建议。
 */
export function getContextUsageInfo(
  modelId: string,
  activeTokens: number,
): { usageRatio: number; status: "ok" | "warning" | "critical"; suggestion: string } {
  const windowSize = getContextWindow(modelId);
  const usageRatio = activeTokens / windowSize;

  if (usageRatio > 0.95) {
    return {
      usageRatio,
      status: "critical",
      suggestion: `上下文即将耗尽 (${(usageRatio * 100).toFixed(0)}%)，建议切换到更大窗口的模型或压缩对话`,
    };
  }
  if (usageRatio > 0.8) {
    return {
      usageRatio,
      status: "warning",
      suggestion: `上下文使用率较高 (${(usageRatio * 100).toFixed(0)}%)，建议压缩或准备切换模型`,
    };
  }
  return {
    usageRatio,
    status: "ok",
    suggestion: `上下文充足 (${(usageRatio * 100).toFixed(0)}%)`,
  };
}

/**
 * 检测新配置的 Provider（与上次检测结果对比）。
 */
export function detectNewProviders(
  previousConfigured: ModelProvider[],
  currentConfigured: ModelProvider[],
): ModelProvider[] {
  return currentConfigured.filter((p) => !previousConfigured.includes(p));
}

/**
 * 获取未配置但可用的 Provider 列表（用户有 env var 但值为空）。
 */
export function getUnconfiguredProviders(): Array<{ id: ModelProvider; name: string; apiKeyEnv: string }> {
  const result: Array<{ id: ModelProvider; name: string; apiKeyEnv: string }> = [];
  for (const provider of PROVIDERS) {
    const key = process.env[provider.apiKeyEnv];
    if (!key || key.trim().length === 0 || key.startsWith("$")) {
      result.push({ id: provider.id, name: provider.name, apiKeyEnv: provider.apiKeyEnv });
    }
  }
  return result;
}

// ── 增强推荐评分 ──────────────────────────────────────────────────

export interface ScoredRecommendation {
  modelId: string;
  label: string;
  provider: string;
  reason: string;
  costPer1MInput: number;
  contextWindow: number;
  score: number;
}

/**
 * 加权评分推荐 — 比 getSmartRecommendation 更精细。
 * 权重: costWeight(40%) + capWeight(30%) + ctxWeight(20%) + speedWeight(10%)
 */
export function getWeightedRecommendation(
  task: TaskType,
  configuredProviders: ModelProvider[],
  weights?: { cost?: number; capability?: number; context?: number; speed?: number },
): ScoredRecommendation[] {
  const w = { cost: 0.4, capability: 0.3, context: 0.2, speed: 0.1, ...weights };
  const neededCaps = TASK_CAPABILITY[task] || ["chat"];
  const candidates: Array<{ model: ModelDef; provider: ProviderConfig }> = [];

  for (const providerId of configuredProviders) {
    const provider = getProvider(providerId);
    if (!provider) continue;
    for (const model of provider.models) {
      if (neededCaps.every((cap) => model.capabilities.includes(cap as any))) {
        candidates.push({ model, provider });
      }
    }
  }

  // 回退到所有 Provider
  if (candidates.length === 0) {
    for (const provider of PROVIDERS) {
      for (const model of provider.models) {
        if (neededCaps.every((cap) => model.capabilities.includes(cap as any))) {
          candidates.push({ model, provider });
        }
      }
    }
  }

  if (candidates.length === 0) return [];

  // 计算各维度的最大/最小值用于归一化
  const maxCost = Math.max(...candidates.map((c) => c.model.costPer1MInput || 0.01));
  const maxCtx = Math.max(...candidates.map((c) => c.model.contextWindow || 1000));
  const maxCap = neededCaps.length; // 满分是需要的cap数量

  const scored = candidates.map((c) => {
    // 成本得分：越便宜越高（逆归一化）
    const costScore = 1 - (c.model.costPer1MInput || 0.01) / maxCost;
    // 上下文得分：越大越好
    const ctxScore = (c.model.contextWindow || 1000) / maxCtx;
    // 能力得分：匹配的能力越多越好
    const matchedCaps = neededCaps.filter((cap) => c.model.capabilities.includes(cap as any)).length;
    const capScore = matchedCaps / maxCap;
    // 速度得分（用成本作为代理：低成本通常更快）
    const speedScore = 1 - (c.model.costPer1MInput + c.model.costPer1MOutput) / (maxCost + maxCost);

    const totalScore = costScore * w.cost + capScore * w.capability + ctxScore * w.context + speedScore * w.speed;

    return {
      modelId: c.model.id,
      label: c.model.label,
      provider: c.provider.name,
      reason: `${c.model.label} (score: ${(totalScore * 100).toFixed(1)}) — $${c.model.costPer1MInput}/${c.model.costPer1MOutput}/M · ${Math.round(c.model.contextWindow / 1000)}K ctx`,
      costPer1MInput: c.model.costPer1MInput,
      contextWindow: c.model.contextWindow,
      score: Math.round(totalScore * 1000) / 1000,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}

// ── 多模型并行投票 ────────────────────────────────────────────────

export interface VoteResult {
  /** 投票任务 ID */
  taskId: string;
  /** 输入 prompt */
  prompt: string;
  /** 各个模型的独立响应 */
  responses: Array<{
    modelId: string;
    label: string;
    provider: string;
    response: string;
    latencyMs: number;
    error?: string;
  }>;
  /** 投票策略 */
  strategy: "majority" | "consensus" | "fastest";
  /** 汇总结果（多数投票时取最长的响应，共识时取最一致的） */
  summary: string;
  /** 投票是否成功 */
  success: boolean;
}

/**
 * 多模型并行投票 — 将同一个 prompt 发给多个不同 Provider 的模型，
 * 并行获取结果后按策略合并。
 *
 * @param prompt - 输入文本
 * @param configuredProviders - 已配置的 Provider ID 列表
 * @param options - 可选参数（strategy, modelCount, signal）
 * @returns VoteResult
 */
export async function parallelVote(
  prompt: string,
  configuredProviders: ModelProvider[],
  options?: {
    strategy?: "majority" | "consensus" | "fastest";
    modelCount?: number;
    signal?: AbortSignal;
    runtimeModels?: ProviderRuntimeModel[];
  },
): Promise<VoteResult> {
  const { strategy = "majority", modelCount = 3, signal } = options || {};
  const taskId = `vote_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // 选择模型：从不同的 Provider 各取一个 chat 模型
  const selectedModels: Array<{
    modelId: string;
    label: string;
    provider: string;
    baseURL: string;
    apiKeyEnv: string;
    apiKey?: string;
  }> = (options?.runtimeModels ?? []).slice(0, modelCount).map((runtime) => ({
    modelId: runtime.modelId,
    label: runtime.label,
    provider: runtime.providerName,
    baseURL: runtime.baseURL,
    apiKeyEnv: "",
    apiKey: runtime.apiKey,
  }));
  const usedProviders = new Set<string>();

  for (const runtime of options?.runtimeModels ?? []) {
    usedProviders.add(runtime.providerId);
  }

  for (const providerId of configuredProviders) {
    if (selectedModels.length >= modelCount) break;
    if (usedProviders.has(providerId)) continue;
    usedProviders.add(providerId);
    const provider = getProvider(providerId);
    if (!provider) continue;
    // 取 provider 的第一个 chat 模型
    const chatModel = provider.models.find((m) => m.capabilities.includes("chat" as any));
    if (!chatModel) continue;
    const key = process.env[provider.apiKeyEnv];
    if (!key) continue;
    selectedModels.push({
      modelId: chatModel.id,
      label: chatModel.label,
      provider: provider.name,
      baseURL: provider.defaultBaseURL,
      apiKeyEnv: provider.apiKeyEnv,
    });
  }

  // 如果不够模型，从所有 Provider 补充
  if (selectedModels.length < 2) {
    for (const provider of PROVIDERS) {
      if (selectedModels.length >= modelCount) break;
      if (usedProviders.has(provider.id)) continue;
      const chatModel = provider.models.find((m) => m.capabilities.includes("chat" as any));
      if (!chatModel) continue;
      selectedModels.push({
        modelId: chatModel.id,
        label: chatModel.label,
        provider: provider.name,
        baseURL: provider.defaultBaseURL,
        apiKeyEnv: provider.apiKeyEnv,
        // 未配置时标注
      });
    }
  }

  // 并行调用
  const results = await Promise.allSettled(
    selectedModels.map(async (m) => {
      const start = Date.now();
      try {
        const apiKey = m.apiKey || process.env[m.apiKeyEnv] || "";
        if (!apiKey) {
          return {
            modelId: m.modelId,
            label: m.label,
            provider: m.provider,
            response: "",
            latencyMs: 0,
            error: "No API key configured",
          };
        }
        const { createClient } = require("./provider-client");
        const client = createClient({ modelId: m.modelId, apiKey, baseURL: m.baseURL });
        const completion = await client.chat.completions.create(
          {
            model: m.modelId,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 1024,
            temperature: 0.3,
          },
          { signal },
        );
        const text = completion.choices?.[0]?.message?.content || "";
        return {
          modelId: m.modelId,
          label: m.label,
          provider: m.provider,
          response: text,
          latencyMs: Date.now() - start,
          error: undefined,
        };
      } catch (err: unknown) {
        return {
          modelId: m.modelId,
          label: m.label,
          provider: m.provider,
          response: "",
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const responses = results.map((r) => {
    if (r.status === "fulfilled") return r.value;
    return {
      modelId: "unknown",
      label: "error",
      provider: "?",
      response: "",
      latencyMs: 0,
      error: r.reason?.toString() || "Unknown error",
    };
  });

  // 根据策略合并
  const successfulResponses = responses.filter((r) => !r.error && r.response.length > 0);
  let summary = "";

  if (strategy === "fastest") {
    // 取最快的成功响应
    const fastest = successfulResponses.sort((a, b) => a.latencyMs - b.latencyMs)[0];
    summary = fastest?.response || "All models failed";
  } else if (strategy === "consensus") {
    // 共识：选平均长度的
    if (successfulResponses.length > 0) {
      const avgLen = successfulResponses.reduce((s, r) => s + r.response.length, 0) / successfulResponses.length;
      const closest = successfulResponses.reduce((best, r) =>
        Math.abs(r.response.length - avgLen) < Math.abs(best.response.length - avgLen) ? r : best,
      );
      summary = closest.response;
    } else {
      summary = "All models failed";
    }
  } else {
    // majority：选最长的（多数投票的近似）
    if (successfulResponses.length > 0) {
      summary = successfulResponses.sort((a, b) => b.response.length - a.response.length)[0].response;
    } else {
      summary = "All models failed";
    }
  }

  return {
    taskId,
    prompt,
    responses,
    strategy,
    summary,
    success: successfulResponses.length > 0,
  };
}

// ── 语义缓存集成 ──────────────────────────────────────────────────

/**
 * 带语义缓存的 LLM 调用。
 * 先查缓存，命中直接返回；未命中调用 LLM 并写入缓存。
 */
export async function callWithCache(
  prompt: string,
  modelId: string,
  llmCall: () => Promise<string>,
  options?: { ttl?: number },
): Promise<{ text: string; fromCache: boolean }> {
  try {
    const { getGlobalCache } = require("../cache/semantic-cache");
    const cache = getGlobalCache();
    const cached = cache.findWithStats(prompt, modelId);
    if (cached.hit) {
      return { text: cached.entry.response, fromCache: true };
    }
    const text = await llmCall();
    if (text && text.length > 10) {
      cache.set(prompt, text, modelId, options?.ttl);
    }
    return { text, fromCache: false };
  } catch {
    // 缓存失败不阻塞 LLM 调用
    const text = await llmCall();
    return { text, fromCache: false };
  }
}

// ── 模型基准测试 ─────────────────────────────────────────────────

export interface BenchmarkResult {
  taskId: string;
  prompt: string;
  results: Array<{
    modelId: string;
    label: string;
    provider: string;
    response: string;
    latencyMs: number;
    responseLength: number;
    cost: number;
    error?: string;
  }>;
  fastest: string;
  cheapest: string;
  longest: string;
}

/** 在多模型上运行基准测试 */
export async function benchmarkModels(
  prompt: string,
  configuredProviders: ModelProvider[],
  options?: { modelCount?: number; signal?: AbortSignal; runtimeModels?: ProviderRuntimeModel[] },
): Promise<BenchmarkResult> {
  const modelCount = options?.modelCount || 3;
  const taskId = `bench_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const selected: Array<{
    modelId: string;
    label: string;
    provider: string;
    baseURL: string;
    apiKeyEnv: string;
    apiKey?: string;
  }> = (options?.runtimeModels ?? []).slice(0, modelCount).map((runtime) => ({
    modelId: runtime.modelId,
    label: runtime.label,
    provider: runtime.providerName,
    baseURL: runtime.baseURL,
    apiKeyEnv: "",
    apiKey: runtime.apiKey,
  }));
  const used = new Set<string>();
  for (const runtime of options?.runtimeModels ?? []) {
    used.add(runtime.providerId);
  }

  for (const pid of configuredProviders) {
    if (selected.length >= modelCount) break;
    if (used.has(pid)) continue;
    used.add(pid);
    const p = getProvider(pid);
    if (!p) continue;
    const m = p.models.find((m) => m.capabilities.includes("chat" as any));
    if (!m || !process.env[p.apiKeyEnv]) continue;
    selected.push({
      modelId: m.id,
      label: m.label,
      provider: p.name,
      baseURL: p.defaultBaseURL,
      apiKeyEnv: p.apiKeyEnv,
    });
  }

  const results = await Promise.allSettled(
    selected.map(async (m) => {
      const start = Date.now();
      try {
        const apiKey = m.apiKey || process.env[m.apiKeyEnv] || "";
        const { createClient } = require("./provider-client");
        const client = createClient({ modelId: m.modelId, apiKey, baseURL: m.baseURL });
        const completion = await client.chat.completions.create(
          {
            model: m.modelId,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 256,
            temperature: 0.3,
          },
          { signal: options?.signal },
        );
        const text = completion.choices?.[0]?.message?.content || "";
        const cost = calculateCost(m.modelId, prompt.length / 4, text.length / 4).totalCost;
        return {
          modelId: m.modelId,
          label: m.label,
          provider: m.provider,
          response: text,
          latencyMs: Date.now() - start,
          responseLength: text.length,
          cost,
          error: undefined,
        };
      } catch (err: unknown) {
        return {
          modelId: m.modelId,
          label: m.label,
          provider: m.provider,
          response: "",
          latencyMs: Date.now() - start,
          responseLength: 0,
          cost: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const flat = results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : {
          modelId: "error",
          label: "Error",
          provider: "?",
          response: "",
          latencyMs: 0,
          responseLength: 0,
          cost: 0,
          error: String(r.reason),
        },
  );
  const ok = flat.filter((r) => !r.error);

  return {
    taskId,
    prompt,
    results: flat,
    fastest: ok.sort((a, b) => a.latencyMs - b.latencyMs)[0]?.modelId || "N/A",
    cheapest: ok.sort((a, b) => a.cost - b.cost)[0]?.modelId || "N/A",
    longest: ok.sort((a, b) => b.responseLength - a.responseLength)[0]?.modelId || "N/A",
  };
}

// ── 配额管理 ────────────────────────────────────────────────────

export interface QuotaConfig {
  /** 每月 Token 上限 (0 = 不限) */
  monthlyTokenLimit: number;
  /** 每月成本上限 (美元, 0 = 不限) */
  monthlyCostLimit: number;
  /** 当前月已用 Token */
  currentTokens: number;
  /** 当前月已用成本 */
  currentCost: number;
  /** 配额周期起始时间戳 */
  periodStart: number;
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  usagePercent: number;
  quota: QuotaConfig;
}

const QUOTA_PATH = (() => {
  try {
    return require("path").join(require("os").homedir(), ".hex4code", "quota.json");
  } catch {
    return "";
  }
})();

let _quotaCache: QuotaConfig | null = null;

/** 加载或创建配额配置 */
export function loadQuota(): QuotaConfig {
  if (_quotaCache) return _quotaCache;
  const defaultQuota: QuotaConfig = {
    monthlyTokenLimit: 0,
    monthlyCostLimit: 0,
    currentTokens: 0,
    currentCost: 0,
    periodStart: Date.now(),
  };
  if (!QUOTA_PATH) {
    _quotaCache = defaultQuota;
    return defaultQuota;
  }
  try {
    const fs = require("fs");
    if (fs.existsSync(QUOTA_PATH)) {
      const raw = fs.readFileSync(QUOTA_PATH, "utf8");
      const data = JSON.parse(raw);
      // 检查是否跨月
      const now = Date.now();
      const oneMonth = 30 * 24 * 3600 * 1000;
      if (now - data.periodStart > oneMonth) {
        data.currentTokens = 0;
        data.currentCost = 0;
        data.periodStart = now;
      }
      _quotaCache = { ...defaultQuota, ...data };
      return _quotaCache!;
    }
  } catch {
    /* ignore */
  }
  _quotaCache = defaultQuota;
  return defaultQuota;
}

/** 保存配额配置 */
export function saveQuota(quota: QuotaConfig): void {
  _quotaCache = quota;
  if (!QUOTA_PATH) return;
  try {
    const fs = require("fs");
    const dir = require("path").dirname(QUOTA_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(QUOTA_PATH, JSON.stringify(quota, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

/** 设置配额限制 */
export function setQuotaLimit(tokenLimit: number, costLimit: number): QuotaConfig {
  const q = loadQuota();
  q.monthlyTokenLimit = tokenLimit;
  q.monthlyCostLimit = costLimit;
  saveQuota(q);
  return q;
}

/** 检查配额是否允许继续 */
export function checkQuota(tokens: number = 0, cost: number = 0): QuotaCheckResult {
  const q = loadQuota();
  const wouldExceedTokens = q.monthlyTokenLimit > 0 && q.currentTokens + tokens > q.monthlyTokenLimit;
  const wouldExceedCost = q.monthlyCostLimit > 0 && q.currentCost + cost > q.monthlyCostLimit;
  const maxUsage = Math.max(
    q.monthlyTokenLimit > 0 ? (q.currentTokens / q.monthlyTokenLimit) * 100 : 0,
    q.monthlyCostLimit > 0 ? (q.currentCost / q.monthlyCostLimit) * 100 : 0,
  );
  if (wouldExceedTokens)
    return {
      allowed: false,
      reason: `Monthly token limit (${q.monthlyTokenLimit.toLocaleString()}) exceeded`,
      usagePercent: maxUsage,
      quota: q,
    };
  if (wouldExceedCost)
    return {
      allowed: false,
      reason: `Monthly cost limit ($${q.monthlyCostLimit.toFixed(2)}) exceeded`,
      usagePercent: maxUsage,
      quota: q,
    };
  return { allowed: true, usagePercent: maxUsage, quota: q };
}

/** 记录用量 */
export function recordUsage(tokens: number, cost: number): QuotaConfig {
  const q = loadQuota();
  q.currentTokens += tokens;
  q.currentCost += cost;
  saveQuota(q);
  return q;
}

// ── 路由历史学习 ────────────────────────────────────────────────

export interface RouteRecord {
  timestamp: number;
  taskType: TaskType;
  promptLength: number;
  selectedModel: string;
  success: boolean;
  latencyMs: number;
  cost: number;
  responseLength: number;
  errorType?: string;
}

const ROUTE_HISTORY_PATH = (() => {
  try {
    return require("path").join(require("os").homedir(), ".hex4code", "route-history.json");
  } catch {
    return "";
  }
})();

let _routeHistory: RouteRecord[] = [];
const MAX_HISTORY = 500;

/** 加载路由历史 */
export function loadRouteHistory(): RouteRecord[] {
  if (_routeHistory.length > 0) return _routeHistory;
  if (!ROUTE_HISTORY_PATH) return [];
  try {
    const fs = require("fs");
    if (fs.existsSync(ROUTE_HISTORY_PATH)) {
      const raw = fs.readFileSync(ROUTE_HISTORY_PATH, "utf8");
      _routeHistory = JSON.parse(raw);
    }
  } catch {
    /* ignore */
  }
  return _routeHistory;
}

/** 保存路由历史 */
function saveRouteHistory(): void {
  if (!ROUTE_HISTORY_PATH) return;
  try {
    const fs = require("fs");
    const dir = require("path").dirname(ROUTE_HISTORY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ROUTE_HISTORY_PATH, JSON.stringify(_routeHistory.slice(-MAX_HISTORY)), "utf8");
  } catch {
    /* ignore */
  }
}

/** 记录一次路由决策结果 */
export function recordRouteDecision(record: RouteRecord): void {
  loadRouteHistory();
  _routeHistory.push(record);
  if (_routeHistory.length > MAX_HISTORY * 2) {
    _routeHistory = _routeHistory.slice(-MAX_HISTORY);
  }
  saveRouteHistory();
}

/** 获取路由洞察 — 每个任务类型下的最优模型 */
export function getRouteInsights(): Array<{
  taskType: TaskType;
  totalCalls: number;
  successRate: number;
  avgLatency: number;
  avgCost: number;
  bestModel: string;
  modelRankings: Array<{ model: string; calls: number; successRate: number; avgLatency: number }>;
}> {
  const history = loadRouteHistory();
  if (history.length === 0) return [];

  const byTask = new Map<TaskType, RouteRecord[]>();
  for (const r of history) {
    if (!byTask.has(r.taskType)) byTask.set(r.taskType, []);
    byTask.get(r.taskType)!.push(r);
  }

  const insights: Array<{
    taskType: TaskType;
    totalCalls: number;
    successRate: number;
    avgLatency: number;
    avgCost: number;
    bestModel: string;
    modelRankings: Array<{ model: string; calls: number; successRate: number; avgLatency: number }>;
  }> = [];

  for (const [taskType, records] of byTask) {
    const byModel = new Map<string, RouteRecord[]>();
    for (const r of records) {
      if (!byModel.has(r.selectedModel)) byModel.set(r.selectedModel, []);
      byModel.get(r.selectedModel)!.push(r);
    }

    const totalCalls = records.length;
    const totalSuccess = records.filter((r) => r.success).length;
    const avgLatency = records.reduce((s, r) => s + r.latencyMs, 0) / totalCalls;
    const avgCost = records.reduce((s, r) => s + r.cost, 0) / totalCalls;

    const modelRankings = [...byModel.entries()]
      .map(([model, recs]) => ({
        model,
        calls: recs.length,
        successRate: recs.filter((r) => r.success).length / recs.length,
        avgLatency: recs.reduce((s, r) => s + r.latencyMs, 0) / recs.length,
      }))
      .sort((a, b) => b.successRate - a.successRate || a.avgLatency - b.avgLatency);

    insights.push({
      taskType,
      totalCalls,
      successRate: totalSuccess / totalCalls,
      avgLatency,
      avgCost,
      bestModel: modelRankings[0]?.model || "N/A",
      modelRankings,
    });
  }

  return insights.sort((a, b) => b.totalCalls - a.totalCalls);
}

/** 获取推荐权重调整建议（基于历史数据） */
export function getSuggestedWeights(
  taskType: TaskType,
): { cost: number; capability: number; context: number; speed: number } | null {
  const insights = getRouteInsights().filter((i) => i.taskType === taskType);
  if (insights.length === 0 || insights[0].totalCalls < 5) return null;

  const i = insights[0];
  // 如果成功率高且延迟低，降低速度权重；如果延迟高，提升速度权重
  const speedWeight = i.avgLatency > 5000 ? 0.3 : i.avgLatency > 2000 ? 0.2 : 0.1;
  const costWeight = i.avgCost > 0.01 ? 0.5 : 0.3;

  return { cost: costWeight, capability: 0.3, context: 0.2, speed: speedWeight };
}
