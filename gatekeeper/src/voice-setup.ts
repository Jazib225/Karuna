// Setting up Karuna Voice from a member's ElevenLabs key, so nobody edits .env or runs a script:
// the console sends the key once, the Gatekeeper checks it, picks a voice, creates (or updates)
// the "Karuna Voice" agent with Karuna's prompt and client tools, and keeps all three on this
// computer. The key is encrypted at rest with the data dir's secrets.key and never sent back out.
// `pnpm --dir gatekeeper voice:agent` runs the same agent setup for a key kept in .env.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ELEVEN_API, VoiceError } from "./voice.ts";
import { VOICE_FIRST_MESSAGE, VOICE_PROMPT, VOICE_TOOLS } from "./voice-tools.ts";

type Fetch = typeof fetch;

export interface SavedVoice {
  apiKey: string;
  agentId: string;
  voiceId: string | null;
  voiceName: string | null;
}

/** voice.json in the data dir: the key AES-256-GCM encrypted, the agent and voice in the clear. */
export class VoiceStore {
  private readonly file: string;
  private readonly keyFile: string;
  constructor(dataDir: string) {
    this.file = join(dataDir, "voice.json");
    this.keyFile = join(dataDir, "secrets.key");
  }

  private key(): Buffer {
    if (!existsSync(this.keyFile)) writeFileSync(this.keyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
    return Buffer.from(readFileSync(this.keyFile, "utf8").trim(), "base64");
  }

  load(): SavedVoice | null {
    if (!existsSync(this.file)) return null;
    try {
      const s = JSON.parse(readFileSync(this.file, "utf8")) as { iv: string; tag: string; data: string; agentId: string; voiceId: string | null; voiceName: string | null };
      const d = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(s.iv, "base64"));
      d.setAuthTag(Buffer.from(s.tag, "base64"));
      const apiKey = Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]).toString("utf8");
      return { apiKey, agentId: s.agentId, voiceId: s.voiceId ?? null, voiceName: s.voiceName ?? null };
    } catch {
      return null;
    }
  }

  save(v: SavedVoice) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key(), iv);
    const data = Buffer.concat([c.update(v.apiKey, "utf8"), c.final()]);
    const out = { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64"), agentId: v.agentId, voiceId: v.voiceId, voiceName: v.voiceName };
    writeFileSync(this.file, JSON.stringify(out, null, 2), { mode: 0o600 });
  }

  clear() {
    rmSync(this.file, { force: true });
  }
}

/** ElevenLabs' own one-line reason for a refusal, or "". */
async function reason(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { detail?: { message?: string } | string };
    const m = typeof j.detail === "string" ? j.detail : j.detail?.message;
    return m ? `: ${String(m).slice(0, 200)}` : "";
  } catch {
    return "";
  }
}

