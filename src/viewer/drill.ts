// Drilling from anything into anything: past a view's two levels, the page reads the detail (what each resource
// spent on each meter, per period). A drill is a path of steps (Virtual Machines, then D4s v5) and what to break
// the last one down by (resources). Each step filters the detail; the breakdown groups what's left.
import { NO_TYPE, typeOf } from "../core/resourceTypes";
import type { Detail, Dim } from "../core/types";

/** What the detail can be broken down by. Region and tag aren't in it: those views stop at their second level. */
export type DD = "service" | "meter" | "resource" | "group" | "type" | "subscription";
export const DDS: DD[] = ["service", "meter", "resource", "group", "type", "subscription"];
export interface Step { dim: DD; key: string }
export interface Drill { path: Step[]; by: DD }

export const DD_DIM: Record<DD, Dim> = { service: "ServiceName", meter: "Meter", resource: "ResourceId", group: "ResourceGroupName",
  type: "ResourceType", subscription: "SubscriptionId" };
export const DIM_DD: Partial<Record<Dim, DD>> = Object.fromEntries(Object.entries(DD_DIM).map(([dd, dim]) => [dim, dd]));
export const DD_WORD: Record<DD, string> = { service: "service", meter: "meter", resource: "resource", group: "resource group", type: "type",
  subscription: "subscription" };

/** A meter's key: its service and its name (the same name, "Data Stored", is a different meter in Storage and Cosmos DB). */
export const meterKey = (service: string, meter: string) => `${service}\u0000${meter}`;

/** One row of the detail, with everything it's about spelled out. */
export interface Fact { resource: string; meter: string; service: string; group: string; type: string; subscription: string; prev: number; cur: number }

const facts = new WeakMap<Detail, Fact[]>();
export function factsOf(detail: Detail): Fact[] {
  let out = facts.get(detail);
  if (out) return out;
  out = detail.rows.map(r => {
    const [resource, id] = r.k, m = detail.meters[id] ?? { service: "(no service)", meter: id };
    const where = /^(\/subscriptions\/([^/]+))(\/resourcegroups\/[^/]+)?/.exec(resource);
    return {
      resource, service: m.service, meter: meterKey(m.service, m.meter),
      group: where ? where[1] + (where[3] ?? "") : resource, subscription: where ? where[2] : "",
      type: where && resource !== where[1] ? typeOf(resource) : NO_TYPE,
      prev: r.d[0], cur: r.d[1],
    };
  });
  facts.set(detail, out);
  return out;
}

const matches = (f: Fact, s: Step) => f[s.dim] === s.key;

/** What a path already says: a resource is in one group, type and subscription, and a meter is in one service. */
function implied(path: Step[]): Set<DD> {
  const out = new Set<DD>();
  for (const s of path) {
    out.add(s.dim);
    if (s.dim === "resource") ["group", "type", "subscription"].forEach(d => out.add(d as DD));
    if (s.dim === "group") out.add("subscription");
    if (s.dim === "meter") out.add("service");
  }
  return out;
}

/** What the last step can be broken down by. */
export const options = (path: Step[]): DD[] => { const i = implied(path); return DDS.filter(d => !i.has(d)); };

// the natural next level after each kind of step: service, meter, resource, meter...
const NEXT: Record<DD, DD[]> = {
  service: ["meter", "resource"], meter: ["resource", "group"], resource: ["meter", "service"],
  group: ["type", "resource", "service"], type: ["resource", "meter"], subscription: ["service", "group", "type"],
};
export function defaultNext(path: Step[]): DD | null {
  const open = options(path);
  return NEXT[path[path.length - 1].dim].find(d => open.includes(d)) ?? open[0] ?? null;
}

export interface LevelRow { key: string; cur: number; prev: number }

/** The facts on a path, grouped by `by`: one row per key, biggest first. */
export function level(detail: Detail, path: Step[], by: DD): LevelRow[] {
  const out = new Map<string, LevelRow>();
  for (const f of factsOf(detail)) {
    if (!path.every(s => matches(f, s))) continue;
    const key = f[by];
    let r = out.get(key);
    if (!r) out.set(key, (r = { key, cur: 0, prev: 0 }));
    r.cur += f.cur;
    r.prev += f.prev;
  }
  return [...out.values()].sort((a, b) => b.cur - a.cur);
}

/** The step a box of a view stands for, or null where the detail can't follow (regions, tag values). */
export function stepFor(dim: Dim, key: string, parentKey?: string): Step | null {
  const dd = DIM_DD[dim];
  if (!dd) return null;
  if (dd === "meter") return parentKey === undefined ? null : { dim: "meter", key: meterKey(parentKey, key) };
  if (dd === "subscription") return { dim: dd, key: key.toLowerCase() };
  if (dd === "resource" && !key.startsWith("/")) return null; // "(no resource)", "(under a cent each)": nothing to open
  return { dim: dd, key };
}
