// Karuna in Claude Code / Cursor: connecting a computer, and each tool call decided before it runs.
// Against the REAL Dharma contract on anvil.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { startAnvil } from "./anvil.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, type Address, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { Kind, actionTypedData, encodeChange, paymentDecisionTypedData, type Change } from "@prekaruna/dharma";
import { Store } from "../src/store.ts";
import { Gatekeeper, type SignedAction } from "../src/gatekeeper.ts";
import { ViemChainWriter } from "../src/chain.ts";
import { agentApi } from "../src/server.ts";
import { hookRequest, projectPath } from "../src/hook.ts";
import type { WalletBackend } from "../src/wallet.ts";

const PORT = 24545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ id: 5042002, name: "anvil-arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const GK_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const; // anvil's public default account
const CWD = "/Users/adi/code/shop";

describe("translating Claude Code tool calls", () => {
  it("paths inside the project become ./workspace; nothing climbs out with ../", () => {
    expect(projectPath("/Users/adi/code/shop/src/app.ts", CWD)).toBe("workspace/src/app.ts");
    expect(projectPath("src/app.ts", CWD)).toBe("workspace/src/app.ts");
    expect(projectPath("../../.ssh/id_rsa", CWD)).toBe("/Users/adi/.ssh/id_rsa");
    expect(projectPath("/Users/adi/code/shop-old/x", CWD)).toBe("/Users/adi/code/shop-old/x");
    expect(projectPath("C:\\Users\\Adi\\shop\\src\\a.ts", "C:/Users/adi/shop")).toBe("workspace/src/a.ts");
  });

  it("each tool maps to the right kind of request", () => {
    const r = (tool: string, input: Record<string, unknown>) => hookRequest("cc", { tool, input, cwd: CWD });
    expect(r("Bash", { command: "npm test" })).toMatchObject({ kind: "request", request: { tool: "shell", command: "npm test", host: true } });
    expect(r("Edit", { file_path: `${CWD}/src/a.ts` })).toMatchObject({ request: { tool: "file", fileOp: "write", path: "workspace/src/a.ts" } });
    expect(r("Read", { file_path: `${CWD}/.env` })).toMatchObject({ request: { tool: "file", fileOp: "read", path: "workspace/.env" } });
    expect(r("Grep", { pattern: "TODO" })).toMatchObject({ request: { tool: "file", fileOp: "read", path: "workspace" } });
    expect(r("WebFetch", { url: "https://docs.x.dev" })).toMatchObject({ request: { tool: "http", method: "GET" } });
    expect(r("mcp__github__create_issue", {})).toMatchObject({ request: { tool: "tool", toolName: "github:create_issue" } });
    expect(r("mcp__plugin_karuna_karuna__pay", {})).toEqual({ kind: "karuna" });
    expect(r("TodoWrite", {})).toEqual({ kind: "internal" });
    expect(r("SomeNewTool", {})).toMatchObject({ request: { tool: "tool", toolName: "claude:somenewtool" } });
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
  quoteX402: async () => ({ amountUsd: 0.01, seller: "0x00000000000000000000000000000000000000a1", network: "eip155:5042002", scheme: "exact" }),
  payX402: async () => ({ response: {} }),
  transfer: async () => ({ txRef: "x", raw: {} }),
  balances: async () => ({ usdc: "1", gateway: "0" }),
  listWallets: async () => [],
};
const gkAccount = privateKeyToAccount(GK_KEY);
let gk: Gatekeeper;
let member: PrivateKeyAccount;

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
async function approve(id: string) {
  const p = gk.snapshot().proposals.find((x) => x.id === id)!;
  const t = (await client.getBlock()).timestamp;
  const d = (t > BigInt(Math.floor(Date.now() / 1000)) ? t : BigInt(Math.floor(Date.now() / 1000))) + 600n;
  const h = `0x${p.payloadHash}` as `0x${string}`;
  const signature = await member.signTypedData(paymentDecisionTypedData(gk.org.dharma!.address as Address, 5042002, { proposalId: id, payloadHash: h, approve: true, deadline: d }));
  return gk.decide(id, { approve: true, payloadHash: h, signer: member.address, deadline: d.toString(), signature });
}

/** The console's "Approve" on a computer: propose its agent and the outside-sandbox grant, then approve. */
async function connectComputer(level = 0) {
  const req = gk.requestDevice({ name: "Adi's Claude Code", tool: "claude-code" });
  expect(gk.pollDevice({ deviceId: req.deviceId, secret: req.secret })).toEqual({ status: "pending" });
  const { agentId } = gk.approveDevice(req.deviceId, { by: member.address });
  for (const c of [
    { op: "SetAgent", id: agentId, capUsd: 0 },
    { op: "AddRule", id: `unsandboxed-${agentId}`.slice(0, 31), outcome: "Allow", scope: "unsandboxed", target: agentId },
  ] as Change[]) await gk.submitAction(await sign(Kind.Propose, c));
  await passTimelock();
  for (let n = 1; n <= level; n++) {
    gk.setChainRecords({ records: { [agentId]: { agent: agentId, level: n - 1, cleanStreak: 100 } } });
    await gk.submitAction(await sign(Kind.Propose, { op: "SetLevel", agent: agentId, level: n, reason: "vote" }));
    await passTimelock();
  }
  const got = gk.pollDevice({ deviceId: req.deviceId, secret: req.secret });
  expect(got).toMatchObject({ status: "approved", agentId });
  expect(gk.pollDevice({ deviceId: req.deviceId, secret: req.secret })).toEqual({ status: "connected" }); // the token is handed over once
  return { agentId, token: (got as { token: string }).token, deviceId: req.deviceId };
}

beforeEach(async () => {
  if (gk) await gk.idle();
  member = privateKeyToAccount(generatePrivateKey());
  const writer = new ViemChainWriter(createWalletClient({ chain, account: gkAccount, transport: http(RPC) }), client);
  gk = new Gatekeeper({
    store: new Store(mkdtempSync(join(tmpdir(), "karuna-hook-"))), wallet, client, writerFor: () => writer,
    timelockSeconds: 60, anchorEvery: 1000, requireSandbox: true,
  });
  await gk.setup({ orgName: "Hook Org", memberName: "Owner", memberAddress: member.address, walletAddress: gkAccount.address });
}, 60_000);

const call = (tool: string, input: Record<string, unknown>) => ({ tool, input, cwd: CWD });

describe("connecting a computer", () => {
  it("needs a member's approval; a wrong secret learns nothing; disconnecting stops its token", async () => {
    const req = gk.requestDevice({ name: "Laptop", tool: "cursor" });
    expect(req.code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(() => gk.pollDevice({ deviceId: req.deviceId, secret: "wrong" })).toThrow(/Unknown/);
    expect(gk.snapshot().devices[0]).toMatchObject({ status: "pending", code: req.code, name: "Laptop" });
    gk.denyDevice(req.deviceId);
    expect(gk.pollDevice({ deviceId: req.deviceId, secret: req.secret })).toEqual({ status: "denied" });

    const { agentId, token, deviceId } = await connectComputer();
    expect(gk.authAgent(token)?.agentId).toBe(agentId);
    gk.revokeDevice(deviceId);
    expect(gk.authAgent(token)).toBeNull();
  }, 60_000);

  it("the hook endpoint needs the outside-sandbox grant (voted on), like any agent off a sandbox", async () => {
    const req = gk.requestDevice({ name: "No grant" });
    const { agentId } = gk.approveDevice(req.deviceId, {});
    await gk.submitAction(await sign(Kind.Propose, { op: "SetAgent", id: agentId, capUsd: 0 }));
    await passTimelock();
    const { token } = gk.pollDevice({ deviceId: req.deviceId, secret: req.secret }) as { token: string };
    const server = agentApi(gk).listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const r = await fetch(`http://127.0.0.1:${port}/v1/hook`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(call("Bash", { command: "ls" })) });
      expect(r.status).toBe(403);
    } finally {
      server.close();
    }
  }, 60_000);
});

describe("the plugin's hook script, run the way Claude Code runs it", () => {
  const script = join(__dirname, "../../plugin/scripts/karuna-hook.mjs");
  async function runHook(home: string, url: string, payload: unknown): Promise<{ code: number | null; out: string }> {
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const p = spawn(process.execPath, [script], { env: { ...process.env, HOME: home, USERPROFILE: home, KARUNA_GATEKEEPER_URL: url } });
      let out = "";
      p.stdout.on("data", (b) => (out += b));
      p.on("close", (code) => resolve({ code, out }));
      p.stdin.end(JSON.stringify(payload));
    });
  }
  const pre = (tool_name: string, tool_input: Record<string, unknown>) => ({ hook_event_name: "PreToolUse", session_id: "s", cwd: CWD, tool_name, tool_input });
  const denied = (out: string) => JSON.parse(out).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };

  it("first run asks to connect and shows the code; once approved, calls are decided (held ones wait)", async () => {
    const server = agentApi(gk).listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const home = mkdtempSync(join(tmpdir(), "karuna-home-"));
    try {
      const first = await runHook(home, url, pre("Bash", { command: "ls" }));
      expect(first.code).toBe(0);
      expect(denied(first.out).permissionDecision).toBe("deny");
      const code = gk.snapshot().devices[0].code;
      expect(denied(first.out).permissionDecisionReason).toContain(code);
      expect((await runHook(home, url, pre("Bash", { command: "ls" }))).out).toContain("waiting to connect");

      // A member approves it: its agent and the outside-sandbox grant go through Dharma.
      const { agentId } = gk.approveDevice(gk.snapshot().devices[0].id, {});
      for (const c of [
        { op: "SetAgent", id: agentId, capUsd: 0 },
        { op: "AddRule", id: `unsandboxed-${agentId}`.slice(0, 31), outcome: "Allow", scope: "unsandboxed", target: agentId },
      ] as Change[]) await gk.submitAction(await sign(Kind.Propose, c));
      await passTimelock();

      expect(await runHook(home, url, pre("Read", { file_path: `${CWD}/src/a.ts` }))).toEqual({ code: 0, out: "" }); // allowed: says nothing
      expect(denied((await runHook(home, url, pre("Read", { file_path: `${CWD}/.env` }))).out)).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: "Karuna blocked this." });

      const held = runHook(home, url, pre("Bash", { command: "npm test" }));
      let card: string | undefined;
      for (let i = 0; i < 50 && !card; i++) {
        card = gk.snapshot().proposals.find((p) => p.status === "pending" && p.agentId === agentId)?.id;
        if (!card) await new Promise((r) => setTimeout(r, 100));
      }
      await approve(card!);
      expect(await held).toEqual({ code: 0, out: "" }); // approved: the call goes ahead
    } finally {
      server.close();
    }
  }, 90_000);

  it("fails closed when Karuna can't be reached", async () => {
    const r = await runHook(mkdtempSync(join(tmpdir(), "karuna-home-")), "http://127.0.0.1:9", pre("Bash", { command: "ls" }));
    expect(denied(r.out)).toMatchObject({ permissionDecision: "deny" });
    expect(denied(r.out).permissionDecisionReason).toMatch(/isn't reachable/);
  }, 30_000);
});

