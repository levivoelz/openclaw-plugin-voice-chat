#!/usr/bin/env python3
"""
Parakeet MLX inference daemon.

Loads the model once (on the inference thread) at startup, then serves
transcription requests over a Unix domain socket at /tmp/openclaw-parakeet.sock.

MLX requires that all GPU/Metal operations run on the same OS thread that
created the MLX context. To satisfy this, the model is loaded and all
transcription work happens exclusively on the inference worker thread.

Request  (newline-terminated JSON):
  {"audio_pcm_b64": "<base64-encoded PCM16 mono>", "sample_rate": 16000}

Response (newline-terminated JSON):
  {"text": "transcribed text"}          — success
  {"error": "message"}                  — failure

Usage:
  python3 parakeet-daemon.py [--model mlx-community/parakeet-tdt-0.6b-v3] \
                              [--socket /tmp/openclaw-parakeet.sock]
"""

import argparse
import base64
import json
import logging
import os
import queue
import socket
import sys
import tempfile
import threading
import time
import traceback
import wave
from concurrent.futures import Future
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
# parakeet_mlx import helper
# ---------------------------------------------------------------------------
def _ensure_parakeet_on_path() -> None:
    """Add the uv tool's site-packages to sys.path if needed."""
    try:
        import parakeet_mlx  # noqa: F401
        return
    except ModuleNotFoundError:
        pass

    import shutil
    binary = shutil.which("parakeet-mlx")
    if binary:
        bin_dir = Path(binary).resolve().parent
        tool_dir = bin_dir.parent
        for sp in tool_dir.glob("lib/python*/site-packages"):
            if str(sp) not in sys.path:
                sys.path.insert(0, str(sp))
            break

    import parakeet_mlx  # noqa: F401 — re-import to verify


# ---------------------------------------------------------------------------
# Inference worker
# ---------------------------------------------------------------------------
class InferenceWorker(threading.Thread):
    """
    Owns the MLX model and all GPU work.

    The model is loaded inside run() so MLX's Metal context is created on
    this thread. All inference also happens here — MLX is not thread-safe
    across OS threads.
    """

    def __init__(self, model_id: str):
        super().__init__(daemon=True, name="inference-worker")
        self._model_id = model_id
        self._queue: queue.Queue = queue.Queue()
        self._ready = threading.Event()
        self._load_error: Exception | None = None

    def wait_until_ready(self, timeout: float = 300.0) -> None:
        """Block until the model is loaded (or raises if load failed)."""
        if not self._ready.wait(timeout):
            raise TimeoutError("Model failed to load within timeout.")
        if self._load_error is not None:
            raise self._load_error

    def submit(self, pcm_bytes: bytes, sample_rate: int) -> "Future[str]":
        """Submit a transcription job. Returns a Future for the result."""
        fut: Future = Future()
        self._queue.put((pcm_bytes, sample_rate, fut))
        return fut

    def run(self):
        # ── Load model on this thread ────────────────────────────────────
        try:
            _ensure_parakeet_on_path()
            import parakeet_mlx
            log.info("Loading model %s …", self._model_id)
            t_load_start = time.monotonic()
            self._model = parakeet_mlx.from_pretrained(self._model_id)
            load_ms = int((time.monotonic() - t_load_start) * 1000)
            log.info("model loaded model=%s load_ms=%d", self._model_id, load_ms)
        except Exception as exc:
            self._load_error = exc
            self._ready.set()
            log.error("Model load failed: %s", exc)
            return

        self._ready.set()

        # ── Inference loop ───────────────────────────────────────────────
        while True:
            pcm_bytes, sample_rate, fut = self._queue.get()
            try:
                result = self._transcribe(pcm_bytes, sample_rate)
                fut.set_result(result)
            except Exception as exc:
                fut.set_exception(exc)

    def _transcribe(self, pcm_bytes: bytes, sample_rate: int) -> dict:
        """Write a temp WAV, run model.transcribe(), return {text, confidence}.

        Confidence is the model's entropy-based certainty for the transcription
        (closer to 1.0 = more confident). For parakeet-tdt, real speech
        typically scores >0.9 while hallucinations on noise/silence score
        lower — the Node side uses this to drop hallucinated transcripts."""
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp_path = f.name
        try:
            with wave.open(tmp_path, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)  # 16-bit = 2 bytes
                wf.setframerate(sample_rate)
                wf.writeframes(pcm_bytes)
            result = self._model.transcribe(tmp_path)
            # Confidence is per-token; aggregate by averaging across sentences.
            # The parakeet-mlx AlignedResult exposes .sentences[].tokens[].confidence.
            confidence = _avg_confidence(result)
            return {"text": result.text.strip(), "confidence": confidence}
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _avg_confidence(result) -> float | None:
    """Mean per-token confidence across all sentences in an AlignedResult.
    Returns None if the result shape doesn't expose token-level confidence."""
    try:
        confs = []
        for sentence in getattr(result, "sentences", []) or []:
            for tok in getattr(sentence, "tokens", []) or []:
                c = getattr(tok, "confidence", None)
                if isinstance(c, (int, float)):
                    confs.append(float(c))
        if not confs:
            return None
        return sum(confs) / len(confs)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Connection handler
