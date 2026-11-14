// EXAMPLE agent (not product code): a real AI test agent. Claude (Sonnet 5.5) gets a task and two
// tools, and every move it makes goes through Karuna. Run it boxed:
//
//   KARUNA_AGENT_TOKEN=kag_… pnpm karuna run --agent <id> ./agents -- npx tsx examples/claude-agent.ts
//   … -- npx tsx examples/claude-agent.ts "your own task here"
//
// Needs, once, in the console:
//   Keys: add your Anthropic API key under the name `anthropic`, bound to api.anthropic.com
//   Rules: allow POST to api.anthropic.com for this agent (else every model call waits for approval)
//
// The agent never holds the key. It sends the placeholder `karuna_key_anthropic`; Karuna's egress
// proxy swaps in the real key only on requests to api.anthropic.com. The model call itself is just
// another request the Gatekeeper decides.
//
// Spend cap: at most MAX_TURNS model calls per run, low effort, short replies. One run costs a few
// cents on Sonnet 5.5 ($2 / $10 per million tokens in / out).
import Anthropic from "@anthropic-ai/sdk";
import { KarunaAgent } from "../src/client.ts";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5";
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 10);

const TASK =
  process.argv.slice(2).join(" ").trim() ||
  "You're testing a permission layer called Karuna that sits between you and the internet. Do these in order, " +
    "one tool call at a time: (1) GET https://api.github.com/zen, (2) GET https://example.com/, " +
    "(3) POST https://api.github.com/repos/octocat/Hello-World/issues with a JSON body {\"title\":\"Karuna test\"}, " +
    "(4) read your inbox. Then report in a few lines which requests Karuna allowed, denied or held for a person.";

const SYSTEM =
  "You are a test agent running inside a Karuna sandbox. All your network access goes through Karuna, which may " +
  "allow, deny, or hold a request until a person approves it. A 403 marked 'Blocked by Karuna' is a denial, not a bug: " +
  "note it and move on, never retry it. You can't see holds directly: a request that took more than a few seconds " +
  "was held until a person decided. Be brief.";

const tools: Anthropic.Tool[] = [
  {
    name: "http_request",
    description:
      "Make an HTTP request. It goes through Karuna, which decides it. Returns the status and the first 500 characters of the body. " +
      "Requests that need approval can take up to 3 minutes to return.",
    input_schema: {
      type: "object",
      required: ["method", "url"],
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        url: { type: "string" },
        body: { type: "string", description: "JSON request body, for POST/PUT/PATCH" },
      },
    },
  },
  {
    name: "read_inbox",
    description: "Read your Karuna inbox (messages people or other agents sent you).",
    input_schema: { type: "object", properties: {} },
  },
];

const karuna = new KarunaAgent({ gatekeeperUrl: process.env.KARUNA_GATEKEEPER_URL ?? "http://127.0.0.1:8787", token: process.env.KARUNA_AGENT_TOKEN ?? "" });
// The placeholder, not a key: Karuna's proxy fills it in on the way to api.anthropic.com.
const claude = new Anthropic({ apiKey: "karuna_key_anthropic", maxRetries: 1, timeout: 240_000 });

async function runTool(name: string, input: Record<string, string>): Promise<string> {
  if (name === "read_inbox") {
    const inbox = await karuna.inbox();
    return JSON.stringify(inbox.slice(0, 10).map((m) => ({ from: m.from, subject: m.subject, body: m.body.slice(0, 300) })));
  }
  if (name === "http_request") {
    const method = (input.method ?? "GET").toUpperCase();
    const t0 = Date.now();
    const r = await fetch(input.url, {
      method,
      headers: { "user-agent": "karuna-claude-test-agent", ...(input.body ? { "content-type": "application/json" } : {}) },
      body: input.body && !["GET", "HEAD"].includes(method) ? input.body : undefined,
      signal: AbortSignal.timeout(200_000),
    });
    const text = await r.text();
    const secs = Math.round((Date.now() - t0) / 1000);
    return `${r.status}${r.headers.get("x-karuna") ? " (from Karuna)" : ""} · took ${secs}s\n${text.slice(0, 500)}`;
  }
  return `unknown tool ${name}`;
}

const log = (who: string, s: string) => console.log(`${new Date().toTimeString().slice(0, 8)}  ${who.padEnd(8)} ${s}`);

console.log(`Claude test agent on ${MODEL}${process.env.KARUNA_SANDBOX ? " · inside a Karuna sandbox" : " · NOT sandboxed"} · up to ${MAX_TURNS} model calls`);
log("task", TASK);

const messages: Anthropic.MessageParam[] = [{ role: "user", content: TASK }];
let usageIn = 0;
let usageOut = 0;

for (let turn = 1; turn <= MAX_TURNS; turn++) {
  let res: Anthropic.Message;
  try {
    res = await claude.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      tools,
      messages,
      output_config: { effort: "low" },
    });
  } catch (e) {
    log("error", `model call failed: ${e instanceof Error ? e.message : String(e)}`);
    log("hint", "is the `anthropic` key added in Keys, and POST to api.anthropic.com allowed in Rules?");
    process.exit(1);
  }
  usageIn += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0);
  usageOut += res.usage.output_tokens;

  for (const b of res.content) if (b.type === "text" && b.text.trim()) log("claude", b.text.trim());
  if (res.stop_reason === "refusal") break;
  messages.push({ role: "assistant", content: res.content });

  const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (res.stop_reason !== "tool_use" || !calls.length) break;

  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const c of calls) {
    const input = c.input as Record<string, string>;
    log("tool", `${c.name} ${input.method ?? ""} ${input.url ?? ""}`.trim());
    let out: string;
    try {
      out = await runTool(c.name, input);
    } catch (e) {
      out = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
    log("result", out.split("\n")[0]!.slice(0, 120));
    results.push({ type: "tool_result", tool_use_id: c.id, content: out });
  }
  messages.push({ role: "user", content: results });
  if (turn === MAX_TURNS) log("stop", `hit the ${MAX_TURNS}-call cap`);
}

const cost = (usageIn * 2 + usageOut * 10) / 1e6;
console.log(`\ndone · ${usageIn} tokens in, ${usageOut} out · about $${cost.toFixed(3)} at Sonnet 5.5 prices`);
