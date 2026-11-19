import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Address } from "viem";
import { isAddr, isNoLimit, decodeChange, describeChange, describeScope, NO_LIMIT_USD, waitText, SETTINGS, settingChange, PERMISSIONS, ALL_PERMISSIONS, STRUCTURES, DELETE_ROLE, MAX_ROLE, ROLE_MEMBER, permissionBits, roleNumber, type Change, type SettingName, type Permission, type RoleDef, type Structure } from "@prekaruna/dharma";
import { api, roleOf, setSessionSigner, useGatekeeper, type LooseningPreview, type AgentExposure, type Exposure, type AgentView, type AgentDraftView, type Governance, type LogEntry, type Proposal, type Rule, type RunDetail, type RunFileChange, type RunStep, type Schedule, type Snapshot, type WalletInfo } from "./api.ts";
import { Kind, SignerUnavailable, cancelEscrow, decidePayment, loadSigner, signerKey, submitChange, type Signer } from "./signer.ts";
import { accountEmail, createAccount, signIn as accountSignIn, signOut as accountSignOut } from "./account.ts";
import { useRelay, type ChainEvent, type LiveMode } from "./live.ts";
import { Palette, type Command } from "./palette.tsx";
import { keccak256, stringToHex } from "viem";
import { PREVIEW, previewLog, previewRun, previewSigner, previewSnapshot, previewWallet } from "./preview.ts";
import { Badge, Icon, type IconName } from "./icons.tsx";
import { askConfirm } from "./confirm.tsx";
import { ProposalToaster, type GovEvent, type ProposalToast } from "./proposalToasts.ts";
import { inviteCode, joinStatus, lookupInvite, sendJoin, sentJoins, type SentJoin } from "./invites.ts";
import { IN_APP, getIslandEnabled, setDesktopSigner, setIslandEnabled } from "./desktop.ts";
import { setThemePref, useThemePref, type ThemePref } from "./theme.ts";
import { eventName, NAMED_KEYS } from "./eventNames.ts";
import { Picker, Select } from "./picker.tsx";

// The menu: everyday work first, then settings. Older page names (pop-ups, saved state) still resolve.
type Page = "overview" | "activity" | "agents" | "safety" | "proposals" | "team" | "rules" | "appearance";
type View = Page | "approvals" | "votes" | "dharma" | "payees" | "keys" | "connectors" | "shield" | "swarm" | "inbox" | "policy";
const PAGE_OF: Record<View, Page> = {
  overview: "overview", activity: "activity", agents: "agents", safety: "safety", proposals: "proposals", team: "team", rules: "rules", appearance: "appearance",
  approvals: "activity", votes: "activity", dharma: "activity", payees: "proposals",
  keys: "agents", connectors: "agents", shield: "safety", swarm: "safety", inbox: "safety", policy: "rules",
};
const TITLES: Record<Page, string> = { overview: "Home", activity: "Activity", agents: "Agents", safety: "Safety", proposals: "Proposals", team: "Team", rules: "Rules", appearance: "Appearance" };
const ICON: Record<Page, IconName> = { overview: "home", activity: "activity", agents: "agents", safety: "shield", proposals: "votes", team: "team", rules: "rules", appearance: "sun" };
const NAV: { label: string | null; hint?: string; pages: Page[] }[] = [
  { label: null, pages: ["overview", "activity", "proposals", "agents", "safety", "team", "rules", "appearance"] },
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

const usd = (n: number) => (isNoLimit(n) ? "no limit" : `$${n > 0 && n < 0.01 ? n.toFixed(4).replace(/0+$/, "") : n.toFixed(2)}`);
const short = (s?: string | null) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "—");
/**
 * How far this computer's clock is ahead of Arc (ms), from the latest block the Gatekeeper read.
 * Chain times (a proposal's creation, its wait's end) are compared against Arc's clock, not this
 * computer's: a wrong system clock would otherwise show "5h ago" for a new proposal and a countdown
 * that already says "executing…". Differences under a minute are just the block being a few seconds old.
 */
let chainSkewMs = 0;
function setChainTime(chainTimeSec?: number | null) {
  if (!chainTimeSec) return;
  const skew = Date.now() - chainTimeSec * 1000;
  chainSkewMs = Math.abs(skew) > 60_000 ? skew : 0;
}
/** Now, on Arc's clock (ms). */
const chainNow = () => Date.now() - chainSkewMs;
/** "5 hours", "12 minutes": how far the clock is off. */
const fmtSkew = (min: number) => {
  const m = Math.abs(min);
  if (m < 90) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hour${h === 1 ? "" : "s"}` : `${Math.round(h / 24)} days`;
};

/** "5m ago". A number is a chain timestamp (seconds, Arc's clock); a string is the Gatekeeper's ISO time. */
const ago = (iso: string | number) => {
  const t = typeof iso === "number" ? iso * 1000 : Date.parse(iso);
  const s = Math.max(0, Math.round(((typeof iso === "number" ? chainNow() : Date.now()) - t) / 1000));
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

/** While something is being sent (a vote, an approval, a rule): a visible notice with the time so far. */
function WorkingNotice() {
  const [start] = useState(() => Date.now());
  const now = useNow(1000);
  const secs = Math.max(0, Math.floor((now - start) / 1000));
  if (secs < 2) return null;
  return (
    <div role="status" className="flash working">
      <span className="spinner" aria-hidden /> Sending to Arc… {secs}s{secs >= 20 ? " · Circle's wallet can take a minute or two" : ""}
    </div>
  );
}

export default function App() {
  const gk = useConsoleData();
  // Who signs: this device's key, which is your account's key once you sign in with email + password.
  const [keyVersion, setKeyVersion] = useState(0);
  const [email, setEmail] = useState<string | null>(() => (PREVIEW ? null : accountEmail()));
  const signer = useMemo<{ me: Signer | null; error: string | null }>(() => {
    if (PREVIEW) return { me: previewSigner, error: null };
    try {
      return { me: loadSigner(), error: null };
    } catch (e) {
      return { me: null, error: e instanceof SignerUnavailable ? e.message : String(e) };
    }
  }, [keyVersion]);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const account: AccountCtl = {
    email,
    signIn: async (e, pw) => {
      await accountSignIn(e, pw);
      setEmail(accountEmail());
      setKeyVersion((v) => v + 1);
    },
    create: async (e, pw) => {
      const key = signerKey();
      if (!key) throw new Error("This device has no key to save");
      await createAccount(e, pw, key);
      setEmail(accountEmail());
    },
    // Log out: this device forgets its key and the console goes back to the log-in screen.
    // Saved to an account, the key comes back on the next log-in; not saved, it's gone for good.
    signOut: async () => {
      const ok = email
        ? await askConfirm(`Log out of ${email}? This device forgets your key until you log in again.`, { action: "Log out", icon: "logout" })
        : await askConfirm("This device's key isn't saved to an account. Logging out deletes it for good: you'd lose your seat until a teammate adds you back. Create an account first to keep it.", { action: "Log out and delete key", danger: true });
      if (!ok) return;
      accountSignOut();
      setEmail(null);
      setKeyVersion((v) => v + 1);
      notify("ok", "Logged out");
    },
  };
  const [busy, setBusy] = useState(false);
  // Not a member: the start screen is Create organization; its "Ask to Join" opens the join page.
  const [joining, setJoining] = useState(false);
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
  useEffect(() => setSessionSigner(PREVIEW ? null : (signer.me as never)), [signer.me]);
  const isViewer = !!s && !!signer.me && roleOf(s, signer.me.address).id === "viewer";
  if (!s && gk.offline) body = <Offline reason={gk.offline} />;
  else if (!s) body = <Loading text="Connecting to the Gatekeeper…" />;
  else if (!signer.me) body = <div className="center"><Backdrop /><div className="onboard narrow"><div className="onboard-body"><h2 className="setup-title heading-gradient">No signing key</h2><p className="lede">{signer.error}</p><AccountBox key={account.email ?? "logged-out"} me={null} account={account} run={run} busy={busy} /></div></div></div>;
  else if (joining && (!s.setUp || (s.policy && !s.policy.members.some((m) => m.address === signer.me!.address.toLowerCase()))))
    body = <Join me={signer.me} run={run} busy={busy} account={account} onBack={() => setJoining(false)} />;
  // Logged out (or new here): every start is a brand-new organization. Creating one when this app
  // already runs an organization archives that one to a backup folder first (Gatekeeper side).
  else if (!s.setUp) body = <Setup s={s} me={signer.me} run={run} busy={busy} account={account} onJoin={() => setJoining(true)} />;
  else if (!s.policy) body = <Loading text="Reading Dharma from Arc…" />;
  else if (!s.policy.members.some((m) => m.address === signer.me!.address.toLowerCase()) && !isViewer) body = <Setup s={s} me={signer.me} run={run} busy={busy} account={account} onJoin={() => setJoining(true)} replace />;
  else body = <Console s={s} log={gk.log} wallet={gk.wallet} refreshWallet={gk.refreshWallet} run={run} busy={busy} me={signer.me} offline={gk.offline} refresh={gk.refresh} account={account} />;

  return (
    <>
      {body}
      {busy && <div className="busy-bar" />}
      {busy && <WorkingNotice />}
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

const SETUP_STEPS = ["Account", "Organization", "Wallet", "Team", "Review"] as const;

/**
 * A new organization, one question per page: account, names, wallet, team structure, then a review
 * before Dharma is deployed. Joining someone else's organization branches off the first page.
 */
function Setup({ s, me, run, busy, account, onJoin, replace = false }: { s: Snapshot; me: Signer; run: Run; busy: boolean; account: AccountCtl; onJoin: () => void; replace?: boolean }) {
  const [step, setStep] = useState(-1); // -1: start a new organization or join one
  const [form, setForm] = useState({ orgName: "", memberName: "", walletAddress: "" });
  const [structure, setStructure] = useState<Structure>("flat");
  const [balance, setBalance] = useState<number | null>(null);
  const deploying = busy || s.deploying;
  const last = SETUP_STEPS.length - 1;

  const create = () =>
    run(async () => {
      const r = await api<{ dharma: { address: string } }>("/setup", { ...form, memberAddress: me.address, replace });
      // A new Dharma is Flat; a Tree is one signed role change, made right after.
      if (structure === "tree") await submitChange(me, r.dharma.address as Address, { kind: Kind.Manage, change: { op: "SetStructure", structure: "tree" } });
      return r;
    }, "Your organization is live");

  const ready = [
    true,
    !!form.orgName.trim() && !!form.memberName.trim(),
    isAddr(form.walletAddress) && balance !== 0,
    true,
    true,
  ][Math.max(step, 0)];

  if (step === -1) {
    return (
      <div className="center">
        <Backdrop />
        <div className="onboard narrow rise">
          <OnboardTop sub={replace ? "New organization" : "Get started"} />
          <div className="onboard-body">
            <div>
              <h2 className="setup-title heading-gradient">Welcome to Karuna</h2>
              <p className="lede">Your AI agents act only within rules your team agrees on, and no one can loosen them alone.</p>
            </div>
            <div className="choices">
              <button type="button" className="choice start-choice" onClick={() => setStep(0)}>
                <Icon name="plus" size={18} />
                <span><b>Start a new organization</b><span className="choice-text">Set up your team's rulebook. You'll be its first member.</span></span>
                <Icon name="arrow" size={16} className="choice-go" />
              </button>
              <button type="button" className="choice start-choice" onClick={onJoin}>
                <Icon name="plug" size={18} />
                <span><b>Join an organization</b><span className="choice-text">Use an invite link from one of its members.</span></span>
                <Icon name="arrow" size={16} className="choice-go" />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const page = (() => {
    switch (step) {
      case 0:
        return (
          <>
            <StepHead title="Save your key to an account" lede="This browser holds the key that signs your votes and approvals. An account lets you use the same key on any device." />
            <AccountBox key={account.email ?? "logged-out"} me={me} account={account} run={run} busy={busy} />
          </>
        );
      case 1:
        return (
          <>
            <StepHead title="Name your organization" lede="Both names stay private to this computer." />
            <label className="field">
              <span>Organization name</span>
              <input required autoFocus value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} placeholder="Your company" />
            </label>
            <label className="field">
              <span>Your name</span>
              <input required value={form.memberName} onChange={(e) => setForm({ ...form, memberName: e.target.value })} placeholder="First approver" />
            </label>
          </>
        );
      case 2:
        return (
          <>
            <StepHead title="Connect a wallet" lede="Your agents' purchases are paid from a Circle wallet in USDC. It also covers the small fee to set up your organization." />
            <WalletStep value={form.walletAddress} onChange={(w) => setForm((f) => ({ ...f, walletAddress: w }))} onBalance={setBalance} run={run} busy={busy} email={account.email} />
          </>
        );
      case 3:
        return (
          <>
            <StepHead title="How does your team work?" lede="You can switch later in Team. Every member can always vote either way." />
            <StructureChoice value={structure} onPick={setStructure} disabled={deploying} stacked />
          </>
        );
      default:
        return (
          <>
            <StepHead title="Review and create" lede="Your rules live on Arc, so no one, not even Karuna, can change them alone. Every change needs your team's vote and a short wait; only the panic button acts at once." />
            <dl className="review">
              {([
                ["Organization", form.orgName, 1],
                ["You", form.memberName, 1],
                ["Account", account.email ?? <span className="muted">Not saved to an account</span>, 0],
                ["Wallet", <><span className="mono">{short(form.walletAddress)}</span>{balance !== null && <span className="muted"> · {fmtUsdc(balance)} USDC</span>}</>, 2],
                ["Team", STRUCTURES[structure].label, 3],
              ] as const).map(([k, v, to]) => (
                <div className="review-row" key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                  <button type="button" className="link-btn small" disabled={deploying} onClick={() => setStep(to)}>Change</button>
                </div>
              ))}
            </dl>
          </>
        );
    }
  })();

  return (
    <div className="center">
      <Backdrop />
      <form className="onboard narrow rise" onSubmit={(e) => {
        e.preventDefault();
        if (!ready || deploying) return;
        if (step === last) void create();
        else setStep(step + 1);
      }}>
        <OnboardTop sub={replace ? "New organization" : "Get started"} />
        <div className="setup-steps" aria-label={`Step ${step + 1} of ${SETUP_STEPS.length}: ${SETUP_STEPS[step]}`}>
          <div className="setup-steps-bar">{SETUP_STEPS.map((n, i) => <span key={n} className={i < step ? "done" : i === step ? "on" : ""} />)}</div>
          <div className="setup-steps-label"><span>Step {step + 1} of {SETUP_STEPS.length}</span><span>{SETUP_STEPS[step]}</span></div>
        </div>
        <div className="onboard-body" key={step}>
          {page}
          <div className="onboard-nav">
            <button type="button" className="back-btn back" disabled={deploying} onClick={() => setStep(step - 1)}><Icon name="arrow" size={15} /> Back</button>
            {step === 0 && !account.email && <button type="button" className="link-btn small" onClick={() => setStep(1)}>Skip for now</button>}
            <button className="btn btn-dark btn-lg" type="submit" disabled={!ready || deploying || (step === 0 && !account.email)}>
              {step === last
                ? deploying ? <span className="shimmer">Setting up your organization…</span> : <>Create organization <span className="nudge"><Icon name="arrow" size={16} /></span></>
                : <>Continue <span className="nudge"><Icon name="arrow" size={16} /></span></>}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function StepHead({ title, lede }: { title: string; lede: string }) {
  return (
    <div>
      <h2 className="setup-title heading-gradient">{title}</h2>
      <p className="lede">{lede}</p>
    </div>
  );
}

const fmtUsdc = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(2));

interface WalletLogin { cli: boolean; loggedIn: boolean; email: string | null; expiresIn: string | null }
const PREVIEW_NO_WALLET = PREVIEW && new URLSearchParams(location.search).has("nowallet");

/**
 * The Gatekeeper's Circle wallet, without a terminal: find the wallets this machine's Circle login
 * has; if there's no login, sign in with a code Circle emails (a first sign-in creates the wallets);
 * then top up from Circle's testnet faucet if it's empty.
 */
function WalletStep({ value, onChange, onBalance, run, busy, email: accountEmail }: {
  value: string; onChange: (w: string) => void; onBalance: (n: number | null) => void; run: Run; busy: boolean; email: string | null;
}) {
  const [login, setLogin] = useState<WalletLogin | null>(null);
  const [wallets, setWallets] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [email, setEmail] = useState(accountEmail ?? "");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [manual, setManual] = useState(false);

  const load = async () => {
    setErr(null);
    if (PREVIEW) {
      setLogin({ cli: true, loggedIn: !PREVIEW_NO_WALLET, email: "you@company.com", expiresIn: "27d" });
      if (!PREVIEW_NO_WALLET) {
        setWallets([previewWallet.address]);
        if (!value) onChange(previewWallet.address);
      }
      return;
    }
    const st = await api<WalletLogin>("/wallets/status");
    setLogin(st);
    if (!st.loggedIn) return;
    const r = await api<{ wallets: string[]; error?: string }>("/wallets/detect");
    setWallets(r.wallets);
    if (r.error) setErr(r.error);
    if (!isAddr(value) && r.wallets.length) onChange(r.wallets[0]);
  };
  useEffect(() => {
    load().catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const readBalance = async (w: string) => {
    if (PREVIEW) return Number(previewWallet.usdc);
    const b = await api<{ usdc: string }>(`/wallets/${w}/balance`);
    return Number(b.usdc);
  };
  useEffect(() => {
    setBalance(null);
    onBalance(null);
    if (!isAddr(value)) return;
    let live = true;
    readBalance(value).then((n) => live && Number.isFinite(n) && (setBalance(n), onBalance(n))).catch(() => undefined);
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const sendCode = () => {
    if (PREVIEW) return void setRequestId("preview");
    void run(async () => setRequestId((await api<{ requestId: string }>("/wallets/login", { email: email.trim() })).requestId), `Circle sent a code to ${email.trim()}`);
  };
  const verify = () =>
    void run(async () => {
      await api("/wallets/login/verify", { requestId, code: code.trim() });
      setRequestId(null);
      setCode("");
      await load();
    }, "Signed in to Circle");
  const fund = () =>
    void run(async () => {
      await api("/wallets/fund", { address: value });
      setWaiting(true);
      // The faucet's transfer lands in a few seconds: watch the balance until it does.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const n = await readBalance(value).catch(() => null);
        if (n !== null && n > 0) {
          setBalance(n);
          onBalance(n);
          break;
        }
      }
      setWaiting(false);
    }, "Test USDC requested from Circle's faucet");
  const enter = (fn: () => void) => (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      fn();
    }
  };

  if (!login) return <p className="muted small">{err ?? <span className="shimmer">Looking for Circle wallets on this machine…</span>}</p>;

  if (!login.cli) {
    return (
      <div className="keybox">
        <span className="field-label"><Icon name="alert" size={14} /> Circle CLI not found</span>
        <div className="small">The Gatekeeper uses Circle's CLI to pay. Install it on this machine, then come back to this page:</div>
        <code className="token">npm install -g @circle-fin/cli</code>
        <div><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void load().catch((e) => setErr(String(e)))}>Check again</button></div>
      </div>
    );
  }

  if (!login.loggedIn) {
    return (
      <div className="keybox">
        <span className="field-label"><Icon name="wallet" size={14} /> Sign in to Circle</span>
        {!requestId ? (
          <>
            <label className="field">
              <span>Email</span>
              <span className="input-icon">
                <Icon name="inbox" size={15} />
                <input className="plain-input" type="email" aria-label="Circle email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={enter(sendCode)} placeholder="you@company.com" />
              </span>
              <small>Circle emails you a sign-in code. Your first sign-in creates your wallet.</small>
            </label>
            <div><button type="button" className="btn btn-dark btn-sm" disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())} onClick={sendCode}>Email me a code</button></div>
          </>
        ) : (
          <>
            <label className="field">
              <span>Code from the email</span>
              <input className="mono code-input" inputMode="numeric" autoComplete="one-time-code" autoFocus aria-label="Code from Circle's email" value={code} maxLength={10} onChange={(e) => setCode(e.target.value)} onKeyDown={enter(verify)} placeholder="123456" />
              <small>Sent to {email.trim()}. Type it here yourself and never share it: anyone with the code can use the wallet.</small>
            </label>
            <div className="row-form">
              <button type="button" className="btn btn-dark btn-sm" disabled={busy || !/^([A-Za-z0-9]{3}-)?\d{6}$/.test(code.trim())} onClick={verify}>Verify</button>
              <button type="button" className="link-btn small" disabled={busy} onClick={() => { setRequestId(null); setCode(""); }}>Use a different email</button>
            </div>
          </>
        )}
      </div>
    );
  }

  const empty = balance === 0;
  return (
    <div className="stack-sm">
      <div className="small muted">Signed in to Circle as <b>{login.email ?? "your account"}</b>.</div>
      {wallets && wallets.length > 0 ? (
        <div className="choices" role="radiogroup" aria-label="Wallet">
          {wallets.map((w) => (
            <button type="button" role="radio" aria-checked={value === w} key={w} className={`choice ${value === w ? "sel" : ""}`} onClick={() => onChange(w)}>
              <span className="radio" /> <span className="mono">{short(w)}</span>
              <span className="tag">{value === w && balance !== null ? `${fmtUsdc(balance)} USDC` : "Circle wallet"}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="muted small">{err ?? "No Circle wallets on this account yet."}</p>
      )}
      {isAddr(value) && empty && (
        <div className="keybox">
          <span className="field-label"><Icon name="alert" size={14} /> No USDC yet</span>
          <div className="small">Setting up needs a little USDC to cover fees. Circle sends free test USDC.</div>
          <div><button type="button" className="btn btn-dark btn-sm" disabled={busy || waiting} onClick={fund}>{waiting ? <span className="shimmer">Waiting for the faucet…</span> : "Get test USDC"}</button></div>
        </div>
      )}
      {manual ? (
        <label className="field">
          <span>Wallet address</span>
          <input className="mono" aria-label="Wallet address" value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder="0x… Circle wallet address" />
        </label>
      ) : (
        <div><button type="button" className="link-btn small" onClick={() => setManual(true)}>Enter an address instead</button></div>
      )}
    </div>
  );
}

/** Flat (every member can do everything) or Tree (an Admin sets roles). */
function StructureChoice({ value, onPick, disabled, stacked }: { value: Structure; onPick: (v: Structure) => void; disabled?: boolean; stacked?: boolean }) {
  return (
    <div className={`choices structure-choices${stacked ? " stacked" : ""}`} role="radiogroup" aria-label="Team structure">
      {(Object.keys(STRUCTURES) as Structure[]).map((k) => (
        <button type="button" role="radio" aria-checked={value === k} key={k} disabled={disabled} className={`choice ${value === k ? "sel" : ""}`} onClick={() => value !== k && onPick(k)}>
          <span className="radio" />
          <span><b>{STRUCTURES[k].label}</b><span className="choice-text">{STRUCTURES[k].text}</span></span>
        </button>
      ))}
    </div>
  );
}

// ============================================================== join: a browser that isn't a member yet

function Join({ me, run, busy, account, onBack }: { me: Signer; run: Run; busy: boolean; account: AccountCtl; onBack: () => void }) {
  const [name, setName] = useState("");
  const [link, setLink] = useState("");
  const [found, setFound] = useState<{ link: string; org: string } | null>(null);
  const [lookErr, setLookErr] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [sent, setSent] = useState<SentJoin[]>(() => sentJoins(me.address));
  const code = inviteCode(link);

  // Look the link up as soon as it's pasted: say whose organization it is before anything is sent.
  useEffect(() => {
    setFound(null);
    setLookErr(null);
    if (!link.trim()) return;
    if (!code) {
      setLookErr("That isn't a Karuna invite link (it ends in /invite/inv_…).");
      return;
    }
    let live = true;
    setLooking(true);
    lookupInvite(link)
      .then((r) => { if (live) setFound({ link, org: r.org }); }, (e) => { if (live) setLookErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (live) setLooking(false); });
    return () => { live = false; };
  }, [link]);

  const sendInvite = () => {
    if (!found) return;
    run(async () => {
      const r = await sendJoin(me, found.link, found.org, name);
      setSent(sentJoins(me.address));
      setLink("");
      if (r.status === "member") throw new Error(`You're already a member of ${r.org}`);
    }, `Request sent to ${found.org}`);
  };
  const check = (j: SentJoin) => run(async () => { await joinStatus(j); setSent(sentJoins(me.address)); });

  return (
    <div className="center">
      <Backdrop />
      <div className="onboard narrow rise">
        <OnboardTop sub="Ask to join" />
        <div className="onboard-body">
          <div>
            <button type="button" className="back-btn back" onClick={onBack}><Icon name="arrow" size={16} /> Go back</button>
            <h2 className="setup-title heading-gradient" style={{ marginTop: 14 }}>Ask to join an organization</h2>
            <p className="lede">Paste the invite link a member sent you. Your request is signed with this device's key, and their members vote to add you.</p>
          </div>
          <label className="field">
            <span>Your name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="So the team recognizes you" maxLength={40} />
          </label>
          <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); sendInvite(); }}>
            <label className="field">
              <span>Invite link</span>
              <span className={`input-icon${lookErr ? " bad" : ""}`}>
                <Icon name="chain" size={15} />
                <input className="plain-input mono" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…/invite/inv_…" spellCheck={false} />
              </span>
              {looking && <small className="shimmer">Looking up the invite…</small>}
              {lookErr && <small className="bad-text" role="alert">{lookErr}</small>}
              {found && <small className="ok-text"><Icon name="check" size={13} /> Invite to <b>{found.org}</b></small>}
            </label>
            <button className="btn btn-dark btn-lg btn-block" disabled={busy || !found || !name.trim()}>
              {found ? `Ask to join ${found.org}` : "Send join request"} <span className="nudge"><Icon name="arrow" size={16} /></span>
            </button>
          </form>
          {sent.length > 0 && (
            <div className="keybox">
              <span className="field-label"><Icon name="inbox" size={14} /> Requests you sent</span>
              {sent.slice().reverse().map((j) => (
                <div className="sent-join" key={j.link}>
                  <div><b>{j.org}</b><div className="small muted">{j.status === "member" ? "You're a member" : j.status === "viewer" ? "You're a Viewer: you can see their console" : j.status === "none" ? "Not found: they may have removed it" : "Waiting for their members' vote"} · sent {ago(j.sentAt)}</div></div>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => check(j)}>Check</button>
                </div>
              ))}
            </div>
          )}
          <AccountBox key={account.email ?? "logged-out"} me={me} account={account} run={run} busy={busy} />
        </div>
      </div>
    </div>
  );
}

