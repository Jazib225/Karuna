// The wake phrase: listens on this computer, offline, for the phrase the member picked (Appearance →
// Voice → Wake phrase), and starts a conversation when it hears it.
//
// Speech is recognized locally by a small Vosk model (web/public/models/vosk-small-en.tar.gz, made
// by `pnpm --dir desktop wake:model`): no audio leaves the computer while it waits. What it hears
// is matched by sound, not spelling (wake-match.ts), because the small model doesn't know names.
// The mic is released while a conversation is on (the conversation needs it) and taken back after.
import type { KaldiRecognizer, Model } from "vosk-browser";
import { heardPhrase } from "./wake-match.ts";

export const WAKE_MODEL_URL = "/models/vosk-small-en.tar.gz";
export type WakeStatus = "off" | "loading" | "listening" | "paused" | "error";

let modelPromise: Promise<Model> | null = null;
/** The model loads once per page (about 40 MB, from this computer) and is kept for later starts. */
async function loadModel(): Promise<Model> {
  modelPromise ??= import("vosk-browser")
    .then((mod) => {
      // The package is CommonJS: bundlers hand it over either as named exports or as `default`.
      const m = mod as unknown as { createModel?: typeof import("vosk-browser").createModel; default?: { createModel: typeof import("vosk-browser").createModel } };
      const createModel = m.createModel ?? m.default?.createModel;
      if (!createModel) throw new Error("speech engine didn't load");
      return createModel(WAKE_MODEL_URL, -1);
    })
    .catch((e) => {
      modelPromise = null;
      throw e;
    });
  return modelPromise;
}

export class WakeListener {
  status: WakeStatus = "off";
  error: string | null = null;
  /** What it heard last (for the status under the setting: helps see a misheard phrase). */
  lastHeard = "";
  private phrase = "";
  private want = false;
  private rec: KaldiRecognizer | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private lastFire = 0;
  private starting: Promise<void> | null = null;

  /** Called with each new thing it heard (shown under the setting, so a misheard phrase is visible). */
  onHeard?: (text: string) => void;

  constructor(
    private readonly onWake: () => void,
    private readonly onStatus: () => void = () => undefined,
  ) {}

  get phraseText() {
    return this.phrase;
  }

  /** Listen for this phrase ("" = off). Safe to call again: it only changes what's needed. */
  set(phrase: string, on: boolean) {
    this.phrase = phrase.trim();
    const want = on && this.phrase.length > 0;
    if (want === this.want) return;
    this.want = want;
    if (want) void this.start();
    else this.stop();
  }

  private setStatus(s: WakeStatus, error: string | null = null) {
    this.status = s;
    this.error = error;
    this.onStatus();
  }

  private async start() {
    if (this.starting || this.rec) return this.starting ?? undefined;
    this.starting = (async () => {
      this.setStatus("loading");
      try {
        const model = await loadModel();
        if (!this.want) return this.setStatus("off");
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false });
        if (!this.want) {
          stream.getTracks().forEach((t) => t.stop());
          return this.setStatus("off");
        }
        const ctx = new AudioContext();
        const rec = new model.KaldiRecognizer(ctx.sampleRate);
        rec.on("partialresult", (m) => this.heard((m as { result: { partial: string } }).result.partial));
        rec.on("result", (m) => this.heard((m as { result: { text: string } }).result.text));
        // ScriptProcessor is old but works everywhere this runs; it only forwards samples to the
        // recognizer (its output is silent).
        const node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (e) => {
          try {
            rec.acceptWaveform(e.inputBuffer);
          } catch {
            /* a dropped chunk: keep listening */
          }
        };
        ctx.createMediaStreamSource(stream).connect(node);
        node.connect(ctx.destination);
        Object.assign(this, { stream, ctx, rec, node });
        // A page that starts audio without a click gets a paused AudioContext, and a paused one never
        // delivers sound. Ask to run now; if the browser still says no, run on the next click or key.
        await ctx.resume().catch(() => undefined);
        if (ctx.state !== "running") {
          const kick = () => void ctx.resume().then(() => ctx.state === "running" && this.setStatus("listening"));
          window.addEventListener("pointerdown", kick, { once: true });
          window.addEventListener("keydown", kick, { once: true });
          this.setStatus("paused", "Click anywhere in Karuna once to start listening.");
          return;
        }
        this.setStatus("listening");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.release();
        this.setStatus(
          "error",
          /404|fetch|load/i.test(msg)
            ? "The wake-phrase model isn't installed. Run: pnpm --dir desktop wake:model"
            : /permission|notallowed|denied/i.test(msg)
              ? "Karuna can't use the microphone. Check Windows Settings → Privacy → Microphone."
              : `Wake phrase stopped: ${msg}`,
        );
      }
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private heard(text: string) {
    if (!text || !this.want) return;
    if (text !== this.lastHeard) {
      this.lastHeard = text;
      this.onHeard?.(text);
    }
    // A phrase is heard again in the next partial results: one wake per few seconds.
    if (Date.now() - this.lastFire < 4000) return;
    if (!heardPhrase(this.phrase, text)) return;
    this.lastFire = Date.now();
    this.onWake();
  }

  /** Let go of the mic (the conversation needs it). `resume()` takes it back. */
  pause() {
    if (!this.rec && !this.starting) return;
    this.release();
    if (this.status !== "error") this.setStatus(this.want ? "paused" : "off");
  }

  resume() {
    if (this.want && !this.rec) void this.start();
  }

  stop() {
    this.want = false;
    this.release();
    this.setStatus("off");
  }

  private release() {
    try {
      this.node?.disconnect();
      this.rec?.remove();
      this.stream?.getTracks().forEach((t) => t.stop());
      void this.ctx?.close();
    } catch {
      /* already gone */
    }
    this.node = null;
    this.rec = null;
    this.stream = null;
    this.ctx = null;
  }
}
