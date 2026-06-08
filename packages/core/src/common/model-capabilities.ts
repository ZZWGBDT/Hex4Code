/// @file model-capabilities.ts
/// @brief Model capability queries — dynamically reads provider-registry, replacing hardcoded sets
///
/// The original version used static Sets to hardcode DeepSeek model names.
/// Changed to dynamically query provider-registry, supporting all registered models.

import { getModelDef, getProvider } from "../models/provider-registry";

// ── Backward-Compatible Named Exports ───────────────────────────────

/**
 * Determines whether a model has thinking mode enabled by default.
 * DeepSeek V4 and Gemini series have it enabled by default.
 */
export function defaultsToThinkingMode(model: string): boolean {
  const def = getModelDef(model);
  if (!def) return false;
  const provider = getProvider(def.provider);
  return provider?.supportsThinking === true;
}

/**
 * Determines whether a model supports multimodal (image/audio input).
 * DeepSeek series does not support it; other models depend on the provider.
 */
export function supportsMultimodal(model: string): boolean {
  const def = getModelDef(model);
  if (!def) return true; // 未知模型默认为支持多模态（向后兼容）
  const provider = getProvider(def.provider);
  return provider?.supportsMultimodal === true;
}

/**
 * 判断模型是否属于 DeepSeek V4 系列（保留向后兼容）。
 */
export function isDeepSeekV4Model(model: string): boolean {
  const def = getModelDef(model);
  return def?.provider === "deepseek" && (def.id === "deepseek-v4-pro" || def.id === "deepseek-v4-flash");
}

// ── 保留向后兼容的静态导出 ──────────────────────────────────────

/** @deprecated 请使用 getModelDef() 或 provider-registry 的动态查询 */
export const DEEPSEEK_V4_MODELS: ReadonlySet<string> = new Set(["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"]);

/** @deprecated 请使用 provider-registry 的 supportsMultimodal 字段 */
export const NON_MULTIMODAL_MODELS: ReadonlySet<string> = new Set([
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-chat",
  "deepseek-reasoner",
]);
