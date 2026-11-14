import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { Address } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { isAddr, decodeChange, describeChange, describeScope, waitText, type Change } from "@prekaruna/dharma";
import { api, useGatekeeper, type LooseningPreview, type AgentView, type Governance, type LogEntry, type Proposal, type Rule, type Snapshot, type WalletInfo } from "./api.ts";
import { Kind, SignerUnavailable, decidePayment, loadSigner, submitChange } from "./signer.ts";
import { useRelay, type ChainEvent, type LiveMode } from "./live.ts";
import { Palette, type Command } from "./palette.tsx";
import { keccak256, stringToHex } from "viem";
import { PREVIEW, previewLog, previewSigner, previewSnapshot, previewWallet } from "./preview.ts";
import { Badge, Icon, type IconName } from "./icons.tsx";
import { IN_APP, getIslandEnabled, setDesktopSigner, setIslandEnabled } from "./desktop.ts";
import { setThemePref, useThemePref, type ThemePref } from "./theme.ts";
import { eventName, NAMED_KEYS } from "./eventNames.ts";

// One job per page. The menu groups them: everyday work first, then the automatic safety systems,
// settings, and a testing tool. Older names (pop-ups, saved state) still resolve.
type Page = "overview" | "approvals" | "votes" | "agents" | "payees" | "activity" | "shield" | "swarm" | "rules" | "keys" | "team" | "appearance" | "inbox";
type View = Page | "dharma" | "safety" | "policy";
const PAGE_OF: Record<View, Page> = {
  overview: "overview", approvals: "approvals", votes: "votes", agents: "agents", payees: "payees", activity: "activity",
  shield: "shield", swarm: "swarm", rules: "rules", keys: "keys", team: "team", appearance: "appearance", inbox: "inbox",
  dharma: "votes", safety: "shield", policy: "rules",
};
const TITLES: Record<Page, string> = {
  overview: "Home", approvals: "Approvals", votes: "Votes", agents: "Agents", payees: "Payments", activity: "Activity",
  shield: "Drills", swarm: "Tripwire", rules: "Rules", keys: "Keys", team: "Team", appearance: "Appearance", inbox: "Inbox",
};
const ICON: Record<Page, IconName> = {
  overview: "home", approvals: "approvals", votes: "votes", agents: "agents", payees: "payees", activity: "activity",
  shield: "shield", swarm: "swarm", rules: "rules", keys: "key", team: "team", appearance: "sun", inbox: "inbox",
};
/** One line under each page title: what the page is for. */
const LEDE: Record<Page, string> = {
  overview: "",
  approvals: "",
  votes: "",
  agents: "",
  payees: "",
  activity: "",
  shield: "",
  swarm: "",
  rules: "",
  keys: "",
  appearance: "",
  team: "",
  inbox: "",
};
const NAV: { label: string | null; hint?: string; pages: Page[] }[] = [
  { label: null, pages: ["overview", "approvals", "votes", "agents", "payees", "activity"] },
  { label: "Safety", pages: ["shield", "swarm", "inbox"] },
  { label: "Settings", pages: ["rules", "keys", "team", "appearance"] },
];
/** Arc explorer link for a transaction hash (payments, Dharma writes, freezes, anchors). */
const isTx = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
function TxLink({ tx, s }: { tx: unknown; s: Snapshot }) {
  if (!isTx(tx) || !s.org.dharma) return null;
  return <a className="txlink" href={`${s.org.dharma.explorer.replace(/\/address\/.*$/, "")}/tx/${tx}`} target="_blank" rel="noreferrer" title={tx}>Arc tx <Icon name="external" size={12} /></a>;
}
/** Info boxes people can close for good (remembered in this browser only). */
const dismissKey = (id: string) => `karuna.dismissed.${id}`;
function isDismissed(id: string): boolean {
  try {
    return localStorage.getItem(dismissKey(id)) === "1";
  } catch {
    return false;
  }
}
function dismiss(id: string) {
  try {
    localStorage.setItem(dismissKey(id), "1");
  } catch {
    /* per-browser convenience only */
  }
}
function DismissX({ onClick }: { onClick: () => void }) {
  return <button type="button" className="dismiss-x" aria-label="Close" title="Close" onClick={onClick}><Icon name="x" size={14} /></button>;
}
function InfoBox({ id, icon, children }: { id: string; icon: IconName; children: ReactNode }) {
  const [hidden, setHidden] = useState(() => isDismissed(id));
  if (hidden) return null;
  return (
    <div className="card rise">
      <div className="intro">
        <span className="intro-mark"><Icon name={icon} size={18} /></span>
        {children}
        <DismissX onClick={() => (dismiss(id), setHidden(true))} />
      </div>
    </div>
  );
}
function Empty({ icon, children }: { icon: IconName; children: ReactNode }) {
  return <div className="empty"><span className="empty-mark"><Icon name={icon} size={18} /></span><p>{children}</p></div>;
}
function Backdrop() {
  return <div className="backdrop" aria-hidden><div className="glow" /><div className="dots" /><div className="rails" /></div>;
}
function Loading({ text }: { text: string }) {
  return <div className="center"><Backdrop /><div className="loading"><img src="/brand/lotus.png" alt="" /><span className="shimmer mono small">{text}</span></div></div>;
}

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

/** Dev-only (?preview[=frozen|setup|join|offline]): sample data, no Gatekeeper, nothing sent. */
function usePreviewGatekeeper() {
  const mode = new URLSearchParams(location.search).get("preview");
  const state: Snapshot = mode === "setup"
    ? { ...previewSnapshot, setUp: false, policy: null }
    : mode === "join"
      ? { ...previewSnapshot, policy: { ...previewSnapshot.policy!, members: previewSnapshot.policy!.members.slice(1) } }
      : mode === "frozen"
        ? { ...previewSnapshot, frozen: { by: "Sam", at: new Date().toISOString(), confirmed: true } }
        : previewSnapshot;
  const offline = mode === "offline" ? "connect ECONNREFUSED 127.0.0.1:8788" : null;
  return { state: offline ? null : state, log: previewLog, wallet: previewWallet, offline, refresh: async () => {}, refreshWallet: () => {} };
}
const useConsoleData = PREVIEW ? usePreviewGatekeeper : useGatekeeper;

