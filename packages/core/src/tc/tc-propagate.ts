import { TC } from "./tc-types";
import { tcAdd, tcMul } from "./tc-semiring";

export interface PropagationConfig {
  maxIterations: number;
  wavefrontDecay: number;
  enableBidirectional: boolean;
  timeThreshold: number;
}

export const DEFAULT_PROPAGATION_CONFIG: PropagationConfig = {
  maxIterations: 3,
  wavefrontDecay: 0.7,
  enableBidirectional: true,
  timeThreshold: 5000,
};

export interface TCPropagationSource {
  name: string;
  file: string;
  tc: TC;
  weight: number;
}

export interface TCPropagationResult {
  affected: number;
  maxTC: TC;
  avgTC: number;
  details: Array<{ name: string; fromTC: TC; toTC: TC }>;
}

export class TCPropagationEngine {
  private config: PropagationConfig;

  constructor(config?: Partial<PropagationConfig>) {
    this.config = { ...DEFAULT_PROPAGATION_CONFIG, ...config };
  }

  propagate(
    sources: TCPropagationSource[],
    getDependents: (name: string) => string[],
    getNodeTC: (name: string) => TC | undefined,
    setNodeTC: (name: string, tc: TC) => void,
    setNodeWeight: (name: string, w: number) => void,
    isEntangled: (a: string, b: string) => boolean,
    iterations?: number,
  ): TCPropagationResult {
    const maxIter = iterations ?? this.config.maxIterations;
    const details: Array<{ name: string; fromTC: TC; toTC: TC }> = [];
    const affectedSet = new Set<string>();

    for (const src of sources) {
      affectedSet.add(src.name);
    }

    for (let iter = 0; iter < maxIter; iter++) {
      let changed = false;
      const wave = Array.from(affectedSet);

      for (const srcName of wave) {
        const srcTC = getNodeTC(srcName);
        if (!srcTC) continue;

        const deps = getDependents(srcName);
        for (const depName of deps) {
          const depTC = getNodeTC(depName);
          if (depTC === undefined) continue;

          const fromTC = depTC;
          const propagatedTC = tcMul(srcTC, srcTC);
          const newTC = tcAdd(depTC, propagatedTC);
          if (newTC !== fromTC) {
            setNodeTC(depName, newTC);
            setNodeWeight(depName, 0.8);
            affectedSet.add(depName);
            details.push({ name: depName, fromTC, toTC: newTC });
            changed = true;
          }
        }
      }

      if (this.config.enableBidirectional) {
        for (const a of affectedSet) {
          for (const b of affectedSet) {
            if (a < b && isEntangled(a, b)) {
              const tcA = getNodeTC(a);
              const tcB = getNodeTC(b);
              if (tcA !== undefined && tcB !== undefined) {
                const maxTC = tcAdd(tcA, tcB);
                setNodeTC(a, maxTC);
                setNodeTC(b, maxTC);
              }
            }
          }
        }
      }

      if (!changed) break;
    }

    const allTCs = Array.from(affectedSet)
      .map(n => getNodeTC(n))
      .filter((t): t is TC => t !== undefined);

    return {
      affected: affectedSet.size,
      maxTC: allTCs.length > 0 ? allTCs.reduce((a, b) => tcAdd(a, b), TC.NONE) : TC.NONE,
      avgTC: allTCs.length > 0 ? allTCs.reduce((s, t) => s + t, 0) / allTCs.length : 0,
      details,
    };
  }

  computeImpactZone(
    sourceName: string,
    getDependents: (name: string) => string[],
  ): string[] {
    const visited = new Set<string>();
    const queue = [sourceName];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const deps = getDependents(current);
      for (const d of deps) {
        if (!visited.has(d)) queue.push(d);
      }
    }
    return Array.from(visited);
  }
}
