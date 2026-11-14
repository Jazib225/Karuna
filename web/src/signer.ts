// This browser's member key. Every Dharma action and every payment decision is signed here,
// in the member's own browser. The Gatekeeper only relays signatures; it can't make one.
// The key lives in this browser's storage: clearing site data means re-enrolling (a member
// proposes adding the new key). One browser = one member.
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import {
  ARC_TESTNET_CHAIN_ID, Kind, actionTypedData, encodeChange, paymentDecisionTypedData, type Change,
} from "@prekaruna/dharma";
import { api } from "./api.ts";

const STORAGE_KEY = "karuna.signer.v1";

export class SignerUnavailable extends Error {}

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
  me: PrivateKeyAccount, dharma: Address,
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
export async function signDecision(me: PrivateKeyAccount, dharma: Address, proposalId: string, payloadHash: string, approve: boolean) {
  const h = (payloadHash.startsWith("0x") ? payloadHash : `0x${payloadHash}`) as Hex;
  const d = deadline();
  const signature = await me.signTypedData(paymentDecisionTypedData(dharma, ARC_TESTNET_CHAIN_ID, { proposalId, payloadHash: h, approve, deadline: d }));
  return { approve, payloadHash: h, signer: me.address, deadline: d.toString(), signature };
}

/** Sign and submit an approve/deny for one payment, bound to the payload hash on the card. */
export async function decidePayment(me: PrivateKeyAccount, dharma: Address, proposalId: string, payloadHash: string, approve: boolean) {
  return api<{ status: string; error?: string }>(`/proposals/${proposalId}/decide`, await signDecision(me, dharma, proposalId, payloadHash, approve));
}

export { Kind };
