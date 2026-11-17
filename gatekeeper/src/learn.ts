// Learns From Your Choices (Dharma case law) + Preview Before Loosening (CLAUDE.md §7).
//
// Every human approve / deny on a payment becomes a precedent. The learning is one-sided:
//   - a "no" becomes a narrow block (this agent → this counterparty) immediately, written by the
//     Gatekeeper through the same block-only path as Auto-Shield;
//   - repeated "yes" only produces a SUGGESTION ("auto-approve X up to $Y?"), which members must
//     pass through Dharma's loosening path (vote + timelock). Karuna never loosens on its own.
//
// Preview Before Loosening replays recent requests under the proposed rule set and reports what
// would have changed — including requests Karuna flagged as scams.
import { createHash } from "node:crypto";
import { buildContext, buildRuleset, evaluate, type Decision, type OnchainRule, type Request } from "@prekaruna/engine";
import type { Change } from "@prekaruna/dharma";

export interface Precedent {
  id: string;
  at: string;
  proposalId: string;
  agentId: string;
  counterparty: string; // payee address (lowercase)
  category: string | null;
  amountUsd: number;
  band: number; // upper bound of the amount band
  outcome: "approve" | "deny";
  by: string; // member address
}

export const ANY = 1e12; // "any amount" (finite so it survives JSON)
export const BANDS = [1, 10, 100, 500, 5_000, ANY];
export const band = (usd: number) => BANDS.find((b) => usd <= b)!;
export const bandLabel = (b: number) => (b >= ANY ? "any amount" : `up to $${b}`);
/** Approvals of the same agent → counterparty, amount band before Karuna suggests a rule. */
export const SUGGEST_AFTER = 3;

const h8 = (...parts: string[]) => createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 8);
export const learnedDenyId = (agentId: string, counterparty: string) => `lc-${h8(agentId, counterparty.toLowerCase())}`;
export const learnedAllowId = (agentId: string, counterparty: string, b: number) => `la-${h8(agentId, counterparty.toLowerCase(), String(b))}`;

/** The block a human "no" turns into: this agent can no longer pay this counterparty. */
export function learnedDenyRule(agentId: string, counterparty: string): Change {
  return { op: "AddRule", id: learnedDenyId(agentId, counterparty), outcome: "Deny", agent: agentId, scope: "payment", target: counterparty.toLowerCase() };
}

export interface Suggestion {
  id: string; // the rule id it would add
  agentId: string;
  counterparty: string;
  band: number;
  approvals: number;
  change: Change;
}

/**
 * Allow rules worth proposing: SUGGEST_AFTER+ approvals for the same agent, counterparty and
 * amount band, never a denial for that pair, and the band below the two-person threshold (so a
 * learned rule can never skip a second approver).
 */
