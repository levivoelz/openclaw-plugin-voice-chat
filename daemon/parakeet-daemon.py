#!/usr/bin/env python3
"""
Parakeet MLX inference daemon.

Loads the model once (on the inference thread) at startup, then serves
transcription requests over a Unix domain socket at /tmp/openclaw-parakeet.sock.

MLX requires that all GPU/Metal operations run on the same OS thread that
created the MLX context. To satisfy this, the model is loaded and all
transcription work happens exclusively on the inference worker thread.

Request  (newline-terminated JSON):
  One-shot (non-streaming):
    {"audio_pcm_b64": "<base64-encoded PCM16 mono>", "sample_rate": 16000}
    → {"text": "...", "confidence": 0.97}

  Streaming (per-connection state, one streaming context per socket):
    {"streaming": "start", "sample_rate": 24000}
      → {"streaming": "started"}
    {"streaming": "chunk", "audio_pcm_b64": "..."}
      → {"text": "...", "is_final": false, "confidence": null}
    {"streaming": "end"}
      → {"text": "...", "is_final": true, "confidence": 0.96}

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
        """Submit a one-shot transcription job. Returns a Future for the result."""
        fut: Future = Future()
        self._queue.put(("oneshot", (pcm_bytes, sample_rate), fut))
        return fut

    def submit_stream_start(self, sample_rate: int) -> "Future":
        """Allocate a streaming context bound to `sample_rate`. The returned
        Future resolves to an opaque stream handle (a dict the worker mutates)."""
        fut: Future = Future()
        self._queue.put(("stream_start", (sample_rate,), fut))
        return fut

    def submit_stream_chunk(self, handle: dict, pcm_bytes: bytes) -> "Future[dict]":
        """Feed a chunk of PCM16 mono audio to an open streaming context.
        Resolves to {"text": <latest partial>}."""
        fut: Future = Future()
        self._queue.put(("stream_chunk", (handle, pcm_bytes), fut))
        return fut

    def submit_stream_end(self, handle: dict) -> "Future[dict]":
        """Finalize and tear down a streaming context.
        Resolves to {"text": <final>, "confidence": <float|None>}."""
        fut: Future = Future()
        self._queue.put(("stream_end", (handle,), fut))
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

        # Import deps lazily on the worker thread.
        import numpy as np
        import mlx.core as mx
        try:
            import soxr  # high-quality streaming resampler
            self._soxr = soxr
        except ImportError:
            self._soxr = None
        self._np = np
        self._mx = mx
        self._model_sample_rate = int(self._model.preprocessor_config.sample_rate)

        # ── Inference loop ───────────────────────────────────────────────
        while True:
            op, args, fut = self._queue.get()
            try:
                if op == "oneshot":
                    pcm_bytes, sample_rate = args
                    fut.set_result(self._transcribe(pcm_bytes, sample_rate))
                elif op == "stream_start":
                    (sample_rate,) = args
                    fut.set_result(self._stream_start(sample_rate))
                elif op == "stream_chunk":
                    handle, pcm_bytes = args
                    fut.set_result(self._stream_chunk(handle, pcm_bytes))
                elif op == "stream_end":
                    (handle,) = args
                    fut.set_result(self._stream_end(handle))
                else:
                    fut.set_exception(ValueError(f"unknown op: {op}"))
            except Exception as exc:
                fut.set_exception(exc)

    # ── Streaming helpers (worker thread) ────────────────────────────────
    def _stream_start(self, sample_rate: int) -> dict:
        """Open a StreamingParakeet context and stash it in an opaque handle."""
        ctx = self._model.transcribe_stream()
        # Manually enter the context manager (we hold the state across queue ops).
        ctx.__enter__()
        handle = {
            "ctx": ctx,
            "in_sr": int(sample_rate),
            "model_sr": self._model_sample_rate,
            "resampler": None,
            "_resample_ratio": (
                self._model_sample_rate / float(sample_rate) if sample_rate else 1.0
            ),
            "last_text": "",
        }
        # Allocate a streaming resampler if we need one and soxr is available.
        if handle["in_sr"] != handle["model_sr"]:
            if self._soxr is None:
                ctx.__exit__(None, None, None)
                raise RuntimeError(
                    f"streaming needs sample_rate={handle['model_sr']} or soxr installed"
                )
            handle["resampler"] = self._soxr.ResampleStream(
                handle["in_sr"], handle["model_sr"], 1, dtype="float32"
            )
        return handle

    def _stream_chunk(self, handle: dict, pcm_bytes: bytes) -> dict:
        """Feed PCM16 mono bytes; return the latest partial transcript."""
        np = self._np
        mx = self._mx
        if len(pcm_bytes) < 2:
            return {"text": handle["last_text"], "is_final": False}
        # PCM16 little-endian → float32 in [-1, 1].
        audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        if handle["resampler"] is not None:
            audio = handle["resampler"].resample_chunk(audio)
        if audio.size == 0:
            return {"text": handle["last_text"], "is_final": False}
        handle["ctx"].add_audio(mx.array(audio))
        text = (handle["ctx"].result.text or "").strip()
        handle["last_text"] = text
        return {"text": text, "is_final": False}

    def _stream_end(self, handle: dict) -> dict:
        """Flush the resampler, drain final tokens, tear down the context."""
        np = self._np
        mx = self._mx
        try:
            if handle["resampler"] is not None:
                # Flush trailing samples out of the resampler.
                tail = handle["resampler"].resample_chunk(
                    np.zeros(0, dtype=np.float32), last=True
                )
                if tail.size > 0:
                    handle["ctx"].add_audio(mx.array(tail))
            result = handle["ctx"].result
            text = (result.text or "").strip()
            confidence = _avg_confidence(result)
            return {"text": text, "is_final": True, "confidence": confidence}
        finally:
            try:
                handle["ctx"].__exit__(None, None, None)
            except Exception:
                pass
            handle["ctx"] = None
            handle["resampler"] = None

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
    # Per-connection streaming state: at most one open StreamingParakeet handle.
    state = {"stream_handle": None}
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
                    _handle_request(conn, worker, line, state)
    except (ConnectionResetError, BrokenPipeError):
        pass
    except Exception as exc:
        log.warning("Connection error addr=%s: %s", addr, exc)
    finally:
        # Free any dangling streaming context (client disconnected mid-utterance).
        if state["stream_handle"] is not None:
            try:
                worker.submit_stream_end(state["stream_handle"]).result(timeout=10)
            except Exception:
                pass
            state["stream_handle"] = None
        try:
            conn.close()
        except OSError:
            pass
        log.debug("client disconnected addr=%s", addr)


def _handle_request(conn: socket.socket, worker: InferenceWorker, raw: bytes, state: dict):
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as exc:
        _send_json(conn, {"error": f"invalid JSON: {exc}"})
        return

    # ── Streaming protocol ─────────────────────────────────────────────────
    streaming_op = req.get("streaming")
    if streaming_op is not None:
        _handle_streaming(conn, worker, req, state, streaming_op)
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


def _handle_streaming(
    conn: socket.socket,
    worker: InferenceWorker,
    req: dict,
    state: dict,
    op: str,
):
    if op == "start":
        if state["stream_handle"] is not None:
            _send_json(conn, {"error": "stream already started on this connection"})
            return
        sample_rate = int(req.get("sample_rate", 16000))
        try:
            handle = worker.submit_stream_start(sample_rate).result(timeout=30)
            state["stream_handle"] = handle
            _send_json(conn, {"streaming": "started"})
        except Exception as exc:
            _send_json(conn, {"error": f"stream start failed: {exc}"})
        return

    if op == "chunk":
        handle = state["stream_handle"]
        if handle is None:
            _send_json(conn, {"error": "no active stream; send streaming=start first"})
            return
        audio_b64 = req.get("audio_pcm_b64")
        if not audio_b64:
            _send_json(conn, {"error": "missing audio_pcm_b64"})
            return
        try:
            pcm_bytes = base64.b64decode(audio_b64)
        except Exception as exc:
            _send_json(conn, {"error": f"base64 decode failed: {exc}"})
            return
        try:
            result = worker.submit_stream_chunk(handle, pcm_bytes).result(timeout=60)
            _send_json(conn, {
                "text": result["text"],
                "is_final": False,
                "confidence": None,
            })
        except Exception as exc:
            _send_json(conn, {"error": f"stream chunk failed: {exc}"})
        return

    if op == "end":
        handle = state["stream_handle"]
        if handle is None:
            _send_json(conn, {"error": "no active stream"})
            return
        state["stream_handle"] = None
        try:
            result = worker.submit_stream_end(handle).result(timeout=60)
            _send_json(conn, {
                "text": result["text"],
                "is_final": True,
                "confidence": result.get("confidence"),
            })
        except Exception as exc:
            _send_json(conn, {"error": f"stream end failed: {exc}"})
        return

    _send_json(conn, {"error": f"unknown streaming op: {op}"})


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
