/**
 * Minimal ambient declarations for the `openclaw/plugin-sdk` modules this
 * plugin imports at runtime. The real types live in the `openclaw` package
 * (peer dep, supplied by the host gateway). We declare only what we use so we
 * don't pull in the full SDK at dev time.
 *
 * If a host's openclaw package is installed locally, its real types take
 * precedence over these because of standard module resolution order.
 *
 * Loose typing is deliberate where the host runtime shape isn't readily
 * importable — we narrow inside our own modules instead.
 */

declare module "openclaw/plugin-sdk" {
  import type { IncomingMessage, ServerResponse } from "node:http";
  import type { Socket } from "node:net";

  export interface OpenClawLogger {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string, ...args: unknown[]) => void;
    debug: (msg: string) => void;
  }

  export type OpenClawPluginHttpRouteAuth = "gateway" | "plugin";

  export type OpenClawPluginHttpRouteHandler = (
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<boolean | void> | boolean | void;

  export type OpenClawPluginHttpRouteUpgradeHandler = (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ) => void;

  export interface OpenClawPluginHttpRouteParams {
    path: string;
    handler: OpenClawPluginHttpRouteHandler;
    handleUpgrade?: OpenClawPluginHttpRouteUpgradeHandler;
    auth: OpenClawPluginHttpRouteAuth;
    match?: "exact" | "prefix";
    gatewayRuntimeScopeSurface?: "write-default" | "trusted-operator";
    nodeCapability?: { surface: string; ttlMs?: number };
    replaceExisting?: boolean;
  }

  export interface OpenClawPluginService {
    id: string;
    start?: () => void;
    stop?: () => void;
  }

  export interface OpenClawPluginApi {
    pluginConfig?: unknown;
    config?: unknown;
    logger?: OpenClawLogger;
    registerHttpRoute(params: OpenClawPluginHttpRouteParams): void;
    registerService(service: OpenClawPluginService): void;
    [key: string]: unknown;
  }
}

declare module "openclaw/plugin-sdk/core" {
  import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
  export function definePluginEntry<T extends {
    id: string;
    name: string;
    description: string;
    configSchema?: unknown;
    kind?: string;
    register: (api: OpenClawPluginApi) => void;
  }>(opts: T): T;
}

/**
 * Channel-plugin SDK. The host exposes a much richer surface than what we
 * declare here — we expose only the helpers we actually call. Everything is
 * intentionally loose; the host enforces the contract at runtime.
 */
declare module "openclaw/plugin-sdk/runtime-store" {
  export interface PluginRuntimeStore<T> {
    setRuntime: (next: T) => void;
    clearRuntime: () => void;
    tryGetRuntime: () => T | null;
    getRuntime: () => T;
  }

  export function createPluginRuntimeStore<T>(opts: {
    pluginId: string;
    errorMessage: string;
  }): PluginRuntimeStore<T>;
}

declare module "openclaw/plugin-sdk/channel-core" {
  export interface ChannelMeta {
    id: string;
    [key: string]: unknown;
  }

  export function getChatChannelMeta(id: string): ChannelMeta;

  /**
   * The ChannelPlugin shape is large and version-shifting; we keep it `any`
   * and let the host validate. Our construction site is the only place that
   * touches the inside of this object.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ChannelPlugin = any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createChatChannelPlugin(spec: any): ChannelPlugin;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type OpenClawPluginApiAny = any;

  export interface DefineChannelPluginEntryOpts<TRuntime = unknown> {
    id: string;
    name: string;
    description?: string;
    plugin: ChannelPlugin;
    configSchema?: unknown;
    setRuntime?: (runtime: TRuntime) => void;
    registerCliMetadata?: (api: OpenClawPluginApiAny) => void;
    registerFull?: (api: OpenClawPluginApiAny) => void;
  }

  export interface DefinedChannelPluginEntry<TRuntime = unknown> {
    id: string;
    name: string;
    description: string;
    configSchema: unknown;
    register: (api: OpenClawPluginApiAny) => void;
    channelPlugin: ChannelPlugin;
    setChannelRuntime?: (runtime: TRuntime) => void;
  }

  export function defineChannelPluginEntry<TRuntime = unknown>(
    opts: DefineChannelPluginEntryOpts<TRuntime>,
  ): DefinedChannelPluginEntry<TRuntime>;
}
