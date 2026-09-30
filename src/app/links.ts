// Links to a view: what to read (subscriptions, period, cost type, tag) and where to look (view, group, box). Whoever
// opens one signs in and reads those costs themselves, so they see only what their own Azure access allows; the link
// carries no costs and no token. The run's settings travel in the query string, the place too:
//   /?subs=<id>,<id>&period=mtd&view=resource&group=<resource group id>&item=<resource id>
import type { PeriodSpec } from "../core/period";
import type { Metric, ViewKey } from "../core/types";

/** What a run read: enough to read it again. */
export interface RunSpec {
  demo?: boolean;
  subs?: string[];
  scope?: string;
  period: PeriodSpec;
  metric: Metric;
  tag: string | null;
}

/** Where to look once it's read: a view, and a group or a box in it. */
export interface Place {
  view: ViewKey;
  group: string | null;
  item: string | null; // a box in the group, which opens the group
}

const VIEWS: ViewKey[] = ["service", "subscription", "region", "resource", "type", "tag"];

function periodParam(p: PeriodSpec): string {
  if (p.mode === "days") return `days-${p.days ?? 30}`;
  if (p.mode === "custom") return `${p.from}_${p.to}`;
  return p.mode;
}

function parsePeriod(s: string | null): PeriodSpec {
  if (!s) return { mode: "days", days: 30 };
  if (s === "mtd" || s === "lastMonth") return { mode: s };
  const days = /^days-(\d+)$/.exec(s);
  if (days) return { mode: "days", days: Number(days[1]) };
  const range = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (range) return { mode: "custom", from: range[1], to: range[2] };
  return { mode: "days", days: 30 };
}

export function buildLink(base: string, run: RunSpec, place: Place): string {
  const q = new URLSearchParams();
  if (run.demo) q.set("demo", "1");
  else if (run.scope) q.set("scope", run.scope);
  else q.set("subs", (run.subs ?? []).join(","));
  if (!run.demo) {
    q.set("period", periodParam(run.period));
    if (run.metric !== "ActualCost") q.set("metric", run.metric);
    if (run.tag) q.set("tag", run.tag);
  }
  q.set("view", place.view);
  if (place.group !== null) q.set("group", place.group);
  if (place.item !== null) q.set("item", place.item);
  return `${base}?${q}`;
}

/** The link this page was opened with, or null when it wasn't one. */
export function parseLink(search: string): { run: RunSpec; place: Place } | null {
  const q = new URLSearchParams(search);
  const demo = q.get("demo") === "1", subs = q.get("subs"), scope = q.get("scope");
  if (!demo && !subs && !scope) return null;
  const view = q.get("view") as ViewKey | null;
  return {
    run: {
      demo, scope: scope || undefined,
      subs: subs ? subs.split(",").map(s => s.trim().toLowerCase()).filter(s => /^[0-9a-f-]{36}$/.test(s)) : undefined,
      period: parsePeriod(q.get("period")),
      metric: q.get("metric") === "AmortizedCost" ? "AmortizedCost" : "ActualCost",
      tag: q.get("tag"),
    },
    place: { view: view && VIEWS.includes(view) ? view : "service", group: q.get("group"), item: q.get("item") },
  };
}

/** The subscription a group or box belongs to, when there's exactly one: a link to it needs to read only that one. */
export function subscriptionOf(view: ViewKey, group: string | null, item: string | null): string | null {
  if (view === "subscription" && group) return group.toLowerCase();
  const m = /^\/subscriptions\/([0-9a-f-]{36})/i.exec(item ?? group ?? "");
  return (view === "resource" || view === "type") && m ? m[1].toLowerCase() : null; // a type spans subscriptions; its resources don't
}
