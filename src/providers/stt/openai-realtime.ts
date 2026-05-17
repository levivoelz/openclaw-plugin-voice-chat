import WebSocket from "ws";
import type { ProviderRegistry } from "../registry.js";
import type { SttCreateOptions, SttSession } from "./types.js";

function getApiKey(cfg: Record<string, unknown>): string {
  const openai = cfg["openai"];
  if (openai && typeof openai === "object" && "apiKey" in openai) {
    const key = (openai as Record<string, unknown>)["apiKey"];
    if (typeof key === "string" && key.length > 0) return key;
  }
  return "";
}

function createRealtimeSession(opts: SttCreateOptions): SttSession {
  const { model = "gpt-4o-transcribe", language, providerConfig, callbacks, sampleRate } = opts;
  const apiKey = getApiKey(providerConfig);
  // GA transcription-only endpoint. Session is configured below with a
  // `transcription`-type payload. No beta header — that API is retired.
  const url = `wss://api.openai.com/v1/realtime?intent=transcription`;

  let ws: WebSocket | null = null;
  let connected = false;

  function send(event: unknown): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  const session: SttSession = {
    connect(): Promise<void> {
      return new Promise((resolve, reject) => {
        ws = new WebSocket(url, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        });

        ws.on("open", () => {
          connected = true;
          send({
            type: "session.update",
            session: {
              type: "transcription",
              audio: {
                input: {
                  format: { type: "audio/pcm", rate: sampleRate },
                  transcription: {
                    model,
                    ...(language ? { language } : {}),
                  },
                  // Server VAD so utterances finalize on trailing silence.
                  // We also support manual finalization via endUtterance().
                  turn_detection: {
                    type: "server_vad",
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 500,
                  },
                },
              },
            },
          });
          resolve();
        });

        ws.on("message", (data) => {
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data.toString()) as Record<string, unknown>;
          } catch {
            return;
          }

          const type = event["type"];
          if (type === "conversation.item.input_audio_transcription.delta") {
            // Streaming partial transcript delta.
            const delta = event["delta"];
            if (typeof delta === "string" && callbacks.onPartial) {
              callbacks.onPartial(delta);
            }
          } else if (type === "conversation.item.input_audio_transcription.completed") {
            const transcript = event["transcript"];
            if (typeof transcript === "string" && callbacks.onFinal) {
              callbacks.onFinal(transcript);
            }
          } else if (type === "error") {
            const err = event["error"];
            const msg =
              err && typeof err === "object" && "message" in err
                ? String((err as Record<string, unknown>)["message"])
                : "OpenAI Realtime error";
            if (callbacks.onError) {
              callbacks.onError(new Error(msg));
            }
          }
        });

        ws.on("error", (err) => {
          connected = false;
          if (callbacks.onError) callbacks.onError(err instanceof Error ? err : new Error(String(err)));
          reject(err);
        });

        ws.on("close", () => {
          connected = false;
        });
      });
    },

    sendAudio(pcm: Buffer): void {
      send({
        type: "input_audio_buffer.append",
        audio: pcm.toString("base64"),
      });
    },

    endUtterance(): Promise<void> {
      send({ type: "input_audio_buffer.commit" });
      // The transcript arrives asynchronously via the message handler above.
      return Promise.resolve();
    },

    close(): Promise<void> {
      if (ws) {
        ws.close();
        ws = null;
      }
      connected = false;
      return Promise.resolve();
    },

    isConnected(): boolean {
      return connected && ws !== null && ws.readyState === WebSocket.OPEN;
    },
  };

  return session;
}

export function registerOpenaiRealtimeStt(registry: ProviderRegistry): void {
  registry.registerStt({
    id: "voice-chat/openai-realtime",
    label: "OpenAI Realtime (streaming)",
    streaming: true,
    models: ["gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
    defaultModel: "gpt-4o-transcribe",

    isConfigured(cfg: Record<string, unknown>): boolean {
      return getApiKey(cfg).length > 0;
    },

    create(opts: SttCreateOptions): SttSession {
      return createRealtimeSession(opts);
    },
  });
}
