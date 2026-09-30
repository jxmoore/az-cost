// Reading costs: the Cost Management, forecast, tag, Advisor and Resource Graph calls, folded into one run's data.
import { fold, type RawEntry } from "../core/pack";
import type { AdvisorRec, Budget, CostData, Dim, Forecast, GraphFinding, Metric, SubInfo, ViewData, ViewKey } from "../core/types";
import { periodDays, type Period } from "../core/period";
import { localToday, monthEnd } from "../core/types";
import { Azure, AzureError, Cancelled, TooManyPages, type Log } from "./client";

const API_VERSION = "2025-03-01"; // Microsoft.CostManagement/query
const MAX_RESOURCE_PAGES = 10; // past this, the resource view reads one total per resource and period instead of daily rows
// What to sum, in order of preference. Some scopes reject USD columns, and older offers only know PreTaxCost.
const AGGREGATIONS = [["Cost", "CostUSD"], ["Cost"], ["PreTaxCost", "PreTaxCostUSD"], ["PreTaxCost"]];
// A 400 about those columns names the aggregation or a column. "Cost" alone isn't enough: "Cost Management is not
// supported for this offer" and "not registered for Microsoft.CostManagement" are not about columns.
const COLUMN_ERROR = /aggregation|column|costusd|pretaxcost|\bcost\b(?!\s*management)/i;

// Each view is outer box -> inner box. A query can group by two dimensions at most, so the
// subscription view is not queried: every query runs per subscription and the service query feeds it too.
export const VIEWS: Record<Exclude<ViewKey, "tag" | "type">, [Dim, Dim]> = { // the type view is derived, not read
  service: ["ServiceName", "Meter"],
  subscription: ["SubscriptionId", "ServiceName"],
  region: ["ResourceLocation", "ServiceName"],
  resource: ["ResourceGroupName", "ResourceId"],
};

type FetchedView = Exclude<ViewKey, "type">;

export interface Subscription { id: string; name: string; state: string; tenant: string | null }
export interface Target { id: string; name: string; scope: string; tenant: string | null }

// ---------------------------------------------------------------- subscriptions

/** Every subscription the token can see, straight from ARM: only that token's tenant. */
export async function listSubscriptions(az: Azure): Promise<Subscription[]> {
  const subs: Subscription[] = [];
  let url: string | undefined = "/subscriptions?api-version=2022-12-01";
  while (url) {
    const page: any = await az.call("GET", url);
    for (const s of page.value ?? []) subs.push({ id: s.subscriptionId, name: s.displayName, state: s.state, tenant: s.tenantId ?? null });
    url = page.nextLink;
  }
  return subs.sort((a, b) => a.name.localeCompare(b.name));
}

export const subscriptionTarget = (s: Pick<Subscription, "id" | "name" | "tenant">): Target =>
  ({ id: s.id, name: s.name, scope: `/subscriptions/${s.id}`, tenant: s.tenant });

export function scopeTarget(scope: string): Target {
  scope = "/" + scope.replace(/^\/+|\/+$/g, "");
  return { id: scope, name: scope, scope, tenant: null };
}

// ---------------------------------------------------------------- one query

type QueryRow = Record<string, any>;
type Grouping = string | { type: string; name: string };

/** One Cost Management query. `start` and `end` are ISO dates, both inclusive. With granularity null, Azure
 * sums each group over the whole period: one row per group instead of one per group per day.
 * Returns every row of every page as an object keyed by column name. */
async function query(az: Azure, scope: string, start: string, end: string, groupings: Grouping[], metric: Metric,
  aggs: string[], opts: { maxPages?: number; granularity?: "Daily" | null } = {}): Promise<QueryRow[]> {
  const dataset: any = {
    aggregation: Object.fromEntries(aggs.map(a => [`total${a}`, { name: a, function: "Sum" }])),
    grouping: groupings.map(g => (typeof g === "string" ? { type: "Dimension", name: g } : g)),
  };
  const granularity = opts.granularity === undefined ? "Daily" : opts.granularity;
  if (granularity) dataset.granularity = granularity;
  const body = { type: metric, timeframe: "Custom", timePeriod: { from: `${start}T00:00:00Z`, to: `${end}T23:59:59Z` }, dataset };
  let url: string | undefined = `${scope}/providers/Microsoft.CostManagement/query?api-version=${API_VERSION}`;
  const rows: QueryRow[] = [];
  let pages = 0;
  while (url) {
    pages++;
    if (opts.maxPages && pages > opts.maxPages) throw new TooManyPages(`more than ${opts.maxPages} pages`);
    const props: any = (await az.call("POST", url, body)).properties ?? {};
    const cols: string[] = (props.columns ?? []).map((c: any) => c.name);
    if (cols.length && !cols.includes(aggs[0])) {
      throw new AzureError(200, `Cost Management answered without a ${aggs[0]} column (columns: ${cols.join(", ")})`);
    }
    for (const r of props.rows ?? []) rows.push(Object.fromEntries(cols.map((c, i) => [c, r[i]])));
    url = props.nextLink || undefined;
  }
  return rows;
}

