/**
 * Channel-plugin entry. Wires voice-chat into OpenClaw as a first-class
 * channel so transcripts become real user messages rather than context
 * injections.
 *
 * Lifecycle:
 *  - `defineChannelPluginEntry` is exported as default. The host calls
 *    `setChannelRuntime(runtime)` once and then `register(api)` to wire
 *    HTTP routes and provider registrations.
 *  - `gateway.startAccount` is called per account by the host. We host the
 *    WebSocketServer for that account's lifetime, bound to `ctx.abortSignal`.
 *  - Inbound transcripts route through `runtime.channel.turn.runPrepared` +
 *    `dispatchReplyWithBufferedBlockDispatcher`, which keeps voice on the
 *    same turn pipeline as every other channel.
 *
 * Capability `blockStreaming: true` is load-bearing — without it `deliver`
 * fires only once with the complete reply, defeating sentence-level TTS.
 */

// `core` is where the host actually exports these — `channel-core` only
// re-exports a subset (defineChannelPluginEntry, createChatChannelPlugin)
// and does NOT include getChatChannelMeta or createPluginRuntimeStore.
import {
  defineChannelPluginEntry,
  createChatChannelPlugin,
  getChatChannelMeta,
} from "openclaw/plugin-sdk/core";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { ProviderRegistry } from "./providers/registry.js";
import { registerOpenaiRealtimeStt } from "./providers/stt/openai-realtime.js";
import { registerOpenaiWhisperStt } from "./providers/stt/openai-whisper.js";
import { registerParakeetLocalStt } from "./providers/stt/parakeet-local.js";
import { registerOpenaiTts } from "./providers/tts/openai.js";
import { registerElevenlabsTts } from "./providers/tts/elevenlabs.js";
import { registerMacosSayTts } from "./providers/tts/macos-say.js";
import { resolveVoiceConfig, type PluginConfigShape } from "./core/resolve-config.js";
import { VoiceSession } from "./core/voice-session.js";
import {
  type ClientFrame,
  type VoiceConnectParams,
  isClientFrame,
} from "./types.js";
import { setVoiceChatRuntime } from "./channel-runtime.js";

const CHANNEL_ID = "voice-chat";
const DEFAULT_ACCOUNT_ID = "default";

type Logger = {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string, ...args: unknown[]) => void;
  debug: (m: string) => void;
};

// Shared between `registerFull` (which owns the HTTP route) and
// `gateway.startAccount` (which owns the WSS lifetime). The route handler
// reads the currently-active WSS to dispatch upgrades. One account → one WSS.
let activeWss: WebSocketServer | null = null;
const activeSessions = new Set<VoiceSession>();

// Provider registry is process-wide; safe to populate eagerly.
const registry = new ProviderRegistry();
registerParakeetLocalStt(registry);
registerOpenaiRealtimeStt(registry);
registerOpenaiWhisperStt(registry);
registerOpenaiTts(registry);
registerElevenlabsTts(registry);
registerMacosSayTts(registry);

const channelMeta = { ...getChatChannelMeta(CHANNEL_ID) };

const voiceChatPlugin = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: channelMeta,
    capabilities: {
      chatTypes: ["direct"],
      // Required so the reply pipeline calls `deliver` per block (sentence)
      // rather than once with the full final text.
      blockStreaming: true,
    },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
    config: {
      // v0: single hard-coded account. Multi-account lands later.
      listAccountIds: () => [DEFAULT_ACCOUNT_ID],
      resolveAccount: (_cfg: unknown, accountId?: string | null) => ({
        accountId: accountId ?? DEFAULT_ACCOUNT_ID,
        enabled: true,
        configured: true,
      }),
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
      isConfigured: (account: { configured?: boolean }) => account.configured !== false,
    },
    setup: {
      // No per-account setup wizard yet. Host-supplied config flows through.
      applyAccountConfig: (params: { cfg: unknown }) => params.cfg,
    },
    gateway: {
      startAccount: async (ctx: GatewayStartAccountCtx) => {
        const logger = ctxLogger(ctx);

        // Read port + bind from channel config (`channels.voice-chat.{port,host}`).
        // Loopback default for personal/local use; bind to "0.0.0.0" to allow LAN.
        const chCfg = readChannelConfig(ctx.cfg);
        const port = chCfg.port ?? 18790;
        const host = chCfg.host ?? "127.0.0.1";

        const wss = new WebSocketServer({ port, host });
        activeWss = wss;
        logger.info(`voice-chat: WS server listening on ws://${host}:${port}`);

        wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
          attachVoiceConnection({ ws, req, cfg: ctx.cfg, accountId: ctx.account.accountId, logger });
        });
        wss.on("error", (err) => {
          logger.error(`voice-chat: WSS error: ${(err as Error).message}`);
        });

        ctx.setStatus({
          accountId: ctx.account.accountId,
          running: true,
          configured: true,
          enabled: true,
        });

        await new Promise<void>((resolve) => {
          const onAbort = () => {
            for (const s of activeSessions) s.close();
            activeSessions.clear();
            wss.close();
            if (activeWss === wss) activeWss = null;
            resolve();
          };
          if (ctx.abortSignal.aborted) onAbort();
          else ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
        });

        ctx.setStatus({ accountId: ctx.account.accountId, running: false });
      },
    },
  },
});

