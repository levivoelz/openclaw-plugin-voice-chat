/**
 * macOS audio: mic capture via sox, playback via afplay (falls back to sox play).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AudioFormat } from "../types.js";

const WAV_HEADER_SIZE = 44;

export function startRecording(opts: {
  sampleRate: number;
  onPcmFrame: (buf: Buffer) => void;
  onError: (e: Error) => void;
}): { stop: () => void } {
  const proc = spawn("sox", [
    "-d",                       // default input device
    "-t", "raw",
    "-r", String(opts.sampleRate),
    "-c", "1",
    "-b", "16",
    "-e", "signed-integer",
    "-",                        // stdout
  ]);

  proc.stdout.on("data", (chunk: Buffer) => opts.onPcmFrame(chunk));
  proc.stderr.on("data", () => { /* suppress sox progress */ });
  proc.on("error", opts.onError);
  proc.on("close", (code) => {
    if (code !== null && code !== 0) {
      opts.onError(new Error(`sox exited with code ${code}`));
    }
  });

  return { stop: () => killQuietly(proc) };
}

/**
 * VAD recording: continuous mic capture, no client-side silence detection.
 * Server-side VAD (OpenAI Realtime turn_detection) handles utterance
 * boundaries. We just stream PCM out as fast as sox produces it.
 */
export function startVadRecording(opts: {
  sampleRate: number;
  onUtterance: (pcm: Buffer) => void;
  onError: (e: Error) => void;
}): { stop: () => void } {
  const proc = spawn("sox", [
    "-d",
    "-t", "raw",
    "-r", String(opts.sampleRate),
    "-c", "1",
    "-b", "16",
    "-e", "signed-integer",
    "-",
  ]);

  proc.stdout.on("data", (chunk: Buffer) => {
    opts.onUtterance(chunk);
  });

  proc.stderr.on("data", () => {});
  proc.on("error", opts.onError);
  proc.on("close", (code) => {
    if (code !== null && code !== 0 && code !== 143 /* SIGTERM */) {
      opts.onError(new Error(`sox vad exited with code ${code}`));
    }
  });

  return { stop: () => killQuietly(proc) };
}

export async function playAudio(args: {
  audio: Buffer;
  format: AudioFormat;
  sampleRate?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const { audio, format, sampleRate = 16000, signal } = args;

  // For pcm16 we build a minimal WAV so afplay / sox can decode it.
  let buf = audio;
  let ext = format === "wav" ? "wav" : format === "mp3" ? "mp3" : format === "opus" ? "opus" : "raw";

  if (format === "pcm16") {
    buf = buildWavHeader(audio, sampleRate);
    ext = "wav";
  }

  const tmp = join(tmpdir(), `voice-chat-${randomUUID()}.${ext}`);
  writeFileSync(tmp, buf);

  await runPlayer(tmp, signal);

  try { unlinkSync(tmp); } catch { /* best-effort */ }
}

function buildWavHeader(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const header = Buffer.alloc(WAV_HEADER_SIZE);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);              // subchunk1 size (PCM)
  header.writeUInt16LE(1, 20);               // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

function runPlayer(tmpFile: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { resolve(); return; }

    // Try afplay first; fall back to sox play.
    const proc = trySpawn("afplay", [tmpFile]) ?? trySpawn("sox", ["play", tmpFile]);
    if (!proc) { reject(new Error("No audio player found (tried afplay, sox play)")); return; }

    const onAbort = () => killQuietly(proc);
    signal?.addEventListener("abort", onAbort);

    proc.on("error", (e) => { signal?.removeEventListener("abort", onAbort); reject(e); });
    proc.on("close", () => { signal?.removeEventListener("abort", onAbort); resolve(); });
  });
}

function trySpawn(cmd: string, args: string[]): ChildProcess | null {
  try {
    return spawn(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    return null;
  }
}

function killQuietly(proc: ChildProcess): void {
  try { proc.kill(); } catch { /* already dead */ }
}
