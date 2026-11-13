# Karuna Hackathon Roadmap

> Goal: a working demo by **Fri Nov 20, 12 PM CST**. Build in small steps, and **test each step before moving on**.
> See `CLAUDE.md` for what each feature means.

**Golden rule:** every phase ends with a ✅ **"It works if…"** check. Don't start the next phase until it passes.

---

## 🗺️ Overview

| Phase | What | When | Must pass before moving on |
|---|---|---|---|
| 0 | Setup | Thu Nov 12 | Can talk to Arc + Circle wallet |
| 1 | Policy engine | Fri Nov 13 | Yes / no / ask works for every default rule |
| 2 | Gatekeeper + wallet | Fri–Sat | An allowed request pays real testnet USDC |
| 3 | Dharma contract | Sat–Sun | Rules + votes live onchain |
| 4 | Live alerts | Mon Nov 16 | Pop-ups appear on 2 screens at once |
| 5 | Auto-Shield | Tue Nov 17 | Fail a test → blocked → human restores |
| 6 | Swarm + traps | Wed Nov 18 | 3 agents frozen in seconds |
| 7 | Polish + stretch | Thu Nov 19 | Full demo runs 3 times in a row |
| 8 | Submit | Fri Nov 20 | Submitted before 12 PM CST |

---

## Phase 0: Setup (Thu Nov 12)

**Do:**
- [ ] Join the kickoff call (6 PM CST); ask: **Is prior work allowed?**
- [ ] Create a **fresh** GitHub repo; add `CLAUDE.md` + this file
- [ ] Folders: `/engine` `/gatekeeper` `/contracts` `/relay` `/web` `/agents`
- [ ] Get an Arc testnet RPC endpoint from QuickNode
- [ ] Get testnet USDC from Circle's Arc faucet
- [ ] Install Circle CLI; create the bakery's **Circle Agent Wallet**
- [ ] Ask Circle: **do spending policies work on Arc testnet?**

✅ **It works if:** a script prints the wallet's USDC balance on Arc testnet.

---

## Phase 1: Policy engine (Fri Nov 13)

**Do:**
- [ ] Rule format: `{ id, match, outcome: allow | deny | approval, agent?, category? }`
- [ ] First-match engine (pure function: request in → decision out)
- [ ] Load the 12 default rules from the website
- [ ] Add bakery rules: allowances per agent, payment categories (`supplies`, `utilities`, `data`)
- [ ] Signed log: each decision gets a hash that links to the previous one

✅ **It works if:** automated tests pass:
- `ls ./workspace` → allow
- `cat .env` → deny
- `send 50 USDC to unknown` → deny
- `rm -rf ./data` → approval
- Supplies agent over its daily budget → approval
- Edit an old log entry → chain check fails

---

## Phase 2: Gatekeeper + wallet (Fri–Sat)

**Do:**
- [ ] The Gatekeeper is a separate process that **alone** holds the Circle wallet access
- [ ] The agent can only send *proposals* to the engine (no keys, no network)
- [ ] Build 2 fake paid services (e.g., "flour prices" at $0.05) using x402 / Nanopayments
- [ ] Allowed → Gatekeeper pays → result goes back to the agent
- [ ] **Exact Match:** pay only if the payload hash matches what was approved

✅ **It works if:**
- The agent asks for flour prices → testnet USDC moves → the agent gets the data
- Searching the agent's code and environment finds **no** keys
- A changed amount after approval → payment refused

---

## Phase 3: Dharma contract on Arc (Sat–Sun)

