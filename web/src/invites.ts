// Invite links, the joining side: sign a join request for another organization's Karuna, and
// remember (in this browser) which requests you sent so you can check on them.
import type { Address } from "viem";
import { api } from "./api.ts";
import type { Signer } from "./signer.ts";

/** Must match the Gatekeeper's inviteTypedData exactly. */
export function inviteTypedData(org: string, invite: string, member: Address, name: string) {
  return {
    domain: { name: "Karuna invite", version: "1" },
    types: { JoinRequest: [{ name: "org", type: "string" }, { name: "invite", type: "string" }, { name: "member", type: "address" }, { name: "name", type: "string" }] },
    primaryType: "JoinRequest" as const,
    message: { org, invite, member, name },
  };
}

export const inviteCode = (link: string) => link.trim().match(/\/invite\/(inv_[\w-]{8,40})\/?$/)?.[1] ?? null;

export interface SentJoin { link: string; org: string; address: string; sentAt: string; status?: "pending" | "member" | "none" }
const KEY = "karuna.joins.v1";

function all(): SentJoin[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as SentJoin[];
  } catch {
    return [];
  }
}

export function sentJoins(address: string): SentJoin[] {
  return all().filter((j) => j.address.toLowerCase() === address.toLowerCase());
}

function saveJoin(j: SentJoin) {
  try {
    const rest = all().filter((x) => !(x.link === j.link && x.address === j.address));
    localStorage.setItem(KEY, JSON.stringify([...rest, j].slice(-20)));
  } catch {
    /* storage off: the request was still sent */
  }
}

export const lookupInvite = (link: string) => api<{ org: string; expiresAt: string }>("/invites/lookup", { link: link.trim() });

export async function sendJoin(me: Signer, link: string, org: string, name: string) {
  const code = inviteCode(link);
  if (!code) throw new Error("That isn't a Karuna invite link");
  const signature = await me.signTypedData(inviteTypedData(org, code, me.address, name.trim()));
  const r = await api<{ org: string; status: "pending" | "member" }>("/invites/send", { link: link.trim(), address: me.address, name: name.trim(), signature });
  saveJoin({ link: link.trim(), org: r.org, address: me.address, sentAt: new Date().toISOString(), status: r.status });
  return r;
}

export async function joinStatus(j: SentJoin) {
  const r = await api<{ status: "pending" | "member" | "none" }>("/invites/status", { link: j.link, address: j.address });
  saveJoin({ ...j, status: r.status });
  return r.status;
}
