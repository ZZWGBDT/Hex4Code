import { TC, TCCell, Mode, Trit, makeCell, cellIsDeterministic, TC_ORDER } from "./tc-types";
import { tcAdd } from "./tc-semiring";

export interface TCStateConfig {
  maxCells: number;
  tcPropagateRate: number;
  timingAgnostic: boolean;
  enableStats: boolean;
}

export const DEFAULT_TC_CONFIG: TCStateConfig = {
  maxCells: 64,
  tcPropagateRate: 0.7,
  timingAgnostic: true,
  enableStats: true,
};

export interface TCStats {
  totalOps: number;
  classicalOps: number;
  quantumOps: number;
  tcPropagations: number;
  modeCrossings: number;
  avgTcLevel: number;
}

export class TCState {
  cells: TCCell[];
  config: TCStateConfig;
  stats: TCStats;
  mode: Mode;
  private entanglement: boolean[][];
  private phase: number[];

  constructor(n: number, config?: Partial<TCStateConfig>) {
    this.config = { ...DEFAULT_TC_CONFIG, ...config };
    this.cells = new Array(n).fill(null).map(() => makeCell(Trit.T0, TC.NONE, 1.0));
    this.entanglement = Array.from({ length: n }, () => new Array(n).fill(false));
    this.phase = new Array(n).fill(0);
    this.stats = { totalOps: 0, classicalOps: 0, quantumOps: 0, tcPropagations: 0, modeCrossings: 0, avgTcLevel: 0 };
    this.mode = Mode.CLASSICAL;
  }

  get numCells(): number { return this.cells.length; }

  getTrit(i: number): Trit { return this.cells[i].trit; }
  getTC(i: number): TC { return this.cells[i].tc; }
  getWeight(i: number): number { return this.cells[i].weight; }

  setCell(i: number, t: Trit, tc: TC, w: number): void {
    if (i < 0 || i >= this.numCells) return;
    this.cells[i] = makeCell(t, tc, w);
    this.updateMode();
  }

  setTrit(i: number, t: Trit): void {
    if (i < 0 || i >= this.numCells) return;
    this.cells[i].trit = t;
  }
  setTC(i: number, tc: TC): void {
    if (i < 0 || i >= this.numCells) return;
    this.cells[i].tc = tc; this.updateMode();
  }
  setWeight(i: number, w: number): void {
    if (i < 0 || i >= this.numCells) return;
    this.cells[i].weight = w;
  }

  private detectMode(): Mode {
    let hasClassical = false;
    let hasQuantum = false;
    for (const c of this.cells) {
      if (cellIsDeterministic(c)) hasClassical = true;
      else hasQuantum = true;
    }
    if (hasClassical && hasQuantum) return Mode.HYBRID;
    if (hasQuantum) return Mode.QUANTUM;
    return Mode.CLASSICAL;
  }

  private updateMode(): void {
    const prev = this.mode;
    this.mode = this.detectMode();
    if (prev !== this.mode) this.stats.modeCrossings++;
  }

  countQuantumCells(): number {
    return this.cells.filter(c => !cellIsDeterministic(c)).length;
  }

  entangle(i: number, j: number): void {
    if (i === j || i < 0 || j < 0 || i >= this.numCells || j >= this.numCells) return;
    this.entanglement[i][j] = true;
    this.entanglement[j][i] = true;
    const maxTC = tcAdd(this.cells[i].tc, this.cells[j].tc);
    this.cells[i].tc = maxTC;
    this.cells[j].tc = maxTC;
  }

  disentangle(i: number, j: number): void {
    if (i < 0 || j < 0 || i >= this.numCells || j >= this.numCells) return;
    this.entanglement[i][j] = false;
    this.entanglement[j][i] = false;
  }

  isEntangled(i: number, j: number): boolean {
    if (i < 0 || j < 0 || i >= this.numCells || j >= this.numCells) return false;
    return this.entanglement[i][j];
  }

  propagateWavefront(iterations: number): void {
    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < this.numCells - 1; i++) {
        if (this.cells[i].tc === TC.NONE) continue;
        const prob = this.config.tcPropagateRate * (0.5 + 0.5 * Math.sin(this.phase[i] * Math.PI / 180.0));
        if (Math.random() < prob) {
          if (TC_ORDER[this.cells[i + 1].tc] < TC_ORDER[this.cells[i].tc]) {
            this.cells[i + 1].tc = this.cells[i].tc;
            this.cells[i + 1].weight = this.cells[i].weight * 0.8;
          }
        }
      }
      this.syncEntangled();
      this.stats.tcPropagations++;
    }
  }

  private syncEntangled(): void {
    for (let i = 0; i < this.numCells; i++) {
      for (let j = i + 1; j < this.numCells; j++) {
        if (this.isEntangled(i, j)) {
          const maxTC = tcAdd(this.cells[i].tc, this.cells[j].tc);
          this.cells[i].tc = maxTC;
          this.cells[j].tc = maxTC;
          const avgWeight = (this.cells[i].weight + this.cells[j].weight) / 2.0;
          this.cells[i].weight = avgWeight;
          this.cells[j].weight = avgWeight;
        }
      }
    }
  }

  propagatePhase(angle: number): void {
    for (let i = 0; i < this.numCells; i++) {
      this.phase[i] = (this.phase[i] + angle) % 360;
      if (this.phase[i] < 0) this.phase[i] += 360;
    }
  }

  amplify(target: number, boost: number): void {
    if (target < 0 || target >= this.numCells) return;
    if (this.cells[target].tc === TC.NONE) return;
    this.cells[target].weight *= (1.0 + boost);
    if (this.cells[target].weight > 10.0) this.cells[target].weight = 10.0;
    if (this.cells[target].weight < 0.001) this.cells[target].weight = 0.001;
    this.stats.quantumOps++;
    this.stats.totalOps++;
  }

  getStats(): TCStats {
    const avgTC = this.cells.reduce((sum, c) => sum + TC_ORDER[c.tc], 0) / this.cells.length;
    return { ...this.stats, avgTcLevel: avgTC };
  }
}
