// Agent-side Karuna client.
// This is everything an agent gets: the Gatekeeper's URL and its own agent token (an identity,
// not a credential to anything else). It cannot hold a wallet, sign, or pay. It can only
// propose an action and later read whether it was allowed — never why it was denied.

export type Status = "done" | "allowed" | "pending" | "denied" | "failed";

export interface ProposalResult {
  id: string;
  status: Status;
  result?: unknown;
}

export type Action =
  | { type: "x402"; url: string; method?: string; body?: unknown; maxUsd?: number; sourceMessageId?: string }
  | { type: "transfer"; to: string; amountUsd: number; payeeName?: string; sourceMessageId?: string }
  | { type: "action"; tool: "shell" | "file" | "http" | "message"; command?: string; path?: string; fileOp?: "read" | "write"; method?: string; url?: string; body?: string };

/** A message in this agent's inbox (invoices, emails). */
export interface Message {
  id: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
}

export class KarunaAgent {
  constructor(private readonly opts: { gatekeeperUrl: string; token: string }) {
    if (!opts.gatekeeperUrl || !opts.token) throw new Error("gatekeeperUrl and token are required");
  }

  private async call(path: string, init?: RequestInit): Promise<ProposalResult> {
    const res = await fetch(new URL(path, this.opts.gatekeeperUrl), {
      ...init,
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
    });
    const body = (await res.json().catch(() => ({}))) as ProposalResult & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `Gatekeeper returned ${res.status}`);
    return body;
  }

  /** Propose any action. */
  propose(action: Action, reason?: string): Promise<ProposalResult> {
    return this.call("/v1/proposals", { method: "POST", body: JSON.stringify({ action, reason }) });
  }

  /** Ask Karuna to buy from an x402 service. The Gatekeeper pays; you get the response. */
  buy(url: string, opts: { method?: string; body?: unknown; maxUsd?: number; reason?: string } = {}) {
    return this.propose({ type: "x402", url, method: opts.method, body: opts.body, maxUsd: opts.maxUsd }, opts.reason);
  }

  /**
   * Ask Karuna to send USDC to a recipient. Name the payee you believe this is, and cite the inbox
   * message you're acting on: Karuna checks the name against the account on file.
   */
  pay(to: string, amountUsd: number, reason?: string, opts: { payeeName?: string; sourceMessageId?: string } = {}) {
    return this.propose({ type: "transfer", to, amountUsd, ...opts }, reason);
  }

  /** This agent's inbox, newest first. */
  async inbox(): Promise<Message[]> {
    const r = await fetch(new URL("/v1/inbox", this.opts.gatekeeperUrl), { headers: { authorization: `Bearer ${this.opts.token}` } });
    const body = (await r.json().catch(() => ({}))) as { messages?: Message[]; error?: string };
    if (!r.ok) throw new Error(body.error ?? `Gatekeeper returned ${r.status}`);
    return body.messages ?? [];
  }

  /** Flag a message as suspicious instead of acting on it. */
  async report(messageId: string, reason?: string): Promise<void> {
    const r = await fetch(new URL(`/v1/inbox/${encodeURIComponent(messageId)}/report`, this.opts.gatekeeperUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    if (!r.ok) throw new Error(`Gatekeeper returned ${r.status}`);
  }

  status(id: string): Promise<ProposalResult> {
    return this.call(`/v1/proposals/${encodeURIComponent(id)}`);
  }

  /** Wait for a pending proposal (e.g. one a human must approve) to resolve. */
  async wait(id: string, { timeoutMs = 10 * 60_000, pollMs = 2_000 } = {}): Promise<ProposalResult> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.status(id);
      if (r.status !== "pending" || Date.now() > end) return r;
      await new Promise((ok) => setTimeout(ok, pollMs));
    }
  }
}
