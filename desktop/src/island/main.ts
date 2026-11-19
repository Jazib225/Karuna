// The island: what Karuna shows at the top of the screen while the console is minimized.
//
// Two modes: a fake notch at top center (default) and a floating lotus you can drag anywhere.
// The window covers the whole monitor and is click-through except over what this page reports as
// interactive (see reportRects); the app tells us when the cursor enters or leaves those areas.
// Every field on an approval card comes from the Gatekeeper; the agent's own words are shown as
// plain text, in a quieter box, labeled untrusted.
import "./island.css";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { createContour } from "../../../web/src/site/contour.ts";
import { createLotus, contextAttributes } from "../../../web/src/site/lotus.ts";
import { IslandVoice, type OpenVote } from "./voice.ts";
import { WaveRenderer } from "./wave.ts";
import { WakeListener } from "./wake.ts";

type State = "idle" | "working" | "pending" | "approved" | "denied" | "paused" | "offline";
interface Decision { type: "decision"; id: string; action_type: string; summary: string; result: "allow" | "deny" }
interface ApprovalRequested {
  type: "approval_requested"; id: string; action_type: string; payload: Record<string, unknown>; payload_hash: string;
  reversible: boolean; agent_reason: string | null; expires_at: string | null; agent?: string;
  /** Why Karuna held it (the rule that matched) and what happens if no member answers. */
  why?: string | null; if_unanswered?: string | null;
}
type GkEvent =
  | Decision
  | ApprovalRequested
  | { type: "approval_resolved"; id: string; result: string }
  | { type: "approval_progress"; id: string; approvals: number; needed: number }
  | { type: "agent_paused"; by?: string }
  | { type: "agent_resumed" }
  | { type: "error"; id?: string; error: string }
  | ({ type: "vote_requested" } & OpenVote)
  | { type: "vote_resolved"; id: number };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const notch = $("notch");
const pill = $("pill");
const label = $("label");
const sub = $("sub");
const floater = $("floater");
const mic = $<HTMLButtonElement>("mic");
const card = $("card");
const cardBody = $("card-body");
const sprite = $<HTMLCanvasElement>("sprite");
const fsprite = $<HTMLCanvasElement>("fsprite");
// Canvas backing stores at device pixels, so Windows display scaling never stretches the lotus.
const fitCanvas = (c: HTMLCanvasElement, css: number) => {
  c.width = c.height = Math.round(css * (window.devicePixelRatio || 1));
};
fitCanvas(sprite, 28);
fitCanvas(fsprite, 40);
matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", () => {
  fitCanvas(sprite, 28);
  fitCanvas(fsprite, 40);
});

const LABELS: Record<State, string> = {
  idle: "Watching", working: "Working", pending: "Needs you", approved: "Approved", denied: "Denied", paused: "Paused", offline: "Offline",
};
const REASON_CAP = 160;
const RETRACT_MS = 700;
const DOCK = { halfWidth: 170, maxY: 90 };