// ============================================================== who signs: email account or this device's key

interface AccountCtl {
  email: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  create: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

/** Log in with email and password, or save this device's key to a new account. */
function AccountBox({ me, account, run, busy }: { me: Signer | null; account: AccountCtl; run: Run; busy: boolean }) {
  const [mode, setMode] = useState<"in" | "create">("in");
  const [form, setForm] = useState({ email: "", password: "", again: "" });
  const [showPw, setShowPw] = useState(false);
  const [pwTouched, setPwTouched] = useState(false);
  if (account.email) {
    return (
      <div className="keybox">
        <span className="field-label"><Icon name="check" size={14} /> Logged in</span>
        <div><b>{account.email}</b>{me && <span className="mono small muted"> {short(me.address)}</span>}</div>
        <div className="small muted">The same member on every device you log in on. <button type="button" className="link-btn" onClick={() => void account.signOut()}>Log out</button></div>
      </div>
    );
  }
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()) && form.password.length >= (mode === "create" ? 10 : 1) && (mode === "in" || form.password === form.again);
  const pwType = showPw ? "text" : "password";
  const mismatch = mode === "create" && form.again.length > 0 && form.again !== form.password;
  // New accounts need 10+ characters: say so once the person leaves the box (then live until it's long enough).
  const tooShort = mode === "create" && pwTouched && form.password.length > 0 && form.password.length < 10;
  return (
    <div className="keybox">
      <div className="email-signin">
        <span className="field-label"><Icon name="key" size={14} /> {mode === "in" ? "Log in" : "Save this device's key to an account"}</span>
        <label className="field">
          <span>Email</span>
          <span className="input-icon">
            <Icon name="inbox" size={15} />
            <input className="plain-input" type="email" aria-label="Email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@company.com" />
          </span>
        </label>
        <label className="field">
          <span>Password</span>
          <span className={`input-icon${tooShort ? " bad" : ""}`}>
            <Icon name="lock" size={15} />
            <input className="plain-input" type={pwType} aria-label="Password" aria-invalid={tooShort || undefined} autoComplete={mode === "in" ? "current-password" : "new-password"} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} onBlur={() => setPwTouched(true)} placeholder={mode === "in" ? "Your password" : "At least 10 characters"} />
            <button type="button" className="input-toggle" onMouseDown={(e) => e.preventDefault()} onClick={() => setShowPw(!showPw)} aria-label={showPw ? "Hide password" : "Show password"}>{showPw ? "Hide" : "Show"}</button>
          </span>
          {tooShort && <small className="bad-text" role="alert">Too short: use at least 10 characters ({form.password.length} so far).</small>}
        </label>
        {mode === "create" && (
          <label className="field">
            <span>Password again</span>
            <span className={`input-icon${mismatch ? " bad" : ""}`}>
              <Icon name="lock" size={15} />
              <input className="plain-input" type={pwType} aria-label="Password again" autoComplete="new-password" value={form.again} onChange={(e) => setForm({ ...form, again: e.target.value })} placeholder="Type it again" />
            </span>
            {mismatch && <small className="bad-text">The passwords don't match yet.</small>}
          </label>
        )}
        <div className="row-form">
          <button type="button" className="btn btn-dark" disabled={busy || !ok}
            onClick={() => run(() => (mode === "in" ? account.signIn(form.email, form.password) : account.create(form.email, form.password)), mode === "in" ? "Logged in" : "Account created")}>
            {mode === "in" ? "Log in" : "Create account"}
          </button>
          <button type="button" className="link-btn small" onClick={() => setMode(mode === "in" ? "create" : "in")}>{mode === "in" ? "Create an account" : "I have an account"}</button>
        </div>
        <div className="small muted">{mode === "in" ? "Use the same email and password on any device." : "Your password locks your key in this browser; Karuna can't open it or reset it."}</div>
      </div>
      {me && (
        <div className="device-key">
          <span className="field-label"><Icon name="key" size={14} /> This device's key</span>
          <div className="mono">{me.address}</div>
        </div>
      )}
    </div>
  );
}

// ============================================================== console shell

interface Ctx {
  s: Snapshot;
  me: Signer;
  run: Run;
  busy: boolean;
  /** Sign a change. Every rule change is proposed for a vote; only the panic button (Freeze) applies at once. */
  change: (c: Change, label?: string) => Promise<boolean>;
  /** Sign a team-role change (SetRole, SetRolePerms, SetStructure): applies at once, needs "team". */
  manage: (c: Change, done: string, label?: string) => Promise<boolean>;
  /** Every member can always vote, whatever their role. */
  vote: (g: Governance, support: boolean) => Promise<boolean>;
  name: (address?: string | null) => string;
  /** What this person's role lets them do (the Gatekeeper checks it too). */
  can: (p: Permission) => boolean;
}

function Console({ s, log, wallet, refreshWallet, run, busy, me, offline, refresh, account }: { s: Snapshot; log: LogEntry[]; wallet: WalletInfo | null; refreshWallet: () => void; run: Run; busy: boolean; me: Signer; offline: string | null; refresh: () => Promise<void>; account: AccountCtl }) {
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
  // A rule named in Activity opens on Rules, scrolled to and briefly highlighted.
  useEffect(() => {
    const open = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      setPage("rules");
      setTimeout(() => {
        const row = document.getElementById(`rule-${id}`);
        if (!row) return;
        row.scrollIntoView({ block: "center", behavior: "smooth" });
        row.classList.add("rule-focus");
        setTimeout(() => row.classList.remove("rule-focus"), 2000);
      }, 80);
    };
    window.addEventListener("karuna:open-rule", open);
    return () => window.removeEventListener("karuna:open-rule", open);
  }, []);
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
      // Left side: a fixed allowance for the longest page title (not the current one, so the bar
      // doesn't move between pages). Right side: the buttons.
      const titleEnd = b.left + 32 + 160; // widest title block measured at 145px
      const room = 2 * Math.min(r.left - mid, mid - titleEnd) - 32;
      // Prefer the window's center. When that's too tight (narrow window, sidebar pinned), center it
      // in the free space between the title and the buttons instead; then icon only; then hidden.
      const gap = r.left - titleEnd - 32;
      const [x, size] =
        room >= 200 ? [mid, "full"] :
        gap >= 200 ? [titleEnd + 16 + gap / 2, "full"] :
        gap >= 54 ? [titleEnd + 16 + gap / 2, "icon"] :
        [mid, "none"];
      bar.dataset.search = size;
      bar.style.setProperty("--search-x", `${x - b.left}px`);
      bar.style.setProperty("--search-w", size === "full" ? `${Math.min(340, x === mid ? room : gap)}px` : "38px");
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
  setChainTime(pol.chainTime); // before anything below renders a chain time
  const clockOffMin = Math.round(chainSkewMs / 60_000);
  const dharma = s.org.dharma!.address as Address;
  const myAddr = me.address.toLowerCase();
  const myName = pol.members.find((m) => m.address === myAddr)?.name ?? short(myAddr);
  const name = (a?: string | null) => (a ? (pol.members.find((m) => m.address === a.toLowerCase())?.name ?? short(a)) : "—");
  const role = roleOf(s, me.address);
  const refuse = (p: Permission) => {
    void run(async () => {
      throw new Error(`Your role (${role.def?.name ?? "none"}) can't do this. It needs "${PERMISSIONS[p]}"; ask an Admin.`);
    });
    return Promise.resolve(false);
  };
  const ctx: Ctx = {
    s, me, run, busy, name, can: role.can,
    change: (c, label) => {
      // Instant: the panic button, and a member lowering an agent's level. Everything else is voted on.
      const lowering = c.op === "SetLevel" && c.reason === "member";
      const need: Permission = c.op === "Freeze" ? "freeze" : lowering ? "agents" : "propose";
      if (!role.can(need)) return refuse(need);
      const now = c.op === "Freeze" || lowering;
      return run(
        () => submitChange(me, dharma, { kind: now ? Kind.Tighten : Kind.Propose, change: c, label }),
        // A proposal's confirmation comes from the chain, bottom right (one card, two with a wait);
        // the centre message is only for when live events are off.
        lowering ? "Level lowered — recorded on Dharma" : now ? "All agents frozen — recorded on Dharma" : liveRef.current ? undefined : `Proposed — goes to Votes: needs ${pol.required} vote${pol.required > 1 ? "s" : ""}, then ${pol.timelock}s`,
      );
    },
    manage: (c, done, label) => !role.can("team") ? refuse("team") : run(() => submitChange(me, dharma, { kind: Kind.Manage, change: c, label }), done),
    vote: (g, support) => run(() => submitChange(me, dharma, { kind: Kind.Vote, change: g.change as Change, proposalId: g.id, support }), support ? "Vote recorded" : "Voted against"),
  };

  // ---- live chain alerts (QuickNode Stream -> relay -> every member's screen)
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const sRef = useRef(s);
  sRef.current = s;
  // Proposals: one card per proposal (two when there's a wait), never one per chain event.
  const toaster = useRef(new ProposalToaster());
  const govWhat = useRef(new Map<number, string>());
  const show = (cards: Omit<Alert, "at">[]) => {
    if (!cards.length) return;
    const now = Date.now();
    // At most 3 on screen; a newer card about the same proposal replaces the older one.
    setAlerts((prev) => [...cards.map((a) => ({ ...a, at: now })), ...prev.filter((p) => !cards.some((c) => c.id === p.id || (c.proposalId !== undefined && c.proposalId === p.proposalId)))].slice(0, MAX_ALERTS));
  };
  const toCard = (t: ProposalToast, source: Alert["source"]): Omit<Alert, "at"> => ({
    id: t.key, title: t.title, body: t.body, tone: t.tone, sticky: t.sticky, source,
    ...(t.vote ? { go: "dharma" as View, cta: "Vote" } : {}), ...(t.proposalId !== undefined ? { proposalId: t.proposalId } : {}),
  });
  const live = useRelay((events) => {
    void refresh();
    const now = Date.now();
    const cards: Omit<Alert, "at">[] = [];
    for (const e of events) {
      const g = govEvent(e, sRef.current, me.address, name, govWhat.current);
      if (g) cards.push(...toaster.current.push(g, now).map((t) => toCard(t, e.source)));
      else {
        const a = toAlert(e, sRef.current, name);
        if (a) cards.push(a);
      }
    }
    show(cards);
  });
  const liveRef = useRef(false);
  liveRef.current = live.mode === "quicknode" || live.mode === "rpc";
  useEffect(() => {
    const t = setInterval(() => {
      const p = sRef.current.policy;
      if (p) show(toaster.current.flush(Date.now(), { required: p.required, timelock: p.timelock, instant: p.members.length === 1 }).map((t) => toCard(t, "rpc")));
    }, 500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    // A "vote on this" alert stays only while there's still a vote for this member to cast.
    const nothingToVote = (a: Alert) => {
      if (a.proposalId === undefined) return false;
      const g = sRef.current.policy?.proposals.find((x) => x.id === a.proposalId);
      return !!g && (g.status !== "open" || g.voters.includes(me.address.toLowerCase()));
    };
    // A freeze alert ("Unfreezing needs a member vote") stays only while agents are still frozen.
    const thawed = (a: Alert) => !!a.whileFrozen && !sRef.current.frozen;
    // A vote or freeze card goes as soon as there's nothing left to do about it. Otherwise a card
    // leaves when its timer bar runs out (the bar is the only clock; see .alert-timer).
    // Same array back when nothing changed, so the whole console doesn't re-render on every tick.
    const t = setInterval(
      () =>
        setAlerts((prev) => {
          const kept = prev.filter((a) => !(a.sticky && (nothingToVote(a) || thawed(a))));
          return kept.length === prev.length ? prev : kept;
        }),
      500,
    );
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
            whileFrozen: a.kind === "swarm-stopped",
          };
        }),
        ...prev,
      ].slice(0, MAX_ALERTS));
    }
  }, [s.shield.alerts]);

  // Waiting on me: not ones I've already signed that still need someone else's approval.
  const pending = s.proposals.filter((p) => p.status === "pending" && !p.approvals.some((a) => a.memberId === myAddr));
  const ballots = pol.proposals.filter((g) => g.status === "open" && !g.voters.includes(myAddr));
  const frozen = s.frozen || null;
  const openUnfreeze = pol.proposals.find((g) => g.change?.op === "Unfreeze" && (g.status === "open" || g.status === "queued"));

  // ---- Ctrl+K: every page, then the common actions
  const commands: Command[] = [
    ...NAV.flatMap((g) => g.pages.map((v) => ({ id: `go-${v}`, label: TITLES[v], hint: g.label ?? "Go to", icon: ICON[v], keywords: v, run: () => setView(v) }))),
    ...(pending.length ? [{ id: "review", label: `Review ${pending.length} waiting approval${pending.length > 1 ? "s" : ""}`, hint: "Approvals", icon: "approvals" as IconName, run: () => setView("approvals") }] : []),
    ...(ballots.length ? [{ id: "vote", label: `Vote on ${ballots.length} open change${ballots.length > 1 ? "s" : ""}`, hint: "Votes", icon: "votes" as IconName, run: () => setView("votes") }] : []),
    { id: "new-rule", label: "Add a rule", hint: "Proposals", icon: "plus", keywords: "policy block allow approval english", run: () => setView("proposals") },
    { id: "new-agent", label: "Add an agent", hint: "Agents", icon: "plus", keywords: "token", run: () => setView("agents") },
    { id: "waits", label: "Change the waits", hint: "Proposals", icon: "clock", keywords: "timelock core", run: () => setView("proposals") },
    ...(["system", "light", "dark"] as const).map((t) => ({ id: `theme-${t}`, label: `Theme: ${t === "system" ? "System" : t === "light" ? "Light" : "Dark"}`, hint: "Appearance", icon: "sun" as IconName, keywords: "dark light mode appearance", run: () => setThemePref(t) })),
    ...(IN_APP ? [{ id: "island", label: getIslandEnabled() ? "Turn the island off" : "Turn the island on", hint: "Appearance", icon: "sun" as IconName, keywords: "notch lotus", run: () => setIslandEnabled(!getIslandEnabled()) }] : []),
    { id: "sidebar", label: sideHidden ? "Pin the sidebar" : "Hide the sidebar", hint: "View", icon: sideHidden ? "pin" : "panel", keywords: "menu nav", run: toggleSide },
    ...(frozen
      ? [{ id: "unfreeze", label: "Unfreeze agents (goes to a vote)", hint: "Safety", icon: "stop" as IconName, run: () => (openUnfreeze ? setView("votes") : void ctx.change({ op: "Unfreeze" })) }]
      : !role.can("freeze") ? [] : [{ id: "freeze", label: "Freeze all agents", hint: "Safety", icon: "stop" as IconName, keywords: "panic stop", run: () => void askConfirm("Freeze every agent now? Unfreezing needs a vote.", { action: "Freeze all agents", danger: true, icon: "stop" }).then((ok) => ok && ctx.change({ op: "Freeze" })) }]),
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
                const n = v === "activity" ? pending.length + ballots.length : v === "team" ? s.enrollments.length
                  : v === "safety" ? s.shield.autoRules.filter((r) => r.active).length + s.swarm.tainted.length : 0;
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
          <div className="who" title={account.email ? `Logged in as ${account.email} · ${myAddr}` : `This device's key · ${myAddr}`}><div>{myName}</div><div>{account.email ?? short(myAddr)}</div></div>
        </div>
        <button type="button" className="logout-btn" onClick={() => void account.signOut()}><Icon name="logout" size={15} /> Log out</button>
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
            ) : role.can("freeze") ? (
              <button className="panic" disabled={busy} title="Freezes every agent at once. Unfreezing needs a vote." onClick={() => ctx.change({ op: "Freeze" })}><Icon name="stop" /> Freeze all agents</button>
            ) : null}
          </div>
        </header>

        {role.id === "viewer" && <div className="viewer-note"><Icon name="team" size={14} /> You're a Viewer: you can see everything here, but approving and changing things is up to the members.</div>}
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
              {/* The card's clock: it closes when this bar runs out. Hovering or focusing the card pauses the bar where it is. */}
              <span className="alert-timer" aria-hidden style={{ animationDuration: `${alertReadMs(a)}ms` }} onAnimationEnd={() => dismiss(a.id)} />
            </div>
          ))}
        </div>

        <div className="content" key={view}>
          {Math.abs(clockOffMin) >= 5 && (
            <div className="clock-note" role="status">
              <Icon name="clock" size={16} />
              <span>
                This computer's clock is {fmtSkew(clockOffMin)} {clockOffMin > 0 ? "ahead of" : "behind"} Arc's. Vote times and countdowns are corrected; to fix it for good, turn on
                <b> Settings → Time &amp; language → Date &amp; time → Set time automatically</b>, then <b>Sync now</b>.
              </span>
            </div>
          )}
          {frozen && (
            <div className="freeze-banner" role="alert">
              <Icon name="stop" size={20} />
              <div>
                <b>Every agent is frozen.</b> {freezeCause(frozen.by)} Every request is denied and no payment can execute.
                {frozen.confirmed ? " Recorded on Dharma." : " Recording on Dharma…"} Unfreezing needs {pol.required} vote{pol.required > 1 ? "s" : ""} and a {pol.timelock}s wait.
              </div>
            </div>
          )}
          {view === "overview" && <Overview ctx={ctx} wallet={wallet} refreshWallet={refreshWallet} go={setView} />}
          {view === "activity" && <ActivityPage ctx={ctx} dharma={dharma} log={log} />}
          {view === "agents" && <Agents ctx={ctx} />}
          {view === "safety" && <Safety ctx={ctx} />}
          {view === "proposals" && <div className="stack"><Policy ctx={ctx} part="propose" /><Waits ctx={ctx} /><Learned ctx={ctx} /></div>}
          {view === "rules" && <div className="stack"><Policy ctx={ctx} part="list" /><Payees ctx={ctx} /><TrustedSites ctx={ctx} /></div>}
          {view === "team" && <Team ctx={ctx} />}
          {view === "appearance" && <Appearance />}
        </div>
      </main>
    </div>
  );
}

