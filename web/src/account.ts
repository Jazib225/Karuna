// Sign in with email and password: the same member on every device.
//
// Your account is your signing key. This browser locks it with your password before anything is
// sent (PBKDF2 → AES-GCM), so Karuna only ever stores a locked key it can't open, plus a proof of
// your password. Signing in on another device fetches the locked key and unlocks it here. Forget the
// password and the key is gone: a teammate adds you back (nothing is ever emailed).
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { api } from "./api.ts";
import { clearSigner, saveSignerKey } from "./signer.ts";

const ACCOUNT_KEY = "karuna.account.v1";

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

/** Two values from the password: an AES key that locks the signing key, and a login proof. */
async function derive(password: string, saltHex: string, iterations: number) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations }, base, 512));
  const lock = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { lock, proof: toHex(bits.slice(32)) };
}

export function accountEmail(): string | null {
  try {
    return localStorage.getItem(ACCOUNT_KEY);
  } catch {
    return null;
  }
}

/** Save the key this device already uses to a new account (you stay the same member). */
export async function createAccount(email: string, password: string, privateKey: Hex) {
  if (password.length < 10) throw new Error("Use at least 10 characters for your password");
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const { kdf } = await api<{ kdf: { iterations: number } }>("/auth/salt", { email });
  const { lock, proof } = await derive(password, salt, kdf.iterations);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const locked = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, lock, fromHex(privateKey.slice(2))));
  const address = privateKeyToAccount(privateKey).address;
  await api("/auth/create", { email, salt, proof, iv: toHex(iv), lockedKey: toHex(locked), address });
  localStorage.setItem(ACCOUNT_KEY, email.trim().toLowerCase());
}

/** Sign in on this device: fetch your locked key, unlock it here, and use it. */
export async function signIn(email: string, password: string) {
  const { salt, kdf } = await api<{ salt: string; kdf: { iterations: number } }>("/auth/salt", { email });
  const { lock, proof } = await derive(password, salt, kdf.iterations);
  const r = await api<{ iv: string; lockedKey: string; address: string }>("/auth/sign-in", { email, proof });
  let key: Hex;
  try {
    key = `0x${toHex(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromHex(r.iv) }, lock, fromHex(r.lockedKey))))}` as Hex;
  } catch {
    throw new Error("Wrong email or password");
  }
  if (privateKeyToAccount(key).address.toLowerCase() !== r.address.toLowerCase()) throw new Error("This account's key doesn't match");
  saveSignerKey(key);
  localStorage.setItem(ACCOUNT_KEY, email.trim().toLowerCase());
}

/** Sign out on this device: its key is forgotten here (it stays in your account). */
export function signOut() {
  try {
    localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    /* nothing stored */
  }
  clearSigner();
}
