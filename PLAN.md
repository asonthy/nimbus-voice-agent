# Nimbus Voice Agent: Implementation Plan

A configurable voice-agent **playground** built on top of the static Nimbus site
(this repo). Every stage of the pipeline (ASR, RAG, LLM, tools, TTS) is
swappable from the frontend, and every stage reports its latency.

## Running this

### Locally

```bash
./restart.sh   # kills anything on :8000/:8080, then relaunches both
```

This starts the backend (`uvicorn backend.main:app --reload` on `:8000`,
logging to `.logs/backend.log`) and the static frontend
(`python3 -m http.server 8080`). Then open:

- `http://localhost:8080/playground/playground.html` — full control panel
- `http://localhost:8080/playground/voice.html` — opens straight to Talk
- `http://localhost:8080/playground/rag.html` — opens straight to RAG Viz

Enter provider API keys on the **Keys** page first (saved to `localStorage`,
not read from `backend/.env`). Doing it manually instead of via the script:

```bash
lsof -ti tcp:8000 -sTCP:LISTEN | xargs kill   # stop whatever's listening
lsof -ti tcp:8080 -sTCP:LISTEN | xargs kill
backend/.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload &
python3 -m http.server 8080 &
```

Full walkthrough (testing steps, debugging tips) is in `README.md`.

### On Vercel (frontend)

1. Import this repo into Vercel — zero-build static site, defaults work as-is.
2. `.vercelignore` already excludes `backend/`, `context/`, and dev-only files
   so Vercel only builds the static site + `playground/`.
3. Deployed pages: `https://<project>.vercel.app/`,
   `.../playground/playground.html`, `.../playground/voice.html`,
   `.../playground/rag.html`.
4. The backend still needs to run somewhere with persistent-process + WebSocket
   support (Railway — see `railway.json`/`Procfile`); once it's deployed, edit
   `assets/runtime-config.js` to set `window.NIMBUS_API_BASE` to the Railway
   URL (default for every visitor), or just set it per-browser from the
   deployed playground's **Keys** page → **Backend URL** (`localStorage`,
   no rebuild needed either way).

## Scope decisions (locked)

- **LLM providers:** OpenAI (`gpt-4o` / `gpt-4o-mini`), Gemini, and Anthropic —
  all three are implemented and swappable per-session.
- **Public phone number / telephony: out of scope** (no Twilio). Web + voice in
  the browser only.
- **Embedding + rerank are a pluggable profile** (`EMBEDDING_PROFILE` env var)
  so the backend can run light on Railway:
  - `rich` (default, local): `sentence-transformers` (`all-MiniLM-L6-v2`) +
    FAISS + cross-encoder rerank (`cross-encoder/ms-marco-MiniLM-L-6-v2`).
  - `light` (Railway): OpenAI `text-embedding-3-small` + FAISS + LLM rerank
    (`gpt-4o-mini`). No `torch`/`sentence-transformers` needed at runtime;
    `backend/requirements-light.txt` drops them from the install entirely.
  - Same `search()` / `_rerank()` interface either way — the profile only
    changes what's inside `embed_texts()` and `_rerank()`
    (`backend/services/embedder.py`, `retriever.py`).
- **Keys available:** OpenAI, Gemini, ElevenLabs, Anthropic, HF, Railway, Vercel.

## Stack

- **Backend:** Python + FastAPI (`backend/`) on Railway. Two ways to reach it:
  a WebSocket (`/api/ws`) carrying a server-orchestrated streaming voice loop,
  and a stateless REST surface (`/api/asr`, `/api/llm[/stream]`, `/api/tts`,
  `/api/rag/*`, `/api/tools`) that the playground pages orchestrate themselves
  turn-by-turn. Per-stage timing on both paths.
- **Frontend:** the existing static site (unchanged catalog pages) plus a
  `playground/` folder with three standalone pages, deployed on Vercel.
- **Vector store:** FAISS (local file index under `backend/data/`), built from
  `context/` on first run.

**Two parallel voice implementations, by design:**
1. **`/api/ws`** — mic → client VAD (`vad.js`) → one WS message per utterance →
   server runs ASR → RAG → LLM → tools → TTS and streams events back. Used
   only by the landing page's floating "Talk to Nimbus" widget
   (`voice-widget.js` + `ws-client.js`), where a lightweight always-on session
   is what you want.
2. **REST, client-orchestrated** — `playground/voice.html` (`voice.js`) drives
   the same stages as discrete calls (`/api/asr` → `/api/llm[/stream]` →
   `/api/tts`), managing conversation history and the tool-call round-trip
   itself in the browser, plus its own VAD/MediaRecorder/barge-in logic. This
   is the reference-matched design (see Repository layout) and is what you get
   full pipeline-stage control and the TTFA latency pie from.

## Repository layout (as built)