// ---------------------------------------------------------------- tags, forecast, Resource Graph, Advisor

const TAG_NAMES_API = "2021-04-01";

/** The tag the tag view splits the bill by: the one asked for, or else the tag on the most resources across the
 * subscriptions. Azure's own hidden-* tags (hidden-link, hidden-title) don't count. null when there's none. */
async function chooseTag(az: Azure, targets: Target[], wanted: string | null, log: Log): Promise<string | null> {
  if (wanted) return wanted;
  const counts = new Map<string, number>(), spelling = new Map<string, string>();
  for (const t of targets) {
    const sub = /^\/subscriptions\/([^/]+)/i.exec(t.scope);
    if (!sub) continue; // tag names are listed per subscription; other scopes need an explicit tag
    let url: string | undefined = `/subscriptions/${sub[1]}/tagNames?api-version=${TAG_NAMES_API}`;
    try {
      while (url) {
        const page: any = await az.call("GET", url);
        for (const item of page.value ?? []) {
          const name: string = item.tagName || "";
          if (name && !name.toLowerCase().startsWith("hidden-")) {
            if (!spelling.has(name.toLowerCase())) spelling.set(name.toLowerCase(), name);
            counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + (item.count?.value || 0));
          }
        }
        url = page.nextLink;
      }
    } catch (e) {
      if (!(e instanceof AzureError)) throw e;
      const fix = e.status === 401 ? "sign in again" : "name a tag to choose one";
      log(`  ${t.name}: couldn't list its tags (HTTP ${e.status}); ${fix}`);
    }
  }
  if (!counts.size) return null;
  const best = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0]; // most resources, then by name
  return spelling.get(best)!;
}

/** Azure's own forecast for this calendar month: what's billed so far and what's still to come, each summed,
 * and the currencies it answered in. null when Azure has no forecast (new subscriptions, some offers). */
async function monthForecast(az: Azure, target: Target, metric: Metric, today: string, column = "Cost") {
  const first = today.slice(0, 8) + "01", last = monthEnd(today);
  const body = {
    type: metric, timeframe: "Custom",
    timePeriod: { from: `${first}T00:00:00Z`, to: `${last}T23:59:59Z` },
    dataset: { granularity: "Daily", aggregation: { totalCost: { name: column, function: "Sum" } } },
    includeActualCost: true, includeFreshPartialCost: false,
  };
  let url: string | undefined = `${target.scope}/providers/Microsoft.CostManagement/forecast?api-version=${API_VERSION}`;
  const sums: Record<string, number> = { Actual: 0, Forecast: 0 }, currencies = new Set<string>();
  let rows = 0;
  while (url) {
    const props: any = (await az.call("POST", url, body)).properties ?? {};
    const cols: string[] = (props.columns ?? []).map((c: any) => c.name);
    if (cols.length && !cols.includes(column)) { // summing a missing column would show a $0 forecast as if it were real
      throw new AzureError(200, `the forecast answered without a ${column} column (columns: ${cols.join(", ")})`);
    }
    for (const values of props.rows ?? []) {
      const r = Object.fromEntries(cols.map((c, i) => [c, values[i]]));
      if (r.CostStatus in sums) {
        sums[r.CostStatus] += r[column] || 0;
        currencies.add(r.Currency);
        rows++;
      }
    }
    url = props.nextLink || undefined;
  }
  return rows ? { actual: sums.Actual, forecast: sums.Forecast, currencies } : null;
}

const GRAPH_API = "2022-10-01";
const MAX_GRAPH_ROWS = 5000;
// Resources that bill while doing nothing. One pass with case(): Resource Graph caps how many unions a query may have.
const IDLE_QUERY = `resources
| extend check = case(
    type =~ 'microsoft.compute/virtualmachines' and tostring(properties.extended.instanceView.powerState.code) =~ 'PowerState/stopped', 'stopped-vm',
    type =~ 'microsoft.compute/disks' and tostring(properties.diskState) =~ 'Unattached', 'unattached-disk',
    type =~ 'microsoft.network/publicipaddresses' and isempty(tostring(properties.ipConfiguration.id)) and isempty(tostring(properties.natGateway.id)), 'unused-ip',
    type =~ 'microsoft.compute/snapshots' and todatetime(properties.timeCreated) < ago(90d), 'old-snapshot',
    type =~ 'microsoft.web/serverfarms' and toint(properties.numberOfSites) == 0, 'empty-plan',
    type =~ 'microsoft.network/natgateways' and coalesce(array_length(properties.subnets), 0) == 0, 'lonely-nat',
    '')
| where check != ''
| project check, id = tolower(id), name, resourceGroup, subscriptionId`;

