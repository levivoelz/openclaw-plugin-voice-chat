/**
 * Shared types — WS protocol between voice clients (Control UI panel, CLI) and
 * the plugin's HTTP route. Re-exported as `@levivoelz/openclaw-plugin-voice-chat/protocol`.
 */

export const VOICE_WS_PATH = "/plugins/voice-chat/ws";
export const VOICE_PROTOCOL_VERSION = 1;

export type SttHints = {
  provider?: string;
  model?: string;
  language?: string;
};

export type TtsHints = {
  provider?: string;
  model?: string;
  voice?: string;
  format?: AudioFormat;
};

export type AudioFormat = "pcm16" | "mp3" | "opus" | "wav";

export type CaptureMode = "ptt" | "vad";

/** Client → plugin frames. */
export type ClientFrame =
  | { type: "hello"; clientId: string; protocol: number; mode?: CaptureMode; sttHints?: SttHints; ttsHints?: TtsHints; codec?: AudioFormat; sampleRate?: number }
  | { type: "speech.start" }
  | { type: "speech.end" }
  | { type: "interrupt" }
  | { type: "text"; content: string }
  | { type: "bye" }
  | { type: "ping" };

/** Plugin → client frames. */
export type ServerFrame =
  | { type: "ready"; sessionKey: string; agentId: string; codecs: AudioFormat[]; sttProvider: string; ttsProvider: string; ttsFormat: AudioFormat }
  | { type: "transcript.partial"; text: string }
  | { type: "transcript.final"; text: string; turnId: string }
  | { type: "agent.delta"; text: string; turnId: string }
  | { type: "agent.done"; turnId: string; usage?: Record<string, unknown> }
  | { type: "agent.thinking"; turnId: string; text: string }
  | { type: "agent.tool_call"; turnId: string; toolName: string; input: unknown; toolCallId?: string }
  | { type: "agent.tool_result"; turnId: string; toolName: string; toolCallId?: string; output: unknown; isError?: boolean }
  | { type: "tts.chunk"; turnId: string; seq: number; format: AudioFormat }
  | { type: "tts.done"; turnId: string }
  | { type: "error"; code: VoiceErrorCode; message: string; recoverable?: boolean }
  | { type: "pong" };

export type VoiceErrorCode =
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_AUTH"
  | "INJECT_FAILED"
  | "AGENT_ERROR"
  | "SESSION_NOT_FOUND"
  | "RATE_LIMITED"
  | "BAD_REQUEST"
  | "INTERNAL";

/** Resolved per-session configuration after merging defaults + per-agent + hints. */
export type ResolvedVoiceConfig = {
  stt: { provider: string; model?: string; language?: string };
  tts: { provider: string; model?: string; voice?: string; format: AudioFormat };
  interrupt: boolean;
  mode: CaptureMode;
};

/** Connect query string params on the WS upgrade. */
export type VoiceConnectParams = {
  /** Existing chat session key to attach to. If absent, plugin creates a fresh session. */
  session?: string;
  /** Target agent id. Defaults to the gateway's default agent. */
  agent?: string;
  /** Token if the plugin enforces its own auth (in addition to gateway auth). */
  token?: string;
};

/** Helpers — small enough to live with the types. */
export function isClientFrame(value: unknown): value is ClientFrame {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

export function isServerFrame(value: unknown): value is ServerFrame {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
