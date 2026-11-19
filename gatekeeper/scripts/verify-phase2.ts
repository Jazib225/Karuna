// Live Phase 2 verification on Arc testnet, on top of Dharma.
//
//   VERIFY_WALLET=0x...                    the org's Circle agent wallet (Gateway balance > 0)
//   VERIFY_SELLER=http://127.0.0.1:4021    the running test seller (services/test-seller)
//
// Isolated Gatekeeper (throwaway data dir, ports 18787/18788), a fresh Dharma, one generated
// member key. Payees and allowances come from Dharma (one 60s timelock to bootstrap), payment
// approvals are signed by the member's key. Moves tiny amounts of testnet USDC.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import { config as loadEnv } from "dotenv";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ARC_TESTNET_CHAIN_ID, Kind, actionTypedData, encodeChange, paymentDecisionTypedData, type Change } from "@prekaruna/dharma";
import { Store } from "../src/store.ts";
import { CircleCliWallet } from "../src/wallet.ts";
import { Gatekeeper } from "../src/gatekeeper.ts";
import { agentApi, consoleApi } from "../src/server.ts";
import { CircleChainWriter, publicClient } from "../src/chain.ts";
import { KarunaAgent } from "../../agents/src/client.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env"), quiet: true });

const WALLET = (process.env.VERIFY_WALLET ?? "").toLowerCase() as Address;
const SELLER = process.env.VERIFY_SELLER ?? "http://127.0.0.1:4021";
if (!/^0x[0-9a-f]{40}$/.test(WALLET)) throw new Error("Set VERIFY_WALLET to your Circle agent wallet address");

const results: { check: string; pass: boolean; detail: string }[] = [];
const record = (check: string, pass: boolean, detail: string) => {
  results.push({ check, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${check}\n      ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listen = (s: Server, port: number) => new Promise<void>((ok) => s.listen(port, "127.0.0.1", ok));
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const setPrice = (usd: string) => fetch(`${SELLER}/__test/price`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ usd }) });

const health = await fetch(`${SELLER}/health`).then(json).catch(() => null);
if (!health) throw new Error(`Test seller not reachable at ${SELLER}. Start it: TEST_SELLER_ADDRESS=0x… pnpm --dir services/test-seller start`);
const sellerAddress = String(health.sellerAddress).toLowerCase() as Address;
await setPrice("0.001");

