## What this changes
<!-- One or two sentences, in plain words. -->

## How I checked it
- [ ] `pnpm ci:check` passes locally (typecheck, tests, no-keys scan, console build)
- [ ] `forge test` passes in `contracts/` (if the contract changed)
- [ ] If a contract in `contracts/src/` changed: ran `pnpm --dir contracts build` and committed `contracts/js/`
- [ ] Tried it in the console (if the UI changed)

## Safety rules (CLAUDE.md §2) still hold
- [ ] Agents still hold no keys, wallet or money
- [ ] Nothing here lets an agent loosen a rule, or skips a vote
- [ ] No secrets in the diff (`.env`, keys, tokens, RPC URLs)
