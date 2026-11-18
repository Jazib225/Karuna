// The org's API keys (OpenAI, Gmail, GitHub…). Agents never hold them: a box gets a placeholder
// like `karuna_key_openai`, and the egress proxy swaps in the real value only on requests to a
// host that a Dharma rule (scope "key:<name>") binds that key to. Values are encrypted at rest
// (AES-256-GCM, key in the data dir) and are never returned to any client after they're stored.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Free model providers the rule drafter can use (see draft.ts). */
export const DRAFTER_PROVIDERS = ["groq", "gemini"] as const;
export type DrafterProvider = (typeof DRAFTER_PROVIDERS)[number];

export interface KeyMeta {
  name: string; // slug, e.g. "openai"
  envVar: string; // what the agent reads, e.g. OPENAI_API_KEY
  createdAt: string;
  rotatedAt?: string;
  /** "drafter": only Karuna's rule drafter may use it. Agents never get it, not even a placeholder. */
  purpose?: "drafter";
  provider?: DrafterProvider; // for drafter keys
}

interface Stored extends KeyMeta {
  iv: string;
  tag: string;
  data: string;
}

export const placeholderFor = (name: string) => `karuna_key_${name}`;
const PLACEHOLDER_RE = /karuna_key_([a-z0-9][a-z0-9-]{0,39})/g;
const ENV_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class SecretStore {
  private readonly key: Buffer;
  private readonly file: string;
  private items: Stored[];

  constructor(dataDir: string) {
    const keyPath = join(dataDir, "secrets.key");
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32).toString("base64"), { mode: 0o600 });
    this.key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    this.file = join(dataDir, "secrets.json");
    this.items = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Stored[]) : [];
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.items, null, 2), { mode: 0o600 });
  }

  /** Forget every key (they were archived with the organization). */
  clear() {
    this.items = [];
    this.save();
  }

  list(): KeyMeta[] {
    return this.items.map(({ name, envVar, createdAt, rotatedAt, purpose, provider }) => ({ name, envVar, createdAt, rotatedAt, ...(purpose ? { purpose, provider } : {}) }));
  }

  /** True for a key agents may use (through a placeholder and a binding). Drafter keys never are. */
  forAgents(name: string): boolean {
    const s = this.items.find((x) => x.name === name);
    return !!s && s.purpose !== "drafter";
  }

  /** The rule drafter's key for a provider: a key marked for the drafter, newest first. */
  drafterKey(provider: DrafterProvider): string | null {
    const k = [...this.items].reverse().find((x) => x.purpose === "drafter" && x.provider === provider);
    return k ? this.reveal(k.name) : null;
  }

  /** Add or rotate a key. The value is encrypted immediately and never handed back out. */
  put(name: string, envVar: string, value: string, now = new Date(), opts: { purpose?: "drafter"; provider?: string } = {}): KeyMeta {
    if (opts.purpose === "drafter" && !DRAFTER_PROVIDERS.includes(opts.provider as DrafterProvider)) {
      throw new Error(`Rule drafter keys are for: ${DRAFTER_PROVIDERS.join(", ")}`);
    }
    if (!NAME_RE.test(name)) throw new Error("Key name: lowercase letters, digits and dashes (max 40)");
    if (!ENV_RE.test(envVar)) throw new Error("Variable name: UPPER_CASE letters, digits and _");
    if (!value || value.length > 8192) throw new Error("Key value is empty or too long");
    if (value.includes("karuna_key_")) throw new Error("That's a Karuna placeholder, not a real key");
    const clash = this.items.find((x) => x.envVar === envVar && x.name !== name);
    if (clash) throw new Error(`${envVar} is already used by key "${clash.name}"`);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
    const prev = this.items.find((x) => x.name === name);
    const item: Stored = {
      name, envVar, createdAt: prev?.createdAt ?? now.toISOString(), rotatedAt: prev ? now.toISOString() : undefined,
      ...(opts.purpose === "drafter" ? { purpose: "drafter" as const, provider: opts.provider as DrafterProvider } : {}),
      iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64"),
    };
    this.items = [...this.items.filter((x) => x.name !== name), item];
    this.save();
    return this.list().find((x) => x.name === name)!;
  }

  remove(name: string) {
    this.items = this.items.filter((x) => x.name !== name);
    this.save();
  }

  /** Decrypt one value. Only the egress proxy calls this, at the moment it forwards a request. */
  reveal(name: string): string | null {
    const s = this.items.find((x) => x.name === name);
    if (!s) return null;
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(s.iv, "base64"));
    d.setAuthTag(Buffer.from(s.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]).toString("utf8");
  }

  /** The env a box gets: each agent key's variable set to its placeholder (never drafter keys). */
  placeholderEnv(): Record<string, string> {
    return Object.fromEntries(this.items.filter((x) => x.purpose !== "drafter").map((x) => [x.envVar, placeholderFor(x.name)]));
  }

  /** Every placeholder named in some text (headers, URL). */
  static placeholdersIn(text: string): string[] {
    return [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))];
  }
}
