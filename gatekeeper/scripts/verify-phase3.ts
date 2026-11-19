// Live Phase 3 verification on Arc testnet.
//
//   VERIFY_WALLET=0x...   the org's Circle agent wallet (pays gas, deploys Dharma)
//
// Spins up an isolated Gatekeeper (throwaway data dir, ports 19787/19788) with two generated
// member keys, deploys a fresh Dharma through the Circle CLI, and drives it over the console
// API exactly as two members' browsers would. Uses real timelocks (60s), so it takes ~3 min.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { config as loadEnv } from "dotenv";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ARC_TESTNET_CHAIN_ID, DHARMA_ABI, Kind, actionTypedData, encodeChange, type Change } from "@prekaruna/dharma";
import { Store } from "../src/store.ts";
import { CircleCliWallet } from "../src/wallet.ts";
import { Gatekeeper } from "../src/gatekeeper.ts";
import { agentApi, consoleApi } from "../src/server.ts";
import { CircleChainWriter, publicClient } from "../src/chain.ts";
import { EXPLORER } from "../src/config.ts";
import { KarunaAgent } from "../../agents/src/client.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env"), quiet: true });
const WALLET = (process.env.VERIFY_WALLET ?? "").toLowerCase() as Address;
if (!/^0x[0-9a-f]{40}$/.test(WALLET)) throw new Error("Set VERIFY_WALLET to your Circle agent wallet address");

