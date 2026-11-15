# PreKaruna

Hackathon build of the Karuna **Organizations layer** for UBC 2026: Dharma (the org's rulebook on
Arc), Drills, Tripwire, live approvals, sandboxed agents and the desktop island.
Read [`CLAUDE.md`](CLAUDE.md) for the product and [`ROADMAP.md`](ROADMAP.md) for the plan.

> *An agent's competence should never be its permission.*

AI agents can now spend a business's money, call its APIs, run commands and message each other.
Karuna makes sure no agent, and no group of agents, can be tricked into misusing that.
**The agent proposes. Karuna decides. People set the rules.**

## Architecture
```
 agents, each in a Karuna sandbox                        members (each browser holds its own key)
 (no keys, no wallet, no network except Karuna)              │  sign votes, rule changes, approvals
   │  every request goes through the egress proxy            ▼
   ▼  agent API :8787 · proxy per run              console API :8788 (localhost) ◄── console :5173 / desktop app
┌──────────────────────────── Gatekeeper ──────────────────────────────┐
│ policy engine (first match) ← rules read from Dharma                  │
│ egress proxy: TLS + plain HTTP, key placeholders swapped on the way   │
│ Drills · Tripwire · trap passwords · changed-account alert            │
│ Exact Match: executes only the payload hash humans approved           │
│ signed, hash-chained log (ed25519), anchored to Dharma                │
│ holds the Circle Agent Wallet ──► Circle CLI ──► Arc (x402 / USDC)    │
└───────────────┬────────────────────────────────────────────────────────┘
                │ relays member-signed actions; may only TIGHTEN on its own
                ▼
     Dharma on Arc (proxy + code) ──events──► QuickNode Stream ──webhook (HMAC)──► relay ──WS──► every console
```
- **Three locks:** the Gatekeeper's policy engine, the Dharma contract, and the wallet itself, which
  only the Gatekeeper holds. Circle's wallet spending limits are mainnet only, so on testnet Dharma
  and the Gatekeeper enforce limits.
- **Agents only propose.** A denial is a blank `denied`, never the reason, so an agent can't learn
  which wording gets through.

## Agent decision loop
1. **The agent acts.** It runs in a Karuna sandbox with no keys, no wallet and no network. Every
   payment, web request, shell command, file access or message to another agent leaves the
   sandbox as a request to the Gatekeeper.
2. **Karuna checks the facts.** It works out who is asking, the exact payee, amount and target, and
   the agent's spend so far today. These come from the request, never from the agent's explanation.
