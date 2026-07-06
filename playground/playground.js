// Nimbus playground - text chat (batch/stream, history, tools, RAG, latency).
// Talks to our backend's /api/llm, /api/llm/stream, /api/rag/*, /api/tools,
// /api/health. Our REST endpoints are stateless (no server-side session), so
// conversation history and the tool-call round-trip are managed here.

import { dispatch } from "../assets/playground/tools.js";

const LS_KEYS = "nimbus_pg_keys";
const LS_BASE = "nimbus_pg_base";
const CART_KEY = "nimbus_cart";
// window.NIMBUS_API_BASE is set by runtime-config.js; ignore the un-edited placeholder.
const RUNTIME_BASE = window.NIMBUS_API_BASE && !window.NIMBUS_API_BASE.includes("REPLACE-ME") ? window.NIMBUS_API_BASE : "";
const DEFAULT_BASE = RUNTIME_BASE || "http://localhost:8000";

const MODELS = [
  { key: "openai:gpt-4o-mini", label: "OpenAI GPT-4o mini", provider: "openai" },
  { key: "openai:gpt-4o", label: "OpenAI GPT-4o", provider: "openai" },
  { key: "gemini:gemini-2.0-flash", label: "Gemini 2.0 Flash", provider: "gemini" },
  { key: "gemini:gemini-1.5-pro", label: "Gemini 1.5 Pro", provider: "gemini" },
  { key: "anthropic:claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku", provider: "anthropic" },
  { key: "anthropic:claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet", provider: "anthropic" },
];

const state = {
  base: localStorage.getItem(LS_BASE) || DEFAULT_BASE,
  keys: loadKeys(),
  mode: "batch",
  length: "medium",
  knowledge: "rag",
  messages: [],
  compareNext: false,
};

function loadKeys() {
  try { return JSON.parse(localStorage.getItem(LS_KEYS) || "{}"); } catch { return {}; }
}
const $ = (id) => document.getElementById(id);

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (state.keys.openai) h["X-OpenAI-Key"] = state.keys.openai;
  if (state.keys.gemini) h["X-Google-Key"] = state.keys.gemini;
  if (state.keys.anthropic) h["X-Anthropic-Key"] = state.keys.anthropic;
  return h;
}

// ---- messages ----
function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "msg msg-" + role;
  div.textContent = text;
  $("messages").append(div);
  $("messages").scrollTop = $("messages").scrollHeight;
  return div;
}

// ---- latency rendering ----
const STAGE_LABELS = { rag_ms: "RAG", llm_ms: "LLM" };
function renderLatency(lat) {
  if (!lat) return;
  $("latTotal").textContent = Math.round(lat.total_ms);
  const max = Math.max(1, ...Object.keys(STAGE_LABELS).map((k) => lat[k] || 0));
  $("latBars").innerHTML = "";
  for (const [k, label] of Object.entries(STAGE_LABELS)) {
    const v = lat[k] || 0;
    const row = document.createElement("div");
    row.className = "lat-row";
    row.innerHTML = `<span>${label}</span><div class="bar"><i style="width:${(v / max) * 100}%"></i></div><span class="val">${Math.round(v)}ms</span>`;
    $("latBars").append(row);
  }
}
function setCmp(mode, ttft, total) {
  const p = mode === "batch" ? "b" : "s";
  $(p + "Ttft").textContent = Math.round(ttft) + "ms";
  $(p + "Total").textContent = Math.round(total) + "ms";
}
function renderMeta(modelKey, toolCalls) {
  $("meta").textContent = `model: ${modelKey}\nverbatim history: ${$("verbatim").value} messages\ntemperature: ${($("temp").value / 10).toFixed(1)}`;
  renderTrace(toolCalls || []);
}
function renderTrace(calls) {
  const box = $("toolTrace");
  if (!calls.length) { box.innerHTML = "<em>none</em>"; return; }
  box.innerHTML = "";
  for (const c of calls) {
    const d = document.createElement("div");
    d.className = "tc";
    d.innerHTML = `<b>${c.name}</b>(${escapeArgs(c.args)}) <small>${Math.round(c.ms || 0)}ms</small>`;
    box.append(d);
  }
}
function escapeArgs(a) {
  const s = JSON.stringify(a || {});
  return s === "{}" ? "" : s.replace(/[<>&]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m]));
}

