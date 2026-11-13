// The Gatekeeper's view of Dharma: read the org's onchain policy, and send transactions.
// Writes go through a ChainWriter. In production that's the org's Circle agent wallet (the
// Gatekeeper relays members' signed actions and pays gas); in tests it's a local key on anvil.
// Every write is simulated first, so a call that would revert costs nothing and its reason is
// readable (e.g. "CoreBoundary").
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, encodeDeployData, http,
  type Address, type Chain, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { arcTestnet } from "viem/chains";
import { DHARMA_ABI, OUTCOME_NAMES, STATUS_NAMES, decodeChange, fromBytes32, fromMicro, type Change } from "@prekaruna/dharma";
import { DHARMA_BYTECODE } from "@prekaruna/dharma/bytecode";
import type { OnchainRule } from "@prekaruna/engine";
import { WALLET_CHAIN } from "./config.ts";

export type WriteFn =
  | "tighten" | "propose" | "vote" | "execute" | "anchorLog" | "requestApproval" | "reportTestFailed";

export interface DeployArgs {
  firstMember: Address;
  timelockSeconds: number;
  thresholdMicro: bigint;
  domains: string[];
}

export interface ChainWriter {
  readonly from: Address; // the Gatekeeper's address (Dharma.gatekeeper)
  deploy(args: DeployArgs): Promise<{ address: Address; txRef: string }>;
  write(contract: Address, fn: WriteFn, args: readonly unknown[]): Promise<{ txRef: string }>;
}

export class ChainError extends Error {
  constructor(message: string, readonly reason?: string) {
    super(message);
  }
}

/** Turn a viem revert into the contract's error name, e.g. "CoreBoundary" or `Invalid("…")`. */
export function revertReason(e: unknown): string | undefined {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r?.data?.errorName) return r.data.args?.length ? `${r.data.errorName}(${r.data.args.join(", ")})` : r.data.errorName;
    if (r?.reason) return r.reason;
  }
  return undefined;
}

/** Reads go through Multicall3 and back off on rate limits (the public Arc RPC returns 429s). */
export const publicClient = (rpcUrl?: string, chain: Chain = arcTestnet): PublicClient =>
  createPublicClient({ chain, transport: http(rpcUrl || undefined, { retryCount: 6, retryDelay: 500 }) }) as PublicClient;

