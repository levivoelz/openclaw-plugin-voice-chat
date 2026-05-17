import type { ProviderRegistry } from "../registry.js";
import type { TtsProviderDescriptor, TtsSynthesizeRequest, TtsStreamChunk, TtsVoice } from "./types.js";

const OPENAI_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer", "ballad", "coral", "ash", "sage", "verse"] as const;

// OpenAI uses "pcm" on the wire; we expose it as "pcm16" to match AudioFormat.
function mapFormat(fmt: string): string {
  return fmt === "pcm16" ? "pcm" : fmt;
}

const staticVoices: TtsVoice[] = OPENAI_VOICES.map((v) => ({
  id: v,
  label: v.charAt(0).toUpperCase() + v.slice(1),
}));

const descriptor: TtsProviderDescriptor = {
  id: "voice-chat/openai",
  label: "OpenAI TTS",
  streaming: true,
  models: ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"],
  defaultModel: "tts-1",
  async voices(_cfg: Record<string, unknown>): Promise<TtsVoice[]> {
    return staticVoices;
  },
  defaultVoice: "alloy",
  formats: ["mp3", "opus", "pcm16", "wav"],
  defaultFormat: "mp3",

  isConfigured(cfg: Record<string, unknown>): boolean {
    const key = (cfg as { openai?: { apiKey?: unknown } }).openai?.apiKey;
    return typeof key === "string" && key.length > 0;
  },

  async *synthesize(req: TtsSynthesizeRequest): AsyncIterable<TtsStreamChunk> {
    const cfg = req.providerConfig as { openai?: { apiKey?: string } };
    const apiKey = cfg.openai?.apiKey ?? "";
    const model = req.model ?? "tts-1";
    const voice = req.voice ?? "alloy";

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      signal: req.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        voice,
        input: req.text,
        response_format: mapFormat(req.format),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`OpenAI TTS error ${response.status}: ${body}`);
    }

    if (!response.body) {
      throw new Error("OpenAI TTS: response has no body");
    }

    const reader = response.body.getReader();
    let seq = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          yield { seq: ++seq, chunk: value };
        }
      }
    } finally {
      reader.releaseLock();
    }
  },
};

export function registerOpenaiTts(registry: ProviderRegistry): void {
  registry.registerTts(descriptor);
}
