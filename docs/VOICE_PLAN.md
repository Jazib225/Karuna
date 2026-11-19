# Karuna Voice: island expansion + ElevenLabs

> **Status (Nov 2026):** planned, not built. Targets the ElevenLabs bounty (voice central, not an
> add-on). Main track is unchanged: Agentic Payments and AI on Arc.

> Goal: **run your organization by talking to the island.** Karuna tells you what your agents
> want, out loud, and you answer out loud. Voice can always make things safer at once; it can
> never make them looser without proof that a member said so.

## Why

The human side of Karuna is short, interrupting moments: an agent's payment is held, a vote is
open, something looks wrong and you want every agent stopped. Today each one means a mouse on
the island or a trip to the console. Voice fits these moments well:

- You hear the request while you're doing something else.
- You answer without switching windows.
- The whole app becomes usable without a screen or mouse.

The risk is the usual one for Karuna: a voice model is an AI that can be talked into things,
including by text an agent wrote. So the voice agent is governed the same way as every other
agent. It holds no keys, every action it takes goes through the Gatekeeper, and loosening needs
a signed member decision.

## What the person sees

```
 idle pill  ──(hotkey or tap the lotus mic)──►  voice panel
 ┌──────────────────────────┐                  ┌────────────────────────────────────────────┐
 │ (lotus) Watching         │                  │ (lotus, moving with the voice) Listening…  │
 └──────────────────────────┘                  │ You:     "What did my agents spend today?" │
                                               │ Karuna:  "$42.10 across 3 agents. The      │
                                               │           coding agent has one payment     │
                                               │           waiting."                        │
                                               │ ┌────────────────────────────────────────┐ │
                                               │ │ Pay Acme Data $40 · over its daily cap │ │
                                               │ │ Say "approve 4 7 2" to approve it      │ │
                                               │ └────────────────────────────────────────┘ │
                                               └────────────────────────────────────────────┘
```

**1. Spoken alerts.** When an action is held, the island plays a short chime and reads it aloud.
For example: "Research agent wants to pay 40 dollars to Acme Data. It's over its daily cap.
Approve or deny?" The sentence is built only from Gatekeeper fields (agent, amount, payee, the
matching rule). If you ask "what's it for?", Karuna reads the agent's own reason, introduced as
"In the agent's words:", in the same way the card already marks that text as untrusted.

**2. Voice panel (the island expansion).** The pill opens into a wider panel:
- the lotus moves with the voice level (listening vs. speaking)
- a live transcript of both sides, last few turns
- action cards: what Karuna is doing ("Freezing every agent… done"), drafts waiting for a
  confirmation, and the approval card with its spoken code
- push-to-talk on a global hotkey (`Ctrl+Shift+Space`), plus a mic button on the pill

The panel follows the island's current behavior. It works in notch and floating modes, closes
when the conversation ends or after a short idle period, and reports its area for click-through
like the card does.

**3. Votes in the island, too.** Open proposals that need your vote show in the island, not just
held actions ("Vote: raise the coding agent to Level 2"). Yes/No works by click or by voice, and
is signed the same way approvals are today. This is needed for voice anyway, and it's useful
without voice.

## What the voice agent can do

The ElevenLabs agent gets **client tools only**: functions that run in the desktop app. It never
calls the Gatekeeper or the chain directly.

| Tool | Kind | How it runs |
|---|---|---|
| `status` | read | Agents, levels, paused or not, today's spend, wallet balance |
| `pending` | read | Held actions and open votes waiting on me |
| `explain(id)` | read | Gatekeeper fields for one item: rule that matched, what happens if unanswered |
| `recent` | read | Last decisions |
| `freeze_all` | tighten, at once | `POST /pause` (needs the freeze permission) |
| `lower_level(agent, level)` | tighten, at once | Signed `tighten`, same as the console |
| `deny(id)` | tighten, at once | Signed deny, same path as the island's Deny button |
| `vote_no(id)` | tighten, at once | Signed vote |
| `approve(id)` | **loosen, needs spoken code** | Signed approve after the code check |
| `vote_yes(id)` | **loosen, needs spoken code** | Signed vote after the code check |
| `resume_all` | **loosen, needs spoken code** | `POST /resume` after the code check |
| `draft_rule(text)` | draft | `POST /rules/draft`; the draft shows in the panel |
| `propose_draft(id)` | **needs spoken code** | Signed propose. Still needs the team's vote in Dharma |

**Spoken code (how loosening stays a member's decision).**
1. `approve(id)` doesn't approve anything. The island makes a random three-digit code, shows it
   on the card, and returns "Ask them to say: approve 4 7 2."
2. The island watches the **user's** final transcripts from the SDK (not the model's replies).
   Only when a user transcript matches `approve 4 7 2` within 30 seconds does the island ask the
   console to sign.
