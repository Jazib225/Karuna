# Grok Bot: Karuna's watcher on Arc

Grok Bot is xAI's always-on agent: it has its own cloud computer, runs **routines** on a schedule,
and can be tagged with **@bot** on X. In Karuna it does two jobs:

1. **Watches your team on Arc.** A Grok Bot routine reads what happened onchain every few minutes
   (payments and their transactions, payments waiting for approval, votes on Dharma, wallet
   transfers the watchdog saw, freezes, how much of the signed log is anchored), checks anything
   waiting, and alerts every member when something looks wrong, with a button to act.
2. **Acts for you from X.** "@bot pay Valley Flour's $40 invoice through Karuna" makes Grok Bot
   propose the payment. Karuna decides; a member approves anything over its limits.

Grok Bot is its own Karuna agent at **Level 0**: payments only to saved payees, anything over its
limits waits for a member, and the wallet and every key stay in Karuna. It can't approve, vote,
freeze or unfreeze. It finds things and proposes; members decide. That is the lesson of May 2026,
when a social command on X moved tokens out of Grok's own wallet through a bot that trusted it:
with Karuna, a post can only ever become a proposal.

## How it's wired

| Piece | Where |
|---|---|
| Grok Bot's address | `https://<tunnel>/grok/mcp`: Karuna's MCP connector with its own sign-in (issuer `/grok`), so the connection shows as Grok Bot |
| Sign-in | OAuth with a code a member approves (Agents → New agent → **Grok Bot**); the Bot's own app link is accepted as the redirect, with PKCE |
| Its tools | `pay`, `buy_data`, `web_search`, `web_fetch`, `balance`, `check_request`, the team's connectors, plus **`read_inbox`** and **`report_message`** (its Karuna inbox, where pre-flight's Drills arrive like real mail), **`arc_activity`** and **`alert_team`** |
| `arc_activity` | Facts only, the same anyone could read on the explorer, with arcscan links. Never a decision's reason, and nothing about Auto-Shield's tests or the trap keys |
| `alert_team` | Shows on every member's screen and in the island, labelled as the agent's words, with a button to Approvals, Votes, or the freeze (the member confirms). 6 an hour |
| A routine without sign-in | Karuna also reads the token from `Authorization: ApiKey …`, a bare `Authorization` value, or `X-Karuna-Token` |
| Disconnect | Agents → New agent → Grok Bot → Disconnect: its calls stop at once |

Code: `gatekeeper/src/chat.ts` (address, sign-in, tools), `gatekeeper/src/gatekeeper.ts`
(`arcActivity`, `teamAlert`), `web/src/App.tsx` (`GrokSetup`, alert buttons). Tests:
`gatekeeper/test/chat.test.ts` → "Grok Bot".

## What you need

- **Grok Bot**: an X subscription that includes it (X Premium or higher). Grok Bot has **no
  developer API key**; you use the app.
- **Karuna running** with a public address: `cloudflared tunnel --url http://127.0.0.1:8792`, and
  `KARUNA_CHAT_URL` in `.env` set to the tunnel's address.
- No xAI API key. (`XAI_API_KEY` is only for `agents/examples/grok-agent.ts`, a different thing:
  Grok the model running a Karuna agent.)

## Setup

1. Start Karuna and the tunnel; set `KARUNA_CHAT_URL` and restart Karuna if the tunnel address changed.
2. Console → **Agents → New agent → Grok Bot**. Copy the address (ends in `/grok/mcp`).
3. In Grok Bot, add it as a custom MCP server (or tell your Bot: "add this custom MCP server: …").
   Grok Bot opens Karuna's sign-in page, which shows a code.
4. In the Grok Bot tab, check the code and **Approve**. Your team votes it in (the normal wait).
   Grok Bot's sign-in finishes on its own once the vote passes.
5. Copy the routine from the tab into a new Grok Bot routine (every 5 minutes).
6. In Grok Bot, turn off its own payment wallets for this work, so money only moves through Karuna.

## See it work

- **Watching:** ask Grok Bot "run the Karuna check now". It calls `arc_activity` and summarizes.
  The Grok Bot tab shows "Watching · last check …".
- **Held payment:** have an agent ask for a payment over its level (or "@bot pay Grain Feed $3
  through Karuna"). The routine reports it with its view of the payee.
- **Alert:** a wallet transfer that matches no payment freezes every agent (the watchdog). The
  routine sees "MATCHES NO PAYMENT KARUNA MADE" with the arcscan link and calls `alert_team`; every
  member sees "Grok Bot: …" with **Freeze all agents** (already frozen here) or **Votes**.
- **Proof:** every call is in Activity, signed, as Grok Bot's agent, and anchored on Dharma.
