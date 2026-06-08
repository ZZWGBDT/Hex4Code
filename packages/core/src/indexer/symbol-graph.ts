import { TC, TCCell } from "../tc/tc-types";
import { tcAdd } from "../tc/tc-semiring";
import { TCPropagationEngine } from "../tc/tc-propagate";
import { SymbolNode } from "./indexer-interface";

export class SymbolGraph {
  private nodes: Map<string, SymbolNode> = new Map();
  private dependents: Map<string, Set<string>> = new Map();
  private dependencies: Map<string, Set<string>> = new Map();
  private propagationEngine: TCPropagationEngine;

  constructor() {
    this.propagationEngine = new TCPropagationEngine();
  }

  addNode(node: SymbolNode): void {
    this.nodes.set(node.name, node);
    if (!this.dependents.has(node.name)) this.dependents.set(node.name, new Set());
    if (!this.dependencies.has(node.name)) this.dependencies.set(node.name, new Set());
  }

  getNode(name: string): SymbolNode | undefined {
    return this.nodes.get(name);
  }

  removeNode(name: string): void {
    this.nodes.delete(name);
    this.dependents.delete(name);
    this.dependencies.delete(name);
  }

  getAllNodeNames(): string[] {
    return Array.from(this.nodes.keys());
  }

  contains(name: string): boolean {
    return this.nodes.has(name);
  }

  addDependency(from: string, to: string): void {
    if (!this.dependencies.has(from)) this.dependencies.set(from, new Set());
    this.dependencies.get(from)!.add(to);
    if (!this.dependents.has(to)) this.dependents.set(to, new Set());
    this.dependents.get(to)!.add(from);
  }

  getDependencies(name: string): string[] {
    return Array.from(this.dependencies.get(name) ?? []);
  }

  getDependents(name: string): string[] {
    return Array.from(this.dependents.get(name) ?? []);
  }

  getEntangledPairs(): Array<[string, string]> {
    const pairs: Array<[string, string]> = [];
    for (const [name, deps] of this.dependencies) {
      for (const dep of deps) {
        if (this.dependencies.get(dep)?.has(name) && name < dep) {
          pairs.push([name, dep]);
        }
      }
    }
    return pairs;
  }

  isEntangled(a: string, b: string): boolean {
    return (
      this.dependencies.get(a)?.has(b) === true &&
      this.dependencies.get(b)?.has(a) === true
    );
  }

  getNodesForFile(filePath: string): SymbolNode[] {
    const results: SymbolNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.file === filePath) results.push(node);
    }
    return results;
  }

  removeFile(filePath: string): void {
    const toRemove: string[] = [];
    for (const [name, node] of this.nodes) {
      if (node.file === filePath) toRemove.push(name);
    }
    for (const name of toRemove) this.removeNode(name);
  }

  getTC(name: string): TC | undefined {
    return this.nodes.get(name)?.cell.tc;
  }

  setTC(name: string, tc: TC): void {
    const node = this.nodes.get(name);
    if (node) node.cell.tc = tc;
  }

  setWeight(name: string, w: number): void {
    const node = this.nodes.get(name);
    if (node) node.cell.weight = w;
  }

  propagateTC(iterations?: number): void {
    const allNames = this.getAllNodeNames();
    const sources = allNames
      .map(n => ({ name: n, tc: this.getTC(n) ?? TC.NONE }))
      .filter(s => s.tc !== TC.NONE)
      .map(s => ({
        name: s.name,
        file: this.getNode(s.name)?.file ?? "",
        tc: s.tc,
        weight: this.getNode(s.name)?.cell.weight ?? 1.0,
      }));

    if (sources.length === 0) return;

    this.propagationEngine.propagate(
      sources,
      (name: string) => this.getDependents(name),
      (name: string) => this.getTC(name),
      (name: string, tc: TC) => this.setTC(name, tc),
      (name: string, w: number) => this.setWeight(name, w),
      (a: string, b: string) => this.isEntangled(a, b),
      iterations,
    );
  }

  getImpactZone(name: string): string[] {
    return this.propagationEngine.computeImpactZone(name, (n) => this.getDependents(n));
  }

  getFileAverageTC(filePath: string): number {
    const nodes = this.getNodesForFile(filePath);
    if (nodes.length === 0) return 0;
    return nodes.reduce((s, n) => s + n.cell.tc, 0) / nodes.length;
  }

  toJSON(): Record<string, unknown> {
    return {
      nodeCount: this.nodes.size,
      entangledPairs: this.getEntangledPairs().length,
      nodes: Array.from(this.nodes.values()).map(n => ({
        name: n.name,
        kind: n.kind,
        file: n.file,
        tc: n.cell.tc,
        trit: n.cell.trit,
        weight: n.cell.weight,
        deps: n.dependencies,
      })),
    };
  }
}
