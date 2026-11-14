// The egress proxy: a sandboxed agent's ONLY way out.
//
// Each `karuna run` gets its own listener on 127.0.0.1 (a random port), so the proxy knows which
// box a request came from without trusting anything the box says. The box reaches it through a
// relay container that forwards one port and nothing else; the box itself has no route anywhere.
//
// For every request: the Gatekeeper decides (traps, swarm, freeze, Dharma rules, signed log, key
// bindings). Allowed requests are forwarded with any key placeholder swapped for the real value.
// Approval-needed requests are held until a member decides (or a timeout), then forwarded once.
// An x402 seller's 402 becomes a normal Karuna payment proposal: the Gatekeeper pays, the box
// gets the paid response. `http://karuna.internal` is the agent API (inbox, karuna.pay()).
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";
import type { AddressInfo } from "node:net";
import type { SandboxCA } from "./ca.ts";
import type { Gatekeeper } from "./gatekeeper.ts";
import { SecretStore } from "./secrets.ts";

const MAX_BODY = 20 * 1024 * 1024;
const INTERNAL_HOST = "karuna.internal";
const HOP = new Set(["connection", "proxy-connection", "proxy-authorization", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "host"]);

interface Target {
  protocol: "http:" | "https:";
  host: string; // hostname
  port: number;
}

export class EgressProxy {
  private servers = new Map<string, Server>();

  constructor(
    private readonly gk: Gatekeeper,
    private readonly ca: SandboxCA,
    private readonly opts: { agentApiPort: number; holdMs?: number },
  ) {
    gk.on("session-end", (token: string) => this.close(token));
  }

