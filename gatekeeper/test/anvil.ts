// Where the local test chain (Foundry's anvil) lives. Works the same on a laptop and in CI:
//   ANVIL_BIN=/path/to/anvil   explicit override
//   ~/.foundry/bin/anvil       the default foundryup install
//   anvil                      on PATH (GitHub Actions: foundry-rs/foundry-toolchain)
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function anvilBin(): string {
  if (process.env.ANVIL_BIN) return process.env.ANVIL_BIN;
  const local = join(homedir(), ".foundry/bin/anvil");
  return existsSync(local) ? local : "anvil";
}
