# Grok Bot as a governed agent

> **Status (Nov 19, 2026):** not started. Optional: targets the Grok Bot bounty. Split out of
> [`VOICE_PLAN.md`](VOICE_PLAN.md).

## The idea

Grok Bot can call remote MCP servers, and Karuna already serves one (`/mcp` on port 8792 through
the tunnel). Connecting Grok Bot there makes it one more Karuna agent: its own agent at Level 0,
payments only to saved payees, the team's connectors only through Karuna. The keys and the wallet
stay in Karuna. A Grok Bot routine can watch Arc for the org's activity and act through those
tools. Anything over its limits is held, and the island reads it aloud.

Karuna can't govern what Grok does on its own computer or on X (its browser, its posts); it
governs everything that needs your money or your keys.

## Check before building

Whether Grok Bot's MCP setup supports Karuna's connect flow (a member approves a code). If it
doesn't, add a token header option to the connector.

## What the bounty needs

- An export of the Grok Bot chat that shows it working through Karuna.
- A 3–4 sentence section in the README on how Grok Bot is governed.

## Already in the repo

`agents/examples/grok-agent.ts` drives Karuna's agent tools with Grok through the agent API (see
`agents/README.md`). That is a Karuna agent using Grok as its model, not Grok Bot connecting over
MCP, but it shows the same rules applying to Grok.
