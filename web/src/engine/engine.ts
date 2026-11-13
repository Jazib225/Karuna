// The deterministic first-match engine. Pure function: request in -> decision out.
import type { Decision, PolicyContext, Request, Rule } from "./types.ts";
import { defaultRules } from "./rules.ts";

/**
 * Evaluate a proposed request against an ordered ruleset.
 * The FIRST matching rule decides (CLAUDE.md §1). Deterministic and side-effect free.
 */
export function evaluate(
  req: Request,
  ctx: PolicyContext,
  rules: Rule[] = defaultRules,
): Decision {
  for (const rule of rules) {
    let matched = false;
    try {
      matched = rule.match(req, ctx);
    } catch {
      // A throwing predicate must never silently allow; skip to the next rule.
      matched = false;
    }
    if (matched) {
      return { outcome: rule.outcome, ruleId: rule.id, reason: rule.description };
    }
  }
  // defaultRules always ends in default-deny, but fail closed if a caller omits it.
  return { outcome: "deny", ruleId: "no-match", reason: "No rule matched; failing closed" };
}

/**
 * What the AGENT is told. Always the same blank denial, regardless of the real reason
 * (CLAUDE.md §2 rule 7) — so it can't learn which wording gets through. "approval" and
 * "allow" pass through; only the reason is withheld.
 */
export function agentFacingResult(d: Decision): { outcome: Decision["outcome"] } {
  return { outcome: d.outcome };
}
