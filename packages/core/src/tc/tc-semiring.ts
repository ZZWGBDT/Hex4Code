import { TC, TC_ORDER } from "./tc-types";

export function tcAdd(a: TC, b: TC): TC {
  return TC_ORDER[a] > TC_ORDER[b] ? a : b;
}

export function tcMul(a: TC, b: TC): TC {
  if (a === TC.NONE || b === TC.NONE) return TC.NONE;
  return TC_ORDER[a] > TC_ORDER[b] ? a : b;
}

export function tcPow(a: TC, n: number): TC {
  if (n <= 0) return TC.NONE;
  if (n === 1) return a;
  if (a === TC.NONE) return TC.NONE;
  return a;
}

export function tcWeightedSum(sources: Array<{ tc: TC; weight: number }>): TC {
  let result = TC.NONE;
  for (const s of sources) {
    if (s.weight >= 0.5) {
      result = tcAdd(result, s.tc);
    }
  }
  return result;
}

export function tcMerge(states: TC[]): TC {
  let result = TC.NONE;
  for (const s of states) {
    result = tcAdd(result, s);
  }
  return result;
}
