/**
 * openclaw-voice doctor — checks prerequisites and connectivity.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";
import { VOICE_WS_PATH } from "../types.js";
import { wsToHttp } from "./ws.js";

const execFileAsync = promisify(execFile);

type CheckResult = { label: string; ok: boolean; detail?: string };

export async function doctor(opts: { gateway: string; deviceToken?: string; debug: boolean }): Promise<void> {
  const results: CheckResult[] = [];

  results.push(await checkSox());
  results.push(await checkPlayer());
  results.push(await checkMic());
  results.push(await checkGateway(opts.gateway, opts.deviceToken, opts.debug));
  results.push(await checkPlugin(opts.gateway, opts.deviceToken, opts.debug));

  for (const r of results) {
    const icon = r.ok ? "✓" : "✗";
    const line = `  ${icon} ${r.label}${r.detail ? ` — ${r.detail}` : ""}`;
    process.stdout.write(`${line}\n`);
  }

  const allOk = results.every((r) => r.ok);
  process.exit(allOk ? 0 : 1);
}

async function checkSox(): Promise<CheckResult> {
  try {
    await execFileAsync("which", ["sox"]);
    const { stdout } = await execFileAsync("sox", ["--version"]);
    return { label: "sox installed", ok: true, detail: stdout.trim().split("\n")[0] ?? "ok" };
  } catch {
    return { label: "sox installed", ok: false, detail: "install sox (brew install sox / apt install sox)" };
  }
}

async function checkPlayer(): Promise<CheckResult> {
  const isMac = process.platform === "darwin";
  const player = isMac ? "afplay" : "ffplay";
  const fallback = isMac ? null : "aplay";

  try {
    await execFileAsync("which", [player]);
    return { label: `${player} installed`, ok: true };
  } catch {
    if (fallback) {
      try {
        await execFileAsync("which", [fallback]);
        return { label: `${fallback} installed (ffplay preferred)`, ok: true };
      } catch { /* fall through */ }
    }
    const hint = isMac
      ? "afplay is built-in to macOS — check your PATH"
      : "install ffmpeg (apt install ffmpeg) or alsa-utils for aplay";
    return { label: `${player} installed`, ok: false, detail: hint };
  }
}

async function checkMic(): Promise<CheckResult> {
  const tmp = join(tmpdir(), `voice-doctor-${randomUUID()}.raw`);
  try {
    // Record 200ms of audio; exit nonzero if mic is unavailable.
    await execFileAsync("sox", [
      "-d",
      "-t", "raw",
      "-r", "16000",
      "-c", "1",
      "-b", "16",
      "-e", "signed-integer",
      tmp,
      "trim", "0", "0.2",
    ], { timeout: 3000 });
    return { label: "Microphone accessible", ok: true };
  } catch (e) {
    return { label: "Microphone accessible", ok: false, detail: `sox failed: ${(e as Error).message.split("\n")[0]}` };
  } finally {
    if (existsSync(tmp)) try { unlinkSync(tmp); } catch { /* best-effort */ }
  }
}

async function checkGateway(gateway: string, token: string | undefined, debug: boolean): Promise<CheckResult> {
  const httpBase = wsToHttp(gateway.replace(/\/$/, ""));
  const healthUrl = `${httpBase}/health`;

  try {
    const res = await fetchWithTimeout(healthUrl, token, 4000);
    if (res.ok || res.status === 401) {
      // 401 means the gateway is reachable but auth failed — that's still reachable.
      return { label: "Gateway reachable", ok: true, detail: res.status === 401 ? "auth required" : `HTTP ${res.status}` };
    }
    return { label: "Gateway reachable", ok: false, detail: `HTTP ${res.status}` };
  } catch (e) {
    if (debug) process.stderr.write(`[debug] gateway health error: ${(e as Error).message}\n`);
    // Fall back to attempting a WS connection.
    return checkGatewayWs(gateway, token, debug);
  }
}

async function checkGatewayWs(gateway: string, token: string | undefined, _debug: boolean): Promise<CheckResult> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    // Dynamically import ws to avoid requiring it at top level.
    import("ws").then(({ default: WebSocket }) => {
      const wsUrl = `${gateway.replace(/\/$/, "")}${VOICE_WS_PATH}`;
      const ws = new WebSocket(wsUrl, { headers });
      const timer = setTimeout(() => {
        ws.terminate();
        resolve({ label: "Gateway reachable", ok: false, detail: "timeout after 4s" });
      }, 4000);

      ws.on("open", () => {
        clearTimeout(timer);
        ws.close();
        resolve({ label: "Gateway reachable", ok: true, detail: "WS upgrade succeeded" });
      });

      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        const code = res.statusCode ?? 0;
        // 401/403 = reachable; 404 could mean plugin not installed.
        resolve({
          label: "Gateway reachable",
          ok: code === 401 || code === 403 || code === 200,
          detail: `HTTP ${code}`,
        });
      });

      ws.on("error", (e) => {
        clearTimeout(timer);
        resolve({ label: "Gateway reachable", ok: false, detail: e.message });
      });
    }).catch((e: Error) => {
      resolve({ label: "Gateway reachable", ok: false, detail: e.message });
    });
  });
}

async function checkPlugin(gateway: string, token: string | undefined, _debug: boolean): Promise<CheckResult> {
  // Try HTTP HEAD on the WS path; a 404 means the plugin route isn't registered.
  const httpBase = wsToHttp(gateway.replace(/\/$/, ""));
  const url = `${httpBase}${VOICE_WS_PATH}`;

  try {
    const res = await fetchWithTimeout(url, token, 4000, "HEAD");
    if (res.status === 404) {
      return { label: "Voice-chat plugin installed", ok: false, detail: "404 — plugin not loaded in this gateway" };
    }
    // Any response that isn't 404 means the route exists.
    return { label: "Voice-chat plugin installed", ok: true, detail: `route responds (HTTP ${res.status})` };
  } catch {
    // If HTTP HEAD fails (WS-only gateway), we can't tell — assume ok.
    return { label: "Voice-chat plugin installed", ok: true, detail: "could not probe via HTTP (WS-only gateway?)" };
  }
}

async function fetchWithTimeout(
  url: string,
  token: string | undefined,
  timeoutMs: number,
  method = "GET",
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    return await fetch(url, { method, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
