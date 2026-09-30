// Reading costs from a fake Azure, and what the rules make of them. The expected outputs are snapshots in
// __snapshots__/: after an intended change to the fetcher or the rules, review the diff and run `npm test -- -u`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Azure } from "../src/azure/client";
import { fetchCosts, fetchTagView, subscriptionTarget, type OnUpdate } from "../src/azure/costs";
import { demo } from "../src/core/demo";
import { resolvePeriod, type Period } from "../src/core/period";
import { pit, summarize } from "../src/core/summarize";
import type { CostData } from "../src/core/types";
import { A, B, DAYS, fakeAzure, TODAY } from "../src/dev/fakeAzure";

afterEach(() => vi.unstubAllGlobals());

async function read(concurrency?: number, onUpdate?: OnUpdate): Promise<{ data: CostData; seen: string[] }> {
  const fake = fakeAzure();
  vi.stubGlobal("fetch", fake.fetch);
  const targets = [subscriptionTarget({ id: A, name: "team-a", tenant: "t1" }), subscriptionTarget({ id: B, name: "team-b", tenant: "t1" })];
  const data = await fetchCosts(new Azure(async () => "token"), targets,
    { period: resolvePeriod({ mode: "days", days: DAYS }, TODAY) as Period, metric: "ActualCost", advisor: true, graph: true, tag: null, today: TODAY, concurrency }, () => {}, onUpdate);
  return { data: { ...data, generated: "2026-09-28 10:00" }, seen: fake.seen };
}

describe("reading in stages", () => {
  it("shows the map before everything is read, and never half a view", async () => {
    const updates: { views: string[]; pending: string[]; advisor: boolean }[] = [];
    await read(3, (d, pending) => updates.push({ views: Object.keys(d.views), pending, advisor: d.advisor !== null }));
    expect(updates[0]).toEqual({ views: ["service", "subscription"], pending: ["resources", "regions", "tags", "forecast", "detail", "budgets", "Advisor", "idle checks"], advisor: false });
    expect(updates[1].views).toEqual(["service", "subscription", "resource"]);
    expect(updates[2].views).toEqual(["service", "subscription", "region", "resource", "tag"]);
    expect(updates[2].pending).toEqual(["detail", "budgets", "Advisor", "idle checks"]);
  }, 20000);

  it("gives the same data however many subscriptions are read at once", async () => {
    const one = (await read(1)).data, many = (await read(8)).data;
    expect(JSON.stringify(many)).toBe(JSON.stringify(one));
  }, 30000);
});

describe("reading costs", () => {
  it("copes with throttling, rejected columns, paging limits and missing access", async () => {
    const { data, seen } = await read();
    expect(seen.filter(s => s.includes("CostManagement/query")).length).toBeGreaterThan(20); // incl. the retried 429
    expect(data.resource_fallback).toEqual(["team-b"]); // too many pages: period totals instead of daily rows
    expect(data.mixed_currencies).toEqual(["EUR", "USD"]); // team-b answered in euros only
    expect(data.advisor_error).toBe("HTTP 403"); // only the status: Azure's message names the caller
    expect(data.advisor?.[0].annual_savings).toBe(2100); // duplicate tips: the biggest saving is kept
    expect(data.views.tag?.tag).toBe("env"); // the tag on the most resources, hidden-* ignored
    expect(data.tag_names).toEqual([{ name: "env", count: 6 }, { name: "owner", count: 2 }]); // for the picker: Env and env are one tag
    expect(data.budgets?.map(b => [b.name, b.filtered])).toEqual([["team-a-monthly", false], ["rg-data-budget", true]]); // cost budgets only
    // the detail (resource x meter, per period) adds up to the same bill as the service view, both periods
    const sum = (rows: { d: number[] }[], from: number, to: number) => rows.reduce((s, r) => s + r.d.slice(from, to).reduce((a, b) => a + b, 0), 0);
    const service = data.views.service!.rows;
    expect(sum(data.detail!.rows, 1, 2)).toBeCloseTo(sum(service, data.split, data.days.length), 2);
    expect(sum(data.detail!.rows, 0, 1)).toBeCloseTo(sum(service, 0, data.split), 2);
    // and knows its meters: the VM in rg-app-dev ran on D2 v2
    const vm = data.detail!.rows.find(r => r.k[0].endsWith("/virtualmachines/vm-dev1"))!;
    expect(data.detail!.meters[vm.k[1]]).toEqual({ service: "Virtual Machines", meter: "D2 v2" });
    // each resource's region and tag value, for drilling the region and tag views
    expect(data.detail!.regions![vm.k[0]]).toBe("eastus");
    expect(data.detail!.tags![vm.k[0]]).toBe("dev");
    // what's attached to the VM, from Resource Graph: its disk, its NIC, and the NIC's public IP
    expect(Object.values(data.related!)[0].map(id => id.split("/").pop())).toEqual(["vm-dev1-os", "vm-dev1-nic", "pip-old"]);
    await expect(JSON.stringify(data, null, 1)).toMatchFileSnapshot("__snapshots__/fetch-data.json");
  }, 20000);

  it("turns them into worth-a-look hints", async () => {
    const s = summarize((await read()).data);
    expect(s.hints.map(h => h.kind)).toContain("spike");
    expect(s.hints.map(h => h.kind)).toContain("idle");
    expect(s.totals.credits_and_refunds).toBeLessThan(0);
    const over = s.hints.filter(h => h.kind === "budget");
    expect(over).toHaveLength(1); // the other budget is on track
    expect(over[0]).toMatchObject({ budget: "team-a-monthly", amount: 30, reason: "forecast to reach 110% of its monthly budget by the end of the month" });
    await expect(JSON.stringify(s, null, 1)).toMatchFileSnapshot("__snapshots__/fetch-summary.json");
  }, 20000);
});

