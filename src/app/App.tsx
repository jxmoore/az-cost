// The app around the map: sign in (or paste a token, or try the demo), pick subscriptions, read costs, show them.
import { useEffect, useMemo, useRef, useState } from "react";
import { loadConfig, type AppConfig } from "../auth/config";
import { inspectToken, signIn, signOut, startAuth, tokenSource, type Auth } from "../auth/msal";
import { Azure, explain, type TokenSource } from "../azure/client";
import {
  fetchCosts, fetchTagView, listSubscriptions, scopeTarget, subscriptionTarget, type FetchOptions, type Pending, type Subscription, type Target,
} from "../azure/costs";
import { demo } from "../core/demo";
import { FAKE } from "../dev/fakeMode";
import { MAX_DAYS, resolvePeriod, type PeriodMode, type PeriodSpec } from "../core/period";
import { localToday, nowStamp, type CostData, type Metric } from "../core/types";
import { Viewer } from "../viewer/Viewer";
import { forgetRun, loadRun, saveRun, type SavedRun } from "./cache";
import { parseLink, type Place, type RunSpec } from "./links";
import "./app.css";

type Phase = "boot" | "start" | "setup" | "running" | "view";
interface Session { token: TokenSource; who: string; auth: Auth | null }
/** A run in progress: its log until the map shows, then what it's still reading. */
interface Run { abort: AbortController; log: string[]; pending: Pending[]; error: string | null }

const TOKEN_CMD = "az account get-access-token --resource https://management.azure.com/ --query accessToken -o tsv";

