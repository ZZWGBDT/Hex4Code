/**
 * @file l3-agent-completion.ts
 * @brief L3 Agent completion — RAG enhanced + pipeline aware + error pattern prevention
 *
 * Leverages Hex4's existing infrastructure to enhance completion quality:
 *   - session-rag.ts: Retrieve relevant code knowledge from conversation history
 *   - kb-loader.ts: Retrieve project documentation from knowledge base
 *   - hex4code-pipeline.ts: Pipeline-stage-aware completions
 *   - Error patterns: Learn from historical build failures and provide prevention suggestions
 *
 * Hex4 映射:
 *   L3 = 应用层智能
 *   RAG = 外部存储器查询
 *   流水线 = 当前执行阶段感知
 *   错误模式 = 故障预测
 */

import type {
  FimContext,
  CompletionItem,
  RelevantSymbol,
  KnowledgeEntry,
  ErrorPatternInfo,
  PipelineStageContext,
} from "./types";
import { PIPELINE_STAGE_PATTERNS } from "./types";
import type { TCType } from "../tools/executor";

/** L3 补全配置 */
export interface L3CompletionConfig {
  /** 是否启用 RAG 检索 */
  enableRag: boolean;
  /** 是否启用知识库检索 */
  enableKnowledgeBase: boolean;
  /** 是否启用错误模式 */
  enableErrorPatterns: boolean;
  /** 是否启用流水线感知 */
  enablePipelineAware: boolean;
  /** 检索 topK */
  ragTopK: number;
  kbTopK: number;
  errorTopK: number;
}

const DEFAULT_L3_CONFIG: L3CompletionConfig = {
  enableRag: true,
  enableKnowledgeBase: true,
  enableErrorPatterns: true,
  enablePipelineAware: true,
  ragTopK: 3,
  kbTopK: 2,
  errorTopK: 2,
};

/** L3 Agent 补全器 */
export class L3AgentCompletion {
  private config: L3CompletionConfig;
  /** 当前流水线阶段上下文 */
  private pipelineContext: PipelineStageContext = { stage: null };

  constructor(config?: Partial<L3CompletionConfig>) {
    this.config = { ...DEFAULT_L3_CONFIG, ...config };
  }

  /**
   * 执行 L3 补全检索。
   * 当前为框架实现，实际 RAG/知识库连接需要项目级集成。
   */
  async retrieve(ctx: FimContext): Promise<{
    symbols: RelevantSymbol[];
    knowledge: KnowledgeEntry[];
    errorPatterns: ErrorPatternInfo[];
    pipelineItems: CompletionItem[];
  }> {
    const query = this.extractQuery(ctx.prefix);

    const [symbols, knowledge, errorPatterns, pipelineItems] = await Promise.all([
      this.config.enableRag ? this.searchRelevantSymbols(query, ctx) : Promise.resolve([]),
      this.config.enableKnowledgeBase ? this.searchKnowledgeBase(query) : Promise.resolve([]),
      this.config.enableErrorPatterns ? this.searchErrorPatterns(query) : Promise.resolve([]),
      this.config.enablePipelineAware ? this.getPipelineCompletions(ctx) : Promise.resolve([]),
    ]);

    return { symbols, knowledge, errorPatterns, pipelineItems };
  }

  /**
   * 更新流水线阶段上下文。
   * 由外部流水线引擎在阶段切换时调用。
   */
  updatePipelineContext(stage: PipelineStageContext): void {
    this.pipelineContext = stage;
  }

  // ── 流水线感知补全 ──────────────────────────────────────────

  /**
   * 根据流水线阶段生成补全。
   */
  private async getPipelineCompletions(ctx: FimContext): Promise<CompletionItem[]> {
    const stage = this.pipelineContext.stage;
    if (!stage) return [];

    const items: CompletionItem[] = [];
    const prefix = ctx.prefix;
    const stageName = stage;

    // 搜索流水线阶段模式
    const stagePatterns = PIPELINE_STAGE_PATTERNS;
    for (const [trigger, suggestions] of Object.entries(stagePatterns)) {
      if (prefix.endsWith(trigger)) {
        for (let i = 0; i < suggestions.length; i++) {
          const suggestion = suggestions[i];
          items.push({
            text: suggestion.startsWith(trigger) ? suggestion.substring(trigger.length) : suggestion,
            tc: "TC_CARRY",
            source: "L3-pipeline",
            score: 45 - i * 5,
            description: `Pipeline: ${stageName}`,
          });
        }
      }
    }

    // 根据上次 TC 状态提供阶段相关补全
    if (this.pipelineContext.lastTcState === "TC_CARRY" || this.pipelineContext.lastTcState === "TC_UNCERTAIN") {
      // 上次阶段有警告 → 提供回滚/检查建议
      items.push({
        text: "// TC propagation: upstream had warnings, verify carefully",
        tc: "TC_CARRY",
        source: "L3-pipeline",
        score: 40,
        description: "TC warning propagation comment",
      });
    }

    return items;
  }

