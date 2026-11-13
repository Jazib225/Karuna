# @prekaruna/gatekeeper — Phase 2

The only process that can move money. Agents **propose**; the Gatekeeper computes the facts
itself, asks the policy engine, logs the decision, and — only if allowed or approved — pays from
the organization's Circle agent wallet on Arc testnet.

```bash
pnpm --dir gatekeeper start            # agent API :8787, console API :8788 (localhost)
pnpm --dir gatekeeper test             # unit tests with a fake wallet
VERIFY_WALLET=0x… pnpm --dir gatekeeper verify:phase2   # live checks on Arc testnet
```

Prerequisite: the Circle CLI logged in on this machine (`circle wallet login <email> --testnet`)
and, for x402 services, a Gateway balance (`circle gateway deposit --amount 1 --address 0x… --chain ARC-TESTNET --method direct`).

## Two APIs, on purpose
| API | Port | Who | Can do |
|---|---|---|---|
| Agent | 8787 | agents, with their agent token | `POST /v1/proposals`, `GET /v1/proposals/:id` — nothing else |
| Console | 8788, 127.0.0.1 only | the console (via its proxy), with the console secret | setup, approvals, panic, agents, payees, policy, signed log, live events |

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
- **Exact Match, three locks.** (1) The approval must carry the payload hash shown on the card.
  (2) Right before paying an approved x402 purchase, the seller is re-quoted and the payload is
  re-hashed; any change refuses the payment. (3) Circle's `--max-amount` caps the payment at the
  approved amount.
- **Two-person approval** at or above the org's threshold. **Panic** freezes everything;
  unfreezing needs two votes once the org has two members.
- **Nothing is erasable.** Every decision, approval, execution, refusal, freeze, and config change
  is appended to the ed25519-signed, hash-chained log in `data/log.jsonl`. The Gatekeeper refuses
  to start if that log was edited.
- Config changes are tagged `tighten` / `loosen` in the log; Phase 3 routes loosening through Dharma.

## Data (`gatekeeper/data/`, gitignored)
`org.json` (config — agent tokens stored only as hashes) · `state.json` (proposals, spend,
freeze) · `log.jsonl` (signed log) · `log-signing-key.pem` · `console.token`.
