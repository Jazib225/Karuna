// Start the Gatekeeper. Data lives in KARUNA_DATA_DIR (default gatekeeper/data).
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.ts";
import { CircleCliWallet } from "./wallet.ts";
import { Gatekeeper } from "./gatekeeper.ts";
import { agentApi, consoleApi } from "./server.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env"), quiet: true });

const dataDir = resolve(process.env.KARUNA_DATA_DIR ?? resolve(here, "../data"));
const agentPort = Number(process.env.KARUNA_AGENT_PORT ?? 8787);
const consolePort = Number(process.env.KARUNA_CONSOLE_PORT ?? 8788);
const agentHost = process.env.KARUNA_AGENT_HOST ?? "127.0.0.1";

const store = new Store(dataDir);
const wallet = new CircleCliWallet();
const gk = new Gatekeeper(store, wallet);
const consoleToken = store.loadOrCreateConsoleToken();

agentApi(gk).listen(agentPort, agentHost, () => console.log(`gatekeeper · agent API    http://${agentHost}:${agentPort}`));
consoleApi(gk, wallet, consoleToken).listen(consolePort, "127.0.0.1", () =>
  console.log(`gatekeeper · console API  http://127.0.0.1:${consolePort}  (data: ${dataDir})`),
);
const v = gk.log.verify();
console.log(`gatekeeper · signed log   ${gk.log.length} entries · ${v.ok ? "verified" : `TAMPERED at ${v.brokenAt}`}`);
