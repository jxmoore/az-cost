// A fake Azure Resource Manager for tests: Cost Management, forecast, tag names, Advisor and Resource Graph,
// answering from a small made-up bill across two subscriptions. It exercises the awkward paths on purpose:
// a throttled request, a subscription that rejects USD columns (and bills in euros), more result pages than the
// resource view reads daily, a spike, a drop, a refund, sub-cent meters, duplicate Advisor tips and idle resources.
import { addDays } from "../core/types";

export const TODAY = "2026-09-28";
export const DAYS = 7;
export const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
export const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ARM = "https://management.azure.com";
const API = "2025-03-01";

const rid = (sub: string, rg: string, path: string) => `/subscriptions/${sub}/resourceGroups/${rg}/providers/${path}`; // Azure's casing
const flat = (v: number) => () => v;

type Line = { sub: string; service: string; meter: string; rg: string; res: string; region: string; env: string; cost: (i: number) => number };
const L = (sub: string, service: string, meter: string, rg: string, path: string, region: string, env: string, cost: (i: number) => number): Line =>
  ({ sub, service, meter, rg, res: rid(sub, rg, path), region, env, cost });

const LINES: Line[] = [
  L(A, "Virtual Machines", "D2 v2", "rg-app-dev", "Microsoft.Compute/virtualMachines/vm-dev1", "EastUS", "dev", flat(10)),
  L(A, "SQL Database", "vCore", "rg-data", "Microsoft.Sql/servers/sql1/databases/orders", "EastUS", "prod", flat(20)),
  L(A, "Virtual Network", "Standard IPv4 Static Public IP", "rg-net", "Microsoft.Network/publicIPAddresses/pip-old", "EastUS", "", flat(1.2)),
  L(A, "Azure Data Factory v2", "Cloud Data Movement", "rg-data", "Microsoft.DataFactory/factories/adf1", "WestEurope", "prod",
    i => (i === 2 * DAYS - 3 ? 150 : 1)), // a spike
  L(A, "Log Analytics", "Analytics Logs Data Ingestion", "rg-mon", "Microsoft.OperationalInsights/workspaces/log1", "EastUS", "prod", i => 5 + i),
  L(A, "Storage", "Hot LRS Data Stored", "rg-data", "Microsoft.Storage/storageAccounts/st1", "EastUS", "prod", i => (i < DAYS ? 8 : 2)), // a drop
  L(A, "Azure Cosmos DB", "Reserved 100 RU/s", "rg-data", "Microsoft.DocumentDB/databaseAccounts/cos1", "EastUS", "prod",
    i => (i === 2 * DAYS - 2 ? -40 : 0)), // a refund
  L(B, "Azure App Service", "S1 App", "rg-web", "Microsoft.Web/serverFarms/asp1", "WestEurope", "", flat(7)),
  L(B, "Bandwidth", "Standard Data Transfer Out", "rg-web", "Microsoft.Web/sites/app1", "WestEurope", "prod", i => 0.5 * (i % 3)),
  L(B, "Key Vault", "Operations", "rg-web", "Microsoft.KeyVault/vaults/kv1", "WestEurope", "prod", flat(0.001)),
  // under half a cent each over both periods: folded into one "(under a cent each)" row per group
  L(B, "Key Vault", "Secret Operations", "rg-web", "Microsoft.KeyVault/vaults/kv2", "WestEurope", "prod", flat(0.0003)),
  L(B, "Key Vault", "Certificate Operations", "rg-web", "Microsoft.KeyVault/vaults/kv3", "WestEurope", "prod", flat(0.0003)),
];
const CURRENCY: Record<string, string> = { [A]: "USD", [B]: "EUR" };
const EUR_PER_USD = 0.9;
const START = addDays(addDays(TODAY, -2), -(2 * DAYS - 1));
const DATES = Array.from({ length: 2 * DAYS }, (_, i) => addDays(START, i));
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

function valueOf(l: Line, dim: string): string {
  return ({ ServiceName: l.service, Meter: l.meter, ResourceGroupName: l.rg, ResourceId: l.res, ResourceLocation: l.region,
    TagValue: l.env, SubscriptionId: l.sub } as Record<string, string>)[dim];
}

function costQuery(sub: string, body: any, page: number): Reply {
  const ds = body.dataset, aggs: string[] = Object.values(ds.aggregation).map((a: any) => a.name);
  if (sub === B && aggs.some(a => a.includes("USD"))) { // this subscription bills in euros only
    return { status: 400, body: { error: { code: "BadRequest", message: "Invalid query definition: aggregation column CostUSD is not valid" } } };
  }
  const from = body.timePeriod.from.slice(0, 10), to = body.timePeriod.to.slice(0, 10);
  const groups: { type: string; name: string }[] = ds.grouping;
  const dims = groups.flatMap(g => (g.type === "TagKey" ? ["TagKey", "TagValue"] : [g.name]));
  const daily = ds.granularity === "Daily";
  const rows = new Map<string, { d: string | null; key: string[]; cost: number }>();
  for (const l of LINES.filter(l => l.sub === sub)) {
    DATES.forEach((d, i) => {
      if (d < from || d > to) return;
      const key = dims.map(dim => (dim === "TagKey" ? groups[0].name : valueOf(l, dim)));
      const k = JSON.stringify([daily ? d : null, ...key]);
      const r = rows.get(k) ?? { d: daily ? d : null, key, cost: 0 };
      r.cost += l.cost(i);
      rows.set(k, r);
    });
  }
  const cols = [...aggs, ...(daily ? ["UsageDate"] : []), ...dims, "Currency"].map(name => ({ name }));
  const out = [...rows.values()].map(({ d, key, cost }) => [
    round6(cost), ...(aggs.length > 1 ? [round6(cost / (sub === B ? EUR_PER_USD : 1))] : []),
    // one subscription answers with numbers, the other with timestamps, as Azure does
    ...(daily ? [sub === A ? Number(d!.replaceAll("-", "")) : `${d}T00:00:00`] : []),
    ...key, CURRENCY[sub],
  ]);
  // B's resource view: one row per page, more pages than the daily resource query reads, so it falls back to totals
  const size = sub === B && daily && dims.includes("ResourceId") ? 1 : 25;
  const props: any = { columns: cols, rows: out.slice(page * size, (page + 1) * size) };
  if ((page + 1) * size < out.length) {
    props.nextLink = `${ARM}/subscriptions/${sub}/providers/Microsoft.CostManagement/query?api-version=${API}&$skiptoken=${page + 1}`;
  }
  return { status: 200, body: { properties: props } };
}

