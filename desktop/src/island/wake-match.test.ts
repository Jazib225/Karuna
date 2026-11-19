// node --test src/island/wake-match.test.ts  (pnpm --dir desktop test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { heardPhrase, skeleton } from "./wake-match.ts";

test("sounds are reduced to a consonant skeleton", () => {
  assert.equal(skeleton("karuna"), "krn");
  assert.equal(skeleton("corona"), "krn");
  assert.equal(skeleton("hey"), "h");
});

test("the phrase, said or misheard the way the offline model hears names", () => {
  for (const heard of ["hey karuna", "Hey, Karuna!", "hey corona", "hey car una", "hey karina", "hey caruna", "um hey karuna can you hear me"]) {
    assert.ok(heardPhrase("hey karuna", heard), heard);
  }
});

test("everyday speech doesn't wake it", () => {
  for (const heard of ["hello there", "how are you doing", "the corner store", "can you hear me", "okay", "hey", "karaoke night", "pay the invoice"]) {
    assert.ok(!heardPhrase("hey karuna", heard), heard);
  }
});

test("any phrase the member picks works", () => {
  assert.ok(heardPhrase("okay bakery", "okay bakery"));
  assert.ok(heardPhrase("okay bakery", "ok baker e"));
  assert.ok(heardPhrase("computer", "computer"));
  assert.ok(!heardPhrase("computer", "compute the total"));
  assert.ok(heardPhrase("wake up maya", "wake up maya"));
  assert.ok(!heardPhrase("wake up maya", "make it up later"));
});

test("an empty or very short phrase never matches loosely", () => {
  assert.ok(!heardPhrase("", "anything"));
  assert.ok(!heardPhrase("hi", "high"));
  assert.ok(heardPhrase("hi", "oh hi there"));
});
