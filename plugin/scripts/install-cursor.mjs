#!/usr/bin/env node
// Add Karuna's hook to Cursor (user-level ~/.cursor/hooks.json), keeping any hooks already there.
//   node plugin/scripts/install-cursor.mjs [--gatekeeper http://127.0.0.1:8787]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hook = resolve(here, "karuna-hook.mjs").replace(/\\/g, "/");
const gk = process.argv.includes("--gatekeeper") ? process.argv[process.argv.indexOf("--gatekeeper") + 1] : null;
const command = `${gk ? `KARUNA_GATEKEEPER_URL=${gk} ` : ""}node "${hook}" --client cursor`;
const file = join(homedir(), ".cursor", "hooks.json");
let cfg = { version: 1, hooks: {} };
if (existsSync(file)) {
  try {
    cfg = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    console.error(`${file} isn't valid JSON; fix or remove it, then run this again.`);
    process.exit(1);
  }
}
cfg.version ??= 1;
cfg.hooks ??= {};
for (const ev of ["beforeShellExecution", "beforeMCPExecution", "beforeReadFile"]) {
  const list = (cfg.hooks[ev] ??= []).filter((h) => !String(h.command ?? "").includes("karuna-hook.mjs"));
  list.push({ command });
  cfg.hooks[ev] = list;
}
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(cfg, null, 2));
console.log(`Karuna's hook is in ${file}. Restart Cursor; the first command shows a code for a member to approve.`);
