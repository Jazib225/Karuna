// Display metadata for the Policy view, derived from the REAL engine ruleset
// (ids, descriptions, outcomes) — no duplicated logic.
import { defaultRules } from "./engine/rules.ts";
export const defaultRulesMeta = defaultRules.map((r) => ({
  id: r.id,
  description: r.description,
  outcome: r.outcome,
}));
