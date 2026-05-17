/**
 * openclaw-voice sessions — lists chat sessions via the gateway HTTP API.
 */

import { wsToHttp } from "./ws.js";

type SessionRow = { id: string; title?: string; [k: string]: unknown };

export async function sessions(opts: { gateway: string; deviceToken?: string; debug: boolean }): Promise<void> {
  const base = wsToHttp(opts.gateway.replace(/\/$/, ""));
  const url = `${base}/api/sessions`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.deviceToken) headers["Authorization"] = `Bearer ${opts.deviceToken}`;

  let res: Response;
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 6000);
    res = await fetch(url, { headers, signal: controller.signal });
  } catch (e) {
    process.stderr.write(`Error reaching gateway: ${(e as Error).message}\n`);
    process.exit(2);
  }

  if (res.status === 404) {
    process.stdout.write(
      "Gateway does not expose a sessions HTTP endpoint on this version; " +
      "use the Control UI to list sessions.\n",
    );
    process.exit(0);
  }

  if (res.status === 401 || res.status === 403) {
    process.stderr.write(`Auth failed (HTTP ${res.status}). Pass --device-token or set OPENCLAW_DEVICE_TOKEN.\n`);
    process.exit(3);
  }

  if (!res.ok) {
    process.stderr.write(`Unexpected HTTP ${res.status} from gateway.\n`);
    process.exit(1);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    process.stderr.write("Could not parse sessions response as JSON.\n");
    process.exit(1);
  }

  const rows: SessionRow[] = Array.isArray(body)
    ? (body as SessionRow[])
    : Array.isArray((body as { sessions?: SessionRow[] }).sessions)
      ? (body as { sessions: SessionRow[] }).sessions
      : [];

  if (rows.length === 0) {
    process.stdout.write("No sessions found.\n");
    process.exit(0);
  }

  // Print id + title columns.
  const idWidth = Math.max(4, ...rows.map((r) => String(r.id).length));
  process.stdout.write(`${"ID".padEnd(idWidth)}  TITLE\n`);
  process.stdout.write(`${"—".repeat(idWidth)}  ${"—".repeat(40)}\n`);
  for (const row of rows) {
    const id = String(row.id).padEnd(idWidth);
    const title = row.title ?? "(untitled)";
    process.stdout.write(`${id}  ${title}\n`);
  }
  process.exit(0);
}
