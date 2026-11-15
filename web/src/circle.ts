// Sign in with email: one Circle account per person, the same on every device.
//
// Circle's own windows ask for the emailed code and confirm each signature; the Gatekeeper holds
// the Circle API key and only hands this page per-login tokens and challenge ids. The account is
// an EOA on Arc, so its signatures are exactly what Dharma already checks.
import type { Address, Hex } from "viem";
import { toCircleTypedData } from "@prekaruna/dharma";
import { api } from "./api.ts";
import type { Signer } from "./signer.ts";

const SESSION_KEY = "karuna.email.v1";

export interface EmailSession {
  email: string;
  address: Address;
  walletId: string;
  userToken: string;
  encryptionKey: string;
  at: number; // when signed in (Circle's user token expires; signing in again is one code)
}

type Sdk = import("@circle-fin/w3s-pw-web-sdk").W3SSdk;
let sdk: Sdk | null = null;
let sdkAppId = "";

async function getSdk(appId: string): Promise<Sdk> {
  if (sdk && sdkAppId === appId) return sdk;
  const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk"); // loaded only when someone uses email
  sdk = new W3SSdk({ appSettings: { appId } });
  sdkAppId = appId;
  return sdk;
}

export async function emailSignInAvailable(): Promise<{ email: boolean; appId: string | null }> {
  try {
    return await api<{ email: boolean; appId: string | null }>("/auth/config");
  } catch {
    return { email: false, appId: null };
  }
}

export function loadEmailSession(): EmailSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as EmailSession | null;
    return s && s.address && s.userToken ? s : null;
  } catch {
    return null;
  }
}

function saveEmailSession(s: EmailSession | null) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* the session then lasts only while this page is open */
  }
}

export function signOutEmail() {
  saveEmailSession(null);
}

/** Run one Circle challenge (create the wallet, or sign) in Circle's window. */
function runChallenge(s: Sdk, challengeId: string): Promise<{ signature?: string }> {
  return new Promise((resolve, reject) => {
    s.execute(challengeId, (error, result) => {
      if (error) return reject(new Error(error.message || "Cancelled in Circle's window"));
      const data = (result as { data?: { signature?: string } } | undefined)?.data;
      resolve({ signature: data?.signature });
    });
  });
}

/**
 * The whole sign-in: Circle emails a code, its window takes the code, the first time it creates
 * the person's wallet on Arc, then we read the wallet's address. Same email, same account.
 */
export async function signInWithEmail(email: string): Promise<EmailSession> {
  const { appId } = await emailSignInAvailable();
  if (!appId) throw new Error("Email sign-in isn't set up on this Karuna");
  const s = await getSdk(appId);
  const deviceId = await s.getDeviceId();
  const t = await api<{ appId: string; deviceToken: string; deviceEncryptionKey: string; otpToken: string }>("/auth/email/start", { email, deviceId });
  const login = await new Promise<{ userToken: string; encryptionKey: string }>((resolve, reject) => {
    s.updateConfigs(
      { appSettings: { appId }, loginConfigs: { deviceToken: t.deviceToken, deviceEncryptionKey: t.deviceEncryptionKey, otpToken: t.otpToken } },
      (error, result) => {
        if (error || !result) return reject(new Error(error?.message || "Sign-in was cancelled"));
        const r = result as { userToken: string; encryptionKey: string };
        resolve({ userToken: r.userToken, encryptionKey: r.encryptionKey });
      },
    );
    s.verifyOtp();
  });
  s.setAuthentication({ userToken: login.userToken, encryptionKey: login.encryptionKey });
  const { challengeId } = await api<{ challengeId: string | null }>("/auth/circle/init", { userToken: login.userToken });
  if (challengeId) await runChallenge(s, challengeId); // first time: creates the wallet
  let wallet: { walletId: string; address: string } | null = null;
  for (let i = 0; i < 6 && !wallet; i++) {
    try {
      wallet = await api<{ walletId: string; address: string }>("/auth/circle/wallet", { userToken: login.userToken });
    } catch (e) {
      if (i === 5) throw e;
      await new Promise((r) => setTimeout(r, 1500)); // Circle indexes a new wallet within seconds
    }
  }
  const session: EmailSession = {
    email: email.trim().toLowerCase(), address: wallet!.address as Address, walletId: wallet!.walletId,
    userToken: login.userToken, encryptionKey: login.encryptionKey, at: Date.now(),
  };
  saveEmailSession(session);
  return session;
}

/** A signer backed by the person's Circle account: each signature is confirmed in Circle's window. */
export function emailSigner(session: EmailSession, onExpired: () => void): Signer {
  return {
    address: session.address,
    email: session.email,
    async signTypedData(td: Parameters<Signer["signTypedData"]>[0]): Promise<Hex> {
      const { appId } = await emailSignInAvailable();
      if (!appId) throw new Error("Email sign-in isn't set up on this Karuna");
      const s = await getSdk(appId);
      s.setAuthentication({ userToken: session.userToken, encryptionKey: session.encryptionKey });
      let challengeId: string;
      try {
        ({ challengeId } = await api<{ challengeId: string }>("/auth/circle/sign", {
          userToken: session.userToken, walletId: session.walletId, typedData: toCircleTypedData(td as never),
        }));
      } catch (e) {
        if (/expired|token/i.test(String(e))) {
          signOutEmail();
          onExpired();
          throw new Error("Your sign-in expired. Sign in with your email again.");
        }
        throw e;
      }
      const { signature } = await runChallenge(s, challengeId);
      if (!signature) throw new Error("Circle didn't return a signature");
      return signature as Hex;
    },
  } as Signer;
}
