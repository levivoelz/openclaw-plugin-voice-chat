/**
 * Voice Chat panel — ES module, no build step, no dependencies.
 *
 * Mount contract: the gateway (or descriptor host) may set window.openclawPanel
 * before the script loads:
 *   { gatewayUrl: string, session: string, agent: string }
 * Absent that, we fall back to query-string params and window.location.host.
 */

// ---------------------------------------------------------------------------
// AudioWorklet processor source — inlined as a blob URL so there is no
// second .js file to serve. The worklet runs in its own AudioWorkletGlobalScope
// so it cannot share anything with the main thread (no closures).
// ---------------------------------------------------------------------------
const WORKLET_SRC = /* js */`
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    // Convert Float32 samples to Int16 PCM in-place and post the result.
    const pcm = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      pcm[i] = s < 0 ? s * 32768 : s * 32767;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------
function resolveConfig() {
  const w = window.openclawPanel ?? {};
  const q = new URLSearchParams(location.search);
  const host = w.gatewayUrl
    ? new URL(w.gatewayUrl).host
    : location.host;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const wsBase = w.gatewayUrl
    ? w.gatewayUrl.replace(/^https?/, proto)
    : `${proto}://${host}`;
  return {
    wsUrl: `${wsBase}/plugins/voice-chat/ws`,
    session: w.session ?? q.get("session") ?? undefined,
    agent:   w.agent   ?? q.get("agent")   ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const dot        = $("status-dot");
const statusLbl  = $("status-label");
const meterBar   = $("meter-bar");
const transcript = $("transcript-area");
const partialEl  = $("partial-line");
const responseEl = $("response-text");
const micBtn     = $("mic-btn");
const interruptBtn = $("interrupt-btn");
const settingsBtn  = $("settings-btn");
const modeInputs   = document.querySelectorAll('input[name="mode"]');

// Error toast — created once
const errorToast = document.createElement("div");
errorToast.id = "error-toast";
document.getElementById("root").appendChild(errorToast);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ws = null;
let audioCtx = null;
let workletNode = null;
let scriptNode = null;  // ScriptProcessorNode fallback
let mediaStream = null;
let analyser = null;
let animFrame = null;
let isRecording = false;
let mode = "ptt";  // "ptt" | "vad"
let currentTurnId = null;
let currentResponseText = "";
let ttsFormat = "mp3";

// PCM playback state (used when ttsFormat is "pcm16")
const pcmQueue = [];
let pcmPlayhead = 0;
let pcmScheduled = false;

// MediaSource playback state (mp3 / opus)
let audioEl = null;
let mediaSource = null;
let sourceBuffer = null;
let msQueue = [];   // pending ArrayBuffers waiting for SourceBuffer to become ready
let msOpen = false;

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------
function setStatus(state, label) {
  dot.className = `dot dot--${state}`;
  dot.title = label;
  statusLbl.textContent = label;
}

function showError(msg, durationMs = 4000) {
  errorToast.textContent = msg;
  errorToast.classList.add("visible");
  setTimeout(() => errorToast.classList.remove("visible"), durationMs);
}

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------
function connect() {
  const cfg = resolveConfig();
  const url = new URL(cfg.wsUrl);
  if (cfg.session) url.searchParams.set("session", cfg.session);
  if (cfg.agent)   url.searchParams.set("agent",   cfg.agent);

  setStatus("conn", "Connecting…");
  ws = new WebSocket(url.toString());
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    const clientId = `panel-${Math.random().toString(36).slice(2)}`;
    send({ type: "hello", clientId, protocol: 1, mode, codec: "pcm16", sampleRate: 16000 });
  });

  ws.addEventListener("message", handleMessage);

  ws.addEventListener("close", (ev) => {
    setStatus("idle", "Disconnected");
    interruptBtn.disabled = true;
    if (ev.code !== 1000) {
      showError(`Connection closed (${ev.code})`);
      // Reconnect after 3 s if not intentional
      setTimeout(connect, 3000);
    }
  });

  ws.addEventListener("error", () => {
    setStatus("error", "Connection error");
  });
}

function send(frame) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
  }
}

// ---------------------------------------------------------------------------
// Binary audio frames: the server sends tts.chunk JSON first, then immediately
// sends the raw audio bytes as a binary frame. We track whether we are waiting
// for the binary follow-up with `awaitingBinary`.
// ---------------------------------------------------------------------------
let awaitingBinary = false;
let pendingChunkFormat = "mp3";

