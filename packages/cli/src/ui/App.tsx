import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, Static, Text, useApp, useStdout, useWindowSize } from "ink";
import chalk from "chalk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import OpenAI from "openai";
import {
  SessionManager,
  type LlmStreamProgress,
  type MessageMeta,
  type SessionEntry,
  type SessionMessage,
  type SessionStatus,
  type SkillInfo,
  type UserPromptContent,
} from "@hex4code/core/session";
import {
  applyModelConfigSelection,
  resolveSettingsSources,
  type Hex4codeSettings,
  type ModelConfigSelection,
  type ResolvedHex4codeSettings,
} from "@hex4code/core/settings";
import { PromptInput, type PromptSubmission } from "./PromptInput";
import { MessageView } from "./MessageView";
import { SessionList } from "./SessionList";
import { buildLoadingText } from "./loadingText";
import { findExpandedThinkingId } from "./thinkingState";
import { WelcomeScreen } from "./WelcomeScreen";
import { AskUserQuestionPrompt } from "./AskUserQuestionPrompt";
import { themeChalk } from "./theme";
import {
  findPendingAskUserQuestion,
  formatAskUserQuestionAnswers,
  type AskUserQuestionAnswers,
} from "./askUserQuestion";
import { buildExitSummaryText } from "./exitSummary";
import { createClient } from "@hex4code/core/models/provider-client";
import { PROVIDERS } from "@hex4code/core/models/provider-registry";
import {
  detectConfiguredProviders,
  resolveProviderRoute,
} from "@hex4code/core/models/model-router";

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

type View = "chat" | "session-list";

type AppProps = {
  projectRoot: string;
  version?: string;
  onRestart?: () => void;
};

