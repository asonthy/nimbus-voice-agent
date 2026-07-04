/**
 * Playground bootstrap: renders all config panels and voice interaction area.
 * Imported by playground.html.
 */

import { get, set, setMany, getConfig } from "./config-store.js";
import * as ragViz from "./rag-viz.js";
import { drawChart, recordTurn, getHistory } from "./latency.js";

/* ─── Public entry point (called by playground.html) ─── */
export async function renderPlayground(catalog) {
  const app = document.getElementById("app");

  // Hero
  app.appendChild(_hero());

  // Shell: rail + main
  const shell = _el("div", { class: "container" });
  const inner = _el("div", { class: "console-shell" });
  shell.appendChild(inner);

  const rail = _buildRail();
  const main = _el("div", { class: "console-main", id: "pg-main" });

  inner.appendChild(rail);
  inner.appendChild(main);
  app.appendChild(shell);

  // Build all pages
  _renderPages(main, catalog);

  // Activate first page
  _activatePage("page-keys");
}

/* ─── Hero ─── */
function _hero() {
  const sec = _el("section", { class: "console-hero" });
  sec.innerHTML = `
    <div class="container">
      <h1 class="display">Voice Agent Playground</h1>
      <p class="lead muted">Configure ASR, LLM, TTS, RAG, and tools. Talk to the Nimbus voice agent in real time.</p>
      <div id="backend-pill" class="pill" style="display:inline-flex;align-items:center;gap:.45rem;margin-top:1rem;font-size:.82rem;font-weight:600;padding:.35rem .8rem;border-radius:999px;border:1px solid var(--line);background:#fff;">
        <span class="dot" style="width:9px;height:9px;border-radius:50%;background:#cbd5e1;display:inline-block;"></span>
        <span class="label">Checking backend…</span>
      </div>
    </div>`;
  _checkBackend(sec.querySelector("#backend-pill"));
  return sec;
}

async function _checkBackend(pill) {
  const url = get("backendUrl") || "http://localhost:8000";
  try {
    const res = await fetch(`${url}/api/health`);
    const data = await res.json();
    const dot = pill.querySelector(".dot");
    const lbl = pill.querySelector(".label");
    if (data.status === "ok") {
      dot.style.background = "#22c55e";
      dot.style.boxShadow = "0 0 0 3px rgba(34,197,94,.2)";
      lbl.textContent = `Backend OK · RAG ${data.rag_ready ? "ready" : "building…"}`;
    } else {
      throw new Error("not ok");
    }
  } catch {
    const dot = pill.querySelector(".dot");
    dot.style.background = "#ef4444";
    pill.querySelector(".label").textContent = "Backend offline";
    pill.classList.add("pill-bad");
  }
}

/* ─── Rail ─── */
const RAIL_ITEMS = [
  { id: "page-keys",    icon: "lock",     label: "API Keys" },
  { id: "page-asr",    icon: "mic",      label: "ASR" },
  { id: "page-llm",    icon: "chat",     label: "LLM" },
  { id: "page-rag",    icon: "flask",    label: "RAG" },
  { id: "page-tts",    icon: "bolt",     label: "TTS" },
  { id: "page-tools",  icon: "puzzle",   label: "Tools" },
  { id: "page-vad",    icon: "refresh",  label: "VAD" },
  { id: "page-latency",icon: "analytics",label: "Latency" },
  { id: "page-ragviz", icon: "sparkle",  label: "RAG Viz" },
  { id: "page-talk",   icon: "mic",      label: "Talk" },
];

function _buildRail() {
  const rail = _el("nav", { class: "console-rail" });
  RAIL_ITEMS.forEach(({ id, icon, label }) => {
    const a = _el("a", {
      class: "rail-link",
      href: "#",
      "data-page": id,
      onclick: (e) => { e.preventDefault(); _activatePage(id); },
    });
    a.innerHTML = `${_iconSvg(icon)}<span>${label}</span>`;
    rail.appendChild(a);
  });
  return rail;
}

function _activatePage(pageId) {
  document.querySelectorAll(".rail-link").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === pageId);
  });
  document.querySelectorAll(".pg-page").forEach((p) => {
    p.style.display = p.id === pageId ? "flex" : "none";
  });
  // Trigger deferred renders
  if (pageId === "page-ragviz") _initRagViz();
  if (pageId === "page-latency") _refreshLatencyChart();
}