3. The model can't produce a user transcript. Agent text it read can't approve anything, and
   neither can a model that misheard or made something up. A code works once, for one id and one
   payload hash.

Everything signed goes through the existing path: island → Rust → console window signs with the
member key → Gatekeeper. The same id and payload-hash checks apply. Dharma and the Gatekeeper
enforce exactly what they do today; voice adds no new authority.

## ElevenLabs products used

| Product | Where | What for |
|---|---|---|
| **Agents** (`@elevenlabs/client`, WebRTC) | Island voice panel | The conversation: speech recognition, the model, voice replies, client tools |
| **Text to speech** (streaming, Flash model) | Gatekeeper `POST /voice/speak` | Spoken alerts for held actions and votes, read even when no conversation is open |
| **Sound effects** | Generated once, saved in `desktop/src/island/sounds/` | Island chimes: needs you, approved, denied, frozen |

The ElevenLabs key lives in the Gatekeeper's `.env` (`ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`,
`ELEVENLABS_VOICE_ID`), never in the desktop app, which matches how Karuna handles every other key.

## Changes

**Gatekeeper (`gatekeeper/src/voice.ts`, routes in `server.ts`)**
- `GET /voice/session`: returns a WebRTC conversation token from ElevenLabs
  (`/v1/convai/conversation/token?agent_id=…`). Console session required.
- `POST /voice/speak { id }`: builds the alert sentence from the pending proposal itself, then
  streams TTS audio back. It never accepts free text, so Karuna can't be used to speak arbitrary
  words. A second form, `{ id, reason: true }`, reads the agent's reason with the "agent's words"
  framing.
- Reports whether voice is set up in `/health` or settings, so the console can show the switch.
- `gatekeeper/scripts/voice-agent.ts`: creates or updates the ElevenLabs agent through the API.
  It sets the system prompt, voice, and the client tool definitions (names and parameters must
  match the island exactly), and prints the agent id for `.env`. The agent stays reproducible
  instead of a dashboard setting.

**Desktop app**
- `desktop/src-tauri`:
  - global shortcut plugin for push-to-talk
  - microphone permission for the island webview (WebView2)
  - a `karuna://voice-call` event pair, so island tools can ask the console window for reads and
    signatures. This extends the existing sign-request path.
- `desktop/src/island/voice.ts` (new):
  - starts and ends the conversation
  - client tool handlers
  - spoken-code check against user transcripts
  - plays alerts from `/voice/speak` and the chimes
- `desktop/src/island/main.ts` and `island.css`:
  - voice panel state (`listening` / `speaking` / `thinking`)
  - transcript, action cards, vote cards
  - lotus driven by `getInputVolume()` / `getOutputVolume()`
  - the panel's area added to `reportRects`
- Pipe (`gatekeeper/src/pipe.ts`): add `vote_requested` / `vote_resolved` events so the island
  sees open votes.

**Console (`web/`)**
- One **Voice** switch, plus "read alerts aloud", in the existing Appearance card next to the
  island switch. Settings live in the card they change.
- Handles `karuna://voice-call` from the island: reads through `api()`, and signs with the member
  key exactly as it does for `karuna://sign-request`.

## Tests

- Gatekeeper:
  - `/voice/speak` builds sentences only from proposal fields
  - unknown or non-pending ids are rejected
  - free text is rejected
  - `/voice/session` needs a console session
  - ElevenLabs is mocked
- Island (unit, no audio):
  - the code check accepts only a matching **user** transcript, once, within the time limit
  - it rejects agent-message matches, wrong ids, expired codes and reused codes
  - tighten tools never ask for a code
- Manual:
  - push-to-talk in both island modes
  - an alert while another app is focused
  - full approve-by-voice with the console minimized

## Order

1. Gatekeeper voice routes and the agent setup script (testable with no UI).
2. Spoken alerts and chimes in the island. This is the smallest working voice feature.
3. Voice panel: conversation, transcript, read tools, tighten tools.
4. Spoken-code approvals, votes in the island, `propose_draft`.
5. Console Voice switch and README section (products used and how, as the bounty asks).
6. Demo recording with audio:
   - an agent's payment is held and Karuna says so
   - "What's it for?"
   - "Approve 4 7 2"
   - "Freeze every agent"

## Optional: Grok Bot as a governed agent

Grok Bot can call remote MCP servers, and Karuna already serves one (`/mcp` on port 8792 through
the tunnel). Connecting Grok Bot there makes it one more Karuna agent: its own agent at Level 0,
payments only to saved payees, the team's connectors only through Karuna. The keys and the wallet
stay in Karuna. A Grok Bot routine can watch Arc for the org's activity and act through those
tools. Anything over its limits is held, and the island reads it aloud. Karuna can't govern what
Grok does on its own computer or on X (its browser, its posts); it governs everything that needs
your money or your keys. Check before building: that Grok Bot's MCP setup supports Karuna's
connect flow (a member approves a code), or else add a token header option.
