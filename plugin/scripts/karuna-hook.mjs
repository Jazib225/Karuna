#!/usr/bin/env node
// Karuna's hook for Claude Code (PreToolUse) and Cursor (beforeShellExecution, beforeMCPExecution,
// beforeReadFile). Before Claude runs a tool, this asks the team's Karuna Gatekeeper:
//   allowed  → the call goes ahead (Claude's own permission prompts still apply)
//   blocked  → the call is refused with "Karuna blocked this."
//   held     → it waits here while a member approves or denies it in Karuna
// The first time, it connects this computer: Karuna shows a code that a member approves.
// It fails closed: if Karuna can't be reached, the call is refused.
// No dependencies: Node 18+ (fetch).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";

const CLIENT = process.argv.includes("--client") ? process.argv[process.argv.indexOf("--client") + 1] : null;
const GATEKEEPER = (process.env.KARUNA_GATEKEEPER_URL || process.env.CLAUDE_PLUGIN_OPTION_GATEKEEPER_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const WAIT_LIMIT_MS = 9 * 60_000; // Claude Code gives the hook 10 minutes

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

const input = readStdin();
const event = String(input.hook_event_name ?? "");
const client = CLIENT ?? (event === "PreToolUse" ? "claude-code" : event.startsWith("before") ? "cursor" : "claude-code");
const cfgDir = join(homedir(), ".karuna");
const cfgFile = join(cfgDir, `${client}.json`);

function loadCfg() {
  try {
    const c = JSON.parse(readFileSync(cfgFile, "utf8"));
    return c.gatekeeper === GATEKEEPER ? c : { gatekeeper: GATEKEEPER };
  } catch {
    return { gatekeeper: GATEKEEPER };
  }
}
function saveCfg(c) {
  try {
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgFile, JSON.stringify(c, null, 2), { mode: 0o600 });
  } catch {
    /* next call starts over */
  }
}

// ---- answers, in each client's format
function finish(decision, message) {
  if (client === "cursor") {
    process.stdout.write(JSON.stringify({ permission: decision === "allow" ? "allow" : "deny", ...(message ? { userMessage: message, agentMessage: message } : {}) }));
  } else if (decision !== "allow") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message } }));
  }
  // Claude Code + allow: say nothing, so Claude's normal permission prompts still apply.
  process.exit(0);
}

// ---- the call, as Claude Code names it
function toolCall() {
  if (client !== "cursor") return { tool: String(input.tool_name ?? ""), input: input.tool_input ?? {}, cwd: String(input.cwd ?? process.cwd()) };
  const cwd = String(input.cwd ?? input.workspace_roots?.[0] ?? process.cwd());
  if (event === "beforeShellExecution") return { tool: "Bash", input: { command: String(input.command ?? "") }, cwd };
  if (event === "beforeReadFile") return { tool: "Read", input: { file_path: String(input.file_path ?? "") }, cwd };
  if (event === "beforeMCPExecution") {
    let args = input.tool_input;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = { raw: args };
      }
    }
    const server = String(input.server ?? input.url ?? "mcp").replace(/[^a-z0-9_-]+/gi, "_").toLowerCase();
    return { tool: `mcp__${server}__${String(input.tool_name ?? "tool")}`, input: args ?? {}, cwd };
  }
  return { tool: event || "unknown", input: input, cwd };
}

async function api(method, path, body, token) {
  const r = await fetch(`${GATEKEEPER}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

// ---- connecting this computer (first run)
async function ensureConnected(cfg) {
  if (cfg.token) return cfg;
  if (cfg.deviceId && cfg.secret) {
    const p = await api("POST", "/v1/devices/poll", { deviceId: cfg.deviceId, secret: cfg.secret });
    if (p.status === 200 && p.body.status === "approved" && p.body.token) {
      const next = { gatekeeper: GATEKEEPER, token: p.body.token, agentId: p.body.agentId };
      saveCfg(next);
      return next;
    }
    if (p.status === 200 && p.body.status === "pending") {
      finish("deny", `Karuna: this computer is waiting to connect. Ask a member to approve code ${cfg.code} in Karuna (Agents → New agent → Coding agents), then try again.`);
    }
    // denied, expired, or unknown: ask again
  }
  let who = "";
  try {
    who = userInfo().username;
  } catch {
    who = "";
  }
  const name = `${who ? `${who}'s ` : ""}${client === "cursor" ? "Cursor" : "Claude Code"} (${hostname()})`.slice(0, 60);
  const d = await api("POST", "/v1/devices", { name, tool: client });
  if (d.status !== 200) finish("deny", `Karuna: couldn't ask to connect this computer (${d.body.error ?? d.status}).`);
  saveCfg({ gatekeeper: GATEKEEPER, deviceId: d.body.deviceId, secret: d.body.secret, code: d.body.code });
  finish("deny", `Karuna: connect this computer first. Ask a member to approve code ${d.body.code} in Karuna (Agents → New agent → Coding agents), then try again.`);
}

async function main() {
  const call = toolCall();
  if (!call.tool) finish("allow");
  let cfg = loadCfg();
  cfg = await ensureConnected(cfg);
  const r = await api("POST", "/v1/hook", call, cfg.token);
  if (r.status === 401) {
    saveCfg({ gatekeeper: GATEKEEPER });
    finish("deny", "Karuna: this computer was disconnected. Try again to reconnect it.");
  }
  if (r.status === 403) finish("deny", "Karuna: this computer's agent needs your team's vote to run outside a sandbox.");
  if (r.status !== 200) finish("deny", `Karuna: ${r.body.error ?? `error ${r.status}`}`);
  if (r.body.decision === "allow") finish("allow");
  if (r.body.decision === "deny") finish("deny", "Karuna blocked this.");
  // Held for a member: wait here (Claude shows the hook running) until it's decided.
  const id = r.body.proposalId;
  process.stderr.write("Karuna: waiting for your team to approve this…\n");
  const until = Date.now() + WAIT_LIMIT_MS;
  while (Date.now() < until) {
    const w = await api("GET", `/v1/hook/${id}/wait?ms=20000`, undefined, cfg.token);
    if (w.status !== 200) finish("deny", "Karuna: lost track of this approval. Try again.");
    if (w.body.status === "allowed") finish("allow");
    if (w.body.status === "denied") finish("deny", "Karuna: a member denied this.");
  }
  finish("deny", "Karuna: still waiting for your team's approval. Try again once it's approved.");
}

main().catch(() => finish("deny", `Karuna isn't reachable at ${GATEKEEPER}, so this was refused. Start Karuna or check the address.`));
