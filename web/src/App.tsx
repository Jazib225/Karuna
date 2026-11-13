import { useEffect, useRef, useState } from "react";
import { evaluate } from "./engine/engine.ts";
import { bakeryContext } from "./engine/rules.ts";
import type { Outcome, Request } from "./engine/types.ts";

const GITHUB = "https://github.com/karuna-protocol";
const ctx = bakeryContext();

/* -------- scroll reveal -------- */
function Reveal({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const io = new IntersectionObserver(
      ([e]) => e.isIntersecting && (el.classList.add("in"), io.disconnect()),
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`reveal ${className}`}>
      {children}
    </div>
  );
}

const RULE_NAMES = [
  ["core-boundary", "deny"], ["secrets-read", "deny"], ["unknown-recipient", "deny"],
  ["payment-within-allowance", "allow"], ["payment-approval", "approval"], ["destructive-shell", "approval"],
  ["package-install", "approval"], ["human-approval-writes", "approval"], ["allowlisted-domain", "allow"],
  ["http-mutations", "approval"], ["unlisted-domain", "deny"], ["workspace-read", "allow"], ["default-deny", "deny"],
] as const;

/* -------- gatekeeper mock panel (hero) -------- */
const HERO_ROWS: { act: string; pol: string; out: Outcome; hash: string }[] = [
  { act: "GET api.stripe.com/v1/balance", pol: "allowlisted-domain", out: "allow", hash: "a41f…0c2e" },
  { act: "send 900 USDC → Golden Mills", pol: "payment-approval", out: "approval", hash: "9c0e…71ab" },
  { act: "cat .env", pol: "secrets-read", out: "deny", hash: "3f9a…c21e" },
  { act: "ls ./workspace", pol: "workspace-read", out: "allow", hash: "5b17…2d4e" },
  { act: "send 50 USDC → 0xabc…", pol: "unknown-recipient", out: "deny", hash: "8672…66a2" },
];

function Panel() {
  return (
    <div className="panel">
      <div className="panel-bar">
        <span className="tl"><i /><i /><i /></span>
        <span className="title">gatekeeper · maya's bakery</span>
      </div>
      <div className="panel-body">
        {HERO_ROWS.map((r) => (
          <div className="row" key={r.act}>
            <span className={`chip ${r.out}`}>{r.out === "approval" ? "require approval" : r.out}</span>
            <span className="act">{r.act}</span>
            <span className="pol">{r.hash}</span>
          </div>
        ))}
      </div>
      <div className="panel-foot">
        <span>12 rules · first match decides</span>
        <span>● decision log signed</span>
      </div>
    </div>
  );
}

/* -------- playground (wired to the real engine) -------- */
const SAMPLES: { label: string; req: Request }[] = [
  { label: "ls ./workspace", req: { tool: "shell", command: "ls ./workspace" } },
  { label: "GET api.stripe.com/v1/balance", req: { tool: "http", method: "GET", url: "https://api.stripe.com/v1/balance" } },
  { label: "rm -rf ./data", req: { tool: "shell", command: "rm -rf ./data" } },
  { label: "send 50 USDC to 0xabc…", req: { tool: "payment", agent: "research", to: "0xabc", amountUsd: 50 } },
  { label: "cat .env", req: { tool: "shell", command: "cat .env" } },
];

function Playground() {
  const [sel, setSel] = useState(0);
  const [shown, setShown] = useState<{ out: Outcome; rule: string } | null>(null);
  const run = () => {
    const d = evaluate(SAMPLES[sel].req, ctx);
    setShown({ out: d.outcome, rule: d.ruleId });
  };
  useEffect(() => setShown(null), [sel]);
  const tag = shown?.out === "approval" ? "require approval" : shown?.out;
  return (
    <div className="play">
      <div className="play-head">
        <strong>Proposed action</strong>
        <span className="muted mono" style={{ fontSize: "0.75rem" }}>runs in your browser</span>
      </div>
      <div className="play-opts">
        {SAMPLES.map((s, i) => (
          <button key={s.label} className={`opt ${i === sel ? "sel" : ""}`} onClick={() => setSel(i)}>
            <span className="radio" />
            {s.label}
          </button>
        ))}
      </div>
      <div className="play-foot">
        {shown ? (
          <span className={`verdict ${shown.out}`}>
            <span className="tag">{tag}</span>
            <span className="rule">matched <b>{shown.rule}</b></span>
          </span>
        ) : (
          <span className="muted mono" style={{ fontSize: "0.82rem" }}>first matching rule decides</span>
        )}
        <button className="btn btn-primary btn-sm" onClick={run}>Evaluate →</button>
      </div>
    </div>
  );
}