// ------------------------------------------------------------------ appearance (from the console)
// The console's Appearance page sends the theme (light / dark / system) and whether the island is on.
// Remembered here too, so the island looks right even before the console has opened.
type Appearance = { theme: "system" | "light" | "dark"; island: boolean; voice: boolean; readAloud: boolean; member: string | null; wake: string };
const APPEAR_KEY = "karuna.appearance";
const darkMedia = matchMedia("(prefers-color-scheme: dark)");
const parseAppearance = (a: Partial<Appearance>): Appearance => ({
  theme: a.theme === "light" || a.theme === "dark" ? a.theme : "system", island: a.island !== false,
  voice: a.voice === true, readAloud: a.readAloud !== false, member: typeof a.member === "string" ? a.member : null,
  wake: typeof a.wake === "string" ? a.wake.slice(0, 60) : "",
});
const loadAppearance = (): Appearance => {
  try {
    return parseAppearance(JSON.parse(localStorage.getItem(APPEAR_KEY) ?? ""));
  } catch {
    return parseAppearance({});
  }
};
let appearance = loadAppearance();
function applyAppearance() {
  const dark = appearance.theme === "dark" || (appearance.theme === "system" && darkMedia.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.body.classList.toggle("island-off", !appearance.island);
}
applyAppearance();
darkMedia.addEventListener("change", applyAppearance);

// ------------------------------------------------------------------ state
const VOICE_LABELS = { off: "Voice", connecting: "Connecting…", listening: "Listening…", speaking: "Speaking", thinking: "Thinking…" } as const;
// Karuna Voice (voice.ts). Created below once the card helpers exist; render() reads it.
// eslint-disable-next-line prefer-const
let voice: IslandVoice;
// The wake phrase listener (wake.ts), made with the voice below.
let wakeListener: WakeListener | null = null;
let connected = false;
let paused = false;
let hovering = false;
/** The approval the user already looked at and hovered away from: it stays in the pill, not open. */
let dismissed: string | null = null;
let visible = false;
let dragging = false;
let transient: { state: State; until: number } | null = null;
const queue: ApprovalRequested[] = [];
// Newest first; only the last FEED_MAX are kept, so a new decision pushes the oldest off the bottom.
const FEED_MAX = 3;
const feed: { at: number; e: Decision }[] = [];
const cardStatus = new Map<string, { text: string; err: boolean }>();
let reasonOpen = false;
let cardKey = "";

type Mode = { mode: "notch" } | { mode: "floating"; x: number; y: number };
const loadMode = (): Mode => {
  try {
    const m = JSON.parse(localStorage.getItem("karuna.island.mode") ?? "") as Mode;
    if (m.mode === "floating" && Number.isFinite(m.x) && Number.isFinite(m.y)) return m;
  } catch {
    /* default */
  }
  return { mode: "notch" };
};
let mode = loadMode();
const saveMode = () => {
  try {
    localStorage.setItem("karuna.island.mode", JSON.stringify(mode));
  } catch {
    /* per-machine convenience only */
  }
};

function currentState(): State {
  if (!connected) return "offline";
  if (queue.length || voice.myVotes().length) return "pending";
  if (transient && transient.until > Date.now()) return transient.state;
  if (paused) return "paused";
  return "idle";
}
const flash = (state: State, ms: number) => {
  transient = { state, until: Date.now() + ms };
  setTimeout(render, ms + 20);
};

// ------------------------------------------------------------------ voice waveform
const wave = new WaveRenderer();

// ------------------------------------------------------------------ lotus
// One turn of the site's lotus (20 s per turn on the site), rendered once at start-up into separate
// frames. Enough frames, plus a crossfade between neighbours, make the slow turn continuous.
const FRAMES = 240;
const SPR = 112; // backing px per frame: the site's dither at a fine grain, drawn at device pixels
const frames: HTMLCanvasElement[] = [];
/** Square crop (in sprite px) centered on the flower itself: the site's camera frames it off-center. */
let crop = { x: 0, y: 0, s: SPR };
function buildSprites() {
  const glc = document.createElement("canvas");
  glc.width = glc.height = SPR;
  const gl = (glc.getContext("webgl2", { ...contextAttributes, preserveDrawingBuffer: true }) ??
    glc.getContext("webgl", { ...contextAttributes, preserveDrawingBuffer: true })) as WebGLRenderingContext | null;
  if (!gl) return;
  const r = createLotus(gl);
  r.resize(SPR, SPR);
  let x0 = SPR, y0 = SPR, x1 = -1, y1 = -1;
  for (let i = 0; i < FRAMES; i++) {
    r.frame((i / FRAMES) * 20, 0);
    const f = document.createElement("canvas");
    f.width = f.height = SPR;
    const fx = f.getContext("2d", { willReadFrequently: i % 8 === 0 })!;
    fx.drawImage(glc, 0, 0);
    frames.push(f);
    // Union of the lotus' pixels over the turn (sampled every 8th frame is plenty).
    if (i % 8 === 0) {
      const px = fx.getImageData(0, 0, SPR, SPR).data;
      for (let y = 0; y < SPR; y++)
        for (let x = 0; x < SPR; x++)
          if (px[(y * SPR + x) * 4 + 3] > 8) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
    }
  }
  r.destroy();
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  if (x1 >= x0) {
    const side = Math.min(SPR, Math.max(x1 - x0 + 1, y1 - y0 + 1) + 4);
    const cx = (x0 + x1 + 1) / 2;
    const cy = (y0 + y1 + 1) / 2;
    crop = { x: Math.max(0, Math.min(SPR - side, cx - side / 2)), y: Math.max(0, Math.min(SPR - side, cy - side / 2)), s: side };
  }
}

const SPEED: Record<State, number> = { idle: 1, working: 3.2, pending: 0.55, approved: 0, denied: 0, paused: 0, offline: 0 };
let phase = 0;
let lastT = 0;
let settleFrom = 0;
function drawSprite(now: number) {
  requestAnimationFrame(drawSprite);
  const dt = Math.min(0.1, (now - (lastT || now)) / 1000);
  lastT = now;
  if (!visible) return;
  drawContour(now);
  // The mic's waveform follows Karuna's voice, and settles flat when it's quiet.
  if (voice?.active) {
    wave.setLevel(voice.waveLevel());
    wave.frame(now);
  } else wave.setLevel(0);
  if (!frames.length) return;
  const st = currentState();
  // Approved settles: the turn slows to a stop. Everything else turns at its own pace.
  let speed = SPEED[st];
  if (voice.active) speed = voice.mode === "connecting" ? 0.4 : 0.5 + 6 * Math.min(1, voice.level());
  else if (st === "approved") speed = Math.max(0, 1.6 * (1 - (now - settleFrom) / 1100));
  phase = (phase + (dt * speed * FRAMES) / 20) % FRAMES;
  const a = Math.floor(phase);
  const b = (a + 1) % FRAMES;
  const t = phase - a;
  // The same frames drive the pill and the floating lotus; neighbours crossfade for smooth motion.
  for (const c of [sprite, fsprite]) {
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.globalAlpha = 1;
    ctx.drawImage(frames[a], crop.x, crop.y, crop.s, crop.s, 0, 0, c.width, c.height);
    if (t > 0.02) {
      ctx.globalAlpha = t;
      ctx.drawImage(frames[b], crop.x, crop.y, crop.s, crop.s, 0, 0, c.width, c.height);
    }
    ctx.globalAlpha = 1;
  }
}

// ------------------------------------------------------------------ contour background
// The site's marble contours behind every surface: the notch pill, the floating lotus and the card.
// One offscreen WebGL canvas (card-sized) renders the shader; each surface copies its own piece of
// it into a plain 2D canvas, so the line density matches everywhere and there's only one GL context
// (no lazy mount that can miss, no per-surface context that the browser may drop). If WebGL isn't
// available, the site's still image is used instead.
const BG = { w: 360, h: 560, fps: 30 };
const bgDpr = Math.min(window.devicePixelRatio || 1, 1.5);
const bgSrc = document.createElement("canvas");
bgSrc.width = Math.round(BG.w * bgDpr);
bgSrc.height = Math.round(BG.h * bgDpr);
let bgRender: ReturnType<typeof createContour> | null = null;
let bgImage: HTMLImageElement | null = null;
let bgT = 0;
let bgLast = 0;
function initContour() {
  const gl = (bgSrc.getContext("webgl2", { alpha: true, antialias: true, preserveDrawingBuffer: true }) ??
    bgSrc.getContext("webgl", { alpha: true, antialias: true, preserveDrawingBuffer: true })) as WebGLRenderingContext | null;
  try {
    if (gl) {
      bgRender = createContour(gl, "marble");
      bgRender.resize(bgSrc.width, bgSrc.height);
      bgRender.frame(0, 0);
    }
  } catch {
    bgRender = null;
  }
  if (!bgRender) {
    bgImage = new Image();
    bgImage.src = "/brand/contour.webp";
  }
  bgSrc.addEventListener("webglcontextlost", (e) => e.preventDefault());
  bgSrc.addEventListener("webglcontextrestored", () => {
    bgRender = null;
    initContour();
  });
}
const bgCanvases = ["pill-bg", "floater-bg", "card-bg"].map((id) => $<HTMLCanvasElement>(id));
/** Where each surface takes its piece of the shared texture (CSS px within BG): pill = top strip, floater = middle, card = all. */
const bgAnchor = (c: HTMLCanvasElement, w: number, h: number) =>
  c.id === "floater-bg" ? { x: (BG.w - w) / 2, y: (BG.h - h) / 2 } : { x: Math.max(0, (BG.w - w) / 2), y: 0 };
function drawContour(now: number) {
  if (now - bgLast < 1000 / BG.fps) return;
  const dt = Math.min(0.1, (now - (bgLast || now)) / 1000);
  bgLast = now;
  bgT += dt;
  const src: CanvasImageSource | null = bgRender ? bgSrc : bgImage?.complete && bgImage.naturalWidth ? bgImage : null;
  if (!src) return;
  if (bgRender) bgRender.frame(bgT, dt);
  const sw = bgRender ? bgSrc.width : bgImage!.naturalWidth;
  const sh = bgRender ? bgSrc.height : bgImage!.naturalHeight;
  const sx = sw / BG.w;
  const sy = sh / BG.h;
  for (const c of bgCanvases) {
    const box = c.parentElement!;
    if (box.hidden || !box.getClientRects().length) continue; // fixed boxes have no offsetParent, so check layout instead
    if (box === pill && !notch.classList.contains("open")) continue; // retracted: the strip shows no background
    const w = Math.min(BG.w, box.clientWidth);
    const h = Math.min(BG.h, box.clientHeight);
    if (!w || !h) continue;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    const a = bgAnchor(c, w, h);
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, pw, ph);
    ctx.drawImage(src, a.x * sx, a.y * sy, w * sx, h * sy, 0, 0, pw, ph);
  }
}

