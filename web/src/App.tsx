import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { api, useGatekeeper, type Agent, type LogEntry, type Proposal, type Rule, type Snapshot, type WalletInfo } from "./api.ts";

type View = "overview" | "approvals" | "agents" | "payees" | "policy" | "activity" | "team";
const TITLES: Record<View, string> = {
  overview: "Overview", approvals: "Approvals", agents: "Agents", payees: "Payees & services",
  policy: "Policy", activity: "Signed log", team: "Team",
};
const ICON: Record<View, string> = { overview: "▦", approvals: "◷", agents: "◉", payees: "⇄", policy: "☰", activity: "≋", team: "☺" };
const AGENT_API = "http://127.0.0.1:8787";

const usd = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(4).replace(/0+$/, "") : n.toFixed(2)}`;
const short = (s?: string | null) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "—");
const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};
const st = (i: number) => ({ ["--i"]: i }) as CSSProperties;
const GLYPH = { allow: "✓", deny: "✕", approval: "◷" } as const;

function describe(p: Proposal, s: Snapshot) {
  const a = p.action;
  if (a.type === "x402") return `buy ${a.method ?? "GET"} ${a.url}`;
  if (a.type === "transfer") {
    const r = s.org.recipients.find((x) => x.address === String(a.to).toLowerCase());
    return `send ${usd(Number(a.amountUsd))} → ${r?.name ?? short(a.to)}`;
  }
  return `${a.tool}: ${a.command ?? (a.url ? `${a.method ?? "GET"} ${a.url}` : a.path ?? "")}`;
}

// ============================================================== root

export default function App() {
  const gk = useGatekeeper();
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const notify = (kind: "ok" | "err", text: string) => {
    setFlash({ kind, text });
    setTimeout(() => setFlash((f) => (f?.text === text ? null : f)), 5000);
  };
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) notify("ok", ok);
      await gk.refresh();
    } catch (e) {
      notify("err", e instanceof Error ? e.message : String(e));
    }
  };

  let body: ReactNode;
  if (!gk.state && gk.offline) body = <Offline reason={gk.offline} />;
  else if (!gk.state) body = <div className="center muted">Connecting to the Gatekeeper…</div>;
  else if (!gk.state.setUp) body = <Setup run={run} />;
  else body = <Console s={gk.state} log={gk.log} wallet={gk.wallet} run={run} offline={gk.offline} />;

  return (
    <>
      {body}
      {flash && <div className={`flash ${flash.kind}`} onClick={() => setFlash(null)}>{flash.text}</div>}
    </>
  );
}

type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

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

// ============================================================== setup (first run)

function Setup({ run }: { run: Run }) {
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

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(() => api("/setup", form), "Organization created");
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
            <p className="muted">Agents propose. Karuna decides. Your team sets the rules. Start with who you are and which wallet the Gatekeeper pays from — you'll add agents, payees, and teammates next.</p>
          </div>
          <label className="field">
            <span>Organization name</span>
            <input required autoFocus value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} placeholder="Your company" />
          </label>
          <label className="field">
            <span>Your name</span>
            <input required value={form.memberName} onChange={(e) => setForm({ ...form, memberName: e.target.value })} placeholder="First approver" />
          </label>
          <label className="field">
            <span>Wallet the Gatekeeper pays from</span>
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
          <button className="btn btn-dark" type="submit">Create organization</button>
        </div>
      </form>
    </div>
  );
}

// ============================================================== console shell

function Console({ s, log, wallet, run, offline }: { s: Snapshot; log: LogEntry[]; wallet: WalletInfo | null; run: Run; offline: string | null }) {
  const [view, setView] = useState<View>(() => {
    try {
      return (localStorage.getItem("karuna.view") as View) || "overview";
    } catch {
      return "overview";
    }
  });
  const [memberId, setMemberId] = useState<string>(() => {
    try {
      return localStorage.getItem("karuna.member") ?? "";
    } catch {
      return "";
    }
  });
  const me = s.org.members.find((m) => m.id === memberId) ?? s.org.members[0];
  useEffect(() => {
    try {
      localStorage.setItem("karuna.view", view);
      localStorage.setItem("karuna.member", me.id);
    } catch {
      /* per-viewer convenience only */
    }
  }, [view, me.id]);

  const pending = s.proposals.filter((p) => p.status === "pending");
  const frozen = !!s.frozen;
  const myVote = s.unfreezeVotes.includes(me.id);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><span className="mark">⬡</span> Karuna</div>
        <div className="biz">{s.org.name}</div>
        <nav className="nav">
          {(Object.keys(TITLES) as View[]).map((v) => (
            <a key={v} className={view === v ? "sel" : ""} onClick={() => setView(v)}>
              <span className="ic">{ICON[v]}</span> {TITLES[v]}
              {v === "approvals" && pending.length > 0 && <span className="count warn">{pending.length}</span>}
            </a>
          ))}
        </nav>
        <div className="member">
          <div className="small muted mono acting">acting as</div>
          <div className="who">
            <span className="av">{me.name[0]?.toUpperCase()}</span>
            <select className="member-select" value={me.id} onChange={(e) => setMemberId(e.target.value)}>
              {s.org.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{TITLES[view]}</h1>
          <div className="right">
            <span className={`status ${frozen ? "frozen" : offline ? "frozen" : ""}`}>
              <span className="d" /> {offline ? "gatekeeper offline" : frozen ? "all agents frozen" : `${s.org.agents.length} agent${s.org.agents.length === 1 ? "" : "s"} active`}
            </span>
            {frozen ? (
              <button className="panic armed" disabled={myVote} onClick={() => run(() => api("/unfreeze-vote", { memberId: me.id }), "Vote recorded")}>
                {myVote ? `Voted · ${s.unfreezeVotes.length}/${s.unfreezeVotesNeeded}` : `Vote to unfreeze · ${s.unfreezeVotes.length}/${s.unfreezeVotesNeeded}`}
              </button>
            ) : (
              <button className="panic" onClick={() => run(() => api("/freeze", { memberId: me.id }), "Every agent is frozen")}>⬛ Panic — freeze all</button>
            )}
          </div>
        </header>

        <div className="content">
          {frozen && (
            <div className="freeze-banner">
              <b>Frozen.</b> {s.org.members.find((m) => m.id === s.frozen!.by)?.name ?? "A member"} hit the panic button {ago(s.frozen!.at)}. Every proposal is denied and no payment can execute.
              Unfreezing needs {s.unfreezeVotesNeeded} vote{s.unfreezeVotesNeeded > 1 ? "s" : ""}.
            </div>
          )}
          {view === "overview" && <Overview s={s} wallet={wallet} go={setView} />}
          {view === "approvals" && <Approvals s={s} me={me.id} run={run} />}
          {view === "agents" && <Agents s={s} me={me.id} run={run} />}
          {view === "payees" && <Payees s={s} me={me.id} run={run} />}
          {view === "policy" && <Policy s={s} me={me.id} run={run} />}
          {view === "activity" && <Activity s={s} log={log} />}
          {view === "team" && <Team s={s} me={me.id} run={run} />}
        </div>
      </main>
    </div>
  );
}

// ============================================================== overview

function Overview({ s, wallet, go }: { s: Snapshot; wallet: WalletInfo | null; go: (v: View) => void }) {
  const pending = s.proposals.filter((p) => p.status === "pending");
  const spent = s.org.agents.reduce((n, a) => n + a.spentTodayUsd, 0);
  const todays = s.proposals.filter((p) => Date.now() - Date.parse(p.createdAt) < 86_400_000);
  const blocked = todays.filter((p) => p.status === "denied").length;
  const steps = [
    { done: s.org.agents.length > 0, text: "Add an agent and give it its token", view: "agents" as View },
    { done: s.org.recipients.length > 0, text: "Add the payees and services your agents may pay", view: "payees" as View },
    { done: s.org.members.length > 1, text: "Invite a second approver (two-person approval, unfreeze votes)", view: "team" as View },
  ];
  return (
    <div className="stack">
      <div className="tiles">
        <div className="tile rise" style={st(0)}><div className="k">Waiting for you</div><div className={`v ${pending.length ? "warn" : ""}`}>{pending.length}</div></div>
        <div className="tile rise" style={st(1)}><div className="k">Wallet USDC</div><div className="v">{wallet ? Number(wallet.usdc).toFixed(2) : "…"}</div></div>
        <div className="tile rise" style={st(2)}><div className="k">Gateway balance</div><div className="v">{wallet ? (wallet.gateway ?? "—") : "…"}</div></div>
        <div className="tile rise" style={st(3)}><div className="k">Spent today</div><div className="v">{usd(spent)}</div><div className="small muted">{blocked} blocked today</div></div>
      </div>

      {steps.some((x) => !x.done) && (
        <div className="card rise" style={st(1)}>
          <div className="hd"><h2>Get started</h2><span className="sub">{steps.filter((x) => x.done).length}/{steps.length}</span></div>
          <div className="checklist">
            {steps.map((x) => (
              <a key={x.text} className={x.done ? "done" : ""} onClick={() => go(x.view)}>
                <span className="box">{x.done ? "✓" : ""}</span> {x.text}
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="grid2">
        <div className="card rise" style={st(2)}>
          <div className="hd"><h2>Waiting for you</h2><span className="sub link" onClick={() => go("approvals")}>view all →</span></div>
          {pending.length === 0 ? <div className="empty">Nothing needs approval.</div> : <Rows s={s} items={pending.slice(0, 4)} />}
        </div>
        <div className="card rise" style={st(3)}>
          <div className="hd"><h2>Agents</h2><span className="sub link" onClick={() => go("agents")}>manage →</span></div>
          {s.org.agents.length === 0 ? (
            <div className="empty">No agents yet.</div>
          ) : (
            <div className="pad stack">{s.org.agents.map((a) => <Meter key={a.id} a={a} frozen={!!s.frozen} label />)}</div>
          )}
        </div>
      </div>

      <div className="card rise" style={st(4)}>
        <div className="hd"><h2>Recent decisions</h2><span className="sub link" onClick={() => go("activity")}>signed log →</span></div>
        {s.proposals.length === 0 ? <div className="empty">No proposals yet. Decisions appear here the moment an agent asks for something.</div> : <Rows s={s} items={s.proposals.slice(0, 8)} />}
        <div className="log-foot"><span><span className="sigdot" /> {s.log.verified ? "signed · chain verified" : `TAMPERED at entry ${s.log.brokenAt}`}</span><span>head {short(s.log.head)}</span></div>
      </div>
    </div>
  );
}

function Rows({ s, items }: { s: Snapshot; items: Proposal[] }) {
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
            <span className={`act ${o === "deny" ? "denied" : ""}`}><span className="ag">{s.org.agents.find((a) => a.id === p.agentId)?.name ?? p.agentId} ·</span> {describe(p, s)}</span>
            <span className={`chip ${cls}`}><span className="g">{GLYPH[cls]}</span>{label}</span>
            <span className="pol">{p.decision.ruleId}</span>
            <span className="t">{ago(p.createdAt)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================== approvals (Facts First + Exact Match)

function Approvals({ s, me, run }: { s: Snapshot; me: string; run: Run }) {
  const pending = s.proposals.filter((p) => p.status === "pending");
  const resolved = s.proposals.filter((p) => p.decision.outcome === "approval" && p.status !== "pending").slice(0, 10);
  return (
    <div className="stack">
      <p className="section-title">Facts first — Karuna verified everything in the grey box. The agent's reason is shown separately and may not be true.</p>
      {pending.length === 0 && <div className="card"><div className="empty">Nothing is waiting for a human.</div></div>}
      {pending.map((p, i) => <div className="rise" style={st(i)} key={p.id}><ApprovalCard p={p} s={s} me={me} run={run} /></div>)}
      {resolved.length > 0 && (
        <div className="card">
          <div className="hd"><h2>Recently resolved</h2></div>
          <div className="resolved">
            {resolved.map((p) => (
              <div key={p.id} className="res">
                <span className={`chip ${p.status === "executed" || p.status === "allowed" ? "allow" : "deny"}`}>{p.status}</span>
                <span className="mono small">{describe(p, s)}</span>
                <span className="muted small">{p.resolvedBy ? `by ${s.org.members.find((m) => m.id === p.resolvedBy)?.name ?? p.resolvedBy}` : ""} {p.resolvedAt ? ago(p.resolvedAt) : ""}</span>
                {p.error && <div className="res-err">{p.error}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ p, s, me, run }: { p: Proposal; s: Snapshot; me: string; run: Run }) {
  const agent = s.org.agents.find((a) => a.id === p.agentId);
  const iApproved = p.approvals.some((a) => a.memberId === me);
  const others = p.approvals.filter((a) => a.memberId !== me).map((a) => s.org.members.find((m) => m.id === a.memberId)?.name ?? a.memberId);
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
          {p.facts.map((f) => (
            <FactRow key={f.label} label={f.label} value={f.value} tone={f.tone} />
          ))}
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
        <button className="btn btn-deny" onClick={() => run(() => api(`/proposals/${p.id}/deny`, { memberId: me }), "Denied")}>Deny</button>
        <button
          className="btn btn-approve"
          disabled={iApproved || !!s.frozen}
          title={s.frozen ? "Unfreeze before approving" : undefined}
          onClick={() =>
            run(async () => {
              const r = await api<{ status: string; error?: string }>(`/proposals/${p.id}/approve`, { memberId: me, payloadHash: p.payloadHash });
              if (r.status === "failed") throw new Error(r.error ?? "Payment failed");
            }, "Approved")
          }
        >
          {iApproved ? "You approved" : p.payload ? `Approve & pay ${usd(p.payload.amountUsd)}` : "Approve"}
        </button>
      </div>
    </div>
  );
}

function FactRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={tone ?? ""}>{value}</dd>
    </>
  );
}

// ============================================================== agents

function Meter({ a, frozen, label }: { a: Agent; frozen?: boolean; label?: boolean }) {
  const pct = a.dailyAllowanceUsd > 0 ? Math.min(100, (a.spentTodayUsd / a.dailyAllowanceUsd) * 100) : 0;
  const cls = pct >= 90 ? "high" : pct >= 60 ? "mid" : "";
  return (
    <div className="meter">
      <div className="row">
        <span>{label ? a.name : "spent today"}</span>
        <span>{usd(a.spentTodayUsd)} / {usd(a.dailyAllowanceUsd)}</span>
      </div>
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
        <p className="muted">Give this to the agent's runtime as <span className="mono">KARUNA_AGENT_TOKEN</span>. It only lets the agent <b>propose</b> — it can't approve, pay, or see any key. Karuna stores only its hash, so copy it now.</p>
        <div className="token-row">
          <code className="token">{token}</code>
          <button className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(token); setCopied(true); }}>{copied ? "copied" : "copy"}</button>
        </div>
        <pre className="snippet">{`import { KarunaAgent } from "@prekaruna/agents";

