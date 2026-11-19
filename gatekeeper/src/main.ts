// Start the Gatekeeper. Data lives in KARUNA_DATA_DIR (default gatekeeper/data).
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, formatEther, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { Store } from "./store.ts";
import { CircleCliWallet } from "./wallet.ts";
import { Gatekeeper } from "./gatekeeper.ts";
import { agentApi, consoleApi } from "./server.ts";
import { Voice, voiceConfigFromEnv } from "./voice.ts";
import { publicApi } from "./chat.ts";
import { Accounts } from "./accounts.ts";
import { CircleChainWriter, RelayedChainWriter, ViemChainWriter, publicClient, scrub } from "./chain.ts";
import { ViemEscrow } from "./escrow.ts";
import { runnerUndo } from "./undo.ts";
import { SandboxCA } from "./ca.ts";
import { SecretStore } from "./secrets.ts";
import { EgressProxy } from "./proxy.ts";
import { remoteListener } from "./remote.ts";
import { PIPE_PATH, pipeServer } from "./pipe.ts";
import { hostname } from "node:os";
import { spawn, spawnSync } from "node:child_process";

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
// KARUNA_RELAYER_KEY: a plain key (holding only test USDC for gas) that delivers member-signed
// Dharma writes in about a second instead of through the Circle wallet. It can't change anything
// members didn't sign; Dharma checks their signatures. Without it, every write uses the Circle wallet.
const relayKey = process.env.KARUNA_RELAYER_KEY?.trim();
const relayWallet = relayKey && /^0x[0-9a-fA-F]{64}$/.test(relayKey)
  ? createWalletClient({ account: privateKeyToAccount(relayKey as Hex), chain: arcTestnet, transport: http(process.env.ARC_RPC_URL || undefined, { retryCount: 3 }) })
  : null;
const relay = relayWallet ? new ViemChainWriter(relayWallet, client) : null;
const gk = new Gatekeeper({
  store,
  wallet,
  client,
  writerFor: (address: Address) => {
    const circle = new CircleChainWriter(address, client);
    return relay ? new RelayedChainWriter(circle, relay, (e) => console.error(`gatekeeper · relayer failed, used the Circle wallet: ${scrub(e)}`)) : circle;
  },
  // The same relayer opens and releases escrow holds for large payments (and relays members' cancels).
  ...(relayWallet ? { escrow: new ViemEscrow(relayWallet, client) } : {}),
  timelockSeconds: Number(process.env.KARUNA_TIMELOCK_SECONDS ?? 60),
  chatUrl: process.env.KARUNA_CHAT_URL || undefined,
  coreTimelockSeconds: Number(process.env.KARUNA_CORE_TIMELOCK_SECONDS ?? 86_400),
  anchorEvery: Number(process.env.KARUNA_ANCHOR_EVERY ?? 20),
  shieldTestsPerDay: Number(process.env.KARUNA_SHIELD_TESTS_PER_DAY ?? 2),
  shieldWindowMs: Number(process.env.KARUNA_SHIELD_WINDOW_MINUTES ?? 30) * 60_000,
  preflightWindowMs: Number(process.env.KARUNA_PREFLIGHT_MINUTES ?? 2) * 60_000,
  preflight: process.env.KARUNA_PREFLIGHT !== "0",
  swarmAgents: Number(process.env.KARUNA_SWARM_AGENTS ?? 2),
  swarmWindowMs: Number(process.env.KARUNA_SWARM_WINDOW_SECONDS ?? 60) * 1000,
  secrets,
  // Agents run in Karuna sandboxes; an agent token used anywhere else is refused unless voted.
  requireSandbox: (process.env.KARUNA_REQUIRE_SANDBOX ?? "1") !== "0",
  requireIsolation: process.env.KARUNA_REQUIRE_ISOLATION === "gvisor" ? "gvisor" : "docker",
  // The console offers "Require gVisor" only where gVisor is installed (the same check `karuna run` makes).
  gvisorAvailable: /"runsc"/.test(spawnSync("docker", ["info", "--format", "{{json .Runtimes}}"], { encoding: "utf8", timeout: 10_000, windowsHide: true }).stdout ?? ""),
  // Agents Karuna builds and runs: each run is a normal `karuna run` of the hosted runner, with a
  // token issued for that run only. Docker must be running on this machine.
  launcher: ({ agentId, token, runId, onOutput, onExit }) => {
    const root = resolve(here, "../..");
    const win = process.platform === "win32";
    const args = ["tsx", resolve(root, "runner/src/cli.ts"), "run", "--agent", agentId, "--gatekeeper", `http://127.0.0.1:${agentPort}`, resolve(root, "agents"), "--", "npx", "tsx", "hosted/run.ts"];
    const p = spawn(win ? "npx.cmd" : "npx", args, {
      env: { ...process.env, KARUNA_AGENT_TOKEN: token, KARUNA_RUN_ID: runId },
      shell: win, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    });
    // The box's own output reaches the run through `karuna run`; here, only Karuna's own lines.
    let buf = "";
    p.stderr!.on("data", (b: Buffer) => {
      const parts = (buf + b.toString("utf8")).split(/\r?\n/);
      buf = parts.pop() ?? "";
      for (const l of parts) if (/^karuna · /.test(l)) onOutput(`Karuna: ${l.slice("karuna · ".length)}`);
    });
    p.on("exit", (code) => onExit(code ?? 1));
    p.on("error", (e) => {
      onOutput(`Karuna: couldn't start the run (${e.message})`);
      onExit(1);
    });
    return () => p.kill();
  },
  // Undo a run's file changes from its snapshot on this machine (runs started here, by `karuna run`).
  undo: runnerUndo(resolve(here, "../..")),
});
gk.holdMs = Number(process.env.KARUNA_HOLD_SECONDS ?? 120) * 1000;
const ca = new SandboxCA(dataDir);
const egress = new EgressProxy(gk, ca, { agentApiPort: agentPort }); // waits gk.holdMs: the Approval hold setting
const consoleToken = store.loadOrCreateConsoleToken();

