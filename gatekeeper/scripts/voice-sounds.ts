// Generates the island's chimes once with ElevenLabs Sound Effects and saves them next to the
// console's other public assets (web/public/sounds/, which the island serves too). Without these
// files the island plays simple built-in tones instead, so this step is optional.
//
//   pnpm --dir gatekeeper voice:sounds
import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ELEVEN_API, voiceConfigFromEnv } from "../src/voice.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env"), quiet: true });
const { apiKey } = voiceConfigFromEnv();
if (!apiKey) {
  console.error("Add ELEVENLABS_API_KEY=... to the repo's .env first.");
  process.exit(1);
}

const SOUNDS: Record<string, string> = {
  "needs-you": "A soft, clear two-note glass chime asking for attention, calm and modern, very short",
  approved: "A gentle rising bright chime confirming success, warm and minimal, very short",
  denied: "A soft low muted double tap, neutral and calm, signaling something was declined, very short",
  frozen: "A firm descending three-note alert tone, serious but not alarming, like a system lock, short",
};

const out = resolve(here, "../../web/public/sounds");
mkdirSync(out, { recursive: true });
for (const [name, text] of Object.entries(SOUNDS)) {
  const r = await fetch(`${ELEVEN_API}/v1/sound-generation?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ text, duration_seconds: name === "frozen" ? 1.5 : 1, prompt_influence: 0.6 }),
  });
  if (!r.ok) {
    console.error(`${name}: ${r.status} ${(await r.text()).slice(0, 300)}`);
    process.exit(1);
  }
  writeFileSync(resolve(out, `${name}.mp3`), Buffer.from(await r.arrayBuffer()));
  console.log(`saved web/public/sounds/${name}.mp3`);
}
