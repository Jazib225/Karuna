# Karuna

> *An agent's competence should never be its permission.*

AI agents can now spend a business's money, call its APIs, run commands and message each other.
Karuna is the permission layer that makes sure no agent, and no group of agents, can be tricked into
misusing that. **The agent proposes. Karuna decides. People set the rules.**

Agents run in a sandbox with no keys, no wallet and no network. Every payment, web request, shell
command, file access and message to another agent becomes a request to Karuna's **Gatekeeper**, the
only process that holds the wallet. The Gatekeeper decides each request against the organization's
rules, which live onchain in **Dharma**, a contract on Arc that the team governs by vote. Tightening a
rule is fast; loosening one is slow and public. Every decision is signed and anchored on Arc.

**Team:** Adi Chaudhary, Jazib Qureshi · **Site:** [karunaprotocol.dev](https://karunaprotocol.dev)

## Hackathon submission (UBC 2026)

| | |
|---|---|
| **Main track** | Agentic Payments and AI |
| **Chain award** | Best use of Arc |
| **Bounties** | QuickNode Streams · ElevenLabs · Grok Bot |

Where each requirement is met:

| Requirement | Where |
|---|---|
| Agents execute onchain transactions (Agentic Payments) | The Gatekeeper pays USDC on Arc through a Circle Agent Wallet: x402 purchases and bill transfers. [Circle tools used](#circle-tools-used) |
| Agent decision loop and safety limits documented | [Agent decision loop](#agent-decision-loop) · [Safety limits](#safety-limits) |
| Core onchain functionality on Arc, contract addresses, how Arc is used | [How Karuna uses Arc](#how-karuna-uses-arc) · [Deployed on Arc testnet](#deployed-on-arc-testnet) |
| QuickNode Stream with a filter and a destination, explained (network, dataset, filter, destination, why) | [QuickNode Stream](#quicknode-stream) |
| ElevenLabs as a core feature, products used and how | [Karuna Voice (ElevenLabs)](#karuna-voice-elevenlabs) |
| Grok Bot: 3–4 sentence role, chat export | [Grok Bot](#grok-bot) · [chat export](docs/GROK_BOT_CHAT.md) |
| Architecture overview | [Architecture](#architecture) |
| Source code and setup instructions | [Run it](#run-it) |

### What we built
A permission layer for autonomous AI agents that handle money. Agents ask; the Gatekeeper decides
each request by the first matching rule (allow, ask a human, or deny), pays from the business's
Circle Agent Wallet on Arc only when allowed, and records every decision in a signed log anchored to
the organization's Dharma contract. Members approve, vote and freeze from a web console, a Windows
desktop app with an always-on "island" at the top of the screen, by voice, and from their chat apps.

### What problem it solves
An agent that can pay can be tricked into paying. Prompt injection, fake invoices, "we changed banks"
emails, leaked keys and agents egging each other on are not hypothetical: in July 2026 a swarm of
research agents shared exposed credentials and compromised production systems for a week before
anyone noticed. Wallet spending limits alone don't help: they can't tell a real invoice from a scam,
and whoever holds the key can change them. Karuna takes the keys away from the agent entirely and
puts every action behind rules that the agent can't talk, trick or compute its way around.

### How it works
See [Architecture](#architecture) and [Agent decision loop](#agent-decision-loop). In short: sandbox →
Gatekeeper → deterministic policy engine reading rules from Dharma on Arc → allow, member approval
(pushed live to every screen through a QuickNode Stream), or a blank denial → the Gatekeeper pays
exactly what was approved → signed log anchored on Arc.

### What makes it unique
- **Drills:** Karuna sends agents fake scam messages, indistinguishable from real ones. An agent that
  falls for one loses access to that kind of action, onchain, until the team votes it back.
- **Tripwire:** agents never get real keys, so any key an agent uses or shares is bait. Using one, or
  two agents going after the same new target at once, freezes every agent.
- **Tighten fast, loosen slow, enforced by a contract:** no one, including Karuna, can quietly loosen
  the rules. Core boundaries need every member and a 24-hour wait.
- **Trust levels earned from the onchain record:** a new agent gets 10¢ per payment; more autonomy
  needs a clean record, read from the chain through QuickNode, and a vote.
- **The agent learns nothing from a denial:** it gets the same blank `denied` every time; the reason
  goes to people only.
- **Voice that can't be talked into loosening:** approvals by voice need a code shown only on screen
  and read back in your own words.

### What we'd build next
Protected Agent Badge (an onchain lookup sellers call before serving an x402 request), Quiet Mode
(only small routine actions while no human is around), a repeat-request detector for agents that
rephrase a blocked request, starter rulebooks, Circle wallet spending policies as the third lock on
mainnet, and a policy core small enough to formally verify.

## Architecture
```
 agents, each in a Karuna sandbox                     members (each device holds its own signing key)
 (no keys, no wallet, no network except Karuna)          │ sign votes, rule changes, approvals
   │ every request goes through the egress proxy         ▼
   ▼ agent API :8787 · proxy per run         console API :8788 ◄── console :4173 · desktop app + island
   │                                                              (voice: ElevenLabs Agents)
   │ chat apps, Grok Bot, Claude Code / Cursor ──► MCP connector :8792 (/mcp, /grok/mcp)
   ▼
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
     Dharma on Arc (proxy + code) ──events──► QuickNode Stream ──webhook (HMAC)──► relay :8790 ──WS──► every console
     the org's wallet ─────────USDC transfers──┘                                       └──► Gatekeeper (watchdog, records)
```
- **Three locks:** the Gatekeeper's policy engine, the Dharma contract, and the wallet itself, which
  only the Gatekeeper holds. Circle's wallet spending limits are mainnet only, so on testnet Dharma
  and the Gatekeeper enforce limits.
- **Agents only propose.** A denial is a blank `denied`, never the reason, so an agent can't learn
  which wording gets through.

| Part | Folder | What it does |
|---|---|---|
| Policy engine | `engine/` | Deterministic first-match engine and the signed, hash-chained log |
| Gatekeeper | `gatekeeper/` | The only process that holds the wallet: requests, approvals, payments, Exact Match, the egress proxy, Drills, Tripwire, the rule drafter, the MCP connector, voice |
| Dharma | `contracts/` | Each organization's rulebook on Arc (`Dharma`, `DharmaExt`, `DharmaProxy`), the `Escrow` for large payments, and the shared TypeScript vocabulary |
| Relay | `relay/` | QuickNode Stream → verified Dharma events and wallet transfers → every console and the Gatekeeper; reads Arc directly if the Stream goes quiet |
| Runner | `runner/` | `pnpm karuna run`: agent sandboxes whose only way out is the Gatekeeper |
| Console | `web/` | The product's web app for members (React + Vite) |
| Desktop app | `desktop/` | Windows app (Tauri): the console plus the island, with Karuna Voice |
| Plugin | `plugin/` | Puts Claude Code and Cursor behind Karuna: every tool call is checked first |
| Agents | `agents/` | The agent-side client (no keys) and example agents |
| Test seller | `services/test-seller/` | A local x402 seller, for testing payments only |

## Agent decision loop
1. **The agent acts.** It runs in a Karuna sandbox with no keys, no wallet and no network. Every
   payment, web request, shell command, file access or message to another agent leaves the
   sandbox as a request to the Gatekeeper.
2. **Karuna checks the facts.** It works out who is asking, the exact payee, amount and target, and
   the agent's spend so far today. These come from the request, never from the agent's explanation.
3. **The rules decide.** The policy engine reads the org's rules from Dharma on Arc and the first
   matching rule gives one of three answers:
   - **allow**: the action goes ahead now (within the agent's trust level);
   - **ask**: an approval card appears on every member's screen and in the island through the
     QuickNode Stream, with Karuna's facts on top and the agent's reason boxed as "may not be true".
     Unanswered, it's refused after the team's hold time (120 s by default, changed by vote);
   - **deny**: the agent gets a blank `denied`, with no reason to learn from.
4. **The Gatekeeper executes.** Only the Gatekeeper holds the Circle Agent Wallet. It pays in USDC
   on Arc (x402 for data, transfers for bills, the Escrow for large payments) and executes exactly
   the payload that was allowed or approved, checked by hash (Exact Match).
5. **Everything is recorded.** Each decision goes into a signed, hash-chained log, which is
   anchored to Dharma on Arc.
6. **Karuna watches for patterns.** Drills, Tripwire, the wallet watchdog and the changed-account
   alert can block an agent or freeze every agent instantly. Only a member vote loosens things again.

## Safety limits
| Limit | Default | Who can change it |
|---|---|---|
| Payment to an address that isn't a saved payee | always denied (core rule) | every member + 24 h wait |
| Reading secrets, catastrophic shell commands (`rm -rf /`, etc.) | always denied (core rule) | every member + 24 h wait |
| Anything no rule covers | denied (core rule) | every member + 24 h wait |
| Payment to a saved payee | allowed within the agent's **trust level**: per payment and per day (Level 0: $0.10 / $1) | majority vote + wait (the level's limits) |
| Payment over the level's limits | needs a member's approval | majority vote + wait |
| Payment above the two-person threshold | needs **two** members' approval | majority vote + wait |
| Large payment | held in the org's Escrow for a set time; any member can cancel it | majority vote + wait |
| A held request nobody answers | refused after the hold time (120 s) | majority vote + wait |
| `rm -rf <path>` | needs a member's approval at every level | majority vote + wait |
| File writes, package installs, POST/PUT/DELETE, messages to other agents | need approval until the agent's level allows them (see [Trust levels](#trust-levels)) | majority vote + wait |
| Raising an agent's level | needs a clean record (10 / 25 / 50 actions) from the Stream, one level at a time | majority vote + wait |
| Lowering an agent's level | instant: any one member, or automatically (Tripwire → Level 0, failed Drill → one level down) | — |
| USDC leaving the wallet that Karuna didn't pay | **every agent frozen**, recorded on Dharma (wallet watchdog) | majority vote + wait to unfreeze |
| Web requests | GET only to allowlisted domains; everything else denied | majority vote + wait |
| Approved payment | executes only if the payload hash and price still match | can't be changed |
| Agent falls for a Drill | blocked from that kind of action until a vote restores it, and one level lower | majority vote + wait |
| Agent uses a trap password, or 2 agents go after the same new target within 60 s | **every agent frozen** | majority vote + wait to unfreeze |
| Panic button | any one member freezes every agent at once | majority vote + wait to unfreeze |
| Agent keys and the wallet | never inside the sandbox; the Gatekeeper swaps placeholders on the way out | can't be changed |
| Voice | can deny, vote no, pause and lower a level at once; approve, vote yes, resume and propose need a code shown on screen, read back by you | can't be changed |

## How Karuna uses Arc
Arc is where Karuna's rules and record live, and where its money moves. USDC as gas keeps every
member action and every payment a predictable cost in dollars.
- **Dharma, one contract per organization.** Members, rules, payees, agents, trust levels, waits,
  roles and the freeze switch are Dharma's state. The Gatekeeper reads the rules from Arc before it
  decides anything; if the chain doesn't mention a core rule, it still applies (fail closed).
- **Every member action is an EIP-712 signature** from that member's own key, relayed to Arc by the
  Gatekeeper, which pays the gas but can't forge or alter it. The contract itself enforces tighten
  fast, loosen slow (`MembersMustPropose`, `NotTightening`).
- **Payments in USDC on Arc** from the Circle Agent Wallet: transfers for bills, x402 for per-request
  data through Circle Gateway, and the `Escrow` contract for large payments members can still cancel.
- **The signed log is anchored to Dharma**, with each agent's running totals (`ActionsRecorded`), so
  the decision record can't be quietly rewritten.
- **Safety events are onchain:** failed Drills (`TestFailed`), Tripwire freezes (`TripwireFired`),
  level changes (`LevelSet`) and transfers the wallet watchdog didn't expect (`UnapprovedTransfer`).
- **The record drives autonomy:** the relay rebuilds each agent's record from Dharma's events
  (delivered by the QuickNode Stream), and Dharma upgrades in place behind an ERC-1967 proxy.

## Deployed on Arc testnet
| | |
|---|---|
| Organization's Dharma (proxy, the address everything uses) | [`0xb053a5dbc75b26ae1637f5a834dc59d0d5d8f13e`](https://testnet.arcscan.app/address/0xb053a5dbc75b26ae1637f5a834dc59d0d5d8f13e) |
| Dharma code (v6, behind the proxy) | [`0x0357fbe89f9986d64b6317593d16e5219ca0fbd2`](https://testnet.arcscan.app/address/0x0357fbe89f9986d64b6317593d16e5219ca0fbd2) |
| DharmaExt (the second half of the v6 code) | [`0x32D29cE391be7C0e87D223bD50a8947B06cc0d37`](https://testnet.arcscan.app/address/0x32D29cE391be7C0e87D223bD50a8947B06cc0d37) |
| Gatekeeper's Circle Agent Wallet | [`0xe78f1b83b5f995a8c5fbc3b4ad1f3639fe6002ea`](https://testnet.arcscan.app/address/0xe78f1b83b5f995a8c5fbc3b4ad1f3639fe6002ea) |
| USDC (ERC-20 interface, 6 decimals) | [`0x3600000000000000000000000000000000000000`](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000) |
| Example: Grok Bot's $0.05 payment to Valley Flour | [`0x0700…f566`](https://testnet.arcscan.app/tx/0x070013ac071ace20fb118b785ebe76bf28b8d4e69968237ca882ebe25d50f566) |

Every new organization deploys its own Dharma (code + proxy) at setup, and its Escrow with its first
large payment; each verification and demo run deploys a fresh one and prints its explorer link. The
repo's code is Dharma **v7** (the host may remove a teammate, queued behind the core wait); an org
moves to it with an `Upgrade`, a core change.

Arc testnet facts (verified Nov 9, 2026): chain ID `5042002` · RPC `https://rpc.testnet.arc.network`
· gas token USDC (native, 18 decimals) · explorer https://testnet.arcscan.app · faucet
https://faucet.circle.com · Circle CLI chain id `ARC-TESTNET`.

## Circle tools used
| Tool | How |
|---|---|
| **Circle Agent Wallet** (SCA on `ARC-TESTNET`) | the organization's wallet, held **only** by the Gatekeeper; agents never see it |
| **Circle CLI** | `circle wallet transfer` (USDC bills), `circle services pay` (x402 purchases, `--estimate` first for Exact Match), `circle wallet execute` (Dharma writes), `circle contract deploy` (each org's Dharma code and proxy), `circle gateway balance`, `circle wallet list` |
| **x402 + Gateway Nanopayments** | agents buy data per request (e.g. $0.001); the Gatekeeper pays from the wallet's Gateway balance and hands the agent only the response. Members top up the Gateway balance from the console |

## QuickNode Stream
One Stream, `karuna-events`, powers live approvals, the wallet watchdog and each agent's record. It
feeds the relay (QuickNode's free plan allows one Stream, and one filter can keep both kinds of log).
Created by `pnpm --dir relay stream:create`.

| Setting | Value | Why |
|---|---|---|
| Network | `arc-testnet` | Dharma and the org's wallet are on Arc |
| Dataset | `logs` | Dharma's state changes and USDC transfers are both logs |
| Range | `start_range` = the block Dharma was deployed in, no `end_range` | replays the org's whole history (backfill), then follows the chain: that history is each agent's record |
| Filter | JavaScript (`quickNodeCombinedFilterSource(wallet)` in `relay/src/events.ts`) that keeps two things and drops every other Arc log: **Dharma's events** (`topics[0]` is one of Dharma's event signatures) as `dharmaLogs`, and **USDC leaving the org's wallet** (`Transfer` logs from Arc's USDC, the ERC-20 interface `0x3600…0000` with 6 decimals or the native USDC system address `0xffff…fffe` with 18, whose `from` topic is the wallet) as `walletTransfers` | each delivery carries only what the relay acts on |
| Destination | webhook → `https://<tunnel>/quicknode/webhook` (relay :8791), `security_token` set, batch size 1 | one block per delivery = lowest latency for approval pop-ups |
| Verification | the relay checks `HMAC-SHA256(token, nonce + timestamp + body)` and rejects replays | an unsigned POST can't fake an alert or a transfer (401) |

What the relay does with it:
- **Dharma's events**: approval pop-ups, votes, freezes and level changes on every member's screen
  and in the island; and each agent's record for trust levels (`ActionsRecorded`, `LevelSet`,
  `TestFailed`, `TripwireFired`), rebuilt in chain order and sent to the Gatekeeper.
- **USDC leaving the wallet**: the wallet watchdog. Each transfer must match a Karuna payment or
  every agent freezes (see [Safety features](#safety-features)).

If the Stream goes quiet the relay reads Arc directly and de-duplicates; the top bar shows which
source is live (`QuickNode` or `Arc`). Setup: [`docs/QUICKNODE.md`](docs/QUICKNODE.md) ·
`pnpm --dir relay stream:create` (add `--backfill` to recreate it from the deploy block).

## Karuna Voice (ElevenLabs)
Run your organization by talking to it. Karuna tells you what your agents want, out loud, even while
you're in another app, and you answer out loud. **Voice can always make things safer at once; it can
never make them looser without proof that you said so.** Design: [docs/VOICE_PLAN.md](docs/VOICE_PLAN.md).

| ElevenLabs product | Where | What for |
|---|---|---|
| **ElevenLabs Agents** (`@elevenlabs/client`, WebRTC) | the island's voice panel and the console | the conversation: speech recognition, the model, Karuna's voice, and 16 client tools (`gatekeeper/src/voice-tools.ts`) |
| **Text to Speech** (streaming, `eleven_flash_v2_5`) | Gatekeeper `POST /voice/speak` | spoken alerts for held requests and votes, even with no conversation open |
| **Sound Effects** | `pnpm --dir gatekeeper voice:sounds` → `web/public/sounds/` | the island's chimes: needs you, approved, denied, frozen |

**Using it:** press **Ctrl+Shift+Space** anywhere (or the mic on the island), or say your wake
phrase. Ask "what's waiting?", "what's it for?", "freeze every agent", "lower the research agent to
level 0", "draft a rule: block payments to Acme over 50 dollars". To approve, vote yes, resume or
propose, Karuna shows a code on the island ("Say **approve 4 7 2**") and you read it out. **End**
closes the conversation for good; the wake phrase can't reopen it for 5 seconds.

**Wake phrase:** in Appearance → Voice, type any phrase (say, "hey karuna"). It's recognized
**offline on this computer** by a small Vosk model (no audio leaves the PC while it waits), matched by
sound so names it doesn't know still work.

**Why it's safe.** The voice agent is governed like every other agent:
- **No keys.** The ElevenLabs key stays on the Gatekeeper; the island gets a one-time conversation
  token. Every action goes island → console window (signs with your member key) → Gatekeeper, the
  same path as a click, so Dharma and the Gatekeeper check exactly what they always do.
- **Client tools only.** The agent can't reach the Gatekeeper or Arc; it can only call the island's
  tools: reads (status, pending, explain, recent, rules, agent info), tightening (deny, vote no,
  pause, lower a level) and drafts.
- **The spoken code.** Approve, vote yes, resume and propose never happen when the model asks. A
  random three-digit code appears **on screen only**; the model is never told it, so it can't say it
  and an agent's text can't contain it. Only **your own transcript** (the speech recognizer's user
  transcript, never the model's reply) saying the action's word and the code within 30 s confirms
  it, once, for that one request and payload hash (`desktop/src/island/code.ts`).
- **Karuna's words, not the agent's.** `/voice/speak` never takes free text: it speaks a sentence
  built from Karuna's own fields (agent, amount, payee name, the matching rule). Commands, file
  paths and URL paths an agent wrote are never read aloud. The agent's reason is read only when you
  ask, introduced as "In the agent's words, which Karuna hasn't checked".

**Set up (once):**
1. Put `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` in the repo's `.env` (see `.env.example`). On
   the free plan, pick a premade voice; Voice Library voices need a paid plan through the API.
2. `pnpm --dir gatekeeper voice:agent` creates the voice agent (prompt, voice and tools from
   `gatekeeper/src/voice-tools.ts`) and prints `ELEVENLABS_AGENT_ID`: add it to `.env`. Run it
   again after changing the tools; it updates the same agent.
3. Optional: `pnpm --dir gatekeeper voice:sounds` remakes the chimes.
4. `pnpm --dir desktop wake:model` gets the wake-phrase model once (about 40 MB, into
   `web/public/models/`, not committed; `start-karuna.ps1` does this for you).
5. Restart the Gatekeeper, then in the desktop app: Appearance → **Voice** and **Read alerts aloud**.

## Grok Bot
Grok Bot is Karuna's watcher on Arc and a governed agent you can direct in plain language. It
connects to Karuna's MCP connector at `/grok/mcp` and, once a member approves its sign-in code and
the team votes it in, becomes its own Karuna agent at Level 0: it can propose payments to saved
payees, anything over its limit waits for a member, and the wallet and every key stay in Karuna. A
Grok Bot routine reads what happened on Arc every few minutes with `arc_activity` (payments and their
transactions, held payments, Dharma votes, wallet transfers, freezes, log anchors) and warns every
member with `alert_team`, whose button opens Approvals, Votes or the freeze; Grok Bot itself can
never approve, vote or freeze.

- **Chat export:** [docs/GROK_BOT_CHAT.md](docs/GROK_BOT_CHAT.md): Grok Bot pays Valley Flour $0.05
  through Karuna ([on Arc](https://testnet.arcscan.app/tx/0x070013ac071ace20fb118b785ebe76bf28b8d4e69968237ca882ebe25d50f566)),
  then tries to send $1 to an unsaved address and Karuna refuses it (`unknown-recipient`).
- **What it passed on joining:** pre-flight's three Drills (it reported the scams), and its first
  `alert_team` flagged two executed Dharma votes that loosened rules.
- **Its tools:** `pay`, `buy_data`, `web_search`, `web_fetch`, `balance`, `check_request`,
  `read_inbox`, `report_message`, `arc_activity`, `alert_team`, and the team's connectors.
- **Setup:** Agents → New agent → **Grok Bot**, then [docs/GROK_BOT.md](docs/GROK_BOT.md). Needs an
  X subscription that includes Grok Bot and Karuna's public address (a tunnel); no xAI API key.

## Dharma: who can change what
Dharma (`contracts/src/Dharma.sol` and `DharmaExt.sol`) is one contract per organization. Every
member action is an EIP-712 signature from that member's own key; the Gatekeeper relays it and pays
gas but can't forge or alter it.

| Change | Who votes | Wait (default) | Wait can be skipped? |
|---|---|---|---|
| Normal change (rules, agents, payees, domains, allowances, members, settings, the normal wait) | majority | 60 s (0 s – 7 days) | yes, if **every** member signs (teams of 2+) |
| Unfreeze | majority | the normal wait | no |
| **Core change**: removing a core rule, changing the core wait, upgrading Dharma's code | **every member** | 24 h (60 s – 30 days) | no |
| Freeze all agents | any one member | none | — |
| Automatic safety blocks (Drills, Tripwire, learned blocks) | the Gatekeeper alone | none | tighten-only |

- **Tighten fast, loosen slow.** Only Freeze and the Gatekeeper's automatic blocks are instant, and
  the contract decides what counts as tightening (`MembersMustPropose`, `NotTightening`).
- **Freeze beats everything.** It's instant for any member, and it cancels every pending core change.
- **Waits are fixed when a proposal passes**, so changing a wait never speeds up a proposal already
  waiting. Lowering a wait itself waits out the current one.
- **Team roles on Dharma.** Flat or tree teams, with per-role permissions (propose, manage agents,
  freeze). Votes never need a permission. Invite links add teammates.
- **Narrower by default.** Every new agent starts at Level 0, below whoever set it up, and its creator
  is recorded. Each drafted change is tagged **Narrows** or **Widens** with the vote and wait it
  needs. [docs/NARROWER_BY_DEFAULT.md](docs/NARROWER_BY_DEFAULT.md)
- **Upgradeable, same address.** Each org is a `DharmaProxy` (ERC-1967) pointing at the Dharma code.
  An `Upgrade` is a core change, so new code ships with every member's signature and the core wait;
  members, rules, payees and signatures carry over.

## Rules
The engine checks rules in this order; the first match decides:
1. **Core rules** (`core-boundary`, `secrets-read`, `unknown-recipient`, `default-deny`): catastrophic
   shell commands, reading secrets, paying unknown addresses, and anything unmatched are blocked.
   They change only by a core change; if the chain doesn't mention one, it still applies (fail closed).
2. **Your blocks**, then **your approvals**, then the agent's **trust level**, then **your allows**.
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
asks a free model to draft rules, checks each draft against the org's real agents and payees, and
shows it as the exact rule and sentence that would be voted on. The model never proposes anything.
Only free models are used, tried in order until one answers: Gemini (`gemini-3.8-flash`, then
`gemini-3.5-flash-lite`), then Groq (`openai/gpt-oss-20b`). When no key is saved, the drafters ask for
a free Groq (console.groq.com) or Gemini (aistudio.google.com) key right there; only the Gatekeeper
uses it. A sentence that drafted once is saved and comes back instantly with no model call. Models:
`KARUNA_DRAFT_MODEL`, `KARUNA_DRAFT_FALLBACK_MODEL`, `KARUNA_DRAFT_GROQ_MODEL`. Without a key the form
works by hand.

## Trust levels
An agent earns autonomy the way a new hire does: a little at first, more as its record earns it,
and all of it pulled back the moment something goes wrong. Each agent's level lives on Dharma.

| Level | Pays without asking (per payment / per day) | Also without asking | To get here |
|---|---|---|---|
| 0 Restricted | $0.10 / $1 | nothing else | every new agent |
| 1 Limited | $0.50 / $5 | messages to other agents, file writes in `./workspace` | 10 clean actions, then a vote |
| 2 Standard | $2 / $20 | POST/PUT/DELETE to allowlisted domains, package installs | 25 clean actions, then a vote |
| 3 Extended | $5 / $50 | file writes anywhere in the sandbox | 50 clean actions, then a vote |

- **What a level never changes.** Core rules, and the org's own block and approval rules, always come
  first (rule order: core → blocks → approvals → **level** → allows → defaults). `rm -rf`, unknown
  payees, secrets and unlisted domains stay off at every level. The payment limits per level are
  changed by vote (the Trust levels popup on the New agent card); the ladder of other permissions is
  the same for every org.
- **Raising is slow, lowering is instant.** A level goes up one step at a time, by majority vote and
  the wait, and only once the agent has enough *clean* actions: completed since its last level
  change, failed Drill or Tripwire. Any member can lower a level at once. A Tripwire drops the agent
  to Level 0 and a failed Drill drops it one level, automatically, recorded on Dharma.
- **The record is onchain, and read through QuickNode.** With every log anchor the Gatekeeper
  publishes each agent's running totals (`ActionsRecorded`); Dharma itself emits level changes,
  failed Drills and Tripwires. The relay rebuilds every agent's record from these events, delivered
  by the QuickNode Stream backfilled from Dharma's deploy block, and the Gatekeeper refuses to relay
  a level-up proposal the record doesn't support. Members still vote on it.

## Safety features
- **Drills (Auto-Shield):** Karuna sends agents fake scam messages through the same inbox as real
  mail. An agent that falls for one is blocked from what the scam asked for, onchain, and drops a
  level, until members restore it by vote. Only people can see which messages were Drills.
  **Pre-flight** runs three Drills (fake invoice, injected link, planted credential) on every new
  agent, with "Apply fix" and "Run again".
- **Tripwire (Swarm Stopper + trap passwords):** agents never get real passwords, so any password an
  agent uses is bait. Sharing one, or two agents going after the same new target within 60 s,
  freezes every agent, recorded on Dharma.
- **Changed bank account alert:** a known supplier's name with a different account is blocked and
  flagged.
- **Facts first, Exact Match:** approval cards are built by Karuna from the exact payload (who,
  amount, account, payload hash, reversible or not), with the agent's reason boxed and labeled
  untrusted. What a member approved (payload hash, re-quoted price) is exactly what executes.
- **Two-person approval** above a threshold, and **Escrow** for large payments: they wait a set time
  in the org's Escrow contract and any member can cancel them.
- **Wallet watchdog:** the QuickNode Stream also watches every USDC transfer leaving the org's wallet.
  Each one must match a payment Karuna made (same payee, same amount); deposits into Circle Gateway
  stay the org's money. Anything else means the wallet was used outside Karuna, so every agent
  freezes and the transfer is recorded on Dharma (`UnapprovedTransfer`). Limits: x402 purchases are
  paid from the Gateway balance and settled by Circle in batches, so they don't show up one by one;
  the watchdog covers the wallet itself. The automatic freeze runs in the Gatekeeper, so a fully
  compromised Gatekeeper could skip it, but the relay still pushes the alert to every member's screen.
- **Learns from your choices:** a "no" becomes a block at once; a "yes" becomes a suggested rule only
  after repeated approvals and a vote. **Preview before loosening** replays recent requests under a
  proposed change and shows what it would have let through.
- **Worst-case meter:** what every agent could do if hijacked right now, on Home and on each
  proposal ("Worst case if it passes").
- **Undo for sandbox runs:** see every file a run changed and undo the run or one file.
- **Panic button:** any one member freezes every agent onchain from the console. The island, the
  tray and voice also pause every agent at once on this Gatekeeper (instant, local).

## Karuna without code
For people who don't write code, and for coders who just want their AI kept safe.

**Sign in with email and password.** Members sign in on any device with an email and a password: the
same member everywhere, one vote. The browser locks the member's signing key with the password
before anything is sent, so Karuna stores only a locked key and a proof of the password; it never
sees either, and hands the locked key only to someone who proves the password. A forgotten password
can't be reset (nothing is emailed): a teammate adds the person back.

**Claude Code and Cursor: every tool call goes through Karuna.** Add Karuna's plugin once:
```
/plugin marketplace add <path or repo of this project>
/plugin install karuna@karuna
```
(Cursor: `node plugin/scripts/install-cursor.mjs`.) The first time Claude tries a tool, it shows a
code; a member approves it in Agents → New agent → Coding agents, which gives that computer its own
agent at Level 0. From then on, before Claude runs a shell command, reads or edits a file, fetches a
page or calls an MCP tool, Karuna decides: it runs, it's refused ("Karuna blocked this."), or it waits
while a member approves. Coding defaults: reading the project runs; at Level 1 edits and commands in
the project run, except `git push`, network tools, installs, `rm -rf` and `sudo`, which ask; secrets
are always blocked. It fails closed if Karuna can't be reached.

**Chat apps (claude.ai, Claude Desktop, ChatGPT).** Add `https://<your-karuna>/mcp` as a connector.
The chat app opens Karuna's connect page, which shows a code; a member approves it in the console.
The chat gets `pay` (saved payees only), `buy_data`, `balance` and `check_request`, plus the team's
connectors: other MCP servers (GitHub, Gmail, …) added by a vote and reached only through Karuna, so
every call follows the rules (read-only tools run, others wait for a member until a rule or Level 2
allows them, destructive ones always ask). A connector's key stays in Karuna. A tool whose
description, inputs or hints change after approval is held until a member reviews it. The connector
is served on `KARUNA_PUBLIC_PORT` (8792): expose it with a tunnel
(`cloudflared tunnel --url http://127.0.0.1:8792`; `start-karuna.ps1` starts one).

**New agent: Karuna builds and runs it.** Agents → New agent: describe the job ("Every morning, check
grain prices; if flour is under $35, order from Valley Flour, up to $50 a week"). Karuna drafts its
name, instructions, when it runs (Run now, every N minutes, daily, or when a message arrives) and its
limits as rules; members edit and propose it. Once the vote passes, Karuna runs it on schedule in a
sandbox: a free Groq agent, or a Claude agent (`agents/hosted/run.ts`) with Karuna's tools, a token
issued for that run only, and the model key as a placeholder. Docker must be running.

**Watching agents work (Runs).** Every sandboxed run has a live timeline: the conversation with its
model, read from the traffic the egress proxy already carries (Anthropic, OpenAI-compatible including
local servers like Ollama, and Gemini), each action with Karuna's decision (Approve/Deny right there
for held ones), what the agent printed (labeled as its own notes), the model used, Watch screen for a
box with a desktop, and Stop.

## Desktop app and island (Windows)
`desktop/` is a Tauri 2 app: the console in a window, plus the **island**, a notch at the top center
of the screen.
- **Island:** a thin strip stays at the top edge; hovering it opens the pill. It shows agent activity,
  and while an approval or a Dharma vote is waiting it stays open with Approve / Deny or Vote yes /
  Vote no right there (signed by the console window like a click). Drag it out to float it, back to
  the top to dock. States: idle, working, pending approval, approved, denied, paused, offline.
- **Console:** closing it hides Karuna to the tray and the island takes over. Tray: Open Karuna,
  Pause/Resume agents, Quit.
- **Pipe protocol** `\\.\pipe\karuna` (newline-delimited JSON, `gatekeeper/src/pipe.ts`): decisions,
  approvals and votes out; signed approval responses and pause/resume in. An approval over the pipe
  is never trusted on its own: the console window signs the exact id + payload hash + decision with
  the member's key, the app forwards it only if it still matches the pending request, and the
  Gatekeeper checks id and hash again and verifies the signature against Dharma's members.

## Run it

### Everything at once (Windows)
```powershell
powershell -ExecutionPolicy Bypass -File start-karuna.ps1
```
Starts the Gatekeeper, relay, console, tunnel and desktop app in the background (logs in `.\logs`).
Each start first pulls the latest `main` and rebuilds what changed (`KARUNA_NO_UPDATE=1` skips it).
Ports: agent API 8787 · console API 8788 · relay 8790 (webhook 8791) · MCP connector 8792 · console 4173.

### By hand
```bash
git submodule update --init           # Foundry's forge-std, for the contract tests
pnpm install
cp .env.example .env                  # optional: your QuickNode Arc URL in ARC_RPC_URL
circle wallet login <email> --testnet # the Gatekeeper pays with this Circle session
pnpm --dir gatekeeper start           # agent API :8787 · console API :8788 · MCP :8792
pnpm --dir relay start                # live chain events (QuickNode or direct RPC) :8790 / :8791
pnpm --dir web dev                    # console at http://127.0.0.1:5173
cd desktop && npm run tauri dev       # optional: the desktop app and island
```
A new install opens on **setup**: name the organization, pick the wallet, choose a flat or tree team,
and Karuna deploys the org's own Dharma on Arc with this browser's signing key as its first member.
Then propose agents, payees and teammates. New orgs take their waits from `KARUNA_TIMELOCK_SECONDS`
(default 60) and `KARUNA_CORE_TIMELOCK_SECONDS` (default 86400). For x402 services the wallet also
needs a Gateway balance (Add funds in the console, or
`circle gateway deposit --amount 1 --address 0x… --chain ARC-TESTNET --method direct`).

Tools: Node ≥ 22, pnpm, [Circle CLI](https://developers.circle.com/agent-stack/circle-cli/command-reference)
(`npm i -g @circle-fin/cli`), [Foundry](https://getfoundry.sh) (`forge`, `anvil`), Docker for
sandboxes; for the desktop app, Rust (MSVC) and Visual Studio Build Tools with the C++ workload.
Installer: `cd desktop && npm run tauri build`.

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

### Example agents (`agents/examples/`)
| File | What |
|---|---|
| `claude-agent.ts` | Claude test agent (`http_request`, `read_inbox`), run in a box; the `anthropic` key reaches it only as a placeholder; at most 10 model calls per run |
| `test-agent.ts` | scripted walkthrough: an allowed GET, a denied GET, a POST held for approval, the inbox (`--loop` repeats it) |
| `payables-agent.ts` | pays invoices from its inbox (gullible, or `--careful` to flag scams) |
| `swarm-agents.ts` | a "helpful" agent that shares credentials it finds (the Tripwire demo) |
| `grok-agent.ts` | the same Karuna tools driven by Grok (xAI) as the model |

## The demo, end to end
```bash
pnpm --dir services/test-seller start   # TEST_SELLER_ADDRESS=0x… ; fake data feed (x402)
VERIFY_WALLET=0x… pnpm --dir gatekeeper demo --runs 3
```
Runs the demo live on Arc, three times in a row, each on a fresh organization: (1) a small x402
purchase paid by the Gatekeeper, (2) a bill over the threshold → approval card → two members sign →
paid, (3) Drills: fake invoice → $0 moves → category blocked → a vote restores it with approval
required, (4) changed bank account blocked, (5) Tripwire: a trap key is shared → all agents frozen →
the freeze on the Arc explorer, (6) a proposal to add the scammer's account as a payee → Preview
Before Loosening shows it would have let the scam through → the vote fails. Amounts are scaled for
testnet; only fake targets are used.

## Tests
Every pull request runs these on GitHub (CI) and needs the owner's review before merging: see
[CONTRIBUTING.md](CONTRIBUTING.md). Locally, `pnpm ci:check` runs the same checks.
```bash
pnpm --dir engine test       # policy engine, every rule kind, Dharma rule ordering, signed log
pnpm --dir contracts test    # Dharma + proxy (forge): tiers, waits, skip, freeze-cancel, upgrades, trust levels, the split, host, escrow
pnpm --dir gatekeeper test   # gatekeeper on the real Dharma (anvil): levels, watchdog, upgrades, drafter, accounts,
                             # Claude Code hook, chat connector + Grok Bot, connectors, built agents, runs, voice
pnpm --dir relay test        # QuickNode signature, replay, decoding, both filters, agent records
pnpm --dir desktop test      # island: spoken-code confirmation, spoken text, wake-phrase matching
pnpm --dir agents check:no-keys
# live, on Arc testnet (needs the test seller running):
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase2   # payments
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase3   # Dharma: tighten / loosen / core / explorer
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase5   # Drills: fake invoice → block onchain → vote restores
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase6   # Tripwire: trap key shared → all agents frozen
```
The gatekeeper tests start a local chain with `anvil`: found in `$ANVIL`, `~/.foundry/bin`
(`anvil.exe` on Windows) or on `PATH`.

## More
- [SUMMARY.md](SUMMARY.md): everything built, with a timeline.
- [docs/KARUNA_GUIDE.md](docs/KARUNA_GUIDE.md): the full guide.
- [CLAUDE.md](CLAUDE.md): product decisions.