// ------------------------------------------------------------------ rendering
const fmtTime = (ms: number) => new Date(ms).toTimeString().slice(0, 8);
const shortHash = (h: string) => (h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h);
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text; // text only: nothing here is ever parsed as HTML
  return n;
};
const fmtValue = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v, null, 2) : String(v));

// "test-agent" -> "Test agent". The id is Karuna's, not something the agent wrote.
const agentName = (id?: string) => (id ? id.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "An agent");
const money = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n < 0.01 && n > 0 ? n.toFixed(4).replace(/0+$/, "") : n.toFixed(2)}` : "";
};
const shortAddr = (s: string) => (/^0x[0-9a-f]{40}$/i.test(s) ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
const hostPath = (u: unknown) => {
  try {
    const url = new URL(String(u));
    return url.host + (url.pathname === "/" ? "" : url.pathname);
  } catch {
    return String(u ?? "");
  }
};

/** Karuna's own one-line headline and the single fact that matters, both from the payload. */
function describe(a: ApprovalRequested): { title: string; fact: string } {
  const p = a.payload ?? {};
  const who = agentName(a.agent);
  const s = (k: string) => (p[k] === undefined || p[k] === null ? "" : String(p[k]));
  switch (a.action_type) {
    case "transfer":
      return { title: `${who} wants to pay ${money(p.amountUsd)}`, fact: `to ${s("payeeName") || shortAddr(s("to"))}` };
    case "x402":
      return { title: `${who} wants to buy data for ${money(p.amountUsd)}`, fact: hostPath(p.url) };
    case "http": {
      const m = (s("method") || "GET").toUpperCase();
      const verb = m === "DELETE" ? "delete something on" : m === "GET" || m === "HEAD" ? "open" : "send data to";
      let host = s("url");
      try { host = new URL(host).host; } catch { /* keep raw */ }
      return { title: `${who} wants to ${verb} ${host}`, fact: `${m} ${hostPath(p.url)}` };
    }
    case "shell":
      return { title: `${who} wants to run a command`, fact: s("command") };
    case "file":
      return { title: `${who} wants to ${s("body") ? "write" : "change"} a file`, fact: s("path") };
    case "message":
      return { title: `${who} wants to message another agent`, fact: s("to") };
    default:
      return { title: `${who} needs your approval`, fact: a.action_type };
  }
}

function approvalCard(a: ApprovalRequested): HTMLElement {
  const box = el("div", "appr");
  const { title, fact } = describe(a);

  const head = el("div", "appr-head");
  head.append(el("h2", "appr-title", title));
  if (a.expires_at) {
    const exp = el("span", "appr-exp");
    exp.dataset.expires = a.expires_at;
    head.append(exp);
  }
  box.append(head);
  if (fact) box.append(el("div", "appr-fact", fact));
  if (a.why) box.append(el("div", "appr-why", `Held: ${a.why}`));
  if (a.if_unanswered) box.append(el("div", "appr-unanswered", a.if_unanswered));

  // The agent's own explanation: shown short and quiet, and marked as its words, not Karuna's.
  if (a.agent_reason) {
    const text = String(a.agent_reason).trim();
    const r = el("div", "reason");
    r.append(el("p", undefined, text.length > REASON_CAP ? `${text.slice(0, REASON_CAP)}…` : text));
    r.append(el("div", "lbl", "Agent's note · not verified"));
    box.append(r);
  }

  // Everything else stays one click away: the exact payload, hash and reversibility.
  const more = el("details", "appr-more");
  more.open = reasonOpen;
  more.ontoggle = () => {
    reasonOpen = more.open;
    requestAnimationFrame(reportRects);
  };
  more.append(el("summary", undefined, "Details"));
  const dl = el("dl");
  for (const [k, v] of Object.entries(a.payload ?? {})) dl.append(el("dt", undefined, k), el("dd", undefined, fmtValue(v)));
  if (!/^0*$/.test(a.payload_hash.replace(/^0x/, ""))) {
    const hash = el("dd", "hash", shortHash(a.payload_hash));
    hash.title = a.payload_hash;
    dl.append(el("dt", undefined, "hash"), hash);
  }
  dl.append(el("dt", undefined, "undo"), el("dd", undefined, a.reversible ? "possible" : "not possible"));
  if (a.agent_reason && String(a.agent_reason).trim().length > REASON_CAP) dl.append(el("dt", undefined, "note"), el("dd", undefined, String(a.agent_reason)));
  more.append(dl);
  box.append(more);

  const st = cardStatus.get(a.id);
  const status = el("div", `status-line${st?.err ? " err" : ""}`, st?.text ?? "");
  const actions = el("div", "actions");
  const deny = el("button", "btn btn-deny", "Deny");
  const approve = el("button", "btn btn-approve", "Approve");
  deny.type = approve.type = "button";
  const busy = st && !st.err;
  deny.disabled = approve.disabled = !!busy || expired(a);
  deny.onclick = () => decide(a, "deny");
  // No keyboard path approves: only a real pointer click (detail >= 1) counts.
  approve.onclick = (e) => {
    if ((e as MouseEvent).detail >= 1) decide(a, "approve");
  };
  actions.append(deny, approve);
  // Always reachable: the decision bar sticks to the bottom of the card while the payload scrolls.
  const bar = el("div", "decide");
  bar.append(actions, status);
  if (queue.length > 1) bar.append(el("div", "queue", `${queue.length - 1} more waiting`));
  box.append(bar);
  return box;
}

/** An open Dharma vote waiting on this member: Yes / No, signed by the console like an approval. */
function voteCard(v: OpenVote): HTMLElement {
  const box = el("div", "appr");
  const head = el("div", "appr-head");
  head.append(el("h2", "appr-title", v.core ? "Core change: your vote" : "Vote on a change"));
  box.append(head, el("div", "appr-fact", v.description));
  box.append(el("div", "appr-why", `${v.yes} of ${v.needed} yes votes${v.no ? ` · ${v.no} no` : ""}`));
  box.append(el("div", "appr-unanswered", v.core ? "Every member must vote yes, then the core wait." : "Passes with a majority, then the team's wait."));
  const key = `v${v.id}`;
  const st = cardStatus.get(key);
  const status = el("div", `status-line${st?.err ? " err" : ""}`, st?.text ?? "");
  const actions = el("div", "actions");
  const no = el("button", "btn btn-deny", "Vote no");
  const yes = el("button", "btn btn-approve", "Vote yes");
  no.type = yes.type = "button";
  no.disabled = yes.disabled = !!st && !st.err;
  const cast = async (support: boolean) => {
    cardStatus.set(key, { text: "Signing your vote in the console…", err: false });
    render();
    try {
      const r = await voice.voteByClick(v.id, support);
      cardStatus.set(key, { text: r === "already" ? "You've already voted on this." : support ? "Voted yes. Recorded on Dharma." : "Voted no. Recorded on Dharma.", err: false });
      dismissed = key;
    } catch (err) {
      cardStatus.set(key, { text: err instanceof Error ? err.message : String(err), err: true });
    }
    render();
  };
  no.onclick = () => void cast(false);
  // Like Approve: only a real pointer click votes yes.
  yes.onclick = (e) => {
    if ((e as MouseEvent).detail >= 1) void cast(true);
  };
  actions.append(no, yes);
  const bar = el("div", "decide");
  bar.append(actions, status);
  box.append(bar);
  return box;
}

const expired = (a: ApprovalRequested) => !!a.expires_at && Date.parse(a.expires_at) <= Date.now();

/** The same mic as the pill's: starts or ends a conversation. */
function micButton(): HTMLButtonElement {
  const b = mic.cloneNode(true) as HTMLButtonElement;
  b.removeAttribute("id");
  b.hidden = false;
  b.classList.add("card-mic");
  b.classList.toggle("on", voice.active);
  b.title = "Talk to Karuna (Ctrl+Shift+Space)";
  b.addEventListener("pointerdown", (e) => e.stopPropagation());
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    void voice.toggle();
  });
  return b;
}

function feedView(): HTMLElement {
  const wrap = el("div");
  const st = currentState();
  const eb = el("div", "eyebrow", st === "offline" ? "Gatekeeper" : "Recent decisions");
  const right = el("span", "right", st === "offline" ? "retrying" : paused ? "paused" : "");
  eb.append(right);
  // Floating, there's no pill to hold the mic: it sits in the card's header instead.
  if (voice.enabled && mode.mode === "floating" && st !== "offline") eb.append(micButton());
  wrap.append(eb);
  if (st === "offline") {
    wrap.append(el("p", "empty", "Not connected to the Gatekeeper. Karuna keeps trying quietly; start it and this connects on its own."));
    return wrap;
  }
  if (!feed.length) {
    wrap.append(el("p", "empty", "Nothing yet. Decisions show up here as your agents act."));
    return wrap;
  }
  const list = el("div", "feed");
  for (const { at, e } of feed.slice(0, FEED_MAX)) {
    const row = el("div", `row ${e.result}`);
    row.append(el("span", "t", fmtTime(at)), el("span", "s", `${e.action_type} · ${e.summary}`), el("span", `verdict ${e.result}`, e.result));
    list.append(row);
  }
  wrap.append(list);
  return wrap;
}

function render() {
  const st = currentState();
  notch.dataset.state = st;
  floater.dataset.state = st;
  const vote = queue.length ? null : voice.myVotes()[0] ?? null;
  // The conversation needs the mic: the wake phrase lets go of it while talking, and takes it back after.
  if (voice.active || consoleTalking) wakeListener?.pause();
  else wakeListener?.resume();
  label.textContent = voice.active ? VOICE_LABELS[voice.mode] : LABELS[st];
  sub.textContent = voice.active ? "" : st === "pending" ? (vote ? "vote" : queue[0].action_type) : st === "offline" ? "retrying" : feed[0] ? feed[0].e.summary : "";
  mic.hidden = !voice.enabled || mode.mode !== "notch";
  mic.classList.toggle("on", voice.active);
  mic.title = voice.active ? "End the conversation (Ctrl+Shift+Space)" : "Talk to Karuna (Ctrl+Shift+Space)";
  if (st === "approved") settleFrom = performance.now();

  const floating = mode.mode === "floating";
  notch.hidden = floating;
  floater.hidden = !floating;
  if (mode.mode === "floating") {
    floater.style.left = `${mode.x}px`;
    floater.style.top = `${mode.y}px`;
  }

  // Open: hovering, dragging, or a new approval waiting. Once the user hovers away from that
  // approval it retracts to the pill (which still says it's waiting); hovering opens it again.
  const pendingKey = queue[0]?.id ?? (vote ? `v${vote.id}` : "");
  const fresh = st === "pending" && pendingKey !== dismissed;
  // A conversation (or a voice error to read) keeps the panel open until it ends.
  const talking = voice.active || !!voice.error;
  const open = hovering || fresh || dragging || talking;
  notch.classList.toggle("open", open && !floating);
  const showCard = open && !dragging && (st === "pending" || hovering || talking);
  clearTimeout(hideTimer);
  if (showCard) {
    card.hidden = false;
    card.classList.toggle("wide", talking);
    // Rebuild only when what the card shows changed: rebuilding on every event (a feed decision, a
    // hover) swapped the buttons out from under a click in progress.
    const a = queue[0];
    const s = a && cardStatus.get(a.id);
    const vs = vote && cardStatus.get(`v${vote.id}`);
    const key = talking
      ? `voice:${voice.stamp()}`
      : st === "pending"
        ? a
          ? `a:${a.id}:${s?.err ? 1 : 0}:${s?.text ?? ""}:${expired(a)}`
          : `v:${vote!.id}:${vote!.yes}:${vote!.no}:${vs?.err ? 1 : 0}:${vs?.text ?? ""}`
        : `f:${st}:${paused}:${feed.length}:${feed[0]?.at ?? 0}:${Math.floor(Date.now() / 30_000)}:${voice.enabled}:${mode.mode}`;
    if (key !== cardKey || !cardBody.firstChild) {
      cardKey = key;
      cardBody.replaceChildren(talking ? voice.panel(el, mode.mode === "floating" ? micButton : undefined) : st === "pending" ? (a ? approvalCard(a) : voteCard(vote!)) : feedView());
    }
    placeCard();
    requestAnimationFrame(() => {
      card.classList.add("show");
      reportRects();
    });
    tickExpiry();
  } else if (!card.hidden) {
    // Fade and lift out with the pill, then take it out of the layout.
    card.classList.remove("show");
    hideTimer = window.setTimeout(() => {
      card.hidden = true;
      reportRects();
    }, CARD_OUT_MS);
  }
  reportRects();
}

/** Under the pill, or next to the floating lotus, flipped so it stays on screen. */
function placeCard() {
  const w = card.offsetWidth || 360;
  const h = card.offsetHeight || 320;
  let x: number;
  let y: number;
  if (mode.mode === "notch") {
    x = window.innerWidth / 2 - w / 2;
    y = 52;
  } else {
    const L = { x: mode.x, y: mode.y, s: 56 };
    x = L.x + L.s + 10;
    if (x + w > window.innerWidth - 8) x = L.x - w - 10; // flip left
    y = L.y;
    if (y + h > window.innerHeight - 8) y = L.y + L.s - h; // flip up
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - h - 8));
  }
  card.style.left = `${Math.round(x)}px`;
  card.style.top = `${Math.round(y)}px`;
}

let hideTimer = 0;
const CARD_OUT_MS = 340; // the card's fade-out (island.css .card transition)

/** Drop approvals whose hold ran out: the Gatekeeper already refused them. */
function dropExpired() {
  const now = Date.now();
  const before = queue.length;
  for (let i = queue.length - 1; i >= 0; i--) {
    const at = queue[i].expires_at ? Date.parse(queue[i].expires_at!) : NaN;
    if (!Number.isNaN(at) && at + 1500 < now) {
      cardStatus.delete(queue[i].id);
      queue.splice(i, 1);
    }
  }
  if (queue.length !== before) {
    flash("denied", 1600);
    render();
  }
}
setInterval(dropExpired, 1000);

let expiryTimer = 0;
function tickExpiry() {
  clearTimeout(expiryTimer);
  const n = card.querySelector<HTMLElement>(".appr-exp");
  if (!n) return;
  const at = n.dataset.expires ? Date.parse(n.dataset.expires) : NaN;
  if (Number.isNaN(at)) {
    n.textContent = "";
    return;
  }
  const left = Math.max(0, Math.round((at - Date.now()) / 1000));
  n.textContent = left ? `expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "expired";
  if (!left) {
    card.querySelectorAll<HTMLButtonElement>(".btn").forEach((b) => (b.disabled = true));
    return;
  }
  expiryTimer = window.setTimeout(tickExpiry, 1000);
}

