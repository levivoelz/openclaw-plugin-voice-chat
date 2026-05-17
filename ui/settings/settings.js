/**
 * Voice Chat settings — ES module, no build step, no dependencies.
 *
 * Data flow:
 *   1. On load, fetch /plugins/voice-chat/registry for provider lists.
 *      If 404, fall back to contract IDs from openclaw.plugin.json (hardcoded below).
 *   2. Populate dropdowns, key fields, agent table from /plugins/voice-chat/config (GET).
 *   3. Save sends POST /plugins/voice-chat/config; if 404 shows a manual-edit hint.
 */

// ---------------------------------------------------------------------------
// Fallback provider data (matches openclaw.plugin.json contracts)
// ---------------------------------------------------------------------------
const FALLBACK_STT = [
  { id: "voice-chat/openai-realtime", label: "OpenAI Realtime", models: ["gpt-4o-realtime-preview"] },
  { id: "voice-chat/openai-whisper",  label: "OpenAI Whisper",  models: ["whisper-1"] },
];
const FALLBACK_TTS = [
  { id: "voice-chat/openai",     label: "OpenAI TTS",   models: ["tts-1", "tts-1-hd"], voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] },
  { id: "voice-chat/elevenlabs", label: "ElevenLabs",   models: ["eleven_monolingual_v1", "eleven_multilingual_v2"], voices: [] },
  { id: "voice-chat/macos-say",  label: "macOS Say",    models: ["default"], voices: ["Alex", "Samantha", "Tom"] },
];

