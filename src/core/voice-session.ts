/**
 * Per-WS-connection voice session orchestrator. Owns the STT session, the
 * agent dispatch, the sentence buffer, and the active TTS stream. Implemented
 * as a small state machine so interrupts are clean.
 *
 * As a channel plugin, every final transcript becomes a real user turn via
 * `runtime.channel.turn.runPrepared` + `dispatchReplyWithBufferedBlockDispatcher`.
 * The reply pipeline calls our `deliver` per block (sentence) because the
 * plugin advertises `blockStreaming: true` — without that, deliver fires
 * once with the entire reply.
 */

import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
  ClientFrame,
  ServerFrame,
  ResolvedVoiceConfig,
  AudioFormat,
  VoiceErrorCode,
} from "../types.js";
import { SentenceBuffer } from "./sentence-buffer.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SttSession } from "../providers/stt/types.js";
import { getVoiceChatRuntime } from "../channel-runtime.js";
// Top-level import — NOT on runtime. The runtime only carries
// finalizeInboundContext + dispatchReplyWithBufferedBlockDispatcher (which
// we still access via runtime.channel.reply).
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";

// 24 kHz: minimum accepted by OpenAI Realtime, also fine for Whisper.
const SAMPLE_RATE = 24_000;
const CHANNEL_ID = "voice-chat";

// Debug timing — only active when VOICE_CHAT_DEBUG is set.
const DEBUG = !!process.env["VOICE_CHAT_DEBUG"];

type TurnTiming = {
  audioStart: number;
  audioEnd: number | null;
  transcriptFinal: number | null;
  dispatch: number | null;
  firstDelta: number | null;
  ttsStart: number | null;
  firstTtsByte: number | null;
  firstTtsDone: number | null;
};

function nowMs(): number {
  return Date.now();
}

type Logger = {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string, ...args: unknown[]) => void;
  debug: (m: string) => void;
};

export type VoiceSessionDeps = {
  ws: WebSocket;
  sessionKey: string;
  agentId: string;
  /** Stable id for this voice client; doubles as the peer id for routing. */
  clientId: string;
  /** Channel account id (currently always "default"). */
  accountId: string;
  /** Full host config — we pass it through to the channel reply pipeline. */
  cfg: unknown;
  config: ResolvedVoiceConfig;
  registry: ProviderRegistry;
  pluginConfig: Record<string, unknown>;
  logger: Logger;
};

export class VoiceSession {
  private readonly ws: WebSocket;
  private readonly d: VoiceSessionDeps;
  private stt: SttSession | null = null;
  // Per-turn sentence buffer. Single-buffer design corrupted audio when a
  // late deliver from turn N arrived after turn N+1 had started — the late
  // text would land in turn N+1's buffer and get synthesized under turn N+1's
  // id. Keyed by turnId so each turn's text routes to its own pipeline.
  private sentenceBufs = new Map<string, SentenceBuffer>();
  private currentTurnId: string | null = null;
  // Per-turn abort controller. Aborting only stops streaming TTS — the agent
  // dispatch keeps running because runPrepared doesn't accept a signal yet.
  private ttsAborts = new Map<string, AbortController>();
  private closed = false;
  private ttsSeqByTurn = new Map<string, number>();
  private pendingTurn: Promise<void> | null = null;
  // True only while we're actively producing TTS audio for a turn. Distinct
  // from `ttsAbort` (which is set the moment a turn dispatches, before any
  // audio exists) — gates barge-in so a phantom `speech.start` during the
  // "thinking" window doesn't destroy the in-flight reply buffer.
  private ttsActive = false;
  // Per-turn timing map — cleaned up on agent.done or session close.
  private turnTimings = new Map<string, TurnTiming>();
  // Pending audio timestamps captured from speech.start/end before turnId is known.
  private _pendingAudioStart: number | null = null;
  private _pendingAudioEnd: number | null = null;
  // Pending audio byte count — accumulated in handleBinary between speech.start and speech.end.
  private _pendingAudioBytes = 0;

