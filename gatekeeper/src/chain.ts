// The Gatekeeper's view of Dharma: read the org's onchain policy, and send transactions.
// Writes go through a ChainWriter. In production that's the org's Circle agent wallet (the
// Gatekeeper relays members' signed actions and pays gas); in tests it's a local key on anvil.
// Every write is simulated first, so a call that would revert costs nothing and its reason is
// readable (e.g. "CoreBoundary").
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const ARGV_WRAPPER = fileURLToPath(new URL("./circle-argv.mjs", import.meta.url));
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, encodeDeployData, encodeFunctionData, http, zeroAddress,
  type Address, type Chain, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { arcTestnet } from "viem/chains";
import { DHARMA_ABI, DHARMA_PROXY_ABI, MAX_LEVEL, OUTCOME_NAMES, STATUS_NAMES, decodeChange, fromBytes32, fromMicro, type Change, type LevelLimits } from "@prekaruna/dharma";
import { DHARMA_BYTECODE, DHARMA_PROXY_BYTECODE } from "@prekaruna/dharma/bytecode";
import type { OnchainRule } from "@prekaruna/engine";
import { WALLET_CHAIN } from "./config.ts";

export type WriteFn =
  | "tighten" | "propose" | "vote" | "execute" | "anchorLog" | "requestApproval" | "reportTestFailed"
  // v3
  | "anchorWithRecord" | "reportTripwire" | "reportUnapprovedTransfer";

export interface DeployArgs {
  firstMember: Address;
  timelockSeconds: number; // the normal wait
  coreTimelockSeconds: number; // the wait for core changes
  thresholdMicro: bigint;
  domains: string[];
}

export interface ChainWriter {
  readonly from: Address; // the Gatekeeper's address (Dharma.gatekeeper)
  deploy(args: DeployArgs): Promise<{ address: Address; txRef: string; implementation: Address }>;
  /** Deploy only the current Dharma code (for an Upgrade the members then vote on). */
  deployCode(): Promise<{ implementation: Address; txRef: string }>;
  write(contract: Address, fn: WriteFn, args: readonly unknown[]): Promise<{ txRef: string }>;
}

/** The org's setup call, run inside the proxy as it's created (so nobody can set the org up first). */
function initCall(gatekeeper: Address, a: DeployArgs): Hex {
  return encodeFunctionData({
    abi: DHARMA_ABI, functionName: "initialize",
    args: [gatekeeper, a.firstMember, BigInt(a.timelockSeconds), BigInt(a.coreTimelockSeconds), a.thresholdMicro, a.domains],
  });
}
const proxyDeployData = (implementation: Address, gatekeeper: Address, a: DeployArgs) =>
  encodeDeployData({ abi: DHARMA_PROXY_ABI, bytecode: DHARMA_PROXY_BYTECODE, args: [implementation, initCall(gatekeeper, a)] });

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

