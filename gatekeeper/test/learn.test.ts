// Learns From Your Choices + Preview Before Loosening, against the REAL Dharma contract on anvil.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { startAnvil } from "./anvil.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { Kind, actionTypedData, encodeChange, paymentDecisionTypedData, type Change } from "@prekaruna/dharma";
import { Store } from "../src/store.ts";
import { Gatekeeper, type SignedAction } from "../src/gatekeeper.ts";
import { ViemChainWriter } from "../src/chain.ts";
import { applyChange, band, learnedDenyId } from "../src/learn.ts";
import type { WalletBackend, X402Quote } from "../src/wallet.ts";

const PORT = 21545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 5042002, name: "anvil-arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const GK_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const; // anvil's public default account
const PAYEE = "0x00000000000000000000000000000000000000a1" as Address;
const OTHER = "0x00000000000000000000000000000000000000a2" as Address;
const NEW_ACCOUNT = "0x00000000000000000000000000000000000000e7" as Address;

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
let member: PrivateKeyAccount;
let bills: string;

const deadline = async () => {
  const t = (await client.getBlock()).timestamp;
  const now = BigInt(Math.floor(Date.now() / 1000));
  return (t > now ? t : now) + 600n;
};
async function sign(kind: number, c: Change, proposalId = 0): Promise<SignedAction> {
  const { op, data } = encodeChange(c);
  const nonce = await gk.nonceOf(member.address);
  const d = await deadline();
  const signature = await member.signTypedData(actionTypedData(gk.org.dharma!.address as Address, 5042002, { kind, op, data, proposalId: BigInt(proposalId), support: kind === Kind.Vote, nonce, deadline: d }));
  return { kind, op, data, proposalId, support: kind === Kind.Vote, signer: member.address, deadline: d.toString(), signature };
}
async function decide(id: string, approve: boolean) {
  const p = gk.snapshot().proposals.find((x) => x.id === id)!;
  const h = `0x${p.payloadHash}` as Hex;
  const d = await deadline();
  const signature = await member.signTypedData(paymentDecisionTypedData(gk.org.dharma!.address as Address, 5042002, { proposalId: id, payloadHash: h, approve, deadline: d }));
  return gk.decide(id, { approve, payloadHash: h, signer: member.address, deadline: d.toString(), signature });
}
async function passTimelock() {
  const t = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
  await t.increaseTime({ seconds: 65 });
  await t.mine({ blocks: 1 });
  await gk.housekeeping();
}

beforeEach(async () => {
  if (gk) await gk.idle();
  member = privateKeyToAccount(generatePrivateKey());
  const writer = new ViemChainWriter(createWalletClient({ chain, account: gkAccount, transport: http(RPC) }), client);
  gk = new Gatekeeper({ store: new Store(mkdtempSync(join(tmpdir(), "karuna-learn-"))), wallet: new FakeWallet(), client, writerFor: () => writer, timelockSeconds: 60, anchorEvery: 1000 });
  await gk.setup({ orgName: "Learn Org", memberName: "Owner", memberAddress: member.address, walletAddress: gkAccount.address });
  bills = gk.prepareAgent("Bills").id;
  for (const [c, label] of [
    [{ op: "SetAgent", id: bills, capUsd: 1 }, undefined],
    [{ op: "SetLevelLimits", level: 0, perPaymentUsd: 1, dailyUsd: 1 }, undefined], // Level 0 = the old $1 allowance
    [{ op: "SetPayee", account: PAYEE, category: "supplies" }, "Supplier"],
    [{ op: "SetPayee", account: OTHER, category: "utilities" }, "Power Co"],
  ] as [Change, string | undefined][]) {
    await gk.submitAction({ ...(await sign(Kind.Propose, c)), label });
  }
  await passTimelock();
}, 60_000);

