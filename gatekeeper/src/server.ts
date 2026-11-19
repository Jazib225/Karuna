// Two HTTP surfaces, deliberately separate:
//  - Agent API   (:8787)  propose + read own proposal status. Bearer agent token. Nothing else.
//  - Console API (:8788)  localhost only + console secret. Policy changes and payment approvals
//                         must ALSO carry a member's signature (their browser key), so even
//                         console access can't approve, loosen, or vote without a member.
// An agent can never reach the console API, so it can't approve its own request.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { remoteInvite } from "./invite.ts";
import { timingSafeEqual } from "node:crypto";
import { defaultRules } from "@prekaruna/engine";
import { ConfigError, isSetUp } from "./config.ts";
import { isTransient, scrub } from "./chain.ts";
import { GatekeeperError, SESSION_ENDED, type AgentAction, type Gatekeeper, type SignedAction, type SignedDecision } from "./gatekeeper.ts";
import type { Permission } from "@prekaruna/dharma";
import { WalletError, type WalletBackend } from "./wallet.ts";
import type { EgressProxy } from "./proxy.ts";
import type { SecretStore } from "./secrets.ts";
import type { Accounts } from "./accounts.ts";
import { Voice, VoiceError, heldSentence, reasonSentence, voteSentence } from "./voice.ts";

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
  // session: true tells the console to sign a new session and try once more.
  if (e instanceof GatekeeperError) return send(res, e.status, { error: e.message, ...(e.message === SESSION_ENDED ? { session: true } : {}) });
  if (e instanceof ConfigError) return send(res, 400, { error: e.message });
  if (e instanceof VoiceError) return send(res, e.status, { error: e.message });
  if (isTransient(e)) return send(res, 503, { error: "The Arc RPC is busy (rate limited). Try again in a moment — or set ARC_RPC_URL to your QuickNode endpoint." });
  console.error("gatekeeper error:", scrub(e));
  send(res, 500, { error: "Internal error" });
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Console requests that need a role's permission, checked against the request's console session.
 * Signed member actions (votes, approvals, escrow cancels) are checked against their signer instead,
 * in the Gatekeeper. Reads, sign-in, joining and the relay's reports need no role.
 */
/** A Circle CLI call whose failure the person can act on (a wrong code, the faucet's limit): 400 with Circle's words. */
async function walletCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WalletError) throw new GatekeeperError(e.message, 400);
    throw e;
  }
}

const GATED: [method: string, path: RegExp, perm: Permission][] = [
  ["POST", /^\/wallet\/gateway-deposit$/, "wallet"],
  ["POST", /^\/devices\/[\w-]+\/(approve|deny|revoke)$/, "agents"],
  ["POST", /^\/connectors\/tools\/.+\/accept$/, "agents"],
  ["POST", /^\/agents\/(draft|build|prepare)$/, "agents"],
  ["PATCH", /^\/agents\/[\w-]+\/built$/, "agents"],
  ["POST", /^\/agents\/[\w-]+\/(run|rotate-token)$/, "agents"],
  ["POST", /^\/agents\/[\w-]+\/preflight(\/fix)?$/, "agents"],
  ["POST", /^\/runs\/[\w-]+\/(stop|undo)$/, "agents"],
  ["POST", /^\/inbox$/, "agents"],
  ["POST", /^\/traps(\/[\w-]+\/plant)?$/, "agents"],
  ["POST", /^\/shield\/test$/, "agents"],
  ["POST", /^\/keys$/, "agents"],
  ["DELETE", /^\/keys\/[a-z0-9-]+$/, "agents"],
  ["POST", /^\/sandbox\/[\w-]+\/stop$/, "agents"],
  ["POST", /^\/(rules\/draft|dharma\/code)$/, "propose"],
  ["POST", /^\/(pause|resume)$/, "freeze"],
  ["PATCH", /^\/settings$/, "team"],
  ["POST", /^\/invites$/, "team"],
  ["DELETE", /^\/invites\/inv_[\w-]+$/, "team"],
];

// ---------------------------------------------------------------- agent API

