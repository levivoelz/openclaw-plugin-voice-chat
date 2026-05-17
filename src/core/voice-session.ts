/**
 * Per-WS-connection voice session orchestrator. Owns the STT session, the
 * agent bridge, the sentence buffer, and the active TTS stream. Implemented
 * as a small state machine to handle interrupts cleanly.
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
import type { AgentBridge } from "./agent-bridge.js";

// 24 kHz: minimum accepted by OpenAI Realtime, also fine for Whisper.
const SAMPLE_RATE = 24_000;

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
  config: ResolvedVoiceConfig;
  registry: ProviderRegistry;
  pluginConfig: Record<string, unknown>;
  agent: AgentBridge;
  logger: Logger;
};

export class VoiceSession {
  private readonly ws: WebSocket;
  private readonly d: VoiceSessionDeps;
  private stt: SttSession | null = null;
  private sentenceBuf: SentenceBuffer | null = null;
  private currentTurnId: string | null = null;
  private ttsAbort: AbortController | null = null;
  private agentUnsub: (() => void) | null = null;
  private closed = false;
  private ttsSeqByTurn = new Map<string, number>();

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

  private async onFinalTranscript(text: string): Promise<void> {
    if (this.closed) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    const turnId = randomUUID();
    this.currentTurnId = turnId;
    this.ttsSeqByTurn.set(turnId, 0);
    this.send({ type: "transcript.final", text: trimmed, turnId });

    let handle: { turnId: string };
    try {
      handle = await this.d.agent.injectUserTurn({
        sessionKey: this.d.sessionKey,
        agentId: this.d.agentId,
        content: trimmed,
        source: { plugin: "voice-chat", channel: "voice", turnId },
      });
    } catch (e) {
      const err = e as Error;
      this.sendError("INJECT_FAILED", `Failed to inject voice turn: ${err.message}`);
      return;
    }

    const ttsProv = this.d.registry.getTts(this.d.config.tts.provider)!;
    this.ttsAbort = new AbortController();
    const ttsAbort = this.ttsAbort;

    this.sentenceBuf = new SentenceBuffer((chunk) => {
      void this.speak(chunk, handle.turnId, ttsProv, ttsAbort.signal);
    });

    this.agentUnsub?.();
    this.agentUnsub = this.d.agent.subscribe({ turnId: handle.turnId, cancel: async () => {} }, {
      onDelta: (delta) => {
        this.send({ type: "agent.delta", text: delta, turnId: handle.turnId });
        this.sentenceBuf?.push(delta);
      },
      onDone: (usage) => {
        this.sentenceBuf?.flush();
        this.send({ type: "agent.done", turnId: handle.turnId, usage });
      },
      onError: (err) => {
        this.sendError("AGENT_ERROR", err.message, true);
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
    this.agentUnsub?.();
    this.agentUnsub = null;
    void this.stt?.close();
    this.stt = null;
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) {
      this.ws.close();
    }
  }
}
