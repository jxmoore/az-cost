// The squarified treemap and the long-tail folding, as positions: the Viewer draws them.
import type { TNode } from "./model";

export interface Rect { x: number; y: number; w: number; h: number }
export interface Placed extends Rect { n: TNode }
export interface Cell extends Placed {
  type: "group" | "leaf";
  gap: number;
  header?: "full" | "name"; // a group's heading: name and amount, or only the name when it's small
}

const sz = (n: TNode) => n.size ?? n.cur;

export function squarify(nodes: TNode[], x: number, y: number, w: number, h: number): Placed[] {
  const out: Placed[] = [], total = nodes.reduce((s, n) => s + sz(n), 0);
  if (total <= 0 || w < 1 || h < 1) return out;
  let items = nodes.map(n => ({ n, a: (sz(n) / total) * w * h }));
  const worst = (row: { a: number }[], side: number) => {
    let s = 0, mx = 0, mn = Infinity;
    for (const r of row) { s += r.a; mx = Math.max(mx, r.a); mn = Math.min(mn, r.a); }
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  while (items.length) {
    const side = Math.min(w, h);
    const row = [items[0]];
    let best = worst(row, side), i = 1;
    for (; i < items.length; i++) {
      const next = worst([...row, items[i]], side);
      if (next > best) break;
      row.push(items[i]); best = next;
    }
    items = items.slice(i);
    const area = row.reduce((s, r) => s + r.a, 0);
    if (w >= h) {
      const cw = items.length ? area / h : w;
      let cy = y;
      for (const r of row) { const rh = r.a / cw; out.push({ n: r.n, x, y: cy, w: cw, h: rh }); cy += rh; }
      x += cw; w -= cw;
    } else {
      const rh = items.length ? area / w : h;
      let cx = x;
      for (const r of row) { const rw = r.a / rh; out.push({ n: r.n, x: cx, y, w: rw, h: rh }); cx += rw; }
      y += rh; h -= rh;
    }
  }
  return out;
}

// the long tail: boxes too small to read or click become one "+N more" box (clicking it twice opens it)
const MIN_BOX = 16 * 16; // px²
export function foldTail(nodes: TNode[], w: number, h: number, many: (n: TNode) => string): TNode[] {
  const total = nodes.reduce((s, n) => s + n.cur, 0), px = total > 0 ? (w * h) / total : 0;
  const i = nodes.findIndex(n => n.cur * px < MIN_BOX);
  if (i < 0 || nodes.length - i < 2) return nodes;
  const rest = nodes.slice(i), first = rest[0];
  const more: TNode = {
    kind: "leaf", more: rest.length, rest, key: "\u0000more", name: `+${rest.length} more`, dim: first.dim, parent: first.parent,
    hit: rest.some(n => n.hit), // lit when the filter matches something inside it
    full: `${rest.length} smaller ${many(first)}`, cur: 0, prev: 0, credits: 0, size: null, children: null, gone: [],
    daily: new Float64Array(first.daily.length),
  };
  for (const n of rest) {
    more.cur += n.cur; more.prev += n.prev;
    for (let d = 0; d < more.daily.length; d++) more.daily[d] += n.daily[d];
  }
  return [...nodes.slice(0, i), more].sort((a, b) => b.cur - a.cur);
}

/** Everything one map draws, in drawing order (a group, then its boxes; largest first), which Tab walks. */
export function layout(root: TNode, zoomed: TNode | undefined, more: number, W: number, H: number,
  many: (n: TNode) => string): { cells: Cell[]; moreCount: number } {
  const cells: Cell[] = [];
  let moreCount = 0;
  const base = zoomed || root;
  const leaf = (p: Placed) => cells.push({ ...p, type: "leaf", gap: 1 });
  if (!base.children!.length || W < 1 || H < 1) return { cells, moreCount };
  if (base === root) {
    for (const r of squarify(root.children!, 0, 0, W, H)) {
      const g: Cell = { ...r, type: "group", gap: 1.5 };
      cells.push(g);
      if (r.w > 46 && r.h > 40) {
        g.header = "full";
        for (const c of squarify(foldTail(r.n.children!, r.w - 8, r.h - 25, many), r.x + 4, r.y + 21, r.w - 8, r.h - 25)) leaf(c);
      } else if (r.w > 30 && r.h > 16) g.header = "name";
    }
  } else {
    let nodes = base.children!; // "+N more" opened: its boxes, one level of the long tail at a time
    for (let i = 0; i < more; i++) {
      const m = foldTail(nodes, W, H, many).find(n => n.more);
      if (!m) break;
      nodes = m.rest!;
    }
    moreCount = more ? nodes.length : 0;
    for (const r of squarify(foldTail(nodes, W, H, many), 0, 0, W, H)) leaf(r);
  }
  return { cells, moreCount };
}

/** A cell's box on screen: its slot less the gap around it. */
export const boxOf = (c: Cell): Rect =>
  ({ x: c.x + c.gap, y: c.y + c.gap, w: Math.max(0, c.w - c.gap * 2), h: Math.max(0, c.h - c.gap * 2) });
