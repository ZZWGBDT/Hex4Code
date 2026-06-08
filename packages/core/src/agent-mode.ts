/**
 * HEX4 Agent Mode Selector
 *
 * Two-mode architecture:
 *   "hex4"    → Pipeline orchestration + confidence propagation + compact protocol (HEX4-specific)
 *   "general" → Free Agent + general completion + multi-language tools (general development)
 *
 * The mode affects:
 *   - Which tools are available
 *   - Whether pipeline detection is active
 *   - Whether TC propagation is enforced
 *   - Whether DualTrit compression is applied
 *   - What autocomplete provider returns
 */

export type AgentMode = "hex4" | "general";

// ── Module-level mode state (replaces globalThis coupling) ────────────
let _currentMode: AgentMode = "general";

export function setAgentMode(mode: AgentMode): void {
  _currentMode = mode;
}

export function getAgentMode(): AgentMode {
  return _currentMode;
}

export type ModeConfig = {
  mode: AgentMode;
  /** Auto-detect mode from project type? */
  autoDetect: boolean;
  /** Override mode (set by user via settings or status bar) */
  override?: AgentMode;
};

const HEX4_PROJECT_HINTS = ["HEX4密码", "HEX4-新版自然语言模型", "hex4", "ternary", "trit"];

/**
 * Detect whether a project is HEX4-based by scanning directory/file names.
 */
export function detectProjectMode(projectRoot: string): AgentMode {
  const lower = projectRoot.toLowerCase();
  for (const hint of HEX4_PROJECT_HINTS) {
    if (lower.includes(hint)) return "hex4";
  }
  // Check for common HEX4 file indicators
  try {
    const entries = require("fs").readdirSync(projectRoot, { withFileTypes: true } as any) as any[];
    for (const entry of entries) {
      if (!entry.isDirectory && !entry.isFile) continue;
      const name = (entry.name as string).toLowerCase();
      if (name.startsWith("hex4") || name.includes("hex4code-pipeline") || name.includes("dual-trit")) {
        return "hex4";
      }
    }
  } catch {
    // ignore
  }
  return "general";
}

/**
 * Get the effective agent mode considering detection + user override.
 */
export function getEffectiveMode(config: ModeConfig, projectRoot: string): AgentMode {
  if (config.override) return config.override;
  if (config.autoDetect) return detectProjectMode(projectRoot);
  return config.mode;
}

/**
 * Tool availability per mode.
 * "hex4" mode exposes HEX4-specific tools; "general" mode keeps them optional.
 */
export function isToolAvailable(toolName: string, _mode: AgentMode): boolean {
  const hex4OnlyTools = new Set(["build", "codeIndex", "test", "git"]);
  if (hex4OnlyTools.has(toolName)) {
    // In general mode, still allow these tools but don't enforce pipeline
    return true; // always available, just mode affects behavior
  }
  return true;
}

/**
 * Whether pipeline detection is active.
 */
export function isPipelineEnabled(mode: AgentMode): boolean {
  return mode === "hex4";
}

/**
 * Whether TC propagation is required.
 */
export function isTcPropagationRequired(mode: AgentMode): boolean {
  return mode === "hex4";
}

/**
 * Whether DualTrit compression should be applied.
 */
export function isDualTritEnabled(mode: AgentMode): boolean {
  return mode === "hex4";
}

/**
 * Human-readable mode label for status bar.
 */
export function getModeLabel(mode: AgentMode): string {
  return mode === "hex4" ? "HEX4" : "General";
}

/**
 * Mode description for system prompt injection.
 */
export function getModeSystemPrompt(mode: AgentMode): string {
  if (mode === "hex4") {
    return `## Current Mode: HEX4

You are using the HEX4 toolchain. Pipeline tools (build/test/codeIndex/git) are available.
Tool results include confidence metadata. Use compact protocol for efficiency.`;
  }

  return `## Current Mode: General Agent

You are in general-purpose AI coding assistant mode. All tools are available.
No mandatory pipeline enforcement or confidence propagation constraints.
Suitable for Python/JavaScript/Go/Rust/C++/Java and other general project development.`;
}