// ============================================================== overview

/**
 * Add funds to Gateway: USDC moves from the org's Circle wallet into its Gateway balance, which
 * agents spend for paid data (x402 nanopayments). On testnet there's no other way to fill it.
 */
function AddFunds({ wallet, run, onClose, onDone }: { wallet: WalletInfo; run: Run; onClose: () => void; onDone: () => void }) {
  const have = Number(wallet.usdc) || 0;
  // Arc pays gas in USDC, so keep a little back when "Max" is used.
  const max = Math.max(0, Math.floor((have - 0.02) * 100) / 100);
  const [amount, setAmount] = useState(() => (max >= 1 ? "1" : max > 0 ? String(max) : ""));
  const [sending, setSending] = useState(false);
  const n = Number(amount);
  const err = !amount.trim() ? null : !Number.isFinite(n) || n < 0.01 ? "Enter at least $0.01" : n > max ? `The wallet has ${usd(have)} (a little stays for fees)` : null;
  const ok = !!amount.trim() && !err && !sending;
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !sending && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sending]);
  const submit = async () => {
    if (!ok) return;
    setSending(true);
    const done = await run(() => api("/wallet/gateway-deposit", { amountUsd: n }), `Added ${usd(n)} to Gateway`);
    setSending(false);
    onDone();
    if (done) onClose();
  };
  return (
    <div className="confirm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !sending && onClose()}>
      <form className="confirm-dialog add-funds-dialog" role="dialog" aria-modal="true" aria-labelledby="add-funds-title" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <span className="confirm-mark" aria-hidden><Icon name="wallet" size={18} /></span>
        <div className="confirm-body">
          <p className="confirm-lead" id="add-funds-title"><b>Add funds to Gateway</b></p>
          <p className="muted small" style={{ margin: 0 }}>Moves USDC from your Circle wallet into Gateway, which your agents spend on paid data. It stays your organization's money.</p>
          <div className="funds-flow">
            <span><small>Circle wallet</small><b>{usd(have)}</b></span>
            <Icon name="arrow" size={14} />
            <span><small>Gateway</small><b>{wallet.gateway == null ? "—" : usd(Number(wallet.gateway))}</b></span>
          </div>
          <label className="field">
            <span>Amount</span>
            <span className={`input-icon${err ? " bad" : ""}`}>
              <span className="input-prefix" aria-hidden>$</span>
              <input ref={inputRef} className="plain-input mono" inputMode="decimal" aria-label="Amount in USDC" value={amount} disabled={sending} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" />
              <button type="button" className="input-toggle" disabled={sending || max <= 0} onMouseDown={(e) => e.preventDefault()} onClick={() => setAmount(String(max))}>Max</button>
            </span>
            {err && <small className="bad-text" role="alert">{err}</small>}
          </label>
        </div>
        <div className="confirm-actions">
          <button type="button" className="btn btn-ghost" disabled={sending} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-dark" disabled={!ok}>{sending ? <span className="shimmer">Adding…</span> : `Add ${amount && !err ? usd(n) : "funds"}`}</button>
        </div>
      </form>
    </div>
  );
}

/** The proposal form's field label for each setting's value. */
const SETTING_FIELD: Record<Exclude<SettingName, "requireGvisor">, string> = {
  drillsPerDay: "Per agent per day (0 = off)",
  drillWindowMinutes: "Minutes",
  holdSeconds: "Seconds",
  swarmAgents: "Agents (0 = off)",
  swarmWindowSeconds: "Seconds",
};

/**
 * One org setting's current value, shown in the card it governs. Changing it is a proposal like any
 * other (the proposal form on Rules); a vote in progress shows next to the value.
 */
function SettingValue({ ctx, name }: { ctx: Ctx; name: SettingName }) {
  const spec = SETTINGS[name];
  const pending = ctx.s.policy!.proposals.filter((g) => (g.status === "open" || g.status === "queued") && g.change?.op === "AddRule" && g.change.scope === `setting:${name}`);
  return (
    <span className="setting">
      <b>{spec.text(ctx.s.settings.values[name])}</b>
      {pending.map((g) => {
        const v = Number(g.change?.op === "AddRule" ? g.change.target : NaN);
        return <span className="tag" key={g.id} title="A change the team is voting on">vote pending: {Number.isFinite(v) ? spec.text(v) : "change"}</span>;
      })}
    </span>
  );
}

