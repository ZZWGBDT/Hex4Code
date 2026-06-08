import { defaultsToThinkingMode } from "./common/model-capabilities";
import type { ModelProvider } from "./models/provider-registry";

export type Hex4codeEnv = Record<string, string | undefined> & {
  MODEL?: string;
  BASE_URL?: string;
  API_KEY?: string;
  THINKING_ENABLED?: string;
  REASONING_EFFORT?: string;
  DEBUG_LOG_ENABLED?: string;
};

export type ReasoningEffort = "high" | "max";
export type ProviderCompatibility = "openai-compatible" | "minimax" | "ollama";

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type ProviderSettings = {
  apiKey?: string;
  baseURL?: string;
  compatibility?: ProviderCompatibility;
  models?: string[];
  endpoints?: Array<{
    id: string;
    name?: string;
    apiKey?: string;
    baseURL: string;
    compatibility?: ProviderCompatibility;
    models: string[];
  }>;
};

export type Hex4codeSettings = {
  env?: Hex4codeEnv;
  apiKey?: string;
  providers?: Partial<Record<ModelProvider, ProviderSettings>>;
  legacyApiKeyProvider?: ModelProvider;
  legacyBaseURLProvider?: ModelProvider;
  model?: string;
  taskModels?: Record<string, string>;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  debugLogEnabled?: boolean;
  notify?: string;
  webSearchTool?: string;
  mcpServers?: Record<string, McpServerConfig>;
};

export type ResolvedHex4codeSettings = {
  env: Record<string, string>;
  apiKey?: string;
  baseURL: string;
  providers?: Partial<Record<ModelProvider, ProviderSettings>>;
  legacyApiKeyProvider?: ModelProvider;
  legacyBaseURLProvider?: ModelProvider;
  model: string;
  taskModels?: Record<string, string>;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  debugLogEnabled: boolean;
  notify?: string;
  webSearchTool?: string;
  mcpServers?: Record<string, McpServerConfig>;
};

export type ModelConfigSelection = {
  model: string;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
};

export type SettingsProcessEnv = Record<string, string | undefined>;

function resolveReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return value === "high" || value === "max" ? value : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "enabled", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "disabled", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEnv(env: Hex4codeSettings["env"]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!env) {
    return result;
  }

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

