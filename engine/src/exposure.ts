// Worst-case exposure: "if every agent in this org were hijacked right now, what could it do
// without a human?" The rules are deterministic, so this is computed exactly by asking the real
// engine (buildContext + buildRuleset + evaluate, and the gatekeeper's message path) about probe
// requests built from the org's own data: its payees, trusted domains, agents and Dharma rules.
// Pure: no I/O, no clock. Assumes a fresh day (nothing spent yet) and a sandboxed agent, which is
// the wider case for file writes; core rules only ever deny, so they never add exposure.
import { evaluate } from "./engine.ts";
import { buildContext, buildRuleset, matchCustomRules, messageLevelDecision, type OnchainRule, type OrgPolicyConfig } from "./rules.ts";
import type { PolicyContext, Request, Rule } from "./types.ts";

/** A level limit at or above this is "no limit" (same value as NO_LIMIT_USD in @prekaruna/dharma). */
export const NO_LIMIT_USD = 1e12;
const isNoLimit = (usd: number) => usd >= NO_LIMIT_USD;

/**
 * What exposure() reads: the same config the gatekeeper hands buildContext (agents with their
 * levels and allowances, payees as recipients, trusted domains, level limits), plus the org's
 * Dharma rules and whether the org is frozen.
 */
export interface ExposureInput extends OrgPolicyConfig {
  /** Every Dharma rule (builtin and custom), exactly as passed to buildRuleset. */
  rules: OnchainRule[];
  /** Frozen org: nothing runs, so everything is zero. */
  frozen?: boolean;
}

export interface AgentExposure {
  agentId: string;
  /** Largest single payment it can make with no human; null = no limit. */
  perPaymentUsd: number | null;
  /** Most it can pay in a day with no human; null = no limit. */
  dailyUsd: number | null;
  /** Trusted domains and Dharma rule targets it may POST/PUT/PATCH/DELETE to with no human. "*" = any site. */
  writeSites: string[];
  /** Key names (Dharma `key:<name>` rules) bound to a host it can reach with no human. */
  keys: string[];
  /** Generic file writes: none, only ./workspace, or anywhere in its sandbox. */
  fileWrites: "none" | "workspace" | "anywhere";
  /** Specific paths outside ./workspace that a Dharma allow rule lets it write (beyond `fileWrites`). */
  writePaths: string[];
  packageInstalls: boolean;
  /** May message at least one other agent with no human. */
  messages: boolean;
  /** Connector tools beyond read-only ones: none, those that aren't destructive, or all. */
  tools: "none" | "non-destructive" | "all";
  /** Specific connector tools a Dharma allow rule lets it run (beyond `tools`). */
  toolNames: string[];
}

export interface Exposure {
  frozen: boolean;
  /** Sum over agents, capped by walletUsd when given; null = no limit (and no wallet balance given). */
  dailyUsd: number | null;
  /** Largest over agents, capped by walletUsd when given; null = no limit (and no wallet balance given). */
  perPaymentUsd: number | null;
  agents: AgentExposure[];
}

// ---------------------------------------------------------------- probes

const MUTATIONS = ["POST", "PUT", "PATCH", "DELETE"] as const;
const INSTALLS = ["npm install pkg", "pnpm add pkg", "yarn add pkg", "pip install pkg"];
/** Smallest USDC amount (6 decimals): a payment that passes nothing but the rules themselves. */
const TINY_USD = 1e-6;
/** Larger than any limit, including "no limit": only a rule with no upper bound allows it. */
const HUGE_USD = NO_LIMIT_USD * 10;
const ANY_HOST = "any-site.invalid";

const urlFor = (target: string) => `https://${target.replace(/^https?:\/\//i, "").replace(/\*/g, "x") || ANY_HOST}${target.includes("/") ? "" : "/"}`;
const isCustomAllow = (r: OnchainRule) => r.active && !r.builtin && r.outcome === "allow";
const kindOf = (r: OnchainRule) => r.scope.split(":")[0];
const forAgent = (r: OnchainRule, agentId: string) => !r.agent || r.agent === agentId;
const inWorkspace = (p: string) => /^(\.\/)?workspace(\/|$)/i.test(p.trim().replace(/\\/g, "/"));
const uniq = (xs: string[]) => [...new Set(xs)];

