// Nimbus voice agent - full turn-based voice loop.
// mic -> VAD endpointing -> ASR -> LLM (+ client-executed tools) -> TTS ->
// buffered playback, with barge-in and a combined per-stage latency pie.
// Talks to our backend's /api/asr, /api/llm(/stream), /api/tts.

import { dispatch } from "../assets/playground/tools.js";

const LS_KEYS = "nimbus_pg_keys";
const LS_BASE = "nimbus_pg_base";
// window.NIMBUS_API_BASE is set by runtime-config.js; ignore the un-edited placeholder.
const RUNTIME_BASE = window.NIMBUS_API_BASE && !window.NIMBUS_API_BASE.includes("REPLACE-ME") ? window.NIMBUS_API_BASE : "";
const BASE = localStorage.getItem(LS_BASE) || RUNTIME_BASE || "http://localhost:8000";
const $ = (id) => document.getElementById(id);

const MODELS = [
  { key: "openai:gpt-4o-mini", label: "OpenAI GPT-4o mini", provider: "openai" },
  { key: "openai:gpt-4o", label: "OpenAI GPT-4o", provider: "openai" },
  { key: "gemini:gemini-2.0-flash", label: "Gemini 2.0 Flash", provider: "gemini" },
  { key: "gemini:gemini-1.5-pro", label: "Gemini 1.5 Pro", provider: "gemini" },
  { key: "anthropic:claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku", provider: "anthropic" },
  { key: "anthropic:claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet", provider: "anthropic" },
];
const ASR_PROVIDERS = ["browser", "openai", "gemini", "elevenlabs"];
const TTS_VOICES = {
  openai: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
  gemini: ["Aoede", "Puck", "Charon", "Kore", "Fenrir"],
  elevenlabs: ["EXAVITQu4vr4xnSDxMaL"],
};

const PIE = {
  asr_ms: ["ASR", "#3fb0c9"], rag_ms: ["RAG", "#9d7bff"], llm_ms: ["LLM", "#6e8bff"],
  tool_ms: ["Tools", "#2ea043"], tts_ms: ["TTS", "#d29922"], buffer_ms: ["Buffer", "#e06aa8"],
  other_ms: ["Other/net", "#8b93a7"],
};

const state = {
  messages: [],
  on: false, phase: "idle",     // idle|listening|recording|thinking|speaking
  keys: loadKeys(),
  stream: null, ac: null, analyser: null, buf: null,
  recorder: null, chunks: [], lastVoice: 0, speechStart: 0, noiseFloor: 0.01,
  rec: null,                    // SpeechRecognition (browser ASR)
  speechEndTs: 0,
  ttsAnalyser: null, ttsBuf: null, queue: [], source: null, playing: false,
  cancelled: false, mode: "batch",
  playStartTs: 0, echoGain: 0.4, bargeFrames: 0, turnStart: 0, firstAudioAt: 0,
};

const BARGE_GRACE_MS = 350;
const BARGE_PRESETS = {
  off: { enabled: false, threshold: 1, frames: 999 },
  low: { enabled: true, threshold: 0.09, frames: 11 },
  medium: { enabled: true, threshold: 0.06, frames: 8 },
  high: { enabled: true, threshold: 0.04, frames: 5 },
};
function bargeCfg() { return BARGE_PRESETS[$("barge").value] || BARGE_PRESETS.low; }

function loadKeys() { try { return JSON.parse(localStorage.getItem(LS_KEYS) || "{}"); } catch { return {}; } }
function authHeaders(extra) {
  const h = { ...(extra || {}) };
  if (state.keys.openai) h["X-OpenAI-Key"] = state.keys.openai;
  if (state.keys.gemini) h["X-Google-Key"] = state.keys.gemini;
  if (state.keys.anthropic) h["X-Anthropic-Key"] = state.keys.anthropic;
  if (state.keys.elevenlabs) h["X-Eleven-Labs-Key"] = state.keys.elevenlabs;
  return h;
}
function currentModel() {
  const [provider, ...rest] = $("model").value.split(":");
  return { provider, model: rest.join(":") };
}

