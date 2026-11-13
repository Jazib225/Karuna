// Organization configuration. Every organization starts EMPTY and configures itself in the
// console: its name, the humans who approve, its wallet, its agents and their allowances,
// the recipients it pays, and the domains it trusts. Nothing here is built in.
import { isAddress } from "viem";
import { DEFAULT_ALLOWLISTED_DOMAINS } from "@prekaruna/engine";

/** Circle CLI chain id for Arc testnet. */
export const WALLET_CHAIN = "ARC-TESTNET";
/** USDC (ERC-20 interface, 6 decimals) on Arc. */
export const USDC_TOKEN = "0x3600000000000000000000000000000000000000";

export interface Member {
  id: string;
  name: string;
  createdAt: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  dailyAllowanceUsd: number;
  /** sha256 of the agent's token. The token itself is shown once and never stored. */
  tokenHash: string;
  createdAt: string;
}

export interface Recipient {
  address: string; // lowercased
  name: string;
  category: string;
  addedAt: string;
}

export interface OrgConfig {
  version: 1;
  name: string;
  wallet: { address: string; chain: string } | null;
  members: Member[];
  agents: AgentConfig[];
  recipients: Recipient[];
  allowlistedDomains: string[];
  /** Payments at or above this need two different members to approve. */
  twoPersonThresholdUsd: number;
}

export const emptyOrg = (): OrgConfig => ({
  version: 1,
  name: "",
  wallet: null,
  members: [],
  agents: [],
  recipients: [],
  allowlistedDomains: [...DEFAULT_ALLOWLISTED_DOMAINS],
  twoPersonThresholdUsd: 500,
});

export const isSetUp = (o: OrgConfig) => !!o.name && !!o.wallet && o.members.length > 0;

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

export function requireDomain(v: unknown): string {
  const s = (typeof v === "string" ? v : "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(s)) throw new ConfigError("domain must look like example.com");
  return s;
}

/** URL-safe id from a display name, unique within `taken`. */
export function slugId(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "item";
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}
