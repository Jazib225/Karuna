// The Gatekeeper's local event pipe for the Karuna desktop app (the island).
//   Windows: \\.\pipe\karuna     elsewhere: $TMPDIR/karuna.sock
// Newline-delimited JSON, both directions.
//
// Out (Gatekeeper → app):
//   decision            { id, action_type, summary, result: "allow" | "deny" }
//   approval_requested  { id, action_type, payload, payload_hash, reversible, agent_reason, why, if_unanswered, expires_at }
//   approval_resolved   { id, result: "approved" | "denied" | "failed" | "expired" }
//   agent_paused        { by, at }      agent_resumed {}
//   error               { id?, error }  (a response we ignored, and why)
// In (app → Gatekeeper):
//   approval_response   { id, payload_hash, decision: "approve" | "deny", signer, deadline, signature }
//   pause { by }        resume { by }
//
// The pipe is not an approval channel by itself: a response must match the pending request's id and
// payload hash exactly AND carry a member's signature over that hash (made by the console's member
// key), which the Gatekeeper verifies like any approval. Any local program can read events; none
// can approve without a member key.
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import type { Gatekeeper, Proposal } from "./gatekeeper.ts";

export const PIPE_PATH = process.platform === "win32" ? "\\\\.\\pipe\\karuna" : join(tmpdir(), "karuna.sock");
const ZERO_HASH = "0".repeat(64);
const MAX_LINE = 64 * 1024;

