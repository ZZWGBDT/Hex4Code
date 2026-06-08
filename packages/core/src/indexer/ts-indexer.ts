import { Trit, TC } from "../tc/tc-types";
import { LangIndexer, SymbolNode, IndexResult, SymbolKind } from "./indexer-interface";

export class TSIndexer implements LangIndexer {
  readonly language = "typescript";
  readonly extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

  private readonly TC_RULES: Array<{ test: (t: string) => boolean; trit: Trit; tc: TC }> = [
    { test: (t) => /^(void|undefined|null)$/.test(t), trit: Trit.T0, tc: TC.NONE },
    { test: (t) => /^(string|number|boolean|symbol|bigint)$/.test(t), trit: Trit.T1, tc: TC.NONE },
    { test: (t) => /^(string|number|boolean)\[\]$/.test(t), trit: Trit.T2, tc: TC.CARRY },
    { test: (t) => /^(Array|Record|Map|Set|Promise|ReadonlyArray)</.test(t), trit: Trit.T2, tc: TC.CARRY },
    { test: (t) => /^(Partial|Required|Pick|Omit|Readonly)</.test(t), trit: Trit.T2, tc: TC.CARRY },
    { test: (t) => /\|/.test(t) && !/^\|/.test(t), trit: Trit.T2, tc: TC.UNCERTAIN },
    { test: (t) => /^unknown$/.test(t), trit: Trit.T2, tc: TC.UNCERTAIN },
    { test: (t) => /^any$/.test(t), trit: Trit.T2, tc: TC.MIXED },
  ];

  indexFile(source: string, filePath: string): IndexResult {
    const start = Date.now();
    try {
      const ts = require("typescript");
      const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
      const symbols: SymbolNode[] = [];
      this.walk(sf, sf, filePath, symbols, ts);
      return { symbols, errors: [], durationMs: Date.now() - start };
    } catch (err) {
      return { symbols: [], errors: [err instanceof Error ? err.message : String(err)], durationMs: Date.now() - start };
    }
  }

  private walk(node: any, sf: any, fp: string, syms: SymbolNode[], ts: any): void {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      const name = node.name?.text ?? "anon";
      const retType = node.type ? node.type.getText(sf) : null;
      const tcData = this.resolveTC(retType);
      const deps: string[] = [];
      ts.forEachChild(node, (c: any) => {
        if (ts.isCallExpression(c) && ts.isIdentifier(c.expression)) deps.push(c.expression.text);
      });
      syms.push({
        name, kind: SymbolKind.FUNCTION, file: fp,
        range: {
          startLine: sf.getLineAndCharacterOfPosition(node.pos).line + 1,
          startCol: sf.getLineAndCharacterOfPosition(node.pos).character,
          endLine: sf.getLineAndCharacterOfPosition(node.end).line + 1,
          endCol: sf.getLineAndCharacterOfPosition(node.end).character,
        },
        cell: { trit: tcData.trit, tc: tcData.tc, weight: 1.0 },
        language: "typescript", dependencies: deps,
        doc: node.jsDoc?.find((d: any) => d.comment)?.comment ?? undefined,
        isExported: node.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false,
      });
    }
    if (ts.isClassDeclaration(node) && node.name) {
      ts.forEachChild(node, (c: any) => this.walk(c, sf, fp, syms, ts));
    }
    ts.forEachChild(node, (c: any) => this.walk(c, sf, fp, syms, ts));
  }

  classifyTrit(typeAnnotation: string): Trit { return this.resolveTC(typeAnnotation).trit; }
  initialTC(typeAnnotation: string | null): TC { return this.resolveTC(typeAnnotation ?? "").tc; }

  private resolveTC(t: string | null): { trit: Trit; tc: TC } {
    if (!t) return { trit: Trit.T1, tc: TC.MIXED };
    for (const r of this.TC_RULES) { if (r.test(t)) return { trit: r.trit, tc: r.tc }; }
    return { trit: Trit.T1, tc: TC.NONE };
  }
}
