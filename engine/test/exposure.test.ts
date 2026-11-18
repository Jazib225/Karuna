import { describe, it, expect } from "vitest";
import { exposure, exposureDelta, NO_LIMIT_USD, type ExposureInput } from "../src/exposure.ts";
import { defaultRules, DEFAULT_ALLOWLISTED_DOMAINS, type OnchainRule } from "../src/rules.ts";
import { VENDOR } from "./fixture.ts";

// Dharma v3 defaults (DEFAULT_LEVEL_LIMITS in @prekaruna/dharma).
const LIMITS = [
  { perPaymentUsd: 0.1, dailyUsd: 1 },
  { perPaymentUsd: 0.5, dailyUsd: 5 },
  { perPaymentUsd: 2, dailyUsd: 20 },
  { perPaymentUsd: 5, dailyUsd: 50 },
];
const OTHER_VENDOR = "0x3333333333333333333333333333333333333333";

const builtins = (): OnchainRule[] =>
  defaultRules.map((r) => ({
    id: r.id, outcome: r.outcome, builtin: true, active: true, scope: "", target: "", maxUsd: 0,
    core: ["core-boundary", "secrets-read", "unknown-recipient", "default-deny"].includes(r.id),
  }));
const rule = (r: Partial<OnchainRule> & Pick<OnchainRule, "outcome" | "scope">): OnchainRule => ({
  id: `r-${r.outcome}-${r.scope}-${r.target ?? ""}-${r.agent ?? ""}`, core: false, builtin: false, active: true, target: "", maxUsd: 0, ...r,
});

/** One agent "a" at a level (allowance $100, to show the level replaces it), one payee. */
const org = (over: Partial<ExposureInput> = {}): ExposureInput => ({
  agents: [{ id: "a", dailyAllowanceUsd: 100, level: 0 }],
  recipients: [{ address: VENDOR, name: "Vendor", category: "data" }],
  allowlistedDomains: DEFAULT_ALLOWLISTED_DOMAINS,
  levelLimits: LIMITS,
  rules: builtins(),
  ...over,
});
const atLevel = (level: number, over: Partial<ExposureInput> = {}) => org({ agents: [{ id: "a", dailyAllowanceUsd: 100, level }], ...over });
const agentA = (input: ExposureInput, opts?: { walletUsd?: number }) => exposure(input, opts).agents[0];

describe("exposure: each level with the default limits", () => {
  it("Level 0: pays up to its limits, nothing else", () => {
    expect(agentA(atLevel(0))).toEqual({
      agentId: "a", perPaymentUsd: 0.1, dailyUsd: 1, writeSites: [], keys: [], fileWrites: "none", writePaths: [],
      packageInstalls: false, messages: false, tools: "none", toolNames: [],
    });
  });

  it("Level 1: workspace writes and messages", () => {
    const a = agentA(atLevel(1, { agents: [{ id: "a", dailyAllowanceUsd: 0, level: 1 }, { id: "b", dailyAllowanceUsd: 0, level: 0 }] }));
    expect(a).toMatchObject({ perPaymentUsd: 0.5, dailyUsd: 5, fileWrites: "workspace", messages: true, writeSites: [], packageInstalls: false, tools: "none" });
  });

  it("Level 2: writes to trusted domains, package installs, non-destructive tools", () => {
    expect(agentA(atLevel(2))).toMatchObject({
      perPaymentUsd: 2, dailyUsd: 20, fileWrites: "workspace", packageInstalls: true, tools: "non-destructive",
      writeSites: DEFAULT_ALLOWLISTED_DOMAINS,
    });
  });

  it("Level 3: file writes anywhere in the sandbox", () => {
    expect(agentA(atLevel(3))).toMatchObject({ perPaymentUsd: 5, dailyUsd: 50, fileWrites: "anywhere", packageInstalls: true, tools: "non-destructive" });
  });

  it("a level set to no limit reports null", () => {
    const limits = [...LIMITS.slice(0, 3), { perPaymentUsd: NO_LIMIT_USD, dailyUsd: NO_LIMIT_USD }];
    const e = exposure(atLevel(3, { levelLimits: limits }));
    expect(e.agents[0]).toMatchObject({ perPaymentUsd: null, dailyUsd: null });
    expect(e).toMatchObject({ dailyUsd: null, perPaymentUsd: null });
  });

  it("no limit per payment is still bounded by the day", () => {
    const limits = [{ perPaymentUsd: NO_LIMIT_USD, dailyUsd: 7 }];
    expect(agentA(atLevel(0, { levelLimits: limits }))).toMatchObject({ perPaymentUsd: 7, dailyUsd: 7 });
  });

  it("an org without levels uses each agent's allowance and grants nothing", () => {
    const a = agentA(org({ agents: [{ id: "a", dailyAllowanceUsd: 30 }], levelLimits: undefined }));
    expect(a).toMatchObject({ perPaymentUsd: 30, dailyUsd: 30, fileWrites: "none", writeSites: [], packageInstalls: false, tools: "none" });
  });
});

