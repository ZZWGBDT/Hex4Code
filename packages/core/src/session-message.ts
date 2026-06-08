/// @file session-message.ts
/// @brief Session system — message construction and tool pairing (extracted from session.ts)
///
/// Pure function collection: does not depend on SessionManager instance state.
/// Functions that need projectRoot receive it as a parameter.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import ejs from "ejs";
import type { ChatCompletionMessageParam, ChatCompletionContentPart } from "openai/resources/chat/completions";
import { supportsMultimodal } from "./common/model-capabilities";
import {
  getExtensionRoot,
  type SessionMessage,
  type SessionMessageRole,
  type MessageMeta,
  type UserPromptContent,
  type SkillInfo,
} from "./session-types";

// ═══════════════════════════════════════════════════════════════
// I. Message Factory (pure functions)
// ═══════════════════════════════════════════════════════════════

export function buildUserMessage(sessionId: string, prompt: UserPromptContent): SessionMessage {
  const now = new Date().toISOString();
  const imageParams =
    prompt.imageUrls
      ?.filter((url) => Boolean(url))
      .map((url) => ({
        type: "image_url",
        image_url: { url },
      })) ?? [];
  return {
    id: crypto.randomUUID(),
    sessionId,
    role: "user",
    content: prompt.text ?? "",
    contentParams: imageParams.length > 0 ? imageParams : null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
  };
}

export function buildSystemMessage(
  sessionId: string,
  content: string,
  contentParams: unknown | null = null,
  visible = false,
  meta?: MessageMeta,
): SessionMessage {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    sessionId,
    role: "system",
    content,
    contentParams,
    messageParams: null,
    compacted: false,
    visible,
    createTime: now,
    updateTime: now,
    meta,
  };
}

export function buildSkillMessage(sessionId: string, content: string, skill: SkillInfo): SessionMessage {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    sessionId,
    role: "system",
    content,
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
    meta: { skill: { ...skill, isLoaded: true } },
  };
}

export function buildAssistantMessage(
  sessionId: string,
  content: string | null,
  toolCalls: unknown[] | null,
  reasoningContent?: string | null,
): SessionMessage {
  const now = new Date().toISOString();
  const hasReasoningContent = reasoningContent != null;
  const messageParams: { tool_calls?: unknown[]; reasoning_content?: string } | null =
    toolCalls || hasReasoningContent ? {} : null;
  if (toolCalls) {
    messageParams!.tool_calls = toolCalls;
  }
  if (hasReasoningContent) {
    messageParams!.reasoning_content = reasoningContent;
  }
  return {
    id: crypto.randomUUID(),
    sessionId,
    role: "assistant",
    content,
    contentParams: null,
    messageParams,
    compacted: false,
    visible: (content || reasoningContent || "").trim() ? true : false,
    createTime: now,
    updateTime: now,
    meta: (toolCalls || (hasReasoningContent && !(content || "").trim())) ? { asThinking: true } : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════
// II. Agent Instruction Loading
// ═══════════════════════════════════════════════════════════════

export function readNonEmptyFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}

export function loadProjectAgentInstructions(projectRoot: string): { content: string; displayPath: string } | null {
  const candidatePaths = [
    {
      absolutePath: path.join(projectRoot, ".hex4code", "AGENTS.md"),
      displayPath: "./.hex4code/AGENTS.md",
    },
    {
      absolutePath: path.join(projectRoot, "AGENTS.md"),
      displayPath: "./AGENTS.md",
    },
  ];
  for (const candidatePath of candidatePaths) {
    const content = readNonEmptyFile(candidatePath.absolutePath);
    if (content) {
      return { content, displayPath: candidatePath.displayPath };
    }
  }
  return null;
}

export function getEffectiveProjectAgentsMdFile(projectRoot: string): string | null {
  return loadProjectAgentInstructions(projectRoot)?.displayPath ?? null;
}

export function loadAgentInstructions(projectRoot: string): string | null {
  const projectInstructions = loadProjectAgentInstructions(projectRoot);
  if (projectInstructions) return projectInstructions.content;
  return readNonEmptyFile(path.join(os.homedir(), ".hex4code", "AGENTS.md"));
}

export function renderInitCommandPrompt(projectRoot: string): string {
  const templatePath = path.join(getExtensionRoot(), "templates", "prompts", "init_command.md.ejs");
  const template = fs.readFileSync(templatePath, "utf8");
  return ejs.render(template, {
    agentsMdFile: getEffectiveProjectAgentsMdFile(projectRoot),
  });
}

// ═══════════════════════════════════════════════════════════════
// III. Tool Messages and Pairing
// ═══════════════════════════════════════════════════════════════

export function buildInterruptedToolResult(toolFunction: unknown | null, reason: string): string {
  const toolName =
    toolFunction && typeof toolFunction === "object" && typeof (toolFunction as { name?: unknown }).name === "string"
      ? (toolFunction as { name: string }).name
      : "tool";
  return JSON.stringify(
    {
      ok: false,
      name: toolName,
      error: reason,
      metadata: { interrupted: true },
    },
    null,
    2,
  );
}

export function buildInterruptedOpenAIToolMessage(
  toolCalls: unknown[],
  toolCallId: string,
): ChatCompletionMessageParam {
  const toolFunction = findToolFunction(toolCalls, toolCallId);
  return {
    role: "tool",
    content: buildInterruptedToolResult(toolFunction, "Previous tool call did not complete."),
    tool_call_id: toolCallId,
  } as ChatCompletionMessageParam;
}

export function getAssistantToolCalls(message: SessionMessage): unknown[] {
  if (message.role !== "assistant") return [];
  const messageParams = message.messageParams as { tool_calls?: unknown[] } | null;
  return Array.isArray(messageParams?.tool_calls) ? messageParams.tool_calls : [];
}

export function getToolCallId(toolCall: unknown): string | null {
  if (!toolCall || typeof toolCall !== "object") return null;
  const id = (toolCall as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}

export function getToolMessageCallId(message: SessionMessage): string | null {
  const messageParams = message.messageParams as { tool_call_id?: unknown } | null;
  const toolCallId = messageParams?.tool_call_id;
  return typeof toolCallId === "string" && toolCallId ? toolCallId : null;
}

export function buildToolPairingKey(assistantIndex: number, toolCallIndex: number): string {
  return `${assistantIndex}:${toolCallIndex}`;
}

export function isInterruptedToolMessage(message: SessionMessage): boolean {
  if (typeof message.content !== "string" || !message.content.trim()) return false;
  try {
    const parsed = JSON.parse(message.content) as { metadata?: { interrupted?: unknown } };
    return parsed.metadata?.interrupted === true;
  } catch {
    return false;
  }
}

export function findToolFunction(toolCalls: unknown[], toolCallId: string): unknown | null {
  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== "object") continue;
    const record = toolCall as { id?: unknown; function?: unknown };
    if (record.id === toolCallId) {
      return record.function ?? null;
    }
  }
  return null;
}