const PROVIDER_KEYS = [
  { key: "openai.apiKey",     label: "OpenAI API key",     placeholder: "sk-..." },
  { key: "elevenlabs.apiKey", label: "ElevenLabs API key", placeholder: "sk_..." },
];

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function setOptions(selectEl, options, currentValue) {
  selectEl.innerHTML = "";
  for (const opt of options) {
    const el = document.createElement("option");
    el.value = opt.value ?? opt.id ?? opt;
    el.textContent = opt.label ?? opt.value ?? opt.id ?? opt;
    if (el.value === currentValue) el.selected = true;
    selectEl.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// Registry fetch with fallback
// ---------------------------------------------------------------------------
async function fetchRegistry() {
  try {
    const res = await fetch("/plugins/voice-chat/registry");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return { stt: FALLBACK_STT, tts: FALLBACK_TTS };
  }
}

// ---------------------------------------------------------------------------
// Config fetch (GET) and save (POST)
// ---------------------------------------------------------------------------
async function fetchConfig() {
  try {
    const res = await fetch("/plugins/voice-chat/config");
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

async function saveConfig(payload) {
  try {
    const res = await fetch("/plugins/voice-chat/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true };
  } catch (err) {
    if (err.message.includes("404") || err.message.includes("Failed to fetch")) {
      return { ok: false, hint: "Config API not available. Edit openclaw.json manually." };
    }
    return { ok: false, hint: err.message };
  }
}

// ---------------------------------------------------------------------------
// Per-agent override table
// ---------------------------------------------------------------------------
let sttProviders = [];
let ttsProviders = [];

function renderAgentRow(tbody, entry = { agentId: "", sttProvider: "", ttsProvider: "" }) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input type="text" class="agent-id" value="${esc(entry.agentId)}" placeholder="agent-id" /></td>
    <td>
      <select class="agent-stt">
        <option value="">(inherit)</option>
        ${sttProviders.map((p) => `<option value="${esc(p.id)}"${p.id === entry.sttProvider ? " selected" : ""}>${esc(p.label)}</option>`).join("")}
      </select>
    </td>
    <td>
      <select class="agent-tts">
        <option value="">(inherit)</option>
        ${ttsProviders.map((p) => `<option value="${esc(p.id)}"${p.id === entry.ttsProvider ? " selected" : ""}>${esc(p.label)}</option>`).join("")}
      </select>
    </td>
    <td><button class="btn btn--danger remove-row-btn">Remove</button></td>
  `;
  tr.querySelector(".remove-row-btn").addEventListener("click", () => tr.remove());
  tbody.appendChild(tr);
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Provider key fields
// ---------------------------------------------------------------------------
function renderKeyFields(config) {
  const container = $("key-fields");
  container.innerHTML = "";
  for (const { key, label, placeholder } of PROVIDER_KEYS) {
    const [section, field] = key.split(".");
    const current = config?.[section]?.[field] ?? "";

    const row = document.createElement("div");
    row.className = "key-field-row";
    row.innerHTML = `
      <label>${esc(label)}</label>
      <input type="password" data-key="${esc(key)}" value="${esc(current)}" placeholder="${esc(placeholder)}" autocomplete="off" />
      <button class="btn show-key-btn" type="button">Show</button>
      <button class="btn btn--primary edit-key-btn" type="button">Edit</button>
    `;
    const input = row.querySelector("input");
    row.querySelector(".show-key-btn").addEventListener("click", (ev) => {
      const btn = ev.currentTarget;
      input.type = input.type === "password" ? "text" : "password";
      btn.textContent = input.type === "password" ? "Show" : "Hide";
    });
    // Edit makes field editable
    row.querySelector(".edit-key-btn").addEventListener("click", () => {
      input.readOnly = false;
      input.type = "text";
      input.focus();
    });
    input.readOnly = current.length > 0;
    container.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Phone access / tunnel detection
// ---------------------------------------------------------------------------
function detectTunnel() {
  const host = location.host;
  const badge = $("tunnel-status");

  if (/\.ts\.net(:\d+)?$/.test(host)) {
    badge.textContent = "Tailscale - phone access ready";
    badge.className = "tunnel-badge tunnel-badge--ok";
  } else if (/\.trycloudflare\.com(:\d+)?$/.test(host) || /\.cloudflare(tunnel)?\.com(:\d+)?$/.test(host)) {
    badge.textContent = "Cloudflare Tunnel - phone access ready";
    badge.className = "tunnel-badge tunnel-badge--ok";
  } else if (/^(localhost|127\.|0\.0\.0\.0|::1|.*\.local)(:\d+)?$/.test(host)) {
    badge.innerHTML = 'Local — phone access requires a tunnel. <a href="https://tailscale.com/kb/1223/funnel" target="_blank">Tailscale Funnel</a> or <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/" target="_blank">Cloudflare Tunnel</a>.';
    badge.className = "tunnel-badge tunnel-badge--warn";
  } else {
    badge.textContent = `Public host: ${host}`;
    badge.className = "tunnel-badge tunnel-badge--ok";
  }
}

function renderPhoneAccess() {
  detectTunnel();
  const panelUrl = `${location.protocol}//${location.host}${location.pathname.replace(/\/settings\/?$/, "/panel/")}`;
  const urlInput = $("phone-url");
  urlInput.value = panelUrl;

  $("copy-url-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(panelUrl).catch(() => {});
  });

  // QR code via external image service (no JS library needed)
  const qrWrap = $("qr-wrap");
  const encoded = encodeURIComponent(panelUrl);
  const img = document.createElement("img");
  img.src = `https://api.qrserver.com/v1/create-qr-code/?data=${encoded}&size=160x160&margin=2`;
  img.alt = "QR code for panel URL";
  img.width = 160;
  img.height = 160;
  qrWrap.appendChild(img);
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
async function runDiagnostics() {
  const out = $("diag-output");
  const log = (line) => { out.textContent += line + "\n"; };

  out.textContent = "";
  log("Starting diagnostics...\n");

  // 1. Registry
  log("1. Fetching /plugins/voice-chat/registry...");
  try {
    const res = await fetch("/plugins/voice-chat/registry");
    log(`   HTTP ${res.status} ${res.statusText}`);
    if (res.ok) {
      const data = await res.json();
      log(`   STT providers: ${data.stt?.map((p) => p.id).join(", ") || "(none)"}`);
      log(`   TTS providers: ${data.tts?.map((p) => p.id).join(", ") || "(none)"}`);
    }
  } catch (e) { log(`   Error: ${e.message}`); }

  // 2. Config
  log("\n2. Fetching /plugins/voice-chat/config...");
  try {
    const res = await fetch("/plugins/voice-chat/config");
    log(`   HTTP ${res.status} ${res.statusText}`);
  } catch (e) { log(`   Error: ${e.message}`); }

  // 3. WS handshake
  log("\n3. WebSocket handshake...");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${proto}://${location.host}/plugins/voice-chat/ws`;
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => { ws.close(); reject(new Error("timeout")); }, 5000);
      ws.addEventListener("open", () => {
        const clientId = `diag-${Math.random().toString(36).slice(2)}`;
        ws.send(JSON.stringify({ type: "hello", clientId, protocol: 1, mode: "ptt", codec: "pcm16", sampleRate: 16000 }));
      });
      ws.addEventListener("message", (ev) => {
        try {
          const frame = JSON.parse(ev.data);
          if (frame.type === "ready") {
            log(`   Connected. Session key: ${frame.sessionKey}`);
            log(`   STT: ${frame.sttProvider}, TTS: ${frame.ttsProvider} (${frame.ttsFormat})`);
            clearTimeout(timer);
            ws.close(1000);
            resolve();
          } else if (frame.type === "error") {
            clearTimeout(timer);
            ws.close();
            reject(new Error(`${frame.code}: ${frame.message}`));
          }
        } catch { /* ignore */ }
      });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS error")); });
      ws.addEventListener("close", (ev) => {
        if (ev.code !== 1000) { clearTimeout(timer); reject(new Error(`closed ${ev.code}`)); }
      });
    });
    log("   Handshake OK");
  } catch (e) { log(`   Error: ${e.message}`); }

  // 4. Mic permission
  log("\n4. Microphone permission...");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    log("   Granted");
  } catch (e) { log(`   Denied or unavailable: ${e.message}`); }

  log("\nDone.");
}