// ------------------------------------------------------------------ click-through areas
let lastRects = "";
function reportRects() {
  if (!visible) return;
  const rects: { x: number; y: number; w: number; h: number; hoverOnly?: boolean }[] = [];
  if (!appearance.island) {
    if (lastRects !== "[]") {
      lastRects = "[]";
      void invoke("island_rects", { rects });
    }
    return;
  }
  const add = (r: DOMRect, pad = 0) => rects.push({ x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 });
  if (mode.mode === "notch") {
    const p = pill.getBoundingClientRect();
    // Retracted, the hover target is the strip at the top edge (a little taller to be easy to find).
    if (notch.classList.contains("open")) add(p);
    else rects.push({ x: p.left, y: 0, w: p.width, h: 12, hoverOnly: true }); // hover opens it; clicks pass through
  } else {
    add(floater.getBoundingClientRect(), 4);
  }
  if (!card.hidden && card.classList.contains("show")) add(card.getBoundingClientRect(), 6);
  const key = JSON.stringify(rects.map((r) => [...[r.x, r.y, r.w, r.h].map(Math.round), r.hoverOnly ? 1 : 0]));
  if (key === lastRects) return;
  lastRects = key;
  void invoke("island_rects", { rects });
}
// The slide changes the pill's box over time: keep the hit area in step with it.
pill.addEventListener("transitionend", reportRects);
card.addEventListener("transitionend", reportRects);

