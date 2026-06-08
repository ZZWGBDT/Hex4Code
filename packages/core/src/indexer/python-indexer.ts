import { execSync } from "child_process";
import { Trit, TC } from "../tc/tc-types";
import { LangIndexer, SymbolNode, IndexResult, SymbolKind } from "./indexer-interface";

const PYTHON_AST_SCRIPT = `
import ast, json, sys
def parse(path):
    with open(path) as f:
        tree = ast.parse(f.read())
    syms = []
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            deps = []
            ret = None
            for c in ast.walk(n):
                if isinstance(c, ast.Call) and hasattr(c.func, 'id'):
                    deps.append(c.func.id)
                if isinstance(c, ast.Return) and c.value:
                    if isinstance(c.value, ast.Constant):
                        ret = type(c.value.value).__name__ if c.value.value is not None else 'None'
                    elif isinstance(c.value, ast.List):
                        ret = 'list'
                    elif isinstance(c.value, ast.Dict):
                        ret = 'dict'
                    elif isinstance(c.value, ast.Set):
                        ret = 'set'
                    elif isinstance(c.value, ast.Tuple):
                        ret = 'tuple'
                    elif isinstance(c.value, ast.Name):
                        ret = c.value.id
                    elif isinstance(c.value, ast.Call):
                        ret = c.value.func.id if hasattr(c.value.func, 'id') else ''
                    else:
                        ret = type(c.value).__name__
            syms.append({"k":"F","n":n.name,"l":n.lineno,"el":n.end_lineno,"t":ret or "","d":list(set(deps)),"doc":ast.get_docstring(n)})
        elif isinstance(n, ast.ClassDef):
            syms.append({"k":"C","n":n.name,"l":n.lineno,"el":n.end_lineno,"m":[x.name for x in n.body if isinstance(x,(ast.FunctionDef,ast.AsyncFunctionDef))],"doc":ast.get_docstring(n)})
    print(json.dumps(syms))
`;

export class PythonIndexer implements LangIndexer {
  readonly language = "python";
  readonly extensions = [".py", ".pyi"];

  private readonly TC_MAP: Array<{ test: RegExp; tc: TC; trit: Trit }> = [
    { test: /^(None|void)$/i, tc: TC.NONE, trit: Trit.T0 },
    { test: /^(int|str|float|bool|bytes)$/i, tc: TC.NONE, trit: Trit.T1 },
    { test: /^(list|dict|set|tuple|Literal)/i, tc: TC.CARRY, trit: Trit.T2 },
    { test: /Optional/i, tc: TC.CARRY, trit: Trit.T1 },
    { test: /Union/i, tc: TC.UNCERTAIN, trit: Trit.T2 },
    { test: /^(Any|object|unknown)$/i, tc: TC.MIXED, trit: Trit.T2 },
    { test: /^$/, tc: TC.MIXED, trit: Trit.T2 },
  ];

  indexFile(source: string, filePath: string): IndexResult {
    const start = Date.now();
    try {
      const out = execSync(`python3 -c ${JSON.stringify(PYTHON_AST_SCRIPT)} ${JSON.stringify(filePath)}`, {
        encoding: "utf-8", timeout: 5000, maxBuffer: 10 * 1024 * 1024,
      });
      const raw = JSON.parse(out.trim());
      const symbols: SymbolNode[] = (Array.isArray(raw) ? raw : []).map((rs: any) => {
        const tcData = this.resolveTC(rs.t || "");
        return {
          name: rs.n,
          kind: rs.k === "C" ? SymbolKind.CLASS : SymbolKind.FUNCTION,
          file: filePath,
          range: { startLine: rs.l, startCol: 0, endLine: rs.el ?? rs.l, endCol: 0 },
          cell: { trit: tcData.trit, tc: tcData.tc, weight: 1.0 },
          language: "python",
          dependencies: rs.d ?? [],
          doc: rs.doc || undefined,
          isExported: !rs.n.startsWith("_"),
          children: rs.m,
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
    for (const r of this.TC_MAP) { if (r.test.test(t)) return { trit: r.trit, tc: r.tc }; }
    return { trit: Trit.T1, tc: TC.CARRY };
  }
}
