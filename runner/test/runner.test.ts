import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, parseMount } from "../src/args.ts";
import { scanForSecrets } from "../src/scan.ts";

describe("karuna run arguments", () => {
  it("parses agent, folder, mounts and the command after --", () => {
    const a = parseArgs(["--agent", "bot", "--mount", "./data:/data:rw", "./bot", "--", "python", "main.py"], { KARUNA_AGENT_TOKEN: "kag_x" });
    expect(a).toMatchObject({ agent: "bot", dir: "./bot", token: "kag_x", command: ["python", "main.py"], gatekeeper: "http://127.0.0.1:8787" });
    expect(a.mounts).toEqual([{ host: "./data", container: "/data", writable: true }]);
  });
  it("keeps Windows drive letters in the host path; read-only by default", () => {
    expect(parseMount("C:\\invoices:/data")).toEqual({ host: "C:\\invoices", container: "/data", writable: false });
    expect(parseMount("C:\\invoices")).toEqual({ host: "C:\\invoices", container: "/mnt/invoices", writable: false });
  });
  it("refuses mounts over system paths, missing tokens and missing commands", () => {
    expect(() => parseMount("./x:/etc")).toThrow();
    expect(() => parseMount("./x:/app")).toThrow();
    expect(() => parseArgs(["--agent", "bot", "./bot", "--", "x"], {})).toThrow(/token/);
    expect(() => parseArgs(["--agent", "bot", "./bot"], { KARUNA_AGENT_TOKEN: "k" })).toThrow(/command/);
  });
});

describe("secret scan before boxing", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "karuna-scan-"));
  it("finds a real key in source, ignores .env files and node_modules", () => {
    const d = dir();
    writeFileSync(join(d, "main.py"), 'client = OpenAI(api_key="sk-proj-' + "a".repeat(40) + '")');
    writeFileSync(join(d, ".env"), "OPENAI_API_KEY=sk-" + "b".repeat(40));
    mkdirSync(join(d, "node_modules"));
    writeFileSync(join(d, "node_modules", "x.js"), "-----BEGIN PRIVATE KEY-----");
    expect(scanForSecrets(d)).toEqual([{ file: "main.py", what: "OpenAI API key" }]);
  });
  it("is clean for code that reads the key from the environment", () => {
    const d = dir();
    writeFileSync(join(d, "main.py"), 'client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])');
    expect(scanForSecrets(d)).toEqual([]);
  });
});
