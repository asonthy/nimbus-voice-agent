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

- **Backend:** Python + FastAPI (`backend/`) on Railway. One WebSocket
  (`/api/ws`) carries the streaming voice loop; REST (`/api/asr`, `/api/llm`,
  `/api/tts`, `/api/rag`) covers standalone per-stage testing. Per-stage timing
  baked into every WS turn.
- **Frontend:** the existing static site (unchanged catalog pages) plus a
  `playground/` folder with three entry pages, deployed on Vercel.
- **Vector store:** FAISS (local file index under `backend/data/`), built from
  `context/` on first run.

## Repository layout (as built)

```
.
├── index.html, products.html, product.html, pricing.html,   # unchanged static catalog
│   support.html, about.html
├── data/catalog.json                # single source of truth for the catalog
├── context/                          # scraped/authored corpus the RAG index is built from
├── assets/
│   ├── app.js, render.js, styles.css, cart.js, voice-widget.js  # site + landing-page voice widget
│   ├── runtime-config.js            # sets window.NIMBUS_API_BASE (prod backend URL); edit after deploy
│   └── playground/
│       ├── playground.js            # tab-based SPA: Keys, ASR, LLM, RAG, TTS, Tools, VAD, Latency, RAG Viz, Talk
│       ├── config-store.js          # localStorage-backed config (keys, backend URL, per-stage settings)
│       ├── ws-client.js             # WsSession: mic -> MediaRecorder -> WS -> ASR/LLM/TTS playback
│       ├── vad.js                   # client-side voice-activity endpointing
│       ├── rag-viz.js, latency.js, tools.js
├── playground/
│   ├── playground.html              # full control panel (all tabs, default = Keys)
│   ├── voice.html                   # same app, opens straight to the Talk tab
│   └── rag.html                     # same app, opens straight to the RAG Viz tab
├── backend/
│   ├── main.py                      # FastAPI app, CORS, lifespan (loads/builds FAISS index)
│   ├── routers/                     # asr.py, llm.py, tts.py, rag.py, ws.py, config.py
│   ├── services/
│   │   ├── asr_providers.py         # openai (whisper), gemini, elevenlabs
│   │   ├── llm_providers.py         # openai, gemini, anthropic streaming + tool-call schemas
│   │   ├── tts_providers.py         # openai, gemini, elevenlabs
│   │   ├── audio_utils.py           # webm -> wav via bundled ffmpeg (imageio-ffmpeg), for Gemini ASR
│   │   ├── embedder.py, retriever.py, scraper.py   # chunk/embed/index/retrieve + rerank; EMBEDDING_PROFILE-aware
│   │   └── history.py               # verbatim-N turns + LLM-summarized older turns
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

---

## Phase 0: Scaffold + corpus — done

- FastAPI app with `/api/health`, `.env`-based key loading, CORS open for the
  playground's cross-origin calls.
- `context/` holds the corpus the RAG index is built from; `backend/services/embedder.py`
  builds/loads the FAISS index at startup (`load_or_build_index`).

## Phase 1: LLM core + text/turn pipeline — done

- Provider adapters for OpenAI, Gemini, and Anthropic, unified behind
  `get_streamer(provider)` yielding `{type: "token"|"tool_call", ...}` events.
- **Streaming mode** over the WebSocket (`llm_token` events); response length
  (low/medium/high) maps to `max_tokens`.
- **System prompt** editable from the **LLM** tab.
- **History:** last *N* turns verbatim (slider), older turns summarized via a
  cheap `gpt-4o-mini` call (`services/history.py:maybe_compress`).
- Per-turn latency (`asr`, `rag`, `llm`, `tts`, `total`) sent as `latency_report`.

## Phase 2: Tools — done

11 tools, individually toggleable from the **Tools** tab: `get_cart_total`,
`add_to_cart`, `remove_from_cart`, `clear_cart`, `checkout_item`,
`checkout_all`, `get_pricing_annual`, `calculate_savings`, `sort_products`,
`get_top_k_expensive`, `get_cart_items`.

- Tool schemas defined once (`llm_providers.TOOL_SCHEMAS`) and translated
  per-provider (OpenAI function-calling shape, Anthropic tool shape).
- Tool execution happens **client-side** (`assets/playground/tools.js`,
  dispatched over the WS `tool_call`/`tool_result` messages) against the same
  `nimbus_cart` the site uses — so cart state stays in sync with the page.

## Phase 3: RAG — done

- `services/embedder.py` / `retriever.py`: chunk + embed + FAISS top-k +
  optional rerank (`ragRerank` toggle, reranks `top_k * 3` candidates down to
  `top_k`). Embedding model and rerank strategy both follow `EMBEDDING_PROFILE`
  (`rich` = MiniLM + cross-encoder locally, `light` = OpenAI embeddings + LLM
  rerank on Railway) — same interface either way.
- RAG on/off, top-k, and rerank are all playground-configurable; `rag_ms` is
  reported per turn.
- **RAG Viz** (`playground/rag.html`): 2D PCA projection of every chunk
  vector, live query overlay + nearest-k highlight, index rebuild button.

## Phase 4: Voice (ASR + TTS + the loop) — done

- **ASR:** browser (Web Speech API, client-side, standalone test panel only)
  + OpenAI Whisper + Gemini + ElevenLabs (server-side, used by the Talk page).
  Gemini doesn't accept the browser's webm/opus directly, so it's transcoded
  to wav first via a bundled ffmpeg binary (`imageio-ffmpeg` — no system
  package needed; ships a Linux binary so this works on Railway, logs a
  warning and no-ops on platforms without a matching wheel, e.g. macOS arm64).
- **TTS:** OpenAI + Gemini + ElevenLabs.
- **Voice loop over `/api/ws`:** mic → client-side VAD endpointing → `vad_end`
  → ASR → (RAG?) → LLM (stream) → tool loop → TTS → playback. One click starts
  a continuous session; VAD auto-detects each utterance boundary, so no
  per-turn clicking is needed.
- **Barge-in / interrupt:** speaking during TTS playback stops it immediately
  and appends `[cancelled by the user]` to history.
- **Latency dashboard** (**Latency** tab): stage breakdown per turn, history
  across turns.

## Phase 5: Landing chatbox + deploy — done

- `assets/voice-widget.js`: a floating "Talk to Nimbus" widget on the catalog
  pages, using the same `localStorage` config as the playground, linking to
  `playground/playground.html`.
- Deployed: static site + `playground/` on **Vercel** (`.vercelignore` keeps
  the Python backend out of the build); backend on **Railway**
  (`railway.json`/`Procfile` install `backend/requirements-light.txt` and run
  `uvicorn backend.main:app` with `EMBEDDING_PROFILE=light` set in the
  dashboard). Default backend URL comes from `assets/runtime-config.js`
  (`window.NIMBUS_API_BASE`, edited once after deploy); anyone can still
  override it per-browser via the playground's Keys page (`localStorage`).

---

## Latency model (consistent everywhere)

Every WS turn ends with a `latency_report`:

```json
{ "asr": 0, "rag": 0, "llm": 0, "tts": 0, "total": 0 }
```

The **Talk** page shows this inline (`E2E / ASR / LLM / TTS`); the
**Latency** tab charts it across turns.

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