# ---------------------------------------------------------------------------
def handle_connection(conn: socket.socket, worker: InferenceWorker, addr: str):
    log.debug("client connected addr=%s", addr)
    try:
        buf = b""
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if line:
                    _handle_request(conn, worker, line)
    except (ConnectionResetError, BrokenPipeError):
        pass
    except Exception as exc:
        log.warning("Connection error addr=%s: %s", addr, exc)
    finally:
        try:
            conn.close()
        except OSError:
            pass
        log.debug("client disconnected addr=%s", addr)


def _handle_request(conn: socket.socket, worker: InferenceWorker, raw: bytes):
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as exc:
        _send_json(conn, {"error": f"invalid JSON: {exc}"})
        return

    audio_b64 = req.get("audio_pcm_b64")
    sample_rate = int(req.get("sample_rate", 16000))

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

    n_bytes = len(pcm_bytes)
    log.debug("req received bytes=%d sr=%d", n_bytes, sample_rate)
    t_req_start = time.monotonic()
    fut = worker.submit(pcm_bytes, sample_rate)
    try:
        result = fut.result(timeout=120)
        text = result["text"]
        confidence = result.get("confidence")
        infer_ms = int((time.monotonic() - t_req_start) * 1000)
        preview = text[:60].replace("\n", " ") if text else ""
        log.debug(
            'req done bytes=%d sr=%d infer_ms=%d text_chars=%d conf=%s text="%s"',
            n_bytes, sample_rate, infer_ms, len(text), confidence, preview,
        )
        _send_json(conn, {"text": text, "confidence": confidence})
    except TimeoutError:
        log.warning("req timeout bytes=%d sr=%d", n_bytes, sample_rate)
        _send_json(conn, {"error": "inference timeout"})
    except Exception as exc:
        tb_summary = traceback.format_exc().splitlines()[-1]
        log.warning("req error bytes=%d sr=%d err=%s tb=%s", n_bytes, sample_rate, exc, tb_summary)
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
    os.chmod(socket_path, 0o600)
    server.listen(16)
    log.info("Listening on %s", socket_path)

    try:
        while True:
            conn, addr = server.accept()
            addr_str = str(addr) if addr else "<unix>"
            t = threading.Thread(
                target=handle_connection, args=(conn, worker, addr_str), daemon=True
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
        "--model", default=DEFAULT_MODEL,
        help="HuggingFace model ID (default: %(default)s)",
    )
    parser.add_argument(
        "--socket", default=SOCKET_PATH,
        help="Unix socket path (default: %(default)s)",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="Enable debug logging",
    )
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    worker = InferenceWorker(args.model)
    worker.start()

    log.info("Waiting for model to load …")
    worker.wait_until_ready()  # blocks until ready or raises

    run_server(args.socket, worker)


if __name__ == "__main__":
    main()
