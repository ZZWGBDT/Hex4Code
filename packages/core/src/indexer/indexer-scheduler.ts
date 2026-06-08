import * as path from "path";
import * as fs from "fs";
import { LangIndexer, IndexResult } from "./indexer-interface";
import { SymbolGraph } from "./symbol-graph";
import { PythonIndexer } from "./python-indexer";
import { JavaIndexer } from "./java-indexer";
import { GoIndexer } from "./go-indexer";
import { RustIndexer } from "./rust-indexer";
import { TSIndexer } from "./ts-indexer";

export class IndexerScheduler {
  private indexers: Map<string, LangIndexer> = new Map();
  private graph: SymbolGraph = new SymbolGraph();
  private indexing: boolean = false;

  constructor() {
    this.register(new PythonIndexer());
    this.register(new JavaIndexer());
    this.register(new GoIndexer());
    this.register(new RustIndexer());
    this.register(new TSIndexer());
  }

  register(indexer: LangIndexer): void {
    for (const ext of indexer.extensions) {
      this.indexers.set(ext, indexer);
    }
  }

  getIndexerForFile(filePath: string): LangIndexer | null {
    const ext = path.extname(filePath).toLowerCase();
    return this.indexers.get(ext) ?? null;
  }

  async indexFile(filePath: string): Promise<IndexResult> {
    const indexer = this.getIndexerForFile(filePath);
    if (!indexer) {
      return { symbols: [], errors: [`No indexer for: ${filePath}`], durationMs: 0 };
    }
    const source = fs.readFileSync(filePath, "utf-8");
    return indexer.indexFile(source, filePath);
  }

  async indexProject(projectRoot: string): Promise<SymbolGraph> {
    if (this.indexing) return this.graph;
    this.indexing = true;
    try {
      const files = this.discoverFiles(projectRoot);
      const batchSize = 50;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        const results = await Promise.allSettled(batch.map(f => this.indexFile(f)));
        for (const result of results) {
          if (result.status === "fulfilled") {
            for (const symbol of result.value.symbols) {
              this.graph.addNode(symbol);
            }
          }
        }
      }
      for (const nodeName of this.graph.getAllNodeNames()) {
        const node = this.graph.getNode(nodeName);
        if (!node) continue;
        for (const dep of node.dependencies) {
          if (this.graph.contains(dep)) {
            this.graph.addDependency(nodeName, dep);
          }
        }
      }
      this.graph.propagateTC(3);
      return this.graph;
    } finally {
      this.indexing = false;
    }
  }

  private discoverFiles(projectRoot: string): string[] {
    const files: string[] = [];
    const skipDirs = new Set([
      "node_modules", ".git", "dist", "build", "target", "out",
      "__pycache__", ".venv", "venv", ".tox", ".mypy_cache",
      ".next", "coverage", ".husky", ".idea", ".vscode",
    ]);
    const walkDir = (dir: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (!skipDirs.has(entry.name)) walkDir(path.join(dir, entry.name));
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (this.indexers.has(ext)) {
              files.push(path.join(dir, entry.name));
            }
          }
        }
      } catch { }
    };
    walkDir(projectRoot);
    return files;
  }

  getGraph(): SymbolGraph {
    return this.graph;
  }

  async reindexFile(filePath: string): Promise<void> {
    const newSymbolNames = new Set<string>();
    for (const node of this.graph.getNodesForFile(filePath)) {
      newSymbolNames.add(node.name);
    }
    this.graph.removeFile(filePath);
    const result = await this.indexFile(filePath);
    for (const symbol of result.symbols) {
      this.graph.addNode(symbol);
      newSymbolNames.add(symbol.name);
    }
    for (const symbol of result.symbols) {
      for (const dep of symbol.dependencies) {
        if (this.graph.contains(dep)) {
          this.graph.addDependency(symbol.name, dep);
        }
      }
    }
    for (const existingName of this.graph.getAllNodeNames()) {
      const existingNode = this.graph.getNode(existingName);
      if (!existingNode || existingNode.file === filePath) continue;
      for (const dep of existingNode.dependencies) {
        if (newSymbolNames.has(dep)) {
          this.graph.addDependency(existingName, dep);
        }
      }
    }
    this.graph.propagateTC(1);
  }
}
