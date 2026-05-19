# openclaw-plugin-voice-chat

Voice that behaves like chat. STT and TTS bracket the real OpenClaw agent —
the transcript becomes a real user turn, and the agent's reply streams back
through TTS as it generates. Same model, same memory, same skills, same
permissions. The voice layer is just I/O.

Built for the Mac Studio + Iris setup. Not a public OpenClaw plugin — uses
local secrets-daemon plumbing.

## How it works

```
                          (this plugin)
                                │
  mic ─► sox ─► WS frames ──► VAD ──► STT provider ──► transcript
                                │                          │
                                │                          ▼
                                │             runtime.channel.turn.runPrepared
                                │                          │
                                │       (real OpenClaw agent session — sonnet/opus/whatever)
                                │                          │
                                │                          ▼
                                ◄── sentence buffer ◄── reply stream
                                │
                                ▼
                          TTS provider ──► audio chunks ──► WS frames ──► speaker
```

- Registers as an OpenClaw **channel** (`voice-chat`).
- Hosts its **own** WebSocket on `127.0.0.1:18790` (separate from gateway 18789).
- A CLI client streams mic audio in, plays TTS audio back.
- Transcript runs as a real channel turn via `runtime.channel.turn.runPrepared`
  — the agent inherits its configured model, memory, skills, and permissions.
- Streaming throughout: STT emits as you talk, agent reply streams as deltas,
  sentence buffer emits to TTS as sentences complete, TTS chunks play as they
  arrive. End-to-end latency is dominated by your network + the LLM's
  first-token time, not the pipeline.

## Quick start

```bash
# Build
cd ~/openclaw-plugin-voice-chat
npm pack

# Deploy to iris's openclaw install
scp -i ~/.ssh/iris-local -o IdentitiesOnly=yes \
  levivoelz-openclaw-plugin-voice-chat-0.1.0.tgz iris@localhost:/tmp/
ssh -i ~/.ssh/iris-local -o IdentitiesOnly=yes iris@localhost \
  "openclaw plugins install /tmp/levivoelz-openclaw-plugin-voice-chat-0.1.0.tgz \
   --force --dangerously-force-unsafe-install \
   && openclaw gateway restart"

# Install local STT (default — Parakeet TDT via MLX, runs on-device)
uv tool install parakeet-mlx

# Talk
node ~/openclaw-plugin-voice-chat/dist/cli/index.js doctor
node ~/openclaw-plugin-voice-chat/dist/cli/index.js \
  --agent iris --gateway ws://127.0.0.1:18790
```

The `--dangerously-force-unsafe-install` is needed because the plugin uses
`child_process` (`macos-say` TTS provider, parakeet daemon spawn).

## STT providers

| Provider id | Backend | When to use |
|---|---|---|
| `voice-chat/parakeet-local` ★ default | Parakeet TDT via MLX, served by `daemon/parakeet-daemon.py` over a Unix socket. Auto-spawns on first utterance, keeps model warm | On-device, free, fast first-token. Apple Silicon only |
| `voice-chat/openai-realtime` | OpenAI Realtime API (GA) | Lowest latency, cloud cost, fewer hallucinations on noisy audio |
| `voice-chat/openai-whisper` | OpenAI Whisper REST | Simple, slower than realtime, no streaming partials |

### Parakeet daemon

See `daemon/README.md`. The daemon avoids the ~1s Python+MLX cold-start
that would otherwise hit every utterance. Auto-spawns; manual start is
documented in the sibling README.

## TTS providers

| Provider id | Backend | When to use |
|---|---|---|
| `voice-chat/openai` ★ default | OpenAI TTS (`tts-1`, voice `shimmer` by default) | Quality + latency balance, paid |
| `voice-chat/elevenlabs` | ElevenLabs | Best voice quality, needs `elevenlabs.apiKey` (pulled from iris-secrets-daemon) |
| `voice-chat/macos-say` | macOS `say` command | Zero cost, zero deps, robotic. Useful for dev / offline |

Audio formats supported: `mp3` (default), `pcm16`, `opus`.

## CLI usage

```bash
openclaw-voice [resume] [options]
```

Every invocation starts a NEW chat session by default. Use `resume` to
continue the most recent session for the given agent.

