// The app around the map: sign in (or paste a token, or try the demo), pick subscriptions, read costs, show them.
import { useEffect, useMemo, useRef, useState } from "react";
import { loadConfig, type AppConfig } from "../auth/config";
import { inspectToken, signIn, signOut, startAuth, tokenSource, type Auth } from "../auth/msal";
import { Azure, explain, type TokenSource } from "../azure/client";
import { fetchCosts, listSubscriptions, scopeTarget, subscriptionTarget, type Subscription } from "../azure/costs";
import { demo } from "../core/demo";
import { nowStamp, type CostData, type Metric } from "../core/types";
import { Viewer } from "../viewer/Viewer";
import { forgetRun, loadRun, saveRun, type SavedRun } from "./cache";
import "./app.css";

type Phase = "boot" | "start" | "setup" | "running" | "view";
interface Session { token: TokenSource; who: string; auth: Auth | null }

const TOKEN_CMD = "az account get-access-token --resource https://management.azure.com/ --query accessToken -o tsv";

export function App() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [auth, setAuth] = useState<Auth | null>(null); // MSAL, when sign-in is configured
  const [session, setSession] = useState<Session | null>(null);
  const [saved, setSaved] = useState<SavedRun | null>(null);
  const [data, setData] = useState<{ data: CostData; who: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return; // once: MSAL must not handle the same sign-in twice (StrictMode runs effects twice)
    booted.current = true;
    (async () => {
      setSaved(await loadRun());
      const c = await loadConfig();
      setCfg(c);
      if (c) {
        try {
          const auth = await startAuth(c);
          setAuth(auth);
          if (auth.account) {
            setSession({ token: tokenSource(auth), who: auth.account.username || auth.account.name || "signed in", auth });
            setPhase("setup");
            return;
          }
        } catch (e) {
          setError(`Microsoft sign-in failed to start: ${(e as Error).message}`);
        }
      }
      setPhase("start");
    })();
  }, []);

  const showData = (d: CostData, who: string | null) => {
    setData({ data: d, who });
    setPhase("view");
  };
  const newRun = () => {
    history.replaceState(null, "", location.pathname); // the viewer's #view and its history steps end here
    setPhase(session ? "setup" : "start");
  };
  const runDemo = () => showData({ ...demo(30), generated: nowStamp(), metric: "ActualCost" }, null);
  const openSaved = () => saved && showData(saved.data, saved.who);
  const forget = async () => { await forgetRun(); setSaved(null); };

  if (phase === "view" && data) return <Viewer data={data.data} who={data.who} onNewRun={newRun} />;

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
        {phase === "start" && <Start cfg={cfg} onSignIn={auth ? () => signIn(auth) : null} saved={saved} onDemo={runDemo} onOpenSaved={openSaved} onForget={forget}
          onToken={(token, who) => { setSession({ token: async () => token, who, auth: null }); setError(null); setPhase("setup"); }} />}
        {(phase === "setup" || phase === "running") && session &&
          <Setup session={session} saved={saved} running={phase === "running"} setRunning={r => setPhase(r ? "running" : "setup")}
            onDemo={runDemo} onOpenSaved={openSaved}
            onDone={async d => {
              const run = { data: d, who: session.who, saved: nowStamp() };
              await saveRun(run);
              setSaved(run);
              showData(d, session.who);
            }} />}
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

// ---------------------------------------------------------------- pick what to read, then read it

function Setup({ session, saved, running, setRunning, onDemo, onOpenSaved, onDone }: {
  session: Session; saved: SavedRun | null; running: boolean; setRunning: (r: boolean) => void;
  onDemo: () => void; onOpenSaved: () => void; onDone: (d: CostData) => void;
}) {
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [find, setFind] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [opts, setOpts] = useState({ days: 30, metric: "ActualCost" as Metric, advisor: true, graph: true, tag: "", scope: "" });
  const abort = useRef<AbortController | null>(null);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listSubscriptions(new Azure(session.token)).then(list => {
      setSubs(list);
      const enabled = list.filter(s => s.state === "Enabled");
      setPicked(new Set(enabled.length <= 10 ? enabled.map(s => s.id) : [])); // many subscriptions: many requests, so choose
    }).catch(e => setErr(explain(e)));
  }, [session]);
  useEffect(() => logEnd.current?.scrollIntoView({ block: "end" }), [log]);

  const shown = useMemo(() => (subs ?? []).filter(s => !find || `${s.name} ${s.id}`.toLowerCase().includes(find.toLowerCase())), [subs, find]);
  const togglePick = (id: string) => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const scope = opts.scope.trim();
  const ready = (scope || picked.size > 0) && opts.days >= 1 && opts.days <= 180;

  async function read() {
    setErr(null);
    setLog([]);
    setRunning(true);
    abort.current = new AbortController();
    const say = (m: string) => setLog(l => [...l, m]);
    const az = new Azure(session.token, say, abort.current.signal);
    const targets = scope ? [scopeTarget(scope)]
      : (subs ?? []).filter(s => picked.has(s.id)).map(subscriptionTarget);
    say(`reading ${targets.length === 1 ? targets[0].name : `${targets.length} subscriptions`}, last ${opts.days} days (+${opts.days} before, for comparison)`);
    try {
      const d = await fetchCosts(az, targets, { days: opts.days, metric: opts.metric, advisor: opts.advisor, graph: opts.graph, tag: opts.tag.trim() || null }, say);
      onDone({ ...d, generated: nowStamp(), metric: opts.metric });
    } catch (e) {
      setErr(explain(e));
      setRunning(false);
    }
  }

  if (running) {
    return (
      <>
        <div className="log">{log.map((l, i) => <div key={i}>{l}</div>)}<div ref={logEnd} /></div>
        <p className="muted small">Cost Management limits how often it can be called, per subscription and per tenant. A run makes about
          10–14 requests per subscription and may wait 30–60 seconds when Azure asks it to.</p>
        <div className="actions"><button onClick={() => abort.current?.abort()}>Cancel</button></div>
      </>
    );
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
        <label>Period (days)<input type="number" min={1} max={180} value={opts.days} onChange={e => setOpts({ ...opts, days: Number(e.target.value) })} />
          <span className="muted small">compared with the same number of days before</span></label>
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
