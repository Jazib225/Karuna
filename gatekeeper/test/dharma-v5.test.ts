// Dharma v5's shared vocabulary: what members see before they sign, and the "apply now or vote" mirror.
import { describe, it, expect } from "vitest";
import { describeChange, isTightening, type PolicyShape } from "@prekaruna/dharma";
import { assertShieldSafe, ShieldGuardError } from "../src/shield.ts";

const policy: PolicyShape = {
  agents: [{ id: "ops", capUsd: 10, level: 1 }],
  thresholdUsd: 500,
  rules: [{ id: "allowlisted-domain", outcome: "allow", builtin: true }],
};

describe("Dharma v5 vocabulary", () => {
  it("a default rule's id reads as re-enabling it, whatever else the change says", () => {
    // Dharma ignores the payload for a default rule's id: show what will actually happen.
    const c = { op: "AddRule", id: "allowlisted-domain", outcome: "Deny", scope: "http", target: "x.com" } as const;
    expect(describeChange(c)).toBe("Re-enable default rule allowlisted-domain");
  });

  it("a block or one agent's approval rule is a tightening; an org-wide approval rule goes to a vote", () => {
    const rule = (outcome: "Deny" | "Approval" | "Allow", agent?: string) => ({ op: "AddRule", id: "r1", outcome, agent, scope: "http", target: "" }) as const;
    expect(isTightening(rule("Deny"), policy)).toBe(true);
    expect(isTightening(rule("Approval", "ops"), policy)).toBe(true);
    expect(isTightening(rule("Approval"), policy)).toBe(false);
    expect(isTightening(rule("Allow", "ops"), policy)).toBe(false);
    expect(isTightening({ op: "AddRule", id: "allowlisted-domain", outcome: "Deny", scope: "", target: "" }, policy)).toBe(false); // re-enables an allow
  });

  it("Drills write blocks, or approval rules for one agent", () => {
    expect(() => assertShieldSafe({ op: "AddRule", id: "sh-x", outcome: "Approval", scope: "payment:x", target: "" })).toThrow(ShieldGuardError);
    expect(() => assertShieldSafe({ op: "AddRule", id: "sh-x", outcome: "Approval", agent: "ops", scope: "shell", target: "" })).not.toThrow();
    expect(() => assertShieldSafe({ op: "AddRule", id: "sh-x", outcome: "Deny", scope: "payment:x", target: "" })).not.toThrow();
  });
});
