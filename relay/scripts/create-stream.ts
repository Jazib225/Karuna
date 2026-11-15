// Create (or update) the QuickNode Stream that feeds the relay.
//
//   QUICKNODE_API_KEY=…        (in .env) QuickNode dashboard → API Keys, with Streams access
//   RELAY_PUBLIC_URL=https://… (in .env) public HTTPS URL that reaches the relay's webhook port
//   QUICKNODE_SECURITY_TOKEN   (in .env) HMAC key; generated and saved to .env if missing
//
//   pnpm --dir relay stream:create              test the filter, then create/update the Stream
//   pnpm --dir relay stream:create --test       only test the filter against real blocks
//   pnpm --dir relay stream:create --backfill   recreate the Stream from Dharma's deploy block
//
// One Stream (QuickNode's free plan allows one), `karuna-events`: arc-testnet · logs · starts at the
// org's Dharma deploy block (backfill), then follows the chain. Its filter keeps two things:
//   - Dharma's events: approvals, votes, freezes, and every agent's record for trust levels;
//   - USDC Transfer logs out of the org's wallet: the wallet watchdog.
// Delivered to the relay's webhook, signed with the security token.
import { config as loadEnv } from "dotenv";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";
import { DHARMA_TOPICS, TRANSFER_TOPIC, USDC_EMITTERS, quickNodeCombinedFilterSource } from "../src/events.ts";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "../../.env");
loadEnv({ path: envPath, quiet: true });
const API = "https://api.quicknode.com/streams/rest/v1";
const KEY = process.env.QUICKNODE_API_KEY;
const testOnly = process.argv.includes("--test");
const forceBackfill = process.argv.includes("--backfill");
if (!KEY) {
  console.error("Set QUICKNODE_API_KEY in .env (QuickNode dashboard → API Keys). It is a secret: don't paste it in chat.");
  process.exit(1);
}
const qn = async (path: string, init?: RequestInit) => {
  const r = await fetch(`${API}${path}`, { ...init, headers: { "x-api-key": KEY, "content-type": "application/json", accept: "application/json" } });
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain text */
  }
  if (!r.ok) throw Object.assign(new Error(`QuickNode ${r.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`), { status: r.status });
  return body as Record<string, any>;
};
const b64 = (s: string) => Buffer.from(s).toString("base64");

// ---- the org (from the Gatekeeper's data dir)
// Log queries use Arc's public RPC: QuickNode's free plan caps eth_getLogs at a 5-block range.
const client = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_LOGS_RPC_URL || undefined) });
const orgFile = resolve(process.env.KARUNA_DATA_DIR ?? resolve(here, "../../gatekeeper/data"), "org.json");
const org = existsSync(orgFile) ? (JSON.parse(readFileSync(orgFile, "utf8")) as { wallet?: { address?: string }; dharma?: { address?: string; txRef?: string } }) : {};
const dharma = (process.env.KARUNA_DHARMA_ADDRESS ?? org.dharma?.address)?.toLowerCase();
const wallet = (process.env.KARUNA_WALLET_ADDRESS ?? org.wallet?.address)?.toLowerCase();
if (!dharma || !wallet) {
  console.error("No organization yet: finish setup in the console first (the Streams need its Dharma and wallet addresses).");
  process.exit(1);
}
let deployBlock: bigint | null = null;
if (org.dharma?.txRef && /^0x[0-9a-f]{64}$/i.test(org.dharma.txRef)) {
  deployBlock = (await client.getTransactionReceipt({ hash: org.dharma.txRef as `0x${string}` })).blockNumber;
}
const latest = await client.getBlockNumber();

// ---- 1. test both filters on QuickNode against real blocks
async function testFilter(label: string, source: string, block: bigint, expectKey: string) {
  const t = await qn("/streams/test_filter", {
    method: "POST",
    body: JSON.stringify({ network: "arc-testnet", dataset: "logs", filter_function: b64(source), filter_language: "javascript", block: String(block) }),
  });
  const out = JSON.stringify(t);
  console.log(`  ${label} filter on block ${block}: ${out.length > 400 ? `${out.slice(0, 400)}…` : out}`);
  if (!out.includes(expectKey)) console.log(`  ⚠ the ${label} filter returned nothing for that block: check the output shape above.`);
}
const dharmaLogs = await client.getLogs({ address: dharma as `0x${string}`, fromBlock: latest > 9000n ? latest - 9000n : 0n, toBlock: latest });
const sample = dharmaLogs.find((l) => DHARMA_TOPICS[String(l.topics[0]).toLowerCase()]);
if (sample?.blockNumber) await testFilter("Dharma", quickNodeCombinedFilterSource(wallet), sample.blockNumber, "dharmaLogs");
else console.log(`No Dharma events in the last 9,000 blocks of ${dharma}; skipping the Dharma filter test.`);
const pad = `0x${"0".repeat(24)}${wallet.slice(2)}` as `0x${string}`;
const outgoing = (await client.request({
  method: "eth_getLogs",
  params: [{ address: Object.keys(USDC_EMITTERS) as `0x${string}`[], topics: [TRANSFER_TOPIC as `0x${string}`, pad], fromBlock: `0x${(latest > 9000n ? latest - 9000n : 0n).toString(16)}`, toBlock: `0x${latest.toString(16)}` }],
} as never)) as { blockNumber: string }[];
if (outgoing.length) await testFilter("watchdog", quickNodeCombinedFilterSource(wallet), BigInt(outgoing.at(-1)!.blockNumber), "walletTransfers");
else console.log(`No USDC left ${wallet} in the last 9,000 blocks; skipping the watchdog filter test (it's unit-tested).`);
if (testOnly) process.exit(0);