function readChannelConfig(cfg: unknown): { port?: number; host?: string } {
  if (!cfg || typeof cfg !== "object") return {};
  const channels = (cfg as Record<string, unknown>)["channels"];
  const ch = channels && typeof channels === "object"
    ? (channels as Record<string, unknown>)[CHANNEL_ID]
    : undefined;
  if (!ch || typeof ch !== "object") return {};
  const c = ch as Record<string, unknown>;
  return {
    port: typeof c["port"] === "number" ? (c["port"] as number) : undefined,
    host: typeof c["host"] === "string" ? (c["host"] as string) : undefined,
  };
}

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "Voice Chat",
  description:
    "Voice that behaves like chat. STT and TTS bracket the real OpenClaw agent.",
  plugin: voiceChatPlugin,
  setRuntime: (runtime) => {
    setVoiceChatRuntime(runtime);
  },
  // Plugin owns its own WS server in startAccount; no gateway HTTP route to
  // register. Browser clients (if we ever ship one) connect to the same port
  // directly; CLI clients use ws://127.0.0.1:18790 by default.
  registerFull: (api) => {
    const apiAny = api as ApiWithDirectMethods;
    const logger = apiAny.logger ?? consoleLogger();
    logger.info(
      `voice-chat: registered (${registry.listStt().length} STT, ${registry.listTts().length} TTS providers)`,
    );
  },
});

// Loose ctx type — the real `ChannelGatewayContext` shape is too entangled
// with internal SDK types to import. We narrow what we actually use.
type GatewayStartAccountCtx = {
  cfg: unknown;
  accountId: string;
  account: { accountId: string };
  abortSignal: AbortSignal;
  setStatus: (snapshot: Record<string, unknown>) => void;
  log?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string, ...a: unknown[]) => void };
};

type ApiWithDirectMethods = {
  logger?: Logger;
  [key: string]: unknown;
};

function ctxLogger(ctx: GatewayStartAccountCtx): Logger {
  const log = ctx.log;
  return {
    info: (m) => log?.info?.(m) ?? console.log(`[voice-chat] ${m}`),
    warn: (m) => log?.warn?.(m) ?? console.warn(`[voice-chat] ${m}`),
    error: (m, ...args) => log?.error?.(m, ...args) ?? console.error(`[voice-chat] ${m}`, ...args),
    debug: (m) => { if (process.env.VOICE_CHAT_DEBUG) console.debug(`[voice-chat] ${m}`); },
  };
}

function attachVoiceConnection(args: {
  ws: WebSocket;
  req: IncomingMessage;
  cfg: unknown;
  accountId: string;
  logger: Logger;
}): void {
  const params = parseConnectParams(args.req.url ?? "/");
  const pluginConfig = extractChannelConfig(args.cfg);

  args.ws.once("message", (raw, isBinary) => {
    if (isBinary) {
      args.ws.close(1002, "expected hello frame");
      return;
    }
    let hello: ClientFrame | null = null;
    try { hello = JSON.parse(String(raw)) as ClientFrame; } catch { /* fallthrough */ }
    if (!hello || !isClientFrame(hello) || hello.type !== "hello") {
      args.ws.close(1002, "expected hello frame");
      return;
    }

    const sessionKey = params.session ?? `voice-chat:${cryptoRandomId()}`;
    const clientId = hello.clientId || `voice:${cryptoRandomId()}`;
    const agentId =
      params.agent ??
      (pluginConfig as { defaultAgentId?: string }).defaultAgentId ??
      "default";
    const resolved = resolveVoiceConfig({
      pluginConfig,
      agentId,
      sttHints: hello.sttHints,
      ttsHints: hello.ttsHints,
    });
    const session = new VoiceSession({
      ws: args.ws,
      sessionKey,
      agentId,
      clientId,
      accountId: args.accountId,
      cfg: args.cfg,
      config: resolved,
      registry,
      pluginConfig,
      logger: args.logger,
    });
    activeSessions.add(session);
    void session.start();

    args.ws.on("message", (raw2, isBinary2) => {
      if (isBinary2) {
        session.handleBinary(raw2 as Buffer);
        return;
      }
      try {
        const frame = JSON.parse(String(raw2)) as ClientFrame;
        if (isClientFrame(frame)) session.handleFrame(frame);
      } catch {
        // ignore malformed frames
      }
    });
    args.ws.on("close", () => {
      session.close();
      activeSessions.delete(session);
    });
  });
}

/**
 * Pull our per-channel plugin config out of the host config. With the
 * channel-plugin shape this lives at `channels.voice-chat` (or under an
 * accounts subkey once multi-account lands). We're forgiving about shape.
 */
function extractChannelConfig(cfg: unknown): PluginConfigShape & Record<string, unknown> {
  if (!cfg || typeof cfg !== "object") return {} as PluginConfigShape;
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  const ours = channels?.[CHANNEL_ID];
  if (ours && typeof ours === "object") return ours as PluginConfigShape & Record<string, unknown>;
  return {} as PluginConfigShape;
}

function consoleLogger(): Logger {
  return {
    info:  (m: string) => console.log(`[voice-chat] ${m}`),
    warn:  (m: string) => console.warn(`[voice-chat] ${m}`),
    error: (m: string, ...args: unknown[]) => console.error(`[voice-chat] ${m}`, ...args),
    debug: (m: string) => { if (process.env.VOICE_CHAT_DEBUG) console.debug(`[voice-chat] ${m}`); },
  };
}

function parseConnectParams(url: string): VoiceConnectParams {
  const u = new URL(url, "http://placeholder");
  return {
    session: u.searchParams.get("session") ?? undefined,
    agent:   u.searchParams.get("agent")   ?? undefined,
    token:   u.searchParams.get("token")   ?? undefined,
  };
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

