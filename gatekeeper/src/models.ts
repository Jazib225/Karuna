// What an agent said to its model and what the model answered, read from the traffic Karuna's
// egress proxy already carries (it decrypts it to swap in the API key). Three formats cover nearly
// every agent: Anthropic Messages, OpenAI-compatible chat (OpenAI, Groq, OpenRouter, Mistral,
// DeepSeek, Together, and local servers like Ollama and llama.cpp) and Gemini. Plain and streamed
// replies both decode. Anything else is still shown as a raw call.
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export type ModelFormat = "anthropic" | "openai" | "gemini";

export interface ModelCall {
  format: ModelFormat;
  provider: string; // "Anthropic", "OpenAI", "Groq", "Gemini", "Ollama (local)", or the host
  model?: string; // when the URL names it (Gemini)
}

export interface ModelExchange {
  provider: string;
  model: string;
  asked: string; // the latest thing the agent sent (its last user / tool-result message), trimmed
  system: string; // the system prompt, trimmed
  toolsOffered: string[];
  said: string; // the model's text answer
  thinking: string; // reasoning text the provider returned (if any)
  toolCalls: { name: string; input: string }[];
  stopReason: string;
  tokensIn?: number;
  tokensOut?: number;
}

const PROVIDERS: [RegExp, string][] = [
  [/(^|\.)openai\.com$/, "OpenAI"], [/(^|\.)groq\.com$/, "Groq"], [/(^|\.)openrouter\.ai$/, "OpenRouter"], [/(^|\.)mistral\.ai$/, "Mistral"],
  [/(^|\.)deepseek\.com$/, "DeepSeek"], [/(^|\.)together\.(xyz|ai)$/, "Together"], [/(^|\.)x\.ai$/, "xAI"], [/(^|\.)fireworks\.ai$/, "Fireworks"],
];

/** Is this request a model call Karuna can read? */
export function modelCall(url: string, method: string): ModelCall | null {
  if (method.toUpperCase() !== "POST") return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  if (host === "api.anthropic.com" && /\/v1\/messages$/.test(path)) return { format: "anthropic", provider: "Anthropic" };
  if (host === "generativelanguage.googleapis.com" && /:(stream)?generateContent$/i.test(path)) {
    return { format: "gemini", provider: "Gemini", model: /\/models\/([^:/]+):/.exec(path)?.[1] };
  }
  if (/\/(chat\/completions|responses)$/.test(path)) {
    const named = PROVIDERS.find(([re]) => re.test(host))?.[1];
    const local = /^(localhost|127\.0\.0\.1|host\.docker\.internal|karuna-model)$/.test(host) || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host);
    const google = host === "generativelanguage.googleapis.com" ? "Gemini" : undefined;
    return { format: "openai", provider: named ?? google ?? (local ? `${u.port === "11434" ? "Ollama" : "Local model"} (local)` : host) };
  }
  return null;
}

