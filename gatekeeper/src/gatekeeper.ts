// The Gatekeeper (CLAUDE.md §1 "02 Decide", §2).
//  - Agents can only PROPOSE. They get back allowed / pending / denied / done — never a reason.
//  - Karuna computes the facts itself (price, seller, recipient) instead of trusting the agent.
//  - The org's POLICY lives in Dharma onchain. The Gatekeeper reads it, and relays members'
//    signed actions to it; it cannot loosen anything on its own (Dharma refuses).
//  - Every decision and event goes to the signed log, which is anchored on Dharma.
//  - Only this process can move money, and only the exact payload a human approved.
import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { keccak256, stringToHex, verifyTypedData, type Address, type Hex, type PublicClient } from "viem";
import {
  SignedLog, buildContext, buildRuleset, evaluate,
  type Decision, type LogEntry, type LogEvent, type Request,
} from "@prekaruna/engine";
import {
  DHARMA_ABI, Kind, actionTypedData, decodeChange, describeChange, opName, paymentDecisionTypedData, toBytes32, toMicro,
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

// ---------------------------------------------------------------- types

/** What an agent may submit. Everything else about the action is computed by Karuna. */
export type AgentAction =
  | { type: "x402"; url: string; method?: string; body?: unknown; maxUsd?: number }
  | { type: "transfer"; to: string; amountUsd: number }
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
  proposals: Proposal[];
  spend: Record<string, Record<string, number>>; // day -> agent -> usd
  localFreeze: { at: string; by: string } | null; // panic applied before the chain confirmed it
  lastFreeze?: { at: string; by: string } | null; // who froze, once the chain confirmed it
}

const emptyState = (): State => ({ proposals: [], spend: {}, localFreeze: null });

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
  timelockSeconds?: number; // for new Dharma deployments
  anchorEvery?: number; // anchor the log after this many new entries…
  anchorMaxAgeMs?: number; // …or when unanchored entries are this old
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const usd = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : n.toFixed(2)}`;
const lower = (a: string) => a.toLowerCase();
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
  private executing = new Set<string>();
  private writes: Promise<unknown> = Promise.resolve();
  private executeTried = new Map<number, number>();
  private lastAnchorTry = 0;
  private lastSyncKey = "";
  private lastFingerprint = "";
  private lastFullRead = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;

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
    for (let w = this.writes; ; w = this.writes) {
      await w;
      if (w === this.writes) return;
    }
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
  }

  /** Anyone may execute a passed proposal after its timelock; the Gatekeeper does it promptly. */
  private async executeReady() {
    const p = this.policy;
    if (!p) return;
    for (const prop of p.proposals) {
      if (prop.status !== "queued" || prop.eta === null || prop.eta > p.chainTime) continue;
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
      const d = await this.deps.writerFor(wallet as Address).deploy({
        firstMember: member as Address, timelockSeconds: timelock, thresholdMicro: toMicro(500), domains: DEFAULT_ALLOWLISTED_DOMAINS,
      });
      this.org.name = name;
      this.org.wallet = { address: wallet, chain: WALLET_CHAIN };
      this.org.dharma = { address: lower(d.address), chainId: await this.deps.client.getChainId(), deployedAt: this.now().toISOString(), txRef: d.txRef };
      this.org.labels.members[member] = memberName;
      this.logEvent({ type: "setup", dharma: lower(d.address), wallet, firstMember: member, timelockSeconds: timelock, txRef: d.txRef });
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
    if (!token) return null;
    const h = sha256(token);
    return Object.entries(this.org.agentTokens).find(([, v]) => v === h)?.[0] ?? null;
  }

  async propose(agentId: string, action: AgentAction, reason?: string): Promise<AgentResponse> {
    const policy = this.requireReady();
    if (!policy.agents.some((a) => a.id === agentId)) throw new GatekeeperError("This agent is not active in Dharma yet", 403);
    const id = randomUUID();
    const base = {
      id, agentId, createdAt: this.now().toISOString(), action,
      reason: typeof reason === "string" ? reason.slice(0, 1000) : undefined, approvals: [],
    };

    // Panic button: nothing runs while frozen. Same blank denial as everything else.
    const frozen = this.isFrozen();
    if (frozen) {
      const request: Request = { agent: agentId, tool: action.type === "action" ? action.tool : "payment" };
      const decision: Decision = { outcome: "deny", ruleId: "panic-freeze", reason: "All agents are frozen" };
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

  agentView(agentId: string, proposalId: string): AgentResponse | null {
    const p = this.state.proposals.find((x) => x.id === proposalId && x.agentId === agentId);
    if (!p) return null;
    const status: AgentResponse["status"] = p.status === "executed" ? "done" : p.status === "executing" ? "pending" : p.status;
    return status === "done" ? { id: p.id, status, result: p.result } : { id: p.id, status };
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
    if (!p.payload) {
      p.status = "allowed";
      p.resolvedAt = this.now().toISOString();
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
        })),
      },
      frozen: frozen && { ...frozen, by: frozen.by ? (L.member(frozen.by) ?? frozen.by) : null },
      enrollments: this.org.enrollments,
      proposals: this.state.proposals.slice(-300).reverse().map((p) => ({ ...p, approvalsNeeded: this.approvalsNeeded(p) })),
      log: { length: this.log.length, head: this.log.head(), verified: v.ok, brokenAt: v.brokenAt ?? null, publicKeyPem: this.log.publicKeyPem() },
    };
  }

  logTail(limit = 200) {
    return this.log.all().slice(-limit).reverse();
  }
}

export { ConfigError };