/** Error text safe to log: first line only, URLs removed (RPC URLs can embed access tokens). */
export const scrub = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].replace(/https?:\/\/[^\s'"]+/g, "<url>");

/** True for transient RPC trouble (rate limits, timeouts) as opposed to a real revert. */
export const isTransient = (e: unknown) => /rate limit|429|timed? ?out|ECONNRESET|fetch failed|Request exceeds/i.test(e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? "")}` : String(e));

// ---------------------------------------------------------------- Circle (production)

const fnSig = (fn: WriteFn) => {
  const item = DHARMA_ABI.find((x) => x.type === "function" && x.name === fn) as { inputs: readonly { type: string }[] };
  return `${fn}(${item.inputs.map((i) => i.type).join(",")})`;
};
/** One Circle CLI argument. Arrays go as JSON, with integers as strings (they can exceed 2^53). */
const cliArg = (v: unknown): string =>
  Array.isArray(v) ? JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)) : typeof v === "bigint" ? v.toString() : String(v);

export class CircleChainWriter implements ChainWriter {
  private readonly env: NodeJS.ProcessEnv;
  constructor(readonly from: Address, private readonly client: PublicClient, private readonly bin = process.env.CIRCLE_BIN ?? "circle") {
    this.env = { ...process.env, CIRCLE_VERSION_CHECK: "off", PATH: `${join(homedir(), ".local", "bin")}${delimiter}${process.env.PATH ?? ""}` };
  }

  private run(args: string[], timeoutMs = 180_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      // A .js CIRCLE_BIN (e.g. the npm package entry on Windows) runs under node.
      const js = /\.[cm]?js$/i.test(this.bin);
      let cliArgs = [...args, "-o", "json"];
      if (js && cliArgs.join(" ").length > 24_000) {
        // Too long for a Windows command line (deploy bytecode): hand the args over in a temp file.
        const file = join(tmpdir(), `circle-args-${randomUUID()}.json`);
        writeFileSync(file, JSON.stringify(cliArgs));
        cliArgs = [ARGV_WRAPPER, this.bin, file];
      } else if (js) {
        cliArgs = [this.bin, ...cliArgs];
      }
      execFile(js ? process.execPath : this.bin, cliArgs, { env: this.env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
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

  /** Two transactions: the Dharma code, then the org's proxy (its permanent address) pointing at it. */
  async deploy(a: DeployArgs) {
    const code = await this.run(["contract", "deploy", "--bytecode", DHARMA_BYTECODE, "--address", this.from, "--chain", WALLET_CHAIN], 300_000);
    if (!code.contractAddress) throw new ChainError("Deploying the Dharma code finished without an address");
    const impl = String(code.contractAddress) as Address;
    const d = await this.run(["contract", "deploy", "--bytecode", proxyDeployData(impl, this.from, a), "--address", this.from, "--chain", WALLET_CHAIN], 300_000);
    if (!d.contractAddress) throw new ChainError("Deploying the org's Dharma finished without an address");
    return { address: String(d.contractAddress) as Address, txRef: String(d.txHash ?? d.id), implementation: impl };
  }

  async deployCode() {
    const code = await this.run(["contract", "deploy", "--bytecode", DHARMA_BYTECODE, "--address", this.from, "--chain", WALLET_CHAIN], 300_000);
    if (!code.contractAddress) throw new ChainError("Deploying the Dharma code finished without an address");
    return { implementation: String(code.contractAddress) as Address, txRef: String(code.txHash ?? code.id) };
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
    throw new ChainError(reason ? `Dharma rejected this: ${reason}` : `Simulation failed: ${scrub(e)}`, reason);
  }
}

// ---------------------------------------------------------------- fast relay for member-signed writes

/**
 * Calls Dharma accepts from anyone, because it checks a member's own signature: proposing, voting,
 * executing a passed change, and a member's own tighten (Freeze, lowering a level). Only the
 * Gatekeeper's calls (signer 0: Drills, Tripwire, anchors, approval signals) must come from
 * Dharma.gatekeeper, the org's Circle wallet.
 */
export const isMemberSigned = (fn: WriteFn, args: readonly unknown[]) =>
  fn === "propose" || fn === "vote" || fn === "execute" || (fn === "tighten" && String(args[2] ?? "").toLowerCase() !== zeroAddress);

/**
 * Member-signed writes go through `relay` (a plain key that only pays gas: about a second on Arc)
 * instead of the Circle wallet (up to minutes). One at a time, so its nonces never collide. If the
 * relay fails for any reason other than Dharma refusing the call (out of gas money, RPC trouble),
 * the write falls back to the Circle wallet, so it's slower, never lost.
 */
export class RelayedChainWriter implements ChainWriter {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly gk: ChainWriter, private readonly relay: ChainWriter, private readonly onFallback?: (e: unknown) => void) {}
  get from() {
    return this.gk.from;
  }
  deploy(a: DeployArgs) {
    return this.gk.deploy(a);
  }
  deployCode() {
    return this.gk.deployCode();
  }
  write(contract: Address, fn: WriteFn, args: readonly unknown[]) {
    if (!isMemberSigned(fn, args)) return this.gk.write(contract, fn, args);
    const run = this.queue.then(async () => {
      try {
        return await this.relay.write(contract, fn, args);
      } catch (e) {
        if (e instanceof ChainError && e.reason) throw e; // Dharma said no: the Circle wallet would hear the same
        this.onFallback?.(e);
        return this.gk.write(contract, fn, args);
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

// ---------------------------------------------------------------- local key (tests / anvil)

export class ViemChainWriter implements ChainWriter {
  readonly from: Address;
  constructor(private readonly wallet: WalletClient, private readonly client: PublicClient) {
    this.from = wallet.account!.address;
  }

  async deploy(a: DeployArgs) {
    const codeHash = await this.wallet.deployContract({ abi: DHARMA_ABI, bytecode: DHARMA_BYTECODE, account: this.wallet.account!, chain: this.wallet.chain });
    const code = await this.client.waitForTransactionReceipt({ hash: codeHash });
    if (!code.contractAddress) throw new ChainError("deploying the Dharma code failed");
    const hash = await this.wallet.sendTransaction({ data: proxyDeployData(code.contractAddress, this.from, a), account: this.wallet.account!, chain: this.wallet.chain });
    const r = await this.client.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new ChainError("deploying the org's Dharma failed");
    return { address: r.contractAddress, txRef: hash, implementation: code.contractAddress };
  }

  async deployCode() {
    const hash = await this.wallet.deployContract({ abi: DHARMA_ABI, bytecode: DHARMA_BYTECODE, account: this.wallet.account!, chain: this.wallet.chain });
    const r = await this.client.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new ChainError("deploying the Dharma code failed");
    return { implementation: r.contractAddress, txRef: hash };
  }

  async write(contract: Address, fn: WriteFn, args: readonly unknown[]) {
    await simulate(this.client, this.from, contract, fn, args);
    const hash = await this.wallet.writeContract({
      address: contract, abi: DHARMA_ABI, functionName: fn, args: args as never, account: this.wallet.account!, chain: this.wallet.chain,
    });
    // Arc confirms in under a second; check every half second rather than the default 4 s.
    const r = await this.client.waitForTransactionReceipt({ hash, pollingInterval: 500 });
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
  core: boolean; // needs every member, waits the core wait, never skipped, cancelled by a freeze
  needed: number; // yes votes it needs
  yes: number;
  no: number;
  status: (typeof STATUS_NAMES)[number];
  voters: Address[]; // members who already voted (open/queued proposals)
}

export interface OnchainPolicy {
  address: Address;
  chainId: number;
  gatekeeper: Address;
  timelock: number; // normal wait, seconds
  coreTimelock: number; // core wait, seconds
  version: number; // Dharma code version
  implementation: Address;
  required: number; // yes votes a normal change needs (a core change needs every member)
  frozen: boolean;
  thresholdUsd: number;
  policyVersion: number;
  logHead: Hex;
  logLength: number;
  members: Address[];
  rules: OnchainRule[];
  payees: { account: Address; category: string }[];
  agents: { id: string; capUsd: number; level?: number }[]; // level: Dharma v3+
  /** What each trust level may pay (index = level). Null before Dharma v3. */
  levelLimits: LevelLimits[] | null;
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
  const [[gatekeeper, timelock, required, frozen, threshold, version, logHead, logLength, members, rules, payees, agents, domains, count, coreTimelock, codeVersion, implementation], block, chainId] =
    await Promise.all([
      readMany<readonly [
        Address, bigint, number, boolean, bigint, bigint, Hex, bigint, readonly Address[],
        readonly { id: Hex; outcome: number; core: boolean; builtin: boolean; active: boolean; agent: Hex; scope: string; target: string; maxMicroUsd: bigint }[],
        readonly { account: Address; category: string }[], readonly [readonly Hex[], readonly bigint[]], readonly string[], bigint,
        bigint, bigint, Address,
      ]>(client, [
        { functionName: "gatekeeper" }, { functionName: "timelock" }, { functionName: "required" }, { functionName: "frozen" },
        { functionName: "thresholdMicroUsd" }, { functionName: "policyVersion" }, { functionName: "logHead" }, { functionName: "logLength" },
        { functionName: "members" }, { functionName: "rules" }, { functionName: "payees" }, { functionName: "agents" },
        { functionName: "domains" }, { functionName: "proposalCount" },
        { functionName: "coreTimelock" }, { functionName: "version" }, { functionName: "implementation" },
      ], address),
      client.getBlock(),
      client.chain?.id ?? client.getChainId(),
    ]);
  // Trust levels (v3): every agent's level and each level's payment limits.
  let levelOf: Map<string, number> | null = null;
  let levelLimits: LevelLimits[] | null = null;
  if (Number(codeVersion) >= 3) {
    const [lv, ...limits] = await readMany<readonly [readonly [readonly Hex[], readonly number[]], ...{ perPaymentMicroUsd: bigint; dailyMicroUsd: bigint }[]]>(
      client,
      [{ functionName: "levels" }, ...Array.from({ length: MAX_LEVEL + 1 }, (_, l) => ({ functionName: "levelLimits", args: [l] }))],
      address,
    );
    levelOf = new Map(lv[0].map((id, i) => [fromBytes32(id), Number(lv[1][i])]));
    levelLimits = limits.map((l) => ({ perPaymentUsd: fromMicro(l.perPaymentMicroUsd), dailyUsd: fromMicro(l.dailyMicroUsd) }));
  }
  const n = Number(count);
  const ids = Array.from({ length: Math.min(n, maxProposals) }, (_, i) => n - 1 - i);
  type RawProposal = { op: number; data: Hex; proposer: Address; createdAt: bigint; queuedAt: bigint; yes: number; no: number; status: number; core: boolean; eta: bigint };
  const raw = ids.length ? await readMany<RawProposal[]>(client, ids.map((id) => ({ functionName: "proposal", args: [BigInt(id)] })), address) : [];
  const liveIds = ids.filter((_, i) => raw[i].status === 1 || raw[i].status === 2);
  const pairs = liveIds.flatMap((id) => members.map((m) => ({ id, m })));
  const votedFlat = pairs.length ? await readMany<boolean[]>(client, pairs.map(({ id, m }) => ({ functionName: "hasVoted", args: [BigInt(id), m] })), address) : [];
  const voters = new Map<number, Address[]>();
  pairs.forEach(({ id, m }, k) => {
    if (votedFlat[k]) voters.set(id, [...(voters.get(id) ?? []), m]);
  });
  return {
    address,
    chainId,
    gatekeeper,
    timelock: Number(timelock),
    coreTimelock: Number(coreTimelock),
    version: Number(codeVersion),
    implementation,
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
    agents: agents[0].map((id, i) => {
      const a = fromBytes32(id);
      return { id: a, capUsd: fromMicro(agents[1][i]), ...(levelOf ? { level: levelOf.get(a) ?? 0 } : {}) };
    }),
    levelLimits,
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
        eta: status === "queued" || status === "executed" ? Number(p.eta) : null,
        core: p.core, needed: p.core ? members.length : Number(required),
        yes: p.yes, no: p.no, status, voters: (voters.get(ids[i]) ?? []).map((v) => v.toLowerCase() as Address),
      };
    }),
    chainTime: Number(block.timestamp),
  };
}