  /** Open this run's listener. Returns the port the runner's relay should forward to. */
  async open(token: string): Promise<number> {
    const existing = this.servers.get(token);
    if (existing) return (existing.address() as AddressInfo).port;
    const inner = createServer((req, res) => {
      const t = (req.socket as TLSSocket & { karunaTarget?: Target }).karunaTarget;
      if (!t) return void res.writeHead(400).end();
      const port = t.port === 443 ? "" : `:${t.port}`;
      void this.handle(token, req, res, `https://${t.host}${port}${req.url ?? "/"}`);
    });
    const server = createServer((req, res) => {
      // Plain-HTTP proxying: the request line carries the absolute URL.
      const url = req.url ?? "";
      if (!/^http:\/\//i.test(url)) return void res.writeHead(400, { "content-type": "text/plain" }).end("Karuna egress proxy: absolute http:// URL expected");
      void this.handle(token, req, res, url);
    });
    server.on("connect", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const [host, portStr] = splitHostPort(req.url ?? "");
      if (!host) return void socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      if (!this.gk.session(token)) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.unshift(head);
      // Terminate TLS here with a certificate from the org's sandbox CA (the only CA the box trusts).
      const tls = new TLSSocket(socket, { isServer: true, secureContext: this.ca.contextFor(host), ALPNProtocols: ["http/1.1"] }) as TLSSocket & { karunaTarget?: Target };
      tls.karunaTarget = { protocol: "https:", host, port: Number(portStr) || 443 };
      tls.on("error", () => socket.destroy());
      inner.emit("connection", tls);
    });
    server.on("clientError", (_e, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.servers.set(token, server);
    return (server.address() as AddressInfo).port;
  }

  close(token: string) {
    const s = this.servers.get(token);
    if (!s) return;
    this.servers.delete(token);
    s.close();
    s.closeAllConnections?.();
  }

  private async handle(token: string, req: IncomingMessage, res: ServerResponse, url: string) {
    try {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return send(res, 400, { error: "Bad URL" });
      }
      const body = await readBody(req);
      if (body === null) return send(res, 413, { error: "Request body too large for the sandbox" });
      const method = (req.method ?? "GET").toUpperCase();
      const headers = cleanHeaders(req.headers);

      if (u.hostname === INTERNAL_HOST) return this.toAgentApi(token, method, u, headers, body, res);

      const v = this.gk.egress(token, { method, url: u.toString(), headers, body });
      if (v.verdict === "deny") return send(res, 403, { error: "Blocked by Karuna", ...(v.proposalId ? { id: v.proposalId } : {}) });
      if (v.verdict === "pending") {
        const outcome = await this.gk.waitForDecision(v.proposalId, this.opts.holdMs ?? 120_000);
        if (outcome === "pending") return send(res, 403, { error: "Waiting for a person to approve this in Karuna", status: "pending", id: v.proposalId });
        if (outcome !== "allowed" || !this.gk.takeGrant(v.proposalId)) return send(res, 403, { error: "Blocked by Karuna", id: v.proposalId });
      }
      await this.forward(token, method, u, headers, body, res);
    } catch (e) {
      if (!res.headersSent) send(res, 502, { error: `Karuna egress: ${e instanceof Error ? e.message : String(e)}` });
      else res.destroy();
    }
  }

  /** Swap placeholders for real keys, send it on, stream the answer back (x402 → Karuna pays). */
  private async forward(token: string, method: string, u: URL, headers: Record<string, string>, body: Buffer, res: ServerResponse) {
    const reveal = (text: string) =>
      SecretStore.placeholdersIn(text).reduce((t, name) => {
        const real = this.gk.revealKey(name);
        if (real === null) throw new Error(`key ${name} is missing`);
        return t.split(`karuna_key_${name}`).join(real);
      }, text);
    const outUrl = new URL(reveal(u.toString()));
    const outHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) outHeaders[k] = reveal(v);
    outHeaders.host = outUrl.host;
    if (body.length || !["GET", "HEAD"].includes(method)) outHeaders["content-length"] = String(body.length);

    const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
      const fn = outUrl.protocol === "https:" ? httpsRequest : httpRequest;
      const r = fn(outUrl, { method, headers: outHeaders, timeout: 300_000 }, resolve);
      r.on("timeout", () => r.destroy(new Error("upstream timed out")));
      r.on("error", reject);
      r.end(body.length ? body : undefined);
    });

    if (upstream.statusCode === 402 && ["GET", "POST"].includes(method)) {
      upstream.resume();
      const paid = await this.gk.payForBox(token, { url: u.toString(), method, body: body.length ? body.toString("utf8") : undefined });
      if (paid.status === "done") {
        const result = paid.result;
        if (typeof result === "string") return void res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-karuna-paid": paid.id }).end(result);
        return void res.writeHead(200, { "content-type": "application/json", "x-karuna-paid": paid.id }).end(JSON.stringify(result ?? null));
      }
      if (paid.status === "pending") return send(res, 402, { error: "Payment is waiting for a person to approve it in Karuna", status: "pending", id: paid.id });
      return send(res, 402, { error: "Payment blocked by Karuna", id: paid.id });
    }

    const outRes: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(upstream.headers)) if (v !== undefined && !["connection", "keep-alive", "transfer-encoding"].includes(k)) outRes[k] = v;
    res.writeHead(upstream.statusCode ?? 502, outRes);
    upstream.pipe(res);
  }

  /** `http://karuna.internal/…` is the agent API, called as this run (inbox, proposals, pay). */
  private async toAgentApi(token: string, method: string, u: URL, headers: Record<string, string>, body: Buffer, res: ServerResponse) {
    const r = await new Promise<IncomingMessage>((resolve, reject) => {
      const q = httpRequest(
        { host: "127.0.0.1", port: this.opts.agentApiPort, path: `${u.pathname}${u.search}`, method, headers: { "content-type": headers["content-type"] ?? "application/json", authorization: `Bearer ${token}`, "content-length": String(body.length) } },
        resolve,
      );
      q.on("error", reject);
      q.end(body.length ? body : undefined);
    });
    res.writeHead(r.statusCode ?? 502, { "content-type": r.headers["content-type"] ?? "application/json" });
    r.pipe(res);
  }
}

function splitHostPort(s: string): [string, string] {
  const m = s.match(/^\[([^\]]+)\]:(\d+)$/) ?? s.match(/^([^:]+):(\d+)$/);
  return m ? [m[1].toLowerCase(), m[2]] : [s.toLowerCase(), "443"];
}

function cleanHeaders(h: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || HOP.has(k.toLowerCase())) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "application/json", "x-karuna": "egress" });
  res.end(JSON.stringify(body));
}
