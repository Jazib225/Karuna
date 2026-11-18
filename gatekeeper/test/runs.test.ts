// Agents Karuna builds and runs, and the Runs view (every sandbox run's timeline), against the REAL
// Dharma contract on anvil. A fake launcher stands in for Docker: it opens the run's session the way
// `karuna run` does and plays what a box would do.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { startAnvil } from "./anvil.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, type Address, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { Kind, actionTypedData, encodeChange, type Change } from "@prekaruna/dharma";
import { Store } from "../src/store.ts";
import { Gatekeeper, dueReason, parseSchedule, scheduleText, type SignedAction } from "../src/gatekeeper.ts";
import { ViemChainWriter } from "../src/chain.ts";
import { draftAgentSpec } from "../src/agent-draft.ts";
import type { WalletBackend } from "../src/wallet.ts";

const PORT = 26545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 5042002, name: "anvil-arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const GK_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const PAYEE = "0x00000000000000000000000000000000000000a1" as Address;

describe("schedules", () => {
  it("are validated and say when they're due", () => {
    expect(() => parseSchedule({ kind: "every", minutes: 5 })).toThrow(/15 minutes/);
    expect(() => parseSchedule({ kind: "daily", at: "9am" })).toThrow(/HH:MM/);
    expect(scheduleText(parseSchedule({ kind: "every", minutes: 120 }))).toBe("Every 2 h");
    const now = new Date("2026-11-14T10:00:00");
    expect(dueReason({ instructions: "", paused: false, createdAt: "", schedule: { kind: "every", minutes: 60 }, lastRunAt: new Date(now.getTime() - 61 * 60_000).toISOString() }, now)).toBe("Every 1 h");
    expect(dueReason({ instructions: "", paused: false, createdAt: "", schedule: { kind: "every", minutes: 60 }, lastRunAt: new Date(now.getTime() - 5 * 60_000).toISOString() }, now)).toBeNull();
    expect(dueReason({ instructions: "", paused: false, createdAt: "", schedule: { kind: "daily", at: "09:00" } }, now)).toBe("Daily at 09:00");
    expect(dueReason({ instructions: "", paused: false, createdAt: "", schedule: { kind: "daily", at: "09:00" }, lastRunAt: new Date("2026-11-14T09:01:00").toISOString() }, now)).toBeNull();
    expect(dueReason({ instructions: "", paused: false, createdAt: "", schedule: { kind: "inbox" }, inboxWaiting: true }, now)).toBe("Message in its inbox");
  });
});

describe("drafting an agent from plain English", () => {
  it("turns the job into a name, instructions, a schedule and limits, and never invents a bad schedule", async () => {
    const fake = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      name: "Flour buyer", instructions: "Check grain prices, then order flour from Valley Flour if under $35.",
      schedule_kind: "daily", every_minutes: 0, daily_at: "25:99", limits: "Allow payments to Valley Flour up to $50", note: "",
    }) } }] }), { status: 200 })) as unknown as typeof fetch;
    const d = await draftAgentSpec("Every morning check grain prices and order flour", { payees: [], domains: [] }, { groq: "k" }, fake);
    expect(d).toMatchObject({ name: "Flour buyer", schedule: { kind: "daily", at: "09:00" }, limits: "Allow payments to Valley Flour up to $50" });
  });
});

let anvil: ChildProcess;
let client: PublicClient;
beforeAll(async () => {
  client = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
  anvil = await startAnvil(PORT);
}, 20_000);
afterAll(() => anvil?.kill());

const wallet: WalletBackend = {
  quoteX402: async () => ({ amountUsd: 0.01, seller: PAYEE, network: "eip155:5042002", scheme: "exact" }),
  payX402: async () => ({ response: { prices: "flour $31" } }),
  transfer: async () => ({ txRef: "tx", raw: {} }),
  balances: async () => ({ usdc: "1", gateway: "0" }),
  listWallets: async () => [],
};
const gkAccount = privateKeyToAccount(GK_KEY);
let gk: Gatekeeper;
let member: PrivateKeyAccount;
let launched: { agentId: string; token: string; runId: string; exit: (code: number) => void }[];
let undos: { runId: string; path?: string }[];

async function sign(kind: number, c: Change): Promise<SignedAction> {
  const { op, data } = encodeChange(c);
  const nonce = await gk.nonceOf(member.address);
  const t = (await client.getBlock()).timestamp;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = (t > now ? t : now) + 600n;
  const signature = await member.signTypedData(actionTypedData(gk.org.dharma!.address as Address, 5042002, { kind, op, data, proposalId: 0n, support: false, nonce, deadline }));
  return { kind, op, data, proposalId: 0, support: false, signer: member.address, deadline: deadline.toString(), signature };
}
async function passTimelock() {
  const t = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
  await t.increaseTime({ seconds: 65 });
  await t.mine({ blocks: 1 });
  await gk.housekeeping();
}