export default function App() {
  const gk = useConsoleData();
  const signer = useMemo<{ me: PrivateKeyAccount | null; error: string | null }>(() => {
    if (PREVIEW) return { me: previewSigner, error: null };
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
    if (PREVIEW) {
      notify("ok", `Preview — nothing was sent${ok ? ` (would show: “${ok}”)` : ""}`);
      return false;
    }
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
  // Desktop app: the island's approvals are signed by this window's member key (see desktop.ts).
  const memberAddr = signer.me?.address.toLowerCase();
  const isMember = !!s?.policy?.members.some((m) => m.address === memberAddr);
  useEffect(() => setDesktopSigner(signer.me, (s?.org.dharma?.address as Address | undefined) ?? null, isMember), [signer.me, s?.org.dharma?.address, isMember]);
  if (!s && gk.offline) body = <Offline reason={gk.offline} />;
  else if (!s) body = <Loading text="Connecting to the Gatekeeper…" />;
  else if (!signer.me) body = <div className="center"><Backdrop /><div className="onboard narrow"><div className="onboard-body"><h2 className="setup-title heading-gradient">No signing key</h2><p className="lede">{signer.error}</p></div></div></div>;
  else if (!s.setUp) body = <Setup s={s} me={signer.me} run={run} busy={busy} />;
  else if (!s.policy) body = <Loading text="Reading Dharma from Arc…" />;
  else if (!s.policy.members.some((m) => m.address === signer.me!.address.toLowerCase())) body = <Join s={s} me={signer.me} run={run} />;
  else body = <Console s={s} log={gk.log} wallet={gk.wallet} run={run} busy={busy} me={signer.me} offline={gk.offline} refresh={gk.refresh} />;

  return (
    <>
      {body}
      {busy && <div className="busy-bar" />}
      {flash && (
        <div role="status" className={`flash ${flash.kind}`} onClick={() => setFlash(null)}>
          <Icon name={flash.kind === "ok" ? "check" : "alert"} size={16} />{flash.text}
        </div>
      )}
    </>
  );
}

function OnboardTop({ sub }: { sub: string }) {
  return (
    <div className="onboard-top">
      <img className="lockup" src="/brand/lockup-transparent.png" alt="Karuna" />
      <span className="sub">{sub}</span>
    </div>
  );
}

function Offline({ reason }: { reason: string }) {
  return (
    <div className="center">
      <Backdrop />
      <div className="onboard narrow rise">
        <OnboardTop sub="offline" />
        <div className="onboard-body">
          <div>
            <p className="eyebrow">Gatekeeper not reachable</p>
            <h2 className="setup-title heading-gradient" style={{ marginTop: 14 }}>Start the Gatekeeper</h2>
            <p className="lede">The console only shows what the Gatekeeper reports. Start it, and this page connects on its own.</p>
          </div>
          <pre className="snippet">pnpm --dir gatekeeper start</pre>
          <p className="muted small mono"><span className="shimmer">Retrying</span> · {reason}</p>
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
    if (PREVIEW) {
      setDetected([previewWallet.address]);
      setForm((f) => ({ ...f, walletAddress: previewWallet.address }));
      return;
    }
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
      <Backdrop />
      <form className="onboard narrow rise" onSubmit={submit}>
        <OnboardTop sub="First-time setup" />
        <div className="onboard-body">
          <div>
            <p className="eyebrow">Deploy your rulebook on Arc</p>
            <h2 className="setup-title heading-gradient" style={{ marginTop: 14 }}>Set up your organization</h2>
            <p className="lede">Karuna deploys your organization's own <b>Dharma</b> rulebook on Arc. Every rule change needs your team's vote and a short waiting period; only the panic button acts instantly. You'll be its first member.</p>
          </div>
          <label className="field">
            <span>Organization name</span>
            <input required autoFocus value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} placeholder="Your company" />
          </label>
          <label className="field">
            <span>Your name</span>
            <input required value={form.memberName} onChange={(e) => setForm({ ...form, memberName: e.target.value })} placeholder="First approver" />
            <small>Kept private by your Gatekeeper. Names never go onchain.</small>
          </label>
          <div className="field">
            <span>Wallet the Gatekeeper pays from</span>
            {detected && detected.length > 0 && (
              <div className="choices" role="radiogroup">
                {detected.map((w) => (
                  <button type="button" role="radio" aria-checked={form.walletAddress === w} key={w} className={`choice ${form.walletAddress === w ? "sel" : ""}`} onClick={() => setForm({ ...form, walletAddress: w })}>
                    <span className="radio" /> <span className="mono">{short(w)}</span><span className="tag">Circle · Arc testnet</span>
                  </button>
                ))}
              </div>
            )}
            <input required aria-label="Wallet address" className="mono" value={form.walletAddress} onChange={(e) => setForm({ ...form, walletAddress: e.target.value.trim() })} placeholder="0x… Circle agent wallet on Arc testnet" />
            <small>
              {detected === null
                ? <span className="shimmer">Looking for Circle agent wallets on this machine…</span>
                : detected.length
                  ? `Found ${detected.length} Circle agent wallet${detected.length > 1 ? "s" : ""} logged in on this machine. It also pays to deploy Dharma.`
                  : <>No logged-in Circle wallet found{detectErr ? ` (${detectErr})` : ""}. Run <span className="mono">circle wallet login &lt;email&gt; --testnet</span></>}
            </small>
          </div>
          <div className="keybox">
            <span className="field-label"><Icon name="key" size={14} /> Your signing key · made in this browser</span>
            <div className="mono">{me.address}</div>
            <div className="small muted">Every vote and approval you make is signed with it, here. Keep using this browser for Karuna.</div>
          </div>
          <button className="btn btn-dark btn-lg btn-block" type="submit" disabled={deploying}>
            {deploying ? <span className="shimmer">Deploying Dharma on Arc…</span> : <>Create organization <span className="nudge"><Icon name="arrow" size={16} /></span></>}
          </button>
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
      <Backdrop />
      <form className="onboard narrow rise" onSubmit={(e) => { e.preventDefault(); run(() => api("/access-request", { address: me.address, name }), "Request sent"); }}>
        <OnboardTop sub={s.org.name} />
        <div className="onboard-body">
          <div>
            <p className="eyebrow">Not a member yet</p>
            <h2 className="setup-title heading-gradient" style={{ marginTop: 14 }}>Ask to join {s.org.name}</h2>
            <p className="lede">Members sign every approval and policy change with a key in their own browser. A current member proposes adding you, and Dharma adds you after the vote and a {s.policy!.timelock}s wait.</p>
          </div>
          <div className="keybox"><span className="field-label"><Icon name="key" size={14} /> This browser's signing key</span><div className="mono">{me.address}</div></div>
          {requested ? (
            <p className="ok-text"><Icon name="check" /> Request sent. A member will see it under Team.</p>
          ) : (
            <>
              <label className="field"><span>Your name</span><input required value={name} onChange={(e) => setName(e.target.value)} placeholder="So teammates recognize you" /></label>
              <button className="btn btn-dark btn-lg btn-block">Ask to join <span className="nudge"><Icon name="arrow" size={16} /></span></button>
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
  const setView = (v: View) => {
    setPage(PAGE_OF[v] ?? "overview");
    window.scrollTo({ top: 0 });
  };
  const [menu, setMenu] = useState(false);
  const [sideHidden, setSideHidden] = useState(() => {
    try {
      return localStorage.getItem("karuna.sidebar") === "hidden";
    } catch {
      return false;
    }
  });
  const [palette, setPalette] = useState(false);
  const topbar = useRef<HTMLElement>(null);
  // Keep the search bar centered on the whole window, sidebar or not, and the same on every page:
  // its width depends only on the window and the buttons on the right (never on the page title).
  useEffect(() => {
    const bar = topbar.current;
    if (!bar) return;
    const fit = () => {
      const b = bar.getBoundingClientRect();
      const r = bar.querySelector(".right")?.getBoundingClientRect();
      if (!r) return;
      const mid = window.innerWidth / 2;
      const room = 2 * (r.left - mid) - 32;
      bar.style.setProperty("--search-x", `${mid - b.left}px`);
      bar.style.setProperty("--search-w", `${Math.max(150, Math.min(340, room))}px`);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(bar);
    const right = bar.querySelector(".right");
    if (right) ro.observe(right);
    fit();
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((o) => !o);
        return;
      }
      // ← / →: previous / next page in the sidebar, unless you are typing or a dialog is open.
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const t = e.target as HTMLElement | null;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        if (document.querySelector(".palette-scrim")) return;
        e.preventDefault();
        const order = NAV.flatMap((g) => g.pages);
        setPage((cur) => order[(order.indexOf(cur) + (e.key === "ArrowRight" ? 1 : -1) + order.length) % order.length]);
        window.scrollTo({ top: 0 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const toggleSide = () => {
    const next = !sideHidden;
    setSideHidden(next);
    setMenu(false);
    try {
      localStorage.setItem("karuna.sidebar", next ? "hidden" : "pinned");
    } catch {
      /* per-browser convenience only */
    }
  };
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);
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
            go: swarm ? "swarm" : "shield", cta: swarm ? "Tripwire" : "Drills",
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

  // ---- Ctrl+K: every page, then the common actions
  const commands: Command[] = [
    ...NAV.flatMap((g) => g.pages.map((v) => ({ id: `go-${v}`, label: TITLES[v], hint: g.label ?? "Go to", icon: ICON[v], keywords: v, run: () => setView(v) }))),
    ...(pending.length ? [{ id: "review", label: `Review ${pending.length} waiting approval${pending.length > 1 ? "s" : ""}`, hint: "Approvals", icon: "approvals" as IconName, run: () => setView("approvals") }] : []),
    ...(ballots.length ? [{ id: "vote", label: `Vote on ${ballots.length} open change${ballots.length > 1 ? "s" : ""}`, hint: "Votes", icon: "votes" as IconName, run: () => setView("votes") }] : []),
    { id: "new-rule", label: "Add a rule", hint: "Rules", icon: "plus", keywords: "policy block allow approval english", run: () => setView("rules") },
    { id: "new-agent", label: "Add an agent", hint: "Agents", icon: "plus", keywords: "token", run: () => setView("agents") },
    { id: "new-key", label: "Add an API key", hint: "Keys", icon: "key", keywords: "secret anthropic gemini openai", run: () => setView("keys") },
    { id: "waits", label: "Change the waits", hint: "Votes", icon: "clock", keywords: "timelock core", run: () => setView("votes") },
    ...(["system", "light", "dark"] as const).map((t) => ({ id: `theme-${t}`, label: `Theme: ${t === "system" ? "System" : t === "light" ? "Light" : "Dark"}`, hint: "Appearance", icon: "sun" as IconName, keywords: "dark light mode appearance", run: () => setThemePref(t) })),
    ...(IN_APP ? [{ id: "island", label: getIslandEnabled() ? "Turn the island off" : "Turn the island on", hint: "Appearance", icon: "sun" as IconName, keywords: "notch lotus", run: () => setIslandEnabled(!getIslandEnabled()) }] : []),
    { id: "sidebar", label: sideHidden ? "Pin the sidebar" : "Hide the sidebar", hint: "View", icon: sideHidden ? "pin" : "panel", keywords: "menu nav", run: toggleSide },
    ...(frozen
      ? [{ id: "unfreeze", label: "Unfreeze agents (goes to a vote)", hint: "Safety", icon: "stop" as IconName, run: () => (openUnfreeze ? setView("votes") : void ctx.change({ op: "Unfreeze" })) }]
      : [{ id: "freeze", label: "Freeze all agents", hint: "Safety", icon: "stop" as IconName, keywords: "panic stop", run: () => confirm("Freeze every agent now? Unfreezing needs a vote.") && void ctx.change({ op: "Freeze" }) }]),
  ];


  return (
    <div className={`app ${sideHidden ? "side-hidden" : ""}`}>
      <div className={`scrim ${menu ? "open" : ""}`} onClick={() => setMenu(false)} aria-hidden />
      <Palette open={palette} onClose={() => setPalette(false)} commands={commands} />
      <aside className={`sidebar ${menu ? "open" : ""}`} id="console-nav">
        <div className="brand-row">
          <img className="lockup" src="/brand/lockup-transparent.png" alt="Karuna" />
          <button type="button" className="side-toggle" onClick={toggleSide} aria-label={sideHidden ? "Pin sidebar" : "Hide sidebar"} title={sideHidden ? "Pin sidebar" : "Hide sidebar"}>
            <Icon name={sideHidden ? "pin" : "panel"} size={16} />
          </button>
        </div>
        <div className="org">
          <b title={s.org.name}>{s.org.name}</b>
          <a href={s.org.dharma!.explorer} target="_blank" rel="noreferrer" title="Dharma contract on Arc">Dharma {short(s.org.dharma!.address)} <Icon name="external" size={11} /></a>
        </div>
        <nav className="nav" aria-label="Console" onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          const links = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>("a")];
          const i = links.indexOf(document.activeElement as HTMLAnchorElement);
          if (i < 0) return;
          e.preventDefault();
          links[(i + (e.key === "ArrowDown" ? 1 : -1) + links.length) % links.length].focus();
        }}>
          {NAV.map((g) => (
            <div key={g.label ?? "main"} className="nav-group">
              {g.label && <div className="nav-label">{g.label}{g.hint && <span> · {g.hint}</span>}</div>}
              {g.pages.map((v) => {
                const n = v === "approvals" ? pending.length : v === "votes" ? ballots.length : v === "team" ? s.enrollments.length
                  : v === "shield" ? s.shield.autoRules.filter((r) => r.active).length : v === "swarm" ? s.swarm.tainted.length : 0;
                return (
                  <a key={v} href={`#${v}`} aria-current={view === v ? "page" : undefined} className={view === v ? "sel" : ""}
                    onClick={(e) => { e.preventDefault(); setView(v); setMenu(false); }}>
                    <Icon name={ICON[v]} /> {TITLES[v]}
                    {n > 0 && <span className={`count ${v === "team" ? "info" : ""}`}>{n}</span>}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="member" title="This browser's signing key">
          <span className="av">{myName[0]?.toUpperCase()}</span>
          <div className="who"><div>{myName}</div><div>{short(myAddr)}</div></div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar" ref={topbar}>
          <div className="left">
            <button className="menu-btn" aria-label="Open menu" aria-expanded={menu} aria-controls="console-nav" onClick={() => setMenu(true)}><Icon name="menu" size={20} /></button>
            <div className="title">
              <span className="eyebrow">{NAV.find((g) => g.pages.includes(view))?.label ?? s.org.name}</span>
              <h1>{TITLES[view]}</h1>
            </div>
          </div>
          <button type="button" className="top-search" onClick={() => setPalette(true)} aria-label="Search or jump to (Ctrl+K)">
            <Icon name="search" size={15} />
            <span>Search or jump to…</span>
            <kbd>Ctrl K</kbd>
          </button>
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
              <button className="panic" disabled={busy} title="Freezes every agent at once. Unfreezing needs a vote." onClick={() => ctx.change({ op: "Freeze" })}><Icon name="stop" /> Freeze all agents</button>
            )}
          </div>
        </header>

        <div className="alerts">
          {alerts.map((a) => (
            <div key={a.id} role="status" className={`alert ${a.tone}`}>
              <span className="alert-icon"><Icon name={a.tone === "bad" ? "alert" : a.tone === "ok" ? "check" : a.go === "approvals" ? "approvals" : a.go === "dharma" ? "votes" : "signal"} size={15} /></span>
              <div className="alert-top">
                <b>{a.title}</b>
                <span className="via">{a.source === "quicknode" ? "via QuickNode" : a.source === "rpc" && (a.go === "shield" || a.go === "swarm") ? "Gatekeeper" : "via Arc RPC"}</span>
              </div>
              <button className="alert-x" aria-label="Dismiss" onClick={() => dismiss(a.id)}><Icon name="x" size={14} /></button>
              <div className="alert-body">{a.body}</div>
              {a.go && <button className="alert-cta" onClick={() => { setView(a.go!); dismiss(a.id); }}>{a.cta ?? "Open"} <span className="nudge"><Icon name="arrow" size={14} /></span></button>}
            </div>
          ))}
        </div>

        <div className="content" key={view}>
          {LEDE[view] && <p className="lede page-enter">{LEDE[view]}</p>}
          {frozen && (
            <div className="freeze-banner" role="alert">
              <Icon name="stop" size={20} />
              <div>
                <b>Every agent is frozen.</b> {frozen.by ? `${frozen.by} hit the panic button.` : "The panic button was pressed."} Every request is denied and no payment can execute.
                {frozen.confirmed ? " Recorded on Dharma." : " Recording on Dharma…"} Unfreezing needs {pol.required} vote{pol.required > 1 ? "s" : ""} and a {pol.timelock}s wait.
              </div>
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
          {view === "keys" && <Keys ctx={ctx} />}
          {view === "appearance" && <Appearance />}
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
  const today = new Date().toDateString();
  const todays = s.proposals.filter((p) => new Date(p.createdAt).toDateString() === today);
  const count = (f: (p: Proposal) => boolean) => todays.filter(f).length;
  const allowedToday = count((p) => p.status === "allowed" || p.status === "executed" || p.status === "executing");
  const blockedToday = count((p) => p.status === "denied" || p.status === "failed");
  const heldToday = count((p) => p.status === "pending");
  const [startHidden, setStartHidden] = useState(() => isDismissed("get-started"));
  const steps = [
    { done: pol.agents.length > 0, text: "Add an agent", view: "agents" as View },
    { done: pol.payees.length > 0, text: "Add who your agents may pay", view: "payees" as View },
    { done: pol.members.length > 1, text: "Add a second member", view: "team" as View },
  ];
  return (
    <div className="stack">
      <div className="tiles">
        <div className={`tile rise ${pending.length ? "attention" : ""}`} style={st(0)}><div className="k">Waiting for you <Icon name="approvals" size={14} /></div><div className="v heading-gradient">{pending.length}</div><div className="note">{pending.length ? "to approve" : "all clear"}</div></div>
        <div className="tile rise" style={st(1)}><div className="k">Wallet (USDC) <Icon name="wallet" size={14} /></div><div className="v heading-gradient">{wallet ? usd(Number(wallet.usdc)) : "…"}</div><div className="note">Gateway {wallet?.gateway ?? "—"}</div></div>
        <div className="tile rise" style={st(2)}><div className="k">Actions today <Icon name="activity" size={14} /></div><div className="v heading-gradient">{todays.length}</div><div className="note">{allowedToday} allowed · {blockedToday} blocked · {heldToday} held</div></div>
        <div className="tile rise" style={st(3)}><div className="k">Spent today <Icon name="wallet" size={14} /></div><div className="v heading-gradient">{usd(spent)}</div><div className="note">of {usd(pol.agents.filter((a) => a.active).reduce((n, a) => n + a.capUsd, 0))} allowed</div></div>
      </div>

      {steps.some((x) => !x.done) && !startHidden && (
        <div className="card rise" style={st(1)}>
          <div className="hd">
            <h2>Get started</h2>
            <span className="sub" style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
              <span className="progress-dots">{steps.map((x) => <i key={x.text} className={x.done ? "on" : ""} />)}</span>
              {steps.filter((x) => x.done).length}/{steps.length}
            </span>
            <DismissX onClick={() => (dismiss("get-started"), setStartHidden(true))} />
          </div>
          <div className="checklist">
            {steps.map((x) => (
              <a key={x.text} href={`#${x.view}`} className={x.done ? "done" : ""} onClick={(e) => { e.preventDefault(); go(x.view); }}>
                <span className="box">{x.done && <Icon name="check" size={12} strokeWidth={2.5} />}</span>
                <span className="txt">{x.text}</span>
                <span className="nudge"><Icon name="arrow" size={14} /></span>
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="grid2">
        <div className="card rise" style={st(2)}>
          <div className="hd"><h2>Waiting for you</h2><a className="sub link-u" href="#approvals" onClick={(e) => { e.preventDefault(); go("approvals"); }}>approvals →</a></div>
          {pending.length === 0 ? <Empty icon="check">Nothing needs approval.</Empty> : <Rows ctx={ctx} items={pending.slice(0, 4)} />}
        </div>
        <div className="card rise" style={st(3)}>
          <div className="hd"><h2>Dharma</h2><a className="sub link-u" href={s.org.dharma!.explorer} target="_blank" rel="noreferrer">{short(s.org.dharma!.address)} ↗</a></div>
          <div className="pad">
            <div className="kv"><span>Members · votes to change a rule</span><b>{pol.members.length} · {pol.required}</b></div>
            <div className="kv"><span>{pol.coreTimelock === undefined ? "Wait" : "Wait · core changes"}</span><b>{waitText(pol.timelock)}{pol.coreTimelock === undefined ? "" : ` · ${waitText(pol.coreTimelock)}`}</b></div>
            <div className="kv"><span>Log anchored onchain</span><b>{pol.anchor.length}/{s.log.length}</b></div>
          </div>
          <div className="log-foot">
            <span>{live.length ? `${live.length} change${live.length > 1 ? "s" : ""} in progress` : "no changes in progress"}</span>
            <a className="link-u" style={{ color: "var(--ink)" }} href="#votes" onClick={(e) => { e.preventDefault(); go("dharma"); }}>votes →</a>
          </div>
        </div>
      </div>

      <div className="card rise" style={st(4)}>
        <div className="hd"><h2>Recent decisions</h2><a className="sub link-u" href="#activity" onClick={(e) => { e.preventDefault(); go("activity"); }}>signed log →</a></div>
        {s.proposals.length === 0 ? <Empty icon="activity">No requests yet. Decisions appear here the moment an agent asks for something.</Empty> : <Rows ctx={ctx} items={s.proposals.slice(0, 8)} />}
        <div className="log-foot"><span className={s.log.verified ? "" : "bad-text"}><span className="sigdot" /> {s.log.verified ? "signed · hash chain verified" : `TAMPERED at entry ${s.log.brokenAt}`}</span><span>head {short(s.log.head)}</span></div>
      </div>
    </div>
  );
}

/** What kind of action a request is, in words, for approval cards. */
function actionKind(p: Proposal): string {
  if (p.payload) return p.payload.kind === "x402" ? "Paid API" : "Payment";
  const t = p.request.tool;
  if (t === "http") return `Web request · ${p.request.method ?? "GET"}`;
  if (t === "message") return "Message to an agent";
  if (t === "shell") return "Shell command";
  if (t === "file") return p.request.fileOp === "write" ? "File write" : "File read";
  return "Payment";
}

function describe(p: Proposal, ctx: Ctx) {
  const a = p.action;
  if (a.type === "message") return `message → ${ctx.s.policy!.agents.find((x) => x.id === a.to)?.name ?? a.to}`;
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
        const cls = p.status === "failed" || p.status === "denied" ? "deny" : p.status === "executed" ? "allow" : o;
        return (
          <div className={`item ${Date.now() - Date.parse(p.createdAt) < 4000 ? "fresh" : ""}`} key={p.id}>
            <span className="caret">›</span>
            <span className="tool">{p.request.paymentKind ?? p.request.tool}</span>
            <span className={`act ${cls === "deny" ? "denied" : ""}`} title={describe(p, ctx)}><span className="ag">{ctx.s.policy!.agents.find((a) => a.id === p.agentId)?.name ?? p.agentId} · </span><span className="what">{describe(p, ctx)}</span></span>
            <Badge v={cls}>{label}</Badge>
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
      {pending.length === 0 && <div className="card"><Empty icon="check">Nothing is waiting for you.</Empty></div>}
      {pending.map((p, i) => <div className="rise" style={st(i)} key={p.id}><ApprovalCard p={p} ctx={ctx} dharma={dharma} /></div>)}
      {resolved.length > 0 && (
        <div className="card">
          <div className="hd"><h2>Recently resolved</h2><span className="sub">{resolved.length}</span></div>
          <div className="resolved">
            {resolved.map((p) => (
              <div key={p.id} className="res">
                <Badge v={p.status === "executed" || p.status === "allowed" ? "allow" : "deny"}>{p.status === "executed" ? "paid" : p.status}</Badge>
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
    <article className="approval">
      <div className="appr-top">
        <span className="agent-mark"><Icon name="agents" size={18} /></span>
        <span className="who"><b>{agent?.name ?? p.agentId}</b><span>{actionKind(p)} · {ago(p.createdAt)}</span></span>
        {p.payload && <span className="amt"><span>amount</span><strong className="heading-gradient">{usd(p.payload.amountUsd)}</strong></span>}
      </div>
      <div className="facts">
        <div className="lbl"><Icon name="shield" size={14} /> Verified by Karuna</div>
        <dl>
          {p.facts.map((f) => (<FactRow key={f.label} label={f.label} value={f.value} tone={f.tone} />))}
          <FactRow label="Why it needs you" value={p.decision.reason} />
        </dl>
      </div>
      {p.reason && (
        <div className="justify">
          <div className="lbl"><Icon name="alert" size={13} /> Written by the agent · may not be true</div>
          <p>{p.reason}</p>
        </div>
      )}
      <div className="appr-actions">
        {p.approvalsNeeded > 1 ? (
          <span className="two-person">
            <span className="segs" style={{ width: 44, flex: "none" }}>{Array.from({ length: p.approvalsNeeded }, (_, i) => <i key={i} className={i < p.approvals.length ? "on" : ""} />)}</span>
            two-person · {p.approvals.length}/{p.approvalsNeeded}{others.length ? ` · ${others.join(", ")} signed` : ""}
          </span>
        ) : <span className="spacer" />}
        <button className="btn btn-deny" disabled={busy} onClick={() => decide(false)}>Deny</button>
        <button className="btn btn-approve" disabled={busy || iApproved || !!s.frozen} title={s.frozen ? "Unfreeze before approving" : undefined} onClick={() => decide(true)}>
          {iApproved ? <><Icon name="check" /> You signed</> : <><Icon name="pen" /> {p.payload ? `Sign & pay ${usd(p.payload.amountUsd)}` : "Sign approval"}</>}
        </button>
      </div>
    </article>
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
  const done = pol.proposals.filter((g) => g.status === "executed" || g.status === "defeated" || g.status === "cancelled").slice(0, 15);
  const team = pol.members.length >= 2;
  // An org on an older Dharma (before core changes and the core wait) has no core settings to show.
  const hasCore = Number.isFinite(pol.coreTimelock);
  return (
    <div className="stack">
      <div className="card dharma-head rise">
        <div className={`grid-kv ${hasCore ? "" : "kv3"}`}>
          <div><div className="k">Contract</div><a className="mono link-u" href={s.org.dharma!.explorer} target="_blank" rel="noreferrer">{short(s.org.dharma!.address)} ↗</a></div>
          <div><div className="k">To pass a change</div><div className="big tnum">{pol.required}/{pol.members.length} <span className="muted small mono">+ {waitText(pol.timelock)}</span></div></div>
          {hasCore && <div><div className="k">Core changes</div><div className="big tnum">{pol.members.length}/{pol.members.length} <span className="muted small mono">+ {waitText(pol.coreTimelock)}</span></div></div>}
          <div><div className="k">Log anchored</div><div className="big tnum">{pol.anchor.length}<span className="muted small mono"> / {s.log.length}</span></div></div>
        </div>
      </div>

      <Waits ctx={ctx} />

      <p className="section-title">In progress</p>
      {live.length === 0 && <div className="card"><Empty icon="votes">No changes are waiting. A new payee, a higher allowance, a new member or an unfreeze appears here for a vote.</Empty></div>}
      {live.map((g, i) => {
        const voted = g.voters.includes(myAddr);
        const remaining = g.eta ? Math.max(0, g.eta - Math.floor(now / 1000)) : null;
        const need = Number.isFinite(g.needed) ? g.needed : pol.required;
        // Every member can skip the wait on a normal change (not Unfreeze, never core).
        const canSkip = g.status === "queued" && !g.core && g.change.op !== "Unfreeze" && team && !voted && !!remaining;
        return (
          <div className="card ballot rise" style={st(i)} key={g.id}>
            <div className="ballot-top">
              <Badge v={g.status === "queued" ? "allow" : "approval"}>{g.status === "queued" ? "passed" : "voting"}</Badge>
              {g.core && <span className="badge badge-danger" title={`Core change: needs every member and waits ${waitText(pol.coreTimelock)}. A freeze cancels it.`}><Icon name="lock" size={11} /> core</span>}
              <b>{g.description}</b>
              <span className="muted">#{g.id} · {ctx.name(g.proposer)} · {ago(g.createdAt)}</span>
            </div>
            <div className="ballot-body">
              <div className="votes">
                <span className="segs" aria-label={`${g.yes} of ${need} votes`}>{Array.from({ length: need }, (_, k) => <i key={k} className={k < g.yes ? "on" : ""} />)}</span>
                <span className="mono small tnum">{g.yes}/{need} yes{g.no ? ` · ${g.no} no` : ""}{g.core ? " · everyone" : ""}</span>
              </div>
              {g.status === "queued" ? (
                <span className="ballot-actions">
                  <span className="countdown"><Icon name="clock" size={14} />{remaining ? <>in effect in <b className="tnum">{waitText(remaining)}</b></> : <span className="shimmer">executing…</span>}</span>
                  {canSkip && <button className="btn btn-approve btn-sm" disabled={busy} title="When every member signs, it applies now" onClick={() => ctx.vote(g, true)}><Icon name="pen" size={14} /> Sign to apply now</button>}
                </span>
              ) : voted ? (
                <span className="muted small">You voted · {need - g.yes} more needed</span>
              ) : (
                <span className="ballot-actions">
                  <button className="btn btn-deny btn-sm" disabled={busy} onClick={() => ctx.vote(g, false)}>Vote no</button>
                  <button className="btn btn-approve btn-sm" disabled={busy} onClick={() => ctx.vote(g, true)}><Icon name="pen" size={14} /> Sign yes</button>
                </span>
              )}
            </div>
            {g.preview && <PreviewBox p={g.preview} ctx={ctx} />}
          </div>
        );
      })}

      {done.length > 0 && (
        <div className="card">
          <div className="hd"><h2>History</h2><span className="sub">{done.length}</span></div>
          <div className="resolved">
            {done.map((g) => (
              <div key={g.id} className="res">
                <Badge v={g.status === "executed" ? "allow" : "deny"}>{g.status === "executed" ? "in effect" : g.status === "cancelled" ? "cancelled by freeze" : g.status}</Badge>
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

/** Propose new waits: the normal wait (majority vote) and the core wait (every member). */
function Waits({ ctx }: { ctx: Ctx }) {
  const pol = ctx.s.policy!;
  const UNITS = { minutes: 60, hours: 3600, days: 86400 } as const;
  type Unit = keyof typeof UNITS;
  const fit = (sec: number): { n: string; unit: Unit } =>
    sec % 86400 === 0 && sec >= 86400 ? { n: String(sec / 86400), unit: "days" } : sec % 3600 === 0 && sec >= 3600 ? { n: String(sec / 3600), unit: "hours" } : { n: String(sec / 60), unit: "minutes" };
  const [normal, setNormal] = useState(fit(pol.timelock));
  const [core, setCore] = useState(fit(Number.isFinite(pol.coreTimelock) ? pol.coreTimelock : 86400));
  const secs = (v: { n: string; unit: Unit }) => Math.round(Number(v.n) * UNITS[v.unit]);
  const row = (label: string, v: { n: string; unit: Unit }, set: (x: { n: string; unit: Unit }) => void, current: number, min: number, max: number, op: "SetTimelock" | "SetCoreTimelock", who: string) => {
    const sec = secs(v);
    const ok = Number.isFinite(sec) && v.n.trim() !== "" && sec >= min && sec <= max && sec !== current;
    return (
      <div className="wait-row">
        <span className="wait-label">{label}<small>{waitText(current)} now · {who}</small></span>
        <input className="select-sm mono" inputMode="decimal" aria-label={`${label} amount`} value={v.n} onChange={(e) => set({ ...v, n: e.target.value })} />
        <select className="select-sm" aria-label={`${label} unit`} value={v.unit} onChange={(e) => set({ ...v, unit: e.target.value as Unit })}>
          {Object.keys(UNITS).map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        <button className="btn btn-ghost btn-sm" disabled={ctx.busy || !ok}
          title={sec < min || sec > max ? `Between ${waitText(min) === "no wait" ? "0" : waitText(min)} and ${waitText(max)}` : undefined}
          onClick={() => {
            if (op === "SetTimelock" && sec === 0 && !confirm("No wait means a passed change applies at once, so stolen keys could loosen rules immediately. Propose it anyway?")) return;
            ctx.change({ op, seconds: sec } as Change);
          }}>Propose</button>
      </div>
    );
  };
  return (
    <div className="card">
      <div className="hd"><h2>Waits</h2></div>
      <div className="pad waits">
        {row("Normal changes", normal, setNormal, pol.timelock, 0, 7 * 86400, "SetTimelock", "majority vote")}
        {Number.isFinite(pol.coreTimelock) && row("Core changes", core, setCore, pol.coreTimelock, 60, 30 * 86400, "SetCoreTimelock", "every member")}
      </div>
    </div>
  );
}

// ============================================================== agents

function Meter({ a, frozen, label }: { a: AgentView; frozen?: boolean; label?: boolean }) {
  const pct = a.capUsd > 0 ? Math.min(100, (a.spentTodayUsd / a.capUsd) * 100) : 0;
  const cls = pct >= 90 ? "high" : pct >= 60 ? "mid" : "";
  return (
    <div className="meter">
      <div className="row"><span>{label ? a.name : "spent today"}</span><span><b>{usd(a.spentTodayUsd)}</b> / {usd(a.capUsd)}</span></div>
      <div className="track"><div className={`fill ${cls}`} style={{ width: `${frozen ? 0 : pct}%` }} /></div>
    </div>
  );
}

function TokenReveal({ token, agent, agentId, onDone }: { token: string; agent: string; agentId: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="card reveal-token rise">
      <div className="hd"><h2>Token for {agent}</h2><span className="badge badge-approval">shown once</span></div>
      <div className="pad stack">
        <p className="muted">Give this to the agent's runtime as <span className="mono">KARUNA_AGENT_TOKEN</span>. It only starts sandbox runs (the box itself never sees it), and only once Dharma has added the agent. Karuna stores just its hash, so copy it now.</p>
        <div className="token-row">
          <code className="token">{token}</code>
          <button className="btn btn-ghost" onClick={() => { navigator.clipboard?.writeText(token); setCopied(true); }}><Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy"}</button>
        </div>
        <pre className="snippet">{`# run the agent in a Karuna sandbox (from the repo root)
KARUNA_AGENT_TOKEN=${token} \\
  pnpm karuna run --agent ${agentId} ./my-agent -- python main.py

// inside the box, pay or buy through Karuna:
import { KarunaAgent } from "@prekaruna/agents";

const karuna = new KarunaAgent({
  gatekeeperUrl: process.env.KARUNA_GATEKEEPER_URL!, // http://karuna.internal
  token: process.env.KARUNA_AGENT_TOKEN!,           // this run's session, set by karuna run
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
  const [reveal, setReveal] = useState<{ token: string; agent: string; agentId: string } | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});

  const add = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ id: string; token: string }>("/agents/prepare", { name: form.name });
      await submitChange(ctx.me, s.org.dharma!.address as Address, { kind: Kind.Propose, change: { op: "SetAgent", id: r.id, capUsd: Number(form.cap) } });
      setReveal({ token: r.token, agent: form.name, agentId: r.id });
      setForm({ name: "", cap: "1" });
    }, `Proposed on Dharma — the agent works after ${pol.required} vote${pol.required > 1 ? "s" : ""} and ${pol.timelock}s`);
  };

  return (
    <div className="stack">
      {reveal && <TokenReveal {...reveal} onDone={() => setReveal(null)} />}
      <form className="card inline-form" onSubmit={add}>
        <label className="field grow"><span>Agent name</span><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Accounts payable agent" /></label>
        <label className="field"><span>Daily allowance (USD)</span><input required type="number" min="0" step="0.000001" value={form.cap} onChange={(e) => setForm({ ...form, cap: e.target.value })} /></label>
        <button className="btn btn-dark" type="submit" disabled={busy}><Icon name="plus" /> Propose agent</button>
      </form>
      <SandboxRuns ctx={ctx} />
      <RemoteRuns ctx={ctx} />
      {pol.agents.length === 0 ? (
        <div className="card"><Empty icon="agents">No agents yet. Propose one above; it can ask for money once Dharma adds it.</Empty></div>
      ) : (
        <div className="grid2 agent-grid">
          {pol.agents.map((a, i) => {
            const ed = editing[a.id];
            return (
              <div className={`agent rise ${s.frozen || !a.active ? "frozen" : ""}`} style={st(i)} key={a.id}>
                <div className="top">
                  <span className="agent-mark"><Icon name="agents" size={18} /></span>
                  <div><div className="name">{a.name}</div><div className="job">{a.id}</div></div>
                  <span className="state">
                    {!a.active ? <Badge v="approval">awaiting vote</Badge> : s.frozen ? <span className="badge badge-danger"><Icon name="stop" size={12} />frozen</span> : <Badge v="allow">active</Badge>}
                  </span>
                </div>
                {a.active && <Meter a={a} frozen={!!s.frozen} />}
                {a.active && (
                  <div className="meta">
                    {ed === undefined ? (
                      <button className="tag link" title="Propose a new daily allowance" onClick={() => setEditing({ ...editing, [a.id]: String(a.capUsd) })}>cap {usd(a.capUsd)}/day <Icon name="pen" size={11} /></button>
                    ) : (
                      <form className="cap-edit" onSubmit={(e) => { e.preventDefault(); ctx.change({ op: "SetAgent", id: a.id, capUsd: Number(ed) }).then((ok) => ok && setEditing(({ [a.id]: _, ...rest }) => rest)); }}>
                        <input autoFocus type="number" min="0" step="0.000001" value={ed} onChange={(e) => setEditing({ ...editing, [a.id]: e.target.value })} />
                        <button className="btn btn-ghost btn-sm" disabled={busy}>propose</button>
                      </form>
                    )}
                    <span className="tag">{a.hasToken ? "token issued" : "no token"}</span>
                    {s.sandbox.unsandboxed.includes(a.id)
                      ? <span className="tag warn-tag" title="Voted to run outside a sandbox: only money and keys are enforced">partially enforced</span>
                      : <span className="tag" title="Only works inside a Karuna sandbox: network, files, keys and money are all enforced"><Icon name="lock" size={11} /> sandboxed</span>}
                    {s.sandbox.sessions.some((x) => x.agentId === a.id) && <span className="tag"><span className="live-dot" aria-hidden /> running</span>}
                    {(() => {
                      const n = s.shield.autoRules.filter((r) => r.active && r.agent === a.id).length;
                      return n ? <span className="tag warn-tag">{n} auto-rule{n > 1 ? "s" : ""}</span> : null;
                    })()}
                  </div>
                )}
                <div className="agent-actions">
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(async () => { const r = await api<{ token: string }>(`/agents/${a.id}/rotate-token`, {}); setReveal({ token: r.token, agent: a.name, agentId: a.id }); })}>{a.hasToken ? "Rotate token" : "Issue token"}</button>
                  {a.active && <button className="btn btn-deny btn-sm" disabled={busy} onClick={() => confirm(`Propose removing ${a.name} from Dharma? It goes to a team vote.`) && ctx.change({ op: "RemoveAgent", id: a.id })}>Propose removal</button>}
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
        <button className="btn btn-dark" type="submit" disabled={busy}><Icon name="plus" /> Propose payee</button>
      </form>
      <div className="card">
        <div className="hd"><h2>Known payees</h2><span className="sub">{pol.payees.length}</span></div>
        {pol.payees.length === 0 ? (
          <Empty icon="payees">No payees yet, so every payment is denied.</Empty>
        ) : (
          <div className="table">
            {pol.payees.map((r) => (
              <div className="tr payee-tr" key={r.account}>
                <span className="av">{(r.name ?? "?")[0]?.toUpperCase()}</span>
                <span className="b">{r.name ?? "Unnamed"}</span>
                <span className="mono small">{r.account}</span>
                <span className="tag">{r.category}</span>
                <button className="btn btn-deny btn-sm" disabled={busy} onClick={() => ctx.change({ op: "RemovePayee", account: r.account as Address })}>Propose removal</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================== policy

/** The key the Gatekeeper uses to draft rules from English (KARUNA_DRAFT_KEY on the Gatekeeper). */
const DRAFTER_KEY = "gemini";

type RuleKind = "payment" | "http" | "shell" | "file" | "message";
type RuleChange = Extract<Change, { op: "AddRule" }>;
interface RuleForm { kind: RuleKind; outcome: "Deny" | "Approval" | "Allow"; agent: string; target: string; method: string; fileOp: string; category: string; maxUsd: string }
interface RuleDraft { change: RuleChange; sentence: string }
const EMPTY_RULE: RuleForm = { kind: "payment", outcome: "Deny", agent: "", target: "", method: "", fileOp: "", category: "", maxUsd: "" };

/** The form as the exact Dharma change it proposes, or why it can't be proposed yet. */
function buildRuleChange(f: RuleForm): { change: RuleChange } | { error: string } {
  let target = f.target.trim();
  let scope: string = f.kind;
  let maxUsd = 0;
  if (f.kind === "payment") {
    if (f.category.trim()) scope = `payment:${f.category.trim().toLowerCase()}`;
    target = target.toLowerCase();
    if (f.outcome === "Allow" && f.maxUsd.trim()) {
      maxUsd = Number(f.maxUsd);
      if (!(maxUsd > 0)) return { error: "The cap must be a dollar amount above 0." };
    }
  } else if (f.kind === "http") {
    if (f.method) scope = `http:${f.method}`;
    target = target.toLowerCase().replace(/^https?:\/\//, "");
    if (f.outcome === "Allow" && !target) return { error: "Name the site to allow." };
  } else if (f.kind === "file") {
    if (f.fileOp) scope = `file:${f.fileOp}`;
  }
  if (f.outcome === "Allow" && (f.kind === "shell" || f.kind === "file") && (!target || target === "*")) {
    return { error: `Name the ${f.kind === "shell" ? "command" : "path"} to allow; allowing every one is too broad.` };
  }
  const id = `r-${f.kind}-${Date.now().toString(36)}`;
  return { change: { op: "AddRule", id, outcome: f.outcome, ...(f.agent ? { agent: f.agent } : {}), scope, target, ...(maxUsd ? { maxUsd } : {}) } };
}

/** A drafted (or any) rule change back into the form, to edit it. */
function formFromChange(c: RuleChange): RuleForm {
  const [kind, sub = ""] = (c.scope ?? "payment").split(":");
  return {
    ...EMPTY_RULE,
    kind: (["payment", "http", "shell", "file", "message"].includes(kind) ? kind : "payment") as RuleKind,
    outcome: c.outcome as RuleForm["outcome"],
    agent: c.agent ?? "",
    target: c.target ?? "",
    method: kind === "http" ? sub.toUpperCase() : "",
    fileOp: kind === "file" ? sub : "",
    category: kind === "payment" ? sub : "",
    maxUsd: c.maxUsd ? String(c.maxUsd) : "",
  };
}

/** The sentence a member reads before proposing; the same wording the Gatekeeper and Votes use. */
function describeRule(c: RuleChange, names: { agent: (id: string) => string; payee: (a: string) => string }): string {
  const verb = c.outcome === "Allow" ? "Allow" : c.outcome === "Deny" ? "Block" : "Require approval for";
  return `${verb} ${describeScope(c.scope ?? "", c.target ?? "", names)} for ${c.agent ? names.agent(c.agent) : "every agent"}${c.maxUsd ? ` up to $${c.maxUsd.toFixed(2)}` : ""}.`;
}

function Policy({ ctx }: { ctx: Ctx }) {
  const { s, busy } = ctx;
  const pol = s.policy!;
  const [meta, setMeta] = useState<Rule[]>([]);
  const [domain, setDomain] = useState("");
  const [threshold, setThreshold] = useState(String(pol.thresholdUsd));
  const [rule, setRule] = useState<RuleForm>(EMPTY_RULE);
  const [english, setEnglish] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [drafts, setDrafts] = useState<RuleDraft[] | null>(null);
  const [draftNote, setDraftNote] = useState<{ note: string; skipped: string[]; model?: string; savedFrom?: string } | null>(null);
  const [draftErr, setDraftErr] = useState("");
  const names = {
    agent: (id: string) => pol.agents.find((a) => a.id === id)?.name ?? id,
    payee: (a: string) => pol.payees.find((p) => p.account.toLowerCase() === a.toLowerCase())?.name ?? short(a),
  };
  const built = buildRuleChange(rule);
  const draft = async () => {
    if (!english.trim() || drafting) return;
    setDrafting(true);
    setDraftErr("");
    setDrafts(null);
    setDraftNote(null);
    try {
      const r = await api<{ rules: RuleDraft[]; note: string; skipped: string[]; model?: string; savedFrom?: string }>("/rules/draft", { text: english });
      setDrafts(r.rules);
      setDraftNote({ note: r.note, skipped: r.skipped, model: r.model, savedFrom: r.savedFrom });
    } catch (e) {
      setDraftErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDrafting(false);
    }
  };
  useEffect(() => {
    api<Rule[]>("/policy").then(setMeta).catch(() => undefined);
  }, []);
  const desc = (id: string) => meta.find((m) => m.id === id)?.description;

  const addRule = (e: FormEvent) => {
    e.preventDefault();
    if ("error" in built) return;
    ctx.change(built.change).then((ok) => ok && setRule({ ...EMPTY_RULE, kind: rule.kind }));
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="hd window-hd"><h2>Rules on Dharma</h2><span className="sub">{pol.rules.filter((r) => r.active).length} active</span></div>
        <div className="policy">
          {pol.rules.map((r, i) => (
            <div className={`p ${r.active ? "" : "off"}`} key={r.id}>
              <span className="i">{String(i + 1).padStart(2, "0")}</span>
              <span className="nm">
                <span>{r.id}{r.core && <span className="lock" title="Core boundary: can never be removed"><Icon name="lock" size={10} /> core</span>}</span>
                <span className="desc">{r.builtin ? desc(r.id) ?? r.scope : `${describeScope(r.scope, r.target, names)} · ${r.agent ? names.agent(r.agent) : "every agent"}`}</span>
              </span>
              <span className="rule-actions">
                {r.active ? <Badge v={r.outcome} /> : <span className="badge badge-quiet">removed</span>}
                {!r.core && r.active && (
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => ctx.change({ op: "RemoveRule", id: r.id })}>{r.outcome === "allow" ? "remove" : "propose removal"}</button>
                )}
                {r.core && r.active && (
                  <button className="btn btn-ghost btn-sm" disabled={busy}
                    onClick={() => confirm(`${r.id} is a core rule. Removing it needs every member's vote and a ${waitText(pol.coreTimelock)} wait, and any freeze cancels it. Propose anyway?`) && ctx.change({ op: "RemoveRule", id: r.id })}>
                    propose removal
                  </button>
                )}
                {!r.core && !r.active && r.builtin && (
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => ctx.change({ op: "AddRule", id: r.id, outcome: "Deny" })}>{"propose re-enable"}</button>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="card rule-english">
        <div className="hd"><h2>Describe a rule in plain English</h2></div>
        <div className="rule-english-body">
          <textarea
            rows={3}
            value={english}
            onChange={(e) => setEnglish(e.target.value)}
            onKeyDown={(e) => (e.key === "Enter" && (e.metaKey || e.ctrlKey) ? void draft() : undefined)}
            placeholder={'e.g. "The research agent can\'t message the payables agent, nobody runs git push, and writes to the finance folder need a person."'}
          />
          <div className="rule-english-actions">
            <button className="btn btn-dark" type="button" disabled={drafting || !english.trim()} onClick={() => void draft()}>{drafting ? "Drafting…" : "Draft rules"}</button>
          </div>
          {draftErr && <div className="draft-err">{draftErr}</div>}
          {drafts && (
            <div className="drafts">
              {drafts.length === 0 && <div className="hint">No rules could be drafted from that. Try being more specific, or use the form below.</div>}
              {drafts.map((d) => (
                <div className="draft" key={d.change.id}>
                  <div className="draft-text">
                    <div className="draft-sentence">{describeRule(d.change, names)}</div>
                    <code className="draft-code">{d.change.outcome.toLowerCase()} · {d.change.scope}{d.change.target ? ` → ${d.change.target}` : ""}{d.change.agent ? ` · ${d.change.agent}` : " · every agent"}{d.change.maxUsd ? ` · ≤ $${d.change.maxUsd}` : ""}</code>
                  </div>
                  <div className="draft-actions">
                    <button className="btn btn-ghost btn-sm" type="button" onClick={() => setRule(formFromChange(d.change))}>Edit</button>
                    <button className="btn btn-dark btn-sm" type="button" disabled={busy} onClick={() => ctx.change(d.change).then((ok) => ok && setDrafts((x) => x?.filter((y) => y !== d) ?? null))}>Propose</button>
                  </div>
                </div>
              ))}
              {draftNote?.model && <div className="hint">{draftNote.model === "saved" ? `From a saved draft (first drafted by ${draftNote.savedFrom ?? "a model"}), no model call needed.` : `Drafted by ${draftNote.model}.`}</div>}
              {draftNote?.note && <div className="hint">Note from the drafter: {draftNote.note}</div>}
              {!!draftNote?.skipped.length && <div className="hint">Left out {draftNote.skipped.length} suggestion{draftNote.skipped.length > 1 ? "s" : ""} that didn't fit your org: {draftNote.skipped.join("; ")}.</div>}
            </div>
          )}
        </div>
      </div>

      <form className="card inline-form rule-form" onSubmit={addRule}>
        <label className="field"><span>Outcome</span>
          <select value={rule.outcome} onChange={(e) => setRule({ ...rule, outcome: e.target.value as RuleForm["outcome"] })}>
            <option value="Deny">Block</option>
            <option value="Approval">Require approval</option>
            <option value="Allow">Allow</option>
          </select>
        </label>
        <label className="field"><span>Action</span>
          <select value={rule.kind} onChange={(e) => setRule({ ...EMPTY_RULE, outcome: rule.outcome, agent: rule.agent, kind: e.target.value as RuleKind })}>
            <option value="payment">Payments</option>
            <option value="http">Web requests</option>
            <option value="shell">Shell commands</option>
            <option value="file">Files</option>
            <option value="message">Messages to other agents</option>
          </select>
        </label>
        <label className="field"><span>Agent</span>
          <select value={rule.agent} onChange={(e) => setRule({ ...rule, agent: e.target.value })}>
            <option value="">Every agent</option>
            {pol.agents.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        {rule.kind === "payment" && <>
          <label className="field"><span>Payee</span>
            <select value={rule.target} onChange={(e) => setRule({ ...rule, target: e.target.value })}>
              <option value="">Any payee</option>
              {pol.payees.map((p) => <option key={p.account} value={p.account}>{p.name ?? short(p.account)}</option>)}
            </select>
          </label>
          <label className="field"><span>Category</span><input value={rule.category} onChange={(e) => setRule({ ...rule, category: e.target.value })} placeholder="any" /></label>
          {rule.outcome === "Allow" && <label className="field"><span>Up to (USD)</span><input inputMode="decimal" value={rule.maxUsd} onChange={(e) => setRule({ ...rule, maxUsd: e.target.value })} placeholder="no cap" /></label>}
        </>}
        {rule.kind === "http" && <>
          <label className="field"><span>Method</span>
            <select value={rule.method} onChange={(e) => setRule({ ...rule, method: e.target.value })}>
              <option value="">Any</option>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="field grow"><span>Site</span><input value={rule.target} onChange={(e) => setRule({ ...rule, target: e.target.value })} placeholder="api.github.com or api.openai.com/v1/" /></label>
        </>}
        {rule.kind === "shell" && (
          <label className="field grow"><span>Command</span><input value={rule.target} onChange={(e) => setRule({ ...rule, target: e.target.value })} placeholder="git push   ·   or a pattern like *curl *" /></label>
        )}
        {rule.kind === "file" && <>
          <label className="field"><span>Access</span>
            <select value={rule.fileOp} onChange={(e) => setRule({ ...rule, fileOp: e.target.value })}>
              <option value="">Read or write</option>
              <option value="read">Read</option>
              <option value="write">Write</option>
            </select>
          </label>
          <label className="field grow"><span>Path</span><input value={rule.target} onChange={(e) => setRule({ ...rule, target: e.target.value })} placeholder="finance   ·   or a pattern like *.csv" /></label>
        </>}
        {rule.kind === "message" && (
          <label className="field grow"><span>To</span>
            <select value={rule.target} onChange={(e) => setRule({ ...rule, target: e.target.value })}>
              <option value="">Any agent</option>
              {pol.agents.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        )}
        <button className="btn btn-dark" disabled={busy || "error" in built}><Icon name="plus" /> Propose rule</button>
        <div className="rule-preview">{"error" in built ? built.error : <>Will be voted on as: <strong>{describeRule(built.change, names)}</strong></>}</div>
      </form>

      <div className="grid2">
        <div className="card">
          <div className="hd"><h2>Allowlisted domains</h2><span className="sub">{pol.domains.length}</span></div>
          <div className="pad stack-sm">
            <div className="pills">
              {pol.domains.map((d) => (<span className="pill" key={d}>{d} <button className="x" aria-label={`Propose removing ${d}`} title="Propose removing this domain" disabled={busy} onClick={() => ctx.change({ op: "RemoveDomain", domain: d })}><Icon name="x" size={12} /></button></span>))}
              {pol.domains.length === 0 && <span className="muted">None, so all HTTP is denied.</span>}
            </div>
            <form className="row-form" onSubmit={(e) => { e.preventDefault(); ctx.change({ op: "AddDomain", domain: domain.trim().toLowerCase() }).then((ok) => ok && setDomain("")); }}>
              <input aria-label="Domain" className="mono" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" required />
              <button className="btn btn-ghost" disabled={busy}>Propose</button>
            </form>
          </div>
        </div>
        <div className="card">
          <div className="hd"><h2>Large payments need two approvals</h2><span className="sub">from {usd(pol.thresholdUsd)}</span></div>
          <div className="pad stack-sm">
            <p className="muted">Payments at or above this need two members' signatures{pol.members.length < 2 ? " (once there are two members)" : ""}. Changing it goes to a team vote.</p>
            <form className="row-form" onSubmit={(e) => { e.preventDefault(); ctx.change({ op: "SetThreshold", usd: Number(threshold) }); }}>
              <span className="prefix"><span>$</span><input aria-label="Threshold in USD" type="number" min="0" step="0.01" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></span>
              <button className="btn btn-ghost" disabled={busy}>Propose</button>
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
        <h2>Decision log</h2>
        <span className="filters" role="tablist" aria-label="Filter the log">{(["all", "decisions", "events", "on Arc"] as const).map((k) => <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{k}</button>)}</span>
      </div>
      {shown.length === 0 ? (
        <Empty icon="activity">{filter === "all" ? "The log is empty." : `Nothing under “${filter}” yet.`}</Empty>
      ) : (
        <div className="gk">
          {shown.map((e) => {
            const anchoredMark = e.seq < anchored ? <span title="Anchored on Dharma" style={{ display: "inline-flex" }}><Icon name="anchor" size={12} /></span> : null;
            if (e.decision) {
              const o = e.decision.outcome;
              const r = e.request!;
              const what = r.tool === "payment" ? `${r.paymentKind ?? "payment"} ${r.amountUsd != null ? usd(r.amountUsd) : ""} → ${short(r.to)}` : r.command ?? (r.url ? `${r.method ?? "GET"} ${r.url}` : r.path ?? r.tool);
              return (
                <div className="item" key={e.seq}>
                  <span className="caret">{e.seq}</span>
                  <span className="tool">{r.tool}</span>
                  <span className={`act ${o === "deny" ? "denied" : ""}`} title={what}><span className="ag">{who(r.agent)} · </span><span className="what">{what}</span></span>
                  <Badge v={o} />
                  <span className="pol">{e.decision.ruleId}</span>
                  <span className="log">{anchoredMark} {e.hash.slice(0, 4)}…{e.hash.slice(-4)}</span>
                </div>
              );
            }
            const ev = e.event!;
            const detail = Object.entries(ev).filter(([k]) => !NAMED_KEYS.has(k)).map(([k, v]) => `${k}=${k === "by" ? who(v) : typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("  ");
            return (
              <div className="item event" key={e.seq}>
                <span className="caret">{e.seq}</span>
                <span className="tool">event</span>
                <span className="act" title={`${ev.type}: ${detail}`}><b>{eventName(ev as Record<string, unknown>)}</b> <span className="ag">{detail}</span></span>
                <span><TxLink tx={(ev as Record<string, unknown>).txRef} s={s} /></span>
                <span className="pol">{ago(e.timestamp)}</span>
                <span className="log">{anchoredMark} {e.hash.slice(0, 4)}…{e.hash.slice(-4)}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="log-foot">
        <span className={s.log.verified ? "" : "bad-text"}><span className="sigdot" /> {s.log.length} entries · ed25519-signed &amp; hash-chained · {s.log.verified ? "verified" : `TAMPERED at ${s.log.brokenAt}`} · {anchored} anchored on Dharma</span>
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
                  {proposed ? <Badge v="approval">proposed</Badge> : <button className="btn btn-dark btn-sm" disabled={busy} onClick={() => ctx.change({ op: "AddMember", member: e.address as Address }, e.name)}><Icon name="plus" size={14} /> Propose adding</button>}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="card">
        <div className="hd"><h2>Members</h2><span className="sub">{pol.members.length}</span></div>
        <div className="table">
          {pol.members.map((m) => (
            <div className="tr" key={m.address}>
              <span className="av">{(m.name ?? "?")[0]?.toUpperCase()}</span>
              <span className="b">{m.name ?? "Unnamed"}{m.address === myAddr ? <span className="tag" style={{ marginLeft: 8 }}>this browser</span> : ""}</span>
              <span className="mono small">{m.address}</span>
              <button className="btn btn-deny btn-sm" disabled={busy || pol.members.length <= 1} onClick={() => ctx.change({ op: "RemoveMember", member: m.address as Address })}>Propose removal</button>
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="hd"><h2>Gatekeeper wallet</h2><span className="sub">{s.org.wallet?.chain}</span></div>
        <div className="pad stack-sm">
          <div className="token-row"><code className="token">{s.org.wallet?.address}</code></div>
          <p className="muted small">Pays for services and relays Dharma transactions.</p>
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
      if (s.frozen && (s.frozen.by === "Tripwire" || s.frozen.by === "Swarm Stopper"))
        return { ...base, tone: "bad", sticky: true, go: "swarm", cta: "Tripwire", title: "Tripwire freeze recorded on Dharma", body: "Tripwire froze every agent. Unfreezing needs a member vote." };
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
      return { ...base, tone: "bad", sticky: true, title: "Agent fell for a drill", body: `${agentName(a.agent)} · ${String(a.category)} payments are now blocked for it.` };
    default:
      return null; // anchors, payee/domain changes etc. update the screen without a pop-up
  }
}

function LiveBadge({ mode }: { mode: LiveMode }) {
  const label = mode === "quicknode" ? "QuickNode" : mode === "rpc" ? "Arc" : mode === "connecting" ? "connecting…" : "relay offline";
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
        <InfoBox id="inbox" icon="inbox"><p>Hand an agent work the way a supplier or teammate would.</p></InfoBox>
          <form className="card" onSubmit={send}>
            <div className="hd"><h2>Send a message to an agent</h2></div>
            <div className="pad stack-sm">
              <div className="row-form">
                <select aria-label="Agent" value={msg.agentId} onChange={(e) => setMsg({ ...msg, agentId: e.target.value })}>
                  {active.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <input aria-label="From" required value={msg.from} onChange={(e) => setMsg({ ...msg, from: e.target.value })} placeholder="From (e.g. a supplier)" />
              </div>
              <input aria-label="Subject" className="plain-input" required value={msg.subject} onChange={(e) => setMsg({ ...msg, subject: e.target.value })} placeholder="Subject" />
              <textarea aria-label="Message" required rows={4} value={msg.body} onChange={(e) => setMsg({ ...msg, body: e.target.value })} placeholder="Invoice text, payment details…" />
              <div><button className="btn btn-dark" disabled={busy || !active.length}><Icon name="inbox" /> Deliver</button></div>
            </div>
          </form>
      <div className="card">
        <div className="hd"><h2>Inboxes</h2></div>
        {s.inbox.length === 0 ? <Empty icon="inbox">No messages yet.</Empty> : (
          <div className="resolved">
            {s.inbox.slice(0, 20).map((m) => (
              <div className="res" key={m.id}>
                {m.test ? <Badge v={m.test.status === "failed" ? "deny" : m.test.status === "passed" ? "allow" : "approval"}>test</Badge> : <span className="badge badge-quiet">real</span>}
                <span className="small"><b>{m.subject}</b> <span className="muted">· {m.from} → {agentName(m.agentId)}</span></span>
                <span className="muted small">{m.reportedAt ? <span className="tag">flagged by agent</span> : null} {ago(m.receivedAt)}</span>
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
      <InfoBox id="shield" icon="shield">
          <p className="center-line">Karuna sends each agent {s.shield.testsPerDay ? `about ${s.shield.testsPerDay}` : "a few"} fake scams a day. One that falls for it stays blocked until you restore it below.</p>
      </InfoBox>

      {active.length > 0 && (
        <div className="grid2 agent-grid">
          {active.map((a, i) => {
            const st2 = stats(a.id);
            const rules = s.shield.autoRules.filter((r) => r.active && r.agent === a.id);
            return (
              <div className={`tile rise ${rules.length ? "attention" : ""}`} style={st(i)} key={a.id}>
                <div className="k">{a.name} <Icon name="agents" size={14} /></div>
                <div className="v small-v">{st2.passed} passed · <span className={st2.failed ? "bad-text" : ""}>{st2.failed} failed</span></div>
                <div className="note">{st2.sent} tests · {rules.length} auto-block{rules.length === 1 ? "" : "s"}</div>
              </div>
            );
          })}
        </div>
      )}

      <div className="card">
        <div className="hd"><h2>Auto-blocks on Dharma</h2><span className="sub">{s.shield.autoRules.filter((r) => r.active).length} active</span></div>
        {s.shield.autoRules.filter((r) => r.active).length === 0 ? (
          <Empty icon="shield">No agent is blocked. When one falls for a test, its block appears here.</Empty>
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
                      <Badge v="approval">restore proposed</Badge>
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
      </div>

      <form className="card" onSubmit={runTest}>
          <div className="hd"><h2>Run a drill now</h2></div>
          <div className="inline-form">
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
            <label className="field"><span>Pretends to be</span>
              <input list="shield-cats" value={test.category} onChange={(e) => setTest({ ...test, category: e.target.value })} placeholder={categories[0] ?? "supplies"} />
              <datalist id="shield-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
            </label>
            <button className="btn btn-dark" disabled={busy || !active.length}><Icon name="shield" /> Send test</button>
          </div>
        </form>

      <div className="card">
        <div className="hd"><h2>Tests</h2></div>
        {tests.length === 0 ? <Empty icon="shield">No tests yet.</Empty> : (
          <div className="resolved">
            {tests.slice(0, 20).map((t) => (
              <div className="res" key={t.id}>
                {t.status === "failed" ? <span className="badge badge-danger"><Icon name="x" size={12} />failed</span> : <Badge v={t.status === "passed" ? "allow" : "approval"}>{t.status}</Badge>}
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
      <InfoBox id="swarm" icon="swarm">
          <p>Agents never get real passwords, so any password an agent uses is bait. If an agent shares one, or {sw.agentsToTrip} agents go after the same new target within {sw.windowSeconds}s, every agent freezes. Unfreeze from the top bar (needs a vote).</p>
      </InfoBox>

      <div className="grid2">
        <div className="card">
          <div className="hd"><h2>Trips</h2><span className="sub">{sw.trips.length}</span></div>
          {sw.trips.length === 0 ? <Empty icon="swarm">No swarm detected.</Empty> : (
            <div className="resolved">
              {sw.trips.map((t) => (
                <div className="res" key={t.id}>
                  <span className="badge badge-danger"><Icon name="stop" size={12} />froze all</span>
                  <span className="small">{t.reason} <span className="muted">· {t.agents.map(agentName).join(", ")}</span></span>
                  <span className="muted small">
                    {isTx(t.txRef) ? <TxLink tx={t.txRef} s={s} /> : "local"} · {ago(t.at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <div className="hd"><h2>Agents that touched a trap</h2><span className="sub">{sw.tainted.length}</span></div>
          {sw.tainted.length === 0 ? <Empty icon="key">None. Any agent that uses a trap credential shows up here.</Empty> : (
            <div className="resolved">
              {sw.tainted.map((t) => (
                <div className="res" key={t.agentId}>
                  <span className="badge badge-danger">marked</span>
                  <span className="small"><b>{t.agentName}</b> used <span className="mono">{t.secret}</span></span>
                  <span className="muted small">{ago(t.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="hd"><h2>Trap credentials</h2></div>
        <form className="pad row-form" onSubmit={(e) => { e.preventDefault(); run(() => api("/traps", { agentId: target || undefined }), "Trap credentials minted. Plant them where the agent can find them."); }}>
          <select aria-label="Which agent the traps are for" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">For every agent</option>
            {active.map((a) => <option key={a.id} value={a.id}>For {a.name}</option>)}
          </select>
          <button className="btn btn-dark" disabled={busy}><Icon name="key" /> Mint trap set</button>
        </form>
        {sw.traps.length === 0 ? <Empty icon="key">No traps yet. Mint a set above and plant it where an agent can find it.</Empty> : (
          <div className="table">
            {sw.traps.map((t) => {
              const to = plantTo[t.id] ?? t.agentId ?? active[0]?.id ?? "";
              return (
                <div className="tr stack" key={t.id}>
                  <div className="row-between">
                    <span className="small"><b>{t.secrets.map((x) => x.name).join(", ")}</b> <span className="muted">· {t.agentName ?? "every agent"} · {ago(t.createdAt)}</span></span>
                    <span className="shield-actions">
                      <button className="btn btn-ghost btn-sm" aria-expanded={shown === t.id} onClick={() => setShown(shown === t.id ? null : t.id)}>{shown === t.id ? "Hide" : "Show .env"}</button>
                      <select className="select-sm" aria-label="Agent to leak the credentials to" value={to} onChange={(e) => setPlantTo({ ...plantTo, [t.id]: e.target.value })}>
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
      <div className="hd"><h2>Learned from your choices</h2></div>
      {L.suggestions.map((x) => (
        <div className="tr learn-tr" key={x.id}>
          <Badge v="approval">suggestion</Badge>
          <span className="small">You approved <b>{x.agentName}</b> → <b>{who(x.counterpartyName, x.counterparty)}</b> {x.approvals} times. Auto-approve it {x.bandLabel} from now on?</span>
          {proposing(x.id) ? <span className="tag">proposed → vote on Dharma</span> : (
            <button className="btn btn-dark btn-sm" disabled={busy} onClick={() => ctx.change(x.change as unknown as Change)}>Propose rule</button>
          )}
        </div>
      ))}
      {L.blocks.map((b) => (
        <div className="tr learn-tr" key={b.id}>
          <Badge v="deny">learned block</Badge>
          <span className="small"><b>{b.agentName ?? "Every agent"}</b> can't pay <b>{who(b.targetName, b.target)}</b> <span className="muted">(a member said no)</span></span>
          {proposing(b.id) ? <span className="tag">lift proposed → vote</span> : (
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => ctx.change({ op: "RemoveRule", id: b.id })}>Propose lifting</button>
          )}
        </div>
      ))}
      {L.allows.map((b) => (
        <div className="tr learn-tr" key={b.id}>
          <Badge v="allow">learned rule</Badge>
          <span className="small"><b>{b.agentName ?? "Every agent"}</b> pays <b>{who(b.targetName, b.target)}</b> up to {usd(b.maxUsd)} without asking</span>
          <button className="btn btn-ghost btn-sm" disabled={busy} title="Proposes revoking this rule (team vote)" onClick={() => ctx.change({ op: "RemoveRule", id: b.id })}>Propose revoking</button>
        </div>
      ))}
      {L.precedents.length > 0 && (
        <div className="resolved">
          {L.precedents.slice(0, 8).map((x) => (
            <div className="res" key={x.id}>
              <Badge v={x.outcome === "approve" ? "allow" : "deny"}>{x.outcome === "approve" ? "yes" : "no"}</Badge>
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
      <span className="field-label"><Icon name={bad ? "alert" : "sparkle"} size={13} /> Preview before loosening</span>
      <div>
        Replaying the last {p.days} days ({p.replayed} requests) under this change,{" "}
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

// ============================================================== Keys (sandbox credentials)

/** A short, stable Dharma rule id (bytes32: 32 chars max). */
const ruleId = (prefix: string) => `${prefix}-${Date.now().toString(36)}`.slice(0, 32);

function Keys({ ctx }: { ctx: Ctx }) {
  const { s, run, busy } = ctx;
  const sb = s.sandbox;
  const [form, setForm] = useState({ name: "", envVar: "", value: "", host: "", llm: true, use: "agents" as "agents" | "drafter", provider: "groq" as "groq" | "gemini" });
  const drafter = form.use === "drafter";
  const PROVIDERS = { groq: { label: "Groq", env: "GROQ_API_KEY", where: "console.groq.com" }, gemini: { label: "Gemini", env: "GEMINI_API_KEY", where: "aistudio.google.com" } } as const;
  const blank = { name: "", envVar: "", value: "", host: "", llm: true, use: form.use, provider: form.provider };
  const [bind, setBind] = useState<Record<string, string>>({});
  const proposing = (scope: string) =>
    s.policy!.proposals.some((g) => (g.status === "open" || g.status === "queued") && g.change?.op === "AddRule" && g.change.scope === scope);

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (drafter) {
      // A drafter key is used by Karuna itself to draft rules from English. Agents never get it,
      // so there's nothing to bind and nothing to vote on.
      const name = form.name.trim().toLowerCase() || `${form.provider}-drafter`;
      run(async () => {
        await api("/keys", { name, envVar: PROVIDERS[form.provider].env, value: form.value, purpose: "drafter", provider: form.provider });
        setForm(blank);
      }, `${PROVIDERS[form.provider].label} key stored for the rule drafter. Agents can't use it.`);
      return;
    }
    const name = form.name.trim().toLowerCase();
    const host = form.host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    run(async () => {
      await api("/keys", { name, envVar: form.envVar.trim(), value: form.value });
      // Where the key may travel is policy: a Dharma rule, voted like any loosening.
      await submitChange(ctx.me, s.org.dharma!.address as Address, { kind: Kind.Propose, change: { op: "AddRule", id: ruleId(`k-${name}`), outcome: "Allow", scope: `key:${name}`, target: host } });
      if (form.llm) await submitChange(ctx.me, s.org.dharma!.address as Address, { kind: Kind.Propose, change: { op: "AddRule", id: ruleId(`p-${name}`), outcome: "Allow", scope: "http:POST", target: host } });
      setForm(blank);
    }, `Key stored. Proposed on Dharma: ${name} may be sent to ${host}${form.llm ? ", and POSTs there skip approval" : ""}`);
  };

  return (
    <div className="stack">
      <form className="card" onSubmit={add}>
        <div className="hd"><h2>Add a key</h2></div>
        <div className="inline-form">
          <label className="field"><span>Use for</span>
            <select value={form.use} onChange={(e) => setForm({ ...form, use: e.target.value as "agents" | "drafter" })}>
              <option value="agents">Agents</option>
              <option value="drafter">Drafter</option>
            </select>
          </label>
          {drafter ? (
            <label className="field"><span>Provider</span>
              <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as "groq" | "gemini" })}>
                <option value="groq">Groq (free)</option>
                <option value="gemini">Gemini (free)</option>
              </select>
            </label>
          ) : <>
            <label className="field"><span>Name</span><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="openai" pattern="[a-zA-Z0-9\-]{1,40}" /></label>
            <label className="field"><span>Variable name</span><input required className="mono" value={form.envVar} onChange={(e) => setForm({ ...form, envVar: e.target.value.toUpperCase() })} placeholder="OPENAI_API_KEY" /></label>
          </>}
          <label className="field grow"><span>Key value</span><input required type="password" autoComplete="off" className="mono" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder={drafter ? `from ${PROVIDERS[form.provider].where}` : "sk-…"} /></label>
          {drafter && <button className="btn btn-dark" disabled={busy}><Icon name="plus" /> Store</button>}
        </div>
        {!drafter && (
          <div className="inline-form" style={{ paddingTop: 0 }}>
            <label className="field grow"><span>Allowed service</span><input required className="mono" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="api.openai.com" /></label>
            <label className="check"><input type="checkbox" checked={form.llm} onChange={(e) => setForm({ ...form, llm: e.target.checked })} /> <span>POSTs to it skip approval <small>(needed for LLM APIs)</small></span></label>
            <button className="btn btn-dark" disabled={busy}><Icon name="plus" /> Store &amp; propose</button>
          </div>
        )}
      </form>

      <div className="card">
        <div className="hd"><h2>Keys</h2><span className="sub">{sb.keys.length}</span></div>
        {sb.keys.length === 0 ? <Empty icon="key">No keys yet. Boxed agents can't call a private API until you add its key here.</Empty> : (
          <div className="table">
            {sb.keys.map((k) => (
              <div className="tr key-tr" key={k.name}>
                <span className="intro-mark"><Icon name="key" size={15} /></span>
                <span className="b">{k.name}<div className="muted small mono">{k.purpose === "drafter" ? "used by Karuna, never by agents" : `${k.envVar}=${k.placeholder}`}</div></span>
                <span className="pills">
                  {k.boundTo.length ? k.boundTo.map((h) => <span className="tag" key={h}><Icon name="lock" size={11} /> {h}</span>)
                    : k.purpose === "drafter" ? <span className="tag"><Icon name="lock" size={11} /> rule drafter · {k.provider === "gemini" ? "Gemini" : "Groq"}</span>
                    : k.name === DRAFTER_KEY ? <span className="tag"><Icon name="lock" size={11} /> rule drafter · used by Karuna only</span>
                    : proposing(`key:${k.name}`) ? <Badge v="approval">binding proposed</Badge> : <span className="badge badge-quiet">not bound · unusable</span>}
                </span>
                <span className="shield-actions">
                  {!k.boundTo.length && k.purpose !== "drafter" && k.name !== DRAFTER_KEY && !proposing(`key:${k.name}`) && <>
                    <input className="select-sm mono bind-input" aria-label={`Bind ${k.name} to a host`} placeholder="api.example.com" value={bind[k.name] ?? ""} onChange={(e) => setBind({ ...bind, [k.name]: e.target.value })} />
                    <button className="btn btn-ghost btn-sm" disabled={busy || !bind[k.name]} onClick={() => ctx.change({ op: "AddRule", id: ruleId(`k-${k.name}`), outcome: "Allow", scope: `key:${k.name}`, target: bind[k.name].trim().toLowerCase() })}>Propose binding</button>
                  </>}
                  <button className="btn btn-deny btn-sm" disabled={busy} onClick={() => confirm(`Delete key ${k.name}? Boxes using it start failing at once.`) && run(() => api(`/keys/${k.name}`, undefined, "DELETE"), "Key deleted")}>Delete</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================== appearance

function Appearance() {
  const theme = useThemePref();
  const [island, setIsland] = useState(getIslandEnabled);
  const options: { v: ThemePref; label: string; note: string }[] = [
    { v: "system", label: "System", note: "Follows your computer" },
    { v: "light", label: "Light", note: "Light backdrop and panels" },
    { v: "dark", label: "Dark", note: "Dark backdrop and panels" },
  ];
  return (
    <div className="stack">
      <div className="card">
        <div className="hd"><h2>Theme</h2></div>
        <div className="pad theme-choices" role="radiogroup" aria-label="Theme">
          {options.map((o) => (
            <button key={o.v} type="button" role="radio" aria-checked={theme === o.v} className={`theme-choice ${theme === o.v ? "on" : ""}`} onClick={() => setThemePref(o.v)}>
              <span className={`theme-swatch ${o.v}`} aria-hidden="true" />
              <b>{o.label}</b>
              <small>{o.note}</small>
            </button>
          ))}
        </div>
      </div>
      {IN_APP && (
        <div className="card">
          <div className="hd"><h2>Island</h2></div>
          <div className="pad">
            <label className="switch-row">
              <span><b>Show the island</b><small>The notch at the top of the screen while Karuna is minimized or closed to the tray. Approvals still reach this console and the tray when it's off.</small></span>
              <input type="checkbox" role="switch" checked={island} onChange={(e) => { setIsland(e.target.checked); setIslandEnabled(e.target.checked); }} />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================== Sandbox runs (Agents page)

function SandboxRuns({ ctx }: { ctx: Ctx }) {
  const { s, run, busy } = ctx;
  const sb = s.sandbox;
  return (
    <div className="card">
      <div className="hd"><h2>Running in a sandbox</h2><span className="sub">{sb.sessions.length} live</span></div>
      {sb.sessions.length === 0 ? <Empty icon="agents">No boxes running. Start one with <span className="mono">pnpm karuna run --agent &lt;id&gt; ./folder -- &lt;command&gt;</span>.</Empty> : (
        <div className="table">
          {sb.sessions.map((x) => (
            <div className="tr run-tr" key={x.id}>
              <span className="live-dot" aria-hidden />
              <span className="b">{x.agentName}
                <div className="run-tags">
                  <span className="tag" title={x.isolation === "gvisor" ? "gVisor: a user-space kernel between the agent and the machine" : "Hardened Docker. Install gVisor on that machine for a stronger wall."}>{x.isolation === "gvisor" ? <><Icon name="lock" size={11} /> gVisor</> : "Docker"}</span>
                  {x.remote && <span className="tag" title="Runs on another machine through the remote port">remote</span>}
                  {x.desktop && <span className="tag" title="Has a virtual screen and browser (computer-use agent)">desktop</span>}
                  <span className="muted small mono">run {x.id}{x.host ? ` · ${x.host}` : ""} · {ago(x.startedAt)}</span>
                </div>
              </span>
              <span className="mono small muted" title={x.lastRequest ?? ""}>{x.requests} requests · {x.denied} blocked{x.lastRequest ? ` · last ${x.lastRequest}` : ""}</span>
              <span className="shield-actions">
                {x.viewer && !x.remote && <a className="btn btn-ghost btn-sm" href={x.viewer} target="_blank" rel="noreferrer" title="Live view of the box's screen (this machine only)">Watch <Icon name="external" size={12} /></a>}
                {x.viewer && x.remote && <span className="tag" title="The live view only opens on the machine running the box">watch on {x.host ?? "that machine"}</span>}
                {x.stopRequested ? <Badge v="approval">stopping</Badge> : <button className="btn btn-deny btn-sm" disabled={busy} onClick={() => run(() => api(`/sandbox/${x.id}/stop`, {}), "Stopping the box")}>Stop</button>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RemoteRuns({ ctx }: { ctx: Ctx }) {
  const r = ctx.s.sandbox.remote;
  const cmd = r ? `KARUNA_AGENT_TOKEN=kag_… pnpm karuna run --agent <id> \\
  --gatekeeper https://<this-machine>:${r.port} --ca karuna-ca.pem \\
  ./my-agent -- python main.py` : "";
  return (
    <div className="card">
      <div className="hd"><h2>Run on another machine</h2><span className="sub">{r ? `remote port ${r.port} on ${r.host}` : "off"}</span></div>
      <div className="pad stack-sm">
        {r ? (
          <>
            <p className="muted small">A teammate's laptop or a cloud server can box agents under this org's rules. That machine needs Docker, the agent's token, and this org's certificate, so it trusts only this Gatekeeper. The box there still has no way out except here.</p>
            <pre className="snippet">{cmd}</pre>
            <div className="row-form">
              <a className="btn btn-ghost" href="/api/sandbox/ca" download="karuna-ca.pem"><Icon name="lock" /> Download karuna-ca.pem</a>
              <span className="muted small">Names it answers to: <span className="mono">{r.names.join(", ")}</span></span>
            </div>
          </>
        ) : (
          <p className="muted small">Off. Start the Gatekeeper with <span className="mono">KARUNA_REMOTE_PORT=8443 KARUNA_REMOTE_HOST=0.0.0.0</span> to turn it on.</p>
        )}
      </div>
    </div>
  );
}
