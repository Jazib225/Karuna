// The relay (Phase 4): chain events → every member's screen, in real time.
//
//   QuickNode Stream ──(signed webhook, public port)──▶ relay ──(WebSocket, localhost)──▶ consoles
//   Arc RPC (fallback when QuickNode is quiet) ────────▶   │
//                                                         └──▶ Gatekeeper: "policy changed, re-read"
//
// Two listeners on purpose: the PUBLIC webhook port does exactly one thing (accept verified
// QuickNode deliveries); everything else listens on 127.0.0.1 only.
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import { DHARMA_ABI } from "@prekaruna/dharma";
import type { Address, PublicClient } from "viem";
import {
  TRANSFER_TOPIC, USDC_EMITTERS, decodeDharmaLogs, decodeWalletTransfers, extractLogs, verifyQuickNodeSignature,
  type DharmaEvent, type RawLog, type WalletTransfer,
} from "./events.ts";
import { RecordBook } from "./records.ts";
import type { AgentRecord } from "@prekaruna/dharma";

export interface RelayOptions {
  securityToken?: string; // QuickNode Stream security token (HMAC key)
  client?: PublicClient; // Arc RPC, for the fallback
  dharma: () => string | null; // the org's Dharma address (only its events are relayed)
  notifyGatekeeper?: (events: DharmaEvent[]) => Promise<void>;
  /** The org's wallet: the watchdog Stream reports USDC leaving it. */
  wallet?: () => string | null;
  notifyTransfers?: (transfers: WalletTransfer[]) => Promise<void>;
  /** Agents' records, rebuilt from Dharma's events (trust levels). */
  records?: RecordBook;
  notifyRecords?: (records: Record<string, AgentRecord>, source: string) => Promise<void>;
  lagBlocks?: number; // with a Stream, the safety net trails the chain by this many blocks
  pollMs?: number;
}

