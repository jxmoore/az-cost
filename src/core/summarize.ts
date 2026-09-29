// Worth a look, and the AI export: the rules that find what's worth a look in a run's data.
import { mean, median, money, pstdev, round1, sum } from "./pack";
import type { AdvisorRec, CostData, Forecast, SubInfo, ViewKey } from "./types";

// ---------------------------------------------------------------- known money pits

// (service pattern, meter pattern, why, monthly floor). First match wins; a rule with a floor only fires once the
// meter runs at least that much a month. `{profiles}` in a reason is filled in from the monthly amount.
const VM_END = String.raw`(?:$|/| Low Priority| Spot| Promo)`;
const RETIRING_MAY_2028 = String.raw`^(?:DS?\d+(?:-\d+)?(?: v2)?|L\d+s)` + VM_END; // D, Ds, Dv2, Dsv2 (and constrained DS13-4 v2), Ls
const RETIRING_NOV_2028 = String.raw`^(?:(?:Basic[ ._])?A\d+m?(?: v2)?|F\d+s?(?: v2)?|L\d+s v2|GS?\d+|B\d+[a-z]*)` + VM_END; // Av2, F*, Lsv2, G*, B v1
const NO_NEW_RESERVATIONS = String.raw`^[DE]\d+(?:-\d+)?(?:i|s|is)? v3` + VM_END; // Dv3, Dsv3, Ev3, Esv3, constrained, isolated

const PITS: [RegExp, RegExp, string, number][] = ([
  [String.raw`^(?:Log Analytics|Azure Monitor)$`, String.raw`^(?!Basic |Auxiliary ).*Data Ingestion`,
    "Log Analytics ingestion — trim noisy tables, use Basic logs, or a commitment tier past 100 GB/day", 0],
  [String.raw`^Azure Front Door Service$`, String.raw`^Premium Base Fees`,
    "Front Door Premium — Standard is about $35 a month against about $330; Premium is only needed for managed " +
    "WAF rules or Private Link origins", 0],
  [String.raw`^Azure Front Door Service$`, String.raw`^Standard Base Fees`,
    "about {profiles} Front Door Standard profiles at $35 a month each; one profile can hold many endpoints and domains", 70],
  [String.raw`^SQL Database$`, String.raw`DTUs?$`, // below ~$150 a month a DTU database is cheaper than any provisioned vCore option
    "DTU databases — vCore can be reserved and use Azure Hybrid Benefit; serverless pauses when idle", 150],
  [String.raw`^Azure DevOps$`, String.raw`Concurrent Job|Basic User`,
    "Azure DevOps seats and hosted jobs — the first 5 Basic users are free; remove inactive users, check pipeline concurrency", 0],
  [String.raw`^Virtual Network$`, String.raw`Private Endpoint`, "private endpoints — $0.01 an hour each plus data; remove the ones nothing uses", 0],
  [String.raw`^Azure Cosmos DB$`, String.raw`^100 RU/s$`, "provisioned Cosmos DB throughput — autoscale or serverless costs less when load varies", 0],
  [String.raw`^Azure Monitor$`, String.raw`at 1 Minute Frequency`, "1-minute alert rules — they cost more than 5- or 15-minute ones; relax the ones " +
    "where minutes don't matter", 0],
  [String.raw`^(?:Redis Cache|Azure Cache for Redis)$`, "",
    "Azure Cache for Redis retires on 30 Sep 2028 (Enterprise tiers on 31 Mar 2027); plan the move to Azure Managed Redis", 0],
  [String.raw`^Azure App Service$`, String.raw`^S\d App$`, "Standard App Service plans can't be reserved or use a savings plan; Premium v3 plans can", 0],
  [String.raw`^Bandwidth$`, String.raw`Data Transfer Out`, "data transfer out — keep traffic in one region, cache at the edge", 0],
  [String.raw`^NAT Gateway$`, String.raw`Data Processed`, "NAT data processing — service or private endpoints for Storage, SQL and ACR skip it", 0],
  [String.raw`^Azure Firewall$`, String.raw`Data Processed|Premium`, "Azure Firewall — processing and Premium add up; route only what needs inspection", 0],
  [String.raw`^Virtual Network$`, String.raw`^Basic .*Public IP`, "Basic public IPs — the Basic SKU retired on 30 Sep 2025, move to Standard", 0],
  [String.raw`^Virtual Network$`, String.raw`Public IP|IP Address Hours`, "public IPs — billed per hour each; release the ones nothing uses", 0],
  [String.raw`^Storage$`, String.raw`Snapshot`, "snapshots — prune old ones; incremental snapshots on Standard storage cost less", 0],
  [String.raw`^Virtual Machines$`, RETIRING_MAY_2028,
    "retiring VM series — D, Ds, Dv2, Dsv2 and Ls stop on 1 May 2028; current generations cost less for the same work", 0],
  [String.raw`^Virtual Machines$`, RETIRING_NOV_2028,
    "retiring VM series — F, Fs, Fsv2, Lsv2, G, Gs, Av2 and B-series v1 stop on 15 Nov 2028; current generations cost " +
    "less for the same work", 0],
  [String.raw`^Virtual Machines$`, NO_NEW_RESERVATIONS,
    "Dv3 and Ev3 sizes — new reservations stopped in July 2026; v5 and v6 sizes can still be reserved", 0],
  [String.raw`^Azure App Service$`, String.raw`^P\d+ ?v2 App`, "Premium v2 App Service plans — Premium v3 gives more per dollar and can be reserved", 0],
  ["", String.raw`Extended Security Update`, "Extended Security Updates — upgrade the OS or SQL version to stop paying for them", 0],
] as [string, string, string, number][]).map(([s, m, why, floor]) => [new RegExp(s), new RegExp(m), why, floor]);

