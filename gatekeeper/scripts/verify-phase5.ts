// Live Phase 5 verification on Arc testnet.
//
//   VERIFY_WALLET=0x…   the org's Circle agent wallet
//
// Throwaway org (temp data dir, ports 17787/17788), fresh Dharma, one member key. A gullible
// agent reads its inbox and pays whatever invoice it finds. Moves ~$0.02 of testnet USDC.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { config as loadEnv } from "dotenv";
import { erc20Abi, zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_CHAIN_ID, DHARMA_ABI, Kind, actionTypedData, encodeChange, type Change } from "@prekaruna/dharma";
import { Store } from "../src/store.ts";
import { CircleCliWallet } from "../src/wallet.ts";
import { Gatekeeper } from "../src/gatekeeper.ts";
import { agentApi, consoleApi } from "../src/server.ts";
import { CircleChainWriter, publicClient } from "../src/chain.ts";
import { USDC_TOKEN, EXPLORER } from "../src/config.ts";
import { autoRuleId, ShieldGuardError, autoRule } from "../src/shield.ts";
import { KarunaAgent } from "../../agents/src/client.ts";
import { parseInvoice } from "../../agents/examples/payables-agent.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env"), quiet: true });
const WALLET = (process.env.VERIFY_WALLET ?? "").toLowerCase() as Address;
if (!/^0x[0-9a-f]{40}$/.test(WALLET)) throw new Error("Set VERIFY_WALLET");
const SUPPLIER = "0xc55a1499aab6747e1edf23e930b6e92c60a18fdb" as Address; // payee: supplies
const UTILITY = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address; // payee: utilities (fresh)