export function formatToolResultSnippet(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}... (total ${value.length} chars)`;
}

export function buildToolResultSnippet(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  const maxLength = 2000;
  try {
    const parsed = JSON.parse(content) as { output?: unknown };
    if (parsed.output !== undefined) {
      if (typeof parsed.output === "string") {
        return formatToolResultSnippet(parsed.output, maxLength);
      }
      return formatToolResultSnippet(JSON.stringify(parsed.output), maxLength);
    }
  } catch {
    console.debug("[session] cannot format tool result, fall back to raw");
  }
  return formatToolResultSnippet(content, maxLength);
}

export function formatToolParamsSnippet(
  toolName: string | null,
  args: Record<string, unknown>,
  projectRoot: string,
): string {
  if (toolName === "bash") {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    const description = typeof args.description === "string" ? args.description.trim() : "";
    if (command && description) return `${command}  # ${description}`;
    if (command) return command;
    if (description) return description;
  }
  const firstKey = Object.keys(args)[0];
  if (!firstKey) return "";
  const value = args[firstKey];
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (toolName === "read" && text.startsWith(projectRoot)) {
    return text.slice(projectRoot.length).replace(/^[\\/]/, "");
  }
  return text;
}

export function buildToolParamsSnippet(toolFunction: unknown | null, projectRoot: string): string {
  if (!toolFunction || typeof toolFunction !== "object") return "";
  const args = (toolFunction as { arguments?: unknown }).arguments;
  const toolName = (toolFunction as { name?: unknown }).name;
  if (typeof args !== "string") return "";
  const trimmed = args.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return formatToolParamsSnippet(
        typeof toolName === "string" ? toolName : null,
        parsed as Record<string, unknown>,
        projectRoot,
      );
    }
  } catch {
    console.debug("[session] cannot parse structured message, fall back to raw");
  }
  return trimmed;
}

