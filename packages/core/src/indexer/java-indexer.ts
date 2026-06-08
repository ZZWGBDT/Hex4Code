import { Trit, TC } from "../tc/tc-types";
import { LangIndexer, SymbolNode, IndexResult, SymbolKind } from "./indexer-interface";

export class JavaIndexer implements LangIndexer {
  readonly language = "java";
  readonly extensions = [".java"];

  private readonly TC_RULES: Array<{ test: RegExp; tc: TC; trit: Trit }> = [
    { test: /^void$/, tc: TC.NONE, trit: Trit.T0 },
    { test: /^(int|long|float|double|boolean|char|byte|short)$/, tc: TC.NONE, trit: Trit.T1 },
    { test: /^(Integer|Long|Float|Double|Boolean|String|Character)$/, tc: TC.NONE, trit: Trit.T1 },
    { test: /^(List|Set|Map|Collection|ArrayList|HashMap|Array|Map\.Entry)/, tc: TC.CARRY, trit: Trit.T2 },
    { test: /^Optional/, tc: TC.CARRY, trit: Trit.T1 },
    { test: /\?/, tc: TC.UNCERTAIN, trit: Trit.T2 },
    { test: /^(Object|Serializable|Comparable)$/, tc: TC.MIXED, trit: Trit.T2 },
    { test: /<[A-Z]>/, tc: TC.CARRY, trit: Trit.T2 },
  ];

  indexFile(source: string, filePath: string): IndexResult {
    const start = Date.now();
    try {
      const symbols = this.regexExtract(filePath, source);
      return { symbols, errors: [], durationMs: Date.now() - start };
    } catch (err) {
      return { symbols: [], errors: [err instanceof Error ? err.message : String(err)], durationMs: Date.now() - start };
    }
  }

  private regexExtract(filePath: string, source: string): SymbolNode[] {
    const symbols: SymbolNode[] = [];
    const classRE = /(?:public\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s<>,?]+)?\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = classRE.exec(source)) !== null) {
      const ln = source.substring(0, m.index).split("\n").length;
      symbols.push({
        name: m[1], kind: SymbolKind.CLASS, file: filePath,
        range: { startLine: ln, startCol: 0, endLine: ln, endCol: 0 },
        cell: { trit: Trit.T2, tc: TC.NONE, weight: 1.0 },
        language: "java", dependencies: [], isExported: true,
      });
    }
    const methodRE = /(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(\w+(?:<[\w,\s]+>)?)\s+(\w+)\s*\(([^)]*)\)\s*(?:\{|throws|;)/g;
    while ((m = methodRE.exec(source)) !== null) {
      const retType = m[1];
      const methodName = m[2];
      const ln = source.substring(0, m.index).split("\n").length;
      const tcData = this.resolveTC(retType);
      symbols.push({
        name: methodName, kind: SymbolKind.METHOD, file: filePath,
        range: { startLine: ln, startCol: 0, endLine: ln, endCol: 0 },
        cell: { trit: tcData.trit, tc: tcData.tc, weight: 1.0 },
        language: "java",
        dependencies: [],
        doc: undefined,
        isExported: source.substring(Math.max(0, m.index - 20), m.index).includes("public"),
      });
    }
    return symbols;
  }

  classifyTrit(typeAnnotation: string): Trit { return this.resolveTC(typeAnnotation).trit; }
  initialTC(typeAnnotation: string | null): TC { return this.resolveTC(typeAnnotation ?? "").tc; }

  private resolveTC(t: string): { trit: Trit; tc: TC } {
    for (const r of this.TC_RULES) { if (r.test.test(t)) return { trit: r.trit, tc: r.tc }; }
    return { trit: Trit.T1, tc: TC.CARRY };
  }
}
