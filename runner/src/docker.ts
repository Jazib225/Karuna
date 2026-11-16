// Make sure Docker is running before a sandbox starts, so nobody has to open Docker themselves:
// if Docker Desktop is installed but stopped, start it and wait; if it isn't installed, say how to
// get it in one line.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

export const DOCKER_INSTALL_URL = "https://www.docker.com/products/docker-desktop/";

export class DockerMissing extends Error {
  constructor() {
    super(`Docker isn't installed. Karuna runs agents in Docker sandboxes: install Docker Desktop (${DOCKER_INSTALL_URL}), then try again.`);
  }
}

const running = () => spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 15_000 }).status === 0;

/** Where Docker Desktop lives on this machine, if it's installed. */
function desktopApp(): { cmd: string; args: string[] } | null {
  if (process.platform === "win32") {
    const roots = [process.env.ProgramFiles, process.env.ProgramW6432, "C:\\Program Files"].filter(Boolean) as string[];
    for (const r of roots) {
      const exe = join(r, "Docker", "Docker", "Docker Desktop.exe");
      if (existsSync(exe)) return { cmd: exe, args: [] };
    }
    return null;
  }
  if (process.platform === "darwin") {
    return existsSync("/Applications/Docker.app") ? { cmd: "open", args: ["-g", "-a", "Docker"] } : null;
  }
  return null; // Linux: the Docker service is started by the system
}

/**
 * Docker Desktop on Windows can leave socket files behind after it stops (in %LOCALAPPDATA%\Docker\run
 * and %LOCALAPPDATA%\docker-secrets-engine), then crash on the next start because it can't remove
 * them. When Docker Desktop isn't running, move those folders aside (renaming doesn't need to open
 * the sockets); Docker makes fresh ones.
 */
function clearStaleSockets() {
  const local = process.env.LOCALAPPDATA;
  if (process.platform !== "win32" || !local) return;
  const tasks = spawnSync("tasklist", ["/FI", "IMAGENAME eq Docker Desktop.exe", "/NH"], { encoding: "utf8", timeout: 10_000 });
  if (tasks.status !== 0 || /Docker Desktop\.exe/i.test(tasks.stdout ?? "")) return;
  for (const dir of [join(local, "Docker", "run"), join(local, "docker-secrets-engine")]) {
    if (!existsSync(dir)) continue;
    try {
      renameSync(dir, `${dir}.stale-${Date.now()}`);
    } catch {
      /* Docker will report it */
    }
  }
}

/**
 * Resolves once Docker answers. Starts Docker Desktop when it's installed but not running.
 * Throws DockerMissing when there's no Docker to start, or an Error if it never came up.
 */
export async function ensureDocker(say: (s: string) => void = () => undefined, timeoutMs = 180_000): Promise<void> {
  if (running()) return;
  const app = desktopApp();
  const cli = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
  if (!app && !cli) throw new DockerMissing();
  if (!app) throw new Error("Docker is installed but not running. Start the Docker service, then try again.");
  clearStaleSockets();
  say("starting Docker Desktop (this can take a minute the first time)");
  spawn(app.cmd, app.args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 3000));
    if (running()) {
      say("Docker is running");
      return;
    }
  }
  throw new Error("Docker Desktop didn't start in time. Open it once to finish its setup, then try again.");
}