function forecast(sub: string, body: any): Reply {
  const col = body.dataset.aggregation.totalCost.name, first = TODAY.slice(0, 8) + "01";
  const rows = Array.from({ length: 30 }, (_, i) => {
    const d = addDays(first, i);
    return [d < TODAY ? 12.5 : 13.0, Number(d.replaceAll("-", "")), d < TODAY ? "Actual" : "Forecast", CURRENCY[sub]];
  });
  return { status: 200, body: { properties: { columns: [col, "UsageDate", "CostStatus", "Currency"].map(name => ({ name })), rows } } };
}

function advisor(sub: string): Reply {
  if (sub === B) return { status: 403, body: { error: { code: "AuthorizationFailed", message: "The client 'someone@contoso.com' does not have authorization" } } };
  const rec = (typeId: string, problem: string, resource: string, savings: number, sku: string | null = null, term: string | null = null) => ({
    properties: {
      shortDescription: { problem, solution: problem }, impact: "High", recommendationTypeId: typeId,
      resourceMetadata: { resourceId: resource }, impactedField: "Microsoft.Subscriptions/subscriptions", impactedValue: resource.split("/").pop(),
      extendedProperties: { annualSavingsAmount: String(savings), savingsCurrency: "USD", displaySKU: sku, term, region: "eastus" },
    },
  });
  const subId = `/subscriptions/${A}`, sql = "Consider SQL PaaS DB reserved instance to save over the pay-as-you-go costs";
  return { status: 200, body: { value: [
    rec("t-sql", sql, subId, 1200, "SQL DB Gen 5", "P1Y"),
    rec("t-sql", sql, subId, 2100, "SQL DB Gen 5", "P1Y"), // the same tip again, bigger: only this one is kept
    rec("t-vm", "Right-size or shutdown underutilized virtual machines", rid(A, "rg-app-dev", "Microsoft.Compute/virtualMachines/vm-dev1"), 300, "Standard_B1s"),
  ] } };
}

const graph = (): Reply => ({ status: 200, body: { data: [
  { check: "unused-ip", id: rid(A, "rg-net", "Microsoft.Network/publicIPAddresses/pip-old").toLowerCase(), name: "pip-old", resourceGroup: "rg-net", subscriptionId: A },
  { check: "unattached-disk", id: rid(A, "rg-x", "Microsoft.Compute/disks/free").toLowerCase(), name: "free", resourceGroup: "rg-x", subscriptionId: A }, // costs nothing
] } });

/** A fetch() that answers like the fake Azure, and counts the requests it saw. `delay` (ms) slows each answer,
 * so a page using it shows its loading states. */
export function fakeAzure({ delay = 0 } = {}) {
  let throttled = false;
  const seen: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const u = new URL(url), path = u.pathname, body = init.body ? JSON.parse(init.body as string) : null;
    const sub = path.startsWith("/subscriptions/") ? path.split("/")[2] : "";
    seen.push(`${init.method} ${url}`);
    if (delay) await new Promise(r => setTimeout(r, delay));
    let r: Reply;
    if (path === "/subscriptions") {
      r = { status: 200, body: { value: [[A, "team-a"], [B, "team-b"]].map(([subscriptionId, displayName]) =>
        ({ subscriptionId, displayName, state: "Enabled", tenantId: "t1" })) } };
    } else if (path.includes("/providers/Microsoft.CostManagement/query") && !throttled) {
      throttled = true; // the first query is throttled once
      r = { status: 429, body: { error: { code: "429", message: "Too many requests" } },
        headers: { "x-ms-ratelimit-microsoft.costmanagement-entity-retry-after": "1" } };
    } else if (path.includes("/providers/Microsoft.CostManagement/query")) r = costQuery(sub, body, Number(u.searchParams.get("$skiptoken") ?? 0));
    else if (path.includes("/providers/Microsoft.CostManagement/forecast")) r = forecast(sub, body);
    else if (path.endsWith("/tagNames")) {
      const counts: [string, number][] = sub === A ? [["env", 5], ["owner", 2], ["hidden-title", 9]] : [["Env", 1]];
      r = { status: 200, body: { value: counts.map(([tagName, value]) => ({ tagName, count: { value } })) } };
    } else if (path.includes("/providers/Microsoft.Advisor/recommendations")) r = advisor(sub);
    else if (path === "/providers/Microsoft.ResourceGraph/resources") r = graph();
    else r = { status: 404, body: { error: { code: "NotFound", message: url } } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  };
  return { fetch, seen };
}
