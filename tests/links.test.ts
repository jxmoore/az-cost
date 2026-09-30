import { describe, expect, it } from "vitest";
import { buildLink, parseLink, subscriptionOf } from "../src/app/links";

const SUB = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RG = `/subscriptions/${SUB}/resourcegroups/rg-app`;
const VM = `${RG}/providers/microsoft.compute/virtualmachines/vm-1`;

describe("links", () => {
  it("round-trip a run and a place", () => {
    const run = { subs: [SUB], period: { mode: "custom" as const, from: "2026-09-01", to: "2026-09-15" }, metric: "AmortizedCost" as const, tag: "env" };
    const url = buildLink("https://costs.example.com/", run, { view: "resource", group: RG, item: VM });
    expect(url.startsWith("https://costs.example.com/?subs=")).toBe(true);
    const back = parseLink(new URL(url).search)!;
    expect(back.place).toEqual({ view: "resource", group: RG, item: VM });
    expect(back.run).toMatchObject({ subs: [SUB], period: run.period, metric: "AmortizedCost", tag: "env", demo: false });
  });

  it("keep default settings out of the link", () => {
    const url = buildLink("/", { subs: [SUB], period: { mode: "mtd" }, metric: "ActualCost", tag: null }, { view: "service", group: null, item: null });
    expect(url).toBe(`/?subs=${SUB}&period=mtd&view=service`);
    expect(parseLink(url.slice(1))!.run.period).toEqual({ mode: "mtd" });
  });

  it("open the demo without Azure", () => {
    const url = buildLink("/", { demo: true, period: { mode: "days", days: 30 }, metric: "ActualCost", tag: null }, { view: "tag", group: "", item: null });
    expect(url).toBe("/?demo=1&view=tag&group=");
    expect(parseLink("?demo=1&view=tag&group=")!.place).toEqual({ view: "tag", group: "", item: null }); // "" is a real group
  });

  it("ignore what isn't a link, and what a link can't hold", () => {
    expect(parseLink("")).toBeNull();
    expect(parseLink("?fake")).toBeNull();
    const odd = parseLink("?subs=not-a-guid," + SUB.toUpperCase() + "&view=nonsense&period=weird")!;
    expect(odd.run.subs).toEqual([SUB]);
    expect(odd.place.view).toBe("service");
    expect(odd.run.period).toEqual({ mode: "days", days: 30 });
  });

  it("know which subscription a box belongs to", () => {
    expect(subscriptionOf("resource", RG, VM)).toBe(SUB);
    expect(subscriptionOf("resource", RG, null)).toBe(SUB);
    expect(subscriptionOf("subscription", SUB.toUpperCase(), "Virtual Machines")).toBe(SUB);
    expect(subscriptionOf("service", "Virtual Machines", "D4s v5")).toBeNull(); // a service spans subscriptions
  });
});
