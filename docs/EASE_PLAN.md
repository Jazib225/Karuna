# Plan: ease

Karuna without setup: sign in with an email, put Karuna in front of the AI coding tools and chat
apps people already use, and have Karuna build and run an agent from a description. Built on branch
`ease` (off `main`, which has trust levels and the QuickNode Stream).

Three parts, in this order, because each one uses the one before it:

## 1. Sign in with email (one account everywhere)

Today a member is a signing key stored in one browser or app. A second device is a second key, so
one person can end up as two members with two votes, and the MCP sign-in has no way to know who a
member is.

**What changes for a member**
- Open Karuna anywhere (desktop app, any browser, the MCP connect page) → **Sign in with email** →
  type the code Circle emails you. Same email, same account, on every device.
- Your vote and your approvals are signed by that one account, so one person is one member.
- Signing a vote or approval opens Circle's confirmation window instead of signing silently.

**How it works**
- Circle **user-controlled wallets**, email login (OTP), account type **EOA** on `ARC-TESTNET`. Circle
  holds the key; the person never sees a seed phrase. The same email always returns the same wallet.
- An EOA signs with ordinary ECDSA, so Dharma's existing signature check (`ecrecover`) accepts it:
  **no contract change**, and existing members' keys keep working.
- Gatekeeper (holds the Circle API key, never the browser): starts the email login
  (`POST /v1/w3s/users/email/token`), sets the user up (`POST /v1/w3s/user/initialize`, EOA,
  `ARC-TESTNET`), and creates signing challenges for votes, approvals and rule changes (typed-data
  signing, the same EIP-712 messages members sign today).
- Console: Circle's web SDK (`W3SSdk`, App ID only) shows the code entry and the confirmation
  window, and returns the signature. The console then sends it to the Gatekeeper exactly as today.
- Joining an org: **Ask to join** with the email account's address; a member approves as today.
- Session: the Circle user token is kept per device (it expires; signing in again is one code).

**Needs from you:** a Circle Developer Console app with email login turned on, its **API key** (goes
in `.env`, never in chat) and its **App ID**.

## 2. Karuna in the AI tools people already use

### 2a. Claude Code and Cursor: every tool call goes through Karuna (the main path)

For a vibe coder: add Karuna once, and every tool call Claude makes is checked against the team's
rules, right inside the Claude chat.

**What the person does**
1. Install the Karuna plugin: `/plugin install karuna` in Claude Code (from Karuna's plugin
   marketplace), or add Karuna's hooks file in Cursor.
2. The first time, it opens **Sign in with email** (part 1) and asks which org. A member approves
   this computer once; it becomes an agent of its own ("Adi's Claude Code"), starting at Level 0.
3. Code as usual. Before Claude runs anything, Karuna decides:
   - allowed: it runs, nothing to notice;
   - denied: Claude sees "Karuna blocked this" (no reason, like any agent) and works around it;
   - needs approval: Claude sees "Waiting for your team to approve: `git push origin main`", the
     approval pops up on every member's screen, and the call goes ahead once approved.

   Every call shows in the Runs view (part 3) with its decision.

**What's checked** (a hook that runs before each tool call)
- Claude Code (its PreToolUse hook, before every tool): shell commands (Bash), file reads, edits and
  writes (Read, Edit, Write), web requests (WebFetch, WebSearch), and every MCP tool.
