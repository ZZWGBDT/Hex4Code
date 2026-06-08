import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import OpenAI from "openai";
import MarkdownIt from "markdown-it";
import type { SessionMessage } from "@hex4code/core/session";
import {
  SessionManager,
  getCompactPromptTokenThreshold,
  type LlmStreamProgress,
  type SessionEntry,
  type SkillInfo,
  type UserPromptContent,
} from "@hex4code/core/session";
import {
  resolveSettingsSources,
  type Hex4codeSettings,
  type ReasoningEffort,
  type ResolvedHex4codeSettings,
} from "@hex4code/core/settings";
import { setShellIfWindows } from "@hex4code/core/common/shell-utils";
import { CompletionManager } from "@hex4code/core/completion";
import { getEffectiveMode, getModeLabel, type AgentMode, type ModeConfig } from "@hex4code/core/agent-mode";
import { PROVIDERS, getModelDef, isRegisteredModel } from "@hex4code/core/models/provider-registry";
import {
  detectConfiguredProviders,
  fetchOpenAICompatibleModels,
  inferProviderCompatibility,
  listConfiguredProviderRuntimeModels,
  resolveProviderRoute,
  type ProviderRuntimeModel,
} from "@hex4code/core/models/model-router";
import { createClient } from "@hex4code/core/models/provider-client";
import type { ToolExecutionResult } from "@hex4code/core/tools/executor";
import { queueDiffPreview, registerDiffViewerCleanup } from "@hex4code/core/common/diff-viewer";
import { registerFileReferenceCommand } from "@hex4code/core/common/file-referencer";

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

// ── Agent Mode State ──────────────────────────────────────────────────
let _currentAgentMode: AgentMode = "general";
const _modeConfig: ModeConfig = { mode: "general", autoDetect: true };
let _modeStatusBarItem: vscode.StatusBarItem | undefined;

// ── Model Status Bar ─────────────────────────────────────────────────
let _modelStatusBarItem: vscode.StatusBarItem | undefined;

function getWorkspaceRootFromVsCode(): string | null {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  return workspace?.uri.fsPath ?? null;
}

function readSettingsFileAt(settingsPath: string): Hex4codeSettings | null {
  try {
    if (!fs.existsSync(settingsPath)) {
      return null;
    }
    const raw = fs.readFileSync(settingsPath, "utf8");
    return JSON.parse(raw) as Hex4codeSettings;
  } catch {
    return null;
  }
}

function readUserSettingsFile(): Hex4codeSettings | null {
  return readSettingsFileAt(path.join(os.homedir(), ".hex4code", "settings.json"));
}

function readProjectSettingsFile(workspaceRoot = getWorkspaceRootFromVsCode()): Hex4codeSettings | null {
  if (!workspaceRoot) {
    return null;
  }
  return readSettingsFileAt(path.join(workspaceRoot, ".hex4code", "settings.json"));
}

function ensureSettingsEnv(settings: Hex4codeSettings): NonNullable<Hex4codeSettings["env"]> {
  if (!settings.env || typeof settings.env !== "object") {
    settings.env = {};
  }
  return settings.env;
}

type CustomProviderEndpointSettings = {
  id: string;
  name?: string;
  apiKey?: string;
  baseURL: string;
  compatibility?: "openai-compatible" | "minimax" | "ollama";
  models: string[];
};

function trimSettingsString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCustomModelIds(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((modelId) => trimSettingsString(modelId)).filter(Boolean)))
    : [];
}

function getCustomProviderEndpoints(
  customSettings: NonNullable<Hex4codeSettings["providers"]>["custom"] | undefined,
): CustomProviderEndpointSettings[] {
  const settings = customSettings as
    | {
        apiKey?: string;
        baseURL?: string;
        compatibility?: "openai-compatible" | "minimax" | "ollama";
        models?: string[];
        endpoints?: CustomProviderEndpointSettings[];
      }
    | undefined;
  const endpoints: CustomProviderEndpointSettings[] = [];
  if (Array.isArray(settings?.endpoints)) {
    for (const endpoint of settings.endpoints) {
      const baseURL = trimSettingsString(endpoint.baseURL).replace(/\/+$/, "");
      const models = normalizeCustomModelIds(endpoint.models);
      if (!baseURL || models.length === 0) {
        continue;
      }
      endpoints.push({
        id: trimSettingsString(endpoint.id) || buildCustomEndpointId(baseURL),
        ...(trimSettingsString(endpoint.name) ? { name: trimSettingsString(endpoint.name) } : {}),
        ...(trimSettingsString(endpoint.apiKey) ? { apiKey: trimSettingsString(endpoint.apiKey) } : {}),
        baseURL,
        ...(endpoint.compatibility ? { compatibility: endpoint.compatibility } : {}),
        models,
      });
    }
  }

  const legacyBaseURL = trimSettingsString(settings?.baseURL).replace(/\/+$/, "");
  const legacyModels = normalizeCustomModelIds(settings?.models);
  if (legacyBaseURL && legacyModels.length > 0) {
    endpoints.push({
      id: "legacy-custom",
      name: "Custom",
      ...(trimSettingsString(settings?.apiKey) ? { apiKey: trimSettingsString(settings?.apiKey) } : {}),
      baseURL: legacyBaseURL,
      ...(settings?.compatibility ? { compatibility: settings.compatibility } : {}),
      models: legacyModels,
    });
  }
  return endpoints;
}

function buildCustomEndpointId(value: string): string {
  const input = value.trim();
  try {
    return new URL(input).hostname.replace(/^www\./, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom";
  } catch {
    return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom";
  }
}

function inferCustomEndpointName(baseURL: string): string {
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    if (host.includes("minimaxi.com")) return "MiniMax";
    if (host.includes("bigmodel.cn")) return "BigModel";
    if (host.includes("localhost") || host.includes("127.0.0.1")) return "Local";
    return host.replace(/^api\./, "");
  } catch {
    return "Custom";
  }
}

function readResolvedSettingsForUi(): ResolvedHex4codeSettings {
  return resolveSettingsSources(
    readUserSettingsFile(),
    readProjectSettingsFile(),
    { model: DEFAULT_MODEL, baseURL: DEFAULT_BASE_URL },
    process.env,
  );
}

function readSettingsModel(): string {
  return readResolvedSettingsForUi().model;
}

function updateModelStatusBar(): void {
  if (!_modelStatusBarItem) return;
  const model = readSettingsModel();
  const modelDef = getModelDef(model);
  const label = modelDef?.label || model;
  _modelStatusBarItem.text = `$(symbol-ruler) ${label}`;
  _modelStatusBarItem.tooltip = `Model: ${model}\nClick to change model`;
  _modelStatusBarItem.color = "#E8A87C";
}

function updateModeFromProject(projectRoot: string): void {
  const newMode = getEffectiveMode(_modeConfig, projectRoot);
  if (newMode !== _currentAgentMode) {
    _currentAgentMode = newMode;
    if (_modeStatusBarItem) {
      _modeStatusBarItem.text = getModeLabel(newMode);
      _modeStatusBarItem.tooltip =
        newMode === "hex4"
          ? "HEX4 Mode: Pipeline + TC Propagation + HEX4 Completions"
          : "General Agent Mode: Free function calling + General completions";
      _modeStatusBarItem.color = newMode === "hex4" ? "#4CAF50" : "#2196F3";
    }
  }
}

function toggleAgentMode(): void {
  _currentAgentMode = _currentAgentMode === "hex4" ? "general" : "hex4";
  _modeConfig.override = _currentAgentMode;
  if (_modeStatusBarItem) {
    _modeStatusBarItem.text = getModeLabel(_currentAgentMode);
    _modeStatusBarItem.tooltip =
      _currentAgentMode === "hex4"
        ? "HEX4 Mode (click to switch to General Agent)"
        : "General Agent Mode (click to switch to HEX4)";
  }
  vscode.window.showInformationMessage(`Switched to ${getModeLabel(_currentAgentMode)} mode`, { modal: false });
}

export function getCurrentAgentMode(): AgentMode {
  return _currentAgentMode;
}

