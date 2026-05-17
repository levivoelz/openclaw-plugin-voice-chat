/**
 * Iris-secrets daemon client. All STT/TTS providers route through the daemon
 * so the plugin never holds raw API keys. The daemon (running on the levi
 * account) keeps the keys; iris just holds a bearer token to talk to it.
 *
 * Config shape (under `channels.voice-chat.daemon`):
 *   { url?: string, token?: string, tokenFile?: string }
 *
 * Defaults: url = http://127.0.0.1:9876, tokenFile = /Users/iris/.iris-secrets-daemon/auth.json.
 * Token is resolved from `token` (literal) or `tokenFile` (`{bearer_token}` JSON
 * field), in that order.
 */

import { readFileSync } from "node:fs";

export type DaemonConfig = {
  url?: string;
  token?: string;
  tokenFile?: string;
};

const DEFAULT_URL = "http://127.0.0.1:9876";
const DEFAULT_TOKEN_FILE = "/Users/iris/.iris-secrets-daemon/auth.json";

export type DaemonAuth = { url: string; token: string };

export function isDaemonConfigured(cfg: Record<string, unknown>): boolean {
  try { resolveDaemonAuth(cfg); return true; } catch { return false; }
}

export function resolveDaemonAuth(cfg: Record<string, unknown>): DaemonAuth {
  const d = (cfg["daemon"] ?? {}) as DaemonConfig;
  const url = d.url ?? DEFAULT_URL;
  const token = d.token ?? readTokenFile(d.tokenFile ?? DEFAULT_TOKEN_FILE);
  if (!token) throw new Error("voice-chat: iris-secrets daemon token not resolvable");
  return { url, token };
}

function readTokenFile(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8");
    const j = JSON.parse(raw) as Record<string, unknown>;
    const t = j["bearer_token"] ?? j["token"];
    return typeof t === "string" && t.length > 0 ? t : null;
  } catch { return null; }
}

/** POST a JSON body to a daemon endpoint. Returns parsed JSON. */
export async function daemonPost<T = unknown>(
  auth: DaemonAuth,
  path: string,
  body: unknown,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  const compositeSignal = opts.signal
    ? anySignal([ctrl.signal, opts.signal])
    : ctrl.signal;
  try {
    const res = await fetch(`${auth.url}${path}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: compositeSignal,
    });
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!res.ok) {
      const err = parsed as { error?: string; detail?: string };
      throw new Error(`daemon ${path} ${res.status}: ${err.error ?? "error"} ${err.detail ?? text.slice(0, 200)}`);
    }
    return parsed as T;
  } finally {
    clearTimeout(timeout);
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(); return ctrl.signal; }
    s.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}
