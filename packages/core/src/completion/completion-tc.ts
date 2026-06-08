/**
 * @file completion-tc.ts
 * @brief TC evaluator — calculates confidence for each completion candidate
 *
 * Evaluates completion quality across multiple factors, mapping to TC four states.
 * TC tags affect sort priority and UI display color.
 *
 * Hex4 映射:
 *   TC 四态置信传播 → 补全质量分级
 *   TC_NONE (绿) = 确定补全
 *   TC_CARRY (蓝) = 参考补全
 *   TC_UNCERTAIN (橙) = 不确定补全
 *   TC_MIXED (红) = 混合信号
 */

import type { TCType } from "../tools/executor";
import type { CompletionItem, CompletionSource, FimContext } from "./types";

/** TC 评估因子权重 */
interface TcFactorWeights {
  /** 来源层级权重 */
  sourceWeight: Record<CompletionSource, number>;
  /** RAG 相关性加分 */
  ragBoost: number;
  /** 历史使用频率加分 */
  usageBoost: number;
  /** 错误模式扣分 */
  errorPenalty: number;
  /** FIM 完整度加分 */
  fimCompleteness: number;
}

const DEFAULT_WEIGHTS: TcFactorWeights = {
  sourceWeight: {
    "L1-pattern": 60,
    "L2-fim": 50,
    "L2-local": 25,
    "L3-rag": 35,
    "L3-pipeline": 45,
    "L3-error-pattern": 15,
  },
  ragBoost: 10,
  usageBoost: 5,
  errorPenalty: 20,
  fimCompleteness: 10,
};

/** 使用频率跟踪器 */
class UsageTracker {
  private freq = new Map<string, number>();

  /** 记录一次使用 */
  record(text: string): void {
    this.freq.set(text, (this.freq.get(text) || 0) + 1);
  }

  /** 获取使用频率 */
  getFrequency(text: string): number {
    return this.freq.get(text) || 0;
  }

  /** 获取所有频率数据 */
  getAll(): Record<string, number> {
    return Object.fromEntries(this.freq);
  }
}

/** TC 评估器 */
export class TcEvaluator {
  private weights: TcFactorWeights;
  private usageTracker: UsageTracker;
  /** 错误模式缓存（防止频繁搜索） */
  private errorPatternCache: Array<{ text: string; isError: boolean }> = [];

  constructor(weights?: Partial<TcFactorWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    this.usageTracker = new UsageTracker();
  }

  /**
   * 评估单个补全省略项。
   * @param item 补全省略项
   * @param context FIM 上下文（可选，用于 RAG 相关性判断）
   * @returns 评估后的 TC 类型
   */
  evaluate(item: CompletionItem, context?: FimContext): TCType {
    const score = this.computeScore(item, context);
    return this.scoreToTc(score);
  }

  /**
   * 批量评估并排序。
   * @param items 补全省略项列表
   * @param context FIM 上下文
   * @returns 按分数降序排列的补全省略项（带 TC 标签）
   */
  rank(items: CompletionItem[], context?: FimContext): CompletionItem[] {
    for (const item of items) {
      const score = this.computeScore(item, context);
      item.score = score;
      item.tc = this.scoreToTc(score);
    }

    return items.sort((a, b) => {
      // 首先按 TC 优先级
      const tcOrder: Record<TCType, number> = { TC_NONE: 0, TC_CARRY: 1, TC_UNCERTAIN: 2, TC_MIXED: 3 };
      const tcDiff = (tcOrder[a.tc] ?? 0) - (tcOrder[b.tc] ?? 0);
      if (tcDiff !== 0) return tcDiff;
      // 然后按分数
      return b.score - a.score;
    });
  }

  /** 记录补全被接受（用于频率跟踪） */
  recordAcceptance(text: string): void {
    this.usageTracker.record(text);
  }

