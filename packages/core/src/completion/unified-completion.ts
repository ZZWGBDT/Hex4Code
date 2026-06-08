/**
 * Unified Inline Completion Provider
 *
 * Merges pattern-based completions with general AI completions:
 *
 *   User types →
 *     1. Pattern prefix match? → return pattern-based completions (fast, local)
 *     2. General fallback?     → call API → if fails: local patterns
 *     3. C/C++ in hex4 mode?  → include project struct/types in general results
 *
 * This replaces both the old inline providers.
 */

import * as vscode from "vscode";
import OpenAI from "openai";
import { resolveProviderRoute } from "../models/model-router";
import { createClient } from "../models/provider-client";

// ── Pattern-based completions ────────────────────────────────────────

const HEX4_PATTERNS: Record<string, string[]> = {
  hex4_: ["hex4_tc_propagate(", "hex4_sm2_sign(", "hex4_model_forward(", "hex4_vm_exec("],
  TC_: ["TC_NONE", "TC_CARRY", "TC_UNCERTAIN", "TC_MIXED"],
  ternary_: ["ternary_core_lite(", "ternary_register_file("],
  Hex4: ["Hex4DualTrit", "Hex4IRGraph", "Hex4Session", "Hex4VMInstance"],
  "Hex4DualTrit.": [".value", ".tc_type", ".raw"],
  tc_: ["tc_add(", "tc_mul(", "tc_propagate(", "tc_merge("],
  sm2_: ["sm2_sign(", "sm2_verify(", "sm2_encrypt(", "sm2_decrypt("],
};

const HEX4_STRUCT_TYPES = ["TCMatrix", "BalancedTrit", "TCType", "Hex4Tensor", "Hex4Node"];

const HEX4_HEADERS = ["hex4_nn_vm_types.h", "hex4_nn_compiler.h", "hex4_nn_vm.h", "hex4_sm2.h", "hex4_balanced_ops.h"];

