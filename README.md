# Nimbus: a fictitious SaaS website (voice-agent starter)

This is a static marketing/catalog website for **Nimbus**, a made-up all-in-one
business software suite (think a fictional Zoho / Salesforce). It is the
**starting point for the Voice Agents bootcamp build**: a real product surface
that you will point a voice agent at.

There is **no voice agent in this repo** on purpose. You add it. The site gives
you the company, the catalog, the pricing, and the policies that your agent will
answer questions about and act on.

## What's here

```
.
├── index.html        # home
├── products.html     # filterable catalog (?cat=<id>)
├── product.html      # product detail (?id=<slug>)
├── pricing.html      # plan model + per-product starting prices
├── support.html      # refund / SLA / billing / security policies + FAQs
├── about.html        # company profile
├── assets/
│   ├── styles.css    # design system
│   ├── app.js        # catalog loader, shared layout (nav/footer), helpers
│   ├── render.js     # per-page renderers
│   └── favicon.svg
└── data/
    └── catalog.json  # single source of truth: company + policies + products
```

Everything is driven by `data/catalog.json`. There is **no build step** and **no
backend**: plain HTML, CSS, and ES modules.

## Run locally

`fetch()` needs HTTP (not `file://`), so serve the folder:

```bash
python3 -m http.server 8080
# then open http://localhost:8080/
```

A voice-agent backend (FastAPI, under `backend/`) and a playground UI
(under `playground/`) have since been added on top of the static site — see
below for how to run and test them.

## Restarting the backend + frontend

Easiest: run the helper script from the repo root, which kills whatever's
listening on 8000/8080 and relaunches both, logging to `.logs/`:

```bash
./restart.sh
```

To do it manually instead:

```bash
# stop whatever's currently listening
lsof -ti tcp:8000 -sTCP:LISTEN | xargs kill
lsof -ti tcp:8080 -sTCP:LISTEN | xargs kill

# backend (from repo root, using the venv under backend/.venv)
backend/.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload &

# frontend
python3 -m http.server 8080 &
```

Backend health check: `curl http://localhost:8000/api/health` should return
`{"status":"ok","rag_ready":true}`.

## Testing the playground

1. Start both services (`./restart.sh` or the manual commands above).
2. Open `http://localhost:8080/playground/playground.html`. Two focused
   entry points exist too: `playground/voice.html` opens straight to the
   **Talk** page, and `playground/rag.html` opens straight to **RAG Viz** —
   all three load the same app and share the same `localStorage` config.
3. On the **Keys** page, paste in the API key(s) for whichever ASR/LLM/TTS
   providers you've selected (OpenAI, Google, ElevenLabs, Anthropic). Keys are
   saved to `localStorage` in your browser, not read from `backend/.env` — you
   need to enter them here even if they're also set in `.env`.
4. Configure the **ASR**, **LLM**, **TTS**, and **RAG** pages as needed. For a
   full voice conversation on the **Talk** page, pick a real ASR provider
   (OpenAI Whisper / Gemini / ElevenLabs) — the "Browser (Web Speech API)"
   option only works on the standalone ASR test panel, not the Talk pipeline.
5. Go to **Talk** and click the mic button once. Speak, then pause — voice
   activity detection (VAD) automatically detects the end of your utterance
   and triggers the full ASR → RAG → LLM → TTS pipeline; you don't need to
   click again between turns. Click the mic a second time only to end the
   whole session (this discards any audio captured since the last pause).
6. Watch the transcript box, the pipeline stage indicator, and the live
   conversation log update as you talk.
7. If something seems stuck, open the browser console — `ws-client.js` logs
   WebSocket connect/open/close events, VAD `voice_start`/`voice_end`, and
   every message received from the backend.

## Deploying

The static site + playground go to **Vercel**; the FastAPI backend goes to
**Railway** (or any host that supports long-running processes and
WebSockets — Vercel's serverless functions don't, and the backend's
`torch`/`sentence-transformers`/`faiss-cpu` dependencies are far too large for
a Vercel function bundle anyway).

### Frontend → Vercel

1. Import this repo into Vercel. It's a zero-build static site, so the
   defaults work: no build command, no output directory override needed.
2. `.vercelignore` at the repo root already excludes `backend/`, `context/`,
   and other dev-only files so Vercel doesn't try to build the Python backend.
3. Once deployed, your pages are at `https://<project>.vercel.app/`,
   `.../playground/playground.html`, `.../playground/voice.html`, and
   `.../playground/rag.html`.

### Backend → Railway

1. Create a new Railway project from this repo. `railway.json` (and the
   equivalent `Procfile`) tell Railway to install
   `backend/requirements-light.txt` and start
   `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`.
2. Set environment variables in the Railway dashboard (not by uploading
   `.env` — it's gitignored and shouldn't be committed):
   - `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ELEVEN_LABS_API`, `ANTHROPIC_API_KEY`,
     `HF_TOKEN` as needed for the providers you use.
   - `EMBEDDING_PROFILE=light` — switches RAG from local
     `sentence-transformers`/cross-encoder (the `rich` default, used locally)
     to OpenAI `text-embedding-3-small` embeddings + LLM-based rerank (no
     `torch` needed at runtime). `requirements-light.txt` correspondingly
     drops `torch`/`sentence-transformers`/`transformers` from the install —
     keeps the Railway image small and cold start fast. Leave this var unset
     to run `rich` (e.g. if you switch the install command back to
     `requirements.txt`).
3. ffmpeg is bundled via the `imageio-ffmpeg` pip package (no system package
   needed) — used to transcode browser audio to a format Gemini ASR accepts.
   It ships a Linux binary, so this works on Railway out of the box; on
   platforms without a matching wheel (e.g. macOS arm64) the backend logs a
   warning and keeps running — only Gemini ASR is affected.
4. After deploy, Railway gives you a public URL
   (`https://<service>.up.railway.app`). CORS is already open (`allow_origins:
   ["*"]"` in `backend/main.py`), and the WS client upgrades `https://` to
   `wss://` automatically.

### Wiring frontend → backend in production

`assets/runtime-config.js` sets `window.NIMBUS_API_BASE`, read by both the
playground (`config-store.js`) and the landing-page widget
(`voice-widget.js`) as their default backend URL — it's included on
`index.html` and all three `playground/*.html` pages. After your first
Railway deploy, edit that one file to your Railway URL:

```js
window.NIMBUS_API_BASE = "https://<service>.up.railway.app";
```

Left as the `REPLACE-ME` placeholder, everything falls back to
`http://localhost:8000` for local dev. This only sets the *default* — anyone
can still override it per-browser from the playground's **Keys** page
(`localStorage`), no redeploy needed.

## Build a voice agent on top of it

This is where your work begins. A typical path:

1. Build a small backend (RAG over `data/catalog.json`, a few tools, an LLM).
2. Add a voice loop (speech-to-text -> LLM -> text-to-speech) with barge-in.
3. Drop a "talk to Nimbus" button on the site that calls your backend.

Keep your API keys private. Never commit keys to this public repo.

## Notes

- Nimbus is **not a real company**. Names, prices, and policies are invented for
  teaching.
- Pricing buttons are static links; there is no real cart or checkout (you can
  add one as a tool your agent drives).