// What's attached to each VM: its disks and NICs, and each NIC's public IPs. The cost data can't tell (a disk is a
// resource of its own), so opening a VM shows these from here. Ids are pulled out of the properties client-side.
const RELATED_QUERY = `resources
| where type =~ 'microsoft.compute/virtualmachines' or type =~ 'microsoft.network/networkinterfaces'
| project id = tolower(id), kind = tolower(type),
    osDisk = properties.storageProfile.osDisk.managedDisk.id, dataDisks = properties.storageProfile.dataDisks,
    nics = properties.networkProfile.networkInterfaces, ipConfigs = properties.ipConfigurations`;
const MAX_RELATED_ROWS = 20000;

/** VM id -> the ids of its disks, NICs and the NICs' public IPs. Nothing (not an error) when Resource Graph says no:
 * VMs then just aren't opened past their meters. */
async function relatedResources(az: Azure, targets: Target[], log: Log): Promise<Record<string, string[]> | null> {
  const subs = [...new Set(targets.map(t => /^\/subscriptions\/([^/]+)/i.exec(t.scope)?.[1]).filter((s): s is string => !!s))];
  const vms = new Map<string, string[]>(), nicIps = new Map<string, string[]>();
  const ids = (xs: unknown, pick: (x: any) => unknown) => (Array.isArray(xs) ? xs : []).map(pick).filter((x): x is string => typeof x === "string" && !!x).map(x => x.toLowerCase());
  let options: Record<string, unknown> = { resultFormat: "objectArray", $top: 1000 }, rows = 0;
  try {
    while (rows < MAX_RELATED_ROWS) {
      const page: any = await az.call("POST", `/providers/Microsoft.ResourceGraph/resources?api-version=${GRAPH_API}`,
        { subscriptions: subs, query: RELATED_QUERY, options });
      for (const r of page.data ?? []) {
        rows++;
        if (r.kind === "microsoft.network/networkinterfaces") nicIps.set(r.id, ids(r.ipConfigs, c => c?.properties?.publicIPAddress?.id));
        else vms.set(r.id, [...ids([r.osDisk], x => x), ...ids(r.dataDisks, d => d?.managedDisk?.id), ...ids(r.nics, n => n?.id)]);
      }
      if (!page.$skipToken) break;
      options = { ...options, $skipToken: page.$skipToken };
    }
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    log(`  skipped what's attached to VMs (${(e as Error).message})`);
    return null;
  }
  const out: Record<string, string[]> = {};
  for (const [vm, parts] of [...vms].sort(([a], [b]) => (a < b ? -1 : 1))) { // sorted: the same bill gives the same data
    out[vm] = [...new Set(parts.flatMap(p => [p, ...(nicIps.get(p) ?? [])]))];
  }
  return out;
}

/** What IDLE_QUERY finds in Azure Resource Graph, for all the subscriptions in one query, at most MAX_GRAPH_ROWS
 * rows. When it says no, returns nothing and the failure's status: the cost data alone is still worth a page. */
async function graphFindings(az: Azure, targets: Target[], log: Log): Promise<[GraphFinding[], string | null]> {
  const subs: string[] = [];
  for (const t of targets) {
    const sub = /^\/subscriptions\/([^/]+)/i.exec(t.scope); // Resource Graph wants the subscription's id, not the path
    if (sub && !subs.includes(sub[1])) subs.push(sub[1]);
  }
  const found: GraphFinding[] = [];
  let options: Record<string, unknown> = { resultFormat: "objectArray", $top: 1000 };
  try {
    while (found.length < MAX_GRAPH_ROWS) {
      const page: any = await az.call("POST", `/providers/Microsoft.ResourceGraph/resources?api-version=${GRAPH_API}`,
        { subscriptions: subs, query: IDLE_QUERY, options });
      for (const row of page.data ?? []) {
        found.push({ check: row.check, id: row.id, name: row.name, resourceGroup: row.resourceGroup, subscriptionId: row.subscriptionId });
      }
      if (!page.$skipToken) break;
      options = { ...options, $skipToken: page.$skipToken };
    }
  } catch (e) {
    if (e instanceof Cancelled) throw e;
    // keep only the status: Azure's 403 text names the caller, and this lands in the AI export
    const error = e instanceof AzureError ? `HTTP ${e.status}` : (e as Error).name;
    log(`  skipped the Resource Graph checks (${(e as Error).message}). Reader on the subscription fixes access errors.`);
    return [found.slice(0, MAX_GRAPH_ROWS), error];
  }
  return [found.slice(0, MAX_GRAPH_ROWS), null];
}

