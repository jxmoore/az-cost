// The data contract between the fetcher (or demo) and the viewer.
import type { RunSpec } from "../app/links";
import type { PeriodMode } from "./period";

export type ViewKey = "service" | "subscription" | "region" | "resource" | "type" | "tag";
export type Dim = "ServiceName" | "Meter" | "SubscriptionId" | "ResourceLocation" | "ResourceGroupName" | "ResourceId" | "ResourceType" | "TagValue";
export type Metric = "ActualCost" | "AmortizedCost";

/** One packed row: [outer key, inner key] and its daily totals over both periods. */
export interface PackedRow { k: [string, string]; d: number[] }

export interface ViewData {
  dims: [Dim, Dim];
  names: Record<string, string>;
  rows: PackedRow[];
  tag?: string; // the tag view: which tag its values are of
}

export interface SubInfo { id: string; name: string; currency: string | null; tenant?: string | null }

export interface AdvisorRec {
  problem: string;
  solution: string;
  impact: string | null;
  resource: string;
  resource_name: string;
  resource_type: string | null;
  sku: string | null;
  term: string | null;
  region?: string | null;
  annual_savings: number | null;
  currency: string | null;
  subscription: string;
}

export interface GraphFinding { check: string; id: string; name: string; resourceGroup: string; subscriptionId: string }

/** A cost budget on a subscription, with Azure's spend and forecast for the budget's current period. */
export interface Budget {
  name: string;
  subscription: string; // its name
  subscription_id: string;
  amount: number;
  time_grain: string; // Monthly, Quarterly, Annually, BillingMonth, ...
  current: number | null;
  forecast: number | null;
  currency: string | null;
  filtered: boolean; // it covers part of the subscription (a resource group, a tag, ...)
}

export interface Forecast { month: string; actual: number; forecast: number; total: number }

export interface CostData {
  days: string[]; // ISO dates, previous period then current period (they needn't touch: month to date)
  split: number; // index of the current period's first day
  period?: { mode: PeriodMode; label: string }; // what the current period is: "last 30 days", "September 2026"
  views: Partial<Record<ViewKey, ViewData>>;
  currency: string;
  subscriptions: SubInfo[];
  resource_fallback: string[];
  advisor: AdvisorRec[] | null;
  advisor_error: string | null;
  budgets?: Budget[] | null; // null: not read (yet)
  budget_error?: string | null;
  mixed_currencies?: string[] | null;
  usd_rate?: number | null;
  forecast: Forecast | null;
  forecast_note: string | null;
  graph: GraphFinding[] | null;
  graph_error: string | null;
  demo: boolean;
  generated?: string;
  metric?: Metric;
  run?: RunSpec; // what was asked for, so the page can link to it
}

// ---------------------------------------------------------------- dates, as ISO strings in UTC arithmetic

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today in the viewer's own time zone, like Python's date.today(). */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

/** The last day of the month `iso` is in. */
export function monthEnd(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The day before yesterday. Azure takes 8-24 hours to post usage, so yesterday is still filling in
 * and would drag down every comparison, grower and pace figure. */
export const lastFullDay = (today: string = localToday()) => addDays(today, -2);

export const nowStamp = () => {
  const d = new Date();
  return `${localToday()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
