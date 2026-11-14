# PreKaruna

Hackathon build of the Karuna **Organizations layer** (Dharma on Arc, Auto-Shield, Swarm Stopper, live approvals) for UBC 2026.
Read [`CLAUDE.md`](CLAUDE.md) for the product and [`ROADMAP.md`](ROADMAP.md) for the plan.

> *An agent's competence should never be its permission.*

AI agents can now handle a business's money. Karuna makes sure no agent, and no group of agents,
can be tricked into misusing it. **The agent proposes. Karuna decides. People set the rules.**

## Architecture
```
 agents (sandbox: no keys, no wallet)                    members (each browser holds its own key)
   │  propose · read inbox · message                         │  sign votes, rule changes, payment approvals
   ▼  agent API :8787 (agent token)                          ▼  console API :8788 (localhost) ◄── console :5173
┌──────────────────────────── Gatekeeper ─────────────────────────────┐
│ policy engine (first match) ← rules read from Dharma                │
│ Auto-Shield · Swarm Stopper · Trap Passwords · Changed-account alert │
│ Exact Match: executes only the payload hash humans approved          │
│ signed, hash-chained log (ed25519), anchored to Dharma               │
│ holds the Circle Agent Wallet ──► Circle CLI ──► Arc (x402 / USDC)   │
└───────────────┬──────────────────────────────────────────────────────┘
                │ relays member-signed actions; may only TIGHTEN on its own
                ▼
        Dharma contract on Arc ──events──► QuickNode Stream ──webhook (HMAC)──► relay ──WS──► every console
```
- **Three locks:** the Gatekeeper's policy engine, the Dharma contract (rules, allowances, payees,
  freeze, core boundaries), and the wallet itself, which only the Gatekeeper holds. Circle's wallet
  spending limits are mainnet only, so on testnet Dharma + the Gatekeeper enforce limits.
- **Dharma** (`contracts/src/Dharma.sol`): one contract per organization. **Every rule change a member
  makes is a proposal → majority vote → 60s timelock**, even one that tightens. Only two things are
  instant: a member's panic button (freeze all), and the Gatekeeper's own automatic safety blocks
  (Auto-Shield, Swarm Stopper, learned blocks), which can only ever tighten. Dharma enforces both
  (`MembersMustPropose`, `NotTightening`). Core boundaries (`core-boundary`, `secrets-read`,
  `unknown-recipient`, `default-deny`) can't be removed. Every action is an EIP-712 signature from
  a member's own key; the Gatekeeper only relays it.

## Deployed on Arc testnet
| | |
|---|---|
| Organization's Dharma (live console) | [`0xfa5ea10c5cec0f56b350ce41074f01e9618b7c17`](https://testnet.arcscan.app/address/0xfa5ea10c5cec0f56b350ce41074f01e9618b7c17) |
| Gatekeeper's Circle Agent Wallet | [`0x185ea7a520be17f4e5c4504b3581bf6af5018328`](https://testnet.arcscan.app/address/0x185ea7a520be17f4e5c4504b3581bf6af5018328) |

Every new organization deploys its own Dharma at setup; each verification and demo run deploys a
fresh one and prints its explorer link.

## QuickNode Stream (core data source for live alerts)
| Setting | Value | Why |
|---|---|---|
| Network | `arc-testnet` | Dharma lives on Arc |
| Dataset | `logs` | Dharma's events are all we need: approvals requested, proposals, votes, freezes, failed tests |
| Filter | JavaScript (`quickNodeFilterSource()` in `relay/src/events.ts`): keeps only logs whose `topics[0]` is one of Dharma's event signatures | ships a few events instead of every Arc log |
| Destination | webhook → `https://<tunnel>/quicknode/webhook` (relay :8791), `security_token` set, batch size 1 | one event per delivery = lowest latency |
| Verification | relay checks `HMAC-SHA256(token, nonce + timestamp + body)` and rejects replays | an unsigned POST can't fake an alert (returns 401) |