// ------------------------------------------------------------------ hover (told by the app)
let retractTimer = 0;
function setHover(inside: boolean) {
  clearTimeout(retractTimer);
  if (inside) {
    if (!hovering) {
      hovering = true;
      render();
    }
    return;
  }
  retractTimer = window.setTimeout(() => {
    hovering = false;
    const v = voice.myVotes()[0];
    if (queue.length) dismissed = queue[0].id;
    else if (v) dismissed = `v${v.id}`;
    render();
  }, RETRACT_MS);
}

// ------------------------------------------------------------------ drag: float / dock
const hint = document.createElement("div");
hint.className = "dock-hint";
document.body.append(hint);
const inDock = (x: number, y: number) => Math.abs(x + 28 - window.innerWidth / 2) < DOCK.halfWidth && y < DOCK.maxY;

// The lotus is a drag handle first: a single press never opens the console (it's too easy to do
// by accident while dragging). A double-click on it does. Clicks right after a drag are ignored.
const DOUBLE_MS = 400;
let lastTap = { at: 0, x: 0, y: 0 };
let dragEndedAt = 0;
function lotusTap(x: number, y: number) {
  const now = Date.now();
  if (now - lastTap.at < DOUBLE_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < 12) {
    lastTap = { at: 0, x: 0, y: 0 };
    void invoke("island_open_main");
  } else {
    lastTap = { at: now, x, y };
  }
}

