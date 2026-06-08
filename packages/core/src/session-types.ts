/// @file session-types.ts
/// @brief Session system — type definitions and pure helper functions
///
/// Standalone module extracted from session.ts. All consumers only need to import type.
/// session.ts re-exports all exports to ensure backward compatibility.

import * as path from "path";
import { fileURLToPath } from "url";
import { isDeepSeekV4Model } from "./common/model-capabilities";
import { calculateCost } from "./models/model-router";
import type { ToolExecutionResult, CreateOpenAIClient } from "./tools/executor";
import type { McpServerConfig } from "./settings";

// ── Constants ─────────────────────────────────────────────────────────

export const MAX_SESSION_ENTRIES = 50;
const DEFAULT_COMPACT_PROMPT_TOKEN_THRESHOLD = 128 * 1024;
const DEEPSEEK_V4_COMPACT_PROMPT_TOKEN_THRESHOLD = 512 * 1024;

// ── Helper constants (used externally) ───────────────────────────


// ── 类型定义 ──────────────────────────────────────────────────────

/** UI 抽象接口 — 解耦 Ink/VSCode */
export interface SessionUI {
  onMessage: (msg: SessionMessage) => void;
  onToolResult: (toolCallId: string, content: string, result: ToolExecutionResult) => void;
  onError: (error: string) => void;
  onProcessStart?: (processId: string | number, command: string) => void;
  onProcessExit?: (processId: string | number) => void;
  onSessionEntryUpdated?: (entry: SessionEntry) => void;
  /** Agent mode getter — injected by VSCode extension for mode-aware prompts */
  getAgentMode?: () => "hex4" | "general";
  ui?: SessionUI;
}

export type SessionStatus = "failed" | "pending" | "processing" | "waiting_for_user" | "completed" | "interrupted";

export type SessionEntry = {
  id: string;
  summary: string | null;
  assistantReply: string | null;
  assistantThinking: string | null;
  assistantRefusal: string | null;
  toolCalls: unknown[] | null;
  status: SessionStatus;
  failReason: string | null;
  usage: unknown | null;
  totalCost: number; // 累计成本（美元）
  activeTokens: number;
  createTime: string;
  updateTime: string;
  processes: Map<string, { startTime: string; command: string }> | null;
};

export type SessionsIndex = {
  version: 1;
  entries: SessionEntry[];
  originalPath: string;
};

export type SessionMessageRole = "system" | "user" | "assistant" | "tool";

export type MessageMeta = {
  function?: unknown;
  paramsMd?: string;
  resultMd?: string;
  asThinking?: boolean;
  isSummary?: boolean;
  isModelChange?: boolean;
  skill?: SkillInfo;
};

export type SessionMessage = {
  id: string;
  sessionId: string;
  role: SessionMessageRole;
  content: string | null;
  contentParams: unknown | null;
  messageParams: unknown | null;
  compacted: boolean;
  visible: boolean;
  createTime: string;
  updateTime: string;
  meta?: MessageMeta;
  html?: string;
};

export type UserPromptContent = {
  text?: string;
  imageUrls?: string[];
  skills?: SkillInfo[];
};

export type SkillInfo = {
  name: string;
  path: string;
  description: string;
  isLoaded?: boolean;
};

export type LlmStreamProgress = {
  requestId: string;
  sessionId?: string;
  startedAt: string;
  estimatedTokens: number;
  formattedTokens: string;
  phase: "start" | "update" | "end";
};

/** SessionManager 构造选项（内部类型，不要求导出） */
export type SessionManagerOptions = {
  projectRoot: string;
  createOpenAIClient: CreateOpenAIClient;
  getResolvedSettings: () => { model: string; webSearchTool?: string; mcpServers?: Record<string, McpServerConfig> };
  renderMarkdown: (text: string) => string;
  onAssistantMessage: (message: SessionMessage, shouldConnect: boolean) => void;
  onSessionEntryUpdated?: (entry: SessionEntry) => void;
  onLlmStreamProgress?: (progress: LlmStreamProgress) => void;
  ui?: SessionUI;
};

/** LLM 调试选项 */
export type ChatCompletionDebugOptions = {
  enabled?: boolean;
  location: string;
  baseURL?: string;
  params?: Record<string, unknown>;
};

// ── 阈值函数 ────────────────────────────────────────────────────

/**
 * 根据模型计算压缩阈值（取 Context Window 的 80%）。
 * 动态读取 model-router 避免循环依赖。
 */
export function getCompactPromptTokenThreshold(model: string): number {
  try {
    const { getContextWindow } = require("./models/model-router");
    const windowSize = getContextWindow(model);
    if (windowSize > 0) {
      return Math.floor(windowSize * 0.8);
    }
  } catch {
    /* fallback */
  }
  return isDeepSeekV4Model(model) ? DEEPSEEK_V4_COMPACT_PROMPT_TOKEN_THRESHOLD : DEFAULT_COMPACT_PROMPT_TOKEN_THRESHOLD;
}

// ── 纯辅助函数 ──────────────────────────────────────────────────

export function isUsageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function summarizeCompletionOptions(options?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!options) return undefined;
  return {
    ...options,
    signal: options.signal instanceof AbortSignal ? { aborted: options.signal.aborted } : options.signal,
  };
}

export function addUsageValue(current: unknown, next: unknown): unknown {
  if (typeof next === "number") {
    return (typeof current === "number" ? current : 0) + next;
  }
  if (isUsageRecord(next)) {
    const currentRecord = isUsageRecord(current) ? current : {};
    const result: Record<string, unknown> = { ...currentRecord };
    for (const [key, value] of Object.entries(next)) {
      result[key] = addUsageValue(currentRecord[key], value);
    }
    return result;
  }
  return next;
}

export function accumulateUsage(current: unknown | null, next: unknown | null | undefined): unknown | null {
  if (next == null) return current ?? null;
  return addUsageValue(current, next);
}

export function getExtensionRoot(): string {
  if (typeof __dirname !== "undefined") {
    return path.resolve(__dirname, "..");
  }
  const currentFilePath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFilePath), "..");
}

export function getTotalTokens(usage: unknown | null | undefined): number {
  if (!isUsageRecord(usage)) return 0;
  const totalTokens = usage.total_tokens;
  return typeof totalTokens === "number" ? totalTokens : 0;
}

/**
 * 从 LLM 响应 usage 中提取 token 数并计算成本。
 * 返回以美元为单位的成本值，无响应或无法计算时返回 0。
 */
export function calculateCostFromUsage(modelId: string, usage: unknown | null | undefined): number {
  if (!usage || !isUsageRecord(usage)) return 0;
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const { totalCost } = calculateCost(modelId, promptTokens, completionTokens);
  return totalCost;
}
