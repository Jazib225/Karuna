// Before a folder becomes a box, make sure no real key rides along in it. A key copied into the
// image would defeat the point: the box must hold nothing worth stealing. Keys belong in Karuna.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".next"]);
const MAX_FILE = 2 * 1024 * 1024;

export const SECRET_PATTERNS: [string, RegExp][] = [
  ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{32,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Slack token", /\bxox[abpr]-[A-Za-z0-9-]{20,}/],
  ["Stripe secret key", /\b[rs]k_live_[A-Za-z0-9]{20,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["mnemonic phrase", /\b(mnemonic|seed[_ ]phrase)\b\s*[:=]\s*["'`]?\w+(\s+\w+){11,}/i],
  ["private key variable", /\b(private[_-]?key|secret[_-]?key)\b\s*[:=]\s*["'`]?(0x)?[0-9a-fA-F]{64}\b/i],
  ["Circle API key", /\b(TEST|LIVE)_API_KEY:[0-9a-f]{32}:[0-9a-f]{32}\b/],
];

export interface Finding {
  file: string;
  what: string;
}

/** Files that never go into an image (the generated .dockerignore excludes them too). */
export const isEnvFile = (name: string) => /^\.env(\..*)?$/.test(name) && !/\.(example|sample|template)$/.test(name);

export function scanForSecrets(dir: string): Finding[] {
  const found: Finding[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (isEnvFile(name) || st.size > MAX_FILE) continue; // .env files are excluded from the image
      let text: string;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue; // binary
      for (const [what, re] of SECRET_PATTERNS) if (re.test(text)) found.push({ file: relative(dir, p), what });
    }
  };
  walk(dir);
  return found;
}