function Overview({ ctx, wallet, refreshWallet, go }: { ctx: Ctx; wallet: WalletInfo | null; refreshWallet: () => void; go: (v: View) => void }) {
  const [adding, setAdding] = useState(false);
  const { s } = ctx;
  const pol = s.policy!;
  const pending = s.proposals.filter((p) => p.status === "pending");
  const myAddr = ctx.me.address.toLowerCase();
  const waitingOnMe = pending.filter((p) => !p.approvals.some((a) => a.memberId === myAddr)).length;
  const spent = pol.agents.reduce((n, a) => n + a.spentTodayUsd, 0);
  const live = pol.proposals.filter((g) => g.status === "open" || g.status === "queued");
  const today = new Date().toDateString();
  const todays = s.proposals.filter((p) => new Date(p.createdAt).toDateString() === today);
  const count = (f: (p: Proposal) => boolean) => todays.filter(f).length;
  // Every allowed or denied decision today (most allowed requests never get a card), plus held
  // requests a member answered or that ran out of time.
  const answered = (f: (p: Proposal) => boolean) => count((p) => p.decision.outcome === "approval" && f(p));
  const allowedToday = s.today ? s.today.allowed + answered((p) => p.status === "allowed" || p.status === "executed" || p.status === "executing")
    : count((p) => p.status === "allowed" || p.status === "executed" || p.status === "executing");
  const blockedToday = s.today ? s.today.denied + answered((p) => p.status === "denied" || p.status === "failed" || p.status === "expired")
    : count((p) => p.status === "denied" || p.status === "failed" || p.status === "expired");
  const heldToday = count((p) => p.status === "pending");
  const actionsToday = allowedToday + blockedToday + heldToday;
  // What Karuna stopped before it ran, over the last 7 days, and the money waiting in escrow now.
  const week = s.proposals.filter((p) => Date.now() - Date.parse(p.createdAt) < 7 * 86_400_000);
  const stoppedWeek = week.filter((p) => p.status === "denied" || p.status === "expired").length;
  const inEscrow = s.proposals.filter((p) => p.escrow?.status === "held" || p.escrow?.status === "opening").reduce((n, p) => n + (p.payload?.amountUsd ?? 0), 0);
  const [startHidden, setStartHidden] = useState(() => isDismissed("get-started"));
  const steps = [
    { done: pol.agents.length > 0, text: "Add an agent", view: "agents" as View },
    { done: pol.payees.length > 0, text: "Add who your agents may pay", view: "payees" as View },
    { done: pol.members.length > 1, text: "Add a second member", view: "team" as View },
  ];
  return (
    <div className="stack">
      {adding && wallet && <AddFunds wallet={wallet} run={ctx.run} onClose={() => setAdding(false)} onDone={refreshWallet} />}
      <div className="tiles">
        <div className={`tile rise ${waitingOnMe ? "attention" : ""}`} style={st(0)}><div className="k">Waiting for you <Icon name="approvals" size={14} /></div><div className="v heading-gradient">{waitingOnMe}</div><div className="note">{waitingOnMe ? "to approve" : "all clear"}</div></div>
        <div className="tile rise" style={st(1)}><div className="k">Wallet (USDC) <Icon name="wallet" size={14} /></div><div className="v heading-gradient">{wallet ? usd(Number(wallet.usdc)) : "…"}</div><div className="note wallet-note"><span>Gateway {wallet?.gateway == null ? "—" : usd(Number(wallet.gateway))}</span>{wallet && ctx.can("wallet") && <button type="button" className="add-funds" onClick={() => setAdding(true)}><Icon name="plus" size={12} /> Add funds</button>}</div></div>
        <div className="tile rise" style={st(2)}><div className="k" title="Actions Karuna blocked before they ran, in the last 7 days">Stopped this week <Icon name="shield" size={14} /></div><div className="v heading-gradient">{stoppedWeek}</div><div className="note one-line">of {week.length} actions{inEscrow > 0 ? ` · $${Math.round(inEscrow).toLocaleString()} in escrow` : ""}</div></div>
        <div className="tile rise" style={st(3)}><div className="k">Actions today <Icon name="activity" size={14} /></div><div className="v heading-gradient">{actionsToday}</div><div className="note one-line">{allowedToday} allowed · {blockedToday} blocked · {heldToday} held</div></div>
        <div className="tile rise" style={st(4)}><div className="k">Spent today <Icon name="wallet" size={14} /></div><div className="v heading-gradient">{usd(spent)}</div><div className="note">of {usd(pol.agents.filter((a) => a.active).reduce((n, a) => n + a.capUsd, 0))} allowed</div></div>
      </div>

      {s.exposure && <WorstCase x={s.exposure} names={Object.fromEntries(pol.agents.map((a) => [a.id, a.name]))} />}

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
        const held = p.escrow && (p.escrow.status === "held" || p.escrow.status === "opening");
        const label = p.escrow?.status === "cancelled" ? "cancelled" : held ? "in escrow" : p.status === "executed" ? "paid" : p.status === "failed" ? "failed" : o === "approval" ? (p.status === "pending" ? "require approval" : p.status) : o;
        const cls = p.escrow?.status === "cancelled" || p.status === "failed" || p.status === "denied" || p.status === "expired" ? "deny" : held ? "approval" : p.status === "executed" ? "allow" : o;
        return (
          <div className={`item ${Date.now() - Date.parse(p.createdAt) < 4000 ? "fresh" : ""}`} key={p.id}>
            <span className="caret">›</span>
            <span className="tool">{p.request.paymentKind ?? p.request.tool}</span>
            <span className={`act ${cls === "deny" ? "denied" : ""}`} title={describe(p, ctx)}><span className="ag">{ctx.s.policy!.agents.find((a) => a.id === p.agentId)?.name ?? p.agentId} · </span><span className="what">{describe(p, ctx)}</span></span>
            <Badge v={cls}>{label}</Badge>
            <RuleRef ctx={ctx} id={p.decision.ruleId} />
            <span className="t">{isTx(p.txRef) ? <TxLink tx={p.txRef} s={ctx.s} /> : ago(p.createdAt)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================== approvals (signed, Facts First, Exact Match)

/** Everything that needs a member, then payees, then the signed log. */
function ActivityPage({ ctx, dharma, log }: { ctx: Ctx; dharma: Address; log: LogEntry[] }) {
  const { s } = ctx;
  const pending = s.proposals.filter((p) => p.status === "pending");
  const live = s.policy!.proposals.filter((g) => g.status === "open" || g.status === "queued");
  return (
    <div className="stack">
      {pending.length === 0 && live.length === 0 && <div className="card"><Empty icon="check">Nothing is waiting for you.</Empty></div>}
      <p className="muted small settings-line">An agent's held web request waits <SettingValue ctx={ctx} name="holdSeconds" /> for a member, then it's refused.</p>
      {pending.map((p, i) => <div className="rise" style={st(i)} key={p.id}><ApprovalCard p={p} ctx={ctx} dharma={dharma} /></div>)}
      <EscrowHolds ctx={ctx} />
      <Ballots ctx={ctx} />
      <UpgradeCard ctx={ctx} />
      <Activity ctx={ctx} log={log} />
    </div>
  );
}

/** Payments waiting in escrow: any one member can cancel before release, and the USDC comes back. */
function EscrowHolds({ ctx }: { ctx: Ctx }) {
  const { s, me, run, busy } = ctx;
  const held = s.proposals.filter((p) => p.escrow && (p.escrow.status === "held" || p.escrow.status === "opening"));
  if (!held.length) return null;
  const agentName = (id: string) => s.policy!.agents.find((a) => a.id === id)?.name ?? id;
  const payee = (a?: string) => (a ? s.policy!.payees.find((x) => x.account === a.toLowerCase())?.name ?? short(a) : "—");
  return (
    <div className="card">
      <div className="hd"><h2>In escrow</h2><span className="sub">any member can cancel before release; the USDC returns to the wallet</span></div>
      <div className="table">
        {held.map((p) => {
          const e = p.escrow!;
          return (
            <div className="tr escrow-tr" key={p.id}>
              <span className="b">{usd(p.payload?.amountUsd ?? p.request.amountUsd ?? 0)} to {payee(p.request.to)}</span>
              <span className="small muted">{agentName(p.agentId)} · {e.blocked ?? (e.status === "opening" ? "placing in escrow…" : `releases ${new Date(e.releaseAt).toLocaleString()}`)}</span>
              {ctx.can("cancelEscrow") && <button className="btn btn-deny btn-sm" disabled={busy || e.status !== "held" || !e.holdId}
                onClick={async () => (await askConfirm(`Cancel this ${usd(p.payload?.amountUsd ?? 0)} payment? The USDC goes back to the org's wallet and the payee gets nothing.`, { action: "Cancel payment", back: "Keep it", danger: true }))
                  && run(() => cancelEscrow(me, e.address as Address, e.holdId!, p.id), "Cancelled; the USDC is back in the wallet")}>
                Cancel
              </button>}
            </div>
          );
        })}
      </div>
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
          <FactRow label="Why it needs you" value={p.decision.reason} />
          {p.facts.map((f) => (<FactRow key={f.label} label={f.label} value={f.value} tone={f.tone} />))}
          {p.ifUnanswered && <FactRow label="If nobody answers" value={p.ifUnanswered} />}
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
        {ctx.can("approve") ? <>
          <button className="btn btn-deny" disabled={busy} onClick={() => decide(false)}>Deny</button>
          <button className="btn btn-approve" disabled={busy || iApproved || !!s.frozen} title={s.frozen ? "Unfreeze before approving" : undefined} onClick={() => decide(true)}>
            {iApproved ? <><Icon name="check" /> You signed</> : <><Icon name="pen" /> {p.payload ? `Sign & pay ${usd(p.payload.amountUsd)}` : "Sign approval"}</>}
          </button>
        </> : <span className="muted small">Waiting for a member who can approve</span>}
      </div>
    </article>
  );
}

function FactRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (<><dt>{label}</dt><dd className={tone ?? ""}>{value}</dd></>);
}

// ============================================================== Dharma governance

/** Open and passed Dharma changes, each with its vote. */
function Ballots({ ctx }: { ctx: Ctx }) {
  const { s, me, busy } = ctx;
  const pol = s.policy!;
  const now = useNow();
  const myAddr = me.address.toLowerCase();
  const live = pol.proposals.filter((g) => g.status === "open" || g.status === "queued");
  const team = pol.members.length >= 2;
  return (
    <>
      {live.map((g, i) => {
        const voted = g.voters.includes(myAddr);
        const remaining = g.eta ? Math.max(0, g.eta - Math.floor((now - chainSkewMs) / 1000)) : null;
        const need = Number.isFinite(g.needed) ? g.needed : pol.required;
        // Every member can skip the wait on a normal change (not Unfreeze, never core).
        const canSkip = g.status === "queued" && !g.core && g.change.op !== "Unfreeze" && team && !voted && !!remaining;
        return (
          <div className="card ballot rise" style={st(i)} key={g.id}>
            <div className="ballot-top">
              <Badge v={g.status === "queued" ? "allow" : "approval"}>{g.status === "queued" ? "passed" : "vote"}</Badge>
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
            {g.exposureDelta && g.exposureDelta.length > 0 && <WorstDelta lines={g.exposureDelta} />}
            {g.preview && <PreviewBox p={g.preview} ctx={ctx} />}
          </div>
        );
      })}
    </>
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
        <Select small label={`${label} unit`} value={v.unit} onChange={(u) => set({ ...v, unit: u as Unit })} options={Object.keys(UNITS).map((u) => ({ value: u, label: u }))} />
        <button className="btn btn-ghost btn-sm" disabled={ctx.busy || !ok}
          title={sec < min || sec > max ? `Between ${waitText(min) === "no wait" ? "0" : waitText(min)} and ${waitText(max)}` : undefined}
          onClick={async () => {
            if (op === "SetTimelock" && sec === 0 && !(await askConfirm("No wait means a passed change applies at once, so stolen keys could loosen rules immediately. Propose it anyway?", { action: "Propose anyway", danger: true }))) return;
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
  const [dir, setDir] = useState("./my-agent");
  const [cmd, setCmd] = useState("python main.py");
  // One command with the token filled in: copy it, run it from the Karuna folder, done.
  const command = `KARUNA_AGENT_TOKEN=${token} pnpm karuna run --agent ${agentId} ${dir.trim() || "."} -- ${cmd.trim() || "python main.py"}`;
  return (
    <div className="card reveal-token rise">
      <div className="hd"><h2>Connect {agent}</h2><span className="badge badge-approval">token shown once</span></div>
      <div className="pad stack">
        <p className="muted">Run this from the Karuna folder to start {agent} in a Karuna sandbox. It works once Dharma has added the agent. Karuna keeps only a hash of the token, so copy the command now.</p>
        <div className="connect-fields">
          <label className="field"><span>Agent's folder</span><input className="mono" value={dir} onChange={(e) => setDir(e.target.value)} /></label>
          <label className="field grow"><span>How it starts</span><input className="mono" value={cmd} onChange={(e) => setCmd(e.target.value)} /></label>
        </div>
        <div className="token-row">
          <code className="token">{command}</code>
          <button className="btn btn-ghost" onClick={() => { navigator.clipboard?.writeText(command); setCopied(true); }}><Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy"}</button>
        </div>
        <details className="connect-more">
          <summary>Paying or buying from the agent's code</summary>
          <pre className="snippet">{`import { KarunaAgent } from "@prekaruna/agents";

const karuna = new KarunaAgent({
  gatekeeperUrl: process.env.KARUNA_GATEKEEPER_URL!, // set inside the sandbox
  token: process.env.KARUNA_AGENT_TOKEN!,           // this run's session, set by karuna run
});

const r = await karuna.buy(serviceUrl, { maxUsd: 0.01, reason: "why" });
if (r.status === "pending") await karuna.wait(r.id); // a member decides`}</pre>
        </details>
        <p className="muted small">Claude Code, Cursor and chat apps don't need a token: they connect from the New agent card (Coding agents or Claude chat).</p>
        <button className="btn btn-dark" onClick={onDone}>I've copied it</button>
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
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const levels = hasLevels(s);
  // On Dharma v3 a level sets what an agent may spend; the meter shows that level's daily limit.
  const limited = (a: AgentView): AgentView => (levels && a.level != null ? { ...a, capUsd: pol.levelLimits![a.level]?.dailyUsd ?? 0 } : a);

  const add = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ id: string; token: string }>("/agents/prepare", { name: form.name });
      await submitChange(ctx.me, s.org.dharma!.address as Address, { kind: Kind.Propose, change: { op: "SetAgent", id: r.id, capUsd: levels ? 0 : Number(form.cap) } });
      setReveal({ token: r.token, agent: form.name, agentId: r.id });
      setForm({ name: "", cap: "1" });
    }, `Proposed on Dharma — the agent works after ${pol.required} vote${pol.required > 1 ? "s" : ""} and ${pol.timelock}s${levels ? ", starting at Level 0" : ""}`);
  };

  return (
    <div className="stack">
      {reveal && <TokenReveal {...reveal} onDone={() => setReveal(null)} />}
      {runsFor && <RunsPanel ctx={ctx} agentId={runsFor} onClose={() => setRunsFor(null)} />}
      {(s.sandbox.sessions.length > 0 || s.settings.gvisorAvailable || s.settings.values.requireGvisor === 1) && <SandboxRuns ctx={ctx} />}
      {pol.agents.length > 0 && (
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
                {a.active && <Meter a={limited(a)} frozen={!!s.frozen} />}
                {a.active && (() => { const x = s.exposure?.agents.find((e) => e.agentId === a.id); return x && <div className="worst-line"><Icon name="alert" size={12} /> If hijacked: {agentWorst(x, s.exposure!.walletUsd)}</div>; })()}
                {a.active && levels && <AgentLevel a={a} ctx={ctx} />}
                {a.active && <Preflight a={a} ctx={ctx} />}
                {a.active && a.built && <BuiltControls a={a} ctx={ctx} openRuns={() => setRunsFor(a.id)} />}
                {a.active && (
                  <div className="meta">
                    {levels ? null : ed === undefined ? (
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
                  {(s.runs ?? []).some((r) => r.agentId === a.id) && <button className="btn btn-ghost btn-sm" onClick={() => setRunsFor(a.id)}>Runs</button>}
                  {a.active && <button className="btn btn-deny btn-sm" disabled={busy} onClick={async () => (await askConfirm(`Propose removing ${a.name} from Dharma? It goes to a team vote.`, { action: "Propose removal", danger: true })) && ctx.change({ op: "RemoveAgent", id: a.id })}>Propose removal</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <NewAgent ctx={ctx} own={
        <form className="row-form own-agent" onSubmit={add}>
          <span className="muted small">Or connect your own code:</span>
          <input required aria-label="Agent name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Agent name" />
          {!levels && <input required aria-label="Daily allowance (USD)" className="select-sm mono" type="number" min="0" step="0.000001" value={form.cap} onChange={(e) => setForm({ ...form, cap: e.target.value })} title="Daily allowance (USD)" />}
          <button className="btn btn-ghost btn-sm" type="submit" disabled={busy}>Propose and get a token</button>
        </form>
      } />
      <Connectors ctx={ctx} />
      {s.sandbox.remote && <RemoteRuns ctx={ctx} />}
    </div>
  );
}

// ============================================================== payees

/** Rules page: the sites agents may reach (read; Level 2+ may write). */
/** Whether a folding card is open (default) or folded; remembered per browser. */
function useFold(id: string): [boolean, () => void] {
  const key = `karuna.fold.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== "closed";
    } catch {
      return true;
    }
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(key, o ? "closed" : "open");
      } catch {
        /* per-browser convenience only */
      }
      return !o;
    });
  return [open, toggle];
}

/** A card header that folds the card: click (or Enter / Space) to hide or show everything under it. */
function FoldHead({ title, sub, open, toggle, className = "" }: { title: string; sub: ReactNode; open: boolean; toggle: () => void; className?: string }) {
  return (
    <div className={`hd fold-hd ${className}`} role="button" tabIndex={0} aria-expanded={open} onClick={toggle}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle())}>
      <h2>{title}</h2>
      <span className="fold-right">{sub}<Icon name="chevron" size={16} className="fold-chev" /></span>
    </div>
  );
}

/** What a folding card hides: always rendered, so opening and folding can slide (see .fold-body). */
function FoldBody({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`fold-body${open ? " open" : ""}`} aria-hidden={!open}>
      <div className="fold-inner">{children}</div>
    </div>
  );
}

function TrustedSites({ ctx }: { ctx: Ctx }) {
  const { s, busy } = ctx;
  const [open, toggle] = useFold("sites");
  const pol = s.policy!;
  return (
    <div className={`card${open ? "" : " folded"}`}>
      <FoldHead title="Trusted sites" open={open} toggle={toggle} sub={<span className="sub">{pol.domains.length ? pol.domains.length : "none yet, so agents can't reach the web"}</span>} />
      {pol.domains.length > 0 && (
        <FoldBody open={open}>
        <div className="table">
          {pol.domains.map((d) => (
            <div className="tr site-tr" key={d}>
              <span className="intro-mark"><Icon name="external" size={14} /></span>
              <span className="b mono">{d}</span>
              <button className="btn btn-deny btn-sm" disabled={busy} onClick={() => ctx.change({ op: "RemoveDomain", domain: d })}>Remove</button>
            </div>
          ))}
        </div>
        </FoldBody>
      )}
    </div>
  );
}

function Payees({ ctx }: { ctx: Ctx }) {
  const { s, busy } = ctx;
  const [open, toggle] = useFold("payees");
  const pol = s.policy!;
  return (
    <div className={`card${open ? "" : " folded"}`}>
      <FoldHead title="Payees" open={open} toggle={toggle} sub={<span className="sub">{pol.payees.length ? pol.payees.length : "none yet, so every payment is denied"}</span>} />
      {pol.payees.length > 0 && (
        <FoldBody open={open}>
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
        </FoldBody>
      )}
    </div>
  );
}

// ============================================================== policy

const WAIT_UNITS = { minutes: 60, hours: 3600, days: 86400 } as const;
type WaitUnit = keyof typeof WAIT_UNITS;

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

function Policy({ ctx, part }: { ctx: Ctx; part: "list" | "propose" }) {
  const [rulesOpen, toggleRules] = useFold("rules");
  const { s, busy } = ctx;
  const pol = s.policy!;
  // Settings are Dharma rules too, but their values show in the card they govern, not in this list.
  const listedRules = pol.rules.filter((r) => !r.scope.startsWith("setting:"));
  const [meta, setMeta] = useState<Rule[]>([]);
  // The form's choices that aren't rules: a payee, a trusted site, the two-signature limit, escrow, a setting.
  const [special, setSpecial] = useState<"" | "payee" | "site" | "threshold" | "escrow" | `set:${SettingName}`>("");
  const [extra, setExtra] = useState({ name: "", account: "", domain: "", usd: "", wait: "24", unit: "hours" as WaitUnit, setting: "" });
  const settingName = special.startsWith("set:") ? (special.slice(4) as SettingName) : null;
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

  const site = extra.domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
  const amount = Number(extra.usd);
  const waitSec = Math.round(Number(extra.wait) * WAIT_UNITS[extra.unit]);
  const specialChange = ((): { change: Change; label?: string; text: string } | { error: string } | null => {
    switch (special) {
      case "payee":
        if (!extra.name.trim() || !isAddr(extra.account) || !rule.category.trim()) return { error: "Enter a name, a 0x… payout address and a category" };
        return { change: { op: "SetPayee", account: extra.account as Address, category: rule.category.trim().toLowerCase() }, label: extra.name.trim(), text: `add payee ${extra.name.trim()} (${short(extra.account)}), category ${rule.category.trim().toLowerCase()}` };
      case "site":
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site)) return { error: "Enter a site, like api.github.com" };
        return { change: { op: "AddDomain", domain: site }, text: `trust ${site}: agents may read from it, and Level 2 and up may also write to it` };
      case "threshold":
        if (!(amount > 0)) return { error: "Enter an amount in USD" };
        return { change: { op: "SetThreshold", usd: amount }, text: `payments of ${usd(amount)} or more need two members to sign (now ${usd(pol.thresholdUsd)})` };
      case "escrow":
        if (!(amount > 0) || !(waitSec > 0)) return { error: "Enter an amount in USD and how long to hold it" };
        if (waitSec < 120) return { error: "Hold payments for at least 2 minutes, so members have time to cancel" };
        return {
          change: { op: "AddRule", id: ruleId("escrow"), outcome: "Approval", scope: "escrow", target: String(waitSec), maxUsd: amount },
          text: `payments of ${usd(amount)} or more wait ${waitText(waitSec)} in escrow, and any member can cancel them`,
        };
      default: {
        if (!settingName) return null;
        const spec = SETTINGS[settingName];
        const now = s.settings.values[settingName];
        const v = Number(extra.setting);
        if (!/^\d+$/.test(extra.setting.trim()) || v < spec.min || v > spec.max) return { error: `Enter a whole number from ${spec.min} to ${spec.max}` };
        if (v === now) return { error: `That's the current value (${spec.text(now)})` };
        return { change: settingChange(settingName, v), text: `Set ${spec.label.toLowerCase()} to ${spec.text(v)} (now ${spec.text(now)})` };
      }
    }
  })();
  const addRule = (e: FormEvent) => {
    e.preventDefault();
    if (specialChange) {
      if ("error" in specialChange) return;
      // Once it's proposed, clear only what was submitted (read the latest state: the member may
      // already be filling in the next one).
      const sent = special;
      ctx.change(specialChange.change, specialChange.label).then((ok) => {
        if (!ok) return;
        if (sent === "payee") {
          setExtra((x) => ({ ...x, name: "", account: "" }));
          setRule((r) => ({ ...r, category: "" }));
        } else if (sent === "site") setExtra((x) => ({ ...x, domain: "" }));
        else if (sent.startsWith("set:")) setExtra((x) => ({ ...x, setting: "" }));
        else setExtra((x) => ({ ...x, usd: "" }));
      });
      return;
    }
    if ("error" in built) return;
    ctx.change(built.change).then((ok) => ok && setRule((r) => ({ ...EMPTY_RULE, kind: r.kind })));
  };

  return (
    <div className="stack">
      {part === "list" && <div className={`card${rulesOpen ? "" : " folded"}`}>
        <FoldHead title="Rules" className="window-hd" open={rulesOpen} toggle={toggleRules} sub={<span className="sub">{listedRules.filter((r) => r.active).length} active</span>} />
        <FoldBody open={rulesOpen}><div className="policy">
          {listedRules.map((r, i) => (
            <div className={`p ${r.active ? "" : "off"}`} key={r.id} id={`rule-${r.id}`}>
              <span className="i">{String(i + 1).padStart(2, "0")}</span>
              <span className="nm">
                <span>{r.id}{r.core && <span className="lock" title="Core boundary: can never be removed"><Icon name="lock" size={10} /> core</span>}</span>
                <span className="desc">{r.builtin ? desc(r.id) ?? r.scope : `${r.scope === "escrow" ? `payments of ${usd(r.maxUsd)} or more wait ${waitText(Number(r.target))} in escrow, and any member can cancel them` : describeScope(r.scope, r.target, names)} · ${r.agent ? names.agent(r.agent) : "every agent"}`}</span>
              </span>
              <span className="rule-actions">
                {r.active ? <Badge v={r.outcome} /> : <span className="badge badge-quiet">removed</span>}
                {!r.core && r.active && (
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => ctx.change({ op: "RemoveRule", id: r.id })}>{r.outcome === "allow" ? "remove" : "propose removal"}</button>
                )}
                {r.core && r.active && (
                  <button className="btn btn-ghost btn-sm" disabled={busy}
                    onClick={async () => (await askConfirm(`${r.id} is a core rule. Removing it needs every member's vote and a ${waitText(pol.coreTimelock)} wait, and any freeze cancels it. Propose anyway?`, { action: "Propose anyway", danger: true, icon: "lock" })) && ctx.change({ op: "RemoveRule", id: r.id })}>
                    propose removal
                  </button>
                )}
                {!r.core && !r.active && r.builtin && (
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => ctx.change({ op: "AddRule", id: r.id, outcome: "Deny" })}>{"propose re-enable"}</button>
                )}
              </span>
            </div>
          ))}
        </div></FoldBody>
      </div>}

      {part === "propose" && <>
      <div className="card rule-english">
        <div className="hd"><h2>Draft rule</h2></div>
        <div className="rule-english-body">
          <DrafterKeyField ctx={ctx} />
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

      <div className="card">
        <div className="hd"><h2>New proposal</h2></div>
      <form className="inline-form rule-form" onSubmit={addRule}>
        {!special && <label className="field"><span>Outcome</span>
          <Select label="Outcome" value={rule.outcome} onChange={(v) => setRule({ ...rule, outcome: v as RuleForm["outcome"] })}
            options={[{ value: "Deny", label: "Block" }, { value: "Approval", label: "Require approval" }, { value: "Allow", label: "Allow" }]} />
        </label>}
        <label className="field"><span>Action</span>
          <Select label="Action" value={special || rule.kind} onChange={(v) => {
            const isSpecial = v === "payee" || v === "site" || v === "threshold" || v === "escrow" || v.startsWith("set:");
            setSpecial(isSpecial ? (v as typeof special) : "");
            if (v.startsWith("set:")) setExtra((x) => ({ ...x, setting: "" }));
            setRule({ ...EMPTY_RULE, outcome: rule.outcome, agent: rule.agent, kind: isSpecial ? rule.kind : (v as RuleKind) });
          }} options={[
            { value: "payee", label: "New payee" },
            { value: "site", label: "Trusted site" },
            { value: "threshold", label: "Two-signature limit" },
            { value: "escrow", label: "Escrow for large payments" },
            { value: "payment", label: "Payments" },
            { value: "http", label: "Web requests" },
            { value: "shell", label: "Shell commands" },
            { value: "file", label: "Files" },
            { value: "message", label: "Messages to other agents" },
            { value: "set:drillsPerDay", label: "Drills per day", group: "Settings" },
            { value: "set:drillWindowMinutes", label: "Drill pass window", group: "Settings" },
            { value: "set:holdSeconds", label: "Approval hold", group: "Settings" },
            { value: "set:swarmAgents", label: "Swarm Stopper", group: "Settings" },
            { value: "set:swarmWindowSeconds", label: "Swarm Stopper window", group: "Settings" },
            ...(s.settings.gvisorAvailable || s.settings.values.requireGvisor === 1 ? [{ value: "set:requireGvisor", label: "Require gVisor", group: "Settings" }] : []),
          ]} />
        </label>
        {settingName && (settingName === "requireGvisor" ? (
          <label className="field"><span>Require gVisor</span>
            <Select label="Require gVisor" value={extra.setting} onChange={(v) => setExtra({ ...extra, setting: v })}
              options={[{ value: "", label: "Choose…" }, { value: "1", label: "On: refuse boxes on plain Docker" }, { value: "0", label: "Off" }]} />
          </label>
        ) : (
          <label className="field"><span>{SETTING_FIELD[settingName]}</span>
            <input className="mono" inputMode="numeric" value={extra.setting} onChange={(e) => setExtra({ ...extra, setting: e.target.value })} placeholder={String(s.settings.values[settingName])} />
          </label>
        ))}
        {special === "payee" && <>
          <label className="field"><span>Name (private)</span><input value={extra.name} onChange={(e) => setExtra({ ...extra, name: e.target.value })} placeholder="Supplier or service" /></label>
          <label className="field grow"><span>Payout address</span><input className="mono" value={extra.account} onChange={(e) => setExtra({ ...extra, account: e.target.value.trim() })} placeholder="0x…" /></label>
          <label className="field"><span>Category</span><input value={rule.category} onChange={(e) => setRule({ ...rule, category: e.target.value })} placeholder="e.g. data, utilities" /></label>
        </>}
        {special === "site" && <label className="field grow"><span>Site</span><input className="mono" value={extra.domain} onChange={(e) => setExtra({ ...extra, domain: e.target.value })} placeholder="api.github.com" /></label>}
        {(special === "threshold" || special === "escrow") && <label className="field"><span>{special === "threshold" ? "From (USD)" : "Payments from (USD)"}</span><input inputMode="decimal" value={extra.usd} onChange={(e) => setExtra({ ...extra, usd: e.target.value })} placeholder={special === "threshold" ? String(pol.thresholdUsd) : "e.g. 100"} /></label>}
        {special === "escrow" && <>
          <label className="field"><span>Hold for</span><input className="mono" inputMode="decimal" value={extra.wait} onChange={(e) => setExtra({ ...extra, wait: e.target.value })} /></label>
          <label className="field"><span>Unit</span>
            <Select label="Unit" value={extra.unit} onChange={(v) => setExtra({ ...extra, unit: v as WaitUnit })} options={Object.keys(WAIT_UNITS).map((u) => ({ value: u, label: u }))} />
          </label>
        </>}
        {!special && <label className="field"><span>Agent</span>
          <Select label="Agent" value={rule.agent} onChange={(v) => setRule({ ...rule, agent: v })} options={[{ value: "", label: "Every agent" }, ...pol.agents.filter((a) => a.active).map((a) => ({ value: a.id, label: a.name }))]} />
        </label>}
        {!special && rule.kind === "payment" && <>
          <label className="field"><span>Payee</span>
            <Select label="Payee" value={rule.target} onChange={(v) => setRule({ ...rule, target: v })}
              options={[{ value: "", label: "Any payee" }, ...pol.payees.map((p) => ({ value: p.account, label: p.name ?? short(p.account) }))]} />
          </label>
          <label className="field"><span>Category</span><input value={rule.category} onChange={(e) => setRule({ ...rule, category: e.target.value })} placeholder="any" /></label>
          {rule.outcome === "Allow" && <label className="field"><span>Up to (USD)</span><input inputMode="decimal" value={rule.maxUsd} onChange={(e) => setRule({ ...rule, maxUsd: e.target.value })} placeholder="no cap" /></label>}
        </>}
        {!special && rule.kind === "http" && <>
          <label className="field"><span>Method</span>
            <Select label="Method" value={rule.method} onChange={(v) => setRule({ ...rule, method: v })}
              options={[{ value: "", label: "Any" }, ...["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }))]} />
          </label>
          <label className="field grow"><span>Site</span><input value={rule.target} onChange={(e) => setRule({ ...rule, target: e.target.value })} placeholder="api.github.com or api.openai.com/v1/" /></label>
        </>}
        {!special && rule.kind === "shell" && (
          <label className="field grow"><span>Command</span><input value={rule.target} onChange={(e) => setRule({ ...rule, target: e.target.value })} placeholder="git push   ·   or a pattern like *curl *" /></label>
        )}
        {!special && rule.kind === "file" && <>
          <label className="field"><span>Access</span>
            <Select label="Access" value={rule.fileOp} onChange={(v) => setRule({ ...rule, fileOp: v })}
              options={[{ value: "", label: "Read or write" }, { value: "read", label: "Read" }, { value: "write", label: "Write" }]} />
          </label>
          <label className="field grow"><span>Path</span><input value={rule.target} onChange={(e) => setRule({ ...rule, target: e.target.value })} placeholder="finance   ·   or a pattern like *.csv" /></label>
        </>}
        {!special && rule.kind === "message" && (
          <label className="field grow"><span>To</span>
            <Select label="To agent" value={rule.target} onChange={(v) => setRule({ ...rule, target: v })} options={[{ value: "", label: "Any agent" }, ...pol.agents.filter((a) => a.active).map((a) => ({ value: a.id, label: a.name }))]} />
          </label>
        )}
        <button className="btn btn-dark" disabled={busy || (specialChange ? "error" in specialChange : "error" in built)}><Icon name="plus" /> {special === "payee" ? "Propose payee" : special ? "Propose" : "Propose rule"}</button>
        <div className="rule-preview">{specialChange
          ? "error" in specialChange ? specialChange.error : <>Will be voted on as: <strong>{specialChange.text}</strong></>
          : "error" in built ? built.error : <>Will be voted on as: <strong>{describeRule(built.change, names)}</strong></>}</div>
      </form>
      </div>

      </>}
    </div>
  );
}

/** The rule behind a decision: a link to it on Rules when it's a Dharma rule, plain text otherwise. */
function RuleRef({ ctx, id }: { ctx: Ctx; id: string }) {
  if (!ctx.s.policy?.rules.some((r) => r.id === id)) return <span className="pol">{id}</span>;
  return (
    <a className="pol pol-link" href="#rules" title="Open this rule" onClick={(e) => {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("karuna:open-rule", { detail: id }));
    }}>{id}</a>
  );
}

// ============================================================== signed log

const LOG_PAGE = 15;

function Activity({ ctx, log }: { ctx: Ctx; log: LogEntry[] }) {
  const { s } = ctx;
  const [filter, setFilter] = useState<"all" | "decisions" | "events" | "on Arc">("all");
  const onArc = (e: LogEntry) => !!e.event && isTx((e.event as Record<string, unknown>).txRef);
  // The newest LOG_PAGE entries first; scrolling to the end adds LOG_PAGE more, fetching older
  // entries from the Gatekeeper (`log` only holds the newest few hundred) until there are none left.
  const [count, setCount] = useState(LOG_PAGE);
  const [older, setOlder] = useState<LogEntry[]>([]);
  const [noOlder, setNoOlder] = useState(PREVIEW);
  const [loadingOlder, setLoadingOlder] = useState(false);
  useEffect(() => setCount(LOG_PAGE), [filter]);
  const merged = useMemo(() => {
    const bySeq = new Map<number, LogEntry>();
    for (const e of [...older, ...log]) bySeq.set(e.seq, e);
    return [...bySeq.values()].sort((a, b) => b.seq - a.seq);
  }, [log, older]);
  const matching = useMemo(() => merged.filter((e) => filter === "all" || (filter === "on Arc" ? onArc(e) : filter === "decisions" ? !!e.decision : !!e.event)), [merged, filter]);
  const oldestLoaded = merged.length ? merged[merged.length - 1].seq : 0;
  const olderOnServer = !noOlder && oldestLoaded > 0;
  const shown = matching.slice(0, count);
  const hasMore = matching.length > count || olderOnServer;
  // Not enough loaded to fill the next page (a filter can skip many entries): fetch the next older batch.
  useEffect(() => {
    if (matching.length >= count || !olderOnServer || loadingOlder) return;
    setLoadingOlder(true);
    api<LogEntry[]>(`/log?limit=100&before=${oldestLoaded}`)
      .then((page) => (page.length ? setOlder((prev) => [...prev, ...page]) : setNoOlder(true)))
      .catch(() => setNoOlder(true))
      .finally(() => setLoadingOlder(false));
  }, [matching.length, count, olderOnServer, oldestLoaded, loadingOlder]);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) setCount((c) => (c < matching.length + LOG_PAGE ? c + LOG_PAGE : c));
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, matching.length]);
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
                  <RuleRef ctx={ctx} id={e.decision.ruleId} />
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
          <div ref={sentinel} className="log-more muted small" aria-live="polite">
            {hasMore ? (loadingOlder ? "Loading more…" : "Scroll for more") :`That's everything${filter === "all" ? "" : ` under “${filter}”`} · ${shown.length} shown`}
          </div>
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
  const { s, me, busy, run } = ctx;
  const pol = s.policy!;
  const myAddr = me.address.toLowerCase();
  const admin = ctx.can("team");
  const roles = s.roles?.defs ?? [];
  const roleName = (id: string | null | undefined) => roles.find((r) => r.id === id)?.name ?? "No role";
  const tree = s.roles?.structure === "tree";
  const setRole = (address: string, role: string) => ctx.manage({ op: "SetRole", member: address as Address, role: roleNumber(role)! }, `Role set to ${roleName(role)}`);
  return (
    <div className="stack">
      {s.enrollments.length > 0 && (
        <div className="card rise">
          <div className="hd"><h2>Access requests</h2><span className="sub">{s.enrollments.length}</span></div>
          <div className="table">
            {s.enrollments.map((e) => {
              const proposed = pol.proposals.some((g) => g.change?.op === "AddMember" && String(g.change.member).toLowerCase() === e.address && (g.status === "open" || g.status === "queued"));
              return (
                <div className="tr team-tr" key={e.address}>
                  <span className="av">{e.name[0]?.toUpperCase()}</span>
                  <span className="b">{e.name}{e.via === "invite" && <span className="tag" style={{ marginLeft: 8 }}>invite link</span>}</span>
                  <span className="mono small">{e.address}</span>
                  <span className="team-actions">
                    {admin && !proposed && <button className="btn btn-ghost btn-sm" disabled={busy} title="Sees the console; doesn't vote, approve or change anything" onClick={() => run(() => api("/viewers", { address: e.address }), `${e.name} added as a Viewer`)}>Add as Viewer</button>}
                    {proposed ? <Badge v="approval">proposed</Badge> : <button className="btn btn-dark btn-sm" disabled={busy} onClick={() => ctx.change({ op: "AddMember", member: e.address as Address }, e.name)}><Icon name="plus" size={14} /> Propose as voting member</button>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {admin && <InviteLinks ctx={ctx} />}
      <div className="card">
        <div className="hd"><h2>Members</h2><span className="sub">{pol.members.length} voting{s.roles?.viewers.length ? ` · ${s.roles.viewers.length} viewing` : ""}</span></div>
        <div className="table">
          {pol.members.map((m) => {
            const r = s.roles?.of[m.address] ?? "member";
            return (
              <div className="tr team-tr" key={m.address}>
                <span className="av">{(m.name ?? "?")[0]?.toUpperCase()}</span>
                <span className="b">{m.name ?? "Unnamed"}{m.address === myAddr ? <span className="tag" style={{ marginLeft: 8 }}>you</span> : ""}</span>
                <span className="mono small">{m.address}</span>
                <span className="team-actions">
                  {!tree ? (
                    <span className="tag">{(s.roles?.can[m.address]?.length ?? ALL_PERMISSIONS.length) === ALL_PERMISSIONS.length ? "Full access" : roleName(r)}</span>
                  ) : admin ? (
                    <Select small label={`${m.name ?? "Member"}'s role`} value={r} disabled={busy} onChange={(v) => void setRole(m.address, v)} options={roles.filter((d) => d.id !== "viewer").map((d) => ({ value: d.id, label: d.name }))} />
                  ) : <span className="tag">{roleName(r)}</span>}
                  <button className="btn btn-deny btn-sm" disabled={busy || pol.members.length <= 1} onClick={() => ctx.change({ op: "RemoveMember", member: m.address as Address })}>Propose removal</button>
                </span>
              </div>
            );
          })}
          {(s.roles?.viewers ?? []).map((v) => (
            <div className="tr team-tr" key={v.address}>
              <span className="av">{(v.name ?? "?")[0]?.toUpperCase()}</span>
              <span className="b">{v.name ?? "Unnamed"}{v.address === myAddr ? <span className="tag" style={{ marginLeft: 8 }}>you</span> : ""}</span>
              <span className="mono small">{v.address}</span>
              <span className="team-actions">
                <span className="tag" title="Sees the console; doesn't vote, approve or change anything">Viewer</span>
                {admin && <button className="btn btn-deny btn-sm" disabled={busy} onClick={() => run(() => api(`/viewers/${v.address}`, undefined, "DELETE"), `${v.name ?? "Viewer"} removed`)}>Remove</button>}
              </span>
            </div>
          ))}
        </div>
      </div>
      <RolesCard ctx={ctx} />
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

/**
 * The team's structure and what each role can do, on Dharma. A member with "team" changes them at
 * once (a signed role change, no vote). Every member can always vote; Admin and Viewer are fixed.
 */
function RolesCard({ ctx }: { ctx: Ctx }) {
  const { s, busy } = ctx;
  const admin = ctx.can("team");
  const team = s.roles;
  const roles = team?.defs ?? [];
  const structure = team?.structure ?? "flat";
  const [name, setName] = useState("");
  const setPerms = (r: RoleDef, perms: Permission[]) =>
    ctx.manage({ op: "SetRolePerms", role: roleNumber(r.id)!, permissions: permissionBits(perms) }, `${r.name} updated`, r.builtin ? undefined : r.name);
  const used = new Set(roles.map((r) => roleNumber(r.id)));
  const free = Array.from({ length: MAX_ROLE - ROLE_MEMBER }, (_, i) => ROLE_MEMBER + 1 + i).find((n) => !used.has(n));
  const pick = async (v: Structure) => {
    const ok = await askConfirm(
      v === "tree"
        ? "Switch to a tree? You become an Admin. Other members get the Member role: they can't freeze agents or manage the team or wallet until an Admin gives them a role that can."
        : "Switch to a flat team? Every member without a set role can do everything.",
      { action: v === "tree" ? "Use a tree" : "Use a flat team" },
    );
    if (!ok) return;
    // A team of two or more votes on becoming a tree (Dharma v5): in a flat team everyone has
    // "team", so one member doing it alone would take the others' rights.
    if (v === "tree" && structure === "flat" && (s.policy?.members.length ?? 1) > 1 && (s.policy?.version ?? 0) >= 5) {
      await ctx.change({ op: "SetStructure", structure: v }, undefined);
      return;
    }
    await ctx.manage({ op: "SetStructure", structure: v }, v === "tree" ? "The team is now a tree" : "The team is now flat");
  };
  return (
    <div className="card">
      <div className="hd"><h2>Roles</h2><span className="sub">{!team?.onchain ? "needs a Dharma upgrade" : admin ? "on Dharma · changes apply at once" : "set by an Admin"}</span></div>
      <div className="pad">
        {team?.onchain
          ? <StructureChoice value={structure} disabled={!admin || busy} onPick={(v) => void pick(v)} />
          : <p className="muted small">This organization's Dharma predates roles, so every member can do everything. Upgrade Dharma to choose a structure.</p>}
      </div>
      {team?.onchain && structure === "tree" && (
        <>
          <div className="roles-wrap">
            <table className="roles-table">
              <thead>
                <tr><th>Role</th>{ALL_PERMISSIONS.map((p) => <th key={p}>{PERMISSIONS[p]}</th>)}<th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {roles.map((r) => {
                  const locked = !admin || r.id === "admin" || r.id === "viewer";
                  return (
                    <tr key={r.id}>
                      <td className="b">{r.name}</td>
                      {ALL_PERMISSIONS.map((p) => (
                        <td key={p}>
                          <input type="checkbox" aria-label={`${r.name}: ${PERMISSIONS[p]}`} checked={r.permissions.includes(p)} disabled={locked || busy}
                            onChange={(e) => void setPerms(r, e.target.checked ? [...r.permissions, p] : r.permissions.filter((x) => x !== p))} />
                        </td>
                      ))}
                      <td>{admin && !r.builtin && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={async () => (await askConfirm(`Delete the ${r.name} role? Anyone with it becomes a Member.`, { action: "Delete role", danger: true })) && ctx.manage({ op: "SetRolePerms", role: roleNumber(r.id)!, permissions: DELETE_ROLE }, `${r.name} deleted`)}>Delete</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {admin && (
            <form className="row-form pad" onSubmit={(e) => {
              e.preventDefault();
              if (free === undefined) return;
              void ctx.manage({ op: "SetRolePerms", role: free, permissions: 0 }, `${name.trim()} added: tick what it can do`, name.trim()).then((ok) => ok && setName(""));
            }}>
              <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} placeholder="New role, e.g. Approver" aria-label="New role name" />
              <button className="btn btn-dark btn-sm" disabled={busy || !name.trim() || free === undefined} title={free === undefined ? "13 custom roles at most" : undefined}><Icon name="plus" size={14} /> Add role</button>
            </form>
          )}
        </>
      )}
      <p className="muted small pad" style={{ paddingTop: 0 }}>Every member can always vote. Roles decide what else they can do; who's a member still changes only by a vote.</p>
    </div>
  );
}

/** Invite links: send one to someone; they paste it in their own Karuna's Ask to Join. */
function InviteLinks({ ctx }: { ctx: Ctx }) {
  const { s, run, busy } = ctx;
  const [copied, setCopied] = useState<string | null>(null);
  const [limits, setLimits] = useState({ days: 7, uses: 10 });
  const invites = s.invites ?? [];
  const copy = (link: string) => {
    navigator.clipboard?.writeText(link);
    setCopied(link);
    setTimeout(() => setCopied((c) => (c === link ? null : c)), 2000);
  };
  const create = () => run(async () => { const r = await api<{ link: string }>("/invites", limits); copy(r.link); }, "Invite link created and copied");
  const revoke = async (code: string) => {
    if (await askConfirm("Revoke this invite link? Anyone who hasn't used it yet won't be able to. Requests already sent stay under Access requests.", { action: "Revoke", danger: true }))
      run(() => api(`/invites/${code}`, undefined, "DELETE"), "Invite link revoked");
  };
  return (
    <div className="card">
      <div className="hd">
        <h2>Invite links</h2>
        {s.publicUrl && (
          <span className="invite-create">
            <Select small label="How long the link lasts" value={String(limits.days)} onChange={(v) => setLimits({ ...limits, days: Number(v) })}
              options={[1, 7, 30].map((d) => ({ value: String(d), label: d === 1 ? "1 day" : `${d} days` }))} />
            <Select small label="How many people can use the link" value={String(limits.uses)} onChange={(v) => setLimits({ ...limits, uses: Number(v) })}
              options={[1, 5, 10, 25, 50].map((u) => ({ value: String(u), label: u === 1 ? "1 use" : `${u} uses` }))} />
            <button className="btn btn-dark btn-sm" disabled={busy} onClick={create}><Icon name="plus" size={14} /> Create invite link</button>
          </span>
        )}
      </div>
      <div className="pad stack-sm">
        {!s.publicUrl ? (
          <p className="muted small">Invite links need Karuna's public address (the tunnel chat apps use). Set <span className="mono">KARUNA_CHAT_URL</span> in <span className="mono">.env</span> and restart the Gatekeeper.</p>
        ) : invites.length === 0 ? (
          <p className="muted small">Send someone a link: they open Karuna on their computer, choose <b>Ask to Join</b> and paste it. Their request shows up here, and members vote to add them. Pick how long the link lasts and how many people can use it.</p>
        ) : (
          invites.map((i) => (
            <div className="invite-row" key={i.code}>
              <code className="token" title={i.link}>{i.link}</code>
              <span className="small muted">{i.uses} of {i.maxUses} used · {daysLeft(i.expiresAt)}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => copy(i.link)}><Icon name={copied === i.link ? "check" : "copy"} size={13} /> {copied === i.link ? "Copied" : "Copy"}</button>
              <button className="btn btn-deny btn-sm" disabled={busy} onClick={() => revoke(i.code)}>Revoke</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function daysLeft(iso: string) {
  const h = Math.max(0, (Date.parse(iso) - Date.now()) / 3600_000);
  return h >= 24 ? `${Math.floor(h / 24)}d left` : `${Math.max(1, Math.floor(h))}h left`;
}

// ============================================================== live alerts

/** Where the wallet watchdog's latest transfer was seen: the QuickNode Stream, or Arc read directly when it's quiet. */
function watchdogSource(source?: string | null): string {
  if (source === "rpc") return "reading Arc directly (QuickNode quiet)";
  if (source === "quicknode") return "QuickNode Stream";
  return "QuickNode Stream · Arc as backup";
}

/** Why every agent is frozen, in a sentence: a member's panic button, or one of Karuna's own safety nets. */
function freezeCause(by?: string | null): string {
  if (by === "Watchdog") return "The wallet watchdog froze every agent: USDC left the wallet without a matching Karuna payment.";
  if (by === "Tripwire" || by === "Swarm Stopper") return "Tripwire froze every agent: an agent used or shared a trap credential, or agents converged on a new target.";
  return by ? `${by} hit the panic button.` : "The panic button was pressed.";
}

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
  /** For a "New Dharma proposal" alert: it clears once nothing is left for this member to vote on. */
  proposalId?: number;
  /** For a freeze alert: it clears once agents are unfrozen. */
  whileFrozen?: boolean;
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
      if (s.frozen && s.frozen.by === "Watchdog")
        return { ...base, tone: "bad", sticky: true, whileFrozen: true, go: "swarm", cta: "Watchdog", title: "Wallet watchdog froze every agent", body: "USDC left the wallet without a matching Karuna payment. Recorded on Dharma; unfreezing needs a member vote." };
      if (s.frozen && (s.frozen.by === "Tripwire" || s.frozen.by === "Swarm Stopper"))
        return { ...base, tone: "bad", sticky: true, whileFrozen: true, go: "swarm", cta: "Tripwire", title: "Tripwire freeze recorded on Dharma", body: "Tripwire froze every agent. Unfreezing needs a member vote." };
      return { ...base, tone: "bad", sticky: true, whileFrozen: true, title: "All agents frozen", body: `${name(String(a.by))} hit the panic button. Recorded on Dharma.` };
    case "AgentsUnfrozen":
      return { ...base, tone: "ok", sticky: false, title: "Agents unfrozen", body: "The vote passed and the timelock ended." };
    case "RuleAdded":
      return { ...base, tone: "info", sticky: false, title: "Rule added", body: `${String(a.id)} — in effect now` };
    case "TestFailed":
      return { ...base, tone: "bad", sticky: true, title: "Agent fell for a drill", body: `${agentName(a.agent)} · ${String(a.category)} payments are now blocked for it.` };
    case "LevelSet": {
      const n = Number(a.level);
      const why = String(a.reason);
      const lowered = why !== "vote";
      return {
        ...base, tone: lowered ? "bad" : "ok", sticky: lowered, go: "agents",
        title: `${agentName(a.agent)}: Level ${n} · ${LEVEL_NAMES[n] ?? ""}`,
        body: why === "tripwire" ? "Lowered by a Tripwire. Recorded on Dharma." : why === "drill" ? "Lowered after a failed Drill. Recorded on Dharma." : why === "member" ? `Lowered by ${name(String(a.by))}.` : "Raised by a member vote.",
      };
    }
    case "UnapprovedTransfer":
      return { ...base, tone: "bad", sticky: true, go: "swarm", cta: "Watchdog", title: "USDC left the wallet without approval", body: `$${Number(a.amountUsd).toFixed(2)} to ${short(String(a.to))}. Every agent is frozen.` };
    default:
      return null; // anchors, payee/domain changes etc. update the screen without a pop-up
  }
}

/** Bottom-right cards on screen at once. */
const MAX_ALERTS = 3;

/** How long a card stays: time to read it (3–6 s by length; at least 5 s for one that needs you). */
function alertReadMs(a: { title: string; body: string; sticky: boolean }) {
  const read = 1500 + (a.title.length + a.body.length) * 30;
  return Math.min(6_000, Math.max(a.sticky ? 5_000 : 3_000, read));
}

/** A Dharma proposal event, for the proposal pop-ups (null for every other event). */
function govEvent(e: ChainEvent, s: Snapshot, me: string, name: (a?: string | null) => string, whats: Map<number, string>): GovEvent | null {
  const a = e.args;
  const kind = ({ ProposalCreated: "created", VoteCast: "vote", ProposalQueued: "queued", ProposalExecuted: "executed", ProposalDefeated: "defeated" } as const)[e.event as "ProposalCreated"];
  if (!kind) return null;
  const id = Number(a.id);
  const pol = s.policy;
  let what = pol?.proposals.find((g) => g.id === id)?.description ?? whats.get(id);
  if (!what && kind === "created") {
    // The event carries the change itself, so describe it before the proposal list refreshes.
    try {
      what = describeChange(decodeChange(Number(a.op), a.data as `0x${string}`), {
        member: (x) => pol?.members.find((m) => m.address === x)?.name ?? undefined,
        agent: (aid) => pol?.agents.find((g) => g.id === aid)?.name,
        payee: (x) => pol?.payees.find((p) => p.account === x)?.name ?? undefined,
      });
    } catch {
      /* described as "a policy change" below */
    }
  }
  what ??= "A policy change";
  whats.set(id, what);
  const who = String((kind === "created" ? a.proposer : a.voter) ?? "").toLowerCase();
  return { kind, id, what, mine: who === me.toLowerCase(), by: kind === "created" ? name(who) : undefined };
}

function LiveBadge({ mode }: { mode: LiveMode }) {
  const label = mode === "quicknode" ? "QuickNode" : mode === "rpc" ? "Arc" : mode === "connecting" ? "connecting…" : "relay offline";
  return <span className={`live ${mode}`} title="Where live chain events come from"><span className="d" /> {label}</span>;
}

// ============================================================== Auto-Shield

/** Watchdog, everything blocked or frozen, drills, traps and inboxes on one page. */
function Safety({ ctx }: { ctx: Ctx }) {
  return (
    <div className="stack">
      <WatchdogCard ctx={ctx} />
      <SafetyTools ctx={ctx} />
      <Incidents ctx={ctx} />
    </div>
  );
}

type SafetyMode = "drills" | "traps" | "inbox";
const SAFETY_MODES: { v: SafetyMode; label: string }[] = [{ v: "drills", label: "Drills" }, { v: "traps", label: "Traps" }, { v: "inbox", label: "Inbox" }];

/** Drills, trap credentials and inboxes in one card, chosen with a switch (like the New agent card). Remembered per browser. */
function SafetyTools({ ctx }: { ctx: Ctx }) {
  const [mode, setModeState] = useState<SafetyMode>(() => {
    try {
      const v = localStorage.getItem("karuna.safetyMode");
      return v === "traps" || v === "inbox" ? v : "drills";
    } catch {
      return "drills";
    }
  });
  const setMode = (m: SafetyMode) => {
    setModeState(m);
    try {
      localStorage.setItem("karuna.safetyMode", m);
    } catch {
      /* per-browser convenience only */
    }
  };
  const switcher = (
    <span className="filters" role="tablist" aria-label="Safety tools">
      {SAFETY_MODES.map((o) => <button key={o.v} type="button" role="tab" aria-selected={mode === o.v} className={mode === o.v ? "on" : ""} onClick={() => setMode(o.v)}>{o.label}</button>)}
    </span>
  );
  return mode === "traps" ? <Traps ctx={ctx} switcher={switcher} /> : mode === "inbox" ? <Inbox ctx={ctx} switcher={switcher} /> : <Drills ctx={ctx} switcher={switcher} />;
}

/** A card's header: its title and either its usual note (right) or, inside SafetyTools, the switch (right) and the note under it. */
function ToolHead({ title, note, switcher }: { title: string; note: ReactNode; switcher?: ReactNode }) {
  if (!switcher) return <div className="hd"><h2>{title}</h2>{note}</div>;
  return (
    <>
      <div className="hd"><h2>{title}</h2>{switcher}</div>
      {note && <div className="tool-note mode-note">{note}</div>}
    </>
  );
}

/** Auto-blocks from failed drills, swarm freezes, and agents that used a trap credential. */
function Incidents({ ctx }: { ctx: Ctx }) {
  const { s, busy } = ctx;
  const pol = s.policy!;
  const blocks = s.shield.autoRules.filter((r) => r.active);
  const sw = s.swarm;
  const agentName = (id: string | null) => (id ? pol.agents.find((a) => a.id === id)?.name ?? id : "every agent");
  const n = blocks.length + sw.trips.length + sw.tainted.length;
  return (
    <div className="card">
      <div className="hd"><h2>Blocks and freezes</h2><span className="sub">{n || ""}</span></div>
      {n === 0 && <Empty icon="shield">Nothing blocked. An agent that fails a drill or touches a trap shows up here.</Empty>}
      {blocks.length > 0 && (
        <div className="table">
          {blocks.map((r) => {
            const removing = pol.proposals.some((g) => g.change?.op === "RemoveRule" && g.change.id === r.id && (g.status === "open" || g.status === "queued"));
            const approvalId = r.id.replace(/^sh-/, "ap-");
            const hasApproval = pol.rules.some((x) => x.id === approvalId && x.active);
            return (
              <div className="tr shield-tr" key={r.id}>
                <span className="b">{agentName(r.agent)} can't pay for <b>{r.category}</b></span>
                <span className="mono small muted">failed a drill</span>
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
      {(sw.trips.length > 0 || sw.tainted.length > 0) && (
        <div className="resolved">
          {sw.trips.map((t) => (
            <div className="res" key={t.id}>
              <span className="badge badge-danger"><Icon name="stop" size={12} />froze all</span>
              <span className="small">{t.reason} <span className="muted">· {t.agents.map((a) => agentName(a)).join(", ")}</span></span>
              <span className="muted small">{isTx(t.txRef) ? <TxLink tx={t.txRef} s={s} /> : "local"} · {ago(t.at)}</span>
            </div>
          ))}
          {sw.tainted.map((t) => (
            <div className="res" key={t.agentId}>
              <span className="badge badge-danger">used a trap</span>
              <span className="small"><b>{t.agentName}</b> used <span className="mono">{t.secret}</span></span>
              <span className="muted small">{ago(t.at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Fake scams sent to agents, automatically and on demand. */
function Drills({ ctx, switcher }: { ctx: Ctx; switcher?: ReactNode }) {
  const { s, busy, run } = ctx;
  const pol = s.policy!;
  const active = pol.agents.filter((a) => a.active);
  const categories = [...new Set(pol.payees.map((p) => p.category))];
  const [test, setTest] = useState({ agentId: "", template: "", category: "" });
  const agentName = (id: string | null) => (id ? pol.agents.find((a) => a.id === id)?.name ?? id : "every agent");
  const tests = s.shield.tests;
  const runTest = (e: FormEvent) => {
    e.preventDefault();
    run(() => api("/shield/test", { agentId: test.agentId || active[0]?.id, template: test.template || undefined, category: test.category || undefined }),
      "Test sent. It looks exactly like a real message to the agent.");
  };
  return (
    <div className="card">
      <ToolHead title="Drills" switcher={switcher} note={<span className="sub">A fake email that tries to trick the agent into acting.</span>} />
      <form className="inline-form" onSubmit={runTest}>
        <label className="field"><span>Agent</span>
          <Select label="Agent" value={test.agentId} onChange={(v) => setTest({ ...test, agentId: v })} options={active.map((a) => ({ value: a.id, label: a.name }))} />
        </label>
        <label className="field"><span>Scam</span>
          <Select label="Scam" value={test.template} onChange={(v) => setTest({ ...test, template: v })}
            options={[{ value: "", label: "Random" }, ...Object.entries(s.shield.templates).map(([k, v]) => ({ value: k, label: v }))]} />
        </label>
        <label className="field"><span>Pretends to be</span>
          <input list="shield-cats" value={test.category} onChange={(e) => setTest({ ...test, category: e.target.value })} placeholder={categories[0] ?? "supplies"} />
          <datalist id="shield-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
        <button className="btn btn-dark" disabled={busy || !active.length}><Icon name="shield" /> Send test</button>
      </form>
      {tests.length > 0 && (
        <div className="resolved">
          {tests.slice(0, 10).map((t) => (
            <div className="res" key={t.id}>
              {t.status === "failed" ? <span className="badge badge-danger"><Icon name="x" size={12} />failed</span> : <Badge v={t.status === "passed" ? "allow" : "approval"}>{t.status}</Badge>}
              <span className="small">{agentName(t.agentId)} · {s.shield.templates[t.template] ?? t.template} · {t.category}</span>
              <span className="muted small">{t.resolution ? `${t.resolution} · ` : ""}{ago(t.sentAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Hand an agent work the way a supplier or teammate would, and see what reached each inbox. */
function Inbox({ ctx, switcher }: { ctx: Ctx; switcher?: ReactNode }) {
  const { s, busy, run } = ctx;
  const pol = s.policy!;
  const active = pol.agents.filter((a) => a.active);
  const [msg, setMsg] = useState({ agentId: "", from: "", subject: "", body: "" });
  const agentName = (id: string | null) => (id ? pol.agents.find((a) => a.id === id)?.name ?? id : "every agent");
  const send = (e: FormEvent) => {
    e.preventDefault();
    run(() => api("/inbox", { ...msg, agentId: msg.agentId || active[0]?.id }), "Message delivered to the agent's inbox").then((ok) => ok && setMsg({ ...msg, subject: "", body: "" }));
  };
  return (
    <div className="card">
      <ToolHead title="Inboxes" switcher={switcher} note={s.inbox.length ? <span className="sub">{s.inbox.length} message{s.inbox.length === 1 ? "" : "s"}</span> : null} />
      <form className="pad stack-sm" onSubmit={send}>
        <div className="row-form">
          <Select label="Agent" value={msg.agentId} onChange={(v) => setMsg({ ...msg, agentId: v })} options={active.map((a) => ({ value: a.id, label: a.name }))} />
          <input aria-label="From" required value={msg.from} onChange={(e) => setMsg({ ...msg, from: e.target.value })} placeholder="From (e.g. a supplier)" />
          <input aria-label="Subject" required value={msg.subject} onChange={(e) => setMsg({ ...msg, subject: e.target.value })} placeholder="Subject" />
        </div>
        <textarea aria-label="Message" required rows={3} value={msg.body} onChange={(e) => setMsg({ ...msg, body: e.target.value })} placeholder="Invoice text, payment details…" />
        <div><button className="btn btn-dark" disabled={busy || !active.length}><Icon name="inbox" /> Deliver</button></div>
      </form>
      {s.inbox.length > 0 && (
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
  );
}

// ============================================================== Swarm Stopper + Trap Passwords

/** Bait credentials: any agent that uses one freezes every agent. */
function Traps({ ctx, switcher }: { ctx: Ctx; switcher?: ReactNode }) {
  const { s, busy, run } = ctx;
  const pol = s.policy!;
  const sw = s.swarm;
  const active = pol.agents.filter((a) => a.active);
  const [target, setTarget] = useState("");
  const [plantTo, setPlantTo] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<string | null>(null);
  const agentName = (id: string) => pol.agents.find((a) => a.id === id)?.name ?? id;

  return (
      <div className="card">
        <ToolHead title="Trap credentials" switcher={switcher} note={<span className="sub">A fake API key planted where the agent can find it.</span>} />
        <form className="pad row-form" onSubmit={(e) => { e.preventDefault(); run(() => api("/traps", { agentId: target || undefined }), "Trap credentials minted. Plant them where the agent can find them."); }}>
          <Select label="Which agent the traps are for" value={target} onChange={setTarget}
            options={[{ value: "", label: "For every agent" }, ...active.map((a) => ({ value: a.id, label: `For ${a.name}` }))]} />
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
                      <Select small label="Agent to leak the credentials to" value={to} onChange={(v) => setPlantTo({ ...plantTo, [t.id]: v })} options={active.map((a) => ({ value: a.id, label: a.name }))} />
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

// ============================================================== worst case

const money = (n: number | null, wallet: number | null) => (n == null ? "no limit" : wallet != null && n >= wallet && wallet > 0 ? `${usd(n)} (the whole wallet)` : usd(n));
const sites = (xs: string[]) => (xs.includes("*") ? "any site" : xs.length ? xs.join(", ") : "none");
const FILE_WRITES = { none: "none", workspace: "its workspace only", anywhere: "anywhere in its sandbox" } as const;
const TOOLS = { none: "read-only", "non-destructive": "all but destructive ones", all: "all" } as const;

/** One line per agent: the money it could move and what else it could touch. */
function agentWorst(x: AgentExposure, wallet: number | null): string {
  const parts = [
    x.dailyUsd === 0 && x.perPaymentUsd === 0 ? "no payments" : `${money(x.dailyUsd, wallet)}/day, ${money(x.perPaymentUsd, wallet)} per payment`,
    x.writeSites.length ? `writes to ${sites(x.writeSites)}` : null,
    x.keys.length ? `keys ${x.keys.join(", ")}` : null,
    x.fileWrites !== "workspace" || x.writePaths.length ? `files: ${[FILE_WRITES[x.fileWrites], ...x.writePaths].join(", ")}` : null,
    x.packageInstalls ? "package installs" : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** Home: if every agent were hijacked right now, what they could do with no member. */
function WorstCase({ x, names }: { x: Exposure; names: Record<string, string> }) {
  const all = <T,>(f: (a: AgentExposure) => T[]) => [...new Set(x.agents.flatMap(f))];
  const writeSites = all((a) => a.writeSites);
  const keys = all((a) => a.keys);
  const files = x.agents.some((a) => a.fileWrites === "anywhere") ? "anywhere in a sandbox" : x.agents.some((a) => a.fileWrites === "workspace") ? "workspaces only" : "none";
  const installs = x.agents.filter((a) => a.packageInstalls).map((a) => names[a.agentId] ?? a.agentId);
  return (
    <div className="card rise worst" style={st(1)}>
      <div className="hd"><h2>If every agent were hijacked</h2><span className="sub">what they could do with no member, under today's rules</span></div>
      {x.frozen ? <div className="pad muted">Agents are frozen: nothing runs.</div> : (
        <div className="pad">
          <div className="kv"><span>Money out per day</span><b>{money(x.dailyUsd, x.walletUsd)}</b></div>
          <div className="kv"><span>Largest single payment</span><b>{money(x.perPaymentUsd, x.walletUsd)}</b></div>
          <div className="kv"><span>Sites they could write to</span><b className="mono">{sites(writeSites)}</b></div>
          <div className="kv"><span>Keys they could use</span><b className="mono">{keys.length ? keys.join(", ") : "none"}</b></div>
          <div className="kv"><span>File writes</span><b>{files}</b></div>
          <div className="kv"><span>Package installs</span><b>{installs.length ? installs.join(", ") : "none"}</b></div>
        </div>
      )}
    </div>
  );
}

/** On a ballot: what the change would add to (or take from) the worst case. */
function WorstDelta({ lines }: { lines: string[] }) {
  const up = lines.some((l) => l.startsWith("+"));
  return (
    <div className={`preview ${up ? "preview-warn" : ""}`}>
      <span className="field-label"><Icon name="alert" size={13} /> Worst case if it passes</span>
      <ul className="worst-delta">{lines.map((l) => <li key={l} className={l.startsWith("+") ? "up" : "down"}>{l}</li>)}</ul>
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

// ============================================================== keys, asked for where they're used

/** A short, stable Dharma rule id (bytes32: 32 chars max). */
const ruleId = (prefix: string) => `${prefix}-${Date.now().toString(36)}`.slice(0, 32);

const DRAFTER_PROVIDERS = {
  groq: { label: "Groq", env: "GROQ_API_KEY", where: "console.groq.com" },
  gemini: { label: "Gemini", env: "GEMINI_API_KEY", where: "aistudio.google.com" },
} as const;
const hasDrafterKey = (s: Snapshot) => s.sandbox.keys.some((k) => k.purpose === "drafter" || k.name === DRAFTER_KEY);

/** In both drafters until a free Groq or Gemini key is saved. Karuna uses it itself; agents never get it. */
function DrafterKeyField({ ctx }: { ctx: Ctx }) {
  const { run, busy } = ctx;
  const [provider, setProvider] = useState<keyof typeof DRAFTER_PROVIDERS>("groq");
  const [value, setValue] = useState("");
  if (hasDrafterKey(ctx.s)) return null;
  const P = DRAFTER_PROVIDERS[provider];
  return (
    <div className="key-ask">
      <span className="small">Drafting needs a free key from <a className="link-u" href={`https://${P.where}`} target="_blank" rel="noreferrer">{P.where}</a></span>
      <div className="row-form">
        <Picker label="Drafter provider" value={provider} onChange={setProvider}
          options={(Object.keys(DRAFTER_PROVIDERS) as (keyof typeof DRAFTER_PROVIDERS)[]).map((k) => ({ value: k, label: DRAFTER_PROVIDERS[k].label, hint: DRAFTER_PROVIDERS[k].where }))} />
        <input type="password" autoComplete="off" className="mono grow" aria-label="Drafter key" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste the key" />
        <button type="button" className="btn btn-dark btn-sm" disabled={busy || !value.trim()}
          onClick={() => run(async () => { await api("/keys", { name: `${provider}-drafter`, envVar: P.env, value: value.trim(), purpose: "drafter", provider }); setValue(""); }, `${P.label} key saved for drafting`)}>
          Save
        </button>
      </div>
    </div>
  );
}

/** A connector's sign-in key, sent only to that connector's address by Karuna itself. */
function ConnectorKey({ name, ctx }: { name: string; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  if (!open) return <button type="button" className="link-btn small" onClick={() => setOpen(true)}>Add sign-in key</button>;
  return (
    <span className="row-form">
      <input type="password" autoComplete="off" className="select-sm mono" aria-label={`Sign-in key for ${name}`} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Sign-in key" />
      <button type="button" className="btn btn-ghost btn-sm" disabled={ctx.busy || !value.trim()}
        onClick={() => ctx.run(async () => { await api("/keys", { name, envVar: connectorEnv(name), value: value.trim() }); setOpen(false); }, `Sign-in key saved for ${name}`)}>Save</button>
    </span>
  );
}
const connectorEnv = (name: string) => `${name.toUpperCase().replace(/-/g, "_")}_CONNECTOR_KEY`;

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


// ============================================================== Claude chat setup

/** The switches to turn off in the chat app, so every tool it uses goes through Karuna. */
const CHAT_OFF = [
  { id: "search", label: "Web search", note: "Karuna's web_search replaces it" },
  { id: "code", label: "Code execution and file creation", note: "runs on the chat app's servers, outside Karuna" },
  { id: "direct", label: "Connectors added in Claude directly", note: "add them under Connectors instead" },
] as const;

/** Connect Claude chat: Karuna's address, then the built-in tools to turn off (the New agent card's "Claude chat" mode). */
function ChatSetup({ ctx }: { ctx: Ctx }) {
  const { s } = ctx;
  const url = s.chatUrl ?? null;
  const connected = (s.devices ?? []).some((d) => d.tool === "chat" && d.status === "approved");
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("karuna.chatSetup") ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const tick = (id: string, on: boolean) => {
    const next = { ...done, [id]: on };
    setDone(next);
    try {
      localStorage.setItem("karuna.chatSetup", JSON.stringify(next));
    } catch {
      /* per-browser convenience only */
    }
  };
  const off = CHAT_OFF.filter((x) => done[x.id]).length;
  return (
    <div className="chat-setup">
      <div className="pad stack-sm">
        <div className="mode-note"><span className={`live-dot${connected ? "" : " off"}`} aria-hidden /> {connected ? `Connected · ${off}/${CHAT_OFF.length} built-in tools off` : "Not connected yet"}</div>
        <div className="chat-step">
          <span className="step-n">1</span>
          <div className="grow">
            <b>Add Karuna as a connector</b>
            <div className="small muted">In Claude: Settings → Connectors → Add custom connector. Paste this address, then approve its code below.</div>
            {url ? (
              <div className="row-form">
                <span className="mono small chat-url">{url}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); }}><Icon name={copied ? "check" : "copy"} size={13} /> {copied ? "Copied" : "Copy"}</button>
              </div>
            ) : (
              <div className="small muted">No public address yet. Point a tunnel at port 8792, set <span className="mono">KARUNA_CHAT_URL</span> to its address, and restart Karuna.</div>
            )}
          </div>
        </div>
        <div className="chat-step">
          <span className="step-n">2</span>
          <div className="grow">
            <b>Turn these off in Claude</b>
            <div className="small muted">Karuna can't see the chat app's own tools. With them off, every tool Claude uses goes through your rules.</div>
            {CHAT_OFF.map((x) => (
              <label className="check-row" key={x.id}>
                <input type="checkbox" checked={!!done[x.id]} onChange={(e) => tick(x.id, e.target.checked)} />
                <span>{x.label} <span className="muted small">· {x.note}</span></span>
              </label>
            ))}
          </div>
        </div>
        <DeviceList ctx={ctx} kind="chat" />
      </div>
    </div>
  );
}

/** The New agent card's "Coding agents" mode: connect Claude Code or Cursor through Karuna's plugin. */
const CODING_STEPS = [
  { tool: "Claude Code", lines: ["/plugin marketplace add <this project's folder>", "/plugin install karuna@karuna"] },
  { tool: "Cursor", lines: ["node plugin/scripts/install-cursor.mjs"] },
] as const;

function CodingSetup({ ctx }: { ctx: Ctx }) {
  const devices = (ctx.s.devices ?? []).filter((d) => d.tool !== "chat");
  const connected = devices.filter((d) => d.status === "approved").length;
  const waiting = devices.filter((d) => d.status === "pending").length;
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied((c) => (c === text ? null : c)), 2000);
  };
  return (
    <div className="chat-setup">
      <div className="pad stack-sm">
        <div className="mode-note"><span className={`live-dot${connected ? "" : " off"}`} aria-hidden /> {connected || waiting ? `${connected} connected${waiting ? ` · ${waiting} waiting for approval` : ""}` : "None connected yet"}</div>
        <div className="chat-step">
          <span className="step-n">1</span>
          <div className="grow">
            <b>Add Karuna's plugin</b>
            <div className="small muted">Once per computer. Every tool call the coding agent makes then goes through your rules first.</div>
            {CODING_STEPS.map((t) => (
              <div className="coding-tool" key={t.tool}>
                <span className="small">{t.tool}</span>
                {t.lines.map((l) => (
                  <div className="row-form" key={l}>
                    <span className="mono small chat-url">{l}</span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(l)}><Icon name={copied === l ? "check" : "copy"} size={13} /> {copied === l ? "Copied" : "Copy"}</button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="chat-step">
          <span className="step-n">2</span>
          <div className="grow">
            <b>Approve its code</b>
            <div className="small muted">The first time it tries a tool, it shows a code. Check it matches the request below and approve it. It gets its own agent, starting at Level 0.</div>
          </div>
        </div>
        <DeviceList ctx={ctx} kind="coding" />
      </div>
    </div>
  );
}

// ============================================================== computers (Claude Code / Cursor plugin)

/** Coding tools (Claude Code, Cursor) or chat apps: waiting requests to approve or deny, and connections to disconnect. */
const isChatDevice = (d: { tool: string }) => d.tool === "chat";

/**
 * The connections of one kind, shown inside the New agent card's Claude chat and Coding agents modes
 * (this used to be the separate "Computers & chats" card). Approve, Deny and Disconnect work as before.
 */
function DeviceList({ ctx, kind }: { ctx: Ctx; kind: "chat" | "coding" }) {
  const { s, run, busy, me } = ctx;
  const devices = (s.devices ?? []).filter((d) => (kind === "chat" ? isChatDevice(d) : !isChatDevice(d)));
  const pending = devices.filter((d) => d.status === "pending");
  const connected = devices.filter((d) => d.status === "approved");
  const toolName = (t: string) => (t === "cursor" ? "Cursor" : t === "chat" ? "Chat app" : "Claude Code");
  const approve = (d: (typeof devices)[number]) =>
    run(async () => {
      const dharma = s.org.dharma!.address as Address;
      const { agentId } = await api<{ agentId: string }>(`/devices/${d.id}/approve`, { by: me.address });
      // Its agent, and the vote to let it run outside a sandbox (it runs on that person's computer).
      await submitChange(me, dharma, { kind: Kind.Propose, change: { op: "SetAgent", id: agentId, capUsd: 0 }, label: d.name });
      await submitChange(me, dharma, { kind: Kind.Propose, change: { op: "AddRule", id: `unsandboxed-${agentId}`.slice(0, 31), outcome: "Allow", scope: "unsandboxed", target: agentId } });
    }, `Approved. ${d.name} works once the vote passes (${s.policy!.timelock}s), starting at Level 0`);
  return (
    <div className="device-list">
      <span className="field-label">{kind === "chat" ? "Chat apps" : "Coding agents"} · {connected.length} connected{pending.length ? ` · ${pending.length} waiting` : ""}</span>
      {!devices.length ? (
        <div className="small muted">Nothing connected yet. Its code shows up here to approve.</div>
      ) : (
        <div className="resolved">
          {pending.map((d) => (
            <div className="res" key={d.id}>
              <Badge v="approval">wants to connect</Badge>
              <span className="small"><b>{d.name}</b> · {toolName(d.tool)} · code <span className="mono">{d.code}</span> · {ago(d.requestedAt)}</span>
              <span className="ballot-actions">
                <button className="btn btn-deny btn-sm" disabled={busy} onClick={() => run(() => api(`/devices/${d.id}/deny`, {}), "Denied")}>Deny</button>
                <button className="btn btn-approve btn-sm" disabled={busy} title="Check the code matches the one on that computer" onClick={() => approve(d)}><Icon name="pen" size={14} /> Approve</button>
              </span>
            </div>
          ))}
          {connected.map((d) => {
            const seen = d.lastSeenAt ? Date.now() - Date.parse(d.lastSeenAt) : null;
            return (
              <div className="res" key={d.id}>
                <Badge v={seen !== null && seen < 10 * 60_000 ? "allow" : "approval"}>{seen !== null && seen < 10 * 60_000 ? "active" : "connected"}</Badge>
                <span className="small"><b>{d.agentName ?? d.name}</b> · {toolName(d.tool)} · {d.lastSeenAt ? `last call ${ago(d.lastSeenAt)}` : "no calls yet"}</span>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={async () => (await askConfirm(`Disconnect ${d.name}? Its tool calls stop working at once.`, { action: "Disconnect", danger: true })) && run(() => api(`/devices/${d.id}/revoke`, {}), "Disconnected")}>Disconnect</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================== new agent (Karuna builds and runs it)

const SCHEDULE_TEXT = (s: Schedule) =>
  s.kind === "every" ? (s.minutes! % 60 === 0 ? `Every ${s.minutes! / 60} h` : `Every ${s.minutes} min`) : s.kind === "daily" ? `Daily at ${s.at}` : s.kind === "inbox" ? "When a message arrives in its inbox" : "Only when started";

function ScheduleFields({ value, onChange }: { value: Schedule; onChange: (s: Schedule) => void }) {
  return (
    <div className="row-form">
      <Select small label="When it runs" value={value.kind} onChange={(k) => {
        const kind = k as Schedule["kind"];
        onChange(kind === "every" ? { kind, minutes: value.minutes ?? 60 } : kind === "daily" ? { kind, at: value.at ?? "09:00" } : { kind });
      }} options={[
        { value: "manual", label: "Only when started" },
        { value: "every", label: "Every…" },
        { value: "daily", label: "Daily at…" },
        { value: "inbox", label: "When a message arrives" },
      ]} />
      {value.kind === "every" && <label className="inline-field"><input className="select-sm mono" type="number" min={15} step={15} value={value.minutes} onChange={(e) => onChange({ ...value, minutes: Number(e.target.value) })} /> minutes</label>}
      {value.kind === "daily" && <input className="select-sm mono" type="time" aria-label="Time" value={value.at} onChange={(e) => onChange({ ...value, at: e.target.value })} />}
    </div>
  );
}

/** The keys built agents run on (agents/hosted/run.ts reads their placeholders). */
const CLAUDE_KEY = "anthropic";
const CLAUDE_HOST = "api.anthropic.com";
const GROQ_KEY = "groq";
const GROQ_HOST = "api.groq.com";
type AgentModel = "groq" | "anthropic";

/** Describe a job; Karuna drafts the agent; members review and propose it; Karuna runs it. */
type NewAgentMode = "agent" | "chat" | "coding";
const NEW_AGENT_MODES: { v: NewAgentMode; label: string }[] = [{ v: "agent", label: "New agent" }, { v: "chat", label: "Claude chat" }, { v: "coding", label: "Coding agents" }];
const NEW_AGENT_TITLES: Record<NewAgentMode, string> = { agent: "New agent", chat: "Claude chat", coding: "Coding agents" };

function NewAgent({ ctx, own }: { ctx: Ctx; own?: ReactNode }) {
  const { s, run, busy, me } = ctx;
  const [levelsOpen, setLevelsOpen] = useState(false);
  // Ways to add an agent: one Karuna builds and runs, Claude chat as a connector, or a coding agent (Claude Code, Cursor) through the plugin. Remembered per browser.
  const [mode, setModeState] = useState<NewAgentMode>(() => {
    try {
      const v = localStorage.getItem("karuna.newAgentMode");
      return v === "chat" || v === "coding" ? v : "agent";
    } catch {
      return "agent";
    }
  });
  const setMode = (m: NewAgentMode) => {
    setModeState(m);
    try {
      localStorage.setItem("karuna.newAgentMode", m);
    } catch {
      /* per-browser convenience only */
    }
  };
  const [job, setJob] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [err, setErr] = useState("");
  const [d, setD] = useState<AgentDraftView | null>(null);
  const [keep, setKeep] = useState<Record<number, boolean>>({});
  const [claude, setClaude] = useState("");
  const [model, setModel] = useState<AgentModel>("groq");
  const claudeKey = s.sandbox.keys.find((k) => k.name === CLAUDE_KEY);
  const groqKey = s.sandbox.keys.find((k) => k.name === GROQ_KEY && !k.purpose);
  // The free Groq key saved for drafting can run the agent too: Karuna copies it, nobody re-pastes it.
  const groqDrafter = s.sandbox.keys.some((k) => k.purpose === "drafter" && k.provider === "groq");
  const [keyName, keyHost, haveKey] = model === "groq" ? [GROQ_KEY, GROQ_HOST, !!groqKey || groqDrafter] : [CLAUDE_KEY, CLAUDE_HOST, !!claudeKey];
  const open = (scope: string) => s.policy!.proposals.some((g) => (g.status === "open" || g.status === "queued") && g.change?.op === "AddRule" && g.change.scope === scope);
  const draft = async () => {
    setDrafting(true);
    setErr("");
    try {
      const r = await api<AgentDraftView>("/agents/draft", { text: job });
      setD(r);
      setKeep(Object.fromEntries(r.rules.map((_, i) => [i, true])));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDrafting(false);
    }
  };
  const propose = () =>
    run(async () => {
      if (!d) return;
      const dharma = s.org.dharma!.address as Address;
      if (model === "anthropic" && !claudeKey) await api("/keys", { name: CLAUDE_KEY, envVar: "ANTHROPIC_API_KEY", value: claude.trim() });
      if (model === "groq" && !groqKey) await api("/keys", { name: GROQ_KEY, envVar: "GROQ_API_KEY", ...(groqDrafter ? { copyFrom: "groq" } : { value: claude.trim() }) });
      const bound = model === "groq" ? groqKey : claudeKey;
      const { id } = await api<{ id: string }>("/agents/build", { name: d.name, instructions: d.instructions, schedule: d.schedule, provider: model });
      await submitChange(me, dharma, { kind: Kind.Propose, change: { op: "SetAgent", id, capUsd: 0 }, label: d.name });
      // Its limits apply to it alone.
      for (const [i, r] of d.rules.entries()) if (keep[i]) await submitChange(me, dharma, { kind: Kind.Propose, change: { ...r.change, agent: id } });
      // The model key it runs on: the key may only go to the model's host, and this agent may call it.
      if (!bound?.boundTo.includes(keyHost) && !open(`key:${keyName}`)) {
        await submitChange(me, dharma, { kind: Kind.Propose, change: { op: "AddRule", id: ruleId(`k-${keyName}`), outcome: "Allow", scope: `key:${keyName}`, target: keyHost } });
      }
      await submitChange(me, dharma, { kind: Kind.Propose, change: { op: "AddRule", id: ruleId(`m-${id}`), outcome: "Allow", agent: id, scope: "http:POST", target: keyHost } });
      setD(null);
      setJob("");
      setClaude("");
    }, `Proposed. Karuna runs it once the vote passes (${s.policy!.timelock}s), starting at Level 0`);
  return (
    <div className="card new-agent">
      <div className="hd">
        <h2>{NEW_AGENT_TITLES[mode]}</h2>
        <span className="filters" role="tablist" aria-label="How to add an agent">
          {NEW_AGENT_MODES.map((o) => {
            // Requests waiting for a member's approval, so one isn't missed while the card shows another mode.
            const waiting = o.v === "agent" ? 0 : (s.devices ?? []).filter((d) => d.status === "pending" && (o.v === "chat" ? isChatDevice(d) : !isChatDevice(d))).length;
            return (
              <button key={o.v} type="button" role="tab" aria-selected={mode === o.v} className={mode === o.v ? "on" : ""} onClick={() => setMode(o.v)}
                aria-label={waiting ? `${o.label}, ${waiting} waiting for approval` : undefined}>
                {o.label}{waiting > 0 && <span className="count tab-count">{waiting}</span>}
              </button>
            );
          })}
        </span>
      </div>
      {mode === "chat" ? <ChatSetup ctx={ctx} /> : mode === "coding" ? <CodingSetup ctx={ctx} /> : (
      <div className="pad stack-sm">
        <div className="mode-note-row">
          <div className="mode-note">Karuna builds and runs it</div>
          {hasLevels(s) && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLevelsOpen(true)}><Icon name="info" size={14} /> Trust levels</button>}
        </div>
        {levelsOpen && hasLevels(s) && <LevelsCard ctx={ctx} onClose={() => setLevelsOpen(false)} />}
        {!d ? (
          <>
            <DrafterKeyField ctx={ctx} />
            <textarea aria-label="Describe the job" rows={3} value={job} onChange={(e) => setJob(e.target.value)} placeholder="e.g. Every morning, check grain prices; if flour is under $35, order from Valley Flour, up to $50 a week." />
            {err && <p className="err-text">{err}</p>}
            <div className="row-form"><button className="btn btn-dark" disabled={drafting || job.trim().length < 10} onClick={draft}>{drafting ? <span className="shimmer">Drafting…</span> : "Draft the agent"}</button></div>
            {own}
          </>
        ) : (
          <>
            <label className="field"><span>Name</span><input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></label>
            <label className="field"><span>Instructions</span><textarea rows={5} value={d.instructions} onChange={(e) => setD({ ...d, instructions: e.target.value })} /></label>
            <div className="field"><span>When it runs</span><ScheduleFields value={d.schedule} onChange={(schedule) => setD({ ...d, schedule })} /></div>
            {d.rules.length > 0 && (
              <div className="field">
                <span>Its limits (voted with it)</span>
                {d.rules.map((r, i) => (
                  <label className="check-row" key={r.change.id}><input type="checkbox" checked={!!keep[i]} onChange={(e) => setKeep({ ...keep, [i]: e.target.checked })} /> {r.sentence.replace(/ for every agent/, "")}</label>
                ))}
              </div>
            )}
            {(d.note || d.rulesNote) && <p className="muted small">{[d.note, d.rulesNote].filter(Boolean).join(" ")}</p>}
            <label className="field"><span>Runs on</span>
              <Select label="Runs on" value={model} onChange={(v) => { setModel(v as AgentModel); setClaude(""); }}
                options={[{ value: "groq", label: "Groq · gpt-oss-20b (free tier)" }, { value: "anthropic", label: "Claude (paid)" }]} />
              {model === "groq" && haveKey && <small className="muted">Uses your saved Groq key. Its reasoning shows in each run.</small>}
            </label>
            {!haveKey && (
              <label className="field"><span>{model === "groq" ? "Groq key (voted with it)" : "Claude key (voted with it)"}</span>
                <input type="password" autoComplete="off" className="mono" value={claude} onChange={(e) => setClaude(e.target.value)} placeholder={model === "groq" ? "gsk_… free from console.groq.com" : "sk-ant-… from console.anthropic.com"} />
                <small className="muted">The agent only sees a placeholder. Karuna swaps in the key on requests to {keyHost} and nowhere else.</small>
              </label>
            )}
            <p className="muted small">It starts at Level 0: small payments only, everything else waits for a member until it earns more.</p>
            <div className="row-form">
              <button className="btn btn-ghost" onClick={() => setD(null)}>Back</button>
              <button className="btn btn-dark" disabled={busy || !d.name.trim() || !d.instructions.trim() || (!haveKey && !claude.trim())} onClick={propose}><Icon name="pen" size={14} /> Propose agent</button>
            </div>
          </>
        )}
      </div>
      )}
    </div>
  );
}

/** On a built agent's card: schedule, Run now, Pause, Edit instructions. */
function BuiltControls({ a, ctx, openRuns }: { a: AgentView; ctx: Ctx; openRuns: () => void }) {
  const { run, busy } = ctx;
  const b = a.built!;
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="built">
      <div className="level-row">
        <span className="tag" title="When Karuna starts it"><Icon name="clock" size={11} /> {b.scheduleText}{b.paused ? " · paused" : ""}</span>
        <span className="muted small">{b.lastRunAt ? `last run ${ago(b.lastRunAt)}` : "hasn't run yet"}</span>
      </div>
      {editing !== null ? (
        <div className="stack-sm">
          <textarea rows={5} aria-label="Instructions" value={editing} onChange={(e) => setEditing(e.target.value)} />
          <div className="row-form">
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn btn-dark btn-sm" disabled={busy || !editing.trim() || editing === b.instructions}
              onClick={async () => (await askConfirm(`Change ${a.name}'s instructions?\n\nNow:\n${b.instructions}\n\nNew:\n${editing}`, { action: "Change instructions", icon: "pen" })) && run(() => api(`/agents/${a.id}/built`, { instructions: editing }, "PATCH"), "Instructions changed").then((ok) => ok && setEditing(null))}>Save</button>
          </div>
        </div>
      ) : (
        <div className="agent-actions">
          <button className="btn btn-dark btn-sm" disabled={busy || b.paused} onClick={() => run(() => api(`/agents/${a.id}/run`, {}).then(openRuns), "Started")}>Run now</button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api(`/agents/${a.id}/built`, { paused: !b.paused }, "PATCH"), b.paused ? "Resumed" : "Paused")}>{b.paused ? "Resume" : "Pause"}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(b.instructions)}>Edit instructions</button>
        </div>
      )}
    </div>
  );
}

// ============================================================== the Runs view

/** One agent's runs; open one for its live timeline. */
function RunsPanel({ ctx, agentId, onClose }: { ctx: Ctx; agentId: string; onClose: () => void }) {
  const { s } = ctx;
  const runs = (s.runs ?? []).filter((r) => r.agentId === agentId);
  const [open, setOpen] = useState<string | null>(runs[0]?.id ?? null);
  useEffect(() => {
    if (!open && runs[0]) setOpen(runs[0].id);
  }, [runs[0]?.id]);
  const name = s.policy!.agents.find((a) => a.id === agentId)?.name ?? agentId;
  return (
    <div className="card runs-panel rise">
      <div className="hd"><h2>Runs · {name}</h2><button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="x" size={12} /> Close</button></div>
      {runs.length === 0 ? (
        <Empty icon="activity">No runs yet.</Empty>
      ) : (
        <div className="runs-split">
          <div className="runs-list">
            {runs.map((r) => (
              <button key={r.id} className={`run-item ${open === r.id ? "on" : ""}`} onClick={() => setOpen(r.id)}>
                <span className={`run-dot ${r.status}`} />
                <span><b>{r.trigger}</b><small>{ago(r.startedAt)} · {r.actions} action{r.actions === 1 ? "" : "s"}{r.waiting ? ` · ${r.waiting} waiting` : ""}{r.changes ? ` · ${r.changes} file${r.changes === 1 ? "" : "s"} changed${r.undone ? `, ${r.undone} undone` : ""}` : ""}</small></span>
              </button>
            ))}
          </div>
          {open && <RunTimeline ctx={ctx} id={open} />}
        </div>
      )}
    </div>
  );
}

function RunTimeline({ ctx, id }: { ctx: Ctx; id: string }) {
  const { s, me, run, busy } = ctx;
  const [r, setR] = useState<RunDetail | null>(null);
  const summary = (s.runs ?? []).find((x) => x.id === id);
  // Live while it runs: refetch on every change the console hears about (and every 3 s as a fallback).
  useEffect(() => {
    let alive = true;
    const load = () => (PREVIEW ? setR(previewRun(id)) : void api<RunDetail>(`/runs/${id}`).then((x) => alive && setR(x)).catch(() => undefined));
    load();
    // A finished run doesn't change: no fallback polling for it.
    const finished = !!summary && summary.status !== "running" && summary.status !== "starting";
    const t = finished ? undefined : setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, summary?.steps, summary?.status]);
  if (!r) return <div className="run-timeline"><Loading text="Loading the run…" /></div>;
  const steps: RunStep[] = r.steps;
  const live = r.status === "running" || r.status === "starting";
  const session = s.sandbox.sessions.find((x) => x.agentId === r.agentId);
  const decide = (proposalId: string, approve: boolean) => {
    const p = s.proposals.find((x) => x.id === proposalId);
    if (!p || !ctx.can("approve")) return;
    run(() => decidePayment(me, s.org.dharma!.address as Address, p.id, p.payloadHash ?? "0".repeat(64), approve), approve ? "Approved" : "Denied");
  };
  return (
    <div className="run-timeline">
      <div className="run-head">
        <span className={`badge ${live ? "badge-allow" : r.status === "done" ? "badge-quiet" : "badge-danger"}`}>{live ? "running" : r.status}</span>
        <span className="small">{r.trigger} · started {ago(r.startedAt)}{r.host ? ` · ${r.host}` : ""}</span>
        <span className="small muted">{r.models.length ? `Model: ${r.models.join(", ")}` : ""}</span>
        <span className="run-head-actions">
          {session?.viewer && !session.remote && live && <a className="btn btn-ghost btn-sm" href={session.viewer} target="_blank" rel="noreferrer">Watch screen <Icon name="external" size={12} /></a>}
          {live && <button className="btn btn-deny btn-sm" disabled={busy} onClick={async () => (await askConfirm("Stop this run now?", { action: "Stop run", danger: true, icon: "stop" })) && run(() => api(`/runs/${r.id}/stop`, {}), "Stopping")}>Stop</button>}
        </span>
      </div>
      {!r.reasoningVisible && <p className="notice small">This agent's reasoning isn't visible; only its actions are.</p>}
      {(r.fileChanges ?? []).length > 0 && <RunFiles ctx={ctx} r={r} live={live} />}
      {steps.length === 0 && <p className="muted small pad">{live ? <span className="shimmer">Starting…</span> : "Nothing recorded."}</p>}
      <ol className="steps">
        {steps.map((st, i) => (
          <li key={i} className={`step ${st.kind}`}>
            <span className="step-time mono">{new Date(st.at).toLocaleTimeString()}</span>
            {st.kind === "model" && (
              <div className="step-body">
                <div className="step-title">{st.exchange.model || "Model"} <span className="muted">· {st.exchange.provider}</span></div>
                {st.exchange.asked && <details><summary className="muted small">Asked</summary><pre className="snippet">{st.exchange.asked}</pre></details>}
                {st.exchange.thinking && <details><summary className="muted small">Reasoning</summary><pre className="snippet">{st.exchange.thinking}</pre></details>}
                {st.exchange.said && <p className="step-said">{st.exchange.said}</p>}
                {st.exchange.toolCalls.map((t, k) => <div key={k} className="tool-call mono small">→ {t.name} {t.input.length > 2 ? t.input : ""}</div>)}
              </div>
            )}
            {st.kind === "raw-model" && <div className="step-body"><div className="step-title">Model call · {st.provider}</div><p className="muted small">Not decoded ({st.status}).</p></div>}
            {st.kind === "action" && (() => {
              const now = st.now === "allowed" || st.now === "executed" ? "approved" : st.now === "denied" || st.now === "expired" ? st.now : st.outcome;
              return (
                <div className="step-body">
                  <div className="step-title">
                    <Badge v={now === "denied" || now === "expired" ? "deny" : now === "waiting" ? "approval" : "allow"}>{now === "waiting" ? "waiting" : now === "approved" ? "approved" : now}</Badge>
                    <span className="mono small">{st.summary}</span>
                  </div>
                  {st.reason && now !== "allowed" && <p className="muted small">{st.reason}</p>}
                  {now === "waiting" && st.proposalId && (
                    <div className="row-form">
                      <button className="btn btn-deny btn-sm" disabled={busy} onClick={() => decide(st.proposalId!, false)}>Deny</button>
                      <button className="btn btn-approve btn-sm" disabled={busy} onClick={() => decide(st.proposalId!, true)}><Icon name="pen" size={14} /> Approve</button>
                    </div>
                  )}
                </div>
              );
            })()}
            {st.kind === "note" && <div className="step-body"><div className="step-title muted small">The agent's own notes</div><pre className="snippet note">{st.text}</pre></div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** What a run changed in writable folders, as diffs, with Undo for the run or one file. */
function RunFiles({ ctx, r, live }: { ctx: Ctx; r: RunDetail; live: boolean }) {
  const { run, busy } = ctx;
  const files = r.fileChanges ?? [];
  const left = files.filter((f) => !f.undoneAt).length;
  const KIND = { added: "added", modified: "changed", deleted: "deleted" } as const;
  const undo = async (f?: RunFileChange) => {
    const what = f ? `Put ${f.path} back the way it was before this run?` : `Put all ${left} file${left === 1 ? "" : "s"} back the way they were before this run?`;
    if (!(await askConfirm(`${what} Files the run added are removed.`, { action: f ? "Undo this change" : "Undo this run", danger: true }))) return;
    run(() => api(`/runs/${r.id}/undo`, f ? { mount: f.mount, path: f.path } : {}), f ? `Undid ${f.path}` : "Undid this run's file changes");
  };
  return (
    <div className="run-files">
      <div className="run-files-hd">
        <span className="field-label">Files changed · {files.length}{left < files.length ? ` · ${files.length - left} undone` : ""}</span>
        {left > 0 && <button className="btn btn-deny btn-sm" disabled={busy || live} title={live ? "Stop the run first" : undefined} onClick={() => undo()}>Undo this run</button>}
      </div>
      {files.map((f) => (
        <details key={`${f.mount}/${f.path}`} className={`run-file ${f.undoneAt ? "undone" : ""}`}>
          <summary>
            <span className={`file-kind ${f.kind}`}>{KIND[f.kind]}</span>
            <span className="mono small grow" title={f.mount}>{f.path}</span>
            {f.undoneAt ? <span className="muted small">undone</span> : (
              <button className="link-btn small" disabled={busy || live} onClick={(e) => { e.preventDefault(); undo(f); }}>Undo this change</button>
            )}
          </summary>
          {f.binary ? <p className="muted small">Binary file; no diff shown.</p> : f.diff ? (
            <pre className="snippet diff">{f.diff.split("\n").map((l, i) => <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : ""}>{l || " "}</span>)}</pre>
          ) : <p className="muted small">No diff kept.</p>}
        </details>
      ))}
    </div>
  );
}

// ============================================================== connectors (chat apps' tools, through Karuna)

/** The team's connectors: other MCP servers whose tools chat apps reach only through Karuna. */
function Connectors({ ctx }: { ctx: Ctx }) {
  const { s, busy, run } = ctx;
  const list = s.connectors ?? [];
  const [form, setForm] = useState({ name: "", url: "", key: "" });
  const name = form.name.trim().toLowerCase();
  const ok = /^[a-z0-9-]{2,24}$/.test(name) && /^https:\/\/\S+$/.test(form.url.trim());
  const rule = (n: string) => s.policy!.rules.find((r) => r.active && r.scope === `connector:${n}`);
  return (
    <div className="card">
      <div className="hd"><h2>Connectors</h2><span className="sub">chat apps reach these tools only through Karuna</span></div>
      <form className="inline-form" onSubmit={(e) => {
        e.preventDefault();
        (form.key.trim() ? run(() => api("/keys", { name, envVar: connectorEnv(name), value: form.key.trim() }), `Sign-in key saved for ${name}`) : Promise.resolve(true))
          .then((ok) => ok && ctx.change({ op: "AddRule", id: `conn-${name}`.slice(0, 31), outcome: "Allow", scope: `connector:${name}`, target: form.url.trim() }))
          .then((done) => done && setForm({ name: "", url: "", key: "" }));
      }}>
        <label className="field"><span>Name</span><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. github" /></label>
        <label className="field grow"><span>Address (MCP, https)</span><input required className="mono" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://api.example.com/mcp" /></label>
        <label className="field"><span>Sign-in key (optional)</span><input type="password" autoComplete="off" className="mono" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="if it needs one" /></label>
        <button className="btn btn-dark" type="submit" disabled={busy || !ok}><Icon name="plus" /> Propose connector</button>
      </form>
      {list.map((c) => (
        <div className="resolved connector" key={c.name}>
          <div className="res">
            {c.error ? <Badge v="deny">unreachable</Badge> : <span className="intro-mark"><Icon name="plug" size={15} /></span>}
            <span className="small"><b>{c.name}</b> <span className="mono muted">{c.url}</span>{c.error && <span className="muted"> · {c.error}</span>}{!c.hasKey && <> · <ConnectorKey name={c.name} ctx={ctx} /></>}</span>
            {rule(c.name) ? <button className="btn btn-ghost btn-sm" disabled={busy} onClick={async () => (await askConfirm(`Remove the ${c.name} connector? Chat apps lose its tools.`, { action: "Remove connector", danger: true, icon: "plug" })) && ctx.change({ op: "RemoveRule", id: rule(c.name)!.id })}>Remove</button> : <span />}
          </div>
          {c.tools.map((t) => (
            <div className="res tool-row" key={t.key}>
              {t.changed ? <Badge v="deny">changed</Badge> : <Badge v="allow">approved</Badge>}
              <span className="small"><b className="mono">{t.name}</b> <span className="muted untrusted-text">{(t.changed?.description ?? t.description).slice(0, 220)}</span></span>
              {t.changed
                ? <button className="btn btn-ghost btn-sm" disabled={busy} title="Its description, inputs or hints changed since your team approved this connector" onClick={async () => (await askConfirm(`Accept the new definition of ${t.name}?\n\nBefore: ${t.description}\n\nNow: ${t.changed!.description}`, { action: "Accept change", icon: "plug" })) && run(() => api(`/connectors/tools/${encodeURIComponent(t.key)}/accept`, {}), "Change accepted")}>Review change</button>
                : <span />}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ============================================================== trust levels (Dharma v3)

const LEVEL_NAMES = ["Restricted", "Limited", "Standard", "Extended"];
const levelText = (n: number) => `Level ${n} · ${LEVEL_NAMES[n] ?? ""}`;
const hasLevels = (s: Snapshot) => (s.policy?.version ?? 0) >= 3 && !!s.policy?.levelLimits;

/** An agent card's level, record and next step. */
function AgentLevel({ a, ctx }: { a: AgentView; ctx: Ctx }) {
  const { s, busy } = ctx;
  if (a.level === null || a.level === undefined) return null;
  const level = a.level;
  const rec = a.record;
  const e = a.eligibility;
  const pending = s.policy!.proposals.some((g) => (g.status === "open" || g.status === "queued") && g.change.op === "SetLevel" && g.change.agent === a.id);
  const lower = async () =>
    (await askConfirm(`Lower ${a.name} to ${levelText(level - 1)} now? This applies immediately. Raising it again needs a clean record and a vote.`, { action: `Lower to Level ${level - 1}`, danger: true })) &&
    ctx.change({ op: "SetLevel", agent: a.id, level: level - 1, reason: "member" });
  return (
    <div className="agent-level">
      <div className="level-row">
        <span className="tag level-tag" title="What this agent may do without asking">{levelText(level)}</span>
        <span className="muted small tnum">
          {rec ? `${rec.completed} completed · ${rec.denied} denied${rec.drillsFailed ? ` · ${rec.drillsFailed} failed Drill${rec.drillsFailed > 1 ? "s" : ""}` : ""}${rec.tripwires ? ` · ${rec.tripwires} Tripwire${rec.tripwires > 1 ? "s" : ""}` : ""}` : "Record not loaded yet"}
        </span>
      </div>
      {e && e.target !== null && (
        e.eligible ? (
          <div className="level-row">
            <span className="small"><b>Eligible for Level {e.target}</b></span>
            <button className="btn btn-ghost btn-sm" disabled={busy || pending} onClick={() => ctx.change({ op: "SetLevel", agent: a.id, level: e.target!, reason: "vote" })}>
              {pending ? "Proposal open" : `Propose Level ${e.target}`}
            </button>
          </div>
        ) : (
          <div className="meter level-meter" title="Completed actions since its last level change, failed Drill or Tripwire">
            <div className="row"><span>toward Level {e.target}</span><span><b>{e.have}</b> / {e.needed} clean actions</span></div>
            <div className="track"><div className="fill" style={{ width: `${Math.min(100, (e.have / Math.max(1, e.needed)) * 100)}%` }} /></div>
          </div>
        )
      )}
      {level > 0 && <button className="btn btn-ghost btn-sm level-lower" disabled={busy} onClick={lower}>Lower to Level {level - 1}</button>}
    </div>
  );
}

/** How a Drill resolved, in a few words. */
const PREFLIGHT_RESOLUTION: Record<string, string> = {
  ignored: "didn't act on it",
  reported: "flagged it as suspicious",
  "blocked by its fix": "tried again; its fix blocked it",
  "acted on it": "acted on it",
};

/**
 * Pre-flight on the agent card: three Drills sent when the agent first activated. "Testing… 1 of 3"
 * while they wait, then each result; a failed one shows its fix (Apply fix) and the check can be run again.
 */
function Preflight({ a, ctx }: { a: AgentView; ctx: Ctx }) {
  const { run, busy } = ctx;
  const pf = a.preflight;
  const may = ctx.can("agents");
  const again = () => run(() => api(`/agents/${a.id}/preflight`, {}), "Pre-flight started: three Drills are in its inbox");
  if (!pf) {
    return may ? (
      <div className="preflight">
        <div className="preflight-head"><span className="muted small">No pre-flight yet</span><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={again}>Run pre-flight</button></div>
      </div>
    ) : null;
  }
  return (
    <div className={`preflight ${pf.status}`}>
      <div className="preflight-head">
        {pf.status === "running" ? (
          <span className="preflight-title"><span className="spinner" aria-hidden /> Pre-flight: Testing… {pf.done} of {pf.total}</span>
        ) : (
          <span className="preflight-title"><Icon name={pf.status === "passed" ? "check" : "alert"} size={14} /> Pre-flight {pf.status === "passed" ? "passed" : "failed"}</span>
        )}
        {pf.status !== "running" && may && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={again}>Run again</button>}
      </div>
      <ul className="preflight-list">
        {pf.results.map((r) => (
          <li key={r.testId} className={r.passed === null ? "wait" : r.passed ? "ok" : "bad"}>
            <span className="preflight-mark" aria-hidden>{r.passed === null ? <span className="dot" /> : <Icon name={r.passed ? "check" : "x"} size={12} />}</span>
            <span className="preflight-text">
              <span>{r.label}</span>
              <small>{r.passed === null ? "waiting" : PREFLIGHT_RESOLUTION[r.resolution ?? ""] ?? r.resolution}</small>
              {r.fix && (
                <span className="preflight-fix">
                  <span>{r.fix.summary}{r.fix.drafted && <span className="tag" style={{ marginLeft: 6 }}>drafted from its job</span>}</span>
                  {r.fix.applied
                    ? <span className="tag"><Icon name="check" size={11} /> fix in place</span>
                    : may && <button type="button" className="btn btn-dark btn-sm" disabled={busy} onClick={() => run(() => api(`/agents/${a.id}/preflight/fix`, { testId: r.testId }), "Fix applied")}>Apply fix</button>}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** New agent card (the Trust levels button): what each level may do without asking, and its
 *  payment limits (changed by vote). A popup over a lightly dimmed page; a click outside or Esc closes it. */
function LevelsCard({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const { s, busy } = ctx;
  const pol = s.policy!;
  const limits = pol.levelLimits!;
  const grants = pol.levelGrants ?? [];
  const streak = pol.levelUpStreak ?? [0, 10, 25, 50];
  const [edit, setEdit] = useState<{ level: number; per: string; daily: string; none: boolean } | null>(null);
  const top = limits.length - 1;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Rendered on <body>: an animated page section would otherwise shift a fixed overlay off the window's edges.
  return createPortal(
    <div className="info-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="card info-pop" role="dialog" aria-modal="true" aria-label="Trust levels">
      <div className="hd">
        <h2>Trust levels</h2>
        <button type="button" className="dismiss-x" aria-label="Close" onClick={onClose}><Icon name="x" size={15} /></button>
      </div>
      <div className="levels">
        {limits.map((l, n) => {
          const adds = grants.filter((g) => g.min === n).map((g) => g.what);
          const editing = edit?.level === n;
          return (
            <div className="level-line" key={n}>
              <span className="level-name"><b>{levelText(n)}</b><small>{n === 0 ? "Every new agent" : `${streak[n]} clean actions, then a vote`}</small></span>
              {editing ? (
                <form className="level-edit" onSubmit={(e) => {
                  e.preventDefault();
                  const [per, daily] = edit.none ? [NO_LIMIT_USD, NO_LIMIT_USD] : [Number(edit.per), Number(edit.daily)];
                  ctx.change({ op: "SetLevelLimits", level: n, perPaymentUsd: per, dailyUsd: daily }).then((ok) => ok && setEdit(null));
                }}>
                  {!edit.none && <>
                    <span className="prefix limit-input"><span>$</span><input aria-label="Per payment" type="number" min="0" step="0.01" value={edit.per} onChange={(e) => setEdit({ ...edit, per: e.target.value })} placeholder="0.00" /><em>/ payment</em></span>
                    <span className="prefix limit-input"><span>$</span><input aria-label="Per day" type="number" min="0" step="0.01" value={edit.daily} onChange={(e) => setEdit({ ...edit, daily: e.target.value })} placeholder="0.00" /><em>/ day</em></span>
                  </>}
                  {n === top && <label className="check"><input type="checkbox" checked={edit.none} onChange={(e) => setEdit({ ...edit, none: e.target.checked })} /> <span>No limit</span></label>}
                  <button className="btn btn-ghost btn-sm" disabled={busy || (!edit.none && Number(edit.per) > Number(edit.daily))}>Propose</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEdit(null)}>Cancel</button>
                </form>
              ) : (
                <button className="tag link tnum" title="Propose new payment limits for this level" onClick={() => {
                  const none = isNoLimit(l.perPaymentUsd) && isNoLimit(l.dailyUsd);
                  setEdit({ level: n, per: none ? "" : l.perPaymentUsd.toFixed(2), daily: none ? "" : l.dailyUsd.toFixed(2), none });
                }}>
                  {isNoLimit(l.perPaymentUsd) && isNoLimit(l.dailyUsd) ? "No payment limit" : `${usd(l.perPaymentUsd)} per payment · ${usd(l.dailyUsd)} per day`} <Icon name="pen" size={11} />
                </button>
              )}
              <span className="level-adds small">{adds.length ? `Level ${n - 1} + ${adds.map((w) => (/^[A-Z]{2}/.test(w) ? w : w.charAt(0).toLowerCase() + w.slice(1))).join(", ")}` : n === 0 ? "Payments within the limits only" : ""}</span>
            </div>
          );
        })}
      </div>
    </div>
    </div>,
    document.body,
  );
}

/** Votes page: move an older org to the Dharma code this Karuna ships (a core change). */
const DHARMA_LATEST = 6;
/** What each Dharma version adds, for the upgrade card. */
const DHARMA_ADDS: Record<number, string> = {
  3: "trust levels, and each agent's record published onchain",
  4: "team roles: what each member may do",
  5: "safer votes: a vote can no longer undo a later automatic block, removing a member needs everyone else, and votes left open when the team changes start over",
  6: "room for new features: the rulebook's code now spans two contracts, with no change to how it works",
};
function UpgradeCard({ ctx }: { ctx: Ctx }) {
  const { s, busy, run, me } = ctx;
  const pol = s.policy!;
  if (pol.version >= DHARMA_LATEST) return null;
  const open = pol.proposals.find((g) => (g.status === "open" || g.status === "queued") && g.change.op === "Upgrade");
  const propose = () =>
    run(async () => {
      const code = await api<{ implementation: string; version: number }>("/dharma/code", {});
      await submitChange(me, s.org.dharma!.address as Address, { kind: Kind.Propose, change: { op: "Upgrade", implementation: code.implementation as Address } });
    }, `Upgrade proposed: needs every member's signature, then ${waitText(pol.coreTimelock)}`);
  return (
    <div className="card upgrade-card rise">
      <div className="hd"><h2>Dharma v{pol.version} → v{DHARMA_LATEST}</h2>{open && <span className="sub">proposal #{open.id}</span>}</div>
      <div className="pad stack-sm">
        <p>
          Adds {Array.from({ length: DHARMA_LATEST - pol.version }, (_, i) => DHARMA_ADDS[pol.version + 1 + i]).filter(Boolean).join("; ")}. The address stays the same, and members, agents, payees and rules carry over.
        </p>
        <p className="muted small">An upgrade is a core change: every member signs, then it waits {waitText(pol.coreTimelock)}. Any freeze cancels it.</p>
        {!open && <button className="btn btn-dark" disabled={busy} onClick={propose}><Icon name="pen" size={14} /> Propose upgrade to v{DHARMA_LATEST}</button>}
      </div>
    </div>
  );
}

/** Tripwire page: every USDC transfer out of the wallet, checked against Karuna's own payments. */
function WatchdogCard({ ctx }: { ctx: Ctx }) {
  const { s } = ctx;
  const w = s.watchdog;
  if (!w) return null;
  const VERDICT: Record<string, { v: "allow" | "deny" | "approval"; text: string }> = {
    matched: { v: "allow", text: "Karuna payment" },
    "gateway-deposit": { v: "approval", text: "Gateway deposit" },
    unapproved: { v: "deny", text: "Not approved" },
  };
  return (
    <div className="card">
      <div className="hd"><h2>Wallet watchdog</h2><span className="sub">{watchdogSource(w.events[0]?.source)}</span></div>
      <div className="pad stack-sm">
        <p className="muted">Every USDC transfer out of {w.wallet ? <span className="mono">{short(w.wallet)}</span> : "the wallet"} must match a payment Karuna made. Anything else freezes every agent and is recorded on Dharma.</p>
      </div>
      {w.events.length === 0 ? (
        <Empty icon="swarm">No transfers out of the wallet yet.</Empty>
      ) : (
        <div className="resolved">
          {w.events.map((e) => (
            <div className="res" key={e.key}>
              <Badge v={VERDICT[e.verdict].v}>{VERDICT[e.verdict].text}</Badge>
              <span className="small tnum">{usd(e.amountUsd)} to <span className="mono">{short(e.to)}</span></span>
              <span className="muted small"><TxLink tx={e.txHash} s={s} /> · {ago(e.at)}</span>
            </div>
          ))}
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
      <div className="hd"><h2>Running in a sandbox</h2><span className="sub settings-line">{sb.sessions.length} live{(s.settings.gvisorAvailable || s.settings.values.requireGvisor === 1) && <> · Require gVisor: <SettingValue ctx={ctx} name="requireGvisor" /></>}</span></div>
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
