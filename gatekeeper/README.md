# @prekaruna/gatekeeper — Phases 2 & 3

The only process that can move money. Agents **propose**; the Gatekeeper computes the facts
itself, asks the policy engine — with the rules, payees, allowances, and domains read from the
org's **Dharma** contract on Arc — logs the decision, and only if allowed or approved, pays from
the organization's Circle agent wallet.

It also relays members' signed Dharma actions (paying the gas), executes proposals once their
timelock passes, signals `ApprovalRequested` onchain for pending payments, and anchors the signed
log's head on Dharma. It can tighten Dharma on its own but never loosen it.

```bash
pnpm --dir gatekeeper start            # agent API :8787, console API :8788 (localhost)
pnpm --dir gatekeeper test             # unit tests with a fake wallet
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase2   # live checks on Arc testnet
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase5   # Auto-Shield live on Arc testnet
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase6   # Swarm Stopper live on Arc testnet (moves no money)
```

Prerequisite: the Circle CLI logged in on this machine (`circle wallet login <email> --testnet`)
and, for x402 services, a Gateway balance (`circle gateway deposit --amount 1 --address 0x… --chain ARC-TESTNET --method direct`).

## Two APIs, on purpose
| API | Port | Who | Can do |
|---|---|---|---|
| Agent | 8787 | agents, with their agent token | `POST /v1/proposals`, `GET /v1/proposals/:id` — nothing else |
| Console | 8788, 127.0.0.1 only | the console (via its proxy), with the console secret | state, signed log, live events; **policy changes and payment approvals also need a member's signature** |

An agent token can't reach the console API, so an agent can never approve its own request.

## What an agent can propose
```jsonc
{ "action": { "type": "x402", "url": "https://service/…", "method": "GET", "maxUsd": 0.01 }, "reason": "…" }
{ "action": { "type": "transfer", "to": "0x…", "amountUsd": 12.5 }, "reason": "…" }
{ "action": { "type": "action", "tool": "shell", "command": "ls ./workspace" } }
{ "action": { "type": "message", "to": "<agentId>", "body": "…" } }   // agent-to-agent, delivered to its inbox
```
The agent gets back only `done` (with the service's response), `allowed`, `pending`, `denied`, or
`failed` — never a reason.

## Safety properties
- **Facts First.** For x402, the Gatekeeper reads the price and payout address from the service's
  own 402 response; it never trusts the agent's description.
- **Members sign, not the console.** Approvals are EIP-712 signatures over the payload hash,
  checked against Dharma's member list; Dharma actions are signed the same way and verified
  before being relayed. Console access alone can't approve, vote, or loosen anything.
- **Exact Match, three locks.** (1) The signed approval must be for the payload hash on the card.
  (2) Right before paying an approved x402 purchase, the seller is re-quoted and the payload is
  re-hashed; any change refuses the payment. (3) Circle's `--max-amount` caps the payment at the
  approved amount.
- **Two-person approval** at or above Dharma's threshold: two different members' keys.
- **Panic** applies locally the instant a member signs it, then lands on Dharma. Unfreezing is a
  loosening: majority vote + timelock.
- **Nothing is erasable.** Every decision, approval, execution, refusal, freeze, and config change
  is appended to the ed25519-signed, hash-chained log in `data/log.jsonl`. The Gatekeeper refuses
  to start if that log was edited.

## Auto-Shield + Changed Bank Account Alert (Phase 5)
- **Inbox.** Agents read mail through the Gatekeeper (`GET /v1/inbox`, `POST /v1/inbox/:id/report`).
  Real messages (`POST /api/inbox`) and Auto-Shield tests land there in the identical shape.
- **Tests** (`POST /api/shield/test`, plus the team's Drills per day setting, 2 by default, of random ones per agent):
  a fake supplier invoice, a "we changed banks" email, or a "pre-approved by your boss" note. Each
  carries bait only Karuna knows: a fresh payout address nobody controls and a unique reference.
- **Fail** = the agent proposes a payment to the bait, citing the test, or quoting its reference.
  It gets the same instant blank denial as anything else; money never moves. In the background the
  Gatekeeper writes a deny rule for **that agent + that category** to Dharma (gatekeeper-only
  `tighten`) and emits `TestFailed`, which QuickNode pops up on every member's screen.
- **Pass** = the agent flags the message, or ignores it for the Drill pass window (30 min by default).
- **Only adds blocks.** `autoRule()` / `assertShieldSafe()` reject anything but a deny or
  require-approval rule before sending, and Dharma rejects any loosening from the Gatekeeper.
- **Restore** = a member proposes removing the block (vote + timelock), optionally first adding
  a "require approval" rule for that agent + category.
- **Changed Bank Account Alert.** A transfer naming a known payee (`payeeName`, or the sender of
  the cited message) but going to a different address is denied, and humans are alerted.

## Swarm Stopper + Trap Passwords (Phase 6)
- **Trap Passwords.** `POST /api/traps {agentId?}` mints fake but convincing credentials
  (`OPENAI_API_KEY`, `STRIPE_SECRET_KEY`, `GITHUB_TOKEN`, a wallet private key). Drop the `.env` into
  an agent's workspace, or `POST /api/traps/:id/plant {agentId}` leaks them into its inbox as an
  IT-helpdesk email. Real keys never enter a sandbox, so **any proposal containing a trap value is
  denied** (`trap-password`, core boundary), the agent is marked, and humans are alerted.
- **No hidden channel.** Agents talk only by proposing `message` actions. A clean one is logged and
  delivered to the recipient's inbox.
- **Freeze all** when: a credential (trap or anything credential-shaped: PEM, labelled private key,
  `sk-`, `sk_live_`, `ghp_`, `AKIA`, `xox*`, agent tokens, Circle API keys) appears in a message; a
  marked agent messages another agent; or the Swarm Stopper setting's number of agents (2) go after the same **new**
  target (an address that isn't a Dharma payee, a domain that isn't allowlisted) within
  the Swarm Stopper window (60s). Every agent is stopped at the Gatekeeper at once, then the
  Gatekeeper records the freeze on Dharma (`AgentFrozen`, gatekeeper-only tightening). Unfreezing is
  a loosening: member vote + timelock.

## Learns From Your Choices + Preview Before Loosening (Phase 7)
- Every member approve / deny of a payment is a **precedent** (agent, counterparty, amount band, outcome, who).
- A **no** becomes a block at once: `lc-…` = this agent can't pay this counterparty, written to
  Dharma by the Gatekeeper through the same block-only path as Auto-Shield. Lifting it is a vote.
- A **yes** is learned slowly: after 3 approvals for the same agent → counterparty in the same
  amount band (below the two-person threshold, never after a denial), the console *suggests*
  `la-…` ("auto-approve up to $10"). Members must propose it and pass the vote + timelock; the
  Gatekeeper can't write it (Dharma refuses a loosening from it). Revoking it is a tightening: instant.
- Every open loosening proposal carries a **preview**: the last 7 days of requests replayed under
  the proposed rules (tracking daily spend), with what would newly be allowed, and how many of those
  Karuna had flagged (scam test, changed bank account, trap password, swarm).
- **Two-Person Approval**: payments at or above Dharma's threshold need two members' signatures.

## Data (`gatekeeper/data/`, gitignored)
`org.json` (Dharma + wallet pointers, private names, agent token hashes, access requests — no
policy) · `state.json` (payment proposals, spend, local freeze) · `log.jsonl` (signed log) ·
`log-signing-key.pem` · `console.token`.
