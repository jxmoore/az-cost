// The treemap page. Click selects, click again opens; the side panel
// explains the selection and lists what's worth a look.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { summarize } from "../core/summarize";
import type { CostData, ViewKey } from "../core/types";
import { boxOf, layout, type Cell, type Rect } from "./layout";
import {
  CATS, createModel, day, esc, HINT_TAG, pct, SHOWN_HINTS, SHOWN_RECS, shortSvc, sym, VIEW_KEYS, VIEW_NAMES,
  type Model, type TNode,
} from "./model";
import { buildLink, subscriptionOf, type Place } from "../app/links";
import { downloadCsv, downloadLevelCsv } from "./csv";
import { defaultNext, DD_DIM, DD_WORD, DIM_DD, options, stepFor, type DD, type Drill, type Step } from "./drill";
import { SharePanel } from "./Share";
import { Table } from "./Table";
import { TagPicker } from "./TagPicker";
import "./viewer.css";

/** The selection, as something that survives a rebuild: keys into the tree, the "+N more" box of a group, or a node
 * that isn't on the map at all (a meter that went to zero, opened from Biggest drops). */
type Sel = null | { k: [string, string | null] } | { more: string } | { node: TNode } | { d: string }; // d: a box of a drilled level

interface VS {
  view: ViewKey;
  change: boolean;
  filter: string;
  collapsed: boolean; // Enter in the filter: only the matches are in the tree
  more: number; // levels into a "+N more" box
  zoom: string | null; // a group key; "" is a real key (the no-region group), so never test it for truthiness
  sel: Sel;
  expanded: { hints: boolean; recs: boolean };
  table: boolean; // the current level as a table instead of the map
  drill: Drill | null; // past the opened group's boxes: a path into the detail, and what its last step is broken down by
}

const narrowedOf = (s: VS) => !!s.filter && s.collapsed;
const keyOf = (n: TNode): [string, string | null] => (n.kind === "group" ? [n.key, null] : [n.parent!.key, n.key]);
function findNode(root: TNode, k: [string, string | null] | null | undefined): TNode | null {
  if (!k) return null;
  const g = root.children!.find(g => g.key === k[0]);
  return (k[1] === null ? g : g?.children!.find(c => c.key === k[1])) ?? null;
}

interface Props {
  data: CostData;
  who?: string | null;
  onNewRun: () => void;
  loading?: string[]; // what the run is still reading: the map shows what's there and fills in
  loadError?: string | null; // the run stopped early: what's shown is all there is
  initial?: Place | null; // where a shared link points: shown once its view has been read
  onChooseTag?: ((tag: string) => void) | null; // read the tag view for another tag (null: can't, say why in tagUnavailable)
  tagUnavailable?: string | null;
  notice?: string | null; // something to know about what's shown (a link's subscriptions this login can't read)
}

