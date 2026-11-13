// The Gatekeeper (CLAUDE.md §1 "02 Decide", §2).
//  - Agents can only PROPOSE. They get back allowed / pending / denied / done — never a reason.
//  - Karuna computes the facts itself (price, seller, recipient) instead of trusting the agent.
//  - The policy engine decides. Every decision and event goes to the signed log.
//  - Only this process can move money, and only the exact payload a human approved.
import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  SignedLog, buildContext, defaultRules, evaluate,
  type Decision, type LogEntry, type LogEvent, type Request,
} from "@prekaruna/engine";
import {
  ConfigError, USDC_TOKEN, WALLET_CHAIN, emptyOrg, isSetUp, requireAddress, requireDomain, requireText,
  requireUsd, slugId, type AgentConfig, type OrgConfig,
} from "./config.ts";
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
  approvals: { memberId: string; at: string }[];
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

interface State {
  frozen: { at: string; by: string } | null;
  unfreezeVotes: string[];
  proposals: Proposal[];
  spend: Record<string, Record<string, number>>; // day -> agent -> usd
}

const emptyState = (): State => ({ frozen: null, unfreezeVotes: [], proposals: [], spend: {} });

export class GatekeeperError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : n.toFixed(2)}`;
const MAX_PROPOSALS_KEPT = 5000;

// ---------------------------------------------------------------- gatekeeper

export class Gatekeeper extends EventEmitter {
  org: OrgConfig;
  private state: State;
  readonly log: SignedLog;
  private executing = new Set<string>();
  private readonly now: () => Date;

  constructor(private readonly store: Store, private readonly wallet: WalletBackend, opts: { now?: () => Date } = {}) {
    super();
    this.now = opts.now ?? (() => new Date());
    this.org = store.readJson("org.json", emptyOrg);
    this.state = store.readJson("state.json", emptyState);
    this.log = SignedLog.restore(store.readLog(), store.loadOrCreateLogKeys());
  }

  // ------------------------------------------------ persistence helpers

  private save() {
    if (this.state.proposals.length > MAX_PROPOSALS_KEPT) {
      // old proposals stay in the signed log; only the working set is trimmed
      this.state.proposals = this.state.proposals.slice(-MAX_PROPOSALS_KEPT);
    }
    this.store.writeJson("org.json", this.org);
    this.store.writeJson("state.json", this.state);
    this.emit("change");
  }

  private logDecision(request: Request, decision: Decision): LogEntry {
    const e = this.log.append(request, decision, this.now());
    this.store.appendLog(e);
    return e;
  }

  private logEvent(event: LogEvent): LogEntry {
    const e = this.log.appendEvent(event, this.now());
    this.store.appendLog(e);
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

  private requireSetUp() {
    if (!isSetUp(this.org)) throw new GatekeeperError("Finish setup in the console first", 409);
  }

  private member(memberId: unknown) {
    const m = this.org.members.find((x) => x.id === memberId);
    if (!m) throw new GatekeeperError("Unknown member", 403);
    return m;
  }

  private recipient(address?: string) {
    return address ? this.org.recipients.find((r) => r.address === address.toLowerCase()) : undefined;
  }

  // ================================================================ agent side

  authenticateAgent(token: string | undefined): AgentConfig | null {
    if (!token) return null;
    const h = sha256(token);
    return this.org.agents.find((a) => a.tokenHash === h) ?? null;
  }

  async propose(agentId: string, action: AgentAction, reason?: string): Promise<AgentResponse> {
    this.requireSetUp();
    const agent = this.org.agents.find((a) => a.id === agentId);
    if (!agent) throw new GatekeeperError("Unknown agent", 401);
    const id = randomUUID();
    const base = {
      id, agentId, createdAt: this.now().toISOString(), action,
      reason: typeof reason === "string" ? reason.slice(0, 1000) : undefined, approvals: [],
    };

    // Panic button: nothing runs while frozen. Same blank denial as everything else.
    if (this.state.frozen) {
      const request: Request = { agent: agentId, tool: action.type === "action" ? action.tool : "payment" };
      const decision: Decision = { outcome: "deny", ruleId: "panic-freeze", reason: `All agents frozen by ${this.memberName(this.state.frozen.by)}` };
      this.logDecision(request, decision);
      this.state.proposals.push({ ...base, request, decision, facts: [], status: "denied" });
      this.save();
      return { id, status: "denied" };
    }

    let built: { request: Request; payload?: PaymentPayload; facts: Fact[] };
    try {
      built = await this.build(agentId, action);
    } catch (e) {
      // Malformed or un-priceable proposals fail closed, logged, with a blank answer to the agent.
      const msg = e instanceof Error ? e.message : String(e);
      const request: Request = { agent: agentId, tool: action.type === "action" ? action.tool : "payment" };
      const decision: Decision = { outcome: "deny", ruleId: "invalid-proposal", reason: msg };
      this.logDecision(request, decision);
      this.state.proposals.push({ ...base, request, decision, facts: [], status: "failed", error: msg });
      this.save();
      return { id, status: "failed" };
    }

    const decision = evaluate(built.request, buildContext(this.org, this.spentToday()), defaultRules);
    this.logDecision(built.request, decision);
    const p: Proposal = {
      ...base, request: built.request, decision, facts: built.facts, payload: built.payload,
      payloadHash: built.payload ? payloadHash(built.payload) : undefined,
      status: decision.outcome === "deny" ? "denied" : decision.outcome === "approval" ? "pending" : built.payload ? "executing" : "allowed",
    };
    if (p.payloadHash) p.facts.push({ label: "Payload hash", value: shortHash(p.payloadHash) });

    // Agent's own price ceiling (x402): never pay more than the agent itself asked for.
    if (action.type === "x402" && action.maxUsd != null && built.payload && built.payload.amountUsd > action.maxUsd) {
      p.status = "failed";
      p.error = `Seller asks ${usd(built.payload.amountUsd)}, above the agent's own limit of ${usd(action.maxUsd)}. Nothing was paid.`;
      this.logEvent({ type: "refused", proposalId: id, reason: "agent-max-exceeded" });
    }

    this.state.proposals.push(p);
    this.save();

    if (p.status === "executing") {
      await this.execute(p, { requote: false });
      return this.agentView(agentId, id)!;
    }
    return this.agentView(agentId, id)!;
  }

  /** Build the engine request + exact payload from Karuna's own lookups, not the agent's claims. */
  private async build(agentId: string, action: AgentAction): Promise<{ request: Request; payload?: PaymentPayload; facts: Fact[] }> {
    const from = this.org.wallet!.address;
    if (action.type === "x402") {
      const url = String(action.url ?? "");
      if (!/^https?:\/\//.test(url)) throw new Error("x402 url must be http(s)");
      const method = String(action.method ?? "GET").toUpperCase();
      const body = action.body === undefined ? undefined : typeof action.body === "string" ? action.body : JSON.stringify(action.body);
      const quote = await this.wallet.quoteX402(from, url, method, body);
      const rec = this.recipient(quote.seller);
      const payload: PaymentPayload = {
        kind: "x402", from, chain: WALLET_CHAIN, url, method, body, seller: quote.seller,
        amountUsd: quote.amountUsd, network: quote.network, scheme: quote.scheme, transferMethod: quote.transferMethod,
      };
      return {
        payload,
        request: { agent: agentId, tool: "payment", paymentKind: "x402", to: quote.seller, amountUsd: quote.amountUsd, category: rec?.category, url, method },
        facts: [
          { label: "Action", value: `Buy ${method} ${url}` },
          { label: "Seller", value: rec ? rec.name : "Not a known recipient", tone: rec ? undefined : "warn" },
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
      const amountUsd = requireUsd(action.amountUsd, "amountUsd", { allowZero: false });
      const rec = this.recipient(to);
      const payload: PaymentPayload = { kind: "transfer", from, chain: WALLET_CHAIN, to, amountUsd, token: USDC_TOKEN };
      return {
        payload,
        request: { agent: agentId, tool: "payment", paymentKind: "transfer", to, amountUsd, category: rec?.category },
        facts: [
          { label: "Action", value: `Send ${usd(amountUsd)} USDC` },
          { label: "Recipient", value: rec ? rec.name : "Not a known recipient", tone: rec ? undefined : "warn" },
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
      // Exact Match, lock 1: the stored payload must still hash to the decided hash.
      if (payloadHash(p.payload) !== p.payloadHash) throw new ExactMatchError("Stored payload no longer matches the approved hash.");
      const pay = p.payload;
      if (pay.kind === "x402") {
        if (requote) {
          // Exact Match, lock 2: the seller's live terms must equal what was approved.
          const q = await this.wallet.quoteX402(pay.from, pay.url, pay.method, pay.body);
          const fresh: PaymentPayload = { ...pay, seller: q.seller, amountUsd: q.amountUsd, network: q.network, scheme: q.scheme, transferMethod: q.transferMethod };
          if (payloadHash(fresh) !== p.payloadHash) {
            throw new ExactMatchError(
              q.amountUsd !== pay.amountUsd
                ? `Seller now asks ${usd(q.amountUsd)} but ${usd(pay.amountUsd)} was approved.`
                : "Seller's payment terms changed after approval.",
            );
          }
        }
        // Exact Match, lock 3: Circle refuses to pay more than the approved amount.
        const r = await this.wallet.payX402(pay.from, pay.url, pay.method, pay.body, pay.amountUsd, p.id);
        p.result = r.response;
        p.txRef = r.transaction;
      } else {
        const r = await this.wallet.transfer(pay.from, pay.to, pay.amountUsd, p.id);
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
        p.error = `Payment failed: ${e instanceof Error ? e.message : String(e)}`;
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
    const status: AgentResponse["status"] =
      p.status === "executed" ? "done" : p.status === "executing" ? "pending" : p.status;
    return status === "done" ? { id: p.id, status, result: p.result } : { id: p.id, status };
  }

  // ================================================================ console side

  private memberName(id: string) {
    return this.org.members.find((m) => m.id === id)?.name ?? id;
  }

  private configEvent(change: string, direction: "tighten" | "loosen" | "neutral", by: string | undefined, data: Record<string, unknown> = {}) {
    // `direction` marks changes that Phase 3 routes through Dharma (loosen = slow & public).
    this.logEvent({ type: "config", change, direction, by: by ?? null, ...data });
    this.save();
  }

  setup(input: { orgName: unknown; memberName: unknown; walletAddress: unknown }) {
    if (isSetUp(this.org)) throw new GatekeeperError("Already set up", 409);
    this.org.name = requireText(input.orgName, "Organization name");
    const name = requireText(input.memberName, "Your name", 40);
    this.org.wallet = { address: requireAddress(input.walletAddress, "Wallet address"), chain: WALLET_CHAIN };
    const m = { id: slugId(name, new Set()), name, createdAt: this.now().toISOString() };
    this.org.members = [m];
    this.configEvent("setup", "neutral", m.id, { org: this.org.name, wallet: this.org.wallet.address });
    return m;
  }

  addMember(name: unknown, by?: string) {
    this.requireSetUp();
    const n = requireText(name, "Name", 40);
    const m = { id: slugId(n, new Set(this.org.members.map((x) => x.id))), name: n, createdAt: this.now().toISOString() };
    this.org.members.push(m);
    this.configEvent("member-added", "neutral", by, { member: m.id });
    return m;
  }

  removeMember(id: string, by?: string) {
    if (this.org.members.length <= 1) throw new GatekeeperError("An organization needs at least one member");
    const before = this.org.members.length;
    this.org.members = this.org.members.filter((m) => m.id !== id);
    if (this.org.members.length === before) throw new GatekeeperError("Unknown member", 404);
    this.state.unfreezeVotes = this.state.unfreezeVotes.filter((v) => v !== id);
    this.configEvent("member-removed", "neutral", by, { member: id });
  }

  addAgent(input: { name: unknown; dailyAllowanceUsd: unknown }, by?: string) {
    this.requireSetUp();
    const name = requireText(input.name, "Agent name", 40);
    const allowance = requireUsd(input.dailyAllowanceUsd, "Daily allowance");
    const token = `kag_${randomBytes(24).toString("base64url")}`;
    const agent: AgentConfig = {
      id: slugId(name, new Set(this.org.agents.map((a) => a.id))), name, dailyAllowanceUsd: allowance,
      tokenHash: sha256(token), createdAt: this.now().toISOString(),
    };
    this.org.agents.push(agent);
    this.configEvent("agent-added", allowance > 0 ? "loosen" : "neutral", by, { agent: agent.id, dailyAllowanceUsd: allowance });
    return { agent: publicAgent(agent), token };
  }

  updateAgent(id: string, input: { dailyAllowanceUsd?: unknown; name?: unknown }, by?: string) {
    const a = this.org.agents.find((x) => x.id === id);
    if (!a) throw new GatekeeperError("Unknown agent", 404);
    if (input.name !== undefined) a.name = requireText(input.name, "Agent name", 40);
    if (input.dailyAllowanceUsd !== undefined) {
      const next = requireUsd(input.dailyAllowanceUsd, "Daily allowance");
      const dir = next > a.dailyAllowanceUsd ? "loosen" : next < a.dailyAllowanceUsd ? "tighten" : "neutral";
      this.logEvent({ type: "config", change: "allowance", direction: dir, by: by ?? null, agent: id, from: a.dailyAllowanceUsd, to: next });
      a.dailyAllowanceUsd = next;
    }
    this.save();
    return publicAgent(a);
  }

  rotateAgentToken(id: string, by?: string) {
    const a = this.org.agents.find((x) => x.id === id);
    if (!a) throw new GatekeeperError("Unknown agent", 404);
    const token = `kag_${randomBytes(24).toString("base64url")}`;
    a.tokenHash = sha256(token);
    this.configEvent("agent-token-rotated", "tighten", by, { agent: id });
    return { token };
  }

  removeAgent(id: string, by?: string) {
    const before = this.org.agents.length;
    this.org.agents = this.org.agents.filter((a) => a.id !== id);
    if (this.org.agents.length === before) throw new GatekeeperError("Unknown agent", 404);
    this.configEvent("agent-removed", "tighten", by, { agent: id });
  }

  addRecipient(input: { address: unknown; name: unknown; category: unknown }, by?: string) {
    this.requireSetUp();
    const address = requireAddress(input.address);
    if (this.recipient(address)) throw new GatekeeperError("That address is already a recipient", 409);
    const r = {
      address, name: requireText(input.name, "Recipient name", 60),
      category: requireText(input.category ?? "general", "Category", 30).toLowerCase(), addedAt: this.now().toISOString(),
    };
    this.org.recipients.push(r);
    this.configEvent("recipient-added", "loosen", by, { address, name: r.name, category: r.category });
    return r;
  }

  removeRecipient(address: string, by?: string) {
    const a = address.toLowerCase();
    const before = this.org.recipients.length;
    this.org.recipients = this.org.recipients.filter((r) => r.address !== a);
    if (this.org.recipients.length === before) throw new GatekeeperError("Unknown recipient", 404);
    this.configEvent("recipient-removed", "tighten", by, { address: a });
  }

  addDomain(domain: unknown, by?: string) {
    const d = requireDomain(domain);
    if (!this.org.allowlistedDomains.includes(d)) this.org.allowlistedDomains.push(d);
    this.configEvent("domain-added", "loosen", by, { domain: d });
  }

  removeDomain(domain: string, by?: string) {
    this.org.allowlistedDomains = this.org.allowlistedDomains.filter((d) => d !== domain.toLowerCase());
    this.configEvent("domain-removed", "tighten", by, { domain });
  }

  updateSettings(input: { twoPersonThresholdUsd?: unknown; orgName?: unknown }, by?: string) {
    if (input.orgName !== undefined) this.org.name = requireText(input.orgName, "Organization name");
    if (input.twoPersonThresholdUsd !== undefined) {
      const next = requireUsd(input.twoPersonThresholdUsd, "Two-person threshold");
      const dir = next > this.org.twoPersonThresholdUsd ? "loosen" : next < this.org.twoPersonThresholdUsd ? "tighten" : "neutral";
      this.logEvent({ type: "config", change: "two-person-threshold", direction: dir, by: by ?? null, from: this.org.twoPersonThresholdUsd, to: next });
      this.org.twoPersonThresholdUsd = next;
    }
    this.save();
  }

  /** Approvals needed for this proposal (Two-Person Approval). */
  approvalsNeeded(p: Proposal): number {
    const amount = p.payload?.amountUsd ?? 0;
    return amount >= this.org.twoPersonThresholdUsd && this.org.members.length >= 2 ? 2 : 1;
  }

  async approve(id: string, memberId: unknown, approvedHash: unknown) {
    const m = this.member(memberId);
    const p = this.state.proposals.find((x) => x.id === id);
    if (!p) throw new GatekeeperError("Unknown proposal", 404);
    if (p.status !== "pending") throw new GatekeeperError(`Proposal is ${p.status}`, 409);
    if (this.state.frozen) throw new GatekeeperError("Agents are frozen. Unfreeze before approving.", 409);
    if (p.payloadHash && approvedHash !== p.payloadHash) {
      // The card the human saw is not the payload on record. Refuse; never "fix it up".
      this.logEvent({ type: "exact-match-refused", proposalId: id, by: m.id, detail: "approval hash does not match payload" });
      this.save();
      throw new GatekeeperError("Exact Match failed: what you approved is not what would execute. Nothing was paid.", 409);
    }
    if (p.approvals.some((a) => a.memberId === m.id)) throw new GatekeeperError("You already approved this", 409);
    p.approvals.push({ memberId: m.id, at: this.now().toISOString() });
    this.logEvent({ type: "approved", proposalId: id, by: m.id, payloadHash: p.payloadHash ?? null, approvals: p.approvals.length, needed: this.approvalsNeeded(p) });
    if (p.approvals.length < this.approvalsNeeded(p)) {
      this.save();
      return { status: "needs-another-approval" as const };
    }
    p.resolvedBy = m.id;
    if (!p.payload) {
      p.status = "allowed";
      p.resolvedAt = this.now().toISOString();
      this.save();
      return { status: "allowed" as const };
    }
    await this.execute(p, { requote: true });
    return { status: p.status, error: p.error };
  }

  deny(id: string, memberId: unknown) {
    const m = this.member(memberId);
    const p = this.state.proposals.find((x) => x.id === id);
    if (!p) throw new GatekeeperError("Unknown proposal", 404);
    if (p.status !== "pending") throw new GatekeeperError(`Proposal is ${p.status}`, 409);
    p.status = "denied";
    p.resolvedBy = m.id;
    p.resolvedAt = this.now().toISOString();
    this.logEvent({ type: "denied-by-human", proposalId: id, by: m.id });
    this.save();
  }

  /** Panic button: any one member freezes every agent, instantly. */
  freeze(memberId: unknown) {
    const m = this.member(memberId);
    if (this.state.frozen) return;
    this.state.frozen = { at: this.now().toISOString(), by: m.id };
    this.state.unfreezeVotes = [];
    this.logEvent({ type: "freeze", by: m.id });
    this.save();
  }

  unfreezeVotesNeeded() {
    return Math.min(2, Math.max(1, this.org.members.length));
  }

  /** Unfreezing is a loosening: it needs a vote (two members when the org has two or more). */
  voteUnfreeze(memberId: unknown) {
    const m = this.member(memberId);
    if (!this.state.frozen) throw new GatekeeperError("Agents are not frozen", 409);
    if (!this.state.unfreezeVotes.includes(m.id)) this.state.unfreezeVotes.push(m.id);
    this.logEvent({ type: "unfreeze-vote", by: m.id, votes: this.state.unfreezeVotes.length, needed: this.unfreezeVotesNeeded() });
    if (this.state.unfreezeVotes.length >= this.unfreezeVotesNeeded()) {
      this.state.frozen = null;
      this.logEvent({ type: "unfreeze", voters: [...this.state.unfreezeVotes] });
      this.state.unfreezeVotes = [];
    }
    this.save();
  }

  // ------------------------------------------------ read models for the console

  snapshot() {
    const spent = this.spentToday();
    const v = this.log.verify();
    return {
      setUp: isSetUp(this.org),
      org: {
        name: this.org.name,
        wallet: this.org.wallet,
        members: this.org.members,
        agents: this.org.agents.map((a) => ({ ...publicAgent(a), spentTodayUsd: spent[a.id] ?? 0 })),
        recipients: this.org.recipients,
        allowlistedDomains: this.org.allowlistedDomains,
        twoPersonThresholdUsd: this.org.twoPersonThresholdUsd,
      },
      frozen: this.state.frozen,
      unfreezeVotes: this.state.unfreezeVotes,
      unfreezeVotesNeeded: this.unfreezeVotesNeeded(),
      proposals: this.state.proposals.slice(-300).reverse().map((p) => ({ ...p, approvalsNeeded: this.approvalsNeeded(p) })),
      log: { length: this.log.length, head: this.log.head(), verified: v.ok, brokenAt: v.brokenAt ?? null, publicKeyPem: this.log.publicKeyPem() },
    };
  }

  logTail(limit = 200) {
    return this.log.all().slice(-limit).reverse();
  }

  policy() {
    return defaultRules.map((r) => ({ id: r.id, description: r.description, outcome: r.outcome }));
  }
}

class ExactMatchError extends Error {}

const publicAgent = (a: AgentConfig) => ({ id: a.id, name: a.name, dailyAllowanceUsd: a.dailyAllowanceUsd, createdAt: a.createdAt });

export { ConfigError };
