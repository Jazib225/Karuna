// Shared Dharma vocabulary for the Gatekeeper and the console.
// The browser builds and signs changes with these helpers; the Gatekeeper decodes and relays
// them; the contract re-checks everything. One definition, so they can't drift apart.
import {
  decodeAbiParameters, encodeAbiParameters, hexToString, isAddress, stringToHex, type Address, type Hex,
} from "viem";

export { DHARMA_ABI, DHARMA_PROXY_ABI } from "./abi.ts";

export const ARC_TESTNET_CHAIN_ID = 5042002;

// Must match Dharma.Op / Outcome / Status / Kind order.
export const Op = {
  AddRule: 0, RemoveRule: 1, SetPayee: 2, RemovePayee: 3, SetAgent: 4, RemoveAgent: 5,
  AddDomain: 6, RemoveDomain: 7, SetThreshold: 8, Freeze: 9, Unfreeze: 10, AddMember: 11, RemoveMember: 12,
  SetTimelock: 13, SetCoreTimelock: 14, Upgrade: 15, SetLevel: 16, SetLevelLimits: 17,
} as const;
export type OpName = keyof typeof Op;
export const OP_NAMES = Object.keys(Op) as OpName[];
export const opName = (n: number): OpName => OP_NAMES[n];

export const Outcome = { Allow: 0, Deny: 1, Approval: 2 } as const;
export const OUTCOME_NAMES = ["allow", "deny", "approval"] as const;
export const STATUS_NAMES = ["none", "open", "queued", "executed", "defeated", "cancelled"] as const;
export const Kind = { Tighten: 0, Propose: 1, Vote: 2 } as const;

// ---------------------------------------------------------------- trust levels (v3)

export const MAX_LEVEL = 3;
export const LEVEL_NAMES = ["Restricted", "Limited", "Standard", "Extended"] as const;
export const levelLabel = (n: number) => `Level ${n} ${LEVEL_NAMES[n] ?? ""}`.trim();
export interface LevelLimits { perPaymentUsd: number; dailyUsd: number }
/** A level limit at or above this is "no limit": members vote it like any other value. */
export const NO_LIMIT_USD = 1e12;
export const isNoLimit = (usd: number) => usd >= NO_LIMIT_USD;
/** Mirrors Dharma.levelLimits' defaults (used until members change a level's limits by vote). */
export const DEFAULT_LEVEL_LIMITS: LevelLimits[] = [
  { perPaymentUsd: 0.1, dailyUsd: 1 },
  { perPaymentUsd: 0.5, dailyUsd: 5 },
  { perPaymentUsd: 2, dailyUsd: 20 },
  { perPaymentUsd: 5, dailyUsd: 50 },
];
/** Why a level changed (stored with the onchain LevelSet event). */
export type LevelReason = "vote" | "member" | "tripwire" | "drill" | "watchdog";

// ---------------------------------------------------------------- ids & money

/** "ops-agent" -> 0x6f70…00 (left-aligned bytes32). Ids are ≤ 32 ASCII chars. */
export const toBytes32 = (s: string): Hex => {
  if (new TextEncoder().encode(s).length > 32) throw new Error(`"${s}" is longer than 32 bytes`);
  return stringToHex(s, { size: 32 });
};
export const fromBytes32 = (h: Hex): string => hexToString(h, { size: 32 }).replace(/\0+$/, "");
export const ZERO32: Hex = `0x${"0".repeat(64)}`;

export const toMicro = (usd: number): bigint => BigInt(Math.round(usd * 1e6));
export const fromMicro = (m: bigint | number): number => Number(m) / 1e6;

// ---------------------------------------------------------------- change encoding

export type Change =
  | { op: "AddRule"; id: string; outcome: keyof typeof Outcome; agent?: string; scope?: string; target?: string; maxUsd?: number }
  | { op: "RemoveRule"; id: string }
  | { op: "SetPayee"; account: Address; category: string }
  | { op: "RemovePayee"; account: Address }
  | { op: "SetAgent"; id: string; capUsd: number }
  | { op: "RemoveAgent"; id: string }
  | { op: "AddDomain"; domain: string }
  | { op: "RemoveDomain"; domain: string }
  | { op: "SetThreshold"; usd: number }
  | { op: "Freeze" }
  | { op: "Unfreeze" }
  | { op: "AddMember"; member: Address }
  | { op: "RemoveMember"; member: Address }
  | { op: "SetTimelock"; seconds: number }
  | { op: "SetCoreTimelock"; seconds: number }
  | { op: "Upgrade"; implementation: Address }
  | { op: "SetLevel"; agent: string; level: number; reason: string }
  | { op: "SetLevelLimits"; level: number; perPaymentUsd: number; dailyUsd: number };

const RULE = [
  { type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }, { type: "string" }, { type: "string" }, { type: "uint256" },
] as const;

