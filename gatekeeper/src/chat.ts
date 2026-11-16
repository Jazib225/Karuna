// Karuna as a connector for chat apps (claude.ai, Claude Desktop, ChatGPT): an MCP server at /mcp,
// with the OAuth sign-in those apps expect. Nothing to install and nothing to copy: the person adds
// `https://<karuna>/mcp`, the chat app opens Karuna's connect page, which shows a code, and a member
// approves it in the console (Agents → Computers & chats). The chat then acts as its own agent,
// under the team's rules, levels and approvals, like any agent.
//
// Served on its own port (KARUNA_PUBLIC_PORT), reached through a tunnel; the console API stays on
// 127.0.0.1. The access token a chat app receives is that connection's agent token, so
// Disconnect in the console (which rotates it) cuts the chat off at once.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { GatekeeperError, type AgentResponse, type Gatekeeper } from "./gatekeeper.ts";
import type { Store } from "./store.ts";

const CODE_TTL_MS = 10 * 60_000;
const AUTH_TTL_MS = 30 * 60_000;

interface OAuthClient { client_id: string; client_name: string; redirect_uris: string[]; created_at: number }
interface PendingAuth { id: string; deviceId: string; secret: string; clientId: string; redirectUri: string; challenge: string; state?: string; createdAt: number; done?: { redirect: string } }
interface AuthCode { code: string; token: string; clientId: string; redirectUri: string; challenge: string; createdAt: number }

const b64url = (b: Buffer) => b.toString("base64url");
const s256 = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new GatekeeperError("Body too large", 413);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The public address the chat app used (a tunnel keeps its own Host and says it's https). */
function baseUrl(req: IncomingMessage): string {
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() || "http";
  return `${proto}://${req.headers.host ?? "127.0.0.1"}`;
}

// ---------------------------------------------------------------- Karuna's own tools

const KARUNA_TOOLS: Tool[] = [
  {
    name: "pay",
    description: "Pay one of your team's payees in USDC on Arc. Your team's Karuna rules decide: it's paid, held for a member's approval, or refused.",
    inputSchema: {
      type: "object",
      properties: {
        payee: { type: "string", description: "The payee's name as your team saved it, or its 0x address" },
        amount_usd: { type: "number", description: "Amount in USD (USDC)" },
        reason: { type: "string", description: "Why, in a sentence (shown to the approvers as the agent's own words)" },
      },
      required: ["payee", "amount_usd"],
    },
    annotations: { title: "Pay a payee", destructiveHint: true },
  },
  {
    name: "buy_data",
    description: "Buy data from a paid (x402) web service. Karuna checks the price and the rules first.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The service URL" },
        method: { type: "string", description: "HTTP method, usually GET" },
        max_usd: { type: "number", description: "Most you're willing to pay" },
        reason: { type: "string" },
      },
      required: ["url"],
    },
    annotations: { title: "Buy data" },
  },
  {
    name: "balance",
    description: "What this connection may still spend today without asking, and its trust level.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Spending left today", readOnlyHint: true },
  },
  {
    name: "check_request",
    description: "The status of something waiting for your team's approval.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { title: "Check a request", readOnlyHint: true },
  },
];

