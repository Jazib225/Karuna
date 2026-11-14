#!/usr/bin/env -S npx tsx
// karuna run: put an agent in a box whose only way out is the Karuna Gatekeeper.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { USAGE, parseArgs, type RunArgs } from "./args.ts";
import { scanForSecrets } from "./scan.ts";
import {
  DESKTOP_BASE_DOCKERFILE, DESKTOP_BASE_TAG, DESKTOP_BROWSER, DESKTOP_ENTRY,
  REMOTE_RELAY_DOCKERFILE, REMOTE_RELAY_JS, REMOTE_RELAY_TAG,
} from "./images.ts";

const say = (s: string) => process.stderr.write(`karuna · ${s}\n`);

function docker(args: string[], quiet = true) {
  const r = spawnSync("docker", args, { encoding: "utf8", stdio: quiet ? "pipe" : "inherit", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
  return (r.stdout ?? "").trim();
}
const imageExists = (tag: string) => spawnSync("docker", ["image", "inspect", tag], { stdio: "ignore" }).status === 0;

/** Agent API call. A remote (https) Gatekeeper is trusted only through the org's sandbox CA. */
function api(a: RunArgs, path: string, token: string, method = "POST", body?: unknown): Promise<Record<string, unknown>> {
  const url = new URL(path, a.gatekeeper);
  const data = body === undefined ? undefined : JSON.stringify(body);
  const ca = url.protocol === "https:" ? readFileSync(a.ca!, "utf8") : undefined;
  return new Promise((done, fail) => {
    const fn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const r = fn(url, { method, ca, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(data ? { "content-length": String(Buffer.byteLength(data)) } : {}) }, timeout: 30_000 }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(text);
        } catch {
          /* empty */
        }
        if ((res.statusCode ?? 500) >= 400) fail(new Error(String(json.error ?? `Gatekeeper returned ${res.statusCode}`)));
        else done(json);
      });
    });
    r.on("timeout", () => r.destroy(new Error("Gatekeeper did not answer")));
    r.on("error", fail);
    r.end(data);
  });
}

/** gVisor when Docker has it (a user-space kernel between the agent and the host kernel). */
function pickIsolation(want: RunArgs["isolation"]): "gvisor" | "docker" {
  const runtimes = spawnSync("docker", ["info", "--format", "{{json .Runtimes}}"], { encoding: "utf8" }).stdout ?? "";
  const hasGvisor = /"runsc"/.test(runtimes);
  if (want === "gvisor" && !hasGvisor) throw new Error("--isolation gvisor: Docker has no runsc runtime. Install gVisor (https://gvisor.dev/docs/user_guide/install/) or use --isolation docker.");
  if (want === "docker") return "docker";
  return hasGvisor ? "gvisor" : "docker";
}

/** Build DIR on a Karuna base image, never copying .env files, keys or node_modules. */
function buildImage(dir: string, agent: string, tmp: string, desktop: boolean): string {
  const has = (f: string) => existsSync(join(dir, f));
  const node = has("package.json");
  const python = has("requirements.txt") || has("pyproject.toml") || has("main.py");
  if (!node && !python) throw new Error(`Can't tell how to build ${dir} (no package.json, requirements.txt or pyproject.toml). Use --image.`);
  const install = node
    ? "RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi"
    : "RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; elif [ -f pyproject.toml ]; then pip install --no-cache-dir .; fi";
  let base: string;
  if (desktop) {
    if (!imageExists(DESKTOP_BASE_TAG)) {
      say(`building the desktop base image (${DESKTOP_BASE_TAG}, once; a few minutes)`);
      const d = join(tmp, "desktop");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "Dockerfile"), DESKTOP_BASE_DOCKERFILE);
      writeFileSync(join(d, "karuna-desktop"), DESKTOP_ENTRY.replace(/\r\n/g, "\n"));
      writeFileSync(join(d, "karuna-browser"), DESKTOP_BROWSER.replace(/\r\n/g, "\n"));
      docker(["build", "-q", "-t", DESKTOP_BASE_TAG, d]);
    }
    base = DESKTOP_BASE_TAG;
  } else {
    base = node ? "node:24-slim" : "python:3.12-slim";
  }
  const df = `FROM ${base}\nWORKDIR /app\nCOPY . .\n${install}\nUSER 10001:10001`;
  const file = join(tmp, "Dockerfile");
  writeFileSync(file, df);
  writeFileSync(`${file}.dockerignore`, ["node_modules", ".git", ".venv", "venv", "__pycache__", ".env", ".env.*", "!.env.example", "*.pem", "*.key"].join("\n"));
  const tag = `karuna-agent-${agent.toLowerCase()}${desktop ? "-desktop" : ""}:latest`;
  say(`building ${tag} from ${dir}`);
  docker(["build", "-q", "-t", tag, "-f", file, dir]);
  return tag;
}

