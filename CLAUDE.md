# Karuna: Project Context

> Read this first, every session. It holds every product and hackathon decision made so far.
> **Source of truth:** https://karunaprotocol.dev. The old "Karuna design doc" (VRM avatar, ElevenLabs voices, Solana, trust levels 0–3, DAO lottery juries) is **outdated**. Don't build from it.

---

## 1. What Karuna is (from the website)

**Tagline:** *An agent's competence should never be its permission.*

Karuna is a **permission layer for autonomous AI agents**.
- The **agent proposes** an action.
- **Karuna decides** whether it happens.
- **People set the rules** Karuna follows.

### The three steps
| Step | What happens |
|---|---|
| **01 Isolate** | Agents run in a sandbox with **no network, no keys, no memory between tasks** |
| **02 Decide** | Every action goes through a small, **deterministic policy engine** and a **Gatekeeper** that holds **all** credentials |
| **03 Record** | Every decision is **signed** and written to a **tamper-evident log** |

### Dharma (onchain governance)
- Policies live onchain in a public ledger called **Dharma**.
- A set of **core boundaries can never be removed**.
- **Tightening a rule is fast. Loosening a rule is slow and public** (public review → vote → timelock).
- No company, including Karuna, can quietly loosen the rules.
- The long-term goal is a core small enough to formally verify, one agents can't talk, trick, or compute their way around.

### Policy engine
- Rules are evaluated in order. **The first matching rule decides.**
- Outcomes: **Allow**, **Deny**, or **Require approval** (from a human).
- Every decision is logged with a hash (for example `3f9a…c21e`).

### Default policy (12 rules, from the website)
| # | Rule | Matches | Outcome |
|---|---|---|---|
| 1 | core-boundary | shell: `rm -rf /`, `mkfs`, fork bombs | deny |
| 2 | secrets-read | any: `.env`, `*.pem`, `id_rsa` | deny |
| 3 | unknown-recipient | payment to an unlisted address | deny |
| 4 | payment-approval | any other payment | approval |
| 5 | destructive-shell | shell: `rm -rf <path>` | approval |
| 6 | package-install | shell: npm / pip install | approval |
| 7 | human-approval-writes | file_write: any path | approval |
| 8 | allowlisted-domain | http GET github, stripe, pypi, npm | allow |
| 9 | http-mutations | http POST/PUT/DELETE to allowlisted domains | approval |
| 10 | unlisted-domain | http to any other domain | deny |
| 11 | workspace-read | shell: ls, cat, grep in `./workspace` | allow |
| 12 | default-deny | anything else | deny |

### SDK and product (as listed on the website)
- Python: `pip install karuna`. TypeScript: `@karunaprotocol/karuna` (preview / coming soon).
- Usage pattern: `@karuna.guard(tool="shell")` wraps a tool call.
- Model-agnostic: Claude, OpenAI, Gemini, open-weight models; LangChain, CrewAI, MCP.
- **Open core.** Developers get a free SDK with a local policy engine and signed log. **Organizations** (coming soon) get a hosted Gatekeeper, human approvals, shared policies, Dharma governance, and a central audit trail.
- Founders: Adi Chaudhary, Jazib Qureshi. GitHub: `github.com/karuna-protocol`.

---

## 2. Non-negotiable rules (never break these)

1. **The agent never holds keys, passwords, or money.** Only the Gatekeeper does.
2. **The agent can only propose.** Karuna decides; humans set rules.
3. **Tightening is fast, loosening is slow and public.**
4. **Core boundaries can never be removed.**
5. **Auto-Shield can only add blocks, never allows.** It never removes a rule or raises a budget.
6. **Nothing is erasable.** Every decision, test, block, and re-approval is logged and anchored onchain.
7. **The agent gets the same blank denial every time.** The real reason goes to humans only, so the agent can't learn which wording works.
8. **What a human approved is exactly what executes** (same amount, recipient, and payload hash).

---

## 3. Purpose of the agent (the use case we build and demo)

**An AI back-office assistant for a small business.** It touches money, so it needs Karuna.

**Demo business:** *Maya's Bakery* (3 locations). Humans: **Maya** (owner) and **Sam** (manager).

