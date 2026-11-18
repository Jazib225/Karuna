// Who signs. Every Dharma action and every payment decision is signed by the member, never by the
// Gatekeeper (it only relays signatures). Two kinds of signer:
//   - the person's email account (Circle, see circle.ts): the same member on every device;
//   - this device's own key, kept in this browser's storage (one browser = one member).
// Both sign the same EIP-712 messages, which Dharma checks the same way.
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import {
  ARC_TESTNET_CHAIN_ID, Kind, actionTypedData, encodeChange, escrowCancelTypedData, paymentDecisionTypedData, type Change,
} from "@prekaruna/dharma";
import { api } from "./api.ts";

const STORAGE_KEY = "karuna.signer.v1";

export class SignerUnavailable extends Error {}

/** What signs: this device's key, or the person's email account (`email` is set for that one). */
export type Signer = Pick<PrivateKeyAccount, "address" | "signTypedData"> & { email?: string };

/** Use this key on this device from now on (signing in to an account). */
export function saveSignerKey(key: Hex) {
  localStorage.setItem(STORAGE_KEY, key);
}

/** Forget this device's key (signing out); a fresh one is made on next load. */
export function clearSigner() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing stored */
  }
}

/** This device's raw key, to save it to an account. */
export function signerKey(): Hex | null {
  try {
    return localStorage.getItem(STORAGE_KEY) as Hex | null;
  } catch {
    return null;
  }
}

/** Load this browser's key, creating it on first use. Throws if storage is unavailable. */
export function loadSigner(): PrivateKeyAccount {
  let key: string | null;
  try {
    key = localStorage.getItem(STORAGE_KEY);
    if (!key) {
      key = generatePrivateKey();
      localStorage.setItem(STORAGE_KEY, key);
      if (localStorage.getItem(STORAGE_KEY) !== key) throw new Error("storage did not persist");
    }
  } catch {
    throw new SignerUnavailable("This browser can't keep a signing key (private window or blocked storage). Use a normal browser window.");
  }
  return privateKeyToAccount(key as Hex);
}

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 10 * 60);

async function nonce(addr: Address) {
  return BigInt((await api<{ nonce: string }>(`/dharma/nonce/${addr}`)).nonce);
}

/** Sign and submit a Dharma action: Tighten (instant), Propose (vote + timelock), or Vote. */
export async function submitChange(
  me: Signer, dharma: Address,
  a: { kind: number; change: Change; proposalId?: number; support?: boolean; label?: string },
) {
  const { op, data } = encodeChange(a.change);
  const d = deadline();
  const signature = await me.signTypedData(
    actionTypedData(dharma, ARC_TESTNET_CHAIN_ID, {
      kind: a.kind, op, data, proposalId: BigInt(a.proposalId ?? 0), support: !!a.support, nonce: await nonce(me.address), deadline: d,
    }),
  );
  return api<{ txRef: string; proposalId?: number }>("/dharma/action", {
    kind: a.kind, op, data, proposalId: a.proposalId ?? 0, support: !!a.support, signer: me.address,
    deadline: d.toString(), signature, label: a.label,
  });
}

/** Sign (only) an approve/deny for one request, bound to its payload hash. Nothing is sent. */
export async function signDecision(me: Signer, dharma: Address, proposalId: string, payloadHash: string, approve: boolean) {
  const h = (payloadHash.startsWith("0x") ? payloadHash : `0x${payloadHash}`) as Hex;
  const d = deadline();
  const signature = await me.signTypedData(paymentDecisionTypedData(dharma, ARC_TESTNET_CHAIN_ID, { proposalId, payloadHash: h, approve, deadline: d }));
  return { approve, payloadHash: h, signer: me.address, deadline: d.toString(), signature };
}

/** Sign and submit an approve/deny for one payment, bound to the payload hash on the card. */
export async function decidePayment(me: Signer, dharma: Address, proposalId: string, payloadHash: string, approve: boolean) {
  return api<{ status: string; error?: string }>(`/proposals/${proposalId}/decide`, await signDecision(me, dharma, proposalId, payloadHash, approve));
}

/** Sign a cancel for one escrowed payment; the Gatekeeper relays it and the Escrow checks you're a member. */
export async function cancelEscrow(me: Signer, escrow: Address, holdId: string, paymentId: string) {
  const signature = await me.signTypedData(escrowCancelTypedData(escrow, ARC_TESTNET_CHAIN_ID, { id: BigInt(holdId) }));
  return api<{ status: string; txRef: string }>(`/proposals/${paymentId}/escrow-cancel`, { signer: me.address, signature });
}

export { Kind };
