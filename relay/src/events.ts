// Turning raw chain logs (from a QuickNode Stream or from Arc directly) into Dharma events.
import { createHmac, timingSafeEqual } from "node:crypto";
import { decodeEventLog, toEventSelector, type Hex } from "viem";
import { DHARMA_ABI, fromBytes32, fromMicro } from "@prekaruna/dharma";

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber?: string | number | null;
  transactionHash?: string | null;
  logIndex?: string | number | null;
}

export interface DharmaEvent {
  id: string; // txHash:logIndex — stable across sources, used to de-duplicate
  event: string;
  args: Record<string, unknown>;
  contract: string;
  txHash: string | null;
  block: number | null;
  logIndex: number | null;
  source: "quicknode" | "rpc";
  receivedAt: string;
}

/** topic0 -> event name, for every event in the Dharma ABI. */
export const DHARMA_TOPICS: Record<string, string> = Object.fromEntries(
  DHARMA_ABI.filter((x) => x.type === "event").map((e) => [toEventSelector(e as never).toLowerCase(), (e as { name: string }).name]),
);

/**
 * QuickNode Streams verification: HMAC-SHA256(securityToken, nonce + timestamp + payload), hex.
 * `payload` is the decoded (uncompressed) body as a string.
 */
export function verifyQuickNodeSignature(securityToken: string, nonce: string, timestamp: string, payload: string, signature: string): boolean {
  if (!securityToken || !nonce || !timestamp || !signature) return false;
  const expected = createHmac("sha256", Buffer.from(securityToken)).update(nonce + timestamp + payload).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim().toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Find every log-shaped object in any payload shape (plain array, {data: …}, batches, our filter's {dharmaLogs}). */
export function extractLogs(payload: unknown, out: RawLog[] = [], depth = 0): RawLog[] {
  if (depth > 8 || payload == null) return out;
  if (Array.isArray(payload)) {
    for (const x of payload) extractLogs(x, out, depth + 1);
    return out;
  }
  if (typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    if (Array.isArray(o.topics) && typeof o.address === "string") {
      out.push({
        address: o.address, topics: o.topics as string[], data: String(o.data ?? "0x"),
        blockNumber: o.blockNumber as string | number | null, transactionHash: o.transactionHash as string | null, logIndex: o.logIndex as string | number | null,
      });
      return out;
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") extractLogs(v, out, depth + 1);
  }
  return out;
}

const num = (v: unknown): number | null => (v == null ? null : typeof v === "number" ? v : Number(BigInt(String(v))));

/** Human-friendly args: bytes32 ids as text, micro-USD as USD, bigints as strings. */
function friendly(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const MONEY: Record<string, string> = {
    amountMicroUsd: "amountUsd", capMicroUsd: "capUsd", microUsd: "usd", maxMicroUsd: "maxUsd", perPaymentMicroUsd: "perPaymentUsd", dailyMicroUsd: "dailyUsd",
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (MONEY[k]) out[MONEY[k]] = fromMicro(v as bigint);
    else if ((k === "agent" || (k === "id" && name.startsWith("Rule"))) && typeof v === "string" && v.length === 66) out[k] = /^0x0+$/.test(v) ? null : fromBytes32(v as Hex);
    else if (typeof v === "bigint") out[k] = v.toString();
    else out[k] = v;
  }
  return out;
}

/** Decode Dharma logs; logs from other contracts or unknown events are dropped. */
export function decodeDharmaLogs(logs: RawLog[], allowed: Set<string> | null, source: DharmaEvent["source"]): DharmaEvent[] {
  const events: DharmaEvent[] = [];
  for (const l of logs) {
    const addr = l.address.toLowerCase();
    if (allowed && !allowed.has(addr)) continue;
    const name = DHARMA_TOPICS[String(l.topics[0] ?? "").toLowerCase()];
    if (!name) continue;
    try {
      const d = decodeEventLog({ abi: DHARMA_ABI, topics: l.topics as [Hex, ...Hex[]], data: l.data as Hex });
      events.push({
        id: `${l.transactionHash ?? "?"}:${num(l.logIndex) ?? "?"}`,
        event: d.eventName,
        args: friendly(d.eventName, (d.args ?? {}) as Record<string, unknown>),
        contract: addr,
        txHash: l.transactionHash ?? null,
        block: num(l.blockNumber),
        logIndex: num(l.logIndex),
        source,
        receivedAt: new Date().toISOString(),
      });
    } catch {
      /* malformed log: ignore */
    }
  }
  return events;
}

/**
 * The QuickNode Streams filter: runs on QuickNode's side and forwards only Dharma events, from
 * any Dharma contract (the relay then keeps only this org's). Tolerates every payload shape.
 */
export function quickNodeFilterSource(): string {
  return `function main(stream) {
  var TOPICS = ${JSON.stringify(Object.fromEntries(Object.keys(DHARMA_TOPICS).map((t) => [t, 1])))};
  var input = stream;
  if (typeof input === "string") { try { input = JSON.parse(input); } catch (e) { return null; } }
  if (input && input.data !== undefined) input = input.data;
  var out = [];
  function visit(x, depth) {
    if (!x || depth > 8) return;
    if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) visit(x[i], depth + 1); return; }
    if (typeof x === "object") {
      if (Array.isArray(x.topics) && x.topics.length && TOPICS[String(x.topics[0]).toLowerCase()]) {
        out.push({ address: x.address, topics: x.topics, data: x.data, blockNumber: x.blockNumber, transactionHash: x.transactionHash, logIndex: x.logIndex });
        return;
      }
      for (var k in x) { if (x[k] && typeof x[k] === "object") visit(x[k], depth + 1); }
    }
  }
  visit(input, 0);
  return out.length ? { dharmaLogs: out } : null;
}
`;
}

// ---------------------------------------------------------------- the wallet watchdog

/** Where USDC Transfer events come from on Arc: the ERC-20 interface (6 decimals) and the native
 *  USDC system address (18 decimals). A Stream filter keeps both; one transfer is matched once. */
export const USDC_EMITTERS: Record<string, number> = {
  "0x3600000000000000000000000000000000000000": 6,
  "0xfffffffffffffffffffffffffffffffffffffffe": 18,
};
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const padAddress = (a: string) => `0x${"0".repeat(24)}${a.toLowerCase().replace(/^0x/, "")}`;

export interface WalletTransfer {
  id: string; // txHash:to:microUsd, the same across emitters and sources
  txHash: string;
  to: string;
  amountUsd: number;
  block: number | null;
  source: "quicknode" | "rpc";
}

/** USDC leaving `wallet`, from any log shape. Everything else is dropped. */
export function decodeWalletTransfers(logs: RawLog[], wallet: string | null, source: WalletTransfer["source"]): WalletTransfer[] {
  if (!wallet) return [];
  const from = padAddress(wallet);
  const out = new Map<string, WalletTransfer>();
  for (const l of logs) {
    const decimals = USDC_EMITTERS[l.address.toLowerCase()];
    if (decimals === undefined || String(l.topics[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) continue;
    if (String(l.topics[1] ?? "").toLowerCase() !== from || !l.topics[2] || !l.transactionHash) continue;
    try {
      const to = `0x${String(l.topics[2]).slice(-40)}`.toLowerCase();
      const raw = BigInt(l.data && l.data !== "0x" ? l.data : 0);
      const micro = decimals >= 6 ? raw / 10n ** BigInt(decimals - 6) : raw * 10n ** BigInt(6 - decimals);
      const txHash = l.transactionHash.toLowerCase();
      const id = `${txHash}:${to}:${micro}`;
      out.set(id, { id, txHash, to, amountUsd: Number(micro) / 1e6, block: num(l.blockNumber), source });
    } catch {
      /* malformed: ignore */
    }
  }
  return [...out.values()];
}

/** The watchdog Stream's filter: only USDC transfers out of this org's wallet. */
export function quickNodeWatchdogFilterSource(wallet: string): string {
  return `function main(stream) {
  var EMITTERS = ${JSON.stringify(Object.fromEntries(Object.keys(USDC_EMITTERS).map((a) => [a, 1])))};
  var TRANSFER = "${TRANSFER_TOPIC}";
  var FROM = "${padAddress(wallet)}";
  var input = stream;
  if (typeof input === "string") { try { input = JSON.parse(input); } catch (e) { return null; } }
  if (input && input.data !== undefined) input = input.data;
  var out = [];
  function visit(x, depth) {
    if (!x || depth > 8) return;
    if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) visit(x[i], depth + 1); return; }
    if (typeof x === "object") {
      if (Array.isArray(x.topics) && typeof x.address === "string") {
        if (EMITTERS[x.address.toLowerCase()] && String(x.topics[0]).toLowerCase() === TRANSFER && String(x.topics[1]).toLowerCase() === FROM) {
          out.push({ address: x.address, topics: x.topics, data: x.data, blockNumber: x.blockNumber, transactionHash: x.transactionHash, logIndex: x.logIndex });
        }
        return;
      }
      for (var k in x) { if (x[k] && typeof x[k] === "object") visit(x[k], depth + 1); }
    }
  }
  visit(input, 0);
  return out.length ? { walletTransfers: out } : null;
}
`;
}
