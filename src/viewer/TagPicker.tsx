// Which tag the tag view splits the bill by. Organizations tag their own way (CostCenter, owner, app...), so the page
// lists every tag on the resources, most used first, and reads the one picked: one query per subscription.
import { useEffect, useRef, useState } from "react";

interface Props {
  names: { name: string; count: number }[];
  current: string | null;
  busy: boolean; // a tag is being read
  unavailable: string | null; // why another tag can't be read here (the demo, no sign-in), or null
  onPick: (tag: string) => void;
  onClose: () => void;
}

const SHOWN = 60;

export function TagPicker({ names, current, busy, unavailable, onPick, onClose }: Props) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const typed = q.trim(), match = typed.toLowerCase();
  const shown = names.filter(n => !match || n.name.toLowerCase().includes(match));
  const exact = names.some(n => n.name.toLowerCase() === match);
  const pick = (tag: string) => { if (!unavailable && !busy && tag) onPick(tag); };

  return (
    <div className="share tagpick" role="dialog" aria-label="Choose a tag" onKeyDown={e => e.key === "Escape" && onClose()}>
      <div className="h">Split the bill by a tag <a onClick={onClose} aria-label="close">✕</a></div>
      <input ref={input} className="tagq" value={q} placeholder="find or type a tag name" aria-label="tag name" spellCheck={false}
        onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === "Enter") pick(exact ? shown[0]?.name ?? typed : shown.length === 1 ? shown[0].name : typed); }} />
      <div className="taglist">
        {shown.slice(0, SHOWN).map(n => (
          <div key={n.name} className={"tagrow" + (n.name === current ? " on" : "")} role="button" tabIndex={0} onClick={() => pick(n.name)}>
            <span>{n.name}</span><span className="muted">{n.count.toLocaleString("en-US")} {n.count === 1 ? "resource" : "resources"}</span>
          </div>))}
        {shown.length > SHOWN && <div className="muted small">{shown.length - SHOWN} more: type to narrow</div>}
        {!names.length && <div className="muted small">No tags were listed for these subscriptions (listing tags needs Reader). You can still type one.</div>}
        {typed && !exact && <div className="tagrow" role="button" tabIndex={0} onClick={() => pick(typed)}>
          <span>read tag “{typed}”</span><span className="muted">not in the list: tag names are case-insensitive</span></div>}
      </div>
      <p className="muted">{unavailable ?? (busy ? "Reading the tag…" : "Reads that tag for this run's subscriptions and period (one query each); the run keeps it.")}</p>
    </div>
  );
}
