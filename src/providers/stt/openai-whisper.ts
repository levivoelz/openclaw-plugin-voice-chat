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

/**
 * Builds a minimal 44-byte RIFF/WAVE PCM16 header so the raw PCM16 buffer
 * can be sent to the Whisper endpoint as a valid .wav file.
 */
function buildWavHeader(numSamples: number, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const chunkSize = 36 + dataSize; // 36 = rest of RIFF header after chunkSize field

  const header = Buffer.alloc(44);
  let offset = 0;

  header.write("RIFF", offset); offset += 4;
  header.writeUInt32LE(chunkSize, offset); offset += 4;
  header.write("WAVE", offset); offset += 4;
  header.write("fmt ", offset); offset += 4;
  header.writeUInt32LE(16, offset); offset += 4;       // PCM subchunk size
  header.writeUInt16LE(1, offset); offset += 2;        // AudioFormat = PCM
  header.writeUInt16LE(numChannels, offset); offset += 2;
  header.writeUInt32LE(sampleRate, offset); offset += 4;
  header.writeUInt32LE(byteRate, offset); offset += 4;
  header.writeUInt16LE(blockAlign, offset); offset += 2;
  header.writeUInt16LE(bitsPerSample, offset); offset += 2;
  header.write("data", offset); offset += 4;
  header.writeUInt32LE(dataSize, offset);

  return header;
}

function createWhisperSession(opts: SttCreateOptions): SttSession {
  const { model = "whisper-1", providerConfig, callbacks, sampleRate } = opts;
  const apiKey = getApiKey(providerConfig);
  const chunks: Buffer[] = [];

  const session: SttSession = {
    connect(): Promise<void> {
      return Promise.resolve();
    },

    sendAudio(pcm: Buffer): void {
      chunks.push(pcm);
    },

    async endUtterance(): Promise<void> {
      if (chunks.length === 0) return;

      const pcmData = Buffer.concat(chunks);
      chunks.length = 0;

      // PCM16 samples = bytes / 2
      const numSamples = pcmData.byteLength / 2;
      const wavHeader = buildWavHeader(numSamples, sampleRate);
      const wavData = Buffer.concat([wavHeader, pcmData]);

      const form = new FormData();
      // Whisper requires a filename with a recognizable audio extension.
      form.append("file", new Blob([wavData], { type: "audio/wav" }), "audio.wav");
      form.append("model", model);
      if (opts.language) {
        form.append("language", opts.language);
      }

      let text: string;
      try {
        const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        });

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`Whisper API error ${res.status}: ${body}`);
        }

        const json = (await res.json()) as { text: string };
        text = json.text;
      } catch (err) {
        if (callbacks.onError) {
          callbacks.onError(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }

      if (callbacks.onFinal) {
        callbacks.onFinal(text);
      }
    },

    close(): Promise<void> {
      chunks.length = 0;
      return Promise.resolve();
    },

    isConnected(): boolean {
      return true;
    },
  };

  return session;
}

export function registerOpenaiWhisperStt(registry: ProviderRegistry): void {
  registry.registerStt({
    id: "voice-chat/openai-whisper",
    label: "OpenAI Whisper (chunked)",
    streaming: false,
    models: ["whisper-1"],
    defaultModel: "whisper-1",

    isConfigured(cfg: Record<string, unknown>): boolean {
      return getApiKey(cfg).length > 0;
    },

    create(opts: SttCreateOptions): SttSession {
      return createWhisperSession(opts);
    },
  });
}