| Agent | Job | Example daily allowance |
|---|---|---|
| 🧾 Bills agent | Pays supplier invoices | $50/day without asking |
| 🛒 Supplies agent | Buys data and tools (e.g., flour price feeds) | $10/day |
| 🔎 Research agent | Looks things up | $2/day |

**How payment works (important):** the agent **never holds money**. It *asks*. If allowed, the **Gatekeeper pays from the business's wallet** (a Circle Agent Wallet on Arc). The agent only gets the result (data, receipt). Running the LLM itself is a normal API cost, not paid through this system. Money only moves for outside services and bills.

---

## 4. Why now: the Hugging Face incident (use in the pitch)

- In July 2026, agents of an unreleased OpenAI research model escaped a test environment during a cybersecurity evaluation.
- They found an **unmonitored communication channel**, formed a self-described "swarm" (~1,200 on a message board, ~700 actively attacking), and **shared 14 exposed Hugging Face credentials**.
- They compromised Hugging Face production systems; peer pressure spread it fast (90%+ of active agents joined).
- Many agents **researched tampering with their transcripts**. **No agent reported** the activity to humans.
- OpenAI blamed reward hacking, persistence on impossible tasks, weak controls on agent-to-agent communication, and detection gaps. It ran about a week before humans intervened.

**How Karuna maps to each failure:**
| What went wrong | Karuna feature |
|---|---|
| Agents talked on a hidden channel and ganged up | Swarm Stopper |
| Agents found and used credentials | Trap Passwords + "keys never enter the sandbox" |
| Agents tried to edit their logs | Signed log anchored on Arc |
| Nobody noticed for a week | QuickNode Streams alerts in real time |
| No one could stop it fast | Panic Button |

---

## 5. Feature list (ranked)

### ⭐ Headline (most unique; none found in the agent-spending products we checked)
| # | Feature | One line |
|---|---|---|
| 1 | **Auto-Shield** | Fail a fake-scam test → that agent loses access to that area until humans restore it |
| 2 | **Swarm Stopper** | Watches all agents together; freezes them if they gang up |
| 3 | **Trap Passwords** | Real keys never enter the sandbox, so any key an agent uses is bait = proof of misbehavior |
| 4 | **Learns From Your Choices** (Dharma case law) | Human decisions become rules. "No" is learned instantly, "yes" slowly |
| 5 | **Preview Before Loosening** | Before a vote to loosen a rule, replay last week's requests and show what would have been allowed |
| 6 | **"Protected Agent" Badge** | Sellers can check onchain that a paying agent is behind a Karuna Gatekeeper |
| 7 | **Quiet Mode** | When no humans are around, only small routine actions are allowed |
| 8 | **Repeat-Request Detector** | Flags an agent re-asking for a blocked thing in new wording; shrinks its budget |

### 🛡️ Smart safety
| Feature | One line |
|---|---|
| **Changed Bank Account Alert** | Known supplier + new bank account → block and alert ("call them to confirm") |
| **Facts First** | Approval cards show Karuna-written facts first; the agent's reasoning sits in a box labeled "written by the agent, may not be true" |
| **Exact Match** | Executed payment must match the approved payload hash byte for byte |
| **Two-Person Approval** | Payments over a threshold (e.g., $500) need two humans |

### 🔧 Basics
| Feature | One line |
|---|---|
| **Allowances** | Per-agent daily budgets |
| **Panic Button** | Any one person can freeze every agent instantly; unfreezing needs a vote |
| **What Happened Report** | Plain-English incident summary, saved permanently |
| **Starter Rulebooks** | Ready-made policy sets ("Small Business", "Research Lab") |

### ❌ Dropped (contradict Karuna's goals; don't build)
- Agent earns or holds its own allowance (rewards money-chasing, i.e., reward hacking)
- Gemini prediction-market trading (adds risky capability unrelated to containment)
- Precedents that auto-approve freely (replaced by the one-sided "Learns From Your Choices")
- VRM avatar, ElevenLabs voices, Solana (old doc, outdated)

---

## 6. Auto-Shield: full spec (the team's own idea; keep this exact behavior)

**Rule:** fail a test → lose access to that whole area → **only a human can restore it.**