export function suggestions(precedents: Precedent[], rules: OnchainRule[], thresholdUsd: number): Suggestion[] {
  const denied = new Set(precedents.filter((p) => p.outcome === "deny").map((p) => `${p.agentId}|${p.counterparty}`));
  const groups = new Map<string, Precedent[]>();
  for (const p of precedents) {
    if (p.outcome !== "approve" || denied.has(`${p.agentId}|${p.counterparty}`)) continue;
    const k = `${p.agentId}|${p.counterparty}|${p.band}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const out: Suggestion[] = [];
  for (const list of groups.values()) {
    const { agentId, counterparty, band: b } = list[0];
    if (list.length < SUGGEST_AFTER || b >= ANY || b >= thresholdUsd) continue;
    const id = learnedAllowId(agentId, counterparty, b);
    if (rules.some((r) => r.id === id && r.active)) continue;
    out.push({ id, agentId, counterparty, band: b, approvals: list.length, change: { op: "AddRule", id, outcome: "Allow", agent: agentId, scope: "payment", target: counterparty, maxUsd: b } });
  }
  return out;
}

// ------------------------------------------------------------------ Preview Before Loosening

export interface PolicyShape {
  rules: OnchainRule[];
  payees: { account: string; category: string }[];
  agents: { id: string; capUsd: number; level?: number }[];
  domains: string[];
  levelLimits?: { perPaymentUsd: number; dailyUsd: number }[] | null; // Dharma v3
}

/** The policy as it would be if `c` passed. Unknown / non-policy ops leave it unchanged. */
export function applyChange(p: PolicyShape, c: Change): PolicyShape {
  const n: PolicyShape = { rules: [...p.rules], payees: [...p.payees], agents: [...p.agents], domains: [...p.domains], levelLimits: p.levelLimits ? [...p.levelLimits] : p.levelLimits };
  switch (c.op) {
    case "AddRule":
      n.rules = n.rules.filter((r) => r.id !== c.id);
      n.rules.push({
        id: c.id, outcome: c.outcome.toLowerCase() as OnchainRule["outcome"], core: false, builtin: false, active: true,
        agent: c.agent, scope: c.scope ?? "", target: (c.target ?? "").toLowerCase(), maxUsd: c.maxUsd ?? 0,
      });
      break;
    case "RemoveRule":
      n.rules = n.rules.map((r) => (r.id === c.id && !r.core ? { ...r, active: false } : r));
      break;
    case "SetPayee":
      n.payees = [...n.payees.filter((x) => x.account.toLowerCase() !== c.account.toLowerCase()), { account: c.account.toLowerCase(), category: c.category }];
      break;
    case "RemovePayee":
      n.payees = n.payees.filter((x) => x.account.toLowerCase() !== c.account.toLowerCase());
      break;
    case "SetAgent":
      n.agents = [...n.agents.filter((a) => a.id !== c.id), { id: c.id, capUsd: c.capUsd }];
      break;
    case "RemoveAgent":
      n.agents = n.agents.filter((a) => a.id !== c.id);
      break;
    case "AddDomain":
      n.domains = [...new Set([...n.domains, c.domain.toLowerCase()])];
      break;
    case "RemoveDomain":
      n.domains = n.domains.filter((d) => d !== c.domain.toLowerCase());
      break;
    case "SetLevel":
      n.agents = n.agents.map((a) => (a.id === c.agent ? { ...a, level: c.level } : a));
      break;
    case "SetLevelLimits":
      if (n.levelLimits) n.levelLimits[c.level] = { perPaymentUsd: c.perPaymentUsd, dailyUsd: c.dailyUsd };
      break;
  }
  return n;
}

export interface PastRequest {
  proposalId: string;
  at: string;
  request: Request;
  decision: Decision; // what actually happened
  flagged: string | null; // why Karuna flagged it (scam test, changed account, trap…), if it did
}

export interface Preview {
  replayed: number;
  days: number;
  newlyAllowed: { proposalId: string; at: string; agent: string; to: string | null; amountUsd: number | null; was: string; now: string; flagged: string | null }[];
  newlyBlocked: number;
  flaggedAllowed: number;
}

/** Replay recent requests (oldest first, tracking each agent's daily spend) under both rule sets. */
export function previewLoosening(
  before: PolicyShape, change: Change, history: PastRequest[], payeeName: (a: string) => string, days = 7, now = Date.now(),
): Preview {
  const after = applyChange(before, change);
  const since = now - days * 86_400_000;
  const recent = history.filter((h) => Date.parse(h.at) >= since && (h.request.tool === "payment" || h.request.tool === "http")).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const ctxOf = (p: PolicyShape, spent: Record<string, number>) =>
    buildContext({
      agents: p.agents.map((a) => ({ id: a.id, dailyAllowanceUsd: a.capUsd, level: a.level })),
      recipients: p.payees.map((x) => ({ address: x.account, name: payeeName(x.account), category: x.category })),
      allowlistedDomains: p.domains,
      levelLimits: p.levelLimits ?? undefined,
    }, spent);
  const rulesAfter = buildRuleset(after.rules);
  const rulesBefore = buildRuleset(before.rules);
  const spentAfter = new Map<string, Record<string, number>>(); // day → agent → usd
  const out: Preview = { replayed: 0, days, newlyAllowed: [], newlyBlocked: 0, flaggedAllowed: 0 };
  for (const h of recent) {
    const day = h.at.slice(0, 10);
    const s = spentAfter.get(day) ?? {};
    spentAfter.set(day, s);
    const req = { ...h.request };
    // Re-derive the category from the policy under test (a new payee changes it).
    if (req.tool === "payment" && req.to) req.category = after.payees.find((x) => x.account.toLowerCase() === req.to!.toLowerCase())?.category ?? req.category;
    const nowDecision = evaluate(req, ctxOf(after, s), rulesAfter);
    const wasDecision = h.flagged ? h.decision : evaluate({ ...h.request }, ctxOf(before, s), rulesBefore);
    out.replayed++;
    const agent = req.agent ?? "";
    if (nowDecision.outcome === "allow" && req.tool === "payment") s[agent] = (s[agent] ?? 0) + (req.amountUsd ?? 0);
    // "Gets further" = deny → approval/allow, or approval → allow. A scam that would now reach a
    // human's approval queue instead of being blocked counts: that's exactly what loosening risks.
    const rank = { deny: 0, approval: 1, allow: 2 } as const;
    const was = rank[wasDecision.outcome], now = rank[nowDecision.outcome];
    if (now > was) {
      out.newlyAllowed.push({ proposalId: h.proposalId, at: h.at, agent, to: req.to ?? req.url ?? null, amountUsd: req.amountUsd ?? null, was: wasDecision.outcome, now: nowDecision.outcome, flagged: h.flagged });
      if (h.flagged) out.flaggedAllowed++;
    } else if (now < was) out.newlyBlocked++;
  }
  return out;
}

/** Only loosenings get a preview (tightenings apply at once and can only allow less). */
export const LOOSENING_OPS = new Set(["AddRule", "RemoveRule", "SetPayee", "SetAgent", "AddDomain", "SetThreshold", "Unfreeze", "SetLevel", "SetLevelLimits"]);

/** Whether a change can let anything new through. A rule that only blocks never can, so it gets no
 *  "Preview before loosening" (an approval rule can: it may turn a default block into a card). */
export function isLoosening(change: Change): boolean {
  if (!LOOSENING_OPS.has(change.op)) return false;
  return !(change.op === "AddRule" && change.outcome === "Deny");
}