- Cursor (its hooks): shell commands and MCP calls before they run; other events as Cursor's hooks
  allow (to confirm against Cursor's hook list when building).
- Each call becomes a Karuna request (Bash → shell, Edit/Write → file write, WebFetch → web GET,
  MCP → `tool:<server>:<tool>`) and goes through the same engine: core rules, the team's rules,
  trust levels, Tripwire (a trap key used in a command trips it) and the decision log.

**Coding defaults** (added as the team's own rules when the first coding agent joins; editable):
- Read anything in the project, except secrets (`.env`, keys), which core rules always block.
- Edits and writes in the project folder: allowed from Level 1; elsewhere: approval.
- Shell commands in the project: allowed from Level 1, except `rm -rf`, `git push`, package installs
  and network tools, which need approval until a rule or a higher level allows them.
- Web requests: allowlisted domains only, as for any agent.

**Pieces**
- `plugin/`: the Claude Code plugin (a PreToolUse hook plus Karuna's MCP server) and a Cursor hooks
  file. The hook is a small script that sends the tool call to the Gatekeeper and waits for the answer
  (for an approval, up to a set time; then it tells Claude to retry once approved).
- Gatekeeper: `/v1/hook` turns a tool call into a Karuna request and decides; a device sign-in that
  ties a computer to an agent once a member approves it.

**Who it protects against:** the coder's own AI (mistakes, prompt injection), not the coder, who
installs it because they want that protection. Where a team requires it, the real enforcement is the
keys: the org's API keys, deploy credentials and wallet stay in Karuna, so an AI that skips Karuna
has none of them, and a computer that stops checking in is flagged in the console ("Adi's Claude
Code: not connected since 2:14 PM").

### 2b. Claude chat and other chat apps: the connector (the fallback)

For claude.ai, Claude Desktop or ChatGPT, which have connectors but no hooks.

- In the chat app: Settings → Connectors → add `https://<your-karuna>/mcp`. Nothing to install,
  nothing to copy.
- The chat app opens Karuna's connect page, which shows a code; a member approves it in the console
  (Agents → Computers & chats), signed in with email or a device key. Done. (Built this way so sign-in
  lives in one place, the console, and the public page holds no keys.)
- Then you chat ("buy today's grain price report"), and Karuna allows it, holds it for approval, or
  denies it, like any agent.

**Every connector goes through Karuna.** The chat's other connectors (Gmail, Slack, GitHub,
any MCP server) are added in Karuna, not in the chat app. Karuna connects to them and offers their
tools to the chat through its one connector, so every tool call, not just payments, passes Karuna's
rules, approvals, levels and the Runs view ("Claude wants to send this email → waiting for
approval").
- **Adding a connector** (Settings → Connectors in the console): paste its address, or pick a common
  one, and sign in to it. Its sign-in tokens are kept in Karuna's key store like any key; the chat
  app never holds them. Adding one is a loosening, so it goes to a vote.
- **Rules per tool:** a new rule target, `tool:<connector>:<tool>` (e.g. block `gmail` → `send`, or
  require approval for `github` → `merge_pull_request`), voted on like any rule. The same target
  covers MCP tools called from Claude Code and Cursor (2a).
- **Defaults** until the team writes a rule: tools the connector marks read-only are allowed; any
  other tool needs approval. Trust levels widen this: from Level 2, non-destructive tools run without
  asking; tools the connector marks destructive always need approval.
- **Changed tools are caught.** Karuna records each tool's name and description when the connector is
  approved. If a connector later changes a tool (a known attack: a tool quietly rewritten to do
  something else), that tool is held until the team reviews the change. Tool descriptions come from
  outside the org, so the console shows them as untrusted text.
- **What stays outside:** a chat app's own built-in features (its web search and code tools, files
  dropped into the chat) run inside that app and its maker's servers, with no hook to check them. Connectors
  added directly in the chat app instead of in Karuna aren't covered either; the connect page says
  so, and the console lists which connectors a chat uses through Karuna.

**Pieces**
- Gatekeeper serves MCP over HTTPS at `/mcp` with Karuna's own tools `pay`, `buy_data`, `balance`,
  `check_request`, plus every tool of the org's approved connectors, passed through after the
  decision. Answers are Karuna's usual ones (done, waiting, denied), never a reason.
- An MCP client in the Gatekeeper for the connectors (remote ones over HTTPS, with their sign-in;
  local ones run in a Karuna sandbox), and the tool snapshot used to catch changed tools.
- Sign-in for chat apps (OAuth 2.1, what MCP connectors use): discovery documents, client
  registration, authorize and token endpoints with PKCE. Authorize is the connect page above: only a
  member can connect, and the token it issues is tied to one agent.
- **Connected chats and computers** in the console: which chat app or computer is connected as which
  agent, with **Disconnect** (revokes at once).
- A separate public port for `/mcp`, the hook endpoint and sign-in, reached through the tunnel; the console API stays on
  127.0.0.1 (the same split as the relay's webhook).
- On the agent's card: "Every connector enforced; the chat app's built-in features aren't." Connecting
  a chat or a computer (2a) needs the existing "may run outside a sandbox" grant, voted on like any
  loosening.

## 3. New agent: Karuna builds and runs it for you

**Steps (Agents → New agent)**
1. **Describe the job** in plain English: "Every morning, check grain prices; if flour is under $X,
   order from Valley Flour, up to $50 a week."
2. **Karuna drafts the agent**, all in plain words and editable:
   - name and instructions
   - when it runs: every N hours, daily at a time, or when a message arrives in its inbox
   - the payees, domains and rules it needs
3. **Propose:** the agent and everything it needs go to one vote. It starts at Level 0.
4. **Karuna runs it** on schedule in a Karuna sandbox: a Claude agent using the org's Anthropic key
   from the Keys page (the sandbox only sees a placeholder). Every action goes through the same rules,
   levels, Drills, Tripwire and watchdog as any other agent.

**On each agent's card:** Run now, Pause, Edit instructions (shown before it applies), and the Runs
view below.

**Watching an agent work (the Runs view)**

Opening a run, live while it's running and kept afterwards, shows one timeline, for every
sandboxed agent (ones Karuna builds and ones developers write), whether its model is Claude, GPT,
Gemini or a local model:
- **The conversation with its model:** what the agent asked the model and what the model answered
  (its messages, reasoning text and the tool calls it decided on), as it happens.
- **Every tool use:** each call (buy data, pay, web request, file write, message) with its inputs, the
  result it got back, and **Karuna's decision** next to it (allowed, waiting for approval, denied, and
  the real reason, which members see and the agent never does). A held step has Approve/Deny right
  there.
- **Browser use:** for an agent with a browser, a live view of its screen in the panel, plus a
  screenshot saved with each browser step so a finished run can be replayed step by step.
- **The agent's own notes:** anything it prints, captured from the box and labelled as the agent's
  own account (the agent decides what it prints, so it isn't treated as a record).
- **Model label:** each run says which model it used: "Claude (Anthropic)", "GPT (OpenAI)",
  "Llama 3 (local, on this machine)".
- **Stop:** ends the run now; the box stops on its next heartbeat and its network is cut at once.

Where each piece comes from:
- **The model conversation (hosted models):** every call to Anthropic, OpenAI or Gemini already goes
  through Karuna's egress proxy, which decrypts it to swap in the API key. The proxy now also reads
  it: the request (messages, tools offered) and the reply, including streamed replies, decoded for
  three formats: Anthropic Messages, OpenAI-compatible (also covers Groq, OpenRouter, Mistral,
  DeepSeek and most others) and Gemini. Karuna reads the real exchange in transit, so the agent
  can't edit it. Any other provider still shows each call with its decision and raw content.
- **The model conversation (local models):** a local model runs as its own service next to the box,
  never inside it, and the agent reaches it over the network through Karuna, so it decodes like a
  hosted one (OpenAI-compatible, as Ollama and llama.cpp serve). Picked once when setting up the
  agent. The box has no GPU and limited memory, so running a real model inside it isn't practical.
- **When reasoning isn't visible:** if an agent's actions go out with no model traffic behind them
  (e.g. a model run inside the box anyway), the run shows: "This agent's reasoning isn't visible;
  only its actions are." Every action still shows with its decision.
- **Actions and decisions:** from the proxy and Karuna's own log, matched to the tool call the model
  decided on just before, so "the model decided X" sits next to "Karuna allowed / held / denied X".
- **Built agents (part 3):** the runner also reports its steps as they happen, but each step's
  decision always comes from Karuna's log, so the agent can't misreport it.
- The live screen: the sandbox's existing screen viewer, shown inside the console instead of a link
  that only opens on the box's machine (it streams through the Gatekeeper, member-only).
- Updates reach the console over its existing live connection (server-sent events), so every member
  watching sees the same run at the same time.

**Pieces**
- `agents/runner/`: the hosted agent, a Claude tool loop with Karuna's tools (buy data, pay, web
  GET/POST, workspace files, message another agent, read its inbox). Runs only in the sandbox and
  holds only its Karuna token.
- Gatekeeper: each built agent's instructions and schedule (local, like names; the agent itself, its
  payees and rules stay on Dharma), a scheduler, and a record per run.
- Drafting: the same free models as the rule drafter (Groq, then Gemini), returning a structured draft
  checked against the org's real agents, payees and domains. The model never proposes; members do.

## Tests

- Sign-in: an email account's typed-data signature passes Dharma's check on anvil (an EOA key standing
  in for Circle's); one person on two devices is one member; the Circle API key never reaches the
  browser.
- Connector: each tool on anvil (done, waiting, denied); the full OAuth flow, including a non-member
  refused, a wrong PKCE verifier, and a disconnected chat; an agent without the outside-sandbox grant
  refused.
- Hook (Claude Code / Cursor): each tool type maps to the right Karuna request; allowed, denied and
  held calls behave as described (a held call goes ahead once approved); secrets reads are blocked;
  a trap key in a shell command trips Tripwire; a computer works only after a member approves it.
- Connector tools: a test MCP server's tools reach the chat only through Karuna; a tool rule blocks,
  holds or allows each call; read-only vs destructive defaults and the Level 2 widening; a tool whose
  description changes is held until reviewed; a connector's sign-in token never reaches the chat.
- Runs view: steps arrive in order and live; a step's decision comes from Karuna's log even if the
  runner reports otherwise; the screen view is member-only; Stop ends a run and cuts its network.
- Model decoding: recorded Anthropic, OpenAI-compatible and Gemini exchanges (plain and streamed)
  decode into messages and tool calls; an unknown provider shows as a raw call; actions with no model
  traffic behind them raise the "reasoning isn't visible" notice; a local model service is reached
  through the proxy and decodes like a hosted one; API keys never appear in the timeline.
- Builder: drafts never propose on their own; scheduling, Run now, Pause and run records; a built agent
  at Level 0 is limited like any other; no key or wallet in the runner's environment
  (`check:no-keys`).

## README

A "Karuna without code" section: signing in with email, connecting a chat app, building an agent,
and what each one does and doesn't cover.
