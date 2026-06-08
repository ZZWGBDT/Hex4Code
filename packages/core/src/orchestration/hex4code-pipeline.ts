/**
 * Hex4Code Pipeline Orchestration
 *
 * Detects tool call patterns and orchestrates them as ordered pipelines
 * with confidence (TC) propagation across stages.
 *
 *   Stage  | Tool      | Description
 *   ───────|───────────|─────────────────────────────────
 *   BUILD  | build     | Compile project, generate artifacts
 *   TEST   | test      | Execute tests, verify correctness
 *   INDEX  | codeIndex | Update code index, accumulate knowledge
 *   GIT    | git       | Git operations (status/diff/commit)
 *
 * Pipeline patterns:
 *   - BUILD → TEST                       Standard CI
 *   - BUILD → TEST → INDEX               Full dev pipeline
 *   - GIT (standalone)                   Version control
 *
 * TC propagation across pipeline stages:
 *   build(fail:U) → test(result:U) → codeIndex(result:CARRY)
 *   → Final TC: merge([U, CARRY]) = UNCERTAIN
 */

import type { ToolCall, ToolExecutionResult, TCType, TCLink } from "../tools/executor";
import { mergeTC } from "../tools/executor";

// ── Pipeline stage identifiers ────────────────────────────────────

export type PipelineSymbol = "BUILD" | "TEST" | "INDEX" | "GIT";

export const TOOL_TO_SYMBOL: Record<string, PipelineSymbol> = {
  build: "BUILD",
  test: "TEST",
  codeIndex: "INDEX",
  git: "GIT",
};

export const SYMBOL_TO_TOOL: Record<PipelineSymbol, string> = {
  BUILD: "build",
  TEST: "test",
  INDEX: "codeIndex",
  GIT: "git",
};

export const SYMBOL_NAMES: Record<PipelineSymbol, string> = {
  BUILD: "Build (Generation)",
  TEST: "Test (Verification)",
  INDEX: "Index (Accumulation)",
  GIT: "Git (Version Control)",
};

export type PipelineStage = {
  symbol: PipelineSymbol;
  toolName: string;
  toolCall: ToolCall;
  result?: ToolExecutionResult;
};

/**
 * Detect if a set of tool calls forms a known pipeline pattern.
 *
 * Returns null if no pattern detected, or ordered stages to execute.
 */
export function detectPipeline(toolCalls: ToolCall[]): PipelineStage[] | null {
  const names = toolCalls.map((tc) => tc.function.name);

  // Priority 1: Full pipeline — build → test → codeIndex
  if (names.includes("build") && names.includes("test") && names.includes("codeIndex")) {
    const stages: PipelineStage[] = [];
    for (const name of ["build", "test", "codeIndex"]) {
      const tc = toolCalls.find((t) => t.function.name === name);
      if (tc) {
        stages.push({
          symbol: TOOL_TO_SYMBOL[name],
          toolName: name,
          toolCall: tc,
        });
      }
    }
    return stages;
  }

  // Priority 2: Standard CI pipeline — build → test
  if (names.includes("build") && names.includes("test")) {
    const stages: PipelineStage[] = [];
    for (const name of ["build", "test"]) {
      const tc = toolCalls.find((t) => t.function.name === name);
      if (tc) {
        stages.push({
          symbol: TOOL_TO_SYMBOL[name],
          toolName: name,
          toolCall: tc,
        });
      }
    }
    return stages;
  }

  // Priority 3: Standalone tool calls
  for (const name of ["test", "codeIndex", "git"]) {
    if (names.includes(name) && names.length === 1) {
      const tc = toolCalls.find((t) => t.function.name === name)!;
      return [
        {
          symbol: TOOL_TO_SYMBOL[name],
          toolName: name,
          toolCall: tc,
        },
      ];
    }
  }

  return null;
}

/**
 * Build a TC-aware pipeline summary message describing the orchestration.
 * This is injected as a system message for the LLM to understand the pipeline.
 */
export function buildPipelineSummary(stages: PipelineStage[]): string {
  const symbolChain = stages.map((s) => s.symbol).join(" -> ");
  const toolChain = stages.map((s) => s.toolName).join(" -> ");
  const symbolNames = stages.map((s) => SYMBOL_NAMES[s.symbol]).join(" -> ");

  const tcStates: TCType[] = stages.map((s) => s.result?.tcState).filter((t): t is TCType => t !== undefined);

  let summary = `[Pipeline] ${symbolChain} (${toolChain})\n  Stages: ${symbolNames}`;

  if (tcStates.length > 0) {
    const finalTc = mergeTC(tcStates);
    summary += `\n  TC propagation: ${tcStates.join(" -> ")} -> Final: ${finalTc}`;
  }

  return summary;
}

/**
 * Get the TC propagation rule for a pipeline stage.
 * Used to attach upstream TC links to downstream stage results.
 */
export function getPipelineTcContext(stages: PipelineStage[]): TCLink[] {
  const chain: TCLink[] = [];
  for (const stage of stages) {
    if (stage.result?.tcState && stage.result.tcState !== "TC_NONE") {
      chain.push({
        source: stage.toolName,
        tc: stage.result.tcState,
        description: SYMBOL_NAMES[stage.symbol],
      });
    }
  }
  return chain;
}
