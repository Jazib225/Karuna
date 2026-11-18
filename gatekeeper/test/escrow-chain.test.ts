// Escrow end to end with the REAL contracts on anvil: Dharma, Escrow, and a 6-decimal USDC (the
// MockUSDC forge builds from contracts/test/Escrow.t.sol). The Gatekeeper's wallet moves real
// token balances; the relayer key deploys the Escrow, opens, releases, and relays a member's cancel
// signed exactly as the console signs it. Skipped when the forge build output isn't there.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ESCROW_ABI, Kind, actionTypedData, encodeChange, escrowCancelTypedData, type Change } from "@prekaruna/dharma";
import { startAnvil } from "./anvil.ts";
import { Store } from "../src/store.ts";
import { Gatekeeper, type SignedAction } from "../src/gatekeeper.ts";
import { ViemChainWriter } from "../src/chain.ts";
import { ViemEscrow } from "../src/escrow.ts";
import type { WalletBackend, X402Quote } from "../src/wallet.ts";

const MOCK = resolve(import.meta.dirname, "../../contracts/out/Escrow.t.sol/MockUSDC.json");
const PORT = 23545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 5042002, name: "anvil-arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
// anvil's public default accounts #0 (the org's wallet / Dharma.gatekeeper) and #1 (the relayer)
const GK_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const RELAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const TOKEN = parseAbi(["function mint(address,uint256)", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

describe.skipIf(!existsSync(MOCK))("escrow on chain (real contracts)", () => {
  let anvil: ChildProcess;
  let client: PublicClient;
  let usdc: Address;
  let gk: Gatekeeper;
  let clock = Date.now();
  const gkAccount = privateKeyToAccount(GK_KEY);
  const member = privateKeyToAccount(generatePrivateKey());
  const payee = privateKeyToAccount(generatePrivateKey()).address;
  const gkWallet = () => createWalletClient({ chain, account: gkAccount, transport: http(RPC) });
  const bal = (a: Address) => client.readContract({ address: usdc, abi: TOKEN, functionName: "balanceOf", args: [a] });
  const warp = async (seconds: number) => {
    const t = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
    await t.increaseTime({ seconds });
    await t.mine({ blocks: 1 });
    clock += seconds * 1000;
  };
  async function sign(c: Change): Promise<SignedAction> {
    const { op, data } = encodeChange(c);
    const nonce = await gk.nonceOf(member.address);
    const deadline = (await client.getBlock()).timestamp + 600n;
    const signature = await member.signTypedData(actionTypedData(gk.org.dharma!.address as Address, 5042002, { kind: Kind.Propose, op, data, proposalId: 0n, support: false, nonce, deadline }));
    return { kind: Kind.Propose, op, data, proposalId: 0, support: false, signer: member.address, deadline: deadline.toString(), signature };
  }

  /** The org's wallet as the Gatekeeper sees it: real token transfers on anvil. */
  const wallet: WalletBackend = {
    quoteX402: async (): Promise<X402Quote> => ({ amountUsd: 0.001, seller: payee, network: "eip155:5042002", scheme: "exact" }),
    payX402: async () => ({ response: {} }),
    transfer: async (_from, to, amountUsd) => {
      const hash = await gkWallet().writeContract({ address: usdc, abi: TOKEN, functionName: "transfer", args: [to as Address, BigInt(Math.round(amountUsd * 1e6))], chain, account: gkAccount });
      await client.waitForTransactionReceipt({ hash });
      return { txRef: hash, raw: {} };
    },
    balances: async () => ({ usdc: "100", gateway: null }),
    listWallets: async () => [],
  };

  beforeAll(async () => {
    client = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
    anvil = await startAnvil(PORT);
    const art = JSON.parse(readFileSync(MOCK, "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };
    const hash = await gkWallet().deployContract({ abi: art.abi, bytecode: art.bytecode.object, chain, account: gkAccount });
    usdc = (await client.waitForTransactionReceipt({ hash })).contractAddress!;
    await client.waitForTransactionReceipt({ hash: await gkWallet().writeContract({ address: usdc, abi: TOKEN, functionName: "mint", args: [gkAccount.address, 100_000_000n], chain, account: gkAccount }) });

    const relayer = createWalletClient({ chain, account: privateKeyToAccount(RELAYER_KEY), transport: http(RPC) });
    gk = new Gatekeeper({
      store: new Store(mkdtempSync(join(tmpdir(), "karuna-escrow-chain-"))), wallet, client,
      writerFor: () => new ViemChainWriter(gkWallet(), client), timelockSeconds: 60, anchorEvery: 1000,
      escrow: new ViemEscrow(relayer, client, usdc), now: () => new Date(clock),
    });
    await gk.setup({ orgName: "Escrow Chain Org", memberName: "Owner", memberAddress: member.address, walletAddress: gkAccount.address });
    const bills = gk.prepareAgent("Bills").id;
    for (const c of [
      { op: "SetAgent", id: bills, capUsd: 10 },
      { op: "SetLevelLimits", level: 0, perPaymentUsd: 10, dailyUsd: 10 },
      { op: "SetPayee", account: payee, category: "supplies" },
      { op: "AddRule", id: "escrow-1", outcome: "Approval", scope: "escrow", target: "3600", maxUsd: 2 },
    ] as Change[]) await gk.submitAction(await sign(c));
    await warp(65);
    await gk.housekeeping();
  }, 90_000);
  afterAll(async () => {
    await gk?.idle();
    anvil?.kill();
  });

  const agent = () => gk.snapshot().policy!.agents[0].id;
  const holdOf = async (id: string) => {
    const p = gk.snapshot().proposals.find((x) => x.id === id)!;
    const h = await client.readContract({ address: p.escrow!.address as Address, abi: ESCROW_ABI, functionName: "holds", args: [BigInt(p.escrow!.holdId!)] }) as { payee: Address; amount: bigint; status: number };
    return { p, h };
  };

  it("a large payment lands in the Escrow, held for the payee; a small one goes straight through", async () => {
    const small = await gk.propose(agent(), { type: "transfer", to: payee, amountUsd: 1 });
    expect(small.status).toBe("done");
    expect(await bal(payee)).toBe(1_000_000n);

    const r = await gk.propose(agent(), { type: "transfer", to: payee, amountUsd: 3 });
    expect(r.status).toBe("done");
    const { p, h } = await holdOf(r.id);
    expect(p.escrow).toMatchObject({ status: "held", holdId: "0" });
    expect(h).toMatchObject({ payee, amount: 3_000_000n, status: 1 });
    expect(await bal(p.escrow!.address as Address)).toBe(3_000_000n);
    expect(await bal(payee)).toBe(1_000_000n); // not paid yet
    expect(gk.watchdogTransfer({ txHash: p.txRef, to: p.escrow!.address, amountUsd: 3 })).toMatchObject({ verdict: "matched", proposalId: r.id });
  }, 60_000);

  it("a member's signed cancel (as the console signs it) sends the USDC back to the org's wallet", async () => {
    const r = await gk.propose(agent(), { type: "transfer", to: payee, amountUsd: 4 });
    const { p } = await holdOf(r.id);
    const before = await bal(gkAccount.address);
    const signature = await member.signTypedData(escrowCancelTypedData(p.escrow!.address as Address, 5042002, { id: BigInt(p.escrow!.holdId!) }));
    expect(await gk.cancelEscrow(r.id, { signer: member.address, signature })).toMatchObject({ status: "cancelled" });
    expect(await bal(gkAccount.address)).toBe(before + 4_000_000n);
    expect((await holdOf(r.id)).h.status).toBe(3); // Cancelled
  }, 60_000);

  it("after the window the Gatekeeper releases it to the payee; not before", async () => {
    await gk.releaseDueEscrows();
    expect(await bal(payee)).toBe(1_000_000n);
    await warp(3700);
    await gk.releaseDueEscrows();
    expect(await bal(payee)).toBe(4_000_000n); // $1 direct + $3 released; the cancelled $4 never arrives
    const released = gk.snapshot().proposals.filter((x) => x.escrow?.status === "released");
    expect(released).toHaveLength(1);
    expect((await holdOf(released[0].id)).h.status).toBe(2); // Released
  }, 60_000);
});
