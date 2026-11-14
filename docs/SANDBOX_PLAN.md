# Karuna Sandbox: implementation plan

> **Status (Nov 2026):** S1–S6 built and verified end to end in real Docker boxes
> (`gatekeeper/scripts/sandbox-harness.ts`), plus gVisor support and desktop boxes for computer-use
> agents. Code: `gatekeeper/src/{proxy,ca,secrets,remote}.ts`, sandbox section of `gatekeeper.ts`,
> `runner/`, Keys page + live runs + remote panel in `web/`. Not built: microVM isolation.
>
> Naming: a **desktop box** (`karuna run --desktop`) is a sandbox with a virtual screen for
> computer-use agents. It is unrelated to the Karuna desktop app (the Windows shell + island).

> Goal: **every agent runs in a Karuna sandbox, and the sandbox's only way out is Karuna.**
> Money is already enforced (only the Gatekeeper holds the wallet). This plan enforces everything
> else the same way: network, credentials, files, and agent-to-agent contact.

## Why

Today an agent is any program on any machine. It *asks* Karuna before paying, and it can't skip
that because it has no wallet. For everything else it is on the honor system: Karuna returns
`allowed` / `denied` for shell, file and HTTP proposals, but nothing stops an agent from never
asking. A program running as your user can read your files, call any website, and leak anything
it has seen.

Enforcement comes from controlling **what the agent can reach**, not what it promises. After this
plan:

| Capability | How it's enforced |
|---|---|
| Money | Unchanged: only the Gatekeeper's wallet can pay |
| Network | The sandbox has no internet. Its one exit is Karuna's egress proxy, which checks every request against Dharma |
| Credentials (LLM keys, Gmail, GitHub, Stripe…) | Real keys live in the Gatekeeper. The agent holds placeholders; the proxy adds the real key on the way out, only for the service it's bound to |
| Files | The agent sees an empty, throwaway workspace. Host folders appear only if mounted (read-only by default; writable needs a vote) |
| Shell | Unrestricted, but only inside the box. It's wiped after every run |
| Other agents | Containers can't see each other. The only channel is a Karuna message (already checked today) |

## How it works

```
 ┌─────────── host (or teammate laptop / cloud VM) ───────────┐
 │                                                             │
 │  karuna run ──► docker                                      │
 │                  │                                          │
 │   ┌──────────────▼───────────────┐   karuna-sandbox net     │
 │   │ agent container               │   (docker --internal:   │
 │   │  - non-root, read-only rootfs │    no route out)        │
 │   │  - /workspace tmpfs           │                         │
 │   │  - HTTP(S)_PROXY=egress       │──► egress relay ──┐     │
 │   │  - OPENAI_API_KEY=karuna-…    │   (socat, fixed    │     │
 │   │  - Karuna CA trusted          │    target only)    │     │
 │   └───────────────────────────────┘                    │     │
 │                                                        ▼     │
 │                      Gatekeeper  :8789 egress proxy (new)    │
 │                        - who: per-run session token          │
 │                        - decide: engine + Dharma rules       │
 │                        - inject real key / hold for approval │
 │                        - x402 → existing payment flow        │
 │                        - signed log, traps, swarm, freeze    │
 └──────────────────────────────────────────────────────────────┘
```

- The proxy lives **inside the Gatekeeper** (one source of truth, and the keys never leave the
  process that already guards the wallet). It's a third surface next to the agent API (:8787) and
  console API (:8788): **`:8789`, egress proxy, sessions only.**
- The sandbox network is created with `docker network create --internal karuna-sandbox`: no route
  to the internet or the host. A tiny **relay container** sits on both that network and the default
  bridge, and forwards one port to the Gatekeeper's proxy (`host.docker.internal:8789`). It can't be
  pointed anywhere else.