3. **The rules decide.** The policy engine reads the org's rules from Dharma on Arc and the first
   matching rule gives one of three answers:
   - **allow**: the action goes ahead now (within the agent's trust level);
   - **ask**: an approval card appears on every member's screen through the QuickNode Stream, with
     Karuna's facts on top and the agent's reason boxed as "may not be true";
   - **deny**: the agent gets a blank `denied`, with no reason to learn from.
4. **The Gatekeeper executes.** Only the Gatekeeper holds the Circle Agent Wallet. It pays in USDC
   on Arc (x402 for data, transfers for bills) and executes exactly the payload that was allowed or
   approved, checked by hash (Exact Match).
5. **Everything is recorded.** Each decision goes into a signed, hash-chained log, which is
   anchored to Dharma on Arc.
6. **Karuna watches for patterns.** Drills, Tripwire and the changed-account alert can block an
   agent or freeze every agent instantly. Only a member vote loosens things again.

## Dharma: who can change what
Dharma (`contracts/src/Dharma.sol`) is one contract per organization. Every member action is an
EIP-712 signature from that member's own key; the Gatekeeper relays it and pays gas but can't forge
or alter it.

| Change | Who votes | Wait (default) | Wait can be skipped? |
|---|---|---|---|
| Normal change (rules, agents, payees, domains, allowances, members, the normal wait) | majority | 60 s (0 s – 7 days) | yes, if **every** member signs (teams of 2+) |
| Unfreeze | majority | the normal wait | no |
| **Core change**: removing a core rule, changing the core wait, upgrading Dharma's code | **every member** | 24 h (60 s – 30 days) | no |
| Freeze all agents | any one member | none | — |
| Automatic safety blocks (Drills, Tripwire, learned blocks) | the Gatekeeper alone | none | tighten-only |

- **Tighten fast, loosen slow.** Only Freeze and the Gatekeeper's automatic blocks are instant, and
  the contract decides what counts as tightening (`MembersMustPropose`, `NotTightening`).
- **Freeze beats everything.** It's instant for any member, and it cancels every pending core change.
- **Waits are fixed when a proposal passes**, so changing a wait never speeds up a proposal already
  waiting. Lowering a wait itself waits out the current one.
- **Upgradeable, same address.** Each org is a `DharmaProxy` (ERC-1967) pointing at the Dharma code.
  An `Upgrade` is a core change, so new code ships with every member's signature and the core wait;
  members, rules, payees and signatures carry over.

## Rules
The engine checks rules in this order; the first match decides:
1. **Core rules** (`core-boundary`, `secrets-read`, `unknown-recipient`, `default-deny`): catastrophic
   shell commands, reading secrets, paying unknown addresses, and anything unmatched are blocked.
   They change only by a core change; if the chain doesn't mention one, it still applies (fail closed).
2. **Your blocks**, then **your approvals**, then **your allows**.
3. **Defaults**: allowance payments, approval for big payments / file writes / package installs /
   `rm -rf` / POSTs, allowlisted GETs, `./workspace` reads.

A custom rule covers any kind of agent action, for every agent or one:

| Action | Rule target | Example |
|---|---|---|
| Payments | payee, category, optional cap on allows | *Allow payments for supplies to Acme up to $50* |
| Web requests | site or path, optional method | *Require approval for POST requests to api.github.com* |
| Shell commands | start of the command, or a `*` pattern | *Block shell commands starting with `git push`* |
| Files | folder or `*` pattern, read and/or write | *Require approval for file writes in `finance`* |
| Messages | the agent being messaged | *Block messages to the payables agent for research* |

**Plain-English rules.** On the Rules page a member can describe a policy in English. The Gatekeeper
asks a free model (Gemini's free tier by default) to draft rules, checks each draft against the
org's real agents and payees, and shows it as the exact rule and sentence that would be voted on.
The model never proposes anything. Only free models are used, tried in order until one answers:
Gemini (`gemini-3.8-flash`, then `gemini-3.5-flash-lite`), then Groq (`openai/gpt-oss-20b`). Add free keys
on the Keys page named `gemini` (aistudio.google.com, service `generativelanguage.googleapis.com`) and/or
`groq` (console.groq.com, service `api.groq.com`). A sentence that drafted once is saved and comes back
instantly with no model call, so a rehearsed demo sentence can't fail. Models: `KARUNA_DRAFT_MODEL`,
`KARUNA_DRAFT_FALLBACK_MODEL`, `KARUNA_DRAFT_GROQ_MODEL`. Without a key the form works by hand.

## Trust levels
An agent earns autonomy the way a new hire does: a little at first, more as its record earns it,
and all of it pulled back the moment something goes wrong. Each agent's level lives on Dharma (v3).

| Level | Pays without asking (per payment / per day) | Also without asking | To get here |
|---|---|---|---|
| 0 Restricted | $0.10 / $1 | nothing else | every new agent |
| 1 Limited | $0.50 / $5 | messages to other agents, file writes in `./workspace` | 10 clean actions, then a vote |
| 2 Standard | $2 / $20 | POST/PUT/DELETE to allowlisted domains, package installs | 25 clean actions, then a vote |
| 3 Extended | $5 / $50 | file writes anywhere in the sandbox | 50 clean actions, then a vote |

- **What a level never changes.** Core rules, and the org's own block and approval rules, always come
  first (rule order: core → blocks → approvals → **level** → allows → defaults). `rm -rf`, unknown
  payees, secrets and unlisted domains stay off at every level. The payment limits per level are
  changed by vote; the ladder of other permissions is the same for every org.
- **Raising is slow, lowering is instant.** A level goes up one step at a time, by majority vote and the
  wait, and only once the agent has enough *clean* actions: completed since its last level change,
  failed Drill or Tripwire. Any member can lower a level at once. A Tripwire drops the agent to
  Level 0 and a failed Drill drops it one level, automatically, recorded on Dharma.
- **The record is onchain, and read through QuickNode.** With every log anchor the Gatekeeper
  publishes each agent's running totals (`ActionsRecorded`); Dharma itself emits level changes,
  failed Drills and Tripwires. The relay rebuilds every agent's record from these events, delivered
  by the QuickNode Stream backfilled from Dharma's deploy block, and the Gatekeeper refuses to relay
  a level-up proposal the record doesn't support. Members still vote on it.
- **Upgrading an older org.** On the Votes page, *Propose upgrade to v3* deploys the new code and
  proposes the upgrade. It's a core change: every member signs and the core wait passes. The org
  keeps its address, members, agents, payees and rules, and every agent starts at Level 0.

## Safety features
- **Drills:** Karuna sends agents fake scam messages. An agent that falls for one is blocked from
  what the scam asked for, onchain, until members restore it by vote. Only people can see which
  messages were drills.
- **Tripwire:** agents never get real passwords, so any password an agent uses is bait. Sharing one,
  or two agents going after the same new target within 60 s, freezes every agent, recorded on Dharma.
- **Changed bank account alert:** a known supplier's name with a different account is blocked and
  flagged.
- **Exact Match:** what a member approved (payload hash, re-quoted price) is exactly what executes.
- **Wallet watchdog:** the QuickNode Stream also watches every USDC transfer leaving the org's wallet.
  Each one must match a payment Karuna made (same payee, same amount); deposits into Circle Gateway
  stay the org's money. Anything else means the wallet was used outside Karuna, so every agent
  freezes and the transfer is recorded on Dharma (`UnapprovedTransfer`). Limits: x402 purchases are
  paid from the Gateway balance and settled by Circle in batches, so they don't show up one by one;
  the watchdog covers the wallet itself. The automatic freeze runs in the Gatekeeper, so a fully
  compromised Gatekeeper could skip it, but the relay still pushes the alert to every member's screen.
- **Learns from your choices:** a "no" becomes a block at once; a "yes" becomes a suggested rule only
  after repeated approvals and a vote. **Preview before loosening** replays recent requests under a
  proposed change.

## Safety limits
| Limit | Default | Who can change it |
|---|---|---|
| Payment to an address that isn't a known payee | always denied (core rule) | every member + 24 h wait |
| Reading secrets, catastrophic shell commands (`rm -rf /`, etc.) | always denied (core rule) | every member + 24 h wait |
| Anything no rule covers | denied (core rule) | every member + 24 h wait |
| Payment to a known payee | allowed within the agent's **trust level**: per payment and per day (Level 0: $0.10 / $1) | majority vote + wait (the level's limits) |
| Payment over the level's limits | needs a member's approval | majority vote + wait |
| Payment above the two-person threshold | needs **two** members' approval | majority vote + wait |
| `rm -rf <path>` | needs a member's approval at every level | majority vote + wait |
| File writes, package installs, POST/PUT/DELETE, messages to other agents | need approval until the agent's level allows them (see Trust levels) | majority vote + wait |
| Raising an agent's level | needs a clean record (10 / 25 / 50 actions) from the Stream, one level at a time | majority vote + wait |
| Lowering an agent's level | instant: any one member, or automatically (Tripwire → Level 0, failed Drill → one level down) | — |
| USDC leaving the wallet that Karuna didn't pay | **every agent frozen**, recorded on Dharma (wallet watchdog) | majority vote + wait to unfreeze |
| Web requests | GET only to allowlisted domains; everything else denied | majority vote + wait |
| Approved payment | executes only if the payload hash and price still match | can't be changed |
| Agent falls for a Drill | blocked from that kind of action until a vote restores it, and one level lower | majority vote + wait |
| Agent uses a trap password, or 2 agents go after the same new target within 60 s | **every agent frozen** | majority vote + wait to unfreeze |
| Panic button | any one member freezes every agent at once | majority vote + wait to unfreeze |
| Agent keys and the wallet | never inside the sandbox; the Gatekeeper swaps placeholders on the way out | can't be changed |

## Deployed on Arc testnet
| | |
|---|---|
| Organization's Dharma (dev org, v2 proxy) | [`0x6a1e15aaf824f51119c4a6e3493085c606b5d843`](https://testnet.arcscan.app/address/0x6a1e15aaf824f51119c4a6e3493085c606b5d843) |
| Gatekeeper's Circle Agent Wallet | [`0xe78f1b83b5f995a8c5fbc3b4ad1f3639fe6002ea`](https://testnet.arcscan.app/address/0xe78f1b83b5f995a8c5fbc3b4ad1f3639fe6002ea) |

Every new organization deploys its own Dharma (code + proxy) at setup; each verification and demo
run deploys a fresh one and prints its explorer link.

## QuickNode Stream (live alerts, the wallet watchdog, and each agent's record)
One Stream, `karuna-events`, feeds the relay (QuickNode's free plan allows one, and one filter can
keep both kinds of log). Created by `pnpm --dir relay stream:create`.

| Setting | Value | Why |
|---|---|---|
| Network | `arc-testnet` | Dharma and the org's wallet are on Arc |
| Dataset | `logs` | Dharma's state changes and USDC transfers are both logs |
| Range | `start_range` = the block Dharma was deployed in, no `end_range` | replays the org's whole history, then follows the chain: that history is each agent's record |
| Filter | JavaScript (`quickNodeCombinedFilterSource(wallet)` in `relay/src/events.ts`) that keeps two things and drops every other Arc log: **Dharma's events** (`topics[0]` is one of Dharma's event signatures) as `dharmaLogs`, and **USDC leaving the org's wallet** (`Transfer` logs from Arc's USDC, the ERC-20 interface `0x3600…0000` with 6 decimals or the native USDC system address `0xffff…fffe` with 18, whose `from` topic is the wallet) as `walletTransfers` | each delivery carries only what the relay acts on |
| Destination | webhook → `https://<tunnel>/quicknode/webhook` (relay :8791), `security_token` set, batch size 1 | one block per delivery = lowest latency for approval pop-ups |
| Verification | the relay checks `HMAC-SHA256(token, nonce + timestamp + body)` and rejects replays | an unsigned POST can't fake an alert or a transfer (401) |

