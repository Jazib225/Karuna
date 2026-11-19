// Karuna Voice in the console's top bar: the same voice as the island (desktop/src/island/voice.ts),
// with the same tools, spoken-code approvals and waveform. Only the wiring differs: here the
// controller calls the console's own handlers directly (desktop.ts voiceCall), and approvals are
// signed with this console's member key exactly like the Approve button.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { IslandVoice, type HeldRequest, type VoiceCall } from "../../desktop/src/island/voice.ts";
import { WaveRenderer } from "../../desktop/src/island/wave.ts";
import { WakeListener } from "../../desktop/src/island/wake.ts";
import { api, type Proposal, type Snapshot } from "./api.ts";
import { IN_APP, activeWakePhrase, onWakeFromIsland, setWakeState, tellIslandConsoleTalking, voiceCall } from "./desktop.ts";
import { decidePayment, type Signer } from "./signer.ts";

const ZERO_HASH = "0".repeat(64);

/** The DOM builder the shared panel uses (text only: nothing is ever parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const usd = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v < 0.01 && v > 0 ? v.toFixed(4).replace(/0+$/, "") : v.toFixed(2)}` : "";
};
const host = (u: unknown) => {
  try {
    return new URL(String(u)).host;
  } catch {
    return "a website";
  }
};

/** A held request in the island's shape, from the console's snapshot. */
function heldOf(p: Proposal): HeldRequest {
  const kind = p.payload?.kind ?? (p.request.tool === "payment" ? p.request.paymentKind ?? "payment" : p.request.tool);
  return {
    id: p.id, action_type: kind,
    payload: { ...(p.payload ?? {}), to: p.request.to, url: p.request.url, method: p.request.method, amountUsd: p.payload?.amountUsd ?? p.request.amountUsd },
    payload_hash: p.payloadHash ?? ZERO_HASH, reversible: false, agent_reason: p.reason ?? null, expires_at: null,
    agent: p.agentId, why: p.decision.reason ?? null, if_unanswered: p.ifUnanswered ?? null,
  };
}

/** Karuna's own one-line title for a held request (never text an agent wrote). */
function titleOf(a: HeldRequest, s: Snapshot): string {
  const who = s.policy?.agents.find((x) => x.id === a.agent)?.name ?? "An agent";
  const p = a.payload;
  const payee = (addr: unknown) => s.policy?.payees.find((x) => x.account.toLowerCase() === String(addr ?? "").toLowerCase())?.name ?? null;
  switch (a.action_type) {
    case "transfer":
      return `${who} wants to pay ${usd(p.amountUsd)} to ${payee(p.to) ?? "an address that isn't a saved payee"}`;
    case "x402":
      return `${who} wants to buy data for ${usd(p.amountUsd)} from ${host(p.url)}`;
    case "http": {
      const m = String(p.method ?? "GET").toUpperCase();
      return `${who} wants to ${m === "GET" || m === "HEAD" ? "open" : m === "DELETE" ? "delete something on" : "send data to"} ${host(p.url)}`;
    }
    case "shell":
      return `${who} wants to run a command`;
    case "file":
      return `${who} wants to change a file`;
    case "message":
      return `${who} wants to message another agent`;
    default:
      return `${who} needs your approval`;
  }
}

