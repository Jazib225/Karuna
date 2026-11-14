// Two HTTP surfaces, deliberately separate:
//  - Agent API   (:8787)  propose + read own proposal status. Bearer agent token. Nothing else.
//  - Console API (:8788)  localhost only + console secret. Policy changes and payment approvals
//                         must ALSO carry a member's signature (their browser key), so even
//                         console access can't approve, loosen, or vote without a member.
// An agent can never reach the console API, so it can't approve its own request.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { defaultRules } from "@prekaruna/engine";
import { ConfigError } from "./config.ts";
import { isTransient, scrub } from "./chain.ts";
import { GatekeeperError, type AgentAction, type Gatekeeper, type SignedAction, type SignedDecision } from "./gatekeeper.ts";
import type { WalletBackend } from "./wallet.ts";
import type { EgressProxy } from "./proxy.ts";
import type { SecretStore } from "./secrets.ts";

/** What the agent API needs to hand out sandbox runs. Absent = sandboxes not available. */
export interface SandboxDeps {
  proxy: EgressProxy;
  caPem: string;
  secrets: SecretStore;
}

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
  if (isTransient(e)) return send(res, 503, { error: "The Arc RPC is busy (rate limited). Try again in a moment — or set ARC_RPC_URL to your QuickNode endpoint." });
  console.error("gatekeeper error:", scrub(e));
  send(res, 500, { error: "Internal error" });
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- agent API

export function agentApi(gk: Gatekeeper, sandbox?: SandboxDeps): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const who = gk.authAgent(token);
      if (!who) return send(res, 401, { error: "Unknown agent token" });
      const agentId = who.agentId;

      // ---- sandbox runs (karuna run). Only an agent's own kag_ token can start one.
      if (req.method === "POST" && url.pathname === "/v1/sessions") {
        if (who.session) return send(res, 403, { error: "Start runs from outside the sandbox" });
        if (!sandbox) return send(res, 501, { error: "This Gatekeeper has no sandbox support" });
        const body = await readBody(req);
        const s = gk.startSession(agentId, { host: body.host, isolation: body.isolation, desktop: body.desktop, remote: body.remote });
        const proxyPort = await sandbox.proxy.open(s.token);
        return send(res, 200, {
          session: s.token, id: s.id, agentId, proxyPort, caPem: sandbox.caPem,
          env: sandbox.secrets.placeholderEnv(),
          writableMounts: (Array.isArray(body.mounts) ? body.mounts : []).filter((m: unknown) => typeof m === "string" && gk.mayMountWritable(agentId, m)),
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/sessions/heartbeat") {
        if (!who.session) return send(res, 400, { error: "Heartbeat with the run's session token" });
        const hb = await readBody(req);
        return send(res, 200, gk.heartbeat(token, { viewer: hb.viewer }));
      }
      if (req.method === "DELETE" && url.pathname === "/v1/sessions") {
        if (who.session) gk.endSession(token, "runner exited");
        return send(res, 200, { ok: true });
      }
      // Sandbox required: an agent's own token can only start runs, unless Dharma says otherwise.
      if (!who.session && gk.requireSandbox && !gk.isUnsandboxed(agentId)) {
        return send(res, 403, { error: "This agent must run in a Karuna sandbox (karuna run)" });
      }

      if (req.method === "POST" && url.pathname === "/v1/proposals") {
        const body = await readBody(req);
        const action = body.action as AgentAction | undefined;
        if (!action || typeof action !== "object") return send(res, 400, { error: "action is required" });
        return send(res, 200, await gk.propose(agentId, action, body.reason as string | undefined));
      }
      if (req.method === "GET" && url.pathname === "/v1/inbox") return send(res, 200, { messages: gk.agentInbox(agentId) });
      const r = url.pathname.match(/^\/v1\/inbox\/([\w-]+)\/report$/);
      if (req.method === "POST" && r) {
        const body = await readBody(req);
        return send(res, 200, gk.reportMessage(agentId, r[1], body.reason as string | undefined));
      }
      const m = url.pathname.match(/^\/v1\/proposals\/([\w-]+)$/);
      if (req.method === "GET" && m) {
        const v = gk.agentView(agentId, m[1]);
        return v ? send(res, 200, v) : send(res, 404, { error: "Not found" });
      }
      send(res, 404, { error: "Not found" });
    } catch (e) {
      fail(res, e);
    }
  });
}