/** Why this meter is worth a look, or null. `monthly` is what it runs at a month; some rules have a floor. */
export function pit(service: string, meter: string, monthly = 0): string | null {
  for (const [s, m, why, floor] of PITS) {
    if (s.test(service) && m.test(meter) && monthly >= floor) return why.replace("{profiles}", String(Math.round(monthly / 35)));
  }
  return null;
}

// ---------------------------------------------------------------- spikes, dev/test, reservations, idle

/** The biggest one-off day in the current period (days from `split` on), or null. A spike is at least `floor`
 * above the meter's usual day (the median of the 14 days before it) and at least 3x it, or any amount on a meter
 * that's usually zero. More than 3 such days is a trend, which the growers cover. A charge with one half its size
 * 27-31 days earlier is a monthly bill, not a spike. */
export function spike(daily: number[], split: number, floor: number) {
  const found: { day: number; usual: number; excess: number }[] = [];
  for (let i = split; i < daily.length; i++) {
    const prior = daily.slice(Math.max(0, i - 14), i);
    if (prior.length < 7) continue;
    const usual = median(prior), excess = daily[i] - usual;
    if (excess >= floor && (usual <= 0 || daily[i] >= 3 * usual)) found.push({ day: i, usual, excess });
  }
  if (found.length < 1 || found.length > 3) return null;
  const best = found.reduce((a, b) => (b.excess > a.excess ? b : a));
  const i = best.day;
  if (daily.slice(Math.max(0, i - 31), Math.max(0, i - 26)).some(v => v >= 0.5 * daily[i])) return null;
  return best;
}

// Dev/test by name: a whole word (tms-dev-rg, acme-staging), not a substring (devices, contest).
const DEV_TEST = /(?:^|[-_ .])(?:dev|devtest|development|tst|test|testing|stg|staging|stage|qa|uat|sbx|sandbox|non-?prod|pre-?prod)(?:[-_ .0-9]|$)/i;
const MIN_PATTERN_DAYS = 7; // "flat" or "steady" means little over fewer days than a week
// Compute that bills by the hour whether used or not, and can be scaled down, stopped or made serverless.
const ALWAYS_ON = /\/providers\/microsoft\.(?:compute\/(?:virtualmachines|virtualmachinescalesets)|web\/serverfarms|sql\/servers\/[^/]+\/(?:databases|elasticpools)|documentdb\/databaseaccounts|containerservice\/managedclusters)\//i;

export interface Hint {
  kind: "grower" | "spike" | "pit" | "devtest" | "steady" | "idle";
  amount: number;
  current: number;
  service?: string;
  meter?: string;
  previous?: number;
  change?: number;
  reason?: string;
  date?: string;
  day_cost?: number;
  usual?: number;
  group?: string;
  label?: string;
  resources?: any; // devtest: a count; idle: the resources found
  meters?: string[];
  monthly?: number;
  check?: string;
}

