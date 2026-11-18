// What the Gatekeeper keeps locally. POLICY is not here: agents, allowances, payees, domains,
// rules, the two-person threshold, members, and the freeze switch all live in the org's Dharma
// contract on Arc. Locally we keep only what must stay private or isn't policy:
//   - human-readable labels (names are never written onchain)
//   - agent token hashes (an agent's identity, not a permission)
//   - pointers: the org's wallet and its Dharma contract
//   - pending access requests from new browsers
import { isAddress } from "viem";
import { DEFAULT_ALLOWLISTED_DOMAINS } from "@prekaruna/engine";

/** Circle CLI chain id for Arc testnet. */
export const WALLET_CHAIN = "ARC-TESTNET";
/** USDC (ERC-20 interface, 6 decimals) on Arc. */
export const USDC_TOKEN = "0x3600000000000000000000000000000000000000";
export const EXPLORER = "https://testnet.arcscan.app";
export { DEFAULT_ALLOWLISTED_DOMAINS };

export interface OrgFile {
  version: 2;
  name: string;
  wallet: { address: string; chain: string } | null;
  dharma: { address: string; chainId: number; deployedAt: string; txRef: string } | null;
  labels: {
    members: Record<string, string>; // lowercased address -> name
    agents: Record<string, string>; // agent id -> name
    payees: Record<string, string>; // lowercased address -> name
  };
  agentTokens: Record<string, string>; // agent id -> sha256(token)
  enrollments: { address: string; name: string; requestedAt: string; via?: "invite" }[];
  /** Invite links: anyone with one can send a join request from their own Karuna (members still vote). */
  invites?: Invite[];
  /** Newer Dharma code deployed for an Upgrade vote (the org moves only once the vote passes). */
  dharmaCode?: { implementation: string; version: number; txRef: string; deployedAt: string };
  /** The org's Escrow for large payments (deployed the first time an escrow rule needs it). */
  escrow?: { address: string; opener: string; deployedAt: string; txRef: string };
}

export interface Invite {
  code: string;
  createdAt: string;
  expiresAt: string;
  /** Join requests sent with this link (it stops working at maxUses). */
  uses: number;
  maxUses: number;
  revoked?: boolean;
}

export const emptyOrg = (): OrgFile => ({
  version: 2,
  name: "",
  wallet: null,
  dharma: null,
  labels: { members: {}, agents: {}, payees: {} },
  agentTokens: {},
  enrollments: [],
});

export const isSetUp = (o: OrgFile) => !!o.name && !!o.wallet && !!o.dharma;

export class ConfigError extends Error {}

export function requireText(v: unknown, field: string, max = 80): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new ConfigError(`${field} is required`);
  if (s.length > max) throw new ConfigError(`${field} must be at most ${max} characters`);
  return s;
}

export function requireAddress(v: unknown, field = "address"): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!isAddress(s, { strict: false })) throw new ConfigError(`${field} must be a 0x… address`);
  return s.toLowerCase();
}

export function requireUsd(v: unknown, field: string, { allowZero = true } = {}): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) throw new ConfigError(`${field} must be a number ≥ ${allowZero ? 0 : "0.000001"}`);
  if (n > 1_000_000) throw new ConfigError(`${field} is unreasonably large`);
  return Math.round(n * 1e6) / 1e6;
}

/** URL-safe id from a display name, unique within `taken`, ≤ 32 chars (fits bytes32). */
export function slugId(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "agent";
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}
