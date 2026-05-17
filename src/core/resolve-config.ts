/**
 * Merge plugin defaults + per-agent overrides + client hints into a single
 * resolved per-session config.
 */

import type { ResolvedVoiceConfig, SttHints, TtsHints, CaptureMode, AudioFormat } from "../types.js";

export type PluginConfigShape = {
  stt?: { provider?: string; model?: string; language?: string };
  tts?: { provider?: string; model?: string; voice?: string; format?: AudioFormat };
  interrupt?: boolean;
  mode?: CaptureMode;
  perAgent?: Record<string, {
    stt?: { provider?: string; model?: string; language?: string };
    tts?: { provider?: string; model?: string; voice?: string; format?: AudioFormat };
  }>;
};

const DEFAULTS = {
  stt: { provider: "voice-chat/parakeet-local", model: "mlx-community/parakeet-tdt-0.6b-v3" },
  tts: { provider: "voice-chat/openai", model: "tts-1", voice: "shimmer", format: "mp3" as AudioFormat },
  interrupt: true,
  mode: "ptt" as CaptureMode,
};

export function resolveVoiceConfig(args: {
  pluginConfig: PluginConfigShape;
  agentId: string;
  sttHints?: SttHints;
  ttsHints?: TtsHints;
}): ResolvedVoiceConfig {
  const base = args.pluginConfig;
  const agent = base.perAgent?.[args.agentId];
  return {
    stt: {
      provider: args.sttHints?.provider ?? agent?.stt?.provider ?? base.stt?.provider ?? DEFAULTS.stt.provider,
      model:    args.sttHints?.model    ?? agent?.stt?.model    ?? base.stt?.model    ?? DEFAULTS.stt.model,
      language: args.sttHints?.language ?? agent?.stt?.language ?? base.stt?.language,
    },
    tts: {
      provider: args.ttsHints?.provider ?? agent?.tts?.provider ?? base.tts?.provider ?? DEFAULTS.tts.provider,
      model:    args.ttsHints?.model    ?? agent?.tts?.model    ?? base.tts?.model    ?? DEFAULTS.tts.model,
      voice:    args.ttsHints?.voice    ?? agent?.tts?.voice    ?? base.tts?.voice    ?? DEFAULTS.tts.voice,
      format:   args.ttsHints?.format   ?? agent?.tts?.format   ?? base.tts?.format   ?? DEFAULTS.tts.format,
    },
    interrupt: base.interrupt ?? DEFAULTS.interrupt,
    mode: base.mode ?? DEFAULTS.mode,
  };
}