function startDrag(e: PointerEvent) {
  if (e.button !== 0) return;
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  const sx = e.clientX;
  const sy = e.clientY;
  let moved = false;
  const move = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
    if (!moved) {
      moved = true;
      dragging = true;
      void invoke("island_drag", { active: true });
    }
    // Dragging the lotus out of the pill detaches it.
    mode = { mode: "floating", x: ev.clientX - 28, y: ev.clientY - 28 };
    hint.classList.toggle("on", inDock(mode.x, mode.y));
    render();
  };
  const up = (ev: PointerEvent) => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
    hint.classList.remove("on");
    if (!moved) {
      if (ev.type === "pointerup") lotusTap(ev.clientX, ev.clientY);
      return;
    }
    dragEndedAt = Date.now();
    lastTap = { at: 0, x: 0, y: 0 };
    dragging = false;
    void invoke("island_drag", { active: false });
    if (mode.mode === "floating") {
      if (inDock(mode.x, mode.y)) mode = { mode: "notch" };
      else mode = { mode: "floating", x: Math.max(0, Math.min(mode.x, window.innerWidth - 56)), y: Math.max(0, Math.min(mode.y, window.innerHeight - 56)) };
    }
    saveMode();
    render();
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
}
sprite.addEventListener("pointerdown", (e) => startDrag(e));
floater.addEventListener("pointerdown", (e) => startDrag(e));
pill.addEventListener("click", (e) => {
  // The text part of the pill opens the console on one click; the lotus needs a double-click.
  if (e.target === sprite || Date.now() - dragEndedAt < DOUBLE_MS) return;
  void invoke("island_open_main");
});

