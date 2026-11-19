// The console inside the Karuna desktop app (Tauri). In a normal browser none of this runs.
//
// The island never holds a key. When someone clicks Approve or Deny there, the app asks this
// window (the console, which holds this member's browser key) to sign that exact decision: the
// request id + payload hash + approve/deny. The signed decision goes back over the Gatekeeper's
// pipe, and the Gatekeeper verifies the signature like any console approval.
import type { Signer } from "./signer.ts";
import type { Address } from "viem";
import { Kind, signDecision, submitChange } from "./signer.ts";
import { api, apiAudio, type Snapshot } from "./api.ts";
import { describeChange, type Change } from "@prekaruna/dharma";
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
  const before = current?.me.address;
  current = me ? { me, dharma: dharma ?? "0x0000000000000000000000000000000000000000", isMember } : null;
  if (current?.me.address !== before) sendAppearance();
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
// Karuna Voice switches (docs/VOICE_PLAN.md): talk to the island, and have it read alerts aloud.
const VOICE_KEY = "karuna.voice.enabled";
const READ_KEY = "karuna.voice.readAloud";
const flag = (key: string, dflt: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v === "on";
  } catch {
    return dflt;
  }
};
const setFlag = (key: string, on: boolean) => {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    /* per-browser convenience only */
  }
  sendAppearance();
};
export const getVoiceEnabled = () => flag(VOICE_KEY, false);
export const setVoiceEnabled = (on: boolean) => setFlag(VOICE_KEY, on);
export const getReadAloud = () => flag(READ_KEY, true);
export const setReadAloud = (on: boolean) => setFlag(READ_KEY, on);
/** Where the wake phrase listener is at (the island's in the app; the console's own in a browser). */
export interface WakeState { status: "off" | "loading" | "listening" | "paused" | "error"; error: string | null; phrase: string; heard: string }
let wakeState: WakeState = { status: "off", error: null, phrase: "", heard: "" };
export const getWakeState = () => wakeState;
export function setWakeState(s: WakeState) {
  wakeState = s;
  window.dispatchEvent(new Event("karuna:wake-status"));
}
/** Ask the island to report where its listener is at (the answer arrives as karuna:wake-status). */
export function requestWakeStatus() {
  if (tauri) void tauri.event.emit("karuna://wake-status-request", {});
}
/** Desktop app: the island heard the wake phrase while this console was in front. */
export function onWakeFromIsland(fn: () => void): () => void {
  if (!tauri) return () => undefined;
  let off: (() => void) | null = null;
  let gone = false;
  void tauri.event.listen("karuna://wake", () => fn()).then((u) => (gone ? u() : (off = u)));
  return () => {
    gone = true;
    off?.();
  };
}
/** Desktop app: tell the island the console is talking (it lets go of the mic meanwhile). */
export function tellIslandConsoleTalking(active: boolean) {
  if (tauri) void tauri.event.emit("karuna://console-voice", { active });
}

/** The wake phrase ("" = off): heard offline on this computer, it starts a conversation. */
const WAKE_KEY = "karuna.voice.wake";
export function getWakePhrase(): string {
  try {
    return localStorage.getItem(WAKE_KEY) ?? "";
  } catch {
    return "";
  }
}
export function setWakePhrase(phrase: string) {
  try {
    localStorage.setItem(WAKE_KEY, phrase.trim().slice(0, 60));
  } catch {
    /* per-browser convenience only */
  }
  sendAppearance();
  window.dispatchEvent(new Event("karuna:wake-phrase"));
}
/** Whether the wake phrase is switched on. The phrase is kept while it's off, so switching back on
 *  needs no retyping. Before this switch existed a saved phrase meant on, so that stays the default. */
const WAKE_ON_KEY = "karuna.voice.wake.on";
export function getWakeOn(): boolean {
  try {
    const v = localStorage.getItem(WAKE_ON_KEY);
    return v === null ? true : v === "on";
  } catch {
    return true;
  }
}
export function setWakeOn(on: boolean) {
  try {
    localStorage.setItem(WAKE_ON_KEY, on ? "on" : "off");
  } catch {
    /* per-browser convenience only */
  }
  sendAppearance();
  window.dispatchEvent(new Event("karuna:wake-phrase"));
}
/** The phrase the listener should wait for right now ("" = not listening). */
export function activeWakePhrase(): string {
  return getWakeOn() ? getWakePhrase() : "";
}

/** Tell the island (and launch screen) the theme choice, whether the island and voice are on, and
 *  which member this console signs as (so the island shows only the votes waiting on them). */
