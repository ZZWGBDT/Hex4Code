/**
 * @file index.ts
 * @brief Completion system — public exports
 *
 * Usage:
 *   import { CompletionManager } from "@hex4code/core/completion";
 *   import type { FimContext, CompletionItem } from "@hex4code/core/completion/types";
 */

// Main entry
export { CompletionManager } from "./completion-manager";
export { CompletionRouter } from "./completion-router";
export { CompletionDebouncer } from "./completion-debounce";
export { TcEvaluator } from "./completion-tc";
export { CompletionCache } from "./completion-cache";

// L1
export { L1PatternIndex } from "./l1-pattern-index";
export { PatternTrie } from "./l1-pattern-trie";

// L2
export { FimHandler } from "./l2-fim-handler";
export { FimContextBuilder } from "./l2-fim-context";
export { buildPrompt, detectFimModelType } from "./l2-fim-prompt";

// L3
export { L3AgentCompletion } from "./l3-agent-completion";

// 类型
export type {
  PatternMatch,
  FimContext,
  FimScope,
  RelevantSymbol,
  KnowledgeEntry,
  ErrorPatternInfo,
  PipelineStageContext,
  CompletionItem,
  CompletionSource,
  CompletionCacheEntry,
  CompletionManagerOptions,
} from "./types";

// 常量
export {
  DEFAULT_COMPLETION_CONFIG,
  LANGUAGE_HINTS,
  LOCAL_PATTERNS,
  HEX4_PATTERNS,
  HEX4_STRUCT_TYPES,
  HEX4_HEADERS,
  PIPELINE_STAGE_PATTERNS,
} from "./types";
