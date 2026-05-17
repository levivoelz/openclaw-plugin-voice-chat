import { spawn } from "node:child_process";
import type { ProviderRegistry } from "../registry.js";
import type { TtsProviderDescriptor, TtsSynthesizeRequest, TtsStreamChunk, TtsVoice } from "./types.js";

// Process-lifetime cache — `say -v ?` is slow and its output is static.
let cachedVoices: TtsVoice[] | null = null;

function parseSayVoices(): Promise<TtsVoice[]> {
  return new Promise((resolve) => {
    const proc = spawn("say", ["-v", "?"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve([{ id: "Samantha", label: "Samantha (en_US)" }]);
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const voices: TtsVoice[] = [];
      // Each line: "Samantha        en_US    # ..."
      const re = /^(\S+)\s+(\w+(?:_\w+)?)\s+#/;
      for (const line of text.split("\n")) {
        const m = re.exec(line.trim());
        if (m) {
          voices.push({ id: m[1]!, label: m[1]!, language: m[2]! });
        }
      }
      resolve(voices.length > 0 ? voices : [{ id: "Samantha", label: "Samantha (en_US)" }]);
    });
    proc.on("error", () => {
      resolve([{ id: "Samantha", label: "Samantha (en_US)" }]);
    });
  });
}

async function getVoices(): Promise<TtsVoice[]> {
  if (cachedVoices) return cachedVoices;
  cachedVoices = await parseSayVoices();
  return cachedVoices;
}

const descriptor: TtsProviderDescriptor = {
  id: "voice-chat/macos-say",
  label: "macOS Say (offline)",
  streaming: false,
  models: ["default"],
  defaultModel: "default",

  async voices(_cfg: Record<string, unknown>): Promise<TtsVoice[]> {
    return getVoices();
  },

  defaultVoice: "Samantha",
  formats: ["wav"],
  defaultFormat: "wav",

  isConfigured(_cfg: Record<string, unknown>): boolean {
    return process.platform === "darwin";
  },

  async *synthesize(req: TtsSynthesizeRequest): AsyncIterable<TtsStreamChunk> {
    const voice = req.voice ?? "Samantha";

    // LEI16@22050 = little-endian signed 16-bit PCM at 22050 Hz (AIFF-like raw).
    // Writing to "-" sends AIFF to stdout; we wrap it in a WAV container upstream.
    const child = spawn(
      "say",
      ["-v", voice, "-o", "-", "--data-format=LEI16@22050"],
      { stdio: ["pipe", "pipe", "inherit"] },
    );

    // Propagate abort to the child process.
    const onAbort = () => child.kill();
    if (req.signal) {
      if (req.signal.aborted) {
        child.kill();
      } else {
        req.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Write the text to stdin then close it so `say` knows to start.
    child.stdin.end(req.text, "utf8");

    let seq = 0;
    const chunks: TtsStreamChunk[] = [];

    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d: Buffer) => {
        chunks.push({ seq: ++seq, chunk: new Uint8Array(d.buffer, d.byteOffset, d.byteLength) });
      });
      child.on("close", (code) => {
        if (code !== 0 && !req.signal?.aborted) {
          reject(new Error(`say exited with code ${code}`));
        } else {
          resolve();
        }
      });
      child.on("error", (err) => reject(err));
    });

    req.signal?.removeEventListener("abort", onAbort);

    for (const c of chunks) {
      yield c;
    }
  },
};

export function registerMacosSayTts(registry: ProviderRegistry): void {
  registry.registerTts(descriptor);
}
