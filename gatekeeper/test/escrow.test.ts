// Escrow for large payments: routing, the watchdog, a member's cancel, and release after the window,
// against the REAL Dharma contract on anvil. The Escrow contract itself is tested in
// contracts/test/Escrow.t.sol; here a fake backend stands in for it.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { startAnvil } from "./anvil.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { Kind, actionTypedData, encodeChange, escrowCancelTypedData, describeChange, type Change } from "@prekaruna/dharma";
import { Store } from "../src/store.ts";
import { Gatekeeper, type SignedAction } from "../src/gatekeeper.ts";
import { ChainError, ViemChainWriter } from "../src/chain.ts";
import type { EscrowBackend } from "../src/escrow.ts";
import type { WalletBackend, X402Quote } from "../src/wallet.ts";

const PORT = 24545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 5042002, name: "anvil-arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const GK_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const PAYEE = "0x00000000000000000000000000000000000000a1" as Address;
const ESCROW = "0x00000000000000000000000000000000000000e5" as Address;

let anvil: ChildProcess;
let client: PublicClient;
beforeAll(async () => {
  client = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
  anvil = await startAnvil(PORT);
}, 20_000);
afterAll(() => anvil?.kill());

class FakeWallet implements WalletBackend {
  paid: { to: string; usd: number }[] = [];
  async quoteX402(): Promise<X402Quote> {
    return { amountUsd: 0.001, seller: PAYEE, network: "eip155:5042002", scheme: "exact" };
  }
  async payX402() {
    return { response: {} };
  }
  async transfer(_f: string, to: string, usd: number) {
    this.paid.push({ to: to.toLowerCase(), usd });
    return { txRef: `0xtx${this.paid.length}`, raw: {} };
  }
  async balances() {
    return { usdc: "10", gateway: "1" };
  }
  async listWallets() {
    return [];
  }
}

class FakeEscrow implements EscrowBackend {
  readonly opener = "0x00000000000000000000000000000000000000b0" as Address;
  deployed = 0;
  holds: { payee: string; amountUsd: number; releaseAt: number; status: string }[] = [];
  frozen = false;
  async deploy() {
    this.deployed++;
    return { address: ESCROW, txRef: "0xdeploy" };
  }
  async open(_e: Address, h: { payee: Address; amountUsd: number; releaseAt: number }) {
    this.holds.push({ payee: h.payee.toLowerCase(), amountUsd: h.amountUsd, releaseAt: h.releaseAt, status: "held" });
    return { id: BigInt(this.holds.length - 1), txRef: "0xopen" };
  }
  async release(_e: Address, id: bigint) {
    if (this.frozen) throw new ChainError("Escrow rejected this: Frozen", "Frozen");
    this.holds[Number(id)].status = "released";
    return { txRef: "0xrelease" };
  }
  async cancel(_e: Address, id: bigint) {
    this.holds[Number(id)].status = "cancelled";
    return { txRef: "0xcancel" };
  }
}

const gkAccount = privateKeyToAccount(GK_KEY);
let gk: Gatekeeper;
let wallet: FakeWallet;
let escrow: FakeEscrow;
let member: PrivateKeyAccount;
let bills: string;
let clock: number;

const deadline = async () => {
  const t = (await client.getBlock()).timestamp;
  const now = BigInt(Math.floor(Date.now() / 1000));
  return (t > now ? t : now) + 600n;
};
async function sign(kind: number, c: Change): Promise<SignedAction> {
  const { op, data } = encodeChange(c);
  const nonce = await gk.nonceOf(member.address);
  const d = await deadline();
  const signature = await member.signTypedData(actionTypedData(gk.org.dharma!.address as Address, 5042002, { kind, op, data, proposalId: 0n, support: false, nonce, deadline: d }));
  return { kind, op, data, proposalId: 0, support: false, signer: member.address, deadline: d.toString(), signature };
}
async function passTimelock() {
  const t = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
  await t.increaseTime({ seconds: 65 });
  await t.mine({ blocks: 1 });
  await gk.housekeeping();
}
const cancelSig = (holdId: string, by = member) =>
  by.signTypedData(escrowCancelTypedData(ESCROW, 5042002, { id: BigInt(holdId) })) as Promise<Hex>;

