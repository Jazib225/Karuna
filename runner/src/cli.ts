#!/usr/bin/env -S npx tsx
// karuna run: put an agent in a box whose only way out is the Karuna Gatekeeper.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { USAGE, parseArgs, type RunArgs } from "./args.ts";
import { scanForSecrets } from "./scan.ts";

const say = (s: string) => process.stderr.write(`karuna · ${s}\n`);

function docker(args: string[], quiet = true) {
  const r = spawnSync("docker", args, { encoding: "utf8", stdio: quiet ? "pipe" : "inherit" });
  if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" ")}`);
  return (r.stdout ?? "").trim();
}

async function api(a: RunArgs, path: string, token: string, method = "POST", body?: unknown) {
  const res = await fetch(new URL(path, a.gatekeeper), {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error ?? `Gatekeeper returned ${res.status}`));
  return data;
}

/** Build DIR on a Karuna base image (Node or Python), never copying .env files or node_modules. */
function buildImage(dir: string, agent: string, tmp: string): string {
  const has = (f: string) => existsSync(join(dir, f));
  let df: string;
  if (has("package.json")) {
    df = `FROM node:24-slim
WORKDIR /app
COPY . .
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
USER 10001:10001`;
  } else if (has("requirements.txt") || has("pyproject.toml") || has("main.py")) {
    df = `FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; elif [ -f pyproject.toml ]; then pip install --no-cache-dir .; fi
USER 10001:10001`;
  } else {
    throw new Error(`Can't tell how to build ${dir} (no package.json, requirements.txt or pyproject.toml). Use --image.`);
  }
  const file = join(tmp, "Dockerfile");
  writeFileSync(file, df);
  writeFileSync(`${file}.dockerignore`, ["node_modules", ".git", ".venv", "venv", "__pycache__", ".env", ".env.*", "!.env.example", "*.pem"].join("\n"));
  const tag = `karuna-agent-${agent.toLowerCase()}:latest`;
  say(`building ${tag} from ${dir}`);
  docker(["build", "-q", "-t", tag, "-f", file, dir]);
  return tag;
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
  const gkHost = new URL(a.gatekeeper).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(gkHost)) throw new Error("Remote Gatekeepers aren't supported yet (plan phase S6). Run the Gatekeeper on this machine.");

  const dir = a.dir ? resolve(a.dir) : undefined;
  if (dir) {
    const found = scanForSecrets(dir);
    if (found.length) {
      for (const f of found.slice(0, 10)) say(`real key in ${f.file}: ${f.what}`);
      throw new Error("Refusing to box a folder that contains real keys. Move them into Karuna (Keys page) and use the placeholder variable instead.");
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), "karuna-run-"));
  const sess = await api(a, "/v1/sessions", a.token, "POST", { host: hostname(), mounts: a.mounts.filter((m) => m.writable).map((m) => resolve(m.host)) });
  const session = String(sess.session);
  const id = String(sess.id);
  const net = `karuna-run-${id}`;
  const relay = `karuna-relay-${id}`;
  const box = `karuna-box-${id}`;
  let stopping = false;
  let beat: NodeJS.Timeout | undefined;

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
    const image = a.image ?? buildImage(dir!, a.agent, tmp);
    const caFile = join(tmp, "karuna-ca.pem");
    writeFileSync(caFile, String(sess.caPem));

    // No route anywhere. The relay is the box's one neighbor, and it forwards one port: this run's proxy.
    docker(["network", "create", "--internal", net]);
    docker(["run", "-d", "--name", relay, "--restart", "no", "alpine/socat", "-d", "tcp-listen:3128,fork,reuseaddr", `tcp-connect:host.docker.internal:${sess.proxyPort}`]);
    docker(["network", "connect", "--alias", "karuna-egress", net, relay]);

    const proxy = "http://karuna-egress:3128";
    const env: Record<string, string> = {
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, ALL_PROXY: proxy, NO_PROXY: "", no_proxy: "",
      NODE_USE_ENV_PROXY: "1",
      SSL_CERT_FILE: "/etc/karuna/ca.pem", REQUESTS_CA_BUNDLE: "/etc/karuna/ca.pem", NODE_EXTRA_CA_CERTS: "/etc/karuna/ca.pem", CURL_CA_BUNDLE: "/etc/karuna/ca.pem", PIP_CERT: "/etc/karuna/ca.pem",
      KARUNA_GATEKEEPER_URL: "http://karuna.internal", KARUNA_AGENT_TOKEN: session, KARUNA_SANDBOX: "1", HOME: "/tmp",
      ...(sess.env as Record<string, string>),
    };
    const args = [
      "run", "--rm", "--init", "--name", box, "--network", net, "--hostname", "sandbox",
      "--read-only", "--tmpfs", "/tmp:rw,size=512m", "--tmpfs", "/workspace:rw,size=1g",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256",
      "--memory", a.memory, "--cpus", a.cpus, "--user", "10001:10001",
      "-v", `${caFile}:/etc/karuna/ca.pem:ro`, "-v", `${caFile}:/etc/ssl/certs/ca-certificates.crt:ro`,
      ...a.mounts.flatMap((m) => ["-v", `${resolve(m.host)}:${m.container}:${m.writable ? "rw" : "ro"}`]),
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      image, ...a.command,
    ];
    say(`run ${id}: ${a.agent} is in the box (no network except Karuna; ${a.mounts.length} mount${a.mounts.length === 1 ? "" : "s"})`);

    beat = setInterval(async () => {
      try {
        const h = await api(a, "/v1/sessions/heartbeat", session);
        if (h.stop && !stopping) {
          stopping = true;
          say(`stopping: ${h.reason}`);
          spawnSync("docker", ["kill", box], { stdio: "ignore" });
        }
      } catch {
        /* Gatekeeper briefly unreachable: the box can't get out either, so just retry */
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
