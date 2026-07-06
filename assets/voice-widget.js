/**
 * Floating voice agent widget for the Nimbus landing page.
 * Creates the .voice-fab button + .voice-panel drawer.
 * Uses WebSocket session with sensible defaults.
 * API keys and settings are read from localStorage keys set by the
 * playground pages: "nimbus_pg_keys" (API keys), "nimbus_pg_base"
 * (backend URL), "nimbus_agent_config" (provider/model/knowledge/tools/etc).
 */

// Set by assets/runtime-config.js in production; falls back to localhost locally.
const BACKEND =
  typeof window !== "undefined" &&
  window.NIMBUS_API_BASE &&
  !window.NIMBUS_API_BASE.includes("REPLACE-ME")
    ? window.NIMBUS_API_BASE
    : "http://localhost:8000";
const CART_KEY = "nimbus_cart";

function getKeys() {
  try { return JSON.parse(localStorage.getItem("nimbus_pg_keys") || "{}"); } catch { return {}; }
}
function getBackendUrl() {
  return localStorage.getItem("nimbus_pg_base") || BACKEND;
}
function getAgentConfig() {
  try { return JSON.parse(localStorage.getItem("nimbus_agent_config") || "{}"); } catch { return {}; }
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ── DOM ── */
function mount() {
  // Fab button
  const fab = document.createElement("button");
  fab.className = "voice-fab";
  fab.title = "Talk to Nimbus Assistant";
  fab.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
  document.body.appendChild(fab);

  // Panel
  const panel = document.createElement("div");
  panel.className = "voice-panel";
  panel.innerHTML = `
    <header>
      <span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:17px;height:17px;vertical-align:-3px;margin-right:.35rem;"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
        Nimbus Assistant
      </span>
      <button class="vp-x" id="vp-close" aria-label="Close">✕</button>
    </header>
    <div class="vp-status" id="vp-status">Idle — press mic to talk</div>
    <div class="vp-log" id="vp-log"></div>
    <div class="vp-controls">
      <button class="vp-mic" id="vp-mic" title="Push to talk">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
      </button>
      <input class="inp" id="vp-text" placeholder="Or type a question…" style="flex:1;font-size:.85rem;" />
      <button class="btn btn-primary btn-sm" id="vp-send">Send</button>
    </div>
    <a class="vp-link muted" href="playground/playground.html">Open full playground →</a>`;
  document.body.appendChild(panel);

  // Toggle
  fab.addEventListener("click", () => panel.classList.toggle("open"));
  panel.querySelector("#vp-close").addEventListener("click", () => panel.classList.remove("open"));

  // Text send
  const textInp = panel.querySelector("#vp-text");
  panel.querySelector("#vp-send").addEventListener("click", () => _sendText(panel, textInp));
  textInp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") _sendText(panel, textInp);
  });

  // Mic button — voice via WebSocket
  let _session = null;
  panel.querySelector("#vp-mic").addEventListener("click", async () => {
    if (!_session) {
      try {
        const keys = getKeys();
        const cfg = getAgentConfig();
        const { WsSession } = await import("./playground/ws-client.js");
        _session = new WsSession({
          backendUrl: getBackendUrl(),
          config: {
            openaiKey: keys.openai || "",
            googleKey: keys.gemini || "",
            elevenLabsKey: keys.elevenlabs || "",
            anthropicKey: keys.anthropic || "",
            asrProvider: cfg.asr || "browser",
            asrLanguage: "en-US",
            llmProvider: cfg.provider || "openai",
            llmModel: cfg.model || "gpt-4o-mini",
            ttsProvider: cfg.tts || "openai",
            ttsVoice: cfg.voice || "alloy",
            ragEnabled: false,
            toolsEnabled: ["get_cart_total", "add_to_cart", "get_cart_items", "get_pricing_annual", "calculate_savings"],
            llmHistoryN: 5,
            llmSystemPrompt: cfg.system_prompt || "You are Nimbus Assistant, a helpful voice agent for the Nimbus cloud software suite. Be concise and friendly. Help users with products, pricing, and cart.",
            vadEndpointMs: cfg.endpoint || 500,
            vadSensitivity: 0.015,
          },
          onStateChange: (state) => {
            const status = panel.querySelector("#vp-status");
            const mic = panel.querySelector("#vp-mic");
            const labels = { idle: "Idle — press mic to talk", listening: "Listening…", thinking: "Thinking…", searching: "Searching…", speaking: "Speaking…" };
            status.textContent = labels[state] || state;
            mic.classList.toggle("live", state === "listening");
          },
          onTranscript: (text, final) => {
            if (final && text) _appendLog(panel, "You", text);
          },
          onToken: (tok) => _appendToken(panel, tok),
          onTurnDone: () => {},
          onToolCall: (name, result) => {
            // Cart tools: refresh cart drawer if open
            if (["add_to_cart", "remove_from_cart", "clear_cart", "checkout_all"].includes(name)) {
              try { window._nimbusCartPaint?.(); } catch {}
            }
          },
        });
        await _session.connect();
      } catch (err) {
        _appendLog(panel, "Error", err.message);
        return;
      }
    }

    if (_session.listening) {
      _session.stopListening();
    } else {
      await _session.startListening();
    }
  });
}

let _agentBubble = null;

function _appendLog(panel, who, text) {
  const log = panel.querySelector("#vp-log");
  const line = document.createElement("div");
  line.className = `talk-line ${who === "You" ? "user" : "agent"}`;
  line.innerHTML = `<span class="who">${who === "You" ? "You" : "Nimbus"}</span><span class="talk-text">${esc(text)}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  if (who !== "You") _agentBubble = null;
}

function _appendToken(panel, tok) {
  const log = panel.querySelector("#vp-log");
  if (!_agentBubble) {
    _agentBubble = document.createElement("div");
    _agentBubble.className = "talk-line agent";
    _agentBubble.innerHTML = `<span class="who">Nimbus</span><span class="talk-text"></span>`;
    log.appendChild(_agentBubble);
  }
  _agentBubble.querySelector(".talk-text").textContent += tok;
  log.scrollTop = log.scrollHeight;
}

async function _sendText(panel, inp) {
  const text = inp.value.trim();
  if (!text) return;
  inp.value = "";
  _appendLog(panel, "You", text);
  const keys = getKeys();
  const cfg = getAgentConfig();

  try {
    const res = await fetch(`${getBackendUrl()}/api/llm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenAI-Key": keys.openai || "",
        "X-Google-Key": keys.gemini || "",
        "X-Anthropic-Key": keys.anthropic || "",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: text }],
        provider: cfg.provider || "openai",
        model: cfg.model || "gpt-4o-mini",
        system_prompt: cfg.system_prompt || "You are Nimbus Assistant. Be concise and helpful.",
        response_length: cfg.response_length || "medium",
        use_rag: cfg.knowledge === "rag",
        use_context: cfg.knowledge === "ragless",
        top_k: cfg.top_k || 5,
        rerank: cfg.rerank || false,
        temperature: cfg.temperature ?? 0.7,
      }),
    });
    const data = await res.json();
    if (data.reply) _appendLog(panel, "Nimbus", data.reply);
  } catch (err) {
    _appendLog(panel, "Error", err.message);
  }
}

// Auto-mount when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
