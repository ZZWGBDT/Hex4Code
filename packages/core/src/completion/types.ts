/**
 * @file types.ts
 * @brief Hex4Code completion system — unified type definitions
 *
 * Defines all data structures for L1/L2/L3 tiered completions,
 * Aligns with TC types in executor.ts and routing types in model-router.ts.
 */

import type { TCType } from "../tools/executor";

// ── 补全源标识 ──────────────────────────────────────────────────

/** 补全来源层级 */
export type CompletionSource = "L1-pattern" | "L2-fim" | "L2-local" | "L3-rag" | "L3-pipeline" | "L3-error-pattern";

// ── L1 模式补全 ──────────────────────────────────────────────────

/** L1 Trie 树的单个匹配项 */
export interface PatternMatch {
  /** 要追加到光标后的文本（不含已键入前缀） */
  suffix: string;
  /** 完整匹配文本（用于展示） */
  fullText: string;
  /** TC 置信度 */
  tc: TCType;
  /** 模式来源 */
  source: CompletionSource;
  /** 匹配优先级 (0=最高) */
  priority: number;
  /** 语言过滤（空 = 全语言） */
  languages?: string[];
  /** 简要说明 */
  description?: string;
}

/** L1 模式索引配置 */
export interface PatternIndexConfig {
  /** 项目根目录，用于自动发现 HEX4 SDK 模式 */
  projectRoot: string;
  /** 额外模式文件路径 */
  extraPatternPaths?: string[];
}

// ── L2 FIM 补全 ──────────────────────────────────────────────────

/** FIM 上下文 — 完整的三段式信息 */
export interface FimContext {
  /** 光标前文本 (Prefix) */
  prefix: string;
  /** 光标后文本 (Suffix) */
  suffix: string;
  /** 语言标识 */
  language: string;
  /** 当前作用域信息 */
  scope?: FimScope;
  /** RAG 检索到的相关符号 */
  relevantSymbols?: RelevantSymbol[];
  /** 知识库条目 */
  knowledgeEntries?: KnowledgeEntry[];
  /** 错误模式（防错补全） */
  errorPatterns?: ErrorPatternInfo[];
  /** 流水线阶段上下文 */
  pipelineContext?: PipelineStageContext;
  /** DualTrit 压缩后的原始上下文（仅内部使用） */
  compressedPrefix?: string;
  compressedSuffix?: string;
}

/** 函数/方法作用域 */
export interface FimScope {
  functionName?: string;
  parameters?: string[];
  locals?: string[];
  returnType?: string;
  /** 类名（如果作用域在类内部） */
  className?: string;
  /** 可见性 (public/private/protected) */
  visibility?: string;
}

/** RAG 检索到的符号定义 */
export interface RelevantSymbol {
  name: string;
  definition: string;
  file: string;
  line: number;
  tcScore: TCType;
  kind: string;
}

/** 知识库条目 */
export interface KnowledgeEntry {
  title: string;
  content: string;
  category: string;
  score: number;
}

/** 历史错误模式 */
export interface ErrorPatternInfo {
  errorType: string;
  fixSequence: string[];
  finalStatus: "fixed" | "unresolved";
  relevance: number;
}

/** 流水线阶段上下文 */
export interface PipelineStageContext {
  stage: "BUILD" | "TEST" | "INDEX" | "GIT" | null;
  lastTcState?: TCType;
  lastToolName?: string;
}

// ── 统一补全省略项 ─────────────────────────────────────────────────

/** 补全省略项（合并 L1/L2/L3 结果） */
export interface CompletionItem {
  /** 要插入的文本 */
  text: string;
  /** 光标偏移（相对于插入文本的结尾，负值表示左移） */
  cursorOffset?: number;
  /** TC 置信度 */
  tc: TCType;
  /** 来源层级 */
  source: CompletionSource;
  /** 排序分数（越高越优先） */
  score: number;
  /** 简要说明 */
  description?: string;
  /** 额外展示信息 */
  detail?: string;
}

// ── 补全管理器选项 ─────────────────────────────────────────────

export interface CompletionManagerOptions {
  /** 项目根目录 */
  projectRoot: string;
  /** 是否启用 L3 (RAG/流水线) 补全 */
  enableL3?: boolean;
  /** FIM 模型 ID（留空则由路由自动选择） */
  fimModel?: string;
  /** 去抖延迟 (ms) */
  debounceMs?: number;
  /** 最大补全 Token 数 */
  maxCompletionTokens?: number;
  /** 补全温度 */
  temperature?: number;
  /** 是否启用 TC 着色 */
  enableTcColor?: boolean;
  /** 跳过补全的语言 */
  skipLanguages?: Set<string>;
  /** 最小触发长度 */
  minTriggerLength?: number;
}

// ── 补全缓存 ──────────────────────────────────────────────────