function getHex4Completions(textBefore: string): vscode.InlineCompletionItem[] | null {
  const items: vscode.InlineCompletionItem[] = [];

  // Prefix-based completions
  for (const [prefix, suggestions] of Object.entries(HEX4_PATTERNS)) {
    if (textBefore.endsWith(prefix)) {
      for (const s of suggestions) {
        items.push(new vscode.InlineCompletionItem(s.substring(prefix.length)));
      }
      return items;
    }
  }

  // C/C++ type completions (fuzzy)
  const lastWord = textBefore.split(/[\s(,;]/).pop() || "";
  if (lastWord.length >= 2) {
    for (const t of HEX4_STRUCT_TYPES) {
      if (t.toLowerCase().startsWith(lastWord.toLowerCase())) {
        items.push(new vscode.InlineCompletionItem(t.substring(lastWord.length)));
      }
    }
    if (items.length > 0) return items;
  }

  // #include completions
  const includeMatch = textBefore.match(/^#include\s+[<"]?(\w*$)/);
  if (includeMatch) {
    for (const h of HEX4_HEADERS) {
      if (h.startsWith(includeMatch[1])) {
        items.push(new vscode.InlineCompletionItem(h.substring(includeMatch[1].length)));
      }
    }
    if (items.length > 0) return items;
  }

  return null; // no HEX4 match
}

// ── General completions (deepseek-v4 powered) ────────────────────────

const COMPLETION_CONFIG = {
  model: "deepseek-v4-flash",
  maxTokens: 64,
  temperature: 0.1,
  skipLanguages: new Set(["json", "yaml", "markdown", "html", "css"]),
} as const;

const LANGUAGE_HINTS: Record<string, string> = {
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

function buildGeneralPrompt(languageId: string, textBefore: string, textAfter: string, indentation: string): string {
  const langHint = LANGUAGE_HINTS[languageId] || languageId;
  const beforeLines = textBefore.split("\n");
  const contextLines = beforeLines.slice(-8).join("\n");
  const afterLines = textAfter.split("\n");
  const nextLines = afterLines.slice(0, 3).join("\n");

  const parts = [
    `Complete the following ${langHint} code.`,
    `Output ONLY the completion, no explanation.`,
    `Follow indentation: "${indentation.replace(/\n/g, "\\n")}".`,
    `Keep it concise. Do NOT repeat the typed prefix.`,
    `Before cursor:`,
    "```" + languageId,
    contextLines,
    "```",
  ];
  if (nextLines) {
    parts.push(`After cursor:\n\`\`\`${languageId}\n${nextLines}\n\`\`\``);
  }
  parts.push(`Completion:`);
  return parts.join("\n");
}

// Local fallback patterns for when API is unavailable
const LOCAL_PATTERNS: Record<string, string[]> = {
  "if ": ["if (", "if True:"],
  "for ": ["for (", "for x in "],
  "while ": ["while (", "while True:"],
  "def ": ["def "],
  "class ": ["class "],
  "import ": ["import ", "import React from 'react'"],
  return: ["return "],
  "const ": ["const ", "const { } = "],
  "function ": ["function ", "function("],
  "=>": [" => ", " => {"],
  "console.": ["console.log(", "console.error("],
  "fmt.": ["fmt.Println(", "fmt.Sprintf("],
  print: ["print(", 'print(f"', "print!("],
};

function getLocalCompletions(textBefore: string): vscode.InlineCompletionItem[] {
  const items: vscode.InlineCompletionItem[] = [];
  const trimmed = (textBefore.split("\n").pop() || "").trim();
  const indentation = textBefore.match(/(\s*)$/)?.[1] || "";

  for (const [prefix, suggestions] of Object.entries(LOCAL_PATTERNS)) {
    if (trimmed.endsWith(prefix)) {
      for (const s of suggestions) {
        items.push(new vscode.InlineCompletionItem(s.startsWith(prefix) ? s.slice(prefix.length) : s));
      }
      return items;
    }
  }

  // Bracket matching
  if (trimmed.endsWith("{")) items.push(new vscode.InlineCompletionItem(`\n${indentation}  \n${indentation}}`));
  if (trimmed.endsWith("(")) items.push(new vscode.InlineCompletionItem(")"));
  if (trimmed.endsWith("[")) items.push(new vscode.InlineCompletionItem("]"));

  return items;
}

// ── Unified Provider ─────────────────────────────────────────────────

export class UnifiedCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private openaiClient: OpenAI | null = null;
  private model: string = COMPLETION_CONFIG.model;
  private baseURL: string = "";
  private apiKey: string = "";
  private disposed = false;

  constructor() {
    this.loadCredentials();
  }

  loadCredentials(): void {
    try {
      const os = require("os");
      const path = require("path");
      const fs = require("fs");
      const settingsPath = path.join(os.homedir(), ".hex4code", "settings.json");
      let settings: Record<string, unknown> = {};
      if (fs.existsSync(settingsPath)) {
        const raw = fs.readFileSync(settingsPath, "utf8");
        settings = JSON.parse(raw);
      }

      // Use multi-model routing to select the completion model
      const settingsEnv =
        settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
          ? (settings.env as Record<string, string | undefined>)
          : {};
      const route = resolveProviderRoute("completion", {
        model: typeof settings.model === "string" ? settings.model : undefined,
        routing:
          settings.taskModels && typeof settings.taskModels === "object" && !Array.isArray(settings.taskModels)
            ? (settings.taskModels as Record<string, string>)
            : undefined,
        env: {
          ...settingsEnv,
          API_KEY: typeof settings.apiKey === "string" ? settings.apiKey : settingsEnv.API_KEY,
        },
        providers:
          settings.providers && typeof settings.providers === "object" && !Array.isArray(settings.providers)
            ? (settings.providers as any)
            : undefined,
        legacyApiKeyProvider:
          typeof settings.legacyApiKeyProvider === "string" ? (settings.legacyApiKeyProvider as any) : undefined,
        legacyBaseURLProvider:
          typeof settings.legacyBaseURLProvider === "string" ? (settings.legacyBaseURLProvider as any) : undefined,
        processEnv: process.env,
      });

      this.model = route.modelId;
      this.baseURL = route.baseURL;
      this.apiKey = route.apiKey;

      // 使用provider-client工厂创建客户端
      const client = createClient({
        modelId: this.model,
        apiKey: this.apiKey,
        baseURL: this.baseURL,
      });
      this.openaiClient = client && "chat" in client ? (client as unknown as OpenAI) : null;
    } catch {
      // routeTask 失败时，用 HEX4CODE_API_KEY 环境变量 + createClient 回退
      this.apiKey = process.env.HEX4CODE_API_KEY || "";
      if (this.apiKey) {
        try {
          const { createClient } = require("../models/provider-client");
          const client = createClient({ modelId: COMPLETION_CONFIG.model, apiKey: this.apiKey });
          if (client && "chat" in client) {
            this.openaiClient = client as unknown as OpenAI;
            this.baseURL = (client as any).baseURL || "";
          }
        } catch {
          /* cannot create fallback client */
        }
      }
    }

    if (!this.openaiClient && this.apiKey) {
      // 终极回退：最小化 OpenAI 兼容客户端
      try {
        this.openaiClient = new OpenAI({ apiKey: this.apiKey });
      } catch {
        /* no fallback */
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    // 清除 API Key 和客户端引用，防止常驻内存
    this.apiKey = "";
    this.baseURL = "";
    this.openaiClient = null;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    if (this.disposed || token.isCancellationRequested) return [];

    const languageId = document.languageId;
    const line = document.lineAt(position.line);
    const textBefore = line.text.substring(0, position.character);
    const trimmedBefore = textBefore.trim();

    // Skip very short input
    if (!trimmedBefore || trimmedBefore.length < 1) return [];

    // ── Step 1: Pattern-based completions (fast, no API call) ──────────
    const isCFile = languageId === "c" || languageId === "cpp";

    if (isCFile) {
      const hex4Results = getHex4Completions(textBefore);
      if (hex4Results && hex4Results.length > 0) {
        return hex4Results;
      }
    }

    // ── Step 2: Skip languages where API autocomplete is not useful ──
    if (COMPLETION_CONFIG.skipLanguages.has(languageId)) {
      return getLocalCompletions(textBefore);
    }

    // ── Step 3: deepseek-v4 API general completion ───────────────────
    if (this.openaiClient && !token.isCancellationRequested && trimmedBefore.length >= 2) {
      try {
        const textAfter = line.text.substring(position.character);
        const indentation = line.text.match(/^\s*/)?.[0] || "";

        const response = await this.openaiClient.chat.completions.create({
          model: this.model,
          messages: [
            {
              role: "user",
              content: buildGeneralPrompt(languageId, textBefore, textAfter, indentation),
            },
          ],
          max_tokens: COMPLETION_CONFIG.maxTokens,
          temperature: COMPLETION_CONFIG.temperature,
          stop: ["\n\n", "\r\n\r\n"],
        });

        const completion = response.choices?.[0]?.message?.content?.trim();
        if (completion && !token.isCancellationRequested) {
          return [new vscode.InlineCompletionItem(completion)];
        }
      } catch {
        // API failed — fall through
      }
    }

    // ── Step 4: Local fallback ───────────────────────────────────────
    const localItems = getLocalCompletions(textBefore);
    if (localItems.length > 0) return localItems;

    return [];
  }
}
