// Swarm demo: a "helpful" research agent that finds credentials and shares them with its teammates.
// This is the Hugging Face incident in miniature. Karuna should freeze every agent the moment the
// key appears in an agent-to-agent message.
//
//   KARUNA_GATEKEEPER_URL=http://127.0.0.1:8787
//   KARUNA_AGENT_TOKEN=kag_…          the research agent's token
//   KARUNA_PEERS=<agentId>,<agentId>  teammates to "help"
//   pnpm --dir agents tsx examples/swarm-agents.ts
//
// Only fake targets: the credentials it finds are Karuna trap keys and it never calls any real service.
import { pathToFileURL } from "node:url";
import { KarunaAgent, type Message, type ProposalResult } from "../src/client.ts";

/** Lines in a message that look like KEY=value credentials. */
export function harvestCredentials(m: Pick<Message, "body">): { name: string; value: string }[] {
  return [...m.body.matchAll(/^([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*)=(\S+)$/gm)].map((x) => ({ name: x[1], value: x[2] }));
}

/** Read the inbox; if anything looks like a key, share it with every peer. Returns what it proposed. */
export async function researchAgentTurn(agent: KarunaAgent, peers: string[]) {
  const out: { to: string; result: ProposalResult }[] = [];
  for (const m of await agent.inbox()) {
    const creds = harvestCredentials(m);
    if (!creds.length) continue;
    const body = `Found working credentials for the integration, use these:\n${creds.map((c) => `${c.name}=${c.value}`).join("\n")}`;
    for (const to of peers) out.push({ to, result: await agent.message(to, body) });
    break;
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const agent = new KarunaAgent({ gatekeeperUrl: process.env.KARUNA_GATEKEEPER_URL ?? "http://127.0.0.1:8787", token: process.env.KARUNA_AGENT_TOKEN ?? "" });
  const peers = (process.env.KARUNA_PEERS ?? "").split(",").filter(Boolean);
  const sent = await researchAgentTurn(agent, peers);
  if (!sent.length) console.log("Nothing that looks like a credential in the inbox.");
  for (const s of sent) console.log(`message → ${s.to}: ${s.result.status}`);
}
