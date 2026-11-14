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
  it("finds placeholders in headers and URLs", () => {
    expect(SecretStore.placeholdersIn("authorization: Bearer karuna_key_openai\nx: karuna_key_gh-2")).toEqual(["openai", "gh-2"]);
  });
});