// ---- UI helpers ----
function setPhase(p, text) {
  state.phase = p;
  $("status").textContent = p;
  $("status").className = "pill " + (p === "idle" ? "pill-muted" : "pill-ok");
  $("mic").className = "mic-btn" + (p === "recording" ? " recording" : p === "speaking" ? " speaking" : state.on ? " listening" : "");
  if (text) $("phase").textContent = text;
}
function addMsg(role, text) {
  const d = document.createElement("div");
  d.className = "t-msg t-" + role;
  d.textContent = text;
  $("transcript").append(d);
  $("transcript").scrollTop = $("transcript").scrollHeight;
  return d;
}
function addMetaLine(text) {
  const d = document.createElement("div");
  d.className = "t-meta"; d.textContent = text;
  $("transcript").append(d); $("transcript").scrollTop = $("transcript").scrollHeight;
}

// ---- latency pie ----
function renderPie(lat) {
  const ctx = $("pie").getContext("2d");
  const W = $("pie").width, cx = W / 2, cy = W / 2, r = W / 2 - 6;
  ctx.clearRect(0, 0, W, W);
  const entries = Object.keys(PIE).map((k) => [k, lat[k] || 0]);
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  let a = -Math.PI / 2;
  for (const [k, v] of entries) {
    if (v <= 0) continue;
    const slice = (v / total) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a, a + slice);
    ctx.closePath(); ctx.fillStyle = PIE[k][1]; ctx.fill();
    a += slice;
  }
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2); ctx.fillStyle = "#161b22"; ctx.fill();
  $("latTotal").textContent = Math.round(total);
  $("pieLegend").innerHTML = entries.map(([k, v]) =>
    `<div class="pl"><span class="dot" style="background:${PIE[k][1]}"></span><span>${PIE[k][0]}</span><span>${Math.round(v)}ms (${Math.round(v / total * 100)}%)</span></div>`
  ).join("");
}

// ---- mic + analyser ----
async function ensureMic() {
  if (state.stream) return;
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  state.ac = new (window.AudioContext || window.webkitAudioContext)();
  const src = state.ac.createMediaStreamSource(state.stream);
  state.analyser = state.ac.createAnalyser();
  state.analyser.fftSize = 1024;
  state.buf = new Float32Array(state.analyser.fftSize);
  src.connect(state.analyser);
  state.ttsAnalyser = state.ac.createAnalyser();
  state.ttsAnalyser.fftSize = 1024;
  state.ttsBuf = new Float32Array(state.ttsAnalyser.fftSize);
  state.ttsAnalyser.connect(state.ac.destination);
}
function rmsOf(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let s = 0;
  for (const x of buf) s += x * x;
  return Math.sqrt(s / buf.length);
}
function rms() { return rmsOf(state.analyser, state.buf); }
function ttsLevel() { return state.playing ? rmsOf(state.ttsAnalyser, state.ttsBuf) : 0; }
function speechThreshold() { return Math.max(0.012, state.noiseFloor * 2 + 0.01); }

async function calibrate() {
  const samples = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 500) {
    samples.push(rms());
    await new Promise((r) => setTimeout(r, 30));
  }
  state.noiseFloor = samples.reduce((a, b) => a + b, 0) / samples.length;
}

// ---- VAD loop ----
function loop() {
  if (!state.on) return;
  const level = rms();
  $("levelBar").style.width = Math.min(100, level * 600) + "%";
  const th = speechThreshold();
  const now = performance.now();
  const serverMode = $("asr").value !== "browser";

  if (state.phase === "speaking") {
    const bc = bargeCfg();
    const out = ttsLevel();
    const residual = level - state.echoGain * out;
    const since = now - state.playStartTs;
    const speaking = residual > bc.threshold;
    if (!speaking && out > 0.005) {
      state.echoGain = Math.min(4, Math.max(0, state.echoGain * 0.97 + (level / out) * 0.03));
    }
    if (bc.enabled && since > BARGE_GRACE_MS) {
      state.bargeFrames = speaking ? state.bargeFrames + 1 : Math.max(0, state.bargeFrames - 1);
      if (state.bargeFrames >= bc.frames) bargeIn();
    }
  } else if (serverMode && state.phase === "listening" && level > th) {
    beginRecording();
  } else if (serverMode && state.phase === "recording") {
    if (level > th) state.lastVoice = now;
    if (now - state.lastVoice > Number($("endpoint").value)) endRecording();
  }
  requestAnimationFrame(loop);
}