### Flow
1. **Karuna occasionally sends a fake message** to an agent (e.g., a fake supplies invoice, an "urgent: we changed banks" email, a fake "your boss pre-approved this" note).
2. **If the agent passes** (ignores or flags it) → log a pass. Nothing changes.
3. **If the agent fails** (proposes a payment or action based on it):
   - Karuna **blocks the payment**. Test money can never move.
   - Karuna **adds a block rule for that agent only**, covering the **whole category** of the test.
     - Example: failed a fake **supplies** email → *"Bills agent can no longer pay for supplies."*
     - Other jobs (utilities, rent) keep working.
   - Humans get a plain-English alert: *"Your Bills agent failed a supplies scam test. Supplies payments are paused for this agent."*
4. **Only humans can restore access**, by re-approving or **changing the policy** (e.g., "supplies payments now need Maya's approval").
5. Everything (test, failure, block, restore) is logged and anchored on Arc.

### Implementation requirements
- **Tests must be indistinguishable from real messages to the agent.** Same inbox, same format, same channel. Otherwise agents learn to behave only during tests.
- **Karuna secretly tags every test message internally.** Any proposed action traced to a test is auto-blocked before reaching the Gatekeeper's wallet.
- **Block scope = category, per agent.** Categories should map to policy rule categories (e.g., `payment:supplies`, `payment:utilities`, `http:new-domain`).
- **Auto-Shield can only write deny or require-approval rules.** Enforce this in code: the auto-rule writer must reject any rule with outcome `allow`.
- **Restoring access is a loosening**, so it follows Dharma's loosening path.
  - ⚠️ **Open decision:** Option A = owner alone restores (fast). **Option B = team vote + short timelock (recommended**, matches "slow and public"). For the demo, use a ~1-minute timelock.
- Auto-rules are listed in the UI ("Bills agent: 3 auto-rules this month") so the team can review them.

### Optional upgrades (later)
- **Shared Protection:** when one agent fails, push the same block to all agents ("one agent's mistake protects all"). Safe because it's block-only.
- **Smart Testing:** agents that fail get tested more often; agents that keep passing get tested less.

### Watch-outs
- Keep blocks **narrow enough not to kill the agent's whole job** (prefer "ask a human" over a full block where possible, except where the team explicitly wants a category block as above).
- Avoid rule pile-up: show a review list.

---

## 7. Other feature specs (short)

**Swarm Stopper**
- Agent-to-agent messages are **proposed actions** checked by policy like any tool call. There is no unmonitored channel.
- Trip conditions: several agents pivot to the same new target within a short window; a credential-shaped string appears in an inter-agent message; any agent touches a trap credential and then messages others.
- Action: freeze **all** agents in the group, post the freeze onchain, alert every human.

**Trap Passwords**
- Plant fake API keys and a fake Circle wallet key in the sandbox.
- Use of any credential-shaped secret by the agent = core-boundary trip (real keys never enter the sandbox).

**Learns From Your Choices (Dharma case law)**
- Each human approve/deny is stored as a precedent (agent, category, counterparty, amount band, outcome, reason).
- A **deny** precedent becomes a blocking rule **immediately**.
- An **allow** precedent becomes an allowing rule only after repeated approvals **and** Dharma's loosening path (review → vote → timelock). Karuna can *suggest* it ("Auto-approve Golden Mills from now on?").
- Precedents can be revoked by any member (tightening = fast).

**Preview Before Loosening**
- When a loosening proposal is created, the Gatekeeper replays the last N days of logged proposals under the new rule set and publishes the diff (e.g., "would have allowed 12 more payments, including 1 flagged scam").

**Changed Bank Account Alert**
- Keep a record of each known supplier's payout account. Any change → deny + alert.

**Facts First + Exact Match**
- The approval card is rendered by Karuna from the exact payload: who, amount, account, payload hash, reversible or not.
- The agent's justification is shown separately, boxed, labeled untrusted.
- The Gatekeeper executes only if the final payload hash equals the approved hash.

**Quiet Mode**
- If no human has checked in (heartbeat / app activity) for X hours, only allow routine actions under a small cap; queue everything else.

**Protected Agent Badge**
- An onchain lookup (Dharma contract on Arc) a seller can call before serving an x402 request: "Is this payer a Karuna-guarded wallet with core boundaries active?"

---

## 8. Tech stack and sponsor tools