beforeEach(async () => {
  if (gk) await gk.idle();
  member = privateKeyToAccount(generatePrivateKey());
  wallet = new FakeWallet();
  escrow = new FakeEscrow();
  clock = Date.now();
  const writer = new ViemChainWriter(createWalletClient({ chain, account: gkAccount, transport: http(RPC) }), client);
  gk = new Gatekeeper({
    store: new Store(mkdtempSync(join(tmpdir(), "karuna-escrow-"))), wallet, client, writerFor: () => writer, timelockSeconds: 60, anchorEvery: 1000,
    escrow, now: () => new Date(clock),
  });
  await gk.setup({ orgName: "Escrow Org", memberName: "Owner", memberAddress: member.address, walletAddress: gkAccount.address });
  bills = gk.prepareAgent("Bills").id;
  for (const c of [
    { op: "SetAgent", id: bills, capUsd: 5 },
    { op: "SetLevelLimits", level: 0, perPaymentUsd: 5, dailyUsd: 5 },
    { op: "SetPayee", account: PAYEE, category: "supplies" },
  ] as Change[]) {
    await gk.submitAction(await sign(Kind.Propose, c));
  }
  await passTimelock();
  // Escrow is a Dharma rule, voted like any other.
  await gk.submitAction(await sign(Kind.Propose, { op: "AddRule", id: "escrow-1", outcome: "Approval", scope: "escrow", target: "3600", maxUsd: 2 }));
  await passTimelock();
}, 60_000);

