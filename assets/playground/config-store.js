const KEY = "nimbus_playground_config";

const DEFAULTS = {
  openaiKey: "",
  googleKey: "",
  elevenLabsKey: "",
  anthropicKey: "",
  backendUrl: "http://localhost:8000",

  asrProvider: "browser",
  asrLanguage: "en-US",

  llmProvider: "openai",
  llmModel: "gpt-4o-mini",
  llmMode: "streaming",
  llmResponseLength: "medium",
  llmHistoryN: 5,
  llmSystemPrompt: `You are Nimbus Assistant, a helpful voice agent for the Nimbus cloud software suite.
Answer questions about Nimbus products, pricing, policies, and help users manage their cart.
Be concise and conversational. When asked about specific products or pricing, use the retrieved context.
For cart operations, use the appropriate tool.`,

  ragEnabled: true,
  ragTopK: 5,
  ragRerank: false,
  ragEmbeddingModel: "all-MiniLM-L6-v2",

  ttsProvider: "openai",
  ttsVoice: "alloy",
  ttsBuffer: true,

  toolsEnabled: [
    "get_cart_total",
    "add_to_cart",
    "remove_from_cart",
    "clear_cart",
    "checkout_all",
    "get_pricing_annual",
    "calculate_savings",
    "sort_products",
    "get_top_k_expensive",
    "get_cart_items",
    "checkout_item",
  ],

  vadEndpointMs: 500,
  vadSensitivity: 0.015,
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(cfg) {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}

let _cfg = load();

export function getConfig() {
  return { ..._cfg };
}

export function get(key) {
  return _cfg[key];
}

export function set(key, value) {
  _cfg[key] = value;
  save(_cfg);
}

export function setMany(updates) {
  Object.assign(_cfg, updates);
  save(_cfg);
}

export { DEFAULTS };
