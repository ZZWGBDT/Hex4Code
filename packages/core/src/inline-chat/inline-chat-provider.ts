/**
 * Inline Chat (Cmd+K) — TC state propagation integration
 *
 * Architecture:
 *   Select code -> Cmd+K opens floating input box
 *   -> User inputs natural language instructions
 *   -> Calls LLM streaming to return modifications
 *   -> TC propagation engine reviews modification confidence
 *   -> Diff preview -> Accept/Reject
 *
 * TC integration points:
 *   - 每个 InlineEdit 带 TCState (NONE~MIXED)
 *   - 编辑操作的 LLM 返回值解析时构建 TCPropagationSource
 *   - 通过 tc-propagate.ts 传播到 SymbolGraph
 *   - 用户接受编辑时，TC 作为 pipeline-tc.ts 输入
 */

import { TC, makeCell, Trit, type TCCell } from "../tc/tc-types";
import { tcAdd } from "../tc/tc-semiring";
import type { TCPropagationSource } from "../tc/tc-propagate";
import { SymbolGraph } from "../indexer/symbol-graph";

// ── 类型定义 ────────────────────────────────────────────────────────────

export interface InlineEditRange {
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
}

export interface InlineEditResult {
  /** 编辑后的完整代码 */
  editedCode: string;
  /** 被替换的范围 */
  range: InlineEditRange;
  /** TC 置信状态 */
  tcCell: TCCell;
  /** 原始代码片段（用于 diff） */
  originalSnippet: string;
  /** 替换代码片段 */
  newSnippet: string;
  /** LLM 原始响应 */
  rawResponse: string;
}

export interface InlineChatContext {
  /** 选中文本 */
  selectedText: string;
  /** 完整文件内容 */
  fullFileContent: string;
  /** 文件路径 */
  filePath: string;
  /** 语言 ID */
  languageId: string;
  /** 光标/选区位置 */
  selectionRange: InlineEditRange;
  /** 已有符号图（可选） */
  symbolGraph?: SymbolGraph;
  /** 用户输入的自然语言指令 */
  instruction: string;
}

// ── 策略枚举（对应 C 层 Hex4TCStrategy） ─────────────────────────────

export enum InlineStrategy {
  CONSERVATIVE = 0,  // 仅接受高置信度的修改
  NEUTRAL = 1,       // 默认策略
  AGGRESSIVE = 2,    // 优先接受 LLM 修改
  CONTEXT_AWARE = 3, // 根据代码上下文动态调整
}

// ── TC 传播规则（对应 C 层 tc_propagation_rules.c） ──────────────────

/**
 * 计算 Inline Edit 的 TC 状态
 * 对应 C 层 tc_propagate_add: TC = TC(a) + TC(b) + carry
 *
 * 输入因素：
 *   - 选中代码的复杂度与编辑幅度的比值
 *   - 指令与代码语言的相关性
 *   - LLM 返回的格式质量
 */
export function computeInlineEditTC(
  originalLength: number,
  newLength: number,
  languageConfidence: number, // [0,1] 语言匹配度
  llmQuality: number,         // [0,1] LLM 输出格式质量
): TCCell {
  // 编辑幅度比
  const ratio = originalLength > 0 ? Math.abs(newLength - originalLength) / originalLength : 0.5;

  // 编辑幅度为 0 → TC.NONE (无变化)
  if (ratio < 0.01) {
    return makeCell(Trit.T0, TC.NONE, 1.0);
  }

  // 根据因素计算 TC 类型（对应 C 层的 max 优先级规则）
  let tc: TC = TC.CARRY;

  // 低语言匹配度 → 升级为 UNCERTAIN
  if (languageConfidence < 0.4) {
    tc = tcAdd(tc, TC.UNCERTAIN);
  }

  // 低 LLM 质量 → 升级为 MIXED
  if (llmQuality < 0.3) {
    tc = tcAdd(tc, TC.MIXED);
  }

  // 大幅修改（>80%）→ 引入冲突
  if (ratio > 0.8) {
    tc = tcAdd(tc, TC.HIGH_CONFLICT);
  }

  // 权重：编辑幅度越小，置信度越高
  const weight = Math.max(0.1, 1.0 - ratio * 0.5);

  return makeCell(Trit.T1, tc, weight);
}

// ── 范围解析器 ──────────────────────────────────────────────────────────

/**
 * 从完整文件和选中文本还原行范围
 * 对应 C 层的 position.index / position.(x,y,z) 位置追踪
 */
export function resolveSelectionRange(
  fullText: string,
  selectedText: string,
): InlineEditRange {
  const lines = fullText.split("\n");
  const selLines = selectedText.split("\n");
  const firstSelLine = selLines[0];

  for (let i = 0; i < lines.length; i++) {
    const col = lines[i].indexOf(firstSelLine);
    if (col !== -1) {
      // 验证后续行匹配
      let match = true;
      for (let j = 1; j < selLines.length; j++) {
        if (i + j >= lines.length || lines[i + j].indexOf(selLines[j]) === -1) {
          match = false;
          break;
        }
      }
      if (match) {
        return {
          startLine: i,
          endLine: i + selLines.length - 1,
          startCol: Math.max(0, col),
          endCol: Math.max(0, col + selLines[selLines.length - 1].length),
        };
      }
    }
  }

  // fallback: 未找到匹配，返回整个文件范围
  return { startLine: 0, endLine: lines.length - 1, startCol: 0, endCol: lines[lines.length - 1]?.length ?? 0 };
}

