/**
 * Internal STT provider contract used by the VoiceSessionService. Wraps the
 * SDK's RealtimeTranscriptionProviderPlugin so we can also support chunked
 * (non-realtime) providers like whisper-1 behind the same interface.
 */

export type SttSessionCallbacks = {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (error: Error) => void;
};

export type SttSession = {
  /** Open underlying connection (no-op for chunked providers). */
  connect(): Promise<void>;
  /** PCM16 mono frame at the session's sampleRate. */
  sendAudio(pcm: Buffer): void;
  /** Mark utterance boundary — required for chunked providers, optional for streaming. */
  endUtterance(): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
};

export type SttCreateOptions = {
  model?: string;
  language?: string;
  sampleRate: number;
  /** Provider-specific configuration resolved from the plugin's pluginConfig. */
  providerConfig: Record<string, unknown>;
  callbacks: SttSessionCallbacks;
};

export type SttProviderDescriptor = {
  /** Fully-qualified id like "voice-chat/openai-realtime". */
  id: string;
  /** Human label for pickers. */
  label: string;
  /** Whether this provider streams partials. Chunked providers return only finals. */
  streaming: boolean;
  /** Models the provider offers. Static list is fine; can be dynamic if the API supports it. */
  models: string[];
  /** Default model. */
  defaultModel: string;
  /** True if the API key is missing — surfaced in the settings page. */
  isConfigured(pluginConfig: Record<string, unknown>): boolean;
  create(opts: SttCreateOptions): SttSession;
};