beforeEach(async () => {
  if (gk) await gk.idle();
  launched = [];
  undos = [];
  member = privateKeyToAccount(generatePrivateKey());
  const writer = new ViemChainWriter(createWalletClient({ chain, account: gkAccount, transport: http(RPC) }), client);
  gk = new Gatekeeper({
    store: new Store(mkdtempSync(join(tmpdir(), "karuna-runs-"))), wallet, client, writerFor: () => writer, timelockSeconds: 60, anchorEvery: 1000,
    launcher: ({ agentId, token, runId, onExit }) => {
      launched.push({ agentId, token, runId, exit: onExit });
      return () => onExit(137);
    },
    undo: async (r) => {
      undos.push(r);
      const all = [{ mount: "/home/dev/books", path: "ledger.csv" }, { mount: "/home/dev/books", path: "new.txt" }];
      return { restored: r.path ? all.filter((x) => r.path!.endsWith(x.path)) : all, skipped: [] };
    },
  });
  await gk.setup({ orgName: "Runs Org", memberName: "Owner", memberAddress: member.address, walletAddress: gkAccount.address });
  await gk.submitAction({ ...(await sign(Kind.Propose, { op: "SetPayee", account: PAYEE, category: "data" })), label: "Grain Feed" });
  await passTimelock();
}, 60_000);

/** What the console does: create the built agent, then propose it on Dharma. */
async function buildAgent(schedule: unknown) {
  const { id } = gk.buildAgent({ name: "Flour buyer", instructions: "Check prices and order flour.", schedule });
  await gk.submitAction(await sign(Kind.Propose, { op: "SetAgent", id, capUsd: 0 }));
  await passTimelock();
  return id;
}

/** What `karuna run` does in the box for one run: open the session (with its run id) and act. */
function playBox(l: (typeof launched)[number]) {
  const s = gk.startSession(l.agentId, { host: "this-pc", isolation: "docker", runId: l.runId });
  return s.token;
}

