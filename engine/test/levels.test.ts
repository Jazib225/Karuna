import { describe, it, expect } from "vitest";
import { evaluate } from "../src/engine.ts";
import { buildContext, buildRuleset, defaultRules, messageLevelDecision, DEFAULT_ALLOWLISTED_DOMAINS, LEVEL_GRANTS, type OnchainRule } from "../src/rules.ts";
import type { Request } from "../src/types.ts";
import { VENDOR, STRANGER } from "./fixture.ts";

// Dharma v3 defaults (DEFAULT_LEVEL_LIMITS in @prekaruna/dharma).
const LIMITS = [
  { perPaymentUsd: 0.1, dailyUsd: 1 },
  { perPaymentUsd: 0.5, dailyUsd: 5 },
  { perPaymentUsd: 2, dailyUsd: 20 },
  { perPaymentUsd: 5, dailyUsd: 50 },
];
const builtins = (): OnchainRule[] =>
  defaultRules.map((r) => ({
    id: r.id, outcome: r.outcome, builtin: true, active: true, scope: "", target: "", maxUsd: 0,
    core: ["core-boundary", "secrets-read", "unknown-recipient", "default-deny"].includes(r.id),
  }));
const custom = (r: Partial<OnchainRule> & Pick<OnchainRule, "id" | "outcome" | "scope">): OnchainRule => ({
  core: false, builtin: false, active: true, target: "", maxUsd: 0, ...r,
});
/** One agent, "a", at the given level; allowance $100 to show the level replaces it. */
const at = (level: number, spent = 0) =>
  buildContext(
    {
      agents: [{ id: "a", dailyAllowanceUsd: 100, level }],
      recipients: [{ address: VENDOR, name: "Vendor", category: "data" }],
      allowlistedDomains: DEFAULT_ALLOWLISTED_DOMAINS,
      levelLimits: LIMITS,
    },
    { a: spent },
  );
const rules = buildRuleset(builtins());
const run = (req: Request, level: number, spent = 0, rs = rules) => evaluate({ agent: "a", ...req }, at(level, spent), rs);
const pay = (amountUsd: number, to = VENDOR): Request => ({ tool: "payment", to, amountUsd, category: "data" });
const write = (path: string): Request => ({ tool: "file", fileOp: "write", path });
const post = (url: string): Request => ({ tool: "http", method: "POST", url });
const sh = (command: string): Request => ({ tool: "shell", command });

describe("trust levels: payments", () => {
  it("a level's limits replace the agent's allowance", () => {
    expect(run(pay(0.1), 0).outcome).toBe("allow");
    expect(run(pay(0.11), 0).outcome).toBe("approval"); // over Level 0's per-payment limit
    expect(run(pay(0.1), 0, 0.95).outcome).toBe("approval"); // over Level 0's $1/day
    expect(run(pay(2), 2).outcome).toBe("allow");
    expect(run(pay(2.5), 2).outcome).toBe("approval");
    expect(run(pay(5), 3, 45).outcome).toBe("allow");
  });

  it("no level ever pays an unknown address", () => {
    expect(run(pay(0.01, STRANGER), 3)).toMatchObject({ outcome: "deny", ruleId: "unknown-recipient" });
  });

  it("an org without levels (Dharma v2) keeps plain allowances", () => {
    const ctx = buildContext(
      { agents: [{ id: "a", dailyAllowanceUsd: 100 }], recipients: [{ address: VENDOR, name: "Vendor" }], allowlistedDomains: [] },
      {},
    );
    expect(ctx.levels).toBeUndefined();
    expect(evaluate({ agent: "a", ...pay(50) }, ctx, rules).outcome).toBe("allow");
    expect(evaluate({ agent: "a", ...write("workspace/x.txt") }, ctx, rules).outcome).toBe("approval"); // no grants
  });
});

describe("trust levels: everything else", () => {
  it("each grant switches on at its level", () => {
    expect(run(write("workspace/notes.md"), 0).outcome).toBe("approval");
    expect(run(write("./workspace/notes.md"), 1)).toMatchObject({ outcome: "allow", ruleId: "level-workspace-writes" });
    expect(run(write("reports/q3.md"), 2).outcome).toBe("approval");
    expect(run(write("reports/q3.md"), 3)).toMatchObject({ outcome: "allow", ruleId: "level-file-writes" });

    expect(run(post("https://api.github.com/repos/x/issues"), 1).outcome).toBe("approval");
    expect(run(post("https://api.github.com/repos/x/issues"), 2)).toMatchObject({ outcome: "allow", ruleId: "level-http-mutations" });
    expect(run(sh("npm install left-pad"), 1).outcome).toBe("approval");
    expect(run(sh("npm install left-pad"), 2)).toMatchObject({ outcome: "allow", ruleId: "level-package-install" });
  });

  it("no level unlocks unlisted domains, rm -rf, secrets or catastrophic commands", () => {
    expect(run(post("https://evil.example/upload"), 3).outcome).toBe("deny");
    expect(run(sh("rm -rf ./build"), 3)).toMatchObject({ outcome: "approval", ruleId: "destructive-shell" });
    expect(run(sh("rm -rf /"), 3)).toMatchObject({ outcome: "deny", ruleId: "core-boundary" });
    expect(run(write(".env"), 3)).toMatchObject({ outcome: "deny", ruleId: "secrets-read" });
  });

  it("the org's own blocks and approval rules beat the level", () => {
    const rs = buildRuleset([
      ...builtins(),
      custom({ id: "finance-writes", outcome: "approval", scope: "file:write", target: "finance" }),
      custom({ id: "no-github-posts", outcome: "deny", scope: "http:POST", target: "github.com" }),
    ]);
    expect(run(write("finance/q3.xlsx"), 3, 0, rs)).toMatchObject({ outcome: "approval", ruleId: "finance-writes" });
    expect(run(post("https://api.github.com/x"), 3, 0, rs)).toMatchObject({ outcome: "deny", ruleId: "no-github-posts" });
  });

  it("messages: Level 0 needs approval, Level 1+ is delivered, no levels means no opinion", () => {
    const msg: Request = { agent: "a", tool: "message", recipient: "b", body: "hi" };
    expect(messageLevelDecision(msg, at(0))?.outcome).toBe("approval");
    expect(messageLevelDecision(msg, at(1))?.outcome).toBe("allow");
    const v2 = buildContext({ agents: [{ id: "a", dailyAllowanceUsd: 1 }], recipients: [], allowlistedDomains: [] });
    expect(messageLevelDecision(msg, v2)).toBeNull();
  });

  it("the ladder only ever widens with the level", () => {
    for (const g of LEVEL_GRANTS) expect(g.min).toBeGreaterThanOrEqual(1);
  });
});
