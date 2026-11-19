// node --test src/island/code.test.ts  (pnpm --dir desktop test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpokenCodes, tokens } from "./code.ts";

function codes(start = 1_000) {
  let t = start;
  let r = 0.372; // -> 434
  const c = new SpokenCodes({ now: () => t, random: () => r });
  return { c, advance: (ms: number) => (t += ms), setRandom: (v: number) => (r = v) };
}

test("tokens: digits and number words", () => {
  assert.deepEqual(tokens("Approve, four-seven two!"), ["approve", "4", "7", "2"]);
  assert.deepEqual(tokens("approve 472."), ["approve", "4", "7", "2"]);
  assert.deepEqual(tokens("Yes 1 0 9"), ["yes", "1", "0", "9"]);
});

test("a matching user transcript confirms once, for that request", () => {
  const { c } = codes();
  const p = c.issue("approve", "req-1", "abc");
  assert.equal(p.phrase, `approve ${p.code.split("").join(" ")}`);
  const got = c.confirm(`Approve ${p.code}`);
  assert.equal(got?.target, "req-1");
  assert.equal(got?.hash, "abc");
  assert.equal(c.confirm(`Approve ${p.code}`), null, "a code works once");
});

test("spoken digits as words work too", () => {
  const { c } = codes();
  const p = c.issue("approve", "req-1");
  const words = p.code.split("").map((d) => ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][Number(d)]).join(" ");
  assert.ok(c.confirm(`okay approve ${words}`));
});

test("the action's word is required, and it must be the right one", () => {
  const { c } = codes();
  const p = c.issue("approve", "req-1");
  assert.equal(c.confirm(p.code), null, "digits alone don't confirm");
  assert.equal(c.confirm(`yes ${p.code}`), null, "a vote word doesn't approve");
  assert.equal(c.confirm(`deny ${p.code}`), null);
  assert.ok(c.confirm(`approve ${p.code}`));
});

test("a wrong code confirms nothing", () => {
  const { c } = codes();
  const p = c.issue("approve", "req-1");
  const wrong = String(((Number(p.code) - 100 + 1) % 900) + 100);
  assert.equal(c.confirm(`approve ${wrong}`), null);
  assert.ok(c.confirm(`approve ${p.code}`), "still usable after a wrong try");
});

test("codes expire after 30 seconds", () => {
  const { c, advance } = codes();
  const p = c.issue("approve", "req-1");
  advance(30_001);
  assert.equal(c.confirm(`approve ${p.code}`), null);
});

test("a new code for the same request replaces the old one", () => {
  const { c, setRandom } = codes();
  const first = c.issue("approve", "req-1");
  setRandom(0.9);
  const second = c.issue("approve", "req-1");
  assert.notEqual(first.code, second.code);
  assert.equal(c.confirm(`approve ${first.code}`), null);
  assert.equal(c.confirm(`approve ${second.code}`)?.target, "req-1");
});

test("each code belongs to its own request", () => {
  const { c, setRandom } = codes();
  const a = c.issue("approve", "req-a");
  setRandom(0.8);
  const b = c.issue("approve", "req-b");
  assert.equal(c.confirm(`approve ${b.code}`)?.target, "req-b");
  assert.equal(c.confirm(`approve ${a.code}`)?.target, "req-a");
});

test("vote yes, resume and propose use their own words", () => {
  const { c, setRandom } = codes();
  const v = c.issue("vote_yes", "v-3");
  setRandom(0.1);
  const r = c.issue("resume_all", "");
  setRandom(0.55);
  const d = c.issue("propose_draft", "d-1");
  assert.equal(c.confirm(`approve ${v.code}`), null);
  assert.equal(c.confirm(`yes ${v.code}`)?.target, "v-3");
  assert.equal(c.confirm(`resume ${r.code}`)?.action, "resume_all");
  assert.equal(c.confirm(`propose ${d.code}`)?.target, "d-1");
});

test("cancel drops a code", () => {
  const { c } = codes();
  const p = c.issue("approve", "req-1");
  c.cancel("approve", "req-1");
  assert.equal(c.confirm(`approve ${p.code}`), null);
});