- **Identity:** `karuna run` asks the Gatekeeper for a short-lived **run session** (using the
  agent's `kag_` token, on the runner side only). The container gets the session in its proxy URL
  (`http://sess_…@karuna-egress:3128`), so every request the proxy sees is tied to one agent and one
  run. The `kag_` token itself does not enter the box.

## Bringing an existing agent in

1. **Keys page (new):** move the agent's keys into Karuna. Each key gets a placeholder env name and
   the service(s) it's bound to, e.g. `OPENAI_API_KEY → api.openai.com`. The *binding* is a Dharma
   rule (voted, onchain); the *value* is stored only by the Gatekeeper, encrypted at rest.
2. **Agents page:** propose the agent as today (vote + timelock).
3. **Run it boxed:**
   ```bash
   karuna run --agent invoice-bot --mount C:\invoices:/data ./invoice-bot -- python main.py
   ```
4. **Code changes:** none, except replacing self-signed payments with `karuna.pay()`. Payments to
   x402 services need no change at all: the proxy turns an HTTP 402 into a payment proposal.

Works unchanged for anything that honors `HTTP_PROXY`/`HTTPS_PROXY` and the system CA store: Python
`requests`/`httpx`, Node `fetch`/`undici`, the OpenAI and Anthropic SDKs, LangChain, CrewAI, the
Claude Agent SDK. Programs that ignore the proxy simply can't connect (safe failure).

## Decisions made

- **TLS interception: yes.** The Gatekeeper generates a per-org CA on first run; the runner trusts
  it inside the box (`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, system store).
  Needed for key injection and per-path rules. Cost: clients that pin certificates won't work (rare
  in agent stacks); they'll fail closed.
- **No Dharma contract change.** Rule `scope`/`target` are strings, so new kinds are new strings:
  - `http:GET|POST|…` scope with `target` = `domain[/path-prefix]` (today `http` matches domain only)
  - `key:<name>` scope, `target` = bound domain: lets the proxy attach that key there
  - `mount` scope, `target` = host path: allows a **writable** mount (read-only needs no rule)
  - `unsandboxed` scope, `target` = agent id: lets an agent use the API without a sandbox
  All are loosenings, so they go to a vote. Removing any of them is a tightening (instant).
- **Sandbox required by default.** If an agent has no `unsandboxed` rule, the agent API refuses
  calls that don't come with a live run session. Agents on platforms we can't install on need that
  rule, and the console labels them **"partially enforced"**.
- **Fresh box every run** (`--rm`, tmpfs workspace): "no memory between tasks" from `CLAUDE.md`.
  Persistent state, if an agent truly needs it, is a mounted folder you chose.

## Changes by package

### `engine/`
- `customRule`: support `http:<METHOD>` scopes and `domain/path-prefix` targets (keep plain `http`
  working). Add `key:` / `mount` / `unsandboxed` scopes as non-matching for requests (they are
  capability grants the Gatekeeper reads, not request rules).
- Keep the default rules generic. When you bind an LLM key, the Keys page also proposes an allow
  rule `http:POST → api.openai.com/v1/`, so model calls don't each need approval. (Today every POST
  to an allowlisted domain hits `http-mutations` and needs approval, which would block LLM calls.)
- Tests: method/path matching, precedence vs. `http-mutations` and `unlisted-domain`.

### `gatekeeper/`
- `proxy.ts` (new): HTTP proxy + `CONNECT` with on-the-fly leaf certs from the org CA
  (`node-forge` or `@peculiar/x509`). For each request:
  1. resolve session → agent; deny if session expired, agent inactive, or org frozen;
  2. trap check on URL/headers/body (reuse `findTrap`) → taint / swarm trip as today;
  3. swarm convergence check on new targets (reuse `pivots`);
  4. evaluate `{ tool: "http", method, url }` with the engine and Dharma rules;
  5. **allow** → strip placeholder, attach bound key if any, forward, stream response back;
     **approval** → create a proposal (Facts First: host, path, method, body size/preview, which key
     would be attached), hold the connection up to `KARUNA_HOLD_SECONDS` (default 120), then 403
     `karuna: pending <id>`. Once approved, a one-time grant for the same request hash for 10 min.
     **deny** → 403 with a blank reason (same as the agent API today);
  6. upstream `402` with x402 headers → `propose(agent, { type: "x402", url, method, body })`; if it
     pays, return the seller's paid response as `200`.
  Every decision goes to the signed log, like agent-API decisions.
- `secrets.ts` (new): store key values encrypted at rest (AES-GCM, key in the data dir next to
  `console.token`); console API to add/rotate/delete (member-signed, like other console writes);
  values are never returned to any client after entry.
- `sessions.ts` (new): `POST /v1/sessions` on the agent API (Bearer `kag_`) → `{ session, caPem,
  proxyHost, placeholders }`; heartbeat; expiry; list for the console.
- Agent API: if the agent has no `unsandboxed` rule, require a valid session on `/v1/*`.
- Freeze: proxy denies everything at once, and the Gatekeeper tells runners (via heartbeat reply)
  to stop their containers.

### `runner/` (new workspace package, the `karuna` CLI)
- `karuna run --agent <id> [--gatekeeper URL] [--mount host[:container][:rw]] [--image IMG | DIR] -- CMD…`
- Ensures the `karuna-sandbox` network and relay container exist.
- Builds `DIR` on a Karuna base image (`sandbox-python`, `sandbox-node`, auto-picked from
  `requirements.txt` / `package.json`) or uses `--image`.
- Container flags: `--network karuna-sandbox --read-only --tmpfs /tmp --tmpfs /workspace
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 2g --cpus 2
  --user 10001 --rm`, no Docker socket, only the listed mounts (`:ro` unless a `mount` rule allows rw).
- Env: proxy URL with session, placeholders for each bound key, CA paths, `KARUNA_GATEKEEPER_URL`
  (reachable through the proxy) so `karuna.pay()` and the inbox still work from inside.
- Streams logs; exits with the agent's exit code; heartbeats the session; stops on freeze.

### `agents/`
- SDK: when `HTTPS_PROXY` points at Karuna, use it (it already will via env). No API break.
- Examples: run all four examples through `karuna run`; delete any leftover direct-network code.
- `check:no-keys` stays; add the same scan as a pre-run check in the runner.

### `web/` (console)
- **Keys** page: add / rotate / remove keys, bound services, placeholder names; never shows values.
- **Agents**: enforcement badge per agent (**Sandboxed** / **Partially enforced**), live run
  sessions (started, last request, stop button), and the exact `karuna run` command to copy.
- **Approvals**: an HTTP approval card (method, host, path, body preview, attached key) next to
  payment cards.
- **Activity**: proxy decisions in the same signed stream.

## Phases (each ends with "It works if…")

| Phase | What | It works if… |
|---|---|---|
| S1 | Box + network lock-down: runner, internal network, relay, proxy with **CONNECT by domain only** | From inside the box: `curl https://example.com` fails, `curl https://api.github.com` works (allowlisted), `curl 1.1.1.1` fails (no route), `rm -rf /` leaves the host untouched, and the box is gone after exit |
| S2 | TLS interception, method/path rules, held approvals | A `POST` to an allowlisted domain shows an approval card and completes after approval; a `GET` passes; a path-blocked endpoint is denied |
| S3 | Keys: secret store, placeholders, injection, Keys page | The OpenAI SDK inside the box works with `OPENAI_API_KEY=karuna-managed`; the real key appears in no file, env var or process inside the box; using the placeholder against any other host is denied |
| S4 | x402 through the proxy, `karuna.pay()` from inside, freeze → stop | Plain `fetch` to the test seller buys data (Gatekeeper pays, Arc tx in Activity); panic button stops running boxes within seconds |
| S5 | Sandbox required by default, enforcement badges, `unsandboxed` rule | A `kag_` token used outside a box is refused; after a vote on `unsandboxed`, it works and the agent shows "Partially enforced" |
| S6 | Remote runner: teammate laptop / cloud VM | `karuna run --gatekeeper https://…` on a second machine runs a boxed agent under the same Dharma rules (needs the Gatekeeper's agent API + proxy exposed over TLS with auth; today they bind to 127.0.0.1) |
| S7 ✅ | gVisor: `--isolation auto|gvisor|docker`; org can require it (`KARUNA_REQUIRE_ISOLATION=gvisor`) | Without runsc, auto falls back to hardened Docker and says so; `--isolation gvisor` refuses to start |
| S8 ✅ | Desktop boxes (`--desktop`): Xvfb + window manager + Chromium (proxy + org CA via NSS, background services off), xdotool/ImageMagick, noVNC viewer on 127.0.0.1 only | Chromium loads an allowed page through the proxy and is denied an unlisted one (signed log); screenshot + click work; raw sockets fail; viewer answers locally |
| Later | microVM isolation (Firecracker / Kata) | — |

## Risks and open questions

- **Containers aren't VMs.** A kernel exploit could escape Docker. Hardening flags reduce that; for
  high-risk agents, S-later swaps the runtime for gVisor (`--runtime=runsc`) or Firecracker.
- **Cert pinning** in a client breaks under interception. It fails closed; document which known
  clients pin.
- **Approval latency:** holding a connection for 120 s can trip client timeouts. The agent sees a
  403 with the proposal id and can retry after approval (the one-time grant makes the retry pass).
- **Exfiltration through allowed services** (e.g. writing data into a GitHub issue). Mitigated by
  method/path rules and `http-mutations` approvals; not eliminated. Worth a body-size limit on
  allowed POSTs without approval.
- **Windows:** Docker Desktop on WSL2 supports `--internal` networks and `host.docker.internal`;
  verify the relay path on this machine in S1.
- **Remote Gatekeeper exposure (S6)** is a real security change: TLS, rate limits, and session
  binding must land before any port leaves 127.0.0.1.