/* ─── Pages ─── */
function _renderPages(main, catalog) {
  main.appendChild(_pageKeys());
  main.appendChild(_pageAsr());
  main.appendChild(_pageLlm());
  main.appendChild(_pageRag(catalog));
  main.appendChild(_pageTts());
  main.appendChild(_pageTools());
  main.appendChild(_pageVad());
  main.appendChild(_pageLatency());
  main.appendChild(_pageRagViz());
  main.appendChild(_pageTalk(catalog));

  // Hide all initially; first activation shows page-keys
  main.querySelectorAll(".pg-page").forEach((p) => (p.style.display = "none"));
}

function _page(id, title, subtitle) {
  const div = _el("div", { class: "pg-page page", id, style: "display:none;flex-direction:column;gap:1.1rem;" });
  div.innerHTML = `<div class="page-head"><h2>${title}</h2><p class="muted">${subtitle}</p></div>`;
  return div;
}

/* — Keys — */
function _pageKeys() {
  const pg = _page("page-keys", "API Keys", "Keys are stored locally in your browser and sent only to the backend you control.");
  const panel = _panel("Provider Keys");
  const fields = [
    ["openaiKey",     "OpenAI API Key",     "sk-proj-…",   "Used for Whisper ASR, GPT-4o / GPT-4o-mini LLM, and OpenAI TTS"],
    ["googleKey",     "Google API Key",     "AIza…",       "Used for Gemini ASR, LLM, and TTS"],
    ["elevenLabsKey", "ElevenLabs API Key", "el_…",        "Used for ElevenLabs ASR and TTS"],
    ["anthropicKey",  "Anthropic API Key",  "sk-ant-…",    "Used for Claude models (haiku, sonnet)"],
    ["backendUrl",    "Backend URL",        "http://localhost:8000", "URL of the running FastAPI backend"],
  ];
  const grid = _el("div", { class: "settings-grid", style: "margin-top:.8rem;" });
  fields.forEach(([key, label, placeholder, hint]) => {
    const wrap = _el("div", { class: "field" });
    wrap.innerHTML = `<label class="field-label">${label}</label>
      <input class="inp" type="password" placeholder="${placeholder}" value="${_esc(get(key) || "")}" />
      <span class="field-hint">${hint}</span>`;
    const inp = wrap.querySelector("input");
    inp.addEventListener("change", () => set(key, inp.value.trim()));
    grid.appendChild(wrap);
  });
  panel.appendChild(grid);
  pg.appendChild(panel);

  const note = _el("div", { class: "note" });
  note.textContent = "Keys are saved to localStorage and never sent to any third-party. They are forwarded to the Nimbus backend, which calls the AI providers on your behalf.";
  pg.appendChild(note);
  return pg;
}

/* — ASR — */
function _pageAsr() {
  const pg = _page("page-asr", "ASR", "Automatic Speech Recognition — choose your speech-to-text provider.");

  const settings = _panel("ASR Settings");
  settings.innerHTML += `
    <div class="settings-grid" style="margin-top:.8rem;">
      <div class="field">
        <label class="field-label">Provider</label>
        <select class="inp" id="asr-provider">
          <option value="browser">Browser (Web Speech API)</option>
          <option value="openai">OpenAI Whisper</option>
          <option value="gemini">Gemini</option>
          <option value="elevenlabs">ElevenLabs</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label">Language</label>
        <input class="inp" id="asr-lang" value="${_esc(get("asrLanguage"))}" placeholder="en-US" />
      </div>
    </div>`;

  const sel = settings.querySelector("#asr-provider");
  sel.value = get("asrProvider");
  sel.addEventListener("change", () => set("asrProvider", sel.value));
  settings.querySelector("#asr-lang").addEventListener("change", (e) => set("asrLanguage", e.target.value));

  const tryPanel = _panel("Test ASR");
  tryPanel.innerHTML += `
    <div class="asr-pulse" id="asr-pulse" style="display:none">
      <i></i><i></i><i></i><i></i><i></i><span>Listening…</span>
    </div>
    <div class="asr-out" id="asr-out" style="color:var(--muted)">Press the mic button to start</div>
    <div class="try-row" style="margin-top:.7rem;">
      <button class="btn btn-primary" id="asr-btn">🎤 Start ASR</button>
      <span id="asr-latency" class="muted" style="font-size:.82rem;"></span>
    </div>`;

  let _recog = null;
  let _mediaRecorder = null;
  let _chunks = [];
  let _active = false;

  tryPanel.querySelector("#asr-btn").addEventListener("click", async () => {
    if (_active) {
      _stopAsr(_recog, _mediaRecorder);
      _active = false;
      tryPanel.querySelector("#asr-btn").textContent = "🎤 Start ASR";
      tryPanel.querySelector("#asr-pulse").style.display = "none";
      return;
    }
    _active = true;
    tryPanel.querySelector("#asr-btn").textContent = "⏹ Stop";
    tryPanel.querySelector("#asr-pulse").style.display = "flex";
    tryPanel.querySelector("#asr-out").textContent = "";

    const provider = get("asrProvider");
    const t0 = performance.now();

    if (provider === "browser") {
      _recog = _browserAsr(
        (interim) => { tryPanel.querySelector("#asr-out").innerHTML = `<span class="asr-interim">${_esc(interim)}</span>`; },
        (final) => {
          tryPanel.querySelector("#asr-out").innerHTML = `<span class="asr-final">${_esc(final)}</span>`;
          tryPanel.querySelector("#asr-latency").textContent = `${Math.round(performance.now() - t0)}ms`;
          _active = false;
          tryPanel.querySelector("#asr-btn").textContent = "🎤 Start ASR";
          tryPanel.querySelector("#asr-pulse").style.display = "none";
        }
      );
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _mediaRecorder = new MediaRecorder(stream);
      _chunks = [];
      _mediaRecorder.ondataavailable = (e) => _chunks.push(e.data);
      _mediaRecorder.onstop = async () => {
        const blob = new Blob(_chunks, { type: "audio/webm" });
        const b64 = await _blobToBase64(blob);
        const res = await _callBackend("/api/asr", {
          audio_b64: b64.split(",")[1],
          provider,
          language: get("asrLanguage"),
        });
        tryPanel.querySelector("#asr-out").innerHTML = `<span class="asr-final">${_esc(res.transcript || "")}</span>`;
        tryPanel.querySelector("#asr-latency").textContent = `${res.latency_ms}ms (server)`;
        _active = false;
        tryPanel.querySelector("#asr-btn").textContent = "🎤 Start ASR";
        tryPanel.querySelector("#asr-pulse").style.display = "none";
        stream.getTracks().forEach((t) => t.stop());
      };
      _mediaRecorder.start();
    }
  });

  pg.appendChild(settings);
  pg.appendChild(tryPanel);
  return pg;
}

