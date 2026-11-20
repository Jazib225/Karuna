// The packaged desktop app's backend: one Node process that runs the Gatekeeper, the relay and the
// console (the built `web/` app plus the same /api and /relay proxy `vite preview` gives it in
// development). build.mjs bundles this file into karuna-core.mjs, and the desktop app starts it
// with the Node it ships. The same bundle is the `karuna` runner: `karuna-core.mjs run …` and
// `karuna-core.mjs undo …` are what the Gatekeeper calls for agent runs and undo.
//
// Everything listens on 127.0.0.1 only, as in development.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, createServer as netServer } from "node:net";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const home = dirname(self);
const mode = process.argv[2];

if (mode === "run" || mode === "undo" || mode === "changes") {
  await import("../../runner/src/cli.ts");
} else {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const dataDir = resolve(process.env.KARUNA_DATA_DIR ?? join(appData, "dev.karunaprotocol.desktop", "data"));
  mkdirSync(dataDir, { recursive: true });
  process.env.KARUNA_DATA_DIR = dataDir;
  process.env.KARUNA_ENV_FILE ??= join(dirname(dataDir), ".env");
  process.env.KARUNA_CORE = self;
  process.env.KARUNA_AGENT_DIR = join(home, "agent");
  process.env.KARUNA_RELAY_RECORDS ??= join(dataDir, "relay-records.json");
  // Circle's CLI ships with the app (its JS entry runs under this Node); a CIRCLE_BIN in .env wins.
  const circle = join(home, "circle", "dist", "index.js");
  if (existsSync(circle)) process.env.CIRCLE_BIN ??= circle;
  // cloudflared ships too: the console opens invite links' public address with it.
  const cloudflared = join(home, "cloudflared.exe");
  if (existsSync(cloudflared)) process.env.KARUNA_CLOUDFLARED ??= cloudflared;

  // The desktop window shows this line if Karuna can't start (src-tauri/src/services.rs, launch.ts).
  const cantStart = (why: string) => {
    console.error(`karuna · can't start: ${why}`);
    process.exit(1);
  };
  process.on("uncaughtException", (e) => cantStart(e instanceof Error ? e.message : String(e)));
  await freePorts(cantStart);

  await import("../../gatekeeper/src/main.ts");
  await import("../../relay/src/main.ts");
  serveConsole(dataDir);
}

/** Check Karuna's ports before starting. One still held by an earlier Karuna (this same node.exe,
 *  left behind by a crash) is freed; anything else is named, so the window can say what to close. */
