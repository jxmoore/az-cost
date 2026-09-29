import { describe, expect, it } from "vitest";
import { demo } from "../src/core/demo";
import { summarize } from "../src/core/summarize";
import { layout } from "../src/viewer/layout";
import { createModel, VIEW_KEYS } from "../src/viewer/model";

describe("viewer model", () => {
  it("lays out every view of the demo", () => {
    const d = demo(30, "2026-09-28"), M = createModel(d, summarize(d));
    for (const v of VIEW_KEYS) {
      const root = M.tree(v, "", false);
      const { cells } = layout(root, undefined, 0, 1000, 700, n => M.DIM[n.dim!].many);
      expect(cells.length).toBeGreaterThan(3);
      const g = root.children![0];
      expect(layout(root, g, 0, 1000, 700, n => M.DIM[n.dim!].many).cells.length).toBeGreaterThan(0);
    }
    expect(M.worthALook().length).toBeGreaterThan(3);
    expect(M.biggestDrops().length).toBeGreaterThan(0);
  });
});
