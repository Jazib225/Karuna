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
import { decodeDharmaLogs, extractLogs, verifyQuickNodeSignature, type DharmaEvent, type RawLog } from "./events.ts";

export interface RelayOptions {
  securityToken?: string; // QuickNode Stream security token (HMAC key)
  client?: PublicClient; // Arc RPC, for the fallback
  dharma: () => string | null; // the org's Dharma address (only its events are relayed)
  notifyGatekeeper?: (events: DharmaEvent[]) => Promise<void>;
  quietMs?: number; // fall back to RPC after this long without a QuickNode delivery
  pollMs?: number;
}

export class Relay extends EventEmitter {
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private nonces = new Set<string>();
  private nonceOrder: string[] = [];
  readonly recent: DharmaEvent[] = [];
  stats = { deliveries: 0, rejected: 0, quickNodeEvents: 0, rpcEvents: 0, lastQuickNodeAt: 0, lastRpcPollAt: 0, lastError: "" };
  private lastBlock: bigint | null = null;
  private timer: NodeJS.Timeout | null = null;
  private notifyTimer: NodeJS.Timeout | null = null;
  private pendingNotify: DharmaEvent[] = [];

  constructor(private readonly opts: RelayOptions) {
    super();
  }

  /** Where events currently come from. */
  mode(): "quicknode" | "rpc" | "none" {
    if (this.opts.securityToken && Date.now() - this.stats.lastQuickNodeAt < (this.opts.quietMs ?? 45_000)) return "quicknode";
    return this.opts.client ? "rpc" : "none";
  }

  /** De-duplicate (QuickNode and RPC may both see an event), keep, broadcast, nudge the Gatekeeper. */
  ingest(events: DharmaEvent[]) {
    const fresh = events.filter((e) => !this.seen.has(e.id));
    for (const e of fresh) {
      this.seen.add(e.id);
      this.seenOrder.push(e.id);
      if (this.seenOrder.length > 5000) this.seen.delete(this.seenOrder.shift()!);
      this.recent.unshift(e);
      if (e.source === "quicknode") this.stats.quickNodeEvents++;
      else this.stats.rpcEvents++;
    }
    this.recent.splice(100);
    if (!fresh.length) return fresh;
    this.emit("events", fresh);
    if (this.opts.notifyGatekeeper) {
      this.pendingNotify.push(...fresh);
      if (this.notifyTimer) clearTimeout(this.notifyTimer);
      this.notifyTimer = setTimeout(() => {
        const batch = this.pendingNotify.splice(0);
        void this.opts.notifyGatekeeper!(batch).catch((e) => (this.stats.lastError = `gatekeeper: ${e instanceof Error ? e.message : e}`));
      }, 200);
    }
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
      payload = (headers["content-encoding"] === "gzip" ? gunzipSync(rawBody) : rawBody).toString("utf8");
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return { status: 200, body: { ok: true, events: 0 } }; // signed but not JSON: acknowledge, ignore
    }
    const events = this.ingest(decodeDharmaLogs(extractLogs(parsed), this.allowed(), "quicknode"));
    return { status: 200, body: { ok: true, events: events.length } };
  }

  // ------------------------------------------------ direct RPC fallback

  start(pollMs = this.opts.pollMs ?? 3000) {
    this.timer = setInterval(() => void this.poll().catch((e) => (this.stats.lastError = `rpc: ${e instanceof Error ? e.message.split("\n")[0] : e}`)), pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Read new Dharma logs straight from Arc while QuickNode is quiet (ROADMAP backup plan). */
  async poll() {
    const client = this.opts.client;
    const dharma = this.opts.dharma();
    if (!client || !dharma || this.mode() === "quicknode") return;
    const latest = await client.getBlockNumber();
    if (this.lastBlock === null) this.lastBlock = latest - 20n;
    if (latest <= this.lastBlock) return;
    const from = latest - this.lastBlock > 2000n ? latest - 2000n : this.lastBlock + 1n;
    const logs = await client.getLogs({ address: dharma as Address, fromBlock: from, toBlock: latest });
    this.lastBlock = latest;
    this.stats.lastRpcPollAt = Date.now();
    const raw: RawLog[] = logs.map((l) => ({
      address: l.address, topics: l.topics as string[], data: l.data, blockNumber: l.blockNumber?.toString() ?? null,
      transactionHash: l.transactionHash, logIndex: l.logIndex ?? null,
    }));
    this.ingest(decodeDharmaLogs(raw, this.allowed(), "rpc"));
  }
}

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