  constructor(deps: VoiceSessionDeps) {
    this.ws = deps.ws;
    this.d = deps;
  }

  async start(): Promise<void> {
    const sttProv = this.d.registry.getStt(this.d.config.stt.provider);
    const ttsProv = this.d.registry.getTts(this.d.config.tts.provider);
    if (!sttProv) {
      this.sendError("PROVIDER_UNAVAILABLE", `STT provider not registered: ${this.d.config.stt.provider}`);
      this.close();
      return;
    }
    if (!ttsProv) {
      this.sendError("PROVIDER_UNAVAILABLE", `TTS provider not registered: ${this.d.config.tts.provider}`);
      this.close();
      return;
    }
    if (!sttProv.isConfigured(this.d.pluginConfig)) {
      this.sendError("PROVIDER_AUTH", `STT provider ${sttProv.id} is missing required configuration (e.g. API key).`);
      this.close();
      return;
    }
    if (!ttsProv.isConfigured(this.d.pluginConfig)) {
      this.sendError("PROVIDER_AUTH", `TTS provider ${ttsProv.id} is missing required configuration (e.g. API key).`);
      this.close();
      return;
    }

    this.stt = sttProv.create({
      model: this.d.config.stt.model,
      language: this.d.config.stt.language,
      sampleRate: SAMPLE_RATE,
      providerConfig: this.d.pluginConfig,
      callbacks: {
        onPartial: (text) => this.send({ type: "transcript.partial", text }),
        onFinal:   (text) => void this.onFinalTranscript(text),
        onError:   (err)  => {
          this.d.logger.error(`voice-chat: STT error: ${err.message}`);
          this.sendError("PROVIDER_UNAVAILABLE", `STT error: ${err.message}`, true);
        },
      },
    });
    try {
      await this.stt.connect();
    } catch (e) {
      const err = e as Error;
      this.sendError("PROVIDER_UNAVAILABLE", `STT connect failed: ${err.message}`);
      this.close();
      return;
    }

    this.send({
      type: "ready",
      sessionKey: this.d.sessionKey,
      agentId: this.d.agentId,
      codecs: ["pcm16"],
      sttProvider: sttProv.id,
      ttsProvider: ttsProv.id,
      ttsFormat: this.d.config.tts.format,
    });
    this.d.logger.info(
      `voice-chat: session ready agent=${this.d.agentId} client=${this.d.clientId} stt=${sttProv.id} tts=${ttsProv.id}/${this.d.config.tts.voice ?? "?"}`,
    );
  }

  handleFrame(frame: ClientFrame): void {
    switch (frame.type) {
      case "speech.start": {
        // Only barge in if TTS is actually producing audio. Without this guard,
        // a `speech.start` during the agent's "thinking" window (between
        // transcript.final and tts.start) destroys the in-flight reply buffer
        // and the user never hears the response.
        if (this.d.config.interrupt && this.ttsActive) this.interruptTts();
        if (DEBUG) {
          // We don't have a turnId yet — use a provisional key based on time.
          // The real per-turn timing is keyed by turnId in onFinalTranscript.
          // Store audioStart in a pending slot; it gets promoted when the turn fires.
          this._pendingAudioStart = nowMs();
          this._pendingAudioBytes = 0;
          this.d.logger.info(`voice-chat: speech.start t=${this._pendingAudioStart}`);
        }
        break;
      }
      case "speech.end": {
        void this.stt?.endUtterance();
        if (DEBUG) {
          this._pendingAudioEnd = nowMs();
          // Compute audio duration from actual bytes received (24 kHz mono PCM16:
          // sample_rate=24000, bytes_per_sample=2 → bytes / 48000 * 1000 ms).
          const audioMs = this._pendingAudioBytes > 0
            ? Math.round(this._pendingAudioBytes / (SAMPLE_RATE * 2) * 1000)
            : null;
          this.d.logger.info(
            `voice-chat: speech.end audio_ms=${audioMs ?? "?"} bytes=${this._pendingAudioBytes}`,
          );
        }
        break;
      }
      case "text":
        void this.onFinalTranscript(frame.content);
        break;
      case "interrupt":
        this.interruptTts();
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
      case "bye":
        this.close();
        break;
      case "hello":
        // Plugin already used hello to create this session; ignore late hellos.
        break;
    }
  }