class Hex4codeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "hex4code.chatView";

  private readonly context: vscode.ExtensionContext;
  private webviewView: vscode.WebviewView | undefined;
  private readonly md: MarkdownIt;
  private readonly sessionManager: SessionManager;
  private _lastRoutedModel: string = "";

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.md = new MarkdownIt({
      html: false,
      linkify: false,
      breaks: true,
    });
    this.sessionManager = new SessionManager({
      projectRoot: this.getWorkspaceRoot(),
      createOpenAIClient: () => this.createOpenAIClient(),
      getResolvedSettings: () => this.resolveCurrentSettings(),
      renderMarkdown: (text) => this.md.render(text),
      ui: {
        onMessage: () => {},
        onToolResult: (toolCallId: string, content: string, result: ToolExecutionResult) => {
          // Detect file changes from edit/write tools and show diff
          try {
            const parsed = JSON.parse(content);
            const filePath = (result as any).file_path || parsed.file_path || parsed.F;
            if (filePath && (result.name === "edit" || result.name === "write") && result.ok) {
              queueDiffPreview(result.name, filePath, null, "");
            }
          } catch { /* ignore parse errors */ }
        },
        onError: () => {},
        getAgentMode: getCurrentAgentMode,
      },
      onAssistantMessage: (message: SessionMessage, shouldConnect: boolean) => {
        if (!this.webviewView) {
          return;
        }
        if (message.visible === false) {
          return;
        }
        if (message.role !== "tool") {
          const reasoningContent = (message.messageParams as any)?.reasoning_content;
          message.html = this.md.render(message.content || reasoningContent || "");
        }
        this.webviewView.webview.postMessage({ type: "appendMessage", message, shouldConnect });
      },
      onSessionEntryUpdated: (entry) => {
        if (!this.webviewView) {
          return;
        }
        this.webviewView.webview.postMessage({
          type: "sessionStatus",
          sessionId: entry.id,
          status: entry.status,
          processes: this.serializeProcesses(entry.processes),
          tokenTelemetry: this.buildTokenTelemetry(entry),
        });
      },
      onLlmStreamProgress: (progress: LlmStreamProgress) => {
        if (!this.webviewView) {
          return;
        }
        this.webviewView.webview.postMessage({
          type: "llmStreamProgress",
          progress,
        });
      },
    });
    void this.initializeMcpServers();
  }

  dispose(): void {
    this.sessionManager.dispose();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === "ready") {
        // webview is ready, send initial data
        this.loadInitialSession();
        this.sendSettingsState();
        // Also request skills list
        this.sendSkillsList();
      } else if (message?.type === "requestSkills") {
        // Request skills list
        this.sendSkillsList();
      } else if (message?.type === "requestSettingsState") {
        this.sendSettingsState();
      } else if (message?.type === "selectModel") {
        const modelId = String(message.modelId || "").trim();
        if (modelId) {
          await this.selectModelFromWebview(modelId);
        }
      } else if (message?.type === "openProviderSettings") {
        await configureProviders();
        updateModelStatusBar();
        this.sendSettingsState();
      } else if (message?.type === "fetchCustomProviderModels") {
        await this.fetchCustomProviderModels(
          String(message.baseURL || "").trim(),
          String(message.apiKey || "").trim(),
        );
      } else if (message?.type === "saveCustomProvider") {
        await this.saveCustomProvider({
          baseURL: String(message.baseURL || "").trim(),
          apiKey: String(message.apiKey || "").trim(),
          modelId: String(message.modelId || "").trim(),
          endpointName: String(message.endpointName || "").trim(),
          compatibility: String(message.compatibility || "").trim(),
        });
      } else if (message?.type === "userPrompt") {
        const prompt = String(message.prompt || "").trim();
        const images = Array.isArray(message.images)
          ? message.images.filter((image: unknown): image is string => typeof image === "string" && image.length > 0)
          : [];
        if (!prompt && images.length === 0) {
          return;
        }
        // Get skills
        const skills = message.skills || [];
        await this.handlePrompt(prompt, skills, images);
      } else if (message?.type === "interrupt") {
        // Interrupt current session
        this.sessionManager.interruptActiveSession();
      } else if (message?.type === "createNewSession") {
        await this.createNewSession();
      } else if (message?.type === "selectSession") {
        const sessionId = String(message.sessionId || "").trim();
        if (sessionId) {
          this.loadSession(sessionId);
          await this.sendSkillsList(sessionId);
        }
      } else if (message?.type === "deleteSession") {
        const sessionId = String(message.sessionId || "").trim();
        if (sessionId) {
          const activeId = this.sessionManager.getActiveSessionId();
          this.sessionManager.deleteSession(sessionId);
          if (activeId === sessionId) {
            this.sessionManager.setActiveSessionId(null);
            this.sendEmptyState(this.buildSessionsList());
          } else {
            this.sendSessionsListUpdate();
            if (activeId) {
              this.loadSession(activeId);
            }
          }
          vscode.window.showInformationMessage("Session deleted.");
        }
      } else if (message?.type === "exportSession") {
        const sessionId = String(message.sessionId || "").trim();
        if (sessionId) {
          const outPath = this.sessionManager.exportSession(sessionId);
          vscode.window.showInformationMessage(`Exported to ${outPath}`);
        }
      } else if (message?.type === "renameSession") {
        const sessionId = String(message.sessionId || "").trim();
        const newName = String(message.newName || "").trim();
        if (sessionId && newName) {
          this.sessionManager.renameSession(sessionId, newName);
          this.sendSessionsListUpdate();
          const activeId = this.sessionManager.getActiveSessionId();
          if (activeId === sessionId) {
            this.loadSession(sessionId);
          }
          vscode.window.showInformationMessage(`Renamed to "${newName}"`);
        }
      } else if (message?.type === "backToList") {
        this.showSessionsList();
      } else if (message?.type === "openFile") {
        const filePath = String(message.filePath || "").trim();
        const line = Number(message.line || 1);
        if (filePath) {
          await this.openFileInEditor(filePath, line);
        }
      }
    });

    webviewView.webview.html = this.getWebviewHtml(webviewView.webview);
  }

  private async loadInitialSession(): Promise<void> {
    const sessions = this.sessionManager.listSessions();
    const sessionsList = sessions.map((s) => ({
      id: s.id,
      summary: s.summary || "Untitled",
      createTime: s.createTime,
      updateTime: s.updateTime,
      status: s.status,
    }));

    if (sessions.length === 0) {
      // No historical sessions, show the new conversation interface
      this.sendEmptyState(sessionsList);
      return;
    }

    // Show the latest conversation
    const latestSession = sessions[0];
    const latestMessages = this.sessionManager
      .listSessionMessages(latestSession.id)
      .filter((message) => message.visible);
    if (latestMessages.length === 0) {
      this.sendEmptyState(sessionsList);
      return;
    }
    this.loadSession(latestSession.id);
  }

  private loadSession(sessionId: string): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return;
    }

    // 设置为活动会话
    this.sessionManager.setActiveSessionId(sessionId);

    const messages = this.sessionManager.listSessionMessages(sessionId);

    // 获取所有会话列表
    const sessions = this.sessionManager.listSessions();
    const sessionsList = sessions.map((s) => ({
      id: s.id,
      summary: s.summary || "Untitled",
      createTime: s.createTime,
      updateTime: s.updateTime,
      status: s.status,
    }));

    // 发送对话信息到 webview
    this.sendMessage({
      type: "loadSession",
      sessionId,
      summary: session.summary || "Untitled",
      status: session.status,
      processes: this.serializeProcesses(session.processes),
      tokenTelemetry: this.buildTokenTelemetry(session),
      sessions: sessionsList,
      messages: messages
        .filter((m) => m.visible)
        .map((m) => ({
          role: m.role,
          content: m.content,
          html:
            m.role !== "tool"
              ? this.md.render(m.content || (m.messageParams as any)?.reasoning_content || "")
              : undefined,
          meta: m.meta,
        })),
    });
  }

  private showSessionsList(): void {
    const sessions = this.sessionManager.listSessions();
    this.sendMessage({
      type: "showSessionsList",
      sessions: sessions.map((s) => ({
        id: s.id,
        summary: s.summary || "Untitled",
        createTime: s.createTime,
        updateTime: s.updateTime,
        status: s.status,
      })),
    });
  }

  private async createNewSession(): Promise<void> {
    // 清除当前活动会话
    this.sessionManager.setActiveSessionId(null);

    // 获取所有会话列表
    const sessions = this.sessionManager.listSessions();
    const sessionsList = sessions.map((s) => ({
      id: s.id,
      summary: s.summary || "Untitled",
      createTime: s.createTime,
      updateTime: s.updateTime,
      status: s.status,
    }));

    this.sendEmptyState(sessionsList);
    await this.sendSkillsList();
  }

  private sendEmptyState(
    sessions: Array<{
      id: string;
      summary: string;
      createTime: string;
      updateTime: string;
      status: SessionEntry["status"];
    }>,
  ): void {
    this.sendMessage({
      type: "initializeEmpty",
      sessions,
      status: null,
      tokenTelemetry: this.buildTokenTelemetry(null),
    });
  }

  private sendMessage(message: any): void {
    if (!this.webviewView) {
      return;
    }
    this.webviewView.webview.postMessage(message);
  }

  private async sendSkillsList(sessionId?: string): Promise<void> {
    if (!this.webviewView) {
      return;
    }
    const skills = await this.sessionManager.listSkills(
      sessionId ?? this.sessionManager.getActiveSessionId() ?? undefined,
    );
    this.sendMessage({ type: "skillsList", skills });
  }

  private buildSessionsList(): Array<{
    id: string;
    summary: string;
    createTime: string;
    updateTime: string;
    status: SessionEntry["status"];
  }> {
    return this.sessionManager.listSessions().map((s) => ({
      id: s.id,
      summary: s.summary || "Untitled",
      createTime: s.createTime,
      updateTime: s.updateTime,
      status: s.status,
    }));
  }

  private sendSessionsListUpdate(): void {
    const sessions = this.buildSessionsList();
    this.sendMessage({ type: "updateSessions", sessions });
  }

  private buildSettingsState() {
    const settings = this.resolveCurrentSettings();
    const routeInput = {
      model: settings.model,
      routing: settings.taskModels,
      env: { ...settings.env, API_KEY: settings.apiKey ?? settings.env.API_KEY },
      providers: settings.providers,
      legacyApiKeyProvider: settings.legacyApiKeyProvider,
      legacyBaseURLProvider: settings.legacyBaseURLProvider,
      processEnv: process.env,
    };
    const currentRoute = resolveProviderRoute("chat", routeInput);
    const currentProvider = PROVIDERS.find((provider) => provider.id === currentRoute.provider);

    return {
      currentModel: currentRoute.modelId,
      currentLabel: currentRoute.modelDef?.label ?? currentRoute.modelId,
      providerId: currentRoute.provider,
      providerName: currentProvider?.name ?? currentRoute.provider,
      apiKeyEnv: currentRoute.apiKeyEnv,
      apiKeySource: currentRoute.apiKeySource,
      baseURLSource: currentRoute.baseURLSource,
      baseURL: currentRoute.baseURL,
      configured: Boolean(currentRoute.apiKey),
      warnings: currentRoute.warnings,
      providers: PROVIDERS.map((provider) => {
        if (provider.id === "custom" && provider.models.length === 0) {
          const customEndpoints = getCustomProviderEndpoints(settings.providers?.custom);
          const customModelIds = new Set(
            [
              ...customEndpoints.flatMap((endpoint) => endpoint.models),
              ...(settings.providers?.custom?.models ?? []),
              ...(currentRoute.provider === "custom" && currentRoute.modelId ? [currentRoute.modelId] : []),
            ]
              .map((modelId) => String(modelId || "").trim())
              .filter((modelId) => modelId && !isRegisteredModel(modelId)),
          );
          const customModels = Array.from(customModelIds).map((modelId) => {
            const route = resolveProviderRoute("chat", { ...routeInput, model: modelId });
            const endpoint = customEndpoints.find((item) => item.models.includes(modelId));
            return {
              id: modelId,
              label: endpoint?.name ? `${modelId} (${endpoint.name})` : modelId,
              providerId: "custom",
              providerName: endpoint?.name ?? provider.name,
              apiKeyEnv: provider.apiKeyEnv,
              configured: Boolean(route.apiKey),
              apiKeySource: route.apiKeySource,
              baseURLSource: route.baseURLSource,
              baseURL: route.baseURL,
              contextWindow: route.modelDef.contextWindow,
              costPer1MInput: 0,
              costPer1MOutput: 0,
              capabilities: ["chat"],
            };
          });
          return {
            id: provider.id,
            name: provider.name,
            apiKeyEnv: provider.apiKeyEnv,
            defaultBaseURL: provider.defaultBaseURL,
            configured: Boolean(settings.providers?.custom?.apiKey || settings.providers?.custom?.baseURL),
            models: customModels,
          };
        }

        return {
          id: provider.id,
          name: provider.name,
          apiKeyEnv: provider.apiKeyEnv,
          defaultBaseURL: provider.defaultBaseURL,
          configured: provider.models.some((model) => {
            const route = resolveProviderRoute("chat", { ...routeInput, model: model.id });
            return Boolean(route.apiKey);
          }),
          models: provider.models.map((model) => {
            const route = resolveProviderRoute("chat", { ...routeInput, model: model.id });
            return {
              id: model.id,
              label: model.label,
              providerId: provider.id,
              providerName: provider.name,
              apiKeyEnv: provider.apiKeyEnv,
              configured: Boolean(route.apiKey),
              apiKeySource: route.apiKeySource,
              baseURLSource: route.baseURLSource,
              baseURL: route.baseURL,
              contextWindow: model.contextWindow,
              costPer1MInput: model.costPer1MInput,
              costPer1MOutput: model.costPer1MOutput,
              capabilities: model.capabilities,
            };
          }),
        };
      }),
    };
  }

  public sendSettingsState(): void {
    this.sendMessage({
      type: "settingsState",
      state: this.buildSettingsState(),
    });
  }

  private async fetchCustomProviderModels(baseURL: string, apiKey: string): Promise<void> {
    try {
      const result = await fetchOpenAICompatibleModels(baseURL, apiKey);
      this.sendMessage({
        type: "customProviderModels",
        ok: true,
        models: result.models,
        compatibility: result.compatibility,
      });
    } catch (error) {
      this.sendMessage({
        type: "customProviderModels",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async saveCustomProvider(config: {
    baseURL: string;
    apiKey: string;
    modelId: string;
    endpointName?: string;
    compatibility: string;
  }): Promise<void> {
    if (!config.baseURL || !config.apiKey || !config.modelId) {
      this.sendMessage({
        type: "customProviderSaved",
        ok: false,
        error: "Base URL, API key, and model are required.",
      });
      return;
    }

    const { settings, scope } = readWritableModelSettings();
    settings.providers = settings.providers ?? {};
    const compatibility =
      config.compatibility === "minimax" || config.compatibility === "ollama" || config.compatibility === "openai-compatible"
        ? config.compatibility
        : inferProviderCompatibility(config.baseURL);
    const baseURL = config.baseURL.replace(/\/+$/, "");
    const existingCustom = settings.providers.custom;
    const endpoints = getCustomProviderEndpoints(existingCustom)
      .map((endpoint) => ({
        ...endpoint,
        models: endpoint.models.filter((modelId) => modelId !== config.modelId),
      }))
      .filter((endpoint) => endpoint.models.length > 0);
    const endpointId = buildCustomEndpointId(baseURL);
    const endpointName = (config.endpointName || inferCustomEndpointName(baseURL)).trim();
    const existingEndpoint = endpoints.find((endpoint) => endpoint.id === endpointId || endpoint.baseURL === baseURL);
    if (existingEndpoint) {
      existingEndpoint.id = endpointId;
      existingEndpoint.name = endpointName;
      existingEndpoint.apiKey = config.apiKey;
      existingEndpoint.baseURL = baseURL;
      existingEndpoint.compatibility = compatibility;
      existingEndpoint.models = Array.from(new Set([...existingEndpoint.models, config.modelId]));
    } else {
      endpoints.push({
        id: endpointId,
        name: endpointName,
        apiKey: config.apiKey,
        baseURL,
        compatibility,
        models: [config.modelId],
      });
    }
    settings.providers.custom = { endpoints };
    const env = ensureSettingsEnv(settings);
    env.MODEL = config.modelId;
    settings.model = config.modelId;
    writeWritableModelSettings(settings, scope);
    updateModelStatusBar();
    this.sendSettingsState();
    this.sendMessage({ type: "customProviderSaved", ok: true, modelId: config.modelId });
    vscode.window.showInformationMessage(`Custom model selected: ${config.modelId}`);
  }

  private async selectModelFromWebview(modelId: string): Promise<void> {
    const model = getModelDef(modelId);
    if (!model) {
      const settings = this.resolveCurrentSettings();
      const hasCustomEndpoint = getCustomProviderEndpoints(settings.providers?.custom).some((endpoint) =>
        endpoint.models.includes(modelId),
      );
      if (!hasCustomEndpoint && !settings.providers?.custom?.apiKey && !settings.providers?.custom?.baseURL) {
        vscode.window.showWarningMessage(`Unknown model: ${modelId}`);
        return;
      }
    }

    const { settings, scope } = readWritableModelSettings();
    const env = ensureSettingsEnv(settings);
    env.MODEL = modelId;
    settings.model = modelId;
    writeWritableModelSettings(settings, scope);
    updateModelStatusBar();
    this.sendSettingsState();

    const route = resolveProviderRoute("chat", {
      model: modelId,
      routing: settings.taskModels,
      env: { ...settings.env, API_KEY: settings.apiKey ?? settings.env?.API_KEY },
      providers: settings.providers,
      legacyApiKeyProvider: settings.legacyApiKeyProvider,
      legacyBaseURLProvider: settings.legacyBaseURLProvider,
      processEnv: process.env,
    });

    if (!route.apiKey) {
      const provider = PROVIDERS.find((item) => item.id === route.provider);
      vscode.window.showWarningMessage(
        `${model?.label ?? modelId} selected, but ${provider?.name ?? route.provider} has no API key configured.`,
      );
      return;
    }

    vscode.window.showInformationMessage(`Model selected: ${model?.label ?? modelId}`);
  }

  private async handlePrompt(prompt: string, skills?: SkillInfo[], imageUrls?: string[]): Promise<void> {
    if (!this.webviewView) {
      return;
    }

    // Sync agent mode to global for executor to read
    const { setAgentMode } = require("@hex4code/core/agent-mode");
    setAgentMode(_currentAgentMode);

    const webview = this.webviewView.webview;
    const normalizedImages = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [];
    const displayPrompt = prompt || (normalizedImages.length > 0 ? "粘贴的图像" : "");

    // 先显示用户消息（原始文本，不做 HTML 格式化）
    webview.postMessage({ type: "userMessage", content: displayPrompt });

    webview.postMessage({ type: "loading", value: true });

    try {
      const userPrompt: UserPromptContent = { text: prompt, skills, imageUrls: normalizedImages };

      // 注入当前打开的文件上下文
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        const doc = activeEditor.document;
        userPrompt.activeFile = {
          path: doc.uri.fsPath,
          content: doc.getText(),
        };
      }
      await this.sessionManager.handleUserPrompt(userPrompt);
      await this.sendSkillsList();

      const activeSessionId = this.sessionManager.getActiveSessionId();
      const activeSession = activeSessionId ? this.sessionManager.getSession(activeSessionId) : null;
      if (activeSessionId && activeSession) {
        webview.postMessage({
          type: "sessionStatus",
          sessionId: activeSessionId,
          status: activeSession.status,
          processes: this.serializeProcesses(activeSession.processes),
          tokenTelemetry: this.buildTokenTelemetry(activeSession),
        });
      }

      // 发送更新后的会话列表（可能创建了新会话）
      const sessions = this.sessionManager.listSessions();
      const sessionsList = sessions.map((s) => ({
        id: s.id,
        summary: s.summary || "Untitled",
        createTime: s.createTime,
        updateTime: s.updateTime,
        status: s.status,
      }));
      webview.postMessage({
        type: "showSessionsList",
        sessions: sessionsList,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      webview.postMessage({
        type: "assistant",
        html: this.md.render(`Request failed: ${message}`),
      });
    } finally {
      webview.postMessage({ type: "loading", value: false });
    }
  }

  private createOpenAIClient(): {
    client: OpenAI | null;
    model: string;
    baseURL: string;
    thinkingEnabled: boolean;
    reasoningEffort: ReasoningEffort;
    debugLogEnabled: boolean;
    notify?: string;
    webSearchTool?: string;
    env?: Record<string, string>;
    machineId?: string;
  } {
    const settings = this.resolveCurrentSettings();

    // 使用多模型路由引擎选择聊天模型
    const route = resolveProviderRoute("chat", {
      model: settings.model,
      routing: settings.taskModels,
      env: { ...settings.env, API_KEY: settings.apiKey ?? settings.env.API_KEY },
      providers: settings.providers,
      legacyApiKeyProvider: settings.legacyApiKeyProvider,
      legacyBaseURLProvider: settings.legacyBaseURLProvider,
      processEnv: process.env,
    });
    const routedModel = route.modelId;
    this._lastRoutedModel = routedModel;
    const routedBaseURL = route.baseURL;
    // ── hex4relay Secrets 模式：多 Provider 感知的 fallback 链 ──
    // 优先级：settings.apiKey (通用) → env[route.apiKeyEnv] → ""
    // 
    // env[route.apiKeyEnv] 覆盖了 hex4relay secrets-resolve 的同步路径：
    //   - 策略1 (env): 直接从环境变量读取，此处即 process.env[route.apiKeyEnv]
    //   - 策略3 (raw): settings.apiKey 已覆盖
    const routedApiKey = route.apiKey;

    const { thinkingEnabled, reasoningEffort, debugLogEnabled, notify, webSearchTool, env } = settings;
    const machineId = vscode.env.machineId;

    // ── hex4relay Secrets: 同步路径已经覆盖 env + settings.apiKey ──
    //   如果 routedApiKey 仍然为空，说明所有同步路径都失败了，直接走 null-client 分支。

    if (!routedApiKey) {
      return {
        client: null,
        model: routedModel,
        baseURL: routedBaseURL,
        thinkingEnabled,
        reasoningEffort,
        debugLogEnabled,
        notify,
        webSearchTool,
        env,
        machineId,
      };
    }

    // 使用 provider-client 工厂创建客户端（支持 Gemini 适配器）
    const client = createClient({
      modelId: routedModel,
      apiKey: routedApiKey,
      baseURL: routedBaseURL,
    });
    const openaiClient =
      client && "chat" in client
        ? (client as unknown as OpenAI)
        : new OpenAI({ apiKey: routedApiKey, baseURL: routedBaseURL || undefined });

    return {
      client: openaiClient,
      model: routedModel,
      baseURL: routedBaseURL,
      thinkingEnabled,
      reasoningEffort,
      debugLogEnabled,
      notify,
      webSearchTool,
      env,
      machineId,
    };
  }

  private buildTokenTelemetry(session: SessionEntry | null): {
    model: string;
    thinkingEnabled: boolean;
    reasoningEffort: ReasoningEffort;
    activeTokens: number;
    compactPromptTokenThreshold: number;
    usage: unknown | null;
  } {
    const settings = this.resolveCurrentSettings();
    return {
      model: this._lastRoutedModel || settings.model,
      thinkingEnabled: settings.thinkingEnabled,
      reasoningEffort: settings.reasoningEffort,
      activeTokens: session?.activeTokens ?? 0,
      compactPromptTokenThreshold: getCompactPromptTokenThreshold(this._lastRoutedModel || settings.model),
      usage: session?.usage ?? null,
    };
  }

  private async initializeMcpServers(): Promise<void> {
    try {
      await this.sessionManager.initMcpServers(this.resolveCurrentSettings().mcpServers);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Failed to initialize MCP servers: ${message}`);
    }
  }

  private resolveCurrentSettings(): ResolvedHex4codeSettings {
    return resolveSettingsSources(
      this.readUserSettings(),
      this.readProjectSettings(),
      {
        model: DEFAULT_MODEL,
        baseURL: DEFAULT_BASE_URL,
      },
      process.env,
    );
  }

  private readUserSettings(): Hex4codeSettings | null {
    try {
      const settingsPath = path.join(os.homedir(), ".hex4code", "settings.json");
      if (!fs.existsSync(settingsPath)) {
        return null;
      }

      const raw = fs.readFileSync(settingsPath, "utf8");
      return JSON.parse(raw) as Hex4codeSettings;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to read ~/.hex4code/settings.json: ${message}`);
      return null;
    }
  }

  private readProjectSettings(): Hex4codeSettings | null {
    const workspaceRoot = this.getWorkspaceRoot();
    try {
      const settingsPath = path.join(workspaceRoot, ".hex4code", "settings.json");
      if (!fs.existsSync(settingsPath)) {
        return null;
      }

      const raw = fs.readFileSync(settingsPath, "utf8");
      return JSON.parse(raw) as Hex4codeSettings;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `Failed to read ${path.join(workspaceRoot, ".hex4code", "settings.json")}: ${message}`,
      );
      return null;
    }
  }

  private getWorkspaceRoot(): string {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (workspace) {
      return workspace.uri.fsPath;
    }
    return process.cwd();
  }

  private serializeProcesses(
    processes: Map<string, { startTime: string; command: string }> | null,
  ): Record<string, { startTime: string; command: string }> | null {
    if (!processes || processes.size === 0) {
      return null;
    }

    const serialized: Record<string, { startTime: string; command: string }> = {};
    for (const [pid, entry] of processes.entries()) {
      serialized[pid] = entry;
    }
    return serialized;
  }

  private getWebviewHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = webview.cspSource;

    // 读取 HTML 模板文件
    const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "webview.html");
    let html = fs.readFileSync(htmlPath.fsPath, "utf8");

    // 获取 CSS 文件 URI
    const cssPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "webview.css");
    const cssUri = webview.asWebviewUri(cssPath);
    const attachmentsJsPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "prompt-attachments.js");
    const attachmentsJsUri = webview.asWebviewUri(attachmentsJsPath);

    // 获取 Logo 文件 URI
    const iconPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "hex4code_icon.png");
    const iconUri = webview.asWebviewUri(iconPath);

    // 替换占位符
    html = html.replace(/\{\{nonce\}\}/g, nonce);
    html = html.replace(/\{\{cspSource\}\}/g, csp);
    html = html.replace(/\{\{cssUri\}\}/g, cssUri.toString());
    html = html.replace(/\{\{attachmentsJsUri\}\}/g, attachmentsJsUri.toString());
    html = html.replace(/\{\{iconUri\}\}/g, iconUri.toString());
    html = html.replace(/\{\{workspaceRoot\}\}/g, JSON.stringify(this.getWorkspaceRoot()));

    return html;
  }

  private async openFileInEditor(filePath: string, line: number): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
    });

    const targetLine = Number.isFinite(line) && line > 0 ? Math.floor(line) - 1 : 0;
    const safeLine = Math.min(Math.max(0, targetLine), Math.max(0, document.lineCount - 1));
    const position = new vscode.Position(safeLine, 0);
    const selection = new vscode.Selection(position, position);
    editor.selection = selection;
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }
}

