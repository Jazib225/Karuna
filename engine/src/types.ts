// Core types for the Karuna policy engine.
// Non-negotiable: the agent only PROPOSES a Request. The engine returns a Decision.
// The agent never sees the real reason for a denial (rule 7 in CLAUDE.md §2).

export type Outcome = "allow" | "deny" | "approval";

export type Tool = "shell" | "file" | "http" | "payment" | "message";

/** Agent ids are chosen by each organization (e.g. "ap-agent"). */
export type AgentId = string;

/** Payment categories are org-defined and map to Auto-Shield block scopes, e.g. `payment:<category>`. */
export type Category = string;

/** A proposed action. The only thing an agent is allowed to emit. */
export interface Request {
  /** Which agent proposed this (used for allowances + Auto-Shield scoping). */
  agent?: AgentId;
  tool: Tool;

  // shell
  command?: string;

  // file
  path?: string;
  fileOp?: "read" | "write";

  // http
  method?: string; // GET | POST | PUT | DELETE ...
  url?: string;

  // payment
  to?: string; // recipient address (lowercased for lookup)
  amountUsd?: number;
  category?: Category;
  /** transfer = direct USDC send; x402 = paying a metered service. Set by the Gatekeeper. */
  paymentKind?: "transfer" | "x402";

  // message (agent-to-agent; checked like any other action — no hidden channel)
  body?: string;
  /** The agent a message is addressed to. */
  recipient?: AgentId;

  /**
   * Internal Auto-Shield flag. Set ONLY by Karuna's test generator, NEVER by an agent.
   * The gatekeeper strips/ignores any agent-supplied value. Used in later phases to
   * auto-block test-triggered actions before money can move.
   */
  testTag?: boolean;
}

/** Runtime facts the engine needs. Supplied by the Gatekeeper, not the agent. */
export interface PolicyContext {
  /** Bare registrable domains the org trusts, e.g. ["github.com","stripe.com"]. */
  allowlistedDomains: string[];
  /** Known payout recipients: lowercased address -> recipient info. */
  knownRecipients: Record<string, { name: string; category?: string }>;
  /** Per-agent daily spend cap in USD. */
  allowances: Record<AgentId, number>;
  /** How much each agent has already spent today, in USD. */
  spentTodayUsd: Record<AgentId, number>;
  /**
   * Trust levels (Dharma v3). When an agent has an entry, its level's payment limits replace its
   * allowance and the level's grants apply. Absent (a v2 org): allowances only, no grants.
   */
  levels?: Record<AgentId, AgentLevel>;
}

/** An agent's trust level and what it may pay without asking. */
export interface AgentLevel {
  level: number;
  perPaymentUsd: number;
  dailyUsd: number;
}

/** The engine's verdict for one request. */
export interface Decision {
  outcome: Outcome;
  /** Id of the first rule that matched. */
  ruleId: string;
  /** Human-facing explanation (Facts First). Never shown verbatim to the agent. */
  reason: string;
}

export interface Rule {
  id: string;
  description: string;
  outcome: Outcome;
  /** Predicate: does this rule apply to the request? First match wins. */
  match: (req: Request, ctx: PolicyContext) => boolean;
  /** Optional scoping metadata (used by Auto-Shield in a later phase). */
  agent?: AgentId;
  category?: string;
}
