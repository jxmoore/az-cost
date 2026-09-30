import { describe, expect, it } from "vitest";
import { subscriptionOf } from "../src/app/links";
import { demo } from "../src/core/demo";
import { NO_TYPE, typeLabel, typeOf } from "../src/core/resourceTypes";
import { summarize } from "../src/core/summarize";
import { toCsv } from "../src/viewer/csv";
import { createModel } from "../src/viewer/model";

const SUB = "/subscriptions/11111111-1111-1111-1111-111111111111";

describe("resource types", () => {
  it("read the type from a resource id, children included", () => {
    expect(typeOf(`${SUB}/resourcegroups/rg/providers/microsoft.compute/virtualmachines/vm-1`)).toBe("microsoft.compute/virtualmachines");
    expect(typeOf(`${SUB}/resourceGroups/rg/providers/Microsoft.Sql/servers/sql1/databases/orders`)).toBe("microsoft.sql/servers/databases");
    expect(typeOf(`${SUB}/providers/microsoft.security/pricings/virtualmachines`)).toBe("microsoft.security/pricings"); // no resource group
    expect(typeOf("Azure Savings Plan")).toBe(NO_TYPE);
  });

  it("name the common ones, and say what the others are", () => {
    expect(typeLabel("microsoft.compute/virtualmachines")).toBe("Virtual machines");
    expect(typeLabel("microsoft.sql/servers/databases")).toBe("SQL databases");
    expect(typeLabel("microsoft.foo/widgets/gears")).toBe("widgets / gears (foo)");
  });
});

describe("the type view", () => {
  const d = demo(30, "2026-09-28"), M = createModel(d, summarize(d));

  it("drills from Virtual machines into each VM, with its change", () => {
    const vms = M.tree("type", "", false).children!.find(g => g.key === "microsoft.compute/virtualmachines")!;
    expect(vms.name).toBe("Virtual machines");
    expect(vms.children!.map(n => n.name).sort()).toEqual(["vm-app-01", "vm-app-02", "vm-etl-worker", "vm-gpu-train", "vm-legacy-ftp"]);
    const etl = vms.children!.find(n => n.name === "vm-etl-worker")!;
    expect(etl.cur).toBeLessThan(etl.prev); // the scaled-down worker
    // a VM carries what's billed to it: vm-app-01 has its compute and its data transfer out
    const app1 = vms.children!.find(n => n.name === "vm-app-01")!, app2 = vms.children!.find(n => n.name === "vm-app-02")!;
    expect(app1.cur).toBeGreaterThan(app2.cur);
  });

  it("adds up to the same bill as the resource view", () => {
    expect(M.tree("type", "", false).cur).toBeCloseTo(M.tree("resource", "", false).cur, 6);
    const csv = toCsv(M, { view: "type", group: null, filter: "" }).replace(/^﻿/, "").trimEnd().split("\r\n").slice(1);
    expect(csv.reduce((s, r) => s + Number(r.match(/,(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),/)![1]), 0)).toBeCloseTo(M.grand, 0);
  });

  it("is there only once the resource view is", () => {
    const { resource: _r, ...early } = d.views;
    expect(createModel({ ...d, views: early }, summarize(d)).DATA.views.type).toBeUndefined();
    expect(M.DATA.views.type?.dims).toEqual(["ResourceType", "ResourceId"]);
  });

  it("links a resource to its own subscription", () => {
    const vm = `${SUB}/resourcegroups/rg/providers/microsoft.compute/virtualmachines/vm-1`;
    expect(subscriptionOf("type", "microsoft.compute/virtualmachines", vm)).toBe("11111111-1111-1111-1111-111111111111");
    expect(subscriptionOf("type", "microsoft.compute/virtualmachines", null)).toBeNull(); // a type spans subscriptions
  });
});
