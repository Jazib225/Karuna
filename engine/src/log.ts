// Tamper-evident decision log (CLAUDE.md §1 "03 Record", §2 rule 6).
// Each entry is hash-chained to the previous one AND ed25519-signed. Editing any
// past entry breaks every hash after it and fails signature verification. In Phase 3
// the latest hash is anchored on Arc so the chain can't be silently rewound.
import {
  createHash,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import type { Decision, Request } from "./types.ts";

/** A non-decision event: approvals, executions, freezes, config changes. Nothing is erasable. */
export interface LogEvent {
  type: string;
  [key: string]: unknown;
}

export interface LogEntry {
  seq: number;
  timestamp: string; // ISO; injectable for deterministic tests
  request?: Request; // set on decision entries
  decision?: Decision; // set on decision entries
  event?: LogEvent; // set on event entries
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

  /**
   * Rebuild a log from stored entries and verify it. Throws if the stored chain was edited,
   * so a tampered log can never be silently continued.
   */
  static restore(entries: LogEntry[], keys: { privateKey: KeyObject; publicKey: KeyObject }): SignedLog {
    const log = new SignedLog(keys);
    log.entries = entries.map((e) => ({ ...e }));
    const v = log.verify();
    if (!v.ok) throw new Error(`Stored log failed verification at entry ${v.brokenAt}: ${v.reason}`);
    return log;
  }

  /** Append a decision. `now` is injectable so tests are deterministic. */
  append(request: Request, decision: Decision, now: Date = new Date()): LogEntry {
    return this.push({ request, decision }, now);
  }

  /** Append an event (approval, execution, freeze, config change, ...). */
  appendEvent(event: LogEvent, now: Date = new Date()): LogEntry {
    return this.push({ event }, now);
  }

  private push(record: Pick<LogEntry, "request" | "decision" | "event">, now: Date): LogEntry {
    const body = {
      seq: this.entries.length,
      timestamp: now.toISOString(),
      ...record,
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
        event: e.event,
        prevHash: e.prevHash,
      });
      if (recomputed !== e.hash) return { ok: false, brokenAt: i, reason: "hash mismatch (entry edited)" };
      const sigOk = edVerify(null, Buffer.from(e.hash, "hex"), publicKey, Buffer.from(e.signature, "hex"));
      if (!sigOk) return { ok: false, brokenAt: i, reason: "bad signature" };
      prev = e.hash;
    }
    return { ok: true };
  }

  private checked = { upTo: 0, prev: GENESIS };

  /**
   * Same result as verify(), checking only the entries appended since the last call (the chain up
   * to there was already checked). For callers that ask often, like the console's live view.
   */
  verifyNew(publicKey: KeyObject = this.publicKey): { ok: boolean; brokenAt?: number; reason?: string } {
    if (this.checked.upTo > this.entries.length) this.checked = { upTo: 0, prev: GENESIS };
    let prev = this.checked.prev;
    for (let i = this.checked.upTo; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.seq !== i) return { ok: false, brokenAt: i, reason: "sequence out of order" };
      if (e.prevHash !== prev) return { ok: false, brokenAt: i, reason: "broken chain link" };
      const recomputed = hashBody({ seq: e.seq, timestamp: e.timestamp, request: e.request, decision: e.decision, event: e.event, prevHash: e.prevHash });
      if (recomputed !== e.hash) return { ok: false, brokenAt: i, reason: "hash mismatch (entry edited)" };
      if (!edVerify(null, Buffer.from(e.hash, "hex"), publicKey, Buffer.from(e.signature, "hex"))) return { ok: false, brokenAt: i, reason: "bad signature" };
      prev = e.hash;
      this.checked = { upTo: i + 1, prev };
    }
    return { ok: true };
  }

  /** Export the public key so anyone can verify the log independently. */
  publicKeyPem(): string {
    return this.publicKey.export({ type: "spki", format: "pem" }).toString();
  }
}