export function encodeChange(c: Change): { op: number; data: Hex } {
  const op = Op[c.op];
  switch (c.op) {
    case "AddRule":
      return {
        op,
        data: encodeAbiParameters(RULE, [
          toBytes32(c.id), Outcome[c.outcome], c.agent ? toBytes32(c.agent) : ZERO32,
          c.scope ?? "", c.target ?? "", toMicro(c.maxUsd ?? 0),
        ]),
      };
    case "RemoveRule":
      return { op, data: encodeAbiParameters([{ type: "bytes32" }], [toBytes32(c.id)]) };
    case "SetPayee":
      return { op, data: encodeAbiParameters([{ type: "address" }, { type: "string" }], [c.account, c.category]) };
    case "RemovePayee":
      return { op, data: encodeAbiParameters([{ type: "address" }], [c.account]) };
    case "SetAgent":
      return { op, data: encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [toBytes32(c.id), toMicro(c.capUsd)]) };
    case "RemoveAgent":
      return { op, data: encodeAbiParameters([{ type: "bytes32" }], [toBytes32(c.id)]) };
    case "AddDomain":
    case "RemoveDomain":
      return { op, data: encodeAbiParameters([{ type: "string" }], [c.domain]) };
    case "SetThreshold":
      return { op, data: encodeAbiParameters([{ type: "uint256" }], [toMicro(c.usd)]) };
    case "Freeze":
    case "Unfreeze":
      return { op, data: "0x" };
    case "AddMember":
    case "RemoveMember":
      return { op, data: encodeAbiParameters([{ type: "address" }], [c.member]) };
    case "SetTimelock":
    case "SetCoreTimelock":
      return { op, data: encodeAbiParameters([{ type: "uint64" }], [BigInt(Math.round(c.seconds))]) };
    case "Upgrade":
      return { op, data: encodeAbiParameters([{ type: "address" }], [c.implementation]) };
    case "SetLevel":
      return { op, data: encodeAbiParameters(LEVEL, [toBytes32(c.agent), c.level, c.reason]) };
    case "SetLevelLimits":
      return { op, data: encodeAbiParameters(LIMITS, [c.level, toMicro(c.perPaymentUsd), toMicro(c.dailyUsd)]) };
  }
}

const LEVEL = [{ type: "bytes32" }, { type: "uint8" }, { type: "string" }] as const;
const LIMITS = [{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }] as const;

export function decodeChange(op: number, data: Hex): Change {
  const name = opName(op);
  switch (name) {
    case "AddRule": {
      const [id, outcome, agent, scope, target, max] = decodeAbiParameters(RULE, data);
      return {
        op: name, id: fromBytes32(id), outcome: (["Allow", "Deny", "Approval"] as const)[outcome],
        agent: agent === ZERO32 ? undefined : fromBytes32(agent), scope, target, maxUsd: fromMicro(max),
      };
    }
    case "RemoveRule":
      return { op: name, id: fromBytes32(decodeAbiParameters([{ type: "bytes32" }], data)[0]) };
    case "SetPayee": {
      const [account, category] = decodeAbiParameters([{ type: "address" }, { type: "string" }], data);
      return { op: name, account, category };
    }
    case "RemovePayee":
      return { op: name, account: decodeAbiParameters([{ type: "address" }], data)[0] };
    case "SetAgent": {
      const [id, cap] = decodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], data);
      return { op: name, id: fromBytes32(id), capUsd: fromMicro(cap) };
    }
    case "RemoveAgent":
      return { op: name, id: fromBytes32(decodeAbiParameters([{ type: "bytes32" }], data)[0]) };
    case "AddDomain":
    case "RemoveDomain":
      return { op: name, domain: decodeAbiParameters([{ type: "string" }], data)[0] };
    case "SetThreshold":
      return { op: name, usd: fromMicro(decodeAbiParameters([{ type: "uint256" }], data)[0]) };
    case "Freeze":
    case "Unfreeze":
      return { op: name };
    case "AddMember":
    case "RemoveMember":
      return { op: name, member: decodeAbiParameters([{ type: "address" }], data)[0] };
    case "SetTimelock":
    case "SetCoreTimelock":
      return { op: name, seconds: Number(decodeAbiParameters([{ type: "uint64" }], data)[0]) };
    case "Upgrade":
      return { op: name, implementation: decodeAbiParameters([{ type: "address" }], data)[0] };
    case "SetLevel": {
      const [agent, level, reason] = decodeAbiParameters(LEVEL, data);
      return { op: name, agent: fromBytes32(agent), level, reason };
    }
    case "SetLevelLimits": {
      const [level, per, daily] = decodeAbiParameters(LIMITS, data);
      return { op: name, level, perPaymentUsd: fromMicro(per), dailyUsd: fromMicro(daily) };
    }
    default:
      throw new Error(`unknown op ${op}`);
  }
}

