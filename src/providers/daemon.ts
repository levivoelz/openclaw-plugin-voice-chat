/**
 * Iris-secrets daemon client. Providers route credentialed calls through the
 * daemon so the plugin never holds raw third-party API keys.
 *
 * Auth: the daemon's bearer token lives in the user's macOS Keychain at
 * (account = $USER, service = "iris-secrets-daemon-token"). This matches the
 * pattern iris's own iris-secrets-client.py and webhook-server/server.js use.
 * One source of truth, no fallbacks, no env vars, no config secrets.
 */

import { execFileSync } from "node:child_process";

export type DaemonAuth = { url: string; token: string };

const DAEMON_URL = "http://127.0.0.1:9876";
const KEYCHAIN_SERVICE = "iris-secrets-daemon-token";

let cachedToken: string | null = null;

export function isDaemonConfigured(_cfg: Record<string, unknown>): boolean {
  try { resolveDaemonAuth(_cfg); return true; } catch { return false; }
}

export function resolveDaemonAuth(_cfg: Record<string, unknown>): DaemonAuth {
  if (!cachedToken) cachedToken = readKeychainToken();
  if (!cachedToken) {
    throw new Error(
      `voice-chat: keychain item "${KEYCHAIN_SERVICE}" not found for user ` +
      `"${process.env["USER"] ?? "?"}". Add it with: ` +
      `security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w "<token>"`,
    );
  }
  return { url: DAEMON_URL, token: cachedToken };
}

function readKeychainToken(): string | null {
  if (process.platform !== "darwin") return null;
  const user = process.env["USER"];
  if (!user) return null;
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-a", user, "-s", KEYCHAIN_SERVICE, "-w"],
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

/**
 * POST a JSON body to a daemon streaming endpoint. Returns the response body
 * as an async iterable of raw Uint8Array chunks. The daemon must respond with
 * Transfer-Encoding: chunked and a binary content type (e.g. audio/mpeg).
 *
 * Throws if the HTTP status is not 2xx (reads error body before throwing).
 */
export async function* daemonStream(
  auth: DaemonAuth,
  path: string,
  body: unknown,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): AsyncIterable<Uint8Array> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  const compositeSignal = opts.signal
    ? anySignal([ctrl.signal, opts.signal])
    : ctrl.signal;

  let res: Response;
  try {
    res = await fetch(`${auth.url}${path}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: compositeSignal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok || res.body === null) {
    const text = res.body ? await res.text() : "";
    let parsed: { error?: string; detail?: string } = {};
    try { parsed = JSON.parse(text); } catch { /* ignore */ }
    throw new Error(
      `daemon ${path} ${res.status}: ${parsed.error ?? "error"} ${parsed.detail ?? text.slice(0, 200)}`,
    );
  }

  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) yield value;
    }
  } finally {
    reader.cancel().catch(() => {/* ignore */});
  }
}