describe("exposure: money", () => {
  it("no payees means $0, whatever the limits", () => {
    const e = exposure(atLevel(3, { recipients: [] }));
    expect(e.agents[0]).toMatchObject({ perPaymentUsd: 0, dailyUsd: 0 });
    expect(e).toMatchObject({ dailyUsd: 0, perPaymentUsd: 0 });
  });

  it("an org allow rule with maxUsd raises the single payment and lifts the daily limit", () => {
    // Payments the rule covers never count against the day: a hijacked agent can repeat them.
    const a = agentA(atLevel(0, { rules: [...builtins(), rule({ outcome: "allow", scope: "payment:data", maxUsd: 25 })] }));
    expect(a).toMatchObject({ perPaymentUsd: 25, dailyUsd: null });
  });

  it("an org allow rule without maxUsd removes both limits", () => {
    const a = agentA(atLevel(0, { rules: [...builtins(), rule({ outcome: "allow", scope: "payment", target: VENDOR })] }));
    expect(a).toMatchObject({ perPaymentUsd: null, dailyUsd: null });
  });

  it("an allow rule for a payee that isn't known adds nothing", () => {
    const a = agentA(atLevel(0, { rules: [...builtins(), rule({ outcome: "allow", scope: "payment", target: OTHER_VENDOR, maxUsd: 25 })] }));
    expect(a).toMatchObject({ perPaymentUsd: 0.1, dailyUsd: 1 });
  });

  it("an org block or approval rule for the agent cuts its payments", () => {
    for (const outcome of ["deny", "approval"] as const) {
      const a = agentA(atLevel(3, { rules: [...builtins(), rule({ outcome, scope: "payment", agent: "a" })] }));
      expect(a).toMatchObject({ perPaymentUsd: 0, dailyUsd: 0 });
    }
  });

  it("a rule for another agent leaves this one alone", () => {
    const a = agentA(atLevel(3, { rules: [...builtins(), rule({ outcome: "deny", scope: "payment", agent: "other" })] }));
    expect(a).toMatchObject({ perPaymentUsd: 5, dailyUsd: 50 });
  });

  it("a rule for every agent cuts every agent; a category rule cuts only that category's payees", () => {
    const agents = [{ id: "a", dailyAllowanceUsd: 0, level: 2 }, { id: "b", dailyAllowanceUsd: 0, level: 3 }];
    const blocked = exposure(org({ agents, rules: [...builtins(), rule({ outcome: "approval", scope: "payment" })] }));
    expect(blocked).toMatchObject({ dailyUsd: 0, perPaymentUsd: 0 });

    const twoPayees = [{ address: VENDOR, name: "Vendor", category: "data" }, { address: OTHER_VENDOR, name: "Cloud", category: "cloud" }];
    const one = exposure(org({ agents, recipients: twoPayees, rules: [...builtins(), rule({ outcome: "deny", scope: "payment:data" })] }));
    expect(one).toMatchObject({ dailyUsd: 70, perPaymentUsd: 5 }); // the cloud payee is still reachable
  });

  it("org totals add up the days and take the largest payment", () => {
    const agents = [{ id: "a", dailyAllowanceUsd: 0, level: 1 }, { id: "b", dailyAllowanceUsd: 0, level: 3 }];
    expect(exposure(org({ agents }))).toMatchObject({ dailyUsd: 55, perPaymentUsd: 5 });
  });

  it("the wallet balance caps the totals", () => {
    const agents = [{ id: "a", dailyAllowanceUsd: 0, level: 3 }, { id: "b", dailyAllowanceUsd: 0, level: 3 }];
    expect(exposure(org({ agents }), { walletUsd: 30 })).toMatchObject({ dailyUsd: 30, perPaymentUsd: 5 });
    expect(exposure(org({ agents }), { walletUsd: 3 })).toMatchObject({ dailyUsd: 3, perPaymentUsd: 3 });
    const unlimited = [{ perPaymentUsd: NO_LIMIT_USD, dailyUsd: NO_LIMIT_USD }];
    const e = exposure(org({ agents: [{ id: "a", dailyAllowanceUsd: 0, level: 0 }], levelLimits: unlimited }), { walletUsd: 12 });
    expect(e).toMatchObject({ dailyUsd: 12, perPaymentUsd: 12 });
    expect(e.agents[0]).toMatchObject({ dailyUsd: null, perPaymentUsd: null }); // the agent keeps its policy figure
  });
});

