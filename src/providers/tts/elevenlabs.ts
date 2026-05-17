import type { ProviderRegistry } from "../registry.js";
import type { TtsProviderDescriptor, TtsSynthesizeRequest, TtsStreamChunk, TtsVoice } from "./types.js";
import { resolveDaemonAuth, isDaemonConfigured, daemonPost } from "../daemon.js";

/**
 * ElevenLabs TTS via the iris-secrets daemon. Daemon endpoints:
 *  - POST /elevenlabs/tts    → {audio_b64, format}
 *  - POST /elevenlabs/voices → {voices: [{id, label, language, gender}]}
 *
 * Note: ElevenLabs free-tier API keys cannot synthesize library voices —
 * the daemon will surface the upstream 402 cleanly. Use a paid-plan key.
 */

const FALLBACK_VOICES: TtsVoice[] = [
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel" },
  { id: "AZnzlk1XvdvUeBnXmlld", label: "Domi" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Bella" },
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni" },
];

let cachedVoices: TtsVoice[] | null = null;

async function listVoices(cfg: Record<string, unknown>): Promise<TtsVoice[]> {
  if (cachedVoices) return cachedVoices;
  try {
    const auth = resolveDaemonAuth(cfg);
    const res = await daemonPost<{ voices: TtsVoice[] }>(auth, "/elevenlabs/voices", {}, { timeoutMs: 10_000 });
    cachedVoices = res.voices && res.voices.length > 0 ? res.voices : FALLBACK_VOICES;
  } catch {
    cachedVoices = FALLBACK_VOICES;
  }
  return cachedVoices;
}

async function* synthesize(req: TtsSynthesizeRequest): AsyncIterable<TtsStreamChunk> {
  const auth = resolveDaemonAuth(req.providerConfig);
  const res = await daemonPost<{ audio_b64: string; format: string }>(
    auth,
    "/elevenlabs/tts",
    {
      text: req.text,
      voice_id: req.voice ?? "21m00Tcm4TlvDq8ikWAM",
      model_id: req.model ?? "eleven_turbo_v2_5",
      output_format: "mp3_44100_128",
    },
    { timeoutMs: 120_000, signal: req.signal },
  );
  const audio = Buffer.from(res.audio_b64, "base64");
  yield { seq: 1, chunk: new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength) };
}

const descriptor: TtsProviderDescriptor = {
  id: "voice-chat/elevenlabs",
  label: "ElevenLabs (via daemon)",
  streaming: false,
  models: ["eleven_turbo_v2_5", "eleven_multilingual_v2", "eleven_flash_v2_5"],
  defaultModel: "eleven_turbo_v2_5",
  voices: listVoices,
  defaultVoice: "21m00Tcm4TlvDq8ikWAM",
  formats: ["mp3"],
  defaultFormat: "mp3",
  isConfigured: (cfg) => isDaemonConfigured(cfg),
  synthesize,
};

export function registerElevenlabsTts(registry: ProviderRegistry): void {
  registry.registerTts(descriptor);
}