// ── Multi-Model UI Commands ─────────────────────────────────────────

/** 读入 .hex4code/settings.json */
function readSettingsFile(): Hex4codeSettings {
  return readUserSettingsFile() ?? {};
}

/** 写入 .hex4code/settings.json */
function writeSettingsFile(settings: Hex4codeSettings): void {
  const dir = path.join(os.homedir(), ".hex4code");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
}

function writeProjectSettingsFile(settings: Hex4codeSettings): boolean {
  const workspaceRoot = getWorkspaceRootFromVsCode();
  if (!workspaceRoot) {
    return false;
  }
  const dir = path.join(workspaceRoot, ".hex4code");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
  return true;
}

function hasModelOverride(settings: Hex4codeSettings | null | undefined): boolean {
  return Boolean(String(settings?.model || "").trim() || String(settings?.env?.MODEL || "").trim());
}

function readWritableModelSettings(): { settings: Hex4codeSettings; scope: "project" | "user" } {
  const projectSettings = readProjectSettingsFile();
  if (hasModelOverride(projectSettings)) {
    return { settings: projectSettings ?? {}, scope: "project" };
  }
  return { settings: readSettingsFile(), scope: "user" };
}

function writeWritableModelSettings(settings: Hex4codeSettings, scope: "project" | "user"): void {
  if (scope === "project" && writeProjectSettingsFile(settings)) {
    return;
  }
  writeSettingsFile(settings);
}

