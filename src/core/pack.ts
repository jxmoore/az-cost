import type { PackedRow } from "./types";

export const TINY = "(under a cent each)";

/** (key, day index, cost, cost in USD): one raw entry, folded once the currency is known. */
export type RawEntry = [key: [string, string], day: number, cost: number, costUsd: number | null | undefined];

const SEP = "\u0000";
const join = (k: [string, string]) => k[0] + SEP + k[1];
const split = (s: string) => s.split(SEP) as [string, string];

/** Rows too small to keep alone (under half a cent over both periods) are summed per group into one TINY row,
 * so a thousand tiny charges still add up. A charge in one period and its refund in the other count in both. */
export function pack(rows: Map<string, number[]>): PackedRow[] {
  const kept = new Map<string, number[]>(), tiny = new Map<string, number[]>();
  const absSum = (d: number[]) => d.reduce((s, v) => s + Math.abs(v), 0);
  for (const [k, d] of rows) {
    if (absSum(d) >= 0.005) kept.set(k, d);
    else {
      const group = split(k)[0];
      let acc = tiny.get(group);
      if (!acc) tiny.set(group, (acc = new Array(d.length).fill(0)));
      d.forEach((v, i) => (acc![i] += v));
    }
  }
  for (const [group, d] of tiny) if (absSum(d) >= 0.005) kept.set(join([group, TINY]), d);
  return [...kept].map(([k, d]) => ({ k: split(k), d: d.map(v => Math.round(v * 1e4) / 1e4) }));
}

/** Add a daily series into a keyed accumulator of `n` days. */
export function accumulate(rows: Map<string, number[]>, key: [string, string], n: number): number[] {
  const k = join(key);
  let acc = rows.get(k);
  if (!acc) rows.set(k, (acc = new Array(n).fill(0)));
  return acc;
}

/** Raw entries -> packed rows of daily totals, in one currency. */
export function fold(entries: RawEntry[], n: number, usd: boolean): PackedRow[] {
  const rows = new Map<string, number[]>();
  for (const [key, i, cost, costUsd] of entries) {
    const amount = usd ? (costUsd || 0) : cost;
    if (amount) accumulate(rows, key, n)[i] += amount;
  }
  return pack(rows);
}

// ---------------------------------------------------------------- small statistics, as Python's statistics module

export const sum = (xs: ArrayLike<number>) => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[i]; return s; };
export const mean = (xs: number[]) => sum(xs) / xs.length;
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function pstdev(xs: number[]): number {
  const mu = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / xs.length);
}
/** round(v, 2) */
export const money = (v: number) => Math.round(v * 100) / 100;
export const round1 = (v: number) => Math.round(v * 10) / 10;