/** True for transient RPC trouble (rate limits, timeouts) as opposed to a real revert. */
export const isTransient = (e: unknown) => /rate limit|429|timed? ?out|ECONNRESET|fetch failed|Request exceeds/i.test(e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? "")}` : String(e));

// ---------------------------------------------------------------- Circle (production)

const fnSig = (fn: WriteFn) => {
  const item = DHARMA_ABI.find((x) => x.type === "function" && x.name === fn) as { inputs: readonly { type: string }[] };
  return `${fn}(${item.inputs.map((i) => i.type).join(",")})`;
};
const cliArg = (v: unknown) => (typeof v === "bigint" ? v.toString() : typeof v === "boolean" ? String(v) : String(v));

export class CircleChainWriter implements ChainWriter {
  private readonly env: NodeJS.ProcessEnv;
  constructor(readonly from: Address, private readonly client: PublicClient, private readonly bin = process.env.CIRCLE_BIN ?? "circle") {
    this.env = { ...process.env, CIRCLE_VERSION_CHECK: "off", PATH: `${join(homedir(), ".local", "bin")}:${process.env.PATH ?? ""}` };
  }

  private run(args: string[], timeoutMs = 180_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      execFile(this.bin, [...args, "-o", "json"], { env: this.env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        const text = stdout || stderr;
        const i = text.indexOf("{");
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = i >= 0 ? JSON.parse(text.slice(i)) : null;
        } catch {
          parsed = null;
        }
        const error = parsed?.error as { message?: string } | undefined;
        if (error) return reject(new ChainError(error.message ?? "Circle CLI error"));
        const data = parsed?.data as Record<string, unknown> | undefined;
        if (!data) return reject(new ChainError((stderr || String(err ?? "no output")).trim().split("\n").slice(-2).join(" ")));
        if (data.state && data.state !== "COMPLETE") return reject(new ChainError(`Transaction ${data.state}${data.errorReason ? `: ${data.errorReason}` : ""}`));
        resolve(data);
      });
    });
  }

  async deploy(a: DeployArgs) {
    const bytecode = encodeDeployData({
      abi: DHARMA_ABI, bytecode: DHARMA_BYTECODE,
      args: [this.from, a.firstMember, BigInt(a.timelockSeconds), a.thresholdMicro, a.domains],
    });
    const d = await this.run(["contract", "deploy", "--bytecode", bytecode, "--address", this.from, "--chain", WALLET_CHAIN], 300_000);
    if (!d.contractAddress) throw new ChainError("Deploy finished without a contract address");
    return { address: String(d.contractAddress) as Address, txRef: String(d.txHash ?? d.id) };
  }

  async write(contract: Address, fn: WriteFn, args: readonly unknown[]) {
    await simulate(this.client, this.from, contract, fn, args);
    const d = await this.run(["wallet", "execute", fnSig(fn), ...args.map(cliArg), "--contract", contract, "--address", this.from, "--chain", WALLET_CHAIN]);
    return { txRef: String(d.txHash ?? d.id) };
  }
}

async function simulate(client: PublicClient, from: Address, contract: Address, fn: WriteFn, args: readonly unknown[]) {
  try {
    await client.simulateContract({ address: contract, abi: DHARMA_ABI, functionName: fn, args: args as never, account: from });
  } catch (e) {
    const reason = revertReason(e);
    throw new ChainError(reason ? `Dharma rejected this: ${reason}` : `Simulation failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`, reason);
  }
}

// ---------------------------------------------------------------- local key (tests / anvil)

export class ViemChainWriter implements ChainWriter {
  readonly from: Address;
  constructor(private readonly wallet: WalletClient, private readonly client: PublicClient) {
    this.from = wallet.account!.address;
  }

  async deploy(a: DeployArgs) {
    const hash = await this.wallet.deployContract({
      abi: DHARMA_ABI, bytecode: DHARMA_BYTECODE, account: this.wallet.account!, chain: this.wallet.chain,
      args: [this.from, a.firstMember, BigInt(a.timelockSeconds), a.thresholdMicro, a.domains],
    });
    const r = await this.client.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new ChainError("deploy failed");
    return { address: r.contractAddress, txRef: hash };
  }

  async write(contract: Address, fn: WriteFn, args: readonly unknown[]) {
    await simulate(this.client, this.from, contract, fn, args);
    const hash = await this.wallet.writeContract({
      address: contract, abi: DHARMA_ABI, functionName: fn, args: args as never, account: this.wallet.account!, chain: this.wallet.chain,
    });
    const r = await this.client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new ChainError(`${fn} reverted`);
    return { txRef: hash };
  }
}

// ---------------------------------------------------------------- reading the policy

export interface OnchainProposal {
  id: number;
  op: number;
  data: Hex;
  change: Change | null;
  proposer: Address;
  createdAt: number;
  queuedAt: number;
  eta: number | null;
  yes: number;
  no: number;
  status: (typeof STATUS_NAMES)[number];
  voters: Address[]; // members who already voted (open/queued proposals)
}

export interface OnchainPolicy {
  address: Address;
  chainId: number;
  gatekeeper: Address;
  timelock: number;
  required: number;
  frozen: boolean;
  thresholdUsd: number;
  policyVersion: number;
  logHead: Hex;
  logLength: number;
  members: Address[];
  rules: OnchainRule[];
  payees: { account: Address; category: string }[];
  agents: { id: string; capUsd: number }[];
  domains: string[];
  proposals: OnchainProposal[];
  chainTime: number; // latest block timestamp, for timelock math
}

/** Read many view functions: one Multicall3 request when the chain has it (Arc does), else in
 *  parallel. Keeps the Gatekeeper well under public-RPC rate limits. */
async function readMany<T extends readonly unknown[]>(client: PublicClient, calls: readonly { functionName: string; args?: readonly unknown[] }[], address: Address): Promise<T> {
  const contracts = calls.map((c) => ({ address, abi: DHARMA_ABI, functionName: c.functionName, args: c.args }));
  if (client.chain?.contracts?.multicall3) {
    return (await client.multicall({ contracts: contracts as never, allowFailure: false })) as unknown as T;
  }
  return (await Promise.all(contracts.map((c) => client.readContract(c as never)))) as unknown as T;
}

/** Cheap staleness check: changes whenever policy, proposals, the freeze, or the anchor change. */
export async function readFingerprint(client: PublicClient, address: Address) {
  const [version, count, frozen, logLength] = await readMany<[bigint, bigint, boolean, bigint]>(
    client, [{ functionName: "policyVersion" }, { functionName: "proposalCount" }, { functionName: "frozen" }, { functionName: "logLength" }], address,
  );
  return `${version}:${count}:${frozen}:${logLength}`;
}

export async function readPolicy(client: PublicClient, address: Address, maxProposals = 200): Promise<OnchainPolicy> {
  const [[gatekeeper, timelock, required, frozen, threshold, version, logHead, logLength, members, rules, payees, agents, domains, count], block, chainId] =
    await Promise.all([
      readMany<readonly [
        Address, bigint, number, boolean, bigint, bigint, Hex, bigint, readonly Address[],
        readonly { id: Hex; outcome: number; core: boolean; builtin: boolean; active: boolean; agent: Hex; scope: string; target: string; maxMicroUsd: bigint }[],
        readonly { account: Address; category: string }[], readonly [readonly Hex[], readonly bigint[]], readonly string[], bigint,
      ]>(client, [
        { functionName: "gatekeeper" }, { functionName: "timelock" }, { functionName: "required" }, { functionName: "frozen" },
        { functionName: "thresholdMicroUsd" }, { functionName: "policyVersion" }, { functionName: "logHead" }, { functionName: "logLength" },
        { functionName: "members" }, { functionName: "rules" }, { functionName: "payees" }, { functionName: "agents" },
        { functionName: "domains" }, { functionName: "proposalCount" },
      ], address),
      client.getBlock(),
      client.chain?.id ?? client.getChainId(),
    ]);
  const n = Number(count);
  const ids = Array.from({ length: Math.min(n, maxProposals) }, (_, i) => n - 1 - i);
  type RawProposal = { op: number; data: Hex; proposer: Address; createdAt: bigint; queuedAt: bigint; yes: number; no: number; status: number };
  const raw = ids.length ? await readMany<RawProposal[]>(client, ids.map((id) => ({ functionName: "proposal", args: [BigInt(id)] })), address) : [];
  const liveIds = ids.filter((_, i) => raw[i].status === 1 || raw[i].status === 2);
  const pairs = liveIds.flatMap((id) => members.map((m) => ({ id, m })));
  const votedFlat = pairs.length ? await readMany<boolean[]>(client, pairs.map(({ id, m }) => ({ functionName: "hasVoted", args: [BigInt(id), m] })), address) : [];
  const voters = new Map<number, Address[]>();
  pairs.forEach(({ id, m }, k) => {
    if (votedFlat[k]) voters.set(id, [...(voters.get(id) ?? []), m]);
  });
  const tl = Number(timelock);
  return {
    address,
    chainId,
    gatekeeper,
    timelock: tl,
    required: Number(required),
    frozen,
    thresholdUsd: fromMicro(threshold),
    policyVersion: Number(version),
    logHead,
    logLength: Number(logLength),
    members: [...members],
    rules: rules.map((r) => ({
      id: fromBytes32(r.id),
      outcome: OUTCOME_NAMES[r.outcome],
      core: r.core,
      builtin: r.builtin,
      active: r.active,
      agent: /^0x0+$/.test(r.agent) ? undefined : fromBytes32(r.agent),
      scope: r.scope,
      target: r.target,
      maxUsd: fromMicro(r.maxMicroUsd),
    })),
    payees: payees.map((p) => ({ account: p.account, category: p.category })),
    agents: agents[0].map((id, i) => ({ id: fromBytes32(id), capUsd: fromMicro(agents[1][i]) })),
    domains: [...domains],
    proposals: raw.map((p, i) => {
      let change: Change | null = null;
      try {
        change = decodeChange(p.op, p.data);
      } catch {
        change = null;
      }
      const status = STATUS_NAMES[p.status];
      return {
        id: ids[i], op: p.op, data: p.data, change, proposer: p.proposer,
        createdAt: Number(p.createdAt), queuedAt: Number(p.queuedAt),
        eta: status === "queued" || status === "executed" ? Number(p.queuedAt) + tl : null,
        yes: p.yes, no: p.no, status, voters: (voters.get(ids[i]) ?? []).map((v) => v.toLowerCase() as Address),
      };
    }),
    chainTime: Number(block.timestamp),
  };
}