function getProviderSettings(settings: Hex4codeSettings, provider: (typeof PROVIDERS)[number]) {
  return settings.providers?.[provider.id];
}

function getConfiguredProviderKey(settings: Hex4codeSettings, provider: (typeof PROVIDERS)[number]): string {
  return (
    getProviderSettings(settings, provider)?.apiKey ||
    settings.env?.[provider.apiKeyEnv] ||
    process.env[provider.apiKeyEnv] ||
    ""
  );
}

function isProviderConfigured(settings: Hex4codeSettings, provider: (typeof PROVIDERS)[number]): boolean {
  return Boolean(getConfiguredProviderKey(settings, provider).trim());
}

function ensureProviderSettings(settings: Hex4codeSettings, provider: (typeof PROVIDERS)[number]) {
  settings.providers = settings.providers ?? {};
  settings.providers[provider.id] = settings.providers[provider.id] ?? {};
  return settings.providers[provider.id]!;
}

function getConfiguredRuntimeModels(task: "completion" | "generation" | "analysis" | "review" | "chat" = "chat") {
  const settings = readResolvedSettingsForUi();
  return listConfiguredProviderRuntimeModels(task, {
    model: settings.model,
    routing: settings.taskModels,
    env: { ...settings.env, API_KEY: settings.apiKey ?? settings.env.API_KEY },
    providers: settings.providers,
    legacyApiKeyProvider: settings.legacyApiKeyProvider,
    legacyBaseURLProvider: settings.legacyBaseURLProvider,
    processEnv: process.env,
  });
}

