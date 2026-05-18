import type { ProviderRegistry } from "../registry.js";
import type { AudioFormat } from "../../types.js";
import type { TtsProviderDescriptor, TtsSynthesizeRequest, TtsStreamChunk, TtsVoice } from "./types.js";
import { resolveDaemonAuth, isDaemonConfigured, daemonStream } from "../daemon.js";

/**
 * OpenAI TTS via the iris-secrets daemon. Uses the daemon's
 * /openai/speech-stream endpoint which proxies OpenAI TTS with HTTP chunked
 * transfer encoding. Yields Uint8Array chunks as they arrive, buffering small
 * chunks into at least 4 KB before yielding to reduce WS overhead.
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

const MIN_YIELD_BYTES = 1024; // don't yield chunks smaller than 1 KB (reduces first-chunk latency)

async function* synthesize(req: TtsSynthesizeRequest): AsyncIterable<TtsStreamChunk> {
  const auth = resolveDaemonAuth(req.providerConfig);
  const stream = daemonStream(
    auth,
    "/openai/speech-stream",
    {
      input: req.text,
      voice: req.voice ?? "alloy",
      model: req.model ?? "tts-1",
      response_format: mapFormat(req.format),
    },
    { timeoutMs: 120_000, signal: req.signal },
  );

  let seq = 0;
  let buffer: Uint8Array[] = [];
  let bufferedBytes = 0;

  for await (const chunk of stream) {
    buffer.push(chunk);
    bufferedBytes += chunk.byteLength;
    if (bufferedBytes >= MIN_YIELD_BYTES) {
      const merged = mergeChunks(buffer, bufferedBytes);
      buffer = [];
      bufferedBytes = 0;
      yield { seq: ++seq, chunk: merged };
    }
  }

  // Flush any remaining buffered bytes
  if (bufferedBytes > 0) {
    const merged = mergeChunks(buffer, bufferedBytes);
    yield { seq: ++seq, chunk: merged };
  }
}

function mergeChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}

const descriptor: TtsProviderDescriptor = {
  id: "voice-chat/openai",
  label: "OpenAI TTS (via daemon)",
  streaming: true,
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
