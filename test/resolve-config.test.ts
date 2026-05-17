import test from "node:test";
import assert from "node:assert/strict";
import { resolveVoiceConfig } from "../src/core/resolve-config.js";

test("hints override per-agent override override base defaults", () => {
  const r = resolveVoiceConfig({
    pluginConfig: {
      tts: { provider: "base", voice: "alloy" },
      perAgent: { iris: { tts: { provider: "agent", voice: "nova" } } },
    },
    agentId: "iris",
    ttsHints: { voice: "shimmer" },
  });
  assert.equal(r.tts.provider, "agent");
  assert.equal(r.tts.voice, "shimmer");
});

test("falls back to built-in defaults when nothing is configured", () => {
  const r = resolveVoiceConfig({ pluginConfig: {}, agentId: "default" });
  assert.equal(r.tts.provider, "voice-chat/openai");
  assert.equal(r.stt.provider, "voice-chat/openai-whisper");
  assert.equal(r.mode, "ptt");
  assert.equal(r.interrupt, true);
});

test("per-agent override applies when no hints", () => {
  const r = resolveVoiceConfig({
    pluginConfig: { perAgent: { iris: { stt: { language: "es" } } } },
    agentId: "iris",
  });
  assert.equal(r.stt.language, "es");
});
