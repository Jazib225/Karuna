// Creates (or updates) Karuna's ElevenLabs voice agent from code, so it's reproducible instead of a
// dashboard setting: the system prompt, the voice, and the client tools the island runs.
//
//   pnpm --dir gatekeeper voice:agent
//
// For a key kept in the repo's .env (ELEVENLABS_API_KEY; ELEVENLABS_VOICE_ID optional). Prints the
// agent id to put in .env as ELEVENLABS_AGENT_ID. Run it again after changing voice-tools.ts: it
// updates the same agent (ELEVENLABS_AGENT_ID) and the same tools (matched by name).
// Without .env, a member pastes the key in the console (Preferences → Voice), which does the same.
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { voiceConfigFromEnv } from "../src/voice.ts";
import { setupVoiceAgent } from "../src/voice-setup.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env"), quiet: true });
const cfg = voiceConfigFromEnv();
if (!cfg.apiKey) {
  console.error("Add ELEVENLABS_API_KEY=... to the repo's .env first (elevenlabs.io → Developers → API keys).");
  process.exit(1);
}

try {
  const id = await setupVoiceAgent(cfg.apiKey, { agentId: cfg.agentId, voiceId: cfg.voiceId, log: (s) => console.log(s) });
  if (id === cfg.agentId) console.log(`\nUpdated agent ${id}. Nothing to change in .env.`);
  else console.log(`\nCreated the Karuna Voice agent. Add this line to the repo's .env, then restart the Gatekeeper:\n\nELEVENLABS_AGENT_ID=${id}\n`);
  if (!cfg.voiceId) console.log("Tip: add ELEVENLABS_VOICE_ID (any voice from elevenlabs.io → Voices) for spoken alerts, then run this again so the agent uses it too.");
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
