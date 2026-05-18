import test from "node:test";
import assert from "node:assert/strict";
import { prefixMatches } from "../src/core/speculative.js";

test("speculative: exact match accepted", () => {
  assert.equal(prefixMatches("hello there", "hello there"), true);
});

test("speculative: partial is a real word-boundary prefix", () => {
  assert.equal(prefixMatches("what is the weather", "what is the weather like in paris"), true);
});

test("speculative: punctuation jitter doesn't reject", () => {
  // STT often adds a trailing period as it finalizes; should still match.
  assert.equal(prefixMatches("what time is it", "what time is it?"), true);
  assert.equal(prefixMatches("what time is it?", "what time is it now"), true);
  assert.equal(prefixMatches("hey iris,", "hey iris how are you"), true);
});

test("speculative: case-insensitive", () => {
  assert.equal(prefixMatches("Hey Iris", "hey iris what's up"), true);
});

test("speculative: mid-word prefix rejected", () => {
  // "te" is a prefix of "tell" but not a word — must not match.
  assert.equal(prefixMatches("te", "tell me about cats"), false);
});

test("speculative: completely different text rejected", () => {
  assert.equal(prefixMatches("what is the weather", "play some music"), false);
});

test("speculative: empty prefix rejected", () => {
  assert.equal(prefixMatches("", "anything goes"), false);
  assert.equal(prefixMatches("   ", "anything"), false);
});

test("speculative: whitespace collapse handles double spaces", () => {
  assert.equal(prefixMatches("hello   world", "hello world how are you"), true);
});
