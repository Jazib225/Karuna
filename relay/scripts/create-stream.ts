// Create (or update) the QuickNode Stream that feeds the relay.
//
//   QUICKNODE_API_KEY=…        (in .env) QuickNode dashboard → API Keys, with Streams access
//   RELAY_PUBLIC_URL=https://… (in .env) public HTTPS URL that reaches the relay's webhook port
//   QUICKNODE_SECURITY_TOKEN   (in .env) HMAC key; generated and saved to .env if missing
//
//   pnpm --dir relay stream:create            test the filter, then create/update the stream
//   pnpm --dir relay stream:create --test     only test the filter against a real Dharma block
//
// Network: arc-testnet · dataset: logs · filter: only Dharma events (any Dharma contract; the
// relay keeps just this org's) · destination: the relay's webhook, signed with the token.
import { config as loadEnv } from "dotenv";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";
import { DHARMA_TOPICS, quickNodeFilterSource } from "../src/events.ts";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "../../.env");
loadEnv({ path: envPath, quiet: true });
const API = "https://api.quicknode.com/streams/rest/v1";
const KEY = process.env.QUICKNODE_API_KEY;
const testOnly = process.argv.includes("--test");
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
  if (!r.ok) throw new Error(`QuickNode ${r.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body as Record<string, any>;
};
const filterB64 = Buffer.from(quickNodeFilterSource()).toString("base64");

// ---- 1. test the filter against a real block that contains a Dharma event
// Log queries use Arc's public RPC: QuickNode's free plan caps eth_getLogs at a 5-block range.
const client = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_LOGS_RPC_URL || undefined) });
const orgFile = resolve(process.env.KARUNA_DATA_DIR ?? resolve(here, "../../gatekeeper/data"), "org.json");
const orgDharma = existsSync(orgFile) ? JSON.parse(readFileSync(orgFile, "utf8")).dharma?.address : undefined;
const probe = process.env.KARUNA_DHARMA_ADDRESS ?? orgDharma ?? "0xb7cfead9d160229f66f9532f1091a332e23b3bc0"; // a verified test Dharma
const latest = await client.getBlockNumber();
const logs = await client.getLogs({ address: probe as `0x${string}`, fromBlock: latest - 9000n, toBlock: latest });
const sample = logs.find((l) => DHARMA_TOPICS[String(l.topics[0]).toLowerCase()]);
if (sample) {
  console.log(`Testing the filter on QuickNode against block ${sample.blockNumber} (${DHARMA_TOPICS[String(sample.topics[0]).toLowerCase()]} on ${probe})…`);
  const t = await qn("/streams/test_filter", {
    method: "POST",
    body: JSON.stringify({ network: "arc-testnet", dataset: "logs", filter_function: filterB64, filter_language: "javascript", block: String(sample.blockNumber) }),
  });
  const out = JSON.stringify(t);
  console.log(`  filter output: ${out.length > 600 ? `${out.slice(0, 600)}…` : out}`);
  if (!out.includes("dharmaLogs")) console.log("  ⚠ the filter returned no Dharma logs for that block — check the output shape above.");
} else {
  console.log(`No Dharma events in the last 9,000 blocks of ${probe}; skipping the filter test.`);
}
if (testOnly) process.exit(0);

// ---- 2. create or update the stream
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
const stateFile = resolve(here, "../.stream.json");
const existing = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")) as { id: string }) : null;
const destination_attributes = {
  url: `${publicUrl}/quicknode/webhook`, security_token: token, compression: "none", headers: {},
  max_retry: 3, retry_interval_sec: 1, post_timeout_sec: 10,
};
const body = {
  name: "karuna-dharma-events", network: "arc-testnet", dataset: "logs", region: "usa_east",
  dataset_batch_size: 1, elastic_batch_enabled: true, filter_function: filterB64, filter_language: "javascript",
  destination: "webhook", destination_attributes, status: "active",
};
const res = existing
  ? await qn(`/streams/${existing.id}`, { method: "PATCH", body: JSON.stringify({ filter_function: filterB64, destination_attributes, status: "active" }) })
  : await qn("/streams", { method: "POST", body: JSON.stringify(body) });
const id = String(res.id ?? existing?.id);
writeFileSync(stateFile, JSON.stringify({ id, network: "arc-testnet", dataset: "logs", url: destination_attributes.url, createdAt: new Date().toISOString() }, null, 2));
console.log(`${existing ? "Updated" : "Created"} stream ${id} → ${destination_attributes.url} (status ${res.status ?? "active"})`);