/** Error text without URLs (RPC URLs can embed access tokens). */
export const scrub = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].replace(/https?:\/\/[^\s'"]+/g, "<url>");

export class Relay extends EventEmitter {
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private nonces = new Set<string>();
  private nonceOrder: string[] = [];
  readonly recent: DharmaEvent[] = [];
  stats = { deliveries: 0, rejected: 0, quickNodeEvents: 0, rpcEvents: 0, quickNodeTransfers: 0, rpcTransfers: 0, lastQuickNodeAt: 0, lastRpcPollAt: 0, lastError: "" };
  readonly transfers: WalletTransfer[] = [];
  private seenTransfers = new Set<string>();
  private recordsTimer: NodeJS.Timeout | null = null;
  private lastBlock: bigint | null = null;
  private timer: NodeJS.Timeout | null = null;
  private notifyTimer: NodeJS.Timeout | null = null;
  private pendingNotify: DharmaEvent[] = [];

  constructor(private readonly opts: RelayOptions) {
    super();
  }

  /** The RPC safety net caught an event the Stream never delivered, and the Stream hasn't delivered since. */
  private streamMissed = false;

  /**
   * Where events come from. With a Stream configured it's QuickNode, unless the RPC safety net
   * caught an event QuickNode never delivered: then it's Arc RPC until the Stream delivers again.
   * (Dharma events are rare, so "no delivery lately" alone says nothing about health.)
   */
  mode(): "quicknode" | "rpc" | "none" {
    if (this.opts.securityToken && !this.streamMissed) return "quicknode";
    return this.opts.client ? "rpc" : "none";
  }

  /** De-duplicate (QuickNode and RPC may both see an event), keep, broadcast, nudge the Gatekeeper. */
  ingest(events: DharmaEvent[]) {
    if (events.some((e) => e.source === "quicknode")) this.streamMissed = false; // the Stream delivers, even a repeat
    const fresh = events.filter((e) => !this.seen.has(e.id));
    for (const e of fresh) {
      this.seen.add(e.id);
      this.seenOrder.push(e.id);
      if (this.seenOrder.length > 5000) this.seen.delete(this.seenOrder.shift()!);
      this.recent.unshift(e);
      if (e.source === "quicknode") {
        this.stats.quickNodeEvents++;
      } else {
        this.stats.rpcEvents++;
        if (this.opts.securityToken) this.streamMissed = true; // QuickNode missed this one
      }
    }
    this.recent.splice(100);
    if (this.opts.records?.add(events)) this.recordsChanged();
    if (!fresh.length) return fresh;
    this.emit("events", fresh);
    if (this.opts.notifyGatekeeper) {
      this.pendingNotify.push(...fresh);
      if (this.notifyTimer) clearTimeout(this.notifyTimer);
      this.notifyTimer = setTimeout(() => {
        const batch = this.pendingNotify.splice(0);
        void this.opts.notifyGatekeeper!(batch).catch((e) => (this.stats.lastError = `gatekeeper: ${scrub(e)}`));
      }, 200);
    }
    return fresh;
  }

  /** Push the rebuilt records to the Gatekeeper (debounced: a backfill delivers many at once). */
  recordsChanged(delayMs = 500) {
    const book = this.opts.records;
    if (!book || !this.opts.notifyRecords) return;
    if (this.recordsTimer) clearTimeout(this.recordsTimer);
    this.recordsTimer = setTimeout(() => {
      this.emit("records", book.records());
      void this.opts.notifyRecords!(book.records(), book.source()).catch((e) => (this.stats.lastError = `gatekeeper: ${scrub(e)}`));
    }, delayMs);
  }

  /** USDC that left the org's wallet: each transfer once, to the consoles and the Gatekeeper. */
  ingestTransfers(transfers: WalletTransfer[]) {
    const fresh = transfers.filter((t) => !this.seenTransfers.has(t.id));
    for (const t of fresh) {
      this.seenTransfers.add(t.id);
      this.transfers.unshift(t);
      if (t.source === "quicknode") this.stats.quickNodeTransfers++;
      else this.stats.rpcTransfers++;
    }
    this.transfers.splice(100);
    if (!fresh.length) return fresh;
    this.emit("transfers", fresh);
    if (this.opts.notifyTransfers) void this.opts.notifyTransfers(fresh).catch((e) => (this.stats.lastError = `gatekeeper: ${scrub(e)}`));
    return fresh;
  }

  private allowed(): Set<string> {
    const d = this.opts.dharma();
    return new Set(d ? [d.toLowerCase()] : []); // unknown org → relay nothing (never another org's events)
  }

  // ------------------------------------------------ QuickNode webhook

  /** Handle one webhook delivery. Returns the HTTP status to answer with. */
  handleDelivery(headers: IncomingMessage["headers"], rawBody: Buffer): { status: number; body: unknown } {
    if (!this.opts.securityToken) return { status: 503, body: { error: "QUICKNODE_SECURITY_TOKEN not configured" } };
    let payload: string;
    try {
      // Bounded: the body is unzipped before its signature can be checked, so a small zip bomb
      // can't exhaust memory.
      payload = (headers["content-encoding"] === "gzip" ? gunzipSync(rawBody, { maxOutputLength: 32 * 1024 * 1024 }) : rawBody).toString("utf8");
    } catch {
      this.stats.rejected++;
      return { status: 400, body: { error: "bad body" } };
    }
    const nonce = String(headers["x-qn-nonce"] ?? "");
    const ts = String(headers["x-qn-timestamp"] ?? "");
    const sig = String(headers["x-qn-signature"] ?? "");
    if (!verifyQuickNodeSignature(this.opts.securityToken, nonce, ts, payload, sig)) {
      this.stats.rejected++;
      return { status: 401, body: { error: "bad signature" } };
    }
    if (this.nonces.has(nonce)) {
      this.stats.rejected++;
      return { status: 409, body: { error: "replayed delivery" } };
    }
    this.nonces.add(nonce);
    this.nonceOrder.push(nonce);
    if (this.nonceOrder.length > 5000) this.nonces.delete(this.nonceOrder.shift()!);

    this.stats.deliveries++;
    this.stats.lastQuickNodeAt = Date.now();
    this.streamMissed = false; // the Stream is reaching us again
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return { status: 200, body: { ok: true, events: 0 } }; // signed but not JSON: acknowledge, ignore
    }
    const logs = extractLogs(parsed);
    const events = this.ingest(decodeDharmaLogs(logs, this.allowed(), "quicknode"));
    const transfers = this.ingestTransfers(decodeWalletTransfers(logs, this.opts.wallet?.() ?? null, "quicknode"));
    return { status: 200, body: { ok: true, events: events.length, transfers: transfers.length } };
  }

  // ------------------------------------------------ direct RPC fallback

  start(pollMs = this.opts.pollMs ?? 3000) {
    this.timer = setInterval(() => void this.poll().catch((e) => (this.stats.lastError = `rpc: ${scrub(e)}`)), pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Safety net: read Dharma's logs straight from Arc. With a Stream
   * configured it trails the chain by `lagBlocks`, so QuickNode always gets the first chance and
   * the net only catches what the Stream missed. Without a Stream it is the live source.
   */
  async poll() {
    const client = this.opts.client;
    const dharma = this.opts.dharma();
    if (!client || !dharma) return;
    const head = await client.getBlockNumber();
    const latest = this.opts.securityToken ? head - BigInt(this.opts.lagBlocks ?? 40) : head;
    if (latest < 0n) return; // a chain younger than the lag: nothing to read yet
    // Start 20 blocks back, but never before block 0 (a brand-new chain has fewer than 20).
    if (this.lastBlock === null) this.lastBlock = latest >= 20n ? latest - 20n : -1n;
    if (latest <= this.lastBlock) return;
    // At most 2000 blocks a pass, from where the last pass ended: after an outage the net catches
    // up over a few polls instead of skipping the gap.
    const from = this.lastBlock + 1n;
    const to = latest - from >= 2000n ? from + 1999n : latest;
    const logs = await client.getLogs({ address: dharma as Address, fromBlock: from, toBlock: to });
    this.stats.lastRpcPollAt = Date.now();
    this.ingest(decodeDharmaLogs(logs.map(toRaw), this.allowed(), "rpc"));
    // The watchdog's safety net: USDC out of the wallet, from either emitter.
    const wallet = this.opts.wallet?.();
    if (wallet) {
      const from32 = `0x${"0".repeat(24)}${wallet.toLowerCase().slice(2)}` as `0x${string}`;
      const out = await client.request({
        method: "eth_getLogs",
        params: [{ address: Object.keys(USDC_EMITTERS) as `0x${string}`[], topics: [TRANSFER_TOPIC as `0x${string}`, from32], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
      } as never) as { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }[];
      this.ingestTransfers(decodeWalletTransfers(out, wallet, "rpc"));
    }
    this.lastBlock = to;
  }

  /**
   * Catch up on Dharma's history from `fromBlock` (e.g. the deploy block) straight from Arc, for
   * when the relay was down while the backfilled Stream delivered. Chunked for public RPC limits.
   */
  async backfill(fromBlock: bigint, chunk = 10_000n) {
    const client = this.opts.client;
    const dharma = this.opts.dharma();
    if (!client || !dharma) return 0;
    const head = await client.getBlockNumber();
    let n = 0;
    for (let b = fromBlock; b <= head; b += chunk) {
      const to = b + chunk - 1n > head ? head : b + chunk - 1n;
      const logs = await client.getLogs({ address: dharma as Address, fromBlock: b, toBlock: to });
      n += this.ingest(decodeDharmaLogs(logs.map(toRaw), this.allowed(), "rpc")).length;
    }
    return n;
  }
}

const toRaw = (l: { address: string; topics: readonly string[]; data: string; blockNumber: bigint | null; transactionHash: string | null; logIndex: number | null }): RawLog => ({
  address: l.address, topics: [...l.topics], data: l.data, blockNumber: l.blockNumber?.toString() ?? null, transactionHash: l.transactionHash, logIndex: l.logIndex ?? null,
});

// ---------------------------------------------------------------- HTTP / WebSocket

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/** Public: QuickNode deliveries only. */
export function webhookServer(relay: Relay): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "POST" || (path !== "/quicknode/webhook" && path !== "/")) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      const r = relay.handleDelivery(req.headers, Buffer.concat(chunks));
      res.writeHead(r.status, { "content-type": "application/json" }).end(json(r.body));
    });
  });
}

