import { afterEach, describe, expect, it, vi } from "vitest";
import { Azure } from "../src/azure/client";
import { fetchCosts, subscriptionTarget } from "../src/azure/costs";
import { periodDays, resolvePeriod, type Period } from "../src/core/period";
import { summarize } from "../src/core/summarize";
import { A, fakeAzure, TODAY } from "../src/dev/fakeAzure";

afterEach(() => vi.unstubAllGlobals());

describe("periods", () => {
  it("reads the last N full days against the N before", () => {
    expect(resolvePeriod({ mode: "days", days: 7 }, "2026-09-28"))
      .toEqual({ mode: "days", label: "last 7 days", prev: ["2026-09-13", "2026-09-19"], cur: ["2026-09-20", "2026-09-26"] });
    expect(resolvePeriod({ mode: "days", days: 0 }, "2026-09-28")).toHaveProperty("error");
    expect(resolvePeriod({ mode: "days", days: 181 }, "2026-09-28")).toHaveProperty("error");
  });

  it("compares month to date with the same days of last month", () => {
    expect(resolvePeriod({ mode: "mtd" }, "2026-09-28"))
      .toEqual({ mode: "mtd", label: "month to date", prev: ["2026-08-01", "2026-08-26"], cur: ["2026-09-01", "2026-09-26"] });
    // March 30 against a 28-day February: February as far as it goes
    expect(resolvePeriod({ mode: "mtd" }, "2026-03-31")).toMatchObject({ prev: ["2026-02-01", "2026-02-28"], cur: ["2026-03-01", "2026-03-29"] });
    // on the 1st and 2nd there's no full day of the month yet
    expect(resolvePeriod({ mode: "mtd" }, "2026-09-02")).toHaveProperty("error");
    expect(resolvePeriod({ mode: "mtd" }, "2026-09-03")).toMatchObject({ cur: ["2026-09-01", "2026-09-01"], prev: ["2026-08-01", "2026-08-01"] });
  });

  it("compares the last full month with the one before", () => {
    expect(resolvePeriod({ mode: "lastMonth" }, "2026-09-28"))
      .toEqual({ mode: "lastMonth", label: "August 2026", prev: ["2026-07-01", "2026-07-31"], cur: ["2026-08-01", "2026-08-31"] });
    expect(resolvePeriod({ mode: "lastMonth" }, "2026-01-15")).toMatchObject({ label: "December 2025", prev: ["2025-11-01", "2025-11-30"] });
    // on the 1st, yesterday isn't a full day yet
    expect(resolvePeriod({ mode: "lastMonth" }, "2026-09-01")).toMatchObject({ cur: ["2026-08-01", "2026-08-30"] });
  });

  it("compares a custom range with the equally long period before", () => {
    expect(resolvePeriod({ mode: "custom", from: "2026-09-01", to: "2026-09-15" }, "2026-09-28"))
      .toEqual({ mode: "custom", label: "Sep 1 – Sep 15", prev: ["2026-08-17", "2026-08-31"], cur: ["2026-09-01", "2026-09-15"] });
    expect(resolvePeriod({ mode: "custom", from: "2026-09-15", to: "2026-09-01" }, "2026-09-28")).toHaveProperty("error");
    expect(resolvePeriod({ mode: "custom", from: "2026-09-01", to: "2026-10-15" }, "2026-09-28")).toHaveProperty("error");
    expect(resolvePeriod({ mode: "custom", from: "2026-01-01" }, "2026-09-28")).toHaveProperty("error");
  });

  it("lists every day it reads, previous first, with a gap when the periods don't touch", () => {
    const { days, split } = periodDays(resolvePeriod({ mode: "mtd" }, "2026-09-04") as Period);
    expect(days).toEqual(["2026-08-01", "2026-08-02", "2026-09-01", "2026-09-02"]);
    expect(split).toBe(2);
  });

  it("reads month to date: the days between the periods don't count", async () => {
    const fake = fakeAzure();
    vi.stubGlobal("fetch", fake.fetch);
    const period = resolvePeriod({ mode: "mtd" }, TODAY) as Period;
    const data = await fetchCosts(new Azure(async () => "t"), [subscriptionTarget({ id: A, name: "team-a", tenant: "t1" })],
      { period, metric: "ActualCost", advisor: false, graph: false, tag: null, today: TODAY }, () => {});
    expect(data.days[0]).toBe("2026-08-01");
    expect(data.days[data.split]).toBe("2026-09-01");
    expect(data.period).toEqual({ mode: "mtd", label: "month to date" });
    // the fake bills only in its last 14 days (Sep 13-26): all of it is in the current period, none in August
    const s = summarize(data);
    expect(s.totals.previous).toBe(0);
    expect(s.totals.current).toBeGreaterThan(0);
    expect(s.period.label).toBe("month to date");
  }, 20000);
});
