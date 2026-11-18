// Escrow vocabulary: large agent payments wait here until their release time, and any one member
// can cancel them before then. The Gatekeeper opens and releases holds; the console builds the
// members' cancel and opener-rotation signatures; the contract re-checks everything.
//
// Flow: the org's wallet sends a plain USDC transfer to the Escrow, then the opener calls
// `open(payee, amount, releaseAt, ref)` against that balance. Deploy with ESCROW_ABI +
// ESCROW_BYTECODE (from "@prekaruna/dharma/bytecode"), args [dharma, usdc, refundTo, opener].
import { encodeFunctionData, keccak256, stringToHex, type Address, type Hex } from "viem";
import { ESCROW_ABI } from "./abi.ts";

/** Arc's USDC (ERC-20, 6 decimals: one base unit is one micro-dollar, so `toMicro` gives amounts). */
export const ARC_USDC: Address = "0x3600000000000000000000000000000000000000";
export const USDC_DECIMALS = 6;

// Must match Escrow.Status order.
export const EscrowStatus = { None: 0, Held: 1, Released: 2, Cancelled: 3 } as const;
export const ESCROW_STATUS_NAMES = ["none", "held", "released", "cancelled"] as const;
export type EscrowStatusName = (typeof ESCROW_STATUS_NAMES)[number];

/** One hold, as `Escrow.holds(id)` returns it. `amount` is in USDC base units. */
export interface EscrowHold {
  id: bigint;
  payee: Address;
  amount: bigint;
  releaseAt: bigint;
  status: EscrowStatusName;
  ref: Hex;
}

/** The Gatekeeper's payment id -> the bytes32 `ref` a hold is opened with (any length of id). */
export const escrowRef = (paymentId: string): Hex => keccak256(stringToHex(paymentId));

// ---------------------------------------------------------------- calldata

/** `open(payee, amount, releaseAt, ref)`: sent by the opener after the USDC transfer lands. */
export function encodeEscrowOpen(h: { payee: Address; amount: bigint; releaseAt: bigint | number; ref: Hex }): Hex {
  return encodeFunctionData({
    abi: ESCROW_ABI, functionName: "open", args: [h.payee, h.amount, BigInt(h.releaseAt), h.ref],
  });
}

/** `cancel(id, sig)` to relay a member's signed CancelEscrow, or `cancel(id)` sent by the member. */
export function encodeEscrowCancel(id: bigint, signature?: Hex): Hex {
  return signature
    ? encodeFunctionData({ abi: ESCROW_ABI, functionName: "cancel", args: [id, signature] })
    : encodeFunctionData({ abi: ESCROW_ABI, functionName: "cancel", args: [id] });
}

/** `release(id)`: anyone, at or after the hold's release time. */
export function encodeEscrowRelease(id: bigint): Hex {
  return encodeFunctionData({ abi: ESCROW_ABI, functionName: "release", args: [id] });
}

/** `setOpener(opener, deadline, sig)`: relays one member's signed SetOpener. */
export function encodeEscrowSetOpener(opener: Address, deadline: bigint, signature: Hex): Hex {
  return encodeFunctionData({ abi: ESCROW_ABI, functionName: "setOpener", args: [opener, deadline, signature] });
}

// ---------------------------------------------------------------- typed data (EIP-712)

const escrowDomain = (escrow: Address, chainId: number) =>
  ({ name: "Karuna Escrow", version: "1", chainId, verifyingContract: escrow }) as const;

/** What a member signs to cancel one hold. Matches Escrow.CANCEL_TYPEHASH. No nonce: a hold
 *  settles once, so relaying the same signature again just reverts. */
export function escrowCancelTypedData(escrow: Address, chainId: number, c: { id: bigint }) {
  return {
    domain: escrowDomain(escrow, chainId),
    types: { CancelEscrow: [{ name: "id", type: "uint256" }] },
    primaryType: "CancelEscrow" as const,
    message: c,
  };
}

/** What a member signs to hand opening rights to a new account. Matches Escrow.SET_OPENER_TYPEHASH;
 *  `nonce` is the Escrow's current `openerNonce()`. */
export function escrowSetOpenerTypedData(escrow: Address, chainId: number, s: { opener: Address; nonce: bigint; deadline: bigint }) {
  return {
    domain: escrowDomain(escrow, chainId),
    types: {
      SetOpener: [
        { name: "opener", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "SetOpener" as const,
    message: s,
  };
}

// ---------------------------------------------------------------- state from events

/** An Escrow log after viem's `parseEventLogs({ abi: ESCROW_ABI, logs })`. */
export type EscrowLog =
  | { eventName: "Escrowed"; args: { id: bigint; payee: Address; amount: bigint; releaseAt: bigint; ref: Hex } }
  | { eventName: "EscrowCancelled"; args: { id: bigint; member: Address } }
  | { eventName: "EscrowReleased"; args: { id: bigint } }
  | { eventName: string; args: unknown };

/** Rebuild every hold from the Escrow's events (the QuickNode Stream, backfilled from deploy),
 *  in log order. Holds keyed by id; the same answer `holds(id)` gives onchain. */
export function holdsFromLogs(logs: readonly EscrowLog[], into: Map<bigint, EscrowHold> = new Map()): Map<bigint, EscrowHold> {
  for (const l of logs) {
    if (l.eventName === "Escrowed") {
      const a = (l as Extract<EscrowLog, { eventName: "Escrowed" }>).args;
      into.set(a.id, { id: a.id, payee: a.payee, amount: a.amount, releaseAt: a.releaseAt, status: "held", ref: a.ref });
    } else if (l.eventName === "EscrowCancelled" || l.eventName === "EscrowReleased") {
      const h = into.get((l.args as { id: bigint }).id);
      if (h) h.status = l.eventName === "EscrowCancelled" ? "cancelled" : "released";
    }
  }
  return into;
}