  handleBinary(audio: Buffer): void {
    if (DEBUG) this._pendingAudioBytes += audio.byteLength;
    this.stt?.sendAudio(audio);
  }

  /**
   * Push a sentence-sized chunk of agent text into TTS. With blockStreaming
   * the reply pipeline already gives us sentence-sized blocks; we send each
   * one straight to the buffer so any short residual gets coalesced and any
   * over-long block gets split.
   */
  deliverAgentText(text: string, turnId: string): void {
    const shortId = turnId.slice(0, 8);
    if (DEBUG) {
      const tNow = nowMs();
      const timing = this.turnTimings.get(turnId);
      if (timing && timing.firstDelta === null) {
        timing.firstDelta = tNow;
        const ttftMs = timing.dispatch !== null ? tNow - timing.dispatch : null;
        this.d.logger.info(
          `voice-chat: agent.first_delta turn=${shortId} ttft_ms=${ttftMs ?? "?"}`,
        );
      }
    }
    this.d.logger.info(`voice-chat: agent.delta turn=${shortId} chars=${text.length} "${preview(text)}"`);
    this.send({ type: "agent.delta", text, turnId });
    // Push to THIS turn's buffer. If the turn was canceled/superseded the
    // entry was deleted and the late text is dropped — preventing it from
    // bleeding into a newer turn's audio.
    this.sentenceBufs.get(turnId)?.push(text);
  }

  private async onFinalTranscript(text: string): Promise<void> {
    if (this.closed) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    const turnId = randomUUID();
    const shortId = turnId.slice(0, 8);
    this.currentTurnId = turnId;
    this.ttsSeqByTurn.set(turnId, 0);

    // Promote pending audio timestamps into the per-turn timing object.
    if (DEBUG) {
      const tNow = nowMs();
      const timing: TurnTiming = {
        audioStart: this._pendingAudioStart ?? tNow,
        audioEnd: this._pendingAudioEnd,
        transcriptFinal: tNow,
        dispatch: null,
        firstDelta: null,
        ttsStart: null,
        firstTtsByte: null,
        firstTtsDone: null,
      };
      this.turnTimings.set(turnId, timing);
      const sttMs = this._pendingAudioEnd !== null ? tNow - this._pendingAudioEnd : null;
      this.d.logger.info(
        `voice-chat: transcript.final turn=${shortId} stt_ms=${sttMs ?? "?"} "${preview(trimmed)}"`,
      );
      // Reset pending slots for the next utterance.
      this._pendingAudioStart = null;
      this._pendingAudioEnd = null;
    } else {
      this.d.logger.info(`voice-chat: transcript.final turn=${shortId} "${preview(trimmed)}"`);
    }

    this.send({ type: "transcript.final", text: trimmed, turnId });

    // A new transcript supersedes any prior turn — abort its TTS streams and
    // drop its sentence buffer so leftover text from the previous LLM dispatch
    // can't bleed into this turn. The prior agent dispatch may still finish in
    // the background, but its late deliveries land in a now-missing buffer
    // entry (deliverAgentText silently no-ops) instead of corrupting this turn.
    this.abortPriorTurns(turnId);

    const ttsProv = this.d.registry.getTts(this.d.config.tts.provider)!;
    const ttsAbort = new AbortController();
    this.ttsAborts.set(turnId, ttsAbort);

    // Chain speak() calls so one chunk's TTS finishes (all binary frames
    // pushed to the wire) before the next begins. Without this, multiple
    // chunks emitted in quick succession run N parallel TTS streams that
    // interleave MP3 bytes on the wire and produce garbled playback.
    let speakChain: Promise<void> = Promise.resolve();
    const sb = new SentenceBuffer((chunk) => {
      speakChain = speakChain.then(() =>
        this.speak(chunk, turnId, ttsProv, ttsAbort.signal),
      ).catch(() => { /* swallow to keep chain alive */ });
    });
    this.sentenceBufs.set(turnId, sb);

    const t0 = Date.now();
    try {
      this.pendingTurn = this.runChannelTurn(trimmed, turnId);
      await this.pendingTurn;
      sb.flush();
      this.d.logger.info(`voice-chat: agent.done turn=${shortId} duration=${Date.now() - t0}ms`);
      this.send({ type: "agent.done", turnId });

      if (DEBUG) {
        const timing = this.turnTimings.get(turnId);
        if (timing) {
          const e2eMs = nowMs() - timing.audioStart;
          this.d.logger.info(
            `voice-chat: turn.text_done turn=${shortId} e2e_ms=${e2eMs}`,
          );
          // Don't delete the timing here — tts.first_byte and turn.audio_start
          // fire AFTER agent.done (TTS is async, the first synth call is still
          // streaming when the LLM finishes). Cleanup happens in close().
        }
      }
    } catch (e) {
      const err = e as Error;
      this.d.logger.error(`voice-chat: agent turn failed turn=${shortId}: ${err.message}`);
      this.sendError("AGENT_ERROR", err.message, true);
      if (DEBUG) this.turnTimings.delete(turnId);
    } finally {
      this.pendingTurn = null;
    }
  }

