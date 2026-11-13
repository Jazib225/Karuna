// Exact Match (CLAUDE.md §2 rule 8): what a human approved is exactly what executes.
// A payment's payload is everything that determines where money goes. Its hash is shown on
// the approval card, sent back with the approval, and recomputed right before paying.
import { createHash } from "node:crypto";
import { canonical } from "@prekaruna/engine";

export type PaymentPayload =
  | {
      kind: "x402";
      from: string; // paying wallet
      chain: string;
      url: string;
      method: string;
      body?: string;
      seller: string; // payTo, lowercased
      amountUsd: number;
      network: string; // CAIP-2, e.g. eip155:5042002
      scheme: string;
      transferMethod?: string;
    }
  | {
      kind: "transfer";
      from: string;
      chain: string;
      to: string; // lowercased
      amountUsd: number;
      token: string;
    };

export function payloadHash(p: PaymentPayload): string {
  return createHash("sha256").update(canonical(p)).digest("hex");
}

export const shortHash = (h: string) => `${h.slice(0, 4)}…${h.slice(-4)}`;
