// Karuna's public address, started from the console: a Cloudflare quick tunnel (cloudflared) to the
// public port (8792), which serves only what other Karunas and chat apps may reach: invite
// requests and the MCP connector. The console API and agent API stay on 127.0.0.1.
//
// A quick tunnel gets a new https address each time it starts, so the address lives only as long as
// the tunnel: when it stops, invite links stop working until it's turned on again. When
// KARUNA_CHAT_URL is set (start-karuna.ps1 runs its own tunnel), that address is used as is.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const START_TIMEOUT_MS = 45_000;

export interface TunnelStatus {
  available: boolean; // cloudflared was found
  external: boolean; // the address comes from KARUNA_CHAT_URL
  running: boolean;
  starting: boolean;
  url: string | null;
  error: string | null;
}

/** cloudflared: KARUNA_CLOUDFLARED (the installed app ships it), else PATH, else its usual install folders. */
export function findCloudflared(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.KARUNA_CLOUDFLARED && existsSync(env.KARUNA_CLOUDFLARED)) return env.KARUNA_CLOUDFLARED;
  const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const dirs = [...(env.PATH ?? "").split(delimiter), env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"]!, "cloudflared"), env.ProgramFiles && join(env.ProgramFiles, "cloudflared")];
  for (const d of dirs) if (d && existsSync(join(d, exe))) return join(d, exe);
  return null;
}

export class Tunnel {
  private proc: ChildProcess | null = null;
  private url: string | null = null;
  private error: string | null = null;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly bin: string | null,
    private readonly port: number,
    /** Called with the new address, or null when the tunnel stops. */
    private readonly onUrl: (url: string | null) => void,
    private readonly external: string | null = null,
    private readonly spawnFn: typeof spawn = spawn,
  ) {}

  status(): TunnelStatus {
    if (this.external) return { available: true, external: true, running: true, starting: false, url: this.external, error: null };
    return { available: !!this.bin, external: false, running: !!this.url, starting: !!this.pending, url: this.url, error: this.error };
  }

  /** Start the tunnel (or return the running one's address). */
  start(): Promise<string> {
    if (this.external) return Promise.resolve(this.external);
    if (this.url) return Promise.resolve(this.url);
    if (this.pending) return this.pending;
    if (!this.bin) return Promise.reject(new Error("cloudflared isn't installed on this computer, so Karuna can't open a public address."));
    this.error = null;
    this.pending = new Promise<string>((resolve, reject) => {
      const p = this.spawnFn(this.bin!, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${this.port}`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      this.proc = p;
      let done = false;
      const finish = (err: string | null, url?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending = null;
        if (err) {
          this.error = err;
          this.stop();
          reject(new Error(err));
        } else {
          this.url = url!;
          this.onUrl(url!);
          resolve(url!);
        }
      };
      const timer = setTimeout(() => finish("Cloudflare didn't open a public address in time. Check the internet connection and try again."), START_TIMEOUT_MS);
      const read = (b: Buffer) => {
        const m = QUICK_URL.exec(b.toString("utf8"));
        if (m) finish(null, m[0]);
      };
      p.stdout?.on("data", read);
      p.stderr?.on("data", read);
      p.on("error", (e) => finish(`Couldn't start cloudflared: ${e.message}`));
      p.on("exit", (code) => {
        const was = this.url;
        this.proc = null;
        this.url = null;
        if (was) {
          this.error = "The public address closed. Turn invite links on again for a new one.";
          this.onUrl(null);
        }
        finish(`cloudflared stopped (exit ${code ?? "?"}) before opening a public address.`);
      });
    });
    return this.pending;
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    const was = this.url;
    this.url = null;
    if (p && p.exitCode === null) p.kill();
    if (was) this.onUrl(null);
  }
}