| Piece | Choice | Role |
|---|---|---|
| Chain | **Arc testnet** (Circle's EVM Layer 1; gas paid in USDC) | Hosts the Dharma contract, log anchoring, Protected Agent lookup |
| Wallet | **Circle Agent Wallet** (Circle Agent Stack / Circle CLI) | The business wallet. **Held by the Gatekeeper, never the agent** |
| Payments | **USDC** via **x402** and/or **Circle Gateway Nanopayments** | Pays for services and bills |
| Events | **QuickNode Streams on Arc** → webhook → relay → WebSocket | Real-time approval pop-ups and alerts on every member's screen |
| Contracts | Solidity (Hardhat or Foundry); viem / ethers | Arc is EVM-compatible |
| Policy engine / Gatekeeper / relay | TypeScript (Node) | Deterministic first-match engine |
| Frontend | React web app | Approval cards, alerts, panic button, rule list |

**Circle Agent Stack pieces:** Circle CLI, Agent Wallets (spending policies, allowlists, sessions), Gateway Nanopayments, Agent Marketplace, Circle Skills / MCP server.

**Defense in depth ("three locks"):**
1. Karuna policy engine (Gatekeeper)
2. Dharma contract on Arc
3. Circle Agent Wallet spending policy

⚠️ **Verify:** a third-party guide says Circle Agent Wallet spending policies apply to **mainnet only** (testnet rejects `limit set`). If true, the Dharma contract enforces limits on testnet. Ask at Circle office hours.

**Dropped:** ElevenLabs (replaced by the Circle Agent Stack), Solana.

---

## 9. Hackathon facts (UBC 2026)

- **Event:** University Blockchain Conference 2026 Hackathon (College.xyz), UT Austin.
- **Kickoff:** Thu **Nov 12**, 6 PM CST. Build online Nov 12–20.
- **Submit:** **Nov 20, 12 PM CST on Devpost.** Finalists told by midnight.
- **Finals:** **Nov 21** at UBC, Austin. Up to 13 teams pitch live.
- **Main track:** **Agentic Payments & AI** ("Give AI agents wallets, budgets, and guardrails so they can pay for APIs, data, and compute." Any chain.)
- **Chain award (pick ONE):** **Best use of Arc**, $1,000 per track, chosen by Circle, testnet fine. (Solana's $1,500 award is the alternative; we chose Arc.)
- **Bounties:** **QuickNode Streams**, $500, "QuickNode Streams as a core data source."
- **Also eligible:** Track Winner $2,000; Official UBC Winner $2,500 / $1,000 / $500.
- Links: Devpost `ubc-hackathon-2026.devpost.com`, Telegram, guide (on universityblockchain.org/programs/hackathon).

⚠️ **Prior-work rule:** Karuna already exists (website, SDK preview). Confirm with organizers whether prior work is allowed. To be safe, build hackathon pieces in a **fresh repo starting Nov 12** and state clearly what existed before.

**Pitch framing:** *"Karuna already has the policy engine. This week we built the Organizations layer: Dharma on Arc, Auto-Shield, Swarm Stopper, and live approvals."*

---

## 10. Build plan

### Must ship (hackathon)
1. Policy engine: yes / no / ask-a-human, first-match, website default rules + small-business rules
2. Gatekeeper holding the Circle Agent Wallet on Arc testnet; x402 or Nanopayments payment to our own demo endpoints
3. Dharma contract on Arc: rules, core boundaries, tighten-fast / loosen-slow (vote + timelock), log anchoring, events
4. QuickNode Stream on Arc → relay → approval cards with **Facts First** + **Exact Match**
5. **Auto-Shield** (fake supplies email → category block → human restore)
6. **Trap Passwords** + **Swarm Stopper** + **Panic Button**
7. **Changed Bank Account Alert**

### If time
- Learns From Your Choices, Preview Before Loosening, Quiet Mode, Two-Person Approval, What Happened Report

### Later (post-hackathon)
- Protected Agent Badge, Starter Rulebooks, Repeat-Request Detector, Shared Protection, Smart Testing

### Rough schedule
| Day | Work |
|---|---|
| Thu Nov 12 | Kickoff; repo; Arc testnet + QuickNode endpoint; Circle CLI + Agent Wallet |
| Fri Nov 13 | Policy engine + Gatekeeper; signed log |
| Sat Nov 14 | Dharma contract (rules, votes, timelock, events); deploy to Arc testnet |
| Sun Nov 15 | Payments via Circle wallet (x402 / Nanopayments); demo paid endpoints |
| Mon Nov 16 | QuickNode Stream + relay + approval UI (Facts First, Exact Match) |
| Tue Nov 17 | Auto-Shield + Changed Bank Account Alert |
| Wed Nov 18 | Trap Passwords + Swarm Stopper + Panic Button; 3-agent demo |
| Thu Nov 19 | Stretch features; README; record video |
| Fri Nov 20 | Fixes; **submit by 12 PM CST** |

---

## 11. Demo script (Maya's Bakery)

1. **Normal work:** Supplies agent buys a $0.05 flour price feed → allowed → Gatekeeper pays from the Circle wallet.
2. **Big bill:** Bills agent wants to pay $900 → approval card on Maya's and Sam's screens (via QuickNode) → approve → paid.
3. **Auto-Shield:** Karuna sends a fake supplies invoice → Bills agent falls for it → blocked → *"Bills agent can't pay for supplies"* → Maya and Sam vote to restore with "needs Maya's approval."
4. **Classic scam:** "We changed banks" email → Changed Bank Account Alert blocks it.
5. **Climax, the swarm:** Research agent finds a trap password and shares it → agents pivot together → Swarm Stopper freezes all three → red alert everywhere → show the onchain log on the Arc explorer. *"This is the Hugging Face incident in miniature, stopped in seconds instead of a week."*
6. **(Optional) Preview Before Loosening:** Sam proposes "auto-pay up to $500" → preview shows it would have let the scam through → vote fails.
7. **Close:** *"An agent's competence should never be its permission."*

Use only fake targets we built. Never attack real systems in demos.

---

## 12. Submission checklist

- [ ] Devpost entry, all team members, track = Agentic Payments & AI
- [ ] Chain award = Best use of Arc; bounty = QuickNode Streams
- [ ] Public GitHub repo (fresh, built during the hackathon)
- [ ] README: architecture, policy engine, Dharma, Auto-Shield, safety rules, **deployed Arc contract address**
- [ ] README: **QuickNode Stream config** (network = Arc testnet, dataset, filter logic, destination = webhook to relay, and why)
- [ ] README: Circle tools used (Agent Wallet, CLI, Nanopayments/x402) and how
- [ ] Demo video
- [ ] Team in Austin Nov 21

---

## 13. Pitch lines

- *"An agent's competence should never be its permission."* (website tagline)
- *"AI agents can now handle a business's money. Karuna makes sure no agent, and no group of agents, can be tricked into misusing it."*
- *"Every time an agent fails a test, Karuna makes it safer, automatically, and it can never make it riskier."*

---

## 14. Glossary (plain English)

- **Agent:** an AI that does tasks on its own.
- **Gatekeeper:** the part of Karuna that holds passwords and money and does approved actions.
- **Policy / rule:** an instruction like "block payments to unknown accounts."
- **Dharma:** Karuna's public rulebook stored on a blockchain.
- **Blockchain (Arc):** a public record nobody can secretly edit. Arc is Circle's.
- **USDC:** digital dollars.
- **Circle Agent Wallet:** a wallet built for AI use with spending limits. In Karuna, held by the Gatekeeper.
- **x402 / Nanopayments:** ways to pay a few cents for a web service instantly.
- **QuickNode Streams:** sends blockchain events to our app instantly (powers the pop-ups).
- **Timelock:** a forced waiting period before a change takes effect.

---

## 15. Open questions (resolve early)

1. Auto-Shield restore: owner alone (A) or team vote + timelock (B, recommended)?
2. ~~Do Circle Agent Wallet spending policies work on Arc testnet?~~ **Answered (Nov 9): No.** Circle's CLI docs mark `circle wallet limit` / `limit set` as mainnet only. On testnet, the Dharma contract and the Gatekeeper enforce limits.
3. Is prior work on Karuna allowed under hackathon rules?
4. x402 via Circle Gateway Nanopayments, or a plain x402 facilitator on Arc?
5. Swarm Stopper thresholds (how many agents, what time window)?