async function freePorts(cantStart: (why: string) => void) {
  const env = (k: string, d: number) => Number(process.env[k] ?? d);
  const ports = [
    { port: env("KARUNA_AGENT_PORT", 8787), what: "the agent API" },
    { port: env("KARUNA_CONSOLE_PORT", 8788), what: "the console API" },
    { port: env("RELAY_PORT", 8790), what: "the chain relay" },
    { port: env("RELAY_WEBHOOK_PORT", 8791), what: "the chain relay's webhook" },
    { port: env("KARUNA_PUBLIC_PORT", 8792), what: "invite links and chat apps" },
    { port: env("KARUNA_WEB_PREVIEW_PORT", 4173), what: "the console" },
  ];
  const free = (port: number) =>
    new Promise<boolean>((done) => {
      const srv = netServer();
      srv.once("error", () => done(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => done(true)));
    });
  const owner = (port: number): { pid: number; path: string | null } | null => {
    if (process.platform !== "win32") return null;
    try {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true });
      const listening = new RegExp(String.raw`^\s*TCP\s+\S+:${port}\s+\S+\s+LISTENING\s+(\d+)`, "i");
      const line = out.split(/\r?\n/).find((l) => listening.test(l));
      const pid = Number(line?.trim().split(/\s+/).pop());
      if (!pid) return null;
      let path: string | null = null;
      try {
        path = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).Path`], { encoding: "utf8", windowsHide: true }).trim() || null;
      } catch {
        /* the process ended meanwhile, or no access */
      }
      return { pid, path };
    } catch {
      return null;
    }
  };
  for (const { port, what } of ports) {
    if (await free(port)) continue;
    const o = owner(port);
    if (o?.path && o.path.toLowerCase() === process.execPath.toLowerCase() && o.pid !== process.pid) {
      // An earlier Karuna's services, still running: stop them and take over.
      try {
        execFileSync("taskkill", ["/PID", String(o.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } catch {
        /* already gone */
      }
      for (let i = 0; i < 20 && !(await free(port)); i++) await new Promise((r) => setTimeout(r, 250));
      if (await free(port)) continue;
    }
    const who = o ? `${o.path ?? "another program"} (process ${o.pid})` : "another program";
    cantStart(`port ${port} (${what}) is in use by ${who}. Close it, then quit Karuna from the tray and open it again.`);
  }
  // The desktop app's pipe: only one Gatekeeper can serve it.
  if (process.platform === "win32") {
    const taken = await new Promise<boolean>((done) => {
      const c = connect("\\\\.\\pipe\\karuna");
      c.once("connect", () => (c.destroy(), done(true)));
      c.once("error", () => done(false));
    });
    if (taken) cantStart("another Karuna Gatekeeper is already running on this computer (it holds \\\\.\\pipe\\karuna). Stop it, then quit Karuna from the tray and open it again.");
  }
}

function serveConsole(dataDir: string) {
  const root = join(home, "console");
  const port = Number(process.env.KARUNA_WEB_PREVIEW_PORT ?? 4173);
  const apiPort = Number(process.env.KARUNA_CONSOLE_PORT ?? 8788);
  const relayPort = Number(process.env.RELAY_PORT ?? 8790);
  const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
  const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
    ".ico": "image/x-icon", ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".wasm": "application/wasm", ".gz": "application/gzip", ".zip": "application/zip", ".txt": "text/plain",
  };
  // The console secret is added here, server-side, exactly as the dev proxy does: it never reaches the page.
  const consoleToken = () => {
    try {
      return readFileSync(join(dataDir, "console.token"), "utf8").trim();
    } catch {
      return "";
    }
  };

  const proxy = (req: IncomingMessage, res: ServerResponse, target: number, token: boolean) => {
    const headers = { ...req.headers, host: `127.0.0.1:${target}` };
    if (token) headers["x-karuna-console-token"] = consoleToken();
    const up = request({ host: "127.0.0.1", port: target, method: req.method, path: req.url, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Karuna is still starting. Try again in a moment." }));
    });
    req.pipe(up);
  };

  const file = (req: IncomingMessage, res: ServerResponse) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let f = normalize(join(root, path));
    if (!f.startsWith(root + sep) && f !== root) return void res.writeHead(403).end();
    // The console is a single page: any path that isn't a file is the app.
    if (!existsSync(f) || statSync(f).isDirectory()) f = join(root, "index.html");
    const ext = extname(f).toLowerCase();
    res.writeHead(200, {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    res.end(readFileSync(f));
  };

  const server = createServer((req, res) => {
    // Only this computer: anyone who can reach the console can approve payments.
    if (!LOCAL.test(req.headers.host ?? "")) return void res.writeHead(403, { "content-type": "text/plain" }).end("This Karuna console only answers on this computer.");
    const url = req.url ?? "/";
    if (url === "/api" || url.startsWith("/api/")) return proxy(req, res, apiPort, true);
    if (url === "/relay" || url.startsWith("/relay/")) return proxy(req, res, relayPort, false);
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
    file(req, res);
  });

  // Live chain events: the relay's WebSocket, passed through as is.
  server.on("upgrade", (req, socket, head) => {
    if (!LOCAL.test(req.headers.host ?? "") || !(req.url ?? "").startsWith("/relay")) return socket.destroy();
    const up = connect(relayPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        lines.push(`${k}: ${k.toLowerCase() === "host" ? `127.0.0.1:${relayPort}` : req.rawHeaders[i + 1]}`);
      }
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const kill = () => {
      socket.destroy();
      up.destroy();
    };
    up.on("error", kill);
    socket.on("error", kill);
  });

  server.listen(port, "127.0.0.1", () => console.log(`karuna · console          http://127.0.0.1:${port}`));
}
