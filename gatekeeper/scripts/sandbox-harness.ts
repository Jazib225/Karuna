// Sandbox end-to-end harness: a real Gatekeeper, egress proxy and agent API with an in-memory
// Dharma policy (no chain, no wallet), so `karuna run` can be tested without votes or USDC.
//   npx tsx scripts/sandbox-harness.ts          prints the agent token and listens on :9787
// Test-only: POST http://127.0.0.1:9799/approve/<proposalId> signs an approval as the test member.
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { paymentDecisionTypedData } from "@prekaruna/dharma";
import { Store } from "../src/store.ts";
import { Gatekeeper } from "../src/gatekeeper.ts";
import { agentApi } from "../src/server.ts";
import { SandboxCA } from "../src/ca.ts";
import { SecretStore } from "../src/secrets.ts";
import { EgressProxy } from "../src/proxy.ts";
import { remoteListener } from "../src/remote.ts";
import { PIPE_PATH, pipeServer } from "../src/pipe.ts";
import type { WalletBackend } from "../src/wallet.ts";
import type { OnchainPolicy } from "../src/chain.ts";

const AGENT_PORT = Number(process.env.HARNESS_AGENT_PORT ?? 9787);
const dataDir = mkdtempSync(join(tmpdir(), "karuna-harness-"));
const member = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // anvil #1, test only
const DHARMA = "0x00000000000000000000000000000000000d4a2a" as Address;

const store = new Store(dataDir);
store.writeJson("org.json", {
  version: 2, name: "Harness Org", wallet: { address: "0x000000000000000000000000000000000000beef", chain: "ARC-TESTNET" },
  dharma: { address: DHARMA, chainId: 5042002, deployedAt: new Date().toISOString(), txRef: "0x" },
  labels: { members: { [member.address.toLowerCase()]: "Tester" }, agents: {}, payees: {} }, agentTokens: {}, enrollments: [],
});
const secrets = new SecretStore(dataDir);
secrets.put("demo", "DEMO_API_KEY", "real-secret-123");

const fakeWallet = {
  quoteX402: async () => ({ seller: "0x000000000000000000000000000000000000c0de", amountUsd: 0.01, network: "eip155:5042002", scheme: "exact", transferMethod: "direct" }),
  payX402: async () => ({ response: { paid: true, data: "premium content" }, transaction: `0x${"ab".repeat(32)}` }),
  transfer: async () => ({ txRef: `0x${"cd".repeat(32)}`, raw: {} }),
  balances: async () => ({ usdc: "10", gateway: null }),
  listWallets: async () => [],
} as unknown as WalletBackend;

const gk = new Gatekeeper({
  store, wallet: fakeWallet, client: {} as never, writerFor: () => ({}) as never, secrets, requireSandbox: true,
  swarmAgents: 2, swarmWindowMs: 60_000,
});
const rule = (id: string, outcome: "allow" | "deny" | "approval", scope: string, target: string, agent?: string) =>
  ({ id, outcome, core: false, builtin: false, active: true, scope, target, maxUsd: 0, agent });
gk.policy = {
  address: DHARMA, chainId: 5042002, gatekeeper: DHARMA, timelock: 60, required: 1, frozen: false, thresholdUsd: 500,
  policyVersion: 1, logHead: `0x${"0".repeat(64)}` as Hex, logLength: 0, members: [member.address],
  payees: [{ account: "0x000000000000000000000000000000000000c0de", category: "data" }],
  agents: [{ id: "tester", capUsd: 5 }, { id: "tester2", capUsd: 5 }],
  domains: ["github.com", "httpbin.org", "pypi.org", "npmjs.com"],
  rules: [
    rule("key-demo", "allow", "key:demo", "httpbin.org"),
    rule("no-delay", "deny", "http", "httpbin.org/delay"),
  ],
  proposals: [], chainTime: Math.floor(Date.now() / 1000),
} as unknown as OnchainPolicy;
// Pretend the agents were proposed + voted in: issue their tokens.
(gk as unknown as { org: { agentTokens: Record<string, string>; labels: { agents: Record<string, string> } } }).org.labels.agents.tester = "Tester agent";
const t1 = gk.rotateAgentToken("tester").token;
const t2 = gk.rotateAgentToken("tester2").token;

const ca = new SandboxCA(dataDir);
const egress = new EgressProxy(gk, ca, { agentApiPort: AGENT_PORT, holdMs: Number(process.env.HARNESS_HOLD_MS ?? 20_000) });
const agentServer = agentApi(gk, { proxy: egress, caPem: ca.certPem, secrets });
agentServer.listen(AGENT_PORT, "127.0.0.1");
// S6: the remote port, as a teammate's machine would reach it (https, org CA only).
remoteListener({ gk, ca, names: ["localhost", "127.0.0.1", "host.docker.internal"], proxy: egress, agentApi: agentServer }).listen(9443, "127.0.0.1");

// Test-only control port: approve a held request as the test member; read state.
createServer(async (req, res) => {
  const m = (req.url ?? "").match(/^\/approve\/([\w-]+)$/);
  if (req.method === "POST" && m) {
    const p = (gk.snapshot().proposals as { id: string; payloadHash?: string }[]).find((x) => x.id === m[1]);
    const h = `0x${p?.payloadHash ?? "0".repeat(64)}` as Hex;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const signature = await member.signTypedData(paymentDecisionTypedData(DHARMA, 5042002, { proposalId: m[1], payloadHash: h, approve: true, deadline }));
    const r = await gk.decide(m[1], { approve: true, payloadHash: h, signer: member.address, deadline: deadline.toString(), signature });
    return void res.end(JSON.stringify(r));
  }
  if (req.url === "/state") {
    const s = gk.snapshot();
    return void res.end(JSON.stringify({ sandbox: s.sandbox, frozen: s.frozen, tainted: s.swarm.tainted, proposals: (s.proposals as { id: string; status: string; decision: { ruleId: string }; request: { url?: string; method?: string } }[]).slice(0, 15).map((p) => ({ id: p.id, status: p.status, rule: p.decision.ruleId, req: `${p.request.method ?? ""} ${p.request.url ?? ""}` })) }));
  }
  if (req.method === "POST" && req.url === "/freeze") {
    (gk.policy as { frozen: boolean }).frozen = true;
    return void res.end("{}");
  }
  if (req.method === "POST" && req.url === "/trap") {
    const t = gk.mintTrapSet("tester");
    gk.postMessage({ agentId: "tester", from: "IT helpdesk", subject: "creds", body: t.envFile });
    return void res.end(JSON.stringify(t));
  }
  res.writeHead(404).end();
}).listen(9799, "127.0.0.1");

if (process.env.HARNESS_PIPE) pipeServer(gk).listen(PIPE_PATH);
console.log(JSON.stringify({ member: member.address, caFile: join(dataDir, "sandbox-ca", "ca.cert.pem"), remote: "https://127.0.0.1:9443", dataDir, agentApi: `http://127.0.0.1:${AGENT_PORT}`, tokens: { tester: t1, tester2: t2 } }));