const BUDGETS_API = "2023-05-01";

/** A subscription's cost budgets, with Azure's own spend and forecast for each budget's current period (so they
 * match the portal whatever period the run reads). Usage budgets (quantities, not money) are left out. */
async function budgetsFor(az: Azure, target: Target): Promise<Budget[]> {
  const out: Budget[] = [];
  let url: string | undefined = `${target.scope}/providers/Microsoft.Consumption/budgets?api-version=${BUDGETS_API}`;
  while (url) {
    const page: any = await az.call("GET", url);
    for (const b of page.value ?? []) {
      const p = b.properties ?? {};
      if (p.category && p.category !== "Cost") continue;
      const f = p.filter ?? {};
      out.push({
        name: b.name, subscription: target.name, subscription_id: target.id, amount: Number(p.amount) || 0,
        time_grain: p.timeGrain ?? "Monthly",
        current: p.currentSpend?.amount ?? null, forecast: p.forecastSpend?.amount ?? null,
        currency: p.currentSpend?.unit ?? p.forecastSpend?.unit ?? null,
        filtered: !!(f.dimensions || f.tags || f.and || f.or || f.not), // it covers part of the subscription only
      });
    }
    url = page.nextLink;
  }
  return out;
}

/** Azure Advisor's cost recommendations for one subscription, one per (kind, resource, SKU, region).
 * Advisor lists each reservation once per term and look-back period; keep the biggest saving. */
async function advisorRecs(az: Azure, target: Target): Promise<AdvisorRec[]> {
  const flt = encodeURIComponent("Category eq 'Cost'").replaceAll("'", "%27");
  let url: string | undefined = `${target.scope}/providers/Microsoft.Advisor/recommendations?api-version=2023-01-01&$filter=${flt}`;
  const best = new Map<string, AdvisorRec>();
  while (url) {
    const page: any = await az.call("GET", url);
    for (const item of page.value ?? []) {
      const [key, rec] = advisorRec(item.properties ?? {}, target);
      const had = best.get(key);
      if (!had || (rec.annual_savings ?? 0) > (had.annual_savings ?? 0)) best.set(key, rec);
    }
    url = page.nextLink;
  }
  return [...best.values()].sort((a, b) => (b.annual_savings ?? -1) - (a.annual_savings ?? -1));
}

function advisorRec(p: any, target: Target): [string, AdvisorRec] {
  const ext = p.extendedProperties ?? {}, short = p.shortDescription ?? {};
  const resource: string = (p.resourceMetadata?.resourceId ?? "").toLowerCase();
  const savings = ext.annualSavingsAmount;
  const name: string = p.impactedValue || resource.split("/").pop() || "";
  const rec: AdvisorRec = {
    problem: short.problem ?? "",
    solution: short.solution ?? "",
    impact: p.impact ?? null,
    resource,
    resource_name: name.toLowerCase() === target.id.toLowerCase() ? target.name : name,
    resource_type: p.impactedField ?? null,
    sku: ext.displaySKU || ext.sku || ext.targetSku || null,
    term: ext.term ?? null,
    region: ext.region || ext.location || null, // a reservation is per region
    annual_savings: savings === undefined || savings === null || savings === "" ? null : Number(savings),
    currency: ext.savingsCurrency ?? null,
    subscription: target.name,
  };
  return [JSON.stringify([p.recommendationTypeId, resource, rec.sku, rec.region]), rec];
}

// ---------------------------------------------------------------- reading costs

/** UsageDate arrives as 20260930 (a number) or as '2026-09-30T00:00:00'. Return 'yyyymmdd'. */
const usageDay = (v: unknown) => { const s = String(v); return s.includes("-") ? s.slice(0, 10).replaceAll("-", "") : s.slice(0, 8); };

/** The resource group's ARM id, or the subscription's for resources outside any group.
 * Keying on the id keeps two `rg-app` groups in different subscriptions apart. */
export function groupKey(scope: string, rg: string, resourceId: string): string {
  const m = /^\/subscriptions\/[^/]+/i.exec(resourceId || "");
  const sub = m ? m[0].toLowerCase() : scope.toLowerCase();
  return rg ? `${sub}/resourcegroups/${rg.toLowerCase()}` : sub;
}

