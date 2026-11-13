import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { Gatekeeper, GatekeeperError } from "../src/gatekeeper.ts";
import type { WalletBackend, X402Quote } from "../src/wallet.ts";

const WALLET = "0x00000000000000000000000000000000000000aa";
const SELLER = "0x00000000000000000000000000000000000000bb";
const PAYEE = "0x00000000000000000000000000000000000000cc";
const STRANGER = "0x00000000000000000000000000000000000000dd";

/** In-memory wallet: records what was paid, lets a test change the seller's price. */
class FakeWallet implements WalletBackend {
  price = 0.001;
  paid: { kind: string; amount: number; to: string; max?: number }[] = [];
  async quoteX402(): Promise<X402Quote> {
    return { amountUsd: this.price, seller: SELLER, network: "eip155:5042002", scheme: "exact", transferMethod: "gateway" };
  }
  async payX402(_f: string, _u: string, _m: string, _b: string | undefined, maxUsd: number) {
    if (this.price > maxUsd) throw new Error(`Payment of $${this.price} exceeds --max-amount ${maxUsd}`);
    this.paid.push({ kind: "x402", amount: this.price, to: SELLER, max: maxUsd });
    return { response: { data: "secret data" }, transaction: "tx-x402" };
  }
  async transfer(_f: string, to: string, amountUsd: number) {
    this.paid.push({ kind: "transfer", amount: amountUsd, to });
    return { txRef: "0xtx", raw: {} };
  }
  async balances() {
    return { usdc: "10", gateway: "1" };
  }
  async listWallets() {
    return [WALLET];
  }
}

let dir: string, wallet: FakeWallet, gk: Gatekeeper, token: string, owner: string, second: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "karuna-gk-"));
  wallet = new FakeWallet();
  gk = new Gatekeeper(new Store(dir), wallet);
  owner = gk.setup({ orgName: "Test Org", memberName: "Owner", walletAddress: WALLET }).id;
  second = gk.addMember("Second", owner).id;
  gk.addRecipient({ address: SELLER, name: "Data seller", category: "data" }, owner);
  gk.addRecipient({ address: PAYEE, name: "Payee", category: "services" }, owner);
  token = gk.addAgent({ name: "Ops agent", dailyAllowanceUsd: 1 }, owner).token;
});

const agentId = () => gk.authenticateAgent(token)!.id;
const pending = () => gk.snapshot().proposals.filter((p) => p.status === "pending");

describe("setup is universal", () => {
  it("a new gatekeeper starts empty — no built-in org, agents, or recipients", () => {
    const fresh = new Gatekeeper(new Store(mkdtempSync(join(tmpdir(), "karuna-empty-"))), wallet);
    const s = fresh.snapshot();
    expect(s.setUp).toBe(false);
    expect(s.org.name).toBe("");
    expect(s.org.agents).toEqual([]);
    expect(s.org.recipients).toEqual([]);
    expect(s.org.members).toEqual([]);
  });

  it("agents cannot propose before setup", async () => {
    const fresh = new Gatekeeper(new Store(mkdtempSync(join(tmpdir(), "karuna-empty-"))), wallet);
    await expect(fresh.propose("x", { type: "transfer", to: PAYEE, amountUsd: 1 })).rejects.toThrow(/setup/);
  });

  it("agent tokens are never stored, only their hash", () => {
    const org = readFileSync(join(dir, "org.json"), "utf8");
    expect(org).not.toContain(token);
    expect(gk.authenticateAgent(token)).not.toBeNull();
    expect(gk.authenticateAgent("kag_wrong")).toBeNull();
  });
});

describe("Phase 2: allowed request pays and returns the result", () => {
  it("x402 purchase within allowance → paid → agent gets the data", async () => {
    const r = await gk.propose(agentId(), { type: "x402", url: "http://seller.test/v1/data" });
    expect(r.status).toBe("done");
    expect(r.result).toEqual({ data: "secret data" });
    expect(wallet.paid).toEqual([{ kind: "x402", amount: 0.001, to: SELLER, max: 0.001 }]);
    expect(gk.spentToday()[agentId()]).toBe(0.001);
  });

  it("transfer to a known recipient within allowance → sent", async () => {
    const r = await gk.propose(agentId(), { type: "transfer", to: PAYEE, amountUsd: 0.5 });
    expect(r.status).toBe("done");
    expect(wallet.paid[0]).toMatchObject({ kind: "transfer", amount: 0.5, to: PAYEE });
  });

  it("over the daily allowance → waits for a human; nothing paid yet", async () => {
    const r = await gk.propose(agentId(), { type: "transfer", to: PAYEE, amountUsd: 5 }, "invoice 12");
    expect(r).toEqual({ id: r.id, status: "pending" });
    expect(wallet.paid).toEqual([]);
    const p = pending()[0];
    expect(p.reason).toBe("invoice 12");
    expect(p.facts.find((f) => f.label === "Recipient")?.value).toBe("Payee");
  });
});

