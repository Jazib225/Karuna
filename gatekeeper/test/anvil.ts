// Starts a throwaway anvil (Foundry's local chain) for the chain-backed tests.
//
// Looks for it in $ANVIL, then ~/.foundry/bin (anvil.exe on Windows), then on PATH. If it isn't
// installed, or doesn't answer, the suite fails right away with a message saying so, instead of
// timing out on a chain that never started.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EXE = process.platform === "win32" ? "anvil.exe" : "anvil";

function anvilPath(): string {
  if (process.env.ANVIL) return process.env.ANVIL;
  const home = join(homedir(), ".foundry", "bin", EXE);
  return existsSync(home) ? home : EXE; // fall back to PATH
}

async function ready(rpc: string): Promise<boolean> {
  try {
    const r = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function startAnvil(port: number): Promise<ChildProcess> {
  const bin = anvilPath();
  const child = spawn(bin, ["--port", String(port), "--chain-id", "5042002", "--silent"], { stdio: "ignore" });
  let failed: Error | null = null;
  child.once("error", (e) => (failed = e));
  const rpc = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (failed) {
      throw new Error(
        `Couldn't start anvil (${bin}): ${(failed as Error).message}. Install Foundry (https://getfoundry.sh) or set ANVIL to the anvil binary.`,
      );
    }
    if (await ready(rpc)) return child;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`anvil (${bin}) didn't answer on ${rpc} within 10 s`);
}
