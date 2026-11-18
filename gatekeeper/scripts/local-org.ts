// A whole Karuna org on a local chain, to try the console end to end with no Circle wallet, no
// testnet USDC and no second member: anvil runs the REAL Dharma and Escrow contracts and a
// 6-decimal test USDC (forge's MockUSDC), the org's wallet is anvil account #0 and the relayer is
// account #1. One member (LOCAL_MEMBER, e.g. this browser's key), so one vote passes a change, and
// no wait.
//   cd contracts && forge build          (once: builds MockUSDC)
//   LOCAL_MEMBER=0x… KARUNA_DATA_DIR=<empty dir> npx tsx scripts/local-org.ts
//   KARUNA_DATA_DIR=<same dir> KARUNA_CONSOLE_PORT=9788 KARUNA_WEB_PORT=5174 pnpm --dir web dev
// Test only: the keys below are anvil's public defaults.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatUnits, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startAnvil } from "../test/anvil.ts";
import { Store } from "../src/store.ts";
import { Gatekeeper } from "../src/gatekeeper.ts";
import { agentApi, consoleApi } from "../src/server.ts";
import { Accounts } from "../src/accounts.ts";
import { ViemChainWriter } from "../src/chain.ts";
import { ViemEscrow } from "../src/escrow.ts";
import { runnerUndo } from "../src/undo.ts";
import { SandboxCA } from "../src/ca.ts";
import { SecretStore } from "../src/secrets.ts";
import { EgressProxy } from "../src/proxy.ts";
import type { WalletBackend } from "../src/wallet.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const MOCK = resolve(ROOT, "contracts/out/Escrow.t.sol/MockUSDC.json");
const member = process.env.LOCAL_MEMBER as Address | undefined;
const dataDir = process.env.KARUNA_DATA_DIR;
if (!member || !/^0x[0-9a-fA-F]{40}$/.test(member)) throw new Error("Set LOCAL_MEMBER to the member's address (the console shows this device's key)");
if (!dataDir) throw new Error("Set KARUNA_DATA_DIR to an empty folder");
if (!existsSync(MOCK)) throw new Error("Run `forge build` in contracts/ first (it builds MockUSDC)");
// The chain starts empty each time, so an org saved by an earlier run would point at nothing.
if (existsSync(resolve(dataDir, "org.json"))) throw new Error(`${dataDir} already has an org from an earlier run; use an empty folder`);
mkdirSync(dataDir, { recursive: true });

const RPC_PORT = Number(process.env.LOCAL_RPC_PORT ?? 8546);
const agentPort = Number(process.env.KARUNA_AGENT_PORT ?? 9787);
const consolePort = Number(process.env.KARUNA_CONSOLE_PORT ?? 9788);
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const chain = defineChain({ id: 5042002, name: "anvil-arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const org = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const relayer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const TOKEN = parseAbi(["function mint(address,uint256)", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

const anvil = await startAnvil(RPC_PORT);
process.on("exit", () => anvil.kill());
process.on("SIGINT", () => process.exit(0));
const client = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
// anvil only makes a block when a transaction arrives; Arc makes one every second or so. Without
// this, chain time stands still and passed changes never reach their execution time.
setInterval(() => void fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_mine", params: [] }) }).catch(() => undefined), 1000).unref();
const orgWallet = createWalletClient({ chain, account: org, transport: http(RPC) });

// The test USDC, with 1,000 in the org's wallet.
const art = JSON.parse(readFileSync(MOCK, "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };
const usdc = (await client.waitForTransactionReceipt({ hash: await orgWallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object, chain, account: org }) })).contractAddress!;
await client.waitForTransactionReceipt({ hash: await orgWallet.writeContract({ address: usdc, abi: TOKEN, functionName: "mint", args: [org.address, 1_000_000_000n], chain, account: org }) });

/** The org's wallet: real token transfers on the local chain. */
const wallet: WalletBackend = {
  quoteX402: async () => {
    throw new Error("Paid APIs (x402) aren't available on the local chain");
  },
  payX402: async () => {
    throw new Error("Paid APIs (x402) aren't available on the local chain");
  },
  transfer: async (_from, to, amountUsd) => {
    const hash = await orgWallet.writeContract({ address: usdc, abi: TOKEN, functionName: "transfer", args: [to as Address, BigInt(Math.round(amountUsd * 1e6))], chain, account: org });
    await client.waitForTransactionReceipt({ hash });
    return { txRef: hash, raw: {} };
  },
  balances: async (a) => ({ usdc: formatUnits(await client.readContract({ address: usdc, abi: TOKEN, functionName: "balanceOf", args: [a as Address] }), 6), gateway: null }),
  listWallets: async () => [org.address],
};

const store = new Store(dataDir);
const secrets = new SecretStore(dataDir);
const gk = new Gatekeeper({
  store, wallet, client, secrets, timelockSeconds: 0,
  writerFor: () => new ViemChainWriter(orgWallet, client),
  escrow: new ViemEscrow(createWalletClient({ chain, account: relayer, transport: http(RPC) }), client, usdc),
  undo: runnerUndo(ROOT),
  requireSandbox: true,
});
await gk.setup({ orgName: "Local Org", memberName: "You", memberAddress: member, walletAddress: org.address });

const ca = new SandboxCA(dataDir);
const egress = new EgressProxy(gk, ca, { agentApiPort: agentPort, holdMs: 120_000 });
agentApi(gk, { proxy: egress, caPem: ca.certPem, secrets }).listen(agentPort, "127.0.0.1");
consoleApi(gk, wallet, store.loadOrCreateConsoleToken(), secrets, ca.certPem, new Accounts(store)).listen(consolePort, "127.0.0.1");
await gk.start();
console.log(JSON.stringify({ ready: true, rpc: RPC, dharma: gk.org.dharma?.address, usdc, wallet: org.address, relayer: relayer.address, member, agentApi: `http://127.0.0.1:${agentPort}`, consoleApi: `http://127.0.0.1:${consolePort}` }));