The relay keeps only this organization's Dharma, decodes the event, and pushes it over WebSocket to
every member's console (approval pop-ups, freezes, failed tests) and to the Gatekeeper (instant
policy refresh). A lagged direct-RPC safety net catches anything missed; the console badge shows
which source delivered each alert. Setup: [`docs/QUICKNODE.md`](docs/QUICKNODE.md) ·
`pnpm --dir relay stream:create`.

## Circle tools used
| Tool | How |
|---|---|
| **Circle Agent Wallet** (SCA on `ARC-TESTNET`) | the organization's wallet, held **only** by the Gatekeeper; agents never see it |
| **Circle CLI** | `circle wallet transfer` (USDC bills), `circle services pay` (x402 purchases, with `--estimate` first for Exact Match), `circle wallet execute` (Dharma writes from the wallet), `circle contract deploy` (each org's Dharma), `circle gateway balance`, `circle wallet list` |
| **x402 + Gateway Nanopayments** | agents buy data per request (e.g. $0.001); the Gatekeeper pays from the wallet's Gateway balance and hands the agent only the response |

## Safety rules enforced in code
1. Agents hold no keys, wallet or money (`pnpm --dir agents check:no-keys`).
2. Agents only propose; denials are blank (`denied`), never the reason.
3. Every member rule change is vote + timelock; automatic safety blocks and the panic button are instant and can only tighten; core boundaries can't be removed (contract).
4. Auto-Shield and Swarm Stopper can only add blocks or freeze (`assertShieldSafe`, Dharma's `NotTightening`).
5. What a human approved is exactly what executes (payload hash + re-quote, else refused).
6. Every decision, test, block, trip and approval is in the signed log and anchored on Arc.

## The demo, end to end
```bash
pnpm --dir services/test-seller start   # TEST_SELLER_ADDRESS=0x… ; fake data feed (x402)
VERIFY_WALLET=0x… pnpm --dir gatekeeper demo --runs 3
```
Runs CLAUDE.md's demo script live on Arc, three times in a row, each on a fresh organization:
(1) small x402 purchase paid by the Gatekeeper, (2) a bill over the threshold → approval card →
two members sign → paid, (3) Auto-Shield: fake invoice → $0 moves → category blocked → vote
restores with approval required, (4) changed bank account blocked, (5) trap key shared → all agents
frozen → freeze on the Arc explorer, (6) a proposal to add the scammer's account as a payee →
Preview Before Loosening shows it would have let the scam through → vote fails. Amounts are scaled
for testnet; only fake targets are used.

## What existed before the hackathon
Karuna's website (karunaprotocol.dev) and SDK preview. This repository was started on Nov 9, 2026;
its git history shows what was built when. <!-- TODO before submitting: confirm the prior-work rule with the organizers and state it here. -->

## Layout
| Folder | What |
|---|---|
| `engine/` | Deterministic first-match policy engine + signed log (Phase 1) ✅ |
| `gatekeeper/` | The only process that holds the wallet: proposals, approvals, payments, Exact Match (Phase 2) ✅ |
| Auto-Shield (in `gatekeeper/`) | Fake-scam tests → per-agent, per-category block rules on Dharma; changed-bank-account alerts (Phase 5) ✅ |
| Swarm Stopper + Trap Passwords (in `gatekeeper/`) | Fake keys planted in sandboxes; agent-to-agent messages checked like any proposal; credential sharing or agents converging → freeze all, recorded on Dharma (Phase 6) ✅ |
| `contracts/` | **Dharma** — the org's onchain rulebook on Arc + shared TS vocabulary (Phase 3) ✅ |
| `relay/` | QuickNode Stream → verified Dharma events → every member's console + Gatekeeper refresh; direct-RPC fallback (Phase 4) ✅ |
| `web/` | Karuna Console — the product frontend (setup, approvals, agents, payees, policy, signed log) |
| `agents/` | Agent-side client: propose, read inbox, flag scams; no keys. `examples/payables-agent.ts` (gullible / `--careful`), `examples/swarm-agents.ts` (shares keys it finds) |
| `services/test-seller/` | **Test fixture only** — a local x402 seller used to verify payments |

## Arc testnet facts (verified Nov 9, 2026)
| | |
|---|---|
| Chain ID | `5042002` |
| Public RPC | `https://rpc.testnet.arc.network` (viem default: `rpc.testnet.arc.io`) |
| USDC (ERC-20, 6 decimals) | `0x3600000000000000000000000000000000000000` |
| Gas token | USDC (native, 18 decimals) |
| Explorer | https://testnet.arcscan.app |
| Faucet | https://faucet.circle.com (20 USDC / 2h) or `circle wallet fund` |
| Circle CLI chain id | `ARC-TESTNET` |

**Circle wallet spending limits are mainnet only**, so on testnet Dharma and the Gatekeeper enforce limits.

## Run it locally
```bash
git submodule update --init           # Foundry's forge-std, for the contract tests
pnpm install
cp .env.example .env                  # optional: put your QuickNode Arc URL in ARC_RPC_URL
circle wallet login <email> --testnet # the Gatekeeper pays with this Circle session
pnpm --dir gatekeeper start           # agent API :8787 · console API :8788
pnpm --dir relay start                # live chain events (QuickNode or direct RPC) :8790 / :8791
pnpm --dir web dev                    # console at http://127.0.0.1:5173
```
A new install opens on **setup**: name your organization, pick the wallet, and Karuna deploys your
organization's own **Dharma** contract on Arc with this browser's signing key as its first member.
Then propose agents, payees, and teammates — every change passes by vote after a timelock; only the
panic button applies at once. Nothing about any organization is built in.

Each member uses their own browser: it holds the key that signs their votes and approvals.

### Running agents: always in a Karuna sandbox
Agent tokens only work from inside a box (`KARUNA_REQUIRE_SANDBOX=0` turns that off for local demos;
per agent, a voted `unsandboxed` rule does, and the console shows it as "partially enforced").
Needs Docker. From the repo root:
```bash
KARUNA_AGENT_TOKEN=kag_… pnpm karuna run --agent invoice-bot ./invoice-bot -- python main.py
```
The box has no network except the Gatekeeper's egress proxy (every request checked against Dharma),
no host files unless `--mount`ed (read-only by default), and no real keys: add keys on the console's
**Keys** page and the proxy swaps the placeholder for the real value only on the service it's bound
to. An x402 seller's 402 becomes a Karuna payment. The panic button stops every box. See
[docs/SANDBOX_PLAN.md](docs/SANDBOX_PLAN.md).

- **Another machine** (teammate laptop, cloud VM): start the Gatekeeper with
  `KARUNA_REMOTE_PORT=8443 KARUNA_REMOTE_HOST=0.0.0.0 KARUNA_PUBLIC_HOSTS=<its name>`, download
  `karuna-ca.pem` from the console (Agents → Run on another machine), then on that machine:
  `pnpm karuna run --agent <id> --gatekeeper https://<name>:8443 --ca karuna-ca.pem ./agent -- …`.
- **Isolation:** `--isolation auto` (default) uses gVisor when Docker has the `runsc` runtime, else
  hardened Docker. `KARUNA_REQUIRE_ISOLATION=gvisor` makes the Gatekeeper refuse anything weaker.
- **Computer-use agents:** `--desktop` gives the box a virtual screen, Chromium (`$KARUNA_BROWSER`),
  xdotool and ImageMagick. The runner prints a live view URL (this machine only); the console's
  Watch button opens it. The browser's traffic goes through the same proxy and rules.

For x402 services the wallet also needs a Gateway balance:
`circle gateway deposit --amount 1 --address 0x… --chain ARC-TESTNET --method direct`.

## Tests
```bash
pnpm --dir engine test       # policy engine + signed log + Dharma rule ordering
pnpm --dir contracts test    # Dharma (forge)
pnpm --dir gatekeeper test   # gatekeeper against the real Dharma on a local chain (anvil)
pnpm --dir relay test        # QuickNode signature, replay, decoding, filter
pnpm --dir agents check:no-keys
# live, on Arc testnet (needs the test seller running):
TEST_SELLER_ADDRESS=0x… pnpm --dir services/test-seller start
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase2   # payments (needs the test seller)
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase3   # Dharma: tighten / loosen / core / explorer
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase5   # Auto-Shield: fake invoice → block onchain → vote restores
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase6   # Swarm Stopper: trap key shared → all 3 agents frozen → freeze on explorer
```

Tools: Node ≥ 22, pnpm, [Circle CLI](https://developers.circle.com/agent-stack/circle-cli/command-reference) (`npm i -g @circle-fin/cli`), [Foundry](https://getfoundry.sh).

## Desktop app (Windows first): console + island
`desktop/` is a Tauri 2 shell around the console. It does not copy the console: the `main` window
loads `web/` from its dev server, and the island imports the site's visuals from `web/src/site/`.

Needs: Node 22+, Rust (MSVC toolchain), Visual Studio Build Tools with the C++ workload + Windows SDK.
```bash
cd desktop && npm run tauri dev     # starts the console dev server if needed, then the app
```
- **`main`**: the console, 1280×800, with the site's marbled background behind it (the browser
  console has it too). Closing it hides Karuna to the tray and the island takes over; **Quit** in
  the tray menu exits.
- **island**: appears when `main` is minimized and hides when it's restored. A black notch at the
  top center of that monitor retracts to a thin strip; hover the strip to slide it down; empty
  areas are click-through. Click the pill to restore the console. Drag the lotus out to float it
  anywhere; drag it back to the top center to dock. Mode and position persist. While an approval is
  pending the island stays open. Tray: Open Karuna, Pause/Resume agents, Quit.
- **States**: idle, working, pending approval, approved, denied, paused (plus offline when the
  Gatekeeper isn't running; it retries quietly).

### Installer (Windows)
```bash
cd desktop && npm run tauri build     # -> src-tauri/target/release/bundle/nsis/Karuna_0.1.0_x64-setup.exe
```
The installed app doesn't bundle the Gatekeeper or the console: it opens a launch page that waits
for the console, then switches to it. Run them from the Karuna folder:
```bash
pnpm --dir gatekeeper start
pnpm --dir web build && pnpm --dir web preview    # the built console on 127.0.0.1:4173
```
(`vite preview` uses the same proxy as dev, so the console token stays server-side.)

### Pipe protocol: `\.\pipe\karuna`
Newline-delimited JSON, served by the Gatekeeper (`gatekeeper/src/pipe.ts`).

| Direction | Message |
|---|---|
| out | `decision` `{id, action_type, summary, result: "allow"\|"deny"}` |
| out | `approval_requested` `{id, action_type, payload, payload_hash, reversible, agent_reason, expires_at}` |
| out | `approval_resolved` `{id, result: "approved"\|"denied"\|"failed"}` |
| out | `agent_paused` `{by, at}` · `agent_resumed` · `error` `{id?, error}` |
| in | `approval_response` `{id, payload_hash, decision: "approve"\|"deny", signer, deadline, signature}` |
| in | `pause` `{by}` · `resume` `{by}` (the local pause: instant, never onchain; not the Dharma freeze) |

An approval over the pipe is never trusted on its own. The island asks the console window to sign
the exact id + payload hash + decision with this member's key; the app forwards it only if it still
matches the pending request; the Gatekeeper checks id and hash again and verifies the signature
against Dharma's members. Stale or mismatched responses are ignored on both sides.

### Testing the island without the engine
```bash
cd desktop && npm run mock          # stop the real Gatekeeper first: same pipe name
cd desktop && npm run mock -- --loop
```
The mock plays a few auto decisions, one approval request (with a deliberately HTML-looking agent
reason, which must render as plain text), one deny, then a pause and a resume. It checks id and
hash on every approval response and requires a signature to be present (it can't verify one
without the chain; the real Gatekeeper does).
