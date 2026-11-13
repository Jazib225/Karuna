# @prekaruna/dharma — the onchain rulebook (Phase 3)

`src/Dharma.sol` holds an organization's whole policy on Arc: rules and core boundaries, payees,
agent allowances, allowlisted domains, the two-person threshold, members, and the freeze switch.
Every organization deploys its own (the console does it at setup). `js/` is the shared
TypeScript vocabulary the Gatekeeper and the console both use.

```bash
pnpm --dir contracts build   # forge build + export ABI/bytecode to js/ (committed)
pnpm --dir contracts test    # forge test
```

## The rules it enforces
| | How |
|---|---|
| **Tighten = fast** | `tighten()` — one member's signature (or the Gatekeeper alone, for Auto-Shield / Swarm Stopper). Applies in the same transaction. |
| **Loosen = slow + public** | `propose()` → `vote()` until a majority (`members/2 + 1`) → `timelock` seconds → anyone `execute()`s. A majority against defeats it. |
| **The contract decides direction** | `isTightening(op, data)` classifies every change. A loosening sent down the fast path reverts `NotTightening`; a tightening sent to a vote reverts `UseTighten`. |
| **Core boundaries are forever** | `core-boundary`, `secrets-read`, `unknown-recipient`, `default-deny` revert `CoreBoundary` on removal — by any path, at proposal and again at execution. |
| **Members sign, the Gatekeeper relays** | Members sign EIP-712 `Action`s with keys in their own browsers. The Gatekeeper submits them and pays gas but can't forge or alter one (`BadSignature`); nonces stop replays; deadlines expire them. |
| **Nothing is erasable** | `anchorLog(head, length)` records the signed log's head; the length can only grow. |

What counts as tightening: adding a deny/approval rule, removing an allow rule, removing a payee /
agent / domain, lowering an allowance or the two-person threshold, freezing. Everything else —
new payees, agents, domains, members, higher limits, allow rules, removing a block, unfreezing —
is a loosening.

## Privacy
Only what policy needs is onchain: addresses, agent ids, allowances, payee categories, domains,
rules, votes. Names (organization, members, agents, payees) stay in the Gatekeeper's local data.

## Events (for QuickNode Streams, Phase 4)
`RuleAdded` `RuleRemoved` `PayeeSet` `PayeeRemoved` `AgentSet` `AgentRemoved` `DomainAdded`
`DomainRemoved` `ThresholdSet` `AgentFrozen` `AgentsUnfrozen` `MemberAdded` `MemberRemoved`
`Tightened` `ProposalCreated` `VoteCast` `ProposalQueued` `ProposalExecuted` `ProposalDefeated`
`LogAnchored` `ApprovalRequested` `TestFailed`

## Deploying
Agent wallets are smart accounts that deploy through a factory, so `msg.sender` in the
constructor is not the org. The Gatekeeper and first member are explicit constructor arguments:
`constructor(gatekeeper, firstMember, timelockSeconds, thresholdMicroUsd, domains[])`.
Built with `optimizer = true, via_ir = true` (≈14 KB runtime, under the 24 KB limit).
