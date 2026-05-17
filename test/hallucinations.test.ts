import test from "node:test";
import assert from "node:assert/strict";
import { isWhisperHallucination } from "../src/providers/stt/hallucinations.js";

test("flags the engVid artifact (the one that triggered this denylist)", () => {
  assert.equal(isWhisperHallucination("Learn English for free www.engvid.com"), true);
  assert.equal(isWhisperHallucination("learn english for free www.engvid.com"), true);
});

test("flags YouTube-subtitle endings", () => {
  for (const s of [
    "Thanks for watching!",
    "Thank you for watching",
    "Please like and subscribe",
    "Like and subscribe",
    "Don't forget to subscribe",
  ]) {
    assert.equal(isWhisperHallucination(s), true, s);
  }
});

test("flags non-speech markers", () => {
  for (const s of ["[Music]", "♪", "(silence)", "[Laughter]"]) {
    assert.equal(isWhisperHallucination(s), true, s);
  }
});

test("flags single-syllable foreign-language fillers from breath/noise", () => {
  for (const s of ["어.", "好.", "いい.", "음악"]) {
    assert.equal(isWhisperHallucination(s), true, s);
  }
});

test("flags repetitive looping (the the the the)", () => {
  assert.equal(isWhisperHallucination("the the the the the"), true);
  assert.equal(isWhisperHallucination("you you you you you you"), true);
});

test("flags empty / whitespace", () => {
  assert.equal(isWhisperHallucination(""), true);
  assert.equal(isWhisperHallucination("   "), true);
});

test("PASSES real utterances unchanged", () => {
  for (const s of [
    "Hi Iris, can you hear me?",
    "What's on my schedule today?",
    "Add a task to follow up with the lawyer.",
    "Yeah.",
    "OK.",
    "No.",
  ]) {
    assert.equal(isWhisperHallucination(s), false, `should NOT flag: "${s}"`);
  }
});