export function Viewer({ data, who, onNewRun, loading = [], loadError = null, initial = null, notice = null, onChooseTag = null, tagUnavailable = null }: Props) {
  const M = useMemo(() => createModel(data, summarize(data)), [data]);
  const { DATA } = M;

  const [st, setSt] = useState<VS>(() => {
    let hashView = "";
    try { hashView = decodeURIComponent(location.hash.slice(1)); } catch { /* a malformed hash opens the default view */ }
    return {
      view: VIEW_KEYS.includes(hashView as ViewKey) && DATA.views[hashView as ViewKey] ? (hashView as ViewKey) : "service",
      change: false, filter: "", collapsed: false, more: 0, zoom: null, sel: null, expanded: { hints: false, recs: false }, table: false, drill: null,
    };
  });
  const [filterText, setFilterText] = useState("");
  const [size, setSize] = useState({ W: 0, H: 0 });
  const mapRef = useRef<HTMLDivElement>(null), sideRef = useRef<HTMLElement>(null), filterRef = useRef<HTMLInputElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  // ---------- what this state draws
  const narrowed = narrowedOf(st);
  const root = M.tree(st.view, st.filter, narrowed);
  const zoomNode = st.zoom === null ? undefined : root.children!.find(g => g.key === st.zoom);
  const many = (n: TNode) => M.DIM[n.dim!].many;
  // a drilled level replaces the opened group's boxes; it needs the detail, and the group it starts from
  const drilled = st.drill && M.DETAIL && zoomNode ? M.drillLevel(st.drill, st.filter, narrowed) : null;
  const shown = drilled?.base ?? zoomNode; // what the map draws inside: the opened group, or the drilled level
  const lay = useMemo(() => layout(root, shown, st.more, size.W, size.H, many),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [root, shown, st.more, size.W, size.H]);
  const drawn = lay.cells.map(c => c.n);
  const selNode: TNode | null = !st.sel ? null
    : "k" in st.sel ? findNode(root, st.sel.k)
    : "more" in st.sel ? (drawn.find(n => n.more && n.parent?.key === (st.sel as { more: string }).more) ?? null)
    : "d" in st.sel ? (drilled ? [...drilled.base.children!, ...drilled.base.gone].find(n => n.key === (st.sel as { d: string }).d) ?? null : null)
    : st.sel.node;

  // ---------- state changes. Back and Forward: a view change, a zoom and a jump are steps; selecting only
  // updates the step you're on
  const stRef = useRef(st);
  stRef.current = st;
  const live = useRef({ root, zoomNode, lay, selNode, shown });
  live.current = { root, zoomNode, lay, selNode, shown };
  const pendingAnim = useRef<{ rect?: Rect; group?: string; opening: boolean } | null>(null);

  const treeOf = (s: VS) => M.tree(s.view, s.filter, narrowedOf(s));
  function commit(next: VS, hist: "push" | "replace" | null) {
    stRef.current = next;
    setSt(next);
    if (hist) {
      const h = { view: next.view, zoom: next.zoom, more: next.more, sel: next.sel && "k" in next.sel ? next.sel.k : null,
        drill: next.drill, seld: next.sel && "d" in next.sel ? next.sel.d : null };
      history[hist === "push" ? "pushState" : "replaceState"](h, "", "#" + next.view);
    }
  }
  /** after the filter changes: drop a zoom or selection the new tree doesn't have */
  function rebuilt(next: VS): VS {
    const t = treeOf(next);
    const zoom = next.zoom !== null && !t.children!.some(g => g.key === next.zoom) ? null : next.zoom;
    const sel = next.sel && (("k" in next.sel && findNode(t, next.sel.k)) || ("d" in next.sel && zoom !== null)) ? next.sel : null;
    return { ...next, zoom, sel, drill: zoom === null ? null : next.drill };
  }
  const selOf = (n: TNode | null, t: TNode): Sel => !n || n.kind === "root" ? null
    : n.more ? { more: n.parent!.key }
    : n.detail ? { d: n.key }
    : findNode(t, keyOf(n)) === n ? { k: keyOf(n) } : { node: n };
  const showView = (s: VS, v: ViewKey): VS => ({ ...s, view: v, zoom: null, sel: null, more: 0, drill: null });
  const cleared = (s: VS): VS => ({ ...s, filter: "", collapsed: false });

  function setView(v: ViewKey) {
    const s = stRef.current;
    if (!DATA.views[v] || v === s.view) return;
    commit(showView(s, v), "push");
  }
  function select(n: TNode | null) {
    commit({ ...stRef.current, sel: selOf(n, live.current.root) }, "replace");
  }
  /** The step to drill from the opened group itself: the path a "break down by" at that level starts with. */
  const groupStep = (s: VS): Step | null => (s.zoom === null ? null : stepFor(DATA.views[s.view]!.dims[0], s.zoom));
  /** The view's own second level, as a breakdown: choosing it again goes back to the view's boxes (with daily series). */
  const natural = (s: VS) => DIM_DD[DATA.views[s.view]!.dims[1]];
  /** The drill cut back to its first `len` steps: back through what the next step was broken down by. */
  function trimmed(s: VS, len: number): VS {
    const path = s.drill!.path, back = path[len];
    if (len < 1) return { ...s, drill: null, more: 0, sel: null };
    if (len === 1 && back.dim === natural(s)) { // the view's own boxes again: select the one we came from
      const B = DATA.views[s.view]!.dims[1], g = treeOf(s).children!.find(g => g.key === s.zoom);
      const leaf = g?.children!.find(c => stepFor(B, c.key, g.key)?.key === back.key);
      return { ...s, drill: null, more: 0, sel: leaf ? { k: keyOf(leaf) } : null };
    }
    return { ...s, drill: { path: path.slice(0, len), by: back.dim }, more: 0, sel: { d: back.key } };
  }
  function breakDownBy(by: DD) {
    const s = stRef.current, g = groupStep(s);
    if (!g) return;
    const path = s.drill?.path ?? [g];
    commit(path.length === 1 && by === natural(s) ? { ...s, drill: null, more: 0, sel: null } : { ...s, drill: { path, by }, more: 0, sel: null }, "push");
  }
  /** Where opening a box goes into the detail: the drill it becomes, or null when it doesn't open that way. */
  function drillInto(s: VS, n: TNode, zoomNode: TNode | undefined): Drill | null {
    if (!M.DETAIL || !zoomNode || !(n.detail || (n.kind === "leaf" && n.parent === zoomNode && M.DRILLABLE.has(s.view)))) return null;
    let path: Step[] | null = null;
    if (n.detail && s.drill) path = [...s.drill.path, { dim: s.drill.by, key: n.key }];
    else if (!n.detail) {
      const [A, B] = DATA.views[s.view]!.dims, g = stepFor(A, zoomNode.key), l = stepFor(B, n.key, zoomNode.key);
      path = g && l ? [g, l] : null;
    }
    const by = path && defaultNext(path, M.RELATED, M.DETAIL);
    return path && by ? { path, by } : null;
  }
  /** Whether opening a box shows something new: the table marks the rows that do. */
  const canOpen = (n: TNode) => !!n.more || (n.kind === "group" && !zoomNode) || !!drillInto(st, n, zoomNode);
  function open(n: TNode | null) {
    const s = stRef.current, { root, lay, zoomNode } = live.current;
    if (n?.more && s.zoom !== null) { commit({ ...s, more: s.more + 1, sel: null }, "push"); return; } // one level into the long tail
    // past the group's boxes: a box of the opened group, or of a drilled level, opens into the detail
    if (n && zoomNode && (n.detail || n.parent === zoomNode)) {
      const drill = drillInto(s, n, zoomNode);
      if (!drill) return; // nothing new past it: a resource already on one meter (unless it's a VM with attachments)
      const cell = lay.cells.find(c => c.n === n);
      pendingAnim.current = { rect: cell && boxOf(cell), opening: true };
      commit({ ...s, drill, more: 0, sel: null }, "push");
      return;
    }
    // a box inside a group on the top-level map (VMs in US East): open the group and, where it drills, the box itself;
    // the group's own box (its heading, its background) opens just the group
    if (n?.kind === "leaf" && !n.more && s.zoom === null && n.parent && root.children!.includes(n.parent)) {
      const g = n.parent, inGroup: VS = { ...s, zoom: g.key, more: 0 }, drill = drillInto(inGroup, n, g);
      const cell = lay.cells.find(c => c.n === (drill ? n : g));
      pendingAnim.current = { rect: cell && boxOf(cell), opening: true };
      commit(drill ? { ...inGroup, drill, sel: null } : { ...inGroup, sel: { k: keyOf(n) } }, "push");
      return;
    }
    const g = n?.kind === "leaf" ? n.parent : n;
    // already inside, or a group that isn't on this map (a drop whose service went to zero): nothing to open
    if (g?.kind !== "group" || s.zoom === g.key || !root.children!.includes(g)) return;
    const cell = lay.cells.find(c => c.n === g);
    pendingAnim.current = { rect: cell && boxOf(cell), opening: true };
    commit({ ...s, zoom: g.key, more: 0 }, "push");
  }
  function up(animate = true) {
    const s = stRef.current, { zoomNode } = live.current;
    if (s.more > 0) { commit({ ...s, more: s.more - 1, sel: null }, "push"); return; }
    if (s.drill) { commit(trimmed(s, s.drill.path.length - 1), "push"); return; }
    if (s.zoom !== null) {
      if (animate && zoomNode) pendingAnim.current = { group: zoomNode.key, opening: false }; // its box in the top-level map
      commit({ ...s, zoom: null, more: 0, sel: zoomNode ? { k: [zoomNode.key, null] } : null }, "push");
    } else if (s.sel) select(null);
  }
  /** Tab walks the drawn boxes by size among the selection's siblings */
  function step(dir: 1 | -1): boolean {
    const { lay, selNode, zoomNode, root } = live.current, drawn = lay.cells.map(c => c.n);
    let peers = drawn.filter(n => n.parent === selNode?.parent);
    // the selection isn't drawn (the group just opened, or a drop that went to zero): walk what the map shows
    if (!peers.length) peers = drawn.filter(n => n.parent === (live.current.shown || zoomNode || root));
    if (!peers.length) return false;
    const i = selNode ? peers.indexOf(selNode) : -1, j = i < 0 ? 0 : i + dir;
    if (j < 0 || j >= peers.length) return false; // past the end: the caller lets Tab move on
    select(peers[j]);
    return true;
  }
  function clearFilterInput() { setFilterText(""); }
  /** jump to a box in a view: zoom into its group and select it */
  function revealed(view: ViewKey, find: (n: TNode) => boolean): VS {
    let s = showView(cleared(stRef.current), view);
    const t = treeOf(s);
    for (const g of t.children!) {
      if (find(g)) { s = { ...s, sel: { k: keyOf(g) } }; break; }
      const leaf = g.children!.find(find);
      if (leaf) { s = { ...s, zoom: g.key, sel: { k: keyOf(leaf) } }; break; }
    }
    return s;
  }
  function reveal(view: ViewKey, find: (n: TNode) => boolean) {
    clearFilterInput();
    commit(revealed(view, find), "push");
  }

  // ---------- side panel clicks
  function clickHint(i: number) {
    const x = M.worthALook()[i];
    reveal(x.view, x.find);
  }
  function clickDrop(i: number) {
    const leaf = M.biggestDrops()[i].n;
    clearFilterInput();
    let s = revealed("service", n => n.kind === "leaf" && n.key === leaf.key && n.parent!.key === leaf.parent!.key);
    if (!s.sel) { // went to zero: no box to select, so open its service (if it still has one) and show its numbers
      const t = treeOf(s);
      s = { ...s, zoom: t.children!.some(g => g.key === leaf.parent!.key) ? leaf.parent!.key : s.zoom, sel: { node: leaf } };
    }
    commit(s, "push");
  }
  function clickRec(i: number) {
    const rec = M.TIPS![i], sub = (rec.resource.match(/^\/subscriptions\/([^/]+)$/) || [])[1], top = rec.covers?.[0];
    if (top) reveal("service", n => n.kind === "leaf" && n.key === top.meter && n.parent!.key === top.service); // the biggest meter it covers
    else if (/\/resourcegroups\//.test(rec.resource)) reveal("resource", n => n.key === rec.resource);
    else if (sub) reveal("subscription", n => n.kind === "group" && n.key.toLowerCase() === sub); // reservations, savings plans
  }
  const toggle = (list: "hints" | "recs") => {
    const s = stRef.current;
    commit({ ...s, expanded: { ...s.expanded, [list]: !s.expanded[list] } }, null);
  };

  // ---------- keyboard, history, size
  function onKey(e: KeyboardEvent) {
    const s = stRef.current, filterEl = filterRef.current, typing = e.target === filterEl;
    const target = e.target as HTMLElement;
    if (e.key === "Escape" && sharing) { setSharing(false); return; }
    if (e.key === "Escape" && choosingTag) { setChoosingTag(false); return; }
    if (e.key === "Escape") { // one thing at a time: the filter, then the selection, then up a level
      if (typing || s.filter) { clearFilterInput(); filterEl?.blur(); commit(rebuilt(cleared(s)), null); }
      else if (live.current.selNode && live.current.selNode !== live.current.zoomNode) select(null);
      else up();
      return;
    }
    if (target.closest?.(".share")) return; // typing and copying in the share and tag panels
    if (typing) { // Enter keeps only the matches
      if (e.key === "Enter" && s.filter) { filterEl?.blur(); commit(rebuilt({ ...s, collapsed: true }), null); }
      return;
    }
    if ((e.key === "Enter" || e.key === " ") && target.matches?.("[role=button]")) { e.preventDefault(); target.click(); return; }
    if (e.key === "Enter" && target.matches?.("button, a, select, input, textarea")) return; // the control's own Enter
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Tab") { // the map walks its boxes; anywhere else, and past the last box, Tab is the browser's
      if (e.target === mapRef.current && step(e.shiftKey ? -1 : 1)) e.preventDefault();
    } else if (e.key === "/") { e.preventDefault(); filterEl?.focus(); }
    else if (e.key === "Enter") live.current.selNode ? open(live.current.selNode) : step(1);
    else if (e.key === "Backspace") { e.preventDefault(); up(); }
    else if (e.key === "e") exportJSON();
    else if (e.key === "s" && DATA.run) setSharing(v => !v);
    else if (e.key === "c") commit({ ...s, change: !s.change }, null);
    else if (e.key === "t") commit({ ...s, table: !s.table }, null);
    else if (/^[1-6]$/.test(e.key)) setView(VIEW_KEYS[+e.key - 1]);
  }
  function onPop(e: PopStateEvent) {
    const h = e.state;
    if (!h || !Object.hasOwn(DATA.views, h.view)) return;
    clearFilterInput();
    let s = showView(cleared(stRef.current), h.view); // not setView: Back to the same view with another zoom must still land
    const t = treeOf(s), z = h.zoom ?? null; // "" is a real zoom key (no region, untagged)
    if (z !== null && t.children!.some(g => g.key === z)) s = { ...s, zoom: z, more: h.more ?? 0 };
    s = { ...s, sel: findNode(t, h.sel) ? { k: h.sel } : null };
    if (h.drill && s.zoom !== null) s = { ...s, drill: h.drill, sel: h.seld ? { d: h.seld } : null };
    commit(s, null);
  }
  const handlers = useRef({ onKey, onPop });
  handlers.current = { onKey, onPop };
  useEffect(() => {
    const key = (e: KeyboardEvent) => handlers.current.onKey(e), pop = (e: PopStateEvent) => handlers.current.onPop(e);
    document.addEventListener("keydown", key);
    addEventListener("popstate", pop);
    commit(stRef.current, "replace");
    return () => { document.removeEventListener("keydown", key); removeEventListener("popstate", pop); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // open and up grow the group into the map, or shrink it back
  const anim = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const measure = () => setSize(s => (s.W === el.clientWidth && s.H === el.clientHeight ? s : { W: el.clientWidth, H: el.clientHeight }));
    measure();
    let raf = 0;
    const ro = new ResizeObserver(() => { anim.current?.cancel(); cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); });
    ro.observe(el); // transforms don't resize the map, so the zoom animation keeps this quiet
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, []);
  useLayoutEffect(() => {
    const p = pendingAnim.current, el = mapRef.current;
    if (!p || !el) return;
    pendingAnim.current = null;
    let r = p.rect;
    if (!r && p.group !== undefined) {
      const c = lay.cells.find(c => c.type === "group" && c.n.key === p.group);
      r = c && boxOf(c);
    }
    const W = el.clientWidth, H = el.clientHeight;
    if (!r || !(r.w >= 1 && r.h >= 1) || !el.animate || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const sx = r.w / W, sy = r.h / H;
    const small = `translate(${r.x}px, ${r.y}px) scale(${sx}, ${sy})`, big = `translate(${-r.x / sx}px, ${-r.y / sy}px) scale(${1 / sx}, ${1 / sy})`;
    anim.current?.cancel();
    anim.current = el.animate([{ transform: p.opening ? small : big }, { transform: "none" }],
      { duration: Math.min(310, 130 + 45 * Math.log2(1 / (sx * sy))), easing: "cubic-bezier(.33, 1, .68, 1)" });
  });

  // a shared link's place: shown as soon as its view is read (the run may still be reading it)
  const pendingPlace = useRef(initial);
  const detailComing = loading.includes("detail");
  useEffect(() => {
    const p = pendingPlace.current;
    if (!p || !DATA.views[p.view]) return;
    if (p.drill && !M.DETAIL && detailComing) return; // a drilled place waits for the detail
    pendingPlace.current = null;
    let s = showView(cleared(stRef.current), p.view);
    const g = p.group === null ? undefined : treeOf(s).children!.find(g => g.key === p.group);
    if (g && p.drill && M.DETAIL) s = { ...s, zoom: g.key, drill: p.drill, sel: p.item === null ? null : { d: p.item } };
    else if (g) {
      const leaf = p.item === null ? undefined : g.children!.find(c => c.key === p.item);
      s = { ...s, zoom: g.key, sel: { k: leaf ? keyOf(leaf) : keyOf(g) } };
    }
    clearFilterInput();
    commit(s, "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [M, detailComing]);

  // ---------- sharing: where the page is now, as a link
  const [sharing, setSharing] = useState(false);
  const [choosingTag, setChoosingTag] = useState(false);
  const readingTag = loading.includes("tags");
  // a tag just read: show its view (the run's own tag view, when it arrives, doesn't take over)
  const wantTagView = useRef(false);
  useEffect(() => {
    if (wantTagView.current && !readingTag && DATA.views.tag) { wantTagView.current = false; setView("tag"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [M, readingTag]);
  const place: Place = drilled ? { view: st.view, group: st.zoom, item: selNode?.detail ? selNode.key : null, drill: st.drill! } : {
    view: st.view,
    group: zoomNode?.key ?? (selNode?.kind === "group" ? selNode.key : selNode?.kind === "leaf" && !selNode.more && selNode.parent ? selNode.parent.key : null),
    item: selNode?.kind === "leaf" && !selNode.more ? selNode.key : null,
  };
  const shareWhat = selNode && selNode.kind !== "root" && !selNode.more ? selNode.name : shown ? shown.name : "the whole bill";
  // a drilled place belongs to one subscription when a step (or the selection) is a resource, group or subscription
  const shareSub = drilled
    ? [...st.drill!.path, ...(place.item !== null ? [{ dim: st.drill!.by, key: place.item }] : [])].map(s =>
      s.dim === "subscription" ? s.key : s.dim === "resource" || s.dim === "group" ? (/^\/subscriptions\/([0-9a-f-]{36})/i.exec(s.key)?.[1]?.toLowerCase() ?? null) : null,
    ).find(Boolean) ?? null
    : subscriptionOf(place.view, place.group, place.item);

  function exportJSON() {
    const blob = new Blob([JSON.stringify(M.EXPORT, null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "azcost-export.json" });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- the map
  const cellAt = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".cell");
    return el ? lay.cells[Number(el.dataset.i)]?.n ?? null : null;
  };
  const onMapClick = (e: React.MouseEvent) => { // click selects; clicking the selected box again opens it
    const n = cellAt(e);
    n && n === selNode ? open(n) : select(n);
  };
  const onMapMove = (e: React.MouseEvent) => {
    const tip = tipRef.current!, n = cellAt(e);
    if (!n) { tip.style.display = "none"; return; }
    const d = n.cur - n.prev;
    const ch = n.prev < 0.01 ? "new" : `${d >= 0 ? "+" : ""}${pct(d / n.prev)} vs prev`;
    tip.innerHTML = `<div class="t1">${n.kind === "leaf" ? esc(n.parent!.name) + " / " : ""}<b>${esc(n.name)}</b></div>
      <div class="t2">${esc(M.money(n.cur))} · ${pct(M.grand ? n.cur / M.grand : 0)} of bill${n.kind === "leaf" && n.parent!.cur > 0
        ? ` · ${pct(n.cur / n.parent!.cur)} of ${esc(n.parent!.name)}` : ""} · ${ch}</div>`;
    tip.style.display = "block";
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.min(e.clientX + 14, innerWidth - tw - 8) + "px";
    tip.style.top = Math.min(e.clientY + 14, innerHeight - th - 8) + "px";
  };

  const cells = lay.cells.map((c: Cell, i) => {
    const n = c.n, b = boxOf(c);
    const style = { left: b.x, top: b.y, width: b.w, height: b.h, "--c": M.color(n, st.view, st.change) } as CSSProperties;
    const tiny = c.type === "leaf" && (c.w < 14 || c.h < 10);
    const cls = "cell " + (c.type === "group" ? "group" : "leaf" + (tiny ? " tiny" : "") + (n.more ? " more" : ""))
      + (M.isTodo(n, st.view) ? " todo" : "") + (st.filter && !st.collapsed && !n.hit ? " dim" : "") + (n === selNode ? " sel" : "");
    let body: ReactNode = null;
    if (c.type === "group" && c.header) {
      body = <div className="gh"><span className="n">{n.name}</span>{c.header === "full" && <span className="v">{M.money(n.cur)}</span>}</div>;
    } else if (c.type === "leaf" && c.w > 42 && c.h > 17) {
      body = <><div className="n">{n.name}</div>{c.h > 32 && <div className="v">{M.money(n.cur)}</div>}</>;
    }
    return <div key={`${c.type}\u0000${n.parent?.key}\u0000${n.key}`} data-i={i} className={cls} style={style}>{body}</div>;
  });

  const base = shown || root;
  const v = DATA.views[st.view]!, [A, B] = v.dims;

  // ---------- header and the line under it (a crumb jump doesn't animate)
  const crumbUp = () => { commit({ ...stRef.current, more: 0, drill: null }, null); up(false); };
  // "break down by": at an opened group of a view the detail can follow, and at every drilled level
  const byStep = groupStep(st), byOptions = byStep && M.DRILLABLE.has(st.view) ? options(st.drill?.path ?? [byStep], M.RELATED, M.DETAIL) : [];
  const byNow: DD | undefined = st.drill?.by ?? DIM_DD[B];
  const picker = zoomNode && byOptions.length > 0 && (
    <select className="by" value={M.DETAIL ? byNow : ""} disabled={!M.DETAIL} onChange={e => breakDownBy(e.target.value as DD)}
      title={M.DETAIL ? "break this down by…" : DATA.detail_note ?? (detailComing ? "the detail is still loading" : "no detail for this run")}>
      {M.DETAIL ? byOptions.map(d => <option key={d} value={d}>by {DD_WORD[d]}</option>)
        : <option value="">{detailComing ? "detail loading…" : "no detail"}</option>}
    </select>);
  const crumbs = drilled
    ? <><a onClick={crumbUp}>all {M.DIM[A].many}</a>
      {st.drill!.path.map((s, i, path) => <span key={i} className="step"><span>/</span>{i < path.length - 1
        ? <a onClick={() => commit(trimmed(stRef.current, i + 1), "push")}>{M.label(s.dim, s.key)}</a>
        : <span className="cur">{M.label(s.dim, s.key)}</span>}</span>)}
      {st.more > 0 && <><span>/</span><span className="cur">{lay.moreCount} smaller</span></>}
      {picker}</>
    : base === root
    ? <span className="cur">all {M.DIM[A].many}</span>
    : st.more
      ? <><a onClick={crumbUp}>all {M.DIM[A].many}</a><span>/</span>
        <a onClick={() => commit({ ...stRef.current, more: 0, sel: null }, "push")}>{base.name}</a><span>/</span>
        <span className="cur">{lay.moreCount} smaller {M.DIM[B].many}</span></>
      : <><a onClick={crumbUp}>all {M.DIM[A].many}</a><span>/</span>
        <span className="cur">{base.name}</span>{picker}</>;

  const leaves = root.children!.reduce((s, g) => s + g.children!.length, 0);
  // what the filter matches, counted over the whole view whether the map dims the rest or drops it
  const hits = st.filter ? root.children!.flatMap(g => g.children!).filter(n => n.hit) : [];
  const found = hits.reduce((s, n) => s + n.cur, 0);
  const creditNote = (n: TNode, Tag: "span" | "div") => {
    const c = M.credits(n, st.view, narrowed);
    return c <= -0.005
      ? <Tag className="credits" title="meters with a negative total (credits, refunds) count in the total but can't be drawn as boxes">incl. {M.money(c)} credits &amp; refunds</Tag>
      : null;
  };

  return (
    <div className="app">
      <header>
        <div className="logo"><i><b style={{ background: "var(--compute)" }} /><b style={{ background: "var(--storage)" }} /><b style={{ background: "var(--database)" }} /><b style={{ background: "var(--network)" }} /></i>azcost</div>
        <div className="crumbs"><span>/</span>{crumbs}</div>
        <div className="spacer" />
        <div className="seg">
          {VIEW_KEYS.filter(k => k !== "tag" && DATA.views[k]).map(k =>
            <button key={k} className={k === st.view ? "on" : ""} onClick={() => setView(k)}>{VIEW_NAMES[k]}</button>)}
          {/* the tag view is named after its tag, which is yours to choose */}
          {DATA.views.tag && <button className={st.view === "tag" ? "on" : ""} onClick={() => setView("tag")} title={`the bill by the values of the ${M.TAG} tag`}>
            Tag: {M.TAG}</button>}
          <button className={"caret" + (choosingTag ? " on" : "")} onClick={() => setChoosingTag(v => !v)}
            title={DATA.views.tag ? "split the bill by another tag" : "split the bill by a tag"}>{readingTag ? "…" : DATA.views.tag ? "▾" : "Tag ▾"}</button>
        </div>
        <div className="seg" title="the current level as a map or a table (t)">
          <button className={st.table ? "" : "on"} onClick={() => commit({ ...stRef.current, table: false }, null)}>Map</button>
          <button className={st.table ? "on" : ""} onClick={() => commit({ ...stRef.current, table: true }, null)}>Table</button>
        </div>
        <label className="chk"><input type="checkbox" checked={st.change} onChange={e => commit({ ...stRef.current, change: e.target.checked }, null)} /> Color by change</label>
        <button className="hbtn" title={`Download what's shown as a spreadsheet: ${zoomNode ? zoomNode.name : `every ${M.DIM[A].one}`}${st.filter ? `, matching “${st.filter}”` : ""}, credits included`}
          onClick={() => drilled
            ? downloadLevelCsv(M, drilled.base.full, DD_DIM[st.drill!.by], drilled.all.filter(r => !st.filter || `${r.key} ${M.label(st.drill!.by, r.key)}`.toLowerCase().includes(st.filter.toLowerCase())), st.drill!.by)
            : downloadCsv(M, { view: st.view, group: zoomNode?.key ?? null, filter: st.filter }, zoomNode?.name)}>CSV</button>
        <button className="hbtn" title="Download a JSON summary to give to an AI agent (e)" onClick={exportJSON}>Export for AI</button>
        <input id="filter" ref={filterRef} aria-label="Filter" placeholder="filter  /" autoComplete="off" spellCheck={false} value={filterText}
          onChange={e => { setFilterText(e.target.value); commit(rebuilt({ ...stRef.current, filter: e.target.value.trim(), collapsed: false }), null); }} />
        <button className={"hbtn" + (sharing ? " on" : "")} title={DATA.run ? "Link to this view, to share (s)" : "This run can't be linked to (it was saved by an older version)"}
          disabled={!DATA.run} onClick={() => setSharing(v => !v)}>Share</button>
        <button className="hbtn" title="Read costs again, or pick other subscriptions" onClick={onNewRun}>New run</button>
        {choosingTag && <TagPicker names={DATA.tag_names ?? (DATA.views.tag ? [{ name: M.TAG, count: 0 }] : [])} current={DATA.views.tag?.tag ?? null}
          busy={readingTag} unavailable={onChooseTag ? null : tagUnavailable ?? "Another tag can't be read here."}
          onPick={tag => { setChoosingTag(false); wantTagView.current = true; onChooseTag?.(tag); }} onClose={() => setChoosingTag(false)} />}
        {sharing && DATA.run && <SharePanel run={DATA.run} place={place} what={shareWhat} viewName={VIEW_NAMES[st.view] || M.TAG}
          sub={shareSub} subName={(id: string) => DATA.subscriptions.find(x => x.id.toLowerCase() === id)?.name ?? id}
          current={[DATA.days[M.SPLIT], DATA.days[M.N - 1]]} periodLabel={M.LABEL} build={buildLink} onClose={() => setSharing(false)} />}
      </header>
      <div className="sub">
        <span><b>{M.money(root.cur)}</b> · {M.period()}</span>
        <span>{root.children!.length} {M.DIM[A].many} · {leaves} {M.DIM[B].many}</span>
        {loading.length > 0 && <span className="loading" title="the map shows what's read so far; views and lists appear as they arrive">
          <i />reading {loading.join(", ")}…</span>}
        {loadError && <span className="warn" title={loadError}>stopped early: {loadError.split("\n")[0]}</span>}
        {notice && <span className="warn" title={notice}>{notice}</span>}
        {DATA.mixed_currencies && <span className="warn" title="Azure couldn't convert these subscriptions to one currency, so every amount adds different currencies">totals mix {DATA.mixed_currencies.join(" and ")}: Azure didn't convert them</span>}
        {M.totalsOnly(st.view) && <span title="too many resources for a daily series: each resource has one total per period">period totals for {DATA.resource_fallback.join(", ")}</span>}
        {st.view === "tag" && !narrowed && <span title={`spend on resources without the ${M.TAG} tag`}>untagged {M.money(M.UNTAGGED)} ({pct(M.grand > 0 ? M.UNTAGGED / M.grand : 0)} of bill)</span>}
        {creditNote(root, "span")}
        {st.filter && <span>filter “{st.filter}” · {hits.length
          ? `${hits.length} ${hits.length === 1 ? M.DIM[B].one : M.DIM[B].many} · ${M.money(found)} · ${pct(M.grand > 0 ? found / M.grand : 0)} of bill`
          : "no match"}</span>}
        <div className="legend">
          {M.marks(st.view).size > 0 && <span><i className="todo" />to-do</span>}
          {st.change
            ? [["--down", "down"], ["--neutral", "flat"], ["--up", "up / new"]].map(([c, l]) => <span key={c}><i style={{ background: `var(${c})` }} />{l}</span>)
            : CATS.map(([k, l]) => <span key={k}><i style={{ background: `var(--${k})` }} />{l}</span>)}
        </div>
      </div>
      <div id="mapbox">
        {st.table && <Table M={M} view={st.view} base={base} selNode={selNode} dimMisses={!!st.filter && !st.collapsed}
          levelDim={drilled ? DD_DIM[st.drill!.by] : base === root ? A : B} canOpen={canOpen} onSelect={select} onOpen={open} />}
        <div id="map" ref={mapRef} hidden={st.table} tabIndex={0} onClick={onMapClick} onMouseMove={onMapMove}
          onMouseLeave={() => (tipRef.current!.style.display = "none")}>
          {base.children!.length ? cells
            : <div className="empty">{narrowed ? `Nothing matches “${st.filter}”` : "No spend in this period"}</div>}
        </div>
      </div>
      <SidePanel M={M} st={st} narrowed={narrowed} root={root} zoomNode={shown} selNode={selNode} sideRef={sideRef}
        creditNote={creditNote} onHint={clickHint} onDrop={clickDrop} onRec={clickRec} onToggle={toggle}
        onBudget={id => reveal("subscription", n => n.kind === "group" && n.key === id)} />
      <footer>
        <span><kbd>click</kbd>select</span><span><kbd>click</kbd>again or <kbd>enter</kbd>open</span><span><kbd>tab</kbd>next</span><span><kbd>⌫</kbd>up</span>
        <span>{VIEW_KEYS.map((k, i) => (DATA.views[k] ? <kbd key={k}>{i + 1}</kbd> : null))}view</span><span><kbd>c</kbd>color</span><span><kbd>t</kbd>table</span><span><kbd>/</kbd>filter</span><span><kbd>e</kbd>export</span><span><kbd>s</kbd>share</span><span><kbd>esc</kbd>clear</span>
        <span className="spacer" />
        <span>
          {DATA.demo && <><span className="badge">demo data</span> </>}
          {DATA.metric || "ActualCost"} · {DATA.subscriptions.length === 1 ? DATA.subscriptions[0].name : `${DATA.subscriptions.length} subscriptions`} · read {DATA.generated || ""}
          {who ? ` · ${who}` : ""}
        </span>
      </footer>
      <div id="tip" ref={tipRef} />
    </div>
  );
}

// ---------------------------------------------------------------- the side panel

interface SideProps {
  M: Model;
  st: VS;
  narrowed: boolean;
  root: TNode;
  zoomNode: TNode | undefined;
  selNode: TNode | null;
  sideRef: React.RefObject<HTMLElement | null>;
  creditNote: (n: TNode, tag: "span" | "div") => ReactNode;
  onHint: (i: number) => void;
  onDrop: (i: number) => void;
  onRec: (i: number) => void;
  onBudget: (subscriptionId: string) => void;
  onToggle: (list: "hints" | "recs") => void;
}

/** one row of a side-panel list: title and amount on a line, then a small kind tag and the reason; a budget's row
 * also has a bar: what's spent, and a tick where the forecast lands */
function Row({ color, title, full, value, tag, why, whyTitle, onClick, meter }:
  { color: string; title: string; full: string; value: string; tag: string | null; why: string; whyTitle?: string; onClick: () => void;
    meter?: { used: number; forecast: number | null } }) {
  return (
    <div className="hint" role="button" tabIndex={0} style={{ "--c": color } as CSSProperties} onClick={onClick}>
      <div className="ht"><span className="hn" title={full}>{title}</span><span className="hv">{value}</span></div>
      {meter && <div className="meter"><i style={{ width: `${Math.min(100, meter.used * 100)}%` }} />
        {meter.forecast !== null && <b style={{ left: `${Math.min(100, meter.forecast * 100)}%` }} />}</div>}
      <div className="hs" title={whyTitle}>{tag && <span className="tag">{tag}</span>}{why}</div>
    </div>
  );
}

function SidePanel({ M, st, narrowed, root, zoomNode, selNode, sideRef, creditNote, onHint, onDrop, onRec, onBudget, onToggle }: SideProps) {
  const { DATA, DAYS } = M;
  const n = selNode || zoomNode || root;
  const [A, B] = DATA.views[st.view]!.dims;
  const d = n.cur - n.prev, share = M.grand > 0 ? n.cur / M.grand : 0;
  const change = n.prev < 0.01 ? (n.cur > 0 ? <b className="upc">new</b> : "–")
    : <><b className={d > 0 ? "upc" : "downc"}>{d > 0 ? "+" : ""}{pct(d / n.prev)}</b> <b style={{ color: "var(--dim)" }}>{d > 0 ? "+" : ""}{M.money(d)}</b></>;
  const path = n.kind === "leaf" ? (n.full.startsWith("/") || n.detail ? n.full : `${n.parent!.name} / ${n.full}`)
    : n.kind === "group" ? n.full : `${M.DIM[A].many} → ${M.DIM[B].many}`;
  const kind = n.kind === "root" ? "whole bill" : n.more ? `${n.more} ${M.DIM[n.dim!].many}` : M.DIM[n.dim!].one + (n.detail && n.kind === "group" ? ", drilled" : "");
  const title = n.kind === "root" ? (narrowed ? `“${st.filter}”` : "Everything") : n.name;
  // Azure's own forecast for this calendar month, on the whole bill only: it knows nothing of views or filters
  const F = n.kind === "root" && !narrowed ? DATA.forecast : null;
  const mon = F && new Date(F.month + "-01T00:00:00").toLocaleDateString("en-US", { month: "short" });
  const href = M.portalHref(n);
  const [big, cents] = M.bigMoney(n.cur);

  const hints = M.worthALook(), gerr = DATA.graph_error;
  const shownHints = st.expanded.hints ? hints : hints.slice(0, SHOWN_HINTS);
  const drops = M.biggestDrops();
  const recs = M.TIPS;
  // a subscription's budget (the one covering all of it first), or the bill's when the run read one subscription
  const budget = M.budgetsOf(n).sort((a, b) => Number(a.filtered) - Number(b.filtered))[0];
  const budgets = M.BUDGETS, overCount = (budgets ?? []).filter(b => M.budgetState(b).status !== "on track").length;

  return (
    <aside id="side" ref={sideRef}>
      <section>
        <div className="h">Selection</div>
        <div className="sel-name">{href ? <a href={href} target="_blank" rel="noopener noreferrer" title="open in the Azure portal">{title}</a> : title}</div>
        <div className="sel-path">{path}</div>
        <div className="big">{big}<small>{cents}</small></div>
        <div style={{ color: "var(--dim)" }}>{M.LABEL} · {M.period()}</div>
        {creditNote(n, "div")}
        <div className="bar"><i style={{ width: `${Math.min(100, share * 100)}%` }} /></div>
        <div className="stats">
          <div><span>of bill</span>{pct(share)}</div>
          <div><span>{M.PREV_SHORT}</span>{change}</div>
          <div><span>per day</span>{M.money(n.cur / DAYS)}</div>
          <div><span>monthly pace</span>{M.money((n.cur / DAYS) * 30.4)}</div>
          {F ? <>
            <div><span>{mon} so far</span>{M.money(F.actual)}</div>
            <div><span>{mon} forecast</span>{M.money(F.total)}</div>
          </> : <>
            <div><span>kind</span>{kind}</div>
            <div><span>category</span>{n.kind === "root" ? "–" : (CATS.find(c => c[0] === M.category(n, st.view)) || [, "–"])[1]}</div>
          </>}
          {budget && (() => { // Azure's figures for the budget's own period, not the run's
            const b = budget, bs = M.budgetState(b), money = (v: number) => M.money(v, sym(b.currency || DATA.currency));
            return <>
              <div title={b.name + (b.filtered ? " (covers part of the subscription)" : "")}><span>{M.grainWord(b)} budget</span>{money(b.amount)}</div>
              <div title={`${money(b.current ?? 0)} spent${b.forecast !== null ? `, ${money(b.forecast)} forecast` : ""}`}><span>used · forecast</span>
                <b style={{ color: bs.used > 1 ? "var(--up)" : undefined }}>{pct(bs.used)}</b>
                {bs.forecast !== null && <> · <b style={{ color: bs.forecast > 1 ? "var(--up)" : undefined }}>{pct(bs.forecast)}</b></>}</div>
            </>;
          })()}
        </div>
        <Spark M={M} n={n} view={st.view} />
      </section>

      {(hints.length > 0 || gerr) && <section>
        {/* a count, not a sum: a dev/test group's total can include meters that are hints of their own */}
        <div className="h">Worth a look {hints.length > 0 && <b>{hints.length}</b>}</div>
        {shownHints.map((h, i) => <Row key={i} color={h.c} title={h.title} full={h.n.full} value={M.money(h.value)}
          tag={HINT_TAG[h.h.kind] || "look"} why={h.why} whyTitle={h.why} onClick={() => onHint(i)} />)}
        <ShowAll open={st.expanded.hints} n={hints.length} cap={SHOWN_HINTS} onClick={() => onToggle("hints")} />
        {gerr && <div className="note">{/^HTTP 40[13]\b/.test(gerr)
          ? "Resource Graph checks need Reader, and didn't run where it's missing." : `Resource Graph checks didn't run everywhere (${gerr}).`}</div>}
      </section>}

      {drops.length > 0 && <section>
        <div className="h">Biggest drops <b style={{ color: "var(--down)" }}>{M.money(drops.reduce((s, h) => s + h.d, 0))}</b></div>
        {drops.map((h, i) => {
          const gone = h.n.cur < 0.005, why = `${gone ? "" : "down " + pct(-h.d / h.n.prev) + " "}(${M.money(h.d)}) vs ${M.PREV}`;
          return <Row key={i} color="var(--down)" title={`${shortSvc(h.n.parent!.key)} · ${h.n.name}`} full={h.n.full} value={M.money(h.n.cur)}
            tag={gone ? "gone" : "fell"} why={why} onClick={() => onDrop(i)} />;
        })}
      </section>}

      {budgets && <section>
        <div className="h">Budgets {overCount > 0 && <b style={{ color: "var(--up)" }}>{overCount} over or at risk</b>}</div>
        {budgets.map((b, i) => {
          const bs = M.budgetState(b), money = (v: number) => M.money(v, sym(b.currency || DATA.currency));
          const why = `${b.subscription} · ${M.grainWord(b)}${b.forecast !== null ? ` · forecast ${money(b.forecast)} (${pct(bs.forecast!)})` : ""}` +
            (b.filtered ? " · filtered" : "");
          return <Row key={i} color={bs.color} title={b.name} full={`${b.name} · ${b.subscription}`} value={`${money(b.current ?? 0)} / ${money(b.amount)}`}
            tag={bs.status} why={why} onClick={() => onBudget(b.subscription_id)} meter={bs} />;
        })}
        {!budgets.length && <div className="note">{DATA.budget_error
          ? (/^HTTP 40[13]\b/.test(DATA.budget_error) ? "Budgets weren't readable with this login." : `Budgets couldn't be read (${DATA.budget_error}).`)
          : "No cost budgets on these subscriptions."}</div>}
      </section>}

      {recs && (!recs.length
        ? <><div className="advh h">Advisor</div><section><div className="note">{!DATA.advisor_error ? "Advisor has no cost recommendations."
          : /^HTTP 40[13]\b/.test(DATA.advisor_error) ? "Advisor wasn't readable with this login (needs Reader)."
          : `Advisor couldn't be read (${DATA.advisor_error}).`}</div></section></>
        : <>
          {/* the header is the aside's own child, so it can stick to the bottom while the lists above it scroll */}
          <div className="advh h" role="button" tabIndex={0} onClick={() => { const s = sideRef.current; if (s) s.scrollTop = s.scrollHeight; }}>
            Advisor <b>{recs.length} cost tip{recs.length > 1 ? "s" : ""}</b>
          </div>
          <section>
            {(st.expanded.recs ? recs : recs.slice(0, SHOWN_RECS)).map((r, i) =>
              <Row key={i} color="var(--advisor)" title={r.problem} full={r.solution || r.problem}
                value={r.annual_savings ? M.money(r.annual_savings, sym(r.currency || DATA.currency)) + "/yr" : "–"}
                tag={null} why={M.tipLine(r)} whyTitle={M.tipDetail(r)} onClick={() => onRec(i)} />)}
            <ShowAll open={st.expanded.recs} n={recs.length} cap={SHOWN_RECS} onClick={() => onToggle("recs")} />
          </section>
        </>)}
    </aside>
  );
}

/** a long list opens in place: "show all N" / "show fewer" */
function ShowAll({ open, n, cap, onClick }: { open: boolean; n: number; cap: number; onClick: () => void }) {
  return n > cap ? <div className="showall" role="button" tabIndex={0} onClick={onClick}>{open ? "show fewer" : `show all ${n}`}</div> : null;
}

function Spark({ M, n, view }: { M: Model; n: TNode; view: ViewKey }) {
  if (n.detail) return <div className="note">No daily chart this deep: past a view's two levels, azcost reads one total per period.</div>;
  if (M.totalsOnly(view, n)) return <div className="note">No daily chart here: this view has period totals only (too many resources for daily detail).</div>;
  const { N, SPLIT, DAYS, DATA } = M;
  const max = Math.max(...n.daily, 0.0001), bw = 100 / N;
  return (
    <div className="spark">
      <svg viewBox="0 0 100 46" preserveAspectRatio="none">
        {Array.from(n.daily, (v, i) => {
          const h = Math.max(0, (v / max) * 44);
          return <rect key={i} x={(i * bw).toFixed(2)} y={(46 - h).toFixed(2)} width={(bw * 0.7).toFixed(2)} height={h.toFixed(2)}
            fill={i < SPLIT ? "#3a4252" : "var(--accent)"} />;
        })}
      </svg>
      <div className="axis"><span>{day(DATA.days[0])}</span><span>{M.SPLIT === DAYS ? `previous ${DAYS}d | last ${DAYS}d` : "previous | current"}</span><span>{day(DATA.days[N - 1])}</span></div>
    </div>
  );
}
