import * as fs from "fs";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";
import type { TCType } from "./executor";

// ── Symbol index data structures ──────────────────────────────────────

export type SymbolKind = "function" | "struct" | "enum" | "macro" | "typedef" | "global" | "unknown";

export type SymbolEntry = {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  signature: string;
  doc: string;
};

type IndexCache = {
  scannedAt: number;
  lastAccess: number; // for LRU eviction
  entries: SymbolEntry[];
  fileMtimes: Map<string, number>; // per-file mtime for incremental update
};

// In-memory cache (per-process, per-root)
const indexCacheByRoot = new Map<string, IndexCache>();
const MAX_CACHED_ROOTS = 5; // LRU: max 5 cached projects

/** Clear all cached indices (used by /clearcache command) */
export function clearIndexCache(): void {
  indexCacheByRoot.clear();
}

// Regex patterns for C symbols
const FUNCTION_RE = /^(?:static\s+)?(?:\w+\s+)*(\w+)\s*\(([^)]*)\)\s*\{/m;
const FUNCTION_PROTO_RE = /^(?:extern\s+)?(?:\w+\s+)+(\w+)\s*\([^)]*\)\s*;/m;
const STRUCT_RE = /^typedef\s+struct\s+(\w+)\s*\{/m;
const ENUM_RE = /^typedef\s+enum\s+(\w+)\s*\{/m;
const MACRO_RE = /^#define\s+(\w+)\s+(.+)$/m;
const TYPEDEF_RE = /^typedef\s+(?:struct|enum|union)\s+\w+\s*\{[\s\S]*?\}\s*(\w+)\s*;/m;
const GLOBAL_VAR_RE = /^(?:\w+\s+)+(\w+)\s*(?:=\s*[^;]+)?\s*;/m;

export async function handleCodeIndexTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const kindFilter = typeof args.type === "string" ? args.type.trim().toLowerCase() : "";
  const projectFilter = typeof args.project === "string" ? args.project.trim() : "";
  const contextLines = typeof args.context === "number" ? Math.max(1, Math.min(20, args.context)) : 5;

  if (!query) {
    return {
      ok: false,
      name: "codeIndex",
      error: 'Missing required "query" string.',
    };
  }

  // Determine which directories to scan
  const scanDirs = resolveScanDirs(context.projectRoot, projectFilter);
  if (scanDirs.length === 0) {
    return {
      ok: false,
      name: "codeIndex",
      error: `No source directories found${projectFilter ? ` for project "${projectFilter}"` : ""}.`,
    };
  }

  const results: SymbolEntry[] = [];
  for (const dir of scanDirs) {
    const cache = getOrBuildCache(dir);
    if (!cache) continue;

    for (const entry of cache.entries) {
      // Fuzzy match: name contains query (case-insensitive) or query contains name
      if (!matchName(entry.name, query)) continue;
      if (kindFilter && entry.kind !== kindFilter) continue;
      results.push(entry);
    }
  }

  // Sort by relevance (exact match > prefix > substring)
  results.sort((a, b) => {
    const scoreA = scoreRelevance(a.name, query);
    const scoreB = scoreRelevance(b.name, query);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.line - b.line;
  });

  const top = results.slice(0, 15);

  // ── Confidence: derive certainty from match quality ─────────────
  // TC_NONE:      exact match found (score 100)
  // TC_CARRY:     prefix match only (score 50)
  // TC_UNCERTAIN: substring/fuzzy match (score < 50) or no result
  // TC_MIXED:     not applicable for single-query search
  const bestScore = top.length > 0 ? scoreRelevance(top[0].name, query) : 0;
  const codeIndexTC: TCType = bestScore >= 100 ? "TC_NONE" : bestScore >= 50 ? "TC_CARRY" : "TC_UNCERTAIN";

  if (top.length === 0) {
    return {
      ok: true,
      name: "codeIndex",
      output: `No symbols found matching "${query}".`,
      tcState: "TC_UNCERTAIN",
      metadata: { scanned_dirs: scanDirs.length, total_files: countScannedFiles(scanDirs) },
    };
  }

  const output = top
    .map(
      (s, i) =>
        `${String(i + 1).padStart(2, " ")}. ${s.kind.padEnd(10)} ${s.signature || s.name}\n` +
        `    ${relativePath(s.file, context.projectRoot)}:${s.line}` +
        (s.doc ? `\n    ${s.doc}` : ""),
    )
    .join("\n");

  return {
    ok: true,
    name: "codeIndex",
    output,
    tcState: codeIndexTC,
    metadata: {
      total_matches: results.length,
      shown: top.length,
      scanned_dirs: scanDirs.length,
      query,
      kind_filter: kindFilter || undefined,
    },
  };
}

// ── Cache management ─────────────────────────────────────────────────

function getOrBuildCache(dir: string): IndexCache | null {
  // LRU eviction: prune oldest when at capacity
  if (indexCacheByRoot.size >= MAX_CACHED_ROOTS && !indexCacheByRoot.has(dir)) {
    const oldest = [...indexCacheByRoot.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess)[0];
    indexCacheByRoot.delete(oldest[0]);
  }

  const currentMtimes = computeDirMtimes(dir);

  const cached = indexCacheByRoot.get(dir);
  if (cached) {
    let entries = cached.entries;
    const fileMtimes = cached.fileMtimes;
    let anyChange = false;

    // Detect new/deleted files
    if (currentMtimes.size !== fileMtimes.size) {
      anyChange = true;
    } else {
      for (const [f, mtime] of currentMtimes) {
        const prev = fileMtimes.get(f);
        if (prev === undefined) {
          anyChange = true;
          break;
        }
        if (prev !== mtime) {
          // Incremental: re-parse only the changed file
          entries = entries.filter((e) => e.file !== f);
          try {
            const content = fs.readFileSync(f, "utf8");
            entries.push(...parseFileSymbols(content, f));
          } catch {
            /* skip unreadable */
          }
          anyChange = true;
        }
      }
    }

    if (!anyChange) {
      cached.lastAccess = Date.now();
      return cached;
    }

    // Full rebuild if file count changed (additions/deletions)
    if (currentMtimes.size !== fileMtimes.size) {
      entries = buildIndex(dir);
    }

    cached.lastAccess = Date.now();
    cached.fileMtimes = currentMtimes;
    cached.entries = entries;
    return cached;
  }

  const entries = buildIndex(dir);
  if (entries.length === 0) return null;

  const cache: IndexCache = {
    scannedAt: Date.now(),
    lastAccess: Date.now(),
    entries,
    fileMtimes: currentMtimes,
  };
  indexCacheByRoot.set(dir, cache);
  return cache;
}

function computeDirMtimes(dir: string): Map<string, number> {
  const mtimes = new Map<string, number>();
  try {
    const files = listSourceFiles(dir);
    for (const f of files) {
      try {
        const stat = fs.statSync(f);
        mtimes.set(f, stat.mtimeMs);
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* skip unlistable */
  }
  return mtimes;
}

// Extract per-file symbol parsing for incremental use
function parseFileSymbols(content: string, filePath: string): SymbolEntry[] {
  const entries: SymbolEntry[] = [];
  const lines = content.split("\n");
  const fileName = path.basename(filePath);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      i += 1;
      continue;
    }

    // #define
    const macroMatch = trimmed.match(/^#define\s+(\w+)\s+(.*)/);
    if (macroMatch) {
      entries.push({
        name: macroMatch[1],
        kind: "macro",
        file: filePath,
        line: i + 1,
        signature: `#define ${macroMatch[1]} ${macroMatch[2].substring(0, 60)}`,
        doc: "",
      });
      i += 1;
      continue;
    }

    // Function definition
    const parenIdx = trimmed.indexOf("(");
    if (parenIdx > 0) {
      const beforeParen = trimmed.substring(0, parenIdx).trimEnd();
      const funcName = beforeParen.match(/(\w+)$/);
      if (funcName && !isKeyword(funcName[1])) {
        const blockStart = findOpenBrace(lines, i);
        if (blockStart !== -1) {
          const sigEnd = findSemicolonOrParen(lines, i);
          const signature = lines
            .slice(i, sigEnd + 1)
            .join(" ")
            .trim()
            .substring(0, 100);
          const doc = extractDocComment(lines, i - 1);
          if (!isDuplicateName(entries, funcName[1], filePath))
            entries.push({ name: funcName[1], kind: "function", file: filePath, line: i + 1, signature, doc });
          i = blockStart + 1;
          continue;
        }
      }
    }

    // Typedef struct/enum
    const structMatch = trimmed.match(/^typedef\s+struct\s+(\w+)\s*\{/);
    if (structMatch) {
      entries.push({
        name: structMatch[1],
        kind: "struct",
        file: filePath,
        line: i + 1,
        signature: `typedef struct ${structMatch[1]} { ... }`,
        doc: extractDocComment(lines, i - 1),
      });
      i += 1;
      continue;
    }
    const enumMatch = trimmed.match(/^typedef\s+enum\s+(\w+)\s*\{/);
    if (enumMatch) {
      entries.push({
        name: enumMatch[1],
        kind: "enum",
        file: filePath,
        line: i + 1,
        signature: `typedef enum ${enumMatch[1]} { ... }`,
        doc: extractDocComment(lines, i - 1),
      });
      i += 1;
      continue;
    }

    i += 1;
  }
  return entries;
}

function buildIndex(dir: string): SymbolEntry[] {
  const entries: SymbolEntry[] = [];
  const files = listSourceFiles(dir);
  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      entries.push(...parseFileSymbols(content, filePath));
    } catch {
      /* skip unreadable */
    }
  }
  return entries;
}

function listSourceFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && (entry.name.endsWith(".c") || entry.name.endsWith(".h") || entry.name.endsWith(".cpp"))) {
        results.push(fullPath);
      } else if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        results.push(...listSourceFiles(fullPath));
      }
    }
  } catch {
    // skip
  }
  return results;
}

