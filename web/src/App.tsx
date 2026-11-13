import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  AGENTS, INITIAL_FEED, SUPPLIERS, TICKER, decide, shortHash,
  type AgentId, type FeedItem,
} from "./data.ts";
import { defaultRulesMeta } from "./policy.ts";

type View = "overview" | "approvals" | "agents" | "policy" | "activity";
const MEMBERS = ["Maya", "Sam"] as const;
const TWO_PERSON = 500;

const fmt = (n: number) => `$${n.toFixed(2)}`;
const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  const mnt = Math.round(s / 60);
  return mnt < 60 ? `${mnt}m ago` : `${Math.round(mnt / 60)}h ago`;
};
const agentOf = (id: AgentId) => AGENTS.find((a) => a.id === id)!;
const st = (i: number) => ({ ["--i"]: i }) as CSSProperties;

export default function App() {
  const [view, setView] = useState<View>("overview");
  const [member, setMember] = useState<(typeof MEMBERS)[number]>("Maya");
  const [frozen, setFrozen] = useState(false);
  const [feed, setFeed] = useState<FeedItem[]>(INITIAL_FEED.slice().reverse());
  const [resolved, setResolved] = useState<Record<string, "approved" | "denied">>({});

  // pending = engine said "approval" and a human hasn't acted yet
  const pending = useMemo(
    () => feed.filter((f) => f.decision.outcome === "approval" && !resolved[f.id]),
    [feed, resolved],
  );

  // live ticker: a routine proposal lands every few seconds (unless frozen)
  useEffect(() => {
    if (frozen) return;
    const t = setInterval(() => {
      const pick = TICKER[Math.floor(Math.random() * TICKER.length)];
      setFeed((f) => [decide(pick.agent, pick.request, pick.label, pick.why), ...f].slice(0, 60));
    }, 5000);
    return () => clearInterval(t);
  }, [frozen]);

  const act = (id: string, outcome: "approved" | "denied") =>
    setResolved((r) => ({ ...r, [id]: outcome }));

  const titles: Record<View, string> = {
    overview: "Overview", approvals: "Approvals", agents: "Agents", policy: "Policy", activity: "Activity log",
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><span className="mark">⬡</span> Karuna</div>
        <div className="biz">maya's bakery · 3 locations</div>
        <nav className="nav">
          {(Object.keys(titles) as View[]).map((v) => (
            <a key={v} className={view === v ? "sel" : ""} onClick={() => setView(v)}>
              <span className="ic">{icon[v]}</span> {titles[v]}
              {v === "approvals" && pending.length > 0 && <span className="count warn">{pending.length}</span>}
            </a>
          ))}
        </nav>
        <div className="member">
          <div className="who">
            <span className="av">{member[0]}</span>
            <span>{member}</span>
            <span className="switch" onClick={() => setMember((m) => (m === "Maya" ? "Sam" : "Maya"))}>switch</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{titles[view]}</h1>
          <div className="right">
            <span className={`status ${frozen ? "frozen" : ""}`}>
              <span className="d" /> {frozen ? "all agents frozen" : "3 agents active"}
            </span>
            <button className={`panic ${frozen ? "armed" : ""}`} onClick={() => setFrozen((f) => !f)}>
              {frozen ? "Unfreeze (needs vote)" : "⬛ Panic — freeze all"}
            </button>
          </div>
        </header>

        <div className="content">
          {frozen && (
            <div className="freeze-banner">
              <b>Frozen.</b> {member} hit the panic button — every agent is stopped. Unfreezing requires a team vote.
              <button className="btn btn-ghost btn-sm" onClick={() => setFrozen(false)}>Record vote to unfreeze</button>
            </div>
          )}

          {view === "overview" && <Overview feed={feed} pending={pending} frozen={frozen} onGo={setView} />}
          {view === "approvals" && (
            <Approvals pending={pending} member={member} onAct={act} resolvedCount={Object.keys(resolved).length} />
          )}
          {view === "agents" && <Agents frozen={frozen} feed={feed} />}
          {view === "policy" && <Policy />}
          {view === "activity" && <Activity feed={feed} />}
        </div>
      </main>
    </div>
  );
}

const icon: Record<View, string> = { overview: "▦", approvals: "◷", agents: "◉", policy: "☰", activity: "≋" };

