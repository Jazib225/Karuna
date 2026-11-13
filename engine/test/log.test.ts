import { describe, it, expect } from "vitest";
import { SignedLog } from "../src/log.ts";
import { evaluate } from "../src/engine.ts";
import { bakeryContext } from "../src/rules.ts";

const ctx = bakeryContext();
const at = (s: number) => new Date(Date.UTC(2026, 10, 9, 0, 0, s)); // fixed clock

function seededLog() {
  const log = new SignedLog();
  const reqs = [
    { tool: "shell", command: "ls ./workspace" } as const,
    { tool: "payment", agent: "supplies", to: "0xGoldenMills", amountUsd: 0.05 } as const,
    { tool: "shell", command: "cat .env" } as const,
  ];
  reqs.forEach((r, i) => log.append(r, evaluate(r, ctx), at(i)));
  return log;
}

describe("signed tamper-evident log (ROADMAP.md: edit an old entry -> chain check fails)", () => {
  it("a clean chain verifies", () => {
    const log = seededLog();
    expect(log.length).toBe(3);
    expect(log.verify().ok).toBe(true);
  });

  it("entries are hash-chained: each prevHash equals the previous hash", () => {
    const log = seededLog();
    const e = log.all();
    expect(e[0].prevHash).toBe("0".repeat(64));
    expect(e[1].prevHash).toBe(e[0].hash);
    expect(e[2].prevHash).toBe(e[1].hash);
  });

  it("editing an old entry's decision breaks verification at that index", () => {
    const log = seededLog();
    // Attacker rewrites history: pretend the denied `cat .env` was allowed.
    (log.all()[2].decision as { outcome: string }).outcome = "allow";
    const res = log.verify();
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(2);
  });

  it("editing an early entry breaks the chain for every entry after it", () => {
    const log = seededLog();
    (log.all()[0].request as { command: string }).command = "rm -rf /";
    const res = log.verify();
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(0);
  });

  it("a forged signature is rejected", () => {
    const log = seededLog();
    (log.all()[1] as { signature: string }).signature = "00".repeat(64);
    const res = log.verify();
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(1);
  });

  it("head() returns the latest hash for onchain anchoring", () => {
    const log = seededLog();
    expect(log.head()).toBe(log.all().at(-1)!.hash);
    expect(log.head()).toMatch(/^[0-9a-f]{64}$/);
  });
});