function handleMessage(ev) {
  if (ev.data instanceof ArrayBuffer) {
    // Binary frame = audio data following a tts.chunk JSON frame
    if (awaitingBinary) {
      awaitingBinary = false;
      handleAudioChunk(ev.data, pendingChunkFormat);
    }
    return;
  }

  let frame;
  try { frame = JSON.parse(ev.data); } catch { return; }

  switch (frame.type) {
    case "ready":
      setStatus("conn", "Ready");
      ttsFormat = frame.ttsFormat ?? "mp3";
      interruptBtn.disabled = false;
      initAudioOut();
      break;

    case "transcript.partial":
      partialEl.textContent = frame.text;
      break;

    case "transcript.final": {
      partialEl.textContent = "";
      const p = document.createElement("p");
      p.className = "transcript-final";
      p.textContent = frame.text;
      transcript.insertBefore(p, partialEl);
      transcript.scrollTop = transcript.scrollHeight;
      break;
    }

    case "agent.delta":
      if (frame.turnId !== currentTurnId) {
        currentTurnId = frame.turnId;
        currentResponseText = "";
      }
      currentResponseText += frame.text;
      responseEl.textContent = currentResponseText;
      $("response-area").scrollTop = $("response-area").scrollHeight;
      setStatus("speak", "Speaking…");
      break;

    case "agent.done":
      setStatus("conn", "Ready");
      break;

    case "tts.chunk":
      awaitingBinary = true;
      pendingChunkFormat = frame.format ?? ttsFormat;
      break;

    case "tts.done":
      // For pcm16, flush any remaining scheduled audio
      break;

    case "error":
      showError(`${frame.code}: ${frame.message}`);
      if (!frame.recoverable) setStatus("error", "Error");
      break;

    case "pong":
      break;
  }
}

// ---------------------------------------------------------------------------
// Audio output
// ---------------------------------------------------------------------------
function initAudioOut() {
  if (ttsFormat === "pcm16") {
    // PCM path: decode and schedule via AudioContext
    ensureAudioCtx();
  } else {
    // mp3/opus path: MediaSource + <audio>
    initMediaSource();
  }
}

function initMediaSource() {
  if (audioEl) return;
  audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  audioEl.style.display = "none";
  document.body.appendChild(audioEl);

  mediaSource = new MediaSource();
  audioEl.src = URL.createObjectURL(mediaSource);

  mediaSource.addEventListener("sourceopen", () => {
    msOpen = true;
    const mime = ttsFormat === "opus"
      ? 'audio/webm; codecs="opus"'
      : 'audio/mpeg';
    try {
      sourceBuffer = mediaSource.addSourceBuffer(mime);
    } catch {
      // Some browsers only support audio/mpeg without the codec param
      try { sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg"); } catch { return; }
    }
    sourceBuffer.mode = "sequence";
    sourceBuffer.addEventListener("updateend", drainMsQueue);
    drainMsQueue();
  });
}

function drainMsQueue() {
  if (!sourceBuffer || sourceBuffer.updating || msQueue.length === 0) return;
  const buf = msQueue.shift();
  try { sourceBuffer.appendBuffer(buf); } catch { /* stale context, ignore */ }
}

function handleAudioChunk(buf, format) {
  if (format === "pcm16") {
    schedulePcm(buf);
  } else {
    // mp3 or opus via MediaSource
    if (!msOpen) { msQueue.push(buf); return; }
    msQueue.push(buf);
    drainMsQueue();
  }
}

// PCM16 playback: decode Int16 samples → Float32 AudioBuffer → schedule
function schedulePcm(buf) {
  ensureAudioCtx();
  const samples = new Int16Array(buf);
  const floats = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    floats[i] = samples[i] / 32768;
  }
  const abuf = audioCtx.createBuffer(1, floats.length, 16000);
  abuf.copyToChannel(floats, 0);
  const src = audioCtx.createBufferSource();
  src.buffer = abuf;
  src.connect(audioCtx.destination);

  const now = audioCtx.currentTime;
  if (pcmPlayhead < now) pcmPlayhead = now;
  src.start(pcmPlayhead);
  pcmPlayhead += abuf.duration;
}

function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext ?? window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
}

// ---------------------------------------------------------------------------
// Microphone capture
// ---------------------------------------------------------------------------
async function startCapture() {
  if (isRecording) return;
  try {
    ensureAudioCtx();
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    const source = audioCtx.createMediaStreamSource(mediaStream);

    // Analyser for the level meter
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    if (audioCtx.audioWorklet) {
      await setupWorklet(source);
    } else {
      setupScriptProcessor(source);
    }

    isRecording = true;
    send({ type: "speech.start" });
    setStatus("listen", "Listening…");
    micBtn.setAttribute("aria-pressed", "true");
    micBtn.classList.add("active");
    startMeterLoop();
  } catch (err) {
    showError(`Mic error: ${err.message}`);
  }
}