What the relay does with it:
- **Dharma's events**: approval pop-ups, votes, freezes and level changes on every member's screen;
  and each agent's record for trust levels (`ActionsRecorded`, `LevelSet`, `TestFailed`,
  `TripwireFired`), rebuilt in chain order and sent to the Gatekeeper.
- **USDC leaving the wallet**: the wallet watchdog. Each transfer must match a Karuna payment or
  every agent freezes (see Safety features).

If the Stream goes quiet the relay reads Arc directly and de-duplicates; the top bar shows which
source is live (`QuickNode` or `Arc`). Setup: [`docs/QUICKNODE.md`](docs/QUICKNODE.md) ·
`pnpm --dir relay stream:create` (add `--backfill` to recreate it from the deploy block).

## Circle tools used
| Tool | How |
|---|---|
| **Circle Agent Wallet** (SCA on `ARC-TESTNET`) | the organization's wallet, held **only** by the Gatekeeper; agents never see it |
| **Circle CLI** | `circle wallet transfer` (USDC bills), `circle services pay` (x402 purchases, `--estimate` first for Exact Match), `circle wallet execute` (Dharma writes), `circle contract deploy` (each org's Dharma code and proxy), `circle gateway balance`, `circle wallet list` |
| **x402 + Gateway Nanopayments** | agents buy data per request (e.g. $0.001); the Gatekeeper pays from the wallet's Gateway balance and hands the agent only the response |

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
A new install opens on **setup**: name the organization, pick the wallet, and Karuna deploys the
org's own Dharma on Arc with this browser's signing key as its first member. Then propose agents,
payees and teammates. Each member uses their own browser, which holds the key that signs their votes
and approvals. New orgs take their waits from `KARUNA_TIMELOCK_SECONDS` (default 60) and
`KARUNA_CORE_TIMELOCK_SECONDS` (default 86400).

### Running agents: always in a Karuna sandbox
Agent tokens only work from inside a box (`KARUNA_REQUIRE_SANDBOX=0` turns that off for local demos;
per agent, a voted `unsandboxed` rule does). Needs Docker. From the repo root:
```bash
KARUNA_AGENT_TOKEN=kag_… pnpm karuna run --agent invoice-bot ./invoice-bot -- python main.py
```
The box has no network except the Gatekeeper's egress proxy (every request checked against Dharma,
TLS and plain HTTP alike), no host files unless `--mount`ed (read-only by default), and no real keys:
add keys on the **Keys** page and the proxy swaps the placeholder (`karuna_key_<name>`) for the real
value only on the service it's bound to. An x402 seller's 402 becomes a Karuna payment. Freeze stops
every box. See [docs/SANDBOX_PLAN.md](docs/SANDBOX_PLAN.md).

