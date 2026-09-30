// A link to what the page shows now, for a project manager or anyone else: they open it, sign in, and land on the
// same view and box, read with their own access. The link holds settings, never costs or a token.
import { useEffect, useRef, useState } from "react";
import type { Place, RunSpec } from "../app/links";

interface Props {
  run: RunSpec;
  place: Place;
  what: string; // what's selected, in words
  viewName: string;
  sub: string | null; // the subscription the selection belongs to, when there's exactly one
  subName: (id: string) => string;
  current: [string, string]; // the current period's dates
  periodLabel: string;
  build: (base: string, run: RunSpec, place: Place) => string;
  onClose: () => void;
}

export function SharePanel({ run, place, what, viewName, sub, subName, current, periodLabel, build, onClose }: Props) {
  const several = (run.subs?.length ?? 0) > 1;
  const canNarrow = !!sub && several && !!run.subs?.includes(sub);
  const rolling = !run.demo && run.period.mode !== "custom"; // "month to date" means another month next month
  const [narrow, setNarrow] = useState(canNarrow); // one subscription opens faster, and is all the selection needs
  const [pin, setPin] = useState(false);
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const spec: RunSpec = {
    ...run,
    subs: narrow && canNarrow ? [sub!] : run.subs,
    period: pin && rolling ? { mode: "custom", from: current[0], to: current[1] } : run.period,
  };
  const url = build(location.origin + location.pathname, spec, place);
  useEffect(() => setCopied(false), [url]);
  useEffect(() => input.current?.select(), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch { // no clipboard permission: the text is selected, so Ctrl+C works
      input.current?.select();
    }
  }

  return (
    <div className="share" role="dialog" aria-label="Share this view" onKeyDown={e => e.key === "Escape" && onClose()}>
      <div className="h">Share this view <a onClick={onClose} aria-label="close">✕</a></div>
      <p>Opens <b>{what}</b> in the {viewName.toLowerCase()} view, {pin && rolling ? `${current[0]} to ${current[1]}` : periodLabel}.</p>
      {canNarrow && <label className="chk"><input type="checkbox" checked={narrow} onChange={e => setNarrow(e.target.checked)} />
        Only {subName(sub!)} <span className="muted">(opens faster; shares are of that subscription)</span></label>}
      {rolling && <label className="chk"><input type="checkbox" checked={pin} onChange={e => setPin(e.target.checked)} />
        Keep these dates <span className="muted">(otherwise “{periodLabel}” moves with the calendar)</span></label>}
      <div className="row">
        <input ref={input} readOnly value={url} onFocus={e => e.target.select()} aria-label="link" />
        <button className="hbtn" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <p className="muted">{run.demo ? "Demo data: anyone can open it."
        : "Whoever opens it signs in and reads the costs with their own Azure access (Cost Management Reader or Reader), so they see only what they're allowed to. The link holds no costs and no token."}</p>
    </div>
  );
}