  /**
   * Drive a single turn through the host's channel reply pipeline. The
   * resolved-route + finalize-context + runPrepared sequence mirrors what
   * clickclack and other channel plugins do; only `deliver` differs (we
   * stream blocks to TTS instead of posting to an upstream API).
   */
  private async runChannelTurn(transcript: string, turnId: string): Promise<void> {
    const runtime = getVoiceChatRuntime() as RuntimeShape;
    const cfg = this.d.cfg;

    // Build the session key explicitly from (agent, channel, accountId, peer)
    // — bypasses resolveAgentRoute which can collapse to the agent's `:main`
    // session and end up sharing thread state with the agent's autonomous
    // work. We want voice in its own thread, keyed to the connecting client.
    const sessionKey = runtime.channel.routing.buildAgentSessionKey({
      agentId: this.d.agentId,
      channel: CHANNEL_ID,
      accountId: this.d.accountId,
      peer: { kind: "direct", id: this.d.clientId },
      // Default is "main" — which collapses every peer into the agent's
      // primary thread. We want one thread per (channel, peer) so voice
      // stays separate from text/main and per-client voice stays separate.
      dmScope: "per-channel-peer",
    });
    if (DEBUG) {
      const tNow = nowMs();
      const timing = this.turnTimings.get(turnId);
      if (timing) {
        timing.dispatch = tNow;
        const dispatchMs = timing.transcriptFinal !== null ? tNow - timing.transcriptFinal : null;
        this.d.logger.info(
          `voice-chat: agent.dispatch turn=${turnId.slice(0, 8)} dispatch_ms=${dispatchMs ?? "?"} sessionKey=${sessionKey}`,
        );
      } else {
        this.d.logger.info(`voice-chat: agent.dispatch turn=${turnId.slice(0, 8)} sessionKey=${sessionKey}`);
      }
    } else {
      this.d.logger.info(`voice-chat: agent.dispatch turn=${turnId.slice(0, 8)} sessionKey=${sessionKey}`);
    }

    const ctxPayload = runtime.channel.reply.finalizeInboundContext({
      Body: transcript,
      BodyForAgent: transcript,
      RawBody: transcript,
      CommandBody: transcript,
      From: this.d.clientId,
      To: this.d.clientId,
      SessionKey: sessionKey,
      AccountId: this.d.accountId,
      ChatType: "direct",
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      // "voice" is in TOOL_DENY_BY_MESSAGE_PROVIDER in the openclaw runtime, which
      // causes filterToolsByMessageProvider to strip the built-in `tts` tool before
      // the model sees it. Without this, the model calls tts itself and emits the
      // [[audio_as_voice]] sentinel, suppressing the text reply the plugin needs.
      // OriginatingChannel takes precedence over Provider in resolveOriginMessageProvider,
      // so routing (Provider/Surface) is unaffected.
      OriginatingChannel: "voice",
      CommandAuthorized: true,
    });

    const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
      cfg,
      agentId: this.d.agentId,
      channel: CHANNEL_ID,
      accountId: this.d.accountId,
    });

    await runtime.channel.turn.runPrepared({
      channel: CHANNEL_ID,
      accountId: this.d.accountId,
      routeSessionKey: sessionKey,
      storePath: runtime.channel.session.resolveStorePath(
        (cfg as { session?: { store?: unknown } } | undefined)?.session?.store,
        { agentId: this.d.agentId },
      ),
      ctxPayload,
      recordInboundSession: runtime.channel.session.recordInboundSession,
      runDispatch: async () =>
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg,
          dispatcherOptions: {
            ...replyPipeline,
            deliver: async (payload: unknown) => {
              const text =
                payload && typeof payload === "object" && "text" in (payload as Record<string, unknown>)
                  ? String((payload as { text?: unknown }).text ?? "")
                  : "";
              if (!text.trim()) return;
              this.deliverAgentText(text, turnId);
            },
            onError: (err: unknown) => {
              throw err instanceof Error ? err : new Error(String(err));
            },
          },
          replyOptions: { onModelSelected },
        }),
      record: {
        onRecordError: (err: unknown) => {
          throw err instanceof Error ? err : new Error(String(err));
        },
      },
    });
  }

  private async speak(
    text: string,
    turnId: string,
    ttsProv: ReturnType<ProviderRegistry["getTts"]> extends infer P ? NonNullable<P> : never,
    signal: AbortSignal,
  ): Promise<void> {
    const shortId = turnId.slice(0, 8);
    const t0 = Date.now();
    this.ttsActive = true;
    try {
      const fmt: AudioFormat = this.d.config.tts.format;

      if (DEBUG) {
        const tNow = nowMs();
        const timing = this.turnTimings.get(turnId);
        if (timing) {
          timing.ttsStart = tNow;
          const fromFirstDeltaMs = timing.firstDelta !== null ? tNow - timing.firstDelta : null;
          this.d.logger.info(
            `voice-chat: tts.start turn=${shortId} chars=${text.length} voice=${this.d.config.tts.voice ?? "?"} from_first_delta_ms=${fromFirstDeltaMs ?? "?"}`,
          );
        } else {
          this.d.logger.info(`voice-chat: tts.start turn=${shortId} chars=${text.length} voice=${this.d.config.tts.voice ?? "?"}`);
        }
      } else {
        this.d.logger.info(`voice-chat: tts.start turn=${shortId} chars=${text.length} voice=${this.d.config.tts.voice ?? "?"}`);
      }

      const stream = ttsProv.synthesize({
        text,
        model: this.d.config.tts.model,
        voice: this.d.config.tts.voice,
        format: fmt,
        providerConfig: this.d.pluginConfig,
        signal,
      });
      let totalBytes = 0;
      for await (const { chunk } of stream) {
        if (signal.aborted || this.closed) return;
        const seq = (this.ttsSeqByTurn.get(turnId) ?? 0) + 1;
        this.ttsSeqByTurn.set(turnId, seq);
        totalBytes += chunk.byteLength;

        if (DEBUG) {
          const timing = this.turnTimings.get(turnId);
          // Gate on timing.firstTtsByte === null so this fires exactly once per
          // turn across all chained speak() calls (not just once per call).
          if (timing && timing.firstTtsByte === null) {
            const tNow = nowMs();
            timing.firstTtsByte = tNow;
            const firstByteMs = timing.ttsStart !== null ? tNow - timing.ttsStart : null;
            this.d.logger.info(
              `voice-chat: tts.first_byte turn=${shortId} ms=${firstByteMs ?? "?"}`,
            );
          }
        }

        this.send({ type: "tts.chunk", turnId, seq, format: fmt });
        this.ws.send(chunk, { binary: true });
      }
      if (!signal.aborted && !this.closed) {
        this.send({ type: "tts.done", turnId });
        this.d.logger.info(`voice-chat: tts.done turn=${shortId} bytes=${totalBytes} duration=${Date.now() - t0}ms`);
        if (DEBUG) {
          const timing = this.turnTimings.get(turnId);
          // Fire turn.audio_start exactly once per turn — on the first tts.done.
          // This is the server's best proxy for "first audio played back" since
          // the CLI plays immediately when it receives tts.done.
          if (timing && timing.firstTtsDone === null) {
            const tNow = nowMs();
            timing.firstTtsDone = tNow;
            const e2eMs = tNow - timing.audioStart;
            this.d.logger.info(
              `voice-chat: turn.audio_start turn=${shortId} e2e_ms=${e2eMs}`,
            );
          }
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      const err = e as Error;
      this.d.logger.error(`voice-chat: TTS error turn=${shortId}: ${err.message}`);
      this.sendError("PROVIDER_UNAVAILABLE", `TTS error: ${err.message}`, true);
    } finally {
      this.ttsActive = false;
    }
  }

  private interruptTts(): void {
    for (const ac of this.ttsAborts.values()) ac.abort();
    this.ttsAborts.clear();
    for (const sb of this.sentenceBufs.values()) sb.close();
    this.sentenceBufs.clear();
    this.ttsActive = false;
  }

  /**
   * Abort and discard every turn except `keepTurnId`. Called when a new
   * transcript arrives so the prior turn's in-flight TTS doesn't continue
   * playing — and its late agent deliveries land in a missing buffer entry
   * (deliverAgentText silently no-ops) instead of bleeding into the new turn.
   */
  private abortPriorTurns(keepTurnId: string): void {
    for (const [tid, ac] of this.ttsAborts) {
      if (tid !== keepTurnId) ac.abort();
    }
    for (const [tid, sb] of this.sentenceBufs) {
      if (tid !== keepTurnId) sb.close();
    }
    for (const tid of [...this.ttsAborts.keys()]) {
      if (tid !== keepTurnId) this.ttsAborts.delete(tid);
    }
    for (const tid of [...this.sentenceBufs.keys()]) {
      if (tid !== keepTurnId) this.sentenceBufs.delete(tid);
    }
    this.ttsActive = false;
  }

  private send(frame: ServerFrame): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  private sendError(code: VoiceErrorCode, message: string, recoverable = false): void {
    this.send({ type: "error", code, message, recoverable });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.d.logger.info(`voice-chat: session closed client=${this.d.clientId}`);
    this.interruptTts();
    this.turnTimings.clear();
    void this.stt?.close();
    this.stt = null;
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) {
      this.ws.close();
    }
  }
}