/* — LLM — */
function _pageLlm() {
  const pg = _page("page-llm", "LLM", "Language model settings, conversation history, and RAG integration.");

  const settings = _panel("LLM Settings");
  settings.innerHTML += `
    <div class="settings-grid" style="margin-top:.8rem;">
      <div class="field">
        <label class="field-label">Provider</label>
        <select class="inp" id="llm-provider">
          <option value="openai">OpenAI</option>
          <option value="gemini">Gemini</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label">Model</label>
        <select class="inp" id="llm-model">
          <option value="gpt-4o-mini">gpt-4o-mini (lite)</option>
          <option value="gpt-4o">gpt-4o (heavyweight)</option>
          <option value="gemini-1.5-flash">gemini-1.5-flash</option>
          <option value="gemini-1.5-pro">gemini-1.5-pro</option>
          <option value="claude-3-haiku-20240307">claude-3-haiku</option>
          <option value="claude-3-5-sonnet-20241022">claude-3.5-sonnet</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label">Mode</label>
        <select class="inp" id="llm-mode">
          <option value="streaming">Streaming</option>
          <option value="batch">Batch</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label">Response Length</label>
        <select class="inp" id="llm-len">
          <option value="low">Low (1–2 sentences)</option>
          <option value="medium">Medium (1 paragraph)</option>
          <option value="high">High (detailed)</option>
        </select>
      </div>
    </div>
    <div class="field" style="margin-top:1rem;">
      <label class="field-label">System Prompt</label>
      <textarea class="inp" id="llm-sysprompt" rows="5">${_esc(get("llmSystemPrompt"))}</textarea>
    </div>
    <div style="margin-top:1rem;">
      <label class="field-label">Verbatim history turns: <span id="hist-val">${get("llmHistoryN")}</span></label>
      <div class="range-wrap"><input type="range" class="inp-range" id="llm-hist" min="0" max="20" value="${get("llmHistoryN")}" /><span class="range-val" id="hist-val2">${get("llmHistoryN")}</span></div>
    </div>`;

  const ragPanel = _panel("RAG Options");
  ragPanel.innerHTML += `
    <div class="settings-grid" style="margin-top:.8rem;">
      <div class="field">
        <label class="field-label">RAG Mode</label>
        <select class="inp" id="rag-mode">
          <option value="rag">RAG (vector retrieval)</option>
          <option value="ragless">RAGless (full context.md)</option>
          <option value="none">No context injection</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label">Top-k chunks</label>
        <div class="range-wrap"><input type="range" class="inp-range" id="rag-k" min="1" max="15" value="${get("ragTopK")}" /><span class="range-val" id="rag-k-val">${get("ragTopK")}</span></div>
      </div>
      <div class="field">
        <label class="field-label">Reranking</label>
        <select class="inp" id="rag-rerank">
          <option value="false">Off</option>
          <option value="true">On (cross-encoder)</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label">Embedding Model</label>
        <select class="inp" id="rag-embed">
          <option value="all-MiniLM-L6-v2">all-MiniLM-L6-v2 (local)</option>
          <option value="text-embedding-3-small">text-embedding-3-small (OpenAI)</option>
        </select>
      </div>
    </div>`;

  // Wire LLM settings
  const llmProv = settings.querySelector("#llm-provider");
  llmProv.value = get("llmProvider");
  llmProv.addEventListener("change", () => set("llmProvider", llmProv.value));

  const llmModel = settings.querySelector("#llm-model");
  llmModel.value = get("llmModel");
  llmModel.addEventListener("change", () => set("llmModel", llmModel.value));

  const llmMode = settings.querySelector("#llm-mode");
  llmMode.value = get("llmMode");
  llmMode.addEventListener("change", () => set("llmMode", llmMode.value));

  const llmLen = settings.querySelector("#llm-len");
  llmLen.value = get("llmResponseLength");
  llmLen.addEventListener("change", () => set("llmResponseLength", llmLen.value));

  const sysprompt = settings.querySelector("#llm-sysprompt");
  sysprompt.addEventListener("change", () => set("llmSystemPrompt", sysprompt.value));

  const histRange = settings.querySelector("#llm-hist");
  const histVal = settings.querySelector("#hist-val2");
  histRange.addEventListener("input", () => {
    histVal.textContent = histRange.value;
    settings.querySelector("#hist-val").textContent = histRange.value;
    set("llmHistoryN", parseInt(histRange.value));
  });

  // Wire RAG settings
  const ragMode = ragPanel.querySelector("#rag-mode");
  ragMode.value = get("ragEnabled") ? "rag" : "none";
  ragMode.addEventListener("change", () => set("ragEnabled", ragMode.value === "rag"));

  const ragK = ragPanel.querySelector("#rag-k");
  const ragKVal = ragPanel.querySelector("#rag-k-val");
  ragK.addEventListener("input", () => {
    ragKVal.textContent = ragK.value;
    set("ragTopK", parseInt(ragK.value));
  });

  const ragRerank = ragPanel.querySelector("#rag-rerank");
  ragRerank.value = get("ragRerank") ? "true" : "false";
  ragRerank.addEventListener("change", () => set("ragRerank", ragRerank.value === "true"));

  const ragEmbed = ragPanel.querySelector("#rag-embed");
  ragEmbed.value = get("ragEmbeddingModel");
  ragEmbed.addEventListener("change", () => set("ragEmbeddingModel", ragEmbed.value));

  pg.appendChild(settings);
  pg.appendChild(ragPanel);
  return pg;
}

