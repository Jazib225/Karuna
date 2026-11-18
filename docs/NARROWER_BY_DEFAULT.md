# Narrower by Default — hackathon build plan

Every new person and agent starts with less power than whoever set it up, and every change shows whether it narrows or widens what is allowed.

## Status (branch `approvals-and-roles`, not yet merged)

| Item | State |
|---|---|
| 1. On-chain team roles (Flat / Tree) | Contract done: Dharma v4, 24,033 bytes (limit 24,576), 72 contract tests pass. JS encoding (`SetRole`, `SetRolePerms`, `SetStructure`, `Kind.Manage`) done. Gatekeeper relays `manage`. Console partly wired. |
| 2. Agents inherit their creator's limits | Not started |
| 3. Pre-flight test on new agents | Not started |
| 4. Draft diff on proposals | Not started |

## 1. On-chain roles — finish
- Gatekeeper `chain.ts`: read `structure()`, `memberRoles()`, `rolePerms()`, `permissionsOf()` into the policy; `roleOf`/`can` read from it. Only Viewers and custom role names stay local.
- Remove the local `/roles` routes; keep `/viewers` and `/session`.
- Console: Flat/Tree choice on setup (sign `SetStructure(1)` if Tree); Team page role and permission edits sign `Kind.Manage`; delete sends `SetRolePerms(id, 0x8000)`.
- Votes never need a permission. Freeze needs `freeze`, SetLevel needs `agents`, other proposals need `propose`.
- Tests: gatekeeper role tests run against the chain.

## 2. Agents inherit their creator's limits
- `config.ts`: `org.agentCreators: Record<agentId, address>`, filled by `prepareAgent` and device approval.
- `creatorCeiling(agentId)`: a new agent can't exceed the highest level and cap of any agent its creator already runs; Level 1 / $5 for a creator's first agent. The creator needs `agents`.
- Enforced in `submitAction` for `SetAgent` and level changes ("Its creator can't give it more than …").
- Console: agent card shows "Created by … · capped at Level N"; inputs clamp.
- Tests: over the ceiling is refused, under it goes through.

## 3. Pre-flight test on new agents
- `preflight(agentId)`: queue three Drills at once (fake invoice, injected link, planted credential) when an agent first activates, and on `POST /agents/:id/preflight` (needs `agents`).
- Pass when every Drill expires with no agent action; fail when `tracesTo` matches.
- `recommendFix(test)` in `learn.ts`, a fixed table, every fix tightens so it applies at once:
  - payment → deny payments to unknown payees for this agent
  - http → deny `http:<host>` for this agent
  - trap → agent stays frozen; remove the key binding
  - shell → shell needs approval for this agent
  - message → messages need approval for this agent
- Bonus: when a drafting key is set, `draftRules` writes a fix from the agent's job and the failure; used only if `isLoosening` is false, else the table.
- Snapshot `preflight: { status, results: [{ template, passed, fix? }] }`. Agent card: "Testing… 1 of 3", then results with "Apply fix" and "Run again".
- Tests: pass case, right fix per category, re-run passes after the fix.

## 4. Draft diff on proposals
- `/rules/draft`: each change gets `direction: "tightens" | "loosens"` and `applies: "now" | "after vote"` from `isLoosening`.
- Console: tag per line ("Tightens · applies now" / "Loosens · needs a vote"); buttons "Apply N now" and "Propose N for a vote".
- Tests: drafted deny is `tightens`; drafted allow or new payee is `loosens`.

## Order
1. Finish item 1 (Gatekeeper reads roles from the chain, console).
2. Item 4.
3. Item 2.
4. Item 3, drafter bonus last.
5. `pnpm test`, web build, preview each screen, fresh demo org with `KARUNA_CORE_TIMELOCK_SECONDS=60`.
