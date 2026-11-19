// Creates (or updates) Karuna's ElevenLabs voice agent from code, so it's reproducible instead of a
// dashboard setting: the system prompt, the voice, and the client tools the island runs.
//
//   pnpm --dir gatekeeper voice:agent
//
// Needs ELEVENLABS_API_KEY in the repo's .env (ELEVENLABS_VOICE_ID optional). Prints the agent id
// to put in .env as ELEVENLABS_AGENT_ID. Run it again after changing voice-tools.ts: it updates the
// same agent (ELEVENLABS_AGENT_ID) and the same tools (matched by name).
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ELEVEN_API, voiceConfigFromEnv } from "../src/voice.ts";
import { VOICE_FIRST_MESSAGE, VOICE_PROMPT, VOICE_TOOLS } from "../src/voice-tools.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env"), quiet: true });
const cfg = voiceConfigFromEnv();
if (!cfg.apiKey) {
  console.error("Add ELEVENLABS_API_KEY=... to the repo's .env first (elevenlabs.io → Developers → API keys).");
  process.exit(1);
}
const headers = { "xi-api-key": cfg.apiKey, "content-type": "application/json" };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${ELEVEN_API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const toolConfig = (t: (typeof VOICE_TOOLS)[number]) => ({
  type: "client",
  name: t.name,
  description: t.description,
  parameters: t.parameters ?? { type: "object", properties: {}, required: [] },
  expects_response: true,
  response_timeout_secs: 20,
});

/** Workspace tools by name (so re-running updates instead of duplicating). */
async function existingTools(): Promise<Map<string, string>> {
  try {
    const r = await call<{ tools?: { id: string; tool_config?: { name?: string } }[] }>("GET", "/v1/convai/tools");
    return new Map((r.tools ?? []).filter((t) => t.tool_config?.name).map((t) => [t.tool_config!.name!, t.id]));
  } catch {
    return new Map();
  }
}

async function main() {
  const have = await existingTools();
  const ids: string[] = [];
  let inline = false;
  for (const t of VOICE_TOOLS) {
    try {
      const known = have.get(t.name);
      if (known) {
        await call("PATCH", `/v1/convai/tools/${known}`, { tool_config: toolConfig(t) });
        ids.push(known);
        console.log(`tool ${t.name.padEnd(14)} updated  ${known}`);
      } else {
        const r = await call<{ id: string }>("POST", "/v1/convai/tools", { tool_config: toolConfig(t) });
        ids.push(r.id);
        console.log(`tool ${t.name.padEnd(14)} created  ${r.id}`);
      }
    } catch (e) {
      // Older accounts/APIs: fall back to tools defined inside the agent (deprecated but accepted).
      console.warn(`Couldn't register tools separately (${e instanceof Error ? e.message.split("\n")[0] : e}); defining them inside the agent instead.`);
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
      ...(cfg.voiceId ? { voice_id: cfg.voiceId } : {}),
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
  if (cfg.agentId) {
    await call("PATCH", `/v1/convai/agents/${cfg.agentId}`, { name: "Karuna Voice", conversation_config });
    console.log(`\nUpdated agent ${cfg.agentId}. Nothing to change in .env.`);
  } else {
    const r = await call<{ agent_id: string }>("POST", "/v1/convai/agents/create", { name: "Karuna Voice", conversation_config });
    console.log(`\nCreated the Karuna Voice agent. Add this line to the repo's .env, then restart the Gatekeeper:\n\nELEVENLABS_AGENT_ID=${r.agent_id}\n`);
  }
  if (!cfg.voiceId) console.log("Tip: add ELEVENLABS_VOICE_ID (any voice from elevenlabs.io → Voices) for spoken alerts, then run this again so the agent uses it too.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
