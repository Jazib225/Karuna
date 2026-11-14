import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { Address } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { isTightening, isAddr, decodeChange, describeChange, type Change } from "@prekaruna/dharma";
import { api, useGatekeeper, type LooseningPreview, type AgentView, type Governance, type LogEntry, type Proposal, type Rule, type Snapshot, type WalletInfo } from "./api.ts";
import { Kind, SignerUnavailable, decidePayment, loadSigner, submitChange } from "./signer.ts";
import { useRelay, type ChainEvent, type LiveMode } from "./live.ts";
import { keccak256, stringToHex } from "viem";

// One job per page. The menu groups them: everyday work first, then the automatic safety systems,
// settings, and a testing tool. Older names (pop-ups, saved state) still resolve.
type Page = "overview" | "approvals" | "votes" | "agents" | "payees" | "activity" | "shield" | "swarm" | "rules" | "team" | "inbox";
type View = Page | "dharma" | "safety" | "policy";
const PAGE_OF: Record<View, Page> = {
  overview: "overview", approvals: "approvals", votes: "votes", agents: "agents", payees: "payees", activity: "activity",
  shield: "shield", swarm: "swarm", rules: "rules", team: "team", inbox: "inbox",
  dharma: "votes", safety: "shield", policy: "rules",
};
const TITLES: Record<Page, string> = {
  overview: "Home", approvals: "Approvals", votes: "Votes", agents: "Agents", payees: "Payees", activity: "Activity",
  shield: "Auto-Shield", swarm: "Swarm Stopper", rules: "Rules", team: "Team", inbox: "Test inbox",
};
const ICON: Record<Page, string> = {
  overview: "▦", approvals: "◷", votes: "⚖", agents: "◉", payees: "⇄", activity: "≋", shield: "⛨", swarm: "⌬", rules: "☰", team: "☺", inbox: "✉",
};
const NAV: { label: string | null; hint?: string; pages: Page[] }[] = [
  { label: null, pages: ["overview", "approvals", "votes", "agents", "payees", "activity"] },
  { label: "Safety", hint: "runs on its own", pages: ["shield", "swarm"] },
  { label: "Settings", pages: ["rules", "team"] },
  { label: "Testing", hint: "demos only", pages: ["inbox"] },
];
/** Arc explorer link for a transaction hash (payments, Dharma writes, freezes, anchors). */
const isTx = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
function TxLink({ tx, s }: { tx: unknown; s: Snapshot }) {
  if (!isTx(tx) || !s.org.dharma) return null;
  return <a className="txlink" href={`${s.org.dharma.explorer.replace(/\/address\/.*$/, "")}/tx/${tx}`} target="_blank" rel="noreferrer" title={tx}>Arc tx ↗</a>;
}
const AGENT_API = "http://127.0.0.1:8787";

