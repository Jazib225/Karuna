// The Gatekeeper (CLAUDE.md §1 "02 Decide", §2).
//  - Agents can only PROPOSE. They get back allowed / pending / denied / done — never a reason.
//  - Karuna computes the facts itself (price, seller, recipient) instead of trusting the agent.
//  - The org's POLICY lives in Dharma onchain. The Gatekeeper reads it, and relays members'
//    signed actions to it; it cannot loosen anything on its own (Dharma refuses).
//  - Every decision and event goes to the signed log, which is anchored on Dharma.
//  - Only this process can move money, and only the exact payload a human approved.
import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { keccak256, stringToHex, verifyTypedData, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  SignedLog, buildContext, buildRuleset, evaluate, httpTargetMatches, matchCustomRules,
  type Decision, type LogEntry, type LogEvent, type Request,
} from "@prekaruna/engine";
import {
  DHARMA_ABI, Kind, actionTypedData, decodeChange, describeChange, encodeChange, opName, paymentDecisionTypedData, toBytes32, toMicro,
  type Change,
} from "@prekaruna/dharma";
import {
  ConfigError, DEFAULT_ALLOWLISTED_DOMAINS, EXPLORER, USDC_TOKEN, WALLET_CHAIN, emptyOrg, isSetUp,
  requireAddress, requireText, slugId, type OrgFile,
} from "./config.ts";
import { readFingerprint, readPolicy, scrub, ChainError, type ChainWriter, type OnchainPolicy, type WriteFn } from "./chain.ts";
import { payloadHash, shortHash, type PaymentPayload } from "./payload.ts";
import type { Store } from "./store.ts";
import type { WalletBackend } from "./wallet.ts";
import {
  TEMPLATES, assertShieldSafe, autoRule, isAutoRule, makeTest, tracesTo,
  type InboxMessage, type ShieldTest, type TestTemplate,
} from "./shield.ts";
import { band, bandLabel, learnedDenyRule, previewLoosening, suggestions, LOOSENING_OPS, type PastRequest, type Precedent, type Preview } from "./learn.ts";
import { PivotTracker, findCredential, findTrap, mintTraps, targetOf, trapEnvFile, trapLeakMessage, type TrapSet } from "./swarm.ts";
import { SecretStore } from "./secrets.ts";
import { DRAFT_KEYS, NoDrafterError, draftRules, freshIds, type DraftResult } from "./draft.ts";

// ---------------------------------------------------------------- types

/** What an agent may submit. Everything else about the action is computed by Karuna. */
export type AgentAction =
  | { type: "x402"; url: string; method?: string; body?: unknown; maxUsd?: number; sourceMessageId?: string }
  | { type: "transfer"; to: string; amountUsd: number; payeeName?: string; sourceMessageId?: string }
  | { type: "message"; to: string; body: string } // to another agent — there is no other channel
  | {
      type: "action";
      tool: "shell" | "file" | "http" | "message";
      command?: string;
      path?: string;
      fileOp?: "read" | "write";
      method?: string;
      url?: string;
      body?: string;
    };

export type ProposalStatus = "pending" | "executing" | "executed" | "allowed" | "denied" | "failed";

export interface Fact {
  label: string;
  value: string;
  tone?: "warn" | "ok";
}

export interface Proposal {
  id: string;
  agentId: string;
  createdAt: string;
  action: AgentAction; // as submitted (untrusted)
  reason?: string; // agent's justification (untrusted, shown boxed)
  request: Request; // what the engine evaluated (built by Karuna)
  decision: Decision;
  facts: Fact[]; // Karuna-verified facts for the approval card
  payload?: PaymentPayload;
  payloadHash?: string;
  status: ProposalStatus;
  approvals: { memberId: string; at: string }[]; // memberId = signing address
  resolvedBy?: string;
  resolvedAt?: string;
  result?: unknown; // returned to the agent on success
  txRef?: string;
  error?: string; // human-facing only
}

/** The only shape an agent ever sees. No reasons, ever (CLAUDE.md §2 rule 7). */
export interface AgentResponse {
  id: string;
  status: "done" | "allowed" | "pending" | "denied" | "failed";
  result?: unknown;
}

/** A member's signed Dharma action, as posted by the console. */
export interface SignedAction {
  kind: number; // Kind.Tighten | Propose | Vote
  op: number;
  data: Hex;
  proposalId?: number;
  support?: boolean;
  signer: Address;
  deadline: number | string;
  signature: Hex;
  label?: string; // private name for a new member / agent / payee (stored locally, never onchain)
}

/** A member's signed approve/deny of one payment. Verified here; never sent onchain. */
export interface SignedDecision {
  approve: boolean;
  payloadHash: Hex;
  signer: Address;
  deadline: number | string;
  signature: Hex;
}

interface State {
  drafts?: Record<string, DraftResult & { at: string }>; // plain-English drafts that worked, by sentence + org
  proposals: Proposal[];
  spend: Record<string, Record<string, number>>; // day -> agent -> usd
  localFreeze: { at: string; by: string } | null; // panic applied before the chain confirmed it
  lastFreeze?: { at: string; by: string } | null; // who froze, once the chain confirmed it
  inbox: InboxMessage[]; // every agent's inbox: real mail and Auto-Shield tests, same shape
  tests: ShieldTest[]; // which messages were tests (never visible to agents)
  alerts: ShieldAlert[]; // for humans: failed tests, changed bank accounts, flagged messages
  traps: TrapSet[]; // fake credentials planted in agents' sandboxes
  tainted: Record<string, { at: string; secret: string }>; // agents that touched a trap
  swarmTrips: { id: string; at: string; reason: string; agents: string[]; txRef?: string }[];
  precedents: Precedent[]; // every human approve / deny on a payment (Learns From Your Choices)
  paused?: { at: string; by: string } | null; // local pause: instant on/off, never onchain (unlike Freeze)
}

export interface ShieldAlert {
  id: string;
  kind: "shield-failed" | "shield-passed" | "changed-bank-account" | "agent-reported" | "trap-touched" | "swarm-stopped";
  agentId: string;
  title: string;
  body: string;
  at: string;
}

const emptyState = (): State => ({ proposals: [], spend: {}, localFreeze: null, inbox: [], tests: [], alerts: [], traps: [], tainted: {}, swarmTrips: [], precedents: [] });

export class GatekeeperError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

class ExactMatchError extends Error {}

export interface GatekeeperDeps {
  store: Store;
  wallet: WalletBackend; // pays for services and transfers
  client: PublicClient; // reads Dharma
  writerFor: (walletAddress: Address) => ChainWriter; // writes Dharma (the org's wallet)
  now?: () => Date;
  timelockSeconds?: number; // for new Dharma deployments: the normal wait
  coreTimelockSeconds?: number; // …and the wait for core changes (default 24 h)
  anchorEvery?: number; // anchor the log after this many new entries…
  anchorMaxAgeMs?: number; // …or when unanchored entries are this old
  shieldTestsPerDay?: number; // Auto-Shield: random tests per active agent per day (0 = off)
  shieldWindowMs?: number; // a test nobody acted on within this window counts as passed
  swarmAgents?: number; // Swarm Stopper: this many agents on one new target…
  swarmWindowMs?: number; // …within this window freezes everyone
  secrets?: SecretStore; // the org's API keys; only the egress proxy ever sees values
  requireSandbox?: boolean; // agent tokens only work from inside a Karuna sandbox (unless voted otherwise)
  requireIsolation?: "gvisor" | "docker"; // refuse runs weaker than this
}

/** One `karuna run`: an agent in a box, reachable only through the egress proxy. */
export interface SandboxSession {
  id: string;
  token: string; // what the box holds instead of the agent's kag_ token
  agentId: string;
  startedAt: string;
  lastSeen: number;
  host: string | null; // machine the runner reported
  isolation: "gvisor" | "docker"; // what the runner reported it used
  desktop: boolean; // has a virtual screen (computer-use agent)
  remote: boolean; // runner is on another machine (S6)
  viewer: string | null; // desktop viewer URL, on the runner's machine only
  requests: number;
  denied: number;
  lastRequest: string | null;
  stopRequested: boolean;
}

/** One HTTP(S) request leaving a box, as the proxy saw it. */
export interface EgressRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

export type EgressVerdict =
  | { verdict: "allow"; keys: string[] }
  | { verdict: "pending"; proposalId: string }
  | { verdict: "deny"; proposalId?: string };