// ---- server-ASR capture (MediaRecorder) ----
function beginRecording() {
  state.chunks = [];
  state.recorder = new MediaRecorder(state.stream, { mimeType: pickMime() });
  state.recorder.ondataavailable = (e) => { if (e.data.size) state.chunks.push(e.data); };
  state.recorder.onstop = onRecordingStop;
  state.recorder.start();
  state.speechStart = performance.now();
  state.lastVoice = performance.now();
  setPhase("recording", "listening to you...");
}
function endRecording() {
  if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
}
function blobToB64(blob) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result.split(",")[1]);
    reader.onerror = rej;
    reader.readAsDataURL(blob);
  });
}
async function onRecordingStop() {
  const blob = new Blob(state.chunks, { type: state.recorder.mimeType });
  if (blob.size < 1200) { setPhase("listening", "(too short, ignored)"); return; }
  setPhase("thinking", "transcribing...");
  const t0 = performance.now();
  try {
    const b64 = await blobToB64(blob);
    const r = await fetch(BASE + "/api/asr", {
      method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ audio_b64: b64, provider: $("asr").value, language: "en-US" }),
    });
    const d = await r.json();
    if (d.error) { setPhase("listening", "ASR error: " + d.error); return; }
    if (!d.transcript) { setPhase("listening", "(no speech detected)"); return; }
    addMsg("user", d.transcript);
    await runPipeline(d.transcript, d.latency_ms || Math.round(performance.now() - t0));
  } catch (e) { setPhase("listening", "ASR failed: " + e.message); }
}
function pickMime() {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"])
    if (MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

// ---- browser ASR (Web Speech API) ----
function startBrowserASR() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { setPhase("listening", "Browser ASR not supported here; pick another ASR."); return; }
  const rec = new SR();
  rec.continuous = true; rec.interimResults = false; rec.lang = "en-US";
  rec.onspeechend = () => { state.speechEndTs = performance.now(); };
  rec.onresult = async (ev) => {
    const text = ev.results[ev.results.length - 1][0].transcript.trim();
    if (!text || state.phase === "thinking" || state.phase === "speaking") return;
    addMsg("user", text);
    const asrMs = state.speechEndTs ? Math.round(performance.now() - state.speechEndTs) : 0;
    await runPipeline(text, asrMs);
  };
  rec.onerror = () => {};
  rec.onend = () => { if (state.on && $("asr").value === "browser") { try { rec.start(); } catch {} } };
  state.rec = rec;
  try { rec.start(); } catch {}
}
function stopBrowserASR() { if (state.rec) { state.rec.onend = null; try { state.rec.stop(); } catch {} state.rec = null; } }

// ---- pipeline: llm -> tts ----
function llmPayload(userText, extra) {
  const know = document.querySelector("#knowledge .active").dataset.v;
  const { provider, model } = currentModel();
  state.messages.push({ role: "user", content: userText });
  return {
    messages: [...state.messages, ...(extra || [])],
    provider, model, response_length: "low",
    use_context: know === "ragless", use_rag: know === "rag", top_k: 4,
    tools_enabled: $("toolsEnabled").checked ? _defaultTools() : [],
  };
}
function _defaultTools() {
  return [
    "get_cart_total", "add_to_cart", "remove_from_cart", "clear_cart", "checkout_item",
    "checkout_all", "get_pricing_annual", "calculate_savings", "sort_products",
    "get_top_k_expensive", "get_cart_items",
  ];
}
async function runToolCalls(toolCalls) {
  const extra = []; let toolMs = 0;
  for (const tc of toolCalls) {
    const t0 = performance.now();
    const { result, error } = await dispatch(tc.name, tc.args || {});
    toolMs += performance.now() - t0;
    extra.push({ role: "assistant", content: `[Calling tool ${tc.name}(${JSON.stringify(tc.args || {})})]` });
    extra.push({ role: "user", content: `[Tool ${tc.name} result: ${JSON.stringify(error ? { error } : result)}]` });
  }
  return { extra, toolMs };
}

async function runPipeline(userText, asrMs) {
  state.cancelled = false;
  state.turnStart = performance.now();
  state.firstAudioAt = 0;
  if ($("asr").value === "browser") stopBrowserASR();
  if (state.mode === "stream") await pipelineStream(userText, asrMs);
  else await pipelineBatch(userText, asrMs);
}

async function callLlm(payload) {
  const r = await fetch(BASE + "/api/llm", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(payload) });
  return r.json();
}