function say(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/** Karuna's answers, in plain words. Never the reason for a denial (the agent never learns it). */
function answer(r: AgentResponse | null): string {
  if (!r) return "No such request.";
  switch (r.status) {
    case "done":
      return `Done.${r.result !== undefined ? `\n\n${typeof r.result === "string" ? r.result : JSON.stringify(r.result).slice(0, 4000)}` : ""}`;
    case "allowed":
      return "Allowed.";
    case "pending":
      return `Waiting for your team to approve this in Karuna (request ${r.id}). Use check_request to see when it's decided.`;
    case "failed":
      return "It was approved but couldn't be completed.";
    default:
      return "Karuna blocked this.";
  }
}

async function callKarunaTool(gk: Gatekeeper, agentId: string, name: string, args: Record<string, unknown>) {
  if (name === "pay") {
    const payee = String(args.payee ?? "").trim();
    const to = gk.resolvePayee(payee);
    if (!to) return say("That isn't one of your team's payees. Karuna only pays saved payees.", true);
    const amountUsd = Number(args.amount_usd);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return say("amount_usd must be a positive number.", true);
    return say(answer(await gk.propose(agentId, { type: "transfer", to, amountUsd }, typeof args.reason === "string" ? args.reason : undefined)));
  }
  if (name === "buy_data") {
    const url = String(args.url ?? "");
    if (!/^https?:\/\//.test(url)) return say("url must start with http:// or https://", true);
    const maxUsd = args.max_usd === undefined ? undefined : Number(args.max_usd);
    return say(answer(await gk.propose(agentId, { type: "x402", url, method: typeof args.method === "string" ? args.method : "GET", maxUsd }, typeof args.reason === "string" ? args.reason : undefined)));
  }
  if (name === "balance") return say(gk.balanceText(agentId));
  if (name === "check_request") return say(answer(gk.agentView(agentId, String(args.id ?? ""))));
  return null;
}

// ---------------------------------------------------------------- the server

export function publicApi(gk: Gatekeeper, store: Store): HttpServer {
  const clients = new Map<string, OAuthClient>(Object.entries(store.readJson<Record<string, OAuthClient>>("oauth-clients.json", () => ({}))));
  const saveClients = () => store.writeJson("oauth-clients.json", Object.fromEntries(clients));
  const pending = new Map<string, PendingAuth>();
  const codes = new Map<string, AuthCode>();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.createdAt > AUTH_TTL_MS) pending.delete(k);
    for (const [k, v] of codes) if (now - v.createdAt > CODE_TTL_MS) codes.delete(k);
  };

  return createServer(async (req, res) => {
    try {
      sweep();
      const url = new URL(req.url ?? "/", "http://x");
      const base = baseUrl(req);
      const method = req.method ?? "GET";
      const path = url.pathname.replace(/\/+$/, "") || "/";

      // ---- discovery (RFC 9728, RFC 8414)
      if (method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
        return send(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"], resource_name: "Karuna" });
      }
      if (method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration")) {
        return send(res, 200, {
          issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
          response_types_supported: ["code"], grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }

      // ---- client registration (RFC 7591): chat apps register themselves
      if (method === "POST" && path === "/register") {
        const body = JSON.parse((await readRaw(req)) || "{}") as { client_name?: string; redirect_uris?: string[] };
        const redirect_uris = (Array.isArray(body.redirect_uris) ? body.redirect_uris : []).filter((u) => /^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(String(u))).slice(0, 10);
        if (!redirect_uris.length) return send(res, 400, { error: "invalid_redirect_uri" });
        if (clients.size >= 200) return send(res, 429, { error: "too_many_clients" });
        const c: OAuthClient = { client_id: `kc_${randomUUID()}`, client_name: String(body.client_name ?? "Chat app").slice(0, 60), redirect_uris, created_at: Date.now() };
        clients.set(c.client_id, c);
        saveClients();
        return send(res, 201, { ...c, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] });
      }

      // ---- the connect page: shows a code; a member approves it in the console
      if (method === "GET" && path === "/authorize") {
        const q = url.searchParams;
        const client = clients.get(q.get("client_id") ?? "");
        const redirectUri = q.get("redirect_uri") ?? "";
        if (!client || !client.redirect_uris.includes(redirectUri)) return page(res, 400, "This connection link isn't valid", "<p>Start again from your chat app.</p>");
        if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
          return page(res, 400, "This chat app's request isn't supported", "<p>Karuna needs PKCE (S256).</p>");
        }
        const d = gk.requestDevice({ name: `${client.client_name} chat`, tool: "chat" });
        const p: PendingAuth = {
          id: randomUUID(), deviceId: d.deviceId, secret: d.secret, clientId: client.client_id, redirectUri,
          challenge: q.get("code_challenge")!, state: q.get("state") ?? undefined, createdAt: Date.now(),
        };
        pending.set(p.id, p);
        return page(res, 200, `Connect ${esc(client.client_name)} to Karuna`, `
          <p>Ask a member of your team to approve this connection in Karuna: <b>Agents → Computers &amp; chats</b>.</p>
          <p class="code">${esc(d.code)}</p>
          <p class="muted">Check the code matches. This page continues on its own once it's approved.</p>
          <p id="st" class="muted">Waiting for approval…</p>
          <script>
            const id = ${JSON.stringify(p.id)};
            async function tick() {
              try {
                const r = await fetch("/authorize/status?req=" + encodeURIComponent(id));
                const j = await r.json();
                if (j.redirect) { location.href = j.redirect; return; }
                if (j.status === "denied" || j.status === "expired") { document.getElementById("st").textContent = "This connection was " + j.status + "."; return; }
              } catch (e) {}
              setTimeout(tick, 2000);
            }
            tick();
          </script>`);
      }
      if (method === "GET" && path === "/authorize/status") {
        const p = pending.get(url.searchParams.get("req") ?? "");
        if (!p) return send(res, 404, { status: "expired" });
        if (p.done) return send(res, 200, { status: "approved", redirect: p.done.redirect });
        const r = gk.pollDevice({ deviceId: p.deviceId, secret: p.secret }) as { status: string; token?: string };
        const back = new URL(p.redirectUri);
        if (p.state) back.searchParams.set("state", p.state);
        if (r.status === "approved" && r.token) {
          const code = b64url(randomBytes(24));
          codes.set(code, { code, token: r.token, clientId: p.clientId, redirectUri: p.redirectUri, challenge: p.challenge, createdAt: Date.now() });
          back.searchParams.set("code", code);
          p.done = { redirect: back.toString() };
          return send(res, 200, { status: "approved", redirect: p.done.redirect });
        }
        if (r.status === "denied" || r.status === "expired") {
          back.searchParams.set("error", "access_denied");
          pending.delete(p.id);
          return send(res, 200, { status: r.status, redirect: back.toString() });
        }
        return send(res, 200, { status: "pending" });
      }

      // ---- token (authorization code + PKCE)
      if (method === "POST" && path === "/token") {
        const raw = await readRaw(req);
        const f = String(req.headers["content-type"] ?? "").includes("json") ? (JSON.parse(raw || "{}") as Record<string, string>) : Object.fromEntries(new URLSearchParams(raw));
        if (f.grant_type !== "authorization_code") return send(res, 400, { error: "unsupported_grant_type" });
        const c = codes.get(f.code ?? "");
        codes.delete(f.code ?? ""); // single use
        if (!c || c.clientId !== f.client_id || c.redirectUri !== f.redirect_uri || s256(f.code_verifier ?? "") !== c.challenge) {
          return send(res, 400, { error: "invalid_grant" });
        }
        return send(res, 200, { access_token: c.token, token_type: "Bearer", scope: "karuna" });
      }

      // ---- MCP
      if (path === "/mcp") {
        const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        const who = token ? gk.authAgent(token) : null;
        if (!who) {
          return send(res, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
        }
        if (gk.requireSandbox && !gk.isUnsandboxed(who.agentId)) {
          return send(res, 403, { error: "This connection's agent needs your team's vote to run outside a sandbox" });
        }
        gk.touchDevice(who.agentId);
        const server = mcpServer(gk, who.agentId);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => void transport.close().catch(() => undefined));
        await server.connect(transport);
        const raw = method === "POST" ? await readRaw(req) : "";
        await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
        return;
      }
      send(res, 404, { error: "Not found" });
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof GatekeeperError) return send(res, e.status, { error: e.message });
      if (e instanceof SyntaxError) return send(res, 400, { error: "invalid_request" });
      send(res, 500, { error: "Internal error" });
    }
  });
}

