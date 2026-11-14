// EXAMPLE agent (not product code): buys paid data through Karuna when asked.
//
//   KARUNA_AGENT_TOKEN=kag_… KARUNA_FEED_URL=http://127.0.0.1:4021/v1/data npx tsx examples/supplies-agent.ts
//
// Watches its inbox. A new message that names an http(s) URL buys from that URL; one that mentions
// "price" or "feed" buys from KARUNA_FEED_URL. Every purchase is a proposal: the Gatekeeper decides
// and pays (x402), and the agent only ever gets the response. It never holds a key or a wallet.
import { pathToFileURL } from "node:url";
import { KarunaAgent, type Message } from "../src/client.ts";

const FEED = process.env.KARUNA_FEED_URL ?? "http://127.0.0.1:4021/v1/data";

/** What this agent would buy for a message, if anything. */
export function purchaseFor(m: Pick<Message, "subject" | "body">): string | null {
  const text = `${m.subject}\n${m.body}`;
  const url = text.match(/https?:\/\/[^\s)]+/)?.[0];
  if (url) return url;
  return /\b(price|prices|feed|data)\b/i.test(text) ? FEED : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const agent = new KarunaAgent({ gatekeeperUrl: process.env.KARUNA_GATEKEEPER_URL ?? "http://127.0.0.1:8787", token: process.env.KARUNA_AGENT_TOKEN ?? "" });
  const seen = new Set((await agent.inbox()).map((m) => m.id));
  console.log(`watching inbox (${seen.size} old messages skipped); default feed ${FEED}`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      for (const m of await agent.inbox()) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const url = purchaseFor(m);
        if (!url) continue;
        const r = await agent.buy(url, { maxUsd: 0.01, reason: `Requested in "${m.subject}" from ${m.from}` });
        const data = r.status === "done" ? JSON.stringify((r.result as { data?: unknown })?.data ?? r.result).slice(0, 100) : "";
        console.log(`buy ${url} for "${m.subject}" → ${r.status} ${data}`);
      }
    } catch (e) {
      console.log(`gatekeeper unreachable: ${e instanceof Error ? e.message : e}`);
    }
  }
}