async function setupWorklet(source) {
  const blob = new Blob([WORKLET_SRC], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  await audioCtx.audioWorklet.addModule(blobUrl);
  URL.revokeObjectURL(blobUrl);

  workletNode = new AudioWorkletNode(audioCtx, "pcm-capture");
  workletNode.port.onmessage = (ev) => {
    if (isRecording && ws?.readyState === WebSocket.OPEN) {
      ws.send(ev.data);
    }
  };
  source.connect(workletNode);
  // No destination connection needed — we only want the side-effect (posting messages).
}

function setupScriptProcessor(source) {
  // ScriptProcessorNode is deprecated but required on some older WebKit builds.
  // bufferSize 4096 → 256 ms latency at 16 kHz; acceptable for voice.
  scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
  scriptNode.onaudioprocess = (ev) => {
    if (!isRecording || ws?.readyState !== WebSocket.OPEN) return;
    const input = ev.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? s * 32768 : s * 32767;
    }
    ws.send(pcm.buffer);
  };
  source.connect(scriptNode);
  scriptNode.connect(audioCtx.destination);
}

function stopCapture() {
  if (!isRecording) return;
  isRecording = false;

  send({ type: "speech.end" });

  // Tear down nodes but keep the AudioContext — we need it for playback.
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (scriptNode)  { scriptNode.disconnect();  scriptNode  = null; }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  analyser = null;

  stopMeterLoop();
  micBtn.setAttribute("aria-pressed", "false");
  micBtn.classList.remove("active");
  setStatus("conn", "Processing…");
}

// ---------------------------------------------------------------------------
// Level meter
// ---------------------------------------------------------------------------
const levelData = new Uint8Array(64);

function startMeterLoop() {
  if (animFrame) return;
  function tick() {
    if (!analyser) { stopMeterLoop(); return; }
    analyser.getByteFrequencyData(levelData);
    let sum = 0;
    for (let i = 0; i < levelData.length; i++) sum += levelData[i];
    const avg = sum / levelData.length;
    meterBar.style.width = `${Math.min(100, (avg / 128) * 100)}%`;
    animFrame = requestAnimationFrame(tick);
  }
  animFrame = requestAnimationFrame(tick);
}

function stopMeterLoop() {
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  meterBar.style.width = "0%";
}

// ---------------------------------------------------------------------------
// PTT / VAD mode handlers
// ---------------------------------------------------------------------------
micBtn.addEventListener("pointerdown", (ev) => {
  ev.preventDefault();  // prevent mobile long-press menu
  if (mode === "ptt") startCapture();
});
micBtn.addEventListener("pointerup",     () => { if (mode === "ptt") stopCapture(); });
micBtn.addEventListener("pointercancel", () => { if (mode === "ptt") stopCapture(); });

micBtn.addEventListener("click", () => {
  if (mode === "vad") {
    isRecording ? stopCapture() : startCapture();
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.code === "Space" && !ev.repeat && document.activeElement.tagName !== "INPUT") {
    ev.preventDefault();
    if (mode === "ptt" && !isRecording) startCapture();
  }
  if (ev.code === "Escape") {
    interrupt();
  }
});

document.addEventListener("keyup", (ev) => {
  if (ev.code === "Space" && mode === "ptt" && isRecording) {
    stopCapture();
  }
});

modeInputs.forEach((input) => {
  input.addEventListener("change", () => {
    mode = input.value;
    // If switching away from VAD while recording, stop.
    if (isRecording && mode === "ptt") stopCapture();
  });
});

// ---------------------------------------------------------------------------
// Interrupt
// ---------------------------------------------------------------------------
function interrupt() {
  send({ type: "interrupt" });
  // Reset PCM playhead so queued audio does not play after interrupt
  pcmPlayhead = audioCtx?.currentTime ?? 0;
  msQueue.length = 0;
  currentResponseText = "";
  responseEl.textContent = "";
}

interruptBtn.addEventListener("click", interrupt);

// ---------------------------------------------------------------------------
// Settings shortcut
// ---------------------------------------------------------------------------
settingsBtn.addEventListener("click", () => {
  const base = location.href.replace(/\/panel\/?.*$/, "/settings/");
  window.open(base, "voice-chat-settings", "width=640,height=720");
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
connect();
