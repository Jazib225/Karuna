// Swarm Stopper + Trap Passwords, against the REAL Dharma contract on anvil.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { startAnvil } from "./anvil.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, type Address, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { Kind, actionTypedData, encodeChange, settingChange, type Change } from "@prekaruna/dharma";
import { Store } from "../src/store.ts";
import { Gatekeeper, type SignedAction } from "../src/gatekeeper.ts";
import { ViemChainWriter } from "../src/chain.ts";
import { findCredential } from "../src/swarm.ts";
import type { WalletBackend, X402Quote } from "../src/wallet.ts";

const PORT = 20545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 5042002, name: "anvil-arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const GK_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const; // anvil's public default account
const PAYEE = "0x00000000000000000000000000000000000000a1" as Address;
const STRANGER = "0x00000000000000000000000000000000000000e7";

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
    return { amountUsd: 0.001, seller: PAYEE, network: "eip155:5042002", scheme: "exact" };
  }
  async payX402() {
    this.paid.push("x402");
    return { response: {} };
  }
  async transfer(_f: string, to: string) {
    this.paid.push(to);
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
let bills: string, supplies: string, research: string;

async function sign(kind: number, c: Change): Promise<SignedAction> {
  const { op, data } = encodeChange(c);
  const nonce = await gk.nonceOf(member.address);
  const t = (await client.getBlock()).timestamp;
  const deadline = (t > BigInt(Math.floor(Date.now() / 1000)) ? t : BigInt(Math.floor(Date.now() / 1000))) + 600n;
  const signature = await member.signTypedData(actionTypedData(gk.org.dharma!.address as Address, 5042002, { kind, op, data, proposalId: 0n, support: false, nonce, deadline }));
  return { kind, op, data, proposalId: 0, support: false, signer: member.address, deadline: deadline.toString(), signature };
}
async function passTimelock() {
  const t = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
  await t.increaseTime({ seconds: 65 });
  await t.mine({ blocks: 1 });
  await gk.housekeeping();
}
const frozenEverywhere = async () => {
  await gk.idle();
  await gk.sync(true);
  return !!gk.isFrozen() && gk.policy!.frozen;
};

beforeEach(async () => {
  if (gk) await gk.idle();
  wallet = new FakeWallet();
  member = privateKeyToAccount(generatePrivateKey());
  const writer = new ViemChainWriter(createWalletClient({ chain, account: gkAccount, transport: http(RPC) }), client);
  gk = new Gatekeeper({
    store: new Store(mkdtempSync(join(tmpdir(), "karuna-swarm-"))), wallet, client, writerFor: () => writer,
    timelockSeconds: 60, anchorEvery: 1000, swarmAgents: 2, swarmWindowMs: 60_000,
  });
  await gk.setup({ orgName: "Swarm Org", memberName: "Owner", memberAddress: member.address, walletAddress: gkAccount.address });
  bills = gk.prepareAgent("Bills").id;
  supplies = gk.prepareAgent("Supplies").id;
  research = gk.prepareAgent("Research").id;
  for (const [c, label] of [
    [{ op: "SetAgent", id: bills, capUsd: 50 }, undefined],
    [{ op: "SetAgent", id: supplies, capUsd: 10 }, undefined],
    [{ op: "SetAgent", id: research, capUsd: 2 }, undefined],
    [{ op: "SetPayee", account: PAYEE, category: "supplies" }, "Supplier"],
    [{ op: "SetLevelLimits", level: 0, perPaymentUsd: 10, dailyUsd: 50 }, undefined],
    [{ op: "SetLevelLimits", level: 1, perPaymentUsd: 10, dailyUsd: 50 }, undefined],
  ] as [Change, string | undefined][]) {
    await gk.submitAction({ ...(await sign(Kind.Propose, c)), label });
  }
  await passTimelock();
  // Agents that message each other: Level 1 (a clean record, then a vote).
  gk.setChainRecords({ records: Object.fromEntries([bills, supplies, research].map((a) => [a, { agent: a, level: 0, cleanStreak: 10 }])) });
  for (const a of [bills, supplies, research]) await gk.submitAction(await sign(Kind.Propose, { op: "SetLevel", agent: a, level: 1, reason: "vote" }));
  await passTimelock();
}, 60_000);

describe("agent-to-agent messages go through Karuna (no hidden channel)", () => {
  it("a normal message is logged and delivered to the other agent's inbox", async () => {
    const r = await gk.propose(research, { type: "message", to: bills, body: "Flour prices are up 4% this week." });
    expect(r.status).toBe("allowed");
    expect(gk.agentInbox(bills)[0]).toMatchObject({ from: "Research (agent)", body: "Flour prices are up 4% this week." });
    expect(gk.isFrozen()).toBeNull();
  });

  it("a transaction hash is not mistaken for a credential", () => {
    expect(findCredential(`paid, tx 0x${"ab".repeat(32)}`)).toBeNull();
    expect(findCredential(`private key: 0x${"ab".repeat(32)}`)).toBe("labelled private key");
  });
});

describe("ROADMAP Phase 6: research agent finds the trap key and shares it → all frozen", () => {
  it("sharing a planted trap credential freezes every agent, locally at once and then onchain", async () => {
    const traps = gk.mintTrapSet(research);
    gk.plantTrapInInbox(traps.id, research);
    const leaked = gk.agentInbox(research)[0].body;
    const key = leaked.match(/STRIPE_SECRET_KEY=(\S+)/)![1];

    const r = await gk.propose(research, { type: "message", to: supplies, body: `found a working key: ${key}` });
    expect(r.status).toBe("denied");
    expect(gk.isFrozen()).toMatchObject({ by: "Tripwire" }); // instantly, before the chain
    for (const a of [bills, supplies, research]) {
      expect((await gk.propose(a, { type: "transfer", to: PAYEE, amountUsd: 1 })).status).toBe("denied");
    }
    expect(gk.agentInbox(supplies)).toEqual([]); // the key never reached the other agent
    expect(await frozenEverywhere()).toBe(true); // and Dharma recorded the freeze
    const s = gk.snapshot();
    expect(s.swarm.trips[0].reason).toMatch(/shared a trap credential \(STRIPE_SECRET_KEY\)/);
    // Sharing it with a second teammate is the same swarm: one trip, one alert.
    await gk.propose(research, { type: "message", to: bills, body: `also you: ${key}` });
    const s2 = gk.snapshot();
    expect(s2.swarm.trips).toHaveLength(1);
    expect(s2.swarm.trips[0].agents).toEqual(expect.arrayContaining([research, supplies, bills]));
    expect(s2.swarm.trips[0].txRef).toMatch(/^0x/);
    expect(s2.shield.alerts.filter((a) => a.kind === "swarm-stopped")).toHaveLength(1);
    expect(s.shield.alerts.map((a) => a.kind)).toEqual(expect.arrayContaining(["swarm-stopped", "trap-touched"]));
    expect(wallet.paid).toEqual([]);
  }, 30_000);

  it("using a trap anywhere is denied and taints the agent; if it then messages anyone, everyone freezes", async () => {
    const traps = gk.mintTrapSet(null);
    const ghToken = traps.secrets.find((x) => x.name === "GITHUB_TOKEN")!.value;
    const used = await gk.propose(research, { type: "action", tool: "http", method: "GET", url: `https://api.github.com/user?token=${ghToken}` });
    expect(used.status).toBe("denied");
    expect(gk.snapshot().proposals[0].decision.ruleId).toBe("trap-password");
    expect(gk.isFrozen()).toBeNull(); // using it alone is a core-boundary denial…
    const hi = await gk.propose(research, { type: "message", to: bills, body: "hey, quick question" });
    expect(hi.status).toBe("denied"); // …messaging others afterwards is the swarm pattern
    expect(await frozenEverywhere()).toBe(true);
  }, 30_000);

  it("any credential-shaped secret in a message trips it, trap or not", async () => {
    const r = await gk.propose(bills, { type: "message", to: supplies, body: "use sk_live_51HxAbCdEfGhIjKlMnOpQrStUv" });
    expect(r.status).toBe("denied");
    expect(await frozenEverywhere()).toBe(true);
  }, 30_000);
});

describe("pivot: agents converging on the same new target", () => {
  it("two agents going after the same unknown address within the window → freeze", async () => {
    await gk.propose(research, { type: "transfer", to: STRANGER, amountUsd: 1 });
    expect(gk.isFrozen()).toBeNull();
    await gk.propose(supplies, { type: "transfer", to: STRANGER, amountUsd: 1 });
    expect(gk.isFrozen()).toMatchObject({ by: "Tripwire" });
    expect(gk.snapshot().swarm.trips[0].reason).toMatch(/2 agents went after the same new target/);
  }, 30_000);

  it("the team can vote the Swarm Stopper's trigger up, or off; it applies once the vote passes", async () => {
    await gk.submitAction(await sign(Kind.Propose, settingChange("swarmAgents", 3)));
    expect(gk.settings().swarmAgents).toBe(2); // not until the vote passes
    await passTimelock();
    expect(gk.snapshot().swarm.agentsToTrip).toBe(3);
    await gk.propose(research, { type: "transfer", to: STRANGER, amountUsd: 1 });
    await gk.propose(supplies, { type: "transfer", to: STRANGER, amountUsd: 1 });
    expect(gk.isFrozen()).toBeNull(); // two isn't enough any more
    await gk.propose(bills, { type: "transfer", to: STRANGER, amountUsd: 1 });
    expect(gk.isFrozen()).toMatchObject({ by: "Tripwire" });
  }, 60_000);

  it("with the Swarm Stopper voted off, agents converging on a new target don't freeze anyone", async () => {
    await gk.submitAction(await sign(Kind.Propose, settingChange("swarmAgents", 0)));
    await passTimelock();
    for (const a of [research, supplies, bills]) await gk.propose(a, { type: "transfer", to: STRANGER, amountUsd: 1 });
    expect(gk.isFrozen()).toBeNull();
  }, 60_000);

  it("the same agent retrying, or several agents paying a known payee, is not a swarm", async () => {
    await gk.propose(research, { type: "transfer", to: STRANGER, amountUsd: 1 });
    await gk.propose(research, { type: "transfer", to: STRANGER, amountUsd: 1 });
    await gk.propose(bills, { type: "transfer", to: PAYEE, amountUsd: 1 });
    await gk.propose(supplies, { type: "transfer", to: PAYEE, amountUsd: 1 });
    expect(gk.isFrozen()).toBeNull();
  });
});

describe("after a swarm freeze", () => {
  it("only a member vote (and the timelock) unfreezes", async () => {
    await gk.propose(bills, { type: "message", to: supplies, body: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" });
    expect(await frozenEverywhere()).toBe(true);
    await gk.submitAction(await sign(Kind.Propose, { op: "Unfreeze" }));
    expect(gk.policy!.frozen).toBe(true);
    await passTimelock();
    expect(gk.policy!.frozen).toBe(false);
    expect((await gk.propose(bills, { type: "transfer", to: PAYEE, amountUsd: 1 })).status).toBe("done");
  }, 30_000);
});
