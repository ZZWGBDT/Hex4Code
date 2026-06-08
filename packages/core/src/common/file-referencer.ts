/**
 * File Referencer (@mention)
 *
 * Detects `@` in user input and shows a quick file picker to reference
 * project files. When selected, the file content is prepended to the
 * user's message as context.
 *
 * Architecture:
 *   User types @ in chat → show QuickPick with workspace files →
 *   select file → read content → insert as context reference
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Minimatch } from "minimatch";

// ── Configuration ─────────────────────────────────────────────────────────

const DEFAULT_IGNORE_PATTERNS = [
  "node_modules/**",
  ".git/**",
  "dist/**",
  "build/**",
  "out/**",
  "target/**",
  "__pycache__/**",
  "*.vsix",
  "*.zip",
  "*.tar*",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".DS_Store",
];

const MAX_FILE_SIZE = 1024 * 100; // 100KB max for referenced files
const MAX_PREVIEW_LINES = 50;
const CACHE_TTL_MS = 30_000; // file index cache: 30 seconds

// ── File Index Cache ──────────────────────────────────────────────────────

interface FileEntry {
  relativePath: string;
  absolutePath: string;
  fileName: string;
  extension: string;
  size: number;
}

let fileIndexCache: FileEntry[] | null = null;
let fileIndexTime = 0;

function shouldIgnore(relativePath: string, ignorePatterns: string[]): boolean {
  for (const pattern of ignorePatterns) {
    const mm = new Minimatch(pattern);
    if (mm.match(relativePath)) return true;
    // Also check without leading ./ or /
    const cleanPath = relativePath.replace(/^[./]+/, "");
    if (mm.match(cleanPath)) return true;
  }
  return false;
}

function buildFileIndex(rootPath: string): FileEntry[] {
  const entries: FileEntry[] = [];

  function walk(dir: string): void {
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const absolutePath = path.join(dir, item.name);
        const relativePath = path.relative(rootPath, absolutePath);

        if (shouldIgnore(relativePath, DEFAULT_IGNORE_PATTERNS)) continue;

        if (item.isDirectory()) {
          walk(absolutePath);
        } else if (item.isFile()) {
          try {
            const stat = fs.statSync(absolutePath);
            if (stat.size > MAX_FILE_SIZE) continue;

            entries.push({
              relativePath,
              absolutePath,
              fileName: item.name,
              extension: path.extname(item.name).toLowerCase(),
              size: stat.size,
            });
          } catch {
            // skip files we can't stat
          }
        }
      }
    } catch {
      // skip directories we can't read
    }
  }

  walk(rootPath);
  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function getFileIndex(rootPath: string): FileEntry[] {
  const now = Date.now();
  if (!fileIndexCache || now - fileIndexTime > CACHE_TTL_MS) {
    fileIndexCache = buildFileIndex(rootPath);
    fileIndexTime = now;
  }
  return fileIndexCache;
}

export function invalidateFileIndex(): void {
  fileIndexCache = null;
  fileIndexTime = 0;
}

// ── Quick Pick for @mention ───────────────────────────────────────────────

function formatFileEntry(entry: FileEntry): vscode.QuickPickItem {
  const icon = getFileIcon(entry.extension);
  const sizeLabel = formatSize(entry.size);
  const dirName = path.dirname(entry.relativePath);

  return {
    label: `${icon} ${entry.fileName}`,
    description: sizeLabel,
    detail: dirName === "." ? entry.relativePath : dirName,
    alwaysShow: true,
  };
}

function getFileIcon(ext: string): string {
  const iconMap: Record<string, string> = {
    ".ts": "$(symbol-parameter)", // TypeScript
    ".tsx": "$(symbol-parameter)",
    ".js": "$(symbol-ruler)",       // JavaScript
    ".jsx": "$(symbol-ruler)",
    ".py": "$(symbol-key)",        // Python
    ".rs": "$(symbol-structure)",   // Rust
    ".go": "$(symbol-enum)",       // Go
    ".c": "$(symbol-misc)",        // C
    ".h": "$(symbol-misc)",
    ".cpp": "$(symbol-misc)",
    ".hpp": "$(symbol-misc)",
    ".json": "$(symbol-property)", // JSON
    ".yaml": "$(symbol-property)",
    ".yml": "$(symbol-property)",
    ".md": "$(symbol-text)",       // Markdown
    ".html": "$(symbol-event)",    // HTML
    ".css": "$(symbol-color)",     // CSS
    ".sh": "$(terminal)",          // Shell
    ".toml": "$(settings-gear)",   // Config
    ".gitignore": "$(git-branch)",
    "Dockerfile": "$(container)",
    "Makefile": "$(build)",
  };
  return iconMap[ext] || "$(file)";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Content Reading ───────────────────────────────────────────────────────

function readFileContent(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    if (lines.length > MAX_PREVIEW_LINES) {
      return lines.slice(0, MAX_PREVIEW_LINES).join("\n") +
        `\n... (${lines.length - MAX_PREVIEW_LINES} more lines)`;
    }
    return content;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Show a QuickPick of workspace files for @mention selection.
 * Returns the selected file's content with formatted reference, or null if cancelled.
 */
export async function pickFileReference(): Promise<string | null> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!workspaceRoot) {
    vscode.window.showInformationMessage("No workspace is open. Cannot reference files.");
    return null;
  }

  const index = getFileIndex(workspaceRoot);
  if (index.length === 0) {
    vscode.window.showInformationMessage("No referenceable files found in the workspace.");
    return null;
  }

  const quickPick = vscode.window.createQuickPick();
  quickPick.title = "@ Reference File";
  quickPick.placeholder = "Search files...";
  quickPick.items = index.map(formatFileEntry);
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;

  return new Promise<string | null>((resolve) => {
    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      if (!selected) {
        resolve(null);
        quickPick.hide();
        quickPick.dispose();
        return;
      }

      // Find the matching file entry
      const fileEntry = index.find(
        (e) => `${getFileIcon(e.extension)} ${e.fileName}` === selected.label,
      );

      if (!fileEntry) {
        resolve(null);
        quickPick.hide();
        quickPick.dispose();
        return;
      }

      const content = readFileContent(fileEntry.absolutePath);
      if (content === null) {
        vscode.window.showErrorMessage(`Cannot read file: ${fileEntry.relativePath}`);
        resolve(null);
        quickPick.hide();
        quickPick.dispose();
        return;
      }

      // Format as a reference block
      const reference = [
        `@${fileEntry.relativePath}:`,
        "```" + (fileEntry.extension.slice(1) || "text"),
        content,
        "```",
      ].join("\n");

      resolve(reference);
      quickPick.hide();
      quickPick.dispose();
    });

    quickPick.onDidHide(() => {
      resolve(null);
      quickPick.dispose();
    });

    quickPick.show();
  });
}

/**
 * Register the @mention command.
 * Users can trigger it via command palette or the chat will auto-detect @.
 */
export function registerFileReferenceCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("hex4code.mentionFile", async () => {
      const reference = await pickFileReference();
      if (reference) {
        // Copy to clipboard for the user to paste
        await vscode.env.clipboard.writeText(reference);
        vscode.window.showInformationMessage(
          "File reference copied to clipboard. Paste it into the conversation to use.",
        );
      }
    }),
  );

  // Watch for file changes to invalidate cache
  context.subscriptions.push(
    vscode.workspace.onDidCreateFiles(() => invalidateFileIndex()),
    vscode.workspace.onDidDeleteFiles(() => invalidateFileIndex()),
    vscode.workspace.onDidRenameFiles(() => invalidateFileIndex()),
  );
}
