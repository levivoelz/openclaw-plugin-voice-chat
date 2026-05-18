import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { ProviderRegistry } from "../registry.js";
import type { SttCreateOptions, SttSession } from "./types.js";

/**
 * Local Parakeet TDT STT via `parakeet-mlx` (Apple-Silicon-native, MLX
 * framework). Buffered PCM goes through a long-lived Unix-socket daemon that
 * holds the model in memory across utterances. On socket failure the provider
 * automatically falls back to the original CLI-spawn path so the plugin still
 * works in environments without the daemon.
 *
 * Config (under `channels.voice-chat.parakeet`):
 *   - binary: path to parakeet-mlx (default: looked up on PATH)
 *   - model:  HuggingFace model id (default: mlx-community/parakeet-tdt-0.6b-v3)
 *   - daemonSocket: Unix socket path (default: /tmp/openclaw-parakeet.sock)
 *   - daemonBin:    Python script to launch as daemon (default: auto-detected)
 *   - language: ignored (parakeet-tdt is English-only at this size)
 */

const SOCKET_PATH = "/tmp/openclaw-parakeet.sock";
// Resolve the daemon script path relative to this module's location.
const _dir = dirname(fileURLToPath(import.meta.url));
// From dist/providers/stt/ → project root → daemon/
const DAEMON_SCRIPT = join(_dir, "../../../daemon/parakeet-daemon.py");

// ─── WAV wrapping ────────────────────────────────────────────────────────────

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

// ─── Config ──────────────────────────────────────────────────────────────────

type ParakeetConfig = {
  binary?: string;
  model?: string;
  daemonSocket?: string;
  daemonBin?: string;
  /** Drop transcripts whose mean per-token confidence falls below this.
   *  Real speech scores ~0.95+; hallucinations on ambient noise typically
   *  score 0.6–0.85. Set to 0 to disable. Default 0.85. */
  minConfidence?: number;
};

function readParakeetConfig(cfg: Record<string, unknown>): Required<ParakeetConfig> {
  const p = (cfg["parakeet"] ?? {}) as ParakeetConfig;
  return {
    binary: p.binary ?? "parakeet-mlx",
    model: p.model ?? "mlx-community/parakeet-tdt-0.6b-v3",
    daemonSocket: p.daemonSocket ?? SOCKET_PATH,
    daemonBin: p.daemonBin ?? DAEMON_SCRIPT,
    minConfidence: typeof p.minConfidence === "number" ? p.minConfidence : 0.85,
  };
}

// ─── Daemon lifecycle ─────────────────────────────────────────────────────────

let daemonSpawnAttempted = false;

/**
 * Spawn the daemon detached so it outlives the Node process. If the daemon
 * binary doesn't exist, skip silently — the CLI fallback will handle it.
 */
