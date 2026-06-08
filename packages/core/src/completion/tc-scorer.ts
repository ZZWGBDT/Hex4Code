import { TC, TC_ORDER } from "../tc/tc-types";

export interface TCScoredItem {
  text: string;
  tc: TC;
  baseScore: number;
  symbolName?: string;
}

export class TCCompletionScorer {
  // TC_ORDER: NONE(0), CARRY(1), LOW_CONFLICT(2), MEDIUM_CONFLICT(3), UNCERTAIN(4), HIGH_CONFLICT(5), MIXED(6)
  private tcBoost = [10, 5, 0, -3, -5, -8, -10];

  score(items: TCScoredItem[], getSymbolTC?: (name: string) => TC | undefined): TCScoredItem[] {
    return items.map(item => {
      let adjusted = item.baseScore + this.tcBoost[TC_ORDER[item.tc]];
      if (item.symbolName && getSymbolTC) {
        const symTC = getSymbolTC(item.symbolName);
        if (symTC !== undefined) {
          adjusted += this.tcBoost[TC_ORDER[symTC]] * 0.5;
        }
      }
      return { ...item, baseScore: Math.max(0, adjusted) };
    }).sort((a, b) => b.baseScore - a.baseScore);
  }

  tcLabel(tc: TC): string {
    // TC_ORDER: NONE(0), CARRY(1), LOW_CONFLICT(2), MEDIUM_CONFLICT(3), UNCERTAIN(4), HIGH_CONFLICT(5), MIXED(6)
    const label = ["", "~", "?", "!", "?", "‼", "!"];
    return label[TC_ORDER[tc]] ?? "";
  }

  filterByTC(items: TCScoredItem[], minTC: TC): TCScoredItem[] {
    return items.filter(item => TC_ORDER[item.tc] >= TC_ORDER[minTC]);
  }
}