/** Undo the response's content-encoding (agents usually ask for gzip). */
export function decodeBody(buf: Buffer, encoding: string | undefined): string {
  try {
    const e = (encoding ?? "").toLowerCase();
    if (e.includes("gzip")) return gunzipSync(buf).toString("utf8");
    if (e.includes("br")) return brotliDecompressSync(buf).toString("utf8");
    if (e.includes("deflate")) return inflateSync(buf).toString("utf8");
  } catch {
    /* fall through: show what we have */
  }
  return buf.toString("utf8");
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The "data:" payloads of a server-sent-events stream, as JSON (non-JSON lines skipped). */
function sseEvents(text: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (!m || m[1] === "[DONE]") continue;
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      /* partial or keep-alive */
    }
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => {
      if (typeof b === "string") return b;
      if (b?.type === "text" || b?.type === "input_text" || b?.type === "output_text") return b.text ?? "";
      if (b?.type === "tool_result") return `[tool result] ${textOf(b.content)}`;
      if (typeof b?.text === "string") return b.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------- decoding

export function decodeExchange(call: ModelCall, requestText: string, responseText: string): ModelExchange | null {
  let req: any;
  try {
    req = JSON.parse(requestText);
  } catch {
    return null;
  }
  const base: ModelExchange = { provider: call.provider, model: String(req.model ?? call.model ?? ""), asked: "", system: "", toolsOffered: [], said: "", thinking: "", toolCalls: [], stopReason: "" };
  try {
    if (call.format === "anthropic") return anthropic(base, req, responseText);
    if (call.format === "openai") return req.input !== undefined && req.messages === undefined ? openaiResponses(base, req, responseText) : openaiChat(base, req, responseText);
    return gemini(base, req, responseText);
  } catch {
    return base;
  }
}

function anthropic(x: ModelExchange, req: any, res: string): ModelExchange {
  x.system = clip(textOf(req.system), 600);
  x.toolsOffered = (req.tools ?? []).map((t: any) => String(t.name ?? t.type ?? "")).filter(Boolean);
  const last = [...(req.messages ?? [])].reverse().find((m: any) => m.role === "user");
  x.asked = clip(textOf(last?.content), 1500);
  const trimmed = res.trimStart();
  if (trimmed.startsWith("{")) {
    const j = JSON.parse(trimmed);
    for (const b of j.content ?? []) {
      if (b.type === "text") x.said += b.text;
      else if (b.type === "thinking") x.thinking += b.thinking ?? "";
      else if (b.type === "tool_use") x.toolCalls.push({ name: b.name, input: clip(JSON.stringify(b.input ?? {}), 600) });
    }
    x.stopReason = String(j.stop_reason ?? "");
    x.model ||= String(j.model ?? "");
    x.tokensIn = j.usage?.input_tokens;
    x.tokensOut = j.usage?.output_tokens;
  } else {
    const blocks = new Map<number, { type: string; name?: string; json: string }>();
    for (const e of sseEvents(res)) {
      if (e.type === "message_start") {
        x.model ||= String(e.message?.model ?? "");
        x.tokensIn = e.message?.usage?.input_tokens;
      } else if (e.type === "content_block_start") {
        blocks.set(e.index, { type: e.content_block?.type, name: e.content_block?.name, json: "" });
        if (e.content_block?.type === "text" && e.content_block.text) x.said += e.content_block.text;
      } else if (e.type === "content_block_delta") {
        const d = e.delta ?? {};
        if (d.type === "text_delta") x.said += d.text ?? "";
        else if (d.type === "thinking_delta") x.thinking += d.thinking ?? "";
        else if (d.type === "input_json_delta") {
          const b = blocks.get(e.index);
          if (b) b.json += d.partial_json ?? "";
        }
      } else if (e.type === "message_delta") {
        x.stopReason = String(e.delta?.stop_reason ?? x.stopReason);
        x.tokensOut = e.usage?.output_tokens ?? x.tokensOut;
      }
    }
    for (const b of [...blocks.entries()].sort((a, c) => a[0] - c[0]).map(([, v]) => v)) {
      if (b.type === "tool_use") x.toolCalls.push({ name: String(b.name ?? ""), input: clip(b.json || "{}", 600) });
    }
  }
  x.said = clip(x.said.trim(), 4000);
  x.thinking = clip(x.thinking.trim(), 4000);
  return x;
}

function openaiChat(x: ModelExchange, req: any, res: string): ModelExchange {
  const msgs = req.messages ?? [];
  x.system = clip(msgs.filter((m: any) => m.role === "system" || m.role === "developer").map((m: any) => textOf(m.content)).join("\n"), 600);
  const last = [...msgs].reverse().find((m: any) => m.role === "user" || m.role === "tool");
  x.asked = clip(last ? `${last.role === "tool" ? "[tool result] " : ""}${textOf(last.content)}` : "", 1500);
  x.toolsOffered = (req.tools ?? []).map((t: any) => String(t.function?.name ?? t.name ?? "")).filter(Boolean);
  const trimmed = res.trimStart();
  if (trimmed.startsWith("{")) {
    const j = JSON.parse(trimmed);
    const m = j.choices?.[0]?.message ?? {};
    x.said = textOf(m.content);
    x.thinking = String(m.reasoning_content ?? m.reasoning ?? "");
    for (const t of m.tool_calls ?? []) x.toolCalls.push({ name: String(t.function?.name ?? ""), input: clip(String(t.function?.arguments ?? "{}"), 600) });
    x.stopReason = String(j.choices?.[0]?.finish_reason ?? "");
    x.model ||= String(j.model ?? "");
    x.tokensIn = j.usage?.prompt_tokens;
    x.tokensOut = j.usage?.completion_tokens;
  } else {
    const calls = new Map<number, { name: string; args: string }>();
    for (const e of sseEvents(res)) {
      x.model ||= String(e.model ?? "");
      const ch = e.choices?.[0];
      const d = ch?.delta ?? {};
      if (typeof d.content === "string") x.said += d.content;
      if (typeof d.reasoning_content === "string") x.thinking += d.reasoning_content;
      if (typeof d.reasoning === "string") x.thinking += d.reasoning;
      for (const t of d.tool_calls ?? []) {
        const c = calls.get(t.index ?? 0) ?? { name: "", args: "" };
        if (t.function?.name) c.name += t.function.name;
        if (t.function?.arguments) c.args += t.function.arguments;
        calls.set(t.index ?? 0, c);
      }
      if (ch?.finish_reason) x.stopReason = String(ch.finish_reason);
      if (e.usage) {
        x.tokensIn = e.usage.prompt_tokens;
        x.tokensOut = e.usage.completion_tokens;
      }
    }
    for (const c of [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) x.toolCalls.push({ name: c.name, input: clip(c.args || "{}", 600) });
  }
  x.said = clip(x.said.trim(), 4000);
  x.thinking = clip(x.thinking.trim(), 4000);
  return x;
}

/** OpenAI's Responses API (`/responses`): input items in, output items out. */
function openaiResponses(x: ModelExchange, req: any, res: string): ModelExchange {
  x.system = clip(String(req.instructions ?? ""), 600);
  const input = Array.isArray(req.input) ? req.input : [{ role: "user", content: req.input }];
  const last = [...input].reverse().find((m: any) => m.role === "user" || m.type === "function_call_output");
  x.asked = clip(last?.type === "function_call_output" ? `[tool result] ${String(last.output ?? "")}` : textOf(last?.content), 1500);
  x.toolsOffered = (req.tools ?? []).map((t: any) => String(t.name ?? t.type ?? "")).filter(Boolean);
  const finalOf = (resp: any) => {
    for (const o of resp.output ?? []) {
      if (o.type === "message") x.said += textOf(o.content);
      else if (o.type === "reasoning") x.thinking += (o.summary ?? []).map((s: any) => s.text ?? "").join("\n");
      else if (o.type === "function_call") x.toolCalls.push({ name: String(o.name ?? ""), input: clip(String(o.arguments ?? "{}"), 600) });
    }
    x.model ||= String(resp.model ?? "");
    x.stopReason = String(resp.status ?? "");
    x.tokensIn = resp.usage?.input_tokens;
    x.tokensOut = resp.usage?.output_tokens;
  };
  const trimmed = res.trimStart();
  if (trimmed.startsWith("{")) finalOf(JSON.parse(trimmed));
  else {
    const done = sseEvents(res).find((e) => e.type === "response.completed");
    if (done?.response) finalOf(done.response);
  }
  x.said = clip(x.said.trim(), 4000);
  x.thinking = clip(x.thinking.trim(), 4000);
  return x;
}

function gemini(x: ModelExchange, req: any, res: string): ModelExchange {
  x.system = clip(textOf((req.systemInstruction ?? req.system_instruction)?.parts?.map((p: any) => p.text ?? "")), 600);
  const last = [...(req.contents ?? [])].reverse().find((c: any) => c.role !== "model");
  x.asked = clip((last?.parts ?? []).map((p: any) => p.text ?? (p.functionResponse ? `[tool result] ${JSON.stringify(p.functionResponse.response ?? {})}` : "")).join("\n"), 1500);
  x.toolsOffered = (req.tools ?? []).flatMap((t: any) => (t.functionDeclarations ?? t.function_declarations ?? []).map((f: any) => String(f.name ?? "")));
  const trimmed = res.trimStart();
  let chunks: any[];
  if (trimmed.startsWith("[")) chunks = JSON.parse(trimmed);
  else if (trimmed.startsWith("{")) chunks = [JSON.parse(trimmed)];
  else chunks = sseEvents(res);
  for (const c of chunks) {
    const cand = c.candidates?.[0];
    for (const p of cand?.content?.parts ?? []) {
      if (p.thought && typeof p.text === "string") x.thinking += p.text;
      else if (typeof p.text === "string") x.said += p.text;
      else if (p.functionCall) x.toolCalls.push({ name: String(p.functionCall.name ?? ""), input: clip(JSON.stringify(p.functionCall.args ?? {}), 600) });
    }
    if (cand?.finishReason) x.stopReason = String(cand.finishReason);
    x.model ||= String(c.modelVersion ?? "");
    if (c.usageMetadata) {
      x.tokensIn = c.usageMetadata.promptTokenCount;
      x.tokensOut = c.usageMetadata.candidatesTokenCount;
    }
  }
  x.said = clip(x.said.trim(), 4000);
  x.thinking = clip(x.thinking.trim(), 4000);
  return x;
}
