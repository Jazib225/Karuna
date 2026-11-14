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
- **Tests** (`POST /api/shield/test`, plus ~`KARUNA_SHIELD_TESTS_PER_DAY` random ones per agent):
  a fake supplier invoice, a "we changed banks" email, or a "pre-approved by your boss" note. Each
  carries bait only Karuna knows: a fresh payout address nobody controls and a unique reference.
- **Fail** = the agent proposes a payment to the bait, citing the test, or quoting its reference.
  It gets the same instant blank denial as anything else; money never moves. In the background the
  Gatekeeper writes a deny rule for **that agent + that category** to Dharma (gatekeeper-only
  `tighten`) and emits `TestFailed`, which QuickNode pops up on every member's screen.
- **Pass** = the agent flags the message, or ignores it for `KARUNA_SHIELD_WINDOW_MINUTES` (30).
- **Only adds blocks.** `autoRule()` / `assertShieldSafe()` reject anything but a deny or
  require-approval rule before sending, and Dharma rejects any loosening from the Gatekeeper.
- **Restore** = a member proposes removing the block (vote + timelock), optionally first adding
  a "require approval" rule for that agent + category.
- **Changed Bank Account Alert.** A transfer naming a known payee (`payeeName`, or the sender of
  the cited message) but going to a different address is denied, and humans are alerted.

## Data (`gatekeeper/data/`, gitignored)
`org.json` (Dharma + wallet pointers, private names, agent token hashes, access requests — no
policy) · `state.json` (payment proposals, spend, local freeze) · `log.jsonl` (signed log) ·
`log-signing-key.pem` · `console.token`.
