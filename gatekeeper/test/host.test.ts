// The host (Dharma v7), against the REAL Dharma contract on anvil: whoever set the org up removes a
// teammate without a vote, but only after the core wait; nobody else can.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, type Address, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { Kind, actionTypedData, encodeChange, type Change } from "@prekaruna/dharma";
import { startAnvil } from "./anvil.ts";
import { Store } from "../src/store.ts";
import { Gatekeeper, type SignedAction } from "../src/gatekeeper.ts";
import { ViemChainWriter } from "../src/chain.ts";
import type { WalletBackend } from "../src/wallet.ts";

const PORT = 24545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 5042002, name: "anvil-arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const GK_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const; // anvil's public default account
const CORE_WAIT = 3600;

let anvil: ChildProcess;
let client: PublicClient;
let gk: Gatekeeper;
let host: PrivateKeyAccount;
let bob: PrivateKeyAccount;

const wallet: WalletBackend = {
  async quoteX402() {
    throw new Error("unused");
  },
  async payX402() {
    throw new Error("unused");
  },
  async transfer() {
    return { txRef: "unused", raw: {} };
  },
  async balances() {
    return { usdc: "0", gateway: null };
  },
  async listWallets() {
    return [];
  },
};

async function sign(who: PrivateKeyAccount, kind: number, c: Change, proposalId = 0, support = false): Promise<SignedAction> {
  const { op, data } = encodeChange(c);
  const nonce = await gk.nonceOf(who.address);
  const t = (await client.getBlock()).timestamp;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = (t > now ? t : now) + 600n;
  const signature = await who.signTypedData(actionTypedData(gk.org.dharma!.address as Address, 5042002, { kind, op, data, proposalId: BigInt(proposalId), support, nonce, deadline }));
  return { kind, op, data, proposalId, support, signer: who.address, deadline: deadline.toString(), signature };
}

async function wait(seconds: number) {
  const t = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
  await t.increaseTime({ seconds });
  await t.mine({ blocks: 1 });
  await gk.housekeeping();
}

const isMember = (a: string) => gk.policy!.members.some((m) => m.toLowerCase() === a.toLowerCase());

beforeAll(async () => {
  client = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
  anvil = await startAnvil(PORT);
  host = privateKeyToAccount(generatePrivateKey());
  bob = privateKeyToAccount(generatePrivateKey());
  const writer = new ViemChainWriter(createWalletClient({ chain, account: privateKeyToAccount(GK_KEY), transport: http(RPC) }), client);
  gk = new Gatekeeper({
    store: new Store(mkdtempSync(join(tmpdir(), "karuna-host-"))), wallet, client, writerFor: () => writer,
    timelockSeconds: 60, coreTimelockSeconds: CORE_WAIT, anchorEvery: 1000,
  });
  await gk.setup({ orgName: "Host Org", memberName: "Host", memberAddress: host.address, walletAddress: privateKeyToAccount(GK_KEY).address });
  // bob joins (the host alone is a majority).
  await gk.submitAction({ ...(await sign(host, Kind.Propose, { op: "AddMember", member: bob.address })), label: "Bob" });
  await wait(65);
}, 90_000);
afterAll(() => anvil?.kill());

describe("the host", () => {
  it("is whoever set the org up, shown to the console", () => {
    expect(gk.policy!.version).toBe(7);
    expect(gk.policy!.host?.toLowerCase()).toBe(host.address.toLowerCase());
    expect(gk.snapshot().policy!.host).toBe(host.address.toLowerCase());
    expect(isMember(bob.address)).toBe(true);
  });

  it("only the host can remove someone without a vote", async () => {
    await expect(gk.submitAction(await sign(bob, Kind.Manage, { op: "RemoveMember", member: host.address }))).rejects.toThrow(/Only the host/);
  });

  it("removes a teammate with no vote, but only after the core wait", async () => {
    const r = await gk.submitAction(await sign(host, Kind.Manage, { op: "RemoveMember", member: bob.address }));
    const p = gk.policy!.proposals.find((x) => x.id === r.proposalId)!;
    expect(p.status).toBe("queued");
    expect(p.core).toBe(true);
    expect(p.eta! - gk.policy!.chainTime).toBeGreaterThan(CORE_WAIT - 60);
    expect(isMember(bob.address)).toBe(true); // not yet

    await wait(120);
    expect(isMember(bob.address)).toBe(true); // still not

    await wait(CORE_WAIT);
    expect(isMember(bob.address)).toBe(false); // executed after the wait
    expect(gk.policy!.members).toHaveLength(1);
  }, 60_000);
});
