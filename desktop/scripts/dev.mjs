// `npm run tauri dev` runs this first: the island's dev server (:1420), plus the console's
// (`web/`, :5173, or KARUNA_WEB_PORT) unless it's already running. The main window loads the
// console from there. Both reload on save, so changes show up without rebuilding the app.
import { spawn } from "node:child_process";
import { request } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const shell = process.platform === "win32";

const up = (port) =>
  new Promise((done) => {
    const r = request({ host: "127.0.0.1", port, path: "/", timeout: 800 }, (res) => {
      res.resume();
      done(true);
    });
    r.on("error", () => done(false));
    r.on("timeout", () => (r.destroy(), done(false)));
    r.end();
  });

const kids = [];
const run = (cmd, args, cwd) => {
  const p = spawn(cmd, args, { cwd, stdio: "inherit", shell });
  kids.push(p);
  p.on("exit", (code) => {
    if (code) process.exitCode = code;
  });
};

const webPort = Number(process.env.KARUNA_WEB_PORT ?? 5173);
if (await up(webPort)) console.log(`karuna-desktop · console already running on :${webPort}`);
else run("npx", ["-y", "pnpm@9", "--dir", "web", "dev"], root);
run("npx", ["vite"], resolve(here, ".."));

const stop = () => kids.forEach((k) => k.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