const agentServer = agentApi(gk, { proxy: egress, caPem: ca.certPem, secrets });
agentServer.listen(agentPort, agentHost, () => console.log(`gatekeeper · agent API    http://${agentHost}:${agentPort}`));
const voice = new Voice(voiceConfigFromEnv());
consoleApi(gk, wallet, consoleToken, secrets, ca.certPem, new Accounts(store), voice).listen(consolePort, "127.0.0.1", () =>
  console.log(`gatekeeper · console API  http://127.0.0.1:${consolePort}  (data: ${dataDir})`),
);
{
  const v = voice.status();
  console.log(`gatekeeper · voice        ${v.configured ? `ElevenLabs · conversation ${v.conversation ? "on" : "off (no ELEVENLABS_AGENT_ID)"} · spoken alerts ${v.alerts ? "on" : "off (no ELEVENLABS_VOICE_ID)"}` : "off (no ELEVENLABS_API_KEY)"}`);
}
console.log(`gatekeeper · sandbox      egress proxy per run on 127.0.0.1 · sandbox ${gk.requireSandbox ? "required" : "optional"} · ${secrets.list().length} key(s)`);
if (relay) {
  void client.getBalance({ address: relay.from }).then(
    (b) => console.log(`gatekeeper · relayer      ${relay.from} delivers members' proposals, votes and executions (~1s) · ${formatEther(b)} USDC for gas${b < 10n ** 17n ? " · LOW: top it up" : ""}`),
    () => console.log(`gatekeeper · relayer      ${relay.from} delivers members' proposals, votes and executions (~1s)`),
  );
} else if (relayKey) {
  console.error("gatekeeper · relayer      KARUNA_RELAYER_KEY isn't a 0x… private key; every write uses the Circle wallet");
}
// S6: boxes on other machines. Off unless a port is set; bind 0.0.0.0 (or a LAN/VPN IP) to expose it.
const remotePort = Number(process.env.KARUNA_REMOTE_PORT ?? 0);
if (remotePort) {
  const remoteHost = process.env.KARUNA_REMOTE_HOST ?? "127.0.0.1";
  const names = ["localhost", "127.0.0.1", "host.docker.internal", hostname(), ...(process.env.KARUNA_PUBLIC_HOSTS ?? "").split(",").map((x) => x.trim()).filter(Boolean)];
  gk.remote = { port: remotePort, host: remoteHost, names };
  remoteListener({ gk, ca, names, proxy: egress, agentApi: agentServer }).listen(remotePort, remoteHost, () =>
    console.log(`gatekeeper · remote port  https://${remoteHost}:${remotePort} for karuna run on other machines (names: ${names.join(", ")})`),
  );
}
// Chat apps (claude.ai, Claude Desktop, ChatGPT): Karuna's MCP endpoint and its sign-in, on their
// own port. Bound to 127.0.0.1 and reached through a tunnel (cloudflared → this port).
const publicPort = Number(process.env.KARUNA_PUBLIC_PORT ?? 8792);
if (publicPort) {
  publicApi(gk, store).listen(publicPort, "127.0.0.1", () =>
    console.log(`gatekeeper · chat apps    http://127.0.0.1:${publicPort}/mcp (MCP + sign-in; expose it with a tunnel)`),
  );
}
// Local event pipe for the desktop app (island). Approvals over it still need a member signature.
pipeServer(gk)
  .on("error", (e) => console.error(`gatekeeper · pipe         ${PIPE_PATH} unavailable: ${e.message}`))
  .listen(PIPE_PATH, () => console.log(`gatekeeper · pipe         ${PIPE_PATH} (desktop app events)`));
const v = gk.log.verify();
console.log(`gatekeeper · signed log   ${gk.log.length} entries · ${v.ok ? "verified" : `TAMPERED at ${v.brokenAt}`}`);
await gk.start();
console.log(gk.org.dharma ? `gatekeeper · Dharma       ${gk.org.dharma.address} (policy v${gk.policy?.policyVersion ?? "?"})` : "gatekeeper · Dharma       not deployed yet — finish setup in the console");