describe("agents Karuna runs", () => {
  it("Run now starts it with a token for that run only; the box reads its job; the run records everything", async () => {
    const id = await buildAgent({ kind: "manual" });
    expect(gk.snapshot().policy!.agents.find((a) => a.id === id)!.built).toMatchObject({ scheduleText: "Only when started", paused: false });
    const { runId } = gk.runBuiltAgent(id);
    expect(() => gk.runBuiltAgent(id)).toThrow(/already running/);
    expect(launched).toHaveLength(1);
    expect(gk.authAgent(launched[0].token)?.agentId).toBe(id); // that run's fresh token
    const box = playBox(launched[0]);
    expect(gk.jobFor(box)).toMatchObject({ name: "Flour buyer", instructions: "Check prices and order flour.", trigger: "Run now", runId });

    // The model call, a web request, a payment and its own print, the way the proxy and runner report them.
    gk.recordModelExchange(box, { url: "https://api.anthropic.com/v1/messages", status: 200, provider: "Anthropic", exchange: {
      provider: "Anthropic", model: "claude-sonnet-5-5", asked: "Run started", system: "", toolsOffered: ["pay"], said: "Buying flour.", thinking: "", toolCalls: [{ name: "pay", input: "{}" }], stopReason: "tool_use",
    } });
    gk.egress(box, { method: "GET", url: "https://evil.example/x", headers: {}, body: Buffer.alloc(0) });
    const paid = await gk.propose(id, { type: "transfer", to: PAYEE, amountUsd: 0.05 });
    gk.noteRunProposal(box, paid);
    gk.noteOutput(box, ["tool    pay → Done."]);
    gk.endSession(box, "runner exited");
    launched[0].exit(0);

    const run = gk.runView(runId);
    expect(run).toMatchObject({ status: "done", trigger: "Run now", built: true, models: ["claude-sonnet-5-5 (Anthropic)"], reasoningVisible: true });
    expect(run.steps.map((s) => s.kind)).toEqual(["model", "action", "action", "note"]);
    expect(run.steps[1]).toMatchObject({ kind: "action", summary: "GET evil.example/x", outcome: "denied", ruleId: "unlisted-domain" });
    expect(run.steps[2]).toMatchObject({ kind: "action", outcome: "allowed" });
    expect(gk.snapshot().runs[0]).toMatchObject({ id: runId, agentName: "Flour buyer", actions: 2 });
  }, 90_000);

  it("the scheduler starts it when it's due; paused agents and agents not yet on Dharma don't run", async () => {
    const id = await buildAgent({ kind: "every", minutes: 60 });
    await gk.housekeeping();
    expect(launched.map((l) => l.agentId)).toEqual([id]); // never run before: due now
    launched[0].exit(0);
    await gk.housekeeping();
    expect(launched).toHaveLength(1); // ran a moment ago
    gk.updateBuiltAgent(id, { paused: true });
    expect(() => gk.updateBuiltAgent(id, { schedule: { kind: "every", minutes: 1 } })).toThrow();

    const { id: pending } = gk.buildAgent({ name: "Not voted yet", instructions: "x", schedule: { kind: "every", minutes: 15 } });
    await gk.housekeeping();
    expect(launched.some((l) => l.agentId === pending)).toBe(false);
    expect(() => gk.runBuiltAgent(pending)).toThrow(/isn't on Dharma yet/);
  }, 90_000);

  it("an inbox agent starts when a message arrives", async () => {
    const id = await buildAgent({ kind: "inbox" });
    await gk.housekeeping();
    expect(launched).toHaveLength(0);
    gk.postMessage({ agentId: id, from: "Valley Flour", subject: "Invoice 12", body: "Please pay $31" });
    await gk.housekeeping();
    expect(launched).toHaveLength(1);
    expect(gk.runView(launched[0].runId).trigger).toBe("Message in its inbox");
  }, 90_000);

  it("Stop ends a run: the launcher is stopped and its box gets told to stop", async () => {
    const id = await buildAgent({ kind: "manual" });
    const { runId } = gk.runBuiltAgent(id);
    const box = playBox(launched[0]);
    gk.stopRun(runId);
    expect(gk.heartbeat(box)).toMatchObject({ stop: true });
    expect(gk.runView(runId).status).toBe("stopped");
  }, 60_000);
});

describe("developers' sandboxed agents get a run too", () => {
  it("karuna run opens a run; with actions but no model traffic, its reasoning shows as not visible", async () => {
    await gk.submitAction(await sign(Kind.Propose, { op: "SetAgent", id: "dev-bot", capUsd: 0 }));
    await passTimelock();
    const s = gk.startSession("dev-bot", { host: "laptop", isolation: "docker" });
    gk.egress(s.token, { method: "GET", url: "https://api.github.com/zen", headers: {}, body: Buffer.alloc(0) });
    const [run] = gk.runsView("dev-bot");
    expect(run).toMatchObject({ trigger: "karuna run on laptop", status: "running", built: false, actions: 1, reasoningVisible: false });
    gk.endSession(s.token);
    expect(gk.runsView("dev-bot")[0].status).toBe("done");
  }, 60_000);
});

describe("undo a run's file changes", () => {
  it("the runner reports what changed; the console undoes one file, then the rest", async () => {
    await gk.submitAction(await sign(Kind.Propose, { op: "SetAgent", id: "dev-bot", capUsd: 0 }));
    await passTimelock();
    const s = gk.startSession("dev-bot", { host: "laptop", isolation: "docker" });
    gk.recordRunChanges({ token: s.token }, { changes: [
      { mount: "/home/dev/books", path: "ledger.csv", kind: "modified", diff: "-a +b", binary: false },
      { mount: "/home/dev/books", path: "new.txt", kind: "added", diff: "+hi", binary: false },
      { mount: "/home/dev/books", path: "../escape", kind: "added", diff: null, binary: false },
    ] });
    const runId = gk.runsView("dev-bot")[0].id;
    await expect(gk.undoRunChanges(runId)).rejects.toThrow(/Stop the run/);
    gk.endSession(s.token);
    expect(gk.runsView("dev-bot")[0]).toMatchObject({ changes: 2, undone: 0 });
    // Another agent can't report changes for this run.
    expect(() => gk.recordRunChanges({ agentId: "someone-else" }, { runId, changes: [] })).toThrow(/No such run/);

    await gk.undoRunChanges(runId, { path: "ledger.csv" });
    expect(undos.at(-1)).toEqual({ runId, path: "/home/dev/books/ledger.csv" });
    expect(gk.runView(runId).fileChanges.find((c) => c.path === "ledger.csv")?.undoneAt).toBeTruthy();
    await expect(gk.undoRunChanges(runId, { path: "ledger.csv" })).rejects.toThrow(/Already undone/);

    await gk.undoRunChanges(runId);
    expect(undos.at(-1)).toEqual({ runId });
    expect(gk.runsView("dev-bot")[0]).toMatchObject({ changes: 2, undone: 2 });
    await expect(gk.undoRunChanges(runId)).rejects.toThrow(/Already undone/);
    expect(gk.logTail(20).some((e) => e.event?.type === "run-undone")).toBe(true);
  }, 60_000);
});
