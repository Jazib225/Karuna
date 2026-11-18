// Wallet backends. Only the Gatekeeper process ever touches one (CLAUDE.md §2 rule 1).
// CircleCliWallet drives the Circle CLI with the session that the org's operator logged in on
// this machine (`circle wallet login <email> --testnet`). No wallet key or session ever goes
// to an agent: agents only reach the Gatekeeper's proposal API.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { formatUnits, parseUnits, erc20Abi, createPublicClient, http, type Address } from "viem";
import { arcTestnet } from "viem/chains";
import { USDC_TOKEN, WALLET_CHAIN } from "./config.ts";
import { randomUUID } from "node:crypto";

export interface X402Quote {
  amountUsd: number;
  seller: string; // payTo, lowercased
  network: string;
  scheme: string;
  transferMethod?: string;
}

export interface X402Result {
  response: unknown; // the seller's body, returned to the agent
  receipt?: string;
  transaction?: string;
}

export interface WalletBackend {
  quoteX402(from: string, url: string, method: string, body?: string): Promise<X402Quote>;
  payX402(from: string, url: string, method: string, body: string | undefined, maxUsd: number, paymentId: string): Promise<X402Result>;
  transfer(from: string, to: string, amountUsd: number, idempotencyKey: string): Promise<{ txRef: string; raw: unknown }>;
  balances(address: string): Promise<{ usdc: string; gateway: string | null }>;
  listWallets(): Promise<string[]>;
  /** Move USDC from the wallet into its Circle Gateway balance, which x402 purchases draw on. */
  depositGateway?(from: string, amountUsd: number): Promise<{ txRef: string; raw: unknown }>;
  /** Whether the Circle CLI is here and logged in to testnet (and as whom). */
  loginStatus?(): Promise<WalletLoginStatus>;
  /** Email a one-time code for a testnet login. A first login also creates the account's wallets. */
  loginStart?(email: string): Promise<{ requestId: string }>;
  /** Finish the login with the code from the email. */
  loginFinish?(requestId: string, code: string): Promise<{ email: string | null }>;
  /** Ask Circle's testnet faucet for USDC (one of this account's wallets). */
  fundTestnet?(address: string): Promise<void>;
}

export interface WalletLoginStatus {
  cli: boolean;
  loggedIn: boolean;
  email: string | null;
  expiresIn: string | null;
}

export class WalletError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

/** "$0.001 USDC" -> 0.001 */
export function parseUsd(price: unknown): number {
  const m = String(price ?? "").match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!m) throw new WalletError(`Could not read a price from "${String(price)}"`);
  return Number(m[1]);
}