describe("exposure: everything else", () => {
  it("org allow rules for websites add write sites, even below Level 2", () => {
    const rules = [...builtins(), rule({ outcome: "allow", scope: "http:POST", target: "api.example.com" })];
    expect(agentA(atLevel(0, { rules })).writeSites).toEqual(["api.example.com"]);
    expect(agentA(atLevel(0, { rules: [...builtins(), rule({ outcome: "allow", scope: "http" })] })).writeSites).toEqual(["*"]);
    // A GET-only rule isn't write access.
    expect(agentA(atLevel(0, { rules: [...builtins(), rule({ outcome: "allow", scope: "http:GET", target: "api.example.com" })] })).writeSites).toEqual([]);
  });

  it("org block and approval rules cut write sites, per agent and for every agent", () => {
    const perAgent = [...builtins(), rule({ outcome: "deny", scope: "http:POST", target: "github.com", agent: "a" })];
    const sites = agentA(atLevel(2, { rules: perAgent })).writeSites;
    expect(sites).toContain("github.com"); // PUT, PATCH and DELETE are still open
    const allMethods = [...builtins(), rule({ outcome: "approval", scope: "http", target: "github.com" })];
    expect(agentA(atLevel(2, { rules: allMethods })).writeSites).toEqual(["stripe.com", "pypi.org", "npmjs.com"]);
  });

  it("keys count only when their host is reachable without a human", () => {
    const keyRule = rule({ outcome: "allow", scope: "key:stripe", target: "api.stripe.com" });
    const offList = rule({ outcome: "allow", scope: "key:openai", target: "api.openai.com" });
    expect(agentA(atLevel(0, { rules: [...builtins(), keyRule, offList] })).keys).toEqual(["stripe"]); // GET to a trusted domain
    const blocked = rule({ outcome: "deny", scope: "http", target: "stripe.com" });
    expect(agentA(atLevel(3, { rules: [...builtins(), keyRule, blocked] })).keys).toEqual([]);
  });

  it("file writes: org rules cut the grant or add specific folders", () => {
    expect(agentA(atLevel(3, { rules: [...builtins(), rule({ outcome: "approval", scope: "file:write" })] })).fileWrites).toBe("none");
    expect(agentA(atLevel(3, { rules: [...builtins(), rule({ outcome: "approval", scope: "file:write", target: "finance" })] })).fileWrites).toBe("anywhere");
    const reports = agentA(atLevel(1, { rules: [...builtins(), rule({ outcome: "allow", scope: "file:write", target: "reports" })] }));
    expect(reports).toMatchObject({ fileWrites: "workspace", writePaths: ["reports"] });
  });

  it("package installs: a block on one installer leaves the others", () => {
    expect(agentA(atLevel(2, { rules: [...builtins(), rule({ outcome: "deny", scope: "shell", target: "npm install" })] })).packageInstalls).toBe(true);
    const everyInstaller = ["npm", "pnpm", "yarn", "pip"].map((target) => rule({ outcome: "deny", scope: "shell", target }));
    expect(agentA(atLevel(2, { rules: [...builtins(), ...everyInstaller] })).packageInstalls).toBe(false);
    expect(agentA(atLevel(0, { rules: [...builtins(), rule({ outcome: "allow", scope: "shell", target: "pip install" })] })).packageInstalls).toBe(true);
  });

  it("messages follow the gatekeeper: org rules, then the level, else delivered", () => {
    const two = (level: number | undefined, rules = builtins()) =>
      exposure(org({ agents: [{ id: "a", dailyAllowanceUsd: 0, level }, { id: "b", dailyAllowanceUsd: 0, level }], rules, ...(level == null ? { levelLimits: undefined } : {}) }));
    expect(two(0).agents[0].messages).toBe(false);
    expect(two(1).agents[0].messages).toBe(true);
    expect(two(undefined).agents[0].messages).toBe(true); // no levels: delivered, as before
    expect(two(1, [...builtins(), rule({ outcome: "approval", scope: "message", agent: "a" })]).agents.map((x) => x.messages)).toEqual([false, true]);
    expect(two(0, [...builtins(), rule({ outcome: "allow", scope: "message", target: "b" })]).agents.map((x) => x.messages)).toEqual([true, false]);
    expect(agentA(atLevel(3)).messages).toBe(false); // nobody to message
  });

  it("connector tools: the level grant, org cuts, and org allows", () => {
    expect(agentA(atLevel(2, { rules: [...builtins(), rule({ outcome: "deny", scope: "tool" })] })).tools).toBe("none");
    expect(agentA(atLevel(0, { rules: [...builtins(), rule({ outcome: "allow", scope: "tool" })] })).tools).toBe("all");
    const send = agentA(atLevel(2, { rules: [...builtins(), rule({ outcome: "allow", scope: "tool", target: "gmail:send_email" })] }));
    expect(send).toMatchObject({ tools: "non-destructive", toolNames: ["gmail:send_email"] });
  });

  it("core rules never count: an allow rule they override adds nothing", () => {
    const rules = [...builtins(), rule({ outcome: "allow", scope: "file:write", target: ".env" }), rule({ outcome: "allow", scope: "file:write", target: "keys/*.pem" })];
    expect(agentA(atLevel(0, { rules }))).toMatchObject({ fileWrites: "none", writePaths: [] }); // secrets-read denies both
  });

  it("a frozen org can do nothing", () => {
    const e = exposure(atLevel(3, { frozen: true, rules: [...builtins(), rule({ outcome: "allow", scope: "http" })] }), { walletUsd: 100 });
    expect(e).toEqual({
      frozen: true, dailyUsd: 0, perPaymentUsd: 0,
      agents: [{ agentId: "a", perPaymentUsd: 0, dailyUsd: 0, writeSites: [], keys: [], fileWrites: "none", writePaths: [], packageInstalls: false, messages: false, tools: "none", toolNames: [] }],
    });
  });
});