describe("blank denial to the agent (CLAUDE.md §2 rule 7)", () => {
  it("unknown recipient → denied with no reason, real reason kept for humans", async () => {
    const r = await gk.propose(agentId(), { type: "transfer", to: STRANGER, amountUsd: 0.01 });
    expect(r).toEqual({ id: r.id, status: "denied" });
    const p = gk.snapshot().proposals[0];
    expect(p.decision.ruleId).toBe("unknown-recipient");
  });

  it("non-payment actions are decided by the same engine", async () => {
    expect((await gk.propose(agentId(), { type: "action", tool: "shell", command: "cat .env" })).status).toBe("denied");
    expect((await gk.propose(agentId(), { type: "action", tool: "shell", command: "ls ./workspace" })).status).toBe("allowed");
  });

  it("an agent cannot read another agent's proposals", async () => {
    const other = gk.addAgent({ name: "Other", dailyAllowanceUsd: 0 }, owner).agent.id;
    const r = await gk.propose(agentId(), { type: "transfer", to: PAYEE, amountUsd: 0.1 });
    expect(gk.agentView(other, r.id)).toBeNull();
  });
});

describe("Exact Match (CLAUDE.md §2 rule 8)", () => {
  it("approve with the hash on the card → executes exactly that payment", async () => {
    await gk.propose(agentId(), { type: "transfer", to: PAYEE, amountUsd: 5 });
    const p = pending()[0];
    const r = await gk.approve(p.id, owner, p.payloadHash);
    expect(r.status).toBe("executed");
    expect(wallet.paid).toEqual([{ kind: "transfer", amount: 5, to: PAYEE }]);
  });

  it("approving a different hash than the payload → refused, nothing paid", async () => {
    await gk.propose(agentId(), { type: "transfer", to: PAYEE, amountUsd: 5 });
    const p = pending()[0];
    await expect(gk.approve(p.id, owner, "0".repeat(64))).rejects.toThrow(/Exact Match failed/);
    expect(wallet.paid).toEqual([]);
  });

  it("seller raises the price after approval → refused, nothing paid", async () => {
    gk.updateAgent(agentId(), { dailyAllowanceUsd: 0 }, owner); // force human approval
    await gk.propose(agentId(), { type: "x402", url: "http://seller.test/v1/data" });
    const p = pending()[0];
    wallet.price = 0.002; // terms change between approval card and payment
    const r = await gk.approve(p.id, owner, p.payloadHash);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/Seller now asks \$0\.002 but \$0\.001 was approved/);
    expect(wallet.paid).toEqual([]);
  });

  it("stored payload edited after the card was shown → refused at execution", async () => {
    await gk.propose(agentId(), { type: "transfer", to: PAYEE, amountUsd: 5 });
    const p = pending()[0];
    const live = (gk as unknown as { state: { proposals: { id: string; payload: { amountUsd: number } }[] } }).state.proposals.find((x) => x.id === p.id)!;
    live.payload.amountUsd = 50; // tampering with the queue
    const r = await gk.approve(p.id, owner, p.payloadHash);
    expect(r.status).toBe("failed");
    expect(wallet.paid).toEqual([]);
  });
});

describe("two-person approval", () => {
  it("at or above the threshold needs two different members", async () => {
    gk.updateSettings({ twoPersonThresholdUsd: 2 }, owner);
    await gk.propose(agentId(), { type: "transfer", to: PAYEE, amountUsd: 3 });
    const p = pending()[0];
    expect((await gk.approve(p.id, owner, p.payloadHash)).status).toBe("needs-another-approval");
    await expect(gk.approve(p.id, owner, p.payloadHash)).rejects.toThrow(/already approved/);
    expect(wallet.paid).toEqual([]);
    expect((await gk.approve(p.id, second, p.payloadHash)).status).toBe("executed");
    expect(wallet.paid).toHaveLength(1);
  });
});

describe("panic button", () => {
  it("any one member freezes everything; agents get the same blank denial", async () => {
    gk.freeze(owner);
    const r = await gk.propose(agentId(), { type: "x402", url: "http://seller.test/v1/data" });
    expect(r).toEqual({ id: r.id, status: "denied" });
    expect(wallet.paid).toEqual([]);
  });

  it("approvals are blocked while frozen", async () => {
    await gk.propose(agentId(), { type: "transfer", to: PAYEE, amountUsd: 5 });
    gk.freeze(owner);
    const p = pending()[0];
    await expect(gk.approve(p.id, owner, p.payloadHash)).rejects.toBeInstanceOf(GatekeeperError);
  });

  it("unfreezing needs a vote from two members", () => {
    gk.freeze(owner);
    gk.voteUnfreeze(owner);
    expect(gk.snapshot().frozen).not.toBeNull();
    gk.voteUnfreeze(second);
    expect(gk.snapshot().frozen).toBeNull();
  });
});

describe("nothing is erasable", () => {
  it("every decision and event lands in the signed log, which survives a restart", async () => {
    await gk.propose(agentId(), { type: "x402", url: "http://seller.test/v1/data" });
    gk.freeze(owner);
    const types = gk.log.all().map((e) => e.event?.type ?? `decision:${e.decision?.ruleId}`);
    expect(types).toContain("decision:payment-within-allowance");
    expect(types).toContain("executed");
    expect(types).toContain("freeze");
    const reopened = new Gatekeeper(new Store(dir), wallet);
    expect(reopened.log.length).toBe(gk.log.length);
    expect(reopened.log.verify().ok).toBe(true);
  });

  it("refuses to start on an edited log", () => {
    const path = join(dir, "log.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const e = JSON.parse(lines[0]);
    e.event.org = "Someone Else";
    lines[0] = JSON.stringify(e);
    writeFileSync(path, lines.join("\n") + "\n");
    expect(() => new Gatekeeper(new Store(dir), wallet)).toThrow(/failed verification/);
  });
});
