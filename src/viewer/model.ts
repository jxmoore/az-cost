// Everything the viewer derives from one run's data: trees, names, colors, formatting and the side panel's lists.
import type { Hint, LinkedTip, Summary } from "../core/summarize";
import { typeLabel, withTypeView } from "../core/resourceTypes";
import { DD_DIM, level, type DD, type Drill, type LevelRow } from "./drill";
import type { AdvisorRec, Budget, CostData, Dim, ViewKey } from "../core/types";

export const VIEW_KEYS: ViewKey[] = ["service", "subscription", "region", "resource", "type", "tag"];
export const VIEW_NAMES: Record<string, string> = { service: "Service", subscription: "Subscription", region: "Region", resource: "Resource", type: "Type" };

export interface TNode {
  kind: "root" | "group" | "leaf";
  key: string;
  name: string;
  full: string;
  dim: Dim | null;
  parent: TNode | null;
  children: TNode[] | null; // null for leaves
  gone: TNode[]; // spent before, nothing now: no box, still news
  daily: Float64Array;
  cur: number;
  prev: number;
  credits: number;
  size: number | null;
  hit: boolean;
  more?: number; // a "+N more" box: how many it holds
  rest?: TNode[];
  detail?: boolean; // a level drilled past a view's two: from the detail, totals per period and no daily series
}

export const esc = (s: unknown) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// ---------- formatting
const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", INR: "₹", KRW: "₩", BRL: "R$", AUD: "A$",
  CAD: "C$", NZD: "NZ$", HKD: "HK$", TWD: "NT$", MXN: "MX$", ILS: "₪", TRY: "₺", PLN: "zł ", ZAR: "R " };
