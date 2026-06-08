import { TC, TC_ORDER } from "./tc-types";
import { tcAdd } from "./tc-semiring";

export interface LazyTritEntry {
  turnTC: TC;
  chain: TC[];
  delta: number;
  timestamp: number;
  source: string;
}

export interface LazyTritTrend {
  direction: "rising" | "stable" | "falling";
  confidence: number;
  volatility: number;
  dominantTC: TC;
  sampleSize: number;
}

export class LazyTrit {
  private history: LazyTritEntry[] = [];
  private lastTC: TC | null = null;

  push(turnTC: TC, chain: TC[], source: string): void {
    const delta = this.lastTC !== null ? TC_ORDER[turnTC] - TC_ORDER[this.lastTC] : 0;
    this.history.push({ turnTC, chain, delta, timestamp: Date.now(), source });
    this.lastTC = turnTC;
    if (this.history.length > 100) {
      this.history = this.history.slice(-50);
    }
  }

  resolve(): TC {
    if (this.history.length === 0) return TC.NONE;
    let result = TC.NONE;
    for (const h of this.history) {
      result = tcAdd(result, h.turnTC);
    }
    return result;
  }

  getTrend(windowSize: number = 5): LazyTritTrend {
    const window = this.history.slice(-windowSize);
    if (window.length < 2) {
      return { direction: "stable", confidence: 0, volatility: 0, dominantTC: TC.NONE, sampleSize: window.length };
    }

    const avgDelta = window.reduce((s, h) => s + h.delta, 0) / window.length;
    const direction: "rising" | "stable" | "falling" =
      avgDelta > 0.5 ? "rising" : avgDelta < -0.5 ? "falling" : "stable";

    const mean = window.reduce((s, h) => s + TC_ORDER[h.turnTC], 0) / window.length;
    const variance = window.reduce((s, h) => s + Math.pow(TC_ORDER[h.turnTC] - mean, 2), 0) / window.length;

    const freq: Record<number, number> = {};
    for (const h of window) {
      freq[TC_ORDER[h.turnTC]] = (freq[TC_ORDER[h.turnTC]] || 0) + 1;
    }
    const dominantEntry = Object.entries(freq).sort(([, a], [, b]) => b - a)[0];
    const dominantTC = Number(dominantEntry?.[0] ?? 0) as TC;

    const confidence = window.length >= 10 ? 0.9 : window.length >= 5 ? 0.7 : 0.4;

    return { direction, confidence, volatility: Math.sqrt(variance), dominantTC, sampleSize: window.length };
  }

  buildSummary(): string {
    if (this.history.length === 0) return "";
    const tcChain = this.history.map(h => `${h.source}:${TC[h.turnTC]}`);
    const resolved = this.resolve();
    const trend = this.getTrend();
    return [
      `[LazyTrit] ${tcChain.join(" -> ")}`,
      `[LazyTrit] Resolved: ${TC[resolved]}`,
      `[LazyTrit] Trend: ${trend.direction} (vol=${trend.volatility.toFixed(2)}, n=${trend.sampleSize})`,
    ].join("\n");
  }

  clear(): void {
    this.history = [];
    this.lastTC = null;
  }

  get length(): number {
    return this.history.length;
  }

  toJSON(): LazyTritEntry[] {
    return [...this.history];
  }
}