function refreshCart() {
  let items = [];
  try { items = JSON.parse(localStorage.getItem(CART_KEY) || "[]"); } catch {}
  const box = $("cart");
  if (!items.length) { box.innerHTML = "<em>empty</em>"; return; }
  const total = items.reduce((s, i) => s + (i.price || 0) * (i.seats || 1), 0);
  box.innerHTML = items.map((i) =>
    `<div class="cline"><span>${i.product_name} · ${i.tier} ×${i.seats}</span><span>$${i.price * i.seats}/mo</span></div>`
  ).join("") + `<div class="ctotal"><span>Monthly</span><span>$${total}/mo</span></div>`;
}

// ---- requests ----
function enabledToolNames() {
  return [...document.querySelectorAll("#toolList input:checked")].map((c) => c.value);
}
function currentModel() {
  const [provider, ...rest] = $("model").value.split(":");
  return { provider, model: rest.join(":") };
}
function verbatimMessages() {
  const n = Number($("verbatim").value);
  return n > 0 ? state.messages.slice(-n) : [];
}
function llmPayload(extraMessages) {
  const toolsOn = $("toolsEnabled").checked;
  const { provider, model } = currentModel();
  return {
    messages: [...verbatimMessages(), ...(extraMessages || [])],
    provider, model,
    response_length: state.length,
    use_context: state.knowledge === "ragless",
    use_rag: state.knowledge === "rag",
    top_k: Number($("topk").value),
    rerank: $("rerank").checked,
    temperature: Number($("temp").value) / 10,
    system_prompt: $("sysPrompt").value.trim() || "You are Nimbus Assistant, a helpful voice agent for the Nimbus cloud software suite.",
    tools_enabled: toolsOn ? enabledToolNames() : [],
  };
}

// Shared agent config consumed by the website widget (same-origin localStorage).
const CFG_KEY = "nimbus_agent_config";
function persistConfig() {
  const toolsOn = $("toolsEnabled").checked;
  let prev = {};
  try { prev = JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); } catch {}
  const { provider, model } = currentModel();
  const next = {
    ...prev,
    provider, model,
    response_length: state.length,
    knowledge: state.knowledge,
    top_k: Number($("topk").value),
    rerank: $("rerank").checked,
    verbatim_turns: Number($("verbatim").value),
    temperature: Number($("temp").value) / 10,
    system_prompt: $("sysPrompt").value.trim() || null,
    tools_enabled: toolsOn,
    enabled_tools: toolsOn ? enabledToolNames() : [],
  };
  localStorage.setItem(CFG_KEY, JSON.stringify(next));
}

// Executes any tool_calls the LLM asked for against the client-side cart,
// appends the results as messages, and returns them for a follow-up call.
async function runToolCalls(toolCalls) {
  const extra = [];
  const trace = [];
  for (const tc of toolCalls) {
    const t0 = performance.now();
    const { result, error } = await dispatch(tc.name, tc.args || {});
    const ms = performance.now() - t0;
    trace.push({ name: tc.name, args: tc.args, ms });
    extra.push({ role: "assistant", content: `[Calling tool ${tc.name}(${JSON.stringify(tc.args || {})})]` });
    extra.push({ role: "user", content: `[Tool ${tc.name} result: ${JSON.stringify(error ? { error } : result)}]` });
  }
  return { extra, trace };
}

async function sendBatch(message) {
  state.messages.push({ role: "user", content: message });
  const el = addMsg("assistant", "...");
  const t0 = performance.now();
  let data = await callLlm(llmPayload());
  let trace = [];
  if (data.tool_calls?.length) {
    const { extra, trace: t } = await runToolCalls(data.tool_calls);
    trace = t;
    data = await callLlm(llmPayload(extra));
  }
  const total = performance.now() - t0;
  if (data.error) { el.className = "msg msg-error"; el.textContent = data.error; return; }
  el.textContent = data.reply;
  state.messages.push({ role: "assistant", content: data.reply });
  renderLatency({ rag_ms: data.rag_latency_ms, llm_ms: data.latency_ms, total_ms: total });
  renderMeta($("model").value, trace);
  setCmp("batch", total, total);
}

