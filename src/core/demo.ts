// Fake data, no Azure needed: a demo bill, four subscriptions and a few stories worth finding.
import { accumulate, pack, sum } from "./pack";
import type { AdvisorRec, Budget, CostData, Forecast, GraphFinding, ViewData, ViewKey } from "./types";
import { addDays, daysBetween, lastFullDay, localToday, monthEnd } from "./types";
import { groupKey, VIEWS } from "../azure/costs";

const [P, S, D, X] = ["1", "2", "3", "4"].map(c => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`);
const DEMO_SUBS: Record<string, string> = { [P]: "acme-prod", [S]: "acme-staging", [D]: "acme-data", [X]: "sandbox-dev" };
const VM = "microsoft.compute/virtualmachines", WEB = "microsoft.web/serverfarms", SQL = "microsoft.sql/servers",
  STG = "microsoft.storage/storageaccounts";

type Spot = [sub: string, region: string, rg: string, path: string, share: number];
// service, meter, $/day, growth over the 60 days, where it runs
const DEMO: [string, string, number, number, Spot[]][] = [
  ["Virtual Machines", "D4s v5", 58, 0.05, [[P, "us east", "rg-app-prod", `${VM}/vm-app-01`, .5], [P, "us east", "rg-app-prod", `${VM}/vm-app-02`, .5]]],
  ["Virtual Machines", "D8s v5", 44, 0.1, [[P, "us east", "mc_rg-aks-prod_aks-prod_eastus", "microsoft.compute/virtualmachinescalesets/aks-nodepool1-vmss", 1]]],
  ["Virtual Machines", "E8s v5", 38, -0.7, [[D, "eu west", "rg-etl", `${VM}/vm-etl-worker`, 1]]], // scaled down: a drop
  ["Virtual Machines", "NC8as T4 v3", 22, 0.3, [[D, "us east", "rg-ml", `${VM}/vm-gpu-train`, 1]]],
  ["Virtual Machines", "D2 v2", 9, 0, [[S, "us east", "rg-legacy", `${VM}/vm-legacy-ftp`, 1]]],
  ["Azure Kubernetes Service", "Standard Uptime SLA", 2.4, 0, [[P, "us east", "rg-aks-prod", "microsoft.containerservice/managedclusters/aks-prod", 1]]],
  ["SQL Database", "vCore", 41, 0, [[P, "us east", "rg-data-prod", `${SQL}/sql-prod/databases/orders`, .7],
    [S, "us east", "rg-data-staging", `${SQL}/sql-staging/databases/orders`, .3]]],
  ["SQL Database", "RA-GRS Data Stored", 6, 0.03, [[P, "us east", "rg-data-prod", `${SQL}/sql-prod/databases/orders`, 1]]],
  ["Azure Cosmos DB", "100 RU/s", 19, 1.2, [[P, "us east", "rg-data-prod", "microsoft.documentdb/databaseaccounts/cosmos-catalog", 1]]],
  ["Azure Cosmos DB", "Data Stored", 3, 0.05, [[P, "us east", "rg-data-prod", "microsoft.documentdb/databaseaccounts/cosmos-catalog", 1]]],
  ["Redis Cache", "C1 Cache Instance", 3.3, 0, [[P, "us east", "rg-app-prod", "microsoft.cache/redis/redis-sessions", 1]]],
  ["Storage", "Hot LRS Data Stored", 16, 0.04, [[D, "eu west", "rg-lake", `${STG}/stlakeraw`, .8], [P, "us east", "rg-app-prod", `${STG}/stappassets`, .2]]],
  ["Storage", "Hot LRS Write Operations", 3, 0.1, [[D, "eu west", "rg-lake", `${STG}/stlakeraw`, 1]]],
  ["Storage", "P30 LRS Disk", 11, 0, [[P, "us east", "rg-app-prod", "microsoft.compute/disks/vm-app-01-data", 1]]],
  ["Storage", "LRS Snapshots", 7, 0.15, [[P, "us east", "rg-backup", "microsoft.compute/snapshots/snap-vm-app-01-2025", 1]]],
  ["Log Analytics", "Analytics Logs Data Ingestion", 34, 1.1, [
    [P, "us east", "rg-monitoring", "microsoft.operationalinsights/workspaces/log-prod", .85],
    [S, "us east", "rg-monitoring", "microsoft.operationalinsights/workspaces/log-staging", .15]]],
  ["Azure Monitor", "Standard Web Test Execution", 1.5, 0, [[P, "us east", "rg-monitoring", "microsoft.insights/webtests/ping-home", 1]]],
  ["Microsoft Defender for Cloud", "Standard Node", 6, 0, [[P, "us east", "", "microsoft.security/pricings/virtualmachines", 1]]],
  ["Azure App Service", "P1 v3 App", 14, 0, [[P, "us east", "rg-app-prod", `${WEB}/asp-web-prod`, 1]]],
  ["Azure App Service", "P1 v2 App", 5, 0, [[S, "us east", "rg-app-staging", `${WEB}/asp-web-staging`, 1]]],
  ["Functions", "Premium vCPU Duration", 8, 0.1, [[P, "us east", "rg-app-prod", `${WEB}/asp-func-prod`, 1]]],
  ["Bandwidth", "Standard Data Transfer Out", 12, 0.1, [[P, "us east", "rg-app-prod", `${VM}/vm-app-01`, 1]]],
  ["Bandwidth", "Inter Continent Data Transfer Out - NAM or EU To Any", 4, 0.2, [[D, "eu west", "rg-etl", `${VM}/vm-etl-worker`, 1]]],
  ["NAT Gateway", "Standard Data Processed", 6, 0.3, [[P, "us east", "rg-network", "microsoft.network/natgateways/ng-prod", 1]]],
  ["NAT Gateway", "Standard Gateway", 1.1, 0, [[P, "us east", "rg-network", "microsoft.network/natgateways/ng-prod", 1]]],
  ["Virtual Network", "Standard Private Endpoint", 1.8, 0, [[P, "us east", "rg-network", "microsoft.network/privateendpoints/pe-sql-prod", 1]]],
  ["Virtual Network", "Standard IPv4 Static Public IP", 1.2, 0, [[P, "us east", "rg-network", "microsoft.network/publicipaddresses/pip-ng-prod", 1]]],
  ["Virtual Network", "Basic IPv4 Static Public IP", 1.4, 0, [[X, "us west 2", "rg-sandbox", "microsoft.network/publicipaddresses/pip-old-test", 1]]],
  ["Azure Front Door Service", "Standard Base Fees", 1.2, 0, [[P, "global", "rg-edge", "microsoft.cdn/profiles/afd-web", 1]]],
  ["Azure Front Door Service", "Standard Data Transfer Out", 4, 0.05, [[P, "global", "rg-edge", "microsoft.cdn/profiles/afd-web", 1]]],
  ["Foundry Models", "gpt 4.1 Inp glbl Tokens", 6, 3, [[X, "us east 2", "rg-ai-sandbox", "microsoft.cognitiveservices/accounts/oai-sandbox", 1]]],
  ["Foundry Models", "gpt 4.1 Outp glbl Tokens", 9, 3, [[X, "us east 2", "rg-ai-sandbox", "microsoft.cognitiveservices/accounts/oai-sandbox", 1]]],
  ["Azure Data Factory v2", "Cloud Data Movement", 5, 0.2, [[D, "eu west", "rg-etl", "microsoft.datafactory/factories/adf-etl", 1]]],
  ["Event Hubs", "Standard Throughput Unit", 3.6, 0, [[D, "eu west", "rg-etl", "microsoft.eventhub/namespaces/evh-ingest", 1]]],
  ["Container Registry", "Standard Registry Unit", 0.67, 0, [[P, "us east", "rg-app-prod", "microsoft.containerregistry/registries/acmecr", 1]]],
  ["Key Vault", "Operations", 0.3, 0, [[P, "us east", "rg-app-prod", "microsoft.keyvault/vaults/kv-app-prod", 1]]],
  // its VM was deleted, the disk wasn't: Resource Graph finds it unattached (demoGraph)
  ["Storage", "P10 LRS Disk", 0.65, 0, [[S, "us east", "rg-legacy", "microsoft.compute/disks/vm-old-ftp-osdisk", 1]]],
];

const demoRid = (sub: string, rg: string, path: string) =>
  rg ? `/subscriptions/${sub}/resourcegroups/${rg}/providers/${path}` : `/subscriptions/${sub}/providers/${path}`;

function demoAdvisor(): AdvisorRec[] {
  const rec = (problem: string, sub: string, path: string | null, savings: number, sku: string | null = null,
    term: string | null = null, rg = ""): AdvisorRec => {
    const resource = path ? demoRid(sub, rg, path) : `/subscriptions/${sub}`;
    return { problem, solution: problem, impact: "High", resource, resource_name: path ? resource.split("/").pop()! : DEMO_SUBS[sub],
      resource_type: null, sku, term, annual_savings: savings, currency: "USD", subscription: DEMO_SUBS[sub] };
  };
  return [
    rec("Consider SQL PaaS DB reserved instance to save over the pay-as-you-go costs", P, null, 4380.0,
      "SQL DB Single/Elastic Pool - General Purpose - Gen 5", "P3Y"),
    rec("Consider purchasing a savings plan to unlock lower prices", P, null, 3120.0, "Compute_Savings_Plan", "P1Y"),
    rec("Right-size or shutdown underutilized virtual machines", D, `${VM}/vm-etl-worker`, 2150.0, "Standard_E4s_v5", null, "rg-etl"),
    rec("Consider Cosmos DB reserved instance to save over the pay-as-you-go costs", P, null, 1020.0, "100 RU/s", "P1Y"),
    rec("Right-size or shutdown underutilized virtual machines", S, `${VM}/vm-legacy-ftp`, 640.0, "Standard_B2s", null, "rg-legacy"),
  ];
}

function demoBudgets(): Budget[] {
  const budget = (sub: string, name: string, amount: number, current: number, forecast: number, filtered = false): Budget =>
    ({ name, subscription: DEMO_SUBS[sub], subscription_id: sub, amount, time_grain: "Monthly", current, forecast, currency: "USD", filtered });
  return [
    budget(P, "prod-monthly", 8000, 7420, 8650), // on pace to run over
    budget(S, "staging-monthly", 1500, 900, 1150),
    budget(X, "sandbox-cap", 300, 410, 450), // the AI experiments already blew through it
    budget(D, "lake-storage", 900, 560, 700, true),
  ];
}

const DEMO_TAG = "environment";
const DEMO_ENV: Record<string, string> = { [P]: "production", [S]: "staging", [D]: "production", [X]: "dev" };
const DEMO_UNTAGGED = new Set(["", "rg-legacy", "rg-backup", "rg-ai-sandbox", "mc_rg-aks-prod_aks-prod_eastus"]); // the usual gaps
const demoEnv = (sub: string, rg: string) => (DEMO_UNTAGGED.has(rg) ? "" : DEMO_ENV[sub]);

function demoGraph(): GraphFinding[] {
  const found = (check: string, sub: string, rg: string, path: string): GraphFinding =>
    ({ check, id: demoRid(sub, rg, path), name: path.split("/").pop()!, resourceGroup: rg, subscriptionId: sub });
  return [found("unattached-disk", S, "rg-legacy", "microsoft.compute/disks/vm-old-ftp-osdisk"),
    found("old-snapshot", P, "rg-backup", "microsoft.compute/snapshots/snap-vm-app-01-2025"),
    found("unused-ip", X, "rg-sandbox", "microsoft.network/publicipaddresses/pip-old-test")];
}

/** This month so far from the demo's own days, and the last week's daily average for the days still to come. */
function demoForecast(views: Partial<Record<ViewKey, ViewData>>, dates: string[], today: string): Forecast {
  const daily = dates.map((_, i) => sum(views.service!.rows.map(r => r.d[i])));
  const month = today.slice(0, 7);
  const last = monthEnd(today);
  const actual = Math.round(100 * sum(daily.filter((_, i) => dates[i].startsWith(month)))) / 100;
  // the days still to come this month: after the demo's last day, or all of them when that day is last month's
  const prevMonthEnd = addDays(month + "-01", -1), lastDate = dates[dates.length - 1];
  const since = lastDate > prevMonthEnd ? lastDate : prevMonthEnd;
  const rest = Math.round(100 * (sum(daily.slice(-7)) / 7) * daysBetween(since, last)) / 100;
  return { month, actual, forecast: rest, total: Math.round(100 * (actual + rest)) / 100 };
}

/** A seeded normal distribution, so the demo looks the same on every load. */
function gaussian(seed: number) {
  let a = seed >>> 0;
  const uniform = () => { // mulberry32
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (mu: number, sigma: number) => mu + sigma * Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

export function demo(days: number, today: string = localToday()): CostData {
  const gauss = gaussian(7);
  const end = lastFullDay(today);
  const n = 2 * days;
  const dates = Array.from({ length: n }, (_, i) => addDays(end, -(n - 1 - i)));
  const weekend = dates.map(d => [0, 6].includes(new Date(d + "T00:00:00Z").getUTCDay()));
  const rows: Record<ViewKey, Map<string, number[]>> =
    { service: new Map(), subscription: new Map(), region: new Map(), resource: new Map(), tag: new Map() };
  const names: Record<string, Record<string, string>> = { service: {}, subscription: { ...DEMO_SUBS }, region: {}, resource: {} };
  const keysFor = (service: string, sub: string, region: string, gkey: string, rid: string, rg: string): [ViewKey, [string, string]][] =>
    [["subscription", [sub, service]], ["region", [region, service]], ["resource", [gkey, rid]], ["tag", [demoEnv(sub, rg), service]]];

  for (const [service, meter, perDay, growth, spots] of DEMO) {
    const bursty = ["Tokens", "Data Transfer", "Ingestion", "Operations", "Processed", "Duration"].some(w => meter.includes(w));
    // plans, provisioned databases, nodes and gateways bill a fixed hourly price: the same every day, like real bills
    const fixed = /App$|vCore|Instance|Node$|Uptime SLA|Unit$|Gateway$|Endpoint$|Public IP$|Base Fees|Disk$/.test(meter);
    for (const [sub, region, rg, path, share] of spots) {
      const daily: number[] = [];
      for (let i = 0; i < n; i++) {
        let m = (1 + growth * i / (n - 1)) / (1 + growth / 2); // keep the average near perDay
        m *= bursty && weekend[i] ? 0.8 : 1;
        const noise = gauss(1, 0.06); // drawn either way, so the other meters' numbers don't move
        daily.push(Math.max(0, perDay * share * m * (fixed ? 1 : noise)));
      }
      const rid = demoRid(sub, rg, path);
      const gkey = groupKey(`/subscriptions/${sub}`, rg, rid);
      names.resource[gkey] = `${rg || "(no resource group)"} · ${DEMO_SUBS[sub]}`;
      for (const [view, key] of [["service", [service, meter]], ...keysFor(service, sub, region, gkey, rid, rg)] as [ViewKey, [string, string]][]) {
        const acc = accumulate(rows[view], key, n);
        daily.forEach((v, i) => (acc[i] += v));
      }
    }
  }
  const oneDay = (service: string, meter: string, sub: string, region: string, rg: string, path: string, day: number, amount: number) => {
    const rid = demoRid(sub, rg, path), gkey = groupKey(`/subscriptions/${sub}`, rg, rid);
    for (const [view, key] of [["service", [service, meter]], ...keysFor(service, sub, region, gkey, rid, rg)] as [ViewKey, [string, string]][]) {
      accumulate(rows[view], key, n)[day] += amount;
    }
  };
  // a cancelled Cosmos DB reservation refunded as one negative day: no box can show it, so the header notes it
  oneDay("Azure Cosmos DB", "Reserved 100 RU/s", P, "us east", "rg-data-prod", "microsoft.documentdb/databaseaccounts/cosmos-catalog",
    Math.max(days, n - 6), -150);
  // a one-off backfill: Data Factory moved a year of data in one day, a spike for "worth a look"
  oneDay("Azure Data Factory v2", "Cloud Data Movement", D, "eu west", "rg-etl", "microsoft.datafactory/factories/adf-etl",
    Math.max(days, n - 9), 180);

  const views: Partial<Record<ViewKey, ViewData>> = {};
  for (const v of Object.keys(VIEWS) as (keyof typeof VIEWS)[]) views[v] = { dims: VIEWS[v], names: names[v], rows: pack(rows[v]) };
  views.tag = { dims: ["TagValue", "ServiceName"], names: {}, tag: DEMO_TAG, rows: pack(rows.tag) };
  return {
    days: dates, split: days, views, currency: "USD",
    subscriptions: Object.entries(DEMO_SUBS).map(([id, name]) => ({ id, name, currency: "USD" })),
    resource_fallback: [], advisor: demoAdvisor(), advisor_error: null, budgets: demoBudgets(), budget_error: null,
    forecast: demoForecast(views, dates, today), forecast_note: null,
    graph: demoGraph(), graph_error: null, demo: true,
  };
}
