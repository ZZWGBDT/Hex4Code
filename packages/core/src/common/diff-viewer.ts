/**
 * Diff Viewer
 *
 * When edit/write tools modify files, captures before/after content and
 * opens a VS Code diff editor to visually show the changes.
 *
 * Architecture:
 *   onToolResult (from session) → detect edit/write with diff_preview →
 *   create temp files for old/new → open diff editor
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Diff Queue ────────────────────────────────────────────────────────────
// Prevents flooding with too many diff views at once

const DIFF_QUEUE: Array<{ filePath: string; original: string | null; updated: string }> = [];
let diffTimer: ReturnType<typeof setTimeout> | null = null;

function flushDiffQueue(): void {
  if (DIFF_QUEUE.length === 0) return;

  // Take the last item (most recent change) or all if only 1-2
  const batch = DIFF_QUEUE.length <= 2 ? DIFF_QUEUE.splice(0) : [DIFF_QUEUE.pop()!];
  DIFF_QUEUE.length = 0;

  for (const item of batch) {
    openDiffEditor(item.filePath, item.original, item.updated);
  }
}

function scheduleDiffQueue(): void {
  if (diffTimer) clearTimeout(diffTimer);
  diffTimer = setTimeout(flushDiffQueue, 300);
}

// ── Open Diff Editor ──────────────────────────────────────────────────────

function openDiffEditor(filePath: string, original: string | null, updated: string): void {
  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    const tmpDir = path.join(os.tmpdir(), "hex4code-diff");

    // Ensure temp directory exists
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    // Create safe file name from the real path
    const safeName = filePath.replace(/[^a-zA-Z0-9_\-./\\]/g, "_").replace(/[/\\]/g, "_");
    const originalPath = path.join(tmpDir, `original_${safeName}`);
    const updatedPath = path.join(tmpDir, `updated_${safeName}`);

    // Write original content (or empty for new files)
    fs.writeFileSync(originalPath, original ?? "", "utf8");
    fs.writeFileSync(updatedPath, updated, "utf8");

    const originalUri = vscode.Uri.file(originalPath);
    const updatedUri = vscode.Uri.file(updatedPath);
    const fileName = path.basename(filePath);

    // Try to find relative path for title
    let title = fileName;
    if (workspaceRoot) {
      const relPath = path.relative(workspaceRoot.fsPath, filePath);
      if (!relPath.startsWith("..")) {
        title = relPath;
      }
    }

    vscode.commands.executeCommand(
      "vscode.diff",
      originalUri,
      updatedUri,
      `${title} (Change Preview)`,
    );
  } catch (err) {
    console.error("[DiffViewer] Failed to open diff:", err);
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Queue a file change for diff display.
 * Called from onToolResult hook whenever edit/write completes.
 *
 * @param toolName - "edit" or "write"
 * @param result    - The tool execution result (contains diff_preview in metadata)
 */
export function queueDiffPreview(
  toolName: string,
  filePath: string,
  originalContent: string | null,
  updatedContent: string,
): void {
  if (!filePath || !updatedContent) return;

  // Avoid duplicates in queue
  const existing = DIFF_QUEUE.findIndex((item) => item.filePath === filePath);
  if (existing >= 0) {
    DIFF_QUEUE[existing] = { filePath, original: originalContent, updated: updatedContent };
  } else {
    DIFF_QUEUE.push({ filePath, original: originalContent, updated: updatedContent });
  }

  scheduleDiffQueue();
}

/**
 * Extract diff information from a tool execution result.
 * Returns null if the result doesn't contain file change info.
 */
export function extractDiffFromResult(
  toolName: string,
  result: Record<string, unknown>,
): { filePath: string; original: string | null; updated: string } | null {
  if (toolName !== "edit" && toolName !== "write") return null;

  // The result should have file_path and content/updated fields
  const filePath = result.file_path as string | undefined;
  if (!filePath) return null;

  // For edit: the updated content is in the output or we need to read the file
  // For write: the content was written
  // We capture from diff_preview metadata or read the file directly
  const metadata = result.metadata as Record<string, unknown> | undefined;
  const diffPreview = metadata?.diff_preview as string | undefined;

  if (diffPreview) {
    // Extract original from diff preview if available, otherwise return what we have
    return { filePath, original: null, updated: "" }; // Will read current file state
  }

  return null;
}

/**
 * Register a file system watcher to clean up temp diff files on shutdown.
 */
export function registerDiffViewerCleanup(context: vscode.ExtensionContext): void {
  context.subscriptions.push({
    dispose: () => {
      const tmpDir = path.join(os.tmpdir(), "hex4code-diff");
      try {
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup errors
      }
    },
  });
}
