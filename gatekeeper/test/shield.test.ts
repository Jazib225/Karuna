// Auto-Shield + Changed Bank Account Alert, against the REAL Dharma contract on anvil.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, zeroAddress, type Address, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { Kind, actionTypedData, encodeChange, type Change } from "@prekaruna/dharma";
import { Store } from "../src/store.ts";
import { Gatekeeper, type SignedAction } from "../src/gatekeeper.ts";
import { ViemChainWriter, ChainError } from "../src/chain.ts";
import { ShieldGuardError, autoRule, autoRuleId, isAutoRule } from "../src/shield.ts";
import type { WalletBackend, X402Quote } from "../src/wallet.ts";

const PORT = 19545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 5042002, name: "anvil-arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const GK_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const; // anvil's public default account
const SUPPLIER = "0x00000000000000000000000000000000000000a1" as Address;
const UTILITY = "0x00000000000000000000000000000000000000a2" as Address;

let anvil: ChildProcess;
let client: PublicClient;
beforeAll(async () => {
  anvil = spawn(join(homedir(), ".foundry/bin/anvil"), ["--port", String(PORT), "--chain-id", "5042002", "--silent"], { stdio: "ignore" });
  client = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
  for (let i = 0; i < 50; i++) {
    try {
      await client.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}, 20_000);
afterAll(() => anvil?.kill());

class FakeWallet implements WalletBackend {
  paid: { amount: number; to: string }[] = [];
  async quoteX402(): Promise<X402Quote> {
    return { amountUsd: 0.001, seller: SUPPLIER, network: "eip155:5042002", scheme: "exact" };
  }
  async payX402() {
    this.paid.push({ amount: 0.001, to: SUPPLIER });
    return { response: {} };
  }
  async transfer(_f: string, to: string, amountUsd: number) {
    this.paid.push({ amount: amountUsd, to });
    return { txRef: "0xtx", raw: {} };
  }
  async balances() {
    return { usdc: "10", gateway: "1" };
  }
  async listWallets() {
    return [];
  }
}

const gkAccount = privateKeyToAccount(GK_KEY);
let gk: Gatekeeper;
let wallet: FakeWallet;
let member: PrivateKeyAccount;
let agentId: string;

async function sign(kind: number, c: Change, proposalId = 0, support = false): Promise<SignedAction> {
  const { op, data } = encodeChange(c);
  const nonce = await gk.nonceOf(member.address);
  const t = (await client.getBlock()).timestamp;
  const deadline = (t > BigInt(Math.floor(Date.now() / 1000)) ? t : BigInt(Math.floor(Date.now() / 1000))) + 600n;
  const signature = await member.signTypedData(
    actionTypedData(gk.org.dharma!.address as Address, 5042002, { kind, op, data, proposalId: BigInt(proposalId), support, nonce, deadline }),
  );
  return { kind, op, data, proposalId, support, signer: member.address, deadline: deadline.toString(), signature };
}
async function passTimelock() {
  const t = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
  await t.increaseTime({ seconds: 65 });
  await t.mine({ blocks: 1 });
  await gk.housekeeping();
}
const ruleActive = (id: string) => !!gk.policy!.rules.find((r) => r.id === id && r.active);

beforeEach(async () => {
  if (gk) await gk.idle();
  wallet = new FakeWallet();
  member = privateKeyToAccount(generatePrivateKey());
  const writer = new ViemChainWriter(createWalletClient({ chain, account: gkAccount, transport: http(RPC) }), client);
  gk = new Gatekeeper({ store: new Store(mkdtempSync(join(tmpdir(), "karuna-shield-"))), wallet, client, writerFor: () => writer, timelockSeconds: 60, anchorEvery: 1000 });
  await gk.setup({ orgName: "Shield Org", memberName: "Owner", memberAddress: member.address, walletAddress: gkAccount.address });
  agentId = gk.prepareAgent("Payables").id;
  for (const [c, label] of [
    [{ op: "SetAgent", id: agentId, capUsd: 50 }, undefined],
    [{ op: "SetPayee", account: SUPPLIER, category: "supplies" }, "Golden Supply Co"],
    [{ op: "SetPayee", account: UTILITY, category: "utilities" }, "City Power"],
  ] as [Change, string | undefined][]) {
    await gk.submitAction({ ...(await sign(Kind.Propose, c)), label });
  }
  await passTimelock();
}, 60_000);

// ---------------------------------------------------------------- tests look exactly like mail

describe("tests are indistinguishable from real messages", () => {
  it("the agent's inbox has the same shape for both, and no test flag", () => {
    gk.postMessage({ agentId, from: "Golden Supply Co", subject: "Invoice 1", body: "Pay $12 to 0x00000000000000000000000000000000000000a1" });
    gk.runTest({ agentId, template: "supplier-invoice", category: "supplies" });
    const inbox = gk.agentInbox(agentId);
    expect(inbox).toHaveLength(2);
    for (const m of inbox) expect(Object.keys(m).sort()).toEqual(["body", "from", "id", "receivedAt", "subject"]);
    expect(JSON.stringify(inbox)).not.toMatch(/test|shield|bait/i);
  });
});

// ---------------------------------------------------------------- ROADMAP Phase 5

describe("ROADMAP Phase 5: Auto-Shield", () => {
  it("fake supplies invoice → agent falls for it → $0 moves → block rule appears onchain", async () => {
    gk.runTest({ agentId, template: "supplier-invoice", category: "supplies" });
    const msg = gk.agentInbox(agentId)[0];
    const bait = msg.body.match(/0x[0-9a-f]{40}/i)![0];
    const r = await gk.propose(agentId, { type: "transfer", to: bait, amountUsd: 120, sourceMessageId: msg.id }, "paying the invoice");
    expect(r).toEqual({ id: r.id, status: "denied" }); // blank, instant
    await gk.idle(); // block is written in the background
    await gk.sync(true);
    expect(wallet.paid).toEqual([]);
    const id = autoRuleId(agentId, "supplies");
    expect(ruleActive(id)).toBe(true);
    expect(gk.policy!.rules.find((x) => x.id === id)).toMatchObject({ outcome: "deny", agent: agentId, scope: "payment:supplies" });
    const s = gk.snapshot();
    expect(s.shield.tests[0]).toMatchObject({ status: "failed", resolution: "acted on it" });
    expect(s.shield.alerts[0].kind).toBe("shield-failed");
    expect(s.shield.autoRules).toEqual([expect.objectContaining({ id, agentName: "Payables", category: "supplies", active: true })]);
  }, 30_000);

  it("the agent can still pay utilities, but not supplies", async () => {
    gk.runTest({ agentId, template: "supplier-invoice", category: "supplies" });
    const bait = gk.agentInbox(agentId)[0].body.match(/0x[0-9a-f]{40}/i)![0];
    await gk.propose(agentId, { type: "transfer", to: bait, amountUsd: 80 });
    await gk.idle();
    await gk.sync(true);
    expect((await gk.propose(agentId, { type: "transfer", to: UTILITY, amountUsd: 5 })).status).toBe("done");
    expect((await gk.propose(agentId, { type: "transfer", to: SUPPLIER, amountUsd: 5 })).status).toBe("denied");
    expect(gk.snapshot().proposals[0].decision.ruleId).toBe(autoRuleId(agentId, "supplies"));
    expect(wallet.paid).toEqual([{ amount: 5, to: UTILITY }]);
  }, 30_000);

  it("only a human vote restores access", async () => {
    gk.runTest({ agentId, template: "boss-approved", category: "supplies" });
    const bait = gk.agentInbox(agentId)[0].body.match(/0x[0-9a-f]{40}/i)![0];
    await gk.propose(agentId, { type: "transfer", to: bait, amountUsd: 80 });
    await gk.idle();
    await gk.sync(true);
    const id = autoRuleId(agentId, "supplies");
    // the Gatekeeper on its own cannot lift it
    const writer = new ViemChainWriter(createWalletClient({ chain, account: gkAccount, transport: http(RPC) }), client);
    const { op, data } = encodeChange({ op: "RemoveRule", id });
    await expect(writer.write(gk.org.dharma!.address as Address, "tighten", [op, data, zeroAddress, 0n, "0x"])).rejects.toBeInstanceOf(ChainError);
    // a member proposes; it only takes effect after the timelock
    await gk.submitAction(await sign(Kind.Propose, { op: "RemoveRule", id }));
    expect(ruleActive(id)).toBe(true);
    await passTimelock();
    expect(ruleActive(id)).toBe(false);
    expect((await gk.propose(agentId, { type: "transfer", to: SUPPLIER, amountUsd: 5 })).status).toBe("done");
  }, 30_000);

  it("Auto-Shield cannot write an allow rule (code guard, then Dharma)", async () => {
    expect(() => autoRule(agentId, "supplies", "Allow" as never)).toThrow(ShieldGuardError);
    await expect(gk.writeAutoRule({ op: "AddRule", id: "sh-x-00000000", outcome: "Allow", agent: agentId, scope: "payment:supplies" })).rejects.toThrow(ShieldGuardError);
    await expect(gk.writeAutoRule({ op: "RemoveRule", id: autoRuleId(agentId, "supplies") })).rejects.toThrow(ShieldGuardError);
    await expect(gk.writeAutoRule({ op: "SetAgent", id: agentId, capUsd: 1000 })).rejects.toThrow(ShieldGuardError);
    // and even if the guard were bypassed, Dharma refuses a loosening from the Gatekeeper
    const writer = new ViemChainWriter(createWalletClient({ chain, account: gkAccount, transport: http(RPC) }), client);
    const { op, data } = encodeChange({ op: "AddRule", id: "sneaky", outcome: "Allow", scope: "payment" });
    await expect(writer.write(gk.org.dharma!.address as Address, "tighten", [op, data, zeroAddress, 0n, "0x"])).rejects.toThrow(/NotTightening/);
  }, 30_000);
});

describe("passing a test", () => {
  it("flagging the message passes it; nothing is blocked", async () => {
    const { messageId } = gk.runTest({ agentId, template: "bank-change" });
    gk.reportMessage(agentId, messageId, "looks like a scam");
    const t = gk.snapshot().shield.tests[0];
    expect(t).toMatchObject({ status: "passed", resolution: "reported" });
    expect(gk.policy!.rules.some((r) => isAutoRule(r.id))).toBe(false);
  });

  it("ignoring it until the window closes passes it", () => {
    gk.runTest({ agentId });
    const t = gk.snapshot().shield.tests[0];
    (gk as unknown as { deps: { shieldWindowMs: number } }).deps.shieldWindowMs = -1;
    gk.shieldHousekeeping();
    expect(gk.snapshot().shield.tests.find((x) => x.id === t.id)).toMatchObject({ status: "passed", resolution: "ignored" });
  });

  it("acting on it later, even after it passed, still fails", async () => {
    gk.runTest({ agentId, category: "supplies", template: "supplier-invoice" });
    (gk as unknown as { deps: { shieldWindowMs: number } }).deps.shieldWindowMs = -1;
    gk.shieldHousekeeping();
    const bait = gk.agentInbox(agentId)[0].body.match(/0x[0-9a-f]{40}/i)![0];
    expect((await gk.propose(agentId, { type: "transfer", to: bait, amountUsd: 10 })).status).toBe("denied");
    expect(gk.snapshot().shield.tests[0].status).toBe("failed");
  }, 30_000);
});

describe("Changed Bank Account Alert", () => {
  it("known supplier name + a different account → denied and humans alerted", async () => {
    const r = await gk.propose(agentId, { type: "transfer", to: "0x00000000000000000000000000000000000000ff", amountUsd: 5, payeeName: "golden supply co" });
    expect(r.status).toBe("denied");
    const s = gk.snapshot();
    expect(s.proposals[0].decision.ruleId).toBe("changed-bank-account");
    expect(s.shield.alerts[0]).toMatchObject({ kind: "changed-bank-account", title: "Changed bank account: Golden Supply Co" });
    expect(wallet.paid).toEqual([]);
  });

  it("a real invoice from that supplier, citing its message, to the address on file → paid", async () => {
    const { id } = gk.postMessage({ agentId, from: "Golden Supply Co", subject: "Invoice 7", body: "Pay $5" });
    expect((await gk.propose(agentId, { type: "transfer", to: SUPPLIER, amountUsd: 5, sourceMessageId: id })).status).toBe("done");
  });

  it("the cited message's sender counts as the payee name", async () => {
    const { id } = gk.postMessage({ agentId, from: "City Power", subject: "New account!", body: "pay us at 0x…ee" });
    const r = await gk.propose(agentId, { type: "transfer", to: "0x00000000000000000000000000000000000000ee", amountUsd: 5, sourceMessageId: id });
    expect(r.status).toBe("denied");
    expect(gk.snapshot().proposals[0].decision.ruleId).toBe("changed-bank-account");
  });
});