const karuna = new KarunaAgent({
  gatekeeperUrl: "${AGENT_API}",
  token: process.env.KARUNA_AGENT_TOKEN!,
});

// buy from an x402 service — the Gatekeeper pays, you get the response
const r = await karuna.buy(serviceUrl, { maxUsd: 0.01, reason: "why" });
if (r.status === "pending") await karuna.wait(r.id); // a human decides`}</pre>
        <button className="btn btn-dark" onClick={onDone}>I've stored the token</button>
      </div>
    </div>
  );
}

function Agents({ s, me, run }: { s: Snapshot; me: string; run: Run }) {
  const [form, setForm] = useState({ name: "", dailyAllowanceUsd: "1" });
  const [reveal, setReveal] = useState<{ token: string; agent: string } | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});

  const add = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ token: string; agent: Agent }>("/agents", { ...form, memberId: me });
      setReveal({ token: r.token, agent: r.agent.name });
      setForm({ name: "", dailyAllowanceUsd: "1" });
    });
  };

  return (
    <div className="stack">
      {reveal && <TokenReveal {...reveal} onDone={() => setReveal(null)} />}
      <form className="card inline-form" onSubmit={add}>
        <label className="field grow"><span>Agent name</span><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Accounts payable agent" /></label>
        <label className="field"><span>Daily allowance (USD)</span><input required type="number" min="0" step="0.000001" value={form.dailyAllowanceUsd} onChange={(e) => setForm({ ...form, dailyAllowanceUsd: e.target.value })} /></label>
        <button className="btn btn-dark" type="submit">Add agent</button>
      </form>
      <p className="section-title">Inside its allowance, an agent's payments to known payees go through on their own. Anything above it waits for a human.</p>
      {s.org.agents.length === 0 ? (
        <div className="card"><div className="empty">No agents yet. Add one above to get its token.</div></div>
      ) : (
        <div className="grid2">
          {s.org.agents.map((a, i) => {
            const count = s.proposals.filter((p) => p.agentId === a.id && Date.now() - Date.parse(p.createdAt) < 86_400_000).length;
            const ed = editing[a.id];
            return (
              <div className={`agent rise ${s.frozen ? "frozen" : ""}`} style={st(i)} key={a.id}>
                <div className="top">
                  <span className="emoji">◉</span>
                  <div><div className="name">{a.name}</div><div className="job mono">{a.id}</div></div>
                  <span className={`state ${s.frozen ? "frozen" : "active"}`}>{s.frozen ? "frozen" : "active"}</span>
                </div>
                <Meter a={a} frozen={!!s.frozen} />
                <div className="meta">
                  {ed === undefined ? (
                    <span className="tag link" onClick={() => setEditing({ ...editing, [a.id]: String(a.dailyAllowanceUsd) })}>cap {usd(a.dailyAllowanceUsd)}/day ✎</span>
                  ) : (
                    <form className="cap-edit" onSubmit={(e) => { e.preventDefault(); run(() => api(`/agents/${a.id}`, { dailyAllowanceUsd: ed, memberId: me }, "PATCH"), "Allowance updated").then(() => setEditing(({ [a.id]: _, ...rest }) => rest)); }}>
                      <input autoFocus type="number" min="0" step="0.000001" value={ed} onChange={(e) => setEditing({ ...editing, [a.id]: e.target.value })} />
                      <button className="btn btn-ghost btn-sm">save</button>
                    </form>
                  )}
                  <span className="tag">{count} proposals today</span>
                </div>
                <div className="agent-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => run(async () => { const r = await api<{ token: string }>(`/agents/${a.id}/rotate-token`, { memberId: me }); setReveal({ token: r.token, agent: a.name }); })}>Rotate token</button>
                  <button className="btn btn-deny btn-sm" onClick={() => confirm(`Remove ${a.name}? Its token stops working immediately.`) && run(() => api(`/agents/${a.id}?by=${me}`, undefined, "DELETE"), "Agent removed")}>Remove</button>
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

function Payees({ s, me, run }: { s: Snapshot; me: string; run: Run }) {
  const [form, setForm] = useState({ address: "", name: "", category: "" });
  const add = (e: FormEvent) => {
    e.preventDefault();
    run(() => api("/recipients", { ...form, memberId: me }), "Payee added").then(() => setForm({ address: "", name: "", category: "" }));
  };
  return (
    <div className="stack">
      <form className="card inline-form" onSubmit={add}>
        <label className="field"><span>Name</span><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Supplier or service" /></label>
        <label className="field grow"><span>Payout address</span><input required className="mono" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value.trim() })} placeholder="0x…" /></label>
        <label className="field"><span>Category</span><input required value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="e.g. data, utilities" /></label>
        <button className="btn btn-dark" type="submit">Add payee</button>
      </form>
      <p className="section-title">Payments to any address not on this list are denied. For x402 services, add the seller's payout address — Karuna reads it from the service's 402 response, not from the agent.</p>
      <div className="card">
        <div className="hd"><h2>Known payees</h2><span className="sub">{s.org.recipients.length}</span></div>
        {s.org.recipients.length === 0 ? (
          <div className="empty">No payees yet, so every payment is denied.</div>
        ) : (
          <div className="table">
            {s.org.recipients.map((r) => (
              <div className="tr" key={r.address}>
                <span className="b">{r.name}</span>
                <span className="mono small">{r.address}</span>
                <span className="tag">{r.category}</span>
                <button className="btn btn-deny btn-sm" onClick={() => run(() => api(`/recipients/${r.address}?by=${me}`, undefined, "DELETE"), "Payee removed")}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================== policy

function Policy({ s, me, run }: { s: Snapshot; me: string; run: Run }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [domain, setDomain] = useState("");
  const [threshold, setThreshold] = useState(String(s.org.twoPersonThresholdUsd));
  useEffect(() => {
    api<Rule[]>("/policy").then(setRules).catch(() => undefined);
  }, []);
  return (
    <div className="stack">
      <div className="card">
        <div className="hd"><h2>Active policy</h2><span className="sub">first match decides · {rules.length} rules</span></div>
        <div className="policy">
          {rules.map((r, i) => (
            <div className="p" key={r.id}>
              <span className="i">{i + 1}</span>
              <span className="nm">{r.id}<span className="desc"> — {r.description}</span></span>
              <span className={`o ${r.outcome}`}>{r.outcome}</span>
            </div>
          ))}
        </div>
        <div className="log-foot"><span>core boundaries can never be removed</span><span>loosening moves to Dharma on Arc in Phase 3</span></div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="hd"><h2>Allowlisted domains</h2><span className="sub">rule 9–11</span></div>
          <div className="pad stack">
            <div className="pills">
              {s.org.allowlistedDomains.map((d) => (
                <span className="pill" key={d}>{d} <a className="x" onClick={() => run(() => api(`/domains/${d}?by=${me}`, undefined, "DELETE"))}>×</a></span>
              ))}
              {s.org.allowlistedDomains.length === 0 && <span className="muted">None — all HTTP is denied.</span>}
            </div>
            <form className="row-form" onSubmit={(e) => { e.preventDefault(); run(() => api("/domains", { domain, memberId: me }), "Domain added").then(() => setDomain("")); }}>
              <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" required />
              <button className="btn btn-ghost btn-sm">Add</button>
            </form>
          </div>
        </div>
        <div className="card">
          <div className="hd"><h2>Two-person approval</h2></div>
          <div className="pad stack">
            <p className="muted">Payments at or above this amount need two different members to approve{s.org.members.length < 2 ? " (once you have two members)" : ""}.</p>
            <form className="row-form" onSubmit={(e) => { e.preventDefault(); run(() => api("/settings", { twoPersonThresholdUsd: threshold, memberId: me }, "PATCH"), "Threshold saved"); }}>
              <span className="mono">$</span>
              <input type="number" min="0" step="0.01" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
              <button className="btn btn-ghost btn-sm">Save</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================== signed log

function Activity({ s, log }: { s: Snapshot; log: LogEntry[] }) {
  const [filter, setFilter] = useState<"all" | "decisions" | "events">("all");
  const shown = useMemo(() => log.filter((e) => filter === "all" || (filter === "decisions" ? !!e.decision : !!e.event)), [log, filter]);
  const name = (id: unknown) => s.org.members.find((m) => m.id === id)?.name ?? s.org.agents.find((a) => a.id === id)?.name ?? String(id ?? "");
  return (
    <div className="card">
      <div className="hd">
        <h2>Signed decision log</h2>
        <span className="sub filters">
          {(["all", "decisions", "events"] as const).map((k) => <span key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{k}</span>)}
        </span>
      </div>
      {shown.length === 0 ? (
        <div className="empty">The log is empty.</div>
      ) : (
        <div className="gk">
          {shown.map((e) => {
            if (e.decision) {
              const o = e.decision.outcome;
              const r = e.request!;
              const what = r.tool === "payment" ? `${r.paymentKind ?? "payment"} ${r.amountUsd != null ? usd(r.amountUsd) : ""} → ${short(r.to)}` : r.command ?? (r.url ? `${r.method ?? "GET"} ${r.url}` : r.path ?? r.tool);
              return (
                <div className="item" key={e.seq}>
                  <span className="caret">{e.seq}</span>
                  <span className="tool">{r.tool}</span>
                  <span className={`act ${o === "deny" ? "denied" : ""}`}><span className="ag">{name(r.agent)} ·</span> {what}</span>
                  <span className={`chip ${o}`}><span className="g">{GLYPH[o]}</span>{o === "approval" ? "require approval" : o}</span>
                  <span className="pol">{e.decision.ruleId}</span>
                  <span className="log">{e.hash.slice(0, 4)}…{e.hash.slice(-4)}</span>
                </div>
              );
            }
            const ev = e.event!;
            const detail = Object.entries(ev).filter(([k]) => k !== "type").map(([k, v]) => `${k}=${k === "by" ? name(v) : typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("  ");
            return (
              <div className="item event" key={e.seq}>
                <span className="caret">{e.seq}</span>
                <span className="tool">event</span>
                <span className="act"><b>{ev.type}</b> <span className="ag">{detail}</span></span>
                <span />
                <span className="pol">{ago(e.timestamp)}</span>
                <span className="log">{e.hash.slice(0, 4)}…{e.hash.slice(-4)}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="log-foot">
        <span><span className="sigdot" /> {s.log.length} entries · ed25519-signed &amp; hash-chained · {s.log.verified ? "verified" : `TAMPERED at ${s.log.brokenAt}`}</span>
        <span>head {short(s.log.head)}</span>
      </div>
    </div>
  );
}

// ============================================================== team

function Team({ s, me, run }: { s: Snapshot; me: string; run: Run }) {
  const [name, setName] = useState("");
  return (
    <div className="stack">
      <form className="card inline-form" onSubmit={(e) => { e.preventDefault(); run(() => api("/members", { name, memberId: me }), "Member added").then(() => setName("")); }}>
        <label className="field grow"><span>Name</span><input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Teammate who can approve" /></label>
        <button className="btn btn-dark" type="submit">Add member</button>
      </form>
      <p className="section-title">Members approve payments, deny requests, hit the panic button, and vote to unfreeze. Any one member can freeze; unfreezing needs {s.unfreezeVotesNeeded} vote{s.unfreezeVotesNeeded > 1 ? "s" : ""}.</p>
      <div className="card">
        <div className="table">
          {s.org.members.map((m) => (
            <div className="tr" key={m.id}>
              <span className="av">{m.name[0]?.toUpperCase()}</span>
              <span className="b">{m.name}{m.id === me ? <span className="muted"> (you)</span> : ""}</span>
              <span className="muted small">joined {ago(m.createdAt)}</span>
              <button className="btn btn-deny btn-sm" disabled={s.org.members.length <= 1} onClick={() => run(() => api(`/members/${m.id}?by=${me}`, undefined, "DELETE"), "Member removed")}>Remove</button>
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="hd"><h2>Gatekeeper wallet</h2></div>
        <div className="pad">
          <div className="mono">{s.org.wallet?.address}</div>
          <div className="muted small">{s.org.wallet?.chain} · held by the Gatekeeper only — agents never see it</div>
        </div>
      </div>
    </div>
  );
}
