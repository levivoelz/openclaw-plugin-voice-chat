/**
 * Stable per-machine + per-agent clientId so the same voice CLI run keeps
 * landing in the same chat session day-after-day. The plugin uses clientId
 * as the routing peer.id; same peer = same session.
 *
 * Layout: ~/.config/openclaw-voice/clientId-<agent>.txt (one file per agent)
 *
 * Override paths:
 *   --client-id <id>   exact id, no read/write
 *   --new              one-off random id, not persisted
 *   default            read existing or create + persist a new one for this agent
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type ResolveOpts = {
  agentId: string;
  explicit?: string;
  fresh?: boolean;
};

export function resolveClientId(opts: ResolveOpts): string {
  if (opts.explicit && opts.explicit.length > 0) return opts.explicit;
  if (opts.fresh) return randomUUID();

  const dir = join(homedir(), ".config", "openclaw-voice");
  const safeAgent = opts.agentId.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  const file = join(dir, `clientId-${safeAgent}.txt`);

  if (existsSync(file)) {
    const id = readFileSync(file, "utf8").trim();
    if (id.length > 0) return id;
  }

  const id = `${hostname().split(".")[0]}-${safeAgent}-${randomUUID().slice(0, 8)}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, id + "\n", { mode: 0o600 });
  return id;
}

export function clientIdStorePath(agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return join(homedir(), ".config", "openclaw-voice", `clientId-${safe}.txt`);
}