async function callLlm(payload) {
  const r = await fetch(state.base + "/api/llm", { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) });
  return r.json();
}

async function sendStream(message) {
  state.messages.push({ role: "user", content: message });
  const el = addMsg("assistant", "");
  el.innerHTML = '<span class="cursor">_</span>';
  const t0 = performance.now();
  let ttft = 0;
  const { text: acc, meta } = await streamOnce(llmPayload(), el, (t) => { if (!ttft) ttft = t; });
  let full = acc, trace = [];
  if (meta.tool_calls?.length) {
    const { extra, trace: t } = await runToolCalls(meta.tool_calls);
    trace = t;
    el.textContent = "";
    const r2 = await streamOnce(llmPayload(extra), el, () => {});
    full = r2.text;
  }
  const total = performance.now() - t0;
  state.messages.push({ role: "assistant", content: full });
  renderLatency({ rag_ms: meta.rag_latency_ms, llm_ms: meta.latency_ms, total_ms: total });
  renderMeta($("model").value, trace);
  setCmp("stream", ttft - t0, total);
}

async function streamOnce(payload, el, onFirstToken) {
  const r = await fetch(state.base + "/api/llm/stream", { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) });
  if (!r.ok || !r.body) { el.className = "msg msg-error"; el.textContent = "Stream failed (" + r.status + ")"; return { text: "", meta: {} }; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", acc = "";
  const meta = { tool_calls: [] };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === "token") {
        if (!acc) onFirstToken(performance.now());
        acc += ev.data; el.textContent = acc; $("messages").scrollTop = $("messages").scrollHeight;
      } else if (ev.type === "tool_call") {
        meta.tool_calls.push(ev.data);
      } else if (ev.type === "error") {
        el.className = "msg msg-error"; el.textContent = ev.data;
      } else if (ev.type === "done") {
        meta.latency_ms = ev.data.latency_ms; meta.rag_latency_ms = ev.data.rag_latency_ms;
      }
    }
  }
  return { text: acc, meta };
}

async function onSend(message) {
  addMsg("user", message);
  setBusy(true);
  try {
    if (state.compareNext) {
      await sendBatch(message);
      await sendStream(message);
      state.compareNext = false; $("compareBtn").classList.remove("active");
    } else if (state.mode === "stream") {
      await sendStream(message);
    } else {
      await sendBatch(message);
    }
  } catch (e) {
    addMsg("error", "Request failed: " + e.message + " (is the backend running at " + state.base + "?)");
  } finally {
    setBusy(false);
    refreshCart();
  }
}

function setBusy(b) {
  $("input").disabled = b;
  document.querySelector("#composer button").disabled = b;
  if (!b) $("input").focus();
}

// ---- health + models ----
async function refreshHealth() {
  try {
    const r = await fetch(state.base + "/api/health");
    const d = await r.json();
    $("health").className = "pill pill-ok";
    $("health").textContent = `backend ok · RAG ${d.rag_ready ? "ready" : "not ready"}`;
  } catch {
    $("health").className = "pill pill-bad";
    $("health").textContent = "backend unreachable";
  }
}
function loadModels() {
  $("model").innerHTML = "";
  for (const m of MODELS) {
    const o = document.createElement("option");
    const hasKey = !!state.keys[m.provider];
    o.value = m.key; o.textContent = m.label + (hasKey ? "" : " (no key)");
    $("model").append(o);
  }
}

async function refreshRagStatus() {
  try {
    const r = await fetch(state.base + "/api/rag/vectors");
    const d = await r.json();
    if (d.points) {
      $("ragStatus").textContent = `index: ${d.chunks} chunks · ${d.model} (${d.dim}-d) · ${d.profile}`;
      $("rrLabel").textContent = d.profile === "rich" ? "(cross-encoder)" : "(LLM rerank, adds latency)";
    } else {
      $("ragStatus").innerHTML = 'index not built. <a href="rag.html" target="_blank">Build it &#8599;</a>';
    }
  } catch { $("ragStatus").textContent = "index status unavailable"; }
}

