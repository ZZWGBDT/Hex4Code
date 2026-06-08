/**
 * @file completion-manager.ts
 * @brief Completion manager — unified entry point for VS Code InlineCompletionItemProvider
 *
 * Replaces the original UnifiedCompletionProvider / GeneralAutocompleteProvider.
 * Integrates the L1/L2/L3 three-tier completion architecture, providing a TC-enhanced code completion experience.
 *
 * Architecture flow:
 *   provideInlineCompletionItems()
 *     → 触发判断 + 去抖
 *     → 路由决策 (L1-only / L1+L2 / L1+L2+L3)
 *     → TC 评估 + 排序
 *     → 返回 vscode.InlineCompletionItem[]
 *
 * Hex4 映射:
 *   补全管理器 = 系统控制器
 *   L1/L2/L3 = 指令流水线的三级
 *   TC 标签 = 执行结果的状态码
 */

import { L1PatternIndex } from "./l1-pattern-index";
import { FimHandler } from "./l2-fim-handler";
import { L3AgentCompletion } from "./l3-agent-completion";
import { TcEvaluator } from "./completion-tc";
import { CompletionCache } from "./completion-cache";
import { CompletionDebouncer, shouldTriggerCompletion } from "./completion-debounce";
import { FimContextBuilder } from "./l2-fim-context";
import {
  DEFAULT_COMPLETION_CONFIG,
  LOCAL_PATTERNS,
  type CompletionManagerOptions,
  type CompletionItem,
} from "./types";

/** VS Code 类型引用（运行时存在） */
declare const vscode: any;

/**
 * CompletionManager — 统一补全入口
 *
 * 替换旧的 UnifiedCompletionProvider。
 * 在 VS Code 中注册为 InlineCompletionItemProvider。
 */
export class CompletionManager {
  /** 解析后的扁平化配置 */
  private options: {
    projectRoot: string;
    enableL3: boolean;
    fimModel?: string;
    debounceMs: number;
    maxCompletionTokens: number;
    temperature: number;
    enableTcColor: boolean;
    skipLanguages: Set<string>;
    minTriggerLength: number;
  };
  private l1Index: L1PatternIndex;
  private l2Handler: FimHandler | null = null;
  private l3Agent: L3AgentCompletion;
  private tcEvaluator: TcEvaluator;
  private cache: CompletionCache;
  private debouncer: CompletionDebouncer;
  private ctxBuilder: FimContextBuilder;
  private disposed = false;

  constructor(options: CompletionManagerOptions) {
    this.options = {
      projectRoot: options.projectRoot,
      enableL3: options.enableL3 ?? DEFAULT_COMPLETION_CONFIG.enableL3,
      fimModel: options.fimModel,
      debounceMs: options.debounceMs ?? DEFAULT_COMPLETION_CONFIG.debounceMs,
      maxCompletionTokens: options.maxCompletionTokens ?? DEFAULT_COMPLETION_CONFIG.maxCompletionTokens,
      temperature: options.temperature ?? DEFAULT_COMPLETION_CONFIG.temperature,
      enableTcColor: options.enableTcColor ?? DEFAULT_COMPLETION_CONFIG.enableTcColor,
      skipLanguages: options.skipLanguages ?? DEFAULT_COMPLETION_CONFIG.skipLanguages,
      minTriggerLength: options.minTriggerLength ?? DEFAULT_COMPLETION_CONFIG.minTriggerLength,
    };

    // 初始化各模块
    this.l1Index = new L1PatternIndex(this.options.projectRoot);
    this.tcEvaluator = new TcEvaluator();
    this.cache = new CompletionCache();
    this.debouncer = new CompletionDebouncer(this.options.debounceMs);
    this.l3Agent = new L3AgentCompletion({ enableRag: this.options.enableL3 });
    this.ctxBuilder = new FimContextBuilder({
      language: "plaintext",
      nearLinesBefore: 15,
      nearLinesAfter: 5,
    });

    // L2 Handler 延迟初始化（需要 API 凭证）
    this.l2Handler = null;

    // 异步初始化 L1 索引
    void this.l1Index.initialize();
  }

  /**
   * 设置 FIM API 凭证（在 VS Code extension 激活时调用）。
   */
  configureFimHandler(apiKey: string, baseURL: string, modelId: string): void {
    this.l2Handler = new FimHandler({
      apiKey,
      baseURL,
      modelId: modelId || "deepseek-v4-flash",
      maxTokens: this.options.maxCompletionTokens,
      temperature: this.options.temperature,
      enableStreaming: true,
    });
  }

  /**
   * VS Code InlineCompletionItemProvider 接口。
   * 被 vscode.languages.registerInlineCompletionItemProvider 调用。
   */
  async provideInlineCompletionItems(
    document: any,
    position: any,
    _context: any,
    token: any,
  ): Promise<any[]> {
    if (this.disposed || token?.isCancellationRequested) return [];

    const languageId = document.languageId;
    const line = document.lineAt(position.line);
    const textBefore = line.text.substring(0, position.character);
    const textAfter = line.text.substring(position.character);

    // Step 1: 触发判断
    if (!shouldTriggerCompletion(
      textBefore,
      languageId,
      this.options.skipLanguages,
      this.options.minTriggerLength,
    )) {
      return this.getLocalFallback(textBefore);
    }

    // Step 2: 去抖
    const shouldProceed = await this.debouncer.wait(this.options.debounceMs, token);
    if (!shouldProceed || token?.isCancellationRequested) return [];

    // Step 3: L1 模式匹配
    const l1Matches = this.l1Index.search(textBefore, languageId);
    const hasDeterministicMatch = l1Matches.some((m) => m.tc === "TC_NONE" && m.priority < 10);

    if (hasDeterministicMatch) {
      // L1-only: 零延迟返回模式匹配结果
      return l1Matches.map((m) => this.toInlineItem(m.suffix, m.tc, m.description));
    }

    // Step 4: 检查缓存
    const cacheKey = this.cache.makeKey(textBefore, textAfter, this.options.fimModel || "default", languageId);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.length > 0) {
      return cached.map((item) => this.toInlineItem(item.text, item.tc, item.description));
    }

