import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore, placeholderFor } from "../src/secrets.ts";

describe("SecretStore (sandbox keys)", () => {
  it("encrypts at rest, never lists values, reveals only on request", () => {
    const dir = mkdtempSync(join(tmpdir(), "karuna-secrets-"));
    const s = new SecretStore(dir);
    s.put("openai", "OPENAI_API_KEY", "sk-real-value-123");
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).not.toContain("sk-real-value-123");
    expect(JSON.stringify(s.list())).not.toContain("sk-real");
    expect(s.placeholderEnv()).toEqual({ OPENAI_API_KEY: placeholderFor("openai") });
    expect(new SecretStore(dir).reveal("openai")).toBe("sk-real-value-123"); // survives restart
  });
  it("rejects bad names, clashing variables, and placeholders as values", () => {
    const s = new SecretStore(mkdtempSync(join(tmpdir(), "karuna-secrets-")));
    s.put("gmail", "GMAIL_TOKEN", "x");
    expect(() => s.put("Bad Name", "X", "v")).toThrow();
    expect(() => s.put("other", "GMAIL_TOKEN", "v")).toThrow(/already used/);
    expect(() => s.put("loop", "LOOP", "karuna_key_gmail")).toThrow(/placeholder/);
  });
  it("rule drafter keys are for Karuna only: no placeholder for boxes, not agent-usable", () => {
    const s = new SecretStore(mkdtempSync(join(tmpdir(), "karuna-secrets-")));
    s.put("openai", "OPENAI_API_KEY", "sk-agent");
    s.put("groq-drafter", "GROQ_API_KEY", "gsk-drafter", new Date(), { purpose: "drafter", provider: "groq" });
    expect(s.placeholderEnv()).toEqual({ OPENAI_API_KEY: placeholderFor("openai") }); // boxes never see it
    expect(s.forAgents("openai")).toBe(true);
    expect(s.forAgents("groq-drafter")).toBe(false);
    expect(s.drafterKey("groq")).toBe("gsk-drafter");
    expect(s.drafterKey("gemini")).toBeNull();
    expect(s.list().find((k) => k.name === "groq-drafter")).toMatchObject({ purpose: "drafter", provider: "groq" });
    expect(() => s.put("x", "X_KEY", "v", new Date(), { purpose: "drafter", provider: "openai" })).toThrow(/groq, gemini/);
  });
  it("finds placeholders in headers and URLs", () => {
    expect(SecretStore.placeholdersIn("authorization: Bearer karuna_key_openai\nx: karuna_key_gh-2")).toEqual(["openai", "gh-2"]);
  });
});
