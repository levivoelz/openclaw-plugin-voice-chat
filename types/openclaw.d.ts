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
  export interface OpenClawLogger {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string, ...args: unknown[]) => void;
    debug: (msg: string) => void;
  }

  export interface OpenClawPluginApi {
    pluginConfig?: unknown;
    config?: unknown;
    logger?: OpenClawLogger;
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
