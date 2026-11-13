# @prekaruna/engine — policy engine + signed log (Phase 1)

The deterministic heart of Karuna. A **pure function**: a proposed `Request` goes in, a
`Decision` (`allow` / `deny` / `approval`) comes out. The **first matching rule decides**.
No keys, no network, no wallet — that is the Gatekeeper's job (Phase 2).

## Run
```bash
pnpm install
pnpm test     # every ROADMAP Phase 1 check + log restore/events
pnpm demo     # prints a gatekeeper-terminal run + a verified signed log
```

## Files
| File | What |
|---|---|
| `src/types.ts` | `Request`, `Decision`, `Rule`, `PolicyContext` |
| `src/rules.ts` | The 12 website rules + the allowance rule, in order; `buildContext()` |
| `src/engine.ts` | `evaluate()` — first-match; `agentFacingResult()` — blank denial to the agent |
| `src/log.ts` | `SignedLog` — ed25519-signed, hash-chained, tamper-evident |
| `src/demo.ts` | Phase 1 showcase |

## The ruleset (first match wins)
1. `core-boundary` → **deny** — `rm -rf /`, `mkfs`, fork bombs *(a Dharma core boundary; never removable)*
2. `secrets-read` → **deny** — `.env`, `*.pem`, `id_rsa`
3. `unknown-recipient` → **deny** — payment to an unlisted address
4. `payment-within-allowance` → **allow** — known recipient, inside the agent's daily cap *(allowance rule)*
5. `payment-approval` → **approval** — any other payment
6. `destructive-shell` → **approval** — `rm -rf <path>`
7. `package-install` → **approval** — npm/pnpm/yarn/pip install
8. `human-approval-writes` → **approval** — any file write
9. `allowlisted-domain` → **allow** — HTTP GET to github/stripe/pypi/npm
10. `http-mutations` → **approval** — POST/PUT/DELETE to an allowlisted domain
11. `unlisted-domain` → **deny** — HTTP anywhere else
12. `workspace-read` → **allow** — `ls`/`cat`/`grep` inside `./workspace`
13. `default-deny` → **deny** — everything else

## Safety properties enforced here (CLAUDE.md §2)
- **Agent only proposes.** It receives `agentFacingResult()` — just the outcome, never the reason, so it can't learn which wording gets through (rule 7).
- **Nothing is erasable.** Every decision is hash-chained and ed25519-signed. Editing any
  past entry breaks the chain and signature; `log.head()` is the hash Phase 3 anchors on Arc (rule 6).
- **Deterministic.** Same input → same output. A throwing predicate fails closed, never allows.

There is no built-in organization. `buildContext(orgConfig, spentToday)` turns each org's own
agents, allowances, payees, and allowlisted domains into the engine context. Tests use a neutral
fixture in `test/fixture.ts`.