/* — RAG test — */
function _pageRag() {
  const pg = _page("page-rag", "RAG Query", "Test retrieval directly. Enter a question and see which chunks are returned.");

  const tryPanel = _panel("Query Test");
  tryPanel.innerHTML += `
    <div class="try-row">
      <input class="inp" id="rag-q" placeholder="What is the refund policy?" />
      <button class="btn btn-primary" id="rag-run">Search</button>
      <span id="rag-lat" class="muted" style="font-size:.82rem;"></span>
    </div>
    <div id="rag-results" style="margin-top:.8rem;"></div>`;

  tryPanel.querySelector("#rag-run").addEventListener("click", async () => {
    const q = tryPanel.querySelector("#rag-q").value.trim();
    if (!q) return;
    const results = tryPanel.querySelector("#rag-results");
    results.innerHTML = `<div class="note">Searching…</div>`;

    const res = await _callBackend("/api/rag/query", {
      query: q,
      top_k: get("ragTopK"),
      rerank: get("ragRerank"),
      embedding_model: get("ragEmbeddingModel"),
    });
    tryPanel.querySelector("#rag-lat").textContent = `${res.latency_ms}ms`;

    results.innerHTML = "";
    (res.chunks || []).forEach((c, i) => {
      const hit = _el("div", { class: "hit" });
      hit.innerHTML = `
        <div class="hit-top">
          <strong>${_esc(c.label)}</strong>
          <span class="score">score ${c.score.toFixed(3)}${c.rerank_score != null ? " · rerank " + c.rerank_score.toFixed(2) : ""}</span>
        </div>
        <p>${_esc(c.text.slice(0, 180))}…</p>
        <a href="#">[${c.source}]</a>`;
      results.appendChild(hit);
    });

    if (!res.chunks?.length) results.innerHTML = `<div class="note err">No results</div>`;
  });

  pg.appendChild(tryPanel);
  return pg;
}

