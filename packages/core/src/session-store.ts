import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import type { SessionsIndex, SessionEntry, SessionStatus, SessionMessage } from "./session-types";

/**
 * ── Session persistence storage — standalone class ─────────────────────────
 *
 * Extracted from SessionManager; encapsulates all filesystem interactions.
 * Session read/write logic. Requires projectRoot when instantiated.
 */
export class SessionStore {
  constructor(private readonly projectRoot: string) {}

  /* ── Path Utilities ─────────────────────────────────── */

  getProjectCode(projectRoot: string): string {
    return projectRoot.replace(/[\\/]/g, "-").replace(/:/g, "");
  }

  getProjectStorage(): {
    projectCode: string;
    projectDir: string;
    sessionsIndexPath: string;
  } {
    const projectCode = this.getProjectCode(this.projectRoot);
    const projectDir = path.join(os.homedir(), ".hex4code", "projects", projectCode);
    const sessionsIndexPath = path.join(projectDir, "sessions-index.json");
    return { projectCode, projectDir, sessionsIndexPath };
  }

  ensureProjectDir(): string {
    const { projectDir } = this.getProjectStorage();
    fs.mkdirSync(projectDir, { recursive: true });
    return projectDir;
  }

  /* ── Sessions Index ──────────────────────────────── */

  loadSessionsIndex(): SessionsIndex {
    const { sessionsIndexPath } = this.getProjectStorage();
    this.ensureProjectDir();

    if (!fs.existsSync(sessionsIndexPath)) {
      return { version: 1, entries: [], originalPath: this.projectRoot };
    }

    try {
      const raw = fs.readFileSync(sessionsIndexPath, "utf8");
      const parsed = JSON.parse(raw) as SessionsIndex;
      const entries = Array.isArray(parsed.entries)
        ? parsed.entries.map((entry) => this.normalizeSessionEntry(entry))
        : [];
      return {
        version: 1,
        entries,
        originalPath: parsed.originalPath || this.projectRoot,
      };
    } catch {
      return { version: 1, entries: [], originalPath: this.projectRoot };
    }
  }

  saveSessionsIndex(index: SessionsIndex): void {
    const { sessionsIndexPath } = this.getProjectStorage();
    this.ensureProjectDir();
    const normalized = {
      version: 1,
      entries: index.entries.map((entry) => ({
        ...entry,
        processes: this.serializeProcesses(entry.processes),
      })),
      originalPath: this.projectRoot,
    };
    fs.writeFileSync(sessionsIndexPath, JSON.stringify(normalized, null, 2), "utf8");
  }

  /* ── Session Messages ────────────────────────────── */

  getSessionMessagesPath(sessionId: string): string {
    const { projectDir } = this.getProjectStorage();
    return path.join(projectDir, `${sessionId}.jsonl`);
  }

  removeSessionMessages(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      const messagePath = this.getSessionMessagesPath(sessionId);
      try {
        if (fs.existsSync(messagePath)) {
          fs.unlinkSync(messagePath);
        }
      } catch {
        // ignore delete failures
      }
    }
  }

  appendSessionMessage(sessionId: string, message: SessionMessage): void {
    this.ensureProjectDir();
    const messagePath = this.getSessionMessagesPath(sessionId);
    fs.appendFileSync(messagePath, `${JSON.stringify(message)}\n`, "utf8");
  }

  saveSessionMessages(sessionId: string, messages: SessionMessage[]): void {
    this.ensureProjectDir();
    const messagePath = this.getSessionMessagesPath(sessionId);
    const payload = messages.map((message) => JSON.stringify(message)).join("\n");
    fs.writeFileSync(messagePath, payload ? `${payload}\n` : "", "utf8");
  }

  /* ── Entry Serialization ─────────────────────────── */

  private normalizeSessionEntry(entry: unknown): SessionEntry {
    const value = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    return {
      id: typeof value.id === "string" ? value.id : crypto.randomUUID(),
      summary: typeof value.summary === "string" ? value.summary : null,
      assistantReply: typeof value.assistantReply === "string" ? value.assistantReply : null,
      assistantThinking: typeof value.assistantThinking === "string" ? value.assistantThinking : null,
      assistantRefusal: typeof value.assistantRefusal === "string" ? value.assistantRefusal : null,
      toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls : null,
      status: this.normalizeSessionStatus(value.status),
      failReason: typeof value.failReason === "string" ? value.failReason : null,
      usage: value.usage ?? null,
      totalCost: typeof value.totalCost === "number" ? value.totalCost : 0,
      activeTokens: typeof value.activeTokens === "number" ? value.activeTokens : 0,
      createTime: typeof value.createTime === "string" ? value.createTime : new Date().toISOString(),
      updateTime: typeof value.updateTime === "string" ? value.updateTime : new Date().toISOString(),
      processes: this.deserializeProcesses(value.processes),
    };
  }

  private normalizeSessionStatus(status: unknown): SessionStatus {
    if (
      status === "failed" ||
      status === "pending" ||
      status === "processing" ||
      status === "waiting_for_user" ||
      status === "completed" ||
      status === "interrupted"
    ) {
      return status;
    }
    return "pending";
  }

  private deserializeProcesses(value: unknown): Map<string, { startTime: string; command: string }> | null {
    if (!value || typeof value !== "object") {
      return null;
    }
    const processes = new Map<string, { startTime: string; command: string }>();
    for (const [pid, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!pid) {
        continue;
      }
      if (typeof entry === "string") {
        // Backward compatibility for old format where just stored start time
        processes.set(pid, { startTime: entry, command: "Running process..." });
      } else if (typeof entry === "object" && entry !== null) {
        const obj = entry as { startTime?: unknown; command?: unknown };
        const startTime = typeof obj.startTime === "string" ? obj.startTime : new Date().toISOString();
        const command = typeof obj.command === "string" ? obj.command : "Running process...";
        processes.set(pid, { startTime, command });
      }
    }
    return processes.size > 0 ? processes : null;
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
}
