/**
 * @file l2-fim-context.ts
 * @brief FIM context builder — assembles three-layer context for model inference
 *
 * Integrates nearby code, current scope info, and RAG retrieval results into
 * Structured FimContext, used by FIM Prompt templates.
 *
 * Hex4 映射:
 *   近上下文 ↔ 紧邻寄存器的数据通路
 *   中上下文 ↔ 当前指令块的作用域
 *   远上下文 ↔ 全局符号表 + 知识库
 */

import type { FimContext, FimScope, RelevantSymbol, KnowledgeEntry, ErrorPatternInfo } from "./types";

/** 上下文构建选项 */
export interface FimContextOptions {
  /** 近上下文的行数 */
  nearLinesBefore?: number;
  nearLinesAfter?: number;
  /** 最大 Token 预算 */
  maxTokens?: number;
  /** 语言 */
  language: string;
}

const DEFAULT_OPTIONS: Required<FimContextOptions> = {
  nearLinesBefore: 15,
  nearLinesAfter: 5,
  maxTokens: 2048,
  language: "plaintext",
};

/** FIM 上下文构建器 */
export class FimContextBuilder {
  private options: Required<FimContextOptions>;

  constructor(options?: Partial<FimContextOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 从编辑器信息构建完整的 FIM 上下文。
   *
   * @param textBefore 光标前文本
   * @param textAfter 光标后文本
   * @param language 语言 ID
   * @param fullText 完整文件内容（用于解析作用域）
   * @param fileName 文件名（用于 RAG 检索）
   */
  async build(
    textBefore: string,
    textAfter: string,
    language: string,
    fullText?: string,
    _fileName?: string,
  ): Promise<FimContext> {
    const ctx: FimContext = {
      prefix: textBefore,
      suffix: textAfter,
      language,
    };

    // 1. 构建近上下文（当前行 + 附近行）
    const nearCtx = this.buildNearContext(textBefore, textAfter);
    ctx.prefix = nearCtx.prefix;
    ctx.suffix = nearCtx.suffix;

    // 2. 解析当前作用域
    if (fullText) {
      ctx.scope = this.parseScope(fullText, textBefore, language);
    }

    // 3. RAG 检索相关符号（异步，不阻塞补全主流程）
    //    由调用方在适当时机注入
    ctx.relevantSymbols = [];
    ctx.knowledgeEntries = [];
    ctx.errorPatterns = [];

    return ctx;
  }

  /**
   * 构建近上下文：提取光标前后一定行数的代码。
   */
  private buildNearContext(textBefore: string, textAfter: string): { prefix: string; suffix: string } {
    // 截取光标前 N 行
    const beforeLines = textBefore.split("\n");
    const prefixLines = beforeLines.slice(-this.options.nearLinesBefore);

    // 截取光标后 N 行
    const afterLines = textAfter.split("\n");
    const suffixLines = afterLines.slice(0, this.options.nearLinesAfter);

    return {
      prefix: prefixLines.join("\n"),
      suffix: suffixLines.join("\n"),
    };
  }

  /**
   * 从文件内容解析当前光标所在的作用域。
   * 支持函数/方法/类的简单正则解析。
   */
  private parseScope(fullText: string, textBefore: string, _language: string): FimScope | undefined {
    const scope: FimScope = {};

    // 计算光标在全文中的位置
    const cursorLine = textBefore.split("\n").length;

    // 简化的作用域解析：从光标位置向前搜索最近的函数/类定义
    const lines = fullText.split("\n");
    const searchStart = Math.max(0, cursorLine - 100); // 向上搜索 100 行

    for (let i = cursorLine - 2; i >= searchStart; i--) {
      const line = lines[i]?.trim() || "";

      // 匹配类定义
      const classMatch = line.match(
        /(?:class|struct|interface|trait|type)\s+(\w+)(?:\s*<[^>]*>)?(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?[\s{]/,
      );
      if (classMatch) {
        scope.className = classMatch[1];
        continue;
      }

      // 匹配函数/方法定义
      const funcMatch = line.match(
        /(?:public|private|protected|static|async|function|def|fun|func|fn|sub)\s+(\w+)\s*\(([^)]*)\)/,
      );
      if (funcMatch) {
        scope.functionName = funcMatch[1];
        scope.parameters = funcMatch[2]
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => {
            // 提取参数名（去掉类型标注）
            const parts = p.split(/\s+/);
            const name = parts[parts.length - 1]?.replace(/[=:].*$/, "").trim() || p;
            // 处理默认值
            return name.split("=")[0]?.trim() || name;
          });
        // 匹配返回类型
        const retMatch = line.match(/\)\s*:\s*(\w+[\w<>[\]]*)/);
        if (retMatch) {
          scope.returnType = retMatch[1];
        }
        // 找到函数定义后停止（不继续向上搜索）
        break;
      }
    }

    // 从光标前提取局部变量
    scope.locals = this.extractLocals(lines, cursorLine);

    return Object.keys(scope).length > 0 ? scope : undefined;
  }

  /**
   * 从附近行提取局部变量。
   */
  private extractLocals(lines: string[], cursorLine: number): string[] {
    const locals: string[] = [];
    const searchStart = Math.max(0, cursorLine - 20);

    for (let i = searchStart; i < cursorLine - 1; i++) {
      const line = lines[i] || "";

      // JS/TS/Python: let/const/var/def 声明的变量
      const jsMatch = line.match(/\b(?:let|const|var)\s+(\w+)\s*[=;]/);
      if (jsMatch) locals.push(jsMatch[1]);

      const pyMatch = line.match(/(\w+)\s*=\s*.+/);
      if (pyMatch && !line.trim().startsWith("class") && !line.trim().startsWith("def")) {
        locals.push(pyMatch[1]);
      }

      // C/C++/Java/Go: 类型声明
      const cMatch = line.match(/\b(?:int|float|double|char|bool|string|void|auto|var|let)\s+(\w+)\s*[=;]/);
      if (cMatch) locals.push(cMatch[1]);
    }

    return [...new Set(locals)];
  }

  /**
   * 提取光标前最后一个标识符（用于 RAG 检索的查询）。
   */
  static extractQuery(textBefore: string): string {
    // 提取最后一个单词/标识符
    const match = textBefore.match(/(\w[\w\d_]*)$/);
    if (!match) return "";

    const word = match[1];

    // 如果是 HEX4 专有标识符，直接作为查询
    if (/^(hex4_|TC_|Hex4|ternary_|sm2_|tc_)/.test(word)) {
      return word;
    }

    // 否则提取最后一个有意义的词
    return word;
  }

  /**
   * 将 RAG 检索结果注入 FIM 上下文。
   */
  injectRagResults(
    ctx: FimContext,
    symbols: RelevantSymbol[],
    knowledge: KnowledgeEntry[],
    errorPatterns: ErrorPatternInfo[],
  ): FimContext {
    return {
      ...ctx,
      relevantSymbols: symbols,
      knowledgeEntries: knowledge,
      errorPatterns,
    };
  }
}
