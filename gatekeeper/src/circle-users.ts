// Sign in with email: Circle user-controlled wallets (email OTP), one account per person.
//
// The Gatekeeper holds the Circle API key and talks to Circle; the browser only ever gets the
// per-login device tokens and challenge ids, and runs Circle's own windows (code entry, signing
// confirmation) through Circle's web SDK. The wallet is an EOA on ARC-TESTNET, so its EIP-712
// signatures are plain ECDSA and Dharma's existing check (ecrecover) accepts them unchanged.
import { randomUUID } from "node:crypto";

export const CIRCLE_API = "https://api.circle.com";
export const CIRCLE_CHAIN = "ARC-TESTNET";

/** Circle's "user already initialized" code: the person signed in before, so the wallet exists. */
const ALREADY_INITIALIZED = 155106;

export class CircleUsersError extends Error {
  constructor(message: string, readonly status = 502, readonly code?: number) {
    super(message);
  }
}

type FetchFn = typeof fetch;

export class CircleUsers {
  constructor(
    private readonly apiKey: string | undefined,
    readonly appId: string | undefined,
    private readonly fetchFn: FetchFn = fetch,
    private readonly base = CIRCLE_API,
  ) {}

  get enabled(): boolean {
    return !!this.apiKey && !!this.appId;
  }

  private async call<T>(method: string, path: string, opts: { body?: unknown; userToken?: string } = {}): Promise<T> {
    if (!this.enabled) throw new CircleUsersError("Email sign-in isn't set up on this Karuna (CIRCLE_API_KEY and CIRCLE_APP_ID)", 503);
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}`, accept: "application/json", "x-request-id": randomUUID() };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.userToken) headers["x-user-token"] = opts.userToken;
    let r: Response;
    try {
      r = await this.fetchFn(`${this.base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    } catch {
      throw new CircleUsersError("Couldn't reach Circle");
    }
    const j = (await r.json().catch(() => ({}))) as { data?: T; code?: number; message?: string };
    if (!r.ok) {
      // Circle's messages are safe to show (no secrets); keep them short.
      throw new CircleUsersError(`Circle: ${String(j.message ?? r.statusText).slice(0, 200)}`, r.status >= 500 ? 502 : r.status === 401 ? 401 : 400, j.code);
    }
    return (j.data ?? ({} as T)) as T;
  }

  /** Step 1: email the person a code. The browser passes these to Circle's SDK to show the code entry. */
  async emailToken(email: string, deviceId: string) {
    const e = String(email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) throw new CircleUsersError("Enter a valid email address", 400);
    if (!String(deviceId ?? "").trim()) throw new CircleUsersError("Missing device id", 400);
    const d = await this.call<{ deviceToken: string; deviceEncryptionKey: string; otpToken: string }>("POST", "/v1/w3s/users/email/token", {
      body: { idempotencyKey: randomUUID(), deviceId: String(deviceId), email: e },
    });
    return { appId: this.appId!, deviceToken: d.deviceToken, deviceEncryptionKey: d.deviceEncryptionKey, otpToken: d.otpToken };
  }

  /**
   * Step 2, after the code: make sure the person has a wallet. First sign-in returns a challenge
   * that creates the EOA on Arc (the browser runs it); later sign-ins return null.
   */
  async initialize(userToken: string): Promise<{ challengeId: string | null }> {
    try {
      const d = await this.call<{ challengeId: string }>("POST", "/v1/w3s/user/initialize", {
        userToken, body: { idempotencyKey: randomUUID(), accountType: "EOA", blockchains: [CIRCLE_CHAIN] },
      });
      return { challengeId: d.challengeId ?? null };
    } catch (e) {
      if (e instanceof CircleUsersError && e.code === ALREADY_INITIALIZED) return { challengeId: null };
      throw e;
    }
  }

  /** Step 3: the person's wallet on Arc (its address is their member address). */
  async wallet(userToken: string): Promise<{ walletId: string; address: string }> {
    const d = await this.call<{ wallets?: { id: string; address: string; blockchain: string; accountType?: string; state?: string }[] }>(
      "GET", `/v1/w3s/wallets?blockchain=${CIRCLE_CHAIN}`, { userToken },
    );
    const w = (d.wallets ?? []).find((x) => x.blockchain === CIRCLE_CHAIN && (x.accountType ?? "EOA") === "EOA" && (x.state ?? "LIVE") === "LIVE");
    if (!w) throw new CircleUsersError("Your Circle wallet isn't ready yet: try again in a few seconds", 409);
    return { walletId: w.id, address: w.address.toLowerCase() };
  }

  /**
   * Signing: a challenge for EIP-712 typed data (a vote, a rule change, an approval). The browser runs
   * it in Circle's confirmation window and gets the signature back.
   */
  async signTypedData(userToken: string, walletId: string, typedData: unknown): Promise<{ challengeId: string }> {
    if (!walletId) throw new CircleUsersError("Missing wallet", 400);
    const data = typeof typedData === "string" ? typedData : JSON.stringify(typedData);
    if (data.length > 20_000) throw new CircleUsersError("Typed data too large", 400);
    const d = await this.call<{ challengeId: string }>("POST", "/v1/w3s/user/sign/typedData", {
      userToken, body: { walletId, data, memo: "Karuna" },
    });
    return { challengeId: d.challengeId };
  }
}
