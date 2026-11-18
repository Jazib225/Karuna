// Escrow for large agent payments (contracts/src/Escrow.sol). The org's wallet pays the USDC into
// the org's Escrow, then the opener (the relayer key: it only pays gas) records the hold with its
// payee and release time. Any one member can cancel before release (the USDC goes back to the
// org's wallet); after the window anyone may release it, and the Gatekeeper does so promptly.
import { parseEventLogs, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { ARC_USDC, ESCROW_ABI, toMicro } from "@prekaruna/dharma";
import { ESCROW_BYTECODE } from "@prekaruna/dharma/bytecode";
import { ChainError, revertReason, scrub } from "./chain.ts";

export interface EscrowBackend {
  /** The account allowed to open holds (the relayer). */
  readonly opener: Address;
  deploy(a: { dharma: Address; refundTo: Address }): Promise<{ address: Address; txRef: string }>;
  open(escrow: Address, h: { payee: Address; amountUsd: number; releaseAt: number; ref: Hex }): Promise<{ id: bigint; txRef: string }>;
  release(escrow: Address, id: bigint): Promise<{ txRef: string }>;
  /** Relay a member's signed cancel (Escrow checks the signer is a Dharma member). */
  cancel(escrow: Address, id: bigint, signature: Hex): Promise<{ txRef: string }>;
}

type EscrowFn = "open" | "release" | "cancel";

/** A plain key (the relayer) that deploys the org's Escrow and opens, releases and relays cancels. */
export class ViemEscrow implements EscrowBackend {
  readonly opener: Address;
  private queue: Promise<unknown> = Promise.resolve(); // one at a time, so nonces never collide
  constructor(private readonly wallet: WalletClient, private readonly client: PublicClient, private readonly usdc: Address = ARC_USDC) {
    this.opener = wallet.account!.address;
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(f);
    this.queue = run.catch(() => undefined);
    return run;
  }

  deploy(a: { dharma: Address; refundTo: Address }) {
    return this.serial(async () => {
      const hash = await this.wallet.deployContract({
        abi: ESCROW_ABI, bytecode: ESCROW_BYTECODE as Hex, args: [a.dharma, this.usdc, a.refundTo, this.opener],
        account: this.wallet.account!, chain: this.wallet.chain,
      });
      const r = await this.client.waitForTransactionReceipt({ hash, pollingInterval: 500 });
      if (r.status !== "success" || !r.contractAddress) throw new ChainError("Deploying the escrow failed");
      return { address: r.contractAddress, txRef: hash };
    });
  }

  private write(escrow: Address, fn: EscrowFn, args: readonly unknown[]) {
    return this.serial(async () => {
      try {
        await this.client.simulateContract({ address: escrow, abi: ESCROW_ABI, functionName: fn as never, args: args as never, account: this.opener });
      } catch (e) {
        const reason = revertReason(e);
        throw new ChainError(reason ? `Escrow rejected this: ${reason}` : `Simulation failed: ${scrub(e)}`, reason);
      }
      const hash = await this.wallet.writeContract({
        address: escrow, abi: ESCROW_ABI, functionName: fn as never, args: args as never, account: this.wallet.account!, chain: this.wallet.chain,
      });
      const r = await this.client.waitForTransactionReceipt({ hash, pollingInterval: 500 });
      if (r.status !== "success") throw new ChainError(`${fn} reverted`);
      return { hash, logs: r.logs };
    });
  }

  async open(escrow: Address, h: { payee: Address; amountUsd: number; releaseAt: number; ref: Hex }) {
    const { hash, logs } = await this.write(escrow, "open", [h.payee, toMicro(h.amountUsd), BigInt(h.releaseAt), h.ref]);
    const ev = parseEventLogs({ abi: ESCROW_ABI, logs, eventName: "Escrowed" })[0] as unknown as { args: { id: bigint } } | undefined;
    if (!ev) throw new ChainError("The escrow didn't record the hold");
    return { id: ev.args.id, txRef: hash };
  }

  async release(escrow: Address, id: bigint) {
    return { txRef: (await this.write(escrow, "release", [id])).hash };
  }

  async cancel(escrow: Address, id: bigint, signature: Hex) {
    return { txRef: (await this.write(escrow, "cancel", [id, signature])).hash };
  }
}