// ------------------------------------------------------------------ decisions
async function decide(a: ApprovalRequested, decision: "approve" | "deny") {
  cardStatus.set(a.id, { text: decision === "approve" ? "Signing approval in the console…" : "Signing denial in the console…", err: false });
  render();
  try {
    await invoke("approval_decision", { id: a.id, payloadHash: a.payload_hash, decision });
    return true;
  } catch (err) {
    cardStatus.set(a.id, { text: String(err), err: true });
    render();
    return false;
  }
}
window.addEventListener("keydown", (e) => {
  // Deny may have a shortcut. Nothing on the keyboard approves.
  if (e.key === "Escape" && queue[0] && !cardStatus.get(queue[0].id)) void decide(queue[0], "deny");
});

function onEvent(ev: GkEvent) {
  voice.onEvent(ev as { type: string });
  switch (ev.type) {
    case "decision":
      feed.unshift({ at: Date.now(), e: ev });
      if (feed.length > FEED_MAX) feed.length = FEED_MAX;
      if (ev.result === "deny") flash("denied", 1800);
      else flash("working", 1600);
      break;
    case "approval_requested":
      if (!queue.some((q) => q.id === ev.id)) queue.push(ev);
      reasonOpen = false;
      break;
    case "approval_resolved": {
      const i = queue.findIndex((q) => q.id === ev.id);
      if (i !== -1) queue.splice(i, 1);
      cardStatus.delete(ev.id);
      flash(ev.result === "approved" ? "approved" : "denied", 2400);
      break;
    }
    case "approval_progress": {
      // My approval counted; another member still has to approve. Say so and retract the card.
      const left = Math.max(1, ev.needed - ev.approvals);
      cardStatus.set(ev.id, { text: `Your approval is in. ${left === 1 ? "One more member needs" : `${left} more members need`} to approve.`, err: false });
      if (queue[0]?.id === ev.id) dismissed = ev.id;
      break;
    }
    case "agent_paused":
      paused = true;
      break;
    case "agent_resumed":
      paused = false;
      break;
    case "error":
      if (ev.id && queue.some((q) => q.id === ev.id)) cardStatus.set(ev.id, { text: ev.error, err: true });
      break;
  }
  render();
}

