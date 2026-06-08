import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

type GitAction = "commit" | "pr" | "review" | "status" | "diff" | "log";

export async function handleGitTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const action = (args.action as string) || "status";
  const projectDir = context.projectRoot;
  const message = (args.message as string) || "";
  const branch = (args.branch as string) || "";
  const target = (args.target as string) || "";

  // Validate we're in a git repo
  if (!fs.existsSync(path.join(projectDir, ".git"))) {
    return { ok: false, name: "git", error: "Not a git repository" };
  }

  try {
    switch (action) {
      case "status": {
        const status = execSync("git status --short", { cwd: projectDir, encoding: "utf8" });
        const branchOut = execSync("git branch --show-current", { cwd: projectDir, encoding: "utf8" }).trim();
        return {
          ok: true,
          name: "git",
          output: `Branch: ${branchOut}\n\n${status || "(clean)"}`,
        };
      }

      case "diff": {
        const staged = args.staged === true;
        const diff = execSync(`git diff${staged ? " --staged" : ""} --stat`, { cwd: projectDir, encoding: "utf8" });
        const diffContent = execSync(`git diff${staged ? " --staged" : ""}`, { cwd: projectDir, encoding: "utf8" });
        const truncate = diffContent.length > 5000;
        return {
          ok: true,
          name: "git",
          output: `Files changed:\n${diff}\n\nDiff:\n${truncate ? diffContent.substring(0, 5000) + "\n... (truncated)" : diffContent}`,
          metadata: { truncated: truncate },
        };
      }

      case "commit": {
        if (!message) {
          return { ok: false, name: "git", error: "Commit message is required" };
        }
        // Auto-stage tracked files
        execSync("git add -u", { cwd: projectDir });
        const result = execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
          cwd: projectDir,
          encoding: "utf8",
        });
        return { ok: true, name: "git", output: result.trim() };
      }

      case "log": {
        const count = Math.min(Math.max(1, typeof args.count === "number" ? args.count : 10), 50);
        const log = execSync(`git log --oneline --graph -${count}`, { cwd: projectDir, encoding: "utf8" });
        return { ok: true, name: "git", output: log.trim() || "(no commits)" };
      }

      case "review": {
        // Generate a code review summary from staged diff
        const diff = execSync("git diff --staged", { cwd: projectDir, encoding: "utf8" });
        const files = execSync("git diff --staged --name-status", { cwd: projectDir, encoding: "utf8" });
        if (!diff.trim()) {
          return { ok: true, name: "git", output: "No staged changes to review." };
        }
        const insertions = (diff.match(/^\+/gm) || []).length;
        const deletions = (diff.match(/^-/gm) || []).length;
        return {
          ok: true,
          name: "git",
          output: `## Review Summary\n\n**Files:**\n${files}\n\n**Changes:** +${insertions} / -${deletions}\n\n**Diff:**\n\`\`\`diff\n${diff.substring(0, 8000)}\`\`\``,
        };
      }

      case "pr": {
        const title = message || "WIP";
        const source = branch || execSync("git branch --show-current", { cwd: projectDir, encoding: "utf8" }).trim();
        const dest = target || "main";
        return {
          ok: true,
          name: "git",
          output: `## PR Summary (generated)\n\n**Title:** ${title}\n**Branch:** ${source} → ${dest}\n\n**Changes:**\n${execSync(`git log --oneline ${dest}..${source}`, { cwd: projectDir, encoding: "utf8" })}`,
          metadata: { source, target: dest, title },
        };
      }

      default:
        return { ok: false, name: "git", error: `Unknown action: ${action}` };
    }
  } catch (err: any) {
    return { ok: false, name: "git", error: `Git error: ${err.message}` };
  }
}
