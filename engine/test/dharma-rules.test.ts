import { describe, it, expect } from "vitest";
import { evaluate } from "../src/engine.ts";
import { buildRuleset, defaultRules, type OnchainRule } from "../src/rules.ts";
import { fixtureContext, VENDOR } from "./fixture.ts";

const builtins = (): OnchainRule[] =>
  defaultRules.map((r) => ({
    id: r.id, outcome: r.outcome, builtin: true, active: true, scope: "", target: "", maxUsd: 0,
    core: ["core-boundary", "secrets-read", "unknown-recipient", "default-deny"].includes(r.id),
  }));
const custom = (r: Partial<OnchainRule> & Pick<OnchainRule, "id" | "outcome" | "scope">): OnchainRule => ({
  core: false, builtin: false, active: true, target: "", maxUsd: 0, ...r,
});
const ctx = fixtureContext();
const pay = (agent: string, amountUsd: number, category = "services") =>
  ({ tool: "payment", agent, to: VENDOR, amountUsd, category }) as const;

describe("buildRuleset (Dharma → engine)", () => {
  it("with only the defaults, behaves exactly like the default policy", () => {
    const rules = buildRuleset(builtins());
    expect(rules.map((r) => r.id)).toEqual(defaultRules.map((r) => r.id));
  });

  it("a custom block for one agent + category beats its allowance (Auto-Shield shape)", () => {
    const rules = buildRuleset([...builtins(), custom({ id: "no-services", outcome: "deny", agent: "buyer", scope: "payment:services" })]);
    expect(evaluate(pay("buyer", 0.05), ctx, rules)).toMatchObject({ outcome: "deny", ruleId: "no-services" });
    expect(evaluate(pay("payer", 0.05), ctx, rules).outcome).toBe("allow"); // other agents unaffected
    expect(evaluate(pay("buyer", 0.05, "utilities"), ctx, rules).outcome).toBe("allow"); // other categories unaffected
  });

  it("a removed default rule no longer applies; core rules apply even if reported inactive", () => {
    const onchain = builtins().map((r) => (r.id === "package-install" || r.id === "core-boundary" ? { ...r, active: false } : r));
    const rules = buildRuleset(onchain);
    expect(rules.find((r) => r.id === "package-install")).toBeUndefined();
    expect(evaluate({ tool: "shell", command: "npm install x" }, ctx, rules).ruleId).toBe("default-deny");
    expect(evaluate({ tool: "shell", command: "mkfs.ext4 /dev/sda" }, ctx, rules).ruleId).toBe("core-boundary");
  });

  it("a voted allow rule cannot pay an unknown recipient", () => {
    const rules = buildRuleset([...builtins(), custom({ id: "auto-pay", outcome: "allow", scope: "payment", maxUsd: 1000 })]);
    expect(evaluate({ tool: "payment", agent: "buyer", to: "0x9999999999999999999999999999999999999999", amountUsd: 1 }, ctx, rules).ruleId).toBe("unknown-recipient");
    expect(evaluate(pay("buyer", 500), ctx, rules)).toMatchObject({ outcome: "allow", ruleId: "auto-pay" });
    expect(evaluate(pay("buyer", 5000), ctx, rules).ruleId).toBe("payment-approval"); // above its max
  });

  it("an approval rule scoped to a payee sends those payments to a human", () => {
    const rules = buildRuleset([...builtins(), custom({ id: "check-vendor", outcome: "approval", scope: "payment", target: VENDOR })]);
    expect(evaluate(pay("buyer", 0.05), ctx, rules)).toMatchObject({ outcome: "approval", ruleId: "check-vendor" });
  });

  it("http rules match by registrable domain", () => {
    const rules = buildRuleset([...builtins(), custom({ id: "no-stripe", outcome: "deny", scope: "http", target: "stripe.com" })]);
    expect(evaluate({ tool: "http", method: "GET", url: "https://api.stripe.com/v1" }, ctx, rules).ruleId).toBe("no-stripe");
    expect(evaluate({ tool: "http", method: "GET", url: "https://github.com/x" }, ctx, rules).outcome).toBe("allow");
  });
});

describe("HTTP rules for sandbox egress (method + path)", () => {
  const ctxHttp = { ...ctx, allowlistedDomains: [...ctx.allowlistedDomains, "openai.com"] };
  const http = (method: string, url: string) => ({ tool: "http", agent: "buyer", method, url }) as const;

  it("by default, a POST to an allowlisted domain needs approval (http-mutations)", () => {
    const rules = buildRuleset(builtins());
    expect(evaluate(http("POST", "https://api.openai.com/v1/chat/completions"), ctxHttp, rules).ruleId).toBe("http-mutations");
  });

  it("an http:POST allow rule with a path lets model calls through, and only there", () => {
    const rules = buildRuleset([...builtins(), custom({ id: "llm", outcome: "allow", scope: "http:POST", target: "api.openai.com/v1/" })]);
    expect(evaluate(http("POST", "https://api.openai.com/v1/chat/completions"), ctxHttp, rules)).toMatchObject({ outcome: "allow", ruleId: "llm" });
    expect(evaluate(http("POST", "https://api.openai.com/admin/keys"), ctxHttp, rules).ruleId).toBe("http-mutations"); // other path
    expect(evaluate(http("DELETE", "https://api.openai.com/v1/files/x"), ctxHttp, rules).ruleId).toBe("http-mutations"); // other method
    expect(evaluate(http("POST", "https://evil-openai.com/v1/x"), ctxHttp, rules).ruleId).toBe("unlisted-domain"); // look-alike host
  });

  it("a path-scoped deny blocks one endpoint on an otherwise allowed domain", () => {
    const rules = buildRuleset([...builtins(), custom({ id: "no-payouts", outcome: "deny", scope: "http", target: "api.stripe.com/v1/payouts" })]);
    expect(evaluate(http("GET", "https://api.stripe.com/v1/payouts"), ctx, rules).ruleId).toBe("no-payouts");
    expect(evaluate(http("GET", "https://api.stripe.com/v1/balance"), ctx, rules).ruleId).toBe("allowlisted-domain");
  });

  it("capability scopes (key:, mount, unsandboxed) never decide a request", () => {
    const rules = buildRuleset([
      ...builtins(),
      custom({ id: "key-openai", outcome: "allow", scope: "key:openai", target: "api.openai.com" }),
      custom({ id: "unsb", outcome: "allow", scope: "unsandboxed", target: "buyer" }),
    ]);
    expect(evaluate(http("GET", "https://api.openai.com/v1/models"), ctxHttp, rules).ruleId).toBe("allowlisted-domain");
  });
});
