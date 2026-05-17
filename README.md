# openclaw-plugin-voice-chat

Voice I/O for OpenClaw, wired into the channel pipeline. Built for the Mac
Studio + Iris setup. Not a public OpenClaw plugin — uses local
secrets-daemon plumbing.

## What it does

- Registers as an OpenClaw **channel** (`voice-chat`).
- Hosts a WebSocket at `/plugins/voice-chat/ws` on the gateway.
- A client (CLI for now) connects, streams mic audio in.
- Plugin transcribes via OpenAI (Whisper or Realtime).
- Transcript becomes a **real user turn** in the routed chat session via
  `runtime.channel.turn.runPrepared`.
- Agent reply streams back as block-level deltas → sentence buffer → TTS
  provider → audio out over the same WebSocket.

## Repo

```
src/
  plugin.ts                 channel plugin entry
  channel-runtime.ts        host runtime store
  types.ts                  WS protocol frames
  core/
    voice-session.ts        per-WS orchestrator
    sentence-buffer.ts      stream-aware sentence emitter
    resolve-config.ts       merge defaults/per-agent/hints
  providers/
    registry.ts
    stt/  openai-realtime.ts, openai-whisper.ts
    tts/  openai.ts, elevenlabs.ts, macos-say.ts
  cli/                      openclaw-voice CLI (sox + afplay)
types/openclaw.d.ts         ambient SDK shim
test/                       unit tests
```

## Dev loop

```bash
# in this repo:
npx tsc --noEmit          # typecheck
npx tsc                   # build to dist/
npx tsx --test test/*.ts  # run tests
npm pack                  # produce tarball
```

## Deploy to iris

```bash
# from /Users/levi/openclaw-plugin-voice-chat
npm pack
scp -i ~/.ssh/iris-local -o IdentitiesOnly=yes \
  levivoelz-openclaw-plugin-voice-chat-0.1.0.tgz iris@localhost:/tmp/
ssh -i ~/.ssh/iris-local -o IdentitiesOnly=yes iris@localhost \
  "openclaw plugins install /tmp/levivoelz-openclaw-plugin-voice-chat-0.1.0.tgz \
   --force --dangerously-force-unsafe-install \
   && openclaw gateway restart"
```

The `--dangerously-force-unsafe-install` is needed because the plugin uses
`child_process` (macos-say TTS provider).

## Plugin config (iris's `~/.openclaw/openclaw.json`)

```jsonc
{
  "channels": {
    "voice-chat": {
      "enabled": true,
      "stt": { "provider": "voice-chat/openai-whisper", "model": "whisper-1" },
      "tts": { "provider": "voice-chat/openai", "model": "tts-1", "voice": "alloy" },
      // Credentials wiring TBD — see daemon-integration notes
    }
  }
}
```

## CLI usage

```bash
# from levi's account
node /Users/levi/openclaw-plugin-voice-chat/dist/cli/index.js doctor
node /Users/levi/openclaw-plugin-voice-chat/dist/cli/index.js \
  --agent iris --gateway ws://127.0.0.1:18789
```

Press space to talk; release to send. Esc interrupts in-flight TTS.

## Status

- Plugin loads cleanly as a channel on OpenClaw 2026.5.2.
- Provider code verified live: OpenAI Whisper STT, OpenAI Realtime STT (GA),
  OpenAI TTS (multiple voices/models), macOS `say` TTS. ElevenLabs needs a
  paid-plan key for library voices.
- `runChannelTurn` integration compiles against `runtime.channel.*` but
  end-to-end (transcript → agent reply → TTS chunks back) not yet driven
  against the live gateway.
- Daemon integration for credential plumbing is the next missing piece.

## Known host limitations (OpenClaw 2026.5.2)

- No plugin-UI registration API. Control UI is a monolithic SPA with
  hardcoded renderers per channel; third-party channels get a generic
  default view. Anything visual ships as a separate sibling-origin app, or
  not at all.
- Channels require `auth: "gateway"` for WS upgrades. Bypassed locally via
  `gateway.controlUi.dangerouslyDisableDeviceAuth: true`. Re-enable once
  the CLI implements the device-token challenge.

## License

MIT (in repo for future portability).
