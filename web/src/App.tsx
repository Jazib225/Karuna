import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  AGENTS, INITIAL_FEED, SUPPLIERS, TICKER, decide, shortHash, ctx,
  type AgentId, type FeedItem, type Request,
} from "./data.ts";
import { evaluate } from "./engine/engine.ts";
import type { Outcome } from "./engine/types.ts";
import { defaultRulesMeta } from "./policy.ts";
import { I, AgentIcon, Glyph } from "./icons.tsx";

type View = "overview" | "approvals" | "agents" | "policy" | "log";
type Member = "Maya" | "Sam";
const MEMBERS: Member[] = ["Maya", "Sam"];
const TWO_PERSON = 500;
const SCOPES: Record<AgentId, string[]> = {
  bills: ["supplies", "utilities", "rent"],
  supplies: ["data", "supplies"],
  research: ["data"],
};

const fmt = (n: number) => `$${n.toFixed(2)}`;
const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};
const st = (i: number) => ({ ["--i"]: i }) as CSSProperties;
const agentOf = (id: AgentId) => AGENTS.find((a) => a.id === id)!;
const verdict = (o: Outcome) => (o === "approval" ? "Require approval" : o === "allow" ? "Allow" : "Deny");
const toolTag = (r: Request) =>
  r.tool === "file" ? (r.fileOp === "write" ? "file_write" : "file_read") : r.tool;
const actionOf = (f: FeedItem) => f.label.replace(/ — .*/, "");

interface Votes { by: Member[]; denied?: Member }

/* ======================================================================= */
export default function App() {
  const [view, setView] = useState<View>("overview");
  const [member, setMember] = useState<Member>("Maya");
  const [frozen, setFrozen] = useState(false);
  const [paused, setPaused] = useState<Partial<Record<AgentId, boolean>>>({});
  const [feed, setFeed] = useState<FeedItem[]>(() => INITIAL_FEED.slice().reverse());
  const [votes, setVotes] = useState<Record<string, Votes>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [, tick] = useState(0);

  const needed = (f: FeedItem) => ((f.amountUsd ?? 0) >= TWO_PERSON ? 2 : 1);
  const pending = useMemo(
    () => feed.filter((f) => f.decision.outcome === "approval" && !votes[f.id]?.denied && (votes[f.id]?.by.length ?? 0) < needed(f)),
    [feed, votes],
  );

  // live gatekeeper: routine proposals stream in (stops when frozen / agent paused)
  useEffect(() => {
    if (frozen) return;
    const t = setInterval(() => {
      const pool = TICKER.filter((p) => !paused[p.agent]);
      if (!pool.length) return;
      const p = pool[Math.floor(Math.random() * pool.length)];
      setFeed((f) => [decide(p.agent, p.request, p.label, p.why), ...f].slice(0, 80));
    }, 4500);
    return () => clearInterval(t);
  }, [frozen, paused]);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 15000); return () => clearInterval(t); }, []);

  const record = (f: FeedItem, outcome: "allow" | "deny", by: Member[]) => {
    const item: FeedItem = {
      ...f, id: `${f.id}-x`, at: Date.now(),
      label: outcome === "allow" ? `Executed: ${f.label}` : `Rejected: ${f.label}`,
      decision: {
        outcome, ruleId: outcome === "allow" ? "human-approved" : "human-denied",
        reason: `${outcome === "allow" ? "Approved" : "Denied"} by ${by.join(" + ")}`,
      },
      hash: shortHash(`${f.id}${outcome}${by.join()}`),
    };
    setFeed((x) => [item, ...x]);
  };
  const approve = (f: FeedItem) => {
    const v = votes[f.id] ?? { by: [] };
    if (v.by.includes(member)) return;
    const by = [...v.by, member];
    setVotes((x) => ({ ...x, [f.id]: { by } }));
    if (by.length >= needed(f)) record(f, "allow", by);
  };
  const deny = (f: FeedItem) => {
    setVotes((x) => ({ ...x, [f.id]: { by: x[f.id]?.by ?? [], denied: member } }));
    record(f, "deny", [member]);
  };
  const go = (v: View, id?: string) => { setView(v); if (id) setSel(id); window.scrollTo({ top: 0, behavior: "smooth" }); };

  const tabs: [View, string][] = [["overview", "Overview"], ["approvals", "Approvals"], ["agents", "Agents"], ["policy", "Policy"], ["log", "Decision log"]];

  return (
    <>
      <header className="topbar">
        <div className="topbar-in">
          <div className="brand">
            <span className="logo"><I.lotus /> Karuna</span>
            <span className="slash">/</span>
            <span className="ws"><span className="av">M</span>Maya's Bakery</span>
          </div>
          <nav className="tabs">
            {tabs.map(([v, label]) => (
              <button key={v} className={`tab ${view === v ? "sel" : ""}`} onClick={() => go(v)}>
                {label}{v === "approvals" && pending.length > 0 && <span className="badge">{pending.length}</span>}
              </button>
            ))}
          </nav>
          <div className="top-right">
            <span className="net"><span className={`pulse ${frozen ? "red" : ""}`} />{frozen ? "frozen" : "arc testnet · live"}</span>
            <div className="member">
              {MEMBERS.map((m) => <button key={m} className={member === m ? "sel" : ""} onClick={() => setMember(m)}>{m}</button>)}
            </div>
            <button className={`panic ${frozen ? "on" : ""}`} onClick={() => setFrozen(true)} title="Any one person can freeze every agent">
              <I.freeze /> {frozen ? "Frozen" : "Freeze all"}
            </button>
          </div>
        </div>
        {frozen && (
          <div className="freeze">
            <div className="freeze-in">
              <I.freeze /><span><b>Every agent is frozen.</b> {member} pressed the panic button. Nothing runs until the team votes to unfreeze.</span>
              <button onClick={() => setFrozen(false)}>Vote to unfreeze</button>
            </div>
          </div>
        )}
      </header>

      <main className="page" key={view}>
        {view === "overview" && <Overview {...{ feed, pending, member, frozen, paused, go }} />}
        {view === "approvals" && <Approvals {...{ feed, pending, member, votes, sel, setSel, approve, deny, needed }} />}
        {view === "agents" && <Agents {...{ feed, frozen, paused, setPaused }} />}
        {view === "policy" && <Policy />}
        {view === "log" && <Log feed={feed} />}
      </main>

      <footer className="foot">
        <span>karuna console · maya's bakery</span>
        <span>policy engine v0.1 · arc testnet 5042002 · demo data</span>
        <span>© 2026 Karuna</span>
      </footer>
    </>
  );
}

