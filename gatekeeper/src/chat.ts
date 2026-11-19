// Karuna as a connector for chat apps (claude.ai, Claude Desktop, ChatGPT): an MCP server at /mcp,
// with the OAuth sign-in those apps expect. Nothing to install and nothing to copy: the person adds
// `https://<karuna>/mcp`, the chat app opens Karuna's connect page, which shows a code, and a member
// approves it in the console (Agents → New agent → Claude chat). The chat then acts as its own agent,
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
interface PendingAuth {
  id: string; deviceId: string; secret: string; clientId: string; redirectUri: string; challenge: string; state?: string; createdAt: number;
  /** Approved: the connection's token, held until its agent's votes have passed. */
  approved?: { token: string; agentId: string };
  done?: { redirect: string };
}
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

/** Opened in a browser, an invite link says what to do with it. */
function invitePage(org: string, link: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Join ${esc(org)} on Karuna</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#0a0a0a;color:#f4f4f5;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}main{max-width:460px}h1{font-size:26px;margin:0 0 8px}code{display:block;background:#18181b;border:1px solid #27272a;border-radius:8px;padding:10px;word-break:break-all;margin:14px 0;font-size:13px}p{color:#a1a1aa}ol{color:#d4d4d8;padding-left:20px}</style></head>
<body><main><h1>You're invited to join ${esc(org)}</h1><p>${esc(org)} uses Karuna to approve what its AI agents do.</p>
<ol><li>Open the Karuna app on your computer.</li><li>Choose <b>Ask to Join</b> and paste this link:</li></ol><code>${esc(link)}</code><p>One of ${esc(org)}'s members then adds you after a vote.</p></main></body></html>`;
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
    name: "web_search",
    description: "Search the web. Use this instead of any built-in web search: your team's Karuna rules decide, and an unlisted request waits for a member's approval.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "What to search for" } }, required: ["query"] },
    annotations: { title: "Search the web", readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "web_fetch",
    description: "Read a web page as text. Use this instead of any built-in web fetch: your team's Karuna rules decide. Redirects aren't followed; call it again on the new address.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "The http(s) address" } }, required: ["url"] },
    annotations: { title: "Read a web page", readOnlyHint: true, openWorldHint: true },
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
  if (name === "web_search" || name === "web_fetch") return gk.callWebTool(agentId, name, args);
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

      // ---- invite links: another Karuna (or a browser) looks up the org and sends a signed join request
      let im: RegExpMatchArray | null;
      if ((im = path.match(/^\/invite\/(inv_[\w-]{8,40})(\/request|\/status)?$/))) {
        const [, code, sub] = im;
        if (method === "GET" && !sub) {
          const info = gk.inviteInfo(code);
          if (!String(req.headers.accept ?? "").includes("text/html")) return send(res, 200, info);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          return res.end(invitePage(info.org, `${base}/invite/${code}`));
        }
        if (method === "POST" && sub === "/request") {
          const body = JSON.parse((await readRaw(req)) || "{}") as { address?: unknown; name?: unknown; signature?: unknown };
          return send(res, 200, await gk.requestWithInvite(code, body));
        }
        if (method === "GET" && sub === "/status") return send(res, 200, gk.inviteStatus(code, url.searchParams.get("address")));
        return send(res, 405, { error: "Method not allowed" });
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
          <p>Ask a member of your team to approve this connection in Karuna: <b>Agents → New agent → Claude chat</b>.</p>
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
                if (j.status === "voting") document.getElementById("st").textContent = "Approved. Waiting for your team's vote to finish (about a minute)…";
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
        const back = new URL(p.redirectUri);
        if (p.state) back.searchParams.set("state", p.state);
        if (!p.approved) {
          const r = gk.pollDevice({ deviceId: p.deviceId, secret: p.secret }) as { status: string; token?: string; agentId?: string };
          if (r.status === "approved" && r.token && r.agentId) p.approved = { token: r.token, agentId: r.agentId };
          else if (r.status === "denied" || r.status === "expired") {
            back.searchParams.set("error", "access_denied");
            pending.delete(p.id);
            return send(res, 200, { status: r.status, redirect: back.toString() });
          } else return send(res, 200, { status: "pending" });
        }
        // Approving starts the votes for the connection's agent. Hand the chat app its token only
        // once they've passed: if it calls /mcp before, Karuna has to refuse it, and the chat app
        // gives up on the connection.
        if (!gk.agentReady(p.approved.agentId)) return send(res, 200, { status: "voting" });
        const code = b64url(randomBytes(24));
        codes.set(code, { code, token: p.approved.token, clientId: p.clientId, redirectUri: p.redirectUri, challenge: p.challenge, createdAt: Date.now() });
        back.searchParams.set("code", code);
        p.done = { redirect: back.toString() };
        return send(res, 200, { status: "approved", redirect: p.done.redirect });
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
