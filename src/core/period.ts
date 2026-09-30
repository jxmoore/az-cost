// What a run compares: a current period and the one it's measured against. Rolling days suit engineers; finance
// thinks in calendar months, so a run can also be month to date, the last full month, or any range.
import { addDays, daysBetween, lastFullDay, localToday, monthEnd } from "./types";

export type PeriodMode = "days" | "mtd" | "lastMonth" | "custom";

/** What the user asked for: small enough to put in a link. */
export interface PeriodSpec {
  mode: PeriodMode;
  days?: number; // "days": the last N full days
  from?: string; // "custom": the current period, both days included
  to?: string;
}

/** Resolved to dates. The previous period comes first and needn't touch the current one (month to date compares
 * with the same days of last month). */
export interface Period {
  mode: PeriodMode;
  label: string; // "last 30 days", "September 2026", "month to date", "Sep 1 – Sep 15"
  prev: [string, string];
  cur: [string, string];
}

export const MAX_DAYS = 180; // a query spans a year at most, and a run reads two periods

const MONTH = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const SHORT = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const firstOf = (iso: string) => iso.slice(0, 8) + "01";
const lengthOf = ([a, b]: [string, string]) => daysBetween(a, b) + 1;

/** The period a spec means today, or why it can't be read. */
export function resolvePeriod(spec: PeriodSpec, today: string = localToday()): Period | { error: string } {
  const last = lastFullDay(today); // Azure takes 8-24 hours to post usage: yesterday is still filling in
  if (spec.mode === "days") {
    const n = spec.days ?? 30;
    if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) return { error: `The period must be between 1 and ${MAX_DAYS} days.` };
    const curStart = addDays(last, -(n - 1));
    return { mode: "days", label: `last ${n} days`, prev: [addDays(curStart, -n), addDays(curStart, -1)], cur: [curStart, last] };
  }
  if (spec.mode === "mtd") {
    const first = firstOf(today);
    if (last < first) {
      return { error: "Month to date needs a full day of this month, and Azure posts usage a day or two late. Try the last full month." };
    }
    const n = daysBetween(first, last) + 1, prevFirst = firstOf(addDays(first, -1));
    // the same days of last month, as far as last month goes (March 30 against a 28-day February)
    const prevEnd = [addDays(prevFirst, n - 1), addDays(first, -1)].sort()[0];
    return { mode: "mtd", label: "month to date", prev: [prevFirst, prevEnd], cur: [first, last] };
  }
  if (spec.mode === "lastMonth") {
    const curFirst = firstOf(addDays(firstOf(today), -1));
    const curEnd = [monthEnd(curFirst), last].sort()[0]; // on the 1st, yesterday isn't a full day yet
    const prevFirst = firstOf(addDays(curFirst, -1));
    return { mode: "lastMonth", label: MONTH(curFirst), prev: [prevFirst, monthEnd(prevFirst)], cur: [curFirst, curEnd] };
  }
  const { from, to } = spec;
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return { error: "Pick both dates of the range." };
  if (from > to) return { error: "The range ends before it starts." };
  if (to > today) return { error: "The range can't end in the future." };
  const n = daysBetween(from, to) + 1;
  if (n > MAX_DAYS) return { error: `A range can be at most ${MAX_DAYS} days.` };
  return { mode: "custom", label: `${SHORT(from)} – ${SHORT(to)}`, prev: [addDays(from, -n), addDays(from, -1)], cur: [from, to] };
}

/** Every day a run reads, previous period first, and where the current period starts. */
export function periodDays(p: Period): { days: string[]; split: number } {
  const range = ([a, b]: [string, string]) => Array.from({ length: lengthOf([a, b]) }, (_, i) => addDays(a, i));
  const prev = range(p.prev);
  return { days: [...prev, ...range(p.cur)], split: prev.length };
}
