// Shared Dharma vocabulary for the Gatekeeper and the console.
// The browser builds and signs changes with these helpers; the Gatekeeper decodes and relays
// them; the contract re-checks everything. One definition, so they can't drift apart.
import {
  decodeAbiParameters, encodeAbiParameters, hexToString, isAddress, stringToHex, type Address, type Hex,
} from "viem";

export { DHARMA_ABI } from "./abi.ts";

export const ARC_TESTNET_CHAIN_ID = 5042002;

// Must match Dharma.Op / Outcome / Status / Kind order.
export const Op = {
  AddRule: 0, RemoveRule: 1, SetPayee: 2, RemovePayee: 3, SetAgent: 4, RemoveAgent: 5,
  AddDomain: 6, RemoveDomain: 7, SetThreshold: 8, Freeze: 9, Unfreeze: 10, AddMember: 11, RemoveMember: 12,
} as const;
export type OpName = keyof typeof Op;
export const OP_NAMES = Object.keys(Op) as OpName[];
export const opName = (n: number): OpName => OP_NAMES[n];

export const Outcome = { Allow: 0, Deny: 1, Approval: 2 } as const;
export const OUTCOME_NAMES = ["allow", "deny", "approval"] as const;
export const STATUS_NAMES = ["none", "open", "queued", "executed", "defeated"] as const;
export const Kind = { Tighten: 0, Propose: 1, Vote: 2 } as const;

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
  | { op: "RemoveMember"; member: Address };

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
  }
}

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
    default:
      throw new Error(`unknown op ${op}`);
  }
}

export interface Labels {
  member?: (a: string) => string | undefined;
  agent?: (id: string) => string | undefined;
  payee?: (a: string) => string | undefined;
}

const usd = (n: number) => `$${n > 0 && n < 0.01 ? String(n) : n.toFixed(2)}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Plain-English description, shown to humans before they sign and in the proposal list. */
export function describeChange(c: Change, l: Labels = {}): string {
  const m = (a: string) => l.member?.(a.toLowerCase()) ?? short(a);
  const ag = (id: string) => l.agent?.(id) ?? id;
  const p = (a: string) => l.payee?.(a.toLowerCase()) ?? short(a);
  switch (c.op) {
    case "AddRule": {
      if (!c.scope) return `Re-enable default rule ${c.id}`;
      const who = c.agent ? ag(c.agent) : "every agent";
      const what = `${c.scope}${c.target ? ` → ${c.target.startsWith("0x") ? p(c.target) : c.target}` : ""}`;
      return `${c.outcome === "Allow" ? "Allow" : c.outcome === "Deny" ? "Block" : "Require approval for"} ${what} for ${who}${c.outcome === "Allow" && c.maxUsd ? ` up to ${usd(c.maxUsd)}` : ""} (${c.id})`;
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
  }
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
  agents: { id: string; capUsd: number }[];
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
    case "RemovePayee":
    case "RemoveAgent":
    case "RemoveDomain":
    case "Freeze":
      return true;
    default:
      return false;
  }
}
