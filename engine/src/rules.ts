// The default policy: the 12 website rules (CLAUDE.md §1) + Maya's Bakery rules.
// Rules are evaluated in order; the FIRST matching rule decides (CLAUDE.md §1).
import type { Rule, Request, PolicyContext } from "./types.ts";

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

  // (bakery) payment-within-allowance — known recipient, still inside the agent's daily cap.
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
      return spent + r.amountUsd <= cap;
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

// Maya's Bakery defaults (CLAUDE.md §3). The Gatekeeper supplies real values at runtime.
export const bakeryContext = (
  overrides: Partial<PolicyContext> = {},
): PolicyContext => ({
  allowlistedDomains: ["github.com", "stripe.com", "pypi.org", "npmjs.com"],
  knownRecipients: {
    "0xgoldenmills": { name: "Golden Mills (flour)" },
    "0xcityutilities": { name: "City Utilities" },
  },
  allowances: { bills: 50, supplies: 10, research: 2 },
  spentTodayUsd: {},
  ...overrides,
});