// ------------------------------------------------------------------ wiring
voice = new IslandVoice({
  render,
  held: () => queue,
  title: (a) => describe(a as ApprovalRequested).title,
  decide: async (a, d) => {
    if (!(await decide(a as ApprovalRequested, d))) throw new Error(cardStatus.get(a.id)?.text ?? "The console couldn't sign this.");
  },
});
voice.setAppearance(appearance);
// The wake phrase (Appearance → Voice): heard offline, it opens the island and starts talking.
// When the console is in front (the island hidden behind it), the console's top-bar voice answers;
// otherwise the island opens and answers.
let consoleTalking = false;
const sendWakeStatus = () => {
  if (!wakeListener) return;
  void emit("karuna://wake-status", { status: wakeListener.status, error: wakeListener.error, phrase: wakeListener.phraseText, heard: wakeListener.lastHeard });
};
wakeListener = new WakeListener(
  () => {
    if (voice.active || consoleTalking) return;
    if (!visible) {
      void emit("karuna://wake", {});
      return;
    }
    void voice.start();
  },
  () => {
    queueMicrotask(render);
    sendWakeStatus();
  },
);
let heardTimer = 0;
wakeListener.onHeard = () => {
  clearTimeout(heardTimer);
  heardTimer = window.setTimeout(sendWakeStatus, 250);
};
void listen("karuna://wake-status-request", () => sendWakeStatus());
void listen<{ active: boolean }>("karuna://console-voice", (e) => {
  consoleTalking = !!e.payload?.active;
  render();
});
wakeListener.set(appearance.wake, appearance.voice && appearance.island);
// Dev only (the design preview): lets dev/island-preview.html play a fake conversation.
if (import.meta.env.DEV) (window as unknown as { __karunaVoice: IslandVoice }).__karunaVoice = voice;
// Which member the console signs as decides which votes are "waiting on you": ask now, and again
// whenever the Gatekeeper reconnects, and every 30 s (the console may load or switch accounts later).
void voice.refreshMember();
setInterval(() => void voice.refreshMember(), 30_000);
// Ctrl+Shift+Space (registered by the app, works from any window) and the pill's mic start or end a conversation.
void listen("voice-hotkey", () => void voice.toggle());
mic.addEventListener("pointerdown", (e) => e.stopPropagation()); // not a drag of the pill
mic.addEventListener("click", (e) => {
  e.stopPropagation();
  void voice.toggle();
});
void listen<GkEvent>("gk-event", (e) => onEvent(e.payload));
void listen<{ connected: boolean }>("gk-status", (e) => {
  connected = e.payload.connected;
  if (connected) void voice.refreshMember();
  if (!connected) {
    queue.length = 0;
    voice.votes.clear();
    cardStatus.clear();
    paused = false; // the Gatekeeper re-sends its pause state when it reconnects
  }
  render();
});
void listen<{ inside: boolean }>("island-hover", (e) => setHover(e.payload.inside));
void listen<Partial<Appearance>>("karuna://appearance", (e) => {
  appearance = parseAppearance(e.payload);
  voice.setAppearance(appearance);
  wakeListener.set(appearance.wake, appearance.voice && appearance.island);
  try {
    localStorage.setItem(APPEAR_KEY, JSON.stringify(appearance));
  } catch {
    /* remembered for next time only */
  }
  applyAppearance();
  if (!appearance.island) hovering = false;
  lastRects = "";
  render();
});
void emit("karuna://appearance-request");
void listen<{ visible: boolean }>("island-visible", (e) => {
  visible = e.payload.visible;
  lastRects = "";
  if (!visible) hovering = false;
  render();
});
window.addEventListener("resize", () => {
  lastRects = "";
  render();
});

void (async () => {
  try {
    const s = await invoke<{ connected: boolean; paused: boolean; pending: ApprovalRequested[]; votes?: OpenVote[] }>("gk_status");
    connected = s.connected;
    paused = s.paused;
    for (const p of s.pending) if (!queue.some((q) => q.id === p.id)) queue.push(p);
    for (const v of s.votes ?? []) voice.votes.set(v.id, v);
  } catch {
    /* not in the app (design preview) */
  }
  initContour();
  buildSprites();
  requestAnimationFrame(drawSprite);
  render();
})();
