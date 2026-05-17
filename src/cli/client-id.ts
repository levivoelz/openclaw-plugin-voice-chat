/**
 * Per-invocation clientId. The plugin uses clientId as the routing peer.id;
 * same peer = same chat session.
 *
 * Default behavior: every CLI invocation gets a fresh random clientId (a new
 * session). The chosen id is written to `last-<agent>.txt` so a subsequent
 * `resume` invocation can pick up the same conversation.
 *
 * Layout: ~/.config/openclaw-voice/last-<agent>.txt
 *
 * Override paths:
 *   --client-id <id>   exact id, no read/write
 *   resume             reuse last-<agent>.txt (errors if none)
 *   default            random uuid, persisted as "last"
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type ResolveOpts = {
  agentId: string;
  /** Explicit override — takes precedence over everything. */
  explicit?: string;
  /** Resume the last clientId used for this agent. Throws if none stored. */
  resume?: boolean;
};

export function resolveClientId(opts: ResolveOpts): string {
  if (opts.explicit && opts.explicit.length > 0) {
    saveLast(opts.agentId, opts.explicit);
    return opts.explicit;
  }
  if (opts.resume) {
    const prev = loadLast(opts.agentId);
    if (!prev) {
      throw new Error(
        `No previous voice session found for agent "${opts.agentId}". ` +
          `Start a new session first (without 'resume').`,
      );
    }
    return prev;
  }
  const fresh = randomUUID();
  saveLast(opts.agentId, fresh);
  return fresh;
}

export function loadLast(agentId: string): string | null {
  const file = lastFile(agentId);
  if (!existsSync(file)) return null;
  const id = readFileSync(file, "utf8").trim();
  return id.length > 0 ? id : null;
}

function saveLast(agentId: string, id: string): void {
  const file = lastFile(agentId);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, id + "\n", { mode: 0o600 });
}

function lastFile(agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return join(homedir(), ".config", "openclaw-voice", `last-${safe}.txt`);
}