```
.
├── index.html, products.html, product.html, pricing.html,   # unchanged static catalog
│   support.html, about.html
├── data/catalog.json                # single source of truth for the catalog
├── context/                          # scraped/authored corpus the RAG index is built from
├── assets/
│   ├── app.js, render.js, styles.css, cart.js   # static site
│   ├── voice-widget.js              # landing-page floating widget, uses ws-client.js (the /api/ws path)
│   ├── runtime-config.js            # sets window.NIMBUS_API_BASE (prod backend URL); edit after deploy
│   └── playground/
│       ├── ws-client.js             # WsSession: mic -> MediaRecorder -> WS -> ASR/LLM/TTS playback
│       ├── vad.js                   # client-side voice-activity endpointing (used by ws-client.js)
│       └── tools.js                 # client-side tool execution against nimbus_cart; used by ws-client.js
│                                       AND by playground.js/voice.js (the REST path)
├── playground/                      # three standalone pages (own CSS/JS each, no shared SPA)
│   ├── playground.html, playground.css, playground.js   # text chat: batch/stream, tools, RAG, latency
│   ├── voice.html, voice.css, voice.js                   # full voice loop (REST-orchestrated, see Stack)
│   └── rag.html, rag.css, rag.js                         # vector scatter + live query highlight
├── backend/
│   ├── main.py                      # FastAPI app, CORS, lifespan (loads/builds FAISS index)
│   ├── routers/                     # asr.py, llm.py, tts.py, rag.py, ws.py, config.py
│   ├── services/
│   │   ├── asr_providers.py         # openai (whisper), gemini, elevenlabs
│   │   ├── llm_providers.py         # openai, gemini, anthropic streaming + tool-call schemas + TOOL_SCHEMAS
│   │   ├── tts_providers.py         # openai, gemini, elevenlabs
│   │   ├── audio_utils.py           # webm -> wav via bundled ffmpeg (imageio-ffmpeg), for Gemini ASR
│   │   ├── embedder.py, retriever.py, scraper.py   # chunk/embed/index/retrieve + rerank; EMBEDDING_PROFILE-aware
│   │   └── history.py               # verbatim-N turns + LLM-summarized older turns (used by the WS path only)
│   ├── data/                        # faiss.index, chunks_meta.json (gitignored, rebuilt on first run)
│   ├── requirements.txt             # full (rich profile): includes torch/sentence-transformers
│   └── requirements-light.txt       # light profile: no torch/sentence-transformers/transformers
├── railway.json, Procfile, .python-version   # backend deploy config (either works; same start command)
├── .vercelignore                    # excludes backend/, context/, dev-only files from the Vercel build
└── restart.sh                       # kills + relaunches backend (uvicorn --reload) + static frontend
```

The static site's cart (`assets/cart.js`, localStorage key `nimbus_cart`, item
shape `{product_id, product_name, tier, seats, price}`) is the shared cart.
Cart tools read/write the same shape so the site and the agent stay in sync.
The REST path (`playground.js`/`voice.js`) has no server-side session, so it
manages conversation history and tool-call follow-ups (execute client-side →
append result → re-call the LLM) itself, in the browser.

---

## Phase 0: Scaffold + corpus — done

- FastAPI app with `/api/health`, `.env`-based key loading, CORS open for the
  playground's cross-origin calls.
- `context/` holds the corpus the RAG index is built from; `backend/services/embedder.py`
  builds/loads the FAISS index at startup (`load_or_build_index`).

## Phase 1: LLM core + text/turn pipeline — done

- Provider adapters for OpenAI, Gemini, and Anthropic, unified behind
  `get_streamer(provider)` yielding `{type: "token"|"tool_call", ...}` events,
  with a `temperature` param threaded through to all three.
- `/api/llm` (batch) and `/api/llm/stream` (SSE) are stateless — callers pass
  the full `messages` array each time. `playground.html` (`playground.js`)
  manages that array client-side: a **Verbatim history** slider truncates to
  the last *N* messages (no server-side summarization on this path — that's
  a `history.py`-only feature, used by the WS path).
- **Streaming vs batch** compared side-by-side (TTFT + total) on the same page.
- **Knowledge source**: RAG (top-k retrieval), RAGless (`use_context` — the
  full `context/context.md` injected), or None.
- **System prompt** and **temperature** both editable from the page.

## Phase 2: Tools — done

11 tools: `get_cart_total`, `add_to_cart`, `remove_from_cart`, `clear_cart`,
`checkout_item`, `checkout_all`, `get_pricing_annual`, `calculate_savings`,
`sort_products`, `get_top_k_expensive`, `get_cart_items` — individually
toggleable, listed via `GET /api/tools` (serializes `llm_providers.TOOL_SCHEMAS`,
one definition shared by both the WS and REST paths).

- Tool schemas defined once and translated per-provider (OpenAI function-
  calling shape, Anthropic tool shape).
- Tool execution happens **client-side** (`assets/playground/tools.js`)
  against `nimbus_cart`, on both paths:
  - WS: dispatched over the `tool_call`/`tool_result` messages.
  - REST: `playground.js`/`voice.js` execute the tool, append the result as a
    message, and re-call `/api/llm[/stream]` for the final reply — since
    there's no session on this path, that round-trip is orchestrated in JS.