- **Another machine:** start the Gatekeeper with `KARUNA_REMOTE_PORT=8443 KARUNA_REMOTE_HOST=0.0.0.0`
  (and `KARUNA_PUBLIC_HOSTS=<its LAN or VPN name>`), download `karuna-ca.pem` from Agents → Run on
  another machine, then: `pnpm karuna run --agent <id> --gatekeeper https://<name>:8443 --ca karuna-ca.pem ./agent -- …`.
- **Isolation:** `--isolation auto` (default) uses gVisor when Docker has the `runsc` runtime, else
  hardened Docker. `KARUNA_REQUIRE_ISOLATION=gvisor` makes the Gatekeeper refuse anything weaker.
- **Computer-use agents:** `--desktop` gives the box a virtual screen and Chromium; the runner prints a
  live view URL. The browser's traffic goes through the same proxy and rules.

For x402 services the wallet also needs a Gateway balance:
`circle gateway deposit --amount 1 --address 0x… --chain ARC-TESTNET --method direct`.

### Example agents (`agents/examples/`)
| File | What |
|---|---|
| `claude-agent.ts` | Claude Sonnet 5.5 test agent (`http_request`, `read_inbox`), run in a box. Uses the `anthropic` key from the Keys page via its placeholder; at most 10 model calls per run, prints token cost (a few cents) |
| `test-agent.ts` | scripted walkthrough: an allowed GET, a denied GET, a POST held for approval, the inbox |
| `payables-agent.ts` | pays invoices from its inbox (gullible, or `--careful` to flag scams) |
| `swarm-agents.ts` | a "helpful" agent that shares credentials it finds (the Tripwire demo) |
| `grok-agent.ts` | the same Karuna tools driven by Grok (xAI) |