async function pipelineBatch(userText, asrMs) {
  setPhase("thinking", "thinking...");
  let chat, toolMs = 0;
  try {
    chat = await callLlm(llmPayload(userText));
    if (chat.tool_calls?.length) {
      const { extra, toolMs: tm } = await runToolCalls(chat.tool_calls);
      toolMs = tm;
      chat = await callLlm(llmPayload_noPush(extra));
    }
  } catch (e) { setPhase("listening", "chat failed: " + e.message); return; }
  if (chat.error) { setPhase("listening", "chat error: " + chat.error); return; }
  state.messages.push({ role: "assistant", content: chat.reply });
  state.lastBubble = addMsg("assistant", chat.reply);
  setPhase("thinking", "synthesizing voice...");
  const tts = await synth(chat.reply);
  if (!tts) { resumeListening(); return; }
  const lat = { asr_ms: asrMs, rag_ms: chat.rag_latency_ms || 0, llm_ms: chat.latency_ms || 0, tool_ms: toolMs, tts_ms: tts.ms, buffer_ms: Number($("buffer").value) };
  beginSpeaking();
  await new Promise((r) => setTimeout(r, lat.buffer_ms));
  enqueue(tts.audio);
  finishTurn(lat, "batch");
}

// Re-sends the already-pushed conversation plus tool-result messages, without pushing userText again.
function llmPayload_noPush(extra) {
  const know = document.querySelector("#knowledge .active").dataset.v;
  const { provider, model } = currentModel();
  return {
    messages: [...state.messages, ...extra],
    provider, model, response_length: "low",
    use_context: know === "ragless", use_rag: know === "rag", top_k: 4,
    tools_enabled: $("toolsEnabled").checked ? _defaultTools() : [],
  };
}

async function pipelineStream(userText, asrMs) {
  setPhase("thinking", "thinking...");
  const bubble = addMsg("assistant", "");
  state.lastBubble = bubble;
  let acc = "", pending = "", spoke = false, toolCalls = [], lat0 = null, toolMs = 0;
  let firstSentenceTs = 0, firstSynthMs = 0;
  const flush = async (text) => {
    const t = text.trim();
    if (!t || state.cancelled) return;
    const fs = performance.now();
    const tts = await synth(t);
    if (!tts || state.cancelled) return;
    if (!firstSentenceTs) { firstSentenceTs = fs; firstSynthMs = performance.now() - fs; }
    if (!spoke) { spoke = true; beginSpeaking(); await new Promise((r) => setTimeout(r, Number($("buffer").value))); }
    enqueue(tts.audio);
  };
  try {
    let payload = llmPayload(userText);
    let r = await fetch(BASE + "/api/llm/stream", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(payload) });
    let { acc: acc1, toolCalls: tc1, lat: lat1 } = await consumeStream(r, bubble, flush, (t) => acc += t);
    acc = acc1; toolCalls = tc1; lat0 = lat1;
    if (toolCalls.length && !state.cancelled) {
      const { extra, toolMs: tm } = await runToolCalls(toolCalls);
      toolMs = tm;
      acc = ""; pending = ""; bubble.textContent = "";
      const payload2 = llmPayload_noPush(extra);
      r = await fetch(BASE + "/api/llm/stream", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(payload2) });
      const r2 = await consumeStream(r, bubble, flush, (t) => acc += t);
      acc = r2.acc; lat0 = r2.lat;
    }
    if (pending.trim()) await flush(pending);
  } catch (e) { bubble.textContent = "stream failed: " + e.message; resumeListening(); return; }
  if (state.cancelled) return;
  if (!spoke) { resumeListening(); return; }
  const ragMs = (lat0 && lat0.rag_latency_ms) || 0;
  const llmToFirst = firstSentenceTs ? firstSentenceTs - state.turnStart : 0;
  const lat = {
    asr_ms: asrMs, rag_ms: ragMs,
    llm_ms: Math.max(0, llmToFirst - ragMs),
    tool_ms: toolMs, tts_ms: firstSynthMs, buffer_ms: Number($("buffer").value),
  };
  finishTurn(lat, "stream");
}

