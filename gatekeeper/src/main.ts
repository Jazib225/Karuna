// Start the Gatekeeper. Data lives in KARUNA_DATA_DIR (default gatekeeper/data).
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import { Store } from "./store.ts";
import { CircleCliWallet } from "./wallet.ts";
import { Gatekeeper } from "./gatekeeper.ts";
import { agentApi, consoleApi } from "./server.ts";
import { CircleChainWriter, publicClient } from "./chain.ts";
import { SandboxCA } from "./ca.ts";
import { SecretStore } from "./secrets.ts";
import { EgressProxy } from "./proxy.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env"), quiet: true });

const dataDir = resolve(process.env.KARUNA_DATA_DIR ?? resolve(here, "../data"));
const agentPort = Number(process.env.KARUNA_AGENT_PORT ?? 8787);
const consolePort = Number(process.env.KARUNA_CONSOLE_PORT ?? 8788);
const agentHost = process.env.KARUNA_AGENT_HOST ?? "127.0.0.1";

const store = new Store(dataDir);
const secrets = new SecretStore(dataDir);
const wallet = new CircleCliWallet();
const client = publicClient(process.env.ARC_RPC_URL);
const gk = new Gatekeeper({
  store,
  wallet,
  client,
  writerFor: (address: Address) => new CircleChainWriter(address, client),
  timelockSeconds: Number(process.env.KARUNA_TIMELOCK_SECONDS ?? 60),
  anchorEvery: Number(process.env.KARUNA_ANCHOR_EVERY ?? 20),
  shieldTestsPerDay: Number(process.env.KARUNA_SHIELD_TESTS_PER_DAY ?? 2),
  shieldWindowMs: Number(process.env.KARUNA_SHIELD_WINDOW_MINUTES ?? 30) * 60_000,
  swarmAgents: Number(process.env.KARUNA_SWARM_AGENTS ?? 2),
  swarmWindowMs: Number(process.env.KARUNA_SWARM_WINDOW_SECONDS ?? 60) * 1000,
  secrets,
  // Agents run in Karuna sandboxes; an agent token used anywhere else is refused unless voted.
  requireSandbox: (process.env.KARUNA_REQUIRE_SANDBOX ?? "1") !== "0",
});
const ca = new SandboxCA(dataDir);
const egress = new EgressProxy(gk, ca, { agentApiPort: agentPort, holdMs: Number(process.env.KARUNA_HOLD_SECONDS ?? 120) * 1000 });
const consoleToken = store.loadOrCreateConsoleToken();

agentApi(gk, { proxy: egress, caPem: ca.certPem, secrets }).listen(agentPort, agentHost, () => console.log(`gatekeeper · agent API    http://${agentHost}:${agentPort}`));
consoleApi(gk, wallet, consoleToken, secrets).listen(consolePort, "127.0.0.1", () =>
  console.log(`gatekeeper · console API  http://127.0.0.1:${consolePort}  (data: ${dataDir})`),
);
console.log(`gatekeeper · sandbox      egress proxy per run on 127.0.0.1 · sandbox ${gk.requireSandbox ? "required" : "optional"} · ${secrets.list().length} key(s)`);
const v = gk.log.verify();
console.log(`gatekeeper · signed log   ${gk.log.length} entries · ${v.ok ? "verified" : `TAMPERED at ${v.brokenAt}`}`);
await gk.start();
console.log(gk.org.dharma ? `gatekeeper · Dharma       ${gk.org.dharma.address} (policy v${gk.policy?.policyVersion ?? "?"})` : "gatekeeper · Dharma       not deployed yet — finish setup in the console");
