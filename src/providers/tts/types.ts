/**
 * Internal TTS provider contract. Mirrors the SDK's SpeechProviderPlugin
 * (streaming via ReadableStream<Uint8Array>) but with a thinner surface for our
 * orchestrator.
 */

import type { AudioFormat } from "../../types.js";

export type TtsSynthesizeRequest = {
  text: string;
  model?: string;
  voice?: string;
  format: AudioFormat;
  providerConfig: Record<string, unknown>;
  /** AbortSignal for interrupt. */
  signal?: AbortSignal;
};

export type TtsStreamChunk = { seq: number; chunk: Uint8Array };

export type TtsVoice = {
  id: string;
  label: string;
  language?: string;
  gender?: "male" | "female" | "neutral";
};

export type TtsProviderDescriptor = {
  id: string;
  label: string;
  /** Whether the provider yields the audio as an incremental stream. Non-streaming providers buffer once. */
  streaming: boolean;
  models: string[];
  defaultModel: string;
  /** Voices — can be static or fetched on demand. */
  voices(pluginConfig: Record<string, unknown>): Promise<TtsVoice[]>;
  defaultVoice: string;
  /** Audio formats this provider can emit. */
  formats: AudioFormat[];
  defaultFormat: AudioFormat;
  isConfigured(pluginConfig: Record<string, unknown>): boolean;
  /** Returns an async iterable of audio chunks tagged with seq. */
  synthesize(req: TtsSynthesizeRequest): AsyncIterable<TtsStreamChunk>;
};
