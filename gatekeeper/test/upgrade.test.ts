// Upgrading a real Dharma v2 org (the code main shipped before trust levels) to the current code,
// through the console's path: the Gatekeeper deploys the code, members vote, the core wait passes.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ChildProcess } from "node:child_process";
import { startAnvil } from "./anvil.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient, createTestClient, createWalletClient, defineChain, encodeDeployData, encodeFunctionData, http,
  type Address, type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DHARMA_ABI, DHARMA_PROXY_ABI, Kind, actionTypedData, encodeChange, type Change } from "@prekaruna/dharma";
import { DHARMA_PROXY_BYTECODE } from "@prekaruna/dharma/bytecode";
import { Store } from "../src/store.ts";
import { Gatekeeper, type SignedAction } from "../src/gatekeeper.ts";
import { ViemChainWriter, type ChainWriter, type DeployArgs } from "../src/chain.ts";
import type { WalletBackend } from "../src/wallet.ts";
import { DHARMA_V2_BYTECODE } from "./fixtures/dharma-v2.ts";

const PORT = 23545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 5042002, name: "anvil-arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const GK_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const; // anvil's public default account
const PAYEE = "0x00000000000000000000000000000000000000a1" as Address;
const CORE_WAIT = 600;

let anvil: ChildProcess;
let client: PublicClient;
beforeAll(async () => {
  client = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
  anvil = await startAnvil(PORT);
}, 20_000);
afterAll(() => anvil?.kill());

const wallet: WalletBackend = {
  quoteX402: async () => ({ amountUsd: 0.01, seller: PAYEE, network: "eip155:5042002", scheme: "exact" }),
  payX402: async () => ({ response: {} }),
  transfer: async () => ({ txRef: "x", raw: {} }),
  balances: async () => ({ usdc: "1", gateway: "0" }),
  listWallets: async () => [],
};

/** A writer whose first org deploy uses Dharma v2's code (what the dev org runs today). */
class V2OrgWriter implements ChainWriter {
  constructor(private readonly inner: ViemChainWriter, private readonly wc: ReturnType<typeof createWalletClient>) {}
  get from() {
    return this.inner.from;
  }
  async deploy(a: DeployArgs) {
    const account = this.wc.account!;
    const codeHash = await this.wc.deployContract({ abi: DHARMA_ABI, bytecode: DHARMA_V2_BYTECODE, account, chain });
    const impl = (await client.waitForTransactionReceipt({ hash: codeHash })).contractAddress!;
    const init = encodeFunctionData({
      abi: DHARMA_ABI, functionName: "initialize",
      args: [this.from, a.firstMember, BigInt(a.timelockSeconds), BigInt(a.coreTimelockSeconds), a.thresholdMicro, a.domains],
    });
    const hash = await this.wc.sendTransaction({ data: encodeDeployData({ abi: DHARMA_PROXY_ABI, bytecode: DHARMA_PROXY_BYTECODE, args: [impl, init] }), account, chain });
    const r = await client.waitForTransactionReceipt({ hash });
    return { address: r.contractAddress!, txRef: hash, implementation: impl };
  }
  deployCode() {
    return this.inner.deployCode();
  }
  write(...args: Parameters<ChainWriter["write"]>) {
    return this.inner.write(...args);
  }
}

describe("upgrading an org from Dharma v2 to v3", () => {
  it("keeps the org (address, members, agents, payees, rules) and adds trust levels", async () => {
    const member = privateKeyToAccount(generatePrivateKey());
    const gkAccount = privateKeyToAccount(GK_KEY);
    const wc = createWalletClient({ chain, account: gkAccount, transport: http(RPC) });
    const writer = new V2OrgWriter(new ViemChainWriter(wc, client), wc);
    const gk = new Gatekeeper({
      store: new Store(mkdtempSync(join(tmpdir(), "karuna-upgrade-"))), wallet, client, writerFor: () => writer,
      timelockSeconds: 60, coreTimelockSeconds: CORE_WAIT, anchorEvery: 1000,
    });
    const sign = async (kind: number, c: Change): Promise<SignedAction> => {
      const { op, data } = encodeChange(c);
      const nonce = await gk.nonceOf(member.address);
      const t = (await client.getBlock()).timestamp;
      const now = BigInt(Math.floor(Date.now() / 1000));
      const deadline = (t > now ? t : now) + 3600n;
      const signature = await member.signTypedData(actionTypedData(gk.org.dharma!.address as Address, 5042002, { kind, op, data, proposalId: 0n, support: false, nonce, deadline }));
      return { kind, op, data, proposalId: 0, support: false, signer: member.address, deadline: deadline.toString(), signature };
    };
    const wait = async (seconds: number) => {
      const t = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
      await t.increaseTime({ seconds });
      await t.mine({ blocks: 1 });
      await gk.housekeeping();
    };

    await gk.setup({ orgName: "Dev", memberName: "Owner", memberAddress: member.address, walletAddress: gkAccount.address });
    const agent = gk.prepareAgent("Research").id;
    for (const c of [{ op: "SetAgent", id: agent, capUsd: 3 }, { op: "SetPayee", account: PAYEE, category: "data" }] as Change[]) await gk.submitAction(await sign(Kind.Propose, c));
    await wait(65);
    const address = gk.org.dharma!.address;
    expect(gk.policy!.version).toBe(2);
    expect(gk.policy!.levelLimits).toBeNull();
    await expect(gk.submitAction(await sign(Kind.Propose, { op: "SetLevel", agent, level: 1, reason: "vote" }))).rejects.toThrow(/need Dharma v3/);

    // The console's "Propose upgrade": deploy the code (twice is a no-op), then a core vote.
    const code = await gk.prepareUpgrade();
    expect(code).toMatchObject({ version: 5, current: 2 });
    expect(await gk.prepareUpgrade()).toEqual(code);
    await gk.submitAction(await sign(Kind.Propose, { op: "Upgrade", implementation: code.implementation as Address }));
    expect(gk.policy!.proposals[0]).toMatchObject({ core: true, status: "queued" });
    await wait(65);
    expect(gk.policy!.version).toBe(2); // the normal wait isn't enough for a core change
    await wait(CORE_WAIT);

    expect(gk.policy!.version).toBe(5);
    expect(gk.policy!.team?.structure).toBe("flat"); // v4: team roles, Flat until someone picks a Tree
    expect(gk.org.dharma!.address).toBe(address);
    expect(gk.policy!.agents).toEqual([{ id: agent, capUsd: 3, level: 0 }]);
    expect(gk.policy!.payees).toHaveLength(1);
    expect(gk.policy!.rules.filter((r) => r.core).length).toBe(4);
    expect(gk.policy!.levelLimits![0]).toEqual({ perPaymentUsd: 0.1, dailyUsd: 1 });

    // Trust levels work on the upgraded org.
    gk.setChainRecords({ records: { [agent]: { agent, level: 0, cleanStreak: 10 } } });
    await gk.submitAction(await sign(Kind.Propose, { op: "SetLevel", agent, level: 1, reason: "vote" }));
    await wait(65);
    expect(gk.levelOf(agent)).toBe(1);
    await gk.idle();
  }, 120_000);
});