/** Dev/test resource groups whose compute runs flat all period (lowest day at least 90% of the highest):
 * one hint per group. Needs daily data, so nothing when the resource view has period totals only. */
function alwaysOn(data: CostData, floor: number): Hint[] {
  const view = data.views.resource;
  if (!view || data.resource_fallback?.length || data.days.length - data.split < MIN_PATTERN_DAYS) return [];
  const split = data.split;
  const subs = new Map((data.subscriptions || []).map(s => [s.id.toLowerCase(), s.name]));
  const groups = new Map<string, { label: string; current: number; resources: number }>();
  for (const r of view.rows) {
    const [key, rid] = r.k;
    const cur = r.d.slice(split);
    const lo = Math.min(...cur), hi = Math.max(...cur);
    if (!ALWAYS_ON.test(rid) || lo <= 0 || lo < 0.9 * hi) continue;
    const label = view.names[key] ?? key;
    const sub = key.startsWith("/subscriptions/") ? subs.get(key.split("/")[2].toLowerCase()) ?? "" : "";
    if (!(DEV_TEST.test(label) || DEV_TEST.test(sub))) continue;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { label, current: 0, resources: 0 }));
    g.current += sum(cur);
    g.resources += 1;
  }
  return [...groups].filter(([, g]) => g.current >= floor).map(([k, g]) => ({
    kind: "devtest", group: k, label: g.label, resources: g.resources, current: money(g.current), amount: money(g.current),
  }));
}

// Meters a reservation or savings plan can cover, by kind: (service pattern, meter pattern). Advisor names a
// reservation in its wording ("Consider SQL PaaS DB reserved instance ...") and a savings plan only by its SKU.
const RESERVABLE: Record<string, [RegExp, RegExp]> = {
  sql: [/^SQL (?:Database|Managed Instance)$/, /vCore/],
  app: [/^Azure App Service$/, /^(?:P\d+ ?m?v3|I\d+ ?v2) App/],
  functions: [/^Functions$/, /^Premium/],
  cosmos: [/^Azure Cosmos DB$/, /RU\/s/],
  vm: [/^Virtual Machines$/, /^(?!.* (?:Spot|Low Priority)$)/], // Spot capacity can't be reserved
  redis: [/^(?:Redis Cache|Azure Cache for Redis)$/, /^P\d|Enterprise/],
  postgres: [/^Azure Database for PostgreSQL/, /vCore/],
  mysql: [/^Azure Database for MySQL/, /vCore/],
};
// "SQL" alone would also catch "Azure Synapse Analytics (formerly SQL DW)", which covers no SQL Database meter
const RESERVATION_WORDS: [RegExp, string][] = [[/SQL (?:PaaS DB|Database|Managed Instance)/i, "sql"], [/App Service/i, "app"],
  [/Cosmos/i, "cosmos"], [/virtual machine/i, "vm"], [/Redis/i, "redis"], [/PostgreSQL/i, "postgres"], [/MySQL/i, "mysql"]];
const SAVINGS_PLANS: Record<string, string[]> = {
  Compute_Savings_Plan: ["vm", "app", "functions"], Database_Savings_Plan: ["sql", "cosmos", "postgres", "mysql"],
};

/** What an Advisor tip would commit to: from its wording for a reservation, from its SKU for a savings plan. */
export function commitmentKinds(rec: Pick<AdvisorRec, "problem" | "sku">): string[] {
  const problem = rec.problem || "";
  const m = /^Consider (.+?) reserved (?:instance|capacity)/i.exec(problem);
  if (m) return RESERVATION_WORDS.filter(([words]) => words.test(m[1])).map(([, kind]) => kind);
  if (problem.toLowerCase().includes("savings plan")) return SAVINGS_PLANS[rec.sku || ""] ?? [];
  return [];
}

export const reservable = (service: string, meter: string, kinds: string[] = Object.keys(RESERVABLE)) =>
  kinds.some(k => RESERVABLE[k][0].test(service) && RESERVABLE[k][1].test(meter));

export interface LineItem {
  service: string; meter: string; current: number; previous: number; change: number;
  change_pct: number | null; share_pct: number;
}
export interface LinkedTip extends AdvisorRec {
  covers: { service: string; meter: string; current: number }[];
  covers_monthly: number;
}

/** An Advisor tip plus the meters its reservation or savings plan would cover (biggest first) and their monthly
 * pace. Other tips cover nothing. */