// ---------------------------------------------------------------- console API

export function consoleApi(gk: Gatekeeper, wallet: WalletBackend, consoleToken: string, secrets?: SecretStore, caPem?: string): Server {
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
        // A named event (not a comment) so the console can see the stream is alive and reopen it if not.
        const beat = setInterval(() => res.write("event: ping\ndata: {}\n\n"), 15_000);
        req.on("close", () => {
          gk.off("change", onChange);
          clearInterval(beat);
        });
        return;
      }
      if (method === "GET" && path === "/state") return send(res, 200, gk.snapshot());
      if (method === "GET" && path === "/sandbox/ca") {
        // Public certificate (not a secret): remote machines pin it to trust only this Gatekeeper.
        res.writeHead(200, { "content-type": "application/x-pem-file", "content-disposition": "attachment; filename=karuna-ca.pem" });
        return void res.end(caPem ?? "");
      }
      if (method === "GET" && path === "/policy") return send(res, 200, defaultRules.map((r) => ({ id: r.id, description: r.description, outcome: r.outcome })));
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
      let m: RegExpMatchArray | null;

      if (method === "GET" && (m = path.match(/^\/dharma\/nonce\/(0x[0-9a-fA-F]{40})$/))) return send(res, 200, { nonce: String(await gk.nonceOf(m[1])) });
      if (method === "POST" && path === "/chain-event") {
        // The relay saw a Dharma event (QuickNode Stream or direct RPC): re-read policy now.
        gk.lastChainEventAt = Date.now();
        await gk.sync(true).catch(() => undefined);
        return send(res, 200, { ok: true });
      }
      if (method === "POST" && path === "/inbox") return send(res, 200, gk.postMessage(body as never));
      if (method === "POST" && path === "/traps") return send(res, 200, gk.mintTrapSet(body.agentId));
      if (method === "POST" && (m = path.match(/^\/traps\/([\w-]+)\/plant$/))) return send(res, 200, gk.plantTrapInInbox(m[1], body.agentId));
      if (method === "POST" && path === "/shield/test") return send(res, 200, gk.runTest(body as never));
      if (method === "POST" && path === "/setup") return send(res, 200, await gk.setup(body as never));
      if (method === "PATCH" && path === "/settings") return send(res, 200, (gk.renameOrg(body.orgName), { ok: true }));
      if (method === "POST" && path === "/dharma/action") return send(res, 200, await gk.submitAction(body as unknown as SignedAction));
      if (method === "POST" && path === "/agents/prepare") return send(res, 200, gk.prepareAgent(body.name));
      if (method === "POST" && (m = path.match(/^\/agents\/([\w-]+)\/rotate-token$/))) return send(res, 200, gk.rotateAgentToken(m[1]));
      if (method === "POST" && path === "/keys") {
        if (!secrets) return send(res, 501, { error: "No key store" });
        try {
          const k = secrets.put(String(body.name ?? "").trim().toLowerCase(), String(body.envVar ?? "").trim(), String(body.value ?? ""));
          gk.noteKeyStored(k.name, k.envVar);
          return send(res, 200, k);
        } catch (e) {
          return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (method === "DELETE" && (m = path.match(/^\/keys\/([a-z0-9-]+)$/))) {
        if (!secrets) return send(res, 501, { error: "No key store" });
        secrets.remove(m[1]);
        gk.noteKeyRemoved(m[1]);
        return send(res, 200, { ok: true });
      }
      if (method === "POST" && (m = path.match(/^\/sandbox\/([\w-]+)\/stop$/))) return send(res, 200, (gk.stopSession(m[1]), { ok: true }));
      if (method === "POST" && path === "/pause") return send(res, 200, { paused: gk.pause(String(body.by ?? "console")) });
      if (method === "POST" && path === "/resume") return send(res, 200, { paused: gk.resume(String(body.by ?? "console")) });
      if (method === "POST" && path === "/access-request") return send(res, 200, (gk.requestAccess(body.address, body.name), { ok: true }));
      if (method === "POST" && (m = path.match(/^\/proposals\/([\w-]+)\/decide$/))) return send(res, 200, await gk.decide(m[1], body as unknown as SignedDecision));

      send(res, 404, { error: "Not found" });
    } catch (e) {
      fail(res, e);
    }
  });
}
