// Reading an agent's model calls from the traffic Karuna's proxy carries (the Runs view).
import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeBody, decodeExchange, modelCall } from "../src/models.ts";

const sse = (events: unknown[]) => events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");

describe("which calls are model calls", () => {
  it("knows the three formats and names the provider", () => {
    expect(modelCall("https://api.anthropic.com/v1/messages", "POST")).toEqual({ format: "anthropic", provider: "Anthropic" });
    expect(modelCall("https://api.openai.com/v1/chat/completions", "POST")).toMatchObject({ format: "openai", provider: "OpenAI" });
    expect(modelCall("https://api.groq.com/openai/v1/chat/completions", "POST")).toMatchObject({ provider: "Groq" });
    expect(modelCall("http://host.docker.internal:11434/v1/chat/completions", "POST")).toMatchObject({ provider: "Ollama (local)" });
    expect(modelCall("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse", "POST")).toEqual({ format: "gemini", provider: "Gemini", model: "gemini-3.8-flash" });
    expect(modelCall("https://api.anthropic.com/v1/messages", "GET")).toBeNull();
    expect(modelCall("https://api.github.com/repos", "POST")).toBeNull();
  });

  it("undoes gzip", () => {
    expect(decodeBody(gzipSync(Buffer.from("hello")), "gzip")).toBe("hello");
  });
});

const anthropicReq = JSON.stringify({
  model: "claude-sonnet-5-5", system: "You are the flour buyer.", tools: [{ name: "pay" }, { name: "buy_data" }],
  messages: [{ role: "user", content: "Check prices" }, { role: "assistant", content: [{ type: "text", text: "ok" }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Flour $31" }] }],
});

describe("decoding exchanges", () => {
  it("Anthropic, plain", () => {
    const res = JSON.stringify({ model: "claude-sonnet-5-5", stop_reason: "tool_use", usage: { input_tokens: 120, output_tokens: 30 },
      content: [{ type: "text", text: "Flour is under $35, ordering." }, { type: "tool_use", name: "pay", input: { payee: "Valley Flour", amount_usd: 31 } }] });
    const x = decodeExchange({ format: "anthropic", provider: "Anthropic" }, anthropicReq, res)!;
    expect(x).toMatchObject({ provider: "Anthropic", model: "claude-sonnet-5-5", system: "You are the flour buyer.", toolsOffered: ["pay", "buy_data"], said: "Flour is under $35, ordering.", stopReason: "tool_use", tokensIn: 120, tokensOut: 30 });
    expect(x.asked).toBe("[tool result] Flour $31");
    expect(x.toolCalls).toEqual([{ name: "pay", input: JSON.stringify({ payee: "Valley Flour", amount_usd: 31 }) }]);
  });

  it("Anthropic, streamed (text, thinking and a tool call built from pieces)", () => {
    const res = sse([
      { type: "message_start", message: { model: "claude-opus-5-5", usage: { input_tokens: 50 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Price is low." } },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Buying " } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "now." } },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", name: "pay" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"payee\":\"Valley" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: " Flour\"}" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
    ]);
    const x = decodeExchange({ format: "anthropic", provider: "Anthropic" }, anthropicReq, res)!;
    expect(x).toMatchObject({ model: "claude-sonnet-5-5", said: "Buying now.", thinking: "Price is low.", stopReason: "tool_use", tokensIn: 50, tokensOut: 12 });
    expect(x.toolCalls).toEqual([{ name: "pay", input: "{\"payee\":\"Valley Flour\"}" }]);
  });

  it("OpenAI-compatible chat, streamed with a tool call (Groq, OpenRouter, Ollama…)", () => {
    const req = JSON.stringify({ model: "llama-4", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Pay the invoice" }], tools: [{ type: "function", function: { name: "pay" } }] });
    const res = sse([
      { model: "llama-4", choices: [{ delta: { content: "Paying" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "pay", arguments: "{\"amount\"" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":5}" } }] }, finish_reason: "tool_calls" }] },
    ]) + "data: [DONE]\n\n";
    const x = decodeExchange({ format: "openai", provider: "Ollama (local)" }, req, res)!;
    expect(x).toMatchObject({ provider: "Ollama (local)", model: "llama-4", system: "Be brief.", asked: "Pay the invoice", said: "Paying", stopReason: "tool_calls", toolsOffered: ["pay"] });
    expect(x.toolCalls).toEqual([{ name: "pay", input: "{\"amount\":5}" }]);
  });

  it("OpenAI Responses API, plain", () => {
    const req = JSON.stringify({ model: "gpt-5", instructions: "Help.", input: [{ role: "user", content: [{ type: "input_text", text: "Summarize" }] }] });
    const res = JSON.stringify({ model: "gpt-5", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }, { type: "function_call", name: "web_get", arguments: "{\"url\":\"x\"}" }] });
    const x = decodeExchange({ format: "openai", provider: "OpenAI" }, req, res)!;
    expect(x).toMatchObject({ system: "Help.", asked: "Summarize", said: "Done.", toolCalls: [{ name: "web_get", input: "{\"url\":\"x\"}" }] });
  });

  it("Gemini, streamed", () => {
    const req = JSON.stringify({ systemInstruction: { parts: [{ text: "Be careful." }] }, contents: [{ role: "user", parts: [{ text: "Check stock" }] }], tools: [{ functionDeclarations: [{ name: "read_inbox" }] }] });
    const res = sse([
      { candidates: [{ content: { parts: [{ text: "Stock is " }] } }], modelVersion: "gemini-3.8-flash" },
      { candidates: [{ content: { parts: [{ text: "low." }, { functionCall: { name: "read_inbox", args: {} } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } },
    ]);
    const x = decodeExchange({ format: "gemini", provider: "Gemini", model: "gemini-3.8-flash" }, req, res)!;
    expect(x).toMatchObject({ model: "gemini-3.8-flash", system: "Be careful.", asked: "Check stock", said: "Stock is low.", toolsOffered: ["read_inbox"], toolCalls: [{ name: "read_inbox", input: "{}" }], tokensIn: 9, tokensOut: 4 });
  });

  it("something it can't parse gives null, not a crash", () => {
    expect(decodeExchange({ format: "anthropic", provider: "Anthropic" }, "not json", "x")).toBeNull();
    expect(decodeExchange({ format: "anthropic", provider: "Anthropic" }, anthropicReq, "garbage")).toMatchObject({ said: "" });
  });
});
