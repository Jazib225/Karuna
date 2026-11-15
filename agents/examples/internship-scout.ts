// EXAMPLE agent (not product code): Claude finds IT internships from trusted public sources and saves
// each one as a file, sorted into a folder by field. It has no idea what needs a person's approval:
// that lives in Karuna's rules. With these two rules (Rules page):
//
//   Allow file writes in `internships`                      → most listings save on their own
//   Require approval for file writes in `internships/cybersecurity`   → those pop up on the island
//
// a cybersecurity listing waits for your Approve / Deny; everything else goes straight through.
// Change the rules (say, require approval for `internships/networking` too) and the agent behaves
// differently without a line of code changing.
//
// Run it boxed (needs Docker). It prints the approved list at the end; send it to a file to keep it:
//
//   pnpm karuna run --agent internship-scout ./agents -- npx tsx examples/internship-scout.ts > internships.txt
//   … -- npx tsx examples/internship-scout.ts "only remote roles, summer 2027"
//
// Needs, once, in the console:
//   Keys:  your Anthropic API key, name `anthropic`, variable ANTHROPIC_API_KEY, service api.anthropic.com
//          (tick "POSTs to it skip approval")
//   Rules: raw.githubusercontent.com in Allowlisted domains, and the two file rules above
//   (To also keep each listing as a file on your computer, add --mount ./internships:/data:rw; writable
//   mounts need a voted `mount` rule for that folder.)
//
// Cost cap: at most MAX_TURNS model calls per run, low effort. A run costs a few cents to a few dimes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { KarunaAgent } from "../src/client.ts";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 12);
const OUT_DIR = process.env.OUT_DIR ?? "/data"; // the --mount target inside the box
const FIELDS = ["software", "data", "it-support", "networking", "cybersecurity", "other"] as const;

const TASK =
  process.argv.slice(2).join(" ").trim() ||
  "Find up to 10 current IT internships for students in North America and save each one.";

const SYSTEM = [
  "You find internships for a student and save each listing with the save_listing tool.",
  "Use only trusted, public sources. Start with Simplify's public internship list on GitHub:",
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/README.md",
  "(if that 404s, try the Summer2026 repo of the same name). Handshake needs a student login, so skip it.",
  "Use fetch_lines with keywords to read only the rows you need; the full page is very large.",
  `Pick the closest field for each listing from: ${FIELDS.join(", ")}.`,
  "For every listing, give save_listing a 1-2 sentence `why` saying why it fits the student's request.",
  "Some saves may be held for a person to approve, take a while, or be denied. That's normal: never retry a",
  "denied save, just move on. Finish with a short list of what was saved and what wasn't.",
].join(" ");

const tools: Anthropic.Tool[] = [
  {
    name: "fetch_lines",
    description:
      "GET a web page through Karuna and return only the lines containing any of the keywords (case-insensitive), " +
      "up to 80 lines. Use for large pages such as job-list READMEs.",
    input_schema: {
      type: "object",
      required: ["url", "keywords"],
      additionalProperties: false,
      properties: {
        url: { type: "string" },
        keywords: { type: "array", items: { type: "string" }, description: "e.g. [\"IT\", \"Security\", \"Network\"]" },
      },
    },
    strict: true,
  },
  {
    name: "save_listing",
    description:
      "Save one internship as a file in its field's folder. Karuna decides whether the save goes ahead, " +
      "may hold it for a person, and returns allowed / denied.",
    input_schema: {
      type: "object",
      required: ["field", "company", "title", "location", "url", "why"],
      additionalProperties: false,
      properties: {
        field: { type: "string", enum: [...FIELDS] },
        company: { type: "string" },
        title: { type: "string" },
        location: { type: "string" },
        url: { type: "string", description: "the application link" },
        why: { type: "string", description: "1-2 short sentences: why this listing fits the request" },
      },
    },
    strict: true,
  },
];

const karuna = new KarunaAgent({ gatekeeperUrl: process.env.KARUNA_GATEKEEPER_URL ?? "http://127.0.0.1:8787", token: process.env.KARUNA_AGENT_TOKEN ?? "" });
// Inside the box ANTHROPIC_API_KEY is the placeholder karuna_key_anthropic; Karuna swaps in the real
// key only on requests to api.anthropic.com.
const claude = new Anthropic({ maxRetries: 1, timeout: 240_000 });

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const log = (who: string, s: string) => console.log(`${new Date().toTimeString().slice(0, 8)}  ${who.padEnd(8)} ${s}`);