function ensureRemoteRelayImage(tmp: string) {
  if (imageExists(REMOTE_RELAY_TAG)) return;
  const d = join(tmp, "relay");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "Dockerfile"), REMOTE_RELAY_DOCKERFILE);
  writeFileSync(join(d, "relay.mjs"), REMOTE_RELAY_JS);
  docker(["build", "-q", "-t", REMOTE_RELAY_TAG, d]);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "run") {
    process.stderr.write(`${USAGE}\n`);
    process.exit(cmd ? 2 : 0);
  }
  let a: RunArgs;
  try {
    a = parseArgs(rest, process.env);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  const gkUrl = new URL(a.gatekeeper);
  const remote = gkUrl.protocol === "https:";
  // From inside Docker, "this machine" is host.docker.internal.
  const relayHost = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(gkUrl.hostname) ? "host.docker.internal" : gkUrl.hostname;

  const dir = a.dir ? resolve(a.dir) : undefined;
  if (dir) {
    const found = scanForSecrets(dir);
    if (found.length) {
      for (const f of found.slice(0, 10)) say(`real key in ${f.file}: ${f.what}`);
      throw new Error("Refusing to box a folder that contains real keys. Move them into Karuna (Keys page) and use the placeholder variable instead.");
    }
  }
  const isolation = pickIsolation(a.isolation);

  const tmp = mkdtempSync(join(tmpdir(), "karuna-run-"));
  // Build first: a run session starts only once the box is ready to start (sessions expire when idle).
  let image: string;
  try {
    image = a.image ?? buildImage(dir!, a.agent, tmp, a.desktop);
    if (remote) ensureRemoteRelayImage(tmp);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  const sess = await api(a, "/v1/sessions", a.token, "POST", {
    host: hostname(), mounts: a.mounts.filter((m) => m.writable).map((m) => resolve(m.host)), isolation, desktop: a.desktop, remote,
  });
  const session = String(sess.session);
  const id = String(sess.id);
  const net = `karuna-run-${id}`;
  const relay = `karuna-relay-${id}`;
  const box = `karuna-box-${id}`;
  let stopping = false;
  let beat: NodeJS.Timeout | undefined;
  let viewer: string | null = null;

  const cleanup = async () => {
    if (beat) clearInterval(beat);
    spawnSync("docker", ["rm", "-f", box, relay], { stdio: "ignore" });
    spawnSync("docker", ["network", "rm", net], { stdio: "ignore" });
    await api(a, "/v1/sessions", session, "DELETE").catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
  };

  try {
    const writable = new Set((sess.writableMounts as string[]) ?? []);
    for (const m of a.mounts) {
      if (m.writable && !writable.has(resolve(m.host))) throw new Error(`Writable mount ${m.host} isn't allowed on Dharma (needs a "mount" rule vote). Mount it read-only instead.`);
    }
    const caFile = join(tmp, "karuna-ca.pem");
    writeFileSync(caFile, String(sess.caPem));

    // No route anywhere. The relay is the box's one neighbor and forwards one port to this run's proxy
    // (plus, for a desktop box, the viewer port from 127.0.0.1 on this machine to the box).
    docker(["network", "create", "--internal", net]);
    const view = a.desktop ? ["-p", "127.0.0.1::6080"] : [];
    if (remote) {
      docker(["run", "-d", "--name", relay, "--restart", "no", ...view,
        "-e", `GK_HOST=${relayHost}`, "-e", `GK_PORT=${gkUrl.port || 443}`, "-e", `SESSION=${session}`,
        "-e", `CA_B64=${Buffer.from(String(sess.caPem)).toString("base64")}`, ...(a.desktop ? ["-e", `VIEW_TARGET=${box}:6080`] : []),
        REMOTE_RELAY_TAG]);
    } else {
      const fwd = `socat tcp-listen:3128,fork,reuseaddr tcp-connect:${relayHost}:${sess.proxyPort}`;
      const sh = a.desktop ? `${fwd} & exec socat tcp-listen:6080,fork,reuseaddr tcp-connect:${box}:6080` : `exec ${fwd}`;
      docker(["run", "-d", "--name", relay, "--restart", "no", ...view, "--entrypoint", "sh", "alpine/socat", "-c", sh]);
    }
    docker(["network", "connect", "--alias", "karuna-egress", net, relay]);
    if (a.desktop) {
      const port = docker(["port", relay, "6080/tcp"]).split("\n")[0].split(":").pop();
      viewer = `http://127.0.0.1:${port}/vnc.html?autoconnect=1&resize=scale`;
    }

    const proxy = "http://karuna-egress:3128";
    const env: Record<string, string> = {
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, ALL_PROXY: proxy, NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1",
      NODE_USE_ENV_PROXY: "1",
      SSL_CERT_FILE: "/etc/karuna/ca.pem", REQUESTS_CA_BUNDLE: "/etc/karuna/ca.pem", NODE_EXTRA_CA_CERTS: "/etc/karuna/ca.pem", CURL_CA_BUNDLE: "/etc/karuna/ca.pem", PIP_CERT: "/etc/karuna/ca.pem",
      KARUNA_GATEKEEPER_URL: "http://karuna.internal", KARUNA_AGENT_TOKEN: session, KARUNA_SANDBOX: "1", HOME: "/tmp",
      ...(a.desktop ? { KARUNA_BROWSER: "/usr/local/bin/karuna-browser" } : {}),
      ...(sess.env as Record<string, string>),
    };
    const args = [
      "run", "--rm", "--init", "--name", box, "--network", net, "--hostname", "sandbox",
      ...(isolation === "gvisor" ? ["--runtime", "runsc"] : []),
      "--read-only", "--tmpfs", "/tmp:rw,exec,size=1g", "--tmpfs", "/workspace:rw,size=1g",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", a.desktop ? "1024" : "256",
      ...(a.desktop ? ["--shm-size", "512m"] : []),
      "--memory", a.memory, "--cpus", a.cpus, "--user", "10001:10001",
      "-v", `${caFile}:/etc/karuna/ca.pem:ro`, "-v", `${caFile}:/etc/ssl/certs/ca-certificates.crt:ro`,
      ...a.mounts.flatMap((m) => ["-v", `${resolve(m.host)}:${m.container}:${m.writable ? "rw" : "ro"}`]),
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      image, ...a.command,
    ];
    say(`run ${id}: ${a.agent} is in the box · isolation ${isolation}${isolation === "docker" ? " (install gVisor for a stronger wall)" : ""} · ${remote ? `remote Gatekeeper ${gkUrl.host}` : "local Gatekeeper"} · ${a.mounts.length} mount${a.mounts.length === 1 ? "" : "s"}`);
    if (viewer) say(`watch the desktop: ${viewer}`);

    beat = setInterval(async () => {
      try {
        const h = await api(a, "/v1/sessions/heartbeat", session, "POST", { viewer });
        if (h.stop && !stopping) {
          stopping = true;
          say(`stopping: ${h.reason}`);
          spawnSync("docker", ["kill", box], { stdio: "ignore" });
        }
      } catch (e) {
        // Unreachable: the box can't get out either, so retry. Session unknown: it's over, stop.
        if (/Unknown agent token|session/i.test((e as Error).message) && !stopping) {
          stopping = true;
          say("stopping: the Gatekeeper ended this run");
          spawnSync("docker", ["kill", box], { stdio: "ignore" });
        }
      }
    }, 5000);

    const code = await new Promise<number>((done) => {
      const p = spawn("docker", args, { stdio: "inherit" });
      p.on("exit", (c) => done(c ?? 1));
      const stop = () => spawnSync("docker", ["kill", box], { stdio: "ignore" });
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    say(`run ${id} ended (exit ${code}); box, network and relay removed`);
    await cleanup();
    process.exit(code);
  } catch (e) {
    await cleanup();
    throw e;
  }
}

main().catch((e) => {
  process.stderr.write(`karuna · ${(e as Error).message}\n`);
  process.exit(1);
});
