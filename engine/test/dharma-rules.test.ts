import { describe, it, expect } from "vitest";
import { evaluate } from "../src/engine.ts";
import { buildRuleset, defaultRules, matchCustomRules, type OnchainRule } from "../src/rules.ts";
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
    expect(rules.map((r) => r.id).filter((id) => !/^(level-|host-|tool-)/.test(id))).toEqual(defaultRules.map((r) => r.id));
  });

  it("a custom block for one agent + category beats its allowance (Auto-Shield shape)", () => {
    const rules = buildRuleset([...builtins(), custom({ id: "no-services", outcome: "deny", agent: "buyer", scope: "payment:services" })]);
    expect(evaluate(pay("buyer", 0.05), ctx, rules)).toMatchObject({ outcome: "deny", ruleId: "no-services" });
    expect(evaluate(pay("payer", 0.05), ctx, rules).outcome).toBe("allow"); // other agents unaffected
    expect(evaluate(pay("buyer", 0.05, "utilities"), ctx, rules).outcome).toBe("allow"); // other categories unaffected
  });

  it("a removed default rule no longer applies, and neither does a core rule removed by a full vote", () => {
    const onchain = builtins().map((r) => (r.id === "package-install" || r.id === "core-boundary" ? { ...r, active: false } : r));
    const rules = buildRuleset(onchain);
    expect(rules.find((r) => r.id === "package-install")).toBeUndefined();
    expect(evaluate({ tool: "shell", command: "npm install x" }, ctx, rules).ruleId).toBe("default-deny");
    // core-boundary was turned off on Dharma (every member + the core wait): the default deny still catches it
    expect(rules.find((r) => r.id === "core-boundary")).toBeUndefined();
    expect(evaluate({ tool: "shell", command: "mkfs.ext4 /dev/sda" }, ctx, rules)).toMatchObject({ outcome: "deny", ruleId: "default-deny" });
  });

  it("core rules the chain doesn't mention still apply (fail closed)", () => {
    const rules = buildRuleset(builtins().filter((r) => r.id !== "secrets-read"));
    expect(evaluate({ tool: "shell", command: "cat .env" }, ctx, rules).ruleId).toBe("secrets-read");
  });

  it("with every default off, nothing is allowed: the engine still fails closed", () => {
    const rules = buildRuleset(builtins().map((r) => ({ ...r, active: false })));
    expect(evaluate({ tool: "shell", command: "ls" }, ctx, rules)).toMatchObject({ outcome: "deny", ruleId: "no-match" });
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

describe("rules for every kind of action (shell, files, messages)", () => {
  const sh = (command: string, agent = "buyer") => ({ tool: "shell", agent, command }) as const;
  const file = (path: string, fileOp: "read" | "write", agent = "buyer") => ({ tool: "file", agent, path, fileOp }) as const;

  it("shell: block a command by prefix, whole words only", () => {
    const rules = buildRuleset([...builtins(), custom({ id: "no-push", outcome: "deny", scope: "shell", target: "git push" })]);
    expect(evaluate(sh("git push origin main"), ctx, rules)).toMatchObject({ outcome: "deny", ruleId: "no-push" });
    expect(evaluate(sh("GIT   push"), ctx, rules).ruleId).toBe("no-push"); // case and spacing don't matter
    expect(evaluate(sh("git pushx"), ctx, rules).ruleId).not.toBe("no-push");
    expect(evaluate(sh("git status"), ctx, rules).ruleId).not.toBe("no-push");
  });

  it("shell: a * pattern matches anywhere in the command", () => {
    const rules = buildRuleset([...builtins(), custom({ id: "curl-needs-ok", outcome: "approval", scope: "shell", target: "*curl *" })]);
    expect(evaluate(sh("cd x && curl https://example.com"), ctx, rules)).toMatchObject({ outcome: "approval", ruleId: "curl-needs-ok" });
    expect(evaluate(sh("echo curly"), ctx, rules).ruleId).not.toBe("curl-needs-ok");
  });

  it("shell: an allow rule opens a command the defaults would deny, but never the core boundary", () => {
    const rules = buildRuleset([...builtins(), custom({ id: "tests-ok", outcome: "allow", scope: "shell", target: "npm test" }), custom({ id: "anything", outcome: "allow", scope: "shell", target: "*" })]);
    expect(evaluate(sh("npm test"), ctx, rules)).toMatchObject({ outcome: "allow", ruleId: "tests-ok" });
    expect(evaluate(sh("rm -rf /"), ctx, rules).outcome).toBe("deny"); // core-boundary still first
    expect(evaluate(sh("cat .env"), ctx, rules).outcome).toBe("deny"); // secrets-read still first
  });

  it("files: a folder covers what's inside it; read/write can be ruled separately", () => {
    const rules = buildRuleset([
      ...builtins(),
      custom({ id: "finance-ro", outcome: "deny", scope: "file:write", target: "finance" }),
      custom({ id: "finance-read", outcome: "allow", scope: "file:read", target: "./finance/" }),
    ]);
    expect(evaluate(file("finance/q3.xlsx", "write"), ctx, rules)).toMatchObject({ outcome: "deny", ruleId: "finance-ro" });
    expect(evaluate(file(String.raw`.\finance\q3.xlsx`, "read"), ctx, rules)).toMatchObject({ outcome: "allow", ruleId: "finance-read" });
    expect(evaluate(file("finance-old/q3.xlsx", "write"), ctx, rules).ruleId).not.toBe("finance-ro"); // not a prefix of a different folder
  });

  it("files: a * pattern matches the whole path or just the file name", () => {
    const rules = buildRuleset([...builtins(), custom({ id: "no-csv", outcome: "deny", scope: "file", target: "*.csv" })]);
    expect(evaluate(file("exports/customers.csv", "read"), ctx, rules).ruleId).toBe("no-csv");
    expect(evaluate(file("customers.csv.bak", "read"), ctx, rules).ruleId).not.toBe("no-csv");
  });

  it("rules are per agent when they name one", () => {
    const rules = buildRuleset([...builtins(), custom({ id: "buyer-no-push", outcome: "deny", agent: "buyer", scope: "shell", target: "git push" })]);
    expect(evaluate(sh("git push", "buyer"), ctx, rules).ruleId).toBe("buyer-no-push");
    expect(evaluate(sh("git push", "payer"), ctx, rules).ruleId).not.toBe("buyer-no-push");
  });

  it("messages: only custom rules decide, by recipient", () => {
    const onchain = [
      ...builtins(),
      custom({ id: "no-dm-payer", outcome: "deny", agent: "research", scope: "message", target: "payer" }),
      custom({ id: "dm-needs-ok", outcome: "approval", scope: "message", target: "" }),
    ];
    const msg = (agent: string, recipient: string) => ({ tool: "message", agent, recipient }) as const;
    expect(matchCustomRules(msg("research", "payer"), onchain)).toMatchObject({ outcome: "deny", ruleId: "no-dm-payer" });
    expect(matchCustomRules(msg("buyer", "payer"), onchain)).toMatchObject({ outcome: "approval", ruleId: "dm-needs-ok" });
    expect(matchCustomRules(msg("buyer", "payer"), builtins())).toBeNull(); // no custom rule: the Gatekeeper's own checks decide
  });

  it("unknown scopes never match (fail closed to the defaults)", () => {
    const rules = buildRuleset([...builtins(), custom({ id: "weird", outcome: "allow", scope: "teleport", target: "" })]);
    expect(evaluate(sh("anything"), ctx, rules).ruleId).toBe("default-deny");
  });
});
