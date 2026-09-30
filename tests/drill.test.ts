import { describe, expect, it } from "vitest";
import { buildLink, parseLink } from "../src/app/links";
import { demo } from "../src/core/demo";
import { summarize } from "../src/core/summarize";
import { levelCsv } from "../src/viewer/csv";
import { defaultNext, level, meterKey, options, stepFor, type Drill } from "../src/viewer/drill";
import { createModel } from "../src/viewer/model";

const d = demo(30, "2026-09-28"), M = createModel(d, summarize(d));
const detail = d.detail!;
const VMS = { dim: "service" as const, key: "Virtual Machines" };
const D4S = { dim: "meter" as const, key: meterKey("Virtual Machines", "D4s v5") };

describe("drilling into the detail", () => {
  it("goes from a VM size to the VMs that ran on it", () => {
    const vms = level(detail, [VMS, D4S], "resource");
    expect(vms.map(r => r.key.split("/").pop())).toEqual(["vm-app-01", "vm-app-02"]);
    expect(vms[0].cur + vms[1].cur).toBeCloseTo(M.tree("service", "", false).children!.find(g => g.key === "Virtual Machines")!
      .children!.find(n => n.key === "D4s v5")!.cur, 2); // to the cent: rows are stored to 1/100 of a cent
  });

  it("adds up to the box it came from, in both periods", () => {
    const vm = M.tree("service", "", false).children!.find(g => g.key === "Virtual Machines")!;
    for (const by of ["meter", "resource", "group", "type", "subscription"] as const) {
      const rows = level(detail, [VMS], by);
      expect(rows.reduce((s, r) => s + r.cur, 0), by).toBeCloseTo(vm.cur, 2);
      expect(rows.reduce((s, r) => s + r.prev, 0), by).toBeCloseTo(vm.prev, 2);
    }
  });

  it("opens a VM on a meter to what's attached to it, and nothing else there", () => {
    const rel = d.related!, app1 = level(detail, [VMS, D4S], "resource")[0].key, app2 = level(detail, [VMS, D4S], "resource")[1].key;
    expect(defaultNext([VMS, D4S, { dim: "resource", key: app1 }], rel)).toBe("attached");
    expect(defaultNext([VMS, D4S, { dim: "resource", key: app1 }])).toBeNull(); // no Resource Graph: not clickable
    const attached = level(detail, [VMS, D4S, { dim: "resource", key: app1 }], "attached", rel);
    expect(attached.map(r => r.key.split("/").pop())).toEqual(["vm-app-01", "vm-app-01-data"]); // its NIC costs nothing
    expect(attached[1].cur).toBeGreaterThan(0); // the disk bills as Storage, yet it's here
    // a resource that isn't a VM, down a meter, doesn't open: its meters would only repeat the path
    const disk = attached[1].key;
    expect(defaultNext([{ dim: "service", key: "Storage" }, { dim: "meter", key: meterKey("Storage", "P30 LRS Disk") }, { dim: "resource", key: disk }], rel)).toBeNull();
    // from the resource or type view, a VM opens to its attachments first; its meters are in the picker
    expect(defaultNext([{ dim: "type", key: "microsoft.compute/virtualmachines" }, { dim: "resource", key: app2 }], rel)).toBe("attached");
    expect(options([{ dim: "resource", key: app2 }], rel)).toEqual(["attached", "service", "meter"]);
    expect(options([{ dim: "resource", key: disk }], rel)).toEqual(["service", "meter"]); // not a VM
    expect(defaultNext([{ dim: "resource", key: disk }], rel)).toBe("meter");
  });

  it("goes the other way too: a resource's meters, a group's types", () => {
    const app1 = level(detail, [VMS, D4S], "resource")[0].key;
    expect(level(detail, [{ dim: "resource", key: app1 }], "meter").map(r => M.label("meter", r.key)).sort())
      .toEqual(["D4s v5", "Standard Data Transfer Out"]); // its compute and the bandwidth billed to it
    const rg = app1.split("/providers/")[0];
    expect(level(detail, [{ dim: "group", key: rg }], "type").map(r => M.label("type", r.key))).toContain("Virtual machines");
  });

  it("picks a natural next level, and never offers what a path already says", () => {
    expect(defaultNext([VMS])).toBe("meter");
    expect(defaultNext([VMS, D4S])).toBe("resource");
    expect(defaultNext([{ dim: "resource", key: "/subscriptions/x/resourcegroups/rg/providers/a/b/c" }])).toBe("meter");
    expect(defaultNext([{ dim: "group", key: "/subscriptions/x/resourcegroups/rg" }])).toBe("type");
    expect(options([{ dim: "resource", key: "r" }])).toEqual(["service", "meter"]); // a resource is in one group, type, subscription
    expect(options([VMS, D4S])).toEqual(["resource", "group", "type", "subscription"]); // a meter is in one service
    expect(defaultNext([VMS, D4S, { dim: "resource", key: "r" }, { dim: "subscription", key: "s" }].slice(0, 3))).toBeNull(); // nothing left
  });

  it("maps a view's boxes to steps, where the detail can follow", () => {
    expect(stepFor("Meter", "D4s v5", "Virtual Machines")).toEqual(D4S);
    expect(stepFor("SubscriptionId", "AAAA")).toEqual({ dim: "subscription", key: "aaaa" });
    expect(stepFor("ResourceLocation", "us east")).toBeNull(); // regions aren't in the detail
    expect(stepFor("ResourceId", "(no resource)")).toBeNull();
  });

  it("builds a level the map and table can show, with a CSV that includes credits", () => {
    const drill: Drill = { path: [VMS, D4S], by: "resource" };
    const { base, all } = M.drillLevel(drill, "", false);
    expect(base.name).toBe("D4s v5");
    expect(base.full).toBe("Virtual Machines / D4s v5");
    expect(base.children!.map(n => n.name)).toEqual(["vm-app-01", "vm-app-02"]);
    expect(base.children!.every(n => n.detail && n.parent === base)).toBe(true);
    const cosmos = M.drillLevel({ path: [{ dim: "service", key: "Azure Cosmos DB" }], by: "meter" }, "", false);
    const csv = levelCsv(M, cosmos.base.full, "Meter", cosmos.all, "meter");
    expect(csv).toContain("Reserved 100 RU/s"); // the refund: not a box, still a row
    expect(all.length).toBe(2);
  });

  it("keeps a filter inside a drilled level", () => {
    const { base } = M.drillLevel({ path: [VMS], by: "resource" }, "etl", true);
    expect(base.children!.map(n => n.name)).toEqual(["vm-etl-worker"]);
  });
});

describe("links to a drilled place", () => {
  it("round-trip the path and the breakdown", () => {
    const drill: Drill = { path: [VMS, D4S], by: "resource" };
    const url = buildLink("/", { demo: true, period: { mode: "days", days: 30 }, metric: "ActualCost", tag: null },
      { view: "service", group: "Virtual Machines", item: "/subscriptions/1/resourcegroups/rg/providers/x/y/vm", drill });
    expect(parseLink(url.slice(1))!.place.drill).toEqual(drill);
  });

  it("ignore a tampered drill", () => {
    expect(parseLink("?demo=1&drill=nonsense")!.place.drill).toBeUndefined();
    expect(parseLink(`?demo=1&drill=${encodeURIComponent('{"path":[["region","x"]],"by":"meter"}')}`)!.place.drill).toBeUndefined();
    expect(parseLink(`?demo=1&drill=${encodeURIComponent('{"path":[["service","x"]],"by":"nope"}')}`)!.place.drill).toBeUndefined();
  });
});