async function loadTools() {
  try {
    const r = await fetch(state.base + "/api/tools");
    const d = await r.json();
    $("toolList").innerHTML = "";
    for (const t of d.tools) {
      const lab = document.createElement("label");
      lab.innerHTML = `<input type="checkbox" value="${t.name}" checked /><span><span class="tname">${t.name}</span> - ${t.description}</span>`;
      $("toolList").append(lab);
    }
  } catch { /* ignore */ }
}

// ---- wiring ----
function seg(id, onPick) {
  $(id).querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      $(id).querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active"); onPick(b.dataset.v);
    }));
}

function initSettings() {
  const dlg = $("settings");
  $("settingsBtn").addEventListener("click", () => {
    $("k_openai").value = state.keys.openai || "";
    $("k_gemini").value = state.keys.gemini || "";
    $("k_anthropic").value = state.keys.anthropic || "";
    $("k_elevenlabs").value = state.keys.elevenlabs || "";
    $("apiBase").value = state.base;
    dlg.showModal();
  });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue !== "save") return;
    state.keys = {
      openai: $("k_openai").value.trim(), gemini: $("k_gemini").value.trim(),
      anthropic: $("k_anthropic").value.trim(), elevenlabs: $("k_elevenlabs").value.trim(),
    };
    localStorage.setItem(LS_KEYS, JSON.stringify(state.keys));
    state.base = $("apiBase").value.trim() || DEFAULT_BASE;
    localStorage.setItem(LS_BASE, state.base);
    loadModels(); refreshHealth();
  });
}

function init() {
  seg("mode", (v) => { state.mode = v; });
  seg("length", (v) => { state.length = v; persistConfig(); });
  $("verbatim").addEventListener("input", (e) => $("vbVal").textContent = e.target.value);
  $("temp").addEventListener("input", (e) => $("tempVal").textContent = (e.target.value / 10).toFixed(1));
  $("topk").addEventListener("input", (e) => $("kVal").textContent = e.target.value);
  seg("knowledge", (v) => {
    state.knowledge = v;
    $("ragOpts").hidden = v !== "rag";
    $("ctxHint").textContent = {
      ragless: "RAGless: the full knowledge base (context.md) is injected (large prompt).",
      rag: "RAG: top-k retrieved chunks are injected (smaller prompt, retrieval latency).",
      none: "No knowledge injected: the agent uses the model's own knowledge only.",
    }[v];
    if (v === "rag") refreshRagStatus();
    persistConfig();
  });
  const controlsPanel = document.querySelector(".controls");
  controlsPanel.addEventListener("change", persistConfig);
  controlsPanel.addEventListener("input", persistConfig);
  $("compareBtn").addEventListener("click", () => {
    state.compareNext = !state.compareNext;
    $("compareBtn").classList.toggle("active", state.compareNext);
  });
  $("toolsEnabled").addEventListener("change", (e) => { $("toolsBox").hidden = !e.target.checked; });
  $("toolAll").addEventListener("click", (e) => { e.preventDefault(); document.querySelectorAll("#toolList input").forEach((c) => c.checked = true); });
  $("toolNone").addEventListener("click", (e) => { e.preventDefault(); document.querySelectorAll("#toolList input").forEach((c) => c.checked = false); });
  $("resetBtn").addEventListener("click", () => {
    state.messages = [];
    $("messages").innerHTML = '<div class="msg msg-system">Conversation reset.</div>';
    refreshCart(); renderTrace([]);
  });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("input").value.trim();
    if (!v) return;
    $("input").value = "";
    onSend(v);
  });
  initSettings();
  $("ragOpts").hidden = state.knowledge !== "rag";
  $("toolsBox").hidden = !$("toolsEnabled").checked;
  if (state.knowledge === "rag") refreshRagStatus();
  refreshHealth(); loadModels(); loadTools().then(persistConfig); refreshCart();
  persistConfig();
}

init();
