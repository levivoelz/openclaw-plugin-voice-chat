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
import { execFileSync } from "node:child_process";

export type DaemonConfig = {
  url?: string;
  token?: string;
  tokenFile?: string;
};

const DEFAULT_URL = "http://127.0.0.1:9876";

export type DaemonAuth = { url: string; token: string };

let cachedToken: string | null = null;

export function isDaemonConfigured(cfg: Record<string, unknown>): boolean {
  try { resolveDaemonAuth(cfg); return true; } catch { return false; }
}

/**
 * Resolution order — matches the iris-secrets-client.py pattern, plus a
 * file-based fallback for non-iris callers (e.g. the levi-side CLI smoke test).
 *
 *   1. explicit `daemon.token` in plugin config
 *   2. $IRIS_DAEMON_TOKEN env var
 *   3. `daemon.tokenFile` JSON (if configured) — reads `bearer_token` field
 *   4. macOS Keychain: `iris-secrets-daemon-token` for the current user
 *   5. /Users/levi/.iris-secrets-daemon/auth.json (canonical levi-side file)
 */
export function resolveDaemonAuth(cfg: Record<string, unknown>): DaemonAuth {
  const d = (cfg["daemon"] ?? {}) as DaemonConfig;
  const url = d.url ?? DEFAULT_URL;
  const token =
    d.token ??
    process.env["IRIS_DAEMON_TOKEN"] ??
    (d.tokenFile ? readTokenFile(d.tokenFile) : null) ??
    cachedToken ??
    readKeychainToken() ??
    readTokenFile("/Users/levi/.iris-secrets-daemon/auth.json");
  if (!token) {
    throw new Error(
      "voice-chat: iris-secrets daemon token not resolvable (tried config.token, " +
      "$IRIS_DAEMON_TOKEN, configured tokenFile, macOS Keychain, levi-side auth.json)",
    );
  }
  cachedToken = token;
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

function readKeychainToken(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-a", process.env["USER"] ?? "iris", "-s", "iris-secrets-daemon-token", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 },
    ).trim();
    return out.length > 0 ? out : null;
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