/** Private (127.0.0.1): consoles subscribe here. */
export function consoleServer(relay: Relay): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0].replace(/^\/relay/, "");
    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(json({ mode: relay.mode(), dharma: null, ...relay.stats }));
      return;
    }
    if (req.method === "GET" && path === "/events/recent") {
      res.writeHead(200, { "content-type": "application/json" }).end(json(relay.recent.slice(0, 50)));
      return;
    }
    if (req.method === "GET" && path === "/transfers/recent") {
      res.writeHead(200, { "content-type": "application/json" }).end(json(relay.transfers.slice(0, 50)));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "/").split("?")[0].replace(/^\/relay/, "");
    if (path !== "/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  const send = (ws: WebSocket, msg: unknown) => ws.readyState === ws.OPEN && ws.send(json(msg));
  wss.on("connection", (ws) => {
    send(ws, { type: "hello", mode: relay.mode(), recent: relay.recent.slice(0, 20) });
  });
  relay.on("events", (events: DharmaEvent[]) => {
    for (const ws of wss.clients) send(ws, { type: "events", mode: relay.mode(), events });
  });
  relay.on("transfers", (transfers: WalletTransfer[]) => {
    for (const ws of wss.clients) send(ws, { type: "transfers", transfers });
  });
  // Tell consoles when the source changes (QuickNode ↔ direct RPC).
  let lastMode = relay.mode();
  const t = setInterval(() => {
    const m = relay.mode();
    if (m !== lastMode) {
      lastMode = m;
      for (const ws of wss.clients) send(ws, { type: "mode", mode: m });
    }
  }, 2000);
  server.on("close", () => clearInterval(t));
  return server;
}

export { DHARMA_ABI };
