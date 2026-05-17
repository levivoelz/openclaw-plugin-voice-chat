import type { ProviderRegistry } from "../registry.js";
import type { TtsProviderDescriptor, TtsSynthesizeRequest, TtsStreamChunk, TtsVoice } from "./types.js";

const STATIC_VOICES: TtsVoice[] = [
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel" },
  { id: "AZnzlk1XvdvUeBnXmlld", label: "Domi" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Bella" },
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni" },
];

// Process-lifetime cache so we only hit the API once per run.
let cachedVoices: TtsVoice[] | null = null;

async function fetchVoices(apiKey: string): Promise<TtsVoice[]> {
  if (cachedVoices) return cachedVoices;

  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) return STATIC_VOICES;

    const data = (await res.json()) as { voices?: Array<{ voice_id: string; name: string }> };
    const voices = data.voices;
    if (!Array.isArray(voices) || voices.length === 0) return STATIC_VOICES;

    cachedVoices = voices.map((v) => ({ id: v.voice_id, label: v.name }));
    return cachedVoices;
  } catch {
    return STATIC_VOICES;
  }
}

const descriptor: TtsProviderDescriptor = {
  id: "voice-chat/elevenlabs",
  label: "ElevenLabs",
  streaming: true,
  models: ["eleven_turbo_v2_5", "eleven_multilingual_v2", "eleven_flash_v2_5"],
  defaultModel: "eleven_turbo_v2_5",

  async voices(cfg: Record<string, unknown>): Promise<TtsVoice[]> {
    const apiKey = (cfg as { elevenlabs?: { apiKey?: string } }).elevenlabs?.apiKey ?? "";
    if (!apiKey) return STATIC_VOICES;
    return fetchVoices(apiKey);
  },

  defaultVoice: "21m00Tcm4TlvDq8ikWAM",
  formats: ["mp3"],
  defaultFormat: "mp3",

  isConfigured(cfg: Record<string, unknown>): boolean {
    const key = (cfg as { elevenlabs?: { apiKey?: unknown } }).elevenlabs?.apiKey;
    return typeof key === "string" && key.length > 0;
  },

  async *synthesize(req: TtsSynthesizeRequest): AsyncIterable<TtsStreamChunk> {
    const cfg = req.providerConfig as { elevenlabs?: { apiKey?: string } };
    const apiKey = cfg.elevenlabs?.apiKey ?? "";
    const voiceId = req.voice ?? "21m00Tcm4TlvDq8ikWAM";
    const model = req.model ?? "eleven_turbo_v2_5";

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
      {
        method: "POST",
        signal: req.signal,
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model_id: model,
          text: req.text,
          output_format: "mp3_44100_128",
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`ElevenLabs TTS error ${response.status}: ${body}`);
    }

    if (!response.body) {
      throw new Error("ElevenLabs TTS: response has no body");
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

export function registerElevenlabsTts(registry: ProviderRegistry): void {
  registry.registerTts(descriptor);
}
