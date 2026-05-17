import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ProviderRegistry } from "../registry.js";
import type { SttCreateOptions, SttSession } from "./types.js";

/**
 * Local Parakeet TDT STT via `parakeet-mlx` (Apple-Silicon-native, MLX
 * framework). Buffered PCM goes to a tmp WAV; we shell out to the CLI;
 * parse the JSON output. No network call, no API key — and no whisper
 * training-data hallucinations.
 *
 * Config (under `channels.voice-chat.parakeet`):
 *   - binary: path to parakeet-mlx (default: looked up on PATH)
 *   - model:  HuggingFace model id (default: mlx-community/parakeet-tdt-0.6b-v3)
 *   - language: ignored (parakeet-tdt is English-only at this size; multilingual
 *     models exist but we default to the v3-en variant)
 */

function wrapPcm16AsWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataLen = pcm.length;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm]);
}

type ParakeetConfig = {
  binary?: string;
  model?: string;
};

function readParakeetConfig(cfg: Record<string, unknown>): Required<ParakeetConfig> {
  const p = (cfg["parakeet"] ?? {}) as ParakeetConfig;
  return {
    binary: p.binary ?? "parakeet-mlx",
    model: p.model ?? "mlx-community/parakeet-tdt-0.6b-v3",
  };
}

function transcribe(pcm: Buffer, sampleRate: number, cfg: Required<ParakeetConfig>, timeoutMs: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "parakeet-"));
  const wavPath = join(dir, `${randomUUID()}.wav`);
  writeFileSync(wavPath, wrapPcm16AsWav(pcm, sampleRate));

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(cfg.binary, [
      wavPath,
      "--output-format", "json",
      "--output-dir", dir,
      "--model", cfg.model,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`parakeet-mlx timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) {
          reject(new Error(`parakeet-mlx exited ${code}: ${stderr.slice(0, 400)}`));
          return;
        }
        // Output file: <basename>.json — find any .json in dir.
        const jsonFile = readdirSync(dir).find((f) => f.endsWith(".json"));
        if (!jsonFile) { reject(new Error("parakeet-mlx produced no JSON output")); return; }
        const parsed = JSON.parse(readFileSync(join(dir, jsonFile), "utf8")) as { text?: string };
        resolve((parsed.text ?? "").trim());
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });
}

function createSession(opts: SttCreateOptions): SttSession {
  const { sampleRate, providerConfig, callbacks } = opts;
  const cfg = readParakeetConfig(providerConfig);

  let buf: Buffer[] = [];
  let connected = true;

  return {
    async connect() { /* no-op */ },
    sendAudio(pcm: Buffer) { if (connected) buf.push(pcm); },
    async endUtterance() {
      if (!connected || buf.length === 0) return;
      const pcm = Buffer.concat(buf);
      buf = [];
      try {
        const text = await transcribe(pcm, sampleRate, cfg, 60_000);
        if (text && callbacks.onFinal) callbacks.onFinal(text);
      } catch (e) {
        callbacks.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    },
    async close() { connected = false; buf = []; },
    isConnected() { return connected; },
  };
}

export function registerParakeetLocalStt(registry: ProviderRegistry): void {
  registry.registerStt({
    id: "voice-chat/parakeet-local",
    label: "NVIDIA Parakeet TDT (local, Apple MLX)",
    streaming: false,
    models: ["mlx-community/parakeet-tdt-0.6b-v3"],
    defaultModel: "mlx-community/parakeet-tdt-0.6b-v3",
    // Always "configured" — the binary check happens at first use.
    isConfigured: () => true,
    create: createSession,
  });
}