const NONE = (agentId: string): AgentExposure => ({
  agentId, perPaymentUsd: 0, dailyUsd: 0, writeSites: [], keys: [], fileWrites: "none", writePaths: [], packageInstalls: false, messages: false, tools: "none", toolNames: [],
});

/**
 * Worst-case exposure of an org: for each agent, what it can do with no human, and the totals.
 *
 * Money: payments go only to known payees (anything else is denied), so no payees means $0. An
 * agent with a level pays up to `levelLimits[level]`, otherwise up to its daily allowance. A
 * Dharma allow rule for payments (with `maxUsd`, or without) lets matching payments through
 * without counting them against the day, so it raises the per-payment figure and removes the daily
 * limit. Dharma block and approval rules (for that agent or every agent) cut payees out entirely.
 *
 * `opts.walletUsd`: the wallet's balance; caps the org totals (agents keep their policy figures).
 */
export function exposure(input: ExposureInput, opts: { walletUsd?: number } = {}): Exposure {
  if (input.frozen) {
    return { frozen: true, dailyUsd: 0, perPaymentUsd: 0, agents: input.agents.map((a) => NONE(a.id)) };
  }
  const rules = buildRuleset(input.rules);
  const agents = input.agents.map((a) => agentExposure(a.id, input, rules));

  const cap = (n: number | null) => (opts.walletUsd == null ? n : n == null ? opts.walletUsd : Math.min(n, opts.walletUsd));
  const daily = agents.some((a) => a.dailyUsd == null) ? null : round(agents.reduce((s, a) => s + (a.dailyUsd ?? 0), 0));
  const perPayment = agents.some((a) => a.perPaymentUsd == null) ? null : Math.max(0, ...agents.map((a) => a.perPaymentUsd ?? 0));
  return { frozen: false, dailyUsd: cap(daily), perPaymentUsd: cap(perPayment), agents };
}

