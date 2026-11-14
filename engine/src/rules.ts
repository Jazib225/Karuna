// The default policy: the 12 website rules (CLAUDE.md §1) + the per-agent allowance rule.
// Organization-specific values (agents, allowances, payees, domains) come from buildContext().
// Rules are evaluated in order; the FIRST matching rule decides (CLAUDE.md §1).
import type { AgentLevel, Outcome, Rule, Request, PolicyContext } from "./types.ts";

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
      // A trust level (Dharma v3) sets both limits: per payment and per day.
      const lvl = ctx.levels?.[r.agent];
      if (lvl && Math.round(r.amountUsd * 1e6) > Math.round(lvl.perPaymentUsd * 1e6)) return false;
      const cap = lvl ? lvl.dailyUsd : ctx.allowances[r.agent];
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
  /** `level` is set on Dharma v3 orgs; then `levelLimits` says what each level may pay. */
  agents: { id: string; dailyAllowanceUsd: number; level?: number }[];
  recipients: { address: string; name: string; category?: string }[];
  allowlistedDomains: string[];
  levelLimits?: { perPaymentUsd: number; dailyUsd: number }[];
}

// ---------------------------------------------------------------- trust levels (Dharma v3)

/** At or above `min`, an agent may do this without asking, unless a core rule or the org's own
 *  block or approval rule says otherwise (those come first). The same ladder for every org. */
export const LEVEL_GRANTS: { id: string; min: number; what: string }[] = [
  { id: "level-messages", min: 1, what: "Messages to other agents" },
  { id: "level-workspace-writes", min: 1, what: "File writes in ./workspace" },
  { id: "level-http-mutations", min: 2, what: "POST/PUT/DELETE to allowlisted domains" },
  { id: "level-package-install", min: 2, what: "Package installs" },
  { id: "level-file-writes", min: 3, what: "File writes anywhere in the sandbox" },
];

const levelOf = (r: Request, ctx: PolicyContext): AgentLevel | undefined => (r.agent ? ctx.levels?.[r.agent] : undefined);
const minFor = (id: string) => LEVEL_GRANTS.find((g) => g.id === id)!.min;
const atLeast = (r: Request, ctx: PolicyContext, id: string) => (levelOf(r, ctx)?.level ?? -1) >= minFor(id);
const inWorkspace = (p: string) => /^(\.\/)?workspace(\/|$)/i.test(p.trim().replace(/\\/g, "/"));

/** The level grants as engine rules (allow). They match only agents that have a level. */
export const levelRules: Rule[] = [
  {
    id: "level-workspace-writes",
    description: `Level ${minFor("level-workspace-writes")}+: file writes in ./workspace`,
    outcome: "allow",
    match: (r, ctx) => r.tool === "file" && r.fileOp === "write" && inWorkspace(r.path ?? "") && atLeast(r, ctx, "level-workspace-writes"),
  },
  {
    id: "level-file-writes",
    description: `Level ${minFor("level-file-writes")}+: file writes anywhere in the sandbox`,
    outcome: "allow",
    match: (r, ctx) => r.tool === "file" && r.fileOp === "write" && atLeast(r, ctx, "level-file-writes"),
  },
  {
    id: "level-http-mutations",
    description: `Level ${minFor("level-http-mutations")}+: POST/PUT/DELETE to allowlisted domains`,
    outcome: "allow",
    match: (r, ctx) =>
      r.tool === "http" &&
      ["POST", "PUT", "DELETE", "PATCH"].includes((r.method ?? "").toUpperCase()) &&
      !!r.url &&
      isAllowlisted(r.url, ctx) &&
      atLeast(r, ctx, "level-http-mutations"),
  },
  {
    id: "level-package-install",
    description: `Level ${minFor("level-package-install")}+: package installs`,
    outcome: "allow",
    match: (r, ctx) => r.tool === "shell" && PKG_INSTALL.test(cmd(r)) && !RM_RF_ANY.test(cmd(r)) && atLeast(r, ctx, "level-package-install"),
  },
];

/**
 * Agent-to-agent messages that no rule of the org's own covers: on a levels org, Level 0 needs
 * approval and Level 1+ is delivered. Null = no level opinion (a v2 org: delivered, as before).
 */
export function messageLevelDecision(req: Request, ctx: PolicyContext): { outcome: Outcome; ruleId: string; reason: string } | null {
  const lvl = levelOf(req, ctx);
  if (!lvl) return null;
  const min = minFor("level-messages");
  return lvl.level >= min
    ? { outcome: "allow", ruleId: "level-messages", reason: `Level ${min}+: messages to other agents` }
    : { outcome: "approval", ruleId: "level-messages", reason: `Level ${lvl.level}: messages to other agents need approval` };
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
    ...(cfg.levelLimits
      ? {
          levels: Object.fromEntries(
            cfg.agents.map((a) => {
              const level = a.level ?? 0;
              const lim = cfg.levelLimits![level] ?? { perPaymentUsd: 0, dailyUsd: 0 };
              return [a.id, { level, perPaymentUsd: lim.perPaymentUsd, dailyUsd: lim.dailyUsd }];
            }),
          ),
        }
      : {}),
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
  /**
   * What a custom rule is about. One per kind of agent action:
   *   "payment" | "payment:<category>"         target: payee address
   *   "http" | "http:<METHOD>"                 target: host, host/path prefix
   *   "shell"                                  target: command (prefix, or a * pattern)
   *   "file" | "file:read" | "file:write"      target: path (folder prefix, or a * pattern)
   *   "message"                                target: the agent being messaged
   * Capability grants (not request rules): "key:<name>", "mount", "unsandboxed".
   */
  scope: string;
  target: string; // see scope ("" = any)
  maxUsd: number; // custom allow rules: upper bound (0 = none)
}