const dir = mkdtempSync(join(tmpdir(), "karuna-verify2-"));
const store = new Store(dir);
const wallet = new CircleCliWallet();
const client = publicClient(process.env.ARC_RPC_URL);
const gk = new Gatekeeper({ store, wallet, client, writerFor: (a: Address) => new CircleChainWriter(a, client), timelockSeconds: 60, anchorEvery: 1000 });
const token = store.loadOrCreateConsoleToken();
const aSrv = agentApi(gk);
const cSrv = consoleApi(gk, wallet, token);
await listen(aSrv, 18787);
await listen(cSrv, 18788);
const api = async (path: string, body?: unknown, raw = false) => {
  const r = await fetch(`http://127.0.0.1:18788/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-karuna-console-token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return r as unknown as Record<string, any>;
  const j = await json(r);
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
};
const member = privateKeyToAccount(generatePrivateKey());
let dharma: Address;
async function act(who: PrivateKeyAccount, kind: number, change: Change, label?: string) {
  const { op, data } = encodeChange(change);
  const nonce = BigInt((await api(`/dharma/nonce/${who.address}`)).nonce);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const signature = await who.signTypedData(actionTypedData(dharma, ARC_TESTNET_CHAIN_ID, { kind, op, data, proposalId: 0n, support: false, nonce, deadline }));
  return api("/dharma/action", { kind, op, data, signer: who.address, deadline: deadline.toString(), signature, label });
}
async function decide(proposalId: string, payloadHash: string, approve: boolean, raw = false) {
  const h = (payloadHash.startsWith("0x") ? payloadHash : `0x${payloadHash}`) as Hex;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const signature = await member.signTypedData(paymentDecisionTypedData(dharma, ARC_TESTNET_CHAIN_ID, { proposalId, payloadHash: h, approve, deadline }));
  return api(`/proposals/${proposalId}/decide`, { approve, payloadHash: h, signer: member.address, deadline: deadline.toString(), signature }, raw);
}

try {
  console.log("· setup: deploying a fresh Dharma, then proposing the seller as payee and an agent with a $0.05 allowance…");
  dharma = (await api("/setup", { orgName: "Phase 2 verification", memberName: "Reviewer", memberAddress: member.address, walletAddress: WALLET })).dharma.address;
  await gk.start(3000);
  const prep = await api("/agents/prepare", { name: "Verifier agent" });
  const agent = new KarunaAgent({ gatekeeperUrl: "http://127.0.0.1:18787", token: prep.token });
  await act(member, Kind.Propose, { op: "SetPayee", account: sellerAddress, category: "data" }, "Test seller");
  await act(member, Kind.Propose, { op: "SetAgent", id: prep.id, capUsd: 0.05 });
  console.log("· waiting out the 60s Dharma timelock…");
  for (let i = 0; i < 60; i++) {
    const s = await api("/state");
    if (s.policy.payees.length && s.policy.agents.some((a: { active: boolean }) => a.active)) break;
    await sleep(3000);
  }

  // 1. allowed request pays real testnet USDC and the agent gets the data
  const before = await wallet.balances(WALLET);
  const bought = await agent.buy(`${SELLER}/v1/data`, { reason: "verification purchase" });
  const after = await wallet.balances(WALLET);
  const paid = (bought.result as { paid?: { transaction?: string; verified?: boolean } } | undefined)?.paid;
  record(
    "Agent asks for paid data → USDC moves → agent gets the data",
    bought.status === "done" && !!(bought.result as { data?: unknown })?.data && paid?.verified === true,
    `status=${bought.status}, Circle payment ${paid?.transaction}, Gateway ${before.gateway} → ${after.gateway} USDC`,
  );

  // 1b. direct transfer to a Dharma payee
  const sent = await agent.pay(sellerAddress, 0.01, "verification transfer");
  record("Agent asks to send USDC → Gatekeeper transfers on Arc", sent.status === "done", `status=${sent.status}, tx ${(sent.result as { txRef?: string } | undefined)?.txRef}`);

  // 2. no keys in agent code or environment
  let scan = "";
  let scanOk = false;
  try {
    scan = execFileSync("npx", ["tsx", resolve(here, "../../agents/scripts/check-no-keys.ts")], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: "utf8" });
    scanOk = true;
  } catch (e) {
    scan = String((e as { stdout?: string }).stdout ?? e);
  }
  record("Searching the agent's code and environment finds no keys", scanOk, scan.trim().split("\n").pop() ?? "");

  // 3. changed amount after approval → refused (allowance lowered to 0: a tightening, instant)
  await act(member, Kind.Tighten, { op: "SetAgent", id: prep.id, capUsd: 0 });
  const asked = await agent.buy(`${SELLER}/v1/data`, { reason: "needs approval" });
  const card = (await api("/state")).proposals.find((p: { id: string }) => p.id === asked.id);
  await setPrice("0.002");
  const approved = await decide(asked.id, card.payloadHash, true);
  const agentSees = await agent.status(asked.id);
  record(
    "Changed amount after approval → payment refused",
    asked.status === "pending" && approved.status === "failed" && /Exact Match failed/.test(approved.error ?? "") && agentSees.status === "failed",
    `member signed $0.001 (hash ${String(card.payloadHash).slice(0, 8)}…); seller then asked $0.002 → ${approved.error}`,
  );
  await setPrice("0.001");

  // 3b. a signature for a different payload hash → refused
  const asked2 = await agent.buy(`${SELLER}/v1/data`);
  const wrong = (await decide(asked2.id, "f".repeat(64), true, true)) as unknown as Response;
  record("Approval signed for a different payload → refused", wrong.status === 409, `HTTP ${wrong.status}: ${(await json(wrong)).error}`);

  // 4. agent cannot reach approvals
  const sneaky = await fetch(`http://127.0.0.1:18788/api/proposals/${asked2.id}/decide`, { method: "POST", headers: { authorization: `Bearer ${prep.token}` }, body: "{}" });
  const viaAgent = await fetch(`http://127.0.0.1:18787/api/proposals/${asked2.id}/decide`, { method: "POST", headers: { authorization: `Bearer ${prep.token}` } });
  record("An agent cannot approve its own request", sneaky.status === 401 && viaAgent.status === 404, `console API with agent token → ${sneaky.status}; agent API has no approve route → ${viaAgent.status}`);

  // 5. panic
  await act(member, Kind.Tighten, { op: "Freeze" });
  const frozen = await agent.buy(`${SELLER}/v1/data`);
  record("Panic freezes every agent (one signature, on Dharma)", frozen.status === "denied", `while frozen the agent got "${frozen.status}"`);

  const st = await api("/state");
  record("Every decision and event is in the signed log", st.log.verified === true, `${st.log.length} entries, chain verified`);
} catch (e) {
  record("verification run", false, e instanceof Error ? e.message : String(e));
} finally {
  gk.stop();
  await gk.idle();
  aSrv.close();
  cSrv.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