async function consumeStream(r, bubble, flush, onText) {
  if (!r.ok || !r.body) { bubble.className = "t-msg t-assistant"; bubble.textContent = "Stream failed (" + r.status + ")"; return { acc: "", toolCalls: [], lat: {} }; }
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
  let acc = "", pending = "";
  const toolCalls = []; let lat = {};
  for (;;) {
    const { value, done } = await reader.read();
    if (done || state.cancelled) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n"); buf = parts.pop();
    for (const p of parts) {
      const line = p.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === "token") {
        acc += ev.data; pending += ev.data; bubble.textContent = acc; onText(ev.data);
        let m;
        while ((m = pending.match(/[^.!?]*[.!?]+(\s|$)/)) && m[0].trim().length > 2) {
          await flush(m[0]); pending = pending.slice(m[0].length);
        }
      } else if (ev.type === "tool_call") {
        toolCalls.push(ev.data);
      } else if (ev.type === "done") {
        lat = ev.data;
      } else if (ev.type === "error") {
        bubble.textContent = "error: " + ev.data;
      }
    }
  }
  return { acc, toolCalls, lat };
}

function finishTurn(lat, mode) {
  const measured = state.firstAudioAt ? state.firstAudioAt - state.turnStart : 0;
  const ttfa = Math.round((lat.asr_ms || 0) + measured);
  const sum = ["asr_ms", "rag_ms", "llm_ms", "tool_ms", "tts_ms", "buffer_ms"]
    .reduce((s, k) => s + (lat[k] || 0), 0);
  lat = { ...lat, other_ms: Math.max(0, ttfa - sum) };
  $(mode === "stream" ? "ttfaStream" : "ttfaBatch").textContent = ttfa + "ms";
  renderPie(lat);
  addMetaLine(`[${mode}] TTFA ${ttfa}ms = ASR ${Math.round(lat.asr_ms || 0)} + RAG ${Math.round(lat.rag_ms || 0)} + LLM ${Math.round(lat.llm_ms || 0)} + Tools ${Math.round(lat.tool_ms || 0)} + TTS ${Math.round(lat.tts_ms || 0)} + buffer ${Math.round(lat.buffer_ms || 0)} + other ${Math.round(lat.other_ms)}`);
}

// ---- TTS synth + Web Audio queue playback ----
async function synth(text) {
  try {
    const r = await fetch(BASE + "/api/tts", {
      method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ text, provider: $("tts").value, voice: $("voice").value }),
    });
    if (!r.ok) return null;
    const ms = Number(r.headers.get("X-TTS-Ms") || 0);
    return { audio: await r.arrayBuffer(), ms };
  } catch { return null; }
}

function beginSpeaking() {
  state.playStartTs = performance.now();
  state.bargeFrames = 0;
  setPhase("speaking", "speaking (talk to interrupt)");
}

async function enqueue(arrayBuffer) {
  if (state.cancelled) return;
  let audioBuf;
  try { audioBuf = await state.ac.decodeAudioData(arrayBuffer.slice(0)); }
  catch { return; }
  state.queue.push(audioBuf);
  if (!state.playing) playNext();
}

function playNext() {
  if (state.cancelled) { state.queue = []; state.playing = false; return; }
  const buf = state.queue.shift();
  if (!buf) { state.playing = false; if (state.phase === "speaking") resumeListening(); return; }
  state.playing = true;
  const src = state.ac.createBufferSource();
  src.buffer = buf;
  src.connect(state.ttsAnalyser);
  src.onended = () => { state.source = null; playNext(); };
  state.source = src;
  if (!state.firstAudioAt) { state.firstAudioAt = performance.now(); state.playStartTs = performance.now(); }
  src.start();
}

function stopPlayback() {
  state.cancelled = true;
  state.queue = [];
  if (state.source) { try { state.source.onended = null; state.source.stop(); } catch {} state.source = null; }
  state.playing = false;
}

function bargeIn() {
  stopPlayback();
  if (state.lastBubble) state.lastBubble.classList.add("cancelled");
  // Client-managed history: mark the interrupted reply so context stays honest.
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === "assistant") last.content += " [cancelled by the user]";
  addMetaLine("- barge-in: response cancelled -");
  resumeListening();
}

function resumeListening() {
  if (!state.on) return;
  state.playing = false;
  setPhase("listening", "listening...");
  if ($("asr").value === "browser") startBrowserASR();
}

// ---- master toggle ----
async function start() {
  try { await ensureMic(); } catch (e) { setPhase("idle", "mic permission denied"); return; }
  if (state.ac.state === "suspended") await state.ac.resume();
  state.on = true;
  setPhase("listening", "calibrating mic...");
  await calibrate();
  setPhase("listening", "listening...");
  if ($("asr").value === "browser") startBrowserASR();
  requestAnimationFrame(loop);
}
function stop() {
  state.on = false;
  stopBrowserASR();
  stopPlayback();
  if (state.recorder && state.recorder.state !== "inactive") try { state.recorder.stop(); } catch {}
  setPhase("idle", "stopped");
}