const actionType = (p: Readonly<Proposal>) => p.payload?.kind ?? (p.request.tool === "payment" ? p.request.paymentKind ?? "payment" : p.request.tool);
const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4).replace(/0+$/, "") : n.toFixed(2)}`;

function summary(p: Readonly<Proposal>): string {
  const pay = p.payload;
  if (pay?.kind === "transfer") return `send ${usd(pay.amountUsd)} to ${pay.to}`;
  if (pay?.kind === "x402") return `buy ${pay.method} ${pay.url} for ${usd(pay.amountUsd)}`;
  const r = p.request;
  if (r.tool === "http") return `${r.method ?? "GET"} ${r.url ?? ""}`;
  if (r.tool === "shell") return r.command ?? "shell";
  if (r.tool === "file") return `${r.fileOp ?? "read"} ${r.path ?? ""}`;
  return r.tool;
}

/** Exactly what would run if approved: the payment payload, or the held HTTP request. */
function payloadOf(p: Readonly<Proposal>): Record<string, unknown> {
  if (p.payload) return { ...p.payload };
  const a = p.action as { method?: string; url?: string; body?: string; command?: string; path?: string };
  return Object.fromEntries(
    Object.entries({ tool: p.request.tool, method: a.method, url: a.url, body: a.body, command: a.command, path: a.path })
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, shown(v)]),
  );
}

/**
 * The desktop app drops event lines over 256 KB, so a huge held body would never reach the island
 * and its card would never appear. Show the start of it; the hash still covers the whole request.
 */
const SHOWN_MAX = 32 * 1024;
const shown = (v: unknown) => (typeof v === "string" && v.length > SHOWN_MAX ? `${v.slice(0, SHOWN_MAX)}… (${v.length - SHOWN_MAX} more characters)` : v);

export function pipeServer(gk: Gatekeeper): Server {
  const clients = new Set<Socket>();
  const send = (msg: Record<string, unknown>, only?: Socket) => {
    const line = `${JSON.stringify(msg)}\n`;
    for (const c of only ? [only] : clients) if (!c.destroyed) c.write(line);
  };

  const requested = (p: Readonly<Proposal>) => ({
    type: "approval_requested",
    id: p.id,
    action_type: actionType(p),
    payload: payloadOf(p),
    payload_hash: p.payloadHash ?? ZERO_HASH,
    // A transfer held in escrow can be cancelled by any member until it's released.
    reversible: p.payload ? p.payload.kind === "transfer" && !!gk.escrowFor(p.agentId, p.payload.amountUsd) : p.request.tool === "http" && ["GET", "HEAD"].includes((p.request.method ?? "GET").toUpperCase()),
    agent_reason: p.reason ?? null,
    // Why Karuna held it (the rule that matched), and what happens if no member answers.
    why: p.decision.reason ?? null,
    if_unanswered: gk.ifUnanswered(p),
    expires_at: p.request.tool === "http" && !p.payload ? new Date(Date.parse(p.createdAt) + gk.holdMs).toISOString() : null,
    agent: p.agentId,
  });

  // Turn Gatekeeper changes into events by diffing what we've already told clients.
  const pending = new Map<string, Readonly<Proposal>>();
  const seen = new Set<string>();
  for (const p of gk.recentProposals()) {
    seen.add(p.id);
    if (p.status === "pending") pending.set(p.id, p);
  }
  gk.on("change", () => {
    const now = gk.recentProposals();
    const byId = new Map(now.map((p) => [p.id, p]));
    for (const p of now) {
      if (p.status === "pending" && !pending.has(p.id)) {
        pending.set(p.id, p);
        seen.add(p.id);
        send(requested(p));
      } else if (!seen.has(p.id)) {
        seen.add(p.id);
        if (p.status !== "pending") {
          send({ type: "decision", id: p.id, action_type: actionType(p), summary: summary(p), result: ["denied", "failed", "expired"].includes(p.status) ? "deny" : "allow", agent: p.agentId });
        }
      }
    }
    for (const [id] of pending) {
      const p = byId.get(id);
      if (p && p.status === "pending") continue;
      pending.delete(id);
      const st = p?.status;
      send({ type: "approval_resolved", id, result: st === "denied" ? "denied" : st === "failed" ? "failed" : st === "expired" ? "expired" : "approved" });
    }
    if (seen.size > 5000) for (const id of [...seen].slice(0, 2500)) seen.delete(id);
  });

  // Allowed requests out of a box don't create proposals; show them as "working" (max 1/s per agent).
  const lastEgress = new Map<string, number>();
  gk.on("egress-allowed", (e: { agentId: string; method: string; url: string }) => {
    if (Date.now() - (lastEgress.get(e.agentId) ?? 0) < 1000) return;
    lastEgress.set(e.agentId, Date.now());
    let host = e.url;
    try {
      const u = new URL(e.url);
      host = `${u.host}${u.pathname}`;
    } catch {
      /* keep raw */
    }
    send({ type: "decision", id: `egress-${Date.now()}`, action_type: "http", summary: `${e.method} ${host}`.slice(0, 160), result: "allow", agent: e.agentId });
  });
  // Trust-level changes and watchdog freezes show in the island's feed like any decision.
  gk.on("notice", (n: { kind: string; agent: string; tone: "ok" | "bad"; summary: string }) =>
    send({ type: "decision", id: `notice-${Date.now()}`, action_type: n.kind, summary: n.summary.slice(0, 160), result: n.tone === "bad" ? "deny" : "allow", agent: n.agent }),
  );
  gk.on("paused", (p: { by: string; at: string }) => send({ type: "agent_paused", ...p }));
  gk.on("resumed", () => send({ type: "agent_resumed" }));

  async function handle(c: Socket, msg: Record<string, unknown>) {
    if (msg.type === "pause") return void gk.pause(String(msg.by ?? "desktop app"));
    if (msg.type === "resume") return void gk.resume(String(msg.by ?? "desktop app"));
    if (msg.type !== "approval_response") return send({ type: "error", error: `unknown message type ${String(msg.type)}` }, c);

    const id = String(msg.id ?? "");
    const hash = String(msg.payload_hash ?? "").replace(/^0x/, "").toLowerCase();
    const p = gk.recentProposals().find((x) => x.id === id);
    // Our side of the id + hash check: stale or mismatched responses are ignored, never applied.
    if (!p || p.status !== "pending") return send({ type: "error", id, error: "stale: that request is no longer pending" }, c);
    if (hash !== (p.payloadHash ?? ZERO_HASH)) return send({ type: "error", id, error: "mismatch: payload hash differs from the pending request" }, c);
    if (msg.decision !== "approve" && msg.decision !== "deny") return send({ type: "error", id, error: "decision must be approve or deny" }, c);
    try {
      await gk.decide(id, {
        approve: msg.decision === "approve",
        payloadHash: `0x${hash}`,
        signer: String(msg.signer ?? "") as `0x${string}`,
        deadline: String(msg.deadline ?? "0"),
        signature: String(msg.signature ?? "") as `0x${string}`,
      });
      // Counted, but it needs another member too: tell this client, or its card waits forever.
      const after = gk.recentProposals().find((x) => x.id === id);
      if (after?.status === "pending") send({ type: "approval_progress", id, approvals: after.approvals.length, needed: gk.approvalsNeeded(after) }, c);
    } catch (e) {
      send({ type: "error", id, error: e instanceof Error ? e.message : String(e) }, c);
    }
  }

  const server = createServer((c) => {
    clients.add(c);
    c.setEncoding("utf8");
    let buf = "";
    c.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE * 4) return void c.destroy();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          send({ type: "error", error: "not JSON" }, c);
          continue;
        }
        void handle(c, msg);
      }
    });
    c.on("close", () => clients.delete(c));
    c.on("error", () => clients.delete(c));
    // Catch a new client up: anything pending right now, and the pause state.
    for (const p of pending.values()) send(requested(p), c);
    if (gk.paused) send({ type: "agent_paused", ...gk.paused }, c);
  });
  if (process.platform !== "win32") {
    try {
      unlinkSync(PIPE_PATH);
    } catch {
      /* not there */
    }
  }
  return server;
}