function linkTip(rec: AdvisorRec, lineItems: LineItem[], n: number): LinkedTip {
  const kinds = commitmentKinds(rec);
  const covers = lineItems
    .filter(x => kinds.length && x.current > 0 && reservable(x.service, x.meter, kinds))
    .map(x => ({ service: x.service, meter: x.meter, current: x.current }));
  return { ...rec, covers, covers_monthly: money(sum(covers.map(c => c.current)) / n * 30.4) };
}

/** Reservable spend that barely moves (no zero day, day-to-day spread within 10%) and runs at least $100 a
 * month, one hint per service. Only asked for when Advisor, which knows what's already reserved, isn't there. */
function steady(data: CostData, lineKeys: Set<string>, n: number, rate = 1): Hint[] {
  const split = data.split, byService = new Map<string, { current: number; meters: string[] }>();
  if (n < MIN_PATTERN_DAYS || !data.views.service) return [];
  for (const r of data.views.service.rows) {
    const [svc, meter] = r.k;
    const cur = r.d.slice(split);
    if (!lineKeys.has(svc + "\u0000" + meter) || !reservable(svc, meter) || Math.min(...cur) <= 0) continue;
    if (pstdev(cur) <= 0.10 * mean(cur)) {
      let s = byService.get(svc);
      if (!s) byService.set(svc, (s = { current: 0, meters: [] }));
      s.current += sum(cur);
      s.meters.push(meter);
    }
  }
  return [...byService].filter(([, s]) => s.current / n * 30.4 >= 100 * rate).map(([svc, s]) => ({
    kind: "steady", service: svc, meters: s.meters, current: money(s.current), amount: money(s.current),
    monthly: money(s.current / n * 30.4),
  }));
}

// Resource Graph checks (see IDLE_QUERY): what one is called, what several are called, and what to do
const IDLE: Record<string, [string, string, string]> = {
  "stopped-vm": ["stopped VM", "stopped VMs", "stopped from inside the OS but still allocated, so compute keeps billing; Stop in the portal deallocates"],
  "unattached-disk": ["unattached disk", "unattached disks", "attached to no VM; snapshot what you need, then delete"],
  "unused-ip": ["unused public IP", "unused public IPs", "attached to nothing, and public IPs bill by the hour; release what nothing uses"],
  "old-snapshot": ["old snapshot", "old snapshots", "older than 90 days; delete what no restore plan needs"],
  "empty-plan": ["empty App Service plan", "empty App Service plans", "no apps, but a plan bills by the hour whether used or not; delete or scale down"],
  "lonely-nat": ["unused NAT gateway", "unused NAT gateways", "on no subnet, so routing nothing, but billed by the hour"],
};
const IDLE_FLOOR = 1.0; // dollars over the period: a check that costs less isn't worth a line

export interface IdleResource { id: string; name: string; group: string; current: number }

/** Resource Graph's findings with what each cost this period (from the resource view): one hint per check,
 * biggest resource first. What cost nothing is left out: a free empty plan or a $0 IP isn't money. */
function idle(data: CostData, rate = 1): Hint[] {
  const split = data.split, cost = new Map<string, number>(), group = new Map<string, string>();
  for (const r of data.views.resource?.rows ?? []) {
    const [key, rid] = r.k;
    cost.set(rid, (cost.get(rid) ?? 0) + sum(r.d.slice(split)));
    group.set(rid, key);
  }
  const checks = new Map<string, IdleResource[]>();
  for (const f of data.graph ?? []) {
    const rid = (f.id || "").toLowerCase();
    if (IDLE[f.check] && (cost.get(rid) ?? 0) >= 0.005) {
      let list = checks.get(f.check);
      if (!list) checks.set(f.check, (list = []));
      list.push({ id: rid, name: f.name || rid.split("/").pop()!, group: group.get(rid)!, current: money(cost.get(rid)!) });
    }
  }
  const hints: Hint[] = [];
  for (const [check, found] of checks) {
    const total = money(sum(found.map(x => x.current)));
    if (total < IDLE_FLOOR * rate) continue;
    const [one, many, why] = IDLE[check];
    found.sort((a, b) => b.current - a.current);
    const single = found.length === 1;
    hints.push({
      kind: "idle", check, label: single ? found[0].name : `${found.length} ${many}`,
      reason: single ? `${one}: ${why}` : `${why}; biggest: ${found[0].name}`,
      resources: found, current: total, amount: total,
    });
  }
  return hints;
}