function spawnDaemon(cfg: Required<ParakeetConfig>): void {
  if (daemonSpawnAttempted) return;
  daemonSpawnAttempted = true;

  const script = cfg.daemonBin;
  if (!existsSync(script)) {
    // Daemon script not installed — that's fine, CLI path will be used.
    return;
  }

  // Use the python3 that ships with the uv-installed parakeet-mlx env if
  // possible, otherwise fall back to system python3.
  const python = resolvePython();
  const child = spawn(
    python,
    [script, "--model", cfg.model, "--socket", cfg.daemonSocket],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  if (PARAKEET_DEBUG && child.pid !== undefined) {
    process.stderr.write(`[parakeet] daemon spawn pid=${child.pid}\n`);
  }
  child.unref();
}

function resolvePython(): string {
  // Derive python3 path from the uv-installed parakeet-mlx binary so it has
  // parakeet_mlx on its sys.path. Fall back to system python3 if not found.
  try {
    const binaryPath = execFileSync("which", ["parakeet-mlx"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    if (binaryPath) {
      // parakeet-mlx binary lives in the uv tool's bin/. The virtualenv python
      // is in the same bin/ directory.
      const toolBin = dirname(binaryPath);
      for (const name of ["python3", "python"]) {
        const candidate = join(toolBin, name);
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch { /* not found on PATH */ }
  return "python3";
}

// ─── Socket transport ─────────────────────────────────────────────────────────

const PARAKEET_DEBUG = !!process.env["VOICE_CHAT_DEBUG"];

/**
 * Send PCM audio to the daemon over a Unix socket. Returns the transcribed
 * text, or throws if the daemon is unreachable or returns an error.
 *
 * Timeout: 10 s connect + 60 s inference.
 */
export type TranscribeResult = { text: string; confidence: number | null };

function transcribeViaDaemon(
  pcm: Buffer,
  sampleRate: number,
  socketPath: string,
): Promise<TranscribeResult> {
  const t0 = Date.now();
  return new Promise<TranscribeResult>((resolve, reject) => {
    const payload = JSON.stringify({
      audio_pcm_b64: pcm.toString("base64"),
      sample_rate: sampleRate,
    }) + "\n";

    let sock: Socket | null = null;
    let settled = false;
    let recvBuf = "";
    let connectMs: number | null = null;

    const connectTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock?.destroy();
        reject(new Error("parakeet-daemon: connect timeout"));
      }
    }, 10_000);

    const inferTimer = { ref: null as ReturnType<typeof setTimeout> | null };

    function done(err: Error | null, result?: TranscribeResult) {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (inferTimer.ref) clearTimeout(inferTimer.ref);
      sock?.destroy();
      if (err) reject(err);
      else {
        if (PARAKEET_DEBUG) {
          const roundTripMs = Date.now() - t0;
          process.stderr.write(`[parakeet] socket round-trip ms=${roundTripMs}\n`);
        }
        resolve(result!);
      }
    }

    try {
      sock = createConnection({ path: socketPath });
    } catch (err) {
      clearTimeout(connectTimer);
      reject(err);
      return;
    }

    sock.on("connect", () => {
      connectMs = Date.now() - t0;
      if (PARAKEET_DEBUG) {
        process.stderr.write(`[parakeet] socket connect ms=${connectMs}\n`);
      }
      clearTimeout(connectTimer);
      // Start inference timeout once connected.
      inferTimer.ref = setTimeout(() => {
        done(new Error("parakeet-daemon: inference timeout"));
      }, 60_000);
      sock!.write(payload);
    });

    sock.on("data", (chunk: Buffer) => {
      recvBuf += chunk.toString("utf8");
      const nl = recvBuf.indexOf("\n");
      if (nl === -1) return;
      const line = recvBuf.slice(0, nl).trim();
      try {
        const resp = JSON.parse(line) as { text?: string; confidence?: number | null; error?: string };
        if (resp.error) {
          done(new Error(`parakeet-daemon: ${resp.error}`));
        } else {
          done(null, { text: (resp.text ?? "").trim(), confidence: resp.confidence ?? null });
        }
      } catch (e) {
        done(new Error(`parakeet-daemon: bad response JSON: ${line}`));
      }
    });

    sock.on("error", (err) => done(err));
    sock.on("close", () => {
      if (!settled) done(new Error("parakeet-daemon: connection closed before response"));
    });
  });
}

// ─── CLI fallback (original implementation) ───────────────────────────────────

function transcribeViaCli(
  pcm: Buffer,
  sampleRate: number,
  cfg: Required<ParakeetConfig>,
  timeoutMs: number,
): Promise<TranscribeResult> {
  const dir = mkdtempSync(join(tmpdir(), "parakeet-"));
  const wavPath = join(dir, `${randomUUID()}.wav`);
  writeFileSync(wavPath, wrapPcm16AsWav(pcm, sampleRate));

  return new Promise<TranscribeResult>((resolve, reject) => {
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
        const jsonFile = readdirSync(dir).find((f) => f.endsWith(".json"));
        if (!jsonFile) { reject(new Error("parakeet-mlx produced no JSON output")); return; }
        const parsed = JSON.parse(readFileSync(join(dir, jsonFile), "utf8")) as { text?: string };
        // CLI fallback doesn't expose token-level confidence — return null.
        resolve({ text: (parsed.text ?? "").trim(), confidence: null });
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });
  });
}

// ─── Main transcribe (daemon → CLI fallback) ──────────────────────────────────

/**
 * Try the daemon socket first. If that fails (not running, connect error,
 * or timeout), fall through to the CLI spawn so the plugin always works.
 */
async function transcribe(
  pcm: Buffer,
  sampleRate: number,
  cfg: Required<ParakeetConfig>,
  timeoutMs: number,
): Promise<TranscribeResult> {
  try {
    return await transcribeViaDaemon(pcm, sampleRate, cfg.daemonSocket);
  } catch {
    // Daemon unavailable — fall back to CLI.
    return transcribeViaCli(pcm, sampleRate, cfg, timeoutMs);
  }
}

// ─── Streaming-daemon transport ───────────────────────────────────────────────

/**
 * Open a long-lived Unix-socket connection to the daemon and speak the
 * streaming protocol. Audio is delivered chunk-by-chunk; the daemon returns
 * a rolling partial transcript per chunk, then a final transcript on `end`.
 *
 * Falls back to one-shot CLI transcription if the streaming connection can't
 * be established (daemon offline, old version, etc.) — the caller handles
 * that decision by catching the connect failure here.
 */
type StreamingClient = {
  /** Push a PCM16 chunk; resolves to the daemon's current partial text. */
  sendChunk(pcm: Buffer): Promise<string>;
  /** Finalize the stream and return the final transcript. */
  end(): Promise<TranscribeResult>;
  /** Tear down (best-effort) without waiting for a final. */
  destroy(): void;
};

function openStreamingClient(
  socketPath: string,
  sampleRate: number,
): Promise<StreamingClient> {
  return new Promise<StreamingClient>((resolveOpen, rejectOpen) => {
    let sock: Socket;
    try {
      sock = createConnection({ path: socketPath });
    } catch (e) {
      rejectOpen(e);
      return;
    }

    let recvBuf = "";
    let opened = false;
    let destroyed = false;
    // FIFO of waiters for the next JSON message from the daemon.
    const waiters: Array<{
      resolve: (msg: Record<string, unknown>) => void;
      reject: (err: Error) => void;
    }> = [];

    const connectTimer = setTimeout(() => {
      if (!opened) {
        rejectOpen(new Error("parakeet-daemon: streaming connect timeout"));
        try { sock.destroy(); } catch { /* ignore */ }
      }
    }, 10_000);

    function popWaiter(): typeof waiters[number] | undefined {
      return waiters.shift();
    }

    function failAll(err: Error) {
      while (waiters.length > 0) waiters.shift()!.reject(err);
    }

    sock.on("connect", () => {
      clearTimeout(connectTimer);
      // Send the streaming-start handshake and wait for {streaming: "started"}.
      sock.write(JSON.stringify({ streaming: "start", sample_rate: sampleRate }) + "\n");
      waiters.push({
        resolve: (msg) => {
          if (msg["streaming"] === "started") {
            opened = true;
            resolveOpen(client);
          } else if (typeof msg["error"] === "string") {
            rejectOpen(new Error(`parakeet-daemon: ${msg["error"]}`));
            try { sock.destroy(); } catch { /* ignore */ }
          } else {
            rejectOpen(new Error("parakeet-daemon: unexpected start response"));
            try { sock.destroy(); } catch { /* ignore */ }
          }
        },
        reject: (err) => rejectOpen(err),
      });
    });

    sock.on("data", (chunk: Buffer) => {
      recvBuf += chunk.toString("utf8");
      let nl: number;
      while ((nl = recvBuf.indexOf("\n")) !== -1) {
        const line = recvBuf.slice(0, nl).trim();
        recvBuf = recvBuf.slice(nl + 1);
        if (!line) continue;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(line) as Record<string, unknown>; }
        catch (e) {
          const w = popWaiter();
          w?.reject(new Error(`parakeet-daemon: bad JSON: ${line.slice(0, 100)}`));
          continue;
        }
        const w = popWaiter();
        if (!w) continue; // unsolicited — drop
        if (typeof parsed["error"] === "string") {
          w.reject(new Error(`parakeet-daemon: ${parsed["error"]}`));
        } else {
          w.resolve(parsed);
        }
      }
    });

    sock.on("error", (err) => {
      clearTimeout(connectTimer);
      if (!opened) rejectOpen(err);
      failAll(err);
    });
    sock.on("close", () => {
      clearTimeout(connectTimer);
      const err = new Error("parakeet-daemon: connection closed");
      if (!opened) rejectOpen(err);
      failAll(err);
    });

    const client: StreamingClient = {
      sendChunk(pcm: Buffer): Promise<string> {
        if (destroyed) return Promise.reject(new Error("stream destroyed"));
        return new Promise<string>((resolve, reject) => {
          waiters.push({
            resolve: (msg) => resolve(String(msg["text"] ?? "")),
            reject,
          });
          try {
            sock.write(JSON.stringify({
              streaming: "chunk",
              audio_pcm_b64: pcm.toString("base64"),
            }) + "\n");
          } catch (e) {
            // The waiter we just pushed will surface this via sock error/close.
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      },
      end(): Promise<TranscribeResult> {
        if (destroyed) return Promise.reject(new Error("stream destroyed"));
        return new Promise<TranscribeResult>((resolve, reject) => {
          waiters.push({
            resolve: (msg) => {
              const text = String(msg["text"] ?? "").trim();
              const conf = msg["confidence"];
              resolve({
                text,
                confidence: typeof conf === "number" ? conf : null,
              });
              // Connection no longer needed.
              try { sock.end(); } catch { /* ignore */ }
            },
            reject,
          });
          try {
            sock.write(JSON.stringify({ streaming: "end" }) + "\n");
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        try { sock.destroy(); } catch { /* ignore */ }
      },
    };
  });
}

// ─── Session ──────────────────────────────────────────────────────────────────

function createSession(opts: SttCreateOptions): SttSession {
  const { sampleRate, providerConfig, callbacks } = opts;
  const cfg = readParakeetConfig(providerConfig);

  // Buffer keeps a copy of every PCM chunk so we can fall back to one-shot
  // transcription (daemon non-streaming or CLI) if the streaming connection
  // never came up. Once the streaming client opens successfully we still
  // keep it (small per-utterance memory cost) so a mid-utterance daemon
  // failure can still recover via the buffered audio.
  let buf: Buffer[] = [];
  let connected = true;
  let daemonEnsured = false;
  // Promise resolves to the streaming client, or rejects if the streaming
  // connection couldn't be opened. We start it lazily on first sendAudio.
  let streamPromise: Promise<StreamingClient> | null = null;
  // True once we know the daemon's streaming path is unavailable for THIS
  // utterance — we stop pushing chunks and let endUtterance() fall back.
  let streamFailed = false;
  // Last partial text we forwarded to the caller; used to dedupe so onPartial
  // only fires when the transcript actually changed.
  let lastPartial = "";
  // Serialize chunk sends so the daemon's per-connection FIFO of waiters
  // doesn't get out-of-order responses if Node hands us two sendAudio bursts.
  let chunkChain: Promise<void> = Promise.resolve();

  function ensureDaemon() {
    if (daemonEnsured) return;
    daemonEnsured = true;
    spawnDaemon(cfg);
  }

  function startStream(): Promise<StreamingClient> {
    if (streamPromise) return streamPromise;
    streamPromise = openStreamingClient(cfg.daemonSocket, sampleRate).catch((err) => {
      streamFailed = true;
      if (PARAKEET_DEBUG) {
        process.stderr.write(
          `[parakeet] streaming open failed (${err.message}); will fall back on endUtterance\n`,
        );
      }
      throw err;
    });
    return streamPromise;
  }

  return {
    async connect() { /* no-op */ },
    sendAudio(pcm: Buffer) {
      if (!connected) return;
      buf.push(pcm);
      if (streamFailed) return;
      ensureDaemon();
      // Kick off the stream open (if needed) and queue this chunk behind any
      // earlier chunk send. We deliberately do NOT await here — sendAudio is
      // sync and the WS handler is hot.
      chunkChain = chunkChain.then(async () => {
        if (streamFailed || !connected) return;
        let client: StreamingClient;
        try {
          client = await startStream();
        } catch {
          return; // failure already recorded in streamFailed
        }
        try {
          const partial = await client.sendChunk(pcm);
          const trimmed = partial.trim();
          if (trimmed && trimmed !== lastPartial) {
            lastPartial = trimmed;
            callbacks.onPartial?.(trimmed);
          }
        } catch (e) {
          streamFailed = true;
          if (PARAKEET_DEBUG) {
            const msg = e instanceof Error ? e.message : String(e);
            process.stderr.write(`[parakeet] streaming chunk failed: ${msg}\n`);
          }
        }
      });
    },
    async endUtterance() {
      if (!connected || buf.length === 0) return;
      ensureDaemon();
      const pcm = Buffer.concat(buf);
      buf = [];

      // Drain any in-flight chunk sends so the daemon's FIFO is empty before
      // we ask for the final.
      try { await chunkChain; } catch { /* swallow */ }

      let result: TranscribeResult | null = null;
      let usedStream = false;

      if (!streamFailed && streamPromise) {
        try {
          const client = await streamPromise;
          result = await client.end();
          usedStream = true;
        } catch (e) {
          streamFailed = true;
          if (PARAKEET_DEBUG) {
            const msg = e instanceof Error ? e.message : String(e);
            process.stderr.write(`[parakeet] streaming end failed (${msg}); falling back\n`);
          }
        }
      }

      // Reset per-utterance streaming state regardless of outcome.
      const dyingStream = streamPromise;
      streamPromise = null;
      streamFailed = false;
      lastPartial = "";
      chunkChain = Promise.resolve();
      if (!usedStream && dyingStream) {
        // Make sure we don't leak the socket if endStream() never ran.
        dyingStream.then((c) => c.destroy()).catch(() => { /* ignore */ });
      }

      if (!result) {
        // Streaming path failed (or wasn't used) — one-shot via daemon → CLI.
        try {
          result = await transcribe(pcm, sampleRate, cfg, 60_000);
        } catch (e) {
          callbacks.onError?.(e instanceof Error ? e : new Error(String(e)));
          return;
        }
      }

      const { text, confidence } = result;
      if (!text) return;
      // Drop low-confidence transcripts. Parakeet (like every CTC/transducer
      // model) confidently hallucinates plausible English when fed sustained
      // non-speech audio (HVAC, breathing, typing). Its own per-token
      // confidence is the right signal — entropy is high on those outputs.
      // CLI fallback returns null confidence; never drop in that case.
      if (
        confidence !== null &&
        cfg.minConfidence > 0 &&
        confidence < cfg.minConfidence
      ) {
        if (PARAKEET_DEBUG) {
          process.stderr.write(
            `[parakeet] dropping low-confidence transcript conf=${confidence.toFixed(3)} text="${text.slice(0, 60)}"\n`,
          );
        }
        return;
      }
      callbacks.onFinal?.(text);
    },
    async close() {
      connected = false;
      buf = [];
      const s = streamPromise;
      streamPromise = null;
      if (s) {
        try { (await s).destroy(); } catch { /* ignore */ }
      }
    },
    isConnected() { return connected; },
  };
}

export function registerParakeetLocalStt(registry: ProviderRegistry): void {
  registry.registerStt({
    id: "voice-chat/parakeet-local",
    label: "NVIDIA Parakeet TDT (local, Apple MLX)",
    streaming: true,
    models: ["mlx-community/parakeet-tdt-0.6b-v3"],
    defaultModel: "mlx-community/parakeet-tdt-0.6b-v3",
    isConfigured: () => true,
    create: createSession,
  });
}
