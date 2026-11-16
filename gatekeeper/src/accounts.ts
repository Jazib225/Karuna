// Sign in with email and password: the same member on every device, with no email sending.
//
// A member's account is their signing key (it signs their votes and approvals), so Karuna must never
// be able to use it. The browser derives two values from the password: one locks the key (AES-GCM),
// the other is a login proof. Karuna stores the locked key and a hash of the proof; it never sees
// the password or the key, and it hands the locked key only to someone who proves the password, so
// nobody can download it to guess passwords offline. Forgetting the password loses the key: a
// teammate adds the person back (there is no reset email, because nothing is emailed).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GatekeeperError } from "./gatekeeper.ts";
import type { Store } from "./store.ts";

/** How the browser derives keys from the password (sent back with the salt). */
export const KDF = { name: "PBKDF2", hash: "SHA-256", iterations: 600_000 } as const;

interface Account {
  email: string;
  salt: string; // hex, 16 bytes
  proofHash: string; // sha256(login proof), hex
  iv: string; // hex, 12 bytes
  lockedKey: string; // hex, AES-GCM ciphertext of the private key
  address: string; // the key's address (public anyway: it's the member address)
  createdAt: string;
}

const FILE = "accounts.json";
const LIMIT = { attempts: 8, windowMs: 10 * 60_000 }; // wrong passwords per email per 10 minutes
const hex = (s: unknown, bytes: number) => typeof s === "string" && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(s);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class Accounts {
  private accounts: Record<string, Account>;
  private secret: string;
  private failures = new Map<string, number[]>();

  constructor(private readonly store: Store, private readonly now: () => Date = () => new Date()) {
    const saved = store.readJson<{ secret?: string; accounts?: Record<string, Account> }>(FILE, () => ({}));
    this.secret = saved.secret ?? randomBytes(32).toString("hex");
    this.accounts = saved.accounts ?? {};
    if (!saved.secret) this.save();
  }

  private save() {
    this.store.writeJson(FILE, { secret: this.secret, accounts: this.accounts });
  }

  private static email(e: unknown): string {
    const v = String(e ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || v.length > 200) throw new GatekeeperError("Enter a valid email address");
    return v;
  }

  /**
   * The salt to derive keys with. An unknown email gets a stable made-up salt, so this doesn't
   * reveal who has an account.
   */
  salt(emailIn: unknown) {
    const email = Accounts.email(emailIn);
    const a = this.accounts[email];
    const salt = a?.salt ?? createHmac("sha256", this.secret).update(email).digest("hex").slice(0, 32);
    return { salt, kdf: KDF };
  }

  /** Save this device's key to a new account (locked by the browser before it's sent). */
  create(input: { email?: unknown; salt?: unknown; proof?: unknown; iv?: unknown; lockedKey?: unknown; address?: unknown }) {
    const email = Accounts.email(input.email);
    if (this.accounts[email]) throw new GatekeeperError("There's already an account with that email. Sign in instead.", 409);
    if (!hex(input.salt, 16) || !hex(input.proof, 32) || !hex(input.iv, 12)) throw new GatekeeperError("Malformed account");
    if (typeof input.lockedKey !== "string" || !/^[0-9a-f]{64,256}$/.test(input.lockedKey)) throw new GatekeeperError("Malformed account");
    if (typeof input.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(input.address)) throw new GatekeeperError("Malformed account");
    if (Object.values(this.accounts).some((a) => a.address === input.address!.toString().toLowerCase())) {
      throw new GatekeeperError("This key is already saved to another account. Sign in with that one.", 409);
    }
    if (Object.keys(this.accounts).length >= 500) throw new GatekeeperError("Too many accounts", 429);
    this.accounts[email] = {
      email, salt: input.salt as string, proofHash: sha256(input.proof as string), iv: input.iv as string,
      lockedKey: input.lockedKey, address: input.address.toLowerCase(), createdAt: this.now().toISOString(),
    };
    this.save();
    return { ok: true, address: input.address.toLowerCase() };
  }

  /** Prove the password; get the locked key back (the browser unlocks it). */
  signIn(input: { email?: unknown; proof?: unknown }) {
    const email = Accounts.email(input.email);
    const now = this.now().getTime();
    const recent = (this.failures.get(email) ?? []).filter((t) => now - t < LIMIT.windowMs);
    if (recent.length >= LIMIT.attempts) throw new GatekeeperError("Too many wrong passwords. Try again in a few minutes.", 429);
    const a = this.accounts[email];
    const given = hex(input.proof, 32) ? sha256(input.proof as string) : "";
    const ok = !!a && given.length === a.proofHash.length && timingSafeEqual(Buffer.from(given), Buffer.from(a.proofHash));
    if (!ok) {
      this.failures.set(email, [...recent, now]);
      throw new GatekeeperError("Wrong email or password", 401);
    }
    this.failures.delete(email);
    return { iv: a.iv, lockedKey: a.lockedKey, address: a.address };
  }

  /** Console: who has an account (addresses are member addresses; emails stay private here). */
  list() {
    return Object.values(this.accounts).map((a) => ({ email: a.email, address: a.address, createdAt: a.createdAt }));
  }
}