function preview(s: string, max = 80): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

/**
 * Loose runtime shape — we don't have a stable importable type for the host
 * channel runtime surface, and faithfully typing it would drag in the entire
 * SDK. We declare the minimum we touch and trust the host contract.
 */
type RuntimeShape = {
  channel: {
    routing: {
      buildAgentSessionKey: (args: {
        agentId: string;
        channel: string;
        accountId: string;
        peer: { kind: string; id: string };
        dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
      }) => string;
    };
    reply: {
      finalizeInboundContext: (payload: Record<string, unknown>) => Record<string, unknown>;
      createChannelReplyPipeline: (args: {
        cfg: unknown;
        agentId: string;
        channel: string;
        accountId: string;
      }) => { onModelSelected: unknown; [key: string]: unknown };
      dispatchReplyWithBufferedBlockDispatcher: (args: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: Record<string, unknown>;
        replyOptions: Record<string, unknown>;
      }) => Promise<void>;
    };
    session: {
      resolveStorePath: (store: unknown, args: { agentId: string }) => unknown;
      recordInboundSession: unknown;
    };
    turn: {
      runPrepared: (args: {
        channel: string;
        accountId: string;
        routeSessionKey: string;
        storePath: unknown;
        ctxPayload: unknown;
        recordInboundSession: unknown;
        runDispatch: () => Promise<unknown>;
        record: { onRecordError: (err: unknown) => void };
      }) => Promise<void>;
    };
  };
};