    // Step 5: 构建 FIM 上下文
    const fullText = document.getText();
    const fileName = document.fileName || "";
    const fimCtx = await this.ctxBuilder.build(textBefore, textAfter, languageId, fullText, fileName);

    // Step 6: L2/L3 补全
    const allItems: CompletionItem[] = [];

    // L1 模式（即使不是确定性匹配也带上）
    for (const match of l1Matches) {
      allItems.push({
        text: match.suffix,
        tc: match.tc,
        source: match.source,
        score: 100 - match.priority,
        description: match.description,
      });
    }

    // L2 FIM API（如果有 handler）
    if (this.l2Handler) {
      const fimItems = await this.l2Handler.complete(fimCtx);
      for (const item of fimItems) {
        allItems.push(item);
      }
    } else {
      // 无 FIM handler → 通用本地补全
      const localItems = this.getLocalFallbackItems(textBefore);
      for (const item of localItems) {
        allItems.push(item);
      }
    }

    // L3 RAG + 流水线
    if (this.options.enableL3) {
      const l3Result = await this.l3Agent.retrieve(fimCtx);
      fimCtx.relevantSymbols = l3Result.symbols;
      for (const item of l3Result.pipelineItems) {
        allItems.push(item);
      }
    }

    // Step 7: TC 评估 + 排序
    const ranked = this.tcEvaluator.rank(allItems, fimCtx);

    // Step 8: 写入缓存
    this.cache.set(cacheKey, ranked);

    // Step 9: 转换为 VS Code InlineCompletionItem
    return ranked.slice(0, 5).map((item) => this.toInlineItem(item.text, item.tc, item.description));
  }

  /** 更新流水线阶段（由外部流水线引擎调用） */
  updatePipelineStage(stage: string, tcState?: string): void {
    this.l3Agent.updatePipelineContext({
      stage: stage as any,
      lastTcState: tcState as any,
    });
  }

  /** 记录补全被接受 */
  recordAcceptance(text: string): void {
    this.tcEvaluator.recordAcceptance(text);
  }

  /** 重新索引 L1 模式 */
  async reindex(): Promise<void> {
    await this.l1Index.reindex();
  }

  /** 释放资源 */
  dispose(): void {
    this.disposed = true;
    this.debouncer.dispose();
    this.cache.clear();
  }

  /** 获取统计信息 */
  getStats() {
    return {
      l1Patterns: this.l1Index.getStats(),
      cache: this.cache.stats(),
      l3Config: this.l3Agent.getConfig(),
    };
  }

  // ── 内部辅助方法 ─────────────────────────────────────────────

  /**
   * 将 CompletionItem 转换为 VS Code InlineCompletionItem。
   * 当 vscode 类型不可用时，返回简单对象。
   */
  private toInlineItem(text: string, _tc: string, _description?: string): any {
    if (typeof vscode !== "undefined" && vscode?.InlineCompletionItem) {
      const item = new vscode.InlineCompletionItem(text);
      return item;
    }
    // 非 VS Code 环境：返回纯对象
    return { insertText: text };
  }

  /**
   * 获取本地补全（无 API 时的终极降级）。
   */
  private getLocalFallback(textBefore: string): any[] {
    const items = this.getLocalFallbackItems(textBefore);
    return items.slice(0, 3).map((item) => this.toInlineItem(item.text, item.tc, item.description));
  }

  /**
   * 生成本地补全省略项。
   */
  private getLocalFallbackItems(textBefore: string): CompletionItem[] {
    const items: CompletionItem[] = [];
    const lastLine = textBefore.split("\n").pop() || "";
    const trimmed = lastLine.trimStart();
    const indentation = lastLine.slice(0, lastLine.length - trimmed.length);

    // 模式匹配
    for (const [prefix, suggestions] of Object.entries(LOCAL_PATTERNS)) {
      if (trimmed.endsWith(prefix)) {
        for (const s of suggestions) {
          const suffix = s.startsWith(prefix) ? s.substring(prefix.length) : "";
          items.push({
            text: suffix,
            tc: "TC_NONE",
            source: "L2-local",
            score: 30,
          });
        }
        return items;
      }
    }

    // 括号匹配
    if (trimmed.endsWith("{")) {
      items.push({
        text: `\n${indentation}  \n${indentation}}`,
        tc: "TC_NONE",
        source: "L2-local",
        score: 25,
        description: "auto-close brace",
      });
    }
    if (trimmed.endsWith("(")) {
      items.push({
        text: ")",
        tc: "TC_NONE",
        source: "L2-local",
        score: 25,
        description: "auto-close paren",
      });
    }
    if (trimmed.endsWith("[")) {
      items.push({
        text: "]",
        tc: "TC_NONE",
        source: "L2-local",
        score: 25,
        description: "auto-close bracket",
      });
    }

    return items;
  }
}