  /** 注册错误模式 */
  registerErrorPattern(text: string): void {
    // 简化实现：将包含常见错误模式的文本标记为高风险
    const errorIndicators = [
      "undefined reference", "segfault", "assertion failed",
      "null pointer", "memory leak", "deadlock",
      "security", "vulnerability", "SQL injection",
    ];
    const isError = errorIndicators.some((ind) => text.toLowerCase().includes(ind));
    this.errorPatternCache.push({ text, isError });

    // 限制缓存大小
    if (this.errorPatternCache.length > 1000) {
      this.errorPatternCache = this.errorPatternCache.slice(-500);
    }
  }

  // ── 内部评分逻辑 ─────────────────────────────────────────────

  private computeScore(item: CompletionItem, context?: FimContext): number {
    let score = 0;

    // 因子 1: 来源基础分
    score += this.weights.sourceWeight[item.source] ?? 20;

    // 因子 2: 文本长度合理性（太短或太长都扣分）
    const len = item.text.length;
    if (len >= 2 && len <= 200) {
      score += 10;
    } else if (len > 200) {
      score -= 5; // 过长可能包含噪音
    } else {
      score -= 5; // 过短无意义
    }

    // 因子 3: RAG 相关性（如果有上下文）
    if (context?.relevantSymbols && context.relevantSymbols.length > 0) {
      const matchCount = context.relevantSymbols.filter((s) =>
        item.text.toLowerCase().includes(s.name.toLowerCase()),
      ).length;
      score += matchCount * this.weights.ragBoost;
    }

    // 因子 4: 历史使用频率
    const freq = this.usageTracker.getFrequency(item.text);
    score += Math.min(freq * this.weights.usageBoost, 20);

    // 因子 5: 错误模式扣分
    const hasError = this.errorPatternCache.some(
      (e) => e.isError && item.text.toLowerCase().includes(e.text.toLowerCase()),
    );
    if (hasError) {
      score -= this.weights.errorPenalty;
    }

    // 因子 6: 与光标前文本的连续性
    if (context?.prefix) {
      const lastChar = context.prefix.slice(-1);
      const firstChar = item.text[0];
      if (lastChar && firstChar) {
        // 检查是否有合理的衔接（如空格、标点对齐）
        const seamless = this.checkSeamless(lastChar, firstChar);
        if (seamless) score += 5;
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  /** 检查两个字符之间是否有合理的衔接 */
  private checkSeamless(last: string, first: string): boolean {
    // 标识符连续
    if (/[a-zA-Z0-9_]/.test(last) && /[a-zA-Z0-9_]/.test(first)) return true;
    // 空格后接合法字符
    if (/\s/.test(last) && !/\s/.test(first)) return true;
    // 操作符后接操作数
    if (/[+\-*/=<>!&|]/.test(last)) return true;
    // 左括号后
    if (last === "(" || last === "[" || last === "{") return true;
    // 逗号/分号后
    if (last === "," || last === ";") return true;
    return false;
  }

  /** 将分数映射到 TC 四态 */
  private scoreToTc(score: number): TCType {
    if (score >= 70) return "TC_NONE";
    if (score >= 45) return "TC_CARRY";
    if (score >= 25) return "TC_UNCERTAIN";
    return "TC_MIXED";
  }

  /** 获取 TC 对应的展示颜色（用于 UI） */
  static getTcColor(tc: TCType): string {
    switch (tc) {
      case "TC_NONE":
        return "#888"; // 灰色 — 标准
      case "TC_CARRY":
        return "#5B9BD5"; // 蓝色 — 参考
      case "TC_UNCERTAIN":
        return "#ED7D31"; // 橙色 — 不确定
      case "TC_MIXED":
        return "#FF4444"; // 红色 — 混合
    }
  }

  /** 获取 TC 对应的透明度 (用于流式渐进) */
  static getTcAlpha(tc: TCType): number {
    switch (tc) {
      case "TC_NONE":
        return 1.0;
      case "TC_CARRY":
        return 0.8;
      case "TC_UNCERTAIN":
        return 0.6;
      case "TC_MIXED":
        return 0.4;
    }
  }
}