/* ---------------- layout pieces ---------------- */
function Band({ children, cls = "" }: { children: ReactNode; cls?: string }) {
  return <section className={`band cross ${cls}`}><div className="rail">{children}</div></section>;
}

function PageHead({ eyebrow, title, grey, lede, facts }: {
  eyebrow: string; title: string; grey: string[]; lede: string;
  facts: { k: string; v: ReactNode; s: string; cls?: string }[];
}) {
  return (
    <Band cls="topo">
      <div className="pagehead">
        <div className="rise">
          <span className="eyebrow">{eyebrow}</span>
          <h1 className="headline">{title}{grey.map((g) => <span className="g" key={g}>{g}</span>)}</h1>
          <p className="lede">{lede}</p>
        </div>
        <div className="headfacts rise" style={st(2)}>
          {facts.map((f) => (
            <div key={f.k}><div className="k">{f.k}</div><div className={`v ${f.cls ?? ""}`}>{f.v}</div><div className="s">{f.s}</div></div>
          ))}
        </div>
      </div>
    </Band>
  );
}

function SecHead({ eyebrow, title, right }: { eyebrow: string; title: string; right?: ReactNode }) {
  return (
    <div className="sechead">
      <div><span className="eyebrow">{eyebrow}</span><h2 className="h2">{title}</h2></div>
      {right}
    </div>
  );
}

/* ---------------- gatekeeper window (from the screencast) ---------------- */
function Gatekeeper({ rows, hit, title = "karuna · gatekeeper" }: { rows: FeedItem[]; hit?: string; title?: string }) {
  return (
    <div className="win">
      <div className="win-bar">
        <span className="tl"><i /><i /><i /></span>
        <span>{title}</span>
        <span className="r">policy: default · {defaultRulesMeta.length} rules</span>
      </div>
      <div className="gk-body">
        <div className="gk-rules">
          <div className="t">RULES</div>
          {defaultRulesMeta.map((r) => (
            <div key={r.id} className={`gk-rule ${r.id === hit ? "hit" : ""}`}>{r.id}{r.core && <I.lock />}</div>
          ))}
        </div>
        <div className="gk-rows">
          {rows.map((f) => <GkRow key={f.id} f={f} />)}
        </div>
      </div>
    </div>
  );
}

function GkRow({ f }: { f: FeedItem }) {
  const [fresh] = useState(() => Date.now() - f.at < 2500);
  const [n, setN] = useState(fresh ? 0 : f.label.length);
  useEffect(() => {
    if (!fresh) return;
    const t = setInterval(() => setN((x) => (x >= f.label.length ? (clearInterval(t), x) : x + 1)), 20);
    return () => clearInterval(t);
  }, [fresh, f.label.length]);
  const done = n >= f.label.length;
  const o = f.decision.outcome;
  return (
    <div className={`gk-row ${fresh ? "enter" : ""}`}>
      <span className="car">›</span>
      <span className="tool">{toolTag(f.request)}</span>
      <span className={`act ${o === "deny" && done ? "struck" : ""}`}>
        <span className="who">{f.agent} · </span>{f.label.slice(0, n)}{!done && <span className="cursor" />}
      </span>
      <span className="meta" style={{ visibility: done ? "visible" : "hidden" }}>
        <span className={`chip ${o} ${fresh ? "pop" : ""}`}><Glyph o={o} />{verdict(o)}</span>
        <span className="pol">policy: <b>{f.decision.ruleId}</b></span>
        <span className="h">log {f.hash}</span>
      </span>
    </div>
  );
}

