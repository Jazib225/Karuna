// Product domain for the Karuna Console (Maya's Bakery).
// The decision feed and approval queue are produced by the REAL Phase 1 engine,
// not hardcoded verdicts — so the console shows exactly what the policy decides.
import { evaluate } from "./engine/engine.ts";
import { bakeryContext } from "./engine/rules.ts";
import type { AgentId, Decision, Outcome, Request } from "./engine/types.ts";

export type { AgentId, Outcome, Request, Decision };

export interface AgentView {
  id: AgentId;
  name: string;
  emoji: string;
  job: string;
  spentToday: number;
  cap: number;
}

export const SUPPLIERS: Record<string, { name: string; account: string }> = {
  "0xgoldenmills": { name: "Golden Mills", account: "0xGold…M1LL" },
  "0xcityutilities": { name: "City Utilities", account: "0xC1ty…UT1L" },
};

export const AGENTS: AgentView[] = [
  { id: "bills", name: "Bills agent", emoji: "🧾", job: "Pays supplier invoices", spentToday: 12.4, cap: 50 },
  { id: "supplies", name: "Supplies agent", emoji: "🛒", job: "Buys data & tools", spentToday: 7.05, cap: 10 },
  { id: "research", name: "Research agent", emoji: "🔎", job: "Looks things up", spentToday: 0.35, cap: 2 },
];

export const spentMap = (): Partial<Record<AgentId, number>> =>
  Object.fromEntries(AGENTS.map((a) => [a.id, a.spentToday])) as Partial<Record<AgentId, number>>;

export const ctx = () => bakeryContext({ spentTodayUsd: spentMap() });

/** Tiny synchronous hash for display (FNV-1a) — real log uses ed25519 in the engine. */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0") + Math.imul(h ^ input.length, 0x85ebca6b).toString(16).replace("-", "").slice(0, 8).padStart(8, "0");
  return `${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

export interface FeedItem {
  id: string;
  at: number;
  agent: AgentId;
  label: string; // human-readable action
  request: Request;
  decision: Decision;
  hash: string;
  // payment facts (when tool === payment)
  amountUsd?: number;
  to?: string;
  category?: string;
  justification?: string; // the agent's (untrusted) reason
}

let counter = 0;
export function decide(
  agent: AgentId,
  request: Request,
  label: string,
  justification?: string,
  at = Date.now(),
): FeedItem {
  const req = { ...request, agent };
  const decision = evaluate(req, ctx());
  const id = `f${counter++}`;
  return {
    id,
    at,
    agent,
    label,
    request: req,
    decision,
    hash: shortHash(id + label + decision.ruleId),
    amountUsd: req.amountUsd,
    to: req.to,
    category: req.category,
    justification,
  };
}

// The scripted morning at Maya's Bakery. Each line is evaluated by the engine.
const now = Date.now();
const m = (mins: number) => now - mins * 60_000;

export const INITIAL_FEED: FeedItem[] = [
  decide("supplies", { tool: "http", method: "GET", url: "https://api.stripe.com/v1/balance" }, "GET api.stripe.com/v1/balance", "Checking the account balance before buying.", m(42)),
  decide("supplies", { tool: "payment", to: "0xgoldenmills", amountUsd: 0.05, category: "data" }, "Buy flour price feed — $0.05", "Daily flour price update from Golden Mills' feed.", m(38)),
  decide("bills", { tool: "payment", to: "0xcityutilities", amountUsd: 30, category: "utilities" }, "Pay City Utilities — $30.00", "Monthly water bill, same as last month.", m(30)),
  decide("research", { tool: "http", method: "GET", url: "https://unknown-data.example.com/q" }, "GET unknown-data.example.com", "Found a cheaper data source online.", m(22)),
  decide("bills", { tool: "payment", to: "0xgoldenmills", amountUsd: 920, category: "supplies" }, "Pay Golden Mills invoice — $920.00", "Invoice #4471 for this week's flour delivery. Due today.", m(14)),
  decide("supplies", { tool: "payment", to: "0xnewvendor", amountUsd: 25, category: "supplies" }, "Pay NewVendor — $25.00", "New supplier offered a discount on packaging.", m(9)),
  decide("supplies", { tool: "payment", to: "0xgoldenmills", amountUsd: 6, category: "supplies" }, "Buy extra flour sample — $6.00", "One-off sample pack to test a new flour blend.", m(4)),
];

// Routine proposals the live ticker draws from (all small + allowed), to keep the feed alive.
export const TICKER: { agent: AgentId; request: Request; label: string; why: string }[] = [
  { agent: "research", request: { tool: "shell", command: "ls ./workspace" }, label: "ls ./workspace", why: "Listing today's task files." },
  { agent: "supplies", request: { tool: "http", method: "GET", url: "https://api.stripe.com/v1/prices" }, label: "GET api.stripe.com/v1/prices", why: "Refreshing price list." },
  { agent: "supplies", request: { tool: "payment", to: "0xgoldenmills", amountUsd: 0.05, category: "data" }, label: "Flour price feed — $0.05", why: "Scheduled price update." },
  { agent: "research", request: { tool: "http", method: "GET", url: "https://github.com/karuna-protocol" }, label: "GET github.com/karuna-protocol", why: "Reading docs." },
];
