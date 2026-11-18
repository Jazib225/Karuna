// The English → rules drafter, with a fake model: whatever the model says, only rules that fit the
// org (real agents, real payees, not absurdly broad) come back, each as the exact Dharma change
// and the sentence a member will read before proposing it.
import { describe, it, expect } from "vitest";
import { draftRules, type DraftContext } from "../src/draft.ts";

const ctx: DraftContext = {
  agents: [{ id: "ap-agent", name: "Accounts payable" }, { id: "research", name: "research" }],
  payees: [{ address: "0x00000000000000000000000000000000000000a1", name: "Acme", category: "supplies" }],
  domains: ["github.com"],
};
const base = { agent: "", target: "", method: "", fileOp: "", category: "", maxUsd: 0 };

/** A fetch that answers like an OpenAI-compatible endpoint with `content`, and records the request. */
function fakeModel(content: unknown, status = 200) {
  const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).authorization) });
    const payload = status === 200 ? { choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] } : { error: { message: "quota" } };
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("rule drafter", () => {
  it("turns the model's rules into Dharma changes and plain sentences", async () => {
    const { f, calls } = fakeModel({
      rules: [
        { ...base, kind: "shell", outcome: "deny", target: "git push" },
        { ...base, kind: "file", outcome: "approval", agent: "ap-agent", target: "finance", fileOp: "write" },
        { ...base, kind: "http", outcome: "allow", target: "https://api.github.com/", method: "get" },
        { ...base, kind: "message", outcome: "deny", agent: "research", target: "ap-agent" },
        { ...base, kind: "payment", outcome: "allow", target: "0x00000000000000000000000000000000000000A1", category: "supplies", maxUsd: 50 },
      ],
      note: "",
    });
    const out = await draftRules("no pushing; finance writes need a person; …", ctx, { gemini: "k-test" }, f);
    expect(calls[0].auth).toBe("Bearer k-test");
    expect((calls[0].body.response_format as { type: string }).type).toBe("json_schema");
    expect(out.skipped).toEqual([]);
    expect(out.rules.map((r) => r.sentence)).toEqual([
      "Block shell commands starting with `git push` for every agent.",
      "Require approval for file writes in `finance` for Accounts payable.",
      "Allow GET requests to api.github.com/ for every agent.",
      "Block messages to Accounts payable for research.",
      "Allow payments for supplies to Acme for every agent up to $50.00.",
    ]);
    expect(out.rules[0].change).toMatchObject({ op: "AddRule", outcome: "Deny", scope: "shell", target: "git push" });
    expect(out.rules[1].change).toMatchObject({ outcome: "Approval", agent: "ap-agent", scope: "file:write", target: "finance" });
    expect(out.rules[2].change).toMatchObject({ outcome: "Allow", scope: "http:GET", target: "api.github.com/" });
    expect(out.rules[3].change).toMatchObject({ scope: "message", target: "ap-agent", agent: "research" });
    expect(out.rules[4].change).toMatchObject({ scope: "payment:supplies", target: "0x00000000000000000000000000000000000000a1", maxUsd: 50 });
  });

  it("drops rules that name agents or payees the org doesn't have, or allow everything", async () => {
    const { f } = fakeModel({
      rules: [
        { ...base, kind: "shell", outcome: "deny", agent: "ghost-agent", target: "ls" },
        { ...base, kind: "payment", outcome: "allow", target: "0x00000000000000000000000000000000000000ff" },
        { ...base, kind: "shell", outcome: "allow", target: "*" },
        { ...base, kind: "http", outcome: "allow", target: "" },
        { ...base, kind: "teleport", outcome: "allow" },
        { ...base, kind: "shell", outcome: "deny", target: "rm" },
      ],
      note: "assumed rm means any rm",
    });
    const out = await draftRules("…", ctx, { gemini: "k" }, f);
    expect(out.rules.map((r) => r.change.target)).toEqual(["rm"]);
    expect(out.skipped).toHaveLength(5);
    expect(out.note).toBe("assumed rm means any rm");
  });

  it("busy or broken providers fall through: Groq, then Gemini, then Gemini lite", async () => {
    const models: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      models.push(String(body.model));
      if (url.includes("groq")) return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
      if (body.model === "gemini-3.8-flash") return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
      // the lighter Gemini refuses the strict schema once, then answers in plain JSON mode
      if (body.response_format.type === "json_schema") return new Response(JSON.stringify({ error: { message: "json_schema not supported" } }), { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rules: [{ ...base, kind: "shell", outcome: "deny", target: "rm" }], note: "" }) } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await draftRules("x", ctx, { gemini: "g", groq: "q" }, f, 0);
    expect(models).toEqual(["openai/gpt-oss-20b", "gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.5-flash-lite"]);
    expect(out.model).toBe("gemini-3.5-flash-lite");
    expect(out.rules.map((r) => r.sentence)).toEqual(["Block shell commands starting with `rm` for every agent."]);
  });

  it("a provider without a key is skipped; no keys at all is a clear message", async () => {
    const { f, calls } = fakeModel({ rules: [{ ...base, kind: "shell", outcome: "deny", target: "rm" }], note: "" });
    await draftRules("x", ctx, { gemini: null, groq: "q" }, f, 0);
    expect(calls.map((c) => c.url)).toEqual(["https://api.groq.com/openai/v1/chat/completions"]);
    await expect(draftRules("x", ctx, { gemini: null, groq: null }, f, 0)).rejects.toThrow(/No drafter key yet.*Groq.*Gemini/);
  });

  it("when every provider fails, the error says so and points to the form", async () => {
    await expect(draftRules("x", ctx, { gemini: "g", groq: "q" }, fakeModel({}, 503).f, 0)).rejects.toThrow(/No free model could draft this.*use the form/);
    await expect(draftRules("x", ctx, { gemini: "g" }, fakeModel("sure! here are your rules").f, 0)).rejects.toThrow(/isn.t a rule/);
  });
});