const SESSION_IDLE_MS = 45_000;
const GRANT_MS = 10 * 60_000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : n.toFixed(2)}`;
const lower = (a: string) => a.toLowerCase();
/** Seconds past a timelock before the Gatekeeper executes (the wallet provider's node can trail our RPC). */
const EXECUTE_MARGIN_S = 3;
const MAX_PROPOSALS_KEPT = 5000;
const KIND_NAMES = ["tighten", "propose", "vote"] as const;

// ---------------------------------------------------------------- gatekeeper

export class Gatekeeper extends EventEmitter {
  org: OrgFile;
  private state: State;
  readonly log: SignedLog;
  policy: OnchainPolicy | null = null;
  deploying = false;
  /** When the relay last reported a Dharma event (QuickNode Stream or its RPC fallback). */
  lastChainEventAt = 0;
  private pivots = new PivotTracker();
  private executing = new Set<string>();
  private writes: Promise<unknown> = Promise.resolve();
  /** Background jobs (a write plus its follow-ups) that idle() must also wait for. */
  private tasks = new Set<Promise<unknown>>();
  private executeTried = new Map<number, number>();
  private lastAnchorTry = 0;
  private lastSyncKey = "";
  private lastFingerprint = "";
  private lastFullRead = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;
  /** Live sandbox runs, by session token. In memory: a Gatekeeper restart ends every run. */
  private sessions = new Map<string, SandboxSession>();
  /** The remote port for boxes on other machines, when enabled (S6). */
  remote: { port: number; host: string; names: string[] } | null = null;
  /** One-time passes for HTTP requests a member approved: request hash -> expiry. */
  private grants = new Map<string, number>();

  constructor(private readonly deps: GatekeeperDeps) {
    super();
    this.now = deps.now ?? (() => new Date());
    const stored = deps.store.readJson<{ version?: number }>("org.json", emptyOrg);
    if (stored.version !== 2) {
      // Phase 2 kept policy locally; Dharma replaces it. Start a fresh org (old file is kept).
      if (stored.version) deps.store.writeJson(`org.v${stored.version}.backup.json`, stored);
      this.org = emptyOrg();
      this.state = emptyState();
    } else {
      this.org = stored as OrgFile;
      this.state = { ...emptyState(), ...deps.store.readJson("state.json", emptyState) };
    }
    this.log = SignedLog.restore(deps.store.readLog(), deps.store.loadOrCreateLogKeys());
  }

  /** Load the onchain policy, then keep it fresh and run governance housekeeping. */
  async start(intervalMs = 4000) {
    await this.sync().catch((e) => console.error("dharma sync:", scrub(e)));
    this.timer = setInterval(() => void this.housekeeping().catch((e) => console.error("gatekeeper:", scrub(e))), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------ persistence helpers

  private save() {
    if (this.state.proposals.length > MAX_PROPOSALS_KEPT) this.state.proposals = this.state.proposals.slice(-MAX_PROPOSALS_KEPT);
    this.deps.store.writeJson("org.json", this.org);
    this.deps.store.writeJson("state.json", this.state);
    this.emit("change");
  }

  private logDecision(request: Request, decision: Decision): LogEntry {
    const e = this.log.append(request, decision, this.now());
    this.deps.store.appendLog(e);
    return e;
  }

  private logEvent(event: LogEvent): LogEntry {
    const e = this.log.appendEvent(event, this.now());
    this.deps.store.appendLog(e);
    return e;
  }

  private today() {
    return this.now().toISOString().slice(0, 10);
  }

  spentToday(): Record<string, number> {
    return { ...(this.state.spend[this.today()] ?? {}) };
  }

  private addSpend(agentId: string, amount: number) {
    const day = (this.state.spend[this.today()] ??= {});
    day[agentId] = Math.round(((day[agentId] ?? 0) + amount) * 1e6) / 1e6;
  }

  // ------------------------------------------------ Dharma plumbing

  private requireReady(): OnchainPolicy {
    if (!isSetUp(this.org)) throw new GatekeeperError("Finish setup in the console first", 409);
    if (!this.policy) throw new GatekeeperError("Dharma policy not loaded yet — is the chain reachable?", 503);
    return this.policy;
  }

  private dharmaAddress(): Address {
    return this.org.dharma!.address as Address;
  }

  private writer(): ChainWriter {
    return this.deps.writerFor(this.org.wallet!.address as Address);
  }

  /** Resolves once every queued chain write has finished (used for clean shutdown and tests). */
  async idle() {
    for (;;) {
      const w = this.writes;
      await Promise.all([w, ...this.tasks]);
      if (w === this.writes && this.tasks.size === 0) return;
    }
  }

  /** Run a job in the background, tracked so idle() waits for all of it. */
  private background(job: Promise<unknown>) {
    const t = job.catch(() => undefined).finally(() => this.tasks.delete(t));
    this.tasks.add(t);
  }

  /** One chain write at a time (nonces, ordering, readable failures). */
  private send(fn: WriteFn, args: readonly unknown[]): Promise<{ txRef: string }> {
    const run = this.writes.then(() => this.writer().write(this.dharmaAddress(), fn, args));
    this.writes = run.catch(() => undefined);
    return run;
  }

  /**
   * Refresh the onchain policy. Cheap by default: one fingerprint read, and the full policy only
   * when it changed, when proposals are live (votes, timelocks), or every 30s regardless.
   */
  async sync(force = false) {
    if (!this.org.dharma) return;
    if (!force && this.policy) {
      const fp = await readFingerprint(this.deps.client, this.dharmaAddress());
      const live = this.policy.proposals.some((x) => x.status === "open" || x.status === "queued");
      if (fp === this.lastFingerprint && !live && Date.now() - this.lastFullRead < 30_000) return;
    }
    const p = await readPolicy(this.deps.client, this.dharmaAddress());
    this.lastFullRead = Date.now();
    this.lastFingerprint = `${p.policyVersion}:${p.proposals.length ? Math.max(...p.proposals.map((x) => x.id)) + 1 : 0}:${p.frozen}:${p.logLength}`;
    this.policy = p;
    let dirty = false;
    // A panic applied locally is handed over to the chain once Dharma confirms the freeze.
    if (p.frozen && this.state.localFreeze) {
      this.state.lastFreeze = this.state.localFreeze;
      this.state.localFreeze = null;
      dirty = true;
    }
    // Access requests are done once the address is a member.
    const members = new Set(p.members.map(lower));
    const before = this.org.enrollments.length;
    this.org.enrollments = this.org.enrollments.filter((e) => !members.has(e.address));
    if (this.org.enrollments.length !== before) dirty = true;
    const key = `${p.policyVersion}:${p.frozen}:${p.logLength}:${p.proposals.map((x) => `${x.id}${x.status}${x.yes}${x.no}`).join(",")}`;
    if (dirty) this.save();
    else if (key !== this.lastSyncKey) this.emit("change");
    this.lastSyncKey = key;
  }

  /** Refresh policy, execute proposals whose timelock passed, anchor the log when due. */
  async housekeeping() {
    await this.sync();
    await this.executeReady();
    await this.anchorIfDue();
    this.shieldHousekeeping();
  }

  /** Anyone may execute a passed proposal after its timelock; the Gatekeeper does it promptly. */
  private async executeReady() {
    const p = this.policy;
    if (!p) return;
    // Oldest first, a few seconds past the timelock: the wallet provider's node can trail the RPC
    // we read the chain clock from, and executing "too early" just burns a round-trip (NotReady).
    const ready = p.proposals.filter((x) => x.status === "queued" && x.eta !== null && x.eta + EXECUTE_MARGIN_S <= p.chainTime).sort((a, b) => a.eta! - b.eta!);
    for (const prop of ready) {
      const last = this.executeTried.get(prop.id) ?? 0;
      if (Date.now() - last < 30_000) continue;
      this.executeTried.set(prop.id, Date.now());
      try {
        const { txRef } = await this.send("execute", [BigInt(prop.id)]);
        this.logEvent({ type: "dharma-executed", proposalId: prop.id, change: prop.change ? describeChange(prop.change, this.labels()) : `op ${prop.op}`, txRef });
        await this.sync(true).catch(() => undefined);
        this.save();
      } catch (e) {
        this.logEvent({ type: "dharma-execute-failed", proposalId: prop.id, detail: scrub(e) });
        this.save();
        if (/NotReady/.test(String(e))) {
          // The chain isn't there yet: retry soon, and don't spend calls on later proposals now.
          this.executeTried.set(prop.id, Date.now() - 25_000);
          break;
        }
      }
    }
  }

  /** Anchor the signed log's head on Dharma, so history can't be rewound unnoticed. */
  private async anchorIfDue() {
    const p = this.policy;
    if (!p) return;
    const unanchored = this.log.length - p.logLength;
    if (unanchored <= 0) return;
    const every = this.deps.anchorEvery ?? 20;
    const maxAge = this.deps.anchorMaxAgeMs ?? 5 * 60_000;
    if (unanchored < every && Date.now() - this.lastAnchorTry < maxAge) return;
    this.lastAnchorTry = Date.now();
    await this.anchorNow();
  }

  /** Anchor immediately (also used by verification). Anchors are recorded onchain, not in the log. */
  async anchorNow() {
    this.requireReady();
    const head = `0x${this.log.head()}` as Hex;
    await this.send("anchorLog", [head, BigInt(this.log.length)]);
    await this.sync(true).catch(() => undefined);
  }

  private labels() {
    return {
      member: (a: string) => this.org.labels.members[lower(a)],
      agent: (id: string) => this.org.labels.agents[id],
      payee: (a: string) => this.org.labels.payees[lower(a)],
    };
  }

  isFrozen(): { by: string; at: string; confirmed: boolean } | null {
    if (this.policy?.frozen) return { by: this.state.lastFreeze?.by ?? "", at: this.state.lastFreeze?.at ?? "", confirmed: true };
    if (this.state.localFreeze) return { ...this.state.localFreeze, confirmed: false };
    return null;
  }

  private isMember(a: string) {
    return !!this.policy?.members.some((m) => lower(m) === lower(a));
  }

  // ================================================================ setup

  /** Deploy this org's Dharma, with the first member's browser key as its only member. */
  async setup(input: { orgName: unknown; memberName: unknown; memberAddress: unknown; walletAddress: unknown }) {
    if (isSetUp(this.org) || this.deploying) throw new GatekeeperError("Already set up", 409);
    const name = requireText(input.orgName, "Organization name");
    const memberName = requireText(input.memberName, "Your name", 40);
    const member = requireAddress(input.memberAddress, "Your signing key");
    const wallet = requireAddress(input.walletAddress, "Wallet address");
    this.deploying = true;
    this.emit("change");
    try {
      const timelock = this.deps.timelockSeconds ?? 60;
      const coreTimelock = this.deps.coreTimelockSeconds ?? 86_400;
      const d = await this.deps.writerFor(wallet as Address).deploy({
        firstMember: member as Address, timelockSeconds: timelock, coreTimelockSeconds: coreTimelock, thresholdMicro: toMicro(500), domains: DEFAULT_ALLOWLISTED_DOMAINS,
      });
      this.org.name = name;
      this.org.wallet = { address: wallet, chain: WALLET_CHAIN };
      this.org.dharma = { address: lower(d.address), chainId: await this.deps.client.getChainId(), deployedAt: this.now().toISOString(), txRef: d.txRef };
      this.org.labels.members[member] = memberName;
      this.logEvent({ type: "setup", dharma: lower(d.address), wallet, firstMember: member, timelockSeconds: timelock, coreTimelockSeconds: coreTimelock, implementation: lower(d.implementation), txRef: d.txRef });
      await this.sync(true).catch(() => undefined);
      return { dharma: this.org.dharma };
    } catch (e) {
      throw new GatekeeperError(`Could not deploy Dharma: ${scrub(e)}`, 502);
    } finally {
      this.deploying = false;
      this.save();
    }
  }

  renameOrg(name: unknown) {
    this.org.name = requireText(name, "Organization name");
    this.save();
  }

  // ================================================================ members' Dharma actions

  /** Verify a member's signed action, then relay it to Dharma (the Gatekeeper pays gas). */
  async submitAction(a: SignedAction) {
    const p = this.requireReady();
    const signer = requireAddress(a.signer, "signer") as Address;
    if (!this.isMember(signer)) throw new GatekeeperError("This key is not a Dharma member", 403);
    const deadline = BigInt(a.deadline);
    if (deadline < BigInt(Math.floor(this.now().getTime() / 1000))) throw new GatekeeperError("Signature expired", 400);
    if (![Kind.Tighten, Kind.Propose, Kind.Vote].includes(a.kind as 0 | 1 | 2)) throw new GatekeeperError("Unknown action kind");

    // Votes sign the proposal's own op + data, so the browser can't be tricked into voting on
    // something other than what it displayed.
    let op = a.op;
    let data = a.data;
    if (a.kind === Kind.Vote) {
      const prop = p.proposals.find((x) => x.id === a.proposalId);
      if (!prop) throw new GatekeeperError("Unknown Dharma proposal", 404);
      op = prop.op;
      data = prop.data;
    }
    let change: Change;
    try {
      change = decodeChange(op, data);
    } catch {
      throw new GatekeeperError("Malformed change");
    }
    // Every member edit goes to a vote, even one that tightens; only the panic button is instant.
    // (Dharma enforces this too: MembersMustPropose.) Automatic safety writes don't come through here.
    if (a.kind === Kind.Tighten && change.op !== "Freeze") {
      throw new GatekeeperError("Rule changes go to a vote: propose it instead. Only the panic button applies instantly.", 409);
    }

    const nonce = await this.deps.client.readContract({ address: this.dharmaAddress(), abi: DHARMA_ABI, functionName: "nonces", args: [signer] });
    const typed = actionTypedData(this.dharmaAddress(), p.chainId, {
      kind: a.kind, op, data, proposalId: BigInt(a.proposalId ?? 0), support: !!a.support, nonce, deadline,
    });
    const ok = await verifyTypedData({ address: signer, ...typed, signature: a.signature });
    if (!ok) throw new GatekeeperError("Signature does not match this action", 401);

    // Private labels for things a member is adding (names never go onchain).
    if (a.label && a.kind === Kind.Propose) {
      const label = requireText(a.label, "Name", 60);
      if (change.op === "AddMember") this.org.labels.members[lower(change.member)] = label;
      if (change.op === "SetAgent") this.org.labels.agents[change.id] = label;
      if (change.op === "SetPayee") this.org.labels.payees[lower(change.account)] = label;
    }

    // Panic: protect immediately, before the chain confirms.
    if (a.kind === Kind.Tighten && change.op === "Freeze" && !this.isFrozen()) {
      this.state.localFreeze = { at: this.now().toISOString(), by: lower(signer) };
      this.logEvent({ type: "freeze", by: lower(signer), stage: "local" });
      this.save();
    }

    const description = describeChange(change, this.labels());
    let res: { txRef: string };
    try {
      if (a.kind === Kind.Tighten) res = await this.send("tighten", [op, data, signer, deadline, a.signature]);
      else if (a.kind === Kind.Propose) res = await this.send("propose", [op, data, signer, deadline, a.signature]);
      else res = await this.send("vote", [BigInt(a.proposalId!), !!a.support, signer, deadline, a.signature]);
    } catch (e) {
      const msg = e instanceof ChainError ? e.message : `Chain write failed: ${scrub(e)}`;
      this.logEvent({ type: "dharma-rejected", action: KIND_NAMES[a.kind], change: description, by: lower(signer), detail: msg });
      this.save();
      throw new GatekeeperError(msg, e instanceof ChainError && e.reason ? 409 : 502);
    }
    // The transaction landed. From here on, read failures (e.g. RPC rate limits) must not make it
    // look like it didn't: report success, and let the background sync catch up.
    let proposalId = a.kind === Kind.Vote ? a.proposalId : undefined;
    if (a.kind === Kind.Propose) {
      try {
        const count = await this.deps.client.readContract({ address: this.dharmaAddress(), abi: DHARMA_ABI, functionName: "proposalCount" });
        proposalId = Number(count) - 1;
      } catch {
        proposalId = undefined;
      }
    }
    this.logEvent({
      type: "dharma", action: KIND_NAMES[a.kind], change: description, by: lower(signer), txRef: res.txRef,
      ...(proposalId !== undefined ? { proposalId } : {}), ...(a.kind === Kind.Vote ? { support: !!a.support } : {}),
    });
    await this.sync(true).catch(() => undefined);
    this.save();
    return { txRef: res.txRef, proposalId };
  }

  /** Plain English → draft rules for a member to review and propose (see draft.ts). Never proposes. */
  async draftRules(text: unknown) {
    const pol = this.requireReady();
    const policy = requireText(text, "Policy", 2000);
    const ctx = {
      agents: pol.agents.map((a) => ({ id: a.id, name: this.org.labels.agents[a.id] ?? a.id })),
      payees: pol.payees.map((p) => ({ address: lower(p.account), name: this.org.labels.payees[lower(p.account)] ?? p.account, category: p.category })),
      domains: pol.domains,
    };
    // A sentence that drafted before, for the same agents and payees, comes back instantly with no
    // model call: rehearse the demo sentence once and it can't fail on stage. New ids every time.
    const cacheKey = sha256(`${policy.trim().replace(/\s+/g, " ").toLowerCase()}\n${JSON.stringify(ctx)}`);
    const saved = this.state.drafts?.[cacheKey];
    if (saved) return { rules: freshIds(saved.rules), note: saved.note, skipped: saved.skipped, model: "saved", savedFrom: saved.model };
    // Keys marked for the drafter; a key literally named "groq"/"gemini" still works (older setups).
    const keys = Object.fromEntries(DRAFT_KEYS.map((k) => [k, this.deps.secrets?.drafterKey(k) ?? this.deps.secrets?.reveal(k) ?? null]));
    let out: DraftResult;
    try {
      out = await draftRules(policy, ctx, keys);
    } catch (e) {
      if (e instanceof NoDrafterError) throw new GatekeeperError(e.message, 503);
      throw new GatekeeperError(scrub(e), 502);
    }
    if (out.rules.length) {
      const drafts = { ...(this.state.drafts ?? {}), [cacheKey]: { ...out, at: this.now().toISOString() } };
      const keep = Object.entries(drafts).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 100);
      this.state.drafts = Object.fromEntries(keep);
      this.save();
    }
    return out;
  }

  nonceOf(address: string) {
    return this.deps.client.readContract({ address: this.dharmaAddress(), abi: DHARMA_ABI, functionName: "nonces", args: [requireAddress(address) as Address] });
  }

  /** Reserve an agent id and issue its token. The agent works once Dharma adds it (by vote). */
  prepareAgent(name: unknown) {
    this.requireReady();
    const label = requireText(name, "Agent name", 40);
    const taken = new Set([...this.policy!.agents.map((a) => a.id), ...Object.keys(this.org.agentTokens), ...Object.keys(this.org.labels.agents)]);
    const id = slugId(label, taken);
    const token = `kag_${randomBytes(24).toString("base64url")}`;
    this.org.agentTokens[id] = sha256(token);
    this.org.labels.agents[id] = label;
    this.logEvent({ type: "agent-token-issued", agent: id });
    this.save();
    return { id, token };
  }

  rotateAgentToken(id: string) {
    if (!this.org.agentTokens[id] && !this.policy?.agents.some((a) => a.id === id)) throw new GatekeeperError("Unknown agent", 404);
    const token = `kag_${randomBytes(24).toString("base64url")}`;
    this.org.agentTokens[id] = sha256(token);
    this.logEvent({ type: "agent-token-rotated", agent: id });
    this.save();
    return { token };
  }

  /** A browser that isn't a member yet asks to join; a member proposes adding it. */
  requestAccess(address: unknown, name: unknown) {
    this.requireReady();
    const a = requireAddress(address, "Signing key");
    if (this.isMember(a)) throw new GatekeeperError("Already a member", 409);
    const n = requireText(name, "Your name", 40);
    this.org.enrollments = [...this.org.enrollments.filter((e) => e.address !== a), { address: a, name: n, requestedAt: this.now().toISOString() }];
    this.org.labels.members[a] = n;
    this.logEvent({ type: "access-requested", address: a });
    this.save();
  }

  // ================================================================ agent side

  authenticateAgent(token: string | undefined): string | null {
    return this.authAgent(token)?.agentId ?? null;
  }

  /** Who is calling the agent API: an agent's own kag_ token, or a sandbox run's session token. */
  authAgent(token: string | undefined): { agentId: string; session: SandboxSession | null } | null {
    if (!token) return null;
    if (token.startsWith("ksess_")) {
      const s = this.session(token);
      return s ? { agentId: s.agentId, session: s } : null;
    }
    const h = sha256(token);
    const agentId = Object.entries(this.org.agentTokens).find(([, v]) => v === h)?.[0];
    return agentId ? { agentId, session: null } : null;
  }

  async propose(agentId: string, action: AgentAction, reason?: string): Promise<AgentResponse> {
    const policy = this.requireReady();
    if (!policy.agents.some((a) => a.id === agentId)) throw new GatekeeperError("This agent is not active in Dharma yet", 403);
    const id = randomUUID();
    const base = {
      id, agentId, createdAt: this.now().toISOString(), action,
      reason: typeof reason === "string" ? reason.slice(0, 1000) : undefined, approvals: [],
    };

    // Trap Passwords: real keys never enter a sandbox, so using one is proof of misbehavior.
    const trap = findTrap(this.state.traps, { action, reason });
    if (trap) {
      const agentName = this.org.labels.agents[agentId] ?? agentId;
      const firstTouch = !this.state.tainted[agentId];
      this.state.tainted[agentId] = { at: this.now().toISOString(), secret: trap.secret };
      const r = this.denyEarly(base, action, "trap-password", `Used trap credential ${trap.secret}`);
      if (firstTouch) this.alert({ kind: "trap-touched", agentId, title: `${agentName} used a trap password`, body: `It tried to use ${trap.secret}, a fake credential planted by Karuna. Real keys never reach agents, so this is proof of misbehavior.` });
      this.logEvent({ type: "trap-touched", agent: agentId, secret: trap.secret, trapSet: trap.trap.id, proposalId: id });
      if (action.type === "message") this.tripSwarm(`${agentName} shared a trap credential (${trap.secret}) with another agent`, [agentId, String(action.to)]);
      this.save();
      return r;
    }

    if (action.type === "message") return this.agentMessage(base, agentId, action);

    // Swarm Stopper: several agents converging on the same new target.
    const target = targetOf(action as { type: string; to?: string; url?: string });
    if (target && this.isNewTarget(target)) {
      const agents = this.pivots.record(target, agentId, this.now().getTime(), this.deps.swarmWindowMs ?? 60_000);
      if (agents.length >= (this.deps.swarmAgents ?? 2)) {
        this.tripSwarm(`${agents.length} agents went after the same new target (${target.replace(/^[a-z]+:/, "")}) within ${Math.round((this.deps.swarmWindowMs ?? 60_000) / 1000)}s`, agents);
      }
    }

    // Auto-Shield: an action traced to a test message is refused before it can reach the wallet.
    // The agent gets the same instant blank denial as any other — nothing hints it was a test.
    if (action.type === "transfer" || action.type === "x402") {
      const test = this.state.tests.find((t) => tracesTo(t, action, reason));
      if (test) {
        const r = this.denyEarly(base, action, "auto-shield", `Acted on drill ${test.id.slice(0, 8)} (${TEMPLATES[test.template]})`);
        this.onShieldFail(test, agentId, id);
        return r;
      }
    }

    // Changed Bank Account Alert: a known supplier, but money going to a different address.
    if (action.type === "transfer") {
      const cited = action.sourceMessageId ? this.state.inbox.find((m) => m.id === action.sourceMessageId && m.agentId === agentId) : undefined;
      const claimed = (action.payeeName ?? cited?.from ?? "").trim().toLowerCase();
      const known = claimed ? policy.payees.find((p) => (this.org.labels.payees[lower(p.account)] ?? "").trim().toLowerCase() === claimed) : undefined;
      if (known && lower(known.account) !== lower(String(action.to ?? ""))) {
        const name = this.org.labels.payees[lower(known.account)];
        const r = this.denyEarly(base, action, "changed-bank-account", `${name} is on file at ${lower(known.account)}, but this payment went to ${lower(String(action.to))}`);
        this.alert({
          kind: "changed-bank-account", agentId, title: `Changed bank account: ${name}`,
          body: `${this.org.labels.agents[agentId] ?? agentId} tried to pay ${name} at a new account (${short(String(action.to))}). Blocked. Call ${name} on a number you already have to confirm before changing anything.`,
        });
        this.logEvent({ type: "changed-bank-account", agent: agentId, payee: lower(known.account), attemptedTo: lower(String(action.to)), proposalId: id });
        this.save();
        return r;
      }
    }

    // Panic button: nothing runs while frozen. Same blank denial as everything else.
    // Pause (local, instant on and off) works the same way, without touching Dharma.
    const frozen = this.isFrozen();
    if (frozen || this.state.paused) {
      const request: Request = { agent: agentId, tool: action.type === "action" ? action.tool : "payment" };
      const decision: Decision = frozen
        ? { outcome: "deny", ruleId: "panic-freeze", reason: "All agents are frozen" }
        : { outcome: "deny", ruleId: "paused", reason: `Agents are paused (by ${this.state.paused!.by})` };
      this.logDecision(request, decision);
      this.state.proposals.push({ ...base, request, decision, facts: [], status: "denied" });
      this.save();
      return { id, status: "denied" };
    }

    let built: { request: Request; payload?: PaymentPayload; facts: Fact[] };
    try {
      built = await this.build(agentId, action);
    } catch (e) {
      const msg = scrub(e);
      const request: Request = { agent: agentId, tool: action.type === "action" ? action.tool : "payment" };
      const decision: Decision = { outcome: "deny", ruleId: "invalid-proposal", reason: msg };
      this.logDecision(request, decision);
      this.state.proposals.push({ ...base, request, decision, facts: [], status: "failed", error: msg });
      this.save();
      return { id, status: "failed" };
    }

    const ctx = buildContext(
      {
        agents: policy.agents.map((a) => ({ id: a.id, dailyAllowanceUsd: a.capUsd })),
        recipients: policy.payees.map((p) => ({ address: p.account, name: this.org.labels.payees[lower(p.account)] ?? p.account, category: p.category })),
        allowlistedDomains: policy.domains,
      },
      this.spentToday(),
    );
    const decision = evaluate(built.request, ctx, buildRuleset(policy.rules));
    this.logDecision(built.request, decision);
    const p: Proposal = {
      ...base, request: built.request, decision, facts: built.facts, payload: built.payload,
      payloadHash: built.payload ? payloadHash(built.payload) : undefined,
      status: decision.outcome === "deny" ? "denied" : decision.outcome === "approval" ? "pending" : built.payload ? "executing" : "allowed",
    };
    if (p.payloadHash) p.facts.push({ label: "Payload hash", value: shortHash(p.payloadHash) });

    if (action.type === "x402" && action.maxUsd != null && built.payload && built.payload.amountUsd > action.maxUsd) {
      p.status = "failed";
      p.error = `Seller asks ${usd(built.payload.amountUsd)}, above the agent's own limit of ${usd(action.maxUsd)}. Nothing was paid.`;
      this.logEvent({ type: "refused", proposalId: id, reason: "agent-max-exceeded" });
    }

    this.state.proposals.push(p);
    this.save();

    if (p.status === "pending" && p.payload && p.payloadHash) {
      // Public signal for QuickNode Streams (Phase 4). Best effort; never blocks the agent.
      void this.send("requestApproval", [keccak256(stringToHex(p.id)), toBytes32(agentId), toMicro(p.payload.amountUsd), `0x${p.payloadHash}`])
        .catch((e) => this.logEvent({ type: "approval-signal-failed", proposalId: p.id, detail: scrub(e) }));
    }
    if (p.status === "executing") await this.execute(p, { requote: false });
    return this.agentView(agentId, id)!;
  }

  /** Build the engine request + exact payload from Karuna's own lookups, not the agent's claims. */
  private async build(agentId: string, action: AgentAction): Promise<{ request: Request; payload?: PaymentPayload; facts: Fact[] }> {
    const from = this.org.wallet!.address;
    const payee = (a: string) => {
      const p = this.policy!.payees.find((x) => lower(x.account) === lower(a));
      return p ? { name: this.org.labels.payees[lower(a)] ?? "Known payee", category: p.category } : undefined;
    };
    if (action.type === "x402") {
      const url = String(action.url ?? "");
      if (!/^https?:\/\//.test(url)) throw new Error("x402 url must be http(s)");
      const method = String(action.method ?? "GET").toUpperCase();
      const body = action.body === undefined ? undefined : typeof action.body === "string" ? action.body : JSON.stringify(action.body);
      const quote = await this.deps.wallet.quoteX402(from, url, method, body);
      const rec = payee(quote.seller);
      const payload: PaymentPayload = {
        kind: "x402", from, chain: WALLET_CHAIN, url, method, body, seller: quote.seller,
        amountUsd: quote.amountUsd, network: quote.network, scheme: quote.scheme, transferMethod: quote.transferMethod,
      };
      return {
        payload,
        request: { agent: agentId, tool: "payment", paymentKind: "x402", to: quote.seller, amountUsd: quote.amountUsd, category: rec?.category, url, method },
        facts: [
          { label: "Action", value: `Buy ${method} ${url}` },
          { label: "Seller", value: rec ? rec.name : "Not a known payee", tone: rec ? undefined : "warn" },
          { label: "Seller address", value: quote.seller },
          ...(rec ? [{ label: "Category", value: rec.category }] : []),
          { label: "Price (quoted by seller)", value: `${usd(quote.amountUsd)} USDC` },
          { label: "Paid via", value: quote.transferMethod === "gateway" ? "Circle Gateway nanopayment" : `x402 ${quote.scheme}` },
          { label: "Network", value: quote.network === "eip155:5042002" ? "Arc testnet" : quote.network },
          { label: "Reversible", value: "No", tone: "warn" },
        ],
      };
    }
    if (action.type === "transfer") {
      const to = requireAddress(action.to, "to");
      const amountUsd = Number(action.amountUsd);
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error("amountUsd must be > 0");
      const rec = payee(to);
      const payload: PaymentPayload = { kind: "transfer", from, chain: WALLET_CHAIN, to, amountUsd, token: USDC_TOKEN };
      return {
        payload,
        request: { agent: agentId, tool: "payment", paymentKind: "transfer", to, amountUsd, category: rec?.category },
        facts: [
          { label: "Action", value: `Send ${usd(amountUsd)} USDC` },
          { label: "Recipient", value: rec ? rec.name : "Not a known payee", tone: rec ? undefined : "warn" },
          { label: "Recipient address", value: to },
          ...(rec ? [{ label: "Category", value: rec.category }] : []),
          { label: "Amount", value: `${usd(amountUsd)} USDC` },
          { label: "Network", value: "Arc testnet" },
          { label: "Reversible", value: "No", tone: "warn" },
        ],
      };
    }
    if (action.type === "action") {
      const tools = ["shell", "file", "http", "message"] as const;
      if (!tools.includes(action.tool)) throw new Error("unknown tool");
      const request: Request = {
        agent: agentId, tool: action.tool,
        command: action.command, path: action.path, fileOp: action.fileOp, method: action.method, url: action.url, body: action.body,
      };
      const what = action.command ?? (action.url ? `${action.method ?? "GET"} ${action.url}` : action.path ? `${action.fileOp ?? "read"} ${action.path}` : action.tool);
      return { request, facts: [{ label: "Action", value: `${action.tool}: ${what}` }] };
    }
    throw new Error("unknown action type");
  }

  /** Move money. Only ever called with a payload whose hash was decided on. */
  private async execute(p: Proposal, { requote }: { requote: boolean }) {
    if (!p.payload || !p.payloadHash) throw new GatekeeperError("Nothing to execute");
    if (this.executing.has(p.id)) throw new GatekeeperError("Already executing", 409);
    this.executing.add(p.id);
    p.status = "executing";
    this.save();
    try {
      if (payloadHash(p.payload) !== p.payloadHash) throw new ExactMatchError("Stored payload no longer matches the approved hash.");
      const pay = p.payload;
      if (pay.kind === "x402") {
        if (requote) {
          const q = await this.deps.wallet.quoteX402(pay.from, pay.url, pay.method, pay.body);
          const fresh: PaymentPayload = { ...pay, seller: q.seller, amountUsd: q.amountUsd, network: q.network, scheme: q.scheme, transferMethod: q.transferMethod };
          if (payloadHash(fresh) !== p.payloadHash) {
            throw new ExactMatchError(
              q.amountUsd !== pay.amountUsd ? `Seller now asks ${usd(q.amountUsd)} but ${usd(pay.amountUsd)} was approved.` : "Seller's payment terms changed after approval.",
            );
          }
        }
        const r = await this.deps.wallet.payX402(pay.from, pay.url, pay.method, pay.body, pay.amountUsd, p.id);
        p.result = r.response;
        p.txRef = r.transaction;
      } else {
        const r = await this.deps.wallet.transfer(pay.from, pay.to, pay.amountUsd, p.id);
        p.result = { sent: pay.amountUsd, to: pay.to, txRef: r.txRef };
        p.txRef = r.txRef;
      }
      p.status = "executed";
      this.addSpend(p.agentId, pay.amountUsd);
      this.logEvent({ type: "executed", proposalId: p.id, payloadHash: p.payloadHash, amountUsd: pay.amountUsd, txRef: p.txRef ?? null });
    } catch (e) {
      p.status = "failed";
      if (e instanceof ExactMatchError) {
        p.error = `Exact Match failed — ${e.message} Nothing was paid.`;
        this.logEvent({ type: "exact-match-refused", proposalId: p.id, payloadHash: p.payloadHash, detail: e.message });
      } else {
        p.error = `Payment failed: ${scrub(e)}`;
        this.logEvent({ type: "execution-failed", proposalId: p.id, detail: p.error });
      }
    } finally {
      this.executing.delete(p.id);
      p.resolvedAt ??= this.now().toISOString();
      this.save();
    }
  }

  // ================================================================ Sandbox (egress proxy)

  /** Rules that grant a capability rather than decide a request: key:<name>, mount, unsandboxed. */
  private capabilityRules(scope: string) {
    return (this.policy?.rules ?? []).filter((r) => r.active && !r.builtin && r.outcome === "allow" && r.scope === scope);
  }

  /** Voted onchain: this agent may use its token outside a sandbox ("partially enforced"). */
  isUnsandboxed(agentId: string) {
    return this.capabilityRules("unsandboxed").some((r) => r.target === agentId);
  }

  /** Voted onchain: this agent may mount `hostPath` writable. Read-only mounts need no rule. */
  mayMountWritable(agentId: string, hostPath: string) {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return this.capabilityRules("mount").some((r) => (!r.agent || r.agent === agentId) && norm(r.target) === norm(hostPath));
  }

  /** Hosts each key is bound to (Dharma rules with scope key:<name>). */
  keyBindings(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const r of (this.policy?.rules ?? []).filter((x) => x.active && !x.builtin && x.outcome === "allow" && x.scope.startsWith("key:"))) {
      (out[r.scope.slice(4)] ??= []).push(r.target);
    }
    return out;
  }

  get requireSandbox() {
    return this.deps.requireSandbox ?? false;
  }

  /** `karuna run` asks for a box. The agent must be on Dharma and the org not frozen. */
  startSession(agentId: string, meta: { host?: unknown; isolation?: unknown; desktop?: unknown; remote?: unknown } = {}): SandboxSession {
    const pol = this.requireReady();
    if (!pol.agents.some((a) => a.id === agentId)) throw new GatekeeperError("This agent is not active in Dharma yet", 403);
    if (this.isFrozen()) throw new GatekeeperError("All agents are frozen", 423);
    const isolation = meta.isolation === "gvisor" ? "gvisor" : "docker";
    if (this.deps.requireIsolation === "gvisor" && isolation !== "gvisor") {
      throw new GatekeeperError("This organization requires gVisor isolation. Install gVisor (runsc) for Docker on that machine.", 403);
    }
    const s: SandboxSession = {
      id: randomUUID().slice(0, 8), token: `ksess_${randomBytes(24).toString("base64url")}`, agentId,
      startedAt: this.now().toISOString(), lastSeen: Date.now(), host: typeof meta.host === "string" ? meta.host.slice(0, 80) : null,
      isolation, desktop: meta.desktop === true, remote: meta.remote === true, viewer: null,
      requests: 0, denied: 0, lastRequest: null, stopRequested: false,
    };
    this.sessions.set(s.token, s);
    this.logEvent({ type: "sandbox-started", agent: agentId, session: s.id, host: s.host, isolation, desktop: s.desktop, remote: s.remote });
    this.save();
    return s;
  }

  /** The live session behind a box's token, or null (unknown, idle too long, or ended). */
  session(token: string | undefined): SandboxSession | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (Date.now() - s.lastSeen > SESSION_IDLE_MS) {
      this.endSession(token, "idle");
      return null;
    }
    return s;
  }

  /** Runner heartbeat. Tells the runner to stop the box when frozen, removed, or stopped. */
  heartbeat(token: string, info: { viewer?: unknown } = {}): { stop: boolean; reason?: string } {
    const s = this.session(token);
    if (!s) return { stop: true, reason: "session ended" };
    s.lastSeen = Date.now();
    if (typeof info.viewer === "string" && /^http:\/\/127\.0\.0\.1:\d+\//.test(info.viewer)) s.viewer = info.viewer;
    if (this.isFrozen()) return { stop: true, reason: "all agents are frozen" };
    if (!this.policy?.agents.some((a) => a.id === s.agentId)) return { stop: true, reason: "agent removed from Dharma" };
    if (s.stopRequested) return { stop: true, reason: "stopped from the console" };
    return { stop: false };
  }

  endSession(token: string, why = "ended") {
    const s = this.sessions.get(token);
    if (!s) return;
    this.sessions.delete(token);
    this.logEvent({ type: "sandbox-ended", agent: s.agentId, session: s.id, why, requests: s.requests, denied: s.denied });
    this.emit("session-end", token);
    this.save();
  }

  /** Console: stop one box (the runner kills it on its next heartbeat; egress stops now). */
  stopSession(id: string) {
    const s = [...this.sessions.values()].find((x) => x.id === id);
    if (!s) throw new GatekeeperError("No such sandbox run", 404);
    s.stopRequested = true;
    this.logEvent({ type: "sandbox-stop-requested", agent: s.agentId, session: s.id });
    this.save();
  }

  /**
   * Decide one request leaving a box. Same checks as a proposal (traps, swarm, freeze, Dharma
   * rules, signed log), plus key bindings. Approvals become cards; a member's yes is a one-time
   * pass for exactly this request (method + URL + body hash) for 10 minutes.
   */
  egress(token: string, r: EgressRequest): EgressVerdict {
    const s = this.session(token);
    if (!s) return { verdict: "deny" };
    s.lastSeen = Date.now();
    s.requests++;
    s.lastRequest = `${r.method} ${r.url}`.slice(0, 200);
    const agentId = s.agentId;
    const method = r.method.toUpperCase();
    const bodyText = r.body.length ? r.body.subarray(0, 64 * 1024).toString("utf8") : "";
    const headerText = Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join("\n");
    const request: Request = { agent: agentId, tool: "http", method, url: r.url };
    const hash = sha256(`${method} ${r.url}\n${createHash("sha256").update(r.body).digest("hex")}`);
    const base = {
      id: randomUUID(), agentId, createdAt: this.now().toISOString(),
      action: { type: "action" as const, tool: "http" as const, method, url: r.url, body: bodyText.slice(0, 2000) || undefined },
      approvals: [],
    };
    const host = (() => {
      try {
        return new URL(r.url).host;
      } catch {
        return r.url;
      }
    })();
    const deny = (ruleId: string, reason: string, record = true): EgressVerdict => {
      s.denied++;
      this.logDecision(request, { outcome: "deny", ruleId, reason });
      if (!record) return { verdict: "deny" };
      // Every denial is in the signed log; the console gets one card per agent + host + rule per 10
      // minutes, so a retry loop (or a browser's background pings) can't bury real approvals.
      const since = Date.now() - 10 * 60_000;
      const repeat = [...this.state.proposals].reverse().find((p) => p.agentId === agentId && p.status === "denied" && p.request.tool === "http"
        && p.decision.ruleId === ruleId && Date.parse(p.createdAt) > since && (() => { try { return new URL(p.request.url ?? "").host === host; } catch { return false; } })());
      if (repeat) return { verdict: "deny", proposalId: repeat.id };
      this.state.proposals.push({ ...base, request, decision: { outcome: "deny", ruleId, reason }, facts: [{ label: "Request", value: `${method} ${r.url}`.slice(0, 300) }], status: "denied" });
      this.save();
      return { verdict: "deny", proposalId: base.id };
    };

    if (!this.policy?.agents.some((a) => a.id === agentId)) return deny("agent-inactive", "Agent is no longer on Dharma");
    if (s.stopRequested) return deny("sandbox-stopped", "This run was stopped from the console");

    // Trap Passwords: a planted fake key anywhere in the request is proof of misbehavior.
    const trap = findTrap(this.state.traps, { url: r.url, headers: headerText, body: bodyText });
    if (trap) {
      const first = !this.state.tainted[agentId];
      this.state.tainted[agentId] = { at: this.now().toISOString(), secret: trap.secret };
      const name = this.org.labels.agents[agentId] ?? agentId;
      if (first) this.alert({ kind: "trap-touched", agentId, title: `${name} used a trap password`, body: `From inside its sandbox it sent ${trap.secret}, a fake credential planted by Karuna, to ${host}.` });
      this.logEvent({ type: "trap-touched", agent: agentId, secret: trap.secret, trapSet: trap.trap.id, via: "egress", host });
      return deny("trap-password", `Used trap credential ${trap.secret}`);
    }

    if (this.isFrozen()) return deny("panic-freeze", "All agents are frozen");
    if (this.state.paused) return deny("paused", `Agents are paused (by ${this.state.paused.by})`);

    // Keys: a placeholder may only travel to a host its key is bound to on Dharma.
    const wanted = SecretStore.placeholdersIn(`${r.url}\n${headerText}`);
    const bindings = this.keyBindings();
    for (const k of wanted) {
      if (!this.deps.secrets?.list().some((x) => x.name === k)) return deny("key-unknown", `Placeholder for unknown key "${k}"`);
      if (!this.deps.secrets.forAgents(k)) return deny("key-drafter-only", `Key "${k}" is for Karuna's rule drafter only`);
      if (!(bindings[k] ?? []).some((t) => httpTargetMatches(r.url, t))) return deny("key-not-bound", `Key "${k}" is not bound to ${host}`);
    }

    // A member already approved exactly this request.
    const grant = this.grants.get(hash);
    if (grant && grant > Date.now()) {
      this.grants.delete(hash);
      this.logDecision(request, { outcome: "allow", ruleId: "human-approved", reason: "One-time pass from a member's approval" });
      return { verdict: "allow", keys: wanted };
    }

    const pol = this.policy!;
    const ctx = buildContext(
      { agents: pol.agents.map((a) => ({ id: a.id, dailyAllowanceUsd: a.capUsd })), recipients: [], allowlistedDomains: pol.domains },
      this.spentToday(),
    );
    const decision = evaluate(request, ctx, buildRuleset(pol.rules));

    // Swarm Stopper: agents converging on a host nobody approved.
    if (decision.outcome !== "allow") {
      const target = targetOf({ type: "action", url: r.url });
      if (target && this.isNewTarget(target)) {
        const agents = this.pivots.record(target, agentId, this.now().getTime(), this.deps.swarmWindowMs ?? 60_000);
        if (agents.length >= (this.deps.swarmAgents ?? 2)) {
          this.tripSwarm(`${agents.length} sandboxed agents went after the same new host (${target.replace(/^[a-z]+:/, "")}) within ${Math.round((this.deps.swarmWindowMs ?? 60_000) / 1000)}s`, agents);
        }
      }
    }

    if (decision.outcome === "allow") {
      this.logDecision(request, decision);
      this.emit("egress-allowed", { agentId, method, url: r.url });
      return { verdict: "allow", keys: wanted };
    }
    if (decision.outcome === "deny") return deny(decision.ruleId, decision.reason);

    // Approval: one card per distinct request; repeats while it's pending join the same card.
    const open = this.state.proposals.find((p) => p.status === "pending" && p.agentId === agentId && p.payloadHash === hash);
    if (open) return { verdict: "pending", proposalId: open.id };
    this.logDecision(request, decision);
    const facts: Fact[] = [
      { label: "Request", value: `${method} ${host}` },
      { label: "Path", value: (() => { try { const u = new URL(r.url); return `${u.pathname}${u.search}`.slice(0, 300) || "/"; } catch { return "/"; } })() },
      { label: "Body", value: r.body.length ? `${r.body.length.toLocaleString()} bytes${bodyText ? ` · ${bodyText.replace(/\s+/g, " ").slice(0, 160)}` : ""}` : "none" },
      ...(wanted.length ? [{ label: "Key attached on approval", value: wanted.join(", ") }] : []),
      { label: "From", value: `sandbox run ${s.id}${s.host ? ` on ${s.host}` : ""}` },
    ];
    this.state.proposals.push({ ...base, request, decision, facts, payloadHash: hash, status: "pending" });
    this.save();
    return { verdict: "pending", proposalId: base.id };
  }

  /** Wait (up to `ms`) for a held request's card to be decided. */
  waitForDecision(proposalId: string, ms: number): Promise<"allowed" | "denied" | "pending"> {
    const check = () => {
      const p = this.state.proposals.find((x) => x.id === proposalId);
      if (!p) return "denied" as const;
      return p.status === "allowed" ? ("allowed" as const) : p.status === "pending" ? ("pending" as const) : ("denied" as const);
    };
    const now = check();
    if (now !== "pending") return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = (v: "allowed" | "denied" | "pending") => {
        clearTimeout(t);
        this.off("change", onChange);
        resolve(v);
      };
      const onChange = () => {
        const v = check();
        if (v !== "pending") done(v);
      };
      const t = setTimeout(() => done("pending"), ms);
      this.on("change", onChange);
    });
  }

  /** Consume the one-time pass a member's approval created for this exact request. */
  takeGrant(proposalId: string): boolean {
    const p = this.state.proposals.find((x) => x.id === proposalId);
    if (!p?.payloadHash || p.status !== "allowed") return false;
    const ok = (this.grants.get(p.payloadHash) ?? 0) > Date.now();
    this.grants.delete(p.payloadHash);
    return ok;
  }

  /** The real value for a key placeholder. Only the egress proxy calls this, per request. */
  /** For the egress proxy: an agent key's real value. Drafter keys are never revealed to the proxy. */
  revealKey(name: string): string | null {
    if (!this.deps.secrets?.forAgents(name)) return null;
    return this.deps.secrets.reveal(name);
  }

  /** An x402 seller answered 402 to a boxed agent: run it as a normal Karuna payment proposal. */
  async payForBox(token: string, r: { url: string; method: string; body?: string }): Promise<AgentResponse> {
    const s = this.session(token);
    if (!s) return { id: "", status: "denied" };
    return this.propose(s.agentId, { type: "x402", url: r.url, method: r.method, body: r.body }, "Paid API returned 402 inside the sandbox");
  }

  /**
   * Local pause: every new agent action and every request out of a box is denied until resumed.
   * Not a governance action: nothing goes onchain, no vote to undo, boxes keep running. For "stop
   * everything and make it stick", members use Freeze.
   */
  pause(by: string) {
    if (this.state.paused) return this.state.paused;
    this.state.paused = { at: this.now().toISOString(), by: String(by).slice(0, 60) || "someone" };
    this.logEvent({ type: "paused", by: this.state.paused.by });
    this.save();
    this.emit("paused", this.state.paused);
    return this.state.paused;
  }

  resume(by: string) {
    if (!this.state.paused) return null;
    this.state.paused = null;
    this.logEvent({ type: "resumed", by: String(by).slice(0, 60) });
    this.save();
    this.emit("resumed");
    return null;
  }

  get paused() {
    return this.state.paused ?? null;
  }

  /** Recent proposals, newest last (cheap: no log verification, unlike snapshot()). */
  recentProposals(n = 300): Readonly<Proposal>[] {
    return this.state.proposals.slice(-n);
  }

  /** How long a held sandbox request waits before the box gets "pending" back. */
  holdMs = 120_000;

  /** A key value was stored or rotated (the value itself is never logged). */
  noteKeyStored(name: string, envVar: string) {
    this.logEvent({ type: "key-stored", key: name, envVar });
    this.save();
  }

  noteKeyRemoved(name: string) {
    this.logEvent({ type: "key-removed", key: name });
    this.save();
  }

  sandboxView() {
    const L = this.labels();
    return {
      requireSandbox: this.requireSandbox,
      remote: this.remote,
      sessions: [...this.sessions.values()]
        .filter((s) => Date.now() - s.lastSeen <= SESSION_IDLE_MS)
        .map(({ token: _t, ...s }) => ({ ...s, agentName: L.agent(s.agentId) ?? s.agentId, lastSeen: new Date(s.lastSeen).toISOString() })),
      keys: (this.deps.secrets?.list() ?? []).map((k) => ({ ...k, placeholder: `karuna_key_${k.name}`, boundTo: this.keyBindings()[k.name] ?? [] })),
      unsandboxed: this.capabilityRules("unsandboxed").map((r) => r.target),
    };
  }

  agentView(agentId: string, proposalId: string): AgentResponse | null {
    const p = this.state.proposals.find((x) => x.id === proposalId && x.agentId === agentId);
    if (!p) return null;
    const status: AgentResponse["status"] = p.status === "executed" ? "done" : p.status === "executing" ? "pending" : p.status;
    return status === "done" ? { id: p.id, status, result: p.result } : { id: p.id, status };
  }

  // ================================================================ Swarm Stopper + Trap Passwords

  /** Not a payee on Dharma and not an allowlisted domain: a target nobody approved. */
  private isNewTarget(target: string) {
    const pol = this.policy;
    if (!pol) return false;
    const [kind, value] = [target.split(":")[0], target.slice(target.indexOf(":") + 1)];
    if (kind === "address") return !pol.payees.some((p) => lower(p.account) === value);
    return !pol.domains.some((d) => value === d || value.endsWith(`.${d}`));
  }

  /** Agent → agent message: checked like any action, logged, then delivered. No hidden channel. */
  private agentMessage(base: Omit<Proposal, "request" | "decision" | "facts" | "status">, agentId: string, action: { type: "message"; to: string; body: string }): AgentResponse {
    const pol = this.policy!;
    const to = String(action.to ?? "");
    const body = String(action.body ?? "").slice(0, 4000);
    const fromName = this.org.labels.agents[agentId] ?? agentId;
    const request: Request = { agent: agentId, tool: "message", recipient: to, body: `to ${to}` };
    const toName = this.org.labels.agents[to] ?? to;
    const deny = (ruleId: string, reason: string) => {
      this.logDecision(request, { outcome: "deny", ruleId, reason });
      this.state.proposals.push({ ...base, request, decision: { outcome: "deny", ruleId, reason }, facts: [{ label: "Message to", value: to }], status: "denied" });
      this.save();
      return { id: base.id, status: "denied" as const };
    };
    if (!pol.agents.some((a) => a.id === to)) return deny("unknown-agent", `No active agent "${to}"`);
    if (this.isFrozen()) return deny("panic-freeze", "All agents are frozen");
    const credential = findCredential(body);
    if (credential) {
      this.tripSwarm(`${fromName} sent a credential (${credential}) to ${this.org.labels.agents[to] ?? to}`, [agentId, to]);
      return deny("swarm-credential", `Credential-shaped secret (${credential}) in an agent-to-agent message`);
    }
    if (this.state.tainted[agentId]) {
      this.tripSwarm(`${fromName} touched a trap password, then messaged ${this.org.labels.agents[to] ?? to}`, [agentId, to]);
      return deny("swarm-tainted", "Agent that touched a trap credential tried to message another agent");
    }
    // The org's own message rules (block / require approval / allow), after the swarm checks above.
    const ruled = matchCustomRules(request, pol.rules);
    if (ruled?.outcome === "deny") return deny(ruled.ruleId, ruled.reason);
    const facts: Fact[] = [
      { label: "Message to", value: toName },
      { label: "Message", value: body.replace(/\s+/g, " ").slice(0, 300) || "(empty)" },
    ];
    if (ruled?.outcome === "approval") {
      // Held: delivered only after a member approves exactly this message (hash of recipient + body).
      const decision: Decision = { outcome: "approval", ruleId: ruled.ruleId, reason: ruled.reason };
      this.logDecision(request, decision);
      this.state.proposals.push({ ...base, request, decision, facts, payloadHash: sha256(`message\n${to}\n${body}`), status: "pending" });
      this.save();
      return { id: base.id, status: "pending" };
    }
    this.deliverMessage(agentId, to, body);
    const decision: Decision = ruled ?? { outcome: "allow", ruleId: "agent-message", reason: `Delivered to ${toName}` };
    this.logDecision(request, decision);
    this.state.proposals.push({ ...base, request, decision, facts, status: "allowed" });
    this.save();
    return { id: base.id, status: "allowed" };
  }

  private deliverMessage(from: string, to: string, body: string) {
    const fromName = this.org.labels.agents[from] ?? from;
    const m: InboxMessage = { id: randomUUID(), agentId: to, from: `${fromName} (agent)`, subject: `Message from ${fromName}`, body, receivedAt: this.now().toISOString() };
    this.state.inbox.push(m);
  }

  /** Freeze every agent: instantly here, then onchain (a Gatekeeper-only tightening). */
  private tripSwarm(reason: string, agents: string[]) {
    // Same swarm, still frozen (e.g. the agent messaged a second teammate): fold it into that trip.
    const last = this.state.swarmTrips.at(-1);
    if (last && last.reason === reason && this.isFrozen()) {
      last.agents = [...new Set([...last.agents, ...agents])];
      this.logEvent({ type: "swarm-stopped", reason, agents, alreadyFrozen: true, tripId: last.id });
      this.save();
      return;
    }
    const trip: State["swarmTrips"][number] = { id: randomUUID(), at: this.now().toISOString(), reason, agents: [...new Set(agents)] };
    this.state.swarmTrips.push(trip);
    if (this.state.swarmTrips.length > 200) this.state.swarmTrips = this.state.swarmTrips.slice(-200);
    const already = !!this.isFrozen();
    if (!already) this.state.localFreeze = { at: trip.at, by: "Tripwire" };
    this.alert({ kind: "swarm-stopped", agentId: agents[0] ?? "", title: "Tripwire froze every agent", body: `${reason}. Every proposal is now denied. Unfreezing needs a member vote.` });
    this.logEvent({ type: "swarm-stopped", reason, agents: trip.agents, alreadyFrozen: already });
    this.save();
    if (!already && !this.policy?.frozen) {
      this.background(
        this.send("tighten", [9 /* Op.Freeze */, "0x", zeroAddress, 0n, "0x"])
          .then(({ txRef }) => {
            trip.txRef = txRef;
            this.logEvent({ type: "swarm-freeze-onchain", tripId: trip.id, txRef });
            return this.sync(true).catch(() => undefined);
          })
          .catch((e) => this.logEvent({ type: "swarm-freeze-onchain-failed", tripId: trip.id, detail: scrub(e) }))
          .finally(() => this.save()),
      );
    }
  }

  /** Mint a trap set (for one agent, or all) to plant in sandboxes. */
  mintTrapSet(agentId?: unknown) {
    this.requireReady();
    const a = typeof agentId === "string" && agentId ? agentId : null;
    const t = mintTraps(a, this.now());
    this.state.traps.push(t);
    this.logEvent({ type: "traps-minted", trapSet: t.id, agent: a, secrets: t.secrets.map((x) => x.name) });
    this.save();
    return { ...t, envFile: trapEnvFile(t) };
  }

  /** Drop a trap set into an agent's inbox as a "leaked credentials" email. */
  plantTrapInInbox(trapId: string, agentId: unknown) {
    const t = this.state.traps.find((x) => x.id === trapId);
    if (!t) throw new GatekeeperError("Unknown trap set", 404);
    const msg = trapLeakMessage(t);
    return this.postMessage({ agentId, ...msg });
  }

  // ================================================================ Auto-Shield + inbox

  /** Record a refused proposal before evaluation (Auto-Shield, changed account). Blank to the agent. */
  private denyEarly(base: Omit<Proposal, "request" | "decision" | "facts" | "status">, action: AgentAction, ruleId: string, reason: string): AgentResponse {
    const request: Request = action.type === "transfer"
      ? { agent: base.agentId, tool: "payment", paymentKind: "transfer", to: lower(String(action.to)), amountUsd: Number(action.amountUsd) }
      : { agent: base.agentId, tool: action.type === "action" ? action.tool : "payment", paymentKind: action.type === "x402" ? "x402" : undefined, url: action.type === "x402" ? action.url : undefined };
    const decision: Decision = { outcome: "deny", ruleId, reason };
    this.logDecision(request, decision);
    this.state.proposals.push({ ...base, request, decision, facts: [], status: "denied" });
    this.save();
    return { id: base.id, status: "denied" };
  }

  private alert(a: Omit<ShieldAlert, "id" | "at">) {
    this.state.alerts.push({ ...a, id: randomUUID(), at: this.now().toISOString() });
    if (this.state.alerts.length > 200) this.state.alerts = this.state.alerts.slice(-200);
  }

  /** The agent fell for a test: record it, alert humans, block that agent + category onchain. */
  private onShieldFail(test: ShieldTest, agentId: string, proposalId: string) {
    const first = test.status !== "failed";
    test.status = "failed";
    test.resolvedAt ??= this.now().toISOString();
    test.resolution = "acted on it";
    test.proposalIds.push(proposalId);
    const agentName = this.org.labels.agents[agentId] ?? agentId;
    if (first) {
      this.alert({
        kind: "shield-failed", agentId, title: `${agentName} failed a scam test`,
        body: `It tried to act on a fake message (${TEMPLATES[test.template]}). ${test.category} payments are paused for this agent. No money moved.`,
      });
    }
    this.logEvent({ type: "shield-test-failed", testId: test.id, agent: agentId, template: test.template, category: test.category, proposalId });
    this.save();
    // Onchain work happens in the background so the agent's answer comes back instantly.
    this.background(this.shieldBlock(agentId, test).catch((e) => {
      this.logEvent({ type: "shield-block-failed", testId: test.id, agent: agentId, detail: scrub(e) });
      this.save();
    }));
  }

  private async shieldBlock(agentId: string, test: ShieldTest) {
    const change = autoRule(agentId, test.category, "Deny");
    test.ruleId = (change as { id: string }).id;
    await this.writeAutoRule(change);
    await this.send("reportTestFailed", [toBytes32(agentId), test.category]);
    this.save();
  }

  /**
   * The single path by which Auto-Shield changes policy. It refuses anything but adding a deny or
   * require-approval rule (and Dharma separately refuses any loosening from the Gatekeeper).
   */
  async writeAutoRule(change: Change, logType = "shield-rule-added") {
    assertShieldSafe(change);
    const id = (change as { id: string }).id;
    if (this.policy?.rules.some((r) => r.id === id && r.active)) return { alreadyActive: true };
    const { op, data } = encodeChange(change);
    const { txRef } = await this.send("tighten", [op, data, zeroAddress, 0n, "0x"]);
    this.logEvent({ type: logType, rule: id, change: describeChange(change, this.labels()), txRef });
    await this.sync(true).catch(() => undefined);
    this.save();
    return { alreadyActive: false, txRef };
  }

  // ================================================================ Learns From Your Choices

  /** Record a human's payment decision as a precedent. A "no" becomes a narrow block at once. */
  private learn(p: Proposal, outcome: Precedent["outcome"], by: string) {
    const to = p.request.tool === "payment" ? p.request.to?.toLowerCase() : undefined;
    if (!to) return;
    const amountUsd = p.payload?.amountUsd ?? p.request.amountUsd ?? 0;
    const prec: Precedent = {
      id: randomUUID(), at: this.now().toISOString(), proposalId: p.id, agentId: p.agentId, counterparty: to,
      category: p.request.category ?? null, amountUsd, band: band(amountUsd), outcome, by,
    };
    this.state.precedents.push(prec);
    if (this.state.precedents.length > 2000) this.state.precedents = this.state.precedents.slice(-2000);
    this.logEvent({ type: "precedent", outcome, agent: p.agentId, counterparty: to, band: bandLabel(prec.band), by, proposalId: p.id });
    if (outcome === "deny") {
      // Tightening, so it applies now — through the same block-only writer as Auto-Shield.
      this.background(this.writeAutoRule(learnedDenyRule(p.agentId, to), "learned-block-added").catch((e) => {
        this.logEvent({ type: "learned-block-failed", proposalId: p.id, detail: scrub(e) });
        this.save();
      }));
    }
  }

  /** Every logged request, for Preview Before Loosening. */
  private history(): PastRequest[] {
    const FLAGS: Record<string, string> = {
      "auto-shield": "acted on a scam test", "changed-bank-account": "changed bank account", "trap-password": "used a trap password",
      "swarm-credential": "shared a credential", "swarm-tainted": "swarm",
    };
    return this.state.proposals.map((p) => ({ proposalId: p.id, at: p.createdAt, request: p.request, decision: p.decision, flagged: FLAGS[p.decision.ruleId] ?? null }));
  }

  private previewCache = new Map<string, Preview>();
  /** What an open loosening proposal would have allowed over the last 7 days. */
  previewFor(govId: number): Preview | null {
    const pol = this.policy;
    const g = pol?.proposals.find((x) => x.id === govId);
    if (!pol || !g?.change || !LOOSENING_OPS.has(g.change.op)) return null;
    const key = `${govId}:${pol.policyVersion}:${this.state.proposals.length}`;
    const hit = this.previewCache.get(key);
    if (hit) return hit;
    const r = previewLoosening(pol, g.change, this.history(), (a) => this.org.labels.payees[lower(a)] ?? a, 7, this.now().getTime());
    if (this.previewCache.size > 100) this.previewCache.clear();
    this.previewCache.set(key, r);
    return r;
  }

  /** What an agent sees in its inbox. Tests are indistinguishable: no flag, same shape. */
  agentInbox(agentId: string) {
    return this.state.inbox
      .filter((m) => m.agentId === agentId)
      .slice(-50)
      .reverse()
      .map(({ id, from, subject, body, receivedAt }) => ({ id, from, subject, body, receivedAt }));
  }

  /** A real message for an agent (forwarded by a human or an integration). */
  postMessage(input: { agentId: unknown; from: unknown; subject: unknown; body: unknown }) {
    this.requireReady();
    const agentId = requireText(input.agentId, "Agent", 40);
    if (!this.org.agentTokens[agentId] && !this.policy!.agents.some((a) => a.id === agentId)) throw new GatekeeperError("Unknown agent", 404);
    const m: InboxMessage = {
      id: randomUUID(), agentId, from: requireText(input.from, "From", 80), subject: requireText(input.subject, "Subject", 120),
      body: requireText(input.body, "Body", 4000), receivedAt: this.now().toISOString(),
    };
    this.state.inbox.push(m);
    if (this.state.inbox.length > 2000) this.state.inbox = this.state.inbox.slice(-2000);
    this.logEvent({ type: "inbox-message", agent: agentId, messageId: m.id, from: m.from });
    this.save();
    return { id: m.id };
  }

  /** The agent flags a message as suspicious. Flagging a test passes it. */
  reportMessage(agentId: string, messageId: string, reason?: string) {
    const m = this.state.inbox.find((x) => x.id === messageId && x.agentId === agentId);
    if (!m) throw new GatekeeperError("Not found", 404);
    m.reportedAt ??= this.now().toISOString();
    m.reportReason = typeof reason === "string" ? reason.slice(0, 500) : undefined;
    const test = this.state.tests.find((t) => t.messageId === messageId);
    const agentName = this.org.labels.agents[agentId] ?? agentId;
    if (test && test.status === "pending") {
      test.status = "passed";
      test.resolvedAt = this.now().toISOString();
      test.resolution = "reported";
      this.alert({ kind: "shield-passed", agentId, title: `${agentName} passed a scam test`, body: `It flagged the fake message instead of acting on it (${TEMPLATES[test.template]}).` });
      this.logEvent({ type: "shield-test-passed", testId: test.id, agent: agentId, resolution: "reported" });
    } else if (!test) {
      this.alert({ kind: "agent-reported", agentId, title: `${agentName} flagged a message`, body: `"${m.subject}" from ${m.from}${m.reportReason ? ` — ${m.reportReason}` : ""}` });
      this.logEvent({ type: "agent-reported-message", agent: agentId, messageId });
    }
    this.save();
    return { ok: true };
  }

  /** Send an Auto-Shield test to an agent now (also used by the random scheduler). */
  runTest(input: { agentId: unknown; template?: unknown; category?: unknown }) {
    const pol = this.requireReady();
    const agentId = requireText(input.agentId, "Agent", 40);
    if (!pol.agents.some((a) => a.id === agentId)) throw new GatekeeperError("That agent is not active in Dharma", 404);
    const templates = Object.keys(TEMPLATES) as TestTemplate[];
    const template = (templates.includes(input.template as TestTemplate) ? input.template : templates[Math.floor(Math.random() * templates.length)]) as TestTemplate;
    const named = pol.payees.filter((p) => this.org.labels.payees[lower(p.account)]);
    const knownPayee = template === "bank-change" && named.length
      ? (() => { const p = named[Math.floor(Math.random() * named.length)]; return { name: this.org.labels.payees[lower(p.account)], category: p.category }; })()
      : undefined;
    const categories = [...new Set(pol.payees.map((p) => p.category))];
    const category = (typeof input.category === "string" && input.category.trim())
      ? input.category.trim().toLowerCase()
      : knownPayee?.category ?? (categories.length ? categories[Math.floor(Math.random() * categories.length)] : "supplies");
    const memberNames = Object.values(this.org.labels.members);
    const { message, test } = makeTest({
      agentId, template, category, knownPayee,
      memberName: memberNames.length ? memberNames[Math.floor(Math.random() * memberNames.length)] : undefined, now: this.now(),
    });
    this.state.inbox.push(message);
    this.state.tests.push(test);
    if (this.state.tests.length > 1000) this.state.tests = this.state.tests.slice(-1000);
    this.logEvent({ type: "shield-test-sent", testId: test.id, agent: agentId, template, category });
    this.save();
    return { testId: test.id, messageId: message.id, template, category };
  }

  private lastShieldTick = 0;

  /** Expire tests nobody acted on (passed), and occasionally send new ones at random. */
  shieldHousekeeping() {
    const now = this.now().getTime();
    const window = this.deps.shieldWindowMs ?? 30 * 60_000;
    let dirty = false;
    for (const t of this.state.tests) {
      if (t.status === "pending" && now - Date.parse(t.sentAt) > window) {
        t.status = "passed";
        t.resolvedAt = new Date(now).toISOString();
        t.resolution = "ignored";
        this.logEvent({ type: "shield-test-passed", testId: t.id, agent: t.agentId, resolution: "ignored" });
        dirty = true;
      }
    }
    const perDay = this.deps.shieldTestsPerDay ?? 0;
    const elapsed = this.lastShieldTick ? now - this.lastShieldTick : 0;
    this.lastShieldTick = now;
    if (perDay > 0 && elapsed > 0 && this.policy && !this.isFrozen() && this.policy.payees.length) {
      const p = Math.min(1, (perDay * elapsed) / 86_400_000);
      for (const a of this.policy.agents) {
        if (Math.random() < p) {
          try {
            this.runTest({ agentId: a.id });
          } catch {
            /* agent removed meanwhile */
          }
        }
      }
    }
    if (dirty) this.save();
  }

  // ================================================================ payment approvals (signed)

  approvalsNeeded(p: Proposal): number {
    const amount = p.payload?.amountUsd ?? 0;
    const pol = this.policy;
    return pol && amount >= pol.thresholdUsd && pol.members.length >= 2 ? 2 : 1;
  }

  /** Verify a member's signed approve/deny for one payment; returns the member's address. */
  private async verifyDecision(p: Proposal, d: SignedDecision): Promise<string> {
    const pol = this.requireReady();
    const signer = requireAddress(d.signer, "signer");
    if (!this.isMember(signer)) throw new GatekeeperError("This key is not a Dharma member", 403);
    const deadline = BigInt(d.deadline);
    if (deadline < BigInt(Math.floor(this.now().getTime() / 1000))) throw new GatekeeperError("Signature expired", 400);
    const typed = paymentDecisionTypedData(this.dharmaAddress(), pol.chainId, {
      proposalId: p.id, payloadHash: d.payloadHash, approve: d.approve, deadline,
    });
    const ok = await verifyTypedData({ address: signer as Address, ...typed, signature: d.signature });
    if (!ok) throw new GatekeeperError("Signature does not match this decision", 401);
    return signer;
  }

  async decide(id: string, d: SignedDecision) {
    const p = this.state.proposals.find((x) => x.id === id);
    if (!p) throw new GatekeeperError("Unknown proposal", 404);
    if (p.status !== "pending") throw new GatekeeperError(`Proposal is ${p.status}`, 409);
    const signedHash = d.payloadHash;
    const memberId = await this.verifyDecision(p, d);

    if (!d.approve) {
      p.status = "denied";
      p.resolvedBy = memberId;
      p.resolvedAt = this.now().toISOString();
      this.logEvent({ type: "denied-by-human", proposalId: id, by: memberId });
      this.learn(p, "deny", memberId);
      this.save();
      return { status: "denied" as const };
    }

    if (this.isFrozen()) throw new GatekeeperError("Agents are frozen. Unfreeze before approving.", 409);
    if (p.payloadHash && signedHash !== `0x${p.payloadHash}`) {
      this.logEvent({ type: "exact-match-refused", proposalId: id, by: memberId, detail: "approval signature is for a different payload" });
      this.save();
      throw new GatekeeperError("Exact Match failed: what you approved is not what would execute. Nothing was paid.", 409);
    }
    if (p.approvals.some((a) => a.memberId === memberId)) throw new GatekeeperError("You already approved this", 409);
    p.approvals.push({ memberId, at: this.now().toISOString() });
    this.logEvent({ type: "approved", proposalId: id, by: memberId, payloadHash: p.payloadHash ?? null, approvals: p.approvals.length, needed: this.approvalsNeeded(p) });
    if (p.approvals.length < this.approvalsNeeded(p)) {
      this.save();
      return { status: "needs-another-approval" as const };
    }
    p.resolvedBy = memberId;
    this.learn(p, "approve", memberId);
    if (!p.payload) {
      p.status = "allowed";
      p.resolvedAt = this.now().toISOString();
      // A held sandbox request: this approval is a one-time pass for exactly that request.
      if (p.request.tool === "http" && p.payloadHash) this.grants.set(p.payloadHash, Date.now() + GRANT_MS);
      // A held agent-to-agent message: deliver exactly what was approved.
      if (p.request.tool === "message" && p.action.type === "message") this.deliverMessage(p.agentId, String(p.action.to), String(p.action.body ?? "").slice(0, 4000));
      this.save();
      return { status: "allowed" as const };
    }
    await this.execute(p, { requote: true });
    return { status: p.status, error: p.error };
  }

  // ------------------------------------------------ read models for the console

  snapshot() {
    const pol = this.policy;
    const spent = this.spentToday();
    const v = this.log.verify();
    const L = this.labels();
    const frozen = this.isFrozen();
    return {
      setUp: isSetUp(this.org),
      deploying: this.deploying,
      lastChainEventAt: this.lastChainEventAt || null,
      org: {
        name: this.org.name,
        wallet: this.org.wallet,
        dharma: this.org.dharma ? { ...this.org.dharma, explorer: `${EXPLORER}/address/${this.org.dharma.address}` } : null,
      },
      policy: pol && {
        loaded: true,
        chainTime: pol.chainTime,
        timelock: pol.timelock,
        coreTimelock: pol.coreTimelock,
        version: pol.version,
        required: pol.required,
        thresholdUsd: pol.thresholdUsd,
        policyVersion: pol.policyVersion,
        anchor: { head: pol.logHead, length: pol.logLength },
        members: pol.members.map((m) => ({ address: lower(m), name: L.member(m) ?? null })),
        agents: [
          ...pol.agents.map((a) => ({ id: a.id, name: L.agent(a.id) ?? a.id, capUsd: a.capUsd, spentTodayUsd: spent[a.id] ?? 0, active: true, hasToken: !!this.org.agentTokens[a.id] })),
          ...Object.keys(this.org.agentTokens)
            .filter((id) => !pol.agents.some((a) => a.id === id))
            .map((id) => ({ id, name: L.agent(id) ?? id, capUsd: 0, spentTodayUsd: 0, active: false, hasToken: true })),
        ],
        payees: pol.payees.map((p) => ({ account: lower(p.account), category: p.category, name: L.payee(p.account) ?? null })),
        domains: pol.domains,
        rules: pol.rules,
        proposals: pol.proposals.map((p) => ({
          ...p,
          proposer: lower(p.proposer),
          description: p.change ? describeChange(p.change, L) : `op ${opName(p.op)}`,
          preview: p.status === "open" || p.status === "queued" ? this.previewFor(p.id) : null,
        })),
      },
      frozen: frozen && { ...frozen, by: frozen.by ? (L.member(frozen.by) ?? frozen.by) : null },
      paused: this.state.paused ?? null,
      enrollments: this.org.enrollments,
      shield: {
        tests: this.state.tests.slice(-100).reverse(),
        alerts: this.state.alerts.slice(-50).reverse(),
        autoRules: (pol?.rules ?? []).filter((r) => isAutoRule(r.id)).map((r) => ({
          id: r.id, active: r.active, outcome: r.outcome, agent: r.agent ?? null,
          agentName: r.agent ? (L.agent(r.agent) ?? r.agent) : null, category: r.scope.replace(/^payment:/, ""),
          failedTest: this.state.tests.filter((t) => t.ruleId === r.id).at(-1)?.id ?? null,
        })),
        templates: TEMPLATES,
        testsPerDay: this.deps.shieldTestsPerDay ?? 0,
        windowMinutes: Math.round((this.deps.shieldWindowMs ?? 30 * 60_000) / 60_000),
      },
      learned: {
        precedents: this.state.precedents.slice(-40).reverse().map((x) => ({
          ...x, bandLabel: bandLabel(x.band),
          agentName: L.agent(x.agentId) ?? x.agentId, counterpartyName: this.org.labels.payees[x.counterparty] ?? null, byName: L.member(x.by) ?? x.by,
        })),
        suggestions: pol ? suggestions(this.state.precedents, pol.rules, pol.thresholdUsd).map((x) => ({
          ...x, bandLabel: bandLabel(x.band), agentName: L.agent(x.agentId) ?? x.agentId, counterpartyName: this.org.labels.payees[x.counterparty] ?? null,
        })) : [],
        blocks: (pol?.rules ?? []).filter((r) => r.active && r.id.startsWith("lc-")).map((r) => ({ id: r.id, agent: r.agent ?? null, agentName: r.agent ? (L.agent(r.agent) ?? r.agent) : null, target: r.target, targetName: this.org.labels.payees[r.target] ?? null })),
        allows: (pol?.rules ?? []).filter((r) => r.active && r.id.startsWith("la-")).map((r) => ({ id: r.id, agent: r.agent ?? null, agentName: r.agent ? (L.agent(r.agent) ?? r.agent) : null, target: r.target, targetName: this.org.labels.payees[r.target] ?? null, maxUsd: r.maxUsd })),
        suggestAfter: 3,
      },
      swarm: {
        traps: this.state.traps.slice(-20).reverse().map((t) => ({ ...t, agentName: t.agentId ? (L.agent(t.agentId) ?? t.agentId) : null, envFile: trapEnvFile(t) })),
        tainted: Object.entries(this.state.tainted).map(([agentId, v]) => ({ agentId, agentName: L.agent(agentId) ?? agentId, ...v })),
        trips: this.state.swarmTrips.slice(-30).reverse(),
        agentsToTrip: this.deps.swarmAgents ?? 2,
        windowSeconds: Math.round((this.deps.swarmWindowMs ?? 60_000) / 1000),
      },
      inbox: this.state.inbox.slice(-100).reverse().map((m) => {
        const t = this.state.tests.find((x) => x.messageId === m.id);
        return { ...m, test: t ? { id: t.id, status: t.status, template: t.template } : null };
      }),
      proposals: this.state.proposals.slice(-300).reverse().map((p) => ({ ...p, approvalsNeeded: this.approvalsNeeded(p) })),
      sandbox: this.sandboxView(),
      log: { length: this.log.length, head: this.log.head(), verified: v.ok, brokenAt: v.brokenAt ?? null, publicKeyPem: this.log.publicKeyPem() },
    };
  }

  logTail(limit = 200) {
    return this.log.all().slice(-limit).reverse();
  }
}

export { ConfigError };