export interface Labels {
  member?: (a: string) => string | undefined;
  agent?: (id: string) => string | undefined;
  payee?: (a: string) => string | undefined;
}

const usd = (n: number) => (isNoLimit(n) ? "no limit" : `$${n > 0 && n < 0.01 ? String(n) : n.toFixed(2)}`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** What a rule covers, in words: "shell commands starting with `git push`", "payments to Acme". */
export function describeScope(scope: string, target: string, n: { agent?: (id: string) => string; payee?: (a: string) => string } = {}): string {
  const [kind, sub] = scope.split(":");
  const pattern = target.includes("*");
  switch (kind) {
    case "payment": {
      const cat = sub ? ` for ${sub}` : "";
      return target ? `payments${cat} to ${n.payee?.(target) ?? short(target)}` : `payments${cat}`;
    }
    case "http": {
      const verb = sub ? `${sub.toUpperCase()} requests` : "web requests";
      return target ? `${verb} to ${target}` : verb;
    }
    case "shell":
      return !target ? "every shell command" : pattern ? `shell commands matching \`${target}\`` : `shell commands starting with \`${target}\``;
    case "file": {
      const op = sub === "write" ? "file writes" : sub === "read" ? "file reads" : "file reads and writes";
      return !target ? op : pattern ? `${op} matching \`${target}\`` : `${op} in \`${target}\``;
    }
    case "message":
      return target ? `messages to ${n.agent?.(target) ?? target}` : "messages to other agents";
    case "key":
      return `using the ${sub} key with ${target || "any host"}`;
    case "mount":
      return `mounting ${target}`;
    case "unsandboxed":
      return "running outside the sandbox";
    default:
      return `${scope}${target ? ` → ${target}` : ""}`;
  }
}

/** Plain-English description, shown to humans before they sign and in the proposal list. */
export function describeChange(c: Change, l: Labels = {}): string {
  const m = (a: string) => l.member?.(a.toLowerCase()) ?? short(a);
  const ag = (id: string) => l.agent?.(id) ?? id;
  const p = (a: string) => l.payee?.(a.toLowerCase()) ?? short(a);
  switch (c.op) {
    case "AddRule": {
      if (!c.scope) return `Re-enable default rule ${c.id}`;
      const who = c.agent ? ag(c.agent) : "every agent";
      return `${c.outcome === "Allow" ? "Allow" : c.outcome === "Deny" ? "Block" : "Require approval for"} ${describeScope(c.scope, c.target ?? "", { agent: ag, payee: p })} for ${who}${c.outcome === "Allow" && c.maxUsd ? ` up to ${usd(c.maxUsd)}` : ""} (${c.id})`;
    }
    case "RemoveRule": return `Remove rule ${c.id}`;
    case "SetPayee": return `Allow payments to ${p(c.account)} (${c.category})`;
    case "RemovePayee": return `Stop payments to ${p(c.account)}`;
    case "SetAgent": return `Set ${ag(c.id)}'s daily allowance to ${usd(c.capUsd)}`;
    case "RemoveAgent": return `Remove agent ${ag(c.id)}`;
    case "AddDomain": return `Allow HTTP to ${c.domain}`;
    case "RemoveDomain": return `Block HTTP to ${c.domain}`;
    case "SetThreshold": return `Require two approvers from ${usd(c.usd)}`;
    case "Freeze": return "Freeze every agent";
    case "Unfreeze": return "Unfreeze agents";
    case "AddMember": return `Add member ${m(c.member)}`;
    case "RemoveMember": return `Remove member ${m(c.member)}`;
    case "SetTimelock": return `Set the wait for changes to ${waitText(c.seconds)}`;
    case "SetCoreTimelock": return `Set the wait for core changes to ${waitText(c.seconds)}`;
    case "Upgrade": return `Upgrade Dharma's code to ${short(c.implementation)}`;
    case "SetLevel": return `Set ${ag(c.agent)} to ${levelLabel(c.level)}`;
    case "SetLevelLimits": return isNoLimit(c.perPaymentUsd) && isNoLimit(c.dailyUsd)
      ? `Remove ${levelLabel(c.level)} payment limits (no limit)`
      : `Set ${levelLabel(c.level)} payment limits to ${usd(c.perPaymentUsd)} per payment, ${usd(c.dailyUsd)} per day`;
  }
}

/** 90 -> "90s", 3600 -> "1h", 86400 -> "24h", 0 -> "no wait". */
export function waitText(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "—";
  if (seconds <= 0) return "no wait";
  if (seconds % 86400 === 0 && seconds > 2 * 86400) return `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0 && seconds >= 120) return `${seconds / 60} min`;
  return `${seconds}s`;
}

/** Mirrors Dharma.isCoreChange: needs every member, waits the core wait, never skipped, cancelled by a freeze. */
export function isCoreChange(c: Change, coreRuleIds: string[]): boolean {
  if (c.op === "SetCoreTimelock" || c.op === "Upgrade") return true;
  return c.op === "RemoveRule" && coreRuleIds.includes(c.id);
}

// ---------------------------------------------------------------- typed data (EIP-712)

/** What members sign for any policy action. Matches Dharma.ACTION_TYPEHASH. */
export function actionTypedData(dharma: Address, chainId: number, a: {
  kind: number; op: number; data: Hex; proposalId: bigint; support: boolean; nonce: bigint; deadline: bigint;
}) {
  return {
    domain: { name: "Dharma", version: "1", chainId, verifyingContract: dharma },
    types: {
      Action: [
        { name: "kind", type: "uint8" }, { name: "op", type: "uint8" }, { name: "data", type: "bytes" },
        { name: "proposalId", type: "uint256" }, { name: "support", type: "bool" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Action" as const,
    message: a,
  };
}

/** What members sign to approve or deny one specific payment. Verified by the Gatekeeper
 *  against the onchain member list; never relayed (no gas). */
export function paymentDecisionTypedData(dharma: Address, chainId: number, d: {
  proposalId: string; payloadHash: Hex; approve: boolean; deadline: bigint;
}) {
  return {
    domain: { name: "Karuna Gatekeeper", version: "1", chainId, verifyingContract: dharma },
    types: {
      PaymentDecision: [
        { name: "proposalId", type: "string" }, { name: "payloadHash", type: "bytes32" },
        { name: "approve", type: "bool" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "PaymentDecision" as const,
    message: d,
  };
}

export const isAddr = (a: unknown): a is Address => typeof a === "string" && isAddress(a, { strict: false });

// ---------------------------------------------------------------- classification (mirror)

export interface PolicyShape {
  agents: { id: string; capUsd: number; level?: number }[];
  levelLimits?: LevelLimits[];
  thresholdUsd: number;
  rules: { id: string; outcome: "allow" | "deny" | "approval"; builtin: boolean }[];
}

/** Mirrors Dharma.isTightening so the console can choose "apply now" vs "propose". The contract
 *  re-checks; if this ever disagrees, the contract wins and the call reverts. */
export function isTightening(c: Change, p: PolicyShape): boolean {
  switch (c.op) {
    case "AddRule": {
      const known = p.rules.find((r) => r.id === c.id && r.builtin);
      return (known ? known.outcome : c.outcome.toLowerCase()) !== "allow";
    }
    case "RemoveRule":
      return p.rules.find((r) => r.id === c.id)?.outcome === "allow";
    case "SetAgent": {
      const a = p.agents.find((x) => x.id === c.id);
      return !!a && c.capUsd <= a.capUsd;
    }
    case "SetThreshold":
      return c.usd <= p.thresholdUsd;
    case "SetLevel": {
      const a = p.agents.find((x) => x.id === c.agent);
      return !!a && c.level < (a.level ?? 0);
    }
    case "SetLevelLimits": {
      const cur = (p.levelLimits ?? DEFAULT_LEVEL_LIMITS)[c.level];
      return !!cur && c.perPaymentUsd <= cur.perPaymentUsd && c.dailyUsd <= cur.dailyUsd;
    }
    case "RemovePayee":
    case "RemoveAgent":
    case "RemoveDomain":
    case "Freeze":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------- the agent's record (trust levels)

/** One agent's record, built from Dharma's events (the QuickNode Stream, backfilled from deploy). */
export interface AgentRecord {
  agent: string;
  level: number;
  completed: number; // running total, from the latest ActionsRecorded
  denied: number;
  approvalsRequested: number;
  drillsFailed: number;
  tripwires: number;
  /** Completed actions since the agent's last level change or last incident (failed Drill, Tripwire). */
  cleanStreak: number;
  levelChanges: { level: number; reason: string; block: number | null; txHash: string | null }[];
  lastBlock: number | null;
}

/** Clean completed actions needed to be proposed for each level (index = target level). */
export const LEVEL_UP_STREAK = [0, 10, 25, 50] as const;

export interface Eligibility {
  eligible: boolean;
  target: number | null; // the next level, or null at the top
  needed: number;
  have: number;
}

/** Whether an agent can be proposed for its next level. One level at a time; members still vote. */
export function levelUpEligibility(rec: Pick<AgentRecord, "cleanStreak"> | null | undefined, current: number): Eligibility {
  if (current >= MAX_LEVEL) return { eligible: false, target: null, needed: 0, have: rec?.cleanStreak ?? 0 };
  const target = current + 1;
  const needed = LEVEL_UP_STREAK[target];
  const have = rec?.cleanStreak ?? 0;
  return { eligible: !!rec && have >= needed, target, needed, have };
}