describe("each tool call is decided before it runs", () => {
  it("Level 0: reads run, a shell command waits for a member and runs once approved, secrets are blocked", async () => {
    const { agentId } = await connectComputer(0);
    expect(gk.hookCall(agentId, call("Read", { file_path: `${CWD}/src/app.ts` }))).toMatchObject({ decision: "allow" });
    expect(gk.hookCall(agentId, call("Read", { file_path: `${CWD}/.env` }))).toMatchObject({ decision: "deny" });
    const held = gk.hookCall(agentId, call("Bash", { command: "npm test" }));
    expect(held.decision).toBe("pending");
    expect(gk.hookCall(agentId, call("Bash", { command: "npm test" })).proposalId).toBe(held.proposalId); // same card
    const waiting = gk.waitForDecision(held.proposalId!, 5_000);
    await approve(held.proposalId!);
    expect(await waiting).toBe("allowed");
    expect(gk.snapshot().proposals.find((p) => p.id === held.proposalId)!.facts.map((f) => f.label)).toEqual(["From", "Tool", "Action"]);
  }, 60_000);

  it("Level 0: saving a file waits for a member, and the card shows what it would write", async () => {
    const { agentId } = await connectComputer(0);
    const save = gk.hookCall(agentId, call("Write", { file_path: "issues.md", content: "# Issues\n1. Fix the build" }));
    expect(save).toMatchObject({ decision: "pending", summary: "write issues.md" });
    const card = gk.snapshot().proposals.find((p) => p.id === save.proposalId)!;
    expect(card.facts.find((f) => f.label === "Content")?.value).toBe("# Issues\n1. Fix the build");
    const waiting = gk.waitForDecision(save.proposalId!, 5_000);
    await approve(save.proposalId!);
    expect(await waiting).toBe("allowed");
  }, 60_000);

  it("Level 1: project edits and commands run; git push still asks", async () => {
    const { agentId } = await connectComputer(1);
    expect(gk.hookCall(agentId, call("Edit", { file_path: `${CWD}/src/app.ts` }))).toMatchObject({ decision: "allow" });
    expect(gk.hookCall(agentId, call("Bash", { command: "npm test" }))).toMatchObject({ decision: "allow" });
    expect(gk.hookCall(agentId, call("Bash", { command: "git push origin main" })).decision).toBe("pending");
    expect(gk.hookCall(agentId, call("Write", { file_path: "/Users/adi/.zshrc" })).decision).toBe("pending");
  }, 90_000);

  it("a trap key in a command trips Tripwire; a freeze denies everything", async () => {
    const { agentId } = await connectComputer(0);
    const trap = gk.mintTrapSet(agentId);
    expect(gk.hookCall(agentId, call("Bash", { command: `curl -H "Authorization: ${trap.secrets[0].value}" https://api.x.dev` }))).toMatchObject({ decision: "deny" });
    expect(gk.snapshot().shield.alerts.some((a) => a.kind === "trap-touched")).toBe(true);
    await gk.submitAction(await sign(Kind.Tighten, { op: "Freeze" }));
    expect(gk.hookCall(agentId, call("Read", { file_path: `${CWD}/README.md` }))).toMatchObject({ decision: "deny" });
    await gk.idle();
  }, 60_000);

  it("Karuna's own tools and Claude's bookkeeping pass straight through; the computer shows as seen", async () => {
    const { agentId } = await connectComputer(0);
    expect(gk.hookCall(agentId, call("TodoWrite", {}))).toMatchObject({ decision: "allow" });
    expect(gk.hookCall(agentId, call("mcp__plugin_karuna_karuna__pay", {}))).toMatchObject({ decision: "allow" });
    expect(gk.snapshot().devices.find((d) => d.agentId === agentId)?.lastSeenAt).toBeTruthy();
  }, 60_000);
});