/**
 * Does a URL fall under an HTTP rule target?
 *   "stripe.com"              any host under stripe.com (registrable domain, as before)
 *   "api.openai.com"          that host and its subdomains
 *   "api.openai.com/v1/"      that host, and only paths starting with /v1/
 */
export function httpTargetMatches(url: string, target: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const t = target.toLowerCase();
  const slash = t.indexOf("/");
  const host = slash === -1 ? t : t.slice(0, slash);
  const path = slash === -1 ? "" : t.slice(slash);
  const h = u.hostname.toLowerCase();
  const hostOk = h === host || h.endsWith(`.${host}`);
  return hostOk && (!path || u.pathname.toLowerCase().startsWith(path));
}

/** A `*` pattern (anything, including nothing) as an anchored, case-insensitive regex. */
function globRe(pattern: string): RegExp {
  const esc = pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${esc}$`, "is");
}

/**
 * Does a shell command fall under a rule target?
 *   "git push"        commands starting with `git push` (whole words: not `git pushx`)
 *   "*curl *"         a `*` pattern over the whole command: here, anything that runs curl
 * Case and runs of spaces don't matter.
 */
export function commandMatches(command: string, target: string): boolean {
  const c = command.trim().replace(/\s+/g, " ");
  const t = target.trim().replace(/\s+/g, " ");
  if (!t) return true;
  if (t.includes("*")) return globRe(t).test(c);
  const lc = c.toLowerCase();
  const lt = t.toLowerCase();
  return lc === lt || lc.startsWith(`${lt} `);
}

/**
 * Does a file path fall under a rule target?
 *   "finance"            that file or folder and everything inside it (`./finance/q3.xlsx`)
 *   "*.pem"              a `*` pattern over the whole path
 * Slashes either way, a leading `./`, and case don't matter.
 */
export function pathMatches(path: string, target: string): boolean {
  const norm = (s: string) => s.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "").toLowerCase();
  const p = norm(path);
  const t = norm(target);
  if (!t) return true;
  if (t.includes("*")) return globRe(t).test(p) || globRe(t).test(p.split("/").pop() ?? "");
  return p === t || p.startsWith(`${t}/`);
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
        // "http:POST" limits the rule to one method; plain "http" covers every method.
        if (sub && (req.method ?? "GET").toUpperCase() !== sub.toUpperCase()) return false;
        return !target || httpTargetMatches(req.url, target);
      }
      if (kind === "shell") {
        return req.tool === "shell" && commandMatches(req.command ?? "", r.target);
      }
      if (kind === "file") {
        if (req.tool !== "file") return false;
        // "file:write" / "file:read" limit the rule to one; plain "file" covers both.
        if (sub && (req.fileOp ?? "read") !== sub.toLowerCase()) return false;
        return pathMatches(req.path ?? "", r.target);
      }
      if (kind === "message") {
        return req.tool === "message" && (!target || (req.recipient ?? "").toLowerCase() === target);
      }
      // key:<name>, mount, unsandboxed: capability grants the Gatekeeper reads, never request rules.
      return false;
    },
  };
}

/**
 * Only the org's own (non-default) rules, in the same order buildRuleset uses (blocks, then
 * approvals, then allows): the first that matches decides, or null if none does. For actions the
 * default ruleset doesn't cover, like agent-to-agent messages.
 */
export function matchCustomRules(req: Request, onchain: OnchainRule[]): { outcome: Outcome; ruleId: string; reason: string } | null {
  const custom = onchain.filter((r) => !r.builtin && r.active).map(customRule);
  for (const outcome of ["deny", "approval", "allow"] as const) {
    const hit = custom.find((r) => r.outcome === outcome && r.match(req, {} as PolicyContext));
    if (hit) return { outcome: hit.outcome, ruleId: hit.id, reason: hit.description };
  }
  return null;
}

/**
 * The engine's ordered ruleset for an org, from its Dharma rules. First match wins:
 *   1. core-boundary, secrets-read           (core, always)
 *   2. custom deny rules                     (blocks beat everything below)
 *   3. unknown-recipient                     (core, always)
 *   4. custom approval rules
 *   5. trust-level grants (Dharma v3; only agents with a level)
 *   6. custom allow rules
 *   7. every other default rule still active (in default order; default-deny last)
 * A default rule the chain doesn't mention at all is kept (fail closed). Core rules can be turned
 * off only by a core change on Dharma (every member + the core wait); when one is, it stops applying.
 * The final no-match denial in evaluate() still fails closed even without default-deny.
 */
export function buildRuleset(onchain: OnchainRule[]): Rule[] {
  const byId = new Map(onchain.map((r) => [r.id, r]));
  const builtinActive = (id: string) => {
    const r = byId.get(id);
    return !r || r.active; // unknown to the chain → keep (fail closed)
  };
  const custom = onchain.filter((r) => !r.builtin && r.active).map(customRule);
  const pick = (id: string) => defaultRules.find((r) => r.id === id)!;
  const ifActive = (id: string) => (builtinActive(id) ? [pick(id)] : []);
  const rest = defaultRules.filter((r) => !["core-boundary", "secrets-read", "unknown-recipient"].includes(r.id) && builtinActive(r.id));
  return [
    ...ifActive("core-boundary"),
    ...ifActive("secrets-read"),
    ...custom.filter((r) => r.outcome === "deny"),
    ...ifActive("unknown-recipient"),
    ...custom.filter((r) => r.outcome === "approval"),
    ...levelRules,
    ...custom.filter((r) => r.outcome === "allow"),
    ...rest,
  ];
}