function findOpenBrace(lines: string[], startIdx: number): number {
  for (let i = startIdx; i < Math.min(startIdx + 8, lines.length); i += 1) {
    if (lines[i].includes("{")) return i;
  }
  return -1;
}

function findSemicolonOrParen(lines: string[], startIdx: number): number {
  for (let i = startIdx; i < Math.min(startIdx + 10, lines.length); i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.endsWith(";") || trimmed.endsWith(")")) return i;
  }
  return startIdx;
}

function extractDocComment(lines: string[], beforeIdx: number): string {
  if (beforeIdx < 0) return "";
  const line = lines[beforeIdx].trim();
  const docMatch = line.match(/\/\/\/?\s*(.+)/) || line.match(/\/\*\*?\s*(.+)/);
  if (docMatch) return docMatch[1].trim();
  return "";
}

function isKeyword(name: string): boolean {
  const keywords = new Set([
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "return",
    "break",
    "continue",
    "goto",
    "sizeof",
    "typedef",
    "struct",
    "enum",
    "union",
    "const",
    "static",
    "extern",
    "volatile",
    "register",
    "int",
    "char",
    "float",
    "double",
    "void",
    "long",
    "short",
    "unsigned",
    "signed",
    "ifdef",
    "ifndef",
    "endif",
    "define",
    "include",
  ]);
  return keywords.has(name);
}

