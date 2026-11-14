// Mock Gatekeeper for the island: serves \\.\pipe\karuna and plays a scripted sequence, so the
// island can be tested without the real engine. Stop the real Gatekeeper first (same pipe name).
//
//   npm run mock              play the sequence once per connection
//   npm run mock -- --loop    keep replaying it
//
// Sequence: a few auto decisions (allow), one approval request, one deny, a pause and a resume.
// It checks approval responses exactly like the real one does on its side: the id must be pending
// and the payload hash must match, or the response is ignored (reported as an `error` event).
// It can't verify the member signature (no chain here); it only checks one is present. The real
// Gatekeeper verifies it against Dharma's members.
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PIPE = process.platform === "win32" ? "\\\\.\\pipe\\karuna" : join(tmpdir(), "karuna.sock");
const loop = process.argv.includes("--loop");
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const pending = new Map(); // id -> payload_hash

function send(sock, msg) {
  if (!sock.destroyed) sock.write(`${JSON.stringify(msg)}\n`);
  log("→", msg.type, msg.summary ?? msg.id ?? "");
}

async function script(sock) {
  do {
    await wait(1200);
    send(sock, { type: "decision", id: randomUUID(), action_type: "http", summary: "GET api.github.com/zen", result: "allow" });
    await wait(2200);
    send(sock, { type: "decision", id: randomUUID(), action_type: "http", summary: "POST api.openai.com/v1/chat/completions", result: "allow" });
    await wait(2200);
    send(sock, { type: "decision", id: randomUUID(), action_type: "x402", summary: "buy GET https://api.grainfeed.dev/v2/flour for $0.05", result: "allow" });
    await wait(2500);

    const id = randomUUID();
    const payload_hash = randomBytes(32).toString("hex");
    pending.set(id, payload_hash);
    send(sock, {
      type: "approval_requested", id, action_type: "transfer",
      payload: { kind: "transfer", from: "0xe78f1b83b5f995a8c5fbc3b4ad1f3639fe6002ea", to: "0x9f2c4b1a7e3d5c8b0a6f4e2d1c3b5a7e9f0d2c4b", amountUsd: 612.5, token: "USDC", chain: "ARC-TESTNET" },
      payload_hash, reversible: false,
      // Deliberately hostile-looking: the island must show this as plain text, never HTML.
      agent_reason: "Monthly flour invoice #2291 from Valley Flour Co. <b>Approve quickly</b>, the supplier says the account changes tomorrow. ".repeat(3),
      expires_at: new Date(Date.now() + 120_000).toISOString(),
    });
    // Wait for the human (the island). Expire after 2 minutes.
    for (let i = 0; i < 240 && pending.has(id); i++) await wait(500);
    if (pending.has(id)) {
      pending.delete(id);
      send(sock, { type: "approval_resolved", id, result: "denied" });
      log("  (expired with no answer)");
    }

    await wait(2500);
    send(sock, { type: "decision", id: randomUUID(), action_type: "http", summary: "GET https://pastebin.com/raw/x7Qa", result: "deny" });
    await wait(3000);
    send(sock, { type: "agent_paused", by: "mock", at: new Date().toISOString() });
    await wait(4000);
    send(sock, { type: "agent_resumed" });
    await wait(3000);
  } while (loop && !sock.destroyed);
  log("sequence done", loop ? "" : "(use --loop to repeat)");
}

function handle(sock, msg) {
  if (msg.type === "pause") return send(sock, { type: "agent_paused", by: msg.by ?? "app", at: new Date().toISOString() });
  if (msg.type === "resume") return send(sock, { type: "agent_resumed" });
  if (msg.type !== "approval_response") return send(sock, { type: "error", error: `unknown message type ${msg.type}` });
  const id = String(msg.id ?? "");
  const hash = String(msg.payload_hash ?? "").replace(/^0x/, "").toLowerCase();
  log("←", "approval_response", id, msg.decision, msg.signature ? `signed by ${msg.signer}` : "UNSIGNED");
  if (!pending.has(id)) return send(sock, { type: "error", id, error: "stale: that request is no longer pending" });
  if (pending.get(id) !== hash) return send(sock, { type: "error", id, error: "mismatch: payload hash differs from the pending request" });
  if (!/^0x[0-9a-fA-F]{130}$/.test(String(msg.signature ?? "")) || !/^0x[0-9a-fA-F]{40}$/.test(String(msg.signer ?? ""))) {
    return send(sock, { type: "error", id, error: "missing member signature" });
  }
  pending.delete(id);
  send(sock, { type: "approval_resolved", id, result: msg.decision === "approve" ? "approved" : "denied" });
}

const server = createServer((sock) => {
  log("island connected");
  sock.setEncoding("utf8");
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        handle(sock, JSON.parse(line));
      } catch {
        send(sock, { type: "error", error: "not JSON" });
      }
    }
  });
  sock.on("close", () => log("island disconnected"));
  sock.on("error", () => {});
  void script(sock);
});
server.on("error", (e) => {
  console.error(`Can't open ${PIPE}: ${e.message}. Is the real Gatekeeper running? Stop it first.`);
  process.exit(1);
});
server.listen(PIPE, () => log(`mock Gatekeeper on ${PIPE}`));