/** One MCP server per request (stateless): Karuna's tools plus the team's connectors' tools. */
function mcpServer(gk: Gatekeeper, agentId: string): Server {
  const server = new Server({ name: "karuna", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...KARUNA_TOOLS, ...(await gk.connectorTools())] }));
  server.setRequestHandler(CallToolRequestSchema, async (r) => {
    const name = r.params.name;
    const args = (r.params.arguments ?? {}) as Record<string, unknown>;
    const own = await callKarunaTool(gk, agentId, name, args);
    if (own) return own;
    const via = await gk.callConnectorTool(agentId, name, args);
    return via ?? say(`No tool named ${name}.`, true);
  });
  return server;
}

function page(res: ServerResponse, status: number, title: string, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Karuna</title>
<style>
  :root { color-scheme: light dark; --bg:#0a0a0a; --fg:#f5f5f5; --muted:#a3a3a3; --card:#141414; --line:rgba(255,255,255,.1) }
  @media (prefers-color-scheme: light) { :root { --bg:#fafafa; --fg:#0a0a0a; --muted:#525252; --card:#fff; --line:rgba(0,0,0,.1) } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; padding:16px }
  main { max-width:440px; width:100%; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:28px }
  h1 { font-size:20px; margin:0 0 12px } .muted { color:var(--muted); font-size:13.5px }
  .code { font:600 28px/1.2 ui-monospace, monospace; letter-spacing:.08em; margin:18px 0 }
</style></head><body><main><p class="muted">Karuna</p><h1>${title}</h1>${body}</main></body></html>`);
}