const usd = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(4).replace(/0+$/, "") : n.toFixed(2)}`;
const short = (s?: string | null) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "—");
const ago = (iso: string | number) => {
  const t = typeof iso === "number" ? iso * 1000 : Date.parse(iso);
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};
const st = (i: number) => ({ ["--i"]: i }) as CSSProperties;
const GLYPH = { allow: "✓", deny: "✕", approval: "◷" } as const;

type Notify = (kind: "ok" | "err", text: string) => void;
type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ============================================================== root

export default function App() {
  const gk = useGatekeeper();
  const signer = useMemo<{ me: PrivateKeyAccount | null; error: string | null }>(() => {
    try {
      return { me: loadSigner(), error: null };
    } catch (e) {
      return { me: null, error: e instanceof SignerUnavailable ? e.message : String(e) };
    }
  }, []);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const notify: Notify = (kind, text) => {
    setFlash({ kind, text });
    setTimeout(() => setFlash((f) => (f?.text === text ? null : f)), 6000);
  };
  const run: Run = async (fn, ok) => {
    if (busy) return false;
    setBusy(true);
    try {
      await fn();
      if (ok) notify("ok", ok);
      await gk.refresh();
      return true;
    } catch (e) {
      notify("err", e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  const s = gk.state;
  if (!s && gk.offline) body = <Offline reason={gk.offline} />;
  else if (!s) body = <div className="center muted">Connecting to the Gatekeeper…</div>;
  else if (!signer.me) body = <div className="center"><div className="card narrow pad">{signer.error}</div></div>;
  else if (!s.setUp) body = <Setup s={s} me={signer.me} run={run} busy={busy} />;
  else if (!s.policy) body = <div className="center muted">Reading Dharma from Arc…</div>;
  else if (!s.policy.members.some((m) => m.address === signer.me!.address.toLowerCase())) body = <Join s={s} me={signer.me} run={run} />;
  else body = <Console s={s} log={gk.log} wallet={gk.wallet} run={run} busy={busy} me={signer.me} offline={gk.offline} refresh={gk.refresh} />;

  return (
    <>
      {body}
      {busy && <div className="busy-bar" />}
      {flash && <div className={`flash ${flash.kind}`} onClick={() => setFlash(null)}>{flash.text}</div>}
    </>
  );
}

function Offline({ reason }: { reason: string }) {
  return (
    <div className="center">
      <div className="card narrow">
        <div className="hd"><h2>Gatekeeper not reachable</h2></div>
        <div className="pad stack">
          <p className="muted">The console only shows what the Gatekeeper reports. Start it, and this page connects on its own.</p>
          <pre className="snippet">pnpm --dir gatekeeper start</pre>
          <p className="muted small mono">{reason}</p>
        </div>
      </div>
    </div>
  );
}

// ============================================================== setup: deploy this org's Dharma

function Setup({ s, me, run, busy }: { s: Snapshot; me: PrivateKeyAccount; run: Run; busy: boolean }) {
  const [detected, setDetected] = useState<string[] | null>(null);
  const [detectErr, setDetectErr] = useState<string | null>(null);
  const [form, setForm] = useState({ orgName: "", memberName: "", walletAddress: "" });

  useEffect(() => {
    api<{ wallets: string[]; error?: string }>("/wallets/detect")
      .then((r) => {
        setDetected(r.wallets);
        if (r.error) setDetectErr(r.error);
        if (r.wallets.length === 1) setForm((f) => ({ ...f, walletAddress: r.wallets[0] }));
      })
      .catch((e) => setDetectErr(String(e)));
  }, []);

  const deploying = busy || s.deploying;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(() => api("/setup", { ...form, memberAddress: me.address }), "Dharma deployed — your organization is live");
  };

  return (
    <div className="center">
      <form className="card narrow rise" onSubmit={submit}>
        <div className="hd">
          <div className="brand"><span className="mark">⬡</span> Karuna</div>
          <span className="sub">first-time setup</span>
        </div>
        <div className="pad stack">
          <div>
            <h2 className="setup-title">Set up your organization</h2>
            <p className="muted">Karuna deploys your organization's own <b>Dharma</b> rulebook on Arc. Every rule change needs your team's vote and a short waiting period; only the panic button acts instantly. You'll be its first member.</p>
          </div>
          <label className="field">
            <span>Organization name</span>
            <input required autoFocus value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} placeholder="Your company" />
          </label>
          <label className="field">
            <span>Your name</span>
            <input required value={form.memberName} onChange={(e) => setForm({ ...form, memberName: e.target.value })} placeholder="First approver" />
            <small className="muted">Kept private by your Gatekeeper — names never go onchain.</small>
          </label>
          <label className="field">
            <span>Wallet the Gatekeeper pays from (and deploys Dharma with)</span>
            {detected && detected.length > 0 && (
              <div className="choices">
                {detected.map((w) => (
                  <button type="button" key={w} className={`choice ${form.walletAddress === w ? "sel" : ""}`} onClick={() => setForm({ ...form, walletAddress: w })}>
                    <span className="radio" /> <span className="mono">{w}</span>
                  </button>
                ))}
              </div>
            )}
            <input required className="mono" value={form.walletAddress} onChange={(e) => setForm({ ...form, walletAddress: e.target.value.trim() })} placeholder="0x… Circle agent wallet on Arc testnet" />
            <small className="muted">
              {detected === null
                ? "Looking for Circle agent wallets on this machine…"
                : detected.length
                  ? `Found ${detected.length} Circle agent wallet${detected.length > 1 ? "s" : ""} logged in on this machine.`
                  : `No logged-in Circle wallet found${detectErr ? ` (${detectErr})` : ""}. Run: circle wallet login <email> --testnet`}
            </small>
          </label>
          <div className="keybox">
            <div className="small muted">Your signing key (created in this browser)</div>
            <div className="mono">{me.address}</div>
            <div className="small muted">Every vote and approval you make is signed with it, here. Use this browser for Karuna.</div>
          </div>
          <button className="btn btn-dark" type="submit" disabled={deploying}>{deploying ? "Deploying Dharma on Arc…" : "Create organization"}</button>
        </div>
      </form>
    </div>
  );
}

// ============================================================== join: a browser that isn't a member yet

function Join({ s, me, run }: { s: Snapshot; me: PrivateKeyAccount; run: Run }) {
  const [name, setName] = useState("");
  const requested = s.enrollments.some((e) => e.address === me.address.toLowerCase());
  return (
    <div className="center">
      <form className="card narrow rise" onSubmit={(e) => { e.preventDefault(); run(() => api("/access-request", { address: me.address, name }), "Request sent"); }}>
        <div className="hd"><div className="brand"><span className="mark">⬡</span> Karuna</div><span className="sub">{s.org.name}</span></div>
        <div className="pad stack">
          <h2 className="setup-title">This browser isn't a member yet</h2>
          <p className="muted">Members of <b>{s.org.name}</b> sign every approval and policy change with a key in their own browser. Ask to join; a current member proposes adding you, and Dharma adds you after the vote and a {s.policy!.timelock}s wait.</p>
          <div className="keybox"><div className="small muted">This browser's signing key</div><div className="mono">{me.address}</div></div>
          {requested ? (
            <p className="ok-text">Request sent. A member will see it under Team → Access requests.</p>
          ) : (
            <>
              <label className="field"><span>Your name</span><input required value={name} onChange={(e) => setName(e.target.value)} placeholder="So teammates recognize you" /></label>
              <button className="btn btn-dark">Ask to join</button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

// ============================================================== console shell

interface Ctx {
  s: Snapshot;
  me: PrivateKeyAccount;
  run: Run;
  busy: boolean;
  /** Sign a change. Every rule change is proposed for a vote; only the panic button (Freeze) applies at once. */
  change: (c: Change, label?: string) => Promise<boolean>;
  vote: (g: Governance, support: boolean) => Promise<boolean>;
  name: (address?: string | null) => string;
}

function Console({ s, log, wallet, run, busy, me, offline, refresh }: { s: Snapshot; log: LogEntry[]; wallet: WalletInfo | null; run: Run; busy: boolean; me: PrivateKeyAccount; offline: string | null; refresh: () => Promise<void> }) {
  const [view, setPage] = useState<Page>(() => {
    try {
      return PAGE_OF[localStorage.getItem("karuna.view") as View] ?? "overview";
    } catch {
      return "overview";
    }
  });
  const setView = (v: View) => setPage(PAGE_OF[v] ?? "overview");
  useEffect(() => {
    try {
      localStorage.setItem("karuna.view", view);
    } catch {
      /* per-viewer convenience only */
    }
  }, [view]);

  const pol = s.policy!;
  const dharma = s.org.dharma!.address as Address;
  const myAddr = me.address.toLowerCase();
  const myName = pol.members.find((m) => m.address === myAddr)?.name ?? short(myAddr);
  const name = (a?: string | null) => (a ? (pol.members.find((m) => m.address === a.toLowerCase())?.name ?? short(a)) : "—");
  const shape = {
    agents: pol.agents.filter((a) => a.active).map((a) => ({ id: a.id, capUsd: a.capUsd })),
    thresholdUsd: pol.thresholdUsd,
    rules: pol.rules.map((r) => ({ id: r.id, outcome: r.outcome, builtin: r.builtin })),
  };
  const ctx: Ctx = {
    s, me, run, busy, name,
    change: (c, label) => {
      const now = c.op === "Freeze";
      return run(
        () => submitChange(me, dharma, { kind: now ? Kind.Tighten : Kind.Propose, change: c, label }),
        now ? "All agents frozen — recorded on Dharma" : `Proposed — goes to Votes: needs ${pol.required} vote${pol.required > 1 ? "s" : ""}, then ${pol.timelock}s`,
      );
    },
    vote: (g, support) => run(() => submitChange(me, dharma, { kind: Kind.Vote, change: g.change as Change, proposalId: g.id, support }), support ? "Vote recorded" : "Voted against"),
  };

  // ---- live chain alerts (QuickNode Stream -> relay -> every member's screen)
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const sRef = useRef(s);
  sRef.current = s;
  const live = useRelay((events) => {
    void refresh();
    const now = Date.now();
    setAlerts((prev) => [...events.map((e) => toAlert(e, sRef.current, name)).filter((a): a is Omit<Alert, "at"> => !!a).map((a) => ({ ...a, at: now })), ...prev].slice(0, 6));
  });
  useEffect(() => {
    const t = setInterval(() => setAlerts((prev) => prev.filter((a) => a.sticky || Date.now() - a.at < 8000)), 1000);
    return () => clearInterval(t);
  }, []);
  const dismiss = (id: string) => setAlerts((prev) => prev.filter((a) => a.id !== id));
  const seenShield = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = s.shield.alerts.map((a) => a.id);
    if (!seenShield.current) {
      seenShield.current = new Set(ids); // existing alerts on load: no pop-ups
      return;
    }
    const fresh = s.shield.alerts.filter((a) => !seenShield.current!.has(a.id) && a.kind !== "shield-failed");
    fresh.forEach((a) => seenShield.current!.add(a.id));
    if (fresh.length) {
      setAlerts((prev) => [
        ...fresh.map((a): Alert => {
          const swarm = a.kind === "swarm-stopped" || a.kind === "trap-touched";
          const bad = swarm || a.kind === "changed-bank-account";
          return {
            id: a.id, title: a.title, body: a.body, source: "rpc", at: Date.now(), sticky: bad,
            tone: bad ? "bad" : a.kind === "shield-passed" ? "ok" : "warn",
            go: swarm ? "swarm" : "shield", cta: swarm ? "Swarm Stopper" : "Auto-Shield",
          };
        }),
        ...prev,
      ].slice(0, 6));
    }
  }, [s.shield.alerts]);

  const pending = s.proposals.filter((p) => p.status === "pending");
  const ballots = pol.proposals.filter((g) => g.status === "open" && !g.voters.includes(myAddr));
  const frozen = s.frozen || null;
  const openUnfreeze = pol.proposals.find((g) => g.change?.op === "Unfreeze" && (g.status === "open" || g.status === "queued"));

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><span className="mark">⬡</span> Karuna</div>
        <div className="biz">{s.org.name}</div>
        <nav className="nav">
          {NAV.map((g) => (
            <div key={g.label ?? "main"} className="nav-group">
              {g.label && <div className="nav-label">{g.label}{g.hint && <span> · {g.hint}</span>}</div>}
              {g.pages.map((v) => (
                <a key={v} className={view === v ? "sel" : ""} onClick={() => setView(v)}>
                  <span className="ic">{ICON[v]}</span> {TITLES[v]}
                  {v === "approvals" && pending.length > 0 && <span className="count warn">{pending.length}</span>}
                  {v === "votes" && ballots.length > 0 && <span className="count warn">{ballots.length}</span>}
                  {v === "team" && s.enrollments.length > 0 && <span className="count">{s.enrollments.length}</span>}
                  {v === "shield" && s.shield.autoRules.some((r) => r.active) && <span className="count warn">{s.shield.autoRules.filter((r) => r.active).length}</span>}
                  {v === "swarm" && s.swarm.tainted.length > 0 && <span className="count warn">{s.swarm.tainted.length}</span>}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="member">
          <div className="small muted mono acting">signed in as</div>
          <div className="who">
            <span className="av">{myName[0]?.toUpperCase()}</span>
            <div><div>{myName}</div><div className="small muted mono">{short(myAddr)}</div></div>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{TITLES[view]}</h1>
          <div className="right">
            <LiveBadge mode={live.mode} />
            <span className={`status ${frozen || offline ? "frozen" : ""}`}>
              <span className="d" /> {offline ? "gatekeeper offline" : frozen ? "all agents frozen" : (() => {
                const n = pol.agents.filter((a) => a.active).length;
                return `${n} agent${n === 1 ? "" : "s"} active`;
              })()}
            </span>
            {frozen ? (
              openUnfreeze ? (
                <button className="panic armed" disabled={busy || openUnfreeze.voters.includes(myAddr) || openUnfreeze.status !== "open"}
                  onClick={() => ctx.vote(openUnfreeze, true)}>
                  {openUnfreeze.status === "queued" ? "Unfreeze passed — waiting out timelock" : openUnfreeze.voters.includes(myAddr) ? `Voted · ${openUnfreeze.yes}/${pol.required}` : `Vote to unfreeze · ${openUnfreeze.yes}/${pol.required}`}
                </button>
              ) : (
                <button className="panic armed" disabled={busy} onClick={() => ctx.change({ op: "Unfreeze" })}>Propose unfreeze</button>
              )
            ) : (
              <button className="panic" disabled={busy} onClick={() => ctx.change({ op: "Freeze" })}>⬛ Panic — freeze all</button>
            )}
          </div>
        </header>

        <div className="alerts">
          {alerts.map((a) => (
            <div key={a.id} className={`alert ${a.tone}`}>
              <div className="alert-top">
                <b>{a.title}</b>
                <span className="via">{a.source === "quicknode" ? "via QuickNode" : a.source === "rpc" && (a.go === "shield" || a.go === "swarm") ? "Gatekeeper" : "via Arc RPC"}</span>
                <button className="alert-x" aria-label="Dismiss" onClick={() => dismiss(a.id)}>×</button>
              </div>
              <div className="alert-body">{a.body}</div>
              {a.go && <button className="alert-cta" onClick={() => { setView(a.go!); dismiss(a.id); }}>{a.cta ?? "Open"} →</button>}
            </div>
          ))}
        </div>

        <div className="content">
          {frozen && (
            <div className="freeze-banner">
              <b>Frozen.</b> {frozen.by ? `${frozen.by} hit the panic button.` : "The panic button was pressed."} Every proposal is denied and no payment can execute.
              {frozen.confirmed ? " Recorded on Dharma." : " Recording on Dharma…"} Unfreezing is a loosening: {pol.required} vote{pol.required > 1 ? "s" : ""} and a {pol.timelock}s wait.
            </div>
          )}
          {view === "overview" && <Overview ctx={ctx} wallet={wallet} go={setView} />}
          {view === "approvals" && <Approvals ctx={ctx} dharma={dharma} />}
          {view === "votes" && <Dharma ctx={ctx} />}
          {view === "agents" && <Agents ctx={ctx} />}
          {view === "payees" && <Payees ctx={ctx} />}
          {view === "shield" && <Shield ctx={ctx} part="tests" />}
          {view === "swarm" && <Swarm ctx={ctx} />}
          {view === "rules" && <div className="stack"><Policy ctx={ctx} /><Learned ctx={ctx} /></div>}
          {view === "team" && <Team ctx={ctx} />}
          {view === "inbox" && <Shield ctx={ctx} part="messages" />}
          {view === "activity" && <Activity ctx={ctx} log={log} />}
        </div>
      </main>
    </div>
  );
}

// ============================================================== overview

function Overview({ ctx, wallet, go }: { ctx: Ctx; wallet: WalletInfo | null; go: (v: View) => void }) {
  const { s } = ctx;
  const pol = s.policy!;
  const pending = s.proposals.filter((p) => p.status === "pending");
  const spent = pol.agents.reduce((n, a) => n + a.spentTodayUsd, 0);
  const live = pol.proposals.filter((g) => g.status === "open" || g.status === "queued");
  const steps = [
    { done: pol.agents.length > 0, text: "Add an agent (its token works once Dharma adds it)", view: "agents" as View },
    { done: pol.payees.length > 0, text: "Add the payees and services your agents may pay", view: "payees" as View },
    { done: pol.members.length > 1, text: "Add a second member (two-person approval, real votes)", view: "team" as View },
  ];
  return (
    <div className="stack">
      <div className="tiles">
        <div className="tile rise" style={st(0)}><div className="k">Waiting for you</div><div className={`v ${pending.length ? "warn" : ""}`}>{pending.length}</div></div>
        <div className="tile rise" style={st(1)}><div className="k">Wallet USDC</div><div className="v">{wallet ? Number(wallet.usdc).toFixed(2) : "…"}</div><div className="small muted">Gateway {wallet?.gateway ?? "—"}</div></div>
        <div className="tile rise" style={st(2)}><div className="k">Dharma votes open</div><div className={`v ${live.length ? "warn" : ""}`}>{live.length}</div></div>
        <div className="tile rise" style={st(3)}><div className="k">Spent today</div><div className="v">{usd(spent)}</div></div>
      </div>

      {steps.some((x) => !x.done) && (
        <div className="card rise" style={st(1)}>
          <div className="hd"><h2>Get started</h2><span className="sub">{steps.filter((x) => x.done).length}/{steps.length}</span></div>
          <div className="checklist">
            {steps.map((x) => (
              <a key={x.text} className={x.done ? "done" : ""} onClick={() => go(x.view)}><span className="box">{x.done ? "✓" : ""}</span> {x.text}</a>
            ))}
          </div>
        </div>
      )}

      <div className="grid2">
        <div className="card rise" style={st(2)}>
          <div className="hd"><h2>Waiting for you</h2><span className="sub link" onClick={() => go("approvals")}>approvals →</span></div>
          {pending.length === 0 ? <div className="empty">Nothing needs approval.</div> : <Rows ctx={ctx} items={pending.slice(0, 4)} />}
        </div>
        <div className="card rise" style={st(3)}>
          <div className="hd"><h2>Dharma</h2><a className="sub link" href={s.org.dharma!.explorer} target="_blank" rel="noreferrer">{short(s.org.dharma!.address)} ↗</a></div>
          <div className="pad stack small">
            <div className="kv"><span>Policy version</span><b className="mono">v{pol.policyVersion}</b></div>
            <div className="kv"><span>Members · votes to loosen</span><b className="mono">{pol.members.length} · {pol.required}</b></div>
            <div className="kv"><span>Timelock</span><b className="mono">{pol.timelock}s</b></div>
            <div className="kv"><span>Log anchored</span><b className="mono">{pol.anchor.length}/{s.log.length} entries</b></div>
            <a className="link small" onClick={() => go("dharma")}>{live.length ? `${live.length} change${live.length > 1 ? "s" : ""} in progress →` : "governance →"}</a>
          </div>
        </div>
      </div>

      <div className="card rise" style={st(4)}>
        <div className="hd"><h2>Recent decisions</h2><span className="sub link" onClick={() => go("activity")}>signed log →</span></div>
        {s.proposals.length === 0 ? <div className="empty">No proposals yet. Decisions appear here the moment an agent asks for something.</div> : <Rows ctx={ctx} items={s.proposals.slice(0, 8)} />}
        <div className="log-foot"><span><span className="sigdot" /> {s.log.verified ? "signed · chain verified" : `TAMPERED at entry ${s.log.brokenAt}`}</span><span>head {short(s.log.head)}</span></div>
      </div>
    </div>
  );
}

function describe(p: Proposal, ctx: Ctx) {
  const a = p.action;
  if (a.type === "x402") return `buy ${a.method ?? "GET"} ${a.url}`;
  if (a.type === "transfer") {
    const r = ctx.s.policy!.payees.find((x) => x.account === String(a.to).toLowerCase());
    return `send ${usd(Number(a.amountUsd))} → ${r?.name ?? short(a.to)}`;
  }
  return `${a.tool}: ${a.command ?? (a.url ? `${a.method ?? "GET"} ${a.url}` : a.path ?? "")}`;
}

function Rows({ ctx, items }: { ctx: Ctx; items: Proposal[] }) {
  return (
    <div className="gk">
      {items.map((p) => {
        const o = p.decision.outcome;
        const label = p.status === "executed" ? "paid" : p.status === "failed" ? "failed" : o === "approval" ? (p.status === "pending" ? "require approval" : p.status) : o;
        const cls = p.status === "failed" ? "deny" : p.status === "executed" ? "allow" : o;
        return (
          <div className={`item ${Date.now() - Date.parse(p.createdAt) < 4000 ? "fresh" : ""}`} key={p.id}>
            <span className="caret">›</span>
            <span className="tool">{p.request.paymentKind ?? p.request.tool}</span>
            <span className={`act ${o === "deny" ? "denied" : ""}`}><span className="ag">{ctx.s.policy!.agents.find((a) => a.id === p.agentId)?.name ?? p.agentId} ·</span> {describe(p, ctx)}</span>
            <span className={`chip ${cls}`}><span className="g">{GLYPH[cls]}</span>{label}</span>
            <span className="pol">{p.decision.ruleId}</span>
            <span className="t">{isTx(p.txRef) ? <TxLink tx={p.txRef} s={ctx.s} /> : ago(p.createdAt)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================== approvals (signed, Facts First, Exact Match)

function Approvals({ ctx, dharma }: { ctx: Ctx; dharma: Address }) {
  const { s } = ctx;
  const pending = s.proposals.filter((p) => p.status === "pending");
  const resolved = s.proposals.filter((p) => p.decision.outcome === "approval" && p.status !== "pending").slice(0, 10);
  return (
    <div className="stack">
      <p className="section-title">Facts first — Karuna verified everything in the grey box. Your approval is signed by your key and bound to the payload hash.</p>
      {pending.length === 0 && <div className="card"><div className="empty">Nothing is waiting for a human.</div></div>}
      {pending.map((p, i) => <div className="rise" style={st(i)} key={p.id}><ApprovalCard p={p} ctx={ctx} dharma={dharma} /></div>)}
      {resolved.length > 0 && (
        <div className="card">
          <div className="hd"><h2>Recently resolved</h2></div>
          <div className="resolved">
            {resolved.map((p) => (
              <div key={p.id} className="res">
                <span className={`chip ${p.status === "executed" || p.status === "allowed" ? "allow" : "deny"}`}>{p.status}</span>
                <span className="mono small">{describe(p, ctx)}</span>
                <span className="muted small">{p.resolvedBy ? `by ${ctx.name(p.resolvedBy)}` : ""} {p.resolvedAt ? ago(p.resolvedAt) : ""}</span>
                {p.error && <div className="res-err">{p.error}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ p, ctx, dharma }: { p: Proposal; ctx: Ctx; dharma: Address }) {
  const { s, me, run, busy } = ctx;
  const myAddr = me.address.toLowerCase();
  const agent = s.policy!.agents.find((a) => a.id === p.agentId);
  const iApproved = p.approvals.some((a) => a.memberId === myAddr);
  const others = p.approvals.filter((a) => a.memberId !== myAddr).map((a) => ctx.name(a.memberId));
  const decide = (approve: boolean) =>
    run(async () => {
      const r = await decidePayment(me, dharma, p.id, p.payloadHash ?? "0".repeat(64), approve);
      if (r.status === "failed") throw new Error(r.error ?? "Payment failed");
    }, approve ? "Approved — signed with your key" : "Denied");
  return (
    <div className="approval">
      <div className="appr-top">
        <span className="who">◉ {agent?.name ?? p.agentId}</span>
        <span className="muted small">{ago(p.createdAt)}</span>
        {p.payload && <span className="amt">{usd(p.payload.amountUsd)}</span>}
      </div>
      <div className="facts">
        <div className="lbl">Karuna — verified facts</div>
        <dl>
          {p.facts.map((f) => (<FactRow key={f.label} label={f.label} value={f.value} tone={f.tone} />))}
          <FactRow label="Why it needs you" value={p.decision.reason} />
        </dl>
      </div>
      {p.reason && (
        <div className="justify">
          <div className="lbl">⚠ written by the agent — may not be true</div>
          <p>{p.reason}</p>
        </div>
      )}
      <div className="appr-actions">
        {p.approvalsNeeded > 1 && (
          <span className="two-person">⚑ two-person approval · {p.approvals.length}/{p.approvalsNeeded}{others.length ? ` · ${others.join(", ")} approved` : ""}</span>
        )}
        <button className="btn btn-deny" disabled={busy} onClick={() => decide(false)}>Deny</button>
        <button className="btn btn-approve" disabled={busy || iApproved || !!s.frozen} title={s.frozen ? "Unfreeze before approving" : undefined} onClick={() => decide(true)}>
          {iApproved ? "You approved" : p.payload ? `Sign & pay ${usd(p.payload.amountUsd)}` : "Sign approval"}
        </button>
      </div>
    </div>
  );
}

function FactRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (<><dt>{label}</dt><dd className={tone ?? ""}>{value}</dd></>);
}

// ============================================================== Dharma governance

function Dharma({ ctx }: { ctx: Ctx }) {
  const { s, me, busy } = ctx;
  const pol = s.policy!;
  const now = useNow();
  const myAddr = me.address.toLowerCase();
  const live = pol.proposals.filter((g) => g.status === "open" || g.status === "queued");
  const done = pol.proposals.filter((g) => g.status === "executed" || g.status === "defeated").slice(0, 15);
  return (
    <div className="stack">
      <div className="card dharma-head rise">
        <div className="pad grid-kv">
          <div><div className="k">Contract</div><a className="mono link" href={s.org.dharma!.explorer} target="_blank" rel="noreferrer">{s.org.dharma!.address} ↗</a></div>
          <div><div className="k">Policy version</div><div className="mono">v{pol.policyVersion}</div></div>
          <div><div className="k">To loosen</div><div className="mono">{pol.required} of {pol.members.length} votes + {pol.timelock}s</div></div>
          <div><div className="k">Signed log anchored</div><div className="mono">{pol.anchor.length} of {s.log.length} entries</div></div>
        </div>
        <div className="log-foot"><span>every rule change: proposal → majority vote → timelock · panic button: instant</span><span>core boundaries: never</span></div>
      </div>

      <p className="section-title">In progress</p>
      {live.length === 0 && <div className="card"><div className="empty">No changes are waiting. Anything that loosens policy — a new payee, a higher allowance, a new member, unfreezing — appears here for a vote.</div></div>}
      {live.map((g, i) => {
        const voted = g.voters.includes(myAddr);
        const remaining = g.eta ? Math.max(0, g.eta - Math.floor(now / 1000)) : null;
        return (
          <div className="card ballot rise" style={st(i)} key={g.id}>
            <div className="ballot-top">
              <span className={`chip ${g.status === "queued" ? "allow" : "approval"}`}>{g.status === "queued" ? "passed" : "voting"}</span>
              <b>{g.description}</b>
              <span className="muted small">#{g.id} · proposed by {ctx.name(g.proposer)} {ago(g.createdAt)}</span>
            </div>
            <div className="ballot-body">
              <div className="votes">
                <div className="track"><div className="fill" style={{ width: `${Math.min(100, (g.yes / pol.required) * 100)}%` }} /></div>
                <span className="mono small">{g.yes}/{pol.required} yes{g.no ? ` · ${g.no} no` : ""}</span>
              </div>
              {g.status === "queued" ? (
                <span className="countdown mono">{remaining ? `in effect in ${remaining}s` : "executing…"}</span>
              ) : voted ? (
                <span className="muted small">You voted · waiting for {pol.required - g.yes} more</span>
              ) : (
                <span className="ballot-actions">
                  <button className="btn btn-deny btn-sm" disabled={busy} onClick={() => ctx.vote(g, false)}>Vote no</button>
                  <button className="btn btn-approve btn-sm" disabled={busy} onClick={() => ctx.vote(g, true)}>Sign yes</button>
                </span>
              )}
            </div>
            {g.preview && <PreviewBox p={g.preview} ctx={ctx} />}
          </div>
        );
      })}

      {done.length > 0 && (
        <div className="card">
          <div className="hd"><h2>History</h2></div>
          <div className="resolved">
            {done.map((g) => (
              <div key={g.id} className="res">
                <span className={`chip ${g.status === "executed" ? "allow" : "deny"}`}>{g.status}</span>
                <span className="small">{g.description}</span>
                <span className="muted small">#{g.id} · {g.yes} yes · {g.no} no</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================== agents

function Meter({ a, frozen, label }: { a: AgentView; frozen?: boolean; label?: boolean }) {
  const pct = a.capUsd > 0 ? Math.min(100, (a.spentTodayUsd / a.capUsd) * 100) : 0;
  const cls = pct >= 90 ? "high" : pct >= 60 ? "mid" : "";
  return (
    <div className="meter">
      <div className="row"><span>{label ? a.name : "spent today"}</span><span>{usd(a.spentTodayUsd)} / {usd(a.capUsd)}</span></div>
      <div className="track"><div className={`fill ${cls}`} style={{ width: `${frozen ? 0 : pct}%` }} /></div>
    </div>
  );
}

function TokenReveal({ token, agent, onDone }: { token: string; agent: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="card reveal-token rise">
      <div className="hd"><h2>Token for {agent}</h2><span className="sub warn-text">shown once</span></div>
      <div className="pad stack">
        <p className="muted">Give this to the agent's runtime as <span className="mono">KARUNA_AGENT_TOKEN</span>. It only lets the agent <b>propose</b>, and only once Dharma has added the agent. Karuna stores just its hash, so copy it now.</p>
        <div className="token-row">
          <code className="token">{token}</code>
          <button className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(token); setCopied(true); }}>{copied ? "copied" : "copy"}</button>
        </div>
        <pre className="snippet">{`import { KarunaAgent } from "@prekaruna/agents";