/* — TTS — */
function _pageTts() {
  const pg = _page("page-tts", "TTS", "Text-to-speech provider settings and audio playback test.");

  const settings = _panel("TTS Settings");
  settings.innerHTML += `
    <div class="settings-grid" style="margin-top:.8rem;">
      <div class="field">
        <label class="field-label">Provider</label>
        <select class="inp" id="tts-provider">
          <option value="openai">OpenAI TTS</option>
          <option value="gemini">Gemini TTS</option>
          <option value="elevenlabs">ElevenLabs</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label">Voice</label>
        <select class="inp" id="tts-voice">
          <option value="alloy">alloy</option>
          <option value="echo">echo</option>
          <option value="fable">fable</option>
          <option value="onyx">onyx</option>
          <option value="nova">nova</option>
          <option value="shimmer">shimmer</option>
        </select>
      </div>
    </div>`;

  const sel = settings.querySelector("#tts-provider");
  sel.value = get("ttsProvider");
  sel.addEventListener("change", () => set("ttsProvider", sel.value));
  const voice = settings.querySelector("#tts-voice");
  voice.value = get("ttsVoice");
  voice.addEventListener("change", () => set("ttsVoice", voice.value));

  const tryPanel = _panel("TTS Test");
  tryPanel.innerHTML += `
    <div class="try-row">
      <input class="inp" id="tts-text" value="Welcome to Nimbus, your all-in-one business software suite." />
      <button class="btn btn-primary" id="tts-run">Speak</button>
    </div>
    <div id="tts-status" class="note" style="margin-top:.6rem;display:none;"></div>
    <div id="tts-latency" class="muted" style="font-size:.82rem;margin-top:.4rem;"></div>`;

  tryPanel.querySelector("#tts-run").addEventListener("click", async () => {
    const text = tryPanel.querySelector("#tts-text").value.trim();
    if (!text) return;
    const status = tryPanel.querySelector("#tts-status");
    status.style.display = "block";
    status.className = "note";
    status.textContent = "Generating audio…";
    const t0 = performance.now();

    try {
      const url = `${get("backendUrl")}/api/tts`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ text, provider: get("ttsProvider"), voice: get("ttsVoice") }),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const ttfb = Math.round(performance.now() - t0);
      const audio = new Audio(URL.createObjectURL(blob));
      audio.play();
      status.className = "note ok";
      status.textContent = "Playing…";
      tryPanel.querySelector("#tts-latency").textContent = `TTFB: ${ttfb}ms`;
      audio.onended = () => { status.textContent = "Done"; };
    } catch (err) {
      status.className = "note err";
      status.textContent = err.message;
    }
  });

  pg.appendChild(settings);
  pg.appendChild(tryPanel);
  return pg;
}

/* — Tools — */
const TOOL_DEFS = [
  { id: "get_cart_total",     label: "Cart Total",       desc: "Sum price × seats" },
  { id: "add_to_cart",        label: "Add to Cart",      desc: "Add a product tier" },
  { id: "remove_from_cart",   label: "Remove from Cart", desc: "Remove one item" },
  { id: "clear_cart",         label: "Clear Cart",       desc: "Empty the cart" },
  { id: "checkout_item",      label: "Checkout Item",    desc: "Buy a single item" },
  { id: "checkout_all",       label: "Checkout All",     desc: "Complete checkout" },
  { id: "get_pricing_annual", label: "Annual Pricing",   desc: "Convert to annual" },
  { id: "calculate_savings",  label: "Savings %",        desc: "Annual vs monthly" },
  { id: "sort_products",      label: "Sort Products",    desc: "By price asc/desc" },
  { id: "get_top_k_expensive",label: "Top-k Products",   desc: "Most expensive k" },
  { id: "get_cart_items",     label: "Cart Items",       desc: "Read current cart" },
];

