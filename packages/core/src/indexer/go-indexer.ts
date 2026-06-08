import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Trit, TC } from "../tc/tc-types";
import { LangIndexer, SymbolNode, IndexResult, SymbolKind } from "./indexer-interface";

const GO_AST_SRC = `
package main
import ("encoding/json";"go/ast";"go/parser";"go/token";"os";"fmt")
type S struct{ N string \`json:"n"\`; K string \`json:"k"\`; L int \`json:"l"\`; EL int \`json:"el"\`; T string \`json:"t"\`; D []string \`json:"d"\`; X bool \`json:"x"\` }
func main() {
  fset := token.NewFileSet()
  f, err := parser.ParseFile(fset, os.Args[1], nil, parser.ParseComments)
  if err != nil { fmt.Fprintf(os.Stderr, "%v", err); os.Exit(1) }
  var syms []S
  for _, d := range f.Decls {
    switch dcl := d.(type) {
    case *ast.FuncDecl:
      s := S{N: dcl.Name.Name, K: "F", L: fset.Position(dcl.Pos()).Line, EL: fset.Position(dcl.End()).Line, X: dcl.Name.IsExported()}
      if dcl.Type.Results != nil && len(dcl.Type.Results.List) > 0 { s.T = fmt.Sprintf("%s", dcl.Type.Results.List[0].Type) }
      ast.Inspect(dcl, func(n ast.Node) bool { if c, ok := n.(*ast.CallExpr); ok { if id, ok := c.Fun.(*ast.Ident); ok { s.D = append(s.D, id.Name) } }; return true })
      syms = append(syms, s)
    case *ast.GenDecl:
      for _, sp := range dcl.Specs {
        if ts, ok := sp.(*ast.TypeSpec); ok {
          s := S{N: ts.Name.Name, K: "T", L: fset.Position(ts.Pos()).Line, EL: fset.Position(ts.End()).Line, T: fmt.Sprintf("%s", ts.Type), X: ts.Name.IsExported()}
          syms = append(syms, s)
        }
      }
    }
  }
  json.NewEncoder(os.Stdout).Encode(syms)
}
`;

export class GoIndexer implements LangIndexer {
  readonly language = "go";
  readonly extensions = [".go"];
  private toolTempDir: string = "";

  private readonly TC_RULES: Array<{ test: RegExp; tc: TC; trit: Trit }> = [
    { test: /^$/, tc: TC.NONE, trit: Trit.T0 },
    { test: /^(int|int64|float64|string|bool|byte|rune|uint64|uint32|float32)$/, tc: TC.NONE, trit: Trit.T1 },
    { test: /^\[\]/, tc: TC.CARRY, trit: Trit.T2 },
    { test: /^map\[/, tc: TC.CARRY, trit: Trit.T2 },
    { test: /^chan/, tc: TC.CARRY, trit: Trit.T2 },
    { test: /^(interface\{\}|any)$/, tc: TC.MIXED, trit: Trit.T2 },
    { test: /^func\(/, tc: TC.CARRY, trit: Trit.T2 },
    { test: /error$/, tc: TC.CARRY, trit: Trit.T1 },
  ];

  indexFile(source: string, filePath: string): IndexResult {
    const start = Date.now();
    try {
      if (!this.toolTempDir) this.toolTempDir = this.buildTool();
      const out = execSync(`go run "${this.toolTempDir}" "${filePath}"`, {
        encoding: "utf-8", timeout: 10000, maxBuffer: 10 * 1024 * 1024,
      });
      const raw = JSON.parse(out.trim());
      const arr = Array.isArray(raw) ? raw : [raw];
      const symbols: SymbolNode[] = arr.map((rs: any) => {
        const tcData = this.resolveTC(rs.t || "");
        return {
          name: rs.n, kind: rs.k === "T" ? SymbolKind.TYPE : SymbolKind.FUNCTION,
          file: filePath,
          range: { startLine: rs.l, startCol: 0, endLine: rs.el ?? rs.l, endCol: 0 },
          cell: { trit: tcData.trit, tc: tcData.tc, weight: 1.0 },
          language: "go", dependencies: rs.d ?? [], doc: undefined,
          isExported: rs.x ?? false,
        };
      });
      return { symbols, errors: [], durationMs: Date.now() - start };
    } catch (err) {
      return { symbols: [], errors: [err instanceof Error ? err.message : String(err)], durationMs: Date.now() - start };
    }
  }

  classifyTrit(typeAnnotation: string): Trit { return this.resolveTC(typeAnnotation).trit; }
  initialTC(typeAnnotation: string | null): TC { return this.resolveTC(typeAnnotation ?? "").tc; }

  private resolveTC(t: string): { trit: Trit; tc: TC } {
    for (const r of this.TC_RULES) { if (r.test.test(t)) return { trit: r.trit, tc: r.tc }; }
    return { trit: Trit.T1, tc: TC.CARRY };
  }

  private buildTool(): string {
    const tmp = fs.mkdtempSync("go-ast-");
    fs.writeFileSync(path.join(tmp, "main.go"), GO_AST_SRC);
    return tmp;
  }
}