describe("exposureDelta", () => {
  const names = { a: "Bills agent", b: "Ops agent" };
  const two = (levelA: number, levelB: number, over: Partial<ExposureInput> = {}) =>
    exposure(org({ agents: [{ id: "a", dailyAllowanceUsd: 0, level: levelA }, { id: "b", dailyAllowanceUsd: 0, level: levelB }], ...over }));

  it("raising a level's limits", () => {
    const raised = [LIMITS[0], { perPaymentUsd: 2, dailyUsd: 20 }, ...LIMITS.slice(2)];
    expect(exposureDelta(two(1, 0), two(1, 0, { levelLimits: raised }), names)).toEqual([
      "+ $15.00/day",
      "+ largest single payment $0.50 → $2.00",
    ]);
  });

  it("adding a trusted domain", () => {
    const domains = [...DEFAULT_ALLOWLISTED_DOMAINS, "api.github.com"];
    expect(exposureDelta(two(2, 2), two(2, 2, { allowlistedDomains: domains }), names)).toEqual(["+ write access to api.github.com for every agent"]);
    expect(exposureDelta(two(2, 0), two(2, 0, { allowlistedDomains: domains }), names)).toEqual(["+ write access to api.github.com for Bills agent"]);
  });

  it("raising an agent's level", () => {
    expect(exposureDelta(two(2, 0), two(3, 0), names)).toEqual([
      "+ $30.00/day",
      "+ largest single payment $2.00 → $5.00",
      "+ file writes anywhere for Bills agent",
    ]);
    expect(exposureDelta(two(0, 0), two(0, 2), names)).toEqual([
      "+ $19.00/day",
      "+ largest single payment $0.10 → $2.00",
      ...DEFAULT_ALLOWLISTED_DOMAINS.map((d) => `+ write access to ${d} for Ops agent`),
      "+ file writes in ./workspace for Ops agent",
      "+ package installs for Ops agent",
      "+ messages to other agents for Ops agent",
      "+ connector tools that aren't destructive for Ops agent",
    ]);
  });

  it("tightening reads as minus lines, and no change is no lines", () => {
    expect(exposureDelta(two(3, 0), two(1, 0), names)).toEqual([
      "- $45.00/day",
      "- largest single payment $5.00 → $0.50",
      ...DEFAULT_ALLOWLISTED_DOMAINS.map((d) => `- write access to ${d} for Bills agent`),
      "- file writes outside ./workspace for Bills agent",
      "- package installs for Bills agent",
      "- connector tools that aren't destructive for Bills agent",
    ]);
    expect(exposureDelta(two(2, 1), two(2, 1), names)).toEqual([]);
  });

  it("no-limit and freeze transitions", () => {
    const unlimited = [...LIMITS.slice(0, 3), { perPaymentUsd: NO_LIMIT_USD, dailyUsd: NO_LIMIT_USD }];
    expect(exposureDelta(two(3, 0), two(3, 0, { levelLimits: unlimited }))).toEqual([
      "+ no daily limit",
      "+ largest single payment $5.00 → no limit",
    ]);
    const frozen = two(1, 1, { frozen: true });
    expect(exposureDelta(two(1, 1), frozen, names)[0]).toBe("- every agent frozen");
    expect(exposureDelta(frozen, two(1, 1), names)).toContain("+ agents unfrozen");
  });
});
