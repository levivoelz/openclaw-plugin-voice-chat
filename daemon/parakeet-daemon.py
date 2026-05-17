#!/usr/bin/env python3
"""
Parakeet MLX inference daemon.

Loads the model once at startup, then serves transcription requests over a
Unix domain socket at /tmp/openclaw-parakeet.sock.

Request  (newline-terminated JSON):
  {"audio_pcm_b64": "<base64-encoded PCM16 mono>", "sample_rate": 24000}

Response (newline-terminated JSON):
  {"text": "transcribed text"}          — success
  {"error": "message"}                  — failure

Concurrency: requests are serialized through a queue; inference is
single-threaded (MLX/Metal is not safely reentrant from multiple threads).

Usage:
  python3 parakeet-daemon.py [--model mlx-community/parakeet-tdt-0.6b-v3] [--socket /tmp/openclaw-parakeet.sock]
"""

import argparse
import base64
import json
import logging
import os
import queue
import socket
import struct
import sys
import tempfile
import threading
import wave
from pathlib import Path

# ---------------------------------------------------------------------------
# Logging — goes to stderr so the Node parent can redirect it separately.
# ---------------------------------------------------------------------------
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s [parakeet-daemon] %(levelname)s %(message)s",
)
log = logging.getLogger("parakeet-daemon")

SOCKET_PATH = "/tmp/openclaw-parakeet.sock"
DEFAULT_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------
def load_model(model_id: str):
    """Import parakeet_mlx from the uv tool environment and load the model."""
    log.info("Loading model %s …", model_id)
    try:
        import parakeet_mlx
    except ModuleNotFoundError:
        # The daemon might be launched without the uv tool env on PYTHONPATH.
        # Try to find it relative to the parakeet-mlx binary on PATH.
        import shutil
        binary = shutil.which("parakeet-mlx")
        if binary:
            # binary is e.g. /Users/iris/.local/bin/parakeet-mlx
            # site-packages is sibling of bin: …/tools/parakeet-mlx/lib/pythonX.Y/site-packages
            bin_dir = Path(binary).resolve().parent
            tool_dir = bin_dir.parent  # e.g. /Users/iris/.local/share/uv/tools/parakeet-mlx
            # Walk up to the uv tool virtualenv root and find site-packages
            for sp in tool_dir.glob("lib/python*/site-packages"):
                if sp not in sys.path:
                    sys.path.insert(0, str(sp))
                break
        import parakeet_mlx  # noqa: F811 — re-import after path fix

    model = parakeet_mlx.from_pretrained(model_id)
    log.info("Model loaded.")
    return model


# ---------------------------------------------------------------------------
# Transcription helper
# ---------------------------------------------------------------------------
def transcribe_pcm(model, pcm_bytes: bytes, sample_rate: int) -> str:
    """Write PCM16 mono bytes to a temp WAV, transcribe, return text."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp_path = f.name

    try:
        # Write a minimal WAV file.
        with wave.open(tmp_path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # 16-bit = 2 bytes
            wf.setframerate(sample_rate)
            wf.writeframes(pcm_bytes)

        result = model.transcribe(tmp_path)
        return result.text.strip()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Request worker (runs in its own thread, owns the model)
# ---------------------------------------------------------------------------
class InferenceWorker(threading.Thread):
    """Serializes inference requests through an internal queue."""

    def __init__(self, model):
        super().__init__(daemon=True, name="inference-worker")
        self._model = model
        self._queue: queue.Queue = queue.Queue()

    def submit(self, pcm_bytes: bytes, sample_rate: int) -> "threading.Future[str]":
        """Submit a transcription job and return a Future for the result."""
        fut: threading.Future = concurrent_futures_Future()
        self._queue.put((pcm_bytes, sample_rate, fut))
        return fut

    def run(self):
        while True:
            pcm_bytes, sample_rate, fut = self._queue.get()
            try:
                text = transcribe_pcm(self._model, pcm_bytes, sample_rate)
                fut.set_result(text)
            except Exception as exc:
                fut.set_exception(exc)


def concurrent_futures_Future():
    """Lazy import to avoid pulling in concurrent.futures at module level."""
    from concurrent.futures import Future
    return Future()


# ---------------------------------------------------------------------------
# Connection handler — one thread per client connection
# ---------------------------------------------------------------------------
def handle_connection(conn: socket.socket, worker: InferenceWorker):
    peer = conn.getpeername() if hasattr(conn, "getpeername") else "unix"
    log.debug("Client connected: %s", peer)
    try:
        buf = b""
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
            # A request is a single JSON line terminated by \n.
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue
                _handle_request(conn, worker, line)
    except (ConnectionResetError, BrokenPipeError):
        pass
    except Exception as exc:
        log.warning("Connection error: %s", exc)
    finally:
        try:
            conn.close()
        except OSError:
            pass
        log.debug("Client disconnected.")


def _handle_request(conn: socket.socket, worker: InferenceWorker, raw: bytes):
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as exc:
        _send_json(conn, {"error": f"invalid JSON: {exc}"})
        return

    audio_b64 = req.get("audio_pcm_b64")
    sample_rate = req.get("sample_rate", 16000)

    if not audio_b64:
        _send_json(conn, {"error": "missing audio_pcm_b64"})
        return

    try:
        pcm_bytes = base64.b64decode(audio_b64)
    except Exception as exc:
        _send_json(conn, {"error": f"base64 decode failed: {exc}"})
        return

    if len(pcm_bytes) < 2:
        _send_json(conn, {"error": "audio too short"})
        return

    log.debug("Queuing transcription: %d PCM bytes @ %d Hz", len(pcm_bytes), sample_rate)
    fut = worker.submit(pcm_bytes, sample_rate)
    try:
        text = fut.result(timeout=120)
        _send_json(conn, {"text": text})
    except TimeoutError:
        _send_json(conn, {"error": "inference timeout"})
    except Exception as exc:
        _send_json(conn, {"error": str(exc)})


def _send_json(conn: socket.socket, obj: dict):
    try:
        conn.sendall((json.dumps(obj) + "\n").encode())
    except (BrokenPipeError, OSError):
        pass


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------
def run_server(socket_path: str, worker: InferenceWorker):
    if os.path.exists(socket_path):
        os.unlink(socket_path)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(socket_path)
    # Restrict to current user only.
    os.chmod(socket_path, 0o600)
    server.listen(16)
    log.info("Listening on %s", socket_path)

    try:
        while True:
            conn, _ = server.accept()
            t = threading.Thread(
                target=handle_connection, args=(conn, worker), daemon=True
            )
            t.start()
    except KeyboardInterrupt:
        log.info("Shutting down.")
    finally:
        server.close()
        try:
            os.unlink(socket_path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Parakeet MLX inference daemon")
    parser.add_argument(
        "--model", default=DEFAULT_MODEL, help="HuggingFace model ID (default: %(default)s)"
    )
    parser.add_argument(
        "--socket", default=SOCKET_PATH, help="Unix socket path (default: %(default)s)"
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="Enable debug logging"
    )
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    model = load_model(args.model)
    worker = InferenceWorker(model)
    worker.start()
    run_server(args.socket, worker)


if __name__ == "__main__":
    main()