## The demo, end to end
```bash
pnpm --dir services/test-seller start   # TEST_SELLER_ADDRESS=0x… ; fake data feed (x402)
VERIFY_WALLET=0x… pnpm --dir gatekeeper demo --runs 3
```
Runs CLAUDE.md's demo script live on Arc, three times in a row, each on a fresh organization:
(1) a small x402 purchase paid by the Gatekeeper, (2) a bill over the threshold → approval card →
two members sign → paid, (3) Drills: fake invoice → $0 moves → category blocked → a vote restores it
with approval required, (4) changed bank account blocked, (5) Tripwire: a trap key is shared → all
agents frozen → the freeze on the Arc explorer, (6) a proposal to add the scammer's account as a payee
→ Preview Before Loosening shows it would have let the scam through → the vote fails. Amounts are
scaled for testnet; only fake targets are used.

## Tests
Every pull request runs these on GitHub (CI) and needs the owner's review before merging: see
[CONTRIBUTING.md](CONTRIBUTING.md). Locally, `pnpm ci:check` runs the same checks.

```bash
pnpm --dir engine test       # policy engine, every rule kind, Dharma rule ordering, signed log
pnpm --dir contracts test    # Dharma + proxy (forge): tiers, waits, skip, freeze-cancel, upgrades, trust levels
pnpm --dir gatekeeper test   # gatekeeper on the real Dharma (anvil): levels, watchdog, v2→v3 upgrade, proxy, drafter
pnpm --dir relay test        # QuickNode signature, replay, decoding, both filters, agent records
pnpm --dir agents check:no-keys
# live, on Arc testnet (needs the test seller running):
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase2   # payments
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase3   # Dharma: tighten / loosen / core / explorer
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase5   # Drills: fake invoice → block onchain → vote restores
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase6   # Tripwire: trap key shared → all agents frozen
```
The gatekeeper tests start a local chain with `anvil`: found in `$ANVIL`, `~/.foundry/bin`
(`anvil.exe` on Windows) or on `PATH`.