export const sym = (code: string | null | undefined) => SYMBOLS[code || "USD"] ?? `${code} `;
export const pct = (v: number) => (Math.abs(v) >= 0.1 || v === 0 ? Math.round(v * 100) : (v * 100).toFixed(1)) + "%";
export const day = (s: string) => new Date(s + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

// ---------- names and categories
const SHORT: Record<string, string> = {
  "Azure Front Door Service": "Front Door", "Azure Data Factory v2": "Data Factory", "Azure Grafana Service": "Managed Grafana",
  "Azure Kubernetes Service": "AKS", "Microsoft Defender for Cloud": "Defender for Cloud", "Azure Cognitive Search": "AI Search",
};
export const shortSvc = (s: string) => SHORT[s] || s.replace(/^(Azure|Microsoft)\s+/, "");
const lastSeg = (id: string) => id.split("/").filter(Boolean).pop() || id;

export const CATS: [string, string][] = [
  ["compute", "Compute"], ["storage", "Storage"], ["database", "Database"], ["network", "Network"],
  ["ai", "AI / ML"], ["analytics", "Analytics"], ["ops", "Ops & security"], ["other", "Other"],
];
const SVC_RULES: [string, RegExp][] = [
  ["ai", /Foundry|Cognitive Services|OpenAI|Machine Learning|AI Search|Cognitive Search|Bot Service|Speech|Translator|Document Intelligence|Form Recognizer|Azure AI/i],
  ["database", /SQL|Cosmos DB|Redis|MySQL|PostgreSQL|MariaDB|Database|Cache/i],
  ["ops", /Monitor|Log Analytics|Defender|Security Center|Sentinel|Key Vault|Application Insights|Automation|Grafana|Azure Arc|App Configuration|Policy|Entra|Active Directory/i],
  ["analytics", /Synapse|Data Factory|Databricks|Event Hubs|Stream Analytics|Data Explorer|HDInsight|Power BI|Fabric|Analysis Services|Purview/i],
  ["storage", /Storage|Backup|Site Recovery|NetApp|Container Registry|Data Box|Archive/i],
  ["network", /Bandwidth|Virtual Network|Front Door|CDN|Content Delivery|Load Balancer|Application Gateway|VPN Gateway|ExpressRoute|NAT Gateway|DNS|Traffic Manager|Firewall|Private Link|Network Watcher|DDoS|Bastion|API Management|Virtual WAN/i],
  ["compute", /Virtual Machines|App Service|Functions|Kubernetes|Container Instances|Container Apps|Batch|Cloud Services|Service Fabric|Logic Apps|Spring|Virtual Desktop|Static Web Apps/i],
];
const METER_RULES: [string, RegExp][] = [
  ["storage", /Data Stored|\bDisks?\b|Snapshot|\b(LRS|GRS|ZRS|RA-GRS)\b|Backup/i],
  ["network", /Data Transfer|Bandwidth|Public IP|Private Endpoint/i],
];
// resource ids name their provider: /subscriptions/../providers/microsoft.web/sites/shop
const PROVIDER_RULES: [string, RegExp][] = [
  ["storage", /\/providers\/microsoft\.(compute\/(disks|snapshots)|storage\/|containerregistry|recoveryservices|netapp|dataprotection)/],
  ["ai", /\/providers\/microsoft\.(cognitiveservices|machinelearningservices|search\/|botservice)/],
  ["database", /\/providers\/microsoft\.(sql|documentdb|cache|dbfor)/],
  ["ops", /\/providers\/microsoft\.(operationalinsights|insights|keyvault|security|dashboard|appconfiguration|automation|operationsmanagement|alertsmanagement)/],
  ["analytics", /\/providers\/microsoft\.(eventhub|datafactory|synapse|databricks|kusto|streamanalytics|hdinsight|purview|fabric)/],
  ["network", /\/providers\/microsoft\.(network|cdn)\//],
  ["compute", /\/providers\/microsoft\.(compute|web|containerservice|app\/|containerinstance|logic|batch|servicefabric)/],
];
const match = (rules: [string, RegExp][], s: string) => rules.find(([, re]) => re.test(s))?.[0];
const svcCat = (s: string) => match(SVC_RULES, s) || "other";

export const TERM: Record<string, string> = { P1Y: "1-yr term", P3Y: "3-yr term", P5Y: "5-yr term" };
export const SHOWN_RECS = 5, SHOWN_HINTS = 6;
export const HINT_TAG: Record<string, string> = { grower: "grew", spike: "spike", pit: "fix", devtest: "dev/test", steady: "reserve", idle: "idle", budget: "budget" };
const HINT_COLOR: Record<string, string> = { grower: "var(--up)", spike: "var(--up)", pit: "var(--accent)", devtest: "var(--accent)",
  steady: "var(--advisor)", idle: "var(--accent)", budget: "var(--up)" };

export interface PlacedHint {
  h: Hint;
  n: TNode;
  c: string;
  why: string;
  title: string;
  value: number;
  view: ViewKey;
  find: (m: TNode) => boolean;
}

export type Model = ReturnType<typeof createModel>;

export function createModel(data: CostData, EXPORT: Summary) {
  const DATA = withTypeView(data); // the type view is derived from the resource view: every VM, disk, database...
  const N = DATA.days.length, SPLIT = DATA.split, DAYS = N - SPLIT;
  const TAG = DATA.views.tag?.tag ?? "tag"; // the tag view splits the bill by one tag's values
  const CUR = DATA.mixed_currencies ? "" : sym(DATA.currency); // unconverted currencies: no one symbol would be true

  function money(v: number, s = CUR) {
    const a = Math.abs(v), p = (v < 0 ? "-" : "") + s;
    if (a >= 1e6) return p + (a / 1e6).toFixed(2) + "M";
    if (a >= 1e4) return p + (a / 1e3).toFixed(1) + "k";
    if (a >= 100) return p + Math.round(a).toLocaleString("en-US");
    return p + a.toFixed(2);
  }
  /** [sign and whole units, cents] for the big number */
  function bigMoney(v: number): [string, string] {
    const [w, c] = Math.abs(v).toFixed(2).split(".");
    return [`${v < 0 ? "-" : ""}${CUR}${Number(w).toLocaleString("en-US")}`, "." + c];
  }
  const period = () => `${day(DATA.days[SPLIT])} – ${day(DATA.days[N - 1])}`;
  // what the current period is, and what it's measured against, in words
  const mode = DATA.period?.mode ?? "days";
  const LABEL = DATA.period?.label ?? `last ${DAYS} days`;
  const PREV = mode === "mtd" ? "the same days last month" : mode === "lastMonth" ? "the month before" : `the previous ${SPLIT} days`;
  const PREV_SHORT = mode === "mtd" ? "vs last month" : mode === "lastMonth" ? "vs month before" : `vs prev ${SPLIT}d`;

  const DIM: Record<Dim, { one: string; many: string; label: (v: string, names: Record<string, string>) => string }> = {
    ServiceName: { one: "service", many: "services", label: v => shortSvc(v) },
    Meter: { one: "meter", many: "meters", label: v => v },
    SubscriptionId: { one: "subscription", many: "subscriptions", label: (v, names) => names[v] || v },
    ResourceLocation: { one: "region", many: "regions", label: v => v || "(no region)" },
    ResourceGroupName: { one: "resource group", many: "resource groups", label: (v, names) => names[v] || lastSeg(v) },
    // resources without an id (some marketplace and support charges) keep a plain label
    ResourceId: { one: "resource", many: "resources", label: v => (v.startsWith("/") ? lastSeg(v) : shortSvc(v)) },
    ResourceType: { one: "resource type", many: "resource types", label: v => typeLabel(v) },
    // one box per value of the tag, and one for spend on resources without it
    TagValue: { one: `${TAG} value`, many: `${TAG} values`, label: v => v || "(untagged)" },
  };

  function category(n: TNode, view: ViewKey): string | null {
    if (n.more) return null; // a mix of whatever was too small to draw
    const [A, B] = DATA.views[view]!.dims;
    const dim = n.detail ? n.dim : n.kind === "leaf" ? B : A;
    if (dim === "Meter") return match(METER_RULES, n.name) || svcCat(n.detail ? n.key.split("\u0000")[0] : n.parent!.key);
    if (dim === "ServiceName") return svcCat(n.key);
    if (dim === "ResourceId") return n.key.startsWith("/") ? match(PROVIDER_RULES, n.key) || "other" : svcCat(n.key);
    if (dim === "ResourceType") return match(PROVIDER_RULES, `/providers/${n.key}/`) || "other";
    return null;
  }
  function color(n: TNode, view: ViewKey, change: boolean): string {
    if (change) {
      if (n.prev < 0.01) return n.cur >= 0.5 ? "var(--up)" : "var(--neutral)";
      const p = (n.cur - n.prev) / n.prev;
      if (Math.abs(p) < 0.05) return "var(--neutral)";
      const t = Math.min(Math.abs(p) / 0.6, 1);
      return `color-mix(in srgb, var(${p > 0 ? "--up" : "--down"}) ${Math.round(35 + 65 * t)}%, var(--neutral))`;
    }
    const c = category(n, view);
    return c ? `var(--${c})` : "var(--neutral)";
  }

  // ---------- tree
  // With collapse off, rows that don't match the filter stay in the tree (the map dims them): `hit` marks the matches.
  function buildTree(viewKey: ViewKey, filter: string, collapse: boolean): TNode {
    const v = DATA.views[viewKey]!, names = v.names || {};
    const [A, B] = v.dims, q = filter.toLowerCase();
    const root: TNode = { kind: "root", key: "\u0000root", name: "all", full: "", dim: null, parent: null, children: [], gone: [],
      daily: new Float64Array(N), cur: 0, prev: 0, credits: 0, size: null, hit: false };
    const groups = new Map<string, TNode>();
    for (const r of v.rows) {
      const [a, b] = r.k;
      const ga = DIM[A].label(a, names), lb = DIM[B].label(b, names);
      const hit = !q || `${a} ${b} ${ga} ${lb}`.toLowerCase().includes(q);
      if (!hit && collapse) continue;
      let g = groups.get(a);
      if (!g) {
        g = { kind: "group", key: a, name: ga, full: a, dim: A, parent: root, children: [], gone: [], daily: new Float64Array(N),
          cur: 0, prev: 0, credits: 0, size: null, hit: false };
        groups.set(a, g);
        root.children!.push(g);
      }
      g.children!.push({ kind: "leaf", key: b, name: lb, full: b, dim: B, parent: g, children: null, gone: [], daily: Float64Array.from(r.d),
        cur: 0, prev: 0, credits: 0, size: null, hit });
    }
    const size = (c: TNode) => c.size ?? c.cur;
    (function total(n: TNode) {
      if (n.children) {
        for (const c of n.children) { total(c); for (let i = 0; i < N; i++) n.daily[i] += c.daily[i]; }
        // credits and refunds can't be drawn as boxes, but they are in the totals: keep count of them
        n.credits = n.children.reduce((s, c) => s + c.credits, 0);
        // a box's area is what its boxes spent, so a refund bigger than a service's usage can't hide the service's meters
        n.gone = n.children.filter(c => size(c) < 0.005 && c.prev >= 0.005);
        n.children = n.children.filter(c => size(c) >= 0.005).sort((a, b) => size(b) - size(a));
        n.hit = n.children.some(c => c.hit);
        n.size = n.children.reduce((s, c) => s + size(c), 0);
      }
      n.prev = 0; n.cur = 0;
      for (let i = 0; i < N; i++) i < SPLIT ? (n.prev += n.daily[i]) : (n.cur += n.daily[i]);
      if (!n.children) n.credits = Math.min(n.cur, 0);
    })(root);
    return root;
  }
  // trees are rebuilt on every view or filter change; keep the last few, and share the unfiltered ones
  const trees = new Map<string, TNode>();
  function tree(view: ViewKey, filter: string, collapse: boolean): TNode {
    const key = `${view}\u0000${filter}\u0000${filter ? collapse : false}`;
    let t = trees.get(key);
    if (!t) {
      t = buildTree(view, filter, collapse);
      if (trees.size > 12) for (const k of trees.keys()) if (k.split("\u0000")[1]) { trees.delete(k); break; }
      trees.set(key, t);
    }
    return t;
  }

  // ---------- drilling past a view's two levels, into the detail
  const DETAIL = DATA.detail ?? null, RELATED = DATA.related ?? null;
  const DRILLABLE = new Set<ViewKey>(["service", "subscription", "resource", "type"]); // regions and tag values aren't in the detail
  const SUB_NAMES = Object.fromEntries((DATA.subscriptions || []).map(s => [s.id.toLowerCase(), s.name]));
  const RESOURCE_GROUP_NAMES = DATA.views.resource?.names ?? {};
  const bare = (key: string) => /^\/subscriptions\/[^/]+$/.test(key); // a charge on no resource (or no resource group)
  function label(dd: DD, key: string): string {
    switch (dd) {
      case "attached": return bare(key) ? "(no resource)" : lastSeg(key);
      case "service": return shortSvc(key);
      case "meter": return key.split("\u0000")[1] ?? key;
      case "resource": return bare(key) ? "(no resource)" : lastSeg(key);
      case "group": return RESOURCE_GROUP_NAMES[key] ?? (bare(key) ? "(no resource group)" : lastSeg(key));
      case "type": return typeLabel(key);
      case "subscription": return SUB_NAMES[key] ?? key;
    }
  }
  const drills = new Map<string, { base: TNode; all: LevelRow[] }>();
  /** A drilled level as a node the map, the table and the side panel can show: its boxes are the path's facts grouped by
   * the breakdown. `all` has every row, credits too, for the CSV. */
  function drillLevel(d: Drill, filter: string, collapse: boolean): { base: TNode; all: LevelRow[] } {
    const cacheKey = JSON.stringify([d, filter, filter ? collapse : false]);
    const hit = drills.get(cacheKey);
    if (hit) return hit;
    const all = DETAIL ? level(DETAIL, d.path, d.by, RELATED) : [], q = filter.toLowerCase(), last = d.path[d.path.length - 1];
    const names = d.path.map(s => label(s.dim, s.key));
    const base: TNode = { kind: "group", key: "\u0000drill", name: names[names.length - 1], full: names.join(" / "), dim: DD_DIM[last.dim],
      parent: null, children: [], gone: [], daily: new Float64Array(N), cur: 0, prev: 0, credits: 0, size: null, hit: false, detail: true };
    for (const r of all) {
      const name = label(d.by, r.key), hitRow = !q || `${r.key} ${name}`.toLowerCase().includes(q);
      base.cur += r.cur; base.prev += r.prev;
      if (r.cur < 0) base.credits += r.cur;
      if (!hitRow && collapse) continue;
      const n: TNode = { kind: "leaf", key: r.key, name, full: r.key.startsWith("/") ? r.key : `${base.full} / ${name}`, dim: DD_DIM[d.by],
        parent: base, children: null, gone: [], daily: new Float64Array(N), cur: r.cur, prev: r.prev, credits: Math.min(r.cur, 0),
        size: null, hit: hitRow, detail: true };
      if (r.cur >= 0.005) base.children!.push(n);
      else if (r.prev >= 0.005) base.gone.push(n); // spent before, nothing now: no box, still in the table
    }
    base.hit = base.children!.some(c => c.hit);
    base.size = base.children!.reduce((s, c) => s + c.cur, 0);
    const out = { base, all };
    if (drills.size > 20) drills.delete(drills.keys().next().value!);
    drills.set(cacheKey, out);
    return out;
  }

  const whole = tree("service", "", false), grand = whole.cur; // shares are always of the whole bill, even when filtered
  const CREDITS = whole.credits; // meters with a negative total: the export's credits_and_refunds
  // spend on resources without the tag, for the tag view's header (the "(untagged)" box before any filter)
  const UNTAGGED = (DATA.views.tag?.rows || []).filter(r => r.k[0] === "")
    .reduce((s, r) => s + r.d.slice(SPLIT).reduce((a, b) => a + b, 0), 0);

  /** A total that includes credits or refunds is bigger in boxes than in the header. Only the service view has meters,
   * where a negative one is a credit or refund; the other views net them into their boxes, so there only the whole
   * bill carries the note, with the same figure as the service view and the export. */
  const credits = (n: TNode, view: ViewKey, narrowed: boolean) =>
    view === "service" ? n.credits : n.kind === "root" && !narrowed ? CREDITS : 0;

  // a subscription with too many resources gets one total per resource and period, so no daily chart in that view
  const FALLBACK = new Set((DATA.subscriptions || []).filter(s => (DATA.resource_fallback || []).includes(s.name)).map(s => s.id.toLowerCase()));
  const subOf = (n: TNode) => ((n.kind === "leaf" ? n.parent!.key : n.key).match(/^\/subscriptions\/([^/]+)/i) || [])[1]?.toLowerCase();
  // the type view is made of the same rows: a type spans subscriptions, so any subscription with totals only affects it
  const totalsOnly = (view: ViewKey, n?: TNode) => (view === "resource" || view === "type") && (DATA.resource_fallback?.length ?? 0) > 0
    && (!n || n.kind === "root" || !FALLBACK.size || (view === "type" && n.kind === "group") || FALLBACK.has(subOf(n)!));

  // resources and resource groups are keyed by ARM id, subscriptions by bare GUID; the demo's ids are made up
  const armId = (n: TNode) => n.kind === "root" || n.more || DATA.demo ? null
    : n.dim === "SubscriptionId" && /^[0-9a-f-]{36}$/i.test(n.key) ? `/subscriptions/${n.key}`
    : /^\/subscriptions\/[^/]+/i.test(n.key) ? n.key : null;
  // the portal opens another tenant's subscription only in that tenant's directory: #@<tenant>/resource/...
  const TENANTS = Object.fromEntries((DATA.subscriptions || []).filter(s => s.tenant).map(s => [String(s.id).toLowerCase(), s.tenant!]));
  function portalHref(n: TNode, portal = "https://portal.azure.com"): string | null {
    const id = armId(n);
    if (!id) return null;
    const tenant = TENANTS[(id.match(/^\/subscriptions\/([^/]+)/i) || [])[1]?.toLowerCase()];
    return `${portal}/#${tenant ? `@${encodeURIComponent(tenant)}/` : ""}resource${encodeURI(id)}`;
  }

  // ---------- Azure Advisor: the export's copy of the tips knows which meters a reservation or savings plan covers
  const TIPS: (AdvisorRec & Partial<LinkedTip>)[] | null = EXPORT.advisor ?? DATA.advisor;
  // "covers SQL Database · vCore ($1,216/mo) + 1 more", or who/what the tip is about
  const tipDetail = (r: AdvisorRec) => [r.resource_name, r.sku, r.region, r.term && Object.hasOwn(TERM, r.term) && TERM[r.term]].filter(Boolean).join(" · ");
  const tipLine = (r: AdvisorRec & Partial<LinkedTip>) => (r.covers?.length
    ? `covers ${shortSvc(r.covers[0].service)} · ${r.covers[0].meter} (${money(r.covers_monthly!)}/mo)${r.covers.length > 1 ? ` + ${r.covers.length - 1} more` : ""}`
    : tipDetail(r));

  // ---------- biggest drops: what fell since the previous period, including what went to zero (always the service view)
  let _drops: { n: TNode; d: number }[] | undefined;
  function biggestDrops() {
    if (_drops) return _drops;
    const t = tree("service", "", false);
    const leaves = [...t.children!, ...t.gone].flatMap(g => [...(g.children ?? []), ...(g.gone || [])]);
    return (_drops = leaves.map(n => ({ n, d: n.cur - n.prev }))
      .filter(h => h.n.cur > -0.005 && h.d <= -Math.max(1, t.cur * 0.005) && h.d / h.n.prev < -0.2) // refunds go in the credits note
      .sort((a, b) => a.d - b.d).slice(0, 3));
  }

  // ---------- worth a look: the hints the rules computed (the export's `hints`, in order), placed on the map
  function hintText(h: Hint): string {
    if (h.kind === "devtest") return `${h.resources} always-on ${h.resources === 1 ? "resource" : "resources"} in this dev/test group billed every day of the period; scale down or stop outside working hours, or go serverless`;
    if (h.kind === "grower") return h.previous! < 0.01 ? "new this period" : `up ${pct(h.change! / h.previous!)} (+${money(h.change!)}) vs ${PREV}`;
    if (h.kind === "spike") return `spiked on ${day(h.date!)}: ${money(h.day_cost!)} vs a usual ${money(h.usual!)}/day`;
    if (h.kind === "steady") return `steady at about ${money(h.monthly!)}/mo on ${h.meters!.join(", ")}: a reservation or savings plan could cut it`;
    return h.reason || "";
  }
  let _hints: PlacedHint[] | undefined;
  function worthALook(): PlacedHint[] {
    if (_hints) return _hints;
    const t = tree("service", "", false), leaves = new Map<string, TNode>();
    for (const g of [...t.children!, ...t.gone]) for (const n of [...(g.children ?? []), ...(g.gone || [])]) leaves.set(`${g.key}\u0000${n.key}`, n);
    const groups = new Map(DATA.views.resource ? tree("resource", "", false).children!.map(g => [g.key, g]) : []);
    // each hint becomes a row: what it's about, its dollars, and where a click takes you
    const place = (h: Hint): PlacedHint | null => {
      const c = HINT_COLOR[h.kind] || "var(--accent)", why = hintText(h);
      if (h.kind === "devtest") {
        const n = groups.get(h.group!);
        return n ? { h, n, c, why, title: n.name, value: h.amount, view: "resource", find: m => m.kind === "group" && m.key === h.group } : null;
      }
      if (h.kind === "idle") { // several resources: a click opens the biggest, which the reason names
        const top = h.resources[0], n = groups.get(top.group)?.children!.find(c => c.key === top.id);
        return n ? { h, n, c, why, title: h.label!, value: h.amount, view: "resource", find: m => m.kind === "leaf" && m.key === top.id } : null;
      }
      if (h.kind === "budget") { // a subscription over (or heading over) its budget: its box in the subscription view
        const n = tree("subscription", "", false).children!.find(g => g.key === h.subscription_id);
        return n ? { h, n, c, why, title: `${h.budget} · ${n.name}`, value: h.amount, view: "subscription",
          find: m => m.kind === "group" && m.key === h.subscription_id } : null;
      }
      if (h.kind === "steady") {
        const n = t.children!.find(g => g.key === h.service);
        return n ? { h, n, c, why, title: n.name, value: h.current, view: "service", find: m => m.kind === "group" && m.key === h.service } : null;
      }
      const n = leaves.get(`${h.service}\u0000${h.meter}`);
      return n ? { h, n, c, why, title: `${shortSvc(n.parent!.key)} · ${n.name}`, value: n.cur, view: "service",
        find: m => m.kind === "leaf" && m.key === n.key && m.parent!.key === n.parent!.key } : null;
    };
    return (_hints = (EXPORT.hints || []).map(place).filter((x): x is PlacedHint => !!x));
  }

  // the boxes the to-dos in Worth a look are about, in the view each row jumps to: hatched on the map
  const _marks: Partial<Record<ViewKey, Set<string>>> = {};
  function marks(view: ViewKey): Set<string> {
    if (_marks[view]) return _marks[view]!;
    const m = new Set<string>();
    for (const x of worthALook()) {
      const h = x.h;
      if (x.view !== view) continue;
      if (h.kind === "pit") m.add(h.service + "\u0000" + h.meter);
      else if (h.kind === "steady") for (const meter of h.meters!) m.add(h.service + "\u0000" + meter);
      else if (h.kind === "idle") for (const r of h.resources) m.add(r.group + "\u0000" + r.id);
      else if (h.kind === "devtest") m.add(h.group + "\u0000*");
    }
    return (_marks[view] = m);
  }
  const isTodo = (n: TNode, view: ViewKey) => n.kind === "leaf" && !n.more
    && (marks(view).has(n.parent!.key + "\u0000" + n.key) || marks(view).has(n.parent!.key + "\u0000*"));

  // ---------- budgets: Azure's spend and forecast for each budget's own period
  const BUDGETS = DATA.budgets ?? null;
  /** how far a budget is used and forecast to be, and what that means */
  function budgetState(b: Budget) {
    const used = b.amount > 0 ? (b.current ?? 0) / b.amount : 0, forecast = b.amount > 0 && b.forecast !== null ? b.forecast / b.amount : null;
    const status = used > 1 ? "over" : (forecast ?? used) > 1 ? "at risk" : "on track";
    return { used, forecast, status, color: status === "on track" ? "var(--down)" : "var(--up)" };
  }
  /** the budgets a box is about: a subscription's, or the whole bill's when the run read one subscription */
  function budgetsOf(n: TNode): Budget[] {
    if (!BUDGETS) return [];
    if (n.kind === "root") return DATA.subscriptions.length === 1 ? BUDGETS : [];
    if (n.kind === "group" && n.dim === "SubscriptionId") return BUDGETS.filter(b => b.subscription_id === n.key);
    return [];
  }
  const GRAIN_WORD: Record<string, string> = { Monthly: "monthly", Quarterly: "quarterly", Annually: "annual", BillingMonth: "billing month",
    BillingQuarter: "billing quarter", BillingAnnual: "billing year" };
  const grainWord = (b: Budget) => GRAIN_WORD[b.time_grain] ?? b.time_grain;

  return {
    DATA, EXPORT, BUDGETS, budgetState, budgetsOf, grainWord, DETAIL, RELATED, DRILLABLE, drillLevel, label, N, SPLIT, DAYS, TAG, CUR, DIM, grand, UNTAGGED, TIPS, LABEL, PREV, PREV_SHORT,
    money, bigMoney, period, category, color, tree, credits, totalsOnly, portalHref,
    tipDetail, tipLine, biggestDrops, worthALook, marks, isTodo,
  };
}
