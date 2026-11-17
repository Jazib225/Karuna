// The console inside the Karuna desktop app (Tauri). In a normal browser none of this runs.
//
// The island never holds a key. When someone clicks Approve or Deny there, the app asks this
// window (the console, which holds this member's browser key) to sign that exact decision: the
// request id + payload hash + approve/deny. The signed decision goes back over the Gatekeeper's
// pipe, and the Gatekeeper verifies the signature like any console approval.
import type { Signer } from "./signer.ts";
import type { Address } from "viem";
import { signDecision } from "./signer.ts";
import { getThemePref, onThemeChange } from "./theme.ts";
import { createContour } from "./site/contour.ts";
import { mountGL } from "./site/glrun.ts";

interface TauriGlobal {
  event: {
    listen: (name: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
    emit: (name: string, payload?: unknown) => Promise<void>;
  };
}
const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;

/** True when the console runs inside the Karuna desktop app. */
export const IN_APP = !!tauri;

interface SignRequest {
  id: string;
  payload_hash: string;
  decision: "approve" | "deny";
}

let current: { me: Signer; dharma: Address; isMember: boolean } | null = null;

/** Called by the console once it knows who this browser is. */
export function setDesktopSigner(me: Signer | null, dharma: Address | null, isMember: boolean) {
  // Without a loaded org (Gatekeeper offline, or the mock) we still sign: a signature is useless to
  // anyone but the real Gatekeeper, which checks it against Dharma and its members.
  current = me ? { me, dharma: dharma ?? "0x0000000000000000000000000000000000000000", isMember } : null;
}

// ---- appearance shared with the island and launch screen (desktop app only)
const ISLAND_KEY = "karuna.island.enabled";
export function getIslandEnabled(): boolean {
  try {
    return localStorage.getItem(ISLAND_KEY) !== "off";
  } catch {
    return true;
  }
}
/** Tell the island (and launch screen) the theme choice and whether the island is on. */
export function sendAppearance() {
  if (!tauri) return;
  void tauri.event.emit("karuna://appearance", { theme: getThemePref(), island: getIslandEnabled() });
}
export function setIslandEnabled(on: boolean) {
  try {
    localStorage.setItem(ISLAND_KEY, on ? "on" : "off");
  } catch {
    /* per-browser convenience only */
  }
  sendAppearance();
}

let started = false;
export function startDesktopBridge() {
  if (!tauri || started) return;
  started = true;
  document.documentElement.classList.add("in-app");
  // The island asks when it starts; the console also tells it whenever the theme changes.
  void tauri.event.listen("karuna://appearance-request", () => sendAppearance());
  onThemeChange(sendAppearance);
  sendAppearance();
  void tauri.event.listen("karuna://sign-request", async (e) => {
    const req = e.payload as SignRequest;
    if (!req?.id || !/^(0x)?[0-9a-fA-F]{64}$/.test(req.payload_hash ?? "") || (req.decision !== "approve" && req.decision !== "deny")) return;
    if (!current) {
      await tauri.event.emit("karuna://sign-error", { id: req.id, error: "This console has no signing key yet." });
      return;
    }
    try {
      const s = await signDecision(current.me, current.dharma, req.id, req.payload_hash, req.decision === "approve");
      await tauri.event.emit("karuna://signed", {
        type: "approval_response", id: req.id, payload_hash: req.payload_hash.replace(/^0x/, ""), decision: req.decision,
        signer: s.signer, deadline: s.deadline, signature: s.signature,
      });
    } catch (err) {
      await tauri.event.emit("karuna://sign-error", { id: req.id, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** The site's marbled background (Governance section: marble variant at 10% over #0a0a0a), behind
 *  the console in the browser and in the desktop app. Paused while the tab or window is hidden. */
export function startMarbleBackground() {
  document.documentElement.classList.add("marbled");
  const bg = document.createElement("div");
  bg.className = "app-marble";
  bg.setAttribute("aria-hidden", "true");
  document.body.prepend(bg);
  const gl = mountGL(bg, (g) => createContour(g, "marble"), { fallbackSrc: "/brand/contour.webp", dprCap: 1.5, resolution: 1 });
  const sync = () => (document.hidden ? gl.stop() : gl.start());
  document.addEventListener("visibilitychange", sync);
  sync();
}