function DecLog({ feed }: { feed: FeedItem[] }) {
  return (
    <div className="declog">
      <div className="hd"><span>Decision log</span><span>signed</span></div>
      {feed.slice(0, 4).map((f) => (
        <DecRow key={f.id} f={f} />
      ))}
    </div>
  );
}
function DecRow({ f }: { f: FeedItem }) {
  const [fresh] = useState(() => Date.now() - f.at < 2500);
  return (
    <div className={`r ${fresh ? "enter" : ""}`}>
      <span>{f.decision.ruleId}</span><span className="h">{f.hash}</span>
      <span className={`chip ${f.decision.outcome}`}><Glyph o={f.decision.outcome} />{f.decision.outcome === "approval" ? "Approval" : verdict(f.decision.outcome)}</span>
    </div>
  );
}

function Meter({ spent, cap, off }: { spent: number; cap: number; off?: boolean }) {
  const pct = Math.min(100, (spent / cap) * 100);
  const cls = pct >= 90 ? "high" : pct >= 65 ? "mid" : "";
  return (
    <div className="meter">
      <div className="row"><span>spent today</span><span><b>{fmt(spent)}</b> / {fmt(cap)}</span></div>
      <div className="track"><div className={`fill ${cls}`} style={{ width: `${off ? 0 : pct}%` }} /></div>
      <div className="ticks"><span>$0</span><span>{fmt(cap / 2)}</span><span>{fmt(cap)}</span></div>
    </div>
  );
}

