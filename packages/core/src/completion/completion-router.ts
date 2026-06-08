/**
 * @file completion-router.ts
 * @brief Completion router — determines L1/L2/L3 strategy based on TC evaluation and context
 *
 * Three-way decision:
 *   L1-only: Deterministic pattern match hit -> zero-latency return
 *   L1+L2: Requires AI completion -> parallel L1 + FIM API
 *   L1+L2+L3: Rich project context scenarios -> all enabled
 *
 * Hex4 mapping:
 *   Router = instruction dispatch unit
 *   TC threshold = priority encoder
 */

import type { PatternMatch, CompletionItem, FimContext } from "./types";
import { L1PatternIndex } from "./l1-pattern-index";
import { FimHandler } from "./l2-fim-handler";
import { L3AgentCompletion } from "./l3-agent-completion";
import { TcEvaluator } from "./completion-tc";
import { DEFAULT_COMPLETION_CONFIG } from "./types";

/** 路由策略 */
export type RoutingStrategy = "L1-only" | "L1+L2" | "L1+L2+L3";

/** 路由决策 */
interface RoutingDecision {
  strategy: RoutingStrategy;
  reason: string;
  /** L1 匹配项（如果 L1 命中） */
  l1Matches: PatternMatch[];
}

/** 补全路由器 */
export class CompletionRouter {
  private l1Index: L1PatternIndex;
  private fimHandler: FimHandler | null;
  private l3Agent: L3AgentCompletion;
  private tcEvaluator: TcEvaluator;
  private maxTotalItems: number;

  constructor(
    l1Index: L1PatternIndex,
    l3Agent: L3AgentCompletion,
    tcEvaluator: TcEvaluator,
    fimHandler: FimHandler | null,
    maxTotalItems?: number,
  ) {
    this.l1Index = l1Index;
    this.fimHandler = fimHandler;
    this.l3Agent = l3Agent;
    this.tcEvaluator = tcEvaluator;
    this.maxTotalItems = maxTotalItems ?? DEFAULT_COMPLETION_CONFIG.maxTotalItems;
  }

  /**
   * 路由决策：根据上下文决定使用哪些补全层级。
   */
  decide(textBefore: string, language: string): RoutingDecision {
    // Step 1: 运行 L1 模式匹配
    const l1Matches = this.l1Index.search(textBefore, language);

    // Step 2: 判断 L1 是否有确定性匹配
    const hasDeterministicMatch = l1Matches.some((m) => m.tc === "TC_NONE" && m.priority < 10);

    if (hasDeterministicMatch) {
      // L1 确定性命中 → L1-only (零延迟)
      return {
        strategy: "L1-only",
        reason: "Deterministic L1 pattern match",
        l1Matches,
      };
    }

    if (l1Matches.length > 0) {
      // L1 有模糊匹配 → 并行 L1 + L2
      return {
        strategy: "L1+L2",
        reason: "L1 fuzzy match, augmenting with L2 FIM",
        l1Matches,
      };
    }

    // 无 L1 匹配 → L1+L2+L3 (全量)
    return {
      strategy: "L1+L2+L3",
      reason: "No L1 match, full pipeline",
      l1Matches: [],
    };
  }

  /**
   * 执行补全路由。
   *
   * @param textBefore 光标前文本
   * @param textAfter 光标后文本
   * @param language 语言
   * @param fimContext FIM 上下文（可选，为 null 时自动构建）
   * @returns 排序后的补全省略项
   */
  async route(
    textBefore: string,
    _textAfter: string,
    language: string,
    fimContext?: FimContext,
  ): Promise<CompletionItem[]> {
    const decision = this.decide(textBefore, language);
    const allItems: CompletionItem[] = [];

    // L1: 模式匹配结果
    for (const match of decision.l1Matches) {
      allItems.push({
        text: match.suffix,
        tc: match.tc,
        source: match.source,
        score: 100 - match.priority,
        description: match.description,
      });
    }

    // L2 / L3: 仅当需要时
    if (decision.strategy !== "L1-only" && this.fimHandler && fimContext) {
      // L2: FIM API 补全
      const fimItems = await this.fimHandler.complete(fimContext);
      for (const item of fimItems) {
        allItems.push(item);
      }

      // L3: RAG + 流水线补全
      if (decision.strategy === "L1+L2+L3") {
        const l3Result = await this.l3Agent.retrieve(fimContext);

        // 将 RAG 检索结果注入 FIM 上下文（以便 TC 评估使用）
        fimContext.relevantSymbols = l3Result.symbols;
        fimContext.knowledgeEntries = l3Result.knowledge;
        fimContext.errorPatterns = l3Result.errorPatterns;

        // L3 流水线补全省略项
        for (const item of l3Result.pipelineItems) {
          allItems.push(item);
        }
      }
    }

    // TC 评估 + 排序
    const ranked = this.tcEvaluator.rank(allItems, fimContext);

    // 截取上限
    return ranked.slice(0, this.maxTotalItems);
  }
}