/* ---------------- Overview ---------------- */
function Overview({ feed, pending, frozen, onGo }: {
  feed: FeedItem[]; pending: FeedItem[]; frozen: boolean; onGo: (v: View) => void;
}) {
  const today = feed.filter((f) => Date.now() - f.at < 86_400_000);
  const denied = today.filter((f) => f.decision.outcome === "deny").length;
  const spent = AGENTS.reduce((s, a) => s + a.spentToday, 0);
  return (
    <div className="stack">
      <div className="tiles">
        <div className="tile rise" style={st(0)}><div className="k">Pending</div><div className={`v ${pending.length ? "warn" : ""}`}>{pending.length}</div></div>
        <div className="tile rise" style={st(1)}><div className="k">Decisions today</div><div className="v">{today.length}</div></div>
        <div className="tile rise" style={st(2)}><div className="k">Blocked today</div><div className={`v ${denied ? "bad" : ""}`}>{denied}</div></div>
        <div className="tile rise" style={st(3)}><div className="k">Spent today</div><div className="v">{fmt(spent)}</div></div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="hd"><h2>Waiting for you</h2><span className="sub" onClick={() => onGo("approvals")} style={{ cursor: "pointer" }}>view all →</span></div>
          {pending.length === 0 ? (
            <div className="empty">Nothing needs approval right now.</div>
          ) : (
            <div className="log">
              {pending.slice(0, 3).map((f) => (
                <div className="item" key={f.id} style={{ gridTemplateColumns: "auto 1fr auto" }}>
                  <span className="chip approval">approve</span>
                  <span className="act"><span className="ag">{agentOf(f.agent).emoji} </span>{f.label}</span>
                  <span className="t">{ago(f.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="hd"><h2>Agents</h2><span className="sub" onClick={() => onGo("agents")} style={{ cursor: "pointer" }}>manage →</span></div>
          <div style={{ padding: "1rem" }} className="stack">
            {AGENTS.map((a) => <Meter key={a.id} agent={a} frozen={frozen} compact />)}
          </div>
        </div>
      </div>

      <div className="card rise" style={st(2)}>
        <div className="hd"><h2>Decision log</h2><span className="sub" onClick={() => onGo("activity")} style={{ cursor: "pointer" }}>full log →</span></div>
        <LogRows feed={feed.slice(0, 6)} />
        <div className="log-foot"><span><span className="sigdot" /> signed · ed25519</span><span>head {feed[0]?.hash}</span></div>
      </div>
    </div>
  );
}

/* ---------------- Approvals ---------------- */
function Approvals({ pending, member, onAct, resolvedCount }: {
  pending: FeedItem[]; member: string; onAct: (id: string, o: "approved" | "denied") => void; resolvedCount: number;
}) {
  if (pending.length === 0)
    return (
      <div className="card"><div className="empty">
        All clear — no actions are waiting for a human.<br />
        <span className="muted" style={{ fontSize: ".8rem" }}>{resolvedCount} resolved so far this session.</span>
      </div></div>
    );
  return (
    <div>
      <p className="section-title">Facts first — the agent's reason is shown separately and labeled untrusted.</p>
      {pending.map((f, i) => <div className="rise" style={st(i)} key={f.id}><ApprovalCard f={f} member={member} onAct={onAct} /></div>)}
    </div>
  );
}

function ApprovalCard({ f, member, onAct }: { f: FeedItem; member: string; onAct: (id: string, o: "approved" | "denied") => void }) {
  const a = agentOf(f.agent);
  const supplier = f.to ? SUPPLIERS[f.to] : undefined;
  const big = (f.amountUsd ?? 0) >= TWO_PERSON;
  const payloadHash = shortHash(`${f.to}${f.amountUsd}${f.category}${f.id}`);
  return (
    <div className="approval">
      <div className="appr-top">
        <span className="who">{a.emoji} {a.name}</span>
        {f.amountUsd != null && <span className="amt">{fmt(f.amountUsd)}</span>}
      </div>
      <div className="facts">
        <div className="lbl">Karuna — verified facts</div>
        <dl>
          <dt>Action</dt><dd>{f.label.replace(/ —.*/, "")}</dd>
          {supplier && (<><dt>Recipient</dt><dd>{supplier.name}</dd><dt>Account</dt><dd>{supplier.account}</dd></>)}
          {!supplier && f.to && (<><dt>Recipient</dt><dd className="warn">unlisted ({f.to})</dd></>)}
          {f.category && (<><dt>Category</dt><dd>{f.category}</dd></>)}
          <dt>Reversible</dt><dd className="warn">no — USDC transfer</dd>
          <dt>Why asking</dt><dd>{f.decision.reason}</dd>
          <dt>Payload hash</dt><dd>{payloadHash}</dd>
        </dl>
      </div>
      {f.justification && (
        <div className="justify">
          <div className="lbl">⚠ written by the agent — may not be true</div>
          <p>{f.justification}</p>
        </div>
      )}
      <div className="appr-actions">
        {big && <span className="two-person">⚑ over {fmt(TWO_PERSON)} — needs {member === "Maya" ? "Sam" : "Maya"} too</span>}
        <button className="btn btn-deny" onClick={() => onAct(f.id, "denied")}>Deny</button>
        <button className="btn btn-approve" onClick={() => onAct(f.id, "approved")}>
          Approve{big ? " (1 of 2)" : ""} — exact match
        </button>
      </div>
    </div>
  );
}

/* ---------------- Agents ---------------- */
function Agents({ frozen, feed }: { frozen: boolean; feed: FeedItem[] }) {
  return (
    <div className="grid2">
      {AGENTS.map((a, i) => {
        const count = feed.filter((f) => f.agent === a.id).length;
        return (
          <div className={`agent rise ${frozen ? "frozen" : ""}`} style={st(i)} key={a.id}>
            <div className="top">
              <span className="emoji">{a.emoji}</span>
              <div><div className="name">{a.name}</div><div className="job">{a.job}</div></div>
              <span className={`state ${frozen ? "frozen" : "active"}`}>{frozen ? "frozen" : "active"}</span>
            </div>
            <Meter agent={a} frozen={frozen} />
            <div className="meta">
              <span className="tag">cap {fmt(a.cap)}/day</span>
              <span className="tag">{count} actions today</span>
              <span className="tag">0 auto-rules</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Meter({ agent, frozen, compact }: { agent: (typeof AGENTS)[number]; frozen?: boolean; compact?: boolean }) {
  const pct = Math.min(100, (agent.spentToday / agent.cap) * 100);
  const cls = pct >= 90 ? "high" : pct >= 60 ? "mid" : "";
  return (
    <div className="meter">
      <div className="row">
        <span>{compact ? `${agent.emoji} ${agent.name}` : "spent today"}</span>
        <span>{fmt(agent.spentToday)} / {fmt(agent.cap)}</span>
      </div>
      <div className="track"><div className={`fill ${cls}`} style={{ width: `${frozen ? 0 : pct}%` }} /></div>
    </div>
  );
}

/* ---------------- Policy ---------------- */
function Policy() {
  return (
    <div className="card">
      <div className="hd"><h2>Active policy</h2><span className="sub">first match decides · {defaultRulesMeta.length} rules</span></div>
      <div className="policy">
        {defaultRulesMeta.map((r, i) => (
          <div className="p" key={r.id}>
            <span className="i">{i + 1}</span>
            <span className="nm">{r.id}<span className="desc"> — {r.description}</span></span>
            <span className={`o ${r.outcome}`}>{r.outcome}</span>
          </div>
        ))}
      </div>
      <div className="log-foot">
        <span>core boundaries can never be removed · tighten fast · loosen slow &amp; public</span>
        <span>anchored on Arc at launch</span>
      </div>
    </div>
  );
}

/* ---------------- Activity ---------------- */
function Activity({ feed }: { feed: FeedItem[] }) {
  const [filter, setFilter] = useState<"all" | "allow" | "deny" | "approval">("all");
  const shown = feed.filter((f) => filter === "all" || f.decision.outcome === filter);
  return (
    <div className="card">
      <div className="hd">
        <h2>Signed decision log</h2>
        <span className="sub" style={{ display: "flex", gap: ".5rem" }}>
          {(["all", "allow", "approval", "deny"] as const).map((k) => (
            <span key={k} onClick={() => setFilter(k)} style={{ cursor: "pointer", color: filter === k ? "var(--black)" : undefined }}>{k}</span>
          ))}
        </span>
      </div>
      <LogRows feed={shown} full />
      <div className="log-foot">
        <span>● every decision ed25519-signed &amp; hash-chained</span>
        <span>head {feed[0]?.hash}</span>
      </div>
    </div>
  );
}

const GLYPH = { allow: "✓", deny: "✕", approval: "◷" } as const;
const toolTag = (f: FeedItem) =>
  f.request.tool === "file" ? (f.request.fileOp === "write" ? "file_write" : "file_read") : f.request.tool;

function LogRows({ feed, full }: { feed: FeedItem[]; full?: boolean }) {
  return (
    <div className="gk">
      {feed.map((f) => {
        const o = f.decision.outcome;
        return (
          <div className={`item ${Date.now() - f.at < 1500 ? "fresh" : ""}`} key={f.id}>
            <span className="caret">›</span>
            <span className="tool">{toolTag(f)}</span>
            <span className={`act ${o === "deny" ? "denied" : ""}`}>
              <span className="ag">{agentOf(f.agent).emoji} {f.agent} ·</span> {f.label}
            </span>
            <span className={`chip ${o}`}><span className="g">{GLYPH[o]}</span>{o === "approval" ? "require approval" : o}</span>
            <span className="pol">{f.decision.ruleId}</span>
            {full ? <span className="t">{ago(f.at)}</span> : <span className="log">{f.hash}</span>}
          </div>
        );
      })}
    </div>
  );
}
