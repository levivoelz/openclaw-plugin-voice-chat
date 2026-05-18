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

  // Holder pattern: mode/key handlers reference `ws` via closure on this
  // outer binding, so swapping it on reconnect transparently routes new
  // frames through the new connection.
  let ws: WebSocket | null = null;
  // True after the user has explicitly asked to quit (Ctrl-C, ESC, bye).
  // Stops the reconnect loop.
  let userQuit = false;
  let modesStarted = false;

  // TTS audio accumulator per turn.
  const ttsBuffers = new Map<string, Buffer[]>();
  let activePlayer: AbortController | null = null;
  // FIFO play queue. Server now serializes TTS per turn so chunks arrive in
  // order, but a turn can still produce multiple tts.done events (one per
  // sentence). We must play them sequentially — calling startPlayback while
  // a prior one is in flight would abort and cut audio off mid-sentence.
  let playChain: Promise<void> = Promise.resolve();
  // Set by startVadMode so runPlayback can duck VAD sensitivity during local
  // playback (prevents the speaker→mic loop from triggering phantom turns
  // while still allowing barge-in if the user speaks louder than playback).
  let vadRecorder: { stop: () => void; setSpeakerActive: (a: boolean) => void } | null = null;
  // Per-turn debug timing for client side.
  const ttsFirstChunkAt = new Map<string, number>();  // turnId -> timestamp of first chunk
  let lastSpeechEndAt: number | null = null;

  // Play a buffered audio chunk for `turnId`. Chained via `playChain` so
  // consecutive calls queue instead of cancelling each other.
  function enqueuePlayback(turnId: string): void {
    playChain = playChain.then(() => runPlayback(turnId)).catch(() => { /* swallow */ });
  }

  async function runPlayback(turnId: string): Promise<void> {
    if (opts.noTts) return;
    const chunks = ttsBuffers.get(turnId);
    if (!chunks || chunks.length === 0) return;

    const buf = Buffer.concat(chunks);
    ttsBuffers.delete(turnId);

    const ac = new AbortController();
    activePlayer = ac;
    vadRecorder?.setSpeakerActive(true);

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
      // Keep the duck on for ~250ms after player exits — speaker tail / OS
      // playback buffer can keep ringing briefly after the process returns.
      setTimeout(() => {
        if (!activePlayer) vadRecorder?.setSpeakerActive(false);
      }, 250);
    }
  }

  function interruptPlayback(): void {
    activePlayer?.abort();
    activePlayer = null;
    safeSend({ type: "interrupt" });
  }

  // Resolve clientId — fresh by default, or reuse last one via `resume`.
  const clientId = resolveClientId({
    agentId: opts.agentId ?? "default",
    explicit: opts.clientId,
    resume: opts.resume,
  });
  if (opts.debug || opts.print) {
    process.stderr.write(`${ANSI_DIM}[session] clientId=${clientId}${ANSI_RESET}\n`);
  }

  function safeSend(frame: import("../types.js").ClientFrame): void {
    if (ws && ws.readyState === WebSocket.OPEN) sendFrame(ws, frame);
  }

  function safeSendBinary(buf: Buffer): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf, { binary: true });
  }

  // Build the hello frame — re-sent on every (re)connection.
  function helloFrame(): import("../types.js").ClientFrame {
    return {
      type: "hello",
      clientId,
      protocol: VOICE_PROTOCOL_VERSION,
      mode: opts.mode,
      codec: "pcm16",
      sampleRate: 24000,
      sttHints: { provider: opts.stt, model: opts.sttModel },
      ttsHints: {
        provider: opts.tts,
        model: opts.ttsModel,
        voice: opts.voice,
        format: opts.format,
      },
    };
  }

  // Per-connection state that must reset on reconnect — TTS audio buffers
  // and playback queue are tied to the wire stream's framing.
  function resetConnectionState(): void {
    ttsBuffers.clear();
    ttsFirstChunkAt.clear();
    playChain = Promise.resolve();
    activePlayer?.abort();
    activePlayer = null;
  }

  let sessionKey: string | undefined;

  function attachToWs(socket: WebSocket): void {
    attachRouter(socket, {
    onFrame(frame: ServerFrame) {
      switch (frame.type) {
        case "ready":
          sessionKey = frame.sessionKey;
          if (opts.debug) process.stderr.write(`[debug] ready session=${sessionKey}\n`);
          // Mode handlers (mic/keypress) only start once per process. On
          // reconnects we just re-attach to the existing handlers via the
          // ws holder; spawning new sox processes per reconnect would leak.
          if (!modesStarted) {
            modesStarted = true;
            if (opts.noStt) startTextMode();
            else if (opts.mode === "ptt") startPttMode();
            else startVadMode();
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
          enqueuePlayback(frame.turnId);
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
      // No quick-start: server emits one tts.done per sentence and we play
      // each on its tts.done. Mid-stream playback would require streaming-
      // capable players that read a growing buffer, which afplay/ffplay
      // don't do — they'd need a fed file or stdin pipe.
    },

    onClose(code, reason) {
      if (opts.debug) process.stderr.write(`[debug] ws closed ${code} ${reason}\n`);
      // The reconnect loop handles re-establishment; no exit here.
    },

    onError(err) {
      if (opts.debug) process.stderr.write(`[debug] ws error: ${err.message}\n`);
      // Treat as a disconnect; the loop will retry.
    },
  });
  }

  // Reconnect loop with exponential backoff. Resolves when the user quits.
  // The mic/keypress handlers stay alive across reconnects — they always
  // send through the current `ws` via the holder pattern.
  async function reconnectLoop(): Promise<void> {
    let backoffMs = 500;
    const MAX_BACKOFF_MS = 30_000;
    let firstAttempt = true;

    while (!userQuit) {
      if (!firstAttempt) {
        process.stderr.write(`${ANSI_DIM}[disconnected — retrying in ${Math.round(backoffMs / 100) / 10}s]${ANSI_RESET}\n`);
        await sleep(backoffMs);
        if (userQuit) return;
      }

      let next: WebSocket;
      try {
        if (opts.debug) process.stderr.write(`[debug] connecting ${wsUrl}\n`);
        next = await connect(wsUrl, headers);
      } catch (e) {
        if (firstAttempt) {
          process.stderr.write(`Error: gateway unreachable: ${(e as Error).message}\n`);
          // Don't bail on first failure either — keep trying. User can ESC out.
        }
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        firstAttempt = false;
        continue;
      }

      if (!firstAttempt) {
        process.stderr.write(`${ANSI_DIM}[reconnected]${ANSI_RESET}\n`);
      }
      firstAttempt = false;
      backoffMs = 500;
      ws = next;
      resetConnectionState();
      attachToWs(next);
      sendFrame(next, helloFrame());

      // Wait for this connection to close, then loop.
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        next.once("close", done);
        next.once("error", done);
      });
      ws = null;
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

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
        userQuit = true;
        interruptPlayback();
        safeSend({ type: "bye" });
        ws?.close();
        process.exit(0);
      }

      if (key.sequence === " " || key.name === "space") {
        if (!recorder) {
          interruptPlayback();
          safeSend({ type: "speech.start" });
          recorder = startRecording({
            sampleRate: 16000,
            onPcmFrame: (buf) => safeSendBinary(buf),
            onError: (e) => process.stderr.write(`Mic error: ${e.message}\n`),
          });
        }
      } else {
        // Any other key released or different key — if recording, end it.
        if (recorder) {
          recorder.stop();
          recorder = null;
          safeSend({ type: "speech.end" });
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
        // If we're between connections the whole utterance is dropped. Mic
        // stays hot; next utterance lands on the new connection.
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          process.stderr.write(`${ANSI_DIM}[dropped — not connected]${ANSI_RESET}\n`);
          return;
        }
        safeSend({ type: "speech.start" });
        const CHUNK = 16 * 1024;
        for (let i = 0; i < pcm.byteLength; i += CHUNK) {
          safeSendBinary(pcm.subarray(i, Math.min(i + CHUNK, pcm.byteLength)));
        }
        safeSend({ type: "speech.end" });
        if (opts.debug) lastSpeechEndAt = Date.now();
      },
      onError: (e) => process.stderr.write(`Mic error: ${e.message}\n`),
    });
    vadRecorder = recorder;

    process.stdin.on("keypress", (_str, key: { name?: string; ctrl?: boolean }) => {
      if (!key) return;
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        userQuit = true;
        interruptPlayback();
        recorder.stop();
        safeSend({ type: "bye" });
        ws?.close();
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
      if (trimmed) safeSend({ type: "text", content: trimmed });
    });
    rl.on("close", () => {
      userQuit = true;
      safeSend({ type: "bye" });
      ws?.close();
      process.exit(0);
    });
  }

  // Kick off the reconnect loop. Resolves only on userQuit.
  await reconnectLoop();
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
