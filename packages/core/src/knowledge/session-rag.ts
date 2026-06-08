import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Types ────────────────────────────────────────────────────────────

export type KnowledgeChunk = {
  id: string;
  question: string;
  answer: string;
  sessionId: string;
  /** BOW (bag-of-words) vector for similarity search */
  tokens: Map<string, number>;
};

// ── In-memory RAG store ──────────────────────────────────────────────

let knowledgeBase: KnowledgeChunk[] = [];
let loaded = false;

const SESSION_DIR = path.join(os.homedir(), ".hex4code", "projects");

/** Tokenize Chinese + English text into word frequency map */
export function tokenize(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  const lower = text.toLowerCase();

  // Extract English words
  const words = lower.match(/[a-z_]\w{2,}/g) || [];
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  // Extract Chinese character bigrams (2-grams for CJK)
  const cjk = lower.match(/[\u4e00-\u9fff]/g) || [];
  for (let i = 0; i < cjk.length - 1; i++) {
    const bigram = cjk[i] + cjk[i + 1];
    freq.set(bigram, (freq.get(bigram) || 0) + 1);
  }

  // Extract project-specific identifiers
  const hex4Ids = lower.match(/hex4_\w+|TC_\w+|Hex4\w+/g) || [];
  for (const id of hex4Ids) {
    freq.set(id, (freq.get(id) || 0) + 3); // Higher weight for API names
  }

  return freq;
}

/** Compute cosine similarity between two BOW vectors */
export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (const [k, v] of a) {
    normA += v * v;
    const vb = b.get(k) || 0;
    dot += v * vb;
  }
  for (const v of b.values()) normB += v * v;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Build knowledge base from JSONL sessions ─────────────────────────

export function rebuildKnowledgeBase(): { chunks: number; sessions: number } {
  knowledgeBase = [];
  let sessionCount = 0;

  if (!fs.existsSync(SESSION_DIR)) {
    console.warn("[RAG] No session data found at", SESSION_DIR);
    return { chunks: 0, sessions: 0 };
  }

  const projectDirs = fs.readdirSync(SESSION_DIR);
  for (const proj of projectDirs) {
    const projPath = path.join(SESSION_DIR, proj);
    if (!fs.statSync(projPath).isDirectory()) continue;

    const files = fs.readdirSync(projPath).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const filePath = path.join(projPath, file);
      const sessionId = file.replace(".jsonl", "");
      const messages = extractQA(filePath);
      for (const msg of messages) {
        knowledgeBase.push(msg);
      }
      sessionCount++;
    }
  }

  loaded = true;
  console.log(`[RAG] Loaded ${knowledgeBase.length} chunks from ${sessionCount} sessions`);
  return { chunks: knowledgeBase.length, sessions: sessionCount };
}

function extractQA(filePath: string): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean);

    // Extract user-assistant pairs
    let lastUser = "";
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.role === "user" && typeof msg.content === "string") {
          lastUser = msg.content.substring(0, 500);
        } else if (msg.role === "assistant" && typeof msg.content === "string" && lastUser) {
          const id = `chunk-${chunks.length}`;
          chunks.push({
            id,
            question: lastUser,
            answer: msg.content.substring(0, 1000),
            sessionId: path.basename(filePath, ".jsonl").substring(0, 8),
            tokens: tokenize(lastUser),
          });
          lastUser = "";
        }
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* skip unreadable */
  }
  return chunks;
}

// ── Search ───────────────────────────────────────────────────────────

