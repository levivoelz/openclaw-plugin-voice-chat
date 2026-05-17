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
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-core";

// 24 kHz: minimum accepted by OpenAI Realtime, also fine for Whisper.
const SAMPLE_RATE = 24_000;
const CHANNEL_ID = "voice-chat";

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
  private sentenceBuf: SentenceBuffer | null = null;
  private currentTurnId: string | null = null;
  private ttsAbort: AbortController | null = null;
  private closed = false;
  private ttsSeqByTurn = new Map<string, number>();
  private pendingTurn: Promise<void> | null = null;

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
  }

  handleFrame(frame: ClientFrame): void {
    switch (frame.type) {
      case "speech.start":
        if (this.d.config.interrupt) this.interruptTts();
        break;
      case "speech.end":
        void this.stt?.endUtterance();
        break;
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
    this.stt?.sendAudio(audio);
  }

  /**
   * Push a sentence-sized chunk of agent text into TTS. With blockStreaming
   * the reply pipeline already gives us sentence-sized blocks; we send each
   * one straight to the buffer so any short residual gets coalesced and any
   * over-long block gets split.
   */
  deliverAgentText(text: string, turnId: string): void {
    this.send({ type: "agent.delta", text, turnId });
    this.sentenceBuf?.push(text);
  }

  private async onFinalTranscript(text: string): Promise<void> {
    if (this.closed) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    const turnId = randomUUID();
    this.currentTurnId = turnId;
    this.ttsSeqByTurn.set(turnId, 0);
    this.send({ type: "transcript.final", text: trimmed, turnId });

    const ttsProv = this.d.registry.getTts(this.d.config.tts.provider)!;
    this.ttsAbort = new AbortController();
    const ttsAbort = this.ttsAbort;

    this.sentenceBuf = new SentenceBuffer((chunk) => {
      void this.speak(chunk, turnId, ttsProv, ttsAbort.signal);
    });

    try {
      this.pendingTurn = this.runChannelTurn(trimmed, turnId);
      await this.pendingTurn;
      this.sentenceBuf?.flush();
      this.send({ type: "agent.done", turnId });
    } catch (e) {
      const err = e as Error;
      this.d.logger.error(`voice-chat: agent turn failed: ${err.message}`);
      this.sendError("AGENT_ERROR", err.message, true);
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

    const route = runtime.channel.routing.resolveAgentRoute({
      cfg,
      channel: CHANNEL_ID,
      accountId: this.d.accountId,
      peer: { kind: "direct", id: this.d.clientId },
    });

    const ctxPayload = runtime.channel.reply.finalizeInboundContext({
      Body: transcript,
      BodyForAgent: transcript,
      RawBody: transcript,
      CommandBody: transcript,
      From: this.d.clientId,
      To: this.d.clientId,
      SessionKey: route.sessionKey,
      AccountId: this.d.accountId,
      ChatType: "direct",
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      CommandAuthorized: true,
    });

    const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
      cfg,
      agentId: route.agentId,
      channel: CHANNEL_ID,
      accountId: this.d.accountId,
    });

    await runtime.channel.turn.runPrepared({
      channel: CHANNEL_ID,
      accountId: this.d.accountId,
      routeSessionKey: route.sessionKey,
      storePath: runtime.channel.session.resolveStorePath(
        (cfg as { session?: { store?: unknown } } | undefined)?.session?.store,
        { agentId: route.agentId },
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
    try {
      const fmt: AudioFormat = this.d.config.tts.format;
      const stream = ttsProv.synthesize({
        text,
        model: this.d.config.tts.model,
        voice: this.d.config.tts.voice,
        format: fmt,
        providerConfig: this.d.pluginConfig,
        signal,
      });
      for await (const { chunk } of stream) {
        if (signal.aborted || this.closed) return;
        const seq = (this.ttsSeqByTurn.get(turnId) ?? 0) + 1;
        this.ttsSeqByTurn.set(turnId, seq);
        this.send({ type: "tts.chunk", turnId, seq, format: fmt });
        this.ws.send(chunk, { binary: true });
      }
      if (!signal.aborted && !this.closed) {
        this.send({ type: "tts.done", turnId });
      }
    } catch (e) {
      if (signal.aborted) return;
      const err = e as Error;
      this.d.logger.error(`voice-chat: TTS error: ${err.message}`);
      this.sendError("PROVIDER_UNAVAILABLE", `TTS error: ${err.message}`, true);
    }
  }

  private interruptTts(): void {
    if (this.ttsAbort) {
      this.ttsAbort.abort();
      this.ttsAbort = null;
    }
    this.sentenceBuf?.close();
    this.sentenceBuf = null;
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
    this.interruptTts();
    void this.stt?.close();
    this.stt = null;
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) {
      this.ws.close();
    }
  }
}

/**
 * Loose runtime shape — we don't have a stable importable type for the host
 * channel runtime surface, and faithfully typing it would drag in the entire
 * SDK. We declare the minimum we touch and trust the host contract.
 */
type RuntimeShape = {
  channel: {
    routing: {
      resolveAgentRoute: (args: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: string; id: string };
      }) => { agentId: string; sessionKey: string; accountId?: string };
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