## Phase 3: RAG — done

- `services/embedder.py` / `retriever.py`: chunk + embed + FAISS top-k +
  optional rerank (reranks `top_k * 3` candidates down to `top_k`). Embedding
  model and rerank strategy both follow `EMBEDDING_PROFILE` (`rich` = MiniLM +
  cross-encoder locally, `light` = OpenAI embeddings + LLM rerank on Railway)
  — same interface either way. Each result carries its absolute chunk `id`.
- RAG on/off, top-k, and rerank are all playground-configurable; latency is
  reported per turn.
- **`playground/rag.html`** (`rag.js`): 2D PCA scatter of every chunk vector
  (colored by source category — products/pricing/faqs/policies/company),
  live query overlay with ranked connector lines to the retrieved points,
  hover-to-read-chunk, index rebuild button.

## Phase 4: Voice (ASR + TTS + the loop) — done

- **ASR:** browser (Web Speech API, client-side) + OpenAI Whisper + Gemini +
  ElevenLabs (server-side). Gemini doesn't accept the browser's webm/opus
  directly, so it's transcoded to wav first via a bundled ffmpeg binary
  (`imageio-ffmpeg` — no system package needed; ships a Linux binary so this
  works on Railway, logs a warning and no-ops on platforms without a matching
  wheel, e.g. macOS arm64).
- **TTS:** OpenAI + Gemini + ElevenLabs; `/api/tts` reports synth time via an
  `X-TTS-Ms` header.
- **`playground/voice.html`** (`voice.js`) is the full voice loop: mic →
  client VAD/MediaRecorder (or browser ASR) → `/api/asr` → `/api/llm[/stream]`
  (+ tool round-trip) → `/api/tts` → Web Audio queue playback. Endpoint
  silence and TTS pre-buffer are both sliders.
- **Barge-in:** an echo-aware double-talk detector (estimates how much of the
  mic signal is our own TTS output echoing back, flags the residual as user
  speech) with off/low/medium/high sensitivity presets; interrupting appends
  `[cancelled by the user]` to that turn instead of dropping it from history.
- **Latency pie** (**time-to-first-audio** breakdown: ASR/RAG/LLM/Tools/TTS/
  buffer/other) plus a batch-vs-streaming TTFA comparison table.
- The landing widget's mic button (`voice-widget.js`) instead uses the WS path
  (`/api/ws` → `ws-client.js`): one click starts a continuous session, VAD
  auto-detects each utterance boundary, no per-turn clicking — simpler, no
  latency dashboard, meant for a quick always-on chat bubble rather than the
  full pipeline-tuning page.

## Phase 5: Landing chatbox + deploy — done

- `assets/voice-widget.js`: a floating "Talk to Nimbus" widget on the catalog
  pages. Reads keys/settings from the same `localStorage` scheme as the
  playground (`nimbus_pg_keys`, `nimbus_pg_base`, `nimbus_agent_config`),
  links to `playground/playground.html`.
- Deployed: static site + `playground/` on **Vercel** (`.vercelignore` keeps
  the Python backend out of the build); backend on **Railway**
  (`railway.json`/`Procfile` install `backend/requirements-light.txt` and run
  `uvicorn backend.main:app` with `EMBEDDING_PROFILE=light` set in the
  dashboard). Default backend URL comes from `assets/runtime-config.js`
  (`window.NIMBUS_API_BASE`, edited once after deploy); anyone can still
  override it per-browser via the playground's Keys dialog (`localStorage`).

---

## Latency model

WS path: every turn ends with a `latency_report`
(`{ "asr": 0, "rag": 0, "llm": 0, "tts": 0, "total": 0 }`).

REST path: each response carries its own stage's latency (`/api/llm`'s
`latency_ms`/`rag_latency_ms`, `/api/tts`'s `X-TTS-Ms` header); `voice.js` and
`playground.js` combine these client-side into the same shape for their own
latency pie / bar-chart / TTFA-comparison displays.

## Out of scope (explicit)

- Public phone number / Twilio telephony.

## Open items / possible next steps

- The backend has no per-IP rate limiting; fine for a bootcamp demo, not for
  a public deploy with real keys behind it.
- `backend/routers/config.py`'s `/api/config/keys` endpoint (used previously
  to pre-fill the playground from `backend/.env`) is currently dead code — the
  frontend no longer calls it. Worth removing or repurposing.
- `imageio-ffmpeg` has no macOS arm64 wheel as of 0.5.1, so Gemini ASR's
  webm→wav conversion silently no-ops on Apple Silicon dev machines (logged
  warning at startup, everything else still works). Fine on Railway (Linux);
  install a system ffmpeg locally and set `IMAGEIO_FFMPEG_EXE` if you need to
  test Gemini ASR on Apple Silicon.
