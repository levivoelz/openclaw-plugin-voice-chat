/**
 * The thin layer between voice and the OpenClaw agent. Wraps the SDK's
 * inject-next-turn + agent-output-event-subscribe APIs behind a stable
 * surface, with capability detection so we degrade gracefully if a given
 * SDK version exposes the APIs under different names.
 *
 * We resolve the API at runtime from the OpenClawPluginApi object — different
 * gateway versions have shuffled these surfaces, so prefer feature-detection
 * over hard imports.
 */

export type AgentTurnHandle = {
  turnId: string;
  /** Cancel the in-flight turn. Best-effort. */
  cancel(): Promise<void>;
};

export type AgentDeltaCallbacks = {
  onDelta?: (text: string) => void;
  onDone?: (usage?: Record<string, unknown>) => void;
  onError?: (err: Error) => void;
};

export type AgentBridge = {
  /** Inject a user turn into the session. Returns a turn handle for subscription. */
  injectUserTurn(args: {
    sessionKey: string;
    agentId: string;
    content: string;
    source: { plugin: string; channel: string; turnId: string };
  }): Promise<AgentTurnHandle>;
  /** Subscribe to streamed output for a specific turn. */
  subscribe(handle: AgentTurnHandle, cb: AgentDeltaCallbacks): () => void;
};

/**
 * Build an AgentBridge from a runtime OpenClawPluginApi. Uses duck-typing
 * because the SDK's exact method names vary across versions and the type
 * surface is too large to import safely from a third-party plugin.
 */
export function createAgentBridge(api: unknown, opts: { logger?: { warn: (m: string) => void; debug?: (m: string) => void } } = {}): AgentBridge {
  // Looked-up paths — we try several known shapes in order.
  const candidates = {
    inject: [
      ["session", "injectNextTurn"],
      ["session", "nextTurn", "inject"],
      ["agent", "session", "injectNextTurn"],
      ["sessions", "injectNextTurn"],
    ],
    subscribe: [
      ["agent", "events", "subscribe"],
      ["session", "events", "subscribe"],
      ["agent", "subscribe"],
    ],
  };

  const inject = resolvePath(api, candidates.inject);
  const subscribe = resolvePath(api, candidates.subscribe);

  if (!inject || !subscribe) {
    opts.logger?.warn(
      `voice-chat: AgentBridge could not resolve SDK methods (inject=${!!inject}, subscribe=${!!subscribe}). ` +
      `Voice turns will fail until the host gateway exposes these APIs or the bridge is updated.`,
    );
  }

  return {
    async injectUserTurn(args) {
      if (!inject) throw new Error("AgentBridge.injectUserTurn: SDK method not resolved");
      const result = await (inject.fn as (a: unknown) => Promise<{ turnId: string }>)({
        sessionKey: args.sessionKey,
        agentId: args.agentId,
        role: "user",
        content: args.content,
        source: args.source,
      });
      const turnId = result?.turnId ?? args.source.turnId;
      return {
        turnId,
        async cancel() { /* best-effort; gateway may not expose */ },
      };
    },
    subscribe(handle, cb) {
      if (!subscribe) {
        cb.onError?.(new Error("AgentBridge.subscribe: SDK method not resolved"));
        return () => {};
      }
      const unsub = (subscribe.fn as (a: unknown, b: unknown) => () => void)(
        { turnId: handle.turnId },
        {
          onDelta: (d: { text?: string }) => { if (d?.text) cb.onDelta?.(d.text); },
          onDone:  (d: { usage?: Record<string, unknown> } | undefined) => cb.onDone?.(d?.usage),
          onError: (e: Error) => cb.onError?.(e),
        },
      );
      return typeof unsub === "function" ? unsub : () => {};
    },
  };
}

function resolvePath(root: unknown, paths: string[][]): { fn: unknown } | null {
  for (const path of paths) {
    let cur: unknown = root;
    let ok = true;
    for (const k of path) {
      if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[k];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && typeof cur === "function") return { fn: cur };
  }
  return null;
}
