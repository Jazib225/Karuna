# Karuna: what has been built

Karuna is the **Organizations layer** for AI agents. AI agents can now spend a
business's money, call its APIs, run commands and message each other. Karuna makes sure no agent, or
group of agents, can be tricked into misusing that.

> **The agent proposes. Karuna decides. People set the rules.**

This file summarizes everything in the project as of November 19, 2026: 127 commits across 12
branches, from November 9 to November 19, by Jazib225, adichaudhary and Pixel.

---

## The pieces

| Part | Folder | What it does |
|---|---|---|
| **Policy engine** | `engine/` | Decides every agent request by the first matching rule; keeps a signed, hash-chained log; computes the worst case if every agent were hijacked |
| **Gatekeeper** | `gatekeeper/` | The only process that holds the wallet. Checks requests, runs approvals and payments, Exact Match, the egress proxy, Drills, Tripwire, the rule drafter, the chat-app connector and the fast relayer |
| **Dharma** | `contracts/` | Each organization's rulebook on Arc: members, rules, payees, agents, trust levels, waits, freezes. Upgradeable (now v5), plus an Escrow contract for large payments |
| **Relay** | `relay/` | Receives the QuickNode Stream, verifies it, and pushes Dharma events and wallet transfers live to every console and the Gatekeeper; reads Arc directly if the Stream goes quiet |
| **Runner** | `runner/` | `pnpm karuna run`: starts agents in sandboxes whose only way out is the Gatekeeper; gVisor, remote machines, desktop boxes, per-run Undo |
| **Console** | `web/` | The product's web app for members (React + Vite) |
| **Desktop app** | `desktop/` | Windows app (Tauri): the console plus the "island", a notch at the top of the screen for approvals |
| **Plugin** | `plugin/` | Puts Claude Code and Cursor behind Karuna: every tool call is checked first |
| **Agents** | `agents/` | The agent-side client (no keys) and example agents: payables, supplies, research, and agents Karuna builds and runs itself |
| **Test seller** | `services/test-seller/` | A local x402 seller for testing payments only |

---

## How a request is decided

1. **The agent acts** inside a sandbox with no keys, no wallet and no network. Every payment, web
   request, shell command, file access or message to another agent goes to the Gatekeeper.
2. **Karuna checks the facts** itself: who is asking, the exact payee, amount and target, and the
   spend so far today. The agent's explanation is never trusted.
3. **The rules decide**, read from Dharma on Arc: **allow**, **ask** a member, or **deny** (a blank
   "denied" with no reason to learn from).
4. **The Gatekeeper executes** exactly what was allowed or approved, checked by hash (Exact Match), and
   pays in USDC on Arc through the Circle Agent Wallet.
5. **Everything is recorded** in a signed log anchored to Dharma.
6. **Karuna watches for patterns** and can block one agent or freeze them all at once.

---

## Features

### Rules and governance (Dharma)
- **One contract per organization** on Arc. Every member action is the member's own signature; the
  Gatekeeper relays it and pays gas but can't forge it.
- **Tighten fast, loosen slow.** Normal changes need a majority vote and a wait (60 s by default).
  Core changes need every member and a 24-hour wait. Any one member can freeze every agent instantly.
- **Rules for every kind of action:** payments, web requests, shell commands, files and messages to
  other agents, each as block, require approval or allow, for one agent or all.
- **Core rules** that never loosen without everyone: unknown payees, secrets, catastrophic commands,
  and anything unmatched are denied.
- **Plain-English rule drafting:** describe a policy in a sentence and a free model (Groq or Gemini)
  drafts the exact rules to vote on. The model never proposes anything itself.
- **Upgradeable in place** (v2 → v3 → v5) with the same address; members, rules and payees carry over.
- **Team roles on Dharma**, invite links, and settings changed by proposal.
- **Fast relayer:** proposals, votes and executions reach Arc in about a second.

### Trust levels
- Agents earn autonomy like a new hire, from **Level 0** (10¢ per payment, $1 a day) to **Level 3**.
- Raising a level needs a clean record (10 / 25 / 50 actions), read from the chain through QuickNode,
  and a vote. Lowering is instant: a Tripwire drops an agent to Level 0, a failed Drill one level.
- The payment limit for each level can be changed by vote.

### Safety
- **Drills:** fake scam emails sent to agents. An agent that falls for one is blocked from that action
  and drops a level. **Pre-flight** runs three Drills on every new agent.
- **Tripwire and trap credentials:** agents never get real keys, so any key an agent uses or shares is
  bait. Using one, or two agents going after the same new target within 60 s (Swarm Stopper), freezes
  every agent.
- **Changed bank account alert:** a known supplier's name with a different account is blocked.
- **Wallet watchdog:** every USDC transfer leaving the wallet must match a payment Karuna made, or
  every agent freezes and it's recorded on Dharma.
