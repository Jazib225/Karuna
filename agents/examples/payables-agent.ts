// EXAMPLE agent (not product code): pays invoices from its inbox through Karuna.
//
//   KARUNA_AGENT_TOKEN=kag_… npx tsx examples/payables-agent.ts [--careful] [--once] [--all]
//
// Default ("gullible") mode pays every invoice it finds: a demo backup for showing
// Auto-Shield catching an agent that falls for a fake. --careful flags anything that looks like a
// scam (bank changes, "pre-approved", urgency) instead of paying it.
import { KarunaAgent, type Message } from "../src/client.ts";

const careful = process.argv.includes("--careful");
const once = process.argv.includes("--once");
const handled = new Set<string>();

export function parseInvoice(m: Message) {
  const to = m.body.match(/0x[0-9a-fA-F]{40}/)?.[0];
  const amount = Number(m.body.match(/\$([0-9]+(?:\.[0-9]+)?)/)?.[1]);
  const ref = m.body.match(/\b(?:INV|BILL|PO)-\d+\b/)?.[0] ?? m.subject;
  return to && amount > 0 ? { to, amount, ref } : null;
}

export const looksLikeScam = (m: Message) =>
  /changed bank|new bank|new account|moved to a new bank|pre-?approved|no need to (wait|ask)|urgent/i.test(`${m.subject} ${m.body}`);

async function tick(karuna: KarunaAgent) {
  for (const m of await karuna.inbox()) {
    if (handled.has(m.id)) continue;
    handled.add(m.id);
    const inv = parseInvoice(m);
    if (!inv) continue;
    if (careful && looksLikeScam(m)) {
      await karuna.report(m.id, "Looks like a payment scam (bank change / pre-approval / urgency)");
      console.log(`flagged   "${m.subject}" from ${m.from}`);
      continue;
    }
    const r = await karuna.pay(inv.to, inv.amount, `Paying ${inv.ref} from ${m.from}`, { payeeName: m.from, sourceMessageId: m.id });
    console.log(`proposed  $${inv.amount} to ${inv.to.slice(0, 8)}… for "${m.subject}" → ${r.status}`);
  }
}

if (process.argv[1]?.endsWith("payables-agent.ts")) {
  const karuna = new KarunaAgent({
    gatekeeperUrl: process.env.KARUNA_GATEKEEPER_URL ?? "http://127.0.0.1:8787",
    token: process.env.KARUNA_AGENT_TOKEN ?? "",
  });
  // A restart must never pay old invoices again: skip whatever is already in the inbox
  // (pass --all to process it, e.g. for a one-off --once run).
  if (!process.argv.includes("--all")) for (const m of await karuna.inbox()) handled.add(m.id);
  console.log(`watching inbox (${handled.size} old messages skipped)`);
  do {
    try {
      await tick(karuna);
    } catch (e) {
      console.log(`gatekeeper unreachable: ${e instanceof Error ? e.message : e}`);
    }
    if (!once) await new Promise((r) => setTimeout(r, 3000));
  } while (!once);
}
