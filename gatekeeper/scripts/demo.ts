// The full demo (CLAUDE.md §11), end to end, live on Arc testnet — a rehearsal you can run
// repeatedly (ROADMAP Phase 7: "the full demo runs 3 times in a row with no fixes in between").
//
//   VERIFY_WALLET=0x…                      the org's Circle agent wallet (USDC + a Gateway balance)
//   VERIFY_SELLER=http://127.0.0.1:4021    the test seller (fake data feed; services/test-seller)
//   pnpm --dir gatekeeper demo [--runs 3]
//
// Each run: a throwaway org (temp data dir, ports 16787/16788), a fresh Dharma, two members
// (Owner, Manager) and three agents (Bills, Supplies, Research). Amounts are scaled to testnet:
// the "$900 bill" is $0.90 against a $0.50 two-person threshold. Moves ~$0.95 of testnet USDC per run.
// Only fake targets: our own test seller, fresh addresses, Karuna-minted trap keys.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { config as loadEnv } from "dotenv";
import { erc20Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ARC_TESTNET_CHAIN_ID, Kind, actionTypedData, encodeChange, paymentDecisionTypedData, type Change } from "@prekaruna/dharma";
import { Store } from "../src/store.ts";
import { CircleCliWallet } from "../src/wallet.ts";
import { Gatekeeper } from "../src/gatekeeper.ts";
import { agentApi, consoleApi } from "../src/server.ts";
import { CircleChainWriter, publicClient } from "../src/chain.ts";
import { USDC_TOKEN, EXPLORER } from "../src/config.ts";
import { autoRuleId } from "../src/shield.ts";
import { KarunaAgent } from "../../agents/src/client.ts";
import { parseInvoice } from "../../agents/examples/payables-agent.ts";
import { researchAgentTurn } from "../../agents/examples/swarm-agents.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env"), quiet: true });
const WALLET = (process.env.VERIFY_WALLET ?? "").toLowerCase() as Address;
const SELLER = process.env.VERIFY_SELLER ?? "http://127.0.0.1:4021";
if (!/^0x[0-9a-f]{40}$/.test(WALLET)) throw new Error("Set VERIFY_WALLET");
const RUNS = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listen = (s: Server, port: number) => new Promise<void>((ok) => s.listen(port, "127.0.0.1", ok));
const close = (s: Server) => new Promise<void>((ok) => s.close(() => ok()));
const client = publicClient(process.env.ARC_RPC_URL);
const usdc = () => client.readContract({ address: USDC_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [WALLET] });