export function App() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [auth, setAuth] = useState<Auth | null>(null); // MSAL, when sign-in is configured
  const [session, setSession] = useState<Session | null>(null);
  const [saved, setSaved] = useState<SavedRun | null>(null);
  const [data, setData] = useState<{ data: CostData; who: string | null; place?: Place | null } | null>(null);
  // the link this page was opened with: read what it names once signed in, and show where it points
  const [link, setLink] = useState(() => parseLink(location.search));
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);

  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return; // once: MSAL must not handle the same sign-in twice (StrictMode runs effects twice)
    booted.current = true;
    (async () => {
      setSaved(await loadRun());
      if (link?.run.demo) { runDemo(link.place); return; } // a demo link needs no Azure
      if (FAKE) { // development: a fake Azure, already signed in
        const fake = { token: async () => "fake", who: "fake@dev", auth: null };
        setSession(fake);
        if (link) openLink(fake, link); else setPhase("setup");
        return;
      }
      const c = await loadConfig();
      setCfg(c);
      if (c) {
        try {
          const auth = await startAuth(c);
          setAuth(auth);
          if (auth.account) {
            const signedIn = { token: tokenSource(auth), who: auth.account.username || auth.account.name || "signed in", auth };
            setSession(signedIn);
            if (link) openLink(signedIn, link); else setPhase("setup");
            return;
          }
        } catch (e) {
          setError(`Microsoft sign-in failed to start: ${(e as Error).message}`);
        }
      }
      setPhase("start");
    })();
  }, []);

  const showData = (d: CostData, who: string | null, place?: Place | null) => {
    setData(prev => ({ data: d, who, place: place === undefined ? prev?.place : place }));
    setPhase("view");
  };
  const newRun = () => {
    run?.abort.abort(); // a run still reading stops here
    setRun(null);
    setLink(null);
    history.replaceState(null, "", location.pathname); // the link, the viewer's #view and its history steps end here
    setPhase(session ? "setup" : "start");
  };
  const runDemo = (place: Place | null = null) => {
    setRun(null);
    const run: RunSpec = { demo: true, period: { mode: "days", days: 30 }, metric: "ActualCost", tag: null };
    showData({ ...demo(30), generated: nowStamp(), metric: "ActualCost", run }, null, place);
  };
  const openSaved = () => { setRun(null); saved && showData(saved.data, saved.who, null); };

  /** Open a link: read the subscriptions it names that this login can see, then show the place it points to. */
  async function openLink(sess: Session, l: NonNullable<typeof link>) {
    setError(null);
    const period = resolvePeriod(l.run.period);
    if ("error" in period) { setError(`This link's period can't be read: ${period.error}`); setPhase("setup"); return; }
    let targets: Target[];
    if (l.run.scope) targets = [scopeTarget(l.run.scope)];
    else {
      setPhase("boot");
      let visible: Subscription[];
      try { visible = await listSubscriptions(new Azure(sess.token)); } catch (e) { setError(explain(e)); setPhase("setup"); return; }
      targets = visible.filter(s => l.run.subs!.includes(s.id.toLowerCase())).map(subscriptionTarget);
      const hidden = l.run.subs!.length - targets.length;
      if (!targets.length) {
        setError("This link is for subscriptions this login can't read. Ask whoever shared it for access (Cost Management Reader or Reader).");
        setPhase("setup");
        return;
      }
      if (hidden) setError(`${hidden} of the link's ${l.run.subs!.length} subscriptions aren't readable with this login; showing the rest.`);
    }
    startRun(sess, targets, { period, metric: l.run.metric, advisor: true, graph: true, tag: l.run.tag },
      `opening a shared view: ${targets.length === 1 ? targets[0].name : `${targets.length} subscriptions`}, ${period.label}`,
      { subs: l.run.subs, scope: l.run.scope, period: l.run.period, metric: l.run.metric, tag: l.run.tag }, l.place);
  }
  const forget = async () => { await forgetRun(); setSaved(null); };

  /** Read costs. The map opens with the first stage (services) and fills in as the rest arrives. */
  async function startRun(sess: Session, targets: Target[], o: FetchOptions, intro: string, spec: RunSpec, place: Place | null = null) {
    const abort = new AbortController(), who = sess.who;
    const update = (patch: Partial<Run>) => setRun(r => (r && r.abort === abort ? { ...r, ...patch } : r));
    const say = (m: string) => setRun(r => (r && r.abort === abort ? { ...r, log: [...r.log, m] } : r));
    setRun({ abort, log: [intro], pending: [], error: null });
    setPhase("running");
    let shown = false;
    const stamp = (d: CostData): CostData => ({ ...d, generated: nowStamp(), metric: o.metric, run: spec });
    try {
      const final = await fetchCosts(new Azure(sess.token, say, abort.signal), targets, o, say, (d, pending) => {
        if (abort.signal.aborted) return;
        update({ pending });
        showData(stamp(d), who, shown ? undefined : place);
        shown = true;
      });
      if (abort.signal.aborted) return;
      const d = stamp(final);
      showData(d, who);
      update({ pending: [] });
      const entry = { data: d, who, saved: nowStamp() };
      await saveRun(entry);
      setSaved(entry);
    } catch (e) {
      if (abort.signal.aborted) return;
      if (shown) update({ pending: [], error: explain(e) }); // keep what was read, and say it stopped early
      else { setError(explain(e)); setRun(null); setPhase("setup"); }
    }
  }

  /** Split the bill by another tag: read it for this run's subscriptions and period, and keep it with the run. */
  async function chooseTag(tag: string) {
    if (!session || !data) return;
    const shown = data, abort = new AbortController();
    setError(null);
    setRun(r => ({ abort: r?.abort ?? abort, log: r?.log ?? [], error: null, pending: [...(r?.pending ?? []).filter(p => p !== "tags"), "tags"] }));
    const done = (patch: Partial<Run>) => setRun(r => r && { ...r, ...patch, pending: r.pending.filter(p => p !== "tags") });
    try {
      const { view, tags } = await fetchTagView(new Azure(session.token), shown.data, tag, () => {});
      const d = shown.data, next: CostData = {
        ...d, views: { ...d.views, tag: view },
        detail: d.detail ? { ...d.detail, tags } : d.detail,
        run: d.run ? { ...d.run, tag } : d.run, // links to this run now carry the tag
      };
      showData(next, shown.who);
      done({});
      const entry = { data: next, who: shown.who, saved: nowStamp() };
      await saveRun(entry);
      setSaved(entry);
    } catch (e) { // the run is fine: say so beside it rather than as the run stopping
      done({});
      setError(`Couldn't read the tag "${tag}": ${explain(e).split("\n")[0]}`);
    }
  }

  if (phase === "view" && data) {
    return <Viewer data={data.data} who={data.who} onNewRun={newRun} loading={run?.pending ?? []} loadError={run?.error ?? null}
      initial={data.place ?? null} notice={error}
      onChooseTag={session && !data.data.demo ? chooseTag : null}
      tagUnavailable={data.data.demo ? "The demo has one tag. Sign in (or paste a token) to pick among your own."
        : "Sign in (or paste a token) to read another tag for this saved run."} />;
  }

  return (
    <div className="shell">
      <div className="card">
        <div className="brand">
          <div className="logo"><i><b style={{ background: "var(--compute)" }} /><b style={{ background: "var(--storage)" }} /><b style={{ background: "var(--database)" }} /><b style={{ background: "var(--network)" }} /></i>azcost</div>
          <span className="muted">see where your Azure money goes</span>
          <span className="spacer" />
          {session && <span className="muted">{session.who} · <a onClick={() => {
            if (session.auth) signOut(session.auth);
            else { setSession(null); setPhase("start"); }
          }}>{session.auth ? "sign out" : "forget token"}</a></span>}
        </div>
        {error && <div className="error">{error}</div>}
        {phase === "boot" && <div className="muted">Starting…</div>}
        {phase === "start" && link && <div className="note-box">Sign in to open the view that was shared with you. You'll see only the costs
          your own Azure access allows.</div>}
        {phase === "start" && <Start cfg={cfg} onSignIn={auth ? () => signIn(auth) : null} saved={saved} onDemo={() => runDemo()} onOpenSaved={openSaved} onForget={forget}
          onToken={(token, who) => {
            const pasted = { token: async () => token, who, auth: null };
            setSession(pasted);
            setError(null);
            if (link) openLink(pasted, link); else setPhase("setup");
          }} />}
        {phase === "setup" && session &&
          <Setup session={session} saved={saved} onDemo={() => runDemo()} onOpenSaved={openSaved}
            onRead={(targets, o, intro, spec) => { setError(null); startRun(session, targets, o, intro, spec); }} />}
        {phase === "running" && run && <Running run={run} onCancel={() => { run.abort.abort(); setRun(null); setPhase("setup"); }} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- not signed in yet

function Start({ cfg, onSignIn, saved, onDemo, onOpenSaved, onForget, onToken }: {
  cfg: AppConfig | null; onSignIn: (() => void) | null; saved: SavedRun | null; onDemo: () => void; onOpenSaved: () => void; onForget: () => void;
  onToken: (token: string, who: string) => void;
}) {
  const [showToken, setShowToken] = useState(!cfg);
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const useToken = () => {
    const t = token.trim(), r = inspectToken(t);
    if (!r.ok) { setErr(r.error); return; }
    onToken(t, r.who);
  };
  return (
    <>
      <p>azcost reads your Azure costs for the last 30 days, compares them with the 30 before, and draws them as a treemap:
        a bigger box is a bigger cost. It only reads; it never changes anything in your subscriptions.</p>
      <div className="actions">
        {cfg && onSignIn
          ? <button className="primary" onClick={onSignIn}>Sign in with Microsoft</button>
          : <div className="note-box">Microsoft sign-in isn't set up yet: <code>config.json</code> still has placeholder ids. See the README
            for the app registration. Until then, paste a token below or try the demo.</div>}
        <button onClick={onDemo}>Try the demo</button>
        {saved && <><button onClick={onOpenSaved}>Open last run</button>
          <span className="muted small">{saved.who ?? "demo"} · read {saved.data.generated ?? saved.saved} · <a onClick={onForget}>forget</a></span></>}
      </div>
      <div className="section">
        <a onClick={() => setShowToken(s => !s)}>{showToken ? "▾" : "▸"} Use an access token instead</a>
        {showToken && <div className="token">
          <p className="muted">Already signed in with the Azure CLI? Copy a token and paste it here. It stays in this tab's memory
            and lasts about an hour. It only sees its own tenant.</p>
          <pre onClick={e => navigator.clipboard?.writeText((e.target as HTMLElement).textContent || "")} title="click to copy">{TOKEN_CMD}</pre>
          <textarea value={token} onChange={e => { setToken(e.target.value); setErr(null); }} placeholder="eyJ0eXAiOiJKV1Qi…" rows={3} spellCheck={false} />
          {err && <div className="error">{err}</div>}
          <button className="primary" disabled={!token.trim()} onClick={useToken}>Use token</button>
        </div>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- a run, until the map can show

function Running({ run, onCancel }: { run: Run; onCancel: () => void }) {
  const logEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { logEnd.current?.scrollIntoView({ block: "end" }); }, [run.log]); // braces: scrolling may return a promise
  return (
    <>
      <div className="log">{run.log.map((l, i) => <div key={i}>{l}</div>)}<div ref={logEnd} /></div>
      <p className="muted small">The map opens as soon as the services are read, and fills in while the rest arrives. Cost Management
        limits how often it can be called, per subscription and per tenant, and azcost waits when Azure asks it to.</p>
      <div className="actions"><button onClick={onCancel}>Cancel</button></div>
    </>
  );
}

// ---------------------------------------------------------------- pick what to read

function Setup({ session, saved, onDemo, onOpenSaved, onRead }: {
  session: Session; saved: SavedRun | null; onDemo: () => void; onOpenSaved: () => void;
  onRead: (targets: Target[], o: FetchOptions, intro: string, spec: RunSpec) => void;
}) {
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [find, setFind] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [opts, setOpts] = useState({ days: 30, metric: "ActualCost" as Metric, advisor: true, graph: true, tag: "", scope: "" });
  const [periodMode, setPeriodMode] = useState<PeriodMode>("days");
  const [range, setRange] = useState({ from: "", to: "" });
  const period = resolvePeriod({ mode: periodMode, days: opts.days, ...range });

  useEffect(() => {
    listSubscriptions(new Azure(session.token)).then(list => {
      setSubs(list);
      const enabled = list.filter(s => s.state === "Enabled");
      setPicked(new Set(enabled.length <= 10 ? enabled.map(s => s.id) : [])); // many subscriptions: many requests, so choose
    }).catch(e => setErr(explain(e)));
  }, [session]);

  const shown = useMemo(() => (subs ?? []).filter(s => !find || `${s.name} ${s.id}`.toLowerCase().includes(find.toLowerCase())), [subs, find]);
  const togglePick = (id: string) => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const scope = opts.scope.trim();
  const ready = (scope || picked.size > 0) && !("error" in period);

  function read() {
    if ("error" in period) return;
    const targets = scope ? [scopeTarget(scope)] : (subs ?? []).filter(s => picked.has(s.id)).map(subscriptionTarget);
    const spec: PeriodSpec = { mode: periodMode, days: opts.days, ...range }, tag = opts.tag.trim() || null;
    onRead(targets, { period, metric: opts.metric, advisor: opts.advisor, graph: opts.graph, tag },
      `reading ${targets.length === 1 ? targets[0].name : `${targets.length} subscriptions`}: ${period.cur[0]} to ${period.cur[1]}, ` +
      `compared with ${period.prev[0]} to ${period.prev[1]}`,
      { subs: scope ? undefined : targets.map(t => t.id.toLowerCase()), scope: scope || undefined, period: spec, metric: opts.metric, tag });
  }

  return (
    <>
      {err && <div className="error">{err}</div>}
      <div className="section">
        <div className="row">
          <b>Subscriptions</b>
          <span className="muted small">{subs ? `${picked.size} of ${subs.length} picked` : "loading…"}</span>
          <span className="spacer" />
          {subs && subs.length > 6 && <input placeholder="find" value={find} onChange={e => setFind(e.target.value)} />}
          {subs && <><a onClick={() => setPicked(new Set(shown.filter(s => s.state === "Enabled").map(s => s.id)))}>all</a>
            <a onClick={() => setPicked(new Set())}>none</a></>}
        </div>
        <div className="subs">
          {subs?.length === 0 && <div className="muted">This login can't see any subscriptions. You need Reader or Cost Management Reader on one.</div>}
          {shown.map(s => (
            <label key={s.id} className={s.state !== "Enabled" ? "off" : ""}>
              <input type="checkbox" checked={picked.has(s.id)} disabled={s.state !== "Enabled" || !!scope} onChange={() => togglePick(s.id)} />
              <span>{s.name}</span><span className="muted small">{s.id}{s.state !== "Enabled" ? ` · ${s.state}` : ""}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="section grid">
        <label>Period<select value={periodMode} onChange={e => setPeriodMode(e.target.value as PeriodMode)}>
          <option value="days">Last days…</option><option value="mtd">Month to date</option>
          <option value="lastMonth">Last full month</option><option value="custom">Custom range…</option></select>
          {periodMode === "days" && <input type="number" min={1} max={MAX_DAYS} value={opts.days} aria-label="days"
            onChange={e => setOpts({ ...opts, days: Number(e.target.value) })} />}
          {periodMode === "custom" && <span className="row">
            <input type="date" value={range.from} max={localToday()} aria-label="from" onChange={e => setRange({ ...range, from: e.target.value })} />
            <input type="date" value={range.to} max={localToday()} aria-label="to" onChange={e => setRange({ ...range, to: e.target.value })} /></span>}
          <span className={"small " + ("error" in period ? "warn" : "muted")}>{"error" in period ? period.error
            : `${period.cur[0]} to ${period.cur[1]}, compared with ${period.prev[0]} to ${period.prev[1]}`}</span></label>
        <label>Cost type<select value={opts.metric} onChange={e => setOpts({ ...opts, metric: e.target.value as Metric })}>
          <option value="ActualCost">Actual cost</option><option value="AmortizedCost">Amortized cost</option></select>
          <span className="muted small">amortized spreads reservation and savings plan purchases over their term</span></label>
        <label>Tag for the tag view<input value={opts.tag} placeholder="automatic" onChange={e => setOpts({ ...opts, tag: e.target.value })} />
          <span className="muted small">default: the tag on the most resources</span></label>
        <label>Scope (optional)<input value={opts.scope} placeholder="/providers/Microsoft.Billing/billingAccounts/…" onChange={e => setOpts({ ...opts, scope: e.target.value })} />
          <span className="muted small">any Cost Management scope instead of subscriptions (untested)</span></label>
        <label className="chk"><input type="checkbox" checked={opts.advisor} onChange={e => setOpts({ ...opts, advisor: e.target.checked })} /> Azure Advisor cost tips</label>
        <label className="chk"><input type="checkbox" checked={opts.graph} onChange={e => setOpts({ ...opts, graph: e.target.checked })} /> Resource Graph idle checks</label>
      </div>
      <div className="actions">
        <button className="primary" disabled={!ready} onClick={read}>Read costs</button>
        <button onClick={onDemo}>Try the demo</button>
        {saved && <button onClick={onOpenSaved}>Open last run <span className="muted small">({saved.data.generated ?? saved.saved})</span></button>}
      </div>
    </>
  );
}
