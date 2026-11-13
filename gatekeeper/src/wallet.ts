// Wallet backends. Only the Gatekeeper process ever touches one (CLAUDE.md §2 rule 1).
// CircleCliWallet drives the Circle CLI with the session that the org's operator logged in on
// this machine (`circle wallet login <email> --testnet`). No wallet key or session ever goes
// to an agent: agents only reach the Gatekeeper's proposal API.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatUnits, erc20Abi, createPublicClient, http, type Address } from "viem";
import { arcTestnet } from "viem/chains";
import { USDC_TOKEN, WALLET_CHAIN } from "./config.ts";

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

export class CircleCliWallet implements WalletBackend {
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly rpc = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL || undefined) });

  constructor(opts: { bin?: string } = {}) {
    this.bin = opts.bin ?? process.env.CIRCLE_BIN ?? "circle";
    this.env = {
      ...process.env,
      CIRCLE_VERSION_CHECK: "off",
      PATH: `${join(homedir(), ".local", "bin")}:${process.env.PATH ?? ""}`,
    };
  }

  private run(args: string[], timeoutMs = 120_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      execFile(
        this.bin,
        [...args, "-o", "json"],
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
    } catch {
      gateway = null; // CLI not logged in or Gateway unavailable; on-chain balance still shown
    }
    return { usdc: formatUnits(raw, decimals), gateway };
  }

  async listWallets(): Promise<string[]> {
    const d = await this.run(["wallet", "list", "--type", "agent", "--chain", WALLET_CHAIN], 30_000);
    const wallets = (d.wallets ?? []) as { address?: string }[];
    return [...new Set(wallets.map((w) => String(w.address ?? "").toLowerCase()).filter(Boolean))];
  }
}
