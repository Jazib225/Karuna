// Start the relay.
//   RELAY_PORT (8790, 127.0.0.1)          consoles connect here (WebSocket /ws)
//   RELAY_WEBHOOK_PORT (8791)             QuickNode delivers here — expose ONLY this port publicly
//   QUICKNODE_SECURITY_TOKEN              the Stream's security token (HMAC key)
import { config as loadEnv } from "dotenv";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type PublicClient } from "viem";
import { arcTestnet } from "viem/chains";
import { Relay, consoleServer, scrub, webhookServer } from "./relay.ts";
import { RecordBook } from "./records.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env"), quiet: true });

const port = Number(process.env.RELAY_PORT ?? 8790);
const webhookPort = Number(process.env.RELAY_WEBHOOK_PORT ?? 8791);
const webhookHost = process.env.RELAY_WEBHOOK_HOST ?? "127.0.0.1"; // a tunnel connects locally
const gatekeeper = `http://127.0.0.1:${process.env.KARUNA_CONSOLE_PORT ?? 8788}`;
const dataDir = resolve(process.env.KARUNA_DATA_DIR ?? resolve(here, "../../gatekeeper/data"));
const consoleToken = () => {
  try {
    return readFileSync(resolve(dataDir, "console.token"), "utf8").trim();
  } catch {
    return "";
  }
};

// The org's Dharma address comes from its Gatekeeper (or KARUNA_DHARMA_ADDRESS). Until it's
// known the relay forwards nothing — the Stream sees every Dharma on Arc, not just ours.
let dharma: string | null = process.env.KARUNA_DHARMA_ADDRESS?.toLowerCase() ?? null;
let wallet: string | null = process.env.KARUNA_WALLET_ADDRESS?.toLowerCase() ?? null;
let deployTx: string | null = null;
async function refreshDharma() {
  try {
    const r = await fetch(`${gatekeeper}/api/state`, { headers: { "x-karuna-console-token": consoleToken() } });
    if (!r.ok) return;
    const org = ((await r.json()) as { org?: { wallet?: { address?: string } | null; dharma?: { address?: string; txRef?: string } | null } }).org;
    if (!process.env.KARUNA_DHARMA_ADDRESS) dharma = org?.dharma?.address?.toLowerCase() ?? null;
    if (!process.env.KARUNA_WALLET_ADDRESS) wallet = org?.wallet?.address?.toLowerCase() ?? null;
    deployTx = org?.dharma?.txRef ?? null;
  } catch {
    /* gatekeeper not up yet */
  }
}
await refreshDharma();
setInterval(refreshDharma, 10_000);

// The fallback reads logs. QuickNode's free plan caps eth_getLogs at a 5-block range, so log
// queries go to Arc's public RPC unless ARC_LOGS_RPC_URL says otherwise.
const client = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_LOGS_RPC_URL || undefined, { retryCount: 4, retryDelay: 500 }) }) as PublicClient;
const post = (path: string, body: unknown) =>
  fetch(`${gatekeeper}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-karuna-console-token": consoleToken() },
    body: JSON.stringify(body),
  });
const records = new RecordBook(resolve(here, "../.records.json"));
const relay = new Relay({
  securityToken: process.env.QUICKNODE_SECURITY_TOKEN || undefined,
  client,
  dharma: () => dharma,
  wallet: () => wallet,
  records,
  notifyTransfers: async (transfers) => {
    for (const t of transfers) await post("/watchdog/transfer", t);
  },
  notifyRecords: async (recs, source) => {
    await post("/records", { records: recs, source });
  },
  notifyGatekeeper: async (events) => {
    await fetch(`${gatekeeper}/api/chain-event`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-karuna-console-token": consoleToken() },
      body: JSON.stringify({ count: events.length, events: events.map((e) => e.event) }),
    });
  },
});
relay.start();

// Agents' records: every Dharma event since the contract was deployed. The backfilled QuickNode
// Stream delivers them; this catch-up covers anything it sent while the relay was down.
let caughtUpFor: string | null = null;
async function catchUp() {
  if (!dharma || caughtUpFor === dharma) return;
  records.useDharma(dharma);
  let from: bigint | null = records.lastBlock() !== null ? BigInt(records.lastBlock()! + 1) : null;
  if (from === null && deployTx && /^0x[0-9a-f]{64}$/i.test(deployTx)) {
    from = (await client.getTransactionReceipt({ hash: deployTx as `0x${string}` })).blockNumber;
  }
  if (from === null) return;
  caughtUpFor = dharma;
  const n = await relay.backfill(from);
  console.log(`relay · records       ${records.size} events (${n} caught up from block ${from}), source: ${records.source()}`);
  relay.recordsChanged(0);
}
const tryCatchUp = () => void catchUp().catch((e) => {
  caughtUpFor = null;
  console.error("relay · catch-up:", scrub(e));
});
tryCatchUp();
setInterval(tryCatchUp, 15_000);
setInterval(() => relay.recordsChanged(0), 5 * 60_000); // keep the Gatekeeper's copy fresh after restarts

consoleServer(relay).listen(port, "127.0.0.1", () => console.log(`relay · consoles      ws://127.0.0.1:${port}/ws`));
webhookServer(relay).listen(webhookPort, webhookHost, () =>
  console.log(`relay · QuickNode     POST http://${webhookHost}:${webhookPort}/quicknode/webhook ${process.env.QUICKNODE_SECURITY_TOKEN ? "(signature check on)" : "(NOT CONFIGURED: set QUICKNODE_SECURITY_TOKEN)"}`),
);
console.log(`relay · Dharma        ${dharma ?? "unknown yet (finish setup in the console)"} · fallback: direct Arc RPC when QuickNode is quiet`);
console.log(`relay · watchdog      ${wallet ?? "wallet unknown yet"} · USDC leaving it must match a Karuna payment`);
