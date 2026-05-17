/**
 * Main voice loop — the default openclaw-voice command.
 */

import readline from "node:readline";
import { WebSocket } from "ws";
import type { AudioFormat, CaptureMode, ServerFrame } from "../types.js";
import { VOICE_PROTOCOL_VERSION } from "../types.js";
import { connect, sendFrame, attachRouter } from "./ws.js";
import { resolveClientId } from "./client-id.js";

const ANSI_DIM    = "\x1b[2m";
const ANSI_RESET  = "\x1b[0m";

// 8KB ≈ a few hundred ms of MP3 at 24kbps — playback starts on the first
// chunk that crosses this size. Lower = snappier first-audio, higher = more
// resistant to brief stalls. 50KB used to push first-audio out ~300–400ms.
const QUICK_START_BYTES = 8 * 1024;

type AudioMod = typeof import("./audio-mac.js");

export type TalkOptions = {
  gateway:     string;
  agentId?:    string;
  session?:    string;
  /** Resume the last voice session for this agent (use stored clientId). */
  resume?:     boolean;
  /** Use a specific clientId (peer.id for routing). Overrides resume. */
  clientId?:   string;
  mode:        CaptureMode;
  stt?:        string;
  sttModel?:   string;
  tts?:        string;
  ttsModel?:   string;
  voice?:      string;
  format:      AudioFormat;
  noTts:       boolean;
  noStt:       boolean;
  print:       boolean;
  deviceToken?: string;
  debug:       boolean;
};