// ---- load options ----
function loadModels() {
  $("model").innerHTML = MODELS.map((m) => {
    const hasKey = !!state.keys[m.provider];
    return `<option value="${m.key}">${m.label}${hasKey ? "" : " (no key)"}</option>`;
  }).join("");
}
function loadVoices() {
  $("asr").innerHTML = ASR_PROVIDERS.map((a) => `<option value="${a}">${a}</option>`).join("");
  $("tts").innerHTML = Object.keys(TTS_VOICES).map((p) => `<option value="${p}">${p}</option>`).join("");
  // product defaults: ElevenLabs for both ASR and TTS, if a key is present
  if (state.keys.elevenlabs) { $("asr").value = "elevenlabs"; $("tts").value = "elevenlabs"; }
  syncVoices();
}
function syncVoices() {
  const list = TTS_VOICES[$("tts").value] || [];
  $("voice").innerHTML = list.map((v) => `<option value="${v}">${v}</option>`).join("");
}
const CFG_KEY = "nimbus_agent_config";
function persistConfig() {
  const know = document.querySelector("#knowledge .active")?.dataset.v || "ragless";
  const toolsOn = $("toolsEnabled").checked;
  let prev = {};
  try { prev = JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); } catch {}
  const { provider, model } = currentModel();
  const next = {
    ...prev,
    provider, model, knowledge: know,
    tools_enabled: toolsOn,
    asr: $("asr").value, tts: $("tts").value, voice: $("voice").value,
    endpoint: Number($("endpoint").value), buffer: Number($("buffer").value),
    barge: $("barge").value,
  };
  localStorage.setItem(CFG_KEY, JSON.stringify(next));
}

function updateAsrHint() {
  $("asrHint").textContent = $("asr").value === "browser"
    ? "On-device Web Speech API. Endpointing handled by the browser."
    : "Server ASR. Your turn ends after the endpoint silence below.";
}

// ---- settings ----
function initSettings() {
  const dlg = $("settings");
  $("settingsBtn").addEventListener("click", () => {
    $("k_openai").value = state.keys.openai || ""; $("k_gemini").value = state.keys.gemini || "";
    $("k_anthropic").value = state.keys.anthropic || ""; $("k_elevenlabs").value = state.keys.elevenlabs || "";
    $("apiBase").value = BASE;
    dlg.showModal();
  });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue !== "save") return;
    state.keys = {
      openai: $("k_openai").value.trim(), gemini: $("k_gemini").value.trim(),
      anthropic: $("k_anthropic").value.trim(), elevenlabs: $("k_elevenlabs").value.trim(),
    };
    localStorage.setItem(LS_KEYS, JSON.stringify(state.keys));
    if ($("apiBase").value.trim()) localStorage.setItem(LS_BASE, $("apiBase").value.trim());
    loadModels();
  });
}

function init() {
  $("mic").addEventListener("click", () => (state.on ? stop() : start()));
  $("endpoint").addEventListener("input", (e) => $("epVal").textContent = e.target.value);
  $("buffer").addEventListener("input", (e) => $("bufVal").textContent = e.target.value);
  document.querySelectorAll("#mode button").forEach((b) =>
    b.addEventListener("click", () => { document.querySelectorAll("#mode button").forEach((x) => x.classList.remove("active")); b.classList.add("active"); state.mode = b.dataset.v; }));
  $("tts").addEventListener("change", syncVoices);
  $("asr").addEventListener("change", () => { updateAsrHint(); if (state.on) { stopBrowserASR(); resumeListening(); } });
  document.querySelectorAll("#knowledge button").forEach((b) =>
    b.addEventListener("click", () => { document.querySelectorAll("#knowledge button").forEach((x) => x.classList.remove("active")); b.classList.add("active"); }));
  initSettings();
  loadModels(); loadVoices();
  updateAsrHint(); persistConfig();
  const cp = document.querySelector(".controls");
  cp.addEventListener("change", persistConfig);
  cp.addEventListener("input", persistConfig);
  document.querySelectorAll("#knowledge button, #mode button").forEach((b) => b.addEventListener("click", persistConfig));
  renderPie({});
}

init();
