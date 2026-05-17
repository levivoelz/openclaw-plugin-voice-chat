# @levivoelz/openclaw-plugin-voice-chat

> Voice that behaves like chat.

A third-party OpenClaw plugin that adds true voice I/O to any chat agent. Speech-to-text and text-to-speech bracket the **real** OpenClaw agent — so your voice conversations inherit the agent's configured models, memory, skills, and permissions. No realtime model standing in front pretending to be your agent.

Ships with:

- A **WebSocket route** at `/plugins/voice-chat/ws` that any client can speak.
- A **Control UI panel** (mounted in `session.sidebar` and `session.modal`) for browser voice.
- A **settings page** (mounted in `settings.plugin`) for picking providers, models, voices, and surfacing your phone-access URL.
- A **CLI** (`openclaw-voice`) for terminal / headless voice — same WS protocol, sox + afplay/ffplay.
- Built-in STT providers: `openai-realtime`, `openai-whisper`.
- Built-in TTS providers: `openai`, `elevenlabs`, `macos-say` (offline).
- A pluggable provider registry — any other OpenClaw plugin can register more STT/TTS providers and they show up automatically in the picker.

## Why

OpenClaw's bundled `voice-call` plugin uses an inverted architecture: a realtime model is the brain and your agent is on-call as a tool. That's great for very low-latency banter, less great when you actually want to talk *to* the agent you configured.

This plugin runs the agent as the brain. Your transcript becomes a real user turn via `injectNextTurn`, the agent runs its full skill stack and streams a reply, and we sentence-buffer the stream into TTS chunks so the first audio plays in under a second.

## Install

```bash
openclaw plugins install clawhub:@levivoelz/openclaw-plugin-voice-chat
# or
openclaw plugins install npm:@levivoelz/openclaw-plugin-voice-chat
```

Enable in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "voice-chat": {
        "enabled": true,
        "config": {
          "openai":     { "apiKey": "${OPENAI_API_KEY}" },
          "elevenlabs": { "apiKey": "${ELEVENLABS_API_KEY}" },
          "stt": { "provider": "voice-chat/openai-whisper", "model": "whisper-1" },
          "tts": { "provider": "voice-chat/openai", "model": "tts-1", "voice": "alloy" },
          "mode": "ptt",
          "interrupt": true
        }
      }
    }
  }
}
```

Restart the gateway: `openclaw gateway restart`.

In the Control UI, every chat session now has a **Talk** button.

## CLI

```bash
npm i -g @levivoelz/openclaw-plugin-voice-chat
openclaw-voice doctor
openclaw-voice --agent iris --tts voice-chat/elevenlabs --voice Rachel
```

| Flag | Default | Notes |
|---|---|---|
| `--gateway <url>` | `ws://127.0.0.1:18789` | Or `$OPENCLAW_GATEWAY` |
| `--agent <id>` | gateway default | |
| `--session <key>` | new ephemeral | Resume an existing chat session |
| `--mode <ptt\|vad>` | `ptt` | Hold space (PTT) or voice-activity |
| `--stt <provider>` | config default | `voice-chat/openai-realtime` for low-latency |
| `--stt-model <name>` | provider default | |
| `--tts <provider>` | config default | |
| `--tts-model <name>` | provider default | |
| `--voice <name>` | provider default | |
| `--format <mp3\|pcm16\|wav>` | `mp3` | Audio format for TTS playback |
| `--no-tts` | | Transcript-only |
| `--no-stt` | | Type input, hear voice out |
| `--print` | | Echo transcripts and replies |
| `--device-token` | | Or `$OPENCLAW_DEVICE_TOKEN` |

Subcommands:

- `openclaw-voice doctor` — checks sox, mic permissions, gateway reachability, plugin installation.
- `openclaw-voice sessions` — list resumable chat sessions.
- `openclaw-voice pair` — device pairing (stub; for now configure `gateway.auth.token` directly).

## Provider configuration

### STT — speech-to-text

| Id | Provider | Models | Streaming |
|---|---|---|---|
| `voice-chat/openai-realtime` | OpenAI Realtime API | `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` | yes (partials) |
| `voice-chat/openai-whisper`  | OpenAI Whisper REST | `whisper-1` | no |

### TTS — text-to-speech

| Id | Provider | Models | Default voice |
|---|---|---|---|
| `voice-chat/openai`     | OpenAI Audio | `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` | `alloy` |
| `voice-chat/elevenlabs` | ElevenLabs | `eleven_turbo_v2_5`, `eleven_multilingual_v2`, `eleven_flash_v2_5` | Rachel |
| `voice-chat/macos-say`  | macOS `say` (offline) | n/a | Samantha |

You can override the provider, model, and voice at three levels:

1. **Config**: `plugins.entries.voice-chat.config.tts.{provider,model,voice}`
2. **Per-session**: client sends `ttsHints` in the WS `hello` frame, or CLI flags
3. **Per-turn**: agent reply can include a `TtsDirectiveOverrides` directive (handled by the SDK)

Any other OpenClaw plugin that registers a `RealtimeTranscriptionProviderPlugin` or `SpeechProviderPlugin` against the gateway provider registry is also selectable — the picker is dynamic.

## Phone access

The plugin runs on your gateway; reaching it from your phone is the same problem as reaching your gateway remotely. Pick a tunnel:

| Option | Cost | Notes |
|---|---|---|
| **Tailscale** | free | Recommended. Install on Mac + phone; gateway reachable at `https://mac.<tailnet>.ts.net:18789` with auto-provisioned TLS. |
| **Cloudflare Tunnel** | free | `cloudflared tunnel --url http://localhost:18789` → public URL with TLS. |
| **ngrok** | free / $8mo | Easy one-off; persistent URL costs. |
| **Caddy + VPS** | ~$5mo | Full control. |
| **LAN only** | free | Phone on same Wi-Fi, but you'll need a trusted local TLS cert (mkcert + install root on phone). |

The settings page auto-detects Tailscale / Cloudflare hostnames and shows a QR code with the right URL.

## WS protocol

Endpoint: `ws[s]://<gateway>/plugins/voice-chat/ws?session=<key>&agent=<id>`

```ts
// Client → plugin
{ type: "hello", clientId, protocol: 1, mode: "ptt", sttHints, ttsHints, codec: "pcm16", sampleRate: 16000 }
{ type: "speech.start" }
<binary PCM16 mono frame>
{ type: "speech.end" }
{ type: "interrupt" }
{ type: "text", content }
{ type: "bye" }
{ type: "ping" }

// Plugin → client
{ type: "ready", sessionKey, agentId, codecs, sttProvider, ttsProvider, ttsFormat }
{ type: "transcript.partial", text }
{ type: "transcript.final",   text, turnId }
{ type: "agent.delta",        text, turnId }
{ type: "agent.done",         turnId, usage }
{ type: "tts.chunk",          turnId, seq, format }
<binary audio frame>
{ type: "tts.done",           turnId }
{ type: "error",              code, message, recoverable }
{ type: "pong" }
```

Types are exported as `@levivoelz/openclaw-plugin-voice-chat/protocol`.

## Development

```bash
git clone <this repo>
cd openclaw-plugin-voice-chat
npm install
npm run typecheck
npm test
npm run build
```

To smoke-test against a local OpenClaw gateway: `npm link`, then in your OpenClaw install run `openclaw plugins install $(pwd)` from the linked directory, or set `openclaw.config.json` to load the plugin from a local path.

## License

MIT
