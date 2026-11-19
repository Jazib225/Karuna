// node --test src/island/text.test.ts  (pnpm --dir desktop test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSpoken } from "./text.ts";

test("pause tags are heard, not shown", () => {
  assert.equal(
    cleanSpoken('Nothing is waiting on you right now. <break time="0.6s" /> Want a quick status, or the last few decisions?'),
    "Nothing is waiting on you right now. Want a quick status, or the last few decisions?",
  );
  assert.equal(cleanSpoken('Done <break time="0.6s"/>.'), "Done.");
  assert.equal(cleanSpoken('<break time="1s" />Hello'), "Hello");
});

test("escaped, cut-off and other tags go too", () => {
  assert.equal(cleanSpoken("Two waiting. &lt;break time=&quot;0.6s&quot; /&gt; First one?"), "Two waiting. First one?");
  assert.equal(cleanSpoken('All good. <break time="0.'), "All good.");
  assert.equal(cleanSpoken("Say <emphasis>now</emphasis>."), "Say now.");
});

test("invisible characters are removed and spacing is tidy", () => {
  const zw = String.fromCharCode(0x200b);
  assert.equal(cleanSpoken(`Read${zw}y  to   go .`), "Ready to go.");
});

test("ordinary text is left alone", () => {
  assert.equal(cleanSpoken("It is 3 < 5 and 40 dollars."), "It is 3 < 5 and 40 dollars.");
});
