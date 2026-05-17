#!/usr/bin/env node
/**
 * openclaw-voice — CLI entry point.
 *
 * Subcommands: doctor, sessions, pair
 * Default (no subcommand): voice loop (talk)
 */

import { talk, type TalkOptions } from "./talk.js";
import { doctor } from "./doctor.js";
import { sessions } from "./sessions.js";
import { pair } from "./pair.js";
import type { AudioFormat, CaptureMode } from "../types.js";

const pkg = (await import("../../package.json", { with: { type: "json" } })).default as { version: string };
const version = pkg.version;

const HELP = `
openclaw-voice [options]

Options:
  --gateway <url>         WS gateway URL (default: ws://127.0.0.1:18789)
                          or \$OPENCLAW_GATEWAY
  --agent <id>            Target agent id (default: gateway default)
  --session <key>         Resume an existing chat session by sessionKey
  --client-id <id>        Use this exact peer id (bypasses --new and the
                          per-agent persisted default)
  --new                   Fresh, non-persisted clientId — one-off session
  --mode <ptt|vad>        Capture mode (default: ptt)
  --stt <provider>        STT provider id (e.g. voice-chat/openai-realtime)
  --stt-model <name>      STT model name
  --tts <provider>        TTS provider id (e.g. voice-chat/openai)
  --tts-model <name>      TTS model name
  --voice <name>          TTS voice name
  --format <mp3|pcm16|wav>  Audio format (default: mp3)
  --no-tts                Transcript-only, skip audio playback
  --no-stt                Type input instead of speaking
  --print                 Echo transcripts and replies to stderr/stdout
  --device-token <tok>    Auth token (or \$OPENCLAW_DEVICE_TOKEN)
  --debug                 Verbose logging
  --help, -h              Show this help
  --version, -v           Show version

Subcommands:
  doctor                  Check sox, mic, player, gateway reachability
  sessions                List chat sessions via gateway API
  pair                    Device pairing (stub)

Exit codes:
  0  clean exit
  2  gateway unreachable
  3  auth failed
  4  no mic / sox missing
  5  plugin not installed
`.trimStart();

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
}

function hasFlag(argv: string[], ...flags: string[]): boolean {
  return flags.some((f) => argv.includes(f));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (hasFlag(argv, "--help", "-h") || argv[0] === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (hasFlag(argv, "--version", "-v")) {
    process.stdout.write(`${version}\n`);
    process.exit(0);
  }

  const gateway =
    arg(argv, "--gateway") ??
    process.env["OPENCLAW_GATEWAY"] ??
    "ws://127.0.0.1:18789";

  const deviceToken =
    arg(argv, "--device-token") ??
    process.env["OPENCLAW_DEVICE_TOKEN"];

  const debug = hasFlag(argv, "--debug");

  const subcommand = argv[0];

  if (subcommand === "doctor") {
    await doctor({ gateway, deviceToken, debug });
    return;
  }

  if (subcommand === "sessions") {
    await sessions({ gateway, deviceToken, debug });
    return;
  }

  if (subcommand === "pair") {
    pair();
    return;
  }

  // Default: voice loop.
  const rawFormat = arg(argv, "--format") ?? "mp3";
  const validFormats: AudioFormat[] = ["mp3", "pcm16", "wav", "opus"];
  if (!validFormats.includes(rawFormat as AudioFormat)) {
    process.stderr.write(`Invalid --format "${rawFormat}". Must be one of: ${validFormats.join(", ")}\n`);
    process.exit(1);
  }

  const rawMode = arg(argv, "--mode") ?? "ptt";
  if (rawMode !== "ptt" && rawMode !== "vad") {
    process.stderr.write(`Invalid --mode "${rawMode}". Must be ptt or vad.\n`);
    process.exit(1);
  }

  const talkOpts: TalkOptions = {
    gateway,
    agentId:     arg(argv, "--agent"),
    session:     arg(argv, "--session"),
    clientId:    arg(argv, "--client-id"),
    newSession:  hasFlag(argv, "--new"),
    mode:        rawMode as CaptureMode,
    stt:         arg(argv, "--stt"),
    sttModel:    arg(argv, "--stt-model"),
    tts:         arg(argv, "--tts"),
    ttsModel:    arg(argv, "--tts-model"),
    voice:       arg(argv, "--voice"),
    format:      rawFormat as AudioFormat,
    noTts:       hasFlag(argv, "--no-tts"),
    noStt:       hasFlag(argv, "--no-stt"),
    print:       hasFlag(argv, "--print"),
    deviceToken,
    debug,
  };

  await talk(talkOpts);
}

main().catch((e: unknown) => {
  process.stderr.write(`Fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