function extractJson(text: string): Record<string, unknown> | null {
  const i = text.indexOf("{");
  if (i < 0) return null;
  try {
    return JSON.parse(text.slice(i)) as Record<string, unknown>;
  } catch {
    // stderr may contain a JSON block after other output; try the last top-level block
    const j = text.lastIndexOf("\n{");
    if (j >= 0) {
      try {
        return JSON.parse(text.slice(j + 1)) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

/** How much Gateway may pull from the wallet before another approval (one approval covers many deposits). */
const GATEWAY_ALLOWANCE_USD = Number(process.env.KARUNA_GATEWAY_ALLOWANCE_USD ?? 100);

export class CircleCliWallet implements WalletBackend {
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly rpc = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL || undefined) });

  constructor(opts: { bin?: string } = {}) {
    this.bin = opts.bin ?? process.env.CIRCLE_BIN ?? "circle";
    this.env = {
      ...process.env,
      CIRCLE_VERSION_CHECK: "off",
      PATH: `${join(homedir(), ".local", "bin")}${delimiter}${process.env.PATH ?? ""}`,
    };
  }

  private run(args: string[], timeoutMs = 120_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      // A .js CIRCLE_BIN (e.g. the npm package entry on Windows, where the circle.cmd shim can't be execFile'd) runs under node.
      const js = /\.[cm]?js$/i.test(this.bin);
      execFile(
        js ? process.execPath : this.bin,
        [...(js ? [this.bin] : []), ...args, "-o", "json"],
        { env: this.env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const parsed = extractJson(stdout) ?? extractJson(stderr);
          const error = parsed?.error as { message?: string; code?: string } | undefined;
          if (error) return reject(new WalletError(error.message ?? "Circle CLI error", error.code));
          if (parsed?.data !== undefined) return resolve(parsed.data as Record<string, unknown>);
          const tail = (stderr || stdout || String(err ?? "")).trim().split("\n").filter((l) => !/deprecat/i.test(l)).slice(-3).join(" ");
          reject(new WalletError(tail || "Circle CLI returned no data"));
        },
      );
    });
  }

  async quoteX402(from: string, url: string, method: string, body?: string): Promise<X402Quote> {
    const args = ["services", "pay", url, "--address", from, "--chain", WALLET_CHAIN, "-X", method, "--estimate"];
    if (body !== undefined) args.push("-d", body);
    const d = await this.run(args, 60_000);
    if (!d.seller) throw new WalletError("That URL did not return x402 payment requirements");
    return {
      amountUsd: parseUsd(d.price ?? d.amount),
      seller: String(d.seller).toLowerCase(),
      network: String(d.chain ?? ""),
      scheme: String(d.scheme ?? ""),
      transferMethod: d.assetTransferMethod ? String(d.assetTransferMethod) : undefined,
    };
  }

  async payX402(from: string, url: string, method: string, body: string | undefined, maxUsd: number, paymentId: string): Promise<X402Result> {
    const args = [
      "services", "pay", url, "--address", from, "--chain", WALLET_CHAIN, "-X", method,
      "--max-amount", String(maxUsd),
    ];
    // Note: no --payment-id. The CLI only accepts it when the seller advertises the
    // payment-identifier extension. Double-pay protection lives in the Gatekeeper instead
    // (one execution per proposal, guarded by status + an in-process lock).
    void paymentId;
    if (body !== undefined) args.push("-d", body);
    const d = await this.run(args, 120_000);
    const payment = (d.payment ?? {}) as Record<string, unknown>;
    const response = d.response;
    const paid = (response as { paid?: { transaction?: string } } | undefined)?.paid;
    return {
      response,
      receipt: payment.receipt ? String(payment.receipt) : undefined,
      transaction: paid?.transaction ?? (payment.transaction ? String(payment.transaction) : undefined),
    };
  }

  async transfer(from: string, to: string, amountUsd: number, idempotencyKey: string) {
    const d = await this.run(
      ["wallet", "transfer", to, "--amount", String(amountUsd), "--token", USDC_TOKEN, "--address", from,
        "--chain", WALLET_CHAIN, "--idempotency-key", idempotencyKey],
      180_000,
    );
    const ref = d.txHash ?? d.transactionHash ?? d.hash ?? d.id ?? d.transactionId ?? (d.transaction as { id?: string })?.id;
    return { txRef: ref ? String(ref) : "submitted", raw: d };
  }

  async balances(address: string) {
    const [raw, decimals] = await Promise.all([
      this.rpc.readContract({ address: USDC_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [address as Address] }),
      this.rpc.readContract({ address: USDC_TOKEN, abi: erc20Abi, functionName: "decimals" }),
    ]);
    let gateway: string | null = null;
    try {
      const g = await this.run(["gateway", "balance", "--address", address, "--chain", WALLET_CHAIN], 30_000);
      gateway = String(g.total ?? "0");
      if (/^0x[0-9a-fA-F]{40}$/.test(String(g.backingEOA ?? ""))) this.backingKeys.set(address.toLowerCase(), String(g.backingEOA));
    } catch {
      gateway = null; // CLI not logged in or Gateway unavailable; on-chain balance still shown
    }
    return { usdc: formatUnits(raw, decimals), gateway };
  }

  /** Circle Gateway's wallet contract on Arc testnet (where deposits go). */
  private gateway: Address = (process.env.KARUNA_GATEWAY_WALLET ?? "0x0077777d7EBA4688BDeF3E311b846F25870A19B9") as Address;

  /**
   * Add funds to Gateway in one transaction. Circle's `gateway deposit` sends two every time (an
   * approval, then the deposit, ~13s). Here the wallet approves Gateway once for a standing amount
   * (GATEWAY_ALLOWANCE_USD), and each deposit is a single `deposit` call while that lasts. Gateway
   * only ever pulls from the wallet that calls `deposit`, so the approval can't be used by anyone else.
   */
  async depositGateway(address: string, amountUsd: number): Promise<{ txRef: string; raw: unknown }> {
    const [decimals, allowance] = await Promise.all([
      this.rpc.readContract({ address: USDC_TOKEN, abi: erc20Abi, functionName: "decimals" }),
      this.rpc.readContract({ address: USDC_TOKEN, abi: erc20Abi, functionName: "allowance", args: [address as Address, this.gateway] }),
    ]);
    const value = parseUnits(String(amountUsd), decimals);
    // Gateway keeps an agent wallet's balance under its backing key (what `gateway balance` and
    // nanopayments use), so deposits are credited to that key, as Circle's own deposit does.
    const owner = await this.backingKey(address).catch(() => null);
    if (!owner) return this.cliDeposit(address, amountUsd, new Error("couldn't find the wallet's backing key"));
    try {
      if (allowance < value) {
        const standing = parseUnits(String(Math.max(amountUsd, GATEWAY_ALLOWANCE_USD)), decimals);
        await this.execute(address, USDC_TOKEN, "approve(address,uint256)", [this.gateway, standing.toString()]);
      }
    } catch (e) {
      return this.cliDeposit(address, amountUsd, e); // nothing moved: Circle's own deposit instead
    }
    // The deposit itself. Not retried another way if it fails: it may still have gone through.
    const ref = await this.execute(address, this.gateway, "depositFor(address,address,uint256)", [USDC_TOKEN, owner, value.toString()]);
    return { txRef: ref ?? "submitted", raw: { method: "depositFor", owner } };
  }

  private backingKeys = new Map<string, string>();
  /** The key Gateway files this wallet's balance under (Circle reports it with the balance). */
  private async backingKey(address: string): Promise<string> {
    const known = this.backingKeys.get(address.toLowerCase());
    if (known) return known;
    const g = await this.run(["gateway", "balance", "--address", address, "--chain", WALLET_CHAIN], 30_000);
    const key = String(g.backingEOA ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(key)) throw new WalletError("Circle didn't report the wallet's backing key");
    this.backingKeys.set(address.toLowerCase(), key);
    return key;
  }

  /** One contract call from the agent wallet (Circle signs and sends it). Returns its tx hash or id. */
  private async execute(address: string, contract: string, fn: string, args: string[]) {
    const d = await this.run(
      ["wallet", "execute", fn, ...args, "--contract", contract, "--address", address, "--chain", WALLET_CHAIN, "--idempotency-key", randomUUID()],
      120_000,
    );
    const ref = d.txHash ?? d.transactionHash ?? d.hash ?? d.id ?? d.transactionId ?? (d.transaction as { id?: string; txHash?: string } | undefined)?.txHash;
    return ref ? String(ref) : null;
  }

  /** Circle's standard deposit (approval + deposit). */
  private async cliDeposit(address: string, amountUsd: number, why?: unknown) {
    if (why) console.error(`gatekeeper · one-step Gateway deposit unavailable, using Circle's deposit: ${why instanceof Error ? why.message : String(why)}`);
    // "direct": an onchain deposit from this wallet on Arc testnet (gas is paid in USDC there).
    const d = await this.run(
      ["gateway", "deposit", "--amount", String(amountUsd), "--address", address, "--chain", WALLET_CHAIN, "--method", "direct", "--timeout", "180"],
      200_000,
    );
    const ref = d.txHash ?? d.transactionHash ?? d.hash ?? d.depositTxHash ?? (d.transaction as { hash?: string; id?: string } | undefined)?.hash ?? d.id;
    return { txRef: ref ? String(ref) : "submitted", raw: d };
  }

  async listWallets(): Promise<string[]> {
    const d = await this.run(["wallet", "list", "--type", "agent", "--chain", WALLET_CHAIN], 30_000);
    const wallets = (d.wallets ?? []) as { address?: string }[];
    return [...new Set(wallets.map((w) => String(w.address ?? "").toLowerCase()).filter(Boolean))];
  }

  async loginStatus(): Promise<WalletLoginStatus> {
    try {
      const d = await this.run(["wallet", "status", "--type", "agent"], 30_000);
      const t = (d.testnet ?? {}) as { email?: string; tokenStatus?: string; expiresIn?: string };
      const loggedIn = t.tokenStatus === "VALID";
      return { cli: true, loggedIn, email: loggedIn ? t.email ?? null : null, expiresIn: loggedIn ? t.expiresIn ?? null : null };
    } catch (e) {
      if (/ENOENT|not recognized|not found/i.test(e instanceof Error ? e.message : String(e))) return { cli: false, loggedIn: false, email: null, expiresIn: null };
      throw e;
    }
  }

  async loginStart(email: string) {
    const d = await this.run(["wallet", "login", email, "--type", "agent", "--testnet", "--init"], 60_000);
    // The CLI says what to run next: "circle wallet login --request <id> --otp <code>".
    const id = /--request\s+(\S+)/.exec(String(d.message ?? ""))?.[1];
    if (!id) throw new WalletError("Circle didn't start the login. Try again.");
    return { requestId: id };
  }

  async loginFinish(requestId: string, code: string) {
    const d = await this.run(["wallet", "login", "--request", requestId, "--otp", code, "--type", "agent", "--testnet"], 60_000);
    return { email: /Logged in as (\S+)/.exec(String(d.message ?? ""))?.[1] ?? null };
  }

  async fundTestnet(address: string) {
    await this.run(["wallet", "fund", "--address", address, "--chain", WALLET_CHAIN], 60_000);
  }
}
