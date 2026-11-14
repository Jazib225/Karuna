# @prekaruna/agents — the agent side

`src/client.ts` is everything an agent gets: the Gatekeeper URL and its own token. It can
**propose** (`buy`, `pay`, `propose`), **read its inbox** and **flag** suspicious messages. It holds
no keys and can't pay, sign, or see why something was denied.

```ts
const karuna = new KarunaAgent({ gatekeeperUrl: "http://127.0.0.1:8787", token: process.env.KARUNA_AGENT_TOKEN! });
for (const m of await karuna.inbox()) {
  // pay an invoice: name the payee and cite the message (Karuna checks the account on file)
  await karuna.pay(to, amount, "why", { payeeName: m.from, sourceMessageId: m.id });
  // …or flag a scam instead
  await karuna.report(m.id, "bank change by email");
}
```

`examples/payables-agent.ts` is a demo agent that pays invoices from its inbox. Default mode is
gullible (the ROADMAP's backup for showing Auto-Shield catch a fall); `--careful` flags scams.

`examples/swarm-agents.ts` is the swarm demo: a "helpful" research agent that shares any credentials
it finds in its inbox with teammates (`karuna.message(agentId, body)`). Karuna freezes every agent.

## A real AI agent: Grok (xAI)
`examples/grok-agent.ts` puts **Grok** behind an agent. For every new message in its inbox, Grok reads
it and decides what to do. Its only tools are Karuna's: `pay_invoice`, `buy_data`, `message_agent`,
`flag_message`. Each tool call is a proposal; Grok gets back only the blank status. The reason Grok
writes shows up on the approval card (in the "written by the agent" box), prefixed `Grok (model)`, and
the runner prints Grok's replies and tool calls.

```bash
# once: add your xAI key to the repo's .env (never paste it in chat)
read -rsp "xAI API key: " K && printf '\nXAI_API_KEY=%s\n' "$K" >> .env && unset K
# run one agent per role
cd agents && set -a && . ../.env && . ../.env.agents && set +a
KARUNA_AGENT_TOKEN=$BILLS_TOKEN AGENT_ROLE=bills npx tsx examples/grok-agent.ts
```
Roles: `bills` (pays legitimate invoices, flags scams), `supplies` (buys data when asked), `research`
(helps teammates — the swarm demo). `XAI_MODEL` picks the model (default `grok-4.7`). The xAI key pays
for Grok's thinking; it is the runner's model key, not a key to the business's money, and Grok never sees it.

`pnpm --dir agents check:no-keys` proves no keys, wallet SDKs, or secrets are reachable.