function normalizeProviders(settings?: Hex4codeSettings | null): Partial<Record<ModelProvider, ProviderSettings>> {
  const result: Partial<Record<ModelProvider, ProviderSettings>> = {};
  const providers = settings?.providers;
  if (!providers || typeof providers !== "object") {
    return result;
  }

  for (const [providerId, providerSettings] of Object.entries(providers)) {
    if (!providerSettings || typeof providerSettings !== "object") {
      continue;
    }
    const apiKey = trimString((providerSettings as ProviderSettings).apiKey);
    const baseURL = trimString((providerSettings as ProviderSettings).baseURL);
    const compatibility = normalizeProviderCompatibility((providerSettings as ProviderSettings).compatibility);
    const models = Array.isArray((providerSettings as ProviderSettings).models)
      ? Array.from(
          new Set(
            (providerSettings as ProviderSettings).models
              ?.map((model) => trimString(model))
              .filter(Boolean),
          ),
        )
      : [];
    const endpoints = normalizeCustomEndpoints((providerSettings as ProviderSettings).endpoints);
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

function normalizeCustomEndpoints(value: unknown): NonNullable<ProviderSettings["endpoints"]> {
  if (!Array.isArray(value)) {
    return [];
  }
  const endpoints: NonNullable<ProviderSettings["endpoints"]> = [];
  const usedIds = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const endpoint = item as NonNullable<ProviderSettings["endpoints"]>[number];
    const baseURL = trimString(endpoint.baseURL);
    const models = Array.isArray(endpoint.models)
      ? Array.from(new Set(endpoint.models.map((model) => trimString(model)).filter(Boolean)))
      : [];
    if (!baseURL || models.length === 0) {
      continue;
    }
    const idBase = trimString(endpoint.id) || buildEndpointId(baseURL);
    let id = idBase;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${idBase}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    const apiKey = trimString(endpoint.apiKey);
    const name = trimString(endpoint.name);
    const compatibility = normalizeProviderCompatibility(endpoint.compatibility);
    endpoints.push({
      id,
      ...(name ? { name } : {}),
      ...(apiKey ? { apiKey } : {}),
      baseURL,
      ...(compatibility ? { compatibility } : {}),
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

export function collectHex4codeEnv(processEnv: SettingsProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (!key.startsWith("HEX4CODE_") || typeof value !== "string") {
      continue;
    }
    const strippedKey = key.slice("HEX4CODE_".length);
    if (strippedKey) {
      result[strippedKey] = value;
    }
  }
  return result;
}

function extractMcpEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("MCP_")) {
      continue;
    }
    const strippedKey = key.slice("MCP_".length);
    if (strippedKey) {
      result[strippedKey] = value;
    }
  }
  return result;
}

function mergeMcpServers(
  userSettings: Hex4codeSettings | null | undefined,
  projectSettings: Hex4codeSettings | null | undefined,
  userEnv: Record<string, string>,
  projectEnv: Record<string, string>,
  systemEnv: Record<string, string>,
): Record<string, McpServerConfig> | undefined {
  const userServers = userSettings?.mcpServers ?? {};
  const projectServers = projectSettings?.mcpServers ?? {};
  const serverNames = new Set([...Object.keys(userServers), ...Object.keys(projectServers)]);
  if (serverNames.size === 0) {
    return undefined;
  }

  const userMcpEnv = extractMcpEnv(userEnv);
  const projectMcpEnv = extractMcpEnv(projectEnv);
  const systemMcpEnv = extractMcpEnv(systemEnv);
  const merged: Record<string, McpServerConfig> = {};

  for (const name of serverNames) {
    const userConfig = userServers[name];
    const projectConfig = projectServers[name];
    const command = projectConfig?.command ?? userConfig?.command;
    if (!command) {
      continue;
    }

    const env = {
      ...userEnv,
      ...(userConfig?.env ?? {}),
      ...userMcpEnv,
      ...projectEnv,
      ...(projectConfig?.env ?? {}),
      ...projectMcpEnv,
      ...systemEnv,
      ...systemMcpEnv,
    };
    const config: McpServerConfig = {
      command,
      args: projectConfig?.args ?? userConfig?.args,
    };
    if (Object.keys(env).length > 0) {
      config.env = env;
    }
    merged[name] = config;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveSettingsSources(
  userSettings: Hex4codeSettings | null | undefined,
  projectSettings: Hex4codeSettings | null | undefined,
  defaults: { model: string; baseURL: string },
  processEnv: SettingsProcessEnv = process.env,
): ResolvedHex4codeSettings {
  const userEnv = normalizeEnv(userSettings?.env);
  const projectEnv = normalizeEnv(projectSettings?.env);
  const systemEnv = collectHex4codeEnv(processEnv);
  const env = {
    ...userEnv,
    ...projectEnv,
    ...systemEnv,
  };

  const model =
    trimString(systemEnv.MODEL) ||
    trimString(projectSettings?.model) ||
    trimString(projectEnv.MODEL) ||
    trimString(userSettings?.model) ||
    trimString(userEnv.MODEL) ||
    defaults.model;

  const thinkingEnabled =
    parseBoolean(systemEnv.THINKING_ENABLED) ??
    parseBoolean(projectSettings?.thinkingEnabled) ??
    parseBoolean(projectEnv.THINKING_ENABLED) ??
    parseBoolean(userSettings?.thinkingEnabled) ??
    parseBoolean(userEnv.THINKING_ENABLED) ??
    defaultsToThinkingMode(model);

  const reasoningEffort =
    resolveReasoningEffort(systemEnv.REASONING_EFFORT) ??
    resolveReasoningEffort(projectSettings?.reasoningEffort) ??
    resolveReasoningEffort(projectEnv.REASONING_EFFORT) ??
    resolveReasoningEffort(userSettings?.reasoningEffort) ??
    resolveReasoningEffort(userEnv.REASONING_EFFORT) ??
    "max";

  const debugLogEnabled =
    parseBoolean(systemEnv.DEBUG_LOG_ENABLED) ??
    parseBoolean(projectSettings?.debugLogEnabled) ??
    parseBoolean(projectEnv.DEBUG_LOG_ENABLED) ??
    parseBoolean(userSettings?.debugLogEnabled) ??
    parseBoolean(userEnv.DEBUG_LOG_ENABLED) ??
    false;

  // ── Config validation warnings ──
  const warnings: string[] = [];
  if (!model) warnings.push("⚠️  model configuration is empty");
  if (model && model.length > 0 && /[A-Z]/.test(model) && !/[A-Z]{2,}/.test(model))
    warnings.push(`⚠️  model name may be incorrect: "${model}"`);
  const baseURL = trimString(env.BASE_URL) || defaults.baseURL;
  if (baseURL && !baseURL.startsWith("http")) {
    warnings.push(`⚠️  baseURL may be invalid (does not start with http): "${baseURL}"`);
  }
  const mcpServers = mergeMcpServers(userSettings, projectSettings, userEnv, projectEnv, systemEnv);
  if (mcpServers) {
    for (const [name, srv] of Object.entries(mcpServers)) {
      if (!srv.command || typeof srv.command !== "string" || !srv.command.trim()) {
        warnings.push(`⚠️  MCP server "${name}" has empty command`);
      }
    }
  }
  if (warnings.length > 0) {
    console.error("[hex4code] Configuration warnings:");
    warnings.forEach((w) => console.error(`  ${w}`));
  }

  const notify =
    trimString(systemEnv.NOTIFY) || trimString(projectSettings?.notify) || trimString(userSettings?.notify) || "";
  const webSearchTool =
    trimString(systemEnv.WEB_SEARCH_TOOL) ||
    trimString(projectSettings?.webSearchTool) ||
    trimString(userSettings?.webSearchTool) ||
    "";
  const taskModels = {
    ...(userSettings?.taskModels ?? {}),
    ...(projectSettings?.taskModels ?? {}),
  };
  const providers = {
    ...normalizeProviders(userSettings),
    ...normalizeProviders(projectSettings),
  };

  return {
    env,
    apiKey:
      trimString(systemEnv.API_KEY) ||
      trimString(projectSettings?.apiKey) ||
      trimString(projectEnv.API_KEY) ||
      trimString(userSettings?.apiKey) ||
      trimString(userEnv.API_KEY) ||
      undefined,
    baseURL: trimString(env.BASE_URL) || defaults.baseURL,
    providers: Object.keys(providers).length > 0 ? providers : undefined,
    legacyApiKeyProvider: projectSettings?.legacyApiKeyProvider ?? userSettings?.legacyApiKeyProvider,
    legacyBaseURLProvider: projectSettings?.legacyBaseURLProvider ?? userSettings?.legacyBaseURLProvider,
    model,
    taskModels: Object.keys(taskModels).length > 0 ? taskModels : undefined,
    thinkingEnabled,
    reasoningEffort,
    debugLogEnabled,
    notify: notify || undefined,
    webSearchTool: webSearchTool || undefined,
    mcpServers: mergeMcpServers(userSettings, projectSettings, userEnv, projectEnv, systemEnv),
  };
}

export function resolveSettings(
  settings: Hex4codeSettings | null | undefined,
  defaults: { model: string; baseURL: string },
  processEnv: SettingsProcessEnv = process.env,
): ResolvedHex4codeSettings {
  return resolveSettingsSources(settings, null, defaults, processEnv);
}

export function modelConfigKey(config: Pick<ModelConfigSelection, "thinkingEnabled" | "reasoningEffort">): string {
  return config.thinkingEnabled ? `thinking:${config.reasoningEffort}` : "thinking:none";
}

export function applyModelConfigSelection(
  settings: Hex4codeSettings | null | undefined,
  current: ModelConfigSelection,
  selected: ModelConfigSelection,
): { settings: Hex4codeSettings; changed: boolean } {
  const changed = selected.model !== current.model || modelConfigKey(selected) !== modelConfigKey(current);
  const next: Hex4codeSettings = { ...(settings ?? {}) };

  if (!changed) {
    return { settings: next, changed: false };
  }

  if (selected.model !== current.model || Object.prototype.hasOwnProperty.call(next, "model")) {
    next.model = selected.model;
  } else {
    delete next.model;
  }

  next.thinkingEnabled = selected.thinkingEnabled;
  if (selected.thinkingEnabled) {
    next.reasoningEffort = selected.reasoningEffort;
  }

  return { settings: next, changed: true };
}

// ── Phase 1-4: Multi-model routing ────────────────────────────────────

export type TaskType = "completion" | "generation" | "analysis" | "review" | "chat";

export type ModelRouting = {
  completion: string;
  generation: string;
  analysis: string;
  review: string;
  chat: string;
};

export const DEFAULT_MODEL_ROUTING: ModelRouting = {
  completion: "deepseek-chat",
  generation: "deepseek-chat",
  analysis: "deepseek-chat",
  review: "deepseek-chat",
  chat: "deepseek-chat",
};

export function getRouterForTask(task: TaskType, routing?: Partial<ModelRouting>): string {
  if (routing && routing[task]) return routing[task];
  return DEFAULT_MODEL_ROUTING[task];
}