Tools: Node ≥ 22, pnpm, [Circle CLI](https://developers.circle.com/agent-stack/circle-cli/command-reference) (`npm i -g @circle-fin/cli`), [Foundry](https://getfoundry.sh) (`forge`, `anvil`), Docker for sandboxes.

## Layout
| Folder | What |
|---|---|
| `engine/` | Deterministic first-match policy engine + signed log |
| `gatekeeper/` | The only process that holds the wallet: proposals, approvals, payments, Exact Match, egress proxy, Drills, Tripwire, rule drafter |
| `contracts/` | **Dharma** + `DharmaProxy` on Arc, and the shared TypeScript vocabulary (ops, encoders, typed data) |
| `relay/` | QuickNode Stream → verified Dharma events → every console + Gatekeeper refresh; direct-RPC fallback |
| `runner/` | `pnpm karuna run`: builds and starts agent sandboxes |
| `web/` | Karuna Console, the product frontend |
| `desktop/` | Tauri app: the console plus the island |
| `agents/` | Agent-side client (propose, inbox, flag scams; no keys) and example agents |
| `services/test-seller/` | **Test fixture only**: a local x402 seller used to verify payments |

## Desktop app (Windows first): console + island
`desktop/` is a Tauri 2 shell around the console: the main window loads `web/`, and the island
imports the site's visuals from `web/src/site/`. Needs Node 22+, Rust (MSVC toolchain), and Visual
Studio Build Tools with the C++ workload + Windows SDK.
```bash
cd desktop && npm run tauri dev     # starts the console dev server if needed, then the app
```
- **Console:** closing it hides Karuna to the tray and the island takes over; **Quit** in the tray
  menu exits. The sidebar can be pinned or hidden.
- **Island:** a notch at the top center that slides down on hover, with the site's marble contours
  behind it. Click it to open the console; drag the lotus out to float it, back to the top to dock.
  While an approval is pending it stays open and can approve or deny right there. Tray: Open
  Karuna, Pause/Resume agents, Quit.
- **States:** idle, working, pending approval, approved, denied, paused, offline.

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

### Pipe protocol: `\\.\pipe\karuna`
Newline-delimited JSON, served by the Gatekeeper (`gatekeeper/src/pipe.ts`).

| Direction | Message |
|---|---|
| out | `decision` `{id, action_type, summary, result: "allow"\|"deny"}` |
| out | `approval_requested` `{id, action_type, payload, payload_hash, reversible, agent_reason, expires_at}` |
| out | `approval_resolved` `{id, result: "approved"\|"denied"\|"failed"}` |
| out | `agent_paused` `{by, at}` · `agent_resumed` · `error` `{id?, error}` |
| in | `approval_response` `{id, payload_hash, decision: "approve"\|"deny", signer, deadline, signature}` |
| in | `pause` `{by}` · `resume` `{by}` (the local pause: instant, never onchain; not the Dharma freeze) |

An approval over the pipe is never trusted on its own: the console window signs the exact id +
payload hash + decision with this member's key, the app forwards it only if it still matches the
pending request, and the Gatekeeper checks id and hash again and verifies the signature against
Dharma's members. `cd desktop && npm run mock` plays a scripted Gatekeeper for testing the island.

## Arc testnet facts (verified Nov 9, 2026)
| | |
|---|---|
| Chain ID | `5042002` |
| Public RPC | `https://rpc.testnet.arc.network` |
| USDC (ERC-20, 6 decimals) | `0x3600000000000000000000000000000000000000` |
| Gas token | USDC (native, 18 decimals) |
| Explorer | https://testnet.arcscan.app |
| Faucet | https://faucet.circle.com (20 USDC / 2h) or `circle wallet fund` |
| Circle CLI chain id | `ARC-TESTNET` |