function getConfiguredProviderIdsFromSettings(): Array<ProviderRuntimeModel["providerId"]> {
  return getConfiguredRuntimeModels("chat").map((runtime) => runtime.providerId);
}

/**
 * 显示模型选择 QuickPick。
 * 按 Provider 分组，显示模型名称、上下文窗口和价格。
 * 选中后写入 .hex4code/settings.json 的 model 字段。
 */
async function showModelPicker(): Promise<void> {
  // 检测当前已配置的 Provider
  const { settings: currentSettings, scope } = readWritableModelSettings();
  const currentModel = readResolvedSettingsForUi().model;

  // 构建 QuickPick 选项（按 Provider 分组）
  const items: vscode.QuickPickItem[] = [];

  for (const provider of PROVIDERS) {
    const isConfigured = isProviderConfigured(currentSettings, provider);

    // Provider 分组头
    const providerName = `$(organization) ${provider.name}`;
    items.push({
      label: providerName,
      kind: vscode.QuickPickItemKind.Separator,
      description: isConfigured ? "已配置" : "未配置 API Key",
    });

    // 该 Provider 下的模型
    for (const model of provider.models) {
      const isCurrent = model.id === currentModel;
      const costStr = `$${model.costPer1MInput}/${model.costPer1MOutput}/M`;
      const ctxStr = `${(model.contextWindow / 1000).toFixed(0)}K ctx`;
      items.push({
        label: `${isCurrent ? "$(link)" : "  "} ${model.label}`,
        description: isCurrent ? "当前使用" : "",
        detail: `${ctxStr} · ${costStr} · ${model.capabilities.join(", ")}`,
        buttons: isConfigured
          ? [{ iconPath: new vscode.ThemeIcon("check"), tooltip: "可用" }]
          : [{ iconPath: new vscode.ThemeIcon("warning"), tooltip: `未设置 ${provider.apiKeyEnv}` }],
      });
    }
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: "选择默认模型（按任务路由自动匹配）",
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selected) return;

  // 从 label 提取模型名
  for (const provider of PROVIDERS) {
    for (const model of provider.models) {
      if (selected.label.includes(model.label)) {
        // 保存选择
        const env = ensureSettingsEnv(currentSettings);
        env.MODEL = model.id;
        currentSettings.model = model.id;
        writeWritableModelSettings(currentSettings, scope);
        updateModelStatusBar();
        vscode.window.showInformationMessage(
          `已选择模型: ${provider.name} - ${model.label}（${model.id}）`,
          `输入: $${model.costPer1MInput}/M · 输出: $${model.costPer1MOutput}/M`,
        );
        return;
      }
    }
  }
}

/**
 * 配置 Provider API Key。
 * 显示所有 Provider 列表，已配置的显示"✓"，未配置的显示"未设置"。
 * 选中后提示用户输入 API Key。
 */
async function configureProviders(): Promise<void> {
  const currentSettings = readSettingsFile();
  const settingsEnv = ensureSettingsEnv(currentSettings);

  // 构建 QuickPick
  const items: vscode.QuickPickItem[] = PROVIDERS.map((provider) => {
    const isConfigured = isProviderConfigured(currentSettings, provider);
    const existingApiKey = getConfiguredProviderKey(currentSettings, provider);
    const icon = isConfigured ? "$(check)" : existingApiKey ? "$(key)" : "$(unverified)";
    return {
      label: `${icon} ${provider.name}`,
      description: provider.defaultBaseURL,
      detail: isConfigured
        ? `环境变量 ${provider.apiKeyEnv} 已配置`
        : existingApiKey
          ? `已保存密钥 (${maskKey(existingApiKey)})`
          : `未配置 · 设置 ${provider.apiKeyEnv} 环境变量或输入密钥`,
    };
  });

  // 底部：帮助说明
  items.push({
    label: "",
    kind: vscode.QuickPickItemKind.Separator,
  });
  items.push({
    label: "$(question) 帮助：如何获取 API Key",
    description: "查看各 Provider 的 API Key 获取方式",
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: "选择要配置的 Provider（设置 API Key）",
    matchOnDescription: true,
  });

  if (!selected) return;

  // 帮助选项
  if (selected.label.includes("如何获取 API Key")) {
    const helpText = [
      "| Provider | 获取地址 | 环境变量 |",
      "|----------|---------|---------|",
      "| DeepSeek | https://platform.deepseek.com/api_keys | DEEPSEEK_API_KEY |",
      "| OpenAI   | https://platform.openai.com/api-keys   | OPENAI_API_KEY   |",
      "| 通义千问  | https://bailian.console.aliyun.com     | QWEN_API_KEY     |",
      "| Gemini   | https://aistudio.google.com/apikey    | GEMINI_API_KEY   |",
      "| 文心一言  | https://cloud.baidu.com/product/wenxin | ERNIE_API_KEY   |",
      "| MiniMax  | https://platform.minimaxi.com         | MINIMAX_API_KEY  |",
      "| 智谱GLM  | https://open.bigmodel.cn/usercenter/apikeys | GLM_API_KEY |",
      "",
      "💡 在 .bashrc 或 .zshrc 中添加环境变量即可，无需重启 VSCode。",
      "💡 也可直接在弹出输入框中输入 Key (会保存到 settings.json)。",
    ].join("\n");
    vscode.window.showInformationMessage("API Key 获取方式", { modal: true, detail: helpText });
    return;
  }

  // 找到选中的 Provider
  const provider = PROVIDERS.find((p) => selected.label.includes(p.name));
  if (!provider) return;

  // 让用户输入 API Key
  const apiKey = await vscode.window.showInputBox({
    prompt: `输入 ${provider.name} 的 API Key（或留空以使用环境变量 ${provider.apiKeyEnv}）`,
    password: true,
    placeHolder: provider.apiKeyEnv === "GEMINI_API_KEY" ? "AIza..." : "sk-...",
    ignoreFocusOut: true,
    validateInput: (value: string) => {
      if (value && value.length < 10) return "API Key 似乎太短了";
      return null;
    },
  });

  if (apiKey === undefined) return; // 用户取消

  if (apiKey) {
    // 保存到 settings.json
    const providerSettings = ensureProviderSettings(currentSettings, provider);
    providerSettings.apiKey = apiKey;
    providerSettings.baseURL = provider.defaultBaseURL;
    // 如果未设置默认模型，自动选择最便宜的模型
    if (!settingsEnv.MODEL && provider.models.length > 0) {
      const cheapest = [...provider.models].sort((a, b) => a.costPer1MInput - b.costPer1MInput)[0];
      settingsEnv.MODEL = cheapest.id;
      currentSettings.model = cheapest.id;
      vscode.window.showInformationMessage(
        `已将 ${provider.name} 的 API Key 保存到 settings.json，并自动选择 ${cheapest.label} 作为默认模型`,
      );
    } else {
      vscode.window.showInformationMessage(`已将 ${provider.name} 的 API Key 保存到 settings.json`);
    }
    writeSettingsFile(currentSettings);
    updateModelStatusBar();
  } else {
    // 用户留空 → 使用环境变量
    const envKey = process.env[provider.apiKeyEnv];
    if (envKey) {
      vscode.window.showInformationMessage(`将使用环境变量 ${provider.apiKeyEnv} 中的 API Key`);
    } else {
      vscode.window.showWarningMessage(
        `环境变量 ${provider.apiKeyEnv} 未设置。请在 .bashrc 中添加:\nexport ${provider.apiKeyEnv}="your-key-here"`,
      );
    }
  }
}

