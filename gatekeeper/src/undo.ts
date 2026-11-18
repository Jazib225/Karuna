// Undo a sandbox run's file changes on this machine: runs `karuna undo` (runner/src/cli.ts), which
// restores the run's snapshot of its writable mounts. Used for runs started on this machine.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { GatekeeperDeps } from "./gatekeeper.ts";

export function runnerUndo(repoRoot: string): NonNullable<GatekeeperDeps["undo"]> {
  return ({ runId, path }) => new Promise((done) => {
    const win = process.platform === "win32";
    const args = ["tsx", resolve(repoRoot, "runner/src/cli.ts"), "undo", "--run", runId, ...(path ? ["--path", path] : [])];
    const p = spawn(win ? "npx.cmd" : "npx", win ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args, { shell: win, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout!.on("data", (b: Buffer) => (out += b.toString("utf8")));
    p.stderr!.on("data", (b: Buffer) => (err += b.toString("utf8")));
    p.on("error", (e) => done({ restored: [], skipped: [], error: e.message }));
    p.on("exit", () => {
      const last = err.split(/\r?\n/).map((l) => l.replace(/^karuna · /, "").trim()).filter(Boolean).at(-1);
      try {
        const r = JSON.parse(out.trim().split(/\r?\n/).at(-1) ?? "");
        done({ restored: r.restored ?? [], skipped: r.skipped ?? [], ...(last && !(r.restored ?? []).length ? { error: last } : {}) });
      } catch {
        done({ restored: [], skipped: [], error: last ?? "karuna undo failed" });
      }
    });
  });
}
