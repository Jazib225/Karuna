// Tamper-evident decision log (CLAUDE.md §1 "03 Record", §2 rule 6).
// Each entry is hash-chained to the previous one AND ed25519-signed. Editing any
// past entry breaks every hash after it and fails signature verification. In Phase 3
// the latest hash is anchored on Arc so the chain can't be silently rewound.
import {
  createHash,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import type { Decision, Request } from "./types.ts";

export interface LogEntry {
  seq: number;
  timestamp: string; // ISO; injectable for deterministic tests
  request: Request;
  decision: Decision;
  prevHash: string; // hash of the previous entry (genesis = 64 zeros)
  hash: string; // sha256 over the canonical entry body
  signature: string; // ed25519(hash), hex
}

export const GENESIS = "0".repeat(64);

/** Stable JSON: keys sorted recursively, so the same data always hashes the same. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function hashBody(body: Omit<LogEntry, "hash" | "signature">): string {
  return createHash("sha256").update(canonical(body)).digest("hex");
}

export class SignedLog {
  private entries: LogEntry[] = [];
  private privateKey: KeyObject;
  readonly publicKey: KeyObject;

  constructor(keys?: { privateKey: KeyObject; publicKey: KeyObject }) {
    const k = keys ?? generateKeyPairSync("ed25519");
    this.privateKey = k.privateKey;
    this.publicKey = k.publicKey;
  }

  get length(): number {
    return this.entries.length;
  }

  all(): readonly LogEntry[] {
    return this.entries;
  }

  head(): string {
    return this.entries.at(-1)?.hash ?? GENESIS;
  }

  /** Append a decision. `now` is injectable so tests are deterministic. */
  append(request: Request, decision: Decision, now: Date = new Date()): LogEntry {
    const body = {
      seq: this.entries.length,
      timestamp: now.toISOString(),
      request,
      decision,
      prevHash: this.head(),
    };
    const hash = hashBody(body);
    const signature = edSign(null, Buffer.from(hash, "hex"), this.privateKey).toString("hex");
    const entry: LogEntry = { ...body, hash, signature };
    this.entries.push(entry);
    return entry;
  }

  /**
   * Verify the whole chain: links intact, hashes recomputed, signatures valid.
   * Returns ok=false and the index of the first broken entry if anything was edited.
   */
  verify(publicKey: KeyObject = this.publicKey): { ok: boolean; brokenAt?: number; reason?: string } {
    let prev = GENESIS;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.seq !== i) return { ok: false, brokenAt: i, reason: "sequence out of order" };
      if (e.prevHash !== prev) return { ok: false, brokenAt: i, reason: "broken chain link" };
      const recomputed = hashBody({
        seq: e.seq,
        timestamp: e.timestamp,
        request: e.request,
        decision: e.decision,
        prevHash: e.prevHash,
      });
      if (recomputed !== e.hash) return { ok: false, brokenAt: i, reason: "hash mismatch (entry edited)" };
      const sigOk = edVerify(null, Buffer.from(e.hash, "hex"), publicKey, Buffer.from(e.signature, "hex"));
      if (!sigOk) return { ok: false, brokenAt: i, reason: "bad signature" };
      prev = e.hash;
    }
    return { ok: true };
  }

  /** Export the public key so anyone can verify the log independently. */
  publicKeyPem(): string {
    return createPublicKey(this.publicKey).export({ type: "spki", format: "pem" }).toString();
  }
}
