/**
 * @file l1-pattern-trie.ts
 * @brief L1 pattern matching — trie tree data structure
 *
 * Prefix matching based on Trie tree, with O(k) time complexity (k = number of typed characters).
 * Replaces the original hardcoded Record<string, string[]> linear scan.
 *
 * Hex4 映射:
 *   L1 = 核心层的 DualTrit 编码 (快速、确定、本地)
 *   每个模式携带 TC 标签 = 硬件 TC 标记
 */

import type { PatternMatch, CompletionSource } from "./types";
import type { TCType } from "../tools/executor";

/** Trie 树节点 */
class TrieNode {
  /** 子节点映射 */
  children = new Map<string, TrieNode>();
  /** 以此节点结尾的补全模式 */
  patterns: PatternMatch[] = [];
  /** 是否有模式在此节点结束 */
  isEnd = false;
}

/** 模式 Trie 树 — 支持前缀搜索 */
export class PatternTrie {
  private root = new TrieNode();

  /**
   * 插入一个补全模式。
   * @param prefix 触发前缀（用户键入的前缀字符串）
   * @param suffix 要追加的文本（不含前缀）
   * @param tc TC 置信度
   * @param source 来源
   * @param priority 优先级 (0=最高)
   */
  insert(
    prefix: string,
    suffix: string,
    tc: TCType = "TC_NONE",
    source: CompletionSource = "L1-pattern",
    priority = 0,
    description?: string,
    languages?: string[],
  ): void {
    let node = this.root;
    for (const ch of prefix) {
      if (!node.children.has(ch)) {
        node.children.set(ch, new TrieNode());
      }
      node = node.children.get(ch)!;
    }
    node.isEnd = true;
    node.patterns.push({
      suffix,
      fullText: prefix + suffix,
      tc,
      source,
      priority,
      description,
      languages,
    });
    // 按优先级排序（高优先级在前）
    node.patterns.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 批量插入模式。
   */
  insertBatch(patterns: Record<string, string[]>, tc: TCType = "TC_NONE", source: CompletionSource = "L1-pattern", priority = 0): void {
    for (const [prefix, suffixes] of Object.entries(patterns)) {
      for (const suffix of suffixes) {
        this.insert(prefix, suffix, tc, source, priority);
      }
    }
  }

  /**
   * 搜索给定前缀的所有匹配项。
   * @param text 光标前文本
   * @param language 当前语言（用于语言过滤）
   * @returns 匹配的模式列表
   */
  search(text: string, language?: string): PatternMatch[] {
    if (!text) return [];

    const results: PatternMatch[] = [];

    // 从每个可能的位置开始尝试匹配
    const searchStarts = this.getSearchStartPositions(text);

    for (const startPos of searchStarts) {
      const searchText = text.substring(startPos);
      let node = this.root;

      for (let i = 0; i < searchText.length; i++) {
        const ch = searchText[i];
        if (!node.children.has(ch)) break;

        node = node.children.get(ch)!;

        // 收集所有以当前路径为前缀的模式
        if (node.isEnd) {
          for (const pattern of node.patterns) {
            // 语言过滤
            if (language && pattern.languages && pattern.languages.length > 0) {
              if (!pattern.languages.includes(language)) continue;
            }
            results.push(pattern);
          }
        }
      }
    }

    // 排序：高优先级优先 -> TC_NONE 优先 -> 较短匹配优先
    return results.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const tcOrder: Record<TCType, number> = { TC_NONE: 0, TC_CARRY: 1, TC_UNCERTAIN: 2, TC_MIXED: 3 };
      const tcDiff = (tcOrder[a.tc] ?? 0) - (tcOrder[b.tc] ?? 0);
      if (tcDiff !== 0) return tcDiff;
      return a.suffix.length - b.suffix.length;
    });
  }

  /**
   * 确定从哪些位置开始搜索。
   * 从最后一个单词边界开始，以提高匹配精度。
   * 使用逐字符扫描避免正则中的转义问题。
   */
  private getSearchStartPositions(text: string): number[] {
    const positions: number[] = [0];

    // 从最后一个分隔符（空格/标点）后开始匹配
    const delimiters = new Set([
      " ", "\t", "(", ",", ";", "[", "{", "=", "<", ">",
      "+", "-", "*", "/", "&", "|", "!", "~", ":", "\n", "\r",
    ]);
    for (let i = text.length - 1; i >= 0; i--) {
      if (delimiters.has(text[i])) {
        if (i + 1 < text.length) {
          positions.push(i + 1);
        }
        break;
      }
    }

    // 从最后一个 "." 后开始（属性/方法访问）
    const dotIndex = text.lastIndexOf(".");
    if (dotIndex > 0 && dotIndex < text.length - 1) {
      positions.push(dotIndex + 1);
    }

    // 从最后一个 ">" 后开始（箭头函数/模板）
    const arrowIndex = text.lastIndexOf(">");
    if (arrowIndex > 0 && arrowIndex < text.length - 1) {
      positions.push(arrowIndex + 1);
    }

    return [...new Set(positions)].sort((a, b) => a - b);
  }

  /**
   * 从 Record<string, string[]> 加载批量模式。
   */
  loadFromRecord(patterns: Record<string, string[]>, tc: TCType = "TC_NONE", source: CompletionSource = "L1-pattern", priority = 0): void {
    this.insertBatch(patterns, tc, source, priority);
  }

  /**
   * 清空 Trie 树。
   */
  clear(): void {
    this.root = new TrieNode();
  }

  /** 获取已注册的模式数量（统计用） */
  getPatternCount(): number {
    let count = 0;
    const traverse = (node: TrieNode): void => {
      if (node.isEnd) count += node.patterns.length;
      for (const child of node.children.values()) {
        traverse(child);
      }
    };
    traverse(this.root);
    return count;
  }
}
