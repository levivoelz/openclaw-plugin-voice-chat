import test from "node:test";
import assert from "node:assert/strict";
import { SentenceBuffer } from "../src/core/sentence-buffer.js";

test("emits first short clause quickly to minimize audio latency", () => {
  const out: string[] = [];
  const buf = new SentenceBuffer((c) => out.push(c), { firstChunkMinChars: 10, idleFlushMs: 9_999 });
  buf.push("Hi there. ");
  buf.push("How can I help today?");
  buf.flush();
  assert.equal(out.length, 2);
  assert.equal(out[0], "Hi there.");
  assert.equal(out[1], "How can I help today?");
});

test("respects subsequentChunkMinChars after first emission", () => {
  const out: string[] = [];
  const buf = new SentenceBuffer((c) => out.push(c), {
    firstChunkMinChars: 5,
    subsequentChunkMinChars: 40,
    idleFlushMs: 9_999,
  });
  buf.push("Hi. ");
  buf.push("Yes. ");
  buf.push("No. ");
  buf.push("Maybe. ");
  // First chunk fires on "Hi.". Then we need >=40 chars before next boundary emission.
  assert.equal(out.length, 1);
  assert.equal(out[0], "Hi.");

  buf.push("This is a longer sentence to push the buffer past the threshold. ");
  // Now buffer has >40 chars and ends on a boundary — should emit.
  assert.ok(out.length >= 2, `expected >=2 emissions, got ${out.length}`);
});

test("hard cap forces emission at a soft space cut even mid-sentence", () => {
  const out: string[] = [];
  const buf = new SentenceBuffer((c) => out.push(c), {
    firstChunkMinChars: 5,
    subsequentChunkMinChars: 5,
    maxChunkChars: 50,
    idleFlushMs: 9_999,
  });
  buf.push("This is a sentence without punctuation that just keeps going and going and going without stopping");
  // Should have emitted at least once because hard cap was exceeded.
  assert.ok(out.length >= 1, `expected emission past hard cap, got ${out.length}`);
  for (const chunk of out) {
    assert.ok(chunk.length <= 50, `chunk exceeded cap: ${chunk.length}`);
  }
});

test("flush emits remainder", () => {
  const out: string[] = [];
  const buf = new SentenceBuffer((c) => out.push(c), { firstChunkMinChars: 999, idleFlushMs: 9_999 });
  buf.push("Tiny bit.");
  // Below threshold, no emission yet.
  assert.equal(out.length, 0);
  buf.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0], "Tiny bit.");
});

test("idle timer flushes pending text", async () => {
  const out: string[] = [];
  const buf = new SentenceBuffer((c) => out.push(c), { firstChunkMinChars: 999, idleFlushMs: 50 });
  buf.push("Stalled mid-thought");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(out.length, 1);
  assert.equal(out[0], "Stalled mid-thought");
});

test("close stops further emissions", () => {
  const out: string[] = [];
  const buf = new SentenceBuffer((c) => out.push(c), { firstChunkMinChars: 1, idleFlushMs: 9_999 });
  buf.push("First. ");
  assert.equal(out.length, 1);
  buf.close();
  buf.push("Second. ");
  buf.flush();
  assert.equal(out.length, 1);
});

test("colon and em-dash count as soft boundaries", () => {
  const out: string[] = [];
  const buf = new SentenceBuffer((c) => out.push(c), { firstChunkMinChars: 5, idleFlushMs: 9_999 });
  buf.push("Here's the thing: ");
  buf.push("It works.");
  buf.flush();
  // Two emissions: one at the colon, one at the period.
  assert.equal(out.length, 2);
});