// ---------------------------------------------------------------- the export

const AI_INSTRUCTIONS =
  "This is an Azure cost breakdown exported by azcost. Amounts are in `currency`, for the cost type in `metric` " +
  "(ActualCost books reservation and savings plan purchases on the day they were bought; AmortizedCost spreads them " +
  "over the term). When `currency` is \"mixed\", the subscriptions bill in the currencies listed in `currencies` and " +
  "Azure didn't convert them, so totals add different currencies: compare amounts within one subscription only. " +
  "`usd_rate` is units of `currency` per US dollar, as this bill priced them (null when unknown). " +
  "`current` is the most recent period and `previous` is the equally long period before it. " +
  "Line items are Azure meters grouped by service; `totals.credits_and_refunds` is the part of `current` that comes " +
  "from negative line items (credits, refunds). `resource_fallback` names subscriptions with so many resources that " +
  "azcost read one total per resource and period for them: their resource groups' amounts are right, but daily " +
  "detail and dev/test always-on checks aren't available there. `flags` are known cost traps matched on meter names. `hints` is the " +
  "list the page shows under Worth a look: news (growers, one-off spikes) taking turns with to-dos (money pits, " +
  "always-on compute in dev/test groups, idle resources, steady spend worth committing). `advisor` holds " +
  "Azure Advisor's cost recommendations, one per kind, resource and SKU, with the largest annual saving Advisor " +
  "reported; recommendations that cover the same usage (a reservation and a savings plan, a 1-year and a 3-year term) " +
  "are alternatives, not additive. A tip's `covers` lists the meters its reservation or savings plan would cover, " +
  "matched across the whole bill, so in a multi-subscription export it can include other subscriptions' usage. " +
  "`by_tag` splits the bill by the values of the tag named in `tag`; the row marked `untagged: true` (shown as " +
  "\"(untagged)\") is spend on resources without it. `forecast` is Azure's own forecast for the current calendar month: `actual` is billed so far, `forecast` is " +
  "still to come and `total` is both. Hints of kind `idle` are resources Azure Resource Graph found billing while " +
  "doing nothing (VMs stopped but still allocated, unattached disks, unused public IPs, snapshots older than 90 " +
  "days, App Service plans with no apps, NAT gateways on no subnet), with what they cost in the current period. " +
  "Please: 1) explain what drives the cost, 2) explain notable changes vs the previous period, " +
  "3) suggest concrete savings, each with an estimated monthly saving and how to verify it. " +
  "Levers to consider: reservations and savings plans for steady compute and databases; Azure Hybrid Benefit for " +
  "Windows Server and SQL Server licenses already owned; dev/test pricing for non-production subscriptions; " +
  "right-sizing and auto-shutdown for VMs and App Service plans; blob access tiers (cool, cold, archive) and lifecycle " +
  "rules; Log Analytics commitment tier pricing, Basic logs and shorter table retention; and keeping data transfer " +
  "inside one region.";
const TOP_RESOURCES = 20; // per resource group in the export; the rest are summed

export interface Entry { current: number; previous: number; change: number; change_pct: number | null; share_pct: number }

export interface Summary {
  tool: string;
  instructions_for_ai: string;
  generated?: string;
  metric: string;
  currency: string;
  currencies: string[];
  usd_rate: number | null;
  subscriptions: Omit<SubInfo, "tenant">[];
  demo_data: boolean;
  period: { current: { start: string; end: string; days: number }; previous: { start: string; end: string; days: number } };
  totals: Entry & { daily_avg: number; monthly_pace: number; credits_and_refunds: number };
  by_service: ({ service: string } & Entry)[];
  by_subscription: Record<string, unknown>[];
  by_region: Record<string, unknown>[];
  by_resource_group: Record<string, unknown>[];
  tag: string | null;
  by_tag: Record<string, unknown>[] | null;
  top_growers: LineItem[];
  top_drops: LineItem[];
  flags: { service: string; meter: string; current: number; reason: string }[];
  hints: Hint[];
  advisor: LinkedTip[] | null;
  advisor_error: string | null;
  resource_fallback: string[];
  graph_error: string | null;
  forecast: Forecast | null;
  line_items: LineItem[];
  daily_totals: { date: string; cost: number }[];
}