async function runOnce(run: number) {
  const results: { step: string; pass: boolean; detail: string }[] = [];
  const record = (step: string, pass: boolean, detail: string) => {
    results.push({ step, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${step}\n      ${detail}`);
  };
  const say = (s: string) => console.log(`\n· ${s}`);

  const health = (await fetch(`${SELLER}/health`).then((r) => r.json()).catch(() => null)) as { sellerAddress?: string } | null;
  if (!health?.sellerAddress) throw new Error(`Test seller not reachable at ${SELLER}`);
  await fetch(`${SELLER}/__test/price`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ usd: "0.001" }) });
  const SELLER_ADDR = health.sellerAddress.toLowerCase() as Address;
  const SUPPLIER = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address; // fresh, fake

  const store = new Store(mkdtempSync(join(tmpdir(), `karuna-demo${run}-`)));
  const wallet = new CircleCliWallet();
  const gk = new Gatekeeper({ store, wallet, client, writerFor: (a: Address) => new CircleChainWriter(a, client), timelockSeconds: 60, anchorEvery: 1000 });
  const token = store.loadOrCreateConsoleToken();
  const aSrv = agentApi(gk);
  const cSrv = consoleApi(gk, wallet, token);
  await listen(aSrv, 16787);
  await listen(cSrv, 16788);
  const api = async (path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:16788/api${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-karuna-console-token": token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = (await r.json()) as Record<string, any>;
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
  };
  const owner = privateKeyToAccount(generatePrivateKey());
  const manager = privateKeyToAccount(generatePrivateKey());
  let dharma: Address = "0x";
  async function act(who: PrivateKeyAccount, kind: number, change: Change | null, opts: { label?: string; proposalId?: number; support?: boolean } = {}) {
    const { op, data } = change ? encodeChange(change) : { op: 0, data: "0x" as Hex };
    const nonce = BigInt((await api(`/dharma/nonce/${who.address}`)).nonce);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const proposalId = BigInt(opts.proposalId ?? 0);
    const support = !!opts.support;
    const signature = await who.signTypedData(actionTypedData(dharma, ARC_TESTNET_CHAIN_ID, { kind, op, data, proposalId, support, nonce, deadline }));
    return api("/dharma/action", { kind, op, data, proposalId: Number(proposalId), support, signer: who.address, deadline: deadline.toString(), signature, label: opts.label });
  }
  async function approve(who: PrivateKeyAccount, id: string, payloadHash: string) {
    const h = (payloadHash.startsWith("0x") ? payloadHash : `0x${payloadHash}`) as Hex;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const signature = await who.signTypedData(paymentDecisionTypedData(dharma, ARC_TESTNET_CHAIN_ID, { proposalId: id, payloadHash: h, approve: true, deadline }));
    return api(`/proposals/${id}/decide`, { approve: true, payloadHash: h, signer: who.address, deadline: deadline.toString(), signature });
  }
  async function until(what: string, ok: () => Promise<boolean>, ms = 180_000, every = 2000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await ok()) return;
      await sleep(every);
    }
    throw new Error(`timed out: ${what}`);
  }
  const state = () => api("/state");

  try {
    say(`Run ${run}: fresh Dharma; two members; Bills ($0.50/day), Supplies ($0.10/day), Research ($0.02/day); two payees…`);
    dharma = (await api("/setup", { orgName: `Demo run ${run}`, memberName: "Owner", memberAddress: owner.address, walletAddress: WALLET })).dharma.address;
    await gk.start(2000);
    const agents: Record<"Bills" | "Supplies" | "Research", { id: string; c: KarunaAgent }> = {} as never;
    for (const [name, cap] of [["Bills", 0.5], ["Supplies", 0.1], ["Research", 0.02]] as const) {
      const prep = await api("/agents/prepare", { name: `${name} agent` });
      agents[name] = { id: prep.id, c: new KarunaAgent({ gatekeeperUrl: "http://127.0.0.1:16787", token: prep.token }) };
      await act(owner, Kind.Propose, { op: "SetAgent", id: prep.id, capUsd: cap });
    }
    await act(owner, Kind.Propose, { op: "SetPayee", account: SELLER_ADDR, category: "data" }, { label: "Price feed" });
    await act(owner, Kind.Propose, { op: "SetPayee", account: SUPPLIER, category: "supplies" }, { label: "Supplier Co" });
    await act(owner, Kind.Propose, { op: "AddMember", member: manager.address }, { label: "Manager" });
    await act(owner, Kind.Propose, { op: "SetThreshold", usd: 0.5 }); // two-person approval from $0.50 (voted on like every edit)
    say("Waiting out the 60s timelock…");
    await until("setup executed", async () => {
      const p = (await state()).policy;
      return p.agents.filter((a: { active: boolean }) => a.active).length === 3 && p.payees.length === 2 && p.members.length === 2 && p.thresholdUsd === 0.5;
    });
    const before = await usdc();

    // ---- 1. normal work
    say("1. Supplies agent buys a price feed from an x402 service…");
    const feed = await agents.Supplies.c.buy(`${SELLER}/v1/data`, { reason: "today's flour price" });
    const paid = (feed.result as { paid?: { transaction?: string; verified?: boolean } })?.paid;
    record("1. Normal work: small purchase allowed, Gatekeeper pays, agent gets the data",
      feed.status === "done" && !!(feed.result as { data?: unknown })?.data && paid?.verified === true,
      `"${feed.status}", Circle payment ${paid?.transaction}`);

    // ---- 2. big bill → approval card → both approve → paid
    say("2. Bills agent wants to pay a $0.90 bill (over its allowance and the two-person threshold)…");
    const big = await agents.Bills.c.pay(SUPPLIER, 0.9, "Monthly supplies invoice #4471 — I checked it matches the PO", { payeeName: "Supplier Co" });
    const card = (await state()).proposals.find((p: { id: string }) => p.id === big.id);
    const facts = (card?.facts ?? []).map((f: { label: string }) => f.label);
    const a1 = await approve(owner, big.id, card.payloadHash);
    const a2 = await approve(manager, big.id, card.payloadHash);
    const done = await agents.Bills.c.status(big.id);
    record("2. Big bill: approval card (Facts First + Exact Match) → two members approve → paid",
      big.status === "pending" && card.approvalsNeeded === 2 && facts.includes("Payload hash") && !!card.reason && a1.status === "needs-another-approval" && done.status === "done",
      `"${big.status}" → card facts [${facts.join(", ")}], agent's reason kept separate; Owner → ${a1.status} (1/2), Manager → ${a2.status}; ` +
        `tx ${(done.result as { txRef?: string })?.txRef}`);

    // ---- 3. Auto-Shield
    say("3. Karuna slips a fake supplies invoice into the Bills agent's inbox; the agent pays it…");
    const test = await api("/shield/test", { agentId: agents.Bills.id, template: "supplier-invoice", category: "supplies" });
    const msg = (await agents.Bills.c.inbox()).find((m) => m.id === test.messageId)!;
    const inv = parseInvoice(msg)!;
    const fell = await agents.Bills.c.pay(inv.to, inv.amount, `Paying ${inv.ref}`, { payeeName: msg.from, sourceMessageId: msg.id });
    const ruleId = autoRuleId(agents.Bills.id, "supplies");
    await until("block rule onchain", async () => (await state()).policy.rules.some((r: { id: string; active: boolean }) => r.id === ruleId && r.active), 150_000);
    const blocked = await agents.Bills.c.pay(SUPPLIER, 0.01, "routine supplies");
    say("   Owner proposes 'supplies need approval' + lifting the block; the Manager votes yes on both…");
    const apId = ruleId.replace(/^sh-/, "ap-");
    const approvalRule: Change = { op: "AddRule", id: apId, outcome: "Approval", agent: agents.Bills.id, scope: "payment:supplies" };
    const ap = await act(owner, Kind.Propose, approvalRule);
    await act(manager, Kind.Vote, approvalRule, { proposalId: Number(ap.proposalId), support: true }); // a vote signs the change itself
    const prop = await act(owner, Kind.Propose, { op: "RemoveRule", id: ruleId });
    await act(manager, Kind.Vote, { op: "RemoveRule", id: ruleId }, { proposalId: Number(prop.proposalId), support: true });
    await until("restore executed", async () => {
      const rules = (await state()).policy.rules as { id: string; active: boolean }[];
      return !rules.some((r) => r.id === ruleId && r.active) && rules.some((r) => r.id === apId && r.active);
    });
    const restored = await agents.Bills.c.pay(SUPPLIER, 0.01, "routine supplies");
    record("3. Auto-Shield: falls for fake invoice → $0 moves → category blocked → vote restores with approval required",
      fell.status === "denied" && blocked.status === "denied" && restored.status === "pending",
      `fake invoice → "${fell.status}"; real supplies payment → "${blocked.status}" (blocked); after the vote → "${restored.status}" (needs a human now)`);

    // ---- 4. changed bank account
    say("4. A 'we changed banks' payment: Supplier Co's name, a new account…");
    const newAccount = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
    const scam = await agents.Bills.c.pay(newAccount, 0.2, "Supplier Co says they changed banks", { payeeName: "Supplier Co" });
    const alerts = (await state()).shield.alerts as { kind: string; title: string }[];
    record("4. Changed Bank Account Alert blocks it and alerts humans", scam.status === "denied" && alerts.some((a) => a.kind === "changed-bank-account"),
      `"${scam.status}"; alert: ${alerts.find((a) => a.kind === "changed-bank-account")?.title}`);

    // ---- 6. Preview Before Loosening
    say("6. Manager proposes adding the 'new bank account' as a payee; the preview replays the week…");
    const change: Change = { op: "SetPayee", account: newAccount, category: "supplies" };
    const loosen = await act(manager, Kind.Propose, change, { label: "Supplier Co (new bank)" });
    const gov = (await state()).policy.proposals.find((g: { id: number }) => g.id === Number(loosen.proposalId));
    const pv = gov?.preview as { replayed: number; newlyAllowed: unknown[]; flaggedAllowed: number } | null;
    await act(owner, Kind.Vote, change, { proposalId: Number(loosen.proposalId), support: false });
    await until("vote fails", async () => (await state()).policy.proposals.find((g: { id: number }) => g.id === Number(loosen.proposalId))?.status === "defeated", 60_000);
    record("6. Preview Before Loosening: the change would have let the scam through → vote fails",
      !!pv && pv.flaggedAllowed >= 1,
      `replayed ${pv?.replayed} requests: would have allowed ${pv?.newlyAllowed.length} more, ${pv?.flaggedAllowed} flagged as a scam; Owner votes no → defeated`);

    // ---- 5. swarm
    say("5. Research agent finds a trap password and shares it with the team…");
    const trap = await api("/traps", { agentId: agents.Research.id });
    await api(`/traps/${trap.id}/plant`, { agentId: agents.Research.id });
    const t0 = Date.now();
    const shared = await researchAgentTurn(agents.Research.c, [agents.Bills.id, agents.Supplies.id]);
    const after = await Promise.all(Object.values(agents).map((a) => a.c.pay(SUPPLIER, 0.01, "routine")));
    const localMs = Date.now() - t0;
    await until("freeze tx", async () => !!(await state()).swarm.trips[0]?.txRef && (await state()).frozen?.confirmed, 90_000, 250);
    const chainMs = Date.now() - t0;
    const tx = (await state()).swarm.trips[0].txRef;
    record("5. Swarm Stopper: trap key shared → all three frozen → freeze on the Arc explorer",
      shared[0]?.result.status === "denied" && after.every((r) => r.status === "denied"),
      `stopped at the Gatekeeper in ${localMs}ms, onchain in ${(chainMs / 1000).toFixed(1)}s: ${EXPLORER}/tx/${tx}`);

    const spent = Number(before - (await usdc())) / 1e6;
    console.log(`\n      wallet USDC moved this run: $${spent.toFixed(4)} (bill + approved payments; scams moved $0)`);
  } catch (e) {
    record("demo run", false, e instanceof Error ? e.message.split("\n")[0] : String(e));
  } finally {
    gk.stop();
    await gk.idle();
    await close(aSrv);
    await close(cSrv);
  }
  console.log(`\nRun ${run}: ${results.filter((r) => r.pass).length}/${results.length} steps passed. Dharma: ${EXPLORER}/address/${dharma}`);
  return results.every((r) => r.pass) && results.length === 6;
}

let streak = 0;
for (let i = 1; i <= RUNS; i++) {
  if (await runOnce(i)) streak++;
  else break;
}
console.log(`\n${streak}/${RUNS} full demo runs in a row passed.`);
process.exit(streak === RUNS ? 0 : 1);