describe("Learns From Your Choices", () => {
  it("a human 'no' becomes a block for that agent → that counterparty, immediately and onchain", async () => {
    const r = await gk.propose(bills, { type: "transfer", to: PAYEE, amountUsd: 5 }); // over the $1 cap → asks
    expect(r.status).toBe("pending");
    await decide(r.id, false);
    await gk.idle();
    await gk.sync(true);
    expect(gk.policy!.rules.some((x) => x.id === learnedDenyId(bills, PAYEE) && x.active && x.outcome === "deny")).toBe(true);
    expect((await gk.propose(bills, { type: "transfer", to: PAYEE, amountUsd: 0.5 })).status).toBe("denied"); // even within the cap
    expect((await gk.propose(bills, { type: "transfer", to: OTHER, amountUsd: 0.5 })).status).toBe("done"); // other payees unaffected
    expect(gk.snapshot().learned.blocks).toHaveLength(1);
  }, 30_000);

  it("a 'yes' is learned slowly: 3 approvals only produce a suggestion, which needs a vote", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await gk.propose(bills, { type: "transfer", to: OTHER, amountUsd: 4 });
      expect(r.status).toBe("pending");
      if (i < 2) expect(gk.snapshot().learned.suggestions).toEqual([]);
      await decide(r.id, true);
    }
    const [sug] = gk.snapshot().learned.suggestions;
    expect(sug).toMatchObject({ agentId: bills, counterparty: OTHER.toLowerCase(), band: 10, approvals: 3 });
    expect(sug.change).toMatchObject({ op: "AddRule", outcome: "Allow", maxUsd: 10 });
    // Karuna can't apply it on its own: Dharma refuses a loosening from the Gatekeeper.
    const { op, data } = encodeChange(sug.change);
    const writer = new ViemChainWriter(createWalletClient({ chain, account: gkAccount, transport: http(RPC) }), client);
    await expect(writer.write(gk.org.dharma!.address as Address, "tighten", [op, data, zeroAddress, 0n, "0x"])).rejects.toThrow(/NotTightening/);
    // A member proposes it; after the timelock the agent pays that payee (up to $10) without asking.
    await gk.submitAction(await sign(Kind.Propose, sug.change));
    await passTimelock();
    expect((await gk.propose(bills, { type: "transfer", to: OTHER, amountUsd: 4 })).status).toBe("done");
    expect((await gk.propose(bills, { type: "transfer", to: OTHER, amountUsd: 40 })).status).toBe("pending"); // above the learned band
    expect(gk.snapshot().learned.suggestions).toEqual([]);
  }, 60_000);

  it("never suggests auto-approving a counterparty a human has refused", async () => {
    for (let i = 0; i < 3; i++) await decide((await gk.propose(bills, { type: "transfer", to: OTHER, amountUsd: 4 })).id, true);
    await decide((await gk.propose(bills, { type: "transfer", to: OTHER, amountUsd: 4 })).id, false);
    expect(gk.snapshot().learned.suggestions).toEqual([]);
  }, 60_000);
});

describe("Preview Before Loosening", () => {
  it("shows that adding the 'new bank account' as a payee would have let a flagged scam through", async () => {
    const scam = await gk.propose(bills, { type: "transfer", to: NEW_ACCOUNT, amountUsd: 0.5, payeeName: "Supplier" });
    expect(scam.status).toBe("denied"); // Changed Bank Account Alert
    await gk.propose(bills, { type: "transfer", to: NEW_ACCOUNT, amountUsd: 0.4 }); // plain unknown-recipient denial
    const res = await gk.submitAction({ ...(await sign(Kind.Propose, { op: "SetPayee", account: NEW_ACCOUNT, category: "supplies" })), label: "Supplier (new bank)" });
    const gov = gk.snapshot().policy!.proposals.find((g) => g.id === Number(res.proposalId))!;
    expect(gov.preview).toMatchObject({ replayed: 2, flaggedAllowed: 1 });
    expect(gov.preview!.newlyAllowed.map((x) => x.flagged)).toEqual(["changed bank account", null]);
  }, 30_000);

  it("counts a scam that would now reach an approval card instead of a block", async () => {
    await gk.submitAction(await sign(Kind.Propose, { op: "AddRule", id: "ap-bills-supplies", outcome: "Approval", agent: bills, scope: "payment:supplies" }));
    await passTimelock();
    expect((await gk.propose(bills, { type: "transfer", to: NEW_ACCOUNT, amountUsd: 0.2, payeeName: "Supplier" })).status).toBe("denied");
    const res = await gk.submitAction(await sign(Kind.Propose, { op: "SetPayee", account: NEW_ACCOUNT, category: "supplies" }));
    const pv = gk.snapshot().policy!.proposals.find((g) => g.id === Number(res.proposalId))!.preview!;
    expect(pv.flaggedAllowed).toBe(1);
    expect(pv.newlyAllowed[0]).toMatchObject({ was: "deny", now: "approval", flagged: "changed bank account" });
  }, 30_000);

  it("tracks daily spend while replaying, and tightenings get no preview", () => {
    const before = { rules: [], payees: [], agents: [{ id: "a", capUsd: 1 }], domains: [] };
    expect(applyChange(before, { op: "SetAgent", id: "a", capUsd: 5 }).agents).toEqual([{ id: "a", capUsd: 5 }]);
    expect(band(0.5)).toBe(1);
    expect(band(499)).toBe(500);
  });
});