const karuna = new KarunaAgent({
  gatekeeperUrl: "${AGENT_API}",
  token: process.env.KARUNA_AGENT_TOKEN!,
});

const r = await karuna.buy(serviceUrl, { maxUsd: 0.01, reason: "why" });
if (r.status === "pending") await karuna.wait(r.id); // a human decides`}</pre>
        <button className="btn btn-dark" onClick={onDone}>I've stored the token</button>
      </div>
    </div>
  );
}

function Agents({ ctx }: { ctx: Ctx }) {
  const { s, run, busy } = ctx;
  const pol = s.policy!;
  const [form, setForm] = useState({ name: "", cap: "1" });
  const [reveal, setReveal] = useState<{ token: string; agent: string } | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});

  const add = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ id: string; token: string }>("/agents/prepare", { name: form.name });
      await submitChange(ctx.me, s.org.dharma!.address as Address, { kind: Kind.Propose, change: { op: "SetAgent", id: r.id, capUsd: Number(form.cap) } });
      setReveal({ token: r.token, agent: form.name });
      setForm({ name: "", cap: "1" });
    }, `Proposed on Dharma — the agent works after ${pol.required} vote${pol.required > 1 ? "s" : ""} and ${pol.timelock}s`);
  };

  return (
    <div className="stack">
      {reveal && <TokenReveal {...reveal} onDone={() => setReveal(null)} />}
      <form className="card inline-form" onSubmit={add}>
        <label className="field grow"><span>Agent name</span><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Accounts payable agent" /></label>
        <label className="field"><span>Daily allowance (USD)</span><input required type="number" min="0" step="0.000001" value={form.cap} onChange={(e) => setForm({ ...form, cap: e.target.value })} /></label>
        <button className="btn btn-dark" type="submit" disabled={busy}>Propose agent</button>
      </form>
      <p className="section-title">Adding an agent, removing one, or changing its allowance goes to a team vote.</p>
      {pol.agents.length === 0 ? (
        <div className="card"><div className="empty">No agents yet.</div></div>
      ) : (
        <div className="grid2">
          {pol.agents.map((a, i) => {
            const ed = editing[a.id];
            return (
              <div className={`agent rise ${s.frozen || !a.active ? "frozen" : ""}`} style={st(i)} key={a.id}>
                <div className="top">
                  <span className="emoji">◉</span>
                  <div><div className="name">{a.name}</div><div className="job mono">{a.id}</div></div>
                  <span className={`state ${!a.active ? "frozen" : s.frozen ? "frozen" : "active"}`}>{!a.active ? "awaiting vote" : s.frozen ? "frozen" : "active"}</span>
                </div>
                {a.active && <Meter a={a} frozen={!!s.frozen} />}
                {a.active && (
                  <div className="meta">
                    {ed === undefined ? (
                      <span className="tag link" onClick={() => setEditing({ ...editing, [a.id]: String(a.capUsd) })}>cap {usd(a.capUsd)}/day ✎</span>
                    ) : (
                      <form className="cap-edit" onSubmit={(e) => { e.preventDefault(); ctx.change({ op: "SetAgent", id: a.id, capUsd: Number(ed) }).then((ok) => ok && setEditing(({ [a.id]: _, ...rest }) => rest)); }}>
                        <input autoFocus type="number" min="0" step="0.000001" value={ed} onChange={(e) => setEditing({ ...editing, [a.id]: e.target.value })} />
                        <button className="btn btn-ghost btn-sm" disabled={busy}>propose</button>
                      </form>
                    )}
                    <span className="tag">{a.hasToken ? "token issued" : "no token"}</span>
                    {(() => {
                      const n = s.shield.autoRules.filter((r) => r.active && r.agent === a.id).length;
                      return n ? <span className="tag warn-tag">{n} auto-rule{n > 1 ? "s" : ""}</span> : null;
                    })()}
                  </div>
                )}
                <div className="agent-actions">
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(async () => { const r = await api<{ token: string }>(`/agents/${a.id}/rotate-token`, {}); setReveal({ token: r.token, agent: a.name }); })}>{a.hasToken ? "Rotate token" : "Issue token"}</button>
                  {a.active && <button className="btn btn-deny btn-sm" disabled={busy} onClick={() => confirm(`Remove ${a.name} from Dharma? This applies immediately.`) && ctx.change({ op: "RemoveAgent", id: a.id })}>Remove</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================== payees

function Payees({ ctx }: { ctx: Ctx }) {
  const { s, busy } = ctx;
  const pol = s.policy!;
  const [form, setForm] = useState({ account: "", name: "", category: "" });
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!isAddr(form.account)) return ctx.run(async () => { throw new Error("Payout address must be a 0x… address"); });
    ctx.change({ op: "SetPayee", account: form.account as Address, category: form.category.trim().toLowerCase() }, form.name).then((ok) => ok && setForm({ account: "", name: "", category: "" }));
  };
  return (
    <div className="stack">
      <form className="card inline-form" onSubmit={add}>
        <label className="field"><span>Name (private)</span><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Supplier or service" /></label>
        <label className="field grow"><span>Payout address</span><input required className="mono" value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value.trim() })} placeholder="0x…" /></label>
        <label className="field"><span>Category</span><input required value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="e.g. data, utilities" /></label>
        <button className="btn btn-dark" type="submit" disabled={busy}>Propose payee</button>
      </form>
      <p className="section-title">Payments to any address not on Dharma's list are denied. Adding or removing a payee goes to a team vote.</p>
      <div className="card">
        <div className="hd"><h2>Known payees</h2><span className="sub">{pol.payees.length} onchain</span></div>
        {pol.payees.length === 0 ? (
          <div className="empty">No payees yet, so every payment is denied.</div>
        ) : (
          <div className="table">
            {pol.payees.map((r) => (
              <div className="tr" key={r.account}>
                <span className="b">{r.name ?? "Unnamed"}</span>
                <span className="mono small">{r.account}</span>
                <span className="tag">{r.category}</span>
                <button className="btn btn-deny btn-sm" disabled={busy} onClick={() => ctx.change({ op: "RemovePayee", account: r.account as Address })}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================== policy

function Policy({ ctx }: { ctx: Ctx }) {
  const { s, busy } = ctx;
  const pol = s.policy!;
  const [meta, setMeta] = useState<Rule[]>([]);
  const [domain, setDomain] = useState("");
  const [threshold, setThreshold] = useState(String(pol.thresholdUsd));
  const [rule, setRule] = useState({ outcome: "Deny" as "Deny" | "Approval", agent: "", category: "", payee: "" });
  useEffect(() => {
    api<Rule[]>("/policy").then(setMeta).catch(() => undefined);
  }, []);
  const desc = (id: string) => meta.find((m) => m.id === id)?.description;

  const addRule = (e: FormEvent) => {
    e.preventDefault();
    const scope = rule.category ? `payment:${rule.category.trim().toLowerCase()}` : "payment";
    const id = `rule-${Date.now().toString(36)}`;
    ctx.change({ op: "AddRule", id, outcome: rule.outcome, agent: rule.agent || undefined, scope, target: rule.payee || "" });
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="hd"><h2>Rules on Dharma</h2><span className="sub">first match decides · core boundaries can never be removed</span></div>
        <div className="policy">
          {pol.rules.map((r, i) => (
            <div className={`p ${r.active ? "" : "off"}`} key={r.id}>
              <span className="i">{i + 1}</span>
              <span className="nm">
                {r.id}{r.core && <span className="lock" title="Core boundary — can never be removed">🔒 core</span>}
                <span className="desc"> — {r.builtin ? desc(r.id) ?? "" : `${r.scope}${r.target ? ` → ${r.target}` : ""}${r.agent ? ` · ${r.agent}` : " · every agent"}`}</span>
              </span>
              <span className="rule-actions">
                <span className={`o ${r.outcome}`}>{r.active ? r.outcome : "removed"}</span>
                {!r.core && r.active && (
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => ctx.change({ op: "RemoveRule", id: r.id })}>{r.outcome === "allow" ? "remove" : "propose removal"}</button>
                )}
                {!r.core && !r.active && r.builtin && (
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => ctx.change({ op: "AddRule", id: r.id, outcome: "Deny" })}>{"propose re-enable"}</button>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      <form className="card inline-form" onSubmit={addRule}>
        <label className="field"><span>New rule</span>
          <select value={rule.outcome} onChange={(e) => setRule({ ...rule, outcome: e.target.value as "Deny" | "Approval" })}>
            <option value="Deny">Block payments</option>
            <option value="Approval">Require approval for payments</option>
          </select>
        </label>
        <label className="field"><span>Agent</span>
          <select value={rule.agent} onChange={(e) => setRule({ ...rule, agent: e.target.value })}>
            <option value="">Every agent</option>
            {pol.agents.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Category (optional)</span><input value={rule.category} onChange={(e) => setRule({ ...rule, category: e.target.value })} placeholder="e.g. data" /></label>
        <label className="field grow"><span>Payee (optional)</span>
          <select value={rule.payee} onChange={(e) => setRule({ ...rule, payee: e.target.value })}>
            <option value="">Any payee</option>
            {pol.payees.map((p) => <option key={p.account} value={p.account}>{p.name ?? short(p.account)}</option>)}
          </select>
        </label>
        <button className="btn btn-dark" disabled={busy}>Propose rule</button>
      </form>

      <div className="grid2">
        <div className="card">
          <div className="hd"><h2>Allowlisted domains</h2></div>
          <div className="pad stack">
            <div className="pills">
              {pol.domains.map((d) => (<span className="pill" key={d}>{d} <a className="x" title="Propose removing this domain" onClick={() => !busy && ctx.change({ op: "RemoveDomain", domain: d })}>×</a></span>))}
              {pol.domains.length === 0 && <span className="muted">None — all HTTP is denied.</span>}
            </div>
            <form className="row-form" onSubmit={(e) => { e.preventDefault(); ctx.change({ op: "AddDomain", domain: domain.trim().toLowerCase() }).then((ok) => ok && setDomain("")); }}>
              <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" required />
              <button className="btn btn-ghost btn-sm" disabled={busy}>Propose</button>
            </form>
          </div>
        </div>
        <div className="card">
          <div className="hd"><h2>Two-person approval</h2></div>
          <div className="pad stack">
            <p className="muted">Payments at or above this need two members' signatures{pol.members.length < 2 ? " (once there are two members)" : ""}. Changing it goes to a team vote.</p>
            <form className="row-form" onSubmit={(e) => { e.preventDefault(); ctx.change({ op: "SetThreshold", usd: Number(threshold) }); }}>
              <span className="mono">$</span>
              <input type="number" min="0" step="0.01" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
              <button className="btn btn-ghost btn-sm" disabled={busy}>Propose</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================== signed log

function Activity({ ctx, log }: { ctx: Ctx; log: LogEntry[] }) {
  const { s } = ctx;
  const [filter, setFilter] = useState<"all" | "decisions" | "events" | "on Arc">("all");
  const onArc = (e: LogEntry) => !!e.event && isTx((e.event as Record<string, unknown>).txRef);
  const shown = useMemo(() => log.filter((e) => filter === "all" || (filter === "on Arc" ? onArc(e) : filter === "decisions" ? !!e.decision : !!e.event)), [log, filter]);
  const who = (id: unknown) => {
    const v = String(id ?? "");
    return v.startsWith("0x") ? ctx.name(v) : s.policy!.agents.find((a) => a.id === v)?.name ?? v;
  };
  const anchored = s.policy!.anchor.length;
  return (
    <div className="card">
      <div className="hd">
        <h2>Everything that happened</h2>
        <span className="sub filters">{(["all", "decisions", "events", "on Arc"] as const).map((k) => <span key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{k}</span>)}</span>
      </div>
      {shown.length === 0 ? (
        <div className="empty">The log is empty.</div>
      ) : (
        <div className="gk">
          {shown.map((e) => {
            const anchoredMark = e.seq < anchored ? <span title="Anchored on Dharma">⚓</span> : null;
            if (e.decision) {
              const o = e.decision.outcome;
              const r = e.request!;
              const what = r.tool === "payment" ? `${r.paymentKind ?? "payment"} ${r.amountUsd != null ? usd(r.amountUsd) : ""} → ${short(r.to)}` : r.command ?? (r.url ? `${r.method ?? "GET"} ${r.url}` : r.path ?? r.tool);
              return (
                <div className="item" key={e.seq}>
                  <span className="caret">{e.seq}</span>
                  <span className="tool">{r.tool}</span>
                  <span className={`act ${o === "deny" ? "denied" : ""}`}><span className="ag">{who(r.agent)} ·</span> {what}</span>
                  <span className={`chip ${o}`}><span className="g">{GLYPH[o]}</span>{o === "approval" ? "require approval" : o}</span>
                  <span className="pol">{e.decision.ruleId}</span>
                  <span className="log">{anchoredMark} {e.hash.slice(0, 4)}…{e.hash.slice(-4)}</span>
                </div>
              );
            }
            const ev = e.event!;
            const detail = Object.entries(ev).filter(([k]) => k !== "type" && k !== "txRef").map(([k, v]) => `${k}=${k === "by" ? who(v) : typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("  ");
            return (
              <div className="item event" key={e.seq}>
                <span className="caret">{e.seq}</span>
                <span className="tool">event</span>
                <span className="act"><b>{ev.type}</b> <span className="ag">{detail}</span></span>
                <span><TxLink tx={(ev as Record<string, unknown>).txRef} s={s} /></span>
                <span className="pol">{ago(e.timestamp)}</span>
                <span className="log">{anchoredMark} {e.hash.slice(0, 4)}…{e.hash.slice(-4)}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="log-foot">
        <span><span className="sigdot" /> {s.log.length} entries · ed25519-signed &amp; hash-chained · {s.log.verified ? "verified" : `TAMPERED at ${s.log.brokenAt}`} · ⚓ {anchored} anchored on Dharma</span>
        <span>head {short(s.log.head)}</span>
      </div>
    </div>
  );
}

// ============================================================== team

function Team({ ctx }: { ctx: Ctx }) {
  const { s, me, busy } = ctx;
  const pol = s.policy!;
  const myAddr = me.address.toLowerCase();
  return (
    <div className="stack">
      {s.enrollments.length > 0 && (
        <div className="card rise">
          <div className="hd"><h2>Access requests</h2><span className="sub">{s.enrollments.length}</span></div>
          <div className="table">
            {s.enrollments.map((e) => {
              const proposed = pol.proposals.some((g) => g.change?.op === "AddMember" && String(g.change.member).toLowerCase() === e.address && (g.status === "open" || g.status === "queued"));
              return (
                <div className="tr" key={e.address}>
                  <span className="av">{e.name[0]?.toUpperCase()}</span>
                  <span className="b">{e.name}</span>
                  <span className="mono small">{e.address}</span>
                  <button className="btn btn-dark btn-sm" disabled={busy || proposed} onClick={() => ctx.change({ op: "AddMember", member: e.address as Address }, e.name)}>{proposed ? "proposed" : "Propose adding"}</button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <p className="section-title">Members sign approvals, votes, and the panic button with keys in their own browsers. Adding or removing a member is a loosening: {pol.required} vote{pol.required > 1 ? "s" : ""} and a {pol.timelock}s wait. To add someone, have them open this console in their own browser and ask to join.</p>
      <div className="card">
        <div className="hd"><h2>Members on Dharma</h2><span className="sub">{pol.members.length}</span></div>
        <div className="table">
          {pol.members.map((m) => (
            <div className="tr" key={m.address}>
              <span className="av">{(m.name ?? "?")[0]?.toUpperCase()}</span>
              <span className="b">{m.name ?? "Unnamed"}{m.address === myAddr ? <span className="muted"> (this browser)</span> : ""}</span>
              <span className="mono small">{m.address}</span>
              <button className="btn btn-deny btn-sm" disabled={busy || pol.members.length <= 1} onClick={() => ctx.change({ op: "RemoveMember", member: m.address as Address })}>Propose removal</button>
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="hd"><h2>Gatekeeper wallet</h2></div>
        <div className="pad">
          <div className="mono">{s.org.wallet?.address}</div>
          <div className="muted small">{s.org.wallet?.chain} · pays for services and relays Dharma transactions · agents never see it · it can tighten Dharma but never loosen it</div>
        </div>
      </div>
    </div>
  );
}

// ============================================================== live alerts

interface Alert {
  id: string;
  title: string;
  body: string;
  tone: "warn" | "bad" | "ok" | "info";
  sticky: boolean;
  go?: View;
  cta?: string;
  source: ChainEvent["source"];
  at: number;
}

function toAlert(e: ChainEvent, s: Snapshot, name: (a?: string | null) => string): Omit<Alert, "at"> | null {
  const a = e.args;
  const pol = s.policy;
  const agentName = (id: unknown) => pol?.agents.find((x) => x.id === id)?.name ?? String(id ?? "an agent");
  const gov = (id: unknown) => pol?.proposals.find((g) => String(g.id) === String(id));
  const base = { id: e.id, source: e.source };
  switch (e.event) {
    case "ApprovalRequested": {
      const p = s.proposals.find((x) => keccak256(stringToHex(x.id)) === String(a.requestId));
      const who = p?.facts.find((f) => f.label === "Recipient" || f.label === "Seller")?.value;
      return { ...base, tone: "warn", sticky: true, go: "approvals", cta: "Review", title: "Approval needed",
        body: `${agentName(a.agent)} wants to pay $${Number(a.amountUsd).toFixed(2)}${who ? ` to ${who}` : ""}` };
    }
    case "AgentFrozen":
      if (s.frozen && s.frozen.by === "Swarm Stopper")
        return { ...base, tone: "bad", sticky: true, go: "swarm", cta: "Swarm Stopper", title: "Swarm freeze recorded on Dharma", body: "Swarm Stopper froze every agent. Unfreezing needs a member vote." };
      return { ...base, tone: "bad", sticky: true, title: "All agents frozen", body: `${name(String(a.by))} hit the panic button. Recorded on Dharma.` };
    case "AgentsUnfrozen":
      return { ...base, tone: "ok", sticky: false, title: "Agents unfrozen", body: "The vote passed and the timelock ended." };
    case "ProposalCreated": {
      // The event carries the change itself, so describe it even before the proposal list refreshes.
      let what = gov(a.id)?.description;
      if (!what) {
        try {
          what = describeChange(decodeChange(Number(a.op), a.data as `0x${string}`), {
            member: (x) => pol?.members.find((m) => m.address === x)?.name ?? undefined,
            agent: (id) => pol?.agents.find((g) => g.id === id)?.name,
            payee: (x) => pol?.payees.find((p) => p.account === x)?.name ?? undefined,
          });
        } catch {
          what = "a policy change";
        }
      }
      return { ...base, tone: "info", sticky: true, go: "dharma", cta: "Vote", title: `New Dharma proposal #${a.id}`, body: `${name(String(a.proposer))}: ${what}` };
    }
    case "VoteCast":
      return { ...base, tone: "info", sticky: false, title: `Vote on #${a.id}`, body: `${name(String(a.voter))} voted ${a.support ? "yes" : "no"} (${a.yes} yes · ${a.no} no)` };
    case "ProposalQueued":
      return { ...base, tone: "ok", sticky: false, go: "dharma", title: `Proposal #${a.id} passed`, body: "Takes effect after the timelock." };
    case "ProposalExecuted":
      return { ...base, tone: "ok", sticky: false, title: `Proposal #${a.id} is in effect`, body: gov(a.id)?.description ?? "Policy updated." };
    case "ProposalDefeated":
      return { ...base, tone: "info", sticky: false, title: `Proposal #${a.id} defeated`, body: gov(a.id)?.description ?? "" };
    case "RuleAdded":
      return { ...base, tone: "info", sticky: false, title: "Rule added", body: `${String(a.id)} — in effect now` };
    case "TestFailed":
      return { ...base, tone: "bad", sticky: true, title: "Agent failed a scam test", body: `${agentName(a.agent)} · ${String(a.category)} payments are now blocked for it.` };
    default:
      return null; // anchors, payee/domain changes etc. update the screen without a pop-up
  }
}

function LiveBadge({ mode }: { mode: LiveMode }) {
  const label = mode === "quicknode" ? "QuickNode live" : mode === "rpc" ? "Arc RPC (fallback)" : mode === "connecting" ? "connecting…" : "relay offline";
  return <span className={`live ${mode}`} title="Where live chain events come from"><span className="d" /> {label}</span>;
}

// ============================================================== Auto-Shield

function Shield({ ctx, part }: { ctx: Ctx; part: "tests" | "messages" }) {
  const { s, busy, run } = ctx;
  const pol = s.policy!;
  const active = pol.agents.filter((a) => a.active);
  const categories = [...new Set(pol.payees.map((p) => p.category))];
  const [test, setTest] = useState({ agentId: "", template: "", category: "" });
  const [msg, setMsg] = useState({ agentId: "", from: "", subject: "", body: "" });
  const agentName = (id: string | null) => (id ? pol.agents.find((a) => a.id === id)?.name ?? id : "every agent");
  const tests = s.shield.tests;
  const stats = (id: string) => {
    const t = tests.filter((x) => x.agentId === id);
    return { sent: t.length, passed: t.filter((x) => x.status === "passed").length, failed: t.filter((x) => x.status === "failed").length };
  };

  const runTest = (e: FormEvent) => {
    e.preventDefault();
    run(() => api("/shield/test", { agentId: test.agentId || active[0]?.id, template: test.template || undefined, category: test.category || undefined }),
      "Test sent. It looks exactly like a real message to the agent.");
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    run(() => api("/inbox", { ...msg, agentId: msg.agentId || active[0]?.id }), "Message delivered to the agent's inbox").then((ok) => ok && setMsg({ ...msg, subject: "", body: "" }));
  };

  if (part === "messages") {
    return (
      <div className="stack">
          <form className="card" onSubmit={send}>
            <div className="hd"><h2>Send a message to an agent</h2></div>
            <div className="pad stack">
              <p className="muted small">Give an agent work, the way a supplier or teammate would: an invoice for the Bills agent, a data request for the Supplies agent.</p>
              <div className="row-form">
                <select value={msg.agentId} onChange={(e) => setMsg({ ...msg, agentId: e.target.value })}>
                  {active.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <input required value={msg.from} onChange={(e) => setMsg({ ...msg, from: e.target.value })} placeholder="From (e.g. a supplier)" />
              </div>
              <input className="plain-input" required value={msg.subject} onChange={(e) => setMsg({ ...msg, subject: e.target.value })} placeholder="Subject" />
              <textarea required rows={3} value={msg.body} onChange={(e) => setMsg({ ...msg, body: e.target.value })} placeholder="Invoice text, payment details…" />
              <button className="btn btn-ghost" disabled={busy || !active.length}>Deliver</button>
            </div>
          </form>
      <div className="card">
        <div className="hd"><h2>Inboxes</h2><span className="sub">what agents received</span></div>
        {s.inbox.length === 0 ? <div className="empty">No messages yet.</div> : (
          <div className="resolved">
            {s.inbox.slice(0, 20).map((m) => (
              <div className="res" key={m.id}>
                <span className={`chip ${m.test ? (m.test.status === "failed" ? "deny" : m.test.status === "passed" ? "allow" : "approval") : ""}`}>{m.test ? "test" : "real"}</span>
                <span className="small"><b>{m.subject}</b> <span className="muted">from {m.from} → {agentName(m.agentId)}</span></span>
                <span className="muted small">{m.reportedAt ? "flagged by agent · " : ""}{ago(m.receivedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card rise">
        <div className="pad stack">
          <p>Karuna sends your agents fake scam messages{s.shield.testsPerDay ? ` (about ${s.shield.testsPerDay} per agent per day)` : ""}. An agent that falls for one can't pay that category until you restore it below. You only need this page when an agent is blocked.</p>
        </div>
      </div>

      {active.length > 0 && (
        <div className="grid-tiles">
          {active.map((a, i) => {
            const st2 = stats(a.id);
            const rules = s.shield.autoRules.filter((r) => r.active && r.agent === a.id);
            return (
              <div className="tile rise" style={st(i)} key={a.id}>
                <div className="k">{a.name}</div>
                <div className="v small-v">{st2.passed} passed · <span className={st2.failed ? "bad-text" : ""}>{st2.failed} failed</span></div>
                <div className="small muted">{st2.sent} tests · {rules.length} auto-rule{rules.length === 1 ? "" : "s"}</div>
              </div>
            );
          })}
        </div>
      )}

      <div className="card">
        <div className="hd"><h2>Auto-blocks on Dharma</h2><span className="sub">{s.shield.autoRules.filter((r) => r.active).length} active</span></div>
        {s.shield.autoRules.filter((r) => r.active).length === 0 ? (
          <div className="empty">No agent is blocked. When one falls for a test, its block appears here.</div>
        ) : (
          <div className="table">
            {s.shield.autoRules.filter((r) => r.active).map((r) => {
              const removing = pol.proposals.some((g) => g.change?.op === "RemoveRule" && g.change.id === r.id && (g.status === "open" || g.status === "queued"));
              const approvalId = r.id.replace(/^sh-/, "ap-");
              const hasApproval = pol.rules.some((x) => x.id === approvalId && x.active);
              return (
                <div className="tr shield-tr" key={r.id}>
                  <span className="b">{agentName(r.agent)} can't pay for <b>{r.category}</b></span>
                  <span className="mono small muted">{r.id}</span>
                  <span className="shield-actions">
                    {removing ? (
                      <span className="tag">restore proposed → vote on Dharma</span>
                    ) : (
                      <>
                        <button className="btn btn-ghost btn-sm" disabled={busy || hasApproval}
                          title="Proposes two changes for a vote: send this agent's payments in this category to a human, and lift the block"
                          onClick={async () => {
                            const ok = await ctx.change({ op: "AddRule", id: approvalId, outcome: "Approval", agent: r.agent ?? undefined, scope: `payment:${r.category}` });
                            if (ok) await ctx.change({ op: "RemoveRule", id: r.id });
                          }}>
                          Restore with approval required
                        </button>
                        <button className="btn btn-dark btn-sm" disabled={busy} onClick={() => ctx.change({ op: "RemoveRule", id: r.id })}>Propose restore</button>
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <div className="log-foot"><span>lifting a block is a loosening: {pol.required} vote{pol.required > 1 ? "s" : ""} + {pol.timelock}s</span><span>Auto-Shield's own blocks apply instantly</span></div>
      </div>

      <div>
        <form className="card" onSubmit={runTest}>
          <div className="hd"><h2>Run a scam test now</h2></div>
          <div className="pad stack">
            <label className="field"><span>Agent</span>
              <select value={test.agentId} onChange={(e) => setTest({ ...test, agentId: e.target.value })}>
                {active.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Scam</span>
              <select value={test.template} onChange={(e) => setTest({ ...test, template: e.target.value })}>
                <option value="">Random</option>
                {Object.entries(s.shield.templates).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="field"><span>Category it pretends to be</span>
              <input list="shield-cats" value={test.category} onChange={(e) => setTest({ ...test, category: e.target.value })} placeholder={categories[0] ?? "supplies"} />
              <datalist id="shield-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
            </label>
            <button className="btn btn-dark" disabled={busy || !active.length}>Send test</button>
          </div>
        </form>


      </div>

      <div className="card">
        <div className="hd"><h2>Tests</h2><span className="sub">only humans can see which messages were tests</span></div>
        {tests.length === 0 ? <div className="empty">No tests yet.</div> : (
          <div className="resolved">
            {tests.slice(0, 20).map((t) => (
              <div className="res" key={t.id}>
                <span className={`chip ${t.status === "failed" ? "deny" : t.status === "passed" ? "allow" : "approval"}`}>{t.status}</span>
                <span className="small">{agentName(t.agentId)} · {s.shield.templates[t.template] ?? t.template} · {t.category}</span>
                <span className="muted small">{t.resolution ? `${t.resolution} · ` : ""}{ago(t.sentAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}

// ============================================================== Swarm Stopper + Trap Passwords

function Swarm({ ctx }: { ctx: Ctx }) {
  const { s, busy, run } = ctx;
  const pol = s.policy!;
  const sw = s.swarm;
  const active = pol.agents.filter((a) => a.active);
  const [target, setTarget] = useState("");
  const [plantTo, setPlantTo] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<string | null>(null);
  const agentName = (id: string) => pol.agents.find((a) => a.id === id)?.name ?? id;

  return (
    <div className="stack">
      <div className="card rise">
        <div className="pad stack">
          <p>Agents never get real passwords, so any password an agent uses is bait. If an agent shares one, or {sw.agentsToTrip} agents go after the same new target within {sw.windowSeconds}s, <b>every agent freezes</b>. Unfreeze from the top bar (needs a vote).</p>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="hd"><h2>Swarm trips</h2><span className="sub">{sw.trips.length}</span></div>
          {sw.trips.length === 0 ? <div className="empty">No swarm detected.</div> : (
            <div className="resolved">
              {sw.trips.map((t) => (
                <div className="res" key={t.id}>
                  <span className="chip deny">froze all</span>
                  <span className="small">{t.reason} <span className="muted">· {t.agents.map(agentName).join(", ")}</span></span>
                  <span className="muted small">
                    {t.txRef && s.org.dharma ? <a href={`${s.org.dharma.explorer.replace(/\/address\/.*$/, "")}/tx/${t.txRef}`} target="_blank" rel="noreferrer">onchain ↗</a> : "local"} · {ago(t.at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <div className="hd"><h2>Agents that touched a trap</h2><span className="sub">{sw.tainted.length}</span></div>
          {sw.tainted.length === 0 ? <div className="empty">None. Any agent that uses a trap credential shows up here.</div> : (
            <div className="resolved">
              {sw.tainted.map((t) => (
                <div className="res" key={t.agentId}>
                  <span className="chip deny">marked</span>
                  <span className="small"><b>{t.agentName}</b> used <span className="mono">{t.secret}</span></span>
                  <span className="muted small">{ago(t.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="hd"><h2>Trap credentials</h2><span className="sub">fake keys that work nowhere and are watched everywhere</span></div>
        <form className="pad row-form" onSubmit={(e) => { e.preventDefault(); run(() => api("/traps", { agentId: target || undefined }), "Trap credentials minted. Plant them where the agent can find them."); }}>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">For every agent</option>
            {active.map((a) => <option key={a.id} value={a.id}>For {a.name}</option>)}
          </select>
          <button className="btn btn-dark" disabled={busy}>Mint trap set</button>
        </form>
        {sw.traps.length === 0 ? <div className="empty">No traps yet.</div> : (
          <div className="table">
            {sw.traps.map((t) => {
              const to = plantTo[t.id] ?? t.agentId ?? active[0]?.id ?? "";
              return (
                <div className="tr stack" key={t.id}>
                  <div className="row-between">
                    <span className="small"><b>{t.secrets.map((x) => x.name).join(", ")}</b> <span className="muted">· {t.agentName ?? "every agent"} · {ago(t.createdAt)}</span></span>
                    <span className="shield-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => setShown(shown === t.id ? null : t.id)}>{shown === t.id ? "Hide" : "Show .env"}</button>
                      <select value={to} onChange={(e) => setPlantTo({ ...plantTo, [t.id]: e.target.value })}>
                        {active.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                      <button className="btn btn-dark btn-sm" disabled={busy || !to}
                        title="Delivers an IT-helpdesk email to the agent that 'accidentally' contains these credentials"
                        onClick={() => run(() => api(`/traps/${t.id}/plant`, { agentId: to }), "Planted: a 'leaked credentials' email is in the agent's inbox")}>
                        Leak into inbox
                      </button>
                    </span>
                  </div>
                  {shown === t.id && <pre className="snippet">{t.envFile}</pre>}
                </div>
              );
            })}
          </div>
        )}
        <div className="log-foot"><span>drop the .env into the agent's workspace, or leak it by email</span><span>real keys stay with the Gatekeeper</span></div>
      </div>
    </div>
  );
}

// ============================================================== Learns From Your Choices + Preview

function Learned({ ctx }: { ctx: Ctx }) {
  const { s, busy } = ctx;
  const L = s.learned;
  const proposing = (id: string) => s.policy!.proposals.some((g) => g.change?.id === id && (g.status === "open" || g.status === "queued"));
  const who = (name: string | null, addr: string) => name ?? short(addr);
  if (!L.precedents.length && !L.blocks.length && !L.allows.length) return null;
  return (
    <div className="card">
      <div className="hd"><h2>Learned from your choices</h2><span className="sub">a "no" is learned at once · a "yes" only after {L.suggestAfter} approvals and a vote</span></div>
      {L.suggestions.map((x) => (
        <div className="tr learn-tr" key={x.id}>
          <span className="chip approval">suggestion</span>
          <span className="small">You approved <b>{x.agentName}</b> → <b>{who(x.counterpartyName, x.counterparty)}</b> {x.approvals} times. Auto-approve it {x.bandLabel} from now on?</span>
          {proposing(x.id) ? <span className="tag">proposed → vote on Dharma</span> : (
            <button className="btn btn-dark btn-sm" disabled={busy} onClick={() => ctx.change(x.change as unknown as Change)}>Propose rule</button>
          )}
        </div>
      ))}
      {L.blocks.map((b) => (
        <div className="tr learn-tr" key={b.id}>
          <span className="chip deny">learned block</span>
          <span className="small"><b>{b.agentName ?? "Every agent"}</b> can't pay <b>{who(b.targetName, b.target)}</b> <span className="muted">(a member said no)</span></span>
          {proposing(b.id) ? <span className="tag">lift proposed → vote</span> : (
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => ctx.change({ op: "RemoveRule", id: b.id })}>Propose lifting</button>
          )}
        </div>
      ))}
      {L.allows.map((b) => (
        <div className="tr learn-tr" key={b.id}>
          <span className="chip allow">learned rule</span>
          <span className="small"><b>{b.agentName ?? "Every agent"}</b> pays <b>{who(b.targetName, b.target)}</b> up to {usd(b.maxUsd)} without asking</span>
          <button className="btn btn-ghost btn-sm" disabled={busy} title="Proposes revoking this rule (team vote)" onClick={() => ctx.change({ op: "RemoveRule", id: b.id })}>Propose revoking</button>
        </div>
      ))}
      {L.precedents.length > 0 && (
        <div className="resolved">
          {L.precedents.slice(0, 8).map((x) => (
            <div className="res" key={x.id}>
              <span className={`chip ${x.outcome === "approve" ? "allow" : "deny"}`}>{x.outcome === "approve" ? "yes" : "no"}</span>
              <span className="small">{x.agentName} → {who(x.counterpartyName, x.counterparty)} · {usd(x.amountUsd)} ({x.bandLabel})</span>
              <span className="muted small">{x.byName} · {ago(x.at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PreviewBox({ p, ctx }: { p: LooseningPreview; ctx: Ctx }) {
  const pol = ctx.s.policy!;
  const agentName = (id: string) => pol.agents.find((a) => a.id === id)?.name ?? id;
  const payee = (a: string | null) => (a ? pol.payees.find((x) => x.account === a.toLowerCase())?.name ?? short(a) : "—");
  const bad = p.flaggedAllowed > 0;
  return (
    <div className={`preview ${bad ? "preview-bad" : ""}`}>
      <div className="small">
        <b>Preview:</b> replaying the last {p.days} days ({p.replayed} requests) under this change,{" "}
        {p.newlyAllowed.length === 0 ? "nothing more would have got through." : <>
          <b>{p.newlyAllowed.length} more</b> would have got through
          {" "}({p.newlyAllowed.filter((x) => x.now === "allow").length} automatically, {p.newlyAllowed.filter((x) => x.now === "approval").length} to an approval card instead of a block)
          {bad ? <>, including <b className="bad-text">{p.flaggedAllowed} Karuna flagged as a scam</b></> : null}.</>}
        {p.newlyBlocked > 0 ? ` ${p.newlyBlocked} would now be blocked.` : ""}
      </div>
      {p.newlyAllowed.slice(0, 5).map((x) => (
        <div className="small mono muted" key={x.proposalId}>
          {agentName(x.agent)} → {payee(x.to)}{x.amountUsd != null ? ` ${usd(x.amountUsd)}` : ""} · {x.was} → {x.now}{x.flagged ? <span className="bad-text"> · flagged: {x.flagged}</span> : null} · {ago(x.at)}
        </div>
      ))}
    </div>
  );
}