const results: { check: string; pass: boolean; detail: string }[] = [];
const record = (check: string, pass: boolean, detail: string) => {
  results.push({ check, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${check}\n      ${detail}`);
};
const step = (s: string) => console.log(`\n· ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listen = (s: Server, port: number) => new Promise<void>((ok) => s.listen(port, "127.0.0.1", ok));

// ---- isolated gatekeeper on Arc testnet
const dir = mkdtempSync(join(tmpdir(), "karuna-verify3-"));
const store = new Store(dir);
const client = publicClient(process.env.ARC_RPC_URL);
const gk = new Gatekeeper({
  store, wallet: new CircleCliWallet(), client,
  writerFor: (a: Address) => new CircleChainWriter(a, client),
  timelockSeconds: 60, anchorEvery: 1000,
});
const token = store.loadOrCreateConsoleToken();
const aSrv = agentApi(gk);
const cSrv = consoleApi(gk, new CircleCliWallet(), token);
await listen(aSrv, 19787);
await listen(cSrv, 19788);

const api = async (path: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:19788/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-karuna-console-token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await r.json()) as Record<string, any>;
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
};
let dharma: Address;
/** What a member's browser does: build the change, sign it with its own key, post it. */
async function act(who: PrivateKeyAccount, kind: number, change: Change, extra: { proposalId?: number; support?: boolean; label?: string } = {}) {
  const { op, data } = encodeChange(change);
  const nonce = BigInt((await api(`/dharma/nonce/${who.address}`)).nonce);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const signature = await who.signTypedData(
    actionTypedData(dharma, ARC_TESTNET_CHAIN_ID, { kind, op, data, proposalId: BigInt(extra.proposalId ?? 0), support: !!extra.support, nonce, deadline }),
  );
  return api("/dharma/action", { kind, op, data, proposalId: extra.proposalId ?? 0, support: !!extra.support, signer: who.address, deadline: deadline.toString(), signature, label: extra.label });
}
const state = () => api("/state");
const proposal = async (id: number) => (await state()).policy.proposals.find((p: { id: number }) => p.id === id);
async function waitFor(what: string, ok: () => Promise<boolean>, timeoutMs = 150_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await ok()) return true;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const memberA = privateKeyToAccount(generatePrivateKey());
const memberB = privateKeyToAccount(generatePrivateKey());

try {
  // ---- 0. setup deploys the org's Dharma
  step("Setting up a throwaway org (deploys a fresh Dharma via the Circle CLI)…");
  const t0 = Date.now();
  const setup = await api("/setup", { orgName: "Phase 3 verification", memberName: "Member A", memberAddress: memberA.address, walletAddress: WALLET });
  dharma = setup.dharma.address as Address;
  await gk.start(3000); // background sync + executes passed proposals + anchors
  const code = await client.getCode({ address: dharma });
  let explorerOk = false;
  try {
    const r = await fetch(`${EXPLORER}/api/v2/addresses/${dharma}`);
    explorerOk = r.ok && ((await r.json()) as { is_contract?: boolean }).is_contract === true;
  } catch {
    explorerOk = false;
  }
  record(
    "Contract address is visible on the Arc explorer",
    !!code && code.length > 2 && explorerOk,
    `${EXPLORER}/address/${dharma} (deployed in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${(code!.length - 2) / 2} bytes of code; explorer reports a contract: ${explorerOk})`,
  );

  // ---- 1. bootstrap: one member is a majority of one
  step("Member A (alone, so a majority) proposes: add member B, add an agent…");
  const prep = await api("/agents/prepare", { name: "Verifier agent" });
  const agent = new KarunaAgent({ gatekeeperUrl: "http://127.0.0.1:19787", token: prep.token });
  const p1 = await act(memberA, Kind.Propose, { op: "AddMember", member: memberB.address }, { label: "Member B" });
  const p2 = await act(memberA, Kind.Propose, { op: "SetAgent", id: prep.id, capUsd: 0 });
  step(`Waiting out the 60s timelock for proposals #${p1.proposalId} and #${p2.proposalId}…`);
  await waitFor("bootstrap proposals executed", async () =>
    (await proposal(p1.proposalId)).status === "executed" && (await proposal(p2.proposalId)).status === "executed");
  const s1 = await state();
  console.log(`      members: ${s1.policy.members.length}, agents: ${s1.policy.agents.filter((a: { active: boolean }) => a.active).length}`);

  // ---- 2. tighten: instant
  const github = "https://github.com/karuna-protocol";
  const before = await agent.propose({ type: "action", tool: "http", method: "GET", url: github });
  step("Member B adds a block rule (tightening: one signature, no vote)…");
  const blockRule: Change = { op: "AddRule", id: "no-github", outcome: "Deny", scope: "http", target: "github.com" };
  const tTight = Date.now();
  const tight = await act(memberB, Kind.Tighten, blockRule);
  const after = await agent.propose({ type: "action", tool: "http", method: "GET", url: github });
  const ruleAfter = (await state()).proposals.find((p: { id: string }) => p.id === after.id)?.decision.ruleId;
  record(
    "Adding a block rule takes effect immediately",
    before.status === "allowed" && after.status === "denied" && ruleAfter === "no-github",
    `GET github.com: "${before.status}" before → "${after.status}" (rule ${ruleAfter}) right after one signed tx (${((Date.now() - tTight) / 1000).toFixed(1)}s, tx ${tight.txRef.slice(0, 10)}…)`,
  );

  // ---- 3. loosen: vote + timelock
  step("Member A proposes removing it (loosening)…");
  const removal: Change = { op: "RemoveRule", id: "no-github" };
  const prop = await act(memberA, Kind.Propose, removal);
  const afterPropose = await proposal(prop.proposalId);
  step("Waiting 65s with only 1 of 2 votes…");
  await sleep(65_000);
  const stillBlocked = await agent.propose({ type: "action", tool: "http", method: "GET", url: github });
  const stillOpen = await proposal(prop.proposalId);
  step("Member B votes yes → queued; trying to execute before the timelock…");
  await act(memberB, Kind.Vote, removal, { proposalId: prop.proposalId, support: true });
  const queued = await proposal(prop.proposalId);
  let earlyExecute = "not attempted";
  try {
    await client.simulateContract({ address: dharma, abi: DHARMA_ABI, functionName: "execute", args: [BigInt(prop.proposalId)], account: WALLET });
    earlyExecute = "succeeded (BAD)";
  } catch (e) {
    earlyExecute = /NotReady/.test(String(e)) ? "rejected: NotReady" : `rejected: ${String(e).slice(0, 60)}`;
  }
  const blockedWhileQueued = await agent.propose({ type: "action", tool: "http", method: "GET", url: github });
  step("Waiting out the timelock; the Gatekeeper executes it…");
  await waitFor("removal executed", async () => (await proposal(prop.proposalId)).status === "executed");
  const unblocked = await agent.propose({ type: "action", tool: "http", method: "GET", url: github });
  record(
    "Removing one only works after the vote and the wait",
    afterPropose.status === "open" && stillBlocked.status === "denied" && stillOpen.status === "open" &&
      queued.status === "queued" && earlyExecute === "rejected: NotReady" && blockedWhileQueued.status === "denied" && unblocked.status === "allowed",
    `1/2 votes after 65s → still "${stillOpen.status}", agent "${stillBlocked.status}"; 2/2 → "${queued.status}", early execute ${earlyExecute}, agent "${blockedWhileQueued.status}"; after timelock → "executed", agent "${unblocked.status}"`,
  );

  // ---- 4. core boundaries
  step("Trying to remove each core boundary, by vote and by the fast path…");
  const tries: string[] = [];
  for (const id of ["core-boundary", "secrets-read", "unknown-recipient", "default-deny"]) {
    for (const kind of [Kind.Propose, Kind.Tighten]) {
      try {
        await act(memberA, kind, { op: "RemoveRule", id });
        tries.push(`${id}:${kind === Kind.Propose ? "vote" : "fast"}=ALLOWED`);
      } catch (e) {
        tries.push(`${id}:${kind === Kind.Propose ? "vote" : "fast"}=${(String(e).match(/CoreBoundary|NotTightening/) ?? ["?"])[0]}`);
      }
    }
  }
  const coreActive = (await state()).policy.rules.filter((r: { core: boolean; active: boolean }) => r.core && r.active).length;
  record(
    "Removing a core boundary always fails",
    tries.every((t) => /=CoreBoundary$|=NotTightening$/.test(t)) && coreActive === 4,
    `${tries.join(" · ")} — all 4 core rules still active (Dharma rejected each in simulation, so no gas was spent)`,
  );

  // ---- 5. panic + anchoring + events
  step("Member A hits panic; anchoring the signed log on Dharma…");
  await act(memberA, Kind.Tighten, { op: "Freeze" });
  const frozenTry = await agent.propose({ type: "action", tool: "http", method: "GET", url: github });
  await gk.anchorNow();
  const head = await client.readContract({ address: dharma, abi: DHARMA_ABI, functionName: "logHead" });
  const len = await client.readContract({ address: dharma, abi: DHARMA_ABI, functionName: "logLength" });
  record(
    "Panic freezes instantly; the signed log is anchored onchain",
    frozenTry.status === "denied" && (await state()).policy !== null && head === `0x${gk.log.head()}` && Number(len) === gk.log.length,
    `agent while frozen: "${frozenTry.status}"; onchain logHead ${head.slice(0, 12)}… = local head, length ${len}`,
  );

  const names = ["RuleAdded", "RuleRemoved", "VoteCast", "ProposalCreated", "ProposalQueued", "ProposalExecuted", "AgentFrozen", "MemberAdded", "AgentSet", "LogAnchored"] as const;
  const counts = await Promise.all(
    names.map(async (n) => [n, (await client.getContractEvents({ address: dharma, abi: DHARMA_ABI, eventName: n, fromBlock: (await client.getBlockNumber()) - 9_000n })).length] as const),
  );
  record(
    "Dharma emits the events QuickNode will stream",
    counts.every(([, c]) => c > 0),
    counts.map(([n, c]) => `${n}×${c}`).join(" "),
  );
} catch (e) {
  record("verification run", false, e instanceof Error ? e.message : String(e));
} finally {
  gk.stop();
  await gk.idle();
  aSrv.close();
  cSrv.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Dharma: ${dharma! ? `${EXPLORER}/address/${dharma}` : "not deployed"}`);
process.exit(failed.length ? 1 : 0);