/** Interleave two lists: a, b, a, b, ... then whatever is left of the longer one. */
function zipLongest<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

/** Turn the raw daily data into a compact JSON an AI agent can reason about (and the page reads its hints from). */
export function summarize(data: CostData): Summary {
  const { days, split } = data;
  const n = days.length - split;
  const rate = data.usd_rate || 1; // the bill's currency per US dollar: the rules' floors and prices are in dollars
  let grand = 0;

  const entry = (cur: number, prev: number): Entry => ({
    current: money(cur), previous: money(prev), change: money(cur - prev),
    change_pct: prev >= 0.01 ? round1(100 * (cur - prev) / prev) : null,
    share_pct: grand ? Math.round(1e4 * cur / grand) / 100 : 0,
  });
  const keep = (cur: number, prev: number) => Math.abs(cur) >= 0.01 || Math.abs(prev) >= 0.01;

  type Group = { cur: number; prev: number; items: Map<string, [number, number]> };
  const grouped = (view: ViewKey): [string, Group][] => {
    const out = new Map<string, Group>();
    for (const r of data.views[view]?.rows ?? []) {
      const cur = sum(r.d.slice(split)), prev = sum(r.d.slice(0, split));
      let g = out.get(r.k[0]);
      if (!g) out.set(r.k[0], (g = { cur: 0, prev: 0, items: new Map() }));
      g.cur += cur;
      g.prev += prev;
      let it = g.items.get(r.k[1]);
      if (!it) g.items.set(r.k[1], (it = [0, 0]));
      it[0] += cur;
      it[1] += prev;
    }
    return [...out].sort((a, b) => b[1].cur - a[1].cur);
  };

  const breakdown = (view: ViewKey, keyName: string, childName: string, children = "services",
    label?: (k: string, names: Record<string, string>) => string, limit?: number) => {
    const names = data.views[view]?.names ?? {};
    const out: Record<string, unknown>[] = [];
    for (const [k, g] of grouped(view)) {
      if (!keep(g.cur, g.prev)) continue;
      const row: Record<string, unknown> = { [keyName]: label ? label(k, names) : k };
      if (label) row.id = k;
      else if (names[k]) row.name = names[k];
      Object.assign(row, entry(g.cur, g.prev));
      const kids = [...g.items].filter(([, [cc, p]]) => keep(cc, p))
        .map(([c, [cc, p]]) => ({ [childName]: c, ...entry(cc, p) }))
        .sort((a, b) => b.current - a.current);
      row[children] = limit ? kids.slice(0, limit) : kids;
      if (limit && kids.length > limit) {
        row["other_" + children] = { count: kids.length - limit, current: money(sum(kids.slice(limit).map(c => c.current))) };
      }
      out.push(row);
    }
    return out;
  };

  const services = grouped("service");
  grand = sum(services.map(([, g]) => g.cur));
  const grandPrev = sum(services.map(([, g]) => g.prev));

  const lineItems: LineItem[] = [];
  for (const [svc, g] of services) {
    for (const [meter, [cur, prev]] of g.items) if (keep(cur, prev)) lineItems.push({ service: svc, meter, ...entry(cur, prev) });
  }
  lineItems.sort((a, b) => b.current - a.current);

  const growing = lineItems
    .filter(x => x.change >= Math.max(rate, grand * 0.005) && (x.change_pct === null || x.change_pct > 20))
    .sort((a, b) => b.change - a.change);
  const growers = growing.slice(0, 10);
  const drops = lineItems // a refund (negative now) is a credit, not a saving: it goes in credits_and_refunds
    .filter(x => x.current > -0.01 && x.change <= -Math.max(rate, grand * 0.005) && (x.change_pct ?? 0) < -20)
    .sort((a, b) => a.change - b.change).slice(0, 10);

  // worth a look: news (what changed) takes turns with to-dos (what to fix), each sorted by its own dollars
  const hint = (kind: Hint["kind"], x: LineItem, amount: number, extra: Partial<Hint> = {}): Hint => ({
    kind, service: x.service, meter: x.meter, current: x.current, previous: x.previous, change: x.change,
    amount: money(amount), ...extra,
  });

  const flags: Summary["flags"] = [];
  let todos: Hint[] = [];
  for (const x of lineItems) { // biggest first
    const why = pit(x.service, x.meter, x.current / n * 30.4 / rate); // the rules are in US dollars
    if (why && x.current >= grand * 0.002) {
      flags.push({ service: x.service, meter: x.meter, current: x.current, reason: why });
      todos.push(hint("pit", x, x.current, { reason: why }));
    }
  }
  const K = (s: string, m: string) => s + "\u0000" + m;
  const items = new Map(lineItems.map(x => [K(x.service, x.meter), x]));
  const spiked = new Map<string, Hint>();
  for (const r of data.views.service?.rows ?? []) {
    const s = spike(r.d, split, Math.max(10 * rate, grand * 0.0025));
    const x = items.get(K(r.k[0], r.k[1]));
    if (s && x && x.current > 0) { // a charge refunded in full is no news
      spiked.set(K(r.k[0], r.k[1]), hint("spike", x, s.excess, { date: days[s.day], day_cost: money(r.d[s.day]), usual: money(s.usual) }));
    }
  }
  const advisor = data.advisor ? data.advisor.map(rec => linkTip(rec, lineItems, n)) : null;
  // steady spend is Advisor's job when it's there: it prices the saving and knows what's already reserved
  const advisorHasCommitments = !!advisor?.length && !data.advisor_error && advisor.some(r => commitmentKinds(r).length);
  if (!advisorHasCommitments && data.metric !== "AmortizedCost") { // amortized, reserved usage looks flat too
    todos = todos.concat(steady(data, new Set(lineItems.map(x => K(x.service, x.meter))), n, rate));
  }
  todos = todos.concat(alwaysOn(data, Math.max(10 * rate, grand * 0.002)), idle(data, rate)).sort((a, b) => b.amount - a.amount);
  const flagged = new Set(flags.map(f => K(f.service, f.meter)));
  const news = [...spiked.values(),
    ...growing.filter(x => !flagged.has(K(x.service, x.meter)) && !spiked.has(K(x.service, x.meter))).map(x => hint("grower", x, x.change)),
  ].sort((a, b) => b.amount - a.amount);
  const hints = zipLongest(news, todos);

  const daily = new Array(days.length).fill(0);
  for (const r of data.views.service?.rows ?? []) r.d.forEach((v, i) => (daily[i] += v));

  const tagView = data.views.tag;
  const byTag = tagView ? breakdown("tag", "value", "service") : null;
  for (const row of byTag ?? []) {
    if (row.value === "") Object.assign(row, { value: "(untagged)", untagged: true }); // flagged: a real "(untagged)" value stays apart
  }

  return {
    tool: "azcost",
    instructions_for_ai: AI_INSTRUCTIONS,
    generated: data.generated,
    metric: data.metric ?? "ActualCost",
    currency: data.mixed_currencies ? "mixed" : data.currency ?? "USD",
    currencies: data.mixed_currencies ?? [data.currency ?? "USD"],
    usd_rate: data.usd_rate ?? null,
    subscriptions: (data.subscriptions ?? []).map(({ tenant: _t, ...s }) => s), // the tenant isn't needed there
    demo_data: !!data.demo,
    period: {
      current: { start: days[split], end: days[days.length - 1], days: n },
      previous: { start: days[0], end: days[split - 1], days: split },
    },
    totals: {
      ...entry(grand, grandPrev), daily_avg: money(grand / n), monthly_pace: money(grand / n * 30.4),
      credits_and_refunds: money(sum(lineItems.map(x => Math.min(x.current, 0)))),
    },
    by_service: services.filter(([, g]) => keep(g.cur, g.prev)).map(([k, g]) => ({ service: k, ...entry(g.cur, g.prev) })),
    by_subscription: breakdown("subscription", "subscription_id", "service"),
    by_region: breakdown("region", "region", "service"),
    by_resource_group: breakdown("resource", "resource_group", "resource_id", "resources", (k, names) => names[k] ?? k, TOP_RESOURCES),
    tag: tagView?.tag ?? null,
    by_tag: byTag,
    top_growers: growers,
    top_drops: drops,
    flags,
    hints,
    advisor,
    advisor_error: data.advisor_error ?? null,
    resource_fallback: data.resource_fallback ?? [],
    graph_error: data.graph_error ?? null,
    forecast: data.forecast ?? null,
    line_items: lineItems,
    daily_totals: days.map((d, i) => ({ date: d, cost: money(daily[i]) })),
  };
}
