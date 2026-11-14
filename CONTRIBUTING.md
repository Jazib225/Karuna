# Working on PreKaruna together

**Nothing goes into `main` without (1) passing CI and (2) a review from the project owner.**

## The workflow
1. Start from the latest `main` on a new branch:
   ```bash
   git switch main && git pull && git switch -c your-change
   ```
2. Make the change. Before pushing, run the same checks CI runs:
   ```bash
   pnpm install
   pnpm ci:check                      # typecheck, tests, no-keys scan, console build
   (cd contracts && forge test)       # contract tests (needs Foundry)
   ```
3. Push the branch and open a pull request into `main`. Fill in the checklist.
4. GitHub runs **CI** (`.github/workflows/ci.yml`) and asks **@Jazib225** to review
   (`.github/CODEOWNERS`).
5. Merge only when CI is green **and** the review is approved.

## What CI checks (no secrets, nothing touches Arc)
| Job | What it proves |
|---|---|
| Typecheck | Every package compiles (engine, gatekeeper, relay, agents, web, contracts JS, test seller) |
| Unit tests | Policy engine + signed log, relay (QuickNode signatures), agents hold no keys |
| Gatekeeper tests | The Gatekeeper against the real Dharma contract on a local chain (anvil) |
| Dharma contract | `forge test`, and that `contracts/js` (ABI + bytecode) matches the contract |
| Console builds | `vite build` succeeds |

Live checks on Arc testnet (`verify:phase*`, `demo`) need a wallet and are run by hand.

## Turn on the protection (one time, repo owner)
GitHub → **Settings → Branches → Add branch ruleset** (or *Add rule*) for `main`:
- **Require a pull request before merging**, with **1 approval** and
  **Require review from Code Owners**
- **Require status checks to pass**: add all five CI jobs
  (*Typecheck*, *Unit tests*, *Gatekeeper tests*, *Dharma contract*, *Console builds*)
  and **Require branches to be up to date**
- **Block force pushes**

Note: on a private repository, enforced branch rules need a paid GitHub plan (Pro/Team). On the
free plan CI still runs and reports on every pull request, but merging isn't blocked automatically,
so merge only when it's green.
