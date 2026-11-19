// Downloads the small offline English speech model the wake phrase uses (Vosk, Apache 2.0, about
// 40 MB) and saves it where both the island and the console serve it:
//   web/public/models/vosk-small-en.tar.gz
// It runs on this computer only: audio for the wake phrase never leaves it.
//
//   pnpm --dir desktop wake:model
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const NAME = "vosk-model-small-en-us-0.15";
// Windows' own tar (bsdtar) reads zips; Git's GNU tar on PATH doesn't, and misreads "C:" as a host.
const TAR = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe") : "tar";
const URL_ = `https://alphacephei.com/vosk/models/${NAME}.zip`;
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../web/public/models");
const out = join(outDir, "vosk-small-en.tar.gz");

if (existsSync(out) && statSync(out).size > 10_000_000) {
  console.log(`already there: ${out}`);
  process.exit(0);
}
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "karuna-wake-"));
try {
  const zip = join(work, `${NAME}.zip`);
  console.log(`downloading ${URL_} …`);
  const res = await fetch(URL_);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
  console.log(`downloaded ${(statSync(zip).size / 1e6).toFixed(1)} MB; repacking for the browser…`);
  // tar (bsdtar on Windows) reads zips; the browser library wants a .tar.gz of the model folder.
  execFileSync(TAR, ["-xf", zip, "-C", work]);
  if (!existsSync(join(work, NAME, "am"))) throw new Error("unexpected archive layout");
  execFileSync(TAR, ["-czf", out, "-C", work, NAME]);
  console.log(`saved ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
