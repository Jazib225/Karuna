// Invite links, the joining side: your console pastes a link from another organization's Karuna,
// and this Gatekeeper talks to that Karuna's public address for it (look up the org, send the signed
// join request, check whether its members added you). Only links of the exact shape below are
// followed: https://<their Karuna>/invite/inv_…  (http only for this computer, for local testing).
import { GatekeeperError } from "./gatekeeper.ts";

const CODE_RE = /^inv_[A-Za-z0-9_-]{8,40}$/;

export function parseInviteLink(link: unknown): { base: string; code: string } {
  let u: URL;
  try {
    u = new URL(String(link ?? "").trim());
  } catch {
    throw new GatekeeperError("Paste the whole invite link (it starts with https://)", 400);
  }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new GatekeeperError("Invite links start with https://", 400);
  const m = u.pathname.replace(/\/+$/, "").match(/^(.*)\/invite\/([^/]+)$/);
  if (!m || !CODE_RE.test(m[2]) || u.username || u.password) throw new GatekeeperError("That isn't a Karuna invite link", 400);
  return { base: `${u.origin}${m[1]}`, code: m[2] };
}

/** Ask the other Karuna. Its errors come back as they are ("This invite link isn't valid anymore…"). */
export async function remoteInvite<T>(link: unknown, sub: string, body?: unknown): Promise<T> {
  const { base, code } = parseInviteLink(link);
  let res: Response;
  try {
    res = await fetch(`${base}/invite/${code}${sub}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GatekeeperError("Couldn't reach that organization's Karuna. Check the link, or ask them whether their Karuna is running.", 502);
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !data) throw new GatekeeperError(data?.error ?? `Their Karuna answered ${res.status}`, res.status === 404 ? 404 : 502);
  return data;
}