  // ── RAG 检索 ────────────────────────────────────────────────

  /**
   * 搜索相关符号。
   * 尝试动态导入 session-rag.ts。
   */
  private async searchRelevantSymbols(query: string, _ctx: FimContext): Promise<RelevantSymbol[]> {
    if (!query) return [];

    try {
      // 动态加载 session-rag（如果可用）
      const rag = await this.loadRagModule();
      if (rag) {
        const results = rag.searchKnowledge(query, this.config.ragTopK);
        return results.map((r) => {
          const tc: TCType = r.score > 0.3 ? "TC_CARRY" : "TC_UNCERTAIN";
          return {
            name: r.chunk.question.substring(0, 50),
            definition: r.chunk.answer.substring(0, 300),
            file: "rag",
            line: 0,
            tcScore: tc,
            kind: "rag",
          };
        });
      }
    } catch {
      // RAG 不可用，静默降级
    }

    return [];
  }

  /**
   * 搜索知识库。
   * 尝试动态导入 kb-loader.ts。
   */
  private async searchKnowledgeBase(query: string): Promise<KnowledgeEntry[]> {
    if (!query) return [];

    try {
      const kb = await this.loadKbModule();
      if (kb) {
        const results = kb.searchKnowledgeBase(query, this.config.kbTopK);
        return results.map((r) => ({
          title: r.title,
          content: r.content.substring(0, 300),
          category: r.category,
          score: 1,
        }));
      }
    } catch {
      // KB 不可用，静默降级
    }

    return [];
  }

  /**
   * 搜索错误模式。
   * 尝试动态导入 session-rag.ts 的 extractErrorPatterns。
   */
  private async searchErrorPatterns(query: string): Promise<ErrorPatternInfo[]> {
    if (!query) return [];

    try {
      const rag = await this.loadRagModule();
      if (rag) {
        const patterns = rag.searchPatterns(query, this.config.errorTopK);
        return patterns.map((p) => ({
          errorType: p.errorType,
          fixSequence: p.fixSequence,
          finalStatus: p.finalStatus,
          relevance: p.finalStatus === "fixed" ? 0.8 : 0.3,
        }));
      }
    } catch {
      // 静默降级
    }

    return [];
  }

  // ── 辅助方法 ────────────────────────────────────────────────

  /** 从前缀提取查询关键词 */
  private extractQuery(prefix: string): string {
    // 提取最后一个有意义的标识符
    const matches = prefix.match(/(\w[\w\d_]*)$/);
    if (!matches) return "";
    const word = matches[1];

    // 对 HEX4 专有标识符加权
    if (/^(hex4_|TC_|Hex4|ternary_|sm2_|tc_)/.test(word)) {
      return word;
    }

    // 对常见编程关键词忽略
    const skipWords = new Set(["if", "for", "while", "return", "const", "let", "var", "function", "def", "class", "import", "from", "try", "catch", "async", "await"]);
    if (skipWords.has(word)) return "";
    if (word.length < 3) return "";

    return word;
  }

  /** 加载 RAG 模块 */
  private async loadRagModule(): Promise<typeof import("../knowledge/session-rag") | null> {
    try {
      return await import("../knowledge/session-rag");
    } catch {
      return null;
    }
  }

  /** 加载 KB 模块 */
  private async loadKbModule(): Promise<typeof import("../knowledge/kb-loader") | null> {
    try {
      return await import("../knowledge/kb-loader");
    } catch {
      return null;
    }
  }

  /** 获取 L3 配置 */
  getConfig(): L3CompletionConfig {
    return { ...this.config };
  }
}