function _pageTools() {
  const pg = _page("page-tools", "Tools", "Choose which tools the voice agent can call.");

  const panel = _panel("Tool Selection");
  const togglesDiv = _el("div", { class: "tool-toggles" });
  const enabled = new Set(get("toolsEnabled") || []);

  TOOL_DEFS.forEach(({ id, label, desc }) => {
    const lbl = document.createElement("label");
    lbl.className = "tool-toggle";
    lbl.innerHTML = `<input type="checkbox" value="${id}" ${enabled.has(id) ? "checked" : ""}/>
      <div><strong>${label}</strong><em>${id}</em><em>${desc}</em></div>`;
    lbl.querySelector("input").addEventListener("change", _saveToolToggles);
    togglesDiv.appendChild(lbl);
  });

  const btnRow = _el("div", { class: "try-row", style: "margin-bottom:.4rem;" });
  const all = _el("button", { class: "btn btn-light btn-sm" });
  all.textContent = "Select All";
  all.addEventListener("click", () => {
    togglesDiv.querySelectorAll("input").forEach((cb) => (cb.checked = true));
    _saveToolToggles();
  });
  const none = _el("button", { class: "btn btn-light btn-sm" });
  none.textContent = "Select None";
  none.addEventListener("click", () => {
    togglesDiv.querySelectorAll("input").forEach((cb) => (cb.checked = false));
    _saveToolToggles();
  });
  btnRow.appendChild(all);
  btnRow.appendChild(none);

  panel.appendChild(btnRow);
  panel.appendChild(togglesDiv);
  pg.appendChild(panel);
  return pg;

  function _saveToolToggles() {
    const checked = [...togglesDiv.querySelectorAll("input:checked")].map((cb) => cb.value);
    set("toolsEnabled", checked);
  }
}

/* — VAD — */
function _pageVad() {
  const pg = _page("page-vad", "VAD & Endpoint Detection", "Voice Activity Detection sensitivity and silence timeout before triggering ASR.");

  const panel = _panel("Settings");
  panel.innerHTML += `
    <div class="field" style="margin-top:.8rem;">
      <label class="field-label">Endpoint silence timeout: <span id="vad-ms-val">${get("vadEndpointMs")}</span>ms</label>
      <div class="range-wrap">
        <input type="range" class="inp-range" id="vad-ms" min="200" max="1000" step="50" value="${get("vadEndpointMs")}" />
        <span class="range-val" id="vad-ms-val2">${get("vadEndpointMs")}ms</span>
      </div>
    </div>
    <div class="field" style="margin-top:.8rem;">
      <label class="field-label">Voice sensitivity (RMS threshold): <span id="vad-sens-val">${get("vadSensitivity")}</span></label>
      <div class="range-wrap">
        <input type="range" class="inp-range" id="vad-sens" min="0.005" max="0.1" step="0.005" value="${get("vadSensitivity")}" />
        <span class="range-val" id="vad-sens-val2">${get("vadSensitivity")}</span>
      </div>
    </div>`;

  const msRange = panel.querySelector("#vad-ms");
  const msVal = panel.querySelector("#vad-ms-val2");
  msRange.addEventListener("input", () => {
    msVal.textContent = msRange.value + "ms";
    panel.querySelector("#vad-ms-val").textContent = msRange.value;
    set("vadEndpointMs", parseInt(msRange.value));
  });
  const sensRange = panel.querySelector("#vad-sens");
  const sensVal = panel.querySelector("#vad-sens-val2");
  sensRange.addEventListener("input", () => {
    sensVal.textContent = sensRange.value;
    panel.querySelector("#vad-sens-val").textContent = sensRange.value;
    set("vadSensitivity", parseFloat(sensRange.value));
  });

  pg.appendChild(panel);
  return pg;
}

/* — Latency — */
function _pageLatency() {
  const pg = _page("page-latency", "Latency Dashboard", "Per-component breakdown from the most recent voice turn.");

  const panel = _panel("Breakdown");
  panel.innerHTML += `
    <div id="lat-total" class="muted" style="font-size:.88rem;margin:.5rem 0;">No data yet — run a voice turn from the Talk page.</div>
    <div class="viz-graph-wrap viz-mount" style="height:200px;">
      <canvas id="lat-chart" class="viz-canvas"></canvas>
    </div>
    <div id="lat-history" class="viz-history" style="margin-top:.8rem;"></div>`;

  pg.appendChild(panel);
  return pg;
}

function _refreshLatencyChart() {
  const hist = getHistory();
  if (!hist.length) return;
  const latest = hist[0];
  const chart = document.querySelector("#lat-chart");
  const total = document.querySelector("#lat-total");
  if (total) total.textContent = `Total E2E: ${latest.total}ms`;
  drawChart(chart, latest);

  const histDiv = document.querySelector("#lat-history");
  if (!histDiv) return;
  histDiv.innerHTML = "";
  hist.forEach((h, i) => {
    const span = _el("span", { class: `viz-turn${i === 0 ? " kept" : ""}` });
    span.innerHTML = `<span class="viz-turn-dot"></span>${h.total}ms`;
    histDiv.appendChild(span);
  });
}

