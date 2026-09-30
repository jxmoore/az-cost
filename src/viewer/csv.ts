// What the page shows, as a spreadsheet: one row per box of the current view (or of the opened group), with its
// numbers for both periods. For chargeback sheets and pasting into reports, so it adds up to the bill: credits and
// refunds (which the map can't draw) and what went to zero are rows too.
import type { Dim, ViewKey } from "../core/types";
import type { DD, LevelRow } from "./drill";
import type { Model } from "./model";

const round2 = (v: number) => Math.round(v * 100) / 100; // a number, so "-12.5" stays a number, not guarded text

/** A cell as CSV: quoted when it needs to be, and never read as a formula by a spreadsheet. */
function cell(v: string | number | null): string {
  if (v === null) return "";
  if (typeof v === "number") return String(v);
  const safe = /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface CsvScope {
  view: ViewKey;
  group: string | null; // the opened group's key: only its rows
  filter: string; // only the rows the filter matches ("" for all)
}

export function toCsv(M: Model, s: CsvScope): string {
  const v = M.DATA.views[s.view]!, [A, B] = v.dims, names = v.names || {}, q = s.filter.toLowerCase();
  const split = M.SPLIT, days = M.DAYS, currency = M.DATA.mixed_currencies ? "mixed" : M.DATA.currency;
  const rows: { g: string; ga: string; b: string; lb: string; cur: number; prev: number }[] = [];
  for (const r of v.rows) {
    const [a, b] = r.k;
    if (s.group !== null && a !== s.group) continue;
    const ga = M.DIM[A].label(a, names), lb = M.DIM[B].label(b, names);
    if (q && !`${a} ${b} ${ga} ${lb}`.toLowerCase().includes(q)) continue; // the same match as the filter on the map
    let cur = 0, prev = 0;
    r.d.forEach((x, i) => (i < split ? (prev += x) : (cur += x)));
    if (Math.abs(cur) < 0.005 && Math.abs(prev) < 0.005) continue;
    rows.push({ g: a, ga, b, lb, cur, prev });
  }
  // groups biggest first, and within a group its rows biggest first, as on the map
  const groupCur = new Map<string, number>();
  for (const r of rows) groupCur.set(r.g, (groupCur.get(r.g) ?? 0) + r.cur);
  rows.sort((x, y) => groupCur.get(y.g)! - groupCur.get(x.g)! || x.ga.localeCompare(y.ga) || y.cur - x.cur);

  const header = [M.DIM[A].one, `${M.DIM[A].one} id`, M.DIM[B].one, `${M.DIM[B].one} id`,
    `current (${M.period()})`, "previous", "change", "change %", "share of bill %", "per day", "monthly pace", "currency"];
  const lines = rows.map(r => [r.ga, r.g, r.lb, r.b, round2(r.cur), round2(r.prev), round2(r.cur - r.prev),
    r.prev >= 0.01 ? round2(100 * (r.cur - r.prev) / r.prev) : null, M.grand ? round2(100 * r.cur / M.grand) : null,
    round2(r.cur / days), round2(r.cur / days * 30.4), currency]);
  // "\ufeff": Excel reads the file as UTF-8 (names with accents, the en dash in the period) only with the mark
  return "\ufeff" + [header, ...lines].map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** A drilled level as a spreadsheet: its rows (credits included) with both periods' totals. */
export function levelCsv(M: Model, path: string, dim: Dim, rows: LevelRow[], dd: DD): string {
  const currency = M.DATA.mixed_currencies ? "mixed" : M.DATA.currency, days = M.DAYS;
  const header = ["path", M.DIM[dim].one, `${M.DIM[dim].one} id`, `current (${M.period()})`, "previous", "change", "change %",
    "share of bill %", "per day", "monthly pace", "currency"];
  const lines = rows.filter(r => Math.abs(r.cur) >= 0.005 || Math.abs(r.prev) >= 0.005).map(r => [path, M.label(dd, r.key), r.key.replace("\u0000", " / "),
    round2(r.cur), round2(r.prev), round2(r.cur - r.prev), r.prev >= 0.01 ? round2(100 * (r.cur - r.prev) / r.prev) : null,
    M.grand ? round2(100 * r.cur / M.grand) : null, round2(r.cur / days), round2(r.cur / days * 30.4), currency]);
  return "\ufeff" + [header, ...lines].map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

function save(M: Model, text: string, name: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${name}-${M.DATA.days[M.SPLIT]}_${M.DATA.days[M.N - 1]}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const slug = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 40);

export function downloadLevelCsv(M: Model, path: string, dim: Dim, rows: LevelRow[], dd: DD) {
  save(M, levelCsv(M, path, dim, rows, dd), `azcost-${slug(path)}-by-${dd}`);
}

export function downloadCsv(M: Model, s: CsvScope, groupName?: string) {
  save(M, toCsv(M, s), `azcost-${s.view}${groupName ? "-" + slug(groupName) : ""}`);
}
