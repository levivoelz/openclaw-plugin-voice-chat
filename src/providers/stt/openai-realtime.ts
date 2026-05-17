import WebSocket from "ws";
import type { ProviderRegistry } from "../registry.js";
import type { SttCreateOptions, SttSession } from "./types.js";
import { resolveDaemonAuth, isDaemonConfigured, daemonPost } from "../daemon.js";

/**
 * Realtime STT via the iris-secrets daemon. The daemon mints a short-lived
 * OpenAI Realtime client secret (server-side, with the real API key) and
 * returns just the secret. We then open the WS directly to OpenAI using
 * the ephemeral secret as the bearer — the plugin never sees the real key.
 *
 * Endpoint: wss://api.openai.com/v1/realtime?intent=transcription
 *   - No OpenAI-Beta header (Beta API is retired).
 *   - Session is preconfigured server-side when the daemon mints the secret
 *     (model, sample rate, language, turn_detection).
 */

function createSession(opts: SttCreateOptions): SttSession {
  const { model = "gpt-4o-transcribe", language, sampleRate, providerConfig, callbacks } = opts;
  const auth = resolveDaemonAuth(providerConfig);

  let ws: WebSocket | null = null;
  let connected = false;

  function send(event: unknown): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }

  return {
    async connect() {
      const credResp = await daemonPost<{ client_secret: string }>(auth, "/openai/realtime-credentials", {
        model, sampleRate, ...(language ? { language } : {}),
      }, { timeoutMs: 15_000 });
      const ephemeral = credResp.client_secret;
      if (!ephemeral) throw new Error("daemon returned no client_secret for realtime");

      const url = `wss://api.openai.com/v1/realtime?intent=transcription`;
      ws = new WebSocket(url, { headers: { Authorization: `Bearer ${ephemeral}` } });

      await new Promise<void>((resolve, reject) => {
        ws!.on("open", () => { connected = true; resolve(); });
        ws!.on("error", (err) => {
          connected = false;
          callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
          reject(err);
        });
      });

      ws.on("message", (data) => {
        let event: Record<string, unknown>;
        try { event = JSON.parse(data.toString()) as Record<string, unknown>; } catch { return; }
        const type = event["type"];
        if (type === "conversation.item.input_audio_transcription.delta") {
          const delta = event["delta"];
          if (typeof delta === "string") callbacks.onPartial?.(delta);
        } else if (type === "conversation.item.input_audio_transcription.completed") {
          const transcript = event["transcript"];
          if (typeof transcript === "string") callbacks.onFinal?.(transcript);
        } else if (type === "error") {
          const err = event["error"];
          const msg = err && typeof err === "object" && "message" in err
            ? String((err as Record<string, unknown>)["message"])
            : "OpenAI Realtime error";
          callbacks.onError?.(new Error(msg));
        }
      });
      ws.on("close", () => { connected = false; });
    },
    sendAudio(pcm: Buffer) {
      send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
    },
    async endUtterance() {
      send({ type: "input_audio_buffer.commit" });
    },
    async close() {
      if (ws) { ws.close(); ws = null; }
      connected = false;
    },
    isConnected() { return connected && ws !== null && ws.readyState === WebSocket.OPEN; },
  };
}

export function registerOpenaiRealtimeStt(registry: ProviderRegistry): void {
  registry.registerStt({
    id: "voice-chat/openai-realtime",
    label: "OpenAI Realtime (streaming, via daemon)",
    streaming: true,
    models: ["gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
    defaultModel: "gpt-4o-transcribe",
    isConfigured: (cfg) => isDaemonConfigured(cfg),
    create: createSession,
  });
}