const results: { check: string; pass: boolean; detail: string }[] = [];
const record = (check: string, pass: boolean, detail: string) => {
  results.push({ check, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${check}\n      ${detail}`);
};
const step = (s: string) => console.log(`\n· ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listen = (s: Server, port: number) => new Promise<void>((ok) => s.listen(port, "127.0.0.1", ok));

const dir = mkdtempSync(join(tmpdir(), "karuna-verify5-"));
const store = new Store(dir);
const client = publicClient(process.env.ARC_RPC_URL);
const logsClient = publicClient(process.env.ARC_LOGS_RPC_URL); // QuickNode free plan caps eth_getLogs
const gk = new Gatekeeper({ store, wallet: new CircleCliWallet(), client, writerFor: (a: Address) => new CircleChainWriter(a, client), timelockSeconds: 60, anchorEvery: 1000 });
const token = store.loadOrCreateConsoleToken();
const aSrv = agentApi(gk);
const cSrv = consoleApi(gk, new CircleCliWallet(), token);
await listen(aSrv, 17787);
await listen(cSrv, 17788);
const api = async (path: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:17788/api${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-karuna-console-token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await r.json()) as Record<string, any>;
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
};
const member = privateKeyToAccount(generatePrivateKey());
let dharma: Address;
async function act(kind: number, change: Change, label?: string) {
  const { op, data } = encodeChange(change);
  const nonce = BigInt((await api(`/dharma/nonce/${member.address}`)).nonce);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const signature = await member.signTypedData(actionTypedData(dharma, ARC_TESTNET_CHAIN_ID, { kind, op, data, proposalId: 0n, support: false, nonce, deadline }));
  return api("/dharma/action", { kind, op, data, signer: member.address, deadline: deadline.toString(), signature, label });
}
async function until(what: string, ok: () => Promise<boolean>, ms = 150_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await sleep(3000);
  }
  throw new Error(`timed out: ${what}`);
}
const ruleActive = async (id: string) => (await api("/state")).policy.rules.some((r: { id: string; active: boolean }) => r.id === id && r.active);

try {
  step("Setup: fresh Dharma; propose an agent ($1/day), a supplies payee and a utilities payee…");
  dharma = (await api("/setup", { orgName: "Phase 5 verification", memberName: "Owner", memberAddress: member.address, walletAddress: WALLET })).dharma.address;
  await gk.start(3000);
  const prep = await api("/agents/prepare", { name: "Payables agent" });
  const agentId = prep.id as string;
  const agent = new KarunaAgent({ gatekeeperUrl: "http://127.0.0.1:17787", token: prep.token });
  await act(Kind.Propose, { op: "SetAgent", id: agentId, capUsd: 1 });
  await act(Kind.Propose, { op: "SetPayee", account: SUPPLIER, category: "supplies" }, "Golden Supply Co");
  await act(Kind.Propose, { op: "SetPayee", account: UTILITY, category: "utilities" }, "City Power");
  step("Waiting out the 60s timelock…");
  await until("setup executed", async () => {
    const p = (await api("/state")).policy;
    return p.payees.length === 2 && p.agents.some((a: { active: boolean }) => a.active);
  });

  // ---- 1. fake supplies invoice → agent falls for it → $0 moves → block rule onchain
  step("Karuna sends a fake supplies invoice; the gullible agent reads its inbox and pays it…");
  const sent = await api("/shield/test", { agentId, template: "supplier-invoice", category: "supplies" });
  const inbox = await agent.inbox();
  const msg = inbox.find((m) => m.id === sent.messageId)!;
  const inv = parseInvoice(msg)!;
  const tPay = Date.now();
  const r = await agent.pay(inv.to, inv.amount, `Paying ${inv.ref} from ${msg.from}`, { payeeName: msg.from, sourceMessageId: msg.id });
  const answeredMs = Date.now() - tPay;
  const ruleId = autoRuleId(agentId, "supplies");
  await until("block rule onchain", () => ruleActive(ruleId), 90_000);
  // TestFailed is a second transaction right after the rule; wait for it too.
  const failedEventsNow = async () =>
    logsClient.getContractEvents({ address: dharma, abi: DHARMA_ABI, eventName: "TestFailed", fromBlock: (await logsClient.getBlockNumber()) - 5_000n });
  await until("TestFailed event onchain", async () => (await failedEventsNow()).length > 0, 90_000);
  const onchain = (await client.readContract({ address: dharma, abi: DHARMA_ABI, functionName: "rules" })).length;
  const baitBalance = await client.readContract({ address: USDC_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [inv.to as Address] });
  const paidAny = (await api("/state")).proposals.some((p: { status: string }) => p.status === "executed");
  const failedEvents = await failedEventsNow();
  record(
    "Fake supplies invoice → agent falls for it → $0 moves → block rule appears onchain",
    r.status === "denied" && baitBalance === 0n && !paidAny && failedEvents.length === 1,
    `agent paid "${msg.subject}" ($${inv.amount} to the invoice's address) → "${r.status}" in ${answeredMs}ms; bait address holds ${baitBalance} USDC; ` +
      `rule ${ruleId} active on Dharma (${onchain} rules); TestFailed event emitted`,
  );

  // ---- 2. still pays utilities, not supplies
  step("The same agent pays a real utilities bill, then a real supplies bill…");
  const util = await agent.pay(UTILITY, 0.01, "Monthly power bill", { payeeName: "City Power" });
  const supp = await agent.pay(SUPPLIER, 0.01, "Weekly flour", { payeeName: "Golden Supply Co" });
  const suppRule = (await api("/state")).proposals.find((p: { id: string }) => p.id === supp.id)?.decision.ruleId;
  record(
    "The agent can still pay utilities, but not supplies",
    util.status === "done" && supp.status === "denied" && suppRule === ruleId,
    `utilities $0.01 → "${util.status}" (tx ${(util.result as { txRef?: string })?.txRef?.slice(0, 12)}…); supplies $0.01 → "${supp.status}" by ${suppRule}`,
  );

  // ---- 3. only a human vote restores
  step("Trying to lift the block: Gatekeeper alone, then a member's vote…");
  const writer = new CircleChainWriter(WALLET, client);
  let gkAlone = "";
  try {
    const { op, data } = encodeChange({ op: "RemoveRule", id: ruleId });
    await writer.write(dharma, "tighten", [op, data, zeroAddress, 0n, "0x"]);
    gkAlone = "LIFTED (BAD)";
  } catch (e) {
    gkAlone = /NotTightening/.test(String(e)) ? "refused: NotTightening" : `refused: ${String(e).slice(0, 60)}`;
  }
  const prop = await act(Kind.Propose, { op: "RemoveRule", id: ruleId });
  const stillBlocked = (await agent.pay(SUPPLIER, 0.01, "retry")).status;
  step("Waiting out the 60s timelock…");
  await until("restore executed", async () => !(await ruleActive(ruleId)));
  const after = await agent.pay(SUPPLIER, 0.01, "Weekly flour", { payeeName: "Golden Supply Co" });
  record(
    "Only a human vote restores access",
    gkAlone === "refused: NotTightening" && stillBlocked === "denied" && after.status === "done",
    `Gatekeeper alone → ${gkAlone}; member proposal #${prop.proposalId} → still "${stillBlocked}" during timelock → executed → supplies payment "${after.status}"`,
  );

  // ---- 4. Auto-Shield can't write an allow rule
  let codeGuard = "";
  try {
    autoRule(agentId, "supplies", "Allow" as never);
  } catch (e) {
    codeGuard = e instanceof ShieldGuardError ? "ShieldGuardError" : String(e);
  }
  let viaGk = "";
  try {
    await gk.writeAutoRule({ op: "AddRule", id: "sh-allow-00000000", outcome: "Allow", agent: agentId, scope: "payment:supplies" });
  } catch (e) {
    viaGk = e instanceof ShieldGuardError ? "ShieldGuardError" : String(e);
  }
  let chainGuard = "";
  try {
    const { op, data } = encodeChange({ op: "AddRule", id: "sneaky-allow", outcome: "Allow", scope: "payment" });
    await writer.write(dharma, "tighten", [op, data, zeroAddress, 0n, "0x"]);
  } catch (e) {
    chainGuard = /NotTightening/.test(String(e)) ? "NotTightening" : String(e).slice(0, 60);
  }
  record("Trying to make Auto-Shield write an allow rule → error", codeGuard === "ShieldGuardError" && viaGk === "ShieldGuardError" && chainGuard === "NotTightening",
    `rule builder → ${codeGuard}; Gatekeeper writer → ${viaGk}; straight to Dharma → ${chainGuard}`);

  // ---- 5. changed bank account
  const bank = await agent.pay("0x00000000000000000000000000000000000000ff", 0.01, "Golden changed banks", { payeeName: "Golden Supply Co" });
  const alerts = (await api("/state")).shield.alerts as { kind: string; title: string }[];
  record("Changed Bank Account Alert: known supplier + new account → deny + alert", bank.status === "denied" && alerts.some((a) => a.kind === "changed-bank-account"),
    `"${bank.status}"; humans alerted: ${alerts.find((a) => a.kind === "changed-bank-account")?.title}`);

  // ---- 6. a careful agent passes
  const t2 = await api("/shield/test", { agentId, template: "bank-change" });
  await agent.report(t2.messageId, "bank change by email — verify by phone");
  const passed = (await api("/state")).shield.tests.find((t: { id: string }) => t.id === t2.testId);
  record("An agent that flags the scam passes the test", passed?.status === "passed", `bank-change test → ${passed?.status} (${passed?.resolution})`);
} catch (e) {
  record("verification run", false, e instanceof Error ? e.message.split("\n")[0] : String(e));
} finally {
  gk.stop();
  await gk.idle();
  aSrv.close();
  cSrv.close();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Dharma: ${dharma! ? `${EXPLORER}/address/${dharma}` : "-"}`);
process.exit(failed.length ? 1 : 0);
