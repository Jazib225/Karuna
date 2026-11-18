// `karuna run` arguments. Kept separate (and pure) so it can be tested without Docker.

export interface Mount {
  host: string;
  container: string;
  writable: boolean;
}

export interface RunArgs {
  agent: string;
  gatekeeper: string;
  token: string;
  image?: string;
  dir?: string;
  mounts: Mount[];
  command: string[];
  memory: string;
  cpus: string;
  ca?: string; // org sandbox CA (PEM file) for a remote https:// Gatekeeper
  isolation: "auto" | "gvisor" | "docker";
  desktop: boolean;
}

export const USAGE = `karuna run --agent <id> [options] [DIR] -- <command…>

Runs an agent in a Karuna sandbox: no network except Karuna's egress proxy, no host files except
the folders you mount, no real keys (placeholders the proxy swaps), wiped when it exits.

  --agent <id>          the agent's id on Dharma (required)
  --token <kag_…>       the agent's token (default: $KARUNA_AGENT_TOKEN)
  --gatekeeper <url>    agent API (default: $KARUNA_GATEKEEPER_URL or http://127.0.0.1:8787)
  --image <image>       run this image instead of building DIR
  --mount <host[:container][:rw]>
                        share a host folder (read-only unless :rw, which needs a Dharma "mount" rule)
  --desktop             give the box a virtual screen + browser (computer-use agents); you can watch it
  --isolation <auto|gvisor|docker>
                        gVisor (runsc) when Docker has it; auto falls back to hardened Docker
  --ca <file>           the org's sandbox CA, for a Gatekeeper on another machine (https://)
  --memory <2g>  --cpus <2>

Undo an agent's file changes (writable mounts are copied before each run and kept 14 days)
  karuna changes --run <runId>
                        what the run added, modified or deleted, as JSON
  karuna undo --run <runId> [--path <file>] [--force]
                        put the whole run back, or one file (its full host path); a file that
                        changed again after the run is refused unless --force

Examples
  karuna run --agent invoice-bot ./invoice-bot -- python main.py
  karuna run --agent supplies --mount ./reports:/data ./agents -- npx tsx examples/supplies-agent.ts
  karuna run --agent browser-bot --desktop ./bot -- python main.py
  karuna run --agent bot --gatekeeper https://gk.office.lan:8443 --ca karuna-ca.pem ./bot -- python main.py`;

/** Split "C:\\data:/data:rw" style specs; Windows drive letters are part of the host path. */
export function parseMount(spec: string): Mount {
  let rest = spec;
  let writable = false;
  if (/:rw$/i.test(rest)) {
    writable = true;
    rest = rest.slice(0, -3);
  } else if (/:ro$/i.test(rest)) {
    rest = rest.slice(0, -3);
  }
  // A container path is the part after the last ":" that starts with "/".
  const m = rest.match(/^(.*):(\/[^:]*)$/);
  const host = m ? m[1] : rest;
  const container = m ? m[2] : `/mnt/${host.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "data"}`;
  if (!host) throw new Error(`Bad --mount "${spec}"`);
  if (!container.startsWith("/") || container === "/" || /^\/(app|etc|proc|sys|dev|usr|bin|lib)(\/|$)/.test(container)) {
    throw new Error(`--mount: can't mount over ${container}`);
  }
  return { host, container, writable };
}

export function parseArgs(argv: string[], env: Record<string, string | undefined>): RunArgs {
  const dash = argv.indexOf("--");
  const opts = dash === -1 ? argv : argv.slice(0, dash);
  const command = dash === -1 ? [] : argv.slice(dash + 1);
  const out: RunArgs = {
    agent: "", gatekeeper: env.KARUNA_GATEKEEPER_URL ?? "http://127.0.0.1:8787", token: env.KARUNA_AGENT_TOKEN ?? "",
    mounts: [], command, memory: "2g", cpus: "2", ca: env.KARUNA_CA_FILE, isolation: "auto", desktop: false,
  };
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i];
    const next = () => {
      const v = opts[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--agent") out.agent = next();
    else if (a === "--token") out.token = next();
    else if (a === "--gatekeeper") out.gatekeeper = next();
    else if (a === "--image") out.image = next();
    else if (a === "--mount") out.mounts.push(parseMount(next()));
    else if (a === "--memory") out.memory = next();
    else if (a === "--cpus") out.cpus = next();
    else if (a === "--ca") out.ca = next();
    else if (a === "--desktop") out.desktop = true;
    else if (a === "--isolation") {
      const v = next();
      if (v !== "auto" && v !== "gvisor" && v !== "docker") throw new Error("--isolation: auto, gvisor or docker");
      out.isolation = v;
    }
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
    else if (!out.dir) out.dir = a;
    else throw new Error(`Unexpected argument ${a} (put the agent's command after --)`);
  }
  if (!out.agent) throw new Error("--agent is required");
  if (!/^[\w-]{1,40}$/.test(out.agent)) throw new Error("--agent: letters, digits, - and _ only");
  if (!out.token) throw new Error("No agent token: pass --token or set KARUNA_AGENT_TOKEN");
  if (!out.image && !out.dir) throw new Error("Give the agent's folder (DIR) or --image");
  if (!out.command.length && !out.image) throw new Error("Give the agent's start command after --");
  const gk = new URL(out.gatekeeper);
  const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(gk.hostname);
  if (gk.protocol === "http:" && !local) throw new Error("A Gatekeeper on another machine must be reached over https:// (its remote port)");
  if (gk.protocol === "https:" && !out.ca) throw new Error("--ca <karuna-ca.pem> is required for an https:// Gatekeeper (download it from the console)");
  return out;
}

export interface UndoArgs {
  run: string;
  path?: string;
  force: boolean;
}

/** `karuna changes --run <id>` and `karuna undo --run <id> [--path <file>] [--force]`. */
export function parseUndoArgs(cmd: "changes" | "undo", argv: string[]): UndoArgs {
  const out: UndoArgs = { run: "", force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--run") out.run = next();
    else if (cmd === "undo" && a === "--path") out.path = next();
    else if (cmd === "undo" && a === "--force") out.force = true;
    else throw new Error(`Unknown option for karuna ${cmd}: ${a}`);
  }
  if (!out.run) throw new Error("--run <runId> is required");
  if (!/^[\w.-]{1,80}$/.test(out.run) || /^\.+$/.test(out.run)) throw new Error("--run: not a run id");
  return out;
}