describe("choosing another tag", () => {
  it("reads it for the run's subscriptions and period, with each resource's value for drilling", async () => {
    const { data } = await read();
    const fake = fakeAzure();
    vi.stubGlobal("fetch", fake.fetch);
    const { view, tags } = await fetchTagView(new Azure(async () => "token"), data, "owner", () => {});
    expect(view.tag).toBe("owner");
    expect(view.dims).toEqual(["TagValue", "ServiceName"]);
    expect(fake.seen.every(s => s.includes("CostManagement/query"))).toBe(true); // only the tag's own queries
    // the same bill: the tag view adds up to what the run read, both periods
    const sum = (rows: { d: number[] }[]) => rows.reduce((s, r) => s + r.d.reduce((a, b) => a + b, 0), 0);
    expect(sum(view.rows)).toBeCloseTo(sum(data.views.service!.rows), 2);
    expect(tags[data.detail!.rows.find(r => r.k[0].endsWith("/vm-dev1"))!.k[0]]).toBe("dev");
  }, 20000);
});

describe("the demo", () => {
  it("has a story for every list", async () => {
    const d = { ...demo(30, TODAY), generated: "2026-09-28 10:00" }, s = summarize(d);
    const kinds = new Set(s.hints.map(h => h.kind));
    for (const k of ["spike", "pit", "idle", "devtest", "budget"]) expect(kinds).toContain(k);
    expect(s.hints.filter(h => h.kind === "budget").map(h => h.reason)).toEqual([ // biggest overrun first: $650, then $150
      "forecast to reach 108% of its monthly budget by the end of the month", "already 137% of its monthly budget"]);
    expect(s.totals.credits_and_refunds).toBeLessThan(0); // the refunded reservation
    expect(s.top_drops.some(x => x.meter === "E8s v5")).toBe(true); // the scaled-down ETL worker
    expect(s.advisor?.[0].covers.length).toBeGreaterThan(0); // the SQL reservation covers the vCore meter
    expect(d.forecast?.total).toBeGreaterThan(0);
    await expect(JSON.stringify(s, null, 1)).toMatchFileSnapshot("__snapshots__/demo-summary.json");
  });
});

describe("money pits", () => {
  it("knows retiring VM series and priced rules", () => {
    expect(pit("Virtual Machines", "D2 v2")).toMatch(/1 May 2028/);
    expect(pit("Virtual Machines", "B2ms")).toMatch(/15 Nov 2028/);
    expect(pit("Virtual Machines", "D4s v5")).toBeNull();
    expect(pit("Azure Front Door Service", "Standard Base Fees", 50)).toBeNull(); // under its floor
    expect(pit("Azure Front Door Service", "Standard Base Fees", 140)).toMatch(/about 4 Front Door/);
  });
});
