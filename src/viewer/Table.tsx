// The map as a table: every box of the current level (all of them, no "+N more"), sortable, with both periods'
// numbers. Selecting a row selects the box; opening a group row opens the group, as on the map.
import { useState } from "react";
import type { Dim, ViewKey } from "../core/types";
import { pct, type Model, type TNode } from "./model";

type Col = "name" | "cur" | "prev" | "change" | "pctChange" | "share" | "daily";
const COLS: [Col, string][] = [["name", ""], ["cur", "current"], ["prev", "previous"], ["change", "change"], ["pctChange", "change %"],
  ["share", "of bill"], ["daily", "per day"]];

interface Props {
  M: Model;
  view: ViewKey;
  base: TNode; // the root, or the opened group
  selNode: TNode | null;
  dimMisses: boolean; // the filter is on and dims what it doesn't match
  levelDim: Dim; // what the rows are (services, meters, resources...)
  canOpen: (n: TNode) => boolean; // rows that open to something new get a ▸
  onSelect: (n: TNode) => void;
  onOpen: (n: TNode) => void;
}

const value = (n: TNode, c: Col, grand: number): number | string => {
  switch (c) {
    case "name": return n.name.toLowerCase();
    case "cur": return n.cur;
    case "prev": return n.prev;
    case "change": return n.cur - n.prev;
    case "pctChange": return n.prev >= 0.01 ? (n.cur - n.prev) / n.prev : n.cur > 0 ? Infinity : 0;
    case "share": return grand ? n.cur / grand : 0;
    case "daily": return n.cur;
  }
};

export function Table({ M, view, base, selNode, dimMisses, levelDim, canOpen, onSelect, onOpen }: Props) {
  const [sort, setSort] = useState<{ col: Col; desc: boolean }>({ col: "cur", desc: true });
  const rows = [...base.children!, ...base.gone]; // what went to zero is listed too, at the bottom by default
  rows.sort((a, b) => {
    const x = value(a, sort.col, M.grand), y = value(b, sort.col, M.grand);
    const d = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number);
    return sort.desc ? -d : d;
  });
  const by = (col: Col) => setSort(s => ({ col, desc: s.col === col ? !s.desc : col !== "name" }));
  const level = M.DIM[levelDim];
  const total = { cur: rows.reduce((s, n) => s + n.cur, 0), prev: rows.reduce((s, n) => s + n.prev, 0) };

  return (
    <div className="table-wrap">
      <table className="costs">
        <thead>
          <tr>{COLS.map(([c, label]) => (
            <th key={c} className={c === "name" ? "name" : "num"} onClick={() => by(c)} aria-sort={sort.col === c ? (sort.desc ? "descending" : "ascending") : "none"}>
              {c === "name" ? level.one : label}{sort.col === c ? (sort.desc ? " ↓" : " ↑") : ""}
            </th>))}
          </tr>
        </thead>
        <tbody>
          {rows.map(n => {
            const d = n.cur - n.prev;
            const opens = canOpen(n);
            const cls = (n === selNode ? "sel " : "") + (dimMisses && !n.hit ? "dim " : "") + (n.cur < 0.005 ? "gone" : "");
            return (
              <tr key={n.key} className={cls} onClick={() => (n === selNode ? onOpen(n) : onSelect(n))}
                onDoubleClick={() => onOpen(n)} title={n.full}>
                <td className="name"><i style={{ background: M.color(n, view, false) }} />{n.name}{opens && <span className="opens" title="click again to open">▸</span>}</td>
                <td className="num">{M.money(n.cur)}</td>
                <td className="num dimc">{M.money(n.prev)}</td>
                <td className={"num " + (Math.abs(d) < 0.005 ? "" : d > 0 ? "upc" : "downc")}>{d > 0 ? "+" : ""}{M.money(d)}</td>
                <td className="num">{n.prev < 0.01 ? (n.cur > 0 ? "new" : "–") : `${d > 0 ? "+" : ""}${pct(d / n.prev)}`}</td>
                <td className="num">{pct(M.grand ? n.cur / M.grand : 0)}</td>
                <td className="num dimc">{M.money(n.cur / M.DAYS)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td className="name">{rows.length} {rows.length === 1 ? level.one : level.many}</td>
            <td className="num">{M.money(total.cur)}</td>
            <td className="num dimc">{M.money(total.prev)}</td>
            <td className="num">{total.cur - total.prev > 0 ? "+" : ""}{M.money(total.cur - total.prev)}</td>
            <td className="num">{total.prev >= 0.01 ? pct((total.cur - total.prev) / total.prev) : "–"}</td>
            <td className="num">{pct(M.grand ? total.cur / M.grand : 0)}</td>
            <td className="num dimc">{M.money(total.cur / M.DAYS)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
