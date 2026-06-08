/**
 * DualTrit Compression
 *
 * Maps the DualTrit compact encoding (2bit value + 2bit TC packed into 4 bits)
 * to tool result JSON compression:
 *
 *   DualTrit encoding    →  field name compression
 *   ─────────────────────────────────────────────
 *   2bit value          →  ok / name / output
 *   2bit TC             →  tcState / tcChain
 *   4bit DualTrit byte  →  compact field names + TC short codes
 *
 * Compression savings on a typical tool result:
 *   {"ok":true,"name":"build","tcState":"TC_CARRY"}       (62 chars)
 *   → {"o":1,"n":"build","t":1}                           (35 chars)  ~44%
 *
 * TC value mapping:
 *   TC_NONE      →  "0"   (no uncertainty)
 *   TC_CARRY     →  "1"   (warning propagated)
 *   TC_UNCERTAIN →  "U"   (semantic uncertainty)
 *   TC_MIXED     →  "M"   (mixed signals)
 */

import type { TCType, TCLink } from "../tools/executor";

// ── Compression field map ──────────────────────────────────────────
const COMPACT_FIELDS: Record<string, string> = {
  ok: "k",
  name: "n",
  output: "o",
  error: "e",
  tcState: "t",
  tcChain: "c",
  metadata: "m",
  awaitUserResponse: "a",
  description: "d",
  source: "s",
  content: "C",
  result: "r",
  duration_ms: "D",
  exit_code: "x",
  total: "T",
  passed: "P",
  failed: "F",
  summary: "S",
  truncated: "u",
  failures: "f",
  errors: "E",
  warnings: "W",
  file: "F",
  line: "L",
  message: "M",
};

const EXPAND_FIELDS: Record<string, string> = {};
for (const [k, v] of Object.entries(COMPACT_FIELDS)) {
  EXPAND_FIELDS[v] = k;
}

const TC_SHORT: Record<TCType, string> = {
  TC_NONE: "0",
  TC_CARRY: "1",
  TC_UNCERTAIN: "U",
  TC_MIXED: "M",
};

const TC_LONG: Record<string, TCType> = {
  "0": "TC_NONE",
  "1": "TC_CARRY",
  U: "TC_UNCERTAIN",
  M: "TC_MIXED",
};

/** Compress a tool result payload into DualTrit compact format (fewer LLM tokens). */
export function dualTritCompress(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const ck = COMPACT_FIELDS[key] ?? key;
    if (key === "tcState" && typeof value === "string") {
      result[ck] = TC_SHORT[value as TCType] ?? value;
    } else if (key === "tcChain" && Array.isArray(value)) {
      result[ck] = (value as TCLink[]).map((link) => ({
        [COMPACT_FIELDS.source ?? "s"]: link.source,
        [COMPACT_FIELDS.tcState ?? "t"]: TC_SHORT[link.tc] ?? link.tc,
        ...(link.description ? { [COMPACT_FIELDS.description ?? "d"]: link.description } : {}),
      }));
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      // Recursively compress nested objects
      result[ck] = dualTritCompress(value as Record<string, unknown>);
    } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
      // Compress arrays of objects
      result[ck] = value.map((v) => dualTritCompress(v as Record<string, unknown>));
    } else {
      result[ck] = value;
    }
  }
  return result;
}

/** Decompress a DualTrit compact payload back to standard tool result format. */
export function dualTritDecompress(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const ek = EXPAND_FIELDS[key] ?? key;
    if (ek === "tcState" && typeof value === "string") {
      result[ek] = TC_LONG[value] ?? value;
    } else if (ek === "tcChain" && Array.isArray(value)) {
      result[ek] = (value as Record<string, unknown>[]).map((link) => ({
        source: link[EXPAND_FIELDS.s ?? "s"] ?? link.s,
        tc: TC_LONG[link[EXPAND_FIELDS.t ?? "t"] as string] ?? link.t,
        ...(link[EXPAND_FIELDS.d ?? "d"] ? { description: link[EXPAND_FIELDS.d ?? "d"] } : {}),
      }));
    } else {
      result[ek] = value;
    }
  }
  return result;
}

/**
 * Estimate token savings from DualTrit compression.
 * Returns approximate character count before and after.
 */
export function estimateCompression(payload: Record<string, unknown>): {
  before: number;
  after: number;
  saved: number;
  percent: number;
} {
  const jsonBefore = JSON.stringify(payload);
  const compressed = dualTritCompress(payload);
  const jsonAfter = JSON.stringify(compressed);
  const before = jsonBefore.length;
  const after = jsonAfter.length;
  return {
    before,
    after,
    saved: before - after,
    percent: before > 0 ? Math.round(((before - after) / before) * 100) : 0,
  };
}