export interface CompletionCacheEntry {
  /** 缓存键 (prefix+suffix+language+model 的哈希) */
  key: string;
  /** 缓存的补全省略项 */
  items: CompletionItem[];
  /** 创建时间戳 */
  createdAt: number;
  /** TTL (ms) */
  ttl: number;
  /** 访问计数 */
  accessCount: number;
  /** 上次访问时间 */
  lastAccessed: number;
}

// ── VS Code 集成类型 ──────────────────────────────────────────

/** VS Code 内联补全项的包装 */
export interface InlineCompletionWrapper {
  /** 补全文本 */
  insertText: string;
  /** 范围（可选，默认为当前光标位置） */
  range?: { startLine: number; startCol: number; endLine: number; endCol: number };
  /** 补全来源标签 */
  sourceLabel: string;
}

// ── 默认配置 ──────────────────────────────────────────────────

export const DEFAULT_COMPLETION_CONFIG = {
  debounceMs: 150,
  maxCompletionTokens: 256,
  temperature: 0.1,
  maxItemsPerSource: 3,
  maxTotalItems: 5,
  enableL3: true,
  enableTcColor: true,
  /** 跳过补全的语言 */
  skipLanguages: new Set(["json", "yaml", "markdown", "html", "css"]),
  /** 最小触发长度 */
  minTriggerLength: 2,
  /** 缓存 TTL (ms) */
  cacheTtl: 60_000,
  /** 缓存最大条目 */
  cacheMaxEntries: 500,
} as const;

// ── 语言提示映射（用于 FIM Prompt） ──────────────────────────────

export const LANGUAGE_HINTS: Record<string, string> = {
  python: "Python 3",
  javascript: "JavaScript (ES2022+)",
  typescript: "TypeScript (strict mode)",
  go: "Go 1.22+",
  rust: "Rust 2021 edition",
  java: "Java 21",
  c: "C11",
  cpp: "C++20",
  csharp: "C# 12",
  ruby: "Ruby 3.3+",
  php: "PHP 8.3+",
  swift: "Swift 5.9+",
  kotlin: "Kotlin 2.0+",
  scala: "Scala 3",
};

/** 通用本地补全模式（L2 fallback） */
export const LOCAL_PATTERNS: Record<string, string[]> = {
  "if ": ["if (", "if True:"],
  "for ": ["for (", "for x in "],
  "while ": ["while (", "while True:"],
  try: ["try:", "try {"],
  catch: ["catch (e)", "catch (Exception e)"],
  "def ": ["def "],
  "class ": ["class "],
  "import ": ["import ", "import React from 'react'"],
  "from ": ["from "],
  return: ["return "],
  "async ": ["async function", "async def", "async () =>"],
  "const ": ["const ", "const { } = ", "const [", "const "],
  "let ": ["let ", "let { } = "],
  "var ": ["var "],
  "function ": ["function ", "function("],
  "=>": [" => ", " => {"],
  "console.": ["console.log(", "console.error(", "console.warn("],
  "fmt.": ["fmt.Println(", "fmt.Sprintf(", "fmt.Errorf("],
  print: ["print(", 'print(f"', "print!("],
};

/** HEX4 SDK 模式（用于 C/C++ 项目的自动补全） */
export const HEX4_PATTERNS: Record<string, string[]> = {
  hex4_: ["hex4_tc_propagate(", "hex4_sm2_sign(", "hex4_model_forward(", "hex4_vm_exec("],
  TC_: ["TC_NONE", "TC_CARRY", "TC_UNCERTAIN", "TC_MIXED"],
  ternary_: ["ternary_core_lite(", "ternary_register_file("],
  Hex4: ["Hex4DualTrit", "Hex4IRGraph", "Hex4Session", "Hex4VMInstance"],
  "Hex4DualTrit.": [".value", ".tc_type", ".raw"],
  tc_: ["tc_add(", "tc_mul(", "tc_propagate(", "tc_merge("],
  sm2_: ["sm2_sign(", "sm2_verify(", "sm2_encrypt(", "sm2_decrypt("],
};

export const HEX4_STRUCT_TYPES = ["TCMatrix", "BalancedTrit", "TCType", "Hex4Tensor", "Hex4Node"];

export const HEX4_HEADERS = [
  "hex4_nn_vm_types.h",
  "hex4_nn_compiler.h",
  "hex4_nn_vm.h",
  "hex4_sm2.h",
  "hex4_balanced_ops.h",
];

/** 流水线阶段补全模式 */
export const PIPELINE_STAGE_PATTERNS: Record<string, string[]> = {
  "T(": ['T("test_name", = PASS', 'T("test_name", = FAIL'],
  "OK(": ["OK()", 'OK("expected", "actual")'],
  "NG(": ['NG("failure_reason")'],
  tc_assert: ["tc_assert_EQ(", "tc_assert_NE(", "tc_assert_TRUE("],
  'BUILD': ["build({ project: \"", "build({ clean: true, project: \""],
  'TEST': ["test({ binary: \"", "test({ filter: \""],
  'codeIndex': ['codeIndex({ query: "'],
  git_: ["git status", "git diff", 'git commit -m "'],
};
