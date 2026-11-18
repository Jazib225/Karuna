# Plan: streamline

Fewer places to look, and two answers a buyer asks first: *what's the worst that can happen, and can
I undo it?* Built on branch `streamline`.

## 1. Every proposal in one form

The rule form on Proposals (the one that isn't plain English) gets three more choices under
**Action**, next to **New payee**:

- **Trusted site.** A domain. Agents may read from it; Level 2+ may also write to it. (Dharma
  `AddDomain`.)
- **Two-signature limit.** The amount at which a payment needs two members to sign. (Dharma
  `SetThreshold`.)
- **New payee** (already built).

The Rules page shows what's in effect: rules, payees, and trusted sites, each with **Propose
removal**.

## 2. Keys where they're needed (no Keys page)

The Keys card goes. A key is asked for in the one place it's used:

- **Drafter key** (free Groq or Gemini). When none is saved, a field appears in both drafters: the
  plain-English rule box on Proposals and **New agent**. Used by Karuna only, never by agents, so no
  vote.
- **Claude key** (for agents Karuna builds). After **Draft the agent**, if none is saved, a field
  appears. **Propose agent** saves it and puts its use (sent only to `api.anthropic.com`, for this
  agent) in the same vote as the agent and its limits.
- **Connector sign-in key.** The connector form gets an optional key field; it's sent only to that
  connector's address.
- Every message that says "on the Keys page" points to the right place instead.

## 3. Undo button for agents

**Files (sandbox).** Before an agent writes a file, the sandbox snapshots it (copy-on-write of the
workspace per run). Each run in the Runs panel lists its changes as a diff with **Undo this run** and
**Undo this change**. Undo restores the snapshot and is logged.

**Payments (escrow on Arc).** Payments at or above an escrow threshold (a Dharma setting, changed by
vote) don't go straight to the payee:
- The Gatekeeper pays into a small escrow contract on Arc with a release time.
- Any one member can **Cancel** before it releases; the USDC returns to the org's wallet.
- After the window, anyone can release it (the Gatekeeper does it promptly).
- Escrowed, cancelled and released payments stream to every screen through QuickNode, and the wallet
  watchdog treats an escrow deposit as a Karuna payment.
- x402 data purchases stay instant (tiny amounts, paid via Gateway).
- This also applies to a Level 3 agent with no payment limit: large payments are still cancellable.

**Settings (Dharma).** An `escrow` rule (amount from, hold time), proposed from the proposal form and
voted like any rule. With several, the strictest applies (lowest amount, longest hold). The org's
Escrow is deployed by the relayer the first time a payment needs it; without a relayer key, a payment
that should be escrowed fails and nothing is paid.

## 4. Worst-case meter

Because the rules are deterministic, Karuna computes exactly what the org's agents could do if every
one of them were hijacked right now:
- **Money:** maximum USDC out per day without a member (each agent's level limits and allow rules,
  capped by the wallet balance; "no limit" shows the wallet balance); maximum per single payment.
- **Systems:** which sites each agent can write to, which keys it can use, where it can write files,
  whether it can install packages.
- **Shown** as one card on Home ("If every agent were hijacked: up to $X/day, write access to …") and
  per agent on its card.
- **On every proposal:** the change it would make ("+ $15/day, + write access to api.github.com"),
  next to Preview before loosening.

A pure function over the onchain policy (engine), so it's exact and unit-tested; no new chain state.

## Tests

- **Console:** each proposal-form choice builds the right Dharma change; key fields appear only when a
  key is missing; New agent's proposal includes the key binding.
- **Contract:** escrow deposit, cancel by a member, release after the window, no early release, no
  release to anyone but the payee; escrow settings tighten instantly, loosen by vote.
- **Gatekeeper:** payments over the threshold go to escrow; the watchdog matches them; cancel and
  release; snapshot carries the worst case; proposals carry their delta.
- **Sandbox:** snapshot, diff, undo of one change and of a whole run.
- **Engine:** exposure for every rule kind, level, custom allow with caps, frozen org (zero), core
  rules (never counted), no-limit levels.