async function fetchLines(url: string, keywords: string[]): Promise<string> {
  const r = await fetch(url, { headers: { "user-agent": "karuna-internship-scout" }, signal: AbortSignal.timeout(200_000) });
  if (!r.ok) return `${r.status}${r.headers.get("x-karuna") ? " (blocked by Karuna)" : ""}`;
  const words = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  const hits = (await r.text()).split("\n").filter((l) => words.some((w) => l.toLowerCase().includes(w)));
  return `${hits.length} matching lines${hits.length > 80 ? " (first 80)" : ""}\n${hits.slice(0, 80).map((l) => l.slice(0, 400)).join("\n")}`;
}

async function saveListing(l: Record<string, string>): Promise<string> {
  const path = `internships/${l.field}/${slug(`${l.company}-${l.title}`)}.md`;
  const body = `# ${l.title} — ${l.company}\n\n- Location: ${l.location}\n- Apply: ${l.url}\n\n${l.why}\n`;
  // The agent asks; Karuna's rules decide (and may hold this for a person).
  const asked = await karuna.propose({ type: "action", tool: "file", fileOp: "write", path, body }, `${l.title} at ${l.company}. ${l.why}`);
  const result = asked.status === "pending" ? await karuna.wait(asked.id, { timeoutMs: 5 * 60_000 }) : asked;
  if (result.status !== "allowed" && result.status !== "done") {
    skipped.push(`${l.title} — ${l.company} (${result.status})`);
    return `${result.status}: not saved`;
  }
  saved.push(l);
  // The box's own disk is wiped when it exits; a writable --mount at OUT_DIR keeps the files.
  try {
    const file = join(OUT_DIR, path.slice("internships/".length));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, body);
  } catch {
    /* no writable folder shared: the list printed at the end is the output */
  }
  return `saved ${path}`;
}

const saved: Record<string, string>[] = [];
const skipped: string[] = [];

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === "fetch_lines") return fetchLines(String(input.url), (input.keywords as string[]) ?? []);
  if (name === "save_listing") return saveListing(input as Record<string, string>);
  return `unknown tool ${name}`;
}

console.log(`Internship scout on ${MODEL}${process.env.KARUNA_SANDBOX ? " · inside a Karuna sandbox" : " · NOT sandboxed"} · up to ${MAX_TURNS} model calls`);
log("task", TASK);

const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: TASK }];
let usageIn = 0;
let usageOut = 0;

for (let turn = 1; turn <= MAX_TURNS; turn++) {
  let res: Anthropic.Beta.BetaMessage;
  try {
    res = await claude.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools,
      messages,
      output_config: { effort: "low" },
      // If a request is ever declined by a safety classifier, retry it on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      log("error", "the Anthropic key was rejected: check the `anthropic` key on the Keys page");
    } else if (e instanceof Anthropic.APIError) {
      log("error", `model call failed (${e.status}): ${e.message}`);
    } else {
      // No answer from Anthropic at all: usually Karuna blocked the call.
      log("error", `model call failed: ${e instanceof Error ? e.message : String(e)}`);
      log("hint", "is the `anthropic` key added and bound to api.anthropic.com, with POSTs there allowed?");
    }
    process.exit(1);
  }
  usageIn += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0);
  usageOut += res.usage.output_tokens;

  if (res.stop_reason === "refusal") {
    log("stop", "the model declined this request");
    break;
  }
  for (const b of res.content) if (b.type === "text" && b.text.trim()) log("claude", b.text.trim());
  messages.push({ role: "assistant", content: res.content });

  const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
  if (res.stop_reason !== "tool_use" || !calls.length) break;

  const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
  for (const c of calls) {
    const input = c.input as Record<string, unknown>;
    log("tool", `${c.name} ${String(input.url ?? input.company ?? "")} ${input.field ? `[${String(input.field)}]` : ""}`.trim());
    let out: string;
    let isError = false;
    try {
      out = await runTool(c.name, input);
    } catch (e) {
      out = `error: ${e instanceof Error ? e.message : String(e)}`;
      isError = true;
    }
    log("result", out.split("\n")[0]!.slice(0, 120));
    results.push({ type: "tool_result", tool_use_id: c.id, content: out, ...(isError ? { is_error: true } : {}) });
  }
  messages.push({ role: "user", content: results });
  if (turn === MAX_TURNS) log("stop", `hit the ${MAX_TURNS}-call cap`);
}

console.log(`\n=== Internships (${saved.length}) ===`);
for (const field of FIELDS) {
  const rows = saved.filter((l) => l.field === field);
  if (!rows.length) continue;
  console.log(`\n${field.toUpperCase()}`);
  for (const l of rows) console.log(`- ${l.title} — ${l.company} (${l.location})\n  ${l.url}\n  ${l.why}`);
}
if (skipped.length) console.log(`\nNot saved:\n${skipped.map((s) => `- ${s}`).join("\n")}`);

console.log(`\ndone · ${usageIn} tokens in, ${usageOut} out · about $${((usageIn * 4 + usageOut * 20) / 1e6).toFixed(3)} at Opus 5.5 prices`);
