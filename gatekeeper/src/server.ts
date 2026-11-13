// Two HTTP surfaces, deliberately separate:
//  - Agent API   (:8787)  propose + read own proposal status. Bearer agent token. Nothing else.
//  - Console API (:8788)  approvals, panic, config, log. Localhost only + console secret.
// An agent can never reach approve/freeze/config, so it can't approve its own request.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { ConfigError } from "./config.ts";
import { GatekeeperError, type AgentAction, type Gatekeeper } from "./gatekeeper.ts";
import type { WalletBackend } from "./wallet.ts";

const MAX_BODY = 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new GatekeeperError("Body too large", 413);
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new GatekeeperError("Body must be JSON");
  }
}

function fail(res: ServerResponse, e: unknown) {
  if (e instanceof GatekeeperError) return send(res, e.status, { error: e.message });
  if (e instanceof ConfigError) return send(res, 400, { error: e.message });
  console.error(e);
  send(res, 500, { error: "Internal error" });
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- agent API

export function agentApi(gk: Gatekeeper): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const agent = gk.authenticateAgent(token);
      if (!agent) return send(res, 401, { error: "Unknown agent token" });

      if (req.method === "POST" && url.pathname === "/v1/proposals") {
        const body = await readBody(req);
        const action = body.action as AgentAction | undefined;
        if (!action || typeof action !== "object") return send(res, 400, { error: "action is required" });
        return send(res, 200, await gk.propose(agent.id, action, body.reason as string | undefined));
      }
      const m = url.pathname.match(/^\/v1\/proposals\/([\w-]+)$/);
      if (req.method === "GET" && m) {
        const v = gk.agentView(agent.id, m[1]);
        return v ? send(res, 200, v) : send(res, 404, { error: "Not found" });
      }
      send(res, 404, { error: "Not found" });
    } catch (e) {
      fail(res, e);
    }
  });
}

// ---------------------------------------------------------------- console API

export function consoleApi(gk: Gatekeeper, wallet: WalletBackend, consoleToken: string): Server {
  let walletCache: { at: number; value: unknown } | null = null;

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname.replace(/^\/api/, "");
      const given = String(req.headers["x-karuna-console-token"] ?? url.searchParams.get("token") ?? "");
      if (!safeEq(given, consoleToken)) return send(res, 401, { error: "Console token required" });
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write("event: hello\ndata: {}\n\n");
        const onChange = () => res.write("event: change\ndata: {}\n\n");
        gk.on("change", onChange);
        const beat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
        req.on("close", () => {
          gk.off("change", onChange);
          clearInterval(beat);
        });
        return;
      }
      if (method === "GET" && path === "/state") return send(res, 200, gk.snapshot());
      if (method === "GET" && path === "/policy") return send(res, 200, gk.policy());
      if (method === "GET" && path === "/log") {
        const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 200) || 200);
        return send(res, 200, gk.logTail(limit));
      }
      if (method === "GET" && path === "/wallet") {
        const addr = gk.org.wallet?.address;
        if (!addr) return send(res, 200, null);
        if (!walletCache || Date.now() - walletCache.at > 10_000) {
          walletCache = { at: Date.now(), value: { address: addr, ...(await wallet.balances(addr)) } };
        }
        return send(res, 200, walletCache.value);
      }
      if (method === "GET" && path === "/wallets/detect") {
        try {
          return send(res, 200, { wallets: await wallet.listWallets() });
        } catch (e) {
          return send(res, 200, { wallets: [], error: e instanceof Error ? e.message : String(e) });
        }
      }

      const body = method === "GET" || method === "DELETE" ? {} : await readBody(req);
      const by = typeof body.memberId === "string" ? body.memberId : undefined;
      let m: RegExpMatchArray | null;

      if (method === "POST" && path === "/setup") return send(res, 200, { member: gk.setup(body as never) });
      if (method === "PATCH" && path === "/settings") return send(res, 200, (gk.updateSettings(body, by), { ok: true }));
      if (method === "POST" && path === "/members") return send(res, 200, gk.addMember(body.name, by));
      if (method === "DELETE" && (m = path.match(/^\/members\/([\w-]+)$/))) return send(res, 200, (gk.removeMember(m[1], url.searchParams.get("by") ?? undefined), { ok: true }));
      if (method === "POST" && path === "/agents") return send(res, 200, gk.addAgent(body as never, by));
      if (method === "PATCH" && (m = path.match(/^\/agents\/([\w-]+)$/))) return send(res, 200, gk.updateAgent(m[1], body, by));
      if (method === "POST" && (m = path.match(/^\/agents\/([\w-]+)\/rotate-token$/))) return send(res, 200, gk.rotateAgentToken(m[1], by));
      if (method === "DELETE" && (m = path.match(/^\/agents\/([\w-]+)$/))) return send(res, 200, (gk.removeAgent(m[1], url.searchParams.get("by") ?? undefined), { ok: true }));
      if (method === "POST" && path === "/recipients") return send(res, 200, gk.addRecipient(body as never, by));
      if (method === "DELETE" && (m = path.match(/^\/recipients\/(0x[0-9a-fA-F]{40})$/))) return send(res, 200, (gk.removeRecipient(m[1], url.searchParams.get("by") ?? undefined), { ok: true }));
      if (method === "POST" && path === "/domains") return send(res, 200, (gk.addDomain(body.domain, by), { ok: true }));
      if (method === "DELETE" && (m = path.match(/^\/domains\/([\w.-]+)$/))) return send(res, 200, (gk.removeDomain(m[1], url.searchParams.get("by") ?? undefined), { ok: true }));
      if (method === "POST" && (m = path.match(/^\/proposals\/([\w-]+)\/approve$/))) return send(res, 200, await gk.approve(m[1], body.memberId, body.payloadHash));
      if (method === "POST" && (m = path.match(/^\/proposals\/([\w-]+)\/deny$/))) return send(res, 200, (gk.deny(m[1], body.memberId), { ok: true }));
      if (method === "POST" && path === "/freeze") return send(res, 200, (gk.freeze(body.memberId), { ok: true }));
      if (method === "POST" && path === "/unfreeze-vote") return send(res, 200, (gk.voteUnfreeze(body.memberId), { ok: true }));

      send(res, 404, { error: "Not found" });
    } catch (e) {
      fail(res, e);
    }
  });
}
