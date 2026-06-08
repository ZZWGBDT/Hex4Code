/**
 * Rust code indexer — integrated with TC state classification
 *
 * Implementation approach (corresponding to the rule table in C-level tc_propagation_rules.h):
 *
 * Phase 1 (current implementation): lightweight regex-based extraction
 *   - fn / struct / enum / trait / impl / type / const / macro
 *   - Visibility detection (pub)
 *   - Dependency extraction (use statements -> resolve paths)
 *   - TC classification: Return type -> Trit/TC mapping
 *
 * Phase 2 (future): Full AST parsing based on the `syn` crate
 *   - Invoke a micro-parser via `cargo` (similar to GoIndexer's go run approach)
 *   - Full support for generics, lifetimes, macro expansion
 *
 * @see go-indexer.ts — 相同模式（编译临时解析器 → 执行）
 * @see python-indexer.ts — 相同模式（调用语言标准库 AST）
 */

import { Trit, TC } from "../tc/tc-types";
import {
  LangIndexer,
  SymbolNode,
  IndexResult,
  SymbolKind,
} from "./indexer-interface";

// ── Rust TC 分类规则（12条） ──────────────────────────────────────────

const RUST_TC_RULES: Array<{ test: RegExp; tc: TC; trit: Trit }> = [
  { test: /^$/, tc: TC.NONE, trit: Trit.T0 },
  { test: /^\(\)$/, tc: TC.NONE, trit: Trit.T0 },
  { test: /^(i32|i64|u32|u64|f32|f64|bool|char|usize|isize|i8|u8|i16|u16)$/i, tc: TC.NONE, trit: Trit.T1 },
  { test: /^(String|str|&str)$/i, tc: TC.NONE, trit: Trit.T1 },
  { test: /^Vec</i, tc: TC.CARRY, trit: Trit.T2 },
  { test: /^Box<dyn /i, tc: TC.MIXED, trit: Trit.T2 },
  { test: /^Box</i, tc: TC.CARRY, trit: Trit.T2 },
  { test: /^(HashMap|HashSet|BTreeMap|BTreeSet|Option|Result|Arc|Rc|Cell|RefCell)/i, tc: TC.CARRY, trit: Trit.T2 },
  { test: /^dyn /i, tc: TC.UNCERTAIN, trit: Trit.T2 },
  { test: /^impl /i, tc: TC.UNCERTAIN, trit: Trit.T2 },
  { test: /^&/, tc: TC.CARRY, trit: Trit.T1 },
  { test: /^\[/, tc: TC.CARRY, trit: Trit.T2 },
  { test: /^Pin</i, tc: TC.CARRY, trit: Trit.T2 },
  { test: /^Future/i, tc: TC.CARRY, trit: Trit.T2 },
];

export class RustIndexer implements LangIndexer {
  readonly language = "rust";
  readonly extensions = [".rs"];

  indexFile(source: string, filePath: string): IndexResult {
    const start = Date.now();

    try {
      // 阶段一：基于正则的内置解析（不依赖外部 Rust 编译器）
      const symbols = this.regexExtract(filePath, source);
      return { symbols, errors: [], durationMs: Date.now() - start };
    } catch (err) {
      return {
        symbols: [],
        errors: [err instanceof Error ? err.message : String(err)],
        durationMs: Date.now() - start,
      };
    }
  }

  classifyTrit(typeAnnotation: string): Trit {
    return this.resolveTC(typeAnnotation).trit;
  }

  initialTC(typeAnnotation: string | null): TC {
    return this.resolveTC(typeAnnotation ?? "").tc;
  }

  // ── 正则提取（阶段一） ──────────────────────────────────────────────

  private regexExtract(filePath: string, source: string): SymbolNode[] {
    const symbols: SymbolNode[] = [];
    const lines = source.split("\n");
    const fileDeps = this.extractDependencies(source);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // 1. 函数: [pub] fn name(...) [-> RetType]
      //    匹配模式: pub fn foo(...) -> Bar / fn foo(...)
      const fnMatch = trimmed.match(
        /^(pub(?:\s*\([^)]*\))?\s+)?(?:unsafe\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)\s*(->\s*([^{;]+))?/
      );
      if (fnMatch) {
        const isPub = !!fnMatch[1];
        const name = fnMatch[2];
        const retType = (fnMatch[5] || "").trim();
        const tcData = this.resolveTC(retType);

        // 查找函数体结束行
        let endLine = i;
        if (line.includes("{")) {
          let braceCount = 0;
          let inBrace = false;
          for (let j = i; j < lines.length; j++) {
            for (const ch of lines[j]) {
              if (ch === "{") { braceCount++; inBrace = true; }
              if (ch === "}") { braceCount--; }
            }
            if (inBrace && braceCount <= 0) {
              endLine = j;
              break;
            }
            if (j === lines.length - 1) endLine = j;
          }
        }

        symbols.push({
          name,
          kind: SymbolKind.FUNCTION,
          file: filePath,
          range: { startLine: i + 1, startCol: 0, endLine: endLine + 1, endCol: 0 },
          cell: { trit: tcData.trit, tc: tcData.tc, weight: 1.0 },
          language: "rust",
          dependencies: fileDeps,
          doc: this.extractDocComment(lines, i),
          isExported: isPub,
        });
        continue;
      }

      // 2. 结构体: [pub] struct Name
      const structMatch = trimmed.match(
        /^(pub(?:\s*\([^)]*\))?\s+)?struct\s+(\w+)/
      );
      if (structMatch) {
        symbols.push({
          name: structMatch[2],
          kind: SymbolKind.CLASS,
          file: filePath,
          range: { startLine: i + 1, startCol: 0, endLine: i + 1, endCol: 0 },
          cell: { trit: Trit.T1, tc: TC.NONE, weight: 1.0 },
          language: "rust",
          dependencies: fileDeps,
          isExported: !!structMatch[1],
        });
        continue;
      }

      // 3. 枚举: [pub] enum Name
      const enumMatch = trimmed.match(
        /^(pub(?:\s*\([^)]*\))?\s+)?enum\s+(\w+)/
      );
      if (enumMatch) {
        symbols.push({
          name: enumMatch[2],
          kind: SymbolKind.ENUM,
          file: filePath,
          range: { startLine: i + 1, startCol: 0, endLine: i + 1, endCol: 0 },
          cell: { trit: Trit.T1, tc: TC.NONE, weight: 1.0 },
          language: "rust",
          dependencies: fileDeps,
          isExported: !!enumMatch[1],
        });
        continue;
      }

      // 4. Trait: [pub] [unsafe] trait Name
      const traitMatch = trimmed.match(
        /^(pub(?:\s*\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+(\w+)/
      );
      if (traitMatch) {
        symbols.push({
          name: traitMatch[2],
          kind: SymbolKind.INTERFACE,
          file: filePath,
          range: { startLine: i + 1, startCol: 0, endLine: i + 1, endCol: 0 },
          cell: { trit: Trit.T1, tc: TC.CARRY, weight: 1.0 },
          language: "rust",
          dependencies: fileDeps,
          isExported: !!traitMatch[1],
        });
        continue;
      }

      // 5. 类型别名: [pub] type Name = Type
      const typeMatch = trimmed.match(
        /^(pub(?:\s*\([^)]*\))?\s+)?type\s+(\w+)/
      );
      if (typeMatch && trimmed.includes("=")) {
        symbols.push({
          name: typeMatch[2],
          kind: SymbolKind.TYPE,
          file: filePath,
          range: { startLine: i + 1, startCol: 0, endLine: i + 1, endCol: 0 },
          cell: { trit: Trit.T1, tc: TC.CARRY, weight: 1.0 },
          language: "rust",
          dependencies: fileDeps,
          isExported: !!typeMatch[1],
        });
        continue;
      }

      // 6. 常量: [pub] const NAME: Type
      const constMatch = trimmed.match(
        /^(pub(?:\s*\([^)]*\))?\s+)?const\s+(\w+)\s*:/
      );
      if (constMatch) {
        symbols.push({
          name: constMatch[2],
          kind: SymbolKind.CONST,
          file: filePath,
          range: { startLine: i + 1, startCol: 0, endLine: i + 1, endCol: 0 },
          cell: { trit: Trit.T0, tc: TC.NONE, weight: 1.0 },
          language: "rust",
          dependencies: fileDeps,
          isExported: !!constMatch[1],
        });
        continue;
      }

      // 7. 宏: macro_rules! name
      const macroMatch = trimmed.match(/^macro_rules!\s*(\w+)/);
      if (macroMatch) {
        symbols.push({
          name: macroMatch[1],
          kind: SymbolKind.MACRO,
          file: filePath,
          range: { startLine: i + 1, startCol: 0, endLine: i + 1, endCol: 0 },
          cell: { trit: Trit.T2, tc: TC.UNCERTAIN, weight: 1.0 },
          language: "rust",
          dependencies: fileDeps,
          isExported: true,
        });
        continue;
      }
    }

    return symbols;
  }

  // ── 依赖提取 ─────────────────────────────────────────────────────────

  private extractDependencies(source: string): string[] {
    const deps = new Set<string>();
    const useRegex = /^use\s+([^;]+);/gm;
    let match: RegExpExecArray | null;

    while ((match = useRegex.exec(source)) !== null) {
      const usePath = match[1].trim();
      // 取第一个路径段: std::collections::HashMap → std
      const firstSeg = usePath.split("::")[0];
      // 过滤自引用 (self, crate, super)
      if (firstSeg && !["self", "crate", "super"].includes(firstSeg)) {
        deps.add(firstSeg);
      }
    }

    return Array.from(deps);
  }

  // ── 文档注释提取 ─────────────────────────────────────────────────────

  private extractDocComment(lines: string[], fnLineIdx: number): string | undefined {
    const comments: string[] = [];
    for (let i = fnLineIdx - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      // 支持 /// 和 //! 和 /** */ 单行
      if (trimmed.startsWith("///")) {
        comments.unshift(trimmed.slice(3).trim());
      } else if (trimmed.startsWith("//!")) {
        comments.unshift(trimmed.slice(3).trim());
      } else if (trimmed.startsWith("/**") && trimmed.endsWith("*/")) {
        comments.unshift(trimmed.slice(3, -2).trim());
      } else if (trimmed === "" || trimmed.startsWith("//")) {
        continue;
      } else {
        break;
      }
    }
    return comments.length > 0 ? comments.join(" ") : undefined;
  }

  // ── TC 类型解析（对应 C 层 tc_propagation_rules.c:resolveTC） ──────

  private resolveTC(t: string): { trit: Trit; tc: TC } {
    for (const rule of RUST_TC_RULES) {
      if (rule.test.test(t)) return { trit: rule.trit, tc: rule.tc };
    }
    // 默认：引用类型 → CARRY
    return { trit: Trit.T1, tc: TC.CARRY };
  }
}
