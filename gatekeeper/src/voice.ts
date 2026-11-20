// Karuna Voice: the Gatekeeper's side of talking to the island (docs/VOICE_PLAN.md).
//
// The ElevenLabs key stays here, like every other key: the desktop app only ever gets a one-time
// conversation token (GET /voice/session) or audio Karuna made (POST /voice/speak).
//
// /voice/speak never takes free text. It speaks a sentence built from Karuna's own fields for one
// held request or one open vote, so nobody (an agent, a page, the voice model) can make Karuna say
// arbitrary words. The agent's own reason is only read on request, introduced as its words.
import type { Proposal } from "./gatekeeper.ts";

export const ELEVEN_API = "https://api.elevenlabs.io";
/** ElevenLabs' low-latency model, for short spoken alerts. */
export const DEFAULT_TTS_MODEL = "eleven_flash_v2_5";
/** Longest agent reason read aloud (characters); the rest is on the card. */
const REASON_SPOKEN_MAX = 300;
/** Speaking pace for alerts (ElevenLabs allows 0.7–1.2; 1 is normal). */
export const ALERT_SPEED = 0.9;
/** The pause between sentences in a spoken alert. */
export const SENTENCE_PAUSE = '<break time="0.6s" />';

/** Put a short pause after each sentence (ElevenLabs break tags), so alerts aren't rushed. */
export function withPauses(text: string): string {
  return text.replace(/([.?!])\s+(?=\S)/g, `$1 ${SENTENCE_PAUSE} `);
}

export interface VoiceConfig {
  apiKey: string | null;
  agentId: string | null;
  voiceId: string | null;
  ttsModel: string;
}

export function voiceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const v = (k: string) => env[k]?.trim() || null;
  return { apiKey: v("ELEVENLABS_API_KEY"), agentId: v("ELEVENLABS_AGENT_ID"), voiceId: v("ELEVENLABS_VOICE_ID"), ttsModel: v("ELEVENLABS_TTS_MODEL") ?? DEFAULT_TTS_MODEL };
}

export class VoiceError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Names Karuna knows (set by members), used instead of raw ids and addresses. */
export interface VoiceNames {
  agent: (id: string) => string;
  payee: (address: string) => string | null;
}

/** An open Dharma vote, as Gatekeeper.openVotes() returns it. */
export interface OpenVote {
  id: number; description: string; core: boolean; yes: number; no: number; needed: number; status: string; voters: string[];
}

// ---------------------------------------------------------------- sentences (Karuna's fields only)

/** Dollars the way a person says them: "40 dollars", "5 cents", "1 dollar 50". */
export function spokenUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "an unknown amount";
  const cents = Math.round(n * 100);
  if (n > 0 && cents === 0) return "less than a cent";
  const d = Math.floor(cents / 100);
  const c = cents % 100;
  if (d === 0) return `${c} cent${c === 1 ? "" : "s"}`;
  const dollars = `${d.toLocaleString("en-US")} dollar${d === 1 ? "" : "s"}`;
  return c ? `${dollars} ${c}` : dollars;
}

/** Only letters, digits, dots and dashes of a host: nothing an agent wrote is read as words. */
function spokenHost(url: string | undefined): string {
  try {
    const h = new URL(String(url)).hostname.toLowerCase().replace(/^www\./, "");
    return /^[a-z0-9.-]{1,80}$/.test(h) ? h : "a website";
  } catch {
    return "a website";
  }
}