| Flag | What |
|---|---|
| `--gateway <url>` | WS URL of the plugin (default `ws://127.0.0.1:18790`, or `$OPENCLAW_GATEWAY`) |
| `--agent <id>` | Target agent id (default = gateway's default agent) |
| `--mode <ptt\|vad>` | `ptt` = push-to-talk (default), `vad` = voice-activity detection |
| `--stt <provider>` | Override STT provider (e.g. `voice-chat/openai-realtime`) |
| `--stt-model <name>` | Model id within that provider |
| `--tts <provider>` | Override TTS provider |
| `--tts-model <name>` | Model id |
| `--voice <name>` | TTS voice |
| `--format <mp3\|pcm16\|wav>` | Audio format |
| `--no-tts` | Transcript-only, no audio playback |
| `--no-stt` | Type input instead of speaking |
| `--print` | Echo transcripts and replies to stderr/stdout |
| `--audio-cues <voice\|off>` | A short sci-fi "working" cue (Zarvox) plays on the first thinking/tool event of a turn so you know iris is alive during long waits |
| `--device-token <tok>` | Auth token (or `$OPENCLAW_DEVICE_TOKEN`) |
| `--debug` | Verbose logging |

### Subcommands

| Command | What |
|---|---|
| `resume` | Resume the last voice session for `--agent` |
| `doctor` | Check `sox`, mic, player, gateway reachability, plugin install |
| `sessions` | List chat sessions via gateway API |
| `pair` | Device pairing (stub) |

### UX behaviors worth knowing

- **Push-to-talk:** space to talk, release to send. Esc to interrupt in-flight TTS.
- **Barge-in:** in VAD mode, starting to speak cancels iris's current TTS and the
  in-flight turn — feels like a real conversation. Mic VAD ducks while local
  playback is active so the speaker bleed doesn't trigger phantom utterances.
- **Working cues:** if iris goes quiet because she's thinking or running a tool,
  a brief sci-fi tone plays so you don't think the line dropped.
- **Auto-reconnect:** if the WebSocket drops, the CLI reconnects with
  exponential backoff and resumes the same client id.
- **Utterance stitching:** consecutive utterances inside an 800ms gap merge so
  pausing mid-sentence doesn't fragment the transcript.

### Exit codes

```
0  clean exit
2  gateway unreachable
3  auth failed
4  no mic / sox missing
5  plugin not installed
```

## Plugin config

Lives in iris's `~/.openclaw/openclaw.json` under `channels.voice-chat`:

```jsonc
{
  "channels": {
    "voice-chat": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 18790,

      "stt": {
        "provider": "voice-chat/parakeet-local",
        "model":    "mlx-community/parakeet-tdt-0.6b-v3",
        "language": "en"
      },
      "tts": {
        "provider": "voice-chat/openai",
        "model":    "tts-1",
        "voice":    "shimmer",
        "format":   "mp3"
      },

      "openai":     { "apiKey": "...", "baseUrl": "..." },
      "elevenlabs": { "apiKey": "..." },

      "mode":      "ptt",   // or "vad"
      "interrupt": true,    // cancel in-flight TTS on user speech

      // Per-agent overrides keyed by agent id
      "perAgent": {
        "iris": { "tts": { "voice": "nova" } }
      }
    }
  }
}
```

API keys can also be wired through the iris-secrets-daemon (see daemon
integration notes — credential plumbing is intentionally per-deploy).

## Repo layout

```
src/
  plugin.ts                 channel plugin entry
  channel-runtime.ts        host runtime store
  types.ts                  WS protocol frames
  core/
    voice-session.ts        per-WS orchestrator (turn lifecycle, streaming)
    sentence-buffer.ts      stream-aware sentence emitter (chunks the LLM
                            output into TTS-ready sentences as deltas arrive)
    speculative.ts          speculative LLM dispatch helpers
    resolve-config.ts       merge defaults/per-agent/hints
  providers/
    registry.ts
    daemon.ts               shared daemon-client helpers
    stt/  parakeet-local.ts, openai-realtime.ts, openai-whisper.ts
    tts/  openai.ts, elevenlabs.ts, macos-say.ts
  cli/
    index.ts                CLI entry + arg parsing
    talk.ts                 main interactive loop
    doctor.ts               environment + reachability checks
    sessions.ts             list/manage chat sessions
    pair.ts                 device pairing (stub)
    vad.ts                  client-side VAD
    audio-mac.ts            sox capture + afplay playback (macOS)
    audio-linux.ts          sox capture + ffplay/aplay playback (Linux)
    client-id.ts            persistent per-CLI client id
    ws.ts                   reconnecting WebSocket
  ui/
daemon/
  parakeet-daemon.py        long-lived Parakeet MLX inference daemon
  README.md
test/                       unit tests
types/openclaw.d.ts         ambient SDK shim
openclaw.plugin.json        OpenClaw plugin manifest + UI hints
```

## Dev loop

```bash
npx tsc --noEmit          # typecheck
npx tsc                   # build to dist/
npx tsx --test test/*.ts  # run tests
npm pack                  # produce tarball
```

## What makes it fast

End-to-end latency from "release space" to "first TTS audio playing" is
dominated by LLM first-token time. Pipeline contributions are below ~150ms
on a warm path:

- **Speculative LLM dispatch** — kick off the agent turn as soon as the
  transcript looks final-shaped, before the user has fully stopped speaking
- **Streaming TTS** — first complete sentence in the reply goes to TTS
  immediately; we don't wait for the agent to finish
- **Parakeet daemon keepalive** — model stays warm in MLX, ~1s cold start
  amortized to zero across utterances
- **16kHz mic + small stream chunks** — minimum viable for STT, smallest
  meaningful frame size for streaming
- **TTS prewarm** — first sentence triggers the TTS connection ahead of audio bytes
- **VAD ducking during playback** — mic stays open, just gets less sensitive,
  so barge-in works without phantom-utterance corruption

## Status

- Plugin loads cleanly as a channel on OpenClaw 2026.5.12+.
- STT verified live: Parakeet local (MLX), OpenAI Realtime (GA), OpenAI Whisper.
- TTS verified live: OpenAI (multiple voices/models), ElevenLabs (with paid
  key, now wired through iris-secrets-daemon), macOS `say`.
- End-to-end driven against the live gateway: transcript → real agent turn →
  streaming reply → TTS chunks → playback. ✓
- Thinking + tool events surface to the client via real SDK hooks
  (`replyOptions` callbacks) — drives the working-cue UX.

## Known host limitations (OpenClaw 2026.5.x)

- **No plugin-UI registration API.** Control UI is a monolithic SPA with
  hardcoded renderers per channel; third-party channels get a generic default
  view. Anything visual ships as a separate sibling-origin app, or not at all.
- **Channels require `auth: "gateway"` for WS upgrades.** Bypassed locally via
  `gateway.controlUi.dangerouslyDisableDeviceAuth: true`. Re-enable once the
  CLI implements the device-token challenge.

## License

MIT (in repo for future portability).
