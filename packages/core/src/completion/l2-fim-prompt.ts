/**
 * @file l2-fim-prompt.ts
 * @brief FIM prompt template — generates FIM-format completion requests for different models
 *
 * Supports multiple FIM formats:
 *   - DeepSeek Coder: <|fim_prefix|>...<|fim_suffix|>...<|fim_middle|>
 *   - Codestral: [SUFFIX]...[PREFIX] (special calling convention)
 *   - Generic: system+user message format
 *
 * Hex4 映射:
 *   FIM 格式 = 指令编码格式
 *   模型适配 = 不同硬件的指令集
 */

import type { FimContext } from "./types";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/** FIM 模型类型 */
export type FimModelType = "deepseek-coder" | "codestral" | "general";

/** FIM Token 配置 */
interface FimTokens {
  prefix: string;
  suffix: string;
  middle: string;
}

/** 各模型的 FIM Token */
const FIM_TOKENS: Record<string, FimTokens> = {
  "deepseek-coder": {
    prefix: "<|fim_prefix|>",
    suffix: "<|fim_suffix|>",
    middle: "<|fim_middle|>",
  },
  "deepseek-coder-v2": {
    prefix: "<|fim_prefix|>",
    suffix: "<|fim_suffix|>",
    middle: "<|fim_middle|>",
  },
};

/** 检测模型类型 */
export function detectFimModelType(modelId: string): FimModelType {
  if (modelId.startsWith("deepseek-coder")) return "deepseek-coder";
  if (modelId.startsWith("codestral") || modelId.includes("codestral")) return "codestral";
  return "general";
}

/**
 * 为普通补全构建 Prompt（非 FIM 格式的通用模式）。
 * 适用于不支持 FIM 的模型（如 deepseek-v4-flash 等通用对话模型）。
 */
export function buildGeneralCompletionPrompt(ctx: FimContext): ChatCompletionMessageParam[] {
  const langHint = ctx.language;
  let scopeHint = "";
  if (ctx.scope?.functionName) {
    scopeHint = `You are inside: ${ctx.scope.functionName}(${ctx.scope.parameters?.join(", ") || ""})`;
    if (ctx.scope.returnType) scopeHint += ` -> ${ctx.scope.returnType}`;
    if (ctx.scope.className) scopeHint = `${ctx.scope.className}.${scopeHint}`;
  }

  // 构建 RAG 上下文
  let ragHint = "";
  if (ctx.relevantSymbols && ctx.relevantSymbols.length > 0) {
    ragHint = "\nRelevant definitions:\n" + ctx.relevantSymbols
      .map((s) => `  [${s.file}:${s.line}] ${s.kind} ${s.name}: ${s.definition.substring(0, 200)}`)
      .join("\n");
  }

  // 构建知识库上下文
  let kbHint = "";
  if (ctx.knowledgeEntries && ctx.knowledgeEntries.length > 0) {
    kbHint = "\nKnowledge:\n" + ctx.knowledgeEntries
      .map((e) => `  [${e.category}] ${e.title}: ${e.content.substring(0, 200)}`)
      .join("\n");
  }

  const beforeCode = ctx.prefix.split("\n").slice(-8).join("\n");
  const afterCode = ctx.suffix.split("\n").slice(0, 3).join("\n");

  let prompt = `Complete the following ${langHint} code at cursor.\n`;
  prompt += `Rules:\n`;
  prompt += `- Output ONLY the completion text, no explanation.\n`;
  prompt += `- Do NOT repeat the line prefix that's already typed.\n`;
  prompt += `- Keep it concise (<256 tokens).\n`;
  prompt += `- Match the style of surrounding code.\n`;

  if (scopeHint) prompt += `\n${scopeHint}\n`;
  if (ragHint) prompt += `${ragHint}\n`;
  if (kbHint) prompt += `${kbHint}\n`;

  prompt += `\nBefore cursor:\n\`\`\`${langHint}\n${beforeCode}\n\`\`\`\n`;

  if (afterCode.trim()) {
    prompt += `After cursor:\n\`\`\`${langHint}\n${afterCode}\n\`\`\`\n`;
  }

  prompt += `\nCompletion:`;

  return [{ role: "user", content: prompt }];
}

/**
 * 为 DeepSeek Coder 系列构建 FIM Prompt。
 * 使用特殊的 FIM token 格式。
 */
export function buildDeepSeekCoderFimPrompt(ctx: FimContext): ChatCompletionMessageParam[] {
  const tokens = FIM_TOKENS["deepseek-coder"];
  if (!tokens) return buildGeneralCompletionPrompt(ctx);

  const langHint = ctx.language;

  // 构建作用域/RAG 上下文作为 system prompt 的一部分
  let scopeContext = "";
  if (ctx.scope?.functionName) {
    scopeContext = `Context: inside ${ctx.scope.functionName}(${ctx.scope.parameters?.join(", ") || ""})`;
    if (ctx.scope.className) scopeContext = `Context: ${ctx.scope.className}.${scopeContext}`;
  }

  // FIM 三段式格式
  const fimText = `${tokens.prefix}${ctx.prefix}${tokens.suffix}${ctx.suffix}${tokens.middle}`;

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: [
        `You are a code completion assistant for ${langHint}.`,
        scopeContext,
        `Output ONLY the completion. No explanation.`,
        `Keep it under 256 tokens.`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
    {
      role: "user",
      content: fimText,
    },
  ];

  return messages;
}

/**
 * 为 Codestral 构建 FIM Prompt。
 * Codestral 使用特殊的 API 参数而非 FIM token。
 */
export function buildCodestralFimRequest(ctx: FimContext): {
  messages: ChatCompletionMessageParam[];
  extraParams: Record<string, unknown>;
} {
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "user",
      content: ctx.prefix || " ",
    },
  ];

  const extraParams: Record<string, unknown> = {
    suffix: ctx.suffix || " ",
  };

  return { messages, extraParams };
}

/**
 * 根据模型类型自动选择 Prompt 构建器。
 */
export function buildPrompt(
  ctx: FimContext,
  modelId: string,
): {
  messages: ChatCompletionMessageParam[];
  extraParams?: Record<string, unknown>;
} {
  const modelType = detectFimModelType(modelId);

  switch (modelType) {
    case "deepseek-coder":
      return { messages: buildDeepSeekCoderFimPrompt(ctx) };
    case "codestral":
      return buildCodestralFimRequest(ctx);
    case "general":
    default:
      return { messages: buildGeneralCompletionPrompt(ctx) };
  }
}
