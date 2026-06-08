export enum Trit {
  T0 = 0,
  T1 = 1,
  T2 = 2,
}

export function tritMod3(v: number): Trit {
  const r = ((v % 3) + 3) % 3;
  return r as Trit;
}

export function tritName(t: Trit): string {
  return ["0", "1", "2"][t];
}

export enum TC {
  NONE = 0,
  CARRY = 1,
  UNCERTAIN = 2,
  MIXED = 3,
  HIGH_CONFLICT = 4,
  MEDIUM_CONFLICT = 5,
  LOW_CONFLICT = 6,
}

export function tcName(t: TC): string {
  const names: Record<TC, string> = {
    [TC.NONE]: "NONE",
    [TC.CARRY]: "CARRY",
    [TC.UNCERTAIN]: "UNCERTAIN",
    [TC.MIXED]: "MIXED",
    [TC.HIGH_CONFLICT]: "HIGH_CONFLICT",
    [TC.MEDIUM_CONFLICT]: "MEDIUM_CONFLICT",
    [TC.LOW_CONFLICT]: "LOW_CONFLICT",
  };
  return names[t];
}

export const TC_ORDER: Record<TC, number> = {
  [TC.NONE]: 0,
  [TC.CARRY]: 1,
  [TC.LOW_CONFLICT]: 2,
  [TC.MEDIUM_CONFLICT]: 3,
  [TC.UNCERTAIN]: 4,
  [TC.HIGH_CONFLICT]: 5,
  [TC.MIXED]: 6,
};

export interface TCWeight {
  value: number;
  decay: number;
  timestamp: number;
}

export function createWeight(initial: number = 1.0): TCWeight {
  return { value: initial, decay: 0.8, timestamp: Date.now() };
}

export enum Mode {
  CLASSICAL = 0,
  QUANTUM = 1,
  HYBRID = 2,
}

export interface TCCell {
  trit: Trit;
  tc: TC;
  weight: number;
}

export function makeCell(trit: Trit, tc: TC, weight: number): TCCell {
  return { trit, tc, weight };
}

export function cellIsDeterministic(c: TCCell): boolean {
  return c.tc === TC.NONE;
}

export function cellIsQuantum(c: TCCell): boolean {
  return c.tc !== TC.NONE;
}
