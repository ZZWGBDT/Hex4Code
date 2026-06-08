import type OpenAI from "openai";
import type { ReasoningEffort } from "../settings";
import { handleAskUserQuestionTool } from "./ask-user-question-handler";
import { handleBashTool } from "./bash-handler";
import { handleBuildTool } from "./build-handler";
import { handleCodeIndexTool } from "./code-index-handler";
import { handleEditTool } from "./edit-handler";
import { handleReadTool } from "./read-handler";
import { handleTestTool } from "./test-handler";
import { handleGitTool } from "./git-handler";
import { handleWebSearchTool } from "./web-search-handler";
import { handleWriteTool } from "./write-handler";
import type { McpManager } from "../mcp/mcp-manager";
// ── Compact protocol & pipeline orchestration ─────────────────────

import { dualTritCompress } from "../compression/dual-trit";
import {
  detectPipeline,
  type PipelineStage,
  buildPipelineSummary,
  getPipelineTcContext,
} from "../orchestration/hex4code-pipeline";
export type CreateOpenAIClient = () => {
  client: OpenAI | null;
  model: string;
  baseURL?: string;
  thinkingEnabled: boolean;
  reasoningEffort?: ReasoningEffort;
  debugLogEnabled?: boolean;
  notify?: string;
  webSearchTool?: string;
  env?: Record<string, string>;
  machineId?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ToolExecutionContext = {
  sessionId: string;
  projectRoot: string;
  toolCall: ToolCall;
  createOpenAIClient?: CreateOpenAIClient;
  onProcessStart?: (processId: string | number, command: string) => void;
  onProcessExit?: (processId: string | number) => void;
};

export type ToolExecutionHooks = {
  onProcessStart?: (processId: string | number, command: string) => void;
  onProcessExit?: (processId: string | number) => void;
  shouldStop?: () => boolean;
};

// ── Confidence / Trust Chain types ────────────────────────────────
export type TCType = "TC_NONE" | "TC_CARRY" | "TC_UNCERTAIN" | "TC_MIXED";

export type TCLink = {
  source: string; // tool name that produced this TC
  tc: TCType;
  description?: string; // human-readable explanation
};

/** Merge multiple TC states into one (order-independent). SCALE: MIXED > UNCERTAIN > CARRY > NONE */
export function mergeTC(states: TCType[]): TCType {
  let hasMixed = false;
  let hasUncertain = false;
  let hasCarry = false;
  for (const s of states) {
    if (s === "TC_MIXED") hasMixed = true;
    else if (s === "TC_UNCERTAIN") hasUncertain = true;
    else if (s === "TC_CARRY") hasCarry = true;
    // TC_NONE is transparent
  }
  if (hasMixed) return "TC_MIXED";
  if (hasUncertain) return "TC_UNCERTAIN";
  if (hasCarry) return "TC_CARRY";
  return "TC_NONE";
}

/** Prepend upstream TC links to a tool result's chain and recompute its composite tcState. */
export function propagateTC(result: ToolExecutionResult, upstreamChain: TCLink[]): ToolExecutionResult {
  if (upstreamChain.length === 0) return result;
  const allStates: TCType[] = [...upstreamChain.map((l) => l.tc)];
  if (result.tcState) allStates.push(result.tcState);
  return {
    ...result,
    tcState: mergeTC(allStates),
    tcChain: [...upstreamChain, ...(result.tcChain || [])],
  };
}

export type ToolExecutionResult = {
  ok: boolean;
  name: string;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  awaitUserResponse?: boolean;
  followUpMessages?: ToolExecutionFollowUpMessage[];
  /** Confidence / Trust Chain state: marks the certainty level of this tool result */
  tcState?: TCType;
  /** Optional chain of TC states from upstream tool calls that propagated to this result */
  tcChain?: TCLink[];
};

export type ToolExecutionFollowUpMessage = {
  role: "system";
  content: string;
  contentParams?: unknown | null;
};

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<ToolExecutionResult>;

export type ToolCallExecution = {
  toolCallId: string;
  content: string;
  result: ToolExecutionResult;
};

export class ToolExecutor {
  private readonly projectRoot: string;
  private readonly createOpenAIClient?: CreateOpenAIClient;
  private readonly mcpManager?: McpManager;
  private readonly toolHandlers = new Map<string, ToolHandler>();

  constructor(projectRoot: string, createOpenAIClient?: CreateOpenAIClient, mcpManager?: McpManager) {
    this.projectRoot = projectRoot;
    this.createOpenAIClient = createOpenAIClient;
    this.mcpManager = mcpManager;
    this.registerToolHandlers();
  }

  async executeToolCalls(
    sessionId: string,
    toolCalls: unknown[],
    hooks?: ToolExecutionHooks,
  ): Promise<ToolCallExecution[]> {
    const parsedCalls = toolCalls
      .map((toolCall) => this.parseToolCall(toolCall))
      .filter((toolCall): toolCall is ToolCall => Boolean(toolCall));

    const executions: ToolCallExecution[] = [];

    // Group independent calls for parallel execution
    const readToolNames = new Set(["read", "codeIndex"]);
    const allReads = parsedCalls.filter((c) => readToolNames.has(c.function.name));
    const others = parsedCalls.filter((c) => !readToolNames.has(c.function.name));

    // Run independent read/codeIndex calls in parallel
    if (allReads.length > 1) {
      const results = await Promise.allSettled(allReads.map((tc) => this.executeToolCall(sessionId, tc, hooks)));
      for (let i = 0; i < allReads.length; i++) {
        const r = results[i];
        executions.push({
          toolCallId: allReads[i].id,
          content:
            r.status === "fulfilled"
              ? this.formatToolResult(r.value)
              : JSON.stringify({ ok: false, error: r.reason?.message || String(r.reason) }),
          result:
            r.status === "fulfilled"
              ? r.value
              : { ok: false, name: allReads[i].function.name, error: r.reason?.message || String(r.reason) },
        });
      }
    } else if (allReads.length === 1) {
      const result = await this.executeToolCall(sessionId, allReads[0], hooks);
      executions.push({ toolCallId: allReads[0].id, content: this.formatToolResult(result), result });
    }

    // ── TC propagation chain for serial calls ────────────────────────
    const turnChain: TCLink[] = [];

    // Run remaining (potentially stateful) calls serially with TC propagation
    for (const toolCall of others) {
      if (hooks?.shouldStop?.()) break;
      const rawResult = await this.executeToolCall(sessionId, toolCall, hooks);
      const propagated = propagateTC(rawResult, turnChain);
      // Accumulate this step's TC for subsequent serial calls
      if (propagated.tcState && propagated.tcState !== "TC_NONE") {
        turnChain.push({ source: toolCall.function.name, tc: propagated.tcState });
      }
      executions.push({ toolCallId: toolCall.id, content: this.formatToolResult(propagated), result: propagated });
      if (hooks?.shouldStop?.()) break;
    }

    // ── Turn-level TC summary ────────────────────────────────────────
    const allTcStates: TCType[] = [];
    for (const exec of executions) {
      if (exec.result.tcState) allTcStates.push(exec.result.tcState);
    }
    const turnTcState = allTcStates.length > 0 ? mergeTC(allTcStates) : undefined;
    (executions as any)._tcSummary = { turnTcState, chain: turnChain };

    // ── Pipeline detection ─────────────────────────────────────────────
    const pipeline = detectPipeline(parsedCalls);
    if (pipeline && pipeline.length > 1) {
      for (const stage of pipeline) {
        const exec = executions.find((e) => e.toolCallId === stage.toolCall.id);
        if (exec) stage.result = exec.result;
      }
      const pipelineTcCtx = getPipelineTcContext(pipeline);
      const pipelineSummary = buildPipelineSummary(pipeline);
      (executions as any)._pipelineSummary = pipelineSummary;
      if (pipelineTcCtx.length > 0) {
        (executions as any)._tcSummary.chain = [...((executions as any)._tcSummary.chain || []), ...pipelineTcCtx];
      }
    }

    return executions;
  }

  private registerToolHandlers(): void {
    this.toolHandlers.set("bash", handleBashTool);
    this.toolHandlers.set("read", handleReadTool);
    this.toolHandlers.set("write", handleWriteTool);
    this.toolHandlers.set("edit", handleEditTool);
    this.toolHandlers.set("AskUserQuestion", handleAskUserQuestionTool);
    this.toolHandlers.set("WebSearch", handleWebSearchTool);
    this.toolHandlers.set("build", handleBuildTool);
    this.toolHandlers.set("codeIndex", handleCodeIndexTool);
    this.toolHandlers.set("test", handleTestTool);
    this.toolHandlers.set("git", handleGitTool);
  }

  private parseToolCall(toolCall: unknown): ToolCall | null {
    if (!toolCall || typeof toolCall !== "object") {
      return null;
    }

    const record = toolCall as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };

    if (typeof record.id !== "string") {
      return null;
    }

    const functionRecord = record.function;
    if (!functionRecord || typeof functionRecord !== "object") {
      return null;
    }

    if (typeof functionRecord.name !== "string") {
      return null;
    }

    const rawArguments = typeof functionRecord.arguments === "string" ? functionRecord.arguments : "";

    return {
      id: record.id,
      type: "function",
      function: {
        name: functionRecord.name,
        arguments: rawArguments,
      },
    };
  }

  private async executeToolCall(
    sessionId: string,
    toolCall: ToolCall,
    hooks?: ToolExecutionHooks,
  ): Promise<ToolExecutionResult> {
    const toolName = toolCall.function.name;
    const handler = this.toolHandlers.get(toolName);
    if (!handler) {
      // Try MCP tools
      if (this.mcpManager?.isMcpTool(toolName)) {
        const parsedArgs = this.parseToolArguments(toolCall.function.arguments);
        const args = parsedArgs.ok ? parsedArgs.args : {};
        return this.mcpManager.executeMcpTool(toolName, args);
      }
      return {
        ok: false,
        name: toolName,
        error: `Unknown tool: ${toolName}`,
      };
    }

    const parsedArgs = this.parseToolArguments(toolCall.function.arguments);
    if (!parsedArgs.ok) {
      return {
        ok: false,
        name: toolName,
        error: parsedArgs.error,
      };
    }

    // Exponential retry for transient failures
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await handler(parsedArgs.args, {
          sessionId,
          projectRoot: this.projectRoot,
          toolCall,
          createOpenAIClient: this.createOpenAIClient,
          onProcessStart: hooks?.onProcessStart,
          onProcessExit: hooks?.onProcessExit,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isTransient =
          message.includes("ETIMEDOUT") ||
          message.includes("ECONNRESET") ||
          message.includes("ENOENT") ||
          message.includes("EACCES");
        if (attempt < maxRetries && isTransient) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        return {
          ok: false,
          name: toolName,
          error: message,
        };
      }
    }
    // Unreachable – fallback
    return { ok: false, name: toolName, error: "Unexpected retry exhaustion" };
  }

  private parseToolArguments(
    rawArguments: string,
  ): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
    if (!rawArguments) {
      return { ok: true, args: {} };
    }

    try {
      const parsed = JSON.parse(rawArguments);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "InputParseError: Tool arguments must be a JSON object." };
      }
      return { ok: true, args: parsed as Record<string, unknown> };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error:
          `InputParseError: Failed to parse tool arguments: ${message}. ` +
          "Ensure the tool call arguments are valid JSON. Prefer Edit over Write for large existing-file changes.",
      };
    }
  }

  private formatToolResult(result: ToolExecutionResult): string {
    const payload: Record<string, unknown> = {
      ok: result.ok,
      name: result.name,
    };

    if (typeof result.output !== "undefined") {
      payload.output = result.output;
    }

    if (result.error) {
      payload.error = result.error;
    }

    // Confidence state: always include if set, so downstream LLM can assess result certainty
    if (result.tcState) {
      payload.tcState = result.tcState;
    }
    if (result.tcChain && result.tcChain.length > 0) {
      payload.tcChain = result.tcChain;
    }

    if (result.metadata && Object.keys(result.metadata).length > 0) {
      payload.metadata = result.metadata;
    }

    if (result.awaitUserResponse === true) {
      payload.awaitUserResponse = true;
    }

    // Compact protocol compression: compact field names + TC short codes (~40% fewer tokens)
    const compressed = dualTritCompress(payload);
    return JSON.stringify(compressed, null, 2);
  }
}
