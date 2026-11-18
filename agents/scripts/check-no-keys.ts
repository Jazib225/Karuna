// ROADMAP Phase 2 check: "Searching the agent's code and environment finds no keys."
// Scans every file in agents/ (except node_modules) and the agent process environment for
// anything that could move money or reach the wallet: private keys, mnemonics, API keys,
// Circle sessions, wallet SDK imports. Exits non-zero if anything is found.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PATTERNS: [string, RegExp][] = [
  ["hex private key", /\b(0x)?[0-9a-fA-F]{64}\b/],
  ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["mnemonic phrase", /\b(mnemonic|seed phrase)\b\s*[:=]/i],
  ["private key variable", /\b(private[_-]?key|secret[_-]?key|entity[_-]?secret)\b\s*[:=]\s*["'`]?[^\s"'`]{8,}/i],
  ["Circle API key", /\b(TEST|LIVE)_API_KEY:[0-9a-f]{32}:[0-9a-f]{32}\b/],
  ["wallet SDK import", /from\s+["'](@circle-fin\/(developer-controlled-wallets|x402-batching)|viem\/accounts|ethers)["']/],
  ["wallet CLI call", /\bcircle\s+(wallet|services|gateway)\b/],
  ["Circle CLI session path", /\.circle-cli/],
];
const ENV_DANGER = /(PRIVATE|SECRET|MNEMONIC|SEED|API_KEY|ENTITY|CIRCLE|WALLET)/i;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".git")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

const self = fileURLToPath(import.meta.url);
const hits: string[] = [];
let scanned = 0;
for (const f of files(root)) {
  if (f === self) continue; // this file contains the patterns themselves
  scanned++;
  const text = readFileSync(f, "utf8");
  text.split("\n").forEach((line, i) => {
    for (const [what, re] of PATTERNS) if (re.test(line)) hits.push(`${relative(root, f)}:${i + 1}  ${what}`);
  });
}
// npm_package_* is package.json metadata the package manager sets (e.g. npm_package_private=true), never a key.
const envHits = Object.keys(process.env).filter((k) => ENV_DANGER.test(k) && !/^npm_package_/i.test(k));

console.log(`Scanned ${scanned} agent files and ${Object.keys(process.env).length} environment variables.`);
if (hits.length) console.log(`Code findings:\n  ${hits.join("\n  ")}`);
if (envHits.length) console.log(`Environment findings: ${envHits.join(", ")}`);
if (hits.length || envHits.length) {
  console.log("FAIL: something key-like is reachable from the agent.");
  process.exit(1);
}
console.log("PASS: no keys, wallet SDKs, wallet CLI calls, or secrets in agent code or environment.");
