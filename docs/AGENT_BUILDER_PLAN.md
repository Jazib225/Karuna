# Plan: agent-builder

Two ways to use Karuna without writing code. Built on branch `agent-builder` (off `quicknode`:
it relies on trust levels).

## 1. "New agent": Karuna builds and runs it for you

For a PM or anyone non-technical. No code, no terminal.

**Steps in the console (Agents → New agent):**
1. **Describe the job** in plain English, e.g. "Every morning, check grain prices; if flour is under
   $X, order from Valley Flour, up to $50 a week."
2. **Karuna drafts the agent**, shown in plain words, every part editable:
   - name and instructions (what it does, step by step)
   - when it runs: every N hours, daily at a time, or when a message arrives in its inbox
   - the payees, domains and rules it needs (using the existing plain-English rule drafter)
3. **Propose:** the agent plus everything it needs goes to a vote, like any change. It starts at
   Level 0, so its first actions are small or need approval.
4. **Karuna runs it:** once the vote passes, the Gatekeeper starts it on schedule inside a Karuna
   sandbox: a Claude agent using the org's Anthropic key from the Keys page (only the egress proxy
   ever sees the key). Every action goes through the same rules, levels, Drills, Tripwire and
   watchdog as any other agent.

**Seeing what it did: a Runs view on each agent's card**
- every run: when, why it started (schedule, inbox message, Run now), its final answer/output,
  the actions it took with Karuna's decision for each, and anything waiting for approval
- **Run now**, **Pause** (stops scheduling; a running box stops on its next heartbeat), **Edit
  instructions** (a change to instructions is shown before it applies)
- live: a running agent's steps appear as they happen

**Pieces**
- `agents/runner/`: the hosted agent: a Claude tool loop with Karuna's tools (buy_data, pay,
  web GET/POST, read/write workspace files, message another agent, read inbox), instructions and
  job from the Gatekeeper. Runs only inside the sandbox, holds only its Karuna token.
- Gatekeeper: stores each built agent's instructions and schedule (local, like labels; the
  agent's existence, payees and rules stay on Dharma), a scheduler that starts runs, and a run
  record per run (output, actions, status) the console reads.
- Drafting the agent: the same free models as the rule drafter, returning a structured draft
  (name, instructions, schedule, needed payees/domains/rules) checked against the org's real data.
  The model never proposes anything; members do.

## 2. MCP connector: Karuna inside the chat apps people already use

For Claude Desktop, Cursor, Claude Code, or any MCP client. It's just a connector added to that
app; it doesn't need the Karuna console.

- `mcp/`: a small MCP server (stdio). Its only config is one agent's Karuna token.
- Tools, all backed by the existing agent API:
  - `pay`: pay one of the org's payees
  - `buy_data`: buy from an x402 service
  - `balance`: what this agent may still spend today at its level
  - `check_request`: the status of something waiting for approval
- Answers are Karuna's usual ones (done, waiting for approval, denied) and never a reason.
- Every call goes through Dharma's rules, trust levels, approvals and the watchdog; approvals pop
  up on every member's console and island as usual.
- Honest limit (shown on the agent's card): a chat app isn't sandboxed, so Karuna governs what goes
  through its tools (money and paid data), not the rest of what the chat app does. Such an agent
  needs the existing "may run outside a sandbox" grant, voted on like any loosening.
- README: how to add it to Claude Desktop and Cursor (one config block).

## Tests
- Runner: tool calls map to Karuna proposals; a denied action never runs; no key or wallet in its
  environment (extends `check:no-keys`).
- Gatekeeper: scheduling, Run now, Pause, run records; a built agent at Level 0 is limited like any
  other; drafts never propose on their own.
- MCP: each tool against a Gatekeeper on anvil; an unsandboxed agent without the grant is refused.