// ---- 2. create or update both Streams
const publicUrl = (process.env.RELAY_PUBLIC_URL ?? "").replace(/\/+$/, "");
if (!/^https:\/\//.test(publicUrl)) {
  console.error("Set RELAY_PUBLIC_URL in .env to the public HTTPS URL that reaches the relay's webhook port (8791).");
  process.exit(1);
}
let token = process.env.QUICKNODE_SECURITY_TOKEN;
if (!token) {
  token = randomBytes(32).toString("hex");
  appendFileSync(envPath, `\n# QuickNode Stream security token (HMAC key the relay verifies deliveries with)\nQUICKNODE_SECURITY_TOKEN=${token}\n`);
  console.log("Generated QUICKNODE_SECURITY_TOKEN and saved it to .env (restart the relay to load it).");
}
const destination_attributes = {
  url: `${publicUrl}/quicknode/webhook`, security_token: token, compression: "none", headers: {},
  max_retry: 3, retry_interval_sec: 1, post_timeout_sec: 10,
};

interface StreamState { id: string; dharma?: string; wallet?: string; startBlock?: string | null; url: string; updatedAt: string }
const stateFile = resolve(here, "../.streams.json");
const legacyFile = resolve(here, "../.stream.json"); // before trust levels: no backfill, Dharma events only
const saved: { stream?: StreamState; dharma?: StreamState } = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const old: StreamState | undefined = saved.stream ?? saved.dharma ?? (existsSync(legacyFile) ? (JSON.parse(readFileSync(legacyFile, "utf8")) as StreamState) : undefined);
const filter = b64(quickNodeCombinedFilterSource(wallet));
const save = (st: StreamState) => writeFileSync(stateFile, JSON.stringify({ stream: st }, null, 2));

async function create(startBlock: bigint | null) {
  const body = {
    name: "karuna-events", network: "arc-testnet", dataset: "logs", region: "usa_east",
    dataset_batch_size: 1, elastic_batch_enabled: true, filter_function: filter, filter_language: "javascript",
    destination: "webhook", destination_attributes, status: "active",
    ...(startBlock !== null ? { start_range: Number(startBlock) } : {}),
  };
  return qn("/streams", { method: "POST", body: JSON.stringify(body) });
}

if (old && old.dharma === dharma && !forceBackfill) {
  // Same org: keep the Stream (and its backfill), update the filter and the destination.
  // QuickNode only edits a paused Stream: pause, update, resume (it picks up where it left off).
  await qn(`/streams/${old.id}`, { method: "PATCH", body: JSON.stringify({ status: "paused" }) }).catch(() => undefined);
  await qn(`/streams/${old.id}`, { method: "PATCH", body: JSON.stringify({ filter_function: filter, destination_attributes }) });
  await qn(`/streams/${old.id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) });
  save({ ...old, wallet, url: destination_attributes.url, updatedAt: new Date().toISOString() });
  console.log(`Updated stream ${old.id}: Dharma events + USDC leaving ${wallet} → ${destination_attributes.url}`);
} else {
  // A new org, or --backfill. The free plan allows one Stream, so the old one goes first.
  if (old?.id) {
    try {
      await qn(`/streams/${old.id}`, { method: "DELETE" });
      console.log(`Deleted the old stream ${old.id}.`);
    } catch (e) {
      console.log(`Couldn't delete the old stream ${old.id} (${(e as Error).message}); delete it in the QuickNode dashboard, then run this again.`);
      process.exit(1);
    }
  }
  const res = await create(deployBlock);
  save({ id: String(res.id), dharma, wallet, startBlock: deployBlock?.toString() ?? null, url: destination_attributes.url, updatedAt: new Date().toISOString() });
  console.log(`Created stream ${res.id}: ${deployBlock !== null ? `backfilling from block ${deployBlock} (Dharma's deploy), then live` : "live from the chain tip (deploy block unknown)"}; Dharma events + USDC leaving ${wallet}`);
}
console.log("Saved relay/.streams.json. Restart the relay; the console badge shows QuickNode once deliveries arrive.");