/* -------- quickstart code -------- */
const PY = `from karuna import Karuna, Policy

karuna = Karuna(policy=Policy.small_business())

@karuna.guard(tool="shell")
def run(cmd: str) -> str:
    return shell(cmd)

# the agent proposes; Karuna decides
run("rm -rf ./data")   # -> requires approval`;

const TS = `import { Karuna, Policy } from "@karunaprotocol/karuna";

const karuna = new Karuna({ policy: Policy.smallBusiness() });

const run = karuna.guard("shell", (cmd: string) => shell(cmd));

// the agent proposes; Karuna decides
await run("rm -rf ./data"); // -> requires approval`;

function Quickstart() {
  const [tab, setTab] = useState<"py" | "ts">("py");
  const [copied, setCopied] = useState(false);
  const install = tab === "py" ? "pip install karuna" : "npm i @karunaprotocol/karuna";
  const copy = () => {
    navigator.clipboard?.writeText(install);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div>
      <div className="code">
        <div className="code-bar">
          <span className={`code-tab ${tab === "py" ? "sel" : ""}`} onClick={() => setTab("py")}>Python</span>
          <span className={`code-tab ${tab === "ts" ? "sel" : ""}`} onClick={() => setTab("ts")}>TypeScript</span>
        </div>
        <pre>{tab === "py" ? PY : TS}</pre>
      </div>
      <div className="install">
        <span>$ {install}</span>
        <button className="copy" onClick={copy}>{copied ? "copied" : "copy"}</button>
      </div>
    </div>
  );
}