function caller(apiKey: string, fetchFn: Fetch) {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetchFn(`${ELEVEN_API}${path}`, {
      method,
      headers: { "xi-api-key": apiKey, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 401) throw new VoiceError("ElevenLabs didn't accept that API key.", 400);
    if (!r.ok) throw new VoiceError(`ElevenLabs refused ${method} ${path.split("?")[0]} (${r.status})${await reason(r)}`, 502);
    const text = await r.text();
    return (text ? JSON.parse(text) : {}) as T;
  };
}

export interface VoiceOption {
  id: string;
  name: string;
}

/** The voices this key can speak with through the API. ElevenLabs' own (premade) voices come first:
 *  free accounts can use those, while voices saved from the library need a paid plan. */
export async function listVoices(apiKey: string, fetchFn: Fetch = fetch): Promise<VoiceOption[]> {
  const r = await caller(apiKey, fetchFn)<{ voices?: { voice_id: string; name: string; category?: string }[] }>("GET", "/v1/voices");
  const all = r.voices ?? [];
  const rank = (c?: string) => (c === "premade" ? 0 : c === "cloned" || c === "generated" || c === "professional" ? 1 : 2);
  return [...all].sort((a, b) => rank(a.category) - rank(b.category)).map((v) => ({ id: v.voice_id, name: v.name }));
}

const toolConfig = (t: (typeof VOICE_TOOLS)[number]) => ({
  type: "client",
  name: t.name,
  description: t.description,
  parameters: t.parameters ?? { type: "object", properties: {}, required: [] },
  expects_response: true,
  response_timeout_secs: 20,
});

/** Create or update the "Karuna Voice" agent on this key's account: Karuna's prompt, its client
 *  tools (registered once by name, updated after), and the chosen voice. Returns the agent id. */
export async function setupVoiceAgent(apiKey: string, opts: { agentId?: string | null; voiceId?: string | null; log?: (s: string) => void } = {}, fetchFn: Fetch = fetch): Promise<string> {
  const call = caller(apiKey, fetchFn);
  const log = opts.log ?? (() => {});
  let have = new Map<string, string>();
  try {
    const r = await call<{ tools?: { id: string; tool_config?: { name?: string } }[] }>("GET", "/v1/convai/tools");
    have = new Map((r.tools ?? []).filter((t) => t.tool_config?.name).map((t) => [t.tool_config!.name!, t.id]));
  } catch {
    /* listed below as created */
  }
  const ids: string[] = [];
  let inline = false;
  for (const t of VOICE_TOOLS) {
    try {
      const known = have.get(t.name);
      if (known) {
        await call("PATCH", `/v1/convai/tools/${known}`, { tool_config: toolConfig(t) });
        ids.push(known);
        log(`tool ${t.name.padEnd(14)} updated  ${known}`);
      } else {
        const r = await call<{ id: string }>("POST", "/v1/convai/tools", { tool_config: toolConfig(t) });
        ids.push(r.id);
        log(`tool ${t.name.padEnd(14)} created  ${r.id}`);
      }
    } catch (e) {
      if (e instanceof VoiceError && /API key/.test(e.message)) throw e;
      // Older accounts/APIs: tools defined inside the agent (deprecated but accepted).
      log(`Couldn't register tools separately (${e instanceof Error ? e.message.split("\n")[0] : e}); defining them inside the agent instead.`);
      inline = true;
      break;
    }
  }

  const prompt = inline ? { prompt: VOICE_PROMPT, tools: VOICE_TOOLS.map(toolConfig) } : { prompt: VOICE_PROMPT, tool_ids: ids };
  const conversation_config = {
    agent: {
      first_message: VOICE_FIRST_MESSAGE, language: "en", prompt,
      // Let the greeting finish; after that the member can always cut in.
      disable_first_message_interruptions: true,
      max_conversation_duration_message: "That's the end of this session. Press Control Shift Space to start again.",
    },
    tts: {
      ...(opts.voiceId ? { voice_id: opts.voiceId } : {}),
      // ElevenLabs requires English agents to use a turbo or Flash v2 model (not v2.5). Flash v2 also
      // honours speed and the <break> pauses the prompt asks for.
      model_id: "eleven_flash_v2", speed: 0.88, stability: 0.6,
    },
    turn: {
      // Wait for the member to really finish before answering, and don't treat small sounds or
      // fillers as an interruption. Real speech still cuts Karuna off and it listens.
      turn_eagerness: "patient",
      turn_timeout: 10,
      interruption_ignore_terms: ["ok", "okay", "yeah", "yes", "yep", "uh huh", "mm", "mhm", "hmm", "right", "sure", "got it", "cool", "nice"],
      merge_with_default_ignore_terms: true,
    },
    // Short sessions keep it to what's on screen; it ends itself after five minutes.
    conversation: { max_duration_seconds: 300 },
  };
  if (opts.agentId) {
    try {
      await call("PATCH", `/v1/convai/agents/${opts.agentId}`, { name: "Karuna Voice", conversation_config });
      return opts.agentId;
    } catch (e) {
      if (!(e instanceof VoiceError) || !/\(404\)/.test(e.message)) throw e;
      log(`Agent ${opts.agentId} is gone; creating a new one.`);
    }
  }
  const r = await call<{ agent_id: string }>("POST", "/v1/convai/agents/create", { name: "Karuna Voice", conversation_config });
  return r.agent_id;
}