/** A name a member gave: plain words only, and short. */
const spokenName = (s: string | null | undefined, fallback: string) => {
  const t = String(s ?? "").replace(/[^\p{L}\p{N} .,'&-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return t || fallback;
};

/**
 * "Research agent wants to pay 40 dollars to Acme Data. It's over its daily cap. Approve or deny?"
 * Built from the held request's Gatekeeper fields. Free text an agent controls (a shell command, a
 * file path, a message body, a URL path) is never read out: only what kind of action it is.
 */
export function heldSentence(p: Readonly<Proposal>, names: VoiceNames, approvalsNeeded = 1): string {
  const who = spokenName(names.agent(p.agentId), "An agent");
  const pay = p.payload;
  let what: string;
  if (pay?.kind === "transfer") {
    const to = names.payee(pay.to);
    what = `wants to pay ${spokenUsd(pay.amountUsd)} to ${to ? spokenName(to, "an unknown payee") : "an address that isn't a saved payee"}`;
  } else if (pay?.kind === "x402") {
    const seller = names.payee(pay.seller);
    what = `wants to buy data for ${spokenUsd(pay.amountUsd)} from ${seller ? spokenName(seller, spokenHost(pay.url)) : spokenHost(pay.url)}`;
  } else {
    const r = p.request;
    const m = (r.method ?? "GET").toUpperCase();
    switch (r.tool) {
      case "http":
        what = m === "GET" || m === "HEAD" ? `wants to open ${spokenHost(r.url)}` : m === "DELETE" ? `wants to delete something on ${spokenHost(r.url)}` : `wants to send data to ${spokenHost(r.url)}`;
        break;
      case "shell":
        what = "wants to run a command";
        break;
      case "file":
        what = r.fileOp === "read" ? "wants to read a file" : "wants to change a file";
        break;
      case "message":
        what = `wants to message ${spokenName(names.agent(String((p.action as { to?: string }).to ?? "")), "another agent")}`;
        break;
      default:
        what = "needs your approval";
    }
  }
  const why = heldReason(p);
  const two = approvalsNeeded > 1 ? ` It needs ${approvalsNeeded} approvals.` : "";
  return `${who} ${what}.${why ? ` ${why}` : ""}${two} Approve or deny?`;
}

/** Why it was held, from the matching rule, in a few words. */
function heldReason(p: Readonly<Proposal>): string {
  const id = p.decision.ruleId ?? "";
  if (id === "payment-approval") return "It's over its limit.";
  if (id.startsWith("level-")) return "Its trust level doesn't cover this yet.";
  if (/destructive/.test(id)) return "It deletes files.";
  if (/package/.test(id)) return "It installs a package.";
  if (/write/.test(id)) return "It writes a file.";
  if (/http-mutation|post/.test(id)) return "It changes something on a website.";
  if (/message/.test(id)) return "Messages between agents need approval.";
  return "A rule says a member must approve it.";
}

/** The agent's own reason, framed as its words (never Karuna's), or a sentence saying there is none. */
export function reasonSentence(p: Readonly<Proposal>, names: VoiceNames): string {
  const who = spokenName(names.agent(p.agentId), "The agent");
  // No markup from the agent (it could add its own pauses or tags): plain words only.
  const text = String(p.reason ?? "").replace(/<[^>]*>/g, " ").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return `${who} didn't give a reason.`;
  const cut = text.length > REASON_SPOKEN_MAX ? `${text.slice(0, REASON_SPOKEN_MAX)}, and more on the card` : text;
  return `In the agent's words, which Karuna hasn't checked: ${cut}`;
}

/** "Vote: Set Coding agent to Level 2. 1 of 2 votes so far." */
export function voteSentence(v: OpenVote): string {
  const desc = spokenName(v.description, "a change").replace(/\.$/, "");
  const core = v.core ? " It's a core change: every member must vote yes." : "";
  return `New vote: ${desc}. ${v.yes} of ${v.needed} yes votes so far.${core} Vote yes or no?`;
}

// ---------------------------------------------------------------- ElevenLabs calls

type Fetch = typeof fetch;

/** ElevenLabs' own one-line reason (e.g. "Free users cannot use library voices via the API"), or "." */
async function elevenReason(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { detail?: { message?: unknown } | string };
    const m = typeof j.detail === "string" ? j.detail : j.detail?.message;
    return typeof m === "string" && m ? `: ${m.replace(/https?:\/\/\S+/g, "").slice(0, 200)}` : ".";
  } catch {
    return ".";
  }
}

export class Voice {
  /** The voice's name, when it was picked in the console. */
  voiceName: string | null = null;
  /** True when the key comes from the Gatekeeper's .env (then the console can't replace it). */
  fromEnv: boolean;
  constructor(public config: VoiceConfig, readonly fetchFn: Fetch = fetch) {
    this.fromEnv = !!config.apiKey;
  }

  /** Switch to a key, agent and voice set up from the console (or clear them). Takes effect at once. */
  configure(c: { apiKey: string | null; agentId: string | null; voiceId: string | null; voiceName?: string | null }) {
    this.config = { ...this.config, apiKey: c.apiKey, agentId: c.agentId, voiceId: c.voiceId };
    this.voiceName = c.voiceName ?? null;
  }

  /** What the console needs to show the Voice switch. */
  status() {
    return {
      configured: !!this.config.apiKey, conversation: !!(this.config.apiKey && this.config.agentId), alerts: !!(this.config.apiKey && this.config.voiceId),
      fromEnv: this.fromEnv, voiceId: this.config.voiceId, voiceName: this.voiceName,
    };
  }

  private key(): string {
    if (!this.config.apiKey) throw new VoiceError("Voice isn't set up: add an ElevenLabs API key in Preferences → Voice.", 503);
    return this.config.apiKey;
  }

  /** A one-time WebRTC conversation token for the island (the key never leaves the Gatekeeper). */
  async conversationToken(): Promise<{ token: string }> {
    const key = this.key();
    if (!this.config.agentId) throw new VoiceError("Voice isn't set up: add an ElevenLabs API key in Preferences → Voice.", 503);
    const r = await this.fetchFn(`${ELEVEN_API}/v1/convai/conversation/token?agent_id=${encodeURIComponent(this.config.agentId)}`, { headers: { "xi-api-key": key } });
    if (!r.ok) throw new VoiceError(`ElevenLabs refused the conversation (${r.status})${await elevenReason(r)}`, 502);
    const j = (await r.json()) as { token?: unknown };
    if (typeof j.token !== "string" || !j.token) throw new VoiceError("ElevenLabs returned no conversation token.", 502);
    return { token: j.token };
  }

  /** Text to speech (streaming endpoint, low-latency model), as one mp3. Only Karuna's sentences. */
  async speak(text: string): Promise<Buffer> {
    const key = this.key();
    if (!this.config.voiceId) throw new VoiceError("Voice alerts need a voice: pick one in Preferences → Voice.", 503);
    const r = await this.fetchFn(`${ELEVEN_API}/v1/text-to-speech/${encodeURIComponent(this.config.voiceId)}/stream?output_format=mp3_44100_64`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text: withPauses(text), model_id: this.config.ttsModel, voice_settings: { speed: ALERT_SPEED } }),
    });
    if (!r.ok) throw new VoiceError(`ElevenLabs couldn't speak this (${r.status})${await elevenReason(r)}`, 502);
    return Buffer.from(await r.arrayBuffer());
  }
}