/* ======================================================================= */
export default function App() {
  return (
    <>
      <nav className="nav">
        <div className="wrap nav-inner">
          <a href="#top" className="nav-logo"><span className="mark">⬡</span> Karuna</a>
          <div className="nav-links">
            <a href="#product" className="hide-sm">Product</a>
            <a href="#governance" className="hide-sm">Governance</a>
            <a href={GITHUB} className="hide-sm">Docs</a>
            <a href="#waitlist" className="btn btn-primary btn-sm">Join the waitlist</a>
          </div>
        </div>
      </nav>

      {/* hero */}
      <header className="hero" id="top">
        <div className="hero-bg" />
        <div className="wrap hero-grid">
          <div>
            <span className="badge"><span className="dot" /> Now onboarding design partners →</span>
            <h1>An agent's competence should never be its permission.</h1>
            <p className="hero-sub">
              Karuna is a permission layer for autonomous AI agents. The agent proposes an action.
              Karuna decides whether it happens. Your team decides what Karuna allows.
            </p>
            <div className="hero-cta">
              <a href="#waitlist" className="btn btn-primary">Join the waitlist</a>
              <a href={GITHUB} className="btn btn-ghost">Read the docs →</a>
            </div>
          </div>
          <Reveal><Panel /></Reveal>
        </div>
      </header>

      {/* problem */}
      <section className="section-line" id="problem">
        <div className="wrap two">
          <Reveal>
            <span className="eyebrow">The problem</span>
            <h2 style={{ margin: "0.8rem 0 1rem" }}>Agents that police themselves.</h2>
            <p className="lead">
              AI agents are starting to run code, move money, and act on the internet with little
              supervision. Most of them hold their own credentials and police themselves.
            </p>
            <p className="mono" style={{ marginTop: "1.4rem", color: "var(--n600)", fontSize: "0.85rem" }}>
              The agent proposes. Karuna decides. People set the rules.
            </p>
          </Reveal>
          <Reveal>
            <div className="panel">
              <div className="panel-bar"><span className="tl"><i /><i /><i /></span><span className="title">unguarded agent</span></div>
              <div className="panel-body" style={{ padding: "0.9rem" }}>
                <div className="mono" style={{ color: "var(--ink-dim)", fontSize: "0.78rem", lineHeight: 1.9 }}>
                  <div>$ load credentials from .env  ✓</div>
                  <div>$ transfer 2,400 USDC  <span style={{ color: "#ff8a80" }}>ran · no check</span></div>
                  <div>$ POST unknown-api.sh/exfil  <span style={{ color: "#ff8a80" }}>ran · no check</span></div>
                  <div>$ rm -rf ./backups  <span style={{ color: "#ff8a80" }}>ran · no check</span></div>
                </div>
              </div>
              <div className="panel-foot"><span>policy: none · approvals: none · log: none</span></div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* the boundary */}
      <section className="section-line" style={{ textAlign: "center" }}>
        <div className="wrap">
          <Reveal>
            <span className="eyebrow">The boundary</span>
            <h2 style={{ margin: "0.8rem 0 0" }}>Every action meets the boundary.</h2>
            <div className="boundary">
              <div className="gate deny"><div className="glyph">✕</div><div className="label">deny</div></div>
              <span className="gate-arrow">→</span>
              <div className="gate approve"><div className="glyph">◷</div><div className="label">require approval</div></div>
              <span className="gate-arrow">→</span>
              <div className="gate allow"><div className="glyph">✓</div><div className="label">allow</div></div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* product: isolate decide record */}
      <section className="section-line" id="product">
        <div className="wrap">
          <Reveal>
            <span className="eyebrow">Product</span>
            <h2 style={{ margin: "0.8rem 0 0" }}>Isolate. Decide. Record.</h2>
          </Reveal>
          <div className="steps">
            {[
              ["01", "Isolate", "Agents run in a sandbox with no network access, no keys, and no memory between tasks."],
              ["02", "Decide", "Every action goes through a small, deterministic policy engine and a gatekeeper that holds all credentials."],
              ["03", "Record", "Every decision is signed and written to a tamper-evident log."],
            ].map(([n, t, d]) => (
              <Reveal key={n}><div className="step"><div className="num">{n}</div><h3>{t}</h3><p>{d}</p></div></Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* playground */}
      <section className="section-line" id="playground">
        <div className="wrap two">
          <Reveal>
            <span className="eyebrow">Playground</span>
            <h2 style={{ margin: "0.8rem 0 1rem" }}>Try it.</h2>
            <p className="lead">
              Pick a proposed action and evaluate it against the default policy. The first matching
              rule decides — and this runs the real engine, right in your browser.
            </p>
            <div className="rules" style={{ marginTop: "1.6rem" }}>
              {RULE_NAMES.map(([n, o], i) => (
                <div className="r" key={n}><span className="i">{i + 1}</span><span>{n}</span><span className={`o ${o}`}>{o}</span></div>
              ))}
            </div>
          </Reveal>
          <Reveal><Playground /></Reveal>
        </div>
      </section>

      {/* quickstart */}
      <section className="section-line" id="quickstart">
        <div className="wrap two">
          <Reveal>
            <span className="eyebrow">Quickstart</span>
            <h2 style={{ margin: "0.8rem 0 1rem" }}>Guard a tool call in ten lines.</h2>
            <p className="lead">Wrap any tool with <code>@karuna.guard</code>. The agent proposes; Karuna decides. Model-agnostic, framework-agnostic.</p>
            <div style={{ marginTop: "1.4rem", display: "flex", gap: "1rem", fontSize: "0.85rem" }}>
              <a href="https://pypi.org/project/karuna" className="muted">PyPI</a>
              <a href="https://www.npmjs.com/package/@karunaprotocol/karuna" className="muted">npm</a>
              <a href={GITHUB} className="muted">Follow on GitHub →</a>
            </div>
          </Reveal>
          <Reveal><Quickstart /></Reveal>
        </div>
      </section>

      {/* compatibility */}
      <section className="section-line">
        <div className="wrap">
          <Reveal>
            <span className="eyebrow">Compatibility</span>
            <h2 style={{ margin: "0.8rem 0 0.6rem" }}>Model-agnostic.</h2>
            <p className="lead">Works with Claude, GPT, Gemini, and open-weight models, and plugs into LangChain, CrewAI, and any MCP server.</p>
            <div className="compat">
              {["Claude", "OpenAI", "Google Gemini", "LangChain", "CrewAI", "MCP", "Open-weight models"].map((x) => (
                <span className="pill" key={x}>{x}</span>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* governance / dharma */}
      <section className="section-line" id="governance">
        <div className="wrap two">
          <Reveal>
            <span className="eyebrow">Governance</span>
            <h2 style={{ margin: "0.8rem 0 1rem" }}>Policies live onchain, in a public ledger called Dharma.</h2>
            <p className="lead">
              A core set of boundaries can never be removed. Everything else is governed by people.
              Tightening a rule is fast. Loosening one is slow and public.
            </p>
            <p className="muted" style={{ marginTop: "1rem", fontSize: "0.95rem" }}>
              No company, including us, can quietly loosen the rules. Every change is proposed, voted
              on, and recorded onchain where anyone can verify it.
            </p>
            <div className="gov-flow">
              {["proposed", "public review", "vote", "timelock", "in effect"].map((n, i, a) => (
                <span key={n} style={{ display: "contents" }}>
                  <span className="node">{n}</span>{i < a.length - 1 && <span className="arr">→</span>}
                </span>
              ))}
            </div>
          </Reveal>
          <Reveal>
            <div>
              <div className="gov-cards">
                <div className="gov-card"><div className="k">Core boundaries</div><div className="v">Can never be removed</div></div>
                <div className="gov-card fast"><div className="k">Tighten a rule</div><div className="v">Fast</div></div>
                <div className="gov-card slow"><div className="k">Loosen a rule</div><div className="v">Slow &amp; public</div></div>
                <div className="gov-card"><div className="k">Anchored on</div><div className="v">Arc (Circle)</div></div>
              </div>
              <div className="blocks">
                <div className="b"><span className="h">block 1</span> a41f…0c2e</div>
                <div className="b"><span className="h">block 2</span> 9c0e…71ab</div>
                <div className="b"><span className="h">block 3</span> 3f9a…c21e</div>
              </div>
              <p className="muted mono" style={{ fontSize: "0.72rem", marginTop: "0.8rem" }}>Chain and contract address published here at launch.</p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* pricing */}
      <section className="section-line" id="pricing">
        <div className="wrap" style={{ textAlign: "center" }}>
          <Reveal>
            <span className="eyebrow">Pricing</span>
            <h2 style={{ margin: "0.8rem 0 0" }}>Open core.</h2>
          </Reveal>
          <div className="price-grid" style={{ textAlign: "left" }}>
            <Reveal>
              <div className="price">
                <span className="eyebrow">Developers</span>
                <div className="amt">Free</div>
                <ul><li>SDK with local policy engine</li><li>Signed decision log</li><li>Model &amp; framework agnostic</li></ul>
                <a href={GITHUB} className="btn btn-ghost btn-sm" style={{ alignSelf: "start" }}>View on GitHub →</a>
              </div>
            </Reveal>
            <Reveal>
              <div className="price dark">
                <span className="eyebrow" style={{ color: "var(--ink-dim)" }}>Organizations</span>
                <div className="amt">Coming soon</div>
                <ul><li>Hosted Gatekeeper &amp; human approvals</li><li>Shared policies &amp; Dharma governance</li><li>Central, tamper-evident audit trail</li></ul>
                <a href="#waitlist" className="btn btn-primary btn-sm" style={{ alignSelf: "start" }}>Join the waitlist</a>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* waitlist */}
      <section className="section-line" id="waitlist">
        <div className="wrap" style={{ maxWidth: 560, textAlign: "center" }}>
          <Reveal>
            <h2>Put your agents inside boundaries you control.</h2>
            <form className="wl" onSubmit={(e) => { e.preventDefault(); alert("Thanks — this is a demo build. Join the real waitlist at karunaprotocol.dev"); }}
              style={{ display: "grid", gap: "0.7rem", marginTop: "1.6rem", textAlign: "left" }}>
              <input required type="email" placeholder="Work email" style={inp} />
              <input placeholder="Company (optional)" style={inp} />
              <input placeholder="Website" style={inp} />
              <label className="muted" style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.9rem" }}>
                <input type="checkbox" /> Interested in being a design partner
              </label>
              <button className="btn btn-primary" type="submit">Join the waitlist</button>
            </form>
          </Reveal>
        </div>
      </section>

      {/* footer */}
      <footer className="footer">
        <div className="wrap footer-inner">
          <div>
            <div className="nav-logo" style={{ marginBottom: "0.6rem" }}><span className="mark">⬡</span> Karuna</div>
            <div>Founded by Adi Chaudhary and Jazib Qureshi</div>
            <div style={{ marginTop: "0.4rem" }}>© 2026 Karuna.</div>
          </div>
          <div style={{ display: "flex", gap: "1.4rem" }}>
            <a href="#top">Careers</a>
            <a href={GITHUB}>GitHub</a>
            <a href="mailto:hello@karunaprotocol.dev">Contact</a>
          </div>
        </div>
      </footer>
    </>
  );
}

const inp: React.CSSProperties = {
  width: "100%", padding: "0.7rem 0.9rem", borderRadius: "0.5rem",
  border: "1px solid var(--line-strong)", fontFamily: "var(--font-sans)", fontSize: "0.95rem", background: "#fff",
};