function isDuplicateName(entries: SymbolEntry[], name: string, filePath: string): boolean {
  return entries.some((e) => e.name === name && e.file === filePath);
}

function matchName(name: string, query: string): boolean {
  const nl = name.toLowerCase();
  const ql = query.toLowerCase();
  return nl.includes(ql) || ql.includes(nl);
}

function scoreRelevance(name: string, query: string): number {
  const nl = name.toLowerCase();
  const ql = query.toLowerCase();
  if (nl === ql) return 100;
  if (nl.startsWith(ql)) return 50;
  if (nl.includes(ql)) return 10;
  return 0;
}

function relativePath(fullPath: string, root: string): string {
  try {
    const rel = path.relative(root, fullPath);
    return rel.startsWith(".") ? rel : `./${rel}`;
  } catch {
    return fullPath;
  }
}

function resolveScanDirs(root: string, projectFilter: string): string[] {
  if (projectFilter) {
    // Check if filter matches a subdirectory name (should be enough for HEX4)
    const subPath = path.join(root, projectFilter);
    if (fs.existsSync(subPath)) return [subPath];

    // Try to find by name
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name.toLowerCase().includes(projectFilter.toLowerCase())) {
          return [path.join(root, e.name)];
        }
      }
    } catch {
      // ignore
    }
    return [];
  }

  return [root];
}

function countScannedFiles(dirs: string[]): number {
  let total = 0;
  for (const dir of dirs) {
    total += listSourceFiles(dir).length;
  }
  return total;
}