/* ================= Overview ================= */
function Overview({ feed, pending, member, frozen, paused, go }: {
  feed: FeedItem[]; pending: FeedItem[]; member: Member; frozen: boolean;
  paused: Partial<Record<AgentId, boolean>>; go: (v: View, id?: string) => void;
}) {
  const allowed = feed.filter((f) => f.decision.outcome === "allow").length;
  const blocked = feed.filter((f) => f.decision.outcome === "deny").length;
  const spent = AGENTS.reduce((s, a) => s + a.spentToday, 0);
  const cap = AGENTS.reduce((s, a) => s + a.cap, 0);
  const active = frozen ? 0 : AGENTS.filter((a) => !paused[a.id]).length;
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <>
      <PageHead
        eyebrow="Maya's Bakery · Console"
        title={`${greet}, ${member}.`}
        grey={[`${pending.length} ${pending.length === 1 ? "action needs" : "actions need"} you.`, `${active} agents inside the boundary.`]}
        lede="Your agents propose. Karuna decides with the rules your team set. Anything that moves money past an allowance waits here for a human."
        facts={[
          { k: "Waiting on you", v: pending.length, s: pending.length ? "oldest " + ago(pending[pending.length - 1].at) : "all clear", cls: pending.length ? "warn" : "" },
          { k: "Decisions today", v: feed.length, s: `${allowed} allowed automatically` },
          { k: "Blocked", v: blocked, s: "agents got a blank denial", cls: blocked ? "bad" : "" },
          { k: "Spent today", v: fmt(spent), s: `of ${fmt(cap)} combined allowance` },
        ]}
      />

      <Band>
        <SecHead eyebrow="Live" title="The gatekeeper, right now." right={<button className="link" onClick={() => go("log")}>open full log →</button>} />
        <div className="frame pad-b rise" style={st(1)}>
          <Gatekeeper rows={feed.slice(0, 7)} hit={feed[0]?.decision.ruleId} />
          <DecLog feed={feed} />
        </div>
      </Band>

      <Band cls="dots">
        <div className="grid g-7-5">
          <div className="card accent fill rise" style={st(1)}>
            <div className="card-hd">
              <span className="t"><span className="itile"><I.clock /></span>Waiting for you</span>
              <button className="link" onClick={() => go("approvals")}>review all →</button>
            </div>
            <div className="grow">
            {pending.length === 0 ? (
              <div className="empty"><div className="itile"><I.check /></div>Nothing needs a human right now.</div>
            ) : pending.map((f) => (
              <div className="lrow click" key={f.id} onClick={() => go("approvals", f.id)}>
                <span className="itile"><AgentIcon id={f.agent} /></span>
                <div className="main">
                  <div className="a">{actionOf(f)}</div>
                  <div className="b">{agentOf(f.agent).name} · {f.decision.ruleId} · {ago(f.at)}{(f.amountUsd ?? 0) >= TWO_PERSON ? " · two signers" : ""}</div>
                </div>
                <span className="amt">{f.amountUsd != null ? fmt(f.amountUsd) : ""}</span>
              </div>
            ))}
            </div>
            <div className="legend">
              <span className="t">How payments are routed</span>
              <div className="r"><span className="chip allow"><I.check />Allow</span>Known supplier, inside the agent's daily allowance</div>
              <div className="r"><span className="chip approval"><I.clock />Approval</span>Over the allowance · two signers above {fmt(TWO_PERSON)}</div>
              <div className="r"><span className="chip deny"><I.x />Deny</span>Unknown recipient · the agent gets a blank denial</div>
            </div>
          </div>

          <div className="card rise" style={st(2)}>
            <div className="card-hd">
              <span className="t"><span className="itile"><I.box /></span>Allowances</span>
              <button className="link" onClick={() => go("agents")}>manage →</button>
            </div>
            <div className="card-bd" style={{ display: "grid", gap: "1.1rem" }}>
              {AGENTS.map((a) => (
                <div key={a.id}>
                  <div style={{ display: "flex", alignItems: "center", gap: ".5rem", marginBottom: ".55rem", fontSize: ".86rem" }}>
                    <AgentIcon id={a.id} /> {a.name}
                    <span className="status" style={{ marginLeft: "auto" }}>
                      <span className={`pulse ${frozen || paused[a.id] ? "red" : ""}`} />{frozen ? "frozen" : paused[a.id] ? "paused" : "active"}
                    </span>
                  </div>
                  <Meter spent={a.spentToday} cap={a.cap} off={frozen} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </Band>

      <Band>
        <SecHead eyebrow="How it works" title="Isolate. Decide. Record." />
        <div className="frame rise" style={st(1)}>
          <div className="arch">
            <div className="glass dash">
              <div className="lab"><span>Sandbox</span><span className="tag">01 Isolate</span></div>
              <div style={{ display: "grid", gap: ".4rem" }}>
                {AGENTS.map((a) => (
                  <div className="ttl" key={a.id} style={{ fontSize: ".84rem" }}><span className="itile"><AgentIcon id={a.id} /></span>{a.name}</div>
                ))}
              </div>
              <div className="pills" style={{ marginTop: ".7rem" }}>
                <span className="pill"><I.no /> no network</span><span className="pill"><I.no /> no keys</span><span className="pill"><I.no /> no memory</span>
              </div>
            </div>
            <div className="wire" />
            <div className="glass">
              <div className="lab"><span>Proposed action</span><span className="tag">02 Decide</span></div>
              <div className="ttl"><span className="itile"><I.gate /></span>Gatekeeper + policy engine</div>
              <div className="kv"><span>policy engine</span><b>deterministic · first match</b></div>
              <div className="kv"><span>gatekeeper</span><b>holds all credentials</b></div>
              <div className="kv"><span>wallet</span><b>Circle agent wallet · Arc</b></div>
            </div>
            <div className="wire" />
            <div className="outcomes">
              <div className="glass"><div className="ttl"><span className="itile"><I.check /></span>Allowed · {allowed}</div><div className="kv"><span>executed with</span><b>gatekeeper-held keys</b></div></div>
              <div className="glass"><div className="ttl"><span className="itile"><I.x /></span>Blocked · {blocked}</div><div className="kv"><span>agent sees</span><b>the same blank denial</b></div></div>
            </div>
          </div>
          <div className="logbar">
            <span className="ttl"><span className="itile" style={{ background: "#fff", color: "#0a0a0a", width: 28, height: 28 }}><I.doc /></span>Signed, tamper-evident log <span className="tag" style={{ fontFamily: "var(--mono)", fontSize: ".62rem", border: "1px solid #ffffff2e", borderRadius: 999, padding: ".05rem .45rem", color: "#ffffffb3" }}>03 Record</span></span>
            <div className="chain">
              {feed.slice(0, 6).reverse().map((f, i, a) => (
                <span key={f.id} style={{ display: "contents" }}>
                  <span className={`lk ${i === a.length - 1 ? "last" : ""}`}>{f.hash.slice(0, 4)}</span>{i < a.length - 1 && <span className="dash" />}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Band>
    </>
  );
}

/* ================= Approvals ================= */
function Approvals({ feed, pending, member, votes, sel, setSel, approve, deny, needed }: {
  feed: FeedItem[]; pending: FeedItem[]; member: Member; votes: Record<string, Votes>;
  sel: string | null; setSel: (id: string) => void; approve: (f: FeedItem) => void; deny: (f: FeedItem) => void;
  needed: (f: FeedItem) => number;
}) {
  const current = pending.find((f) => f.id === sel) ?? pending[0];
  const approvedToday = feed.filter((f) => f.decision.ruleId === "human-approved").length;
  const deniedToday = feed.filter((f) => f.decision.ruleId === "human-denied").length;
  return (
    <>
      <PageHead
        eyebrow="Approvals"
        title="Facts first."
        grey={["The agent's story second."]}
        lede="Karuna writes the top of every card from the exact payload. The agent's explanation sits below it, boxed, because it may not be true. What you approve is byte-for-byte what executes."
        facts={[
          { k: "Waiting", v: pending.length, s: "need a human", cls: pending.length ? "warn" : "" },
          { k: "Two signers", v: pending.filter((f) => needed(f) === 2).length, s: `over ${fmt(TWO_PERSON)}` },
          { k: "Approved", v: approvedToday, s: "this session" },
          { k: "Denied", v: deniedToday, s: "this session" },
        ]}
      />
      <Band cls="dots">
        {pending.length === 0 ? (
          <div className="card"><div className="empty"><div className="itile"><I.check /></div>All clear. No action is waiting for a human.</div></div>
        ) : (
          <div className="grid g-7-5" style={{ alignItems: "start" }}>
            <div>
              {pending.map((f, i) => (
                <div className="rise" style={st(i)} key={f.id}>
                  <ApprovalCard f={f} member={member} v={votes[f.id]} need={needed(f)} selected={current?.id === f.id}
                    onSelect={() => setSel(f.id)} onApprove={() => approve(f)} onDeny={() => deny(f)} />
                </div>
              ))}
            </div>
            {current && <PayloadPanel f={current} v={votes[current.id]} need={needed(current)} />}
          </div>
        )}
      </Band>
    </>
  );
}

const payloadHash = (f: FeedItem) => shortHash(`${f.to}|${f.amountUsd}|${f.category}|${f.agent}|${f.id}`);

function ApprovalCard({ f, member, v, need, selected, onSelect, onApprove, onDeny }: {
  f: FeedItem; member: Member; v?: Votes; need: number; selected: boolean;
  onSelect: () => void; onApprove: () => void; onDeny: () => void;
}) {
  const a = agentOf(f.agent);
  const sup = f.to ? SUPPLIERS[f.to] : undefined;
  const signed = v?.by ?? [];
  const mine = signed.includes(member);
  return (
    <div className={`card ap ${selected ? "sel" : ""}`} onClickCapture={onSelect}>
      <div className="ap-top">
        <span className="itile dark"><AgentIcon id={f.agent} /></span>
        <div><div className="who">{a.name}</div><div className="what">{actionOf(f)} · {ago(f.at)}</div></div>
        {f.amountUsd != null && <span className="amt">{fmt(f.amountUsd)}</span>}
      </div>
      <div className="facts">
        <div className="lab"><I.shield /> Karuna · verified facts</div>
        <dl>
          <dt>Recipient</dt><dd>{sup ? sup.name : f.to}</dd>
          {sup && (<><dt>Payout account</dt><dd>{sup.account} · on file</dd></>)}
          {f.category && (<><dt>Category</dt><dd>payment:{f.category}</dd></>)}
          <dt>Network</dt><dd>Arc testnet · USDC</dd>
          <dt>Reversible</dt><dd className="warn">no</dd>
          <dt>Matched rule</dt><dd>{f.decision.ruleId}</dd>
          <dt>Payload hash</dt><dd>{payloadHash(f)}</dd>
        </dl>
      </div>
      {f.justification && (
        <div className="untrusted">
          <div className="lab"><I.pen /> Written by the agent · may not be true</div>
          <p>“{f.justification}”</p>
        </div>
      )}
      <div className="ap-act">
        <span className="note">
          {need === 2 ? <>two signers</> : <>one signer</>}
          <span className="signers">
            {MEMBERS.map((m) => <span key={m} className={`signer ${signed.includes(m) ? "ok" : ""}`}><i>{m[0]}</i>{m}</span>)}
          </span>
        </span>
        <button className="btn btn-line btn-sm" onClick={onDeny}><I.x /> Deny</button>
        <button className="btn btn-dark btn-sm" onClick={onApprove} disabled={mine}>
          <I.check /> {mine ? `Signed · waiting for ${MEMBERS.find((m) => m !== member)}` : `Approve as ${member}`}
        </button>
      </div>
    </div>
  );
}

function PayloadPanel({ f, v, need }: { f: FeedItem; v?: Votes; need: number }) {
  const signed = v?.by.length ?? 0;
  const line = (k: string, val: string, cls = "s") => <div><span className="k">  "{k}"</span>: <span className={cls}>{val}</span>,</div>;
  return (
    <div className="payload rise" style={st(1)}>
      <div className="card">
        <div className="card-hd"><span className="t"><span className="itile"><I.bolt /></span>Exact match</span><span className="sub">what executes</span></div>
        <div className="card-bd">
          <div className="code">
            <div>{"{"}</div>
            {line("agent", `"${f.agent}"`)}
            {line("tool", `"${f.request.tool}"`)}
            {line("to", `"${f.to ?? ""}"`)}
            {line("amount_usdc", `"${(f.amountUsd ?? 0).toFixed(2)}"`, "n")}
            {line("category", `"${f.category ?? ""}"`)}
            {line("chain", `"ARC-TESTNET"`)}
            <div><span className="k">  "from"</span>: <span className="s">"bakery wallet (gatekeeper-held)"</span></div>
            <div>{"}"}</div>
          </div>
          <div className="hashline"><span>sha256(payload)</span><b>{payloadHash(f)}</b></div>
          <div className="steps">
            <div className="step done"><span className="n">1</span>Karuna rendered these facts from the payload, not from the agent.</div>
            <div className={`step ${signed >= 1 ? "done" : ""}`}><span className="n">2</span>A human approves this exact hash.</div>
            {need === 2 && <div className={`step ${signed >= 2 ? "done" : ""}`}><span className="n">3</span>A second human co-signs (over {fmt(TWO_PERSON)}).</div>}
            <div className="step"><span className="n">{need === 2 ? 4 : 3}</span>The gatekeeper pays only if the final payload hash still matches.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================= Agents ================= */
function Agents({ feed, frozen, paused, setPaused }: {
  feed: FeedItem[]; frozen: boolean; paused: Partial<Record<AgentId, boolean>>;
  setPaused: (fn: (p: Partial<Record<AgentId, boolean>>) => Partial<Record<AgentId, boolean>>) => void;
}) {
  const spent = AGENTS.reduce((s, a) => s + a.spentToday, 0);
  const cap = AGENTS.reduce((s, a) => s + a.cap, 0);
  const nPaused = AGENTS.filter((a) => paused[a.id]).length;
  return (
    <>
      <PageHead
        eyebrow="Agents"
        title="Three agents."
        grey={["Zero keys."]}
        lede="Each agent runs in a sandbox with no network, no keys and no memory between tasks. It can only propose. The gatekeeper holds the bakery's wallet and pays on its behalf."
        facts={[
          { k: "Active", v: frozen ? 0 : AGENTS.length - nPaused, s: frozen ? "all frozen" : "inside the boundary" },
          { k: "Paused", v: frozen ? AGENTS.length : nPaused, s: "tightening is instant", cls: nPaused || frozen ? "bad" : "" },
          { k: "Spent today", v: fmt(spent), s: "paid by the gatekeeper" },
          { k: "Combined cap", v: fmt(cap), s: "raising it needs a vote" },
        ]}
      />
      <Band cls="dots">
        <div className="grid g3">
          {AGENTS.map((a, i) => {
            const mine = feed.filter((f) => f.agent === a.id);
            const last = mine[0];
            const off = frozen || !!paused[a.id];
            return (
              <div className={`card accent agent rise ${off ? "off" : ""}`} style={st(i)} key={a.id}>
                <div className="card-bd">
                  <div className="head">
                    <span className="itile dark"><AgentIcon id={a.id} /></span>
                    <div><div className="nm">{a.name}</div><div className="jb">{a.job}</div></div>
                    <span className="num">0{i + 1}</span>
                  </div>
                  <span className="status"><span className={`pulse ${off ? "red" : ""}`} />{frozen ? "frozen by panic" : paused[a.id] ? "paused" : "active · proposing"}</span>
                  <div className="pills"><span className="pill solid"><I.no /> no network</span><span className="pill solid"><I.no /> no keys</span><span className="pill solid"><I.no /> no memory</span></div>
                  <Meter spent={a.spentToday} cap={a.cap} off={off} />
                  <div>
                    <div className="mono muted" style={{ fontSize: ".62rem", letterSpacing: ".12em", textTransform: "uppercase", marginBottom: ".4rem" }}>may pay for</div>
                    <div className="pills">{SCOPES[a.id].map((c) => <span key={c} className="pill">payment:{c}</span>)}</div>
                  </div>
                  <div className="kvs">
                    <div><div className="k">Actions</div><div className="v">{mine.length}</div></div>
                    <div><div className="k">Blocked</div><div className="v">{mine.filter((f) => f.decision.outcome === "deny").length}</div></div>
                    <div><div className="k">Auto-rules</div><div className="v">0</div></div>
                  </div>
                  <div className="last"><span>last: {last ? actionOf(last) : "—"}</span><span>{last ? ago(last.at) : ""}</span></div>
                  <div className="ctl">
                    <button className="btn btn-line btn-sm" disabled={frozen} onClick={() => setPaused((p) => ({ ...p, [a.id]: !p[a.id] }))}>
                      {paused[a.id] ? "Resume" : "Pause agent"}
                    </button>
                    <button className="btn btn-line btn-sm" disabled title="Loosening goes through a Dharma vote + timelock">Raise cap · needs vote</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Band>
    </>
  );
}

/* ================= Policy ================= */
const SAMPLES: { label: string; agent: AgentId; req: Request }[] = [
  { label: "ls ./workspace", agent: "research", req: { tool: "shell", command: "ls ./workspace" } },
  { label: "GET api.stripe.com/v1/balance", agent: "supplies", req: { tool: "http", method: "GET", url: "https://api.stripe.com/v1/balance" } },
  { label: "rm -rf ./data", agent: "research", req: { tool: "shell", command: "rm -rf ./data" } },
  { label: "send 50 USDC to 0xabc…", agent: "research", req: { tool: "payment", to: "0xabc", amountUsd: 50 } },
  { label: "cat .env", agent: "research", req: { tool: "shell", command: "cat .env" } },
  { label: "pay Golden Mills $6", agent: "supplies", req: { tool: "payment", to: "0xgoldenmills", amountUsd: 6, category: "supplies" } },
  { label: "npm install left-pad", agent: "research", req: { tool: "shell", command: "npm install left-pad" } },
];
const PROPOSALS = [
  { kind: "tighten", title: "Block payments to 0xnewvendor", by: "proposed by Maya", when: "9m ago", status: "in effect" },
  { kind: "loosen", title: "Raise Supplies cap $10 → $15/day", by: "proposed by Sam", when: "1h ago", status: "vote 1 of 2" },
  { kind: "loosen", title: "Auto-pay Golden Mills up to $50", by: "suggested by Karuna", when: "after 5 approvals", status: "in review" },
] as const;
const EXPLAIN: Record<Outcome, string> = {
  allow: "Executed with gatekeeper-held credentials.",
  deny: "Blocked. The agent gets the same blank denial every time.",
  approval: "Queued for a human. Nothing runs until it's approved.",
};

function Policy() {
  const [pick, setPick] = useState(0);
  const [hist, setHist] = useState<{ s: (typeof SAMPLES)[number]; o: Outcome; rule: string; h: string; k: number }[]>([]);
  const run = () => {
    const s = SAMPLES[pick];
    const d = evaluate({ ...s.req, agent: s.agent }, ctx());
    setHist((h) => [{ s, o: d.outcome, rule: d.ruleId, h: shortHash(s.label + Date.now()), k: Date.now() }, ...h].slice(0, 4));
  };
  const cur = hist[0];
  return (
    <>
      <PageHead
        eyebrow="Policy · Dharma"
        title="First match decides."
        grey={["Loosening is slow", "and public."]}
        lede="Rules run top to bottom and the first one that matches wins. Core boundaries can never be removed. Any member can tighten instantly; loosening needs a vote and a timelock, recorded on Arc."
        facts={[
          { k: "Rules", v: defaultRulesMeta.length, s: "default + bakery" },
          { k: "Core boundaries", v: defaultRulesMeta.filter((r) => r.core).length, s: "can never be removed" },
          { k: "Auto-rules", v: 0, s: "Auto-Shield (phase 5)" },
          { k: "Ledger", v: "Arc", s: "Dharma contract (phase 3)" },
        ]}
      />
      <Band cls="dots">
        <div className="grid g-5-7" style={{ alignItems: "start" }}>
          <div className="card rise">
            <div className="card-hd"><span className="t"><span className="itile"><I.ledger /></span>Sample policy</span><span className="sub">default · {defaultRulesMeta.length} rules</span></div>
            <div className="rules">
              {defaultRulesMeta.map((r, i) => (
                <div key={r.id} className={`rule ${cur?.rule === r.id ? "hit" : ""} ${r.core ? "core" : ""}`}>
                  <span className="i">{String(i + 1).padStart(2, "0")}</span>
                  <div><div className="nm">{r.id}{r.core && <I.lock />}</div><div className="mt">{r.match}</div></div>
                  <span className="o">{r.outcome === "approval" ? "APPROVAL" : r.outcome.toUpperCase()}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "grid", gap: "1rem" }}>
            <div className="card accent rise" style={st(1)}>
              <div className="card-hd"><span className="t"><span className="itile"><I.gate /></span>Try a proposal</span><span className="sub">runs the real engine</span></div>
              <div className="card-bd">
                <div className="tester">
                  <span className="in">› {SAMPLES[pick].label}</span>
                  <button className="btn btn-dark btn-sm" onClick={run}>Evaluate <I.arrow /></button>
                </div>
                <div className="samples">
                  {SAMPLES.map((s, i) => <button key={s.label} className={`sample ${pick === i ? "sel" : ""}`} onClick={() => setPick(i)}>{s.label}</button>)}
                </div>
                {cur && (
                  <div className="result" key={cur.k}>
                    <div className="l1"><span className="tool">{toolTag(cur.s.req)}</span>{cur.s.label}</div>
                    <div className="l2"><span className={`chip ${cur.o} pop`}><Glyph o={cur.o} />{verdict(cur.o)}</span>policy: {cur.rule} · log {cur.h}</div>
                    <div className="l3">{EXPLAIN[cur.o]}</div>
                    {hist.slice(1).map((h) => (
                      <div key={h.k} className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: ".7rem", color: "var(--n400)", marginTop: ".5rem", borderTop: "1px solid var(--n150)", paddingTop: ".4rem" }}>
                        <span>{toolTag(h.s.req)} · {h.s.label}</span><span>{verdict(h.o).toUpperCase()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="card rise" style={st(2)}>
              <div className="card-hd"><span className="t"><span className="itile"><I.shield /></span>Dharma governance</span><span className="sub">contract address at launch</span></div>
              <div className="card-bd" style={{ display: "grid", gap: "1rem" }}>
                <div className="speed">
                  <div><div className="k">Tighten a rule</div><div className="v">Instant · any member</div></div>
                  <div><div className="k">Loosen a rule</div><div className="v">Vote + 1 min timelock</div></div>
                </div>
                <div className="flow">
                  {["proposed", "public review", "vote", "timelock", "in effect"].map((s, i, a) => (
                    <span key={s} style={{ display: "contents" }}><span className="st">{s}</span>{i < a.length - 1 && <span className="ar">→</span>}</span>
                  ))}
                </div>
                <div className="pills">
                  {defaultRulesMeta.filter((r) => r.core).map((r) => <span key={r.id} className="pill on"><I.lock /> {r.id} · permanent</span>)}
                </div>
              </div>
            </div>

            <div className="card rise" style={st(3)}>
              <div className="card-hd"><span className="t"><span className="itile"><I.pen /></span>Proposals</span><span className="sub">onchain at launch</span></div>
              {PROPOSALS.map((p) => (
                <div className="lrow" key={p.title}>
                  <span className={`chip ${p.kind === "tighten" ? "allow" : "approval"}`}>{p.kind}</span>
                  <div className="main"><div className="a">{p.title}</div><div className="b">{p.by} · {p.when}</div></div>
                  <span className="mono" style={{ fontSize: ".7rem", color: p.kind === "tighten" ? "var(--black)" : "var(--approve)", whiteSpace: "nowrap" }}>{p.status}</span>
                </div>
              ))}
              <div className="legend"><span className="t">Rule of thumb</span><div style={{ fontSize: ".8rem", color: "var(--n600)" }}>Tightening takes effect the moment any member signs it. Loosening is replayed against last week's requests first, then voted on, then waits out the timelock.</div></div>
            </div>
          </div>
        </div>
      </Band>
    </>
  );
}

/* ================= Log ================= */
function Log({ feed }: { feed: FeedItem[] }) {
  const [filter, setFilter] = useState<"all" | Outcome>("all");
  const rows = feed.filter((f) => filter === "all" || f.decision.outcome === filter);
  const c = (o: Outcome) => feed.filter((f) => f.decision.outcome === o).length;
  return (
    <>
      <PageHead
        eyebrow="Decision log"
        title="Every decision,"
        grey={["signed and chained."]}
        lede="In the engine, each entry is ed25519-signed and linked to the one before it, so editing any past decision breaks the chain. In Phase 3 the chain head gets anchored on Arc so it can't be quietly rewound. This console shows a local demo stream."
        facts={[
          { k: "Entries", v: feed.length, s: "this session" },
          { k: "Allowed", v: c("allow"), s: "ran with gatekeeper keys" },
          { k: "Needed a human", v: c("approval"), s: "queued for approval", cls: "warn" },
          { k: "Blocked", v: c("deny"), s: "blank denial to agent", cls: "bad" },
        ]}
      />
      <Band>
        <SecHead eyebrow="Stream" title="karuna · gatekeeper" right={
          <div className="seg">
            {(["all", "allow", "approval", "deny"] as const).map((k) => (
              <button key={k} className={filter === k ? "sel" : ""} onClick={() => setFilter(k)}>{k === "approval" ? "needs human" : k}</button>
            ))}
          </div>
        } />
        <div className="frame rise" style={st(1)}>
          <Gatekeeper rows={rows} hit={rows[0]?.decision.ruleId} title={`karuna · gatekeeper · ${rows.length} entries`} />
          <div className="logbar">
            <span className="ttl"><span className="itile" style={{ background: "#fff", color: "#0a0a0a", width: 28, height: 28 }}><I.doc /></span>Chain head · latest 8 links</span>
            <div className="chain">
              {feed.slice(0, 8).reverse().map((f, i, a) => (
                <span key={f.id} style={{ display: "contents" }}>
                  <span className={`lk ${i === a.length - 1 ? "last" : ""}`}>{f.hash.slice(0, 4)}</span>{i < a.length - 1 && <span className="dash" />}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Band>
    </>
  );
}
