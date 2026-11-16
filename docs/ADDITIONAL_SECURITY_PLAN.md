# Plan: additional-security

Two features that answer the buyer's real question: *what's the worst that can happen, and can I undo it?*
Built on branch `additional-security`.

## 1. Undo button for agents

**Files (sandbox).** Before an agent writes a file, the sandbox snapshots it (copy-on-write
of the workspace per run). The console lists each run's changes as a diff and offers
**Undo this run** or **Undo this change**. Undo restores the snapshot and is logged.

**Payments (escrow on Arc).** Payments at or above an escrow threshold (a Dharma setting,
changed by vote) don't go straight to the payee:
- The Gatekeeper pays into a small escrow contract on Arc with a release time.
- Any one member can **Cancel** before it releases; the USDC returns to the org's wallet.
- After the window, anyone can release it (the Gatekeeper does it promptly).
- Escrowed, cancelled and released payments stream to every screen through QuickNode, and the
  wallet watchdog treats an escrow deposit as a Karuna payment.
- x402 data purchases stay instant (tiny amounts, paid via Gateway).

**Settings (Dharma).** `escrowThreshold` and `escrowWindow`: lowering the threshold or
lengthening the window is instant (tightening); the reverse is a vote.

**Tests.** Contract: deposit, cancel by a member, release after the window, no early release,
no release to anyone but the payee. Gatekeeper: payments over the threshold go to escrow,
the watchdog matches them, cancel/release flow. Sandbox: snapshot, diff, undo.

## 2. Worst-case meter

Because the rules are deterministic, Karuna can compute exactly what the org's agents could do
if every one of them were hijacked right now:
- **Money:** maximum USDC out per day without a human (sum of each agent's level limits and
  allow rules, capped by the wallet balance); maximum per single payment.
- **Systems:** which domains each agent can write to, which keys it can use, where it can write
  files, whether it can run package installs.
- **Shown** as one card on Home ("If every agent were hijacked: up to $X/day, write access to …")
  and per agent on its card.
- **On every proposal:** the change it would make ("+ $15/day, + write access to api.github.com"),
  next to Preview Before Loosening on the Votes page.

Pure function over the onchain policy (engine), so it's exact and unit-tested; no new chain state.

**Tests.** Engine: exposure for every rule kind, level, custom allow with caps, frozen org (zero),
core rules (never counted). Gatekeeper: snapshot carries it; proposals carry their delta.