export function searchKnowledge(query: string, topK: number = 3): Array<{ chunk: KnowledgeChunk; score: number }> {
  if (!loaded || knowledgeBase.length === 0) {
    // Auto-load on first use
    rebuildKnowledgeBase();
  }

  const queryTokens = tokenize(query);
  const results: Array<{ chunk: KnowledgeChunk; score: number }> = [];

  for (const chunk of knowledgeBase) {
    const score = cosineSimilarity(queryTokens, chunk.tokens);
    if (score > 0.05) {
      results.push({ chunk, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

export function formatKnowledgeResults(results: Array<{ chunk: KnowledgeChunk; score: number }>): string {
  if (results.length === 0) return "No relevant knowledge found.";

  return results
    .map(
      (r, i) =>
        `[${i + 1}] (relevance: ${(r.score * 100).toFixed(0)}%)\n` +
        `  Q: ${r.chunk.question.substring(0, 200)}\n` +
        `  A: ${r.chunk.answer.substring(0, 300)}`,
    )
    .join("\n\n");
}

// ── Priority 3: Error pattern extraction ──────────────────────────────

export type ErrorPattern = {
  errorType: string; // e.g., "undefined reference", "segfault", "assertion"
  buildOutput: string; // relevant error snippet
  fixSequence: string[]; // tools called to fix it
  finalStatus: "fixed" | "unresolved";
  sessionId: string;
  timestamp: string;
};

let extractedPatterns: ErrorPattern[] | null = null;

/**
 * Extract error-fix patterns from session JSONL data.
 * Scans for sequences: error -> tool calls (build/test/bash) -> success
 */
export function extractErrorPatterns(): ErrorPattern[] {
  if (extractedPatterns) return extractedPatterns;

  extractedPatterns = [];
  if (!fs.existsSync(SESSION_DIR)) return extractedPatterns;

  const projectDirs = fs.readdirSync(SESSION_DIR);
  for (const proj of projectDirs) {
    const projPath = path.join(SESSION_DIR, proj);
    if (!fs.statSync(projPath).isDirectory()) continue;

    const files = fs.readdirSync(projPath).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const filePath = path.join(projPath, file);
      const sessionId = file.replace(".jsonl", "").substring(0, 8);
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const lines = raw.split("\n").filter(Boolean);

        let errorType = "";
        let buildOutput = "";
        const fixSequence: string[] = [];
        let inError = false;
        let finalStatus: "fixed" | "unresolved" = "unresolved";

        for (const line of lines) {
          try {
            const msg = JSON.parse(line);

            // Detect error types
            if (msg.role === "tool" && msg.meta?.name === "build" && msg.content?.includes("error:")) {
              const match = msg.content.match(/error:\s*(.+)/) || msg.content.match(/undefined reference to `(\\w+)`/);
              if (match) {
                errorType = match[1].substring(0, 100);
                buildOutput = msg.content.substring(0, 500);
                inError = true;
              }
            }
            if (msg.role === "tool" && msg.meta?.name === "test" && msg.content?.includes("FAIL")) {
              errorType = msg.content.substring(0, 100);
              inError = true;
            }

            // Track tool calls during error remediation
            if (inError && msg.role === "tool" && msg.meta?.name) {
              const toolName = msg.meta.name;
              if (["edit", "write", "bash", "build", "test"].includes(toolName)) {
                fixSequence.push(toolName);
              }
              // Check if error was resolved
              if (toolName === "build" && msg.content?.includes("Build succeeded")) {
                finalStatus = "fixed";
              }
              if (toolName === "test" && msg.content?.includes("/0 failed")) {
                finalStatus = "fixed";
              }
            }
          } catch {
            /* skip malformed JSON */
          }
        }

        if (errorType && fixSequence.length > 0) {
          extractedPatterns.push({
            errorType,
            buildOutput,
            fixSequence: [...new Set(fixSequence)],
            finalStatus,
            sessionId,
            timestamp: new Date().toISOString(),
          });
        }
      } catch {
        /* skip unreadable */
      }
    }
  }
  console.log("[Patterns] Extracted " + String(extractedPatterns.length) + " error-fix patterns");
  return extractedPatterns;
}

export function searchPatterns(query: string, topK = 5): ErrorPattern[] {
  const all = extractErrorPatterns();
  const ql = query.toLowerCase();
  const scored = all.map((p) => ({
    pattern: p,
    score:
      (p.errorType.toLowerCase().includes(ql) ? 10 : 0) +
      (p.finalStatus === "fixed" ? 3 : 0) +
      (p.buildOutput.toLowerCase().includes(ql) ? 2 : 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored
    .slice(0, topK)
    .filter((s) => s.score > 0)
    .map((s) => s.pattern);
}

export function formatPatternResults(patterns: ErrorPattern[]): string {
  if (patterns.length === 0) return "No matching error patterns found.";
  return patterns
    .map((p, i) => {
      const status = p.finalStatus === "fixed" ? "FIXED" : "UNRESOLVED";
      return (
        "[" +
        String(i + 1) +
        "] [" +
        status +
        "] " +
        p.errorType +
        "\n    Fix sequence: " +
        p.fixSequence.join(" -> ") +
        " (session: " +
        p.sessionId +
        ")"
      );
    })
    .join("\n\n");
}

export function getKnowledgeStats(): { chunks: number; sessions: number } {
  return {
    chunks: knowledgeBase.length,
    sessions: new Set(knowledgeBase.map((c) => c.sessionId)).size,
  };
}