/** 隐藏 API Key 中间部分（用于显示） */
function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

export function activate(context: vscode.ExtensionContext): void {
  process.env.NoDefaultCurrentDirectoryInExePath = "1";
  try {
    setShellIfWindows();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(message);
  }

  // ── Provider 预热 ────────────────────────────────────
  try {
    resolveSettingsSources(
      readSettingsFile(),
      null,
      { model: DEFAULT_MODEL, baseURL: DEFAULT_BASE_URL },
    );
  } catch { /* 不阻塞启动 */ }

  const provider = new Hex4codeViewProvider(context);
  context.subscriptions.push(provider);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(Hex4codeViewProvider.viewType, provider));
  context.subscriptions.push(
    vscode.commands.registerCommand("hex4code.openView", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.hex4code");
      await vscode.commands.executeCommand("hex4code.chatView.focus");
    }),
  );

  // ── Agent Mode Status Bar ──────────────────────────────────────────
  _modeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  _modeStatusBarItem.command = "hex4code.toggleAgentMode";
  _modeStatusBarItem.backgroundColor = undefined;
  // Auto-detect mode from the workspace
  const wsRoot = provider["getWorkspaceRoot"]();
  updateModeFromProject(wsRoot);
  _modeStatusBarItem.show();
  context.subscriptions.push(_modeStatusBarItem);

  // ── Model Status Bar ────────────────────────────────────────────────
  _modelStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  _modelStatusBarItem.command = "hex4code.selectModel";
  _modelStatusBarItem.backgroundColor = undefined;
  updateModelStatusBar();
  _modelStatusBarItem.show();
  context.subscriptions.push(_modelStatusBarItem);

  // Mode toggle command
  context.subscriptions.push(vscode.commands.registerCommand("hex4code.toggleAgentMode", toggleAgentMode));

  // ── Model Selection QuickPick ──────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("hex4code.selectModel", async () => {
      await showModelPicker();
      provider.sendSettingsState();
    }),
  );

  // ── Provider Configuration (disabled — users edit settings.json directly) ──
  context.subscriptions.push(
    vscode.commands.registerCommand("hex4code.configureProviders", async () => {
      await configureProviders();
      updateModelStatusBar();
      provider.sendSettingsState();
    }),
  );

  // ── Provider Health Command ─────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("hex4code.providerHealth", async () => {
      const configured = getConfiguredRuntimeModels("chat");
      if (configured.length === 0) {
        vscode.window.showInformationMessage(
          "No AI providers configured. Use 'Hex4Code: Configure AI Providers' to set one up.",
        );
        return;
      }
      const baseName = path.basename(vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || "");
      const panel = vscode.window.createOutputChannel(`Provider Health — ${baseName}`, { log: true });
      panel.appendLine(`Provider Health Check — ${new Date().toLocaleString()}`);
      panel.appendLine("─".repeat(50));
      let healthy = 0;
      for (const runtime of configured) {
        const pid = runtime.providerId;
        const p = PROVIDERS.find((pr) => pr.id === pid);
        if (!p) {
          panel.appendLine(`❌ ${pid}: unknown provider`);
          continue;
        }
        const key = "";
        const testModel = p.models.find((m: any) => m.capabilities?.includes?.("chat")) || p.models[0];
        panel.appendLine(`🔍 Testing ${p.name} (${testModel.id})...`);
        try {
          const { testProviderConnection } = await import("@hex4code/core/models/model-router");
          const result = runtime
            ? await testProviderConnection(runtime.modelId, runtime.apiKey, runtime.baseURL)
            : await testProviderConnection(testModel.id, key, p.defaultBaseURL);
          if (result.ok) {
            panel.appendLine(`  ✅ OK — ${result.latencyMs}ms`);
            healthy++;
          } else {
            panel.appendLine(`  ❌ FAILED — ${result.error.slice(0, 100)}`);
          }
        } catch (e: any) {
          panel.appendLine(`  ❌ ERROR — ${e.message?.slice(0, 100) || e}`);
        }
      }
      panel.appendLine("─".repeat(50));
      panel.appendLine(`Result: ${healthy}/${configured.length} providers healthy`);
      panel.show();
    }),
  );

  // ── Cost Dashboard Command ─────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("hex4code.showCostDashboard", async () => {
      const baseName = path.basename(vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || "");
      const panel = vscode.window.createOutputChannel(`Cost Dashboard — ${baseName}`, { log: true });
      panel.appendLine(`Cost Dashboard — ${new Date().toLocaleString()}`);
      panel.appendLine("─".repeat(60));
      const sessionsPath = path.join(os.homedir(), ".hex4code", "sessions.json");
      if (!fs.existsSync(sessionsPath)) {
        panel.appendLine("No session data found. Use Hex4Code first.");
        panel.show();
        return;
      }
      try {
        const raw = fs.readFileSync(sessionsPath, "utf8");
        const index: any = JSON.parse(raw);
        const entries = index.entries || [];
        let totalCost = 0,
          totalTokens = 0,
          sessionCount = 0;
        for (const e of entries) {
          const cost = typeof e.totalCost === "number" ? e.totalCost : 0;
          const tokens = typeof e.activeTokens === "number" ? e.activeTokens : 0;
          if (cost > 0 || tokens > 0) {
            totalCost += cost;
            totalTokens += tokens;
            sessionCount++;
            panel.appendLine(`  ${e.id?.substring(0, 8) || "?"}  ${e.summary?.substring(0, 40) || "(no summary)"}`);
            panel.appendLine(`      Cost: $${cost.toFixed(6)}  Tokens: ${tokens.toLocaleString()}`);
          }
        }
        panel.appendLine("─".repeat(60));
        panel.appendLine(`Sessions tracked: ${sessionCount}`);
        panel.appendLine(`Total Cost: $${totalCost.toFixed(6)}`);
        panel.appendLine(`Total Tokens: ${totalTokens.toLocaleString()}`);
        if (totalCost > 0) {
          panel.appendLine(`Avg Cost/Session: $${(totalCost / Math.max(sessionCount, 1)).toFixed(6)}`);
          panel.appendLine(`Avg $/1K tokens: $${((totalCost / Math.max(totalTokens, 1)) * 1000).toFixed(8)}`);
        }
      } catch (e: any) {
        panel.appendLine(`Error: ${e.message?.slice(0, 100) || e}`);
      }
      panel.appendLine("─".repeat(60));
      panel.show();
    }),
  );

  // ── Task Model Configuration ────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("hex4code.configureTaskModels", async () => {
      const settings = readSettingsFile() || {};
      const currentRouting: Record<string, string> = (settings.taskModels as any) || {};
      const TASK_ENTRIES: Array<{ task: string; label: string; desc: string }> = [
        {
          task: "completion",
          label: "$(symbol-misc) 补全 — 代码/文本补全",
          desc: "当前: " + (currentRouting.completion || "默认"),
        },
        {
          task: "generation",
          label: "$(beaker) 生成 — 代码生成/重构",
          desc: "当前: " + (currentRouting.generation || "默认"),
        },
        {
          task: "analysis",
          label: "$(search) 分析 — 代码审查/架构分析",
          desc: "当前: " + (currentRouting.analysis || "默认"),
        },
        {
          task: "review",
          label: "$(checklist) 审查 — 安全审查/质量检查",
          desc: "当前: " + (currentRouting.review || "默认"),
        },
        {
          task: "chat",
          label: "$(comment-discussion) 对话 — 日常问答",
          desc: "当前: " + (currentRouting.chat || "默认"),
        },
      ];
      const selectedTask = await vscode.window.showQuickPick(
        TASK_ENTRIES.map((t) => ({ label: t.label, description: t.desc }) as vscode.QuickPickItem),
        { placeHolder: "选择要配置的任务类型", matchOnDescription: true },
      );
      if (!selectedTask) return;

      const TASK_MAP: Record<string, string> = {
        补全: "completion",
        生成: "generation",
        分析: "analysis",
        审查: "review",
        对话: "chat",
      };
      let taskType = "";
      for (const [key, val] of Object.entries(TASK_MAP)) {
        if (selectedTask.label.includes(key)) {
          taskType = val;
          break;
        }
      }
      if (!taskType) return;

      const configuredProviders = getConfiguredProviderIdsFromSettings();
      const modelItems: vscode.QuickPickItem[] = [];
      for (const provider of PROVIDERS) {
        const isConfigured = configuredProviders.includes(provider.id);
        modelItems.push({
          label: `$(organization) ${provider.name}`,
          kind: vscode.QuickPickItemKind.Separator,
          description: isConfigured ? "已配置" : "",
        });
        for (const model of provider.models) {
          modelItems.push({
            label: `${currentRouting[taskType] === model.id ? "$(link)" : "  "} ${model.label}`,
            description: currentRouting[taskType] === model.id ? "当前" : "",
            detail: `${(model.contextWindow / 1000).toFixed(0)}K ctx · $${model.costPer1MInput}/${model.costPer1MOutput}/M`,
          });
        }
      }
      modelItems.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
      modelItems.push({ label: "$(trash) 清除此任务的配置", description: "使用默认模型" });

      const selectedModel = await vscode.window.showQuickPick(modelItems, {
        placeHolder: `为 "${taskType}" 选择模型`,
        matchOnDescription: true,
      });
      if (!selectedModel) return;

      const taskModels = { ...currentRouting };
      if (selectedModel.label.includes("清除")) {
        delete taskModels[taskType];
      } else {
        for (const provider of PROVIDERS) {
          for (const model of provider.models) {
            if (selectedModel.label.includes(model.label)) {
              taskModels[taskType] = model.id;
            }
          }
        }
      }
      settings.taskModels = taskModels;
      fs.writeFileSync(
        path.join(os.homedir(), ".hex4code", "settings.json"),
        JSON.stringify(settings, null, 2),
        "utf8",
      );
      const count = Object.keys(taskModels).length;
      vscode.window.showInformationMessage(
        count > 0 ? `已配置 ${count} 个任务级模型规则` : "已清除所有任务级模型配置",
        { modal: false },
      );
    }),
  );

  // ── Smart Model Recommendation ───────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("hex4code.recommendModel", async () => {
      const { getSmartRecommendation } = await import("@hex4code/core/models/model-router");
      const configuredProviders = getConfiguredProviderIdsFromSettings();
      const preferenceItems: vscode.QuickPickItem[] = [
        { label: "$(dash) 均衡 (Balanced)", description: "按性价比推荐" },
        { label: "$(light-bulb) 最强 (Best)", description: "推荐推理能力最强模型" },
        { label: "$(percentage) 最便宜 (Cheapest)", description: "推荐价格最低模型" },
        { label: "$(rocket) 最快 (Fastest)", description: "推荐延迟最低模型" },
      ];
      const selectedPref = await vscode.window.showQuickPick(preferenceItems, { placeHolder: "选择推荐偏好" });
      if (!selectedPref) return;
      const prefMap: Record<string, "cheapest" | "fastest" | "best" | "balanced"> = {
        均衡: "balanced",
        最强: "best",
        最便宜: "cheapest",
        最快: "fastest",
      };
      let preference: "cheapest" | "fastest" | "best" | "balanced" = "balanced";
      for (const [key, val] of Object.entries(prefMap)) {
        if (selectedPref.label.includes(key)) {
          preference = val;
          break;
        }
      }
      const panel = vscode.window.createOutputChannel("Model Recommendations", { log: true });
      panel.appendLine(`Model Recommendations — ${selectedPref.label.replace(/\$\([^)]+\)\s*/g, "").trim()}`);
      panel.appendLine("─".repeat(60));
      panel.appendLine(`Configured: ${configuredProviders.join(", ") || "none"}`);
      const tasks = [
        { id: "completion", label: "补全" },
        { id: "generation", label: "生成" },
        { id: "analysis", label: "分析" },
        { id: "review", label: "审查" },
        { id: "chat", label: "对话" },
      ];
      for (const task of tasks) {
        const recs = getSmartRecommendation(task.id as any, configuredProviders, preference);
        panel.appendLine(`\n▸ ${task.label}`);
        if (!recs.length) {
          panel.appendLine("   无可用模型");
          continue;
        }
        recs.forEach((r, i) => panel.appendLine(`  ${i === 0 ? "★" : " "} ${r.reason}`));
      }
      panel.appendLine("\n─".repeat(60));
      panel.show();
    }),
  );

  // ── Multi-Model Parallel Vote ──────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("hex4code.voteOnSelection", async () => {
      const { parallelVote } = await import("@hex4code/core/models/model-router");
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active text editor");
        return;
      }
      const selection = editor.document.getText(editor.selection);
      if (!selection) {
        vscode.window.showWarningMessage("No text selected");
        return;
      }
      const runtimeModels = getConfiguredRuntimeModels("chat");
      const configured = runtimeModels.map((runtime) => runtime.providerId);
      if (runtimeModels.length < 2) {
        vscode.window.showInformationMessage(
          "At least 2 providers needed for voting. Please edit settings.json to add more API keys.",
        );
        return;
      }
      const strategyItems: vscode.QuickPickItem[] = [
        { label: "$(symbol-event) Majority", description: "Take longest response as best" },
        { label: "$(symbol-ruler) Consensus", description: "Take response closest to average" },
        { label: "$(rocket) Fastest", description: "Take fastest response" },
      ];
      const strat = await vscode.window.showQuickPick(strategyItems, { placeHolder: "Select voting strategy" });
      if (!strat) return;
      const strategy = strat.label.includes("Consensus")
        ? ("consensus" as const)
        : strat.label.includes("Fastest")
          ? ("fastest" as const)
          : ("majority" as const);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "🗳️  Multi-model voting in progress...",
          cancellable: true,
        },
        async (_progress, _token) => {
          const result = await parallelVote(selection, configured, { strategy, modelCount: 3, runtimeModels });
          const panel = vscode.window.createOutputChannel(`Vote: ${result.taskId.slice(-8)}`, { log: true });
          panel.appendLine(`Multi-Model Vote — ${strategy}`);
          panel.appendLine("─".repeat(60));
          panel.appendLine(`Prompt:\n${result.prompt.slice(0, 200)}${result.prompt.length > 200 ? "..." : ""}\n`);
          for (const r of result.responses) {
            const icon = r.error ? "❌" : "✅";
            panel.appendLine(`${icon} ${r.label} (${r.provider}) — ${r.latencyMs}ms`);
            if (r.error) panel.appendLine(`   Error: ${r.error.slice(0, 100)}`);
            else panel.appendLine(`   ${r.response.slice(0, 200)}...`);
            panel.appendLine("");
          }
          panel.appendLine("─".repeat(60));
          panel.appendLine(`Summary (${strategy}):\n${result.summary.slice(0, 500)}`);
          panel.appendLine("\n─".repeat(60));
          panel.show();
        },
      );
    }),
  );

  // ── Cache Stats ────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("hex4code.showCacheStats", () => {
      try {
        const { getGlobalCache } = require("../../packages/core/src/cache/semantic-cache");
        const cache = getGlobalCache();
        const stats = cache.stats();
        const panel = vscode.window.createOutputChannel("Semantic Cache", { log: true });
        panel.appendLine("Semantic Cache Stats");
        panel.appendLine("─".repeat(50));
        panel.appendLine(`Entries: ${stats.totalEntries}`);
        panel.appendLine(`Models: ${stats.totalModels.join(", ") || "none"}`);
        panel.appendLine(`Hits/Misses: ${stats.hits}/${stats.misses}`);
        panel.appendLine(`Hit Rate: ${(stats.hitRate * 100).toFixed(1)}%`);
        panel.show();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Cache error: ${e.message}`);
      }
    }),
  );

  // ── Model Benchmark ────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("hex4code.benchmark", async () => {
      const editor = vscode.window.activeTextEditor;
      const defaultPrompt = editor ? editor.document.getText(editor.selection) : "";
      const prompt = await vscode.window.showInputBox({
        prompt: "Prompt to benchmark",
        value: defaultPrompt,
        placeHolder: "Enter a prompt to test across models...",
      });
      if (!prompt) return;
      const { benchmarkModels } = await import("@hex4code/core/models/model-router");
      const runtimeModels = getConfiguredRuntimeModels("chat");
      const configured = runtimeModels.map((runtime) => runtime.providerId);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Benchmarking models..." },
        async () => {
          const result = await benchmarkModels(prompt, configured, { runtimeModels });
          const panel = vscode.window.createOutputChannel("Benchmark", { log: true });
          panel.appendLine(`Benchmark: ${result.taskId}`);
          panel.appendLine("─".repeat(60));
          for (const r of result.results) {
            panel.appendLine(`${r.error ? "❌" : "✅"} ${r.label} (${r.provider})`);
            panel.appendLine(`   ${r.latencyMs}ms · ${r.responseLength} chars · $${(r.cost || 0).toFixed(6)}`);
            if (r.error) panel.appendLine(`   Error: ${r.error}`);
            panel.appendLine("");
          }
          panel.appendLine("─".repeat(60));
          panel.appendLine(
            `Fastest: ${result.fastest}  |  Cheapest: ${result.cheapest}  |  Longest: ${result.longest}`,
          );
          panel.show();
        },
      );
    }),
  );

  // ── Quota Management ─────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("hex4code.quotaStatus", () => {
      const { checkQuota } = require("@hex4code/core/models/model-router");
      const status = checkQuota();
      const q = status.quota;
      const panel = vscode.window.createOutputChannel("Quota Status", { log: true });
      panel.appendLine("Quota Status");
      panel.appendLine("─".repeat(50));
      panel.appendLine(`Token Limit: ${q.monthlyTokenLimit > 0 ? q.monthlyTokenLimit.toLocaleString() : "unlimited"}`);
      panel.appendLine(`Cost Limit: ${q.monthlyCostLimit > 0 ? `$${q.monthlyCostLimit.toFixed(2)}` : "unlimited"}`);
      panel.appendLine(`Used: ${q.currentTokens.toLocaleString()} tokens / $${q.currentCost.toFixed(6)}`);
      panel.appendLine(`Usage: ${status.usagePercent.toFixed(1)}%`);
      panel.appendLine(`Status: ${status.allowed ? "OK - within limits" : "EXCEEDED"}`);
      panel.show();
    }),
  );

  // ── Route Insights ────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("hex4code.showRouteInsights", () => {
      const { getRouteInsights, getSuggestedWeights } = require("@hex4code/core/models/model-router");
      const insights = getRouteInsights();
      const panel = vscode.window.createOutputChannel("Route Insights", { log: true });
      panel.appendLine("Route Insights");
      panel.appendLine("─".repeat(60));
      if (insights.length === 0) {
        panel.appendLine("No route history data yet.");
      } else {
        for (const i of insights) {
          panel.appendLine(`\n${i.taskType} — ${i.totalCalls} calls`);
          panel.appendLine(
            `  Success: ${(i.successRate * 100).toFixed(0)}%  Latency: ${i.avgLatency.toFixed(0)}ms  Cost: $${i.avgCost.toFixed(6)}`,
          );
          panel.appendLine(`  Best: ${i.bestModel}`);
          const weights = getSuggestedWeights(i.taskType);
          if (weights)
            panel.appendLine(
              `  Suggested weights: cost=${weights.cost} cap=${weights.capability} ctx=${weights.context} speed=${weights.speed}`,
            );
          for (const m of i.modelRankings.slice(0, 3)) {
            panel.appendLine(
              `    ${m.model}: ${(m.successRate * 100).toFixed(0)}% · ${m.avgLatency.toFixed(0)}ms · ${m.calls} calls`,
            );
          }
        }
      }
      panel.show();
    }),
  );

  // ── WebView: Model Configuration Panel ─────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("hex4code.configureModelsWebView", async () => {
      const panel = vscode.window.createWebviewPanel(
        "hex4ModelConfig",
        "HEX4 Model Configuration",
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      const { PROVIDERS } = await import("@hex4code/core/models/provider-registry");
      const currentSettings = readSettingsFile();
      const providerHTML = PROVIDERS.map((p) => {
        const modelsHTML = p.models
          .map(
            (m) =>
              `<tr><td>${m.id}</td><td>${m.label}</td><td>${m.costPer1MInput}/${m.costPer1MOutput}</td><td>${Math.round(m.contextWindow / 1000)}K</td><td>${(m.capabilities || []).join(", ")}</td></tr>`,
          )
          .join("\n");
        const key = getConfiguredProviderKey(currentSettings, p);
        const configuredKey = key ? `${key.slice(0, 8)}...` : "(not set)";
        return `<div class="provider"><h2>${p.name}</h2><p>Key: ${configuredKey}${configuredKey !== "(not set)" ? ' <span class="key-ok">OK</span>' : ' <span class="key-missing">MISSING</span>'}</p><table><tr><th>Model</th><th>Label</th><th>Cost</th><th>Context</th><th>Capabilities</th></tr>${modelsHTML}</table></div>`;
      }).join("\n");
      panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        body { font-family: -apple-system, sans-serif; padding: 20px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }
        h1 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; }
        .provider { margin: 16px 0; padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
        .provider h2 { margin: 0 0 8px 0; } .provider p { margin: 4px 0; font-size: 0.9em; }
        table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
        th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
        th { font-weight: 600; background: var(--vscode-sideBar-background); }
        .key-ok { color: #4CAF50; font-weight: 600; } .key-missing { color: #f44336; }
      </style></head><body><h1>HEX4 Model Configuration</h1>${providerHTML}</body></html>`;
    }),
  );

  // ── Reset All Settings ───────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "hex4code.resetAllSettings",
      async () => {
        const confirm = await vscode.window.showWarningMessage(
          "Reset ALL Hex4Code settings? This will delete all config files, cache, quota, memory, and route history.",
          { modal: true },
          "Reset All",
        );
        if (confirm !== "Reset All") return;

        const homeDir = os.homedir();
        const configDir = path.join(homeDir, ".hex4code");
        const filesToDelete: string[] = [
          path.join(configDir, "settings.json"),
          path.join(configDir, "quota.json"),
          path.join(configDir, "route-history.json"),
          path.join(configDir, "memory.json"),
          path.join(configDir, "cache", "semantic-cache.json"),
        ];

        const projectRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
        if (projectRoot) {
          filesToDelete.push(
            path.join(projectRoot, ".hex4code", "settings.json"),
          );
        }

        let deleted = 0,
          failed = 0;
        for (const filePath of filesToDelete) {
          try {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              deleted++;
            }
          } catch {
            failed++;
          }
        }

        try {
          const { resetGlobalCache } = require(
            "./cache/semantic-cache",
          );
          resetGlobalCache();
        } catch {
          /* ignore */
        }

        vscode.window.showInformationMessage(
          `Hex4Code settings reset: ${deleted} file(s) deleted${failed > 0 ? `, ${failed} failed` : ""}. Restart VS Code to apply.`,
        );
      },
    ),
  );

  // ── Provider Auto-Detection ─────────────────────────────────────────
  (async () => {
    try {
      const configured = getConfiguredProviderIdsFromSettings();
      const configuredSet = new Set(configured);
      const available = PROVIDERS.filter((provider) => !configuredSet.has(provider.id)).map((provider) => ({
        id: provider.id,
        name: provider.name,
        apiKeyEnv: provider.apiKeyEnv,
      }));
      if (!configured.length && available.length > 0) {
        setTimeout(() => {
          vscode.window
            .showInformationMessage(
              `发现 ${available.length} 个 AI Provider 可配置（如 ${available[0].name}）。请在 settings.json 中设置 ${available[0].apiKeyEnv} 或环境变量即可激活。`,
            );
        }, 5000);
      }
    } catch {
      /* background check */
    }
  })();

  // Watch for workspace folder changes to re-detect mode
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const newRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || "";
      if (newRoot) updateModeFromProject(newRoot);
    }),
  );

  // ── Hex4Code Completion Manager ──────────────────────────────────
  // 三层补全架构: L1 模式匹配 + L2 FIM API + L3 RAG/流水线
  // 取代旧的 UnifiedCompletionProvider
  const completionManager = new CompletionManager({
    projectRoot: getWorkspaceRootFromVsCode() || process.cwd(),
    enableL3: true,
    debounceMs: 150,
    maxCompletionTokens: 256,
    enableTcColor: true,
  });

  // 从当前设置中读取 API 凭证配置 FIM 处理器
  try {
    const settings = readResolvedSettingsForUi();
    const route = resolveProviderRoute("fim", {
      model: settings.model,
      routing: settings.taskModels,
      env: { ...settings.env, API_KEY: settings.apiKey ?? settings.env.API_KEY },
      providers: settings.providers,
      legacyApiKeyProvider: settings.legacyApiKeyProvider,
      legacyBaseURLProvider: settings.legacyBaseURLProvider,
      processEnv: process.env,
    });
    if (route.apiKey) {
      completionManager.configureFimHandler(route.apiKey, route.baseURL, route.modelId);
    }
  } catch { /* FIM handler will be configured lazily */ }

  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, completionManager));
  context.subscriptions.push(completionManager);

  // ── Ensure VS Code inlineSuggest is enabled for autocomplete ────────
  // Sets editor.inlineSuggest.enabled: true if not already configured
  try {
    const config = vscode.workspace.getConfiguration("editor");
    const currentSetting = config.inspect("inlineSuggest.enabled");
    if (currentSetting?.globalValue === undefined && currentSetting?.defaultValue !== true) {
      config.update("inlineSuggest.enabled", true, vscode.ConfigurationTarget.Global);
    }
  } catch { /* non-critical */ }

  // ── @mention File Reference Command ────────────────────────────────
  registerFileReferenceCommand(context);

  // ── Diff Viewer Cleanup (remove temp files on deactivate) ──────────
  registerDiffViewerCleanup(context);
}

export function deactivate(): void {
  // 清理全局语义缓存定时器
  try {
    const { resetGlobalCache } = require("../../packages/core/src/cache/semantic-cache");
    resetGlobalCache();
  } catch {
    /* ignore */
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// ── Inline Completion Provider (HEX4 Edition) — 已迁移至 unified-completion.ts ──
