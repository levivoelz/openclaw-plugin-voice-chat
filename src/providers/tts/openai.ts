import type { ProviderRegistry } from "../registry.js";
import type { AudioFormat } from "../../types.js";
import type { TtsProviderDescriptor, TtsSynthesizeRequest, TtsStreamChunk, TtsVoice } from "./types.js";
import { resolveDaemonAuth, isDaemonConfigured, daemonPost } from "../daemon.js";

/**
 * OpenAI TTS via the iris-secrets daemon. The daemon's /openai/speech
 * endpoint returns the entire audio buffer base64-encoded in JSON, so we
 * lose true streaming — but for typical reply lengths the synthesis is
 * sub-second, and we recover incremental playback by sentence-chunking at
 * the orchestrator layer (one daemon call per sentence).
 */

const OPENAI_VOICES = [
  "alloy", "echo", "fable", "onyx", "nova", "shimmer",
  "ballad", "coral", "ash", "sage", "verse",
];

function mapFormat(fmt: AudioFormat): string {
  // Daemon forwards the value to OpenAI's response_format which uses "pcm" not "pcm16".
  if (fmt === "pcm16") return "pcm";
  return fmt;
}

async function* synthesize(req: TtsSynthesizeRequest): AsyncIterable<TtsStreamChunk> {
  const auth = resolveDaemonAuth(req.providerConfig);
  const res = await daemonPost<{ audio_b64: string; format: string }>(
    auth,
    "/openai/speech",
    {
      input: req.text,
      voice: req.voice ?? "alloy",
      model: req.model ?? "tts-1",
      response_format: mapFormat(req.format),
    },
    { timeoutMs: 120_000, signal: req.signal },
  );
  const audio = Buffer.from(res.audio_b64, "base64");
  yield { seq: 1, chunk: new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength) };
}

const descriptor: TtsProviderDescriptor = {
  id: "voice-chat/openai",
  label: "OpenAI TTS (via daemon)",
  streaming: false, // see note above; daemon returns one base64 chunk
  models: ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"],
  defaultModel: "tts-1",
  async voices(_cfg: Record<string, unknown>): Promise<TtsVoice[]> {
    return OPENAI_VOICES.map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }));
  },
  defaultVoice: "alloy",
  formats: ["mp3", "pcm16", "wav", "opus"],
  defaultFormat: "mp3",
  isConfigured: (cfg) => isDaemonConfigured(cfg),
  synthesize,
};

export function registerOpenaiTts(registry: ProviderRegistry): void {
  registry.registerTts(descriptor);
}