function agentExposure(agentId: string, input: ExposureInput, rules: Rule[]): AgentExposure {
  const ctx = buildContext(input);
  const allowed = (req: Omit<Request, "agent">, c: PolicyContext = ctx) => evaluate({ agent: agentId, ...req }, c, rules).outcome === "allow";
  const customAllows = input.rules.filter((r) => isCustomAllow(r) && forAgent(r, agentId));

  // ---- money
  const lvl = ctx.levels?.[agentId];
  const dailyCap = lvl ? lvl.dailyUsd : (ctx.allowances[agentId] ?? 0);
  // Every amount where the answer can change: the level's limits and each allow rule's maxUsd.
  const amounts = [lvl?.perPaymentUsd ?? 0, dailyCap, ...customAllows.filter((r) => kindOf(r) === "payment").map((r) => r.maxUsd)].filter(
    (n) => Number.isFinite(n) && n > 0,
  );
  const spentAll = buildContext(input, { [agentId]: HUGE_USD });
  let perPayment: number | null = 0;
  let reachable = false; // some payee takes a payment with no human
  let unboundedDay = false; // some payee takes payments that don't count against the day
  for (const p of input.recipients) {
    const pay = (amountUsd: number, c?: PolicyContext) => allowed({ tool: "payment", to: p.address, amountUsd, category: p.category }, c);
    if (!pay(TINY_USD)) continue; // blocked, needs approval, or no limit left at all
    reachable = true;
    if (pay(TINY_USD, spentAll)) unboundedDay = true;
    if (pay(HUGE_USD)) perPayment = null;
    else if (perPayment != null) perPayment = Math.max(perPayment, ...amounts.filter((n) => pay(n)));
  }
  if (perPayment != null && isNoLimit(perPayment)) perPayment = null;
  const dailyUsd = !reachable ? 0 : unboundedDay || isNoLimit(dailyCap) ? null : dailyCap;

  // ---- websites and keys
  const reach = (target: string, methods: readonly string[]) => methods.some((method) => allowed({ tool: "http", method, url: urlFor(target) }));
  const httpTargets = customAllows.filter((r) => kindOf(r) === "http").map((r) => r.target.toLowerCase() || "*");
  const sites = uniq([...input.allowlistedDomains.map((d) => d.toLowerCase()), ...httpTargets]).filter((t) => reach(t === "*" ? "" : t, MUTATIONS));
  const writeSites = sites.includes("*") ? ["*"] : sites; // any site covers the named ones
  const keys = uniq(
    input.rules
      .filter((r) => isCustomAllow(r) && r.scope.startsWith("key:") && reach(r.target, ["GET", ...MUTATIONS]))
      .map((r) => r.scope.slice(4)),
  );

  // ---- files
  const write = (path: string) => allowed({ tool: "file", fileOp: "write", path });
  const fileWrites = write("exposure-probe/file.txt") ? "anywhere" : write("workspace/exposure-probe.txt") ? "workspace" : "none";
  const writePaths =
    fileWrites === "anywhere"
      ? []
      : uniq(
          customAllows
            .filter((r) => r.scope === "file" || r.scope === "file:write")
            .map((r) => r.target)
            .filter((t) => t && !inWorkspace(t) && write(t.includes("*") ? t.replace(/\*/g, "x") : `${t.replace(/[\\/]+$/, "")}/file.txt`)),
        );

  // ---- shell, messages, tools
  const packageInstalls = INSTALLS.some((command) => allowed({ tool: "shell", command }));

  // The gatekeeper's message path: the org's own message rules, then the level, else delivered.
  const messages = input.agents
    .filter((a) => a.id !== agentId)
    .some((a) => {
      const req: Request = { agent: agentId, tool: "message", recipient: a.id, body: `to ${a.id}` };
      return ((matchCustomRules(req, input.rules) ?? messageLevelDecision(req, ctx))?.outcome ?? "allow") === "allow";
    });

  const connectors = input.rules.filter((r) => isCustomAllow(r) && r.scope.startsWith("connector:")).map((r) => r.scope.slice(10).toLowerCase());
  const toolProbes = ["any:tool", ...connectors.map((c) => `${c}:tool`)];
  const tool = (toolName: string, destructive: boolean) => allowed({ tool: "tool", host: true, toolName, readOnly: false, destructive });
  const tools = toolProbes.some((t) => tool(t, true)) ? "all" : toolProbes.some((t) => tool(t, false)) ? "non-destructive" : "none";
  const toolNames =
    tools === "all"
      ? []
      : uniq(
          customAllows
            .filter((r) => kindOf(r) === "tool" && r.target)
            .map((r) => r.target.toLowerCase())
            .filter((t) => tool(t.replace(/\*/g, "x"), tools === "non-destructive")),
        );

  return { agentId, perPaymentUsd: perPayment, dailyUsd, writeSites, keys, fileWrites, writePaths, packageInstalls, messages, tools, toolNames };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

// ---------------------------------------------------------------- delta

const usd = (n: number) => `$${n > 0 && n < 0.01 ? String(n) : n.toFixed(2)}`;
const FILE_RANK = { none: 0, workspace: 1, anywhere: 2 } as const;
const TOOL_RANK = { none: 0, "non-destructive": 1, all: 2 } as const;
/** What each step up the ladder adds, from the step below it. */
const FILE_SAY = { workspace: "file writes in ./workspace", anywhere: "file writes outside ./workspace" };
const TOOL_SAY = { "non-destructive": "connector tools that aren't destructive", all: "destructive connector tools" };
const FILE_UP = { workspace: "file writes in ./workspace", anywhere: "file writes anywhere" };
const TOOL_UP = { "non-destructive": "connector tools that aren't destructive", all: "every connector tool, destructive ones included" };

/** "+ <the new top>" when widening; "- <each step lost>" when narrowing. */
function rankLine<K extends string>(rank: Record<K, number>, up: Partial<Record<K, string>>, lost: Partial<Record<K, string>>, from: K, to: K): string {
  if (rank[to] > rank[from]) return `+ ${up[to]}`;
  const steps = (Object.keys(rank) as K[]).filter((k) => rank[k] > rank[to] && rank[k] <= rank[from]).map((k) => lost[k]);
  return `- ${steps.join(" and ")}`;
}

/**
 * What changed between two exposures, as plain lines: "+" widens, "-" narrows. Money lines are
 * org totals ("+ $15.00/day"); the rest name the agents ("+ file writes anywhere for Bills agent",
 * or "for every agent"). `names` maps agent ids to display names (default: the id).
 */
export function exposureDelta(before: Exposure, after: Exposure, names: Record<string, string> = {}): string[] {
  const lines: string[] = [];
  if (before.frozen && !after.frozen) lines.push("+ agents unfrozen");
  if (!before.frozen && after.frozen) lines.push("- every agent frozen");

  lines.push(...moneyLine(before.dailyUsd, after.dailyUsd, (n) => `${usd(n)}/day`, "daily"));
  lines.push(...paymentLine(before.perPaymentUsd, after.perPaymentUsd));

  // Per-agent changes, grouped so the same change for several agents is one line.
  const groups = new Map<string, string[]>();
  const add = (line: string, agentId: string) => groups.set(line, [...(groups.get(line) ?? []), agentId]);
  const ids = uniq([...before.agents.map((a) => a.agentId), ...after.agents.map((a) => a.agentId)]);
  for (const id of ids) {
    const b = before.agents.find((a) => a.agentId === id) ?? NONE(id);
    const a = after.agents.find((x) => x.agentId === id) ?? NONE(id);
    const setDiff = (from: string[], to: string[], say: (x: string) => string) => {
      for (const x of to.filter((x) => !from.includes(x))) add(`+ ${say(x)}`, id);
      for (const x of from.filter((x) => !to.includes(x))) add(`- ${say(x)}`, id);
    };
    setDiff(b.writeSites, a.writeSites, (s) => (s === "*" ? "write access to any site" : `write access to ${s}`));
    setDiff(b.keys, a.keys, (k) => `use of key ${k}`);
    if (a.fileWrites !== b.fileWrites) add(rankLine(FILE_RANK, FILE_UP, FILE_SAY, b.fileWrites, a.fileWrites), id);
    setDiff(b.writePaths, a.writePaths, (p) => `file writes to ${p}`);
    if (a.packageInstalls !== b.packageInstalls) add(`${a.packageInstalls ? "+" : "-"} package installs`, id);
    if (a.messages !== b.messages) add(`${a.messages ? "+" : "-"} messages to other agents`, id);
    if (a.tools !== b.tools) add(rankLine(TOOL_RANK, TOOL_UP, TOOL_SAY, b.tools, a.tools), id);
    setDiff(b.toolNames, a.toolNames, (t) => `connector tool ${t}`);
  }
  const everyone = after.agents.length > 1 ? after.agents.map((a) => a.agentId) : [];
  for (const [line, agentIds] of groups) {
    const all = everyone.length > 0 && everyone.every((id) => agentIds.includes(id));
    lines.push(`${line} for ${all ? "every agent" : agentIds.map((id) => names[id] ?? id).join(", ")}`);
  }
  return lines;
}

function moneyLine(before: number | null, after: number | null, say: (n: number) => string, what: string): string[] {
  if (before === after) return [];
  if (after == null) return [`+ no ${what} limit`];
  if (before == null) return [`- ${what} limit now ${say(after)}`];
  const d = round(after - before);
  return d === 0 ? [] : [`${d > 0 ? "+" : "-"} ${say(Math.abs(d))}`];
}

function paymentLine(before: number | null, after: number | null): string[] {
  if (before === after) return [];
  const say = (n: number | null) => (n == null ? "no limit" : usd(n));
  const up = after == null || (before != null && after > before);
  return [`${up ? "+" : "-"} largest single payment ${say(before)} → ${say(after)}`];
}