/* — RAG Viz — */
function _pageRagViz() {
  const pg = _page("page-ragviz", "RAG Vector Space", "2D PCA projection of all knowledge-base chunks. Red = query, amber = top-k matches.");

  const panel = _panel("Scatter Plot");
  panel.innerHTML += `
    <div class="viz-mount viz-mount-tall">
      <div class="viz-graph-wrap" id="ragviz-wrap" style="height:380px;">
        <canvas id="ragviz-canvas" class="viz-canvas"></canvas>
      </div>
    </div>
    <div class="viz-legend" id="ragviz-legend">
      <span class="viz-legend-item"><i style="background:#6366f1;"></i>Products</span>
      <span class="viz-legend-item"><i style="background:#0ea5e9;"></i>Pricing</span>
      <span class="viz-legend-item"><i style="background:#8b5cf6;"></i>FAQs</span>
      <span class="viz-legend-item"><i style="background:#10b981;"></i>Policies</span>
      <span class="viz-legend-item"><i style="background:#f59e0b;"></i>Company / Top-k</span>
      <span class="viz-legend-item"><i style="background:#ef4444;"></i>Query</span>
    </div>
    <div class="try-row" style="margin-top:.9rem;">
      <input class="inp" id="ragviz-q" placeholder="Type a query and press Enter to highlight top-k" />
      <button class="btn btn-primary" id="ragviz-run">Search</button>
      <span id="ragviz-lat" class="muted" style="font-size:.82rem;"></span>
    </div>`;

  pg.appendChild(panel);
  return pg;
}

let _ragVizInit = false;
async function _initRagViz() {
  if (_ragVizInit) { ragViz.render(); return; }
  _ragVizInit = true;
  const canvas = document.getElementById("ragviz-canvas");
  const wrap = document.getElementById("ragviz-wrap");
  if (!canvas || !wrap) return;
  ragViz.init(canvas, wrap);
  try {
    const n = await ragViz.loadVectors(get("backendUrl"));
    console.log(`RAG viz: loaded ${n} vectors`);
  } catch (e) {
    console.error("RAG viz load failed", e);
  }

  const runBtn = document.getElementById("ragviz-run");
  const qInp = document.getElementById("ragviz-q");
  if (runBtn && qInp) {
    const doSearch = async () => {
      const q = qInp.value.trim();
      if (!q) return;
      const res = await _callBackend("/api/rag/query", {
        query: q,
        top_k: get("ragTopK"),
        rerank: get("ragRerank"),
        embedding_model: get("ragEmbeddingModel"),
      });
      document.getElementById("ragviz-lat").textContent = `${res.latency_ms}ms`;
      ragViz.setQueryResult(res.query_coords, res.chunks || []);
    };
    runBtn.addEventListener("click", doSearch);
    qInp.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  }
}

/* — Talk — */
function _pageTalk(catalog) {
  const pg = _page("page-talk", "Talk", "Full voice conversation. Uses all settings configured in other panels.");

  const panel = _panel("Voice Session");
  panel.innerHTML += `
    <div class="viz-pipe" id="talk-pipe" style="margin-bottom:.9rem;">
      <span class="viz-pipe-stage" data-stage="asr">ASR</span>
      <span class="viz-pipe-arrow">→</span>
      <span class="viz-pipe-stage" data-stage="rag">RAG</span>
      <span class="viz-pipe-arrow">→</span>
      <span class="viz-pipe-stage" data-stage="llm">LLM</span>
      <span class="viz-pipe-arrow">→</span>
      <span class="viz-pipe-stage" data-stage="tts">TTS</span>
    </div>
    <div class="talk-controls">
      <button class="mic-btn" id="talk-mic" title="Push to talk">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
      </button>
      <div>
        <div class="talk-status"><span class="dot-idle" id="talk-dot"></span><span id="talk-state">Idle</span></div>
        <div id="talk-mini-lat" class="muted" style="font-size:.78rem;margin-top:.2rem;"></div>
      </div>
    </div>
    <div class="asr-out" id="talk-asr" style="margin-bottom:.7rem;color:var(--muted)">Transcript will appear here…</div>
    <div class="talk-log" id="talk-log"></div>`;

  let _wsSession = null;

  const micBtn = panel.querySelector("#talk-mic");
  micBtn.addEventListener("click", async () => {
    const { WsSession } = await import("./ws-client.js");
    if (!_wsSession) {
      _wsSession = new WsSession({
        backendUrl: get("backendUrl"),
        config: getConfig(),
        onStateChange: (state) => _updateTalkState(panel, state),
        onTranscript: (text, final) => _updateTranscript(panel, text, final),
        onToken: (tok) => _appendToken(panel, tok),
        onTurnDone: (report) => {
          recordTurn(report);
          panel.querySelector("#talk-mini-lat").textContent = `E2E: ${report.total}ms · ASR: ${report.asr ?? 0}ms · LLM: ${report.llm ?? 0}ms · TTS: ${report.tts ?? 0}ms`;
        },
        onToolCall: (name, result) => _appendToolChip(panel, name, result),
        catalog,
      });
      await _wsSession.connect();
    }
    if (_wsSession.listening) {
      _wsSession.stopListening();
    } else {
      _wsSession.startListening();
    }
  });

  pg.appendChild(panel);
  return pg;
}

