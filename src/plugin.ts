/**
 * Plugin entry. Wires the voice-chat plugin into OpenClaw via the SDK's
 * `definePluginEntry`. Registers built-in STT and TTS providers, the WS HTTP
 * route, a session action ("Talk") and Control UI descriptors for the panel
 * and settings page.
 *
 * NOTE: the SDK surface this plugin uses (registerService, registerHttpRoute,
 * registerSessionAction, controlUi.registerDescriptor, agent bridge methods)
 * is large and version-shifting. We do best-effort feature-detection via
 * `createAgentBridge` and try several known shapes for each registration so a
 * given gateway version that exposes the API under a slightly different name
 * still works. Unsupported features log a warning and degrade gracefully.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi, OpenClawPluginHttpRouteParams } from "openclaw/plugin-sdk";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { ProviderRegistry } from "./providers/registry.js";
import { registerOpenaiRealtimeStt } from "./providers/stt/openai-realtime.js";
import { registerOpenaiWhisperStt } from "./providers/stt/openai-whisper.js";
import { registerOpenaiTts } from "./providers/tts/openai.js";
import { registerElevenlabsTts } from "./providers/tts/elevenlabs.js";
import { registerMacosSayTts } from "./providers/tts/macos-say.js";
import { createAgentBridge } from "./core/agent-bridge.js";
import { resolveVoiceConfig, type PluginConfigShape } from "./core/resolve-config.js";
import { VoiceSession } from "./core/voice-session.js";
import { VOICE_WS_PATH, type ClientFrame, type VoiceConnectParams, isClientFrame } from "./types.js";

const PLUGIN_ID = "voice-chat";

// Type for the parts of OpenClawPluginApi we call directly.
type ApiWithDirectMethods = OpenClawPluginApi & {
  registerHttpRoute(params: OpenClawPluginHttpRouteParams): void;
  registerService(service: { id: string; start?: () => void; stop?: () => void }): void;
};

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Voice Chat",
  description: "Voice that behaves like chat. STT and TTS bracket the real OpenClaw agent.",
  register(api) {
    const apiAny = api as ApiWithDirectMethods;
    const logger = apiAny.logger ?? consoleLogger();

    const registry = new ProviderRegistry();
    registerOpenaiRealtimeStt(registry);
    registerOpenaiWhisperStt(registry);
    registerOpenaiTts(registry);
    registerElevenlabsTts(registry);
    registerMacosSayTts(registry);

    const agentBridge = createAgentBridge(apiAny, { logger });

    // WebSocket server — attaches to upgrade events for VOICE_WS_PATH.
    const wss = new WebSocketServer({ noServer: true });
    const sessions = new Set<VoiceSession>();

    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const params = parseConnectParams(req.url ?? "/");
      const pluginConfig = (apiAny.pluginConfig ?? {}) as PluginConfigShape & Record<string, unknown>;

      ws.once("message", (raw, isBinary) => {
        if (isBinary) {
          ws.close(1002, "expected hello frame");
          return;
        }
        let hello: ClientFrame | null = null;
        try { hello = JSON.parse(String(raw)) as ClientFrame; } catch { /* fallthrough */ }
        if (!hello || !isClientFrame(hello) || hello.type !== "hello") {
          ws.close(1002, "expected hello frame");
          return;
        }

        const sessionKey = params.session ?? `voice-chat:${cryptoRandomId()}`;
        const agentId = params.agent ?? (pluginConfig as { defaultAgentId?: string }).defaultAgentId ?? "default";
        const resolved = resolveVoiceConfig({
          pluginConfig,
          agentId,
          sttHints: hello.sttHints,
          ttsHints: hello.ttsHints,
        });
        const session = new VoiceSession({
          ws,
          sessionKey,
          agentId,
          config: resolved,
          registry,
          pluginConfig,
          agent: agentBridge,
          logger,
        });
        sessions.add(session);
        void session.start();

        ws.on("message", (raw2, isBinary2) => {
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
        ws.on("close", () => {
          session.close();
          sessions.delete(session);
        });
      });
    });

    // Register the HTTP/WS route — direct call with required auth field.
    apiAny.registerHttpRoute({
      path: VOICE_WS_PATH,
      auth: "gateway",
      handler: (_req, res) => { res.writeHead(426, "Upgrade Required").end(); },
      handleUpgrade: (req, socket, head) => {
        if (req.url?.startsWith(VOICE_WS_PATH)) {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
          });
        } else {
          socket.destroy();
        }
      },
    });

    // Session action — "Talk" button on every chat session.
    tryRegisterSessionAction(apiAny, {
      id: "voice-chat.start",
      label: "Talk",
      icon: "microphone",
      invoke: ({ sessionKey, agentId }: { sessionKey: string; agentId: string }) => ({
        openPanel: "voice-chat",
        params: { sessionKey, agentId },
      }),
    }, logger);

    // Control UI descriptors — voice panel + settings.
    tryRegisterControlUi(apiAny, {
      id: "voice-chat.panel",
      title: "Voice Chat",
      entry: "./ui/panel/index.html",
      mountPoints: ["session.sidebar", "session.modal"],
    }, logger);
    tryRegisterControlUi(apiAny, {
      id: "voice-chat.settings",
      title: "Voice Chat",
      entry: "./ui/settings/index.html",
      mountPoints: ["settings.plugin"],
    }, logger);

    // Long-running service — exposes the active session map for debugging.
    apiAny.registerService({
      id: "voice-chat",
      start: () => { /* WebSocketServer already running */ },
      stop: () => {
        for (const s of sessions) s.close();
        sessions.clear();
        wss.close();
      },
    });

    logger.info(`voice-chat: ready (${registry.listStt().length} STT, ${registry.listTts().length} TTS providers)`);
  },
});

function consoleLogger() {
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

type Logger = ReturnType<typeof consoleLogger>;

function tryRegisterSessionAction(api: Record<string, unknown>, action: unknown, logger: Logger): void {
  const fn = pickFn(api, [
    ["session", "actions", "register"],
    ["sessions", "actions", "register"],
    ["session", "registerAction"],
  ]);
  if (!fn) {
    logger.debug("voice-chat: session action API not present (Talk button skipped)");
    return;
  }
  try { fn.call(api, action); } catch (e) { logger.warn(`voice-chat: session action registration failed: ${(e as Error).message}`); }
}

function tryRegisterControlUi(api: Record<string, unknown>, descriptor: unknown, logger: Logger): void {
  const fn = pickFn(api, [
    ["controlUi", "registerDescriptor"],
    ["session", "controls", "registerControlUiDescriptor"],
    ["ui", "registerDescriptor"],
  ]);
  if (!fn) {
    logger.debug("voice-chat: Control UI descriptor API not present (panel will not auto-mount)");
    return;
  }
  try { fn.call(api, descriptor); } catch (e) { logger.warn(`voice-chat: control UI registration failed: ${(e as Error).message}`); }
}

function pickFn(root: unknown, paths: string[][]): Function | null {
  for (const path of paths) {
    let cur: unknown = root;
    let ok = true;
    for (const k of path) {
      if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[k];
      } else { ok = false; break; }
    }
    if (ok && typeof cur === "function") return cur as Function;
  }
  return null;
}