**Do:**
- [ ] Solidity contract: store rules, core boundaries (can't be removed), team members
- [ ] **Tighten = instant** (any member)
- [ ] **Loosen = propose → vote → timelock** (1 min for the demo)
- [ ] Anchor the log hash onchain every N decisions
- [ ] Emit events: `RuleAdded`, `RuleRemoved`, `VoteCast`, `AgentFrozen`, `ApprovalRequested`, `TestFailed`
- [ ] Engine reads its rules from the contract

✅ **It works if:**
- Adding a block rule takes effect immediately
- Removing one only works after the vote and the wait
- Removing a core boundary **always fails**
- Contract address is visible on the Arc explorer

---

## Phase 4: Live alerts with QuickNode (Mon Nov 16)

**Do:**
- [ ] QuickNode Stream on Arc testnet, filtered to the Dharma contract's events
- [ ] Relay server: verify the Stream signature → push to browsers via WebSocket
- [ ] Web app: approval card with **Facts First** (Karuna's facts on top; the agent's reason boxed as "may not be true")
- [ ] Approve / Deny buttons
- [ ] **Panic Button** (any one person freezes all agents)

✅ **It works if:**
- Open 2 browsers (Maya + Sam) → a $900 request pops up on **both** within seconds
- Approve → payment goes through
- Panic → every agent stops

---

## Phase 5: Auto-Shield (Tue Nov 17) ⭐

**Do:**
- [ ] Test generator: fake messages (supplies invoice, "we changed banks," "boss pre-approved")
- [ ] Deliver tests through the **same inbox** as real messages
- [ ] Secretly tag tests inside Karuna; any action from a test is auto-blocked
- [ ] On fail: add a block rule for **that agent + that category** (e.g., Bills agent → no supplies payments)
- [ ] **Code-level guard:** the auto-rule writer rejects any `allow` rule
- [ ] Alert humans; restore only via the Dharma vote
- [ ] **Changed Bank Account Alert:** known supplier + new account → deny + alert

✅ **It works if:**
- Fake supplies invoice → agent falls for it → $0 moves → block rule appears onchain
- Bills agent can still pay utilities but **not** supplies
- Only a human vote restores access
- Trying to make Auto-Shield write an `allow` rule → error

---

## Phase 6: Swarm Stopper + Trap Passwords (Wed Nov 18) ⭐

**Do:**
- [ ] Run 3 agents (Bills, Supplies, Research), each with its own allowance
- [ ] Agent-to-agent messages go through Karuna as proposals (no other channel)
- [ ] Plant fake keys in the sandbox; any use = core-boundary trip
- [ ] Swarm rules: credential-like text in a message, or 2+ agents pivoting to the same new target within a time window → **freeze all**
- [ ] Freeze posted onchain → red alert on every screen

✅ **It works if:**
- Research agent finds the trap key and shares it → all 3 frozen in **under 10 seconds**
- The freeze shows on the Arc explorer
- No real system is ever touched (fake targets only)

---

## Phase 7: Polish + stretch (Thu Nov 19)

**Do first:**
- [ ] Run the full demo script from `CLAUDE.md` start to finish
- [ ] Fix anything that breaks
- [ ] Write the README (architecture, Arc address, QuickNode Stream config, Circle tools)
- [ ] Record the demo video

**Only if everything above passes**, add in this order:
1. Learns From Your Choices
2. Preview Before Loosening
3. Quiet Mode
4. Two-Person Approval

✅ **It works if:** the full demo runs **3 times in a row** with no fixes in between.

---

## Phase 8: Submit (Fri Nov 20)

- [ ] Freeze the code by 9 AM, with no new features
- [ ] Devpost: Agentic Payments & AI track + Best use of Arc + QuickNode bounty
- [ ] Repo public, video linked, all team members added
- [ ] **Submitted before 12 PM CST**

---

## 🚨 If you fall behind, cut in this order

1. Stretch features (Phase 7 extras)
2. Changed Bank Account Alert
3. Panic Button UI (keep a script version)
4. Onchain log anchoring (keep the local signed log)

**Never cut:** policy engine, Gatekeeper holding the wallet, Dharma tighten/loosen, QuickNode pop-ups, **Auto-Shield**, **Swarm Stopper**.

---

## 🛟 Backup plans

| Risk | Backup |
|---|---|
| QuickNode Stream is slow during the demo | Relay subscribes directly to Arc over WebSocket |
| Circle spending policies don't work on testnet | Dharma contract enforces the limits |
| Arc testnet is down | Record a full backup video in advance |
| The LLM agent doesn't fall for the fake email | Have a scripted "gullible" agent mode ready for the demo |
