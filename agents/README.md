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

`pnpm --dir agents check:no-keys` proves no keys, wallet SDKs, or secrets are reachable.
