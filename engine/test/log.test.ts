import { describe, it, expect } from "vitest";
import { createPublicKey } from "node:crypto";
import { SignedLog } from "../src/log.ts";
import { evaluate } from "../src/engine.ts";
import { fixtureContext, VENDOR } from "./fixture.ts";

const ctx = fixtureContext();
const at = (s: number) => new Date(Date.UTC(2026, 10, 9, 0, 0, s)); // fixed clock

function seededLog() {
  const log = new SignedLog();
  const reqs = [
    { tool: "shell", command: "ls ./workspace" } as const,
    { tool: "payment", agent: "buyer", to: VENDOR, amountUsd: 0.05 } as const,
    { tool: "shell", command: "cat .env" } as const,
  ];
  reqs.forEach((r, i) => log.append(r, evaluate(r, ctx), at(i)));
  return log;
}

describe("signed tamper-evident log (edit an old entry -> chain check fails)", () => {
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

  it("event entries (approvals, freezes) are chained and signed too", () => {
    const log = seededLog();
    log.appendEvent({ type: "approved", proposalId: "p1", memberId: "m1" }, at(9));
    expect(log.verify().ok).toBe(true);
    (log.all()[3].event as unknown as { memberId: string }).memberId = "someone-else";
    expect(log.verify()).toMatchObject({ ok: false, brokenAt: 3 });
  });

  it("restore() reloads a stored chain and refuses an edited one", () => {
    const log = seededLog();
    const keys = { privateKey: (log as unknown as { privateKey: import("node:crypto").KeyObject }).privateKey, publicKey: log.publicKey };
    const stored = JSON.parse(JSON.stringify(log.all()));
    const again = SignedLog.restore(stored, keys);
    again.appendEvent({ type: "resumed" });
    expect(again.verify().ok).toBe(true);
    stored[1].decision.outcome = "deny";
    expect(() => SignedLog.restore(stored, keys)).toThrow(/failed verification at entry 1/);
  });

  it("publicKeyPem() exports a key anyone can verify the log with", () => {
    const log = seededLog();
    const pem = log.publicKeyPem();
    expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(log.verify(createPublicKey(pem)).ok).toBe(true);
  });

  it("head() returns the latest hash for onchain anchoring", () => {
    const log = seededLog();
    expect(log.head()).toBe(log.all().at(-1)!.hash);
    expect(log.head()).toMatch(/^[0-9a-f]{64}$/);
  });
});