// ---------------------------------------------------------------------------
// Collect form values → config payload
// ---------------------------------------------------------------------------
function collectPayload(agentTbody) {
  const modeVal = document.querySelector('input[name="capture-mode"]:checked')?.value ?? "ptt";

  const perAgent = {};
  for (const tr of agentTbody.querySelectorAll("tr")) {
    const id = tr.querySelector(".agent-id")?.value?.trim();
    const stt = tr.querySelector(".agent-stt")?.value?.trim();
    const tts = tr.querySelector(".agent-tts")?.value?.trim();
    if (!id) continue;
    perAgent[id] = {};
    if (stt) perAgent[id].stt = { provider: stt };
    if (tts) perAgent[id].tts = { provider: tts };
  }

  const payload = {
    stt: { provider: $("stt-provider").value, model: $("stt-model").value },
    tts: { provider: $("tts-provider").value, model: $("tts-model").value, voice: $("tts-voice").value },
    mode: modeVal,
    interrupt: $("interrupt-toggle").checked,
    perAgent,
  };

  const lang = $("stt-lang").value.trim();
  if (lang) payload.stt.language = lang;

  // Key fields
  for (const input of $("key-fields").querySelectorAll("input[data-key]")) {
    if (input.readOnly) continue;  // not edited
    const val = input.value.trim();
    if (!val) continue;
    const [section, field] = input.dataset.key.split(".");
    if (!payload[section]) payload[section] = {};
    payload[section][field] = val;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const [registry, config] = await Promise.all([fetchRegistry(), fetchConfig()]);

sttProviders = registry.stt ?? FALLBACK_STT;
ttsProviders = registry.tts ?? FALLBACK_TTS;

// STT section
setOptions($("stt-provider"), sttProviders, config?.stt?.provider ?? "voice-chat/openai-whisper");
// Populate STT models on provider change
function updateSttModels() {
  const p = sttProviders.find((p) => p.id === $("stt-provider").value) ?? sttProviders[0];
  setOptions($("stt-model"), (p?.models ?? []).map((m) => ({ id: m, label: m })), config?.stt?.model);
}
$("stt-provider").addEventListener("change", updateSttModels);
updateSttModels();
$("stt-lang").value = config?.stt?.language ?? "";

// TTS section
setOptions($("tts-provider"), ttsProviders, config?.tts?.provider ?? "voice-chat/openai");
function updateTtsModels() {
  const p = ttsProviders.find((p) => p.id === $("tts-provider").value) ?? ttsProviders[0];
  setOptions($("tts-model"), (p?.models ?? []).map((m) => ({ id: m, label: m })), config?.tts?.model);
  setOptions($("tts-voice"), (p?.voices ?? []).map((v) => ({ id: v.id ?? v, label: v.label ?? v })), config?.tts?.voice);
}
$("tts-provider").addEventListener("change", updateTtsModels);
updateTtsModels();

// Mode
const modeVal = config?.mode ?? "ptt";
const modeInput = document.querySelector(`input[name="capture-mode"][value="${modeVal}"]`);
if (modeInput) modeInput.checked = true;
$("interrupt-toggle").checked = config?.interrupt !== false;

// Per-agent table
const tbody = $("agent-tbody");
const perAgent = config?.perAgent ?? {};
for (const [agentId, overrides] of Object.entries(perAgent)) {
  renderAgentRow(tbody, {
    agentId,
    sttProvider: overrides.stt?.provider ?? "",
    ttsProvider: overrides.tts?.provider ?? "",
  });
}
$("add-agent-btn").addEventListener("click", () => renderAgentRow(tbody));

// Provider keys
renderKeyFields(config);

// Phone access
renderPhoneAccess();

// Test mic button
$("test-mic-btn").addEventListener("click", async () => {
  const result = $("test-mic-result");
  result.textContent = "Testing…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    result.textContent = "Mic accessible.";
  } catch (e) {
    result.textContent = `Error: ${e.message}`;
  }
});

// Preview TTS — opens a test WS connection, sends a short text, plays response
$("preview-tts-btn").addEventListener("click", async () => {
  const result = $("preview-tts-result");
  result.textContent = "Previewing…";
  try {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${proto}://${location.host}/plugins/voice-chat/ws`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        type: "hello",
        clientId: `preview-${Math.random().toString(36).slice(2)}`,
        protocol: 1,
        mode: "ptt",
        codec: "pcm16",
        sampleRate: 16000,
        ttsHints: {
          provider: $("tts-provider").value || undefined,
          model:    $("tts-model").value || undefined,
          voice:    $("tts-voice").value || undefined,
        },
      }));
    });
    let ttsFormat = "mp3";
    let awaitingBinary = false;
    const audioCtx = new (window.AudioContext ?? window.webkitAudioContext)();
    let playhead = audioCtx.currentTime;

    ws.addEventListener("message", (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        if (awaitingBinary && ttsFormat === "pcm16") {
          awaitingBinary = false;
          const samples = new Int16Array(ev.data);
          const floats = new Float32Array(samples.length);
          for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768;
          const buf = audioCtx.createBuffer(1, floats.length, 16000);
          buf.copyToChannel(floats, 0);
          const src = audioCtx.createBufferSource();
          src.buffer = buf;
          src.connect(audioCtx.destination);
          if (playhead < audioCtx.currentTime) playhead = audioCtx.currentTime;
          src.start(playhead);
          playhead += buf.duration;
        }
        return;
      }
      try {
        const frame = JSON.parse(ev.data);
        if (frame.type === "ready") {
          ttsFormat = frame.ttsFormat ?? "mp3";
          ws.send(JSON.stringify({ type: "text", content: "Hello, this is a voice preview." }));
          result.textContent = "Playing…";
        } else if (frame.type === "tts.chunk") {
          awaitingBinary = true;
        } else if (frame.type === "tts.done") {
          result.textContent = "Done.";
          setTimeout(() => ws.close(1000), 500);
        } else if (frame.type === "error") {
          result.textContent = `Error: ${frame.message}`;
          ws.close();
        }
      } catch { /* ignore */ }
    });
    ws.addEventListener("close", () => {
      setTimeout(() => audioCtx.close(), 2000);
    });
  } catch (e) {
    $("preview-tts-result").textContent = `Error: ${e.message}`;
  }
});

// Diagnostics
$("run-diag-btn").addEventListener("click", runDiagnostics);

// Save
$("save-btn").addEventListener("click", async () => {
  const payload = collectPayload(tbody);
  const { ok, hint } = await saveConfig(payload);
  if (ok) {
    const btn = $("save-btn");
    btn.textContent = "Saved";
    setTimeout(() => { btn.textContent = "Save"; }, 2000);
  } else {
    alert(hint ?? "Save failed.");
  }
});
