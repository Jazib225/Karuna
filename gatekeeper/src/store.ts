// Durable storage for one Gatekeeper instance. Everything lives in a single data directory
// (default gatekeeper/data, gitignored): org config, runtime state, the signed log, and the
// log-signing key. Writes are atomic (temp file + rename).
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import type { LogEntry } from "@prekaruna/engine";

export class Store {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private path(name: string) {
    return join(this.dir, name);
  }

  readJson<T>(name: string, fallback: () => T): T {
    const p = this.path(name);
    if (!existsSync(p)) return fallback();
    return JSON.parse(readFileSync(p, "utf8")) as T;
  }

  writeJson(name: string, value: unknown) {
    const p = this.path(name);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
  }

  readLog(): LogEntry[] {
    const p = this.path("log.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LogEntry);
  }

  appendLog(entry: LogEntry) {
    appendFileSync(this.path("log.jsonl"), JSON.stringify(entry) + "\n", { mode: 0o600 });
  }

  /** Copy these files into archive/<time>-<name>/ (for starting a new organization). Returns the folder. */
  archive(name: string, files: string[]): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "organization";
    const folder = join(this.dir, "archive", `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}`);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    for (const f of files) if (existsSync(this.path(f))) copyFileSync(this.path(f), join(folder, f));
    return folder;
  }

  /** Start an empty decision log (after archiving the old one). */
  resetLog() {
    writeFileSync(this.path("log.jsonl"), "", { mode: 0o600 });
  }

  /** The ed25519 key that signs the decision log. Created once, never leaves this directory. */
  loadOrCreateLogKeys(): { privateKey: KeyObject; publicKey: KeyObject } {
    const p = this.path("log-signing-key.pem");
    if (existsSync(p)) {
      const privateKey = createPrivateKey(readFileSync(p, "utf8"));
      return { privateKey, publicKey: createPublicKey(privateKey) };
    }
    const keys = generateKeyPairSync("ed25519");
    writeFileSync(p, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    chmodSync(p, 0o600);
    return keys;
  }

  /** Secret the console uses to reach the console API. Agents never get it. */
  loadOrCreateConsoleToken(): string {
    const p = this.path("console.token");
    if (existsSync(p)) return readFileSync(p, "utf8").trim();
    const token = randomBytes(32).toString("base64url");
    writeFileSync(p, token, { mode: 0o600 });
    return token;
  }
}
