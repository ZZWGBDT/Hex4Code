/**
 * General Autocomplete Provider
 *
 * Uses deepseek-v4-flash (fast, low-cost) for general code completion.
 * Falls back to prefix-based completions when API is unavailable.
 *
 * Architecture:
 *   User types → detect trigger → build prompt → call deepseek-v4-flash API → return suggestions
 *
 * Supports:
 *   - Any language (Python, JS, TS, Go, Rust, Java, C/C++, etc.)
 *   - Fast inline completions via "flash" model variant
 *   - Graceful fallback: token-aware local completions
 */

import * as vscode from "vscode";
import OpenAI from "openai";
import { resolveProviderRoute } from "../models/model-router";
import { createClient } from "../models/provider-client";

// ── Configuration ─────────────────────────────────────────────────────

const COMPLETION_CONFIG = {
  /** Use the fast/cheap model variant for autocomplete */
  model: "deepseek-v4-flash",
  maxTokens: 64,
  temperature: 0.1,
  /** Debounce delay (ms) before firing API call */
  debounceMs: 150,
  /** Stop sequences to keep completions tight */
  stopSequences: ["\n\n", "\r\n\r\n", "\n\r\n"] as string[],
  /** Languages where we skip API autocomplete (use local only) */
  skipLanguages: new Set(["json", "yaml", "markdown", "html", "css"]),
} as const;

// ── Prompt templates per language ────────────────────────────────────

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

function buildAutocompletePrompt(
  languageId: string,
  textBefore: string,
  textAfter: string,
  indentation: string,
): string {
  const langHint = LANGUAGE_HINTS[languageId] || languageId;
  const beforeLines = textBefore.split("\n");
  const contextLines = beforeLines.slice(-8).join("\n"); // last 8 lines
  const afterLines = textAfter.split("\n");
  const nextLines = afterLines.slice(0, 3).join("\n"); // next 3 lines

  return [
    `Complete the following ${langHint} code.`,
    `Rules:`,
    `- Output ONLY the completion text, no explanation.`,
    `- Follow the existing indentation (currently: "${indentation.replace(/\n/g, "\\n")}").`,
    `- Keep it concise (<${COMPLETION_CONFIG.maxTokens} tokens).`,
    `- Do NOT repeat the line prefix that's already typed.`,
    `- Match the style of surrounding code.`,
    ``,
    `Before cursor:`,
    "```" + languageId,
    contextLines,
    "```",
    nextLines ? `After cursor:\n\`\`\`${languageId}\n${nextLines}\n\`\`\`` : "",
    ``,
    `Completion:`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Local fallback: token-aware prefix completion ────────────────────

const COMMON_PATTERNS: Record<string, string[]> = {
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

function getLocalCompletions(textBefore: string): vscode.InlineCompletionItem[] {
  const items: vscode.InlineCompletionItem[] = [];
  const lastLine = textBefore.split("\n").pop() || "";
  const trimmed = lastLine.trimStart();
  const indentation = lastLine.slice(0, lastLine.length - trimmed.length);

  for (const [prefix, suggestions] of Object.entries(COMMON_PATTERNS)) {
    if (trimmed.endsWith(prefix)) {
      for (const s of suggestions) {
        const suffix = s.startsWith(prefix) ? s.slice(prefix.length) : "";
        items.push(new vscode.InlineCompletionItem(suffix));
      }
      return items;
    }
  }

  // Bracket matching
  if (trimmed.endsWith("{")) {
    items.push(new vscode.InlineCompletionItem(`\n${indentation}  \n${indentation}}`));
  }
  if (trimmed.endsWith("(")) {
    items.push(new vscode.InlineCompletionItem(")"));
  }
  if (trimmed.endsWith("[")) {
    items.push(new vscode.InlineCompletionItem("]"));
  }

  return items;
}

// ── Main completion provider ─────────────────────────────────────────

export class GeneralAutocompleteProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private openaiClient: OpenAI | null = null;
  private model: string = COMPLETION_CONFIG.model;
  private baseURL: string = "";
  private apiKey: string = "";
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor() {
    this.loadCredentials();
  }

  /** Load or reload API credentials */
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
      // routeTask 失败时，用 HEX4CODE_API_KEY + createClient 回退
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
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
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

    // Skip empty lines or very short prefixes
    if (!trimmedBefore || trimmedBefore.length < 2) return [];

    // Skip certain file types
    if (COMPLETION_CONFIG.skipLanguages.has(languageId)) {
      return getLocalCompletions(textBefore);
    }

    // Get text after cursor (for context-aware completion)
    const textAfter = line.text.substring(position.character);
    const indentation = line.text.match(/^\s*/)?.[0] || "";

    // Try API-based completion
    if (this.openaiClient && !token.isCancellationRequested) {
      try {
        const response = await this.openaiClient.chat.completions.create({
          model: this.model,
          messages: [
            {
              role: "user",
              content: buildAutocompletePrompt(languageId, textBefore, textAfter, indentation),
            },
          ],
          max_tokens: COMPLETION_CONFIG.maxTokens,
          temperature: COMPLETION_CONFIG.temperature,
          stop: COMPLETION_CONFIG.stopSequences,
        });

        const completion = response.choices?.[0]?.message?.content?.trim();
        if (completion && !token.isCancellationRequested) {
          return [new vscode.InlineCompletionItem(completion)];
        }
      } catch {
        // API failed silently — fall through to local completions
      }
    }

    // Fallback to local completions
    return getLocalCompletions(textBefore);
  }
}