export function agentApi(gk: Gatekeeper, sandbox?: SandboxDeps): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      // Connecting a computer (the Claude Code / Cursor plugin): no token yet, a member approves it.
      if (req.method === "POST" && url.pathname === "/v1/devices") return send(res, 200, gk.requestDevice(await readBody(req)));
      if (req.method === "POST" && url.pathname === "/v1/devices/poll") return send(res, 200, gk.pollDevice(await readBody(req)));
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const who = gk.authAgent(token);
      if (!who) return send(res, 401, { error: "Unknown agent token" });
      const agentId = who.agentId;

      // ---- sandbox runs (karuna run). Only an agent's own kag_ token can start one.
      if (req.method === "POST" && url.pathname === "/v1/sessions") {
        if (who.session) return send(res, 403, { error: "Start runs from outside the sandbox" });
        if (!sandbox) return send(res, 501, { error: "This Gatekeeper has no sandbox support" });
        const body = await readBody(req);
        const s = gk.startSession(agentId, { host: body.host, isolation: body.isolation, desktop: body.desktop, remote: body.remote, runId: body.runId });
        const proxyPort = await sandbox.proxy.open(s.token);
        return send(res, 200, {
          session: s.token, id: s.id, runId: s.runId, agentId, proxyPort, caPem: sandbox.caPem,
          env: sandbox.secrets.placeholderEnv(),
          writableMounts: (Array.isArray(body.mounts) ? body.mounts : []).filter((m: unknown) => typeof m === "string" && gk.mayMountWritable(agentId, m)),
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/sessions/heartbeat") {
        if (!who.session) return send(res, 400, { error: "Heartbeat with the run's session token" });
        const hb = await readBody(req);
        return send(res, 200, gk.heartbeat(token, { viewer: hb.viewer }));
      }
      // What the box printed (karuna run forwards it): the agent's own account, shown in its run.
      if (req.method === "POST" && url.pathname === "/v1/sessions/output") {
        if (!who.session) return send(res, 400, { error: "Send output with the run's session token" });
        const out = await readBody(req);
        return send(res, 200, gk.noteOutput(token, out.lines));
      }
      // What the run changed in its writable mounts (snapshotted first): after the box exits, from the
      // session (or the agent's own token for one of its runs, if the session already ended).
      if (req.method === "POST" && url.pathname === "/v1/sessions/changes") {
        const body = await readBody(req);
        return send(res, 200, gk.recordRunChanges(who.session ? { token } : { agentId }, body));
      }
      // A built agent's box asks what to do this run.
      if (req.method === "GET" && url.pathname === "/v1/job") {
        if (!who.session) return send(res, 400, { error: "Ask from inside the run" });
        return send(res, 200, gk.jobFor(token));
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
        const r = await gk.propose(agentId, action, body.reason as string | undefined);
        if (who.session) gk.noteRunProposal(token, r);
        return send(res, 200, r);
      }
      // Claude Code / Cursor: decide one tool call before it runs; wait for a member when it's held.
      if (req.method === "POST" && url.pathname === "/v1/hook") {
        const body = await readBody(req);
        const r = gk.hookCall(agentId, body as never);
        if (who.session) gk.noteHookCall(token, r);
        return send(res, 200, r);
      }
      const hw = url.pathname.match(/^\/v1\/hook\/([\w-]+)\/wait$/);
      if (req.method === "GET" && hw) {
        if (!gk.agentView(agentId, hw[1])) return send(res, 404, { error: "Not found" });
        const ms = Math.min(25_000, Math.max(0, Number(url.searchParams.get("ms") ?? 20_000)));
        return send(res, 200, { status: await gk.waitForDecision(hw[1], ms) });
      }
      if (req.method === "GET" && url.pathname === "/v1/inbox") return send(res, 200, { messages: gk.agentInbox(agentId) });
      if (req.method === "GET" && url.pathname === "/v1/payees") return send(res, 200, { payees: gk.agentPayees() });
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

export function consoleApi(
  gk: Gatekeeper, wallet: WalletBackend, consoleToken: string, secrets?: SecretStore, caPem?: string,
  accounts: Accounts | null = null,
  voice: Voice | null = null,
): Server {
  const voiceNames = () => ({
    agent: (id: string) => gk.org.labels.agents[id] ?? id.replace(/[-_]+/g, " "),
    payee: (a: string) => gk.org.labels.payees[a.toLowerCase()] ?? null,
  });
  /** Karuna Voice (docs/VOICE_PLAN.md): only for a signed-in member's console session. */
  async function voiceRoute(res: ServerResponse, method: string, path: string, body: Record<string, unknown>, me: string | null): Promise<boolean> {
    if (method === "GET" && path === "/voice/config") return (send(res, 200, voice ? voice.status() : { configured: false, conversation: false, alerts: false }), true);
    if (!path.startsWith("/voice/")) return false;
    if (!voice) throw new GatekeeperError("Voice isn't set up on this Gatekeeper.", 503);
    if (!me) throw new GatekeeperError("Sign in to the console to use voice.", 401);
    if (method === "POST" && path === "/voice/session") return (send(res, 200, await voice.conversationToken()), true);
    if (method === "POST" && path === "/voice/speak") {
      // Only Karuna's own sentence for one held request or one open vote: never free text.
      const keys = Object.keys(body).filter((k) => body[k] !== undefined);
      if (keys.some((k) => !["id", "reason", "vote"].includes(k))) throw new GatekeeperError("Voice only speaks a held request or an open vote, never free text.", 400);
      let text: string;
      if (body.vote !== undefined) {
        const v = gk.openVotes().find((x) => x.id === Number(body.vote));
        if (!v || !Number.isInteger(Number(body.vote))) throw new GatekeeperError("That vote isn't open.", 404);
        text = voteSentence(v);
      } else {
        const id = String(body.id ?? "");
        const p = gk.recentProposals().find((x) => x.id === id);
        if (!p || p.status !== "pending") throw new GatekeeperError("That request isn't waiting for anyone.", 404);
        text = body.reason === true ? reasonSentence(p, voiceNames()) : heldSentence(p, voiceNames(), gk.approvalsNeeded(p as never));
      }
      const audio = await voice.speak(text);
      res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "no-store", "x-karuna-said": encodeURIComponent(text) });
      res.end(audio);
      return true;
    }
    return false;
  }
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
      if (method === "GET" && path === "/runs") return send(res, 200, gk.runsView(url.searchParams.get("agent") ?? undefined));
      if (method === "GET" && path.startsWith("/runs/")) return send(res, 200, gk.runView(decodeURIComponent(path.slice("/runs/".length))));
      // Sign in with email and password: the browser locks the member's key with the password.
      if (method === "GET" && path === "/auth/config") return send(res, 200, { accounts: !!accounts });
      if (method === "GET" && path === "/sandbox/ca") {
        // Public certificate (not a secret): remote machines pin it to trust only this Gatekeeper.
        res.writeHead(200, { "content-type": "application/x-pem-file", "content-disposition": "attachment; filename=karuna-ca.pem" });
        return void res.end(caPem ?? "");
      }
      if (method === "GET" && path === "/policy") return send(res, 200, defaultRules.map((r) => ({ id: r.id, description: r.description, outcome: r.outcome })));
      if (method === "GET" && path === "/log") {
        const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 200) || 200);
        const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined;
        return send(res, 200, gk.logTail(limit, before !== undefined && Number.isInteger(before) && before >= 0 ? before : undefined));
      }
      if (method === "GET" && path === "/wallet") {
        const addr = gk.org.wallet?.address;
        if (!addr) return send(res, 200, null);
        if (!walletCache || Date.now() - walletCache.at > 10_000) {
          walletCache = { at: Date.now(), value: { address: addr, ...(await wallet.balances(addr)) } };
          const n = Number((walletCache.value as { usdc: string }).usdc);
          if (Number.isFinite(n)) gk.walletUsd = n;
        }
        return send(res, 200, walletCache.value);
      }
      let m0: RegExpMatchArray | null;
      if (method === "GET" && path === "/wallets/status") {
        if (!wallet.loginStatus) return send(res, 200, { cli: true, loggedIn: true, email: null, expiresIn: null });
        return send(res, 200, await wallet.loginStatus());
      }
      if (method === "GET" && (m0 = path.match(/^\/wallets\/(0x[0-9a-fA-F]{40})\/balance$/))) {
        return send(res, 200, await wallet.balances(m0[1].toLowerCase()));
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

      // Who is asking (their console session), and whether their role allows it.
      const me = gk.sessionMember(String(req.headers["x-karuna-session"] ?? "") || undefined);
      const gate = GATED.find(([gm, gp]) => gm === method && gp.test(path));
      if (gate) gk.requirePermission(me, gate[2]);
      if (await voiceRoute(res, method, path, body, me)) return;

      // The Circle wallet, from the console (no terminal): sign in with an emailed code, and get test
      // USDC from Circle's faucet. Before setup anyone at this machine can; after, it needs "wallet".
      if (method === "POST" && path.startsWith("/wallets/")) {
        if (isSetUp(gk.org) && path !== "/wallets/fund") gk.requirePermission(me, "wallet");
        if (path === "/wallets/login") {
          const email = String(body.email ?? "").trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new GatekeeperError("Enter a valid email address", 400);
          if (!wallet.loginStart) throw new GatekeeperError("This wallet can't sign in from the console", 501);
          return send(res, 200, await walletCall(() => wallet.loginStart!(email)));
        }
        if (path === "/wallets/login/verify") {
          const requestId = String(body.requestId ?? "");
          const code = String(body.code ?? "").trim().toUpperCase();
          if (!/^[\w-]{4,200}$/.test(requestId)) throw new GatekeeperError("Start again: send a new code", 400);
          if (!/^([A-Z0-9]{3}-)?\d{6}$/.test(code)) throw new GatekeeperError("Enter the 6-digit code from the email", 400);
          if (!wallet.loginFinish) throw new GatekeeperError("This wallet can't sign in from the console", 501);
          const r = await walletCall(() => wallet.loginFinish!(requestId, code));
          walletCache = null;
          return send(res, 200, { ...r, wallets: await wallet.listWallets().catch(() => []) });
        }
        if (path === "/wallets/fund") {
          const address = String(body.address ?? "").toLowerCase();
          if (!/^0x[0-9a-f]{40}$/.test(address)) throw new GatekeeperError("Pick a wallet", 400);
          if (!wallet.fundTestnet) throw new GatekeeperError("This wallet can't use the faucet", 501);
          await walletCall(() => wallet.fundTestnet!(address));
          walletCache = null;
          return send(res, 200, { ok: true });
        }
      }

      if (method === "POST" && path === "/session") return send(res, 200, await gk.startConsoleSession(body));
      if (method === "POST" && path === "/viewers") return send(res, 200, (gk.addViewer(me, body.address), { ok: true }));
      if (method === "DELETE" && (m = path.match(/^\/viewers\/(0x[0-9a-fA-F]{40})$/))) return send(res, 200, (gk.removeViewer(me, m[1]), { ok: true }));

      if (method === "POST" && path === "/wallet/gateway-deposit") {
        const r = await gk.depositGateway((body as { amountUsd?: unknown }).amountUsd);
        walletCache = null; // show the new balances on the next read
        return send(res, 200, r);
      }

      if (method === "GET" && (m = path.match(/^\/dharma\/nonce\/(0x[0-9a-fA-F]{40})$/))) return send(res, 200, { nonce: String(await gk.nonceOf(m[1])) });
      if (method === "POST" && path === "/chain-event") {
        // The relay saw a Dharma event (QuickNode Stream or direct RPC): re-read policy now.
        gk.lastChainEventAt = Date.now();
        await gk.sync(true).catch(() => undefined);
        return send(res, 200, { ok: true });
      }
      // The relay's QuickNode Streams: a USDC transfer out of the org's wallet (watchdog), and the
      // agents' records rebuilt from Dharma's events (trust levels).
      if (method === "POST" && (m = path.match(/^\/devices\/([\w-]+)\/approve$/))) return send(res, 200, gk.approveDevice(m[1], body));
      if (method === "POST" && (m = path.match(/^\/devices\/([\w-]+)\/deny$/))) return send(res, 200, gk.denyDevice(m[1]));
      if (method === "POST" && (m = path.match(/^\/devices\/([\w-]+)\/revoke$/))) return send(res, 200, gk.revokeDevice(m[1]));
      if (method === "POST" && (m = path.match(/^\/connectors\/tools\/(.+)\/accept$/))) return send(res, 200, gk.acceptToolChange(decodeURIComponent(m[1])));
      // Agents Karuna builds and runs, and every run's timeline.
      if (method === "POST" && path === "/agents/draft") return send(res, 200, await gk.draftAgent(body.text));
      if (method === "POST" && path === "/agents/build") return send(res, 200, gk.buildAgent(body));
      if (method === "PATCH" && (m = path.match(/^\/agents\/([\w-]+)\/built$/))) return send(res, 200, gk.updateBuiltAgent(m[1], body));
      if (method === "POST" && (m = path.match(/^\/agents\/([\w-]+)\/run$/))) return send(res, 200, gk.runBuiltAgent(m[1], "Run now"));
      // Pre-flight: three Drills for one agent (Run again), and "Apply fix" for one that failed.
      if (method === "POST" && (m = path.match(/^\/agents\/([\w-]+)\/preflight$/))) return send(res, 200, gk.preflight(m[1]));
      if (method === "POST" && (m = path.match(/^\/agents\/([\w-]+)\/preflight\/fix$/))) return send(res, 200, await gk.applyPreflightFix(m[1], body.testId));
      if (method === "POST" && (m = path.match(/^\/runs\/([\w-]+)\/stop$/))) return send(res, 200, gk.stopRun(m[1]));
      if (method === "POST" && (m = path.match(/^\/runs\/([\w-]+)\/undo$/))) return send(res, 200, await gk.undoRunChanges(m[1], body));
      if (method === "POST" && (m = path.match(/^\/proposals\/([\w-]+)\/escrow-cancel$/))) return send(res, 200, await gk.cancelEscrow(m[1], body));
      if (accounts && method === "POST" && path === "/auth/salt") return send(res, 200, accounts.salt(body.email));
      if (accounts && method === "POST" && path === "/auth/create") return send(res, 200, accounts.create(body));
      if (accounts && method === "POST" && path === "/auth/sign-in") return send(res, 200, accounts.signIn(body));
      if (method === "POST" && path === "/dharma/code") return send(res, 200, await gk.prepareUpgrade());
      if (method === "POST" && path === "/watchdog/transfer") return send(res, 200, gk.watchdogTransfer(body as never));
      if (method === "POST" && path === "/records") return send(res, 200, gk.setChainRecords(body as never));
      if (method === "POST" && path === "/inbox") return send(res, 200, gk.postMessage(body as never));
      if (method === "POST" && path === "/traps") return send(res, 200, gk.mintTrapSet(body.agentId));
      if (method === "POST" && (m = path.match(/^\/traps\/([\w-]+)\/plant$/))) return send(res, 200, gk.plantTrapInInbox(m[1], body.agentId));
      if (method === "POST" && path === "/shield/test") return send(res, 200, gk.runTest(body as never));
      // Replacing an organization archives it and its keys: only a member who can manage the team may.
      if (method === "POST" && path === "/setup") {
        if (isSetUp(gk.org)) gk.requirePermission(me, "team");
        return send(res, 200, await gk.setup(body as never));
      }
      if (method === "PATCH" && path === "/settings") return send(res, 200, (gk.renameOrg(body.orgName), { ok: true }));
      if (method === "POST" && path === "/dharma/action") return send(res, 200, await gk.submitAction(body as unknown as SignedAction));
      if (method === "POST" && path === "/rules/draft") return send(res, 200, await gk.draftRules(body.text));
      if (method === "POST" && path === "/agents/prepare") return send(res, 200, gk.prepareAgent(body.name));
      if (method === "POST" && (m = path.match(/^\/agents\/([\w-]+)\/rotate-token$/))) return send(res, 200, gk.rotateAgentToken(m[1]));
      if (method === "POST" && path === "/keys") {
        if (!secrets) return send(res, 501, { error: "No key store" });
        try {
          // copyFrom: reuse the Groq or Gemini key saved for drafting (the console never sees its value).
          const from = body.copyFrom === "groq" || body.copyFrom === "gemini" ? secrets.drafterKey(body.copyFrom) : null;
          if (body.copyFrom !== undefined && !from) return send(res, 400, { error: "No drafting key to reuse. Paste the key instead." });
          const k = secrets.put(String(body.name ?? "").trim().toLowerCase(), String(body.envVar ?? "").trim(), from ?? String(body.value ?? ""), new Date(), body.purpose === "drafter" ? { purpose: "drafter", provider: String(body.provider ?? "") } : {});
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
      // Invite links: make and revoke yours; use someone else's (this Gatekeeper reaches their Karuna).
      if (method === "POST" && path === "/invites") return send(res, 200, gk.createInvite({ days: body.days, uses: body.uses }));
      if (method === "DELETE" && (m = path.match(/^\/invites\/(inv_[\w-]+)$/))) return send(res, 200, (gk.revokeInvite(m[1]), { ok: true }));
      if (method === "POST" && path === "/invites/lookup") return send(res, 200, await remoteInvite(body.link, ""));
      if (method === "POST" && path === "/invites/send") return send(res, 200, await remoteInvite(body.link, "/request", { address: body.address, name: body.name, signature: body.signature }));
      if (method === "POST" && path === "/invites/status") return send(res, 200, await remoteInvite(body.link, `/status?address=${encodeURIComponent(String(body.address ?? ""))}`));
      if (method === "POST" && path === "/access-request") return send(res, 200, (gk.requestAccess(body.address, body.name), { ok: true }));
      if (method === "POST" && (m = path.match(/^\/proposals\/([\w-]+)\/decide$/))) return send(res, 200, await gk.decide(m[1], body as unknown as SignedDecision));

      send(res, 404, { error: "Not found" });
    } catch (e) {
      fail(res, e);
    }
  });
}
