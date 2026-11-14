// EXAMPLE agent (not product code): a test agent that exercises Karuna end to end from inside a
// sandbox, one visible case at a time. Run it boxed:
//
//   KARUNA_AGENT_TOKEN=kag_… pnpm karuna run --agent <id> ./agents -- npx tsx examples/test-agent.ts
//   … -- npx tsx examples/test-agent.ts --loop     repeat every 90 s
//
// It uses plain fetch, like any agent would. Inside the box every request goes through Karuna's
// egress proxy (HTTPS_PROXY is set by `karuna run`), so the Gatekeeper decides each one:
//   1. allowed GET to an allowlisted domain        → the island shows "working"
//   2. GET to a site nobody allowed                → denied (Activity, Recent decisions)
//   3. POST to an allowlisted domain               → held: an approval card appears (island + console)
//   4. its inbox, through Karuna (karuna.internal) → the agent API from inside the box
import { KarunaAgent } from "../src/client.ts";

const loop = process.argv.includes("--loop");
const log = (step: string, result: string) => console.log(`${new Date().toTimeString().slice(0, 8)}  ${step.padEnd(44)} ${result}`);
const karuna = new KarunaAgent({ gatekeeperUrl: process.env.KARUNA_GATEKEEPER_URL ?? "http://127.0.0.1:8787", token: process.env.KARUNA_AGENT_TOKEN ?? "" });

async function status(url: string, init?: RequestInit) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(180_000) });
    const body = await r.text();
    const why = r.headers.get("x-karuna") ? ` (${body.slice(0, 80)})` : "";
    return `${r.status}${why}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function round(n: number) {
  console.log(`\n— round ${n}${process.env.KARUNA_SANDBOX ? " · inside a Karuna sandbox" : " · NOT sandboxed"}`);
  log("1. GET api.github.com/zen (allowed)", await status("https://api.github.com/zen"));
  log("2. GET example.com (not allowlisted)", await status("https://example.com/"));
  console.log("   3. POSTing to GitHub: this waits for a person to approve it in Karuna (up to 2 min)…");
  log(
    "3. POST api.github.com/…/issues (approval)",
    await status("https://api.github.com/repos/octocat/Hello-World/issues", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "karuna-test-agent" },
      body: JSON.stringify({ title: "Karuna test agent", body: "Approved through Karuna. (GitHub will refuse it: no credentials, by design.)" }),
    }),
  );
  try {
    const inbox = await karuna.inbox();
    log("4. inbox via Karuna", `${inbox.length} message(s)`);
  } catch (e) {
    log("4. inbox via Karuna", `error: ${(e as Error).message}`);
  }
}

let n = 1;
do {
  await round(n++);
  if (loop) await new Promise((r) => setTimeout(r, 90_000));
} while (loop);
console.log("\ndone");