export function isInvisibleExecution(content: string): boolean {
  if (!content.trim()) return false;
  try {
    const parsed = JSON.parse(content) as { name?: unknown; ok?: unknown };
    return parsed.name === "bash" && parsed.ok !== true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// IV. 工具消息构建
// ═══════════════════════════════════════════════════════════════

export function buildToolMessage(
  sessionId: string,
  toolCallId: string,
  content: string,
  toolFunction: unknown | null,
  projectRoot: string,
): SessionMessage {
  const now = new Date().toISOString();
  const paramsMd = buildToolParamsSnippet(toolFunction, projectRoot);
  const resultMd = buildToolResultSnippet(content);
  const invisible = isInvisibleExecution(content);
  return {
    id: crypto.randomUUID(),
    sessionId,
    role: "tool",
    content,
    contentParams: null,
    messageParams: { tool_call_id: toolCallId },
    compacted: false,
    visible: !invisible,
    createTime: now,
    updateTime: now,
    meta: {
      function: toolFunction ?? undefined,
      paramsMd,
      resultMd,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// V. 工具消息配对
// ═══════════════════════════════════════════════════════════════

export function findPairableToolMessageIndex(
  messages: SessionMessage[],
  assistantIndex: number,
  toolCallId: string,
  usedToolMessageIndexes: Set<number>,
): number | null {
  let firstMatchingIndex: number | null = null;
  for (let index = assistantIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "tool" || usedToolMessageIndexes.has(index)) continue;
    const candidateToolCallId = getToolMessageCallId(message);
    if (candidateToolCallId !== toolCallId) continue;
    if (firstMatchingIndex == null) firstMatchingIndex = index;
    if (!isInterruptedToolMessage(message)) return index;
  }
  return firstMatchingIndex;
}

export function pairToolMessages(messages: SessionMessage[]): Map<string, number> {
  const pairings = new Map<string, number>();
  const usedToolMessageIndexes = new Set<number>();
  for (let assistantIndex = 0; assistantIndex < messages.length; assistantIndex += 1) {
    const toolCalls = getAssistantToolCalls(messages[assistantIndex]);
    for (let toolCallIndex = 0; toolCallIndex < toolCalls.length; toolCallIndex += 1) {
      const toolCallId = getToolCallId(toolCalls[toolCallIndex]);
      if (!toolCallId) continue;
      const toolIndex = findPairableToolMessageIndex(messages, assistantIndex, toolCallId, usedToolMessageIndexes);
      if (toolIndex == null) continue;
      usedToolMessageIndexes.add(toolIndex);
      pairings.set(buildToolPairingKey(assistantIndex, toolCallIndex), toolIndex);
    }
  }
  return pairings;
}

// ═══════════════════════════════════════════════════════════════
// VI. OpenAI 消息转换
// ═══════════════════════════════════════════════════════════════

export function renderOpenAIMessageContent(message: SessionMessage, projectRoot: string): string {
  if (message.role === "user" && message.content === "/init") {
    return renderInitCommandPrompt(projectRoot);
  }
  return message.content ?? "";
}

export function sessionMessageToOpenAIMessage(
  message: SessionMessage,
  thinkingEnabled: boolean,
  model: string,
  projectRoot: string,
): ChatCompletionMessageParam {
  const content = renderOpenAIMessageContent(message, projectRoot);
  const base: ChatCompletionMessageParam = {
    role: message.role,
    content,
  } as ChatCompletionMessageParam;

  const messageParams = message.messageParams as
    | { tool_calls?: unknown[]; tool_call_id?: string; reasoning_content?: string }
    | null
    | undefined;
  if (messageParams?.tool_calls) {
    (base as { tool_calls?: unknown[] }).tool_calls = messageParams.tool_calls;
  }
  if (messageParams?.tool_call_id) {
    (base as { tool_call_id?: string }).tool_call_id = messageParams.tool_call_id;
  }
  if (typeof messageParams?.reasoning_content === "string") {
    (base as { reasoning_content?: string }).reasoning_content = messageParams.reasoning_content;
  } else if (thinkingEnabled && message.role === "assistant") {
    (base as { reasoning_content?: string }).reasoning_content = "";
  }

  if ((message.role === "user" || message.role === "system") && message.contentParams) {
    const contentParts: ChatCompletionContentPart[] = [];
    if (content) contentParts.push({ type: "text", text: content });
    const params = Array.isArray(message.contentParams) ? message.contentParams : [message.contentParams];
    for (const param of params) {
      const part = param as ChatCompletionContentPart;
      if (part && (part.type !== "image_url" || supportsMultimodal(model))) {
        contentParts.push(part);
      }
    }
    const contentValue: string | ChatCompletionContentPart[] = contentParts.length > 0 ? contentParts : content;
    (base as { content: string | ChatCompletionContentPart[] }).content = contentValue;
  }

  return base;
}

export function buildOpenAIMessages(
  messages: SessionMessage[],
  thinkingEnabled: boolean,
  model: string,
  projectRoot: string,
): ChatCompletionMessageParam[] {
  const activeMessages = messages.filter((message) => !message.compacted);
  const toolPairings = pairToolMessages(activeMessages);
  const openAIMessages: ChatCompletionMessageParam[] = [];

  for (let index = 0; index < activeMessages.length; index += 1) {
    const message = activeMessages[index];
    if (message.role === "tool") continue;
    openAIMessages.push(sessionMessageToOpenAIMessage(message, thinkingEnabled, model, projectRoot));

    const toolCalls = getAssistantToolCalls(message);
    if (toolCalls.length === 0) continue;

    for (let toolCallIndex = 0; toolCallIndex < toolCalls.length; toolCallIndex += 1) {
      const toolCallId = getToolCallId(toolCalls[toolCallIndex]);
      if (!toolCallId) continue;
      const pairedToolIndex = toolPairings.get(buildToolPairingKey(index, toolCallIndex));
      if (pairedToolIndex != null) {
        openAIMessages.push(
          sessionMessageToOpenAIMessage(activeMessages[pairedToolIndex], thinkingEnabled, model, projectRoot),
        );
        continue;
      }
      openAIMessages.push(buildInterruptedOpenAIToolMessage(toolCalls, toolCallId));
    }
  }

  return openAIMessages;
}
