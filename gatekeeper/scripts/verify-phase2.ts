// Live Phase 2 verification against Arc testnet (ROADMAP.md §Phase 2 "It works if").
//
//   VERIFY_WALLET=0x...       the org's Circle agent wallet (Gateway balance > 0)
//   VERIFY_SELLER=http://127.0.0.1:4021   the running test seller (services/test-seller)
//
// Runs an isolated Gatekeeper in a throwaway data dir on ports 18787/18788 and drives it over
// HTTP the same way a real agent and a real human would. Moves tiny amounts of testnet USDC.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import { config as loadEnv } from "dotenv";
import { Store } from "../src/store.ts";
import { CircleCliWallet } from "../src/wallet.ts";
import { Gatekeeper } from "../src/gatekeeper.ts";
import { agentApi, consoleApi } from "../src/server.ts";
import { KarunaAgent } from "../../agents/src/client.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env"), quiet: true });

const WALLET = (process.env.VERIFY_WALLET ?? "").toLowerCase();
const SELLER = process.env.VERIFY_SELLER ?? "http://127.0.0.1:4021";
if (!/^0x[0-9a-f]{40}$/.test(WALLET)) throw new Error("Set VERIFY_WALLET to your Circle agent wallet address");

const results: { check: string; pass: boolean; detail: string }[] = [];
const record = (check: string, pass: boolean, detail: string) => {
  results.push({ check, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${check}\n      ${detail}`);
};

const listen = (s: Server, port: number) => new Promise<void>((ok) => s.listen(port, "127.0.0.1", ok));
const json = async (r: Response) => (await r.json()) as Record<string, any>;

const health = await fetch(`${SELLER}/health`).then(json).catch(() => null);
if (!health) throw new Error(`Test seller not reachable at ${SELLER}. Start it: pnpm --dir services/test-seller start`);
const sellerAddress = String(health.sellerAddress).toLowerCase();
await fetch(`${SELLER}/__test/price`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"usd":"0.001"}' });

// ---- isolated gatekeeper
const dir = mkdtempSync(join(tmpdir(), "karuna-verify-"));
const store = new Store(dir);
const wallet = new CircleCliWallet();
const gk = new Gatekeeper(store, wallet);
const consoleToken = store.loadOrCreateConsoleToken();
const aSrv = agentApi(gk);
const cSrv = consoleApi(gk, wallet, consoleToken);
await listen(aSrv, 18787);
await listen(cSrv, 18788);
const api = (path: string, body?: unknown, method = body ? "POST" : "GET") =>
  fetch(`http://127.0.0.1:18788/api${path}`, {
    method, headers: { "content-type": "application/json", "x-karuna-console-token": consoleToken },
    body: body ? JSON.stringify(body) : undefined,
  });

try {
  // ---- a human sets up an org through the console API
  const owner = (await api("/setup", { orgName: "Verification Org", memberName: "Reviewer One", walletAddress: WALLET }).then(json)).member.id;
  const second = (await api("/members", { name: "Reviewer Two", memberId: owner }).then(json)).id;
  await api("/recipients", { address: sellerAddress, name: "Test seller", category: "data", memberId: owner });
  const created = await api("/agents", { name: "Verifier agent", dailyAllowanceUsd: 0.05, memberId: owner }).then(json);
  const agent = new KarunaAgent({ gatekeeperUrl: "http://127.0.0.1:18787", token: created.token });
  const agentId = created.agent.id;

  // ---- 1. allowed request pays real testnet USDC and the agent gets the data
  const before = await wallet.balances(WALLET);
  const bought = await agent.buy(`${SELLER}/v1/data`, { reason: "verification purchase" });
  const after = await wallet.balances(WALLET);
  const tx = (bought.result as { paid?: { transaction?: string; verified?: boolean } } | undefined)?.paid;
  record(
    "Agent asks for paid data → USDC moves → agent gets the data",
    bought.status === "done" && !!(bought.result as { data?: unknown })?.data && tx?.verified === true,
    `status=${bought.status}, data=${JSON.stringify((bought.result as { data?: unknown })?.data)}, Circle payment ${tx?.transaction}, ` +
      `Gateway balance ${before.gateway} → ${after.gateway} USDC`,
  );

  // ---- 1b. a direct USDC transfer to a known recipient (on-chain)
  const usdcBefore = before.usdc;
  const sent = await agent.pay(sellerAddress, 0.01, "verification transfer");
  const usdcAfter = (await wallet.balances(WALLET)).usdc;
  const txRef = (sent.result as { txRef?: string } | undefined)?.txRef;
  record(
    "Agent asks to send USDC → Gatekeeper transfers on Arc",
    sent.status === "done",
    `status=${sent.status}, Circle tx ${txRef}, wallet USDC ${usdcBefore} → ${usdcAfter} (includes gas)`,
  );

  // ---- 2. no keys in agent code or environment
  let scan = "";
  let scanOk = false;
  try {
    scan = execFileSync("npx", ["tsx", resolve(here, "../../agents/scripts/check-no-keys.ts")], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: "utf8",
    });
    scanOk = true;
  } catch (e) {
    scan = String((e as { stdout?: string }).stdout ?? e);
  }
  record("Searching the agent's code and environment finds no keys", scanOk, scan.trim().split("\n").pop() ?? "");

  // ---- 3. changed amount after approval → payment refused
  await api(`/agents/${agentId}`, { dailyAllowanceUsd: 0, memberId: owner }, "PATCH"); // force human approval
  const asked = await agent.buy(`${SELLER}/v1/data`, { reason: "needs approval" });
  const card = (await api("/state").then(json)).proposals.find((p: { id: string }) => p.id === asked.id);
  await fetch(`${SELLER}/__test/price`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"usd":"0.002"}' });
  const gwBefore = (await wallet.balances(WALLET)).gateway;
  const approved = await api(`/proposals/${asked.id}/approve`, { memberId: owner, payloadHash: card.payloadHash }).then(json);
  const gwAfter = (await wallet.balances(WALLET)).gateway;
  const agentSees = await agent.status(asked.id);
  record(
    "Changed amount after approval → payment refused",
    asked.status === "pending" && approved.status === "failed" && /Exact Match failed/.test(approved.error ?? "") && agentSees.status === "failed",
    `card showed $0.001 (hash ${String(card.payloadHash).slice(0, 8)}…), seller then asked $0.002 → ${approved.error} ` +
      `Gateway ${gwBefore} → ${gwAfter}; agent sees "${agentSees.status}" with no reason`,
  );
  await fetch(`${SELLER}/__test/price`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"usd":"0.001"}' });

  // ---- 3b. approving a hash that isn't the payload → refused
  const asked2 = await agent.buy(`${SELLER}/v1/data`);
  const wrong = await api(`/proposals/${asked2.id}/approve`, { memberId: owner, payloadHash: "f".repeat(64) });
  record("Approval for a different payload hash → refused", wrong.status === 409, `HTTP ${wrong.status}: ${(await json(wrong)).error}`);

  // ---- 4. agent cannot reach the console API
  const sneaky = await fetch(`http://127.0.0.1:18788/api/proposals/${asked2.id}/approve`, {
    method: "POST", headers: { authorization: `Bearer ${created.token}`, "content-type": "application/json" },
    body: JSON.stringify({ memberId: owner, payloadHash: "x" }),
  });
  const viaAgentPort = await fetch(`http://127.0.0.1:18787/api/proposals/${asked2.id}/approve`, {
    method: "POST", headers: { authorization: `Bearer ${created.token}` },
  });
  record("An agent cannot approve its own request", sneaky.status === 401 && viaAgentPort.status === 404, `console API with agent token → ${sneaky.status}; agent API has no approve route → ${viaAgentPort.status}`);

  // ---- 5. panic button
  await api("/freeze", { memberId: second });
  const frozen = await agent.buy(`${SELLER}/v1/data`);
  await api("/unfreeze-vote", { memberId: owner });
  const stillFrozen = (await api("/state").then(json)).frozen !== null;
  await api("/unfreeze-vote", { memberId: second });
  const thawed = (await api("/state").then(json)).frozen === null;
  record("Panic freezes every agent; unfreeze needs two votes", frozen.status === "denied" && stillFrozen && thawed, `while frozen agent got "${frozen.status}"; 1 vote → still frozen; 2 votes → unfrozen`);

  // ---- 6. everything is in the signed log
  const st = await api("/state").then(json);
  record("Every decision and event is in the signed log", st.log.verified === true, `${st.log.length} entries, chain verified, head ${String(st.log.head).slice(0, 8)}…`);
} finally {
  aSrv.close();
  cSrv.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Isolated data dir: ${dir}`);
process.exit(failed.length ? 1 : 0);
