# Development

## The dev loop (no build step)

OpenClaw loads `.ts` plugin entries directly via jiti. So:

```bash
# 1. One-time install pointed at your working copy.
openclaw plugins install /path/to/openclaw-plugin-voice-chat

# 2. Edit src/*.ts directly.

# 3. Restart the gateway to pick up changes:
openclaw gateway restart
# (or send a hot-reload signal — see "Hot reload" below)

# 4. Tail the gateway log:
tail -F ~/.openclaw/logs/gateway.log
```

No `tsc` between edits. `npm run build` only matters for npm-published consumers who pull from `dist/` instead of `src/`.

## Hot reload (skip the restart)

The SDK supports config-driven hot reload via `api.registerReload({...})`. The plugin doesn't register one yet — when added, restarts won't be needed for config changes that match the `hotPrefixes` list (e.g. provider keys, voice selection). Code changes still require a restart.

## Testing the WS protocol without audio

This is the no-mumbo-jumbo path. The voice loop is just a WS exchange — you don't need a mic to debug the agent integration, sentence buffering, or TTS. A tiny Node script can drive it directly:

```bash
node -e '
const ws = new WebSocket("ws://127.0.0.1:18789/plugins/voice-chat/ws?agent=iris");
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ type: "hello", clientId: "dev", protocol: 1, codec: "pcm16", sampleRate: 16000 }));
  setTimeout(() => ws.send(JSON.stringify({ type: "text", content: "What time is it?" })), 200);
});
ws.addEventListener("message", (e) => {
  if (typeof e.data === "string") console.log("JSON:", e.data);
  else console.log("BINARY:", e.data.byteLength, "bytes");
});
'
```

That sends a text frame instead of audio. You'll see `transcript.final` → `agent.delta` (×N) → `agent.done` → `tts.chunk` + binary frames → `tts.done`. If anything in the pipeline is broken, you'll see exactly where without an audio confound.

## Testing providers in isolation

Each provider is a pure function of its inputs. Standalone test:

```bash
# TTS — produces audio without touching the gateway:
node --input-type=module -e '
import { registerOpenaiTts } from "./src/providers/tts/openai.js";
import { ProviderRegistry } from "./src/providers/registry.js";
const r = new ProviderRegistry();
registerOpenaiTts(r);
const tts = r.getTts("voice-chat/openai");
const fs = await import("node:fs");
const out = fs.createWriteStream("/tmp/test.mp3");
for await (const { chunk } of tts.synthesize({
  text: "Testing voice chat.",
  voice: "alloy",
  format: "mp3",
  providerConfig: { openai: { apiKey: process.env.OPENAI_API_KEY } },
})) out.write(chunk);
out.end();
'
afplay /tmp/test.mp3
```

Same pattern for STT — feed it a PCM16 buffer (or a WAV stripped of its header) and inspect the callbacks.

## Verifying the install

```bash
openclaw-voice doctor      # CLI side
openclaw plugins list      # gateway side — voice-chat should appear
openclaw plugins validate voice-chat   # (if available in your gateway version)
```

## Where logs go

- Gateway: `~/.openclaw/logs/gateway.log`
- Per-plugin output goes through `api.logger` and lands in the gateway log, prefixed `[voice-chat]`.
- Set `VOICE_CHAT_DEBUG=1` in the gateway env for verbose debug logs.

## Iteration cycle for a typical bug

1. Reproduce: hit `Talk` in Control UI or run the Node WS script above.
2. Tail logs: `tail -F ~/.openclaw/logs/gateway.log | grep voice-chat`
3. Edit `src/*.ts`.
4. `openclaw gateway restart` (or wait for hot reload if registered).
5. Repeat from 1.

Most bugs in a plugin like this show up in the orchestrator (`src/core/voice-session.ts`) and the agent bridge (`src/core/agent-bridge.ts`). When the WS log shows `error` frames, the message field is usually enough to localize.