describe("escrow for large payments", () => {
  it("uses one rule's amount and wait together: only rules the payment reaches apply, the longest wait wins", async () => {
    // beforeEach: $2 → 1h. Add $20 → 2h and $1 → 10 min.
    await gk.submitAction(await sign(Kind.Propose, { op: "AddRule", id: "escrow-2", outcome: "Approval", scope: "escrow", target: "7200", maxUsd: 20 }));
    await gk.submitAction(await sign(Kind.Propose, { op: "AddRule", id: "escrow-3", outcome: "Approval", scope: "escrow", target: "600", maxUsd: 1 }));
    await passTimelock();
    expect(gk.escrowFor(bills, 0.5)).toBeNull();
    expect(gk.escrowFor(bills, 1.5)).toEqual({ thresholdUsd: 1, waitSeconds: 600 });
    expect(gk.escrowFor(bills, 6)).toEqual({ thresholdUsd: 2, waitSeconds: 3600 }); // not the $20 rule's 2h
    expect(gk.escrowFor(bills, 25)).toEqual({ thresholdUsd: 20, waitSeconds: 7200 });
  }, 60_000);

  it("is described in plain words", () => {
    expect(describeChange({ op: "AddRule", id: "escrow-1", outcome: "Approval", scope: "escrow", target: "86400", maxUsd: 100 })).toMatch(/Hold payments of \$100\.00 or more in escrow for 24h; any member can cancel/);
  });

  it("the approval card says a large payment will be held and can be cancelled, not that it's irreversible", async () => {
    const r = await gk.propose(bills, { type: "transfer", to: PAYEE, amountUsd: 8 });
    expect(r.status).toBe("pending");
    const p = gk.snapshot().proposals.find((x) => x.id === r.id)!;
    expect(p.facts.find((f) => f.label === "Reversible")).toEqual({ label: "Reversible", value: "Held in escrow for 1h; any member can cancel before release" });
  }, 60_000);

  it("small payments go straight to the payee; large ones into the Escrow, which the watchdog knows is ours", async () => {
    expect((await gk.propose(bills, { type: "transfer", to: PAYEE, amountUsd: 1 })).status).toBe("done");
    expect(wallet.paid.at(-1)).toEqual({ to: PAYEE, usd: 1 });

    const r = await gk.propose(bills, { type: "transfer", to: PAYEE, amountUsd: 3 });
    expect(r.status).toBe("done");
    expect(wallet.paid.at(-1)).toEqual({ to: ESCROW, usd: 3 });
    expect(escrow.deployed).toBe(1);
    expect(escrow.holds[0]).toMatchObject({ payee: PAYEE, amountUsd: 3, releaseAt: Math.floor(clock / 1000) + 3600 });
    const p = gk.snapshot().proposals.find((x) => x.id === r.id)!;
    expect(p.escrow).toMatchObject({ address: ESCROW, status: "held", holdId: "0" });
    expect(gk.snapshot().org.escrow?.address).toBe(ESCROW);

    const ev = gk.watchdogTransfer({ txHash: `0x${"ab".repeat(32)}`, to: ESCROW, amountUsd: 3 });
    expect(ev).toMatchObject({ verdict: "matched", proposalId: r.id });
    expect(gk.isFrozen()).toBeFalsy();
  }, 60_000);

  it("any member can cancel before release; the money counts as unspent", async () => {
    const r = await gk.propose(bills, { type: "transfer", to: PAYEE, amountUsd: 3 });
    const outsider = privateKeyToAccount(generatePrivateKey());
    await expect(gk.cancelEscrow(r.id, { signer: outsider.address, signature: await cancelSig("0", outsider) })).rejects.toThrow(/not a Dharma member/);
    await expect(gk.cancelEscrow(r.id, { signer: member.address, signature: await cancelSig("1") })).rejects.toThrow(/does not match/);
    expect(await gk.cancelEscrow(r.id, { signer: member.address, signature: await cancelSig("0") })).toMatchObject({ status: "cancelled" });
    expect(escrow.holds[0].status).toBe("cancelled");
    expect(gk.snapshot().proposals.find((x) => x.id === r.id)!.escrow).toMatchObject({ status: "cancelled", cancelledBy: member.address.toLowerCase() });
    await expect(gk.cancelEscrow(r.id, { signer: member.address, signature: await cancelSig("0") })).rejects.toThrow(/already cancelled/);
    // Release skips it, and the agent may spend that money again today.
    clock += 2 * 3600_000;
    await gk.releaseDueEscrows();
    expect(escrow.holds[0].status).toBe("cancelled");
    expect((await gk.propose(bills, { type: "transfer", to: PAYEE, amountUsd: 4 })).status).toBe("done");
  }, 60_000);

  it("releases after the window, not before; a freeze holds it until a member decides", async () => {
    const r = await gk.propose(bills, { type: "transfer", to: PAYEE, amountUsd: 3 });
    clock += 1800_000;
    await gk.releaseDueEscrows();
    expect(escrow.holds[0].status).toBe("held");
    escrow.frozen = true;
    clock += 3600_000;
    await gk.releaseDueEscrows();
    expect(gk.snapshot().proposals.find((x) => x.id === r.id)!.escrow).toMatchObject({ status: "held", blocked: expect.stringMatching(/frozen/) });
    escrow.frozen = false;
    await gk.releaseDueEscrows();
    expect(escrow.holds[0].status).toBe("released");
    expect(gk.snapshot().proposals.find((x) => x.id === r.id)!.escrow).toMatchObject({ status: "released", releaseTx: "0xrelease" });
    expect(gk.snapshot().proposals.find((x) => x.id === r.id)!.escrow!.blocked).toBeUndefined();
  }, 60_000);

  it("with escrow on but no relayer, a large payment fails and nothing is paid", async () => {
    const writer = new ViemChainWriter(createWalletClient({ chain, account: gkAccount, transport: http(RPC) }), client);
    const plain = new Gatekeeper({ store: new Store(mkdtempSync(join(tmpdir(), "karuna-escrow-"))), wallet, client, writerFor: () => writer, timelockSeconds: 60, anchorEvery: 1000 });
    await plain.setup({ orgName: "No Relayer", memberName: "Owner", memberAddress: member.address, walletAddress: gkAccount.address }).catch(() => undefined);
    (plain as unknown as { org: unknown }).org = gk.org;
    (plain as unknown as { org: { escrow?: unknown } }).org.escrow = undefined;
    await plain.housekeeping();
    const before = wallet.paid.length;
    const r = await plain.propose(bills, { type: "transfer", to: PAYEE, amountUsd: 3 });
    expect(r.status).toBe("failed");
    expect(wallet.paid.length).toBe(before);
    await plain.idle();
  }, 60_000);
});