const serviceOf = (r: QueryRow) => r.ServiceName || "(no service)";

export interface FetchOptions {
  period: Period; // what to read, and what to compare it with
  metric: Metric;
  advisor: boolean;
  graph: boolean;
  tag: string | null;
  today?: string;
  concurrency?: number; // subscriptions read at once
}

/** What a run is still reading, for the page to say while it shows what's already there. */
export type Pending = "resources" | "regions" | "tags" | "forecast" | "detail" | "budgets" | "Advisor" | "idle checks";
export type OnUpdate = (data: CostData, pending: Pending[]) => void;

// Cost Management throttles per subscription and per tenant: a few at once is faster, many at once only waits
const CONCURRENCY = 3;
// resources x meters, as two period totals: past this many pages a query's detail is left out (the views still work)
const DETAIL_PAGES = 40;

/** Run `fn` over `items`, at most `n` at a time. The first failure stops new work and is thrown. */
async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0, failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try { await fn(items[i], i); } catch (e) { failed = true; throw e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

type ForecastResult = NonNullable<Awaited<ReturnType<typeof monthForecast>>>;

/** Read a run's costs. Subscriptions are read a few at a time and in stages (services first, so the map can draw,
 * then resources, then regions, tags and the forecast, then Advisor and the idle checks). `onUpdate` gets the data
 * after each stage; a view is in it once every subscription's part of it is, so no view shows half a bill.
 * Each subscription's results are kept apart and joined in order, so the same bill always gives the same data. */
export async function fetchCosts(az: Azure, targets: Target[], o: FetchOptions, log: Log, onUpdate?: OnUpdate): Promise<CostData> {
  const today = o.today ?? localToday(), p = o.period;
  const { days: dates, split } = periodDays(p); // the previous period's days, then the current's
  const index = new Map(dates.map((d, i) => [d.replaceAll("-", ""), i]));
  const twins = new Map<string, number>();
  for (const t of targets) twins.set(t.name, (twins.get(t.name) ?? 0) + 1);
  targets = targets.map(t => (twins.get(t.name)! > 1 ? { ...t, name: `${t.name} (${t.id.slice(0, 8)})` } : t)); // "Pay-As-You-Go" twice
  const n = targets.length, concurrency = o.concurrency ?? CONCURRENCY;

  // per subscription, in target order
  const raw = targets.map(() => ({ service: [], subscription: [], region: [], resource: [], tag: [] } as Record<FetchedView, RawEntry[]>));
  const resourceNames = targets.map(() => ({} as Record<string, string>));
  const subs: (SubInfo | undefined)[] = new Array(n), fallback: boolean[] = new Array(n).fill(false);
  const forecasts: ({ f: ForecastResult | null; why: string } | undefined)[] = new Array(n);
  const recs: AdvisorRec[][] = targets.map(() => []);
  const budgets: Budget[][] = targets.map(() => []);
  const detailRaw: RawEntry[][] = targets.map(() => []); // [[resource id, meter id], 0 previous | 1 current, cost, USD]
  const meterNames = targets.map(() => new Map<string, { service: string; meter: string }>());
  const regionOf = targets.map(() => new Map<string, string>()), tagOf = targets.map(() => new Map<string, string>());
  let detailNote: string | null = null;
  let budgetError: string | null = null;
  const columns = new Map<string, string[][]>(); // target id -> cost columns that target accepts, best first
  const settled = new Set<string>(); // targets whose columns a query has already worked with
  const done = { resources: false, regions: false, detail: false, budgets: false, advisor: false, graph: false };
  let tag: string | null = null, tagDone = false, advisorError: string | null = null;
  let findings: GraphFinding[] | null = null, graphError: string | null = null, related: Record<string, string[]> | null = null;

  const run = async (t: Target, groupings: Grouping[], opts: { start?: string; end?: string; maxPages?: number; granularity?: null } = {}) => {
    if (!columns.has(t.id)) columns.set(t.id, AGGREGATIONS.map(a => [...a]));
    const aggs = columns.get(t.id)!;
    for (;;) {
      try {
        const rows = await query(az, t.scope, opts.start ?? dates[0], opts.end ?? dates[dates.length - 1], groupings, o.metric, aggs[0], opts);
        settled.add(t.id);
        return rows;
      } catch (e) {
        // step down only when Azure objects to the cost columns, and only until a query has worked: after
        // that the columns are known good, and a 400 (a tag it can't group by) is that query's own problem
        if (!(e instanceof AzureError) || e.status !== 400 || aggs.length === 1 || !COLUMN_ERROR.test(e.message) || settled.has(t.id)) throw e;
        aggs.shift();
      }
    }
  };

  /** `day` is set for period totals, which have no UsageDate: they land on their period's first day. */
  const amounts = (r: QueryRow): [number, number | null | undefined] =>
    ["Cost" in r ? r.Cost || 0 : r.PreTaxCost || 0, "CostUSD" in r ? r.CostUSD : r.PreTaxCostUSD];
  const add = (i: number, view: FetchedView, key: [string, string], r: QueryRow, day?: number) => {
    const d = day ?? index.get(usageDay(r.UsageDate));
    if (d === undefined) return;
    raw[i][view].push([key, d, ...amounts(r)]);
  };

  // ---- the stages
  const services = async (t: Target, i: number) => {
    log(`  ${t.name}: services ...`);
    const currencies = new Map<string, number>();
    for (const r of await run(t, VIEWS.service)) {
      currencies.set(r.Currency, (currencies.get(r.Currency) ?? 0) + 1);
      add(i, "service", [serviceOf(r), r.Meter || "(no meter)"], r);
      add(i, "subscription", [t.id, serviceOf(r)], r);
    }
    const top = [...currencies].sort((a, b) => b[1] - a[1]).find(([c]) => c);
    subs[i] = { id: t.id, name: t.name, currency: top ? top[0] : null, tenant: t.tenant }; // portal links open this tenant
  };
  const resources = async (t: Target, i: number) => {
    log(`  ${t.name}: resources ...`);
    let rows: [QueryRow, number | undefined][];
    try {
      rows = (await run(t, VIEWS.resource, { maxPages: MAX_RESOURCE_PAGES })).map(r => [r, undefined]);
    } catch (e) {
      if (!(e instanceof TooManyPages)) throw e;
      // too many resources x days: read one total per resource and period instead (two small queries)
      log(`  ${t.name}: too many resources for daily detail, reading period totals instead`);
      const prev = await run(t, VIEWS.resource, { start: p.prev[0], end: p.prev[1], granularity: null });
      const cur = await run(t, VIEWS.resource, { start: p.cur[0], end: p.cur[1], granularity: null });
      rows = [...prev.map(r => [r, 0] as [QueryRow, number]), ...cur.map(r => [r, split] as [QueryRow, number])];
      fallback[i] = true;
    }
    for (const [r, day] of rows) {
      const rg: string = r.ResourceGroupName || "", rid: string = (r.ResourceId || "").toLowerCase();
      const key = groupKey(t.scope, rg, rid);
      const label = rg || "(no resource group)";
      resourceNames[i][key] = n > 1 ? `${label} · ${t.name}` : label;
      add(i, "resource", [key, rid || "(no resource)"], r, day);
    }
  };
  let tagFailed = false;
  const details = async (t: Target, i: number) => {
    log(`  ${t.name}: regions ...`);
    for (const r of await run(t, VIEWS.region)) add(i, "region", [(r.ResourceLocation || "").toLowerCase(), serviceOf(r)], r);
    if (tag && !tagFailed) {
      log(`  ${t.name}: tag ${tag} ...`);
      try {
        for (const r of await run(t, [{ type: "TagKey", name: tag }, "ServiceName"])) {
          add(i, "tag", [r.TagValue || "", serviceOf(r)], r); // no value: spend on untagged resources
        }
      } catch (e) {
        if (!(e instanceof AzureError)) throw e;
        log(`  ${t.name}: skipped the tag view (${e.message})`);
        tagFailed = true; // without this target's part it wouldn't add up to the bill
      }
    }
    log(`  ${t.name}: forecast ...`);
    let f: ForecastResult | null = null, why = "Azure has none";
    try {
      f = await monthForecast(az, t, o.metric, today, columns.get(t.id)![0][0]);
    } catch (e) {
      if (!(e instanceof AzureError)) throw e;
      why = `HTTP ${e.status}`;
    }
    forecasts[i] = { f, why };
  };
  const withAdvisor = targets.filter(t => t.scope.toLowerCase().startsWith("/subscriptions/")); // Advisor is per subscription
  const advisor = async (t: Target, i: number) => {
    log(`  ${t.name}: Advisor ...`);
    try {
      recs[i] = await advisorRecs(az, t);
    } catch (e) { // Advisor needs Reader; cost data alone is still worth a page
      if (e instanceof Cancelled) throw e;
      advisorError = e instanceof AzureError ? `HTTP ${e.status}` : (e as Error).name; // not the text: it names the caller
      log(`  ${t.name}: skipped Advisor (${(e as Error).message}). Reader on the subscription fixes access errors.`);
    }
  };

  /** What each resource spent on each meter, per period, and what the meters are: drilling from anything into
   * anything filters these. Too big (or refused) leaves the detail out with a note; the views don't need it. */
  const detail = async (t: Target, i: number) => {
    log(`  ${t.name}: detail ...`);
    const whole = { granularity: null, maxPages: DETAIL_PAGES } as const;
    const meter = (id: unknown) => {
      const key = String(id ?? "").toLowerCase();
      let m = meterNames[i].get(key);
      if (!m) meterNames[i].set(key, (m = { service: "(no service)", meter: "(no meter)" }));
      return m;
    };
    try {
      for (const r of await run(t, ["MeterId", "Meter"], whole)) meter(r.MeterId).meter = r.Meter || "(no meter)";
      for (const r of await run(t, ["MeterId", "ServiceName"], whole)) meter(r.MeterId).service = serviceOf(r);
      // each resource's region and tag value, so the region and tag views can be drilled into too
      for (const r of await run(t, ["ResourceId", "ResourceLocation"], whole)) {
        if (r.ResourceId) regionOf[i].set(r.ResourceId.toLowerCase(), (r.ResourceLocation || "").toLowerCase());
      }
      if (tag && !tagFailed) {
        for (const r of await run(t, [{ type: "TagKey", name: tag }, "ResourceId"], whole)) {
          if (r.ResourceId && r.TagValue) tagOf[i].set(r.ResourceId.toLowerCase(), r.TagValue);
        }
      }
      for (const [slot, [start, end]] of [[0, p.prev], [1, p.cur]] as const) {
        for (const r of await run(t, ["ResourceId", "MeterId"], { ...whole, start, end })) {
          const rid = (r.ResourceId || "").toLowerCase() || `/subscriptions/${t.id.toLowerCase()}`; // charged to no resource
          const [cost, costUsd] = amounts(r);
          detailRaw[i].push([[rid, String(r.MeterId ?? "").toLowerCase()], slot, cost, costUsd]);
        }
      }
    } catch (e) {
      if (!(e instanceof TooManyPages) && !(e instanceof AzureError)) throw e;
      detailRaw[i] = [];
      detailNote = e instanceof TooManyPages ? "too many resources and meters to read the detail" : `the detail couldn't be read (HTTP ${e.status})`;
      log(`  ${t.name}: skipped the detail (${e.message})`);
    }
  };
  const budget = async (t: Target, i: number) => {
    log(`  ${t.name}: budgets ...`);
    try {
      budgets[i] = await budgetsFor(az, t);
    } catch (e) { // budgets need Cost Management Reader or Reader, like the costs; say so and go on without them
      if (e instanceof Cancelled) throw e;
      budgetError = e instanceof AzureError ? `HTTP ${e.status}` : (e as Error).name;
      log(`  ${t.name}: skipped budgets (${(e as Error).message}).`);
    }
  };

  /** The data as far as it's read. */
  function assemble(): CostData {
    const known = subs.filter((s): s is SubInfo => !!s);
    const all = (view: FetchedView) => raw.flatMap(r => r[view]);
    const found = new Set(known.map(s => s.currency).filter((c): c is string => !!c));
    // USD only if every row has a USD figure: a subscription may have answered in its billing currency alone
    const usd = found.size > 1 && raw.every(r => Object.values(r).every(entries => entries.every(e => e[3] !== null && e[3] !== undefined)));
    const mixed = found.size > 1 && !usd ? [...found].sort() : null; // the page and export say so; nothing converts them
    const currency = usd || !found.size ? "USD" : [...found].sort()[0];
    // units of the bill's currency per US dollar, from rows that carry both: the $ thresholds in the rules use it
    const paired = all("service").filter(e => e[3]).map(e => [e[2], e[3] as number]);
    let usdRate: number | null = null;
    const pairedUsd = paired.reduce((s, [, u]) => s + u, 0);
    if (currency === "USD") usdRate = 1;
    else if (!mixed && pairedUsd) usdRate = Math.round(1e4 * paired.reduce((s, [c]) => s + c, 0) / pairedUsd) / 1e4;

    let forecast: Forecast | null = null, forecastNote: string | null = null;
    if (done.regions) { // the forecast is read with the regions
      const missing = targets.map((t, i) => (forecasts[i]!.f ? null : `${t.name} (${forecasts[i]!.why})`)).filter(Boolean);
      const billedIn = new Set<string>();
      for (const x of forecasts) for (const c of x!.f?.currencies ?? []) if (c) billedIn.add(c);
      if (missing.length) forecastNote = "no forecast for " + missing.join(", ");
      else if ([...billedIn].some(c => c !== currency)) {
        forecastNote = `the forecast came in a different currency (${[...billedIn].sort().join(", ")}) than the bill (${currency})`;
      } else {
        const actual = Math.round(100 * forecasts.reduce((s, x) => s + x!.f!.actual, 0)) / 100;
        const rest = Math.round(100 * forecasts.reduce((s, x) => s + x!.f!.forecast, 0)) / 100;
        forecast = { month: today.slice(0, 7), actual, forecast: rest, total: Math.round(100 * (actual + rest)) / 100 };
      }
    }

    const views: Partial<Record<ViewKey, ViewData>> = {};
    const names: Record<string, Record<string, string>> = {
      service: {}, subscription: Object.fromEntries(known.map(s => [s.id, s.name])),
      region: {}, resource: Object.assign({}, ...resourceNames),
    };
    const ready: Record<keyof typeof VIEWS, boolean> = { service: true, subscription: true, region: done.regions, resource: done.resources };
    for (const v of Object.keys(VIEWS) as (keyof typeof VIEWS)[]) {
      if (ready[v]) views[v] = { dims: VIEWS[v], names: names[v], rows: fold(all(v), dates.length, usd) };
    }
    if (tag && tagDone && !tagFailed) views.tag = { dims: ["TagValue", "ServiceName"], names: {}, tag, rows: fold(all("tag"), dates.length, usd) };
    const advisorList = o.advisor && withAdvisor.length && done.advisor
      ? recs.flat().sort((a, b) => (b.annual_savings ?? -1) - (a.annual_savings ?? -1)) : null;
    return {
      days: dates, split, views, currency, period: { mode: p.mode, label: p.label },
      subscriptions: known, resource_fallback: targets.filter((_, i) => fallback[i]).map(t => t.name),
      advisor: advisorList, advisor_error: advisorError,
      budgets: withAdvisor.length && done.budgets ? budgets.flat() : null, budget_error: budgetError,
      detail: done.detail && !detailNote ? {
        meters: Object.fromEntries(meterNames.flatMap(m => [...m])), // in target order: the same bill gives the same data
        rows: fold(detailRaw.flat(), 2, usd),
        regions: Object.fromEntries(regionOf.flatMap(m => [...m])),
        ...(views.tag ? { tags: Object.fromEntries(tagOf.flatMap(m => [...m])) } : {}),
      } : null,
      detail_note: detailNote,
      related: done.graph ? related : null,
      mixed_currencies: mixed, usd_rate: usdRate,
      forecast, forecast_note: forecastNote,
      graph: findings, graph_error: graphError, demo: false,
      metric: o.metric,
    };
  }
  const pendingNow = (): Pending[] => [
    ...(done.resources ? [] : ["resources" as const]),
    ...(done.regions ? [] : ["regions" as const, ...(tag || !tagDone ? ["tags" as const] : []), "forecast" as const]),
    ...(!done.detail ? ["detail" as const] : []),
    ...(withAdvisor.length && !done.budgets ? ["budgets" as const] : []),
    ...(o.advisor && withAdvisor.length && !done.advisor ? ["Advisor" as const] : []),
    ...(o.graph && withAdvisor.length && !done.graph ? ["idle checks" as const] : []),
  ];
  const update = () => onUpdate?.(assemble(), pendingNow());

  const choosing = chooseTag(az, targets, o.tag, log); // tag names are listed while the services are read
  await pool(targets, concurrency, services);
  update();
  await pool(targets, concurrency, resources);
  done.resources = true;
  update();
  tag = await choosing;
  await pool(targets, concurrency, details);
  done.regions = true;
  tagDone = true;
  update();
  await Promise.all([
    pool(targets, concurrency, detail),
    withAdvisor.length ? pool(withAdvisor, concurrency, t => budget(t, targets.indexOf(t))) : undefined,
    o.advisor && withAdvisor.length ? pool(withAdvisor, concurrency, (t, _) => advisor(t, targets.indexOf(t))) : undefined,
    o.graph && withAdvisor.length // Resource Graph, like Advisor, reads subscriptions
      ? (log("  Resource Graph ..."), graphFindings(az, withAdvisor, log).then(([f, err]) => { findings = f; graphError = err; }))
      : undefined,
    o.graph && withAdvisor.length ? relatedResources(az, withAdvisor, log).then(r => { related = r; }) : undefined,
  ]);
  done.detail = done.budgets = done.advisor = done.graph = true;

  const data = assemble();
  if (data.mixed_currencies) log("  warning: these subscriptions bill in different currencies and Azure won't convert them; totals mix currencies");
  if (data.forecast_note) log(`  skipped this month's forecast: ${data.forecast_note}`);
  log(`  done: ${az.requests} requests (Cost Management queries are free)`);
  return data;
}
