// Builds the packaged app's backend into desktop/src-tauri/core/, which the installer ships:
//   karuna-core.mjs   Gatekeeper + relay + console server + runner, bundled and minified (core.ts)
//   circle-argv.mjs   the Gatekeeper's helper for long Circle CLI calls
//   agent/            the hosted agent Karuna builds and runs (bundled), as its Docker build context
//   console/          the built console (`web/`)
//   circle/           Circle's CLI (Apache-2.0), for the wallet: sign-in, payments, deploying Dharma
//   cloudflared.exe   Cloudflare's tunnel (Apache-2.0), for invite links and chat apps
//   node.exe          the Node that runs all of it
// No TypeScript source, .env, keys or data go in. Run: node desktop/core/build.mjs
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = resolve(here, "../src-tauri/core");
const say = (s) => console.log(`core · ${s}`);

// esbuild comes with Vite (the console's build tool).
const fromWeb = createRequire(join(root, "web", "package.json"));
const esbuild = createRequire(fromWeb.resolve("vite"))("esbuild");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// CommonJS dependencies (dotenv, node-forge, ws…) inside an ES module bundle need a `require`.
const banner = { js: 'import { createRequire as __karunaRequire } from "node:module"; const require = __karunaRequire(import.meta.url);' };
// Packages are resolved with Node's own rules, not esbuild's: esbuild obeys any Yarn Plug'n'Play
// manifest (.pnp.cjs) in a parent folder, even one that belongs to another project, and then
// refuses this repo's pnpm packages. Node finds them through pnpm's links as usual.
const nodeResolve = {
  name: "node-resolve",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (!args.importer || args.path.startsWith("node:") || builtinModules.includes(args.path.split("/")[0])) return;
      try {
        return { path: realpathSync(createRequire(join(args.resolveDir, "x.js")).resolve(args.path)) };
      } catch {
        return undefined;
      }
    });
  },
};
const common = { bundle: true, platform: "node", format: "esm", target: "node22", minify: true, legalComments: "none", banner, logLevel: "warning", plugins: [nodeResolve] };

say("bundling the Gatekeeper, relay, console server and runner");
await esbuild.build({ ...common, entryPoints: [join(here, "core.ts")], outfile: join(out, "karuna-core.mjs") });
cpSync(join(root, "gatekeeper/src/circle-argv.mjs"), join(out, "circle-argv.mjs"));

say("bundling the hosted agent");
mkdirSync(join(out, "agent"));
await esbuild.build({ ...common, entryPoints: [join(root, "agents/hosted/run.ts")], outfile: join(out, "agent", "run.mjs") });
// No dependencies left to install: the image build's `npm install` has nothing to fetch.
writeFileSync(join(out, "agent", "package.json"), JSON.stringify({ name: "karuna-hosted-agent", private: true, type: "module" }, null, 2));

say("building the console");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
execFileSync(pnpm, ["--dir", join(root, "web"), "build"], { stdio: "inherit", shell: process.platform === "win32" });
cpSync(join(root, "web", "dist"), join(out, "console"), { recursive: true });
rmSync(join(out, "console", "vercel.json"), { force: true });

say("adding Circle's CLI");
const circle = process.env.KARUNA_CIRCLE_CLI_DIR ?? findCircle();
cpSync(circle, join(out, "circle"), { recursive: true, filter: (p) => !/[\\/]\.(git|github)([\\/]|$)/.test(p) });

say("adding cloudflared");
const cloudflared = process.env.KARUNA_CLOUDFLARED_EXE ?? [join(process.env["ProgramFiles(x86)"] ?? "", "cloudflared", "cloudflared.exe"), join(process.env.ProgramFiles ?? "", "cloudflared", "cloudflared.exe")].find((p) => existsSync(p));
if (!cloudflared) throw new Error("cloudflared isn't installed (winget install Cloudflare.cloudflared), or set KARUNA_CLOUDFLARED_EXE.");
cpSync(cloudflared, join(out, "cloudflared.exe"));
const cfVersion = execFileSync(cloudflared, ["--version"], { encoding: "utf8" }).trim().split(" ")[2] ?? "";

say("adding Node");
cpSync(process.execPath, join(out, "node.exe"));
writeFileSync(
  join(out, "THIRD_PARTY.txt"),
  [
    `Node.js ${process.version} (node.exe): MIT License, https://github.com/nodejs/node/blob/main/LICENSE`,
    `cloudflared ${cfVersion} (cloudflared.exe): Apache License 2.0, https://github.com/cloudflare/cloudflared/blob/master/LICENSE`,
    `Circle CLI ${JSON.parse(readFileSync(join(out, "circle", "package.json"), "utf8")).version} (circle/): Apache License 2.0, see circle/LICENSE`,
    "Bundled npm packages in karuna-core.mjs and agent/run.mjs keep their own licenses (viem, ws, dotenv, node-forge, @anthropic-ai/sdk).",
    "",
  ].join("\n"),
);

// Nothing private may ship: no .env, keys, data dirs or TypeScript source.
const bad = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) {
      if (/^(data|\.karuna)$/.test(f) && d === out) bad.push(p);
      walk(p);
    } else if (/^\.env(\..*)?$|\.pem$|\.key$|^secrets\.json$|^console\.token$/.test(f) || (/\.tsx?$/.test(f) && !/\.d\.ts$/.test(f) && !p.includes(`${join(out, "circle")}`))) bad.push(p);
  }
};
walk(out);
if (bad.length) {
  console.error(`core · refusing to ship:\n  ${bad.join("\n  ")}`);
  process.exit(1);
}
const size = (d) => readdirSync(d).reduce((n, f) => n + (statSync(join(d, f)).isDirectory() ? size(join(d, f)) : statSync(join(d, f)).size), 0);
say(`done: ${out} (${(size(out) / 1e6).toFixed(1)} MB)`);

function findCircle() {
  const npmRoot = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
  const d = join(npmRoot, "@circle-fin", "cli");
  if (!existsSync(join(d, "dist", "index.js"))) throw new Error("Circle's CLI isn't installed (npm i -g @circle-fin/cli), or set KARUNA_CIRCLE_CLI_DIR.");
  return d;
}