- **Escrow for large payments:** big payments wait a set time and any member can cancel them.
- **Two-signature limit:** payments above an amount need two members.
- **Worst-case meter:** what every agent could do if hijacked right now, shown on Home and on each
  proposal ("Worst case if it passes").
- **Learns from your choices:** a "no" becomes a block; repeated "yes" becomes a suggested rule.
  **Preview before loosening** replays recent requests under a proposed change.
- **Undo** for sandbox runs: see every file a run changed and undo the run or one file.

### Karuna without code
- **Sign in with email and password** on any device; the key is locked in the browser.
- **Claude Code and Cursor** through Karuna's plugin: each computer gets its own agent at Level 0.
- **Chat apps** (claude.ai, Claude Desktop, ChatGPT) connect as an MCP connector, and the team's own
  connectors (GitHub, Gmail, …) are reached only through Karuna.
- **New agent:** describe a job in a sentence; Karuna drafts the agent, its schedule and its limits,
  members vote, and Karuna runs it in a sandbox (free Groq agents or Claude).
- **Runs:** a live timeline of every sandboxed run: its conversation with its model, each action and
  Karuna's decision, with Approve, Deny and Stop.

### Integrations
- **Circle:** the Agent Wallet on Arc testnet, the Circle CLI for transfers, x402 purchases, contract
  deploys and Gateway, and Gateway nanopayments for per-request data.
- **QuickNode:** one Stream (`karuna-events`) delivers Dharma's events and the wallet's USDC transfers,
  with HMAC-verified webhooks.
- **Arc testnet:** the dev org's Dharma is at `0x1034316a026f18096c42346ae2e549856380d933`.

### Console (web app)
- **Pages:** Home, Activity, Proposals, Agents, Safety, Team, Rules and Appearance.
- **Look and feel:** light, dark and system themes in the karunaprotocol.dev visual style, a Ctrl+K
  search, and Karuna's own confirm dialogs and pop-ups.
- **New agent card:** switches between New agent, Claude chat and Coding agents. A count shows on a tab
  when a connection is waiting for approval, and approving, denying and disconnecting happen right there.
- **Trust levels popup:** opened from the New agent card, with each level's limits editable by vote.
- **Safety card:** Drills, Traps and Inbox in one card with a switch.
- **Folding cards:** log and list cards slide open and closed: Rules, Payees, Trusted sites, Recent
  decisions, Decision log, In escrow, Wallet watchdog, Blocks and freezes, Learned from your choices
  and Running in a sandbox.
- **Dropdowns:** every dropdown uses the console's own styled list.

### Desktop app (Windows)
- The console in a window, plus the **island**: a notch at the top of the screen that shows agent
  activity and lets a member approve or deny right there.
- Tray menu (Open, Pause/Resume agents, Quit), close-to-tray, an installer, and links that open in
  the default browser.

---

## Timeline

| Date | What was built |
|---|---|
| **Nov 9** | Repo, Arc testnet setup and funded wallet; the policy engine and signed log; the Gatekeeper with Circle wallet payments; the first console |
| **Nov 10** | Dharma on Arc; QuickNode Stream and live alerts; Auto-Shield and changed-account alert; Swarm Stopper and trap passwords; the demo runner; sandboxes, gVisor and remote runners; the desktop app and island; CI |
| **Nov 11** | Dharma v2 (upgradeable, core changes, waits); rules for every action; the plain-English drafter; trust levels (v3) and the wallet watchdog; themes; dark mode fixes |
| **Nov 12** | Email sign-in; Claude Code and Cursor through Karuna; one combined QuickNode Stream |
| **Nov 14** | Chat apps as connectors; agents Karuna builds and runs; the Runs view; email and password sign-in; a Proposals page |
| **Nov 16** | The fast relayer; Karuna's own dialogs; the scrolling decision log; connector re-checks; trust-level tests |
| **Nov 17** | Escrow; the worst-case meter; Undo for runs; one proposal form; settings by vote; team roles and onboarding; log out and invite links |
| **Nov 18** | Dharma v5 after a contract review; a bug sweep; Pre-flight Drills; expiring holds; the New agent card with Coding agents; the Trust levels popup; styled dropdowns |
| **Nov 19** | Folding log and list cards |

---

## Running it
- **Everything at once (Windows):** `start-karuna.ps1` starts the Gatekeeper, relay, console, tunnel
  and desktop app.
- **Ports:** agent API 8787, console API 8788, chat connector 8792, relay 8790, console 4173.
- **More detail:** [`README.md`](README.md) for the full reference, [`SETUP.md`](SETUP.md) for setup,
  and [`docs/`](docs) for design plans.