// ── Inline Chat 核心引擎 ──────────────────────────────────────────────

export interface InlineChatEngineOptions {
  strategy?: InlineStrategy;
  symbolGraph?: SymbolGraph;
}

export class InlineChatEngine {
  private strategy: InlineStrategy;
  private symbolGraph?: SymbolGraph;

  constructor(options?: InlineChatEngineOptions) {
    this.strategy = options?.strategy ?? InlineStrategy.NEUTRAL;
    this.symbolGraph = options?.symbolGraph;
  }

  setStrategy(s: InlineStrategy): void {
    this.strategy = s;
  }

  /**
   * 处理 Inline Chat 请求
   * 1. 解析选中范围
   * 2. 计算编辑的 TC 置信状态
   * 3. 如果 symbolGraph 可用，传播 TC
   * 4. 返回完整的 InlineEditResult
   */
  async processInlineChat(ctx: InlineChatContext): Promise<InlineEditResult> {
    const range = resolveSelectionRange(ctx.fullFileContent, ctx.selectedText);

    // 这里集成 LLM 调用（实际项目中通过 session.ts 调 LLM）
    // 当前返回占位结构，供 TC 管道测试用
    const tcCell = computeInlineEditTC(
      ctx.selectedText.length,
      ctx.selectedText.length,   // 暂假设编辑前后等长，实际由 LLM 输出决定
      0.8,
      0.9,
    );

    // TC 传播到符号图（如果可用）
    if (this.symbolGraph) {
      const sources: TCPropagationSource[] = [{
        name: `inline-${path.basename(ctx.filePath)}:${range.startLine}`,
        file: ctx.filePath,
        tc: tcCell.tc,
        weight: tcCell.weight,
      }];
      // 注入到符号图的传播
      for (const src of sources) {
        // 查找文件名对应的符号
        const fileNodes = this.symbolGraph.getNodesForFile(ctx.filePath);
        for (const node of fileNodes) {
          this.symbolGraph.setTC(node.name, tcAdd(this.symbolGraph.getTC(node.name) ?? TC.NONE, src.tc));
        }
      }
    }

    return {
      editedCode: ctx.fullFileContent,
      range,
      tcCell,
      originalSnippet: ctx.selectedText,
      newSnippet: ctx.selectedText,
      rawResponse: "",
    };
  }

  /**
   * 根据策略和 TC 状态做接受/拒绝决策
   * 对应 C 层的 hex4_tc_resolve_with_strategy
   */
  shouldAccept(result: InlineEditResult): { accept: boolean; reason: string } {
    const { tc, weight } = result.tcCell;

    switch (this.strategy) {
      case InlineStrategy.CONSERVATIVE:
        // 仅接受 TC.NONE 或 TC.CARRY 且权重足够
        if (tc <= TC.CARRY && weight >= 0.7) {
          return { accept: true, reason: "Conservative: low TC, high weight" };
        }
        return { accept: false, reason: `Conservative rejected: TC=${tcName(tc)}, weight=${weight.toFixed(2)}` };

      case InlineStrategy.AGGRESSIVE:
        // 几乎全部接受
        if (tc <= TC.MIXED) {
          return { accept: true, reason: "Aggressive: accepting all non-blocking TC" };
        }
        return { accept: false, reason: `Aggressive rejected: TC=${tcName(tc)}` };

      case InlineStrategy.CONTEXT_AWARE: {
        // 如果存在符号图依赖链，降低阈值
        const threshold = weight >= 0.3 ? TC.MIXED : TC.CARRY;
        if (tc <= threshold) {
          return { accept: true, reason: `ContextAware: TC=${tcName(tc)} <= threshold=${tcName(threshold)}` };
        }
        return { accept: false, reason: `ContextAware rejected: TC=${tcName(tc)} > ${tcName(threshold)}` };
      }

      case InlineStrategy.NEUTRAL:
      default:
        if (tc <= TC.UNCERTAIN && weight >= 0.4) {
          return { accept: true, reason: "Neutral: TC <= UNCERTAIN, weight >= 0.4" };
        }
        return { accept: false, reason: `Neutral rejected: TC=${tcName(tc)}, weight=${weight.toFixed(2)}` };
    }
  }

  /**
   * 批量决策（对应 C 层 hex4_tc_resolve_batch）
   */
  batchDecide(results: InlineEditResult[]): Array<{ result: InlineEditResult; decision: ReturnType<InlineChatEngine["shouldAccept"]> }> {
    return results.map(r => ({ result: r, decision: this.shouldAccept(r) }));
  }
}

// 懒加载 path
import * as path from "path";
import { tcName } from "../tc/tc-types";
