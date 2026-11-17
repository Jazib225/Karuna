// Email + password accounts: Karuna stores only a locked key and a proof hash.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { Accounts } from "../src/accounts.ts";

const h = (n: number, c = "a") => c.repeat(n * 2);
const account = { email: "Adi@Example.com", salt: h(16), proof: h(32, "b"), iv: h(12, "c"), lockedKey: h(48, "d"), address: "0x00000000000000000000000000000000000000AA" };

describe("password accounts", () => {
  it("create, then sign in with the proof; the file never holds the proof itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "karuna-acct-"));
    const a = new Accounts(new Store(dir));
    expect(a.create(account)).toEqual({ ok: true, address: "0x00000000000000000000000000000000000000aa" });
    expect(a.salt("adi@example.com").salt).toBe(account.salt);
    expect(a.signIn({ email: "adi@example.com", proof: account.proof })).toEqual({ iv: account.iv, lockedKey: account.lockedKey, address: "0x00000000000000000000000000000000000000aa" });
    expect(readFileSync(join(dir, "accounts.json"), "utf8")).not.toContain(account.proof);
    expect(() => a.create(account)).toThrow(/already an account/);
    expect(() => a.create({ ...account, email: "other@x.co" })).toThrow(/already saved/);
  });

  it("a wrong password gets nothing and is rate-limited; unknown emails get a stable made-up salt", () => {
    const a = new Accounts(new Store(mkdtempSync(join(tmpdir(), "karuna-acct-"))));
    a.create(account);
    for (let i = 0; i < 8; i++) expect(() => a.signIn({ email: account.email, proof: h(32, "e") })).toThrow(/Wrong email or password/);
    expect(() => a.signIn({ email: account.email, proof: account.proof })).toThrow(/Too many/);
    expect(a.salt("nobody@x.co").salt).toBe(a.salt("nobody@x.co").salt);
    expect(a.salt("nobody@x.co").salt).toMatch(/^[0-9a-f]{32}$/);
  });
});
