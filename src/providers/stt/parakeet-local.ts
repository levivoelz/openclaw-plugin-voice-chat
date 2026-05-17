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
};

function readParakeetConfig(cfg: Record<string, unknown>): Required<ParakeetConfig> {
  const p = (cfg["parakeet"] ?? {}) as ParakeetConfig;
  return {
    binary: p.binary ?? "parakeet-mlx",
    model: p.model ?? "mlx-community/parakeet-tdt-0.6b-v3",
    daemonSocket: p.daemonSocket ?? SOCKET_PATH,
    daemonBin: p.daemonBin ?? DAEMON_SCRIPT,
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
function transcribeViaDaemon(
  pcm: Buffer,
  sampleRate: number,
  socketPath: string,
): Promise<string> {
  const t0 = Date.now();
  return new Promise<string>((resolve, reject) => {
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

    function done(err: Error | null, text?: string) {
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
        resolve(text!);
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
        const resp = JSON.parse(line) as { text?: string; error?: string };
        if (resp.error) {
          done(new Error(`parakeet-daemon: ${resp.error}`));
        } else {
          done(null, (resp.text ?? "").trim());
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
): Promise<string> {
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
): Promise<string> {
  try {
    return await transcribeViaDaemon(pcm, sampleRate, cfg.daemonSocket);
  } catch {
    // Daemon unavailable — fall back to CLI.
    return transcribeViaCli(pcm, sampleRate, cfg, timeoutMs);
  }
}

// ─── Session ──────────────────────────────────────────────────────────────────

function createSession(opts: SttCreateOptions): SttSession {
  const { sampleRate, providerConfig, callbacks } = opts;
  const cfg = readParakeetConfig(providerConfig);

  let buf: Buffer[] = [];
  let connected = true;
  let daemonEnsured = false;

  function ensureDaemon() {
    if (daemonEnsured) return;
    daemonEnsured = true;
    spawnDaemon(cfg);
  }

  return {
    async connect() { /* no-op */ },
    sendAudio(pcm: Buffer) { if (connected) buf.push(pcm); },
    async endUtterance() {
      if (!connected || buf.length === 0) return;
      ensureDaemon();
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
    isConfigured: () => true,
    create: createSession,
  });
}
