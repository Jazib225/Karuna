// The default policy: the 12 website rules (CLAUDE.md §1) + the per-agent allowance rule.
// Organization-specific values (agents, allowances, payees, domains) come from buildContext().
// Rules are evaluated in order; the FIRST matching rule decides (CLAUDE.md §1).
import type { Outcome, Rule, Request, PolicyContext } from "./types.ts";

// --- helpers ---------------------------------------------------------------

const cmd = (r: Request) => (r.command ?? "").trim();

/** Pull the registrable domain out of a URL, e.g. api.stripe.com -> stripe.com. */
export function registrableDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split(".");
    return parts.length <= 2 ? host : parts.slice(-2).join(".");
  } catch {
    return null;
  }
}

function isAllowlisted(url: string, ctx: PolicyContext): boolean {
  const d = registrableDomain(url);
  return !!d && ctx.allowlistedDomains.map((x) => x.toLowerCase()).includes(d);
}

function touchesSecret(r: Request): boolean {
  const hay = `${r.path ?? ""} ${cmd(r)}`.toLowerCase();
  return /(^|[\s/"'=(])\.env(\b|["')])/.test(hay) || /\.pem\b/.test(hay) || /\bid_rsa\b/.test(hay);
}

const RM_RF_ROOT = /\brm\s+(-[a-z]*\s+)*-?[a-z]*\s*(-rf|-fr|-r\s+-f|-f\s+-r)\s+\/(\s|$|\*)/i;
const RM_RF_ANY = /\brm\s+-[a-z]*r[a-z]*f?|rm\s+-[a-z]*f[a-z]*r/i; // rm with both r and f flags
const FORKBOMB = /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;
const MKFS = /\bmkfs(\.\w+)?\b/i;
const PKG_INSTALL = /\b(npm|pnpm|yarn)\s+(install|add|i)\b|\bpip3?\s+install\b/i;
const WORKSPACE_READ = /^(ls|cat|grep)\b/i;

// --- the ruleset -----------------------------------------------------------

export const defaultRules: Rule[] = [
  // 1. core-boundary — catastrophic shell. Can NEVER be removed (Dharma core boundary).
  {
    id: "core-boundary",
    description: "Catastrophic shell commands (rm -rf /, mkfs, fork bombs)",
    outcome: "deny",
    match: (r) =>
      r.tool === "shell" &&
      (RM_RF_ROOT.test(cmd(r)) || MKFS.test(cmd(r)) || FORKBOMB.test(cmd(r))),
  },

  // 2. secrets-read — anything that reads credentials.
  {
    id: "secrets-read",
    description: "Reading secrets (.env, *.pem, id_rsa)",
    outcome: "deny",
    match: (r) => (r.tool === "shell" || r.tool === "file") && touchesSecret(r),
  },

  // 3. unknown-recipient — payment to an address we don't know.
  {
    id: "unknown-recipient",
    description: "Payment to an unlisted recipient",
    outcome: "deny",
    match: (r, ctx) =>
      r.tool === "payment" &&
      !!r.to &&
      !ctx.knownRecipients[r.to.toLowerCase()],
  },

  // payment-within-allowance — known recipient, still inside the agent's daily cap.
  // Must come before the generic payment-approval so routine spend flows without asking.
  {
    id: "payment-within-allowance",
    description: "Known recipient and within the agent's daily allowance",
    outcome: "allow",
    match: (r, ctx) => {
      if (r.tool !== "payment" || !r.to || r.amountUsd == null) return false;
      if (!ctx.knownRecipients[r.to.toLowerCase()]) return false;
      if (!r.agent) return false;
      const cap = ctx.allowances[r.agent];
      if (cap == null) return false;
      const spent = ctx.spentTodayUsd[r.agent] ?? 0;
      return Math.round((spent + r.amountUsd) * 1e6) <= Math.round(cap * 1e6);
    },
  },

  // 4. payment-approval — any other payment (over budget, no agent, etc.) asks a human.
  {
    id: "payment-approval",
    description: "Payment that needs a human to approve",
    outcome: "approval",
    match: (r) => r.tool === "payment",
  },

  // 5. destructive-shell — rm -rf on a path (not root; root was denied above).
  {
    id: "destructive-shell",
    description: "Destructive shell command (rm -rf <path>)",
    outcome: "approval",
    match: (r) => r.tool === "shell" && RM_RF_ANY.test(cmd(r)),
  },

  // 6. package-install — installing packages.
  {
    id: "package-install",
    description: "Installing packages (npm/pnpm/yarn/pip install)",
    outcome: "approval",
    match: (r) => r.tool === "shell" && PKG_INSTALL.test(cmd(r)),
  },

  // 7. human-approval-writes — any file write.
  {
    id: "human-approval-writes",
    description: "Writing to any file path",
    outcome: "approval",
    match: (r) => r.tool === "file" && r.fileOp === "write",
  },

  // 8. allowlisted-domain — read-only HTTP to a trusted domain.
  {
    id: "allowlisted-domain",
    description: "HTTP GET to an allowlisted domain",
    outcome: "allow",
    match: (r, ctx) =>
      r.tool === "http" &&
      (r.method ?? "GET").toUpperCase() === "GET" &&
      !!r.url &&
      isAllowlisted(r.url, ctx),
  },

  // 9. http-mutations — writes to a trusted domain need approval.
  {
    id: "http-mutations",
    description: "HTTP POST/PUT/DELETE to an allowlisted domain",
    outcome: "approval",
    match: (r, ctx) =>
      r.tool === "http" &&
      ["POST", "PUT", "DELETE", "PATCH"].includes((r.method ?? "").toUpperCase()) &&
      !!r.url &&
      isAllowlisted(r.url, ctx),
  },

  // 10. unlisted-domain — any other HTTP is denied.
  {
    id: "unlisted-domain",
    description: "HTTP to a domain that is not allowlisted",
    outcome: "deny",
    match: (r) => r.tool === "http",
  },

  // 11. workspace-read — safe reads inside ./workspace.
  {
    id: "workspace-read",
    description: "Reading inside ./workspace (ls, cat, grep)",
    outcome: "allow",
    match: (r) => {
      if (r.tool !== "shell" || !WORKSPACE_READ.test(cmd(r))) return false;
      const c = cmd(r);
      // bare `ls` is fine; otherwise it must stay inside ./workspace
      if (/^ls\s*$/i.test(c)) return true;
      return /(^|\s)(\.\/)?workspace(\/|\s|$)/i.test(c);
    },
  },

  // 12. default-deny — anything not matched above.
  {
    id: "default-deny",
    description: "Nothing else matched",
    outcome: "deny",
    match: () => true,
  },
];

// Karuna's default allowlist (website rule 8). Organizations can add or remove domains.
export const DEFAULT_ALLOWLISTED_DOMAINS = ["github.com", "stripe.com", "pypi.org", "npmjs.com"];

/** The policy-relevant slice of an organization's configuration. */
export interface OrgPolicyConfig {
  agents: { id: string; dailyAllowanceUsd: number }[];
  recipients: { address: string; name: string; category?: string }[];
  allowlistedDomains: string[];
}

/** Build the engine context from an org's config plus today's spend. No built-in data. */
export function buildContext(cfg: OrgPolicyConfig, spentTodayUsd: Record<string, number> = {}): PolicyContext {
  return {
    allowlistedDomains: cfg.allowlistedDomains.map((d) => d.toLowerCase()),
    knownRecipients: Object.fromEntries(
      cfg.recipients.map((r) => [r.address.toLowerCase(), { name: r.name, category: r.category }]),
    ),
    allowances: Object.fromEntries(cfg.agents.map((a) => [a.id, a.dailyAllowanceUsd])),
    spentTodayUsd: { ...spentTodayUsd },
  };
}

// ---------------------------------------------------------------- Dharma (onchain policy)

/** A rule as stored in the Dharma contract. */
export interface OnchainRule {
  id: string;
  outcome: Outcome;
  core: boolean;
  builtin: boolean;
  active: boolean;
  agent?: string; // undefined = every agent
  scope: string; // custom rules: "payment", "payment:<category>", "http"
  target: string; // payee address or domain ("" = any)
  maxUsd: number; // custom allow rules: upper bound (0 = none)
}

/** A custom (non-default) Dharma rule as an engine rule. Unknown scopes never match. */
export function customRule(r: OnchainRule): Rule {
  const [kind, sub] = r.scope.split(":");
  const target = r.target.toLowerCase();
  const what = `${r.scope}${r.target ? ` → ${r.target}` : ""}${r.agent ? ` for ${r.agent}` : ""}`;
  return {
    id: r.id,
    outcome: r.outcome,
    agent: r.agent,
    category: r.scope,
    description:
      r.outcome === "deny" ? `Blocked by Dharma rule: ${what}` : r.outcome === "approval" ? `Dharma rule requires approval: ${what}` : `Allowed by Dharma rule: ${what}`,
    match: (req) => {
      if (r.agent && req.agent !== r.agent) return false;
      if (kind === "payment") {
        if (req.tool !== "payment") return false;
        if (sub && (req.category ?? "").toLowerCase() !== sub.toLowerCase()) return false;
        if (target && (req.to ?? "").toLowerCase() !== target) return false;
        if (r.outcome === "allow" && r.maxUsd > 0 && (req.amountUsd ?? Infinity) > r.maxUsd) return false;
        return true;
      }
      if (kind === "http") {
        if (req.tool !== "http" || !req.url) return false;
        return !target || registrableDomain(req.url) === target;
      }
      return false;
    },
  };
}

/**
 * The engine's ordered ruleset for an org, from its Dharma rules. First match wins:
 *   1. core-boundary, secrets-read           (core, always)
 *   2. custom deny rules                     (blocks beat everything below)
 *   3. unknown-recipient                     (core, always)
 *   4. custom approval rules, then custom allow rules
 *   5. every other default rule still active (in default order; default-deny is core, always last)
 * Core rules apply even if the chain somehow reported them inactive: fail closed.
 */
export function buildRuleset(onchain: OnchainRule[]): Rule[] {
  const byId = new Map(onchain.map((r) => [r.id, r]));
  const builtinActive = (id: string) => {
    const r = byId.get(id);
    return !r || r.active || r.core; // unknown to the chain → keep (fail closed)
  };
  const custom = onchain.filter((r) => !r.builtin && r.active).map(customRule);
  const pick = (id: string) => defaultRules.find((r) => r.id === id)!;
  const head = ["core-boundary", "secrets-read"].map(pick);
  const rest = defaultRules.filter((r) => !["core-boundary", "secrets-read", "unknown-recipient"].includes(r.id) && builtinActive(r.id));
  return [
    ...head,
    ...custom.filter((r) => r.outcome === "deny"),
    pick("unknown-recipient"),
    ...custom.filter((r) => r.outcome === "approval"),
    ...custom.filter((r) => r.outcome === "allow"),
    ...rest,
  ];
}