function _updateTalkState(panel, state) {
  const dot = panel.querySelector("#talk-dot");
  const label = panel.querySelector("#talk-state");
  const mic = panel.querySelector("#talk-mic");
  const stages = panel.querySelectorAll(".viz-pipe-stage");

  stages.forEach((s) => s.classList.remove("on"));
  dot.className = "";
  label.textContent = state;

  const stageMap = { listening: "asr", thinking: "llm", searching: "rag", speaking: "tts" };
  if (stageMap[state]) {
    stages.forEach((s) => { if (s.dataset.stage === stageMap[state]) s.classList.add("on"); });
  }

  dot.classList.add(`dot-${state === "listening" ? "listening" : state === "speaking" ? "speaking" : "thinking"}`);
  mic.classList.toggle("live", state === "listening");
}

function _updateTranscript(panel, text, final) {
  const el = panel.querySelector("#talk-asr");
  el.innerHTML = final
    ? `<span class="asr-final">${_esc(text)}</span>`
    : `<span class="asr-interim">${_esc(text)}</span>`;

  if (final && text) {
    const log = panel.querySelector("#talk-log");
    const line = _el("div", { class: "talk-line user" });
    line.innerHTML = `<span class="who">You</span><span class="talk-text">${_esc(text)}</span>`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }
}

function _appendToken(panel, tok) {
  const log = panel.querySelector("#talk-log");
  let last = log.querySelector(".talk-line.agent:last-child");
  if (!last) {
    last = _el("div", { class: "talk-line agent" });
    last.innerHTML = `<span class="who">Nimbus</span><span class="talk-text"></span>`;
    log.appendChild(last);
  }
  last.querySelector(".talk-text").textContent += tok;
  log.scrollTop = log.scrollHeight;
}

function _appendToolChip(panel, name, result) {
  const log = panel.querySelector("#talk-log");
  const chip = _el("div", { class: "trace" });
  chip.innerHTML = `<span class="chip-tool">${_iconSvg("puzzle")}<code>${name}</code></span><span class="cited">${_esc(JSON.stringify(result).slice(0, 80))}</span>`;
  log.appendChild(chip);
  log.scrollTop = log.scrollHeight;
}

/* ─── Helpers ─── */
async function _callBackend(path, body) {
  const url = `${get("backendUrl")}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

function authHeaders() {
  return {
    "X-OpenAI-Key": get("openaiKey") || "",
    "X-Google-Key": get("googleKey") || "",
    "X-ElevenLabs-Key": get("elevenLabsKey") || "",
    "X-Anthropic-Key": get("anthropicKey") || "",
  };
}

function _el(tag, attrs = {}) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2), v);
    } else {
      el.setAttribute(k, v);
    }
  });
  return el;
}

function _panel(title) {
  const div = _el("div", { class: "panel" });
  div.innerHTML = `<div class="panel-h">${title}</div>`;
  return div;
}

function _esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _iconSvg(name) {
  const PATHS = {
    lock: '<path d="M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2z"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    flask: '<path d="M9 3h6v10l3 6H6l3-6z"/><line x1="9" y1="3" x2="9" y2="13"/><line x1="15" y1="3" x2="15" y2="13"/>',
    bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    puzzle: '<path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 2c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.017z"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    analytics: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
    sparkle: '<path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>',
  };
  const d = PATHS[name] || PATHS.sparkle;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}

function _browserAsr(onInterim, onFinal) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { onFinal("Browser ASR not supported"); return null; }
  const recog = new SR();
  recog.continuous = false;
  recog.interimResults = true;
  recog.lang = get("asrLanguage");
  recog.onresult = (e) => {
    const last = e.results[e.results.length - 1];
    if (last.isFinal) onFinal(last[0].transcript);
    else onInterim(last[0].transcript);
  };
  recog.start();
  return recog;
}

function _stopAsr(recog, mr) {
  recog?.stop();
  mr?.stop();
}

function _blobToBase64(blob) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result);
    reader.onerror = rej;
    reader.readAsDataURL(blob);
  });
}
