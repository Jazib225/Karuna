// Display metadata for the Policy view, derived from the REAL engine ruleset
// (ids, descriptions, outcomes) — no duplicated logic. MATCH is the one-line
// "what it matches" text shown under each rule, as on karunaprotocol.dev.
import { defaultRules } from "./engine/rules.ts";

const MATCH: Record<string, string> = {
  "core-boundary": "shell: rm -rf / · mkfs · fork bombs",
  "secrets-read": "any: .env · *.pem · id_rsa",
  "unknown-recipient": "payment: unlisted address",
  "payment-within-allowance": "payment: known recipient, under daily cap",
  "payment-approval": "payment: anything else",
  "destructive-shell": "shell: rm -rf <path>",
  "package-install": "shell: npm / pip install",
  "human-approval-writes": "file_write: any path",
  "allowlisted-domain": "http GET: github · stripe · pypi · npm",
  "http-mutations": "http POST/PUT/DELETE: allowlisted",
  "unlisted-domain": "http: any other domain",
  "workspace-read": "shell: ls · cat · grep in ./workspace",
  "default-deny": "anything else",
};

export const CORE = new Set(["core-boundary", "secrets-read"]);

export const defaultRulesMeta = defaultRules.map((r) => ({
  id: r.id,
  description: r.description,
  outcome: r.outcome,
  match: MATCH[r.id] ?? r.description,
  core: CORE.has(r.id),
}));