export function sendAppearance() {
  if (!tauri) return;
  void tauri.event.emit("karuna://appearance", {
    theme: getThemePref(), island: getIslandEnabled(), voice: getVoiceEnabled(), readAloud: getReadAloud(), wake: activeWakePhrase(),
    member: current?.me.address.toLowerCase() ?? null,
  });
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
  void tauri.event.listen("karuna://wake-status", (e) => setWakeState(e.payload as WakeState));
  onThemeChange(sendAppearance);
  sendAppearance();
  // The app's window can't open new tabs, so a link meant for a new tab (an "Arc tx" link, the
  // Dharma contract) would do nothing. Hand it to the app, which opens explorer links in the
  // default browser (and nothing else; see lib.rs).
  document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || a.target !== "_blank" || !a.href.startsWith("https://")) return;
    e.preventDefault();
    void tauri.event.emit("karuna://open-url", { url: a.href });
  }, true);
  void tauri.event.listen("karuna://voice-call", async (e) => {
    const { callId, tool, args } = (e.payload ?? {}) as { callId?: string; tool?: string; args?: Record<string, unknown> };
    if (!callId || typeof tool !== "string") return;
    try {
      const result = await voiceCall(tool, args ?? {});
      await tauri.event.emit("karuna://voice-result", { callId, ok: true, result });
    } catch (err) {
      await tauri.event.emit("karuna://voice-result", { callId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
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

// ---- Karuna Voice: what the island's voice tools need from this window (docs/VOICE_PLAN.md)
// The island never holds a key or the console token. It asks here for reads, for its one-time
// ElevenLabs conversation token, for spoken alerts, and for signatures. Approve, vote yes, resume
// and propose only reach this function after the member read out the code on the island's screen
// (checked there against their own speech); Dharma and the Gatekeeper check everything as usual.

const drafts = new Map<string, { change: Change; sentence: string }>();
let draftSeq = 0;
const money = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4).replace(/0+$/, "") : n.toFixed(2)}`;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function signerOrThrow() {
  if (!current) throw new Error("This console has no signing key yet. Open Karuna and sign in.");
  return current;
}

export async function voiceCall(tool: string, args: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    case "config":
      return api("/voice/config");
    case "whoami":
      return { address: current?.me.address.toLowerCase() ?? null };
    case "session":
      return api<{ token: string }>("/voice/session", {});
    case "speak": {
      const body = args.vote !== undefined ? { vote: Number(args.vote) } : { id: String(args.id ?? ""), ...(args.reason === true ? { reason: true } : {}) };
      const r = await apiAudio("/voice/speak", body);
      return { audio: toBase64(r.audio), said: r.said };
    }
    case "status": {
      const s = await api<Snapshot>("/state");
      const w = await api<{ usdc: string; gateway: string | null } | null>("/wallet").catch(() => null);
      return {
        organization: s.org.name,
        frozen: !!s.frozen, paused: !!(s as unknown as { paused?: unknown }).paused,
        wallet: w ? { usdc: Number(w.usdc).toFixed(2), gateway: w.gateway } : null,
        today: s.today ?? null,
        agents: (s.policy?.agents ?? []).map((a) => ({
          name: a.name, id: a.id, level: a.level ?? null, spentToday: money(a.spentTodayUsd), dailyCap: a.capUsd ? money(a.capUsd) : null,
        })),
      };
    }
    case "recent": {
      const s = await api<Snapshot>("/state");
      const name = (id: string) => s.policy?.agents.find((a) => a.id === id)?.name ?? id;
      return s.proposals
        .filter((p) => p.status !== "pending")
        .slice(0, 6)
        .map((p) => ({ agent: name(p.agentId), what: p.facts.find((f) => f.label === "Action")?.value ?? p.request.tool, result: p.status, at: p.createdAt }));
    }
    case "rules": {
      const s = await api<Snapshot>("/state");
      const pol = s.policy;
      if (!pol) throw new Error("The organization isn't loaded yet.");
      const agent = (id: string) => pol.agents.find((a) => a.id === id)?.name ?? id;
      const payee = (a: string) => pol.payees.find((p) => p.account.toLowerCase() === a.toLowerCase())?.name ?? a;
      const OUT = { allow: "Allow", deny: "Deny", approval: "Approval" } as const;
      const sentence = (r: (typeof pol.rules)[number]) =>
        describeChange({ op: "AddRule", id: r.id, outcome: OUT[r.outcome], agent: r.agent, scope: r.scope, target: r.target, maxUsd: r.maxUsd } as Change, { agent, payee });
      const custom = pol.rules.filter((r) => r.active && !r.builtin);
      return {
        coreRules: "Always denied: paying an address that isn't a saved payee, reading secrets, catastrophic shell commands, and anything no rule covers.",
        teamRules: custom.slice(0, 25).map(sentence),
        moreRules: Math.max(0, custom.length - 25),
        payees: pol.payees.map((p) => ({ name: p.name ?? p.account, category: p.category })),
        allowedWebsites: pol.domains,
        twoPersonLimit: pol.thresholdUsd ? money(pol.thresholdUsd) : null,
        waits: { normalChangeSeconds: pol.timelock, coreChangeSeconds: pol.coreTimelock },
        members: pol.members.length,
      };
    }
    case "agent_info": {
      const s = await api<Snapshot>("/state");
      const q = String(args.agent ?? "").trim().toLowerCase();
      const agents = s.policy?.agents ?? [];
      const a = agents.find((x) => x.id.toLowerCase() === q || x.name.toLowerCase() === q) ?? agents.find((x) => !!q && (x.name.toLowerCase().includes(q) || x.id.toLowerCase().includes(q)));
      if (!a) throw new Error(`No agent called "${String(args.agent ?? "")}". Agents: ${agents.map((x) => x.name).join(", ") || "none"}.`);
      const lim = a.level != null ? s.policy?.levelLimits?.[a.level] : null;
      const grants = (s.policy?.levelGrants ?? []).filter((g) => a.level != null && g.min <= a.level).map((g) => g.what);
      const recent = s.proposals.filter((p) => p.agentId === a.id).slice(0, 5)
        .map((p) => ({ what: p.facts.find((f) => f.label === "Action")?.value ?? p.request.tool, result: p.status }));
      return {
        id: a.id, name: a.name, level: a.level ?? null,
        paysWithoutAsking: lim ? { perPayment: money(lim.perPaymentUsd), perDay: money(lim.dailyUsd) } : null,
        alsoWithoutAsking: grants,
        spentToday: money(a.spentTodayUsd), dailyAllowance: a.capUsd ? money(a.capUsd) : null,
        record: a.record ?? a.eligibility ?? null,
        runsOnSchedule: a.built ? a.built.scheduleText : null,
        recentActions: recent,
      };
    }
    case "vote": {
      const me = signerOrThrow();
      const id = Number(args.id);
      const s = await api<Snapshot>("/state");
      const g = s.policy?.proposals.find((x) => x.id === id);
      if (!g || g.status !== "open") throw new Error("That vote isn't open any more.");
      if (g.voters.some((v) => v.toLowerCase() === me.me.address.toLowerCase())) throw new Error("You already voted on this.");
      await submitChange(me.me, me.dharma, { kind: Kind.Vote, change: g.change as unknown as Change, proposalId: id, support: args.support === true });
      return { done: true, vote: args.support === true ? "yes" : "no", on: g.description };
    }
    case "lower_level": {
      const me = signerOrThrow();
      const s = await api<Snapshot>("/state");
      const q = String(args.agent ?? "").trim().toLowerCase();
      const agents = s.policy?.agents ?? [];
      const a = agents.find((x) => x.id.toLowerCase() === q || x.name.toLowerCase() === q) ?? agents.find((x) => !!q && (x.name.toLowerCase().includes(q) || x.id.toLowerCase().includes(q)));
      if (!a) throw new Error(`No agent called "${String(args.agent ?? "")}".`);
      const level = Number(args.level);
      if (a.level == null) throw new Error("Trust levels need Dharma v3 or later.");
      if (!Number.isInteger(level) || level < 0 || level >= a.level) throw new Error(`${a.name} is at Level ${a.level}. Voice can only lower it.`);
      await submitChange(me.me, me.dharma, { kind: Kind.Tighten, change: { op: "SetLevel", agent: a.id, level, reason: "member" } as Change });
      return { done: true, agent: a.name, level };
    }
    case "pause":
      return api("/pause", { by: `${current?.me.email ?? "a member"} (voice)` });
    case "resume":
      return api("/resume", { by: `${current?.me.email ?? "a member"} (voice)` });
    case "draft_rule": {
      const r = await api<{ rules: { change: Change; sentence: string }[]; note: string; skipped: string[] }>("/rules/draft", { text: String(args.text ?? "") });
      const out = r.rules.map((rule) => {
        const key = `d-${++draftSeq}`;
        drafts.set(key, rule);
        return { id: key, rule: rule.sentence };
      });
      return { drafts: out, note: r.note, skipped: r.skipped };
    }
    case "propose_draft": {
      const me = signerOrThrow();
      const d = drafts.get(String(args.id ?? ""));
      if (!d) throw new Error("That draft is gone. Draft the rule again.");
      const r = await submitChange(me.me, me.dharma, { kind: Kind.Propose, change: d.change });
      drafts.delete(String(args.id));
      return { done: true, proposed: d.sentence, voteId: r.proposalId ?? null };
    }
    default:
      throw new Error(`Unknown voice call ${tool}`);
  }
}
