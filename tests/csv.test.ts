import { describe, expect, it } from "vitest";
import { demo } from "../src/core/demo";
import { summarize } from "../src/core/summarize";
import { toCsv } from "../src/viewer/csv";
import { createModel } from "../src/viewer/model";

const d = demo(30, "2026-09-28"), M = createModel(d, summarize(d));
const lines = (csv: string) => csv.replace(/^\ufeff/, "").trimEnd().split("\r\n");

describe("CSV export", () => {
  it("has one row per box of the view, credits included, and adds up to the bill", () => {
    const rows = lines(toCsv(M, { view: "service", group: null, filter: "" }));
    expect(rows[0]).toMatch(/^service,service id,meter,meter id,current \(/);
    const current = rows.slice(1).map(r => Number(r.split(",")[4]));
    expect(current.reduce((s, v) => s + v, 0)).toBeCloseTo(M.tree("service", "", false).cur, 1); // the refund is a row
    expect(rows.some(r => r.includes("Reserved 100 RU/s") && r.split(",")[4] === "-150")).toBe(true);
  });

  it("adds up to the bill in every view", () => {
    for (const view of ["subscription", "region", "resource", "tag"] as const) {
      const total = lines(toCsv(M, { view, group: null, filter: "" })).slice(1).reduce((s, r) => s + Number(r.match(/,(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),/)![1]), 0);
      expect(total, view).toBeCloseTo(M.grand, 0);
    }
  });

  it("exports only the opened group, or only what the filter matches", () => {
    const rows = lines(toCsv(M, { view: "service", group: "Virtual Machines", filter: "" })).slice(1);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every(r => r.startsWith("Virtual Machines,"))).toBe(true);
    const cosmos = lines(toCsv(M, { view: "service", group: null, filter: "cosmos" })).slice(1);
    expect(cosmos.length).toBeGreaterThan(0);
    expect(cosmos.every(r => /Cosmos/.test(r))).toBe(true);
  });

  it("includes what went to zero, keeps negative numbers numeric, and marks UTF-8 for Excel", () => {
    const csv = toCsv(M, { view: "service", group: null, filter: "" });
    expect(csv.startsWith("\ufeff")).toBe(true);
    const e8 = lines(csv).find(r => r.includes("E8s v5"))!.split(",");
    expect(Number(e8[6])).toBeLessThan(0); // the scaled-down worker: a plain negative number, not '-123 text
  });

  it("quotes names with commas, and never lets a name be read as a formula", () => {
    const tricky = { ...d, views: { ...d.views, service: { ...d.views.service!, rows: [
      { k: ["=HYPERLINK(\"x\")", "a, b"] as [string, string], d: d.views.service!.rows[0].d },
    ] } } };
    const T = createModel(tricky, summarize(tricky));
    const row = lines(toCsv(T, { view: "service", group: null, filter: "" }))[1];
    expect(row.startsWith(`"'=HYPERLINK(""x"")"`)).toBe(true);
    expect(row).toContain(`"a, b"`);
  });
});