export async function talk(opts: TalkOptions): Promise<void> {
  const audioMod = await loadAudioMod();
  const play = audioMod.playAudio;

  const wsUrl = buildWsUrl(opts);
  const headers: Record<string, string> = {};
  if (opts.deviceToken) headers["Authorization"] = `Bearer ${opts.deviceToken}`;

  if (opts.debug) process.stderr.write(`[debug] connecting ${wsUrl}\n`);

  let ws: WebSocket;
  try {
    ws = await connect(wsUrl, headers);
  } catch (e) {
    process.stderr.write(`Error: gateway unreachable: ${(e as Error).message}\n`);
    process.exit(2);
    // Unreachable — process.exit() terminates, but TypeScript needs a throw here.
    throw new Error("unreachable");
  }

  // TTS audio accumulator per turn.
  const ttsBuffers = new Map<string, Buffer[]>();
  let activePlayer: AbortController | null = null;
  // Per-turn debug timing for client side.
  const ttsFirstChunkAt = new Map<string, number>();  // turnId -> timestamp of first chunk
  let lastSpeechEndAt: number | null = null;

  // Start an audio playback, cancelling any in-flight one.
  async function startPlayback(turnId: string): Promise<void> {
    if (opts.noTts) return;
    const chunks = ttsBuffers.get(turnId);
    if (!chunks || chunks.length === 0) return;

    const buf = Buffer.concat(chunks);
    ttsBuffers.delete(turnId);

    activePlayer?.abort();
    const ac = new AbortController();
    activePlayer = ac;

    const playbackStart = Date.now();
    if (opts.debug) {
      const firstChunkAt = ttsFirstChunkAt.get(turnId);
      const msSinceFirstChunk = firstChunkAt !== null && firstChunkAt !== undefined
        ? playbackStart - firstChunkAt
        : null;
      process.stderr.write(
        `[debug] playback start turn=${turnId.slice(0, 8)} ms_since_first_chunk=${msSinceFirstChunk ?? "?"}\n`,
      );
    }

    try {
      await play({ audio: buf, format: opts.format, signal: ac.signal });
      if (opts.debug) {
        const totalMs = Date.now() - playbackStart;
        process.stderr.write(
          `[debug] playback done turn=${turnId.slice(0, 8)} total_ms=${totalMs}\n`,
        );
      }
    } catch {
      // swallow player errors in normal mode
    } finally {
      if (activePlayer === ac) activePlayer = null;
      ttsFirstChunkAt.delete(turnId);
    }
  }

  function interruptPlayback(): void {
    activePlayer?.abort();
    activePlayer = null;
    sendFrame(ws, { type: "interrupt" });
  }

  let sessionKey: string | undefined;

  attachRouter(ws, {
    onFrame(frame: ServerFrame) {
      switch (frame.type) {
        case "ready":
          sessionKey = frame.sessionKey;
          if (opts.debug) process.stderr.write(`[debug] ready session=${sessionKey}\n`);
          // In PTT mode start listening for keypresses now.
          if (opts.noStt) {
            startTextMode();
          } else if (opts.mode === "ptt") {
            startPttMode();
          } else {
            startVadMode();
          }
          break;

        case "transcript.partial":
          if (opts.print) process.stderr.write(`${ANSI_DIM}${frame.text}${ANSI_RESET}\r`);
          break;

        case "transcript.final":
          if (opts.print) process.stderr.write(`${ANSI_DIM}You: ${frame.text}${ANSI_RESET}\n`);
          break;

        case "agent.delta":
          if (opts.print) process.stdout.write(frame.text);
          break;

        case "agent.done":
          if (opts.print) process.stdout.write("\n");
          break;

        case "tts.chunk": {
          if (opts.noTts) break;
          const turnId = frame.turnId;
          if (!ttsBuffers.has(turnId)) ttsBuffers.set(turnId, []);
          // The next binary message is the audio payload; onBinary handles it.
          break;
        }

        case "tts.done":
          void startPlayback(frame.turnId);
          break;

        case "error":
          process.stderr.write(`Error [${frame.code}]: ${frame.message}\n`);
          if (!frame.recoverable) process.exit(1);
          break;

        case "pong":
          break;
      }
    },

    onBinary(buf: Buffer) {
      if (opts.noTts) return;
      // Find the most recently opened turn buffer and append.
      // We don't track which turnId the binary belongs to here because the
      // JSON tts.chunk frame always arrives immediately before the binary frame.
      // The last entry in ttsBuffers is the right one.
      const last = [...ttsBuffers.keys()].at(-1);
      if (!last) return;
      const arr = ttsBuffers.get(last)!;

      // Log first chunk timing per turn.
      if (opts.debug && !ttsFirstChunkAt.has(last)) {
        const now = Date.now();
        ttsFirstChunkAt.set(last, now);
        const msSinceSpeechEnd = lastSpeechEndAt !== null ? now - lastSpeechEndAt : null;
        process.stderr.write(
          `[debug] tts first-chunk turn=${last.slice(0, 8)} ms_since_speech_end=${msSinceSpeechEnd ?? "?"}\n`,
        );
      }

      arr.push(buf);

      // Quick-start: begin playback once enough audio has buffered.
      const total = arr.reduce((n, b) => n + b.length, 0);
      if (total >= QUICK_START_BYTES) {
        void startPlayback(last);
      }
    },

    onClose(code, reason) {
      if (opts.debug) process.stderr.write(`[debug] ws closed ${code} ${reason}\n`);
      process.exit(0);
    },

    onError(err) {
      process.stderr.write(`WS error: ${err.message}\n`);
      process.exit(2);
    },
  });

  // Resolve clientId — fresh by default, or reuse last one via `resume`.
  const clientId = resolveClientId({
    agentId: opts.agentId ?? "default",
    explicit: opts.clientId,
    resume: opts.resume,
  });
  if (opts.debug || opts.print) {
    process.stderr.write(`${ANSI_DIM}[session] clientId=${clientId}${ANSI_RESET}\n`);
  }

  // Send hello.
  sendFrame(ws, {
    type: "hello",
    clientId,
    protocol: VOICE_PROTOCOL_VERSION,
    mode: opts.mode,
    codec: "pcm16",
    sampleRate: 24000,
    sttHints: {
      provider: opts.stt,
      model: opts.sttModel,
    },
    ttsHints: {
      provider: opts.tts,
      model: opts.ttsModel,
      voice: opts.voice,
      format: opts.format,
    },
  });

  // ---- PTT mode ----
  function startPttMode(): void {
    const { startRecording } = audioMod;
    process.stderr.write('Press and hold SPACE to speak. ESC or Ctrl-C to exit.\n');
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    let recorder: { stop: () => void } | null = null;

    process.stdin.on("keypress", (_str, key: { name?: string; sequence?: string; ctrl?: boolean }) => {
      if (!key) return;

      // Escape or Ctrl-C → interrupt and exit.
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        interruptPlayback();
        sendFrame(ws, { type: "bye" });
        ws.close();
        process.exit(0);
      }

      if (key.sequence === " " || key.name === "space") {
        if (!recorder) {
          interruptPlayback();
          sendFrame(ws, { type: "speech.start" });
          recorder = startRecording({
            sampleRate: 16000,
            onPcmFrame: (buf) => {
              if (ws.readyState === WebSocket.OPEN) ws.send(buf, { binary: true });
            },
            onError: (e) => process.stderr.write(`Mic error: ${e.message}\n`),
          });
        }
      } else {
        // Any other key released or different key — if recording, end it.
        if (recorder) {
          recorder.stop();
          recorder = null;
          sendFrame(ws, { type: "speech.end" });
        }
      }
    });

    // Space keydown vs keyup: Node's keypress fires on keydown. For PTT we treat
    // SPACE down as start and the next non-SPACE keypress as stop. This is a
    // reasonable terminal approximation; true key-up detection requires platform bindings.
  }

  // ---- VAD mode ----
  // Client-side amplitude VAD: sox streams continuous PCM, the Vad state
  // machine emits one complete utterance per silence boundary. Each emitted
  // utterance becomes one {speech.start, audio, speech.end} burst.
  function startVadMode(): void {
    const { startVadRecording } = audioMod;
    process.stderr.write('VAD mode active (local). Speak naturally — utterances send on pause. ESC or Ctrl-C to exit.\n');
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    const VAD_SAMPLE_RATE = 24000;
    const recorder = startVadRecording({
      sampleRate: VAD_SAMPLE_RATE,
      onUtterance: (pcm) => {
        const durationMs = Math.round((pcm.byteLength / 2) / VAD_SAMPLE_RATE * 1000);
        if (opts.print) process.stderr.write(`${ANSI_DIM}[vad] utterance ${pcm.byteLength} bytes${ANSI_RESET}\n`);
        if (opts.debug) {
          process.stderr.write(`[debug] vad utterance bytes=${pcm.byteLength} duration_ms=${durationMs}\n`);
        }
        sendFrame(ws, { type: "speech.start" });
        // Chunk into 16KB frames so the server can pipeline.
        const CHUNK = 16 * 1024;
        for (let i = 0; i < pcm.byteLength; i += CHUNK) {
          ws.send(pcm.subarray(i, Math.min(i + CHUNK, pcm.byteLength)), { binary: true });
        }
        sendFrame(ws, { type: "speech.end" });
        if (opts.debug) lastSpeechEndAt = Date.now();
      },
      onError: (e) => process.stderr.write(`Mic error: ${e.message}\n`),
    });

    process.stdin.on("keypress", (_str, key: { name?: string; ctrl?: boolean }) => {
      if (!key) return;
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        interruptPlayback();
        recorder.stop();
        sendFrame(ws, { type: "bye" });
        ws.close();
        process.exit(0);
      }
    });
  }

  // ---- Text / no-STT mode ----
  function startTextMode(): void {
    if (process.stdin.isTTY) process.stderr.write('Type your message and press Enter. Ctrl-C to exit.\n');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed) sendFrame(ws, { type: "text", content: trimmed });
    });
    rl.on("close", () => {
      sendFrame(ws, { type: "bye" });
      ws.close();
      process.exit(0);
    });
  }
}

async function loadAudioMod(): Promise<AudioMod> {
  if (process.platform === "darwin") {
    return import("./audio-mac.js");
  }
  return import("./audio-linux.js") as Promise<AudioMod>;
}

function buildWsUrl(opts: TalkOptions): string {
  // Plugin owns its own WS port — connect to the root of the gateway URL
  // (no path prefix). The plugin's WebSocketServer accepts any path.
  const u = new URL(opts.gateway);
  if (opts.session) u.searchParams.set("session", opts.session);
  if (opts.agentId) u.searchParams.set("agent", opts.agentId);
  return u.toString();
}