export function App({
  projectRoot,
  version = "",
  onRestart,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout, write } = useStdout();
  const { columns } = useWindowSize();
  const [view, setView] = useState<View>("chat");
  const [busy, setBusy] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [statusLine, setStatusLine] = useState<string>("");
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [streamProgress, setStreamProgress] =
    useState<LlmStreamProgress | null>(null);
  const [runningProcesses, setRunningProcesses] =
    useState<SessionEntry["processes"]>(null);
  const [activeStatus, setActiveStatus] = useState<SessionStatus | null>(null);
  const [dismissedQuestionIds, setDismissedQuestionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isExiting, setIsExiting] = useState(false);
  const [showWelcome, setShowWelcome] = useState(true);
  const [welcomeNonce, setWelcomeNonce] = useState(0);
  const [resolvedSettings, setResolvedSettings] = useState(() =>
    resolveCurrentSettings(projectRoot),
  );
  const [nowTick, setNowTick] = useState(0);

  const messagesRef = useRef<SessionMessage[]>([]);
  messagesRef.current = messages;

  const sessionManager = useMemo(() => {
    // Auto-detect agent mode from project root (with env var override)
    const {
      detectProjectMode,
      getEffectiveMode,
      getModeLabel,
    } = require("@hex4code/core/agent-mode");
    const envOverride = process.env.HEX4CODE_AGENT_MODE;
    const validatedOverride: "hex4" | "general" | undefined =
      envOverride === "hex4" || envOverride === "general"
        ? envOverride
        : undefined;
    const effectiveMode = getEffectiveMode(
      {
        mode: detectProjectMode(projectRoot),
        autoDetect: !validatedOverride,
        override: validatedOverride,
      },
      projectRoot,
    );
    // Set global mode flag for executor
    const { setAgentMode, getAgentMode } = require("@hex4code/core/agent-mode");
    setAgentMode(effectiveMode);
    process.stderr.write(
      `[HEX4] Project Mode: ${getModeLabel(effectiveMode)}${validatedOverride ? " (env override)" : ""}\n`,
    );

    return new SessionManager({
      projectRoot,
      createOpenAIClient: () => createOpenAIClient(projectRoot),
      getResolvedSettings: () => resolveCurrentSettings(projectRoot),
      renderMarkdown: (text) => text,
      ui: {
        onMessage: () => {},
        onToolResult: () => {},
        onError: () => {},
        getAgentMode: () => getAgentMode(),
      },
      onAssistantMessage: (message: SessionMessage) => {
        setMessages((prev) => [...prev, message]);
      },
      onSessionEntryUpdated: (entry) => {
        setStatusLine(buildStatusLine(entry));
        setRunningProcesses(entry.processes);
        setActiveStatus(entry.status);
      },
      onLlmStreamProgress: (progress) => {
        if (progress.phase === "end") {
          setStreamProgress(null);
          return;
        }
        setStreamProgress(progress);
      },
    });
  }, [projectRoot]);

  // ── Provider Auto-Detection on Startup ──────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const {
          detectConfiguredProviders,
          getUnconfiguredProviders,
        } = require("@hex4code/core/models/model-router");
        const configured = detectConfiguredProviders(process.env);
        const available = getUnconfiguredProviders();
        if (configured.length === 0 && available.length > 0) {
          process.stderr.write(
            chalk.dim(
              `\n🌟 ${available.length} AI providers available: ${available.map((a: { name: string }) => a.name).join(", ")}. Set env vars (e.g., ${available[0].apiKeyEnv}) to activate.\n`,
            ),
          );
        } else if (configured.length > 0) {
          process.stderr.write(
            chalk.dim(
              `🔌 ${configured.length} provider(s) configured: ${configured.join(", ")}\n`,
            ),
          );
        }
      } catch {
        /* background check */
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!busy) {
      return;
    }
    const id = setInterval(() => setNowTick((tick) => tick + 1), 500);
    return () => clearInterval(id);
  }, [busy]);

  function loadVisibleMessages(
    manager: SessionManager,
    sessionId: string,
  ): SessionMessage[] {
    return manager.listSessionMessages(sessionId).filter((m) => m.visible);
  }

  const refreshSessionsList = useCallback((): void => {
    setSessions(sessionManager.listSessions());
  }, [sessionManager]);

  const refreshSkills = useCallback(
    async (sessionId?: string): Promise<void> => {
      try {
        const list = await sessionManager.listSkills(
          sessionId ?? sessionManager.getActiveSessionId() ?? undefined,
        );
        setSkills(list);
      } catch {
        // ignore
      }
    },
    [sessionManager],
  );

  useEffect(() => {
    refreshSessionsList();
    void refreshSkills();
  }, [refreshSessionsList, refreshSkills]);

  useLayoutEffect(() => {
    const settings = resolveCurrentSettings(projectRoot);
    void sessionManager.initMcpServers(settings.mcpServers);
  }, [projectRoot, sessionManager]);

  useEffect(() => {
    return () => {
      sessionManager.dispose();
    };
  }, [sessionManager]);

  const writeRef = useRef(write);
  writeRef.current = write;
  const handlePrompt = useCallback(
    async (submission: PromptSubmission) => {
      if (submission.command === "exit") {
        setIsExiting(true);
        setTimeout(() => {
          const activeSessionId = sessionManager.getActiveSessionId();
          const session = activeSessionId
            ? sessionManager.getSession(activeSessionId)
            : null;
          const allMessages = activeSessionId
            ? sessionManager.listSessionMessages(activeSessionId)
            : messagesRef.current;
          const resolved = resolveCurrentSettings(projectRoot);
          const summary = buildExitSummaryText({
            session,
            messages: allMessages,
            model: resolved.model,
          });
          process.stdout.write("\n");
          process.stdout.write(chalk.green("> /exit "));
          process.stdout.write("\n\n");
          process.stdout.write(summary);
          process.stdout.write("\n\n");
          sessionManager.dispose();
          exit();
        }, 0);
        return;
      }
      if (submission.command === "new") {
        if (onRestart) {
          onRestart();
        } else {
          writeRef.current("\u001B[2J\u001B[3J\u001B[H");
          sessionManager.setActiveSessionId(null);
          setMessages([]);
          setStatusLine("");
          setErrorLine(null);
          setRunningProcesses(null);
          setActiveStatus(null);
          setDismissedQuestionIds(new Set());
          setShowWelcome(true);
          setWelcomeNonce((n) => n + 1);
          await refreshSkills();
          refreshSessionsList();
        }
        return;
      }
      if (submission.command === "resume") {
        setShowWelcome(false);
        refreshSessionsList();
        setView("session-list");
        return;
      }
      if (submission.command === "mcp") {
        process.stdout.write("\n");
        process.stdout.write(
          themeChalk.accentStrongBold("MCP Server Status\n"),
        );
        process.stdout.write(chalk.dim("─────────────────\n"));
        const statuses = sessionManager.getMcpStatus();
        if (statuses.length === 0) {
          process.stdout.write(chalk.dim("  No MCP servers configured.\n"));
        } else {
          for (const s of statuses) {
            if (s.status === "starting") {
              process.stdout.write(
                `${chalk.yellow("●")} ${chalk.bold(s.name)} - Starting...`,
              );
            } else if (s.status === "failed") {
              process.stdout.write(
                `${chalk.red("✖")} ${chalk.bold(s.name)} - Failed (${s.error ?? "unknown error"})`,
              );
            } else {
              process.stdout.write(
                `${chalk.green("✔")} ${chalk.bold(s.name)} - Ready (${s.toolCount} tools)`,
              );
            }
            process.stdout.write("\n");
            if (s.status === "ready" && s.tools.length > 0) {
              for (const tool of s.tools) {
                process.stdout.write(chalk.dim(`  - ${tool}\n`));
              }
            }
          }
        }
        process.stdout.write(chalk.dim("─────────────────\n"));
        process.stdout.write(
          chalk.dim(
            `  Total: ${statuses.filter((s) => s.status === "ready").length} ready, `,
          ) +
            chalk.dim(
              `${statuses.filter((s) => s.status === "starting").length} starting, `,
            ) +
            chalk.dim(
              `${statuses.filter((s) => s.status === "failed").length} failed\n`,
            ),
        );
        process.stdout.write("\n");
        return;
      }
      if (submission.command === "clearcache") {
        sessionManager.clearCaches?.();
        process.stdout.write(chalk.green("✅ All caches cleared.\n"));
        process.stdout.write("\n");
        return;
      }

      if (submission.command === "hex4") {
        const text = (submission.text ?? "").trim();
        const parts = text.split(/\s+/).filter(Boolean);
        const subCmd = parts[0]?.toLowerCase() || "";
        const arg = parts.slice(1).join(" ");

        if (subCmd === "new" || subCmd === "n") {
          const type = arg || "module";
          process.stdout.write(
            themeChalk.accentStrongBold("\nHEX4 New Project Generator\n"),
          );
          process.stdout.write(
            chalk.dim(
              "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n",
            ),
          );
          process.stdout.write("Creating new " + type + " project...\n");
          process.stdout.write(
            chalk.dim("  Use templates in ~/.agents/skills/hex4-*/\n"),
          );
          process.stdout.write("\n");
          process.stdout.write("Available templates:\n");
          process.stdout.write(
            "  /hex4 new module     - C module (hex4_*.h + hex4_*.c + test_*.c)\n",
          );
          process.stdout.write(
            "  /hex4 new crypto     - Crypto algorithm (in HEX4\u5bc6\u7801/)\n",
          );
          process.stdout.write(
            "  /hex4 new test       - Test file using T()/OK()/NG()\n",
          );
          process.stdout.write(
            "  /hex4 new alu        - Ternary ALU core (in HEX4-Lite-IP\u6838/)\n",
          );
        } else if (subCmd === "build") {
          process.stdout.write(
            themeChalk.accent(
              'Tip: use the `build` tool with project="<subdir>"\n',
            ),
          );
        } else if (subCmd === "test") {
          process.stdout.write(
            themeChalk.accent(
              'Tip: use the `test` tool with project="<subdir>"\n',
            ),
          );
        } else {
          process.stdout.write(
            chalk.yellow("Commands: /hex4 new [module|crypto|test|alu]\n"),
          );
        }
        process.stdout.write("\n");
        return;
      }
      if (submission.command === "sessions") {
        const text = (submission.text ?? "").trim();
        const parts = text.split(/\s+/).filter(Boolean);
        const subCmd = parts[0]?.toLowerCase() || "list";
        const arg = parts.slice(1).join(" ");

        if (subCmd === "list" || subCmd === "ls") {
          const all = sessionManager.listSessions();
          process.stdout.write(
            themeChalk.accentStrongBold(`\nSessions (${all.length}):\n`),
          );
          process.stdout.write(chalk.dim("─────────────────\n"));
          for (const s of all) {
            const date = new Date(s.createTime || Date.now());
            const label = (s.summary || s.id).substring(0, 60);
            process.stdout.write(
              `  ${chalk.green(s.id.substring(0, 8))}  ${chalk.dim(date.toLocaleString())}  "${label}"\n`,
            );
          }
          process.stdout.write(chalk.dim("─────────────────\n"));
        } else if (subCmd === "delete" || subCmd === "rm") {
          if (!arg) {
            process.stdout.write(
              chalk.red("Usage: /sessions delete <session-id>\n"),
            );
          } else {
            const found = sessionManager.deleteSession?.(arg);
            process.stdout.write(
              found
                ? chalk.green(`✅ Session "${arg.substring(0, 8)}" deleted.\n`)
                : chalk.red(`❌ Session "${arg.substring(0, 8)}" not found.\n`),
            );
          }
        } else if (subCmd === "export") {
          if (!arg) {
            process.stdout.write(
              chalk.red("Usage: /sessions export <session-id>\n"),
            );
          } else {
            const messages = sessionManager.listSessionMessages(arg);
            const outPath = path.join(
              projectRoot,
              `session-${arg.substring(0, 8)}.md`,
            );
            const md = messages
              .map(
                (m) =>
                  `## ${m.role}\n\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content, null, 2)}`,
              )
              .join("\n\n");
            fs.writeFileSync(outPath, md, "utf8");
            process.stdout.write(
              chalk.green(`✅ Session exported to ${outPath}\n`),
            );
          }
        } else {
          process.stdout.write(
            chalk.yellow("Commands: list, delete <id>, export <id>\n"),
          );
        }
        process.stdout.write("\n");
        return;
      }

      if (submission.command === "model") {
        const text = (submission.text ?? "").trim();
        const parts = text.split(/\s+/).filter(Boolean);
        const subCmd = parts[0]?.toLowerCase() || "list";

        if (subCmd === "list" || subCmd === "ls") {
          const configured = detectConfiguredProviders(process.env);
          process.stdout.write(
            themeChalk.accentStrongBold("\nAvailable Models:\n"),
          );
          process.stdout.write(
            chalk.dim("───────────────────────────────────────\n"),
          );
          for (const p of PROVIDERS) {
            const isConfigured = configured.includes(p.id);
            const icon = isConfigured ? chalk.green("●") : chalk.red("○");
            process.stdout.write(
              `  ${icon} ${chalk.bold(p.name)}  ${isConfigured ? chalk.green("configured") : chalk.dim("unconfigured")}\n`,
            );
            for (const m of p.models) {
              const caps = Array.isArray(m.capabilities)
                ? m.capabilities.join(", ")
                : "";
              const cost = m.costPer1MInput
                ? ` $${m.costPer1MInput}/${m.costPer1MOutput} per 1M tok`
                : "";
              const ctx = m.contextWindow
                ? chalk.dim(` (${Math.round(m.contextWindow / 1000)}K ctx`)
                : "";
              process.stdout.write(
                `    ${themeChalk.accent(m.id)}${ctx}${cost ? chalk.dim(cost) : ""}${chalk.dim(")")}\n`,
              );
              if (caps) process.stdout.write(chalk.dim(`      ${caps}\n`));
            }
          }
          process.stdout.write(
            chalk.dim("───────────────────────────────────────\n"),
          );
        } else {
          process.stdout.write(chalk.yellow("Subcommands: list, ls\n"));
        }
        process.stdout.write("\n");
        return;
      }

      // ── /cost — Cost Dashboard ──────────────────────────────────────────
      if (submission.command === "cost") {
        process.stdout.write(themeChalk.accentStrongBold("\nCost Dashboard\n"));
        process.stdout.write(
          chalk.dim("───────────────────────────────────────\n"),
        );
        const sessionsPath = path.join(
          os.homedir(),
          ".hex4code",
          "sessions.json",
        );
        try {
          const fs = await import("fs");
          if (!fs.existsSync(sessionsPath)) {
            process.stdout.write(chalk.yellow("  No session data found.\n"));
          } else {
            const raw = fs.readFileSync(sessionsPath, "utf8");
            const index = JSON.parse(raw);
            const entries = index.entries || [];
            let totalCost = 0,
              totalTokens = 0,
              sessionCount = 0;
            for (const e of entries) {
              const cost = typeof e.totalCost === "number" ? e.totalCost : 0;
              const tokens =
                typeof e.activeTokens === "number" ? e.activeTokens : 0;
              if (cost > 0 || tokens > 0) {
                totalCost += cost;
                totalTokens += tokens;
                sessionCount++;
                process.stdout.write(
                  `  ${themeChalk.accent(e.id?.substring(0, 8) || "?")}  ${(e.summary || "(no summary)").substring(0, 40)}\n`,
                );
                process.stdout.write(
                  chalk.dim(
                    `      Cost: $${cost.toFixed(6)}  Tokens: ${tokens.toLocaleString()}\n`,
                  ),
                );
              }
            }
            process.stdout.write(
              chalk.dim("───────────────────────────────────────\n"),
            );
            process.stdout.write(`  Sessions: ${sessionCount}\n`);
            process.stdout.write(
              `  Total Cost: ${chalk.green(`$${totalCost.toFixed(6)}`)}\n`,
            );
            process.stdout.write(
              `  Total Tokens: ${totalTokens.toLocaleString()}\n`,
            );
            if (totalCost > 0) {
              process.stdout.write(
                `  Avg/Session: $${(totalCost / Math.max(sessionCount, 1)).toFixed(6)}\n`,
              );
            }
          }
        } catch (e: unknown) {
          process.stdout.write(
            chalk.red(
              `  Error: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}\n`,
            ),
          );
        }
        process.stdout.write(
          chalk.dim("───────────────────────────────────────\n"),
        );
        process.stdout.write("\n");
        return;
      }

      // ── /recommend — Smart Model Recommendation ─────────────────────────
      if (submission.command === "recommend") {
        const { getSmartRecommendation, detectConfiguredProviders } =
          await import("@hex4code/core/models/model-router");
        const configured = detectConfiguredProviders(process.env);
        process.stdout.write(
          themeChalk.accentStrongBold("\nSmart Model Recommendation\n"),
        );
        process.stdout.write(
          chalk.dim("───────────────────────────────────────\n"),
        );
        process.stdout.write(
          `Configured: ${configured.join(", ") || chalk.yellow("none")}\n`,
        );
        const tasks = [
          { id: "completion", label: "Completion" },
          { id: "generation", label: "Generation" },
          { id: "analysis", label: "Analysis" },
          { id: "review", label: "Review" },
          { id: "chat", label: "Chat" },
        ];
        for (const task of tasks) {
          const recs = getSmartRecommendation(
            task.id as any,
            configured,
            "balanced",
          );
          process.stdout.write(`\n▸ ${chalk.bold(task.label)}\n`);
          if (recs.length === 0) {
            process.stdout.write("   No suitable models\n");
          } else {
            recs.forEach((r, i) => {
              const icon = i === 0 ? "★" : " ";
              process.stdout.write(`  ${icon} ${r.reason}\n`);
            });
          }
        }
        process.stdout.write(
          chalk.dim("───────────────────────────────────────\n\n"),
        );
        return;
      }

      // ── /vote — Multi-Model Parallel Vote ───────────────────────────────
      if (submission.command === "vote") {
        const text = (submission.text ?? "").trim();
        const { parallelVote, detectConfiguredProviders } =
          await import("@hex4code/core/models/model-router");
        const configured = detectConfiguredProviders(process.env);
        if (configured.length < 2) {
          process.stdout.write(
            chalk.yellow(
              "⚠️  Need at least 2 configured providers for voting.\n",
            ),
          );
          return;
        }
        const strategy = text.includes("consensus")
          ? ("consensus" as const)
          : text.includes("fastest")
            ? ("fastest" as const)
            : ("majority" as const);
        const promptText = text
          .replace(/^(majority|consensus|fastest)\s*/i, "")
          .trim();
        if (!promptText) {
          process.stdout.write(
            chalk.yellow(
              "Usage: /vote [majority|consensus|fastest] <prompt>\n",
            ),
          );
          return;
        }
        process.stdout.write(
          themeChalk.accentStrongBold(
            `\nVoting (${strategy}) — ${configured.length} providers...\n`,
          ),
        );
        const result = await parallelVote(promptText, configured, {
          strategy,
          modelCount: 3,
        });
        process.stdout.write(
          chalk.dim("───────────────────────────────────────\n"),
        );
        for (const r of result.responses) {
          const icon = r.error ? "❌" : "✅";
          process.stdout.write(
            `${icon} ${chalk.bold(r.label)} (${r.provider}) — ${r.latencyMs}ms\n`,
          );
          if (r.error)
            process.stdout.write(chalk.red(`   ${r.error.slice(0, 100)}\n`));
          else
            process.stdout.write(
              chalk.dim(`   ${r.response.slice(0, 200)}...\n`),
            );
        }
        process.stdout.write(
          chalk.dim("───────────────────────────────────────\n"),
        );
        if (result.success) {
          process.stdout.write(chalk.bold.green(`\nSummary (${strategy}):\n`));
          process.stdout.write(result.summary.slice(0, 500) + "\n");
        } else {
          process.stdout.write(chalk.red("All models failed\n"));
        }
        process.stdout.write(
          chalk.dim("───────────────────────────────────────\n\n"),
        );
        return;
      }

      // ── /cache — Semantic Cache Stats ──────────────────────────────────
      if (submission.command === "cache") {
        try {
          const {
            getGlobalCache,
          } = require("@hex4code/core/cache/semantic-cache");
          const cache = getGlobalCache();
          const stats = cache.stats();
          process.stdout.write(
            themeChalk.accentStrongBold("\nSemantic Cache\n"),
          );
          process.stdout.write(
            chalk.dim("───────────────────────────────────────\n"),
          );
          process.stdout.write(`Entries: ${stats.totalEntries}\n`);
          process.stdout.write(
            `Models: ${stats.totalModels.join(", ") || "none"}\n`,
          );
          process.stdout.write(`Hits/Misses: ${stats.hits}/${stats.misses}\n`);
          process.stdout.write(
            `Hit Rate: ${(stats.hitRate * 100).toFixed(1)}%\n`,
          );
          process.stdout.write(
            chalk.dim("───────────────────────────────────────\n\n"),
          );
        } catch (e: unknown) {
          process.stdout.write(
            chalk.red(`Error: ${e instanceof Error ? e.message : String(e)}\n`),
          );
        }
        return;
      }

      // ── /benchmark — Model Benchmarking ─────────────────────────────────
      if (submission.command === "benchmark") {
        const text = (submission.text ?? "").trim();
        if (!text) {
          process.stdout.write(chalk.yellow("Usage: /benchmark <prompt>\n"));
          return;
        }
        const { benchmarkModels, detectConfiguredProviders } =
          await import("@hex4code/core/models/model-router");
        const configured = detectConfiguredProviders(process.env);
        process.stdout.write(
          themeChalk.accentStrongBold(
            `\nBenchmarking ${Math.min(configured.length, 3)} models...\n`,
          ),
        );
        const result = await benchmarkModels(text, configured);
        process.stdout.write(
          chalk.dim("───────────────────────────────────────\n"),
        );
        for (const r of result.results) {
          const icon = r.error ? "❌" : "✅";
          process.stdout.write(
            `${icon} ${chalk.bold(r.label)} (${r.provider})\n`,
          );
          process.stdout.write(
            chalk.dim(
              `   ${r.latencyMs}ms · ${r.responseLength} chars · $${r.cost.toFixed(6)}\n`,
            ),
          );
          if (r.error)
            process.stdout.write(chalk.red(`   ${r.error.slice(0, 100)}\n`));
        }
        process.stdout.write(
          chalk.dim("───────────────────────────────────────\n"),
        );
        process.stdout.write(
          chalk.green(
            `⚡ Fastest: ${result.fastest} · 💰 Cheapest: ${result.cheapest} · 📝 Longest: ${result.longest}\n\n`,
          ),
        );
        return;
      }

      // ── /quota — Usage Quota Management ────────────────────────────────
      if (submission.command === "quota") {
        const text = (submission.text ?? "").trim();
        const { loadQuota, setQuotaLimit, checkQuota, saveQuota } =
          await import("@hex4code/core/models/model-router");
        const parts = text.split(/\s+/).filter(Boolean);
        const subCmd = parts[0]?.toLowerCase() || "status";
        if (subCmd === "set" && parts.length >= 3) {
          const tokenLimit = parseInt(parts[1], 10) || 0;
          const costLimit = parseFloat(parts[2]) || 0;
          setQuotaLimit(tokenLimit, costLimit);
          process.stdout.write(
            chalk.green(
              `Quota set: ${tokenLimit.toLocaleString()} tokens / $${costLimit.toFixed(2)} per month\n`,
            ),
          );
        } else if (subCmd === "reset") {
          const q = loadQuota();
          q.currentTokens = 0;
          q.currentCost = 0;
          q.periodStart = Date.now();
          saveQuota(q);
          process.stdout.write(chalk.green("Monthly usage reset\n"));
        } else {
          const status = checkQuota();
          const q = status.quota;
          process.stdout.write(themeChalk.accentStrongBold("\nQuota Status\n"));
          process.stdout.write(
            chalk.dim("───────────────────────────────────────\n"),
          );
          process.stdout.write(
            `Token Limit: ${q.monthlyTokenLimit > 0 ? q.monthlyTokenLimit.toLocaleString() : "unlimited"}\n`,
          );
          process.stdout.write(
            `Cost Limit: ${q.monthlyCostLimit > 0 ? `$${q.monthlyCostLimit.toFixed(2)}` : "unlimited"}\n`,
          );
          process.stdout.write(
            `Used Tokens: ${q.currentTokens.toLocaleString()}\n`,
          );
          process.stdout.write(`Used Cost: $${q.currentCost.toFixed(6)}\n`);
          process.stdout.write(`Usage: ${status.usagePercent.toFixed(1)}%\n`);
          process.stdout.write(
            `Status: ${status.allowed ? chalk.green("OK") : chalk.red("EXCEEDED")}\n`,
          );
          process.stdout.write(
            chalk.dim("───────────────────────────────────────\n"),
          );
          process.stdout.write(
            chalk.dim("  /quota set <tokenLimit> <costLimit>  — set limits\n"),
          );
          process.stdout.write(
            chalk.dim(
              "  /quota reset                         — reset monthly usage\n\n",
            ),
          );
        }
        return;
      }

      // ── /insights — Route History Insights ─────────────────────────────
      if (submission.command === "insights") {
        const { getRouteInsights, getSuggestedWeights } =
          await import("@hex4code/core/models/model-router");
        const insights = getRouteInsights();
        process.stdout.write(themeChalk.accentStrongBold("\nRoute Insights\n"));
        process.stdout.write(
          chalk.dim("───────────────────────────────────────\n"),
        );
        if (insights.length === 0) {
          process.stdout.write(
            chalk.yellow(
              "No route history yet. Use the assistant to generate data.\n",
            ),
          );
        } else {
          for (const i of insights) {
            process.stdout.write(
              `\n${chalk.bold(i.taskType)} — ${i.totalCalls} calls\n`,
            );
            process.stdout.write(
              `  Success: ${(i.successRate * 100).toFixed(0)}%  Latency: ${i.avgLatency.toFixed(0)}ms  Cost: $${i.avgCost.toFixed(6)}\n`,
            );
            process.stdout.write(`  Best: ${chalk.green(i.bestModel)}\n`);
            const weights = getSuggestedWeights(i.taskType);
            if (weights)
              process.stdout.write(
                chalk.dim(
                  `  Suggested weights: cost=${weights.cost} cap=${weights.capability} ctx=${weights.context} speed=${weights.speed}\n`,
                ),
              );
            for (const m of i.modelRankings.slice(0, 3)) {
              process.stdout.write(
                chalk.dim(
                  `    ${m.model}: ${(m.successRate * 100).toFixed(0)}% success · ${m.avgLatency.toFixed(0)}ms avg · ${m.calls} calls\n`,
                ),
              );
            }
          }
        }
        process.stdout.write(
          chalk.dim("───────────────────────────────────────\n\n"),
        );
        return;
      }

      // ── /compact — Manual Context Compaction ────────────────────────────
      if (submission.command === "compact") {
        const activeId = sessionManager.getActiveSessionId();
        if (!activeId) {
          process.stdout.write(chalk.yellow("No active session to compact.\n"));
          return;
        }
        const session = sessionManager.getSession(activeId);
        if (!session) {
          process.stdout.write(chalk.yellow("Session not found.\n"));
          return;
        }
        const msgs = sessionManager.listSessionMessages(activeId);
        const nonCompacted = msgs.filter(
          (m) => !m.compacted && m.role !== "system",
        );
        if (nonCompacted.length < 4) {
          process.stdout.write(
            chalk.yellow(
              `Not enough messages to compact (need 4+, have ${nonCompacted.length}).\n`,
            ),
          );
          return;
        }
        process.stdout.write(
          themeChalk.accent("Compacting session context...\n"),
        );
        try {
          await sessionManager.compactSession(activeId);
          const updated = sessionManager.getSession(activeId);
          const after = updated?.activeTokens ?? 0;
          process.stdout.write(chalk.green("Compaction complete.\n"));
          process.stdout.write(
            chalk.dim(
              `  Tokens: ${session.activeTokens.toLocaleString()} → ${after.toLocaleString()}\n`,
            ),
          );
          process.stdout.write(
            chalk.dim(`  Messages compacted: ${nonCompacted.length}\n`),
          );
        } catch (err: unknown) {
          process.stdout.write(
            chalk.red(
              `Compaction failed: ${err instanceof Error ? err.message : String(err)}\n`,
            ),
          );
        }
        process.stdout.write("\n");
        return;
      }

      // ── /config — Show Current Configuration ─────────────────────────╼
      if (submission.command === "config") {
        const resolved = resolveCurrentSettings(projectRoot);
        const configured = detectConfiguredProviders(process.env);
        let modelDef: any = null;
        try {
          const m = await import("@hex4code/core/models/provider-registry");
          modelDef = m.getModelDef(resolved.model);
        } catch {
          /* ignore */
        }

        process.stdout.write(
          themeChalk.accentStrongBold("\nCurrent Configuration\n"),
        );
        process.stdout.write(chalk.dim("═══════════════════════════════\n"));

        process.stdout.write(chalk.bold("Model:\n"));
        process.stdout.write(
          `  ID:           ${chalk.green(resolved.model)}\n`,
        );
        if (modelDef) {
          process.stdout.write(`  Label:        ${modelDef.label}\n`);
          process.stdout.write(`  Provider:     ${modelDef.provider}\n`);
          process.stdout.write(
            `  Ctx Window:   ${Math.round(modelDef.contextWindow / 1000)}K tokens\n`,
          );
          process.stdout.write(
            `  Cost (in/out):$${modelDef.costPer1MInput}/$${modelDef.costPer1MOutput} per 1M\n`,
          );
        }

        process.stdout.write(chalk.bold("\nReasoning:\n"));
        process.stdout.write(
          `  Thinking:     ${resolved.thinkingEnabled ? chalk.green("enabled") : chalk.dim("disabled")}\n`,
        );
        process.stdout.write(`  Effort:       ${resolved.reasoningEffort}\n`);

        process.stdout.write(chalk.bold("\nAPI:\n"));
        process.stdout.write(`  Base URL:     ${resolved.baseURL}\n`);
        const keySuffix = resolved.apiKey
          ? "****" + resolved.apiKey.slice(-4)
          : "NOT SET";
        process.stdout.write(
          `  API Key:      ${resolved.apiKey ? chalk.green(keySuffix) : chalk.red(keySuffix)}\n`,
        );

        process.stdout.write(chalk.bold("\nConfigured Providers:\n"));
        if (configured.length === 0) {
          process.stdout.write(chalk.yellow("  (none)\n"));
        } else {
          for (const pid of configured)
            process.stdout.write(`  ${chalk.green("●")} ${pid}\n`);
        }

        process.stdout.write(chalk.bold("\nMCP Servers:\n"));
        if (
          resolved.mcpServers &&
          Object.keys(resolved.mcpServers).length > 0
        ) {
          for (const [name, srv] of Object.entries(resolved.mcpServers)) {
            process.stdout.write(
              `  ${themeChalk.accent(name)}: ${srv.command} ${(srv.args ?? []).join(" ")}\n`,
            );
          }
        } else process.stdout.write(chalk.dim("  (none)\n"));

        process.stdout.write(chalk.bold("\nConfig Sources:\n"));
        const userPath = path.join(os.homedir(), ".hex4code", "settings.json");
        const projectPath = path.join(
          projectRoot,
          ".hex4code",
          "settings.json",
        );
        process.stdout.write(
          `  User:    ${fs.existsSync(userPath) ? chalk.green(userPath) : chalk.dim(userPath + " (not found)")}\n`,
        );
        process.stdout.write(
          `  Project: ${fs.existsSync(projectPath) ? chalk.green(projectPath) : chalk.dim(projectPath + " (not found)")}\n`,
        );
        process.stdout.write(`  Env:     HEX4CODE_* variables\n`);

        process.stdout.write(chalk.dim("═══════════════════════════════\n\n"));
        return;
      }

      // ── /context — Show Context Window Usage ─────────────────────────╼
      if (submission.command === "context") {
        const activeId = sessionManager.getActiveSessionId();
        const resolved = resolveCurrentSettings(projectRoot);
        let ctxWindow = 128000;
        let compactThreshold = 128 * 1024;
        try {
          const mr = await import("@hex4code/core/models/model-router");
          const st = await import("@hex4code/core/session-types");
          ctxWindow = mr.getContextWindow(resolved.model);
          compactThreshold = st.getCompactPromptTokenThreshold(resolved.model);
        } catch {
          /* use defaults */
        }

        process.stdout.write(themeChalk.accentStrongBold("\nContext Usage\n"));
        process.stdout.write(chalk.dim("═══════════════════════════════\n"));
        process.stdout.write(
          `  Model:          ${chalk.green(resolved.model)}\n`,
        );
        process.stdout.write(
          `  Ctx Window:     ${(ctxWindow / 1000).toFixed(0)}K tokens\n`,
        );
        process.stdout.write(
          `  Compact Thd:    ${(compactThreshold / 1000).toFixed(0)}K tokens\n\n`,
        );

        if (!activeId) {
          process.stdout.write(chalk.dim("  No active session.\n"));
        } else {
          const session = sessionManager.getSession(activeId);
          if (session) {
            const ratio = session.activeTokens / ctxWindow;
            const barW = 30;
            const filled = Math.round(Math.min(ratio, 1) * barW);
            const bar = "█".repeat(filled) + "░".repeat(barW - filled);
            const barColor =
              ratio > 0.95
                ? chalk.red
                : ratio > 0.8
                  ? chalk.yellow
                  : chalk.green;
            const status =
              ratio > 0.95
                ? chalk.red("CRITICAL")
                : ratio > 0.8
                  ? chalk.yellow("WARNING")
                  : chalk.green("OK");

            process.stdout.write(
              `  Active Tokens:  ${session.activeTokens.toLocaleString()} / ${ctxWindow.toLocaleString()}\n`,
            );
            process.stdout.write(
              `  Usage:          ${barColor(bar)} ${(ratio * 100).toFixed(1)}%\n`,
            );
            process.stdout.write(`  Status:         ${status}\n`);

            const msgs = sessionManager.listSessionMessages(activeId);
            const compacted = msgs.filter((m) => m.compacted).length;
            const active = msgs.filter((m) => !m.compacted).length;
            process.stdout.write(
              `  Messages:       ${active} active, ${compacted} compacted\n`,
            );
            process.stdout.write(
              `  Total Cost:     $${session.totalCost.toFixed(6)}\n`,
            );

            const remaining = compactThreshold - session.activeTokens;
            if (remaining > 0) {
              process.stdout.write(
                chalk.dim(
                  `  Until compact:  ${(remaining / 1000).toFixed(0)}K tokens remaining\n`,
                ),
              );
            } else {
              process.stdout.write(
                chalk.yellow(
                  "  Above compact threshold — auto-compact will trigger.\n",
                ),
              );
            }
          } else {
            process.stdout.write(chalk.yellow("  Session data unavailable.\n"));
          }
        }
        process.stdout.write(chalk.dim("═══════════════════════════════\n\n"));
        return;
      }

      // ── /doctor — Run Diagnostic Checks ──────────────────────────────╼
      if (submission.command === "doctor") {
        const resolved = resolveCurrentSettings(projectRoot);
        let checks = 0;
        let passes = 0;

        process.stdout.write(
          themeChalk.accentStrongBold("\nDiagnostic Report\n"),
        );
        process.stdout.write(chalk.dim("═══════════════════════════════\n"));

        // 1. Node version
        checks++;
        const nodeVer = process.version;
        const nodeOk = parseInt(nodeVer.slice(1)) >= 18;
        process.stdout.write(nodeOk ? chalk.green("●") : chalk.red("○"));
        process.stdout.write(
          ` Node.js ${nodeVer} ${nodeOk ? chalk.green("OK") : chalk.red("needs >=18")}\n`,
        );
        if (nodeOk) passes++;

        // 2. API key
        checks++;
        if (resolved.apiKey) {
          process.stdout.write(
            chalk.green("●") + chalk.green(" API Key configured\n"),
          );
          passes++;
        } else {
          process.stdout.write(
            chalk.red("○") + chalk.red(" API Key NOT set\n"),
          );
        }

        // 3. Provider connection tests
        const configured = detectConfiguredProviders(process.env);
        if (configured.length > 0) {
          process.stdout.write(chalk.dim("  Testing providers...\n"));
          for (const pid of configured) {
            checks++;
            try {
              const { testProviderConnection } =
                await import("@hex4code/core/models/model-router");
              const { getProvider } =
                await import("@hex4code/core/models/provider-registry");
              const p = getProvider(pid);
              if (!p) {
                process.stdout.write(`  ${chalk.red("○")} ${pid}: unknown\n`);
                continue;
              }
              const testModel =
                p.models.find((m: any) => m.capabilities.includes("chat")) ||
                p.models[0];
              const key = process.env[p.apiKeyEnv] || resolved.apiKey || "";
              if (!key) {
                process.stdout.write(`  ${chalk.yellow("○")} ${pid}: no key\n`);
                continue;
              }
              const result = await testProviderConnection(
                testModel.id,
                key,
                p.defaultBaseURL,
              );
              if (result.ok) {
                process.stdout.write(
                  `  ${chalk.green("●")} ${pid}: OK (${result.latencyMs}ms)\n`,
                );
                passes++;
              } else {
                process.stdout.write(
                  `  ${chalk.red("○")} ${pid}: ${result.error.slice(0, 60)}\n`,
                );
              }
            } catch {
              process.stdout.write(`  ${chalk.red("○")} ${pid}: test failed\n`);
            }
          }
        } else {
          process.stdout.write(chalk.yellow("○ No providers configured\n"));
          checks++;
        }

        // 4. MCP servers
        checks++;
        if (
          resolved.mcpServers &&
          Object.keys(resolved.mcpServers).length > 0
        ) {
          const statuses = sessionManager.getMcpStatus();
          const ready = statuses.filter((s) => s.status === "ready").length;
          process.stdout.write(
            `${ready === statuses.length ? chalk.green("●") : chalk.yellow("●")} MCP: ${ready}/${statuses.length} ready\n`,
          );
          if (ready === statuses.length) passes++;
        } else {
          process.stdout.write(
            chalk.dim("●") + chalk.dim(" MCP: not configured\n"),
          );
          passes++;
        }

        // 5. Project config
        checks++;
        const projCfgPath = path.join(
          projectRoot,
          ".hex4code",
          "settings.json",
        );
        process.stdout.write(
          fs.existsSync(projCfgPath)
            ? chalk.green("●") +
                chalk.green(" Project config: .hex4code/settings.json\n")
            : chalk.dim("●") + chalk.dim(" Project config: none\n"),
        );
        passes++;

        // Summary
        const pct = Math.round((passes / checks) * 100);
        const sumColor =
          pct === 100 ? chalk.green : pct >= 70 ? chalk.yellow : chalk.red;
        process.stdout.write(chalk.dim("─────────────────────────────────\n"));
        process.stdout.write(
          sumColor(`  ${passes}/${checks} checks passed (${pct}%)\n`),
        );
        process.stdout.write(chalk.dim("═══════════════════════════════\n\n"));
        return;
      }

      // ── /memory — Manage Long-Term Memory ────────────────────────────╼
      if (submission.command === "memory") {
        const text = (submission.text ?? "").trim();
        const parts = text.split(/\s+/).filter(Boolean);
        const subCmd = parts[0]?.toLowerCase() || "list";
        const memoryPath = path.join(os.homedir(), ".hex4code", "memory.json");

        const loadMemory = (): Array<{
          id: string;
          text: string;
          createdAt: string;
        }> => {
          try {
            if (fs.existsSync(memoryPath))
              return JSON.parse(fs.readFileSync(memoryPath, "utf8"));
          } catch {
            /* ignore */
          }
          return [];
        };
        const saveMemory = (
          items: Array<{
            id: string;
            text: string;
            createdAt: string;
          }>,
        ) => {
          fs.mkdirSync(path.dirname(memoryPath), {
            recursive: true,
          });
          fs.writeFileSync(memoryPath, JSON.stringify(items, null, 2), "utf8");
        };

        process.stdout.write(
          themeChalk.accentStrongBold("\nLong-Term Memory\n"),
        );
        process.stdout.write(chalk.dim("═══════════════════════════════\n"));

        if (subCmd === "list" || subCmd === "ls") {
          const items = loadMemory();
          if (items.length === 0) {
            process.stdout.write(chalk.dim("  No memories stored.\n"));
            process.stdout.write(
              chalk.dim("  Use /memory add <text> to create one.\n"),
            );
          } else {
            for (const item of items) {
              process.stdout.write(
                `  ${themeChalk.accent(item.id.slice(0, 6))}  ${item.text.slice(0, 70)}\n`,
              );
              process.stdout.write(chalk.dim(`       ${item.createdAt}\n`));
            }
          }
        } else if (subCmd === "add") {
          const content = parts.slice(1).join(" ").trim();
          if (!content) {
            process.stdout.write(chalk.yellow("Usage: /memory add <text>\n"));
          } else {
            const items = loadMemory();
            const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            items.push({
              id,
              text: content,
              createdAt: new Date().toISOString(),
            });
            saveMemory(items);
            process.stdout.write(
              chalk.green(
                `  Memory added: ${id.slice(0, 6)} → "${content.slice(0, 50)}"\n`,
              ),
            );
          }
        } else if (subCmd === "delete" || subCmd === "rm") {
          const idPrefix = parts[1] || "";
          const items = loadMemory();
          const idx = items.findIndex((i) => i.id.startsWith(idPrefix));
          if (idx === -1) {
            process.stdout.write(
              chalk.red(`  Memory "${idPrefix}" not found.\n`),
            );
          } else {
            const removed = items.splice(idx, 1)[0];
            saveMemory(items);
            process.stdout.write(
              chalk.green(`  Memory deleted: "${removed.text.slice(0, 50)}"\n`),
            );
          }
        } else if (subCmd === "clear") {
          saveMemory([]);
          process.stdout.write(chalk.yellow("  All memories cleared.\n"));
        } else {
          process.stdout.write(
            chalk.dim("  Commands: list, add <text>, delete <id>, clear\n"),
          );
        }
        process.stdout.write(chalk.dim("═══════════════════════════════\n\n"));
        return;
      }

      // ── /release-notes — Show CHANGELOG ──────────────────────────────╼
      if (submission.command === "release-notes") {
        process.stdout.write(
          themeChalk.accentStrongBold("\nRelease Notes (CHANGELOG)\n"),
        );
        process.stdout.write(chalk.dim("═══════════════════════════════\n"));
        const candidates = [
          path.join(projectRoot, "CHANGELOG.md"),
          path.resolve(projectRoot, "..", "CHANGELOG.md"),
          path.resolve(projectRoot, "..", "..", "CHANGELOG.md"),
        ];
        let found = false;
        for (const candidate of candidates) {
          try {
            if (fs.existsSync(candidate)) {
              const raw = fs.readFileSync(candidate, "utf8");
              const match = raw.match(
                /##\s*\[[\d.]+\].*?\n([\s\S]*?)(?=##\s*\[|$)/,
              );
              process.stdout.write(
                (match
                  ? match[0]
                  : raw.split("\n").slice(0, 50).join("\n")
                ).trim() + "\n",
              );
              found = true;
              break;
            }
          } catch {
            /* ignore */
          }
        }
        if (!found)
          process.stdout.write(chalk.dim("  CHANGELOG.md not found.\n"));
        process.stdout.write(chalk.dim("═══════════════════════════════\n\n"));
        return;
      }

      // ── /status — Show Connection Status ─────────────────────────────╼
      if (submission.command === "status") {
        const activeId = sessionManager.getActiveSessionId();
        const resolved = resolveCurrentSettings(projectRoot);
        const configured = detectConfiguredProviders(process.env);
        const activeStatus = activeId
          ? sessionManager.getSession(activeId)
          : null;

        process.stdout.write(
          themeChalk.accentStrongBold("\nConnection Status\n"),
        );
        process.stdout.write(chalk.dim("═══════════════════════════════\n"));

        process.stdout.write(chalk.bold("Active Model:\n"));
        process.stdout.write(`  ${chalk.green(resolved.model)}\n`);
        process.stdout.write(`  Base URL: ${resolved.baseURL}\n`);
        process.stdout.write(
          `  API Key:  ${resolved.apiKey ? chalk.green("configured") : chalk.red("NOT SET")}\n`,
        );

        process.stdout.write(chalk.bold("\nSession:\n"));
        if (activeStatus) {
          const icon =
            activeStatus.status === "completed"
              ? chalk.green("●")
              : activeStatus.status === "processing"
                ? chalk.yellow("●")
                : activeStatus.status === "failed"
                  ? chalk.red("●")
                  : chalk.dim("●");
          process.stdout.write(`  ${icon} ${activeStatus.status}\n`);
          process.stdout.write(`  ID:      ${activeStatus.id.slice(0, 8)}\n`);
          process.stdout.write(
            `  Tokens:  ${activeStatus.activeTokens.toLocaleString()}\n`,
          );
          process.stdout.write(
            `  Cost:    $${activeStatus.totalCost.toFixed(6)}\n`,
          );
        } else {
          process.stdout.write(chalk.dim("  No active session\n"));
        }

        process.stdout.write(chalk.bold("\nProviders:\n"));
        if (configured.length === 0) {
          process.stdout.write(chalk.yellow("  None configured\n"));
        } else {
          for (const pid of configured) {
            try {
              const { getProvider } =
                await import("@hex4code/core/models/provider-registry");
              const p = getProvider(pid);
              const keySet = p ? process.env[p.apiKeyEnv] : null;
              process.stdout.write(
                `  ${chalk.green("●")} ${p?.name || pid}${keySet ? chalk.green(" (key set)") : chalk.yellow(" (no key)")}\n`,
              );
            } catch {
              process.stdout.write(`  ${chalk.green("●")} ${pid}\n`);
            }
          }
        }
        process.stdout.write(chalk.dim("═══════════════════════════════\n\n"));
        return;
      }

      if (submission.command === "provider") {
        const text = (submission.text ?? "").trim();
        const parts = text.split(/\s+/).filter(Boolean);
        const subCmd = parts[0]?.toLowerCase() || "list";

        if (subCmd === "list" || subCmd === "ls") {
          const configured = detectConfiguredProviders(process.env);
          process.stdout.write(
            themeChalk.accentStrongBold("\nAI Providers:\n"),
          );
          process.stdout.write(chalk.dim("─────────────────\n"));
          for (const p of PROVIDERS) {
            const isConfigured = configured.includes(p.id);
            const icon = isConfigured ? chalk.green("●") : chalk.red("○");
            const status = isConfigured
              ? chalk.green(`ENV ${p.apiKeyEnv}`)
              : chalk.dim(`unconfigured`);
            process.stdout.write(
              `  ${icon} ${chalk.bold(p.name)}  ${status}\n`,
            );
            process.stdout.write(chalk.dim(`     ${p.defaultBaseURL}\n`));
            process.stdout.write(
              chalk.dim(
                `     ${p.models.length} models · ${p.models.map((m) => m.label).join(", ")}\n`,
              ),
            );
          }
          process.stdout.write(chalk.dim("─────────────────\n"));
        } else if (subCmd === "set") {
          const providerName = parts.slice(1).join(" ");
          const provider = PROVIDERS.find(
            (p) =>
              p.name.toLowerCase().includes(providerName.toLowerCase()) ||
              p.id.toLowerCase().includes(providerName.toLowerCase()),
          );
          if (!provider) {
            process.stdout.write(
              chalk.red(
                `❌ Provider "${providerName}" not found. Use /provider list\n`,
              ),
            );
          } else {
            process.stdout.write(
              themeChalk.accent(`\nEnter API key for ${provider.name}\n`),
            );
            process.stdout.write(
              chalk.dim(`  (press Enter to use ENV ${provider.apiKeyEnv})\n`),
            );
            process.stdout.write("> ");
            const readline = require("readline");
            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            const key = await new Promise<string>((resolve) => {
              rl.question("", (answer: string) => {
                rl.close();
                resolve(answer.trim());
              });
            });
            // Clear the input line for security
            process.stdout.write("\x1B[1A\x1B[2K");
            process.stdout.write(
              chalk.dim(`> ${key ? "************" : "(using ENV)"}\n`),
            );

            if (key) {
              const settingsPath = path.join(
                os.homedir(),
                ".hex4code",
                "settings.json",
              );
              let settings: Record<string, unknown> = {};
              try {
                if (fs.existsSync(settingsPath)) {
                  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
                }
              } catch {
                /* ignore */
              }
              settings[`${provider.id}ApiKey`] = key;
              fs.mkdirSync(path.join(os.homedir(), ".hex4code"), {
                recursive: true,
              });
              fs.writeFileSync(
                settingsPath,
                JSON.stringify(settings, null, 2),
                "utf8",
              );
              process.stdout.write(
                chalk.green(
                  `✅ ${provider.name} API key saved to ~/.hex4code/settings.json\n`,
                ),
              );
              // ── API Key Verification ──────────────────────────────
              process.stdout.write(chalk.dim(`⏳ Testing connection...`));
              try {
                const { testProviderConnection } =
                  await require("@hex4code/core/models/model-router");
                const testModel =
                  provider.models.find((m) =>
                    m.capabilities.includes("chat" as any),
                  ) || provider.models[0];
                const result = await testProviderConnection(testModel.id, key);
                if (result.ok) {
                  process.stdout.write("\r\x1B[K");
                  process.stdout.write(
                    chalk.green(`✅ Connection OK (${result.latencyMs}ms)\n`),
                  );
                } else {
                  process.stdout.write("\r\x1B[K");
                  process.stdout.write(
                    chalk.yellow(
                      `⚠️  Connection failed: ${result.error.slice(0, 80)}\n`,
                    ),
                  );
                }
              } catch {
                process.stdout.write("\r\x1B[K");
              }
            } else {
              const envKey = process.env[provider.apiKeyEnv];
              if (envKey) {
                process.stdout.write(
                  chalk.green(
                    `✅ Using ENV ${provider.apiKeyEnv} for ${provider.name}\n`,
                  ),
                );
              } else {
                process.stdout.write(
                  chalk.yellow(`⚠️  ENV ${provider.apiKeyEnv} not set\n`),
                );
              }
            }
          }
        } else if (subCmd === "status" || subCmd === "health") {
          process.stdout.write(
            themeChalk.accentStrongBold("\nProvider Health:\n"),
          );
          process.stdout.write(
            chalk.dim("───────────────────────────────────────\n"),
          );
          const configured = detectConfiguredProviders(process.env);
          if (configured.length === 0) {
            process.stdout.write(chalk.yellow("  No providers configured.\n"));
            process.stdout.write(
              chalk.dim("  Use /provider set <name> to configure one.\n"),
            );
          } else {
            // Test all configured providers in parallel
            const results = await Promise.allSettled(
              configured.map(async (pid) => {
                const p = PROVIDERS.find((pr) => pr.id === pid);
                if (!p)
                  return {
                    id: pid,
                    ok: false,
                    latency: 0,
                    error: "Unknown provider",
                  };
                const key = process.env[p.apiKeyEnv] || "";
                const testModel =
                  p.models.find((m) =>
                    m.capabilities.includes("chat" as any),
                  ) || p.models[0];
                const { testProviderConnection } =
                  await require("@hex4code/core/models/model-router");
                return {
                  id: pid,
                  result: await testProviderConnection(
                    testModel.id,
                    key,
                    p.defaultBaseURL,
                  ),
                  provider: p,
                };
              }),
            );
            for (const r of results) {
              if (r.status === "fulfilled") {
                const d = r.value;
                const icon = d.result.ok ? chalk.green("●") : chalk.red("○");
                const latencyStr = d.result.ok
                  ? chalk.dim(` (${d.result.latencyMs}ms)`)
                  : "";
                const errorStr = d.result.ok
                  ? ""
                  : chalk.yellow(`  ${d.result.error.slice(0, 60)}`);
                const providerName = (d as any).provider?.name || d.id;
                process.stdout.write(
                  `  ${icon} ${chalk.bold(providerName)}${latencyStr}\n`,
                );
                if (errorStr) process.stdout.write(`     ${errorStr}\n`);
              } else {
                process.stdout.write(
                  `  ${chalk.red("○")} ${chalk.bold(r.reason?.toString().slice(0, 40) || "unknown")}\n`,
                );
              }
            }
          }
          process.stdout.write(
            chalk.dim("───────────────────────────────────────\n"),
          );
        } else {
          process.stdout.write(
            chalk.yellow("Commands: list, set <name>, status, health\n"),
          );
        }
        process.stdout.write("\n");
        return;
      }

      const prompt: UserPromptContent = {
        text: submission.text,
        imageUrls: submission.imageUrls,
        skills:
          submission.selectedSkills && submission.selectedSkills.length > 0
            ? submission.selectedSkills
            : undefined,
      };

      const trimmedText = (submission.text ?? "").trim();
      const selectedSkillNames =
        submission.selectedSkills?.map((skill) => skill.name).filter(Boolean) ??
        [];
      const userDisplayContent =
        trimmedText ||
        (selectedSkillNames.length > 0
          ? `Use skills: ${selectedSkillNames.join(", ")}`
          : "") ||
        (submission.imageUrls.length > 0 ? "[Image]" : "");

      if (userDisplayContent) {
        setMessages((prev) => [
          ...prev,
          buildSyntheticUserMessage(
            userDisplayContent,
            submission.imageUrls.length,
          ),
        ]);
      }

      setBusy(true);
      setErrorLine(null);
      setRunningProcesses(null);
      try {
        await sessionManager.handleUserPrompt(prompt);
        await refreshSkills();
        refreshSessionsList();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorLine(message);
      } finally {
        setBusy(false);
        setStreamProgress(null);
        setRunningProcesses(null);
      }
    },
    [
      exit,
      onRestart,
      projectRoot,
      sessionManager,
      refreshSkills,
      refreshSessionsList,
    ],
  );

  const handleInterrupt = useCallback(() => {
    sessionManager.interruptActiveSession();
  }, [sessionManager]);

  const handleModelConfigChange = useCallback(
    (selection: ModelConfigSelection): string => {
      const current = resolveCurrentSettings(projectRoot);
      const { changed } = writeModelConfigSelection(
        selection,
        current,
        projectRoot,
      );
      const next = resolveCurrentSettings(projectRoot);
      setResolvedSettings(next);

      if (!changed) {
        return "Model settings unchanged";
      }

      const activeSessionId = sessionManager.getActiveSessionId();
      const meta: MessageMeta = {
        isModelChange: true,
      };
      const content = `/model\n└ Set model to ${selection.model} (${selection?.thinkingEnabled ? selection?.reasoningEffort : "no thinking"})`;

      if (activeSessionId) {
        sessionManager.addSessionSystemMessage(
          activeSessionId,
          content,
          true,
          meta,
        );
      } else {
        const now = new Date().toISOString();
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            sessionId: "local",
            role: "system" as const,
            content,
            contentParams: null,
            messageParams: null,
            compacted: false,
            visible: true,
            createTime: now,
            updateTime: now,
            meta,
          },
        ]);
      }

      return `Model settings updated: ${formatModelConfig(current)} → ${formatModelConfig(next)}`;
    },
    [projectRoot, sessionManager],
  );

  const handleSubmit = useCallback(
    (submission: PromptSubmission) => {
      void handlePrompt(submission);
    },
    [handlePrompt],
  );

  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      const currentSessionId = sessionManager.getActiveSessionId();
      if (currentSessionId !== sessionId) {
        process.stdout.write("\u001B[2J\u001B[3J\u001B[H");
      }
      sessionManager.setActiveSessionId(sessionId);
      // Clear first so <Static> resets its index to 0.
      setMessages([]);
      setShowWelcome(false);
      setWelcomeNonce((n) => n + 1);
      setView("chat");
      // Load messages after the reset so all static items are rendered.
      setTimeout(() => {
        setMessages(loadVisibleMessages(sessionManager, sessionId));
        setShowWelcome(true);
      }, 0);
      const session = sessionManager.getSession(sessionId);
      setStatusLine(session ? buildStatusLine(session) : "");
      setRunningProcesses(session?.processes ?? null);
      setActiveStatus(session?.status ?? null);
      await refreshSkills(sessionId);
    },
    [sessionManager, refreshSkills],
  );

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      const activeId = sessionManager.getActiveSessionId();
      const deleted = sessionManager.deleteSession(sessionId);
      if (deleted && activeId === sessionId) {
        sessionManager.setActiveSessionId(null);
        setMessages([]);
        setStatusLine("");
        setRunningProcesses(null);
        setActiveStatus(null);
      }
      refreshSessionsList();
    },
    [sessionManager, refreshSessionsList],
  );

  const handleExportSession = useCallback(
    (sessionId: string) => {
      try {
        const outPath = sessionManager.exportSession(sessionId);
        process.stderr.write(`\n✅ Exported to ${outPath}\n`);
      } catch (error) {
        process.stderr.write(
          `\n❌ Export failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    },
    [sessionManager],
  );

  const handleRenameSession = useCallback(
    (sessionId: string, newName: string) => {
      sessionManager.renameSession(sessionId, newName);
      refreshSessionsList();
      const activeId = sessionManager.getActiveSessionId();
      if (activeId === sessionId) {
        setStatusLine((prev) => prev); // trigger re-render with updated summary
      }
    },
    [sessionManager, refreshSessionsList],
  );

  const [stableColumns, setStableColumns] = useState(columns);
  useEffect(() => {
    const timer = setTimeout(() => setStableColumns(columns), 100);
    return () => clearTimeout(timer);
  }, [columns]);
  const lastRenderedColumnsRef = useRef<number | null>(null);
  useEffect(() => {
    if (!stdout?.isTTY) {
      return;
    }
    if (stableColumns <= 0) {
      return;
    }
    if (lastRenderedColumnsRef.current === null) {
      lastRenderedColumnsRef.current = stableColumns;
      return;
    }
    if (lastRenderedColumnsRef.current === stableColumns) {
      return;
    }
    lastRenderedColumnsRef.current = stableColumns;

    // Force full redraw on terminal resize to avoid stale wrapped rows.
    writeRef.current("\u001B[2J\u001B[H");
    setMessages([]);
    setShowWelcome(false);
    setWelcomeNonce((n) => n + 1);

    const activeSessionId = sessionManager.getActiveSessionId();
    const nextMessages =
      activeSessionId && !busy
        ? loadVisibleMessages(sessionManager, activeSessionId)
        : messagesRef.current;
    setTimeout(() => {
      setMessages(nextMessages);
      setShowWelcome(true);
    }, 0);
  }, [busy, sessionManager, stableColumns, stdout]);
  const screenWidth = useMemo(
    () => stableColumns ?? stdout?.columns ?? 80,
    [stableColumns, stdout],
  );
  const promptHistory = useMemo(() => {
    return messages
      .filter(
        (message) =>
          message.role === "user" && typeof message.content === "string",
      )
      .map((message) => (message.content ?? "").trim())
      .filter((content) => content.length > 0);
  }, [messages]);
  const expandedThinkingId = findExpandedThinkingId(messages);
  const pendingQuestion = useMemo(
    () => findPendingAskUserQuestion(messages, activeStatus),
    [activeStatus, messages],
  );
  const shouldShowQuestionPrompt = Boolean(
    pendingQuestion && !dismissedQuestionIds.has(pendingQuestion.messageId),
  );
  const loadingText = useMemo(
    () =>
      busy
        ? buildLoadingText({
            progress: streamProgress,
            processes: runningProcesses,
            now: Date.now(),
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nowTick forces periodic recalculation for spinner animation
    [busy, streamProgress, runningProcesses, nowTick],
  );
  const welcomeSettings = resolvedSettings;
  const welcomeItem: SessionMessage = useMemo(
    () => ({
      id: `__welcome__${welcomeNonce}`,
      sessionId: "",
      role: "system",
      content: "",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: "",
      updateTime: "",
    }),
    [welcomeNonce],
  );
  const staticItems = useMemo(() => {
    if (showWelcome && view === "chat") {
      return [welcomeItem, ...messages];
    }
    return messages;
  }, [showWelcome, view, messages, welcomeItem]);

  const handleQuestionAnswers = useCallback(
    (answers: AskUserQuestionAnswers) => {
      void handlePrompt({
        text: formatAskUserQuestionAnswers(answers),
        imageUrls: [],
      });
    },
    [handlePrompt],
  );

  const handleQuestionCancel = useCallback(() => {
    if (!pendingQuestion) {
      return;
    }
    setDismissedQuestionIds((prev) =>
      new Set(prev).add(pendingQuestion.messageId),
    );
  }, [pendingQuestion]);

  return (
    <Box
      flexDirection="column"
      width={screenWidth}
      minWidth={80}
      overflowX={"visible"}
    >
      <Static items={staticItems}>
        {(item) => {
          if (item.id.startsWith("__welcome__")) {
            return (
              <WelcomeScreen
                key={item.id}
                projectRoot={projectRoot}
                settings={welcomeSettings}
                skills={skills}
                version={version}
                width={screenWidth}
              />
            );
          }
          return (
            <MessageView
              key={item.id}
              message={item}
              collapsed={isCollapsedThinking(item, expandedThinkingId)}
              width={screenWidth}
            />
          );
        }}
      </Static>
      {statusLine ? (
        <Box>
          <Text dimColor>{statusLine}</Text>
        </Box>
      ) : null}
      {errorLine ? (
        <Box>
          <Text color="red">Error: {errorLine}</Text>
        </Box>
      ) : null}
      {view === "session-list" ? (
        <SessionList
          sessions={sessions}
          onSelect={(id) => void handleSelectSession(id)}
          onCancel={() => setView("chat")}
          onDelete={(id) => handleDeleteSession(id)}
          onExport={(id) => handleExportSession(id)}
          onRename={(id, name) => handleRenameSession(id, name)}
        />
      ) : shouldShowQuestionPrompt && pendingQuestion && !busy ? (
        <AskUserQuestionPrompt
          questions={pendingQuestion.questions}
          onSubmit={handleQuestionAnswers}
          onCancel={handleQuestionCancel}
        />
      ) : isExiting ? null : (
        <PromptInput
          screenWidth={screenWidth}
          skills={skills}
          modelConfig={resolvedSettings}
          promptHistory={promptHistory}
          busy={busy}
          loadingText={loadingText}
          onSubmit={handleSubmit}
          onModelConfigChange={handleModelConfigChange}
          onInterrupt={handleInterrupt}
          placeholder="Type your message..."
        />
      )}
    </Box>
  );
}

function isCollapsedThinking(
  message: SessionMessage,
  expandedId: string | null,
): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if (!message.meta?.asThinking) {
    return false;
  }
  return message.id !== expandedId;
}

function buildSyntheticUserMessage(
  content: string,
  imageCount: number,
): SessionMessage {
  const now = new Date().toISOString();
  return {
    id: `local-${Math.random().toString(36).slice(2)}`,
    sessionId: "local",
    role: "user",
    content,
    contentParams:
      imageCount > 0
        ? Array.from({ length: imageCount }, () => ({
            type: "image_url",
            image_url: { url: "" },
          }))
        : null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
  };
}

function buildStatusLine(entry: SessionEntry): string {
  const parts: string[] = [];
  parts.push(`status: ${entry.status}`);
  const mode = (globalThis as any).__HEX4CODE_AGENT_MODE__;
  if (mode) parts.push(`mode: ${mode}`);
  // Read model from settings for display
  const settings = readSettings();
  if (settings?.model) parts.push(`model: ${settings.model}`);
  if (typeof entry.totalCost === "number" && entry.totalCost > 0) {
    parts.push(`cost: $${entry.totalCost.toFixed(6)}`);
  }
  if (typeof entry.activeTokens === "number" && entry.activeTokens > 0) {
    parts.push(`tokens: ${entry.activeTokens}`);
  }
  if (entry.failReason) {
    parts.push(`fail: ${entry.failReason}`);
  }
  return parts.join(" · ");
}

export function readSettings(): Hex4codeSettings | null {
  return readSettingsFile(getUserSettingsPath());
}

export function readProjectSettings(
  projectRoot: string = process.cwd(),
): Hex4codeSettings | null {
  return readSettingsFile(getProjectSettingsPath(projectRoot));
}

function readSettingsFile(settingsPath: string): Hex4codeSettings | null {
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

export function writeSettings(settings: Hex4codeSettings): void {
  const settingsPath = getUserSettingsPath();
  writeSettingsFile(settingsPath, settings);
}

export function writeProjectSettings(
  settings: Hex4codeSettings,
  projectRoot: string = process.cwd(),
): void {
  const settingsPath = getProjectSettingsPath(projectRoot);
  writeSettingsFile(settingsPath, settings);
}

function writeSettingsFile(
  settingsPath: string,
  settings: Hex4codeSettings,
): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
}

export function writeModelConfigSelection(
  selection: ModelConfigSelection,
  current: ModelConfigSelection = resolveCurrentSettings(),
  projectRoot: string = process.cwd(),
): { changed: boolean; settings: Hex4codeSettings } {
  const projectSettingsPath = getProjectSettingsPath(projectRoot);
  const shouldWriteProjectSettings = fs.existsSync(projectSettingsPath);
  const rawSettings = shouldWriteProjectSettings
    ? readProjectSettings(projectRoot)
    : readSettings();
  const result = applyModelConfigSelection(rawSettings, current, selection);
  if (result.changed) {
    if (shouldWriteProjectSettings) {
      writeProjectSettings(result.settings, projectRoot);
    } else {
      writeSettings(result.settings);
    }
  }
  return result;
}

export function resolveCurrentSettings(
  projectRoot: string = process.cwd(),
): ResolvedHex4codeSettings {
  return resolveSettingsSources(
    readSettings(),
    readProjectSettings(projectRoot),
    {
      model: DEFAULT_MODEL,
      baseURL: DEFAULT_BASE_URL,
    },
    process.env,
  );
}

export function createOpenAIClient(projectRoot: string = process.cwd()): {
  client: OpenAI | null;
  model: string;
  baseURL: string;
  thinkingEnabled: boolean;
  reasoningEffort: "high" | "max";
  debugLogEnabled: boolean;
  notify?: string;
  webSearchTool?: string;
  env: Record<string, string>;
  machineId?: string;
} {
  const settings = resolveCurrentSettings(projectRoot);

  // Use multi-model routing engine to select the chat model
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
  const routedBaseURL = route.baseURL;
  const routedApiKey = route.apiKey;

  if (!routedApiKey) {
    return {
      client: null,
      model: routedModel,
      baseURL: routedBaseURL,
      thinkingEnabled: settings.thinkingEnabled,
      reasoningEffort: settings.reasoningEffort,
      debugLogEnabled: settings.debugLogEnabled,
      notify: settings.notify,
      webSearchTool: settings.webSearchTool,
      env: settings.env,
      machineId: getMachineId(),
    };
  }

  const client = createClient({
    modelId: routedModel,
    apiKey: routedApiKey,
    baseURL: routedBaseURL,
  });
  const openaiClient =
    client && "chat" in client
      ? (client as unknown as OpenAI)
      : new OpenAI({
          apiKey: routedApiKey,
          baseURL: routedBaseURL || undefined,
        });
  return {
    client: openaiClient,
    model: routedModel,
    baseURL: routedBaseURL,
    thinkingEnabled: settings.thinkingEnabled,
    reasoningEffort: settings.reasoningEffort,
    debugLogEnabled: settings.debugLogEnabled,
    notify: settings.notify,
    webSearchTool: settings.webSearchTool,
    env: settings.env,
    machineId: getMachineId(),
  };
}

function getMachineId(): string | undefined {
  try {
    const idPath = path.join(os.homedir(), ".hex4code", "machine-id");
    if (fs.existsSync(idPath)) {
      const raw = fs.readFileSync(idPath, "utf8").trim();
      if (raw) {
        return raw;
      }
    }
    const generated = `${os.hostname()}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    fs.mkdirSync(path.dirname(idPath), { recursive: true });
    fs.writeFileSync(idPath, generated, "utf8");
    return generated;
  } catch {
    return undefined;
  }
}

function getUserSettingsPath(): string {
  return path.join(os.homedir(), ".hex4code", "settings.json");
}

function getProjectSettingsPath(projectRoot: string): string {
  return path.join(projectRoot, ".hex4code", "settings.json");
}

function formatThinkingMode(
  settings: Pick<ModelConfigSelection, "thinkingEnabled" | "reasoningEffort">,
): string {
  if (!settings.thinkingEnabled) {
    return "no thinking";
  }
  return `thinking ${settings.reasoningEffort}`;
}

function formatModelConfig(settings: ModelConfigSelection): string {
  return `${settings.model}, ${formatThinkingMode(settings)}`;
}
