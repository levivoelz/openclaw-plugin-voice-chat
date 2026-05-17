# Parakeet MLX Inference Daemon

Long-lived Python process that loads the Parakeet TDT model once and serves
transcription requests over a Unix domain socket. Eliminates the ~1 s
Python+MLX cold-start that occurs when spawning `parakeet-mlx` per utterance.

**Socket path:** `/tmp/openclaw-parakeet.sock`

## Prerequisites

The daemon uses the same `parakeet-mlx` Python environment installed by
`uv tool install parakeet-mlx`. No extra deps needed.

## Auto-start (normal use)

The Node STT provider spawns the daemon automatically on the first utterance
if the socket does not already exist. Nothing extra needed.

## Manual start (debugging)

```bash
# Using the uv tool's Python (has parakeet_mlx on sys.path):
/Users/iris/.local/share/uv/tools/parakeet-mlx/bin/python3 \
  /path/to/openclaw-plugin-voice-chat/daemon/parakeet-daemon.py

# Verbose logging:
... daemon/parakeet-daemon.py --verbose

# Custom model or socket:
... daemon/parakeet-daemon.py --model mlx-community/parakeet-tdt-0.6b-v2 \
                               --socket /tmp/my-parakeet.sock
```

## Protocol

Request (newline-terminated JSON sent to the socket):
```json
{"audio_pcm_b64": "<base64 PCM16 mono>", "sample_rate": 16000}
```

Response (newline-terminated JSON):
```json
{"text": "transcribed text"}
{"error": "message if something went wrong"}
```

## Stopping the daemon

```bash
pkill -f parakeet-daemon.py
```