export function TopVoice({ s, me }: { s: Snapshot; me: Signer }) {
  const [cfg, setCfg] = useState<{ conversation: boolean } | null>(null);
  useEffect(() => {
    api<{ conversation: boolean }>("/voice/config").then(setCfg).catch(() => setCfg(null));
  }, []);
  const [tick, setTick] = useState(0);
  const sRef = useRef(s);
  sRef.current = s;
  const dharma = s.org.dharma?.address as Address | undefined;

  const voice = useMemo(() => {
    const call: VoiceCall = <T,>(tool: string, args: Record<string, unknown> = {}) => voiceCall(tool, args) as Promise<T>;
    return new IslandVoice(
      {
        render: () => setTick((n) => n + 1),
        held: () => sRef.current.proposals.filter((p) => p.status === "pending").map(heldOf),
        title: (a) => titleOf(a, sRef.current),
        decide: async (a, d) => {
          if (!dharma) throw new Error("The organization isn't loaded yet.");
          const r = await decidePayment(me, dharma, a.id, a.payload_hash, d === "approve");
          if (r.error) throw new Error(r.error);
        },
      },
      call,
    );
  }, [me, dharma]);

  // Who this console is, and whether voice is set up. Alerts aren't read aloud here (the island does that).
  useEffect(() => {
    voice.setAppearance({ voice: !!cfg?.conversation, readAloud: false, member: me.address.toLowerCase() });
  }, [voice, cfg, me]);

  // Keep the controller's picture of what's waiting in step with the console's snapshot.
  const known = useRef<{ held: Set<string>; votes: Set<number> } | null>(null);
  useEffect(() => {
    const held = new Set(s.proposals.filter((p) => p.status === "pending").map((p) => p.id));
    const open = (s.policy?.proposals ?? []).filter((g) => g.status === "open" || g.status === "queued");
    const first = !known.current;
    const prev = known.current ?? { held: new Set<string>(), votes: new Set<number>() };
    for (const p of s.proposals) {
      if (p.status === "pending" && !prev.held.has(p.id)) voice.onEvent({ type: "approval_requested", ...heldOf(p) } as never);
      if (p.status !== "pending" && prev.held.has(p.id)) voice.onEvent({ type: "approval_resolved", id: p.id, result: p.status === "denied" ? "denied" : p.status === "failed" ? "failed" : "approved" });
    }
    for (const g of open) voice.onEvent({ type: "vote_requested", id: g.id, description: g.description, core: g.core, yes: g.yes, no: g.no, needed: g.needed, status: g.status, voters: g.voters.map((v) => v.toLowerCase()), eta: g.eta } as never);
    for (const id of prev.votes) if (!open.some((g) => g.id === id)) voice.onEvent({ type: "vote_resolved", id });
    known.current = { held, votes: new Set(open.map((g) => g.id)) };
    void first;
  }, [s, voice]);

  // The waveform follows Karuna's voice while a conversation is on.
  const wave = useMemo(() => new WaveRenderer(), []);
  useEffect(() => {
    if (!voice.active) return;
    let raf = 0;
    const loop = (now: number) => {
      wave.setLevel(voice.waveLevel());
      wave.frame(now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [voice, wave, voice.active]);

  // In a normal browser tab Ctrl+Shift+Space talks here (in the desktop app it's the island's).
  useEffect(() => {
    if (IN_APP || !cfg?.conversation) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === "Space") {
        e.preventDefault();
        void voice.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [voice, cfg]);

  // The wake phrase (Appearance → Voice), in a normal browser tab. In the desktop app the island
  // listens instead, so the two never both answer.
  const wake = useMemo(() => {
    if (IN_APP) return null;
    const w = new WakeListener(
      () => void (voice.active ? undefined : voice.start()),
      () => setWakeState({ status: w.status, error: w.error, phrase: w.phraseText, heard: w.lastHeard }),
    );
    w.onHeard = () => setWakeState({ status: w.status, error: w.error, phrase: w.phraseText, heard: w.lastHeard });
    return w;
  }, [voice]);
  // Desktop app: the island listens, and hands the wake to this console when it's in front.
  useEffect(() => onWakeFromIsland(() => void (voice.active ? undefined : voice.start())), [voice]);
  useEffect(() => tellIslandConsoleTalking(voice.active), [voice.active]);
  useEffect(() => {
    if (!wake) return;
    const apply = () => wake.set(activeWakePhrase(), !!cfg?.conversation);
    apply();
    window.addEventListener("karuna:wake-phrase", apply);
    return () => {
      window.removeEventListener("karuna:wake-phrase", apply);
      wake.stop();
    };
  }, [wake, cfg]);
  // The conversation needs the mic: let go of it while talking, take it back after.
  useEffect(() => {
    if (!wake) return;
    if (voice.active) wake.pause();
    else wake.resume();
  }, [wake, voice, voice.active, tick]);

  // The panel: the island's own, mounted under the button while talking (or to show an error).
  const panel = useRef<HTMLDivElement>(null);
  const showPanel = voice.active || !!voice.error;
  useEffect(() => {
    if (showPanel && panel.current) panel.current.replaceChildren(voice.panel(el));
  }, [showPanel, tick, voice]);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!voice.error || voice.active) return;
    const close = (e: PointerEvent) => {
      if (wrap.current?.contains(e.target as Node)) return;
      voice.error = null;
      setTick((n) => n + 1);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [voice, voice.error, voice.active]);

  if (!cfg?.conversation) return null;
  return (
    <div className="top-voice" ref={wrap}>
      <button
        type="button"
        className={`pill-mic top-mic${voice.active ? " on" : ""}`}
        aria-label={voice.active ? "End the conversation" : "Talk to Karuna"}
        title={voice.active ? "End the conversation" : `Talk to Karuna${IN_APP ? "" : " (Ctrl+Shift+Space)"}`}
        onClick={() => void voice.toggle()}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" />
        </svg>
        <canvas className="wave" aria-hidden="true" />
      </button>
      {showPanel && <div className="voice-pop" ref={panel} role="dialog" aria-label="Karuna Voice" />}
    </div>
  );
}
