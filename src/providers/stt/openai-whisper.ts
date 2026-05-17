import type { ProviderRegistry } from "../registry.js";
import type { SttCreateOptions, SttSession } from "./types.js";
import { resolveDaemonAuth, isDaemonConfigured, daemonPost } from "../daemon.js";

/**
 * Chunked Whisper STT via the iris-secrets daemon.
 *
 * The plugin buffers PCM16 frames, then on `endUtterance()` wraps them in a
 * minimal WAV header, base64-encodes, and POSTs to /openai/transcribe. The
 * daemon holds the OpenAI key and forwards as multipart.
 */

function wrapPcm16AsWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataLen = pcm.length;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);              // PCM chunk size
  header.writeUInt16LE(1, 20);                // format = PCM
  header.writeUInt16LE(1, 22);                // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);   // byte rate (mono × 16-bit)
  header.writeUInt16LE(2, 32);                // block align
  header.writeUInt16LE(16, 34);               // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm]);
}

function createSession(opts: SttCreateOptions): SttSession {
  const { model = "whisper-1", language, sampleRate, providerConfig, callbacks } = opts;
  const auth = resolveDaemonAuth(providerConfig);

  let buf: Buffer[] = [];
  let connected = true;

  return {
    async connect() { /* no-op */ },
    sendAudio(pcm: Buffer) { if (connected) buf.push(pcm); },
    async endUtterance() {
      if (!connected || buf.length === 0) return;
      const pcm = Buffer.concat(buf);
      buf = [];
      const wav = wrapPcm16AsWav(pcm, sampleRate);
      try {
        const res = await daemonPost<{ text?: string }>(auth, "/openai/transcribe", {
          audio_b64: wav.toString("base64"),
          format: "wav",
          model,
          ...(language ? { language } : {}),
        }, { timeoutMs: 60_000 });
        if (res.text && callbacks.onFinal) callbacks.onFinal(res.text);
      } catch (e) {
        callbacks.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    },
    async close() { connected = false; buf = []; },
    isConnected() { return connected; },
  };
}

export function registerOpenaiWhisperStt(registry: ProviderRegistry): void {
  registry.registerStt({
    id: "voice-chat/openai-whisper",
    label: "OpenAI Whisper (chunked, via daemon)",
    streaming: false,
    models: ["whisper-1"],
    defaultModel: "whisper-1",
    isConfigured: (cfg) => isDaemonConfigured(cfg),
    create: createSession,
  });
}
