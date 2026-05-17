/**
 * Minimal ambient declarations for the `openclaw/plugin-sdk` modules this
 * plugin imports at runtime. The real types live in the `openclaw` package
 * which is a peer dependency (provided by the host gateway). We declare only
 * what we use so we don't pull in the full 80MB SDK at dev time.
 *
 * If a host's openclaw package is installed locally, its real types take
 * precedence over these because of standard module resolution order.
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
    // Anything else is duck-typed; we feature-detect at runtime.
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
