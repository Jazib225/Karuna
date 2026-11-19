import { describe, it, expect } from "vitest";
import { evaluate } from "../src/engine.ts";
import { registrableDomain, buildContext } from "../src/rules.ts";
import { fixtureContext, VENDOR, STRANGER } from "./fixture.ts";
import type { Request } from "../src/types.ts";

const ctx = fixtureContext();
const verdict = (r: Request, c = ctx) => evaluate(r, c);

describe("policy engine checks", () => {
  it("ls ./workspace -> allow", () => {
    const d = verdict({ tool: "shell", command: "ls ./workspace" });
    expect(d.outcome).toBe("allow");
    expect(d.ruleId).toBe("workspace-read");
  });

  it("cat .env -> deny", () => {
    const d = verdict({ tool: "shell", command: "cat .env" });
    expect(d.outcome).toBe("deny");
    expect(d.ruleId).toBe("secrets-read");
  });

  it("send 50 USDC to unknown recipient -> deny", () => {
    const d = verdict({ tool: "payment", agent: "payer", to: STRANGER, amountUsd: 50 });
    expect(d.outcome).toBe("deny");
    expect(d.ruleId).toBe("unknown-recipient");
  });

  it("rm -rf ./data -> approval", () => {
    const d = verdict({ tool: "shell", command: "rm -rf ./data" });
    expect(d.outcome).toBe("approval");
    expect(d.ruleId).toBe("destructive-shell");
  });

  it("agent over its daily allowance -> approval", () => {
    // buyer: $10/day cap, $9 already spent, asks for $5 more -> over allowance
    const c = fixtureContext({ buyer: 9 });
    const d = verdict(
      { tool: "payment", agent: "buyer", to: VENDOR, amountUsd: 5, category: "services" },
      c,
    );
    expect(d.outcome).toBe("approval");
    expect(d.ruleId).toBe("payment-approval");
  });
});

describe("all 12 website default rules fire in order", () => {
  it("1 core-boundary: rm -rf / -> deny", () => {
    expect(verdict({ tool: "shell", command: "rm -rf /" }).ruleId).toBe("core-boundary");
    expect(verdict({ tool: "shell", command: "sudo mkfs.ext4 /dev/sda" }).ruleId).toBe("core-boundary");
    expect(verdict({ tool: "shell", command: ":(){ :|:& };:" }).ruleId).toBe("core-boundary");
  });

  it("2 secrets-read: .env / *.pem / id_rsa -> deny", () => {
    expect(verdict({ tool: "file", fileOp: "read", path: "config/prod.pem" }).ruleId).toBe("secrets-read");
    expect(verdict({ tool: "file", fileOp: "read", path: "~/.ssh/id_rsa" }).ruleId).toBe("secrets-read");
    expect(verdict({ tool: "shell", command: "cat secrets/.env" }).outcome).toBe("deny");
  });

  it("3 unknown-recipient -> deny", () => {
    expect(verdict({ tool: "payment", agent: "payer", to: STRANGER, amountUsd: 5 }).ruleId).toBe(
      "unknown-recipient",
    );
  });

  it("payment-within-allowance: known recipient under cap -> allow", () => {
    const d = verdict({ tool: "payment", agent: "buyer", to: VENDOR, amountUsd: 0.05, category: "services" });
    expect(d.outcome).toBe("allow");
    expect(d.ruleId).toBe("payment-within-allowance");
  });

  it("4 payment-approval: known recipient, no agent/over cap -> approval", () => {
    expect(verdict({ tool: "payment", to: VENDOR, amountUsd: 900 }).ruleId).toBe("payment-approval");
  });

  it("5 destructive-shell: rm -rf <path> -> approval", () => {
    expect(verdict({ tool: "shell", command: "rm -rf ./build" }).ruleId).toBe("destructive-shell");
  });

  it("6 package-install -> approval", () => {
    expect(verdict({ tool: "shell", command: "npm install lodash" }).ruleId).toBe("package-install");
    expect(verdict({ tool: "shell", command: "pip install requests" }).ruleId).toBe("package-install");
  });

  it("7 human-approval-writes: file write -> approval", () => {
    expect(verdict({ tool: "file", fileOp: "write", path: "out/report.txt" }).ruleId).toBe(
      "human-approval-writes",
    );
  });

  it("8 allowlisted-domain: GET trusted -> allow", () => {
    expect(verdict({ tool: "http", method: "GET", url: "https://api.stripe.com/v1/balance" }).ruleId).toBe(
      "allowlisted-domain",
    );
    expect(verdict({ tool: "http", method: "GET", url: "https://github.com/x/y" }).outcome).toBe("allow");
  });

  it("9 http-mutations: POST trusted -> approval", () => {
    expect(verdict({ tool: "http", method: "POST", url: "https://api.stripe.com/v1/charges" }).ruleId).toBe(
      "http-mutations",
    );
  });

  it("10 unlisted-domain: GET untrusted -> deny", () => {
    expect(verdict({ tool: "http", method: "GET", url: "https://evil.example.com/x" }).ruleId).toBe(
      "unlisted-domain",
    );
  });

  it("11 workspace-read: bare ls -> allow", () => {
    expect(verdict({ tool: "shell", command: "ls" }).ruleId).toBe("workspace-read");
    expect(verdict({ tool: "shell", command: "grep foo ./workspace/log.txt" }).outcome).toBe("allow");
  });

  it("12 default-deny: anything else -> deny", () => {
    expect(verdict({ tool: "shell", command: "curl http://x" }).ruleId).toBe("default-deny");
    expect(verdict({ tool: "message", agent: "buyer", body: "hi" }).ruleId).toBe("default-deny");
  });
});

describe("engine properties", () => {
  it("is deterministic: same input -> same output", () => {
    const r: Request = { tool: "http", method: "GET", url: "https://github.com/a" };
    expect(evaluate(r, ctx)).toEqual(evaluate(r, ctx));
  });

  it("a cat outside workspace is not allowed by workspace-read", () => {
    expect(verdict({ tool: "shell", command: "cat /etc/passwd" }).outcome).toBe("deny");
  });

  it("spend exactly at the cap is still allowed; one cent over asks", () => {
    const c = fixtureContext({ payer: 45 });
    expect(verdict({ tool: "payment", agent: "payer", to: VENDOR, amountUsd: 5 }, c).outcome).toBe("allow");
    expect(verdict({ tool: "payment", agent: "payer", to: VENDOR, amountUsd: 5.01 }, c).outcome).toBe(
      "approval",
    );
  });

  it("buildContext uses only the org's own config (no built-in agents or recipients)", () => {
    const empty = buildContext({ agents: [], recipients: [], allowlistedDomains: [] });
    expect(empty.allowances).toEqual({});
    expect(empty.knownRecipients).toEqual({});
    // with no recipients configured, every payment is to an unknown recipient
    expect(evaluate({ tool: "payment", agent: "x", to: VENDOR, amountUsd: 1 }, empty).ruleId).toBe("unknown-recipient");
  });

  it("recipient addresses match case-insensitively", () => {
    expect(verdict({ tool: "payment", agent: "buyer", to: VENDOR.toUpperCase().replace("0X", "0x"), amountUsd: 1 }).outcome).toBe("allow");
  });

  it("registrableDomain reduces subdomains", () => {
    expect(registrableDomain("https://api.stripe.com/v1")).toBe("stripe.com");
    expect(registrableDomain("not a url")).toBeNull();
  });
});
