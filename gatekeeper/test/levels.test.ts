// Trust levels and the wallet watchdog, against the REAL Dharma contract (v3) on anvil.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { startAnvil } from "./anvil.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, parseAbiItem, type Address, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { Kind, actionTypedData, encodeChange, type Change } from "@prekaruna/dharma";
import { Store } from "../src/store.ts";
import { GATEWAY_WALLET, Gatekeeper, type SignedAction } from "../src/gatekeeper.ts";
import { ViemChainWriter } from "../src/chain.ts";
import type { WalletBackend, X402Quote } from "../src/wallet.ts";

const PORT = 22545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 5042002, name: "anvil-arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const GK_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const; // anvil's public default account
const PAYEE = "0x00000000000000000000000000000000000000a1" as Address;
const STRANGER = "0x00000000000000000000000000000000000000ee" as Address;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

let anvil: ChildProcess;
let client: PublicClient;
beforeAll(async () => {
  client = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
  anvil = await startAnvil(PORT);
}, 20_000);
afterAll(() => anvil?.kill());

class FakeWallet implements WalletBackend {
  paid: string[] = [];
  async quoteX402(): Promise<X402Quote> {
    return { amountUsd: 0.05, seller: PAYEE, network: "eip155:5042002", scheme: "exact" };
  }
  async payX402() {
    this.paid.push("x402");
    return { response: { ok: true } };
  }
  async transfer(_f: string, to: string) {
    this.paid.push(to);
    return { txRef: "circle-id", raw: {} };
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
let member: PrivateKeyAccount;
let agent: string;

async function sign(kind: number, c: Change): Promise<SignedAction> {
  const { op, data } = encodeChange(c);
  const nonce = await gk.nonceOf(member.address);
  const t = (await client.getBlock()).timestamp;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = (t > now ? t : now) + 600n;
  const signature = await member.signTypedData(actionTypedData(gk.org.dharma!.address as Address, 5042002, { kind, op, data, proposalId: 0n, support: false, nonce, deadline }));
  return { kind, op, data, proposalId: 0, support: false, signer: member.address, deadline: deadline.toString(), signature };
}
async function passTimelock() {
  const t = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
  await t.increaseTime({ seconds: 65 });
  await t.mine({ blocks: 1 });
  await gk.housekeeping();
}
const level = () => gk.levelOf(agent);
const streak = (n: number) => gk.setChainRecords({ records: { [agent]: { agent, level: level(), cleanStreak: n } } });

beforeEach(async () => {
  if (gk) await gk.idle();
  member = privateKeyToAccount(generatePrivateKey());
  const writer = new ViemChainWriter(createWalletClient({ chain, account: gkAccount, transport: http(RPC) }), client);
  gk = new Gatekeeper({ store: new Store(mkdtempSync(join(tmpdir(), "karuna-levels-"))), wallet: new FakeWallet(), client, writerFor: () => writer, timelockSeconds: 60, anchorEvery: 1000 });
  await gk.setup({ orgName: "Levels Org", memberName: "Owner", memberAddress: member.address, walletAddress: gkAccount.address });
  agent = gk.prepareAgent("Research").id;
  for (const c of [{ op: "SetAgent", id: agent, capUsd: 100 }, { op: "SetPayee", account: PAYEE, category: "data" }] as Change[]) {
    await gk.submitAction(await sign(Kind.Propose, c));
  }
  await passTimelock();
}, 60_000);

describe("trust levels", () => {
  it("a new org runs the current Dharma and agents start at Level 0 with its limits, not the allowance", async () => {
    expect(gk.policy!.version).toBe(4);
    expect(level()).toBe(0);
    expect(gk.policy!.levelLimits![0]).toEqual({ perPaymentUsd: 0.1, dailyUsd: 1 });
    expect((await gk.propose(agent, { type: "transfer", to: PAYEE, amountUsd: 0.1 })).status).toBe("done");
    expect((await gk.propose(agent, { type: "transfer", to: PAYEE, amountUsd: 0.5 })).status).toBe("pending"); // the $100 allowance no longer applies
  }, 30_000);

  it("raising a level needs a clean record from the Stream, one level at a time, then a vote", async () => {
    await expect(gk.submitAction(await sign(Kind.Propose, { op: "SetLevel", agent, level: 1, reason: "vote" }))).rejects.toThrow(/record hasn't arrived/);
    streak(9);
    await expect(gk.submitAction(await sign(Kind.Propose, { op: "SetLevel", agent, level: 1, reason: "vote" }))).rejects.toThrow(/9 of 10 clean actions/);
    streak(10);
    await expect(gk.submitAction(await sign(Kind.Propose, { op: "SetLevel", agent, level: 2, reason: "vote" }))).rejects.toThrow(/one at a time/);
    await gk.submitAction(await sign(Kind.Propose, { op: "SetLevel", agent, level: 1, reason: "vote" }));
    expect(level()).toBe(0); // not until the wait passes
    await passTimelock();
    expect(level()).toBe(1);
    expect(gk.snapshot().policy!.agents[0]).toMatchObject({ level: 1, eligibility: { target: 2, needed: 25 } });
    // Level 1 widens more than payments: workspace writes and messages go through on their own.
    expect((await gk.propose(agent, { type: "action", tool: "file", fileOp: "write", path: "workspace/notes.md" })).status).toBe("allowed");
  }, 60_000);

  it("a member lowers a level instantly; raising can't use the fast path", async () => {
    streak(10);
    await gk.submitAction(await sign(Kind.Propose, { op: "SetLevel", agent, level: 1, reason: "vote" }));
    await passTimelock();
    await expect(gk.submitAction(await sign(Kind.Tighten, { op: "SetLevel", agent, level: 2, reason: "member" }))).rejects.toThrow(/Only lowering/);
    await gk.submitAction(await sign(Kind.Tighten, { op: "SetLevel", agent, level: 0, reason: "member" }));
    expect(level()).toBe(0);
  }, 60_000);

  it("a Tripwire drops the agent to Level 0 and is recorded onchain for that agent", async () => {
    streak(10);
    await gk.submitAction(await sign(Kind.Propose, { op: "SetLevel", agent, level: 1, reason: "vote" }));
    await passTimelock();
    const trap = gk.mintTrapSet(agent);
    await gk.propose(agent, { type: "action", tool: "http", method: "GET", url: `https://api.github.com/user?token=${trap.secrets[0].value}` });
    await gk.idle();
    await gk.sync(true);
    expect(level()).toBe(0);
    const logs = await client.getLogs({ address: gk.org.dharma!.address as Address, event: parseAbiItem("event TripwireFired(bytes32 indexed agent, string reason)"), fromBlock: 0n });
    expect(logs).toHaveLength(1);
    expect(gk.snapshot().shield.alerts.some((a) => a.kind === "level-lowered")).toBe(true);
  }, 60_000);

  /** Up to Level 2 the normal way: a clean record, then a vote, one level at a time. */
  async function toLevel2() {
    for (const [target, clean] of [[1, 10], [2, 25]] as const) {
      streak(clean);
      await gk.submitAction(await sign(Kind.Propose, { op: "SetLevel", agent, level: target, reason: "vote" }));
      await passTimelock();
    }
    expect(level()).toBe(2);
  }

  it("from Level 2, a failed Drill drops exactly one level (to 1, not 0)", async () => {
    await toLevel2();
    gk.runTest({ agentId: agent, template: "supplier-invoice", category: "data" });
    const msg = gk.agentInbox(agent)[0];
    const bait = msg.body.match(/0x[0-9a-f]{40}/i)![0];
    expect((await gk.propose(agent, { type: "transfer", to: bait, amountUsd: 12, sourceMessageId: msg.id })).status).toBe("denied");
    await gk.idle();
    await gk.sync(true);
    expect(level()).toBe(1);
  }, 90_000);

  it("from Level 2, a Tripwire drops the agent all the way to Level 0", async () => {
    await toLevel2();
    const trap = gk.mintTrapSet(agent);
    await gk.propose(agent, { type: "action", tool: "http", method: "GET", url: `https://api.github.com/user?token=${trap.secrets[0].value}` });
    await gk.idle();
    await gk.sync(true);
    expect(level()).toBe(0);
  }, 90_000);

  it("a member lowers by more than one level at once (2 to 0), with no vote or wait", async () => {
    await toLevel2();
    await gk.submitAction(await sign(Kind.Tighten, { op: "SetLevel", agent, level: 0, reason: "member" }));
    expect(level()).toBe(0);
  }, 90_000);

  it("a failed Drill lowers the agent one level", async () => {
    streak(10);
    await gk.submitAction(await sign(Kind.Propose, { op: "SetLevel", agent, level: 1, reason: "vote" }));
    await passTimelock();
    gk.runTest({ agentId: agent, template: "supplier-invoice", category: "data" });
    const msg = gk.agentInbox(agent)[0];
    const bait = msg.body.match(/0x[0-9a-f]{40}/i)![0];
    expect((await gk.propose(agent, { type: "transfer", to: bait, amountUsd: 12, sourceMessageId: msg.id })).status).toBe("denied");
    await gk.idle();
    await gk.sync(true);
    expect(level()).toBe(0);
  }, 60_000);

  it("each log anchor publishes every agent's running totals (ActionsRecorded)", async () => {
    await gk.propose(agent, { type: "transfer", to: PAYEE, amountUsd: 0.05 });
    await gk.propose(agent, { type: "transfer", to: STRANGER, amountUsd: 0.05 }); // denied
    await gk.anchorNow();
    const logs = await client.getLogs({ address: gk.org.dharma!.address as Address, event: parseAbiItem("event ActionsRecorded(bytes32 indexed agent, uint64 completed, uint64 denied)"), fromBlock: 0n });
    expect(logs.at(-1)!.args).toMatchObject({ completed: 1n, denied: 1n });
  }, 30_000);
});

describe("wallet watchdog", () => {
  it("a transfer Karuna made matches, a Gateway deposit is expected, and anything else freezes every agent", async () => {
    const paid = await gk.propose(agent, { type: "transfer", to: PAYEE, amountUsd: 0.1 });
    expect(paid.status).toBe("done");
    expect(gk.watchdogTransfer({ txHash: tx(1), to: PAYEE, amountUsd: 0.1, block: 10 })).toMatchObject({ verdict: "matched", proposalId: paid.id });
    // the same payment can't vouch for a second transfer
    expect(gk.watchdogTransfer({ txHash: tx(2), to: PAYEE, amountUsd: 0.1, block: 11 })).toMatchObject({ verdict: "unapproved" });
    await gk.idle();
    await gk.sync(true);
    expect(gk.policy!.frozen).toBe(true);
    expect(gk.isFrozen()).toMatchObject({ confirmed: true });
    expect(gk.snapshot().shield.alerts[0]).toMatchObject({ kind: "watchdog" });
    const reported = await client.getLogs({ address: gk.org.dharma!.address as Address, event: parseAbiItem("event UnapprovedTransfer(bytes32 indexed txHash, address indexed to, uint256 amountMicroUsd)"), fromBlock: 0n });
    expect(reported).toHaveLength(1);
    expect(gk.watchdogTransfer({ txHash: tx(3), to: GATEWAY_WALLET, amountUsd: 1, block: 12 })).toMatchObject({ verdict: "gateway-deposit" });
  }, 60_000);

  it("the same transfer reported twice (QuickNode and the RPC fallback) is handled once", async () => {
    const a = gk.watchdogTransfer({ txHash: tx(9), to: STRANGER, amountUsd: 2, block: 20 });
    const b = gk.watchdogTransfer({ txHash: tx(9), to: STRANGER, amountUsd: 2, block: 20, source: "rpc" });
    expect(b).toBe(a);
    expect(gk.snapshot().watchdog.events).toHaveLength(1);
    await gk.idle();
  }, 30_000);

  it("rejects malformed reports", () => {
    expect(() => gk.watchdogTransfer({ txHash: "0x12", to: PAYEE, amountUsd: 1 })).toThrow(/Malformed/);
  });
});
