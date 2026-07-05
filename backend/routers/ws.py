"""
WebSocket endpoint for full-duplex voice sessions.

Client → Server messages (JSON):
  { type: "config", data: { provider, model, ... } }
  { type: "audio_chunk", data: "<base64>" }
  { type: "vad_end" }
  { type: "interrupt" }
  { type: "tool_result", data: { name, result, id } }

Server → Client messages (JSON):
  { type: "asr_partial", text }
  { type: "asr_final", text, latency_ms }
  { type: "llm_token", text }
  { type: "llm_done", text, latency_ms, tool_calls }
  { type: "tts_chunk", audio_b64, latency_ms }
  { type: "tts_done" }
  { type: "latency_report", breakdown }
  { type: "error", message }
"""

import asyncio
import base64
import json
import time
import traceback
import uuid
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()


class Session:
    def __init__(self, ws: WebSocket, session_id: str):
        self.ws = ws
        self.id = session_id
        self.config: dict = {}
        self.audio_buf: list[bytes] = []
        self.pipeline_task: Optional[asyncio.Task] = None
        self.tts_task: Optional[asyncio.Task] = None
        self.interrupted = False
        self.pending_tool_results: dict[str, asyncio.Future] = {}

    async def send(self, msg: dict):
        try:
            await self.ws.send_text(json.dumps(msg))
        except Exception:
            pass

    def get_key(self, name: str) -> Optional[str]:
        return self.config.get(name) or None


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    session = Session(ws, str(uuid.uuid4()))

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            mtype = msg.get("type")

            if mtype == "config":
                session.config = msg.get("data", {})

            elif mtype == "audio_chunk":
                chunk = base64.b64decode(msg.get("data", ""))
                session.audio_buf.append(chunk)

            elif mtype == "vad_end":
                if session.pipeline_task and not session.pipeline_task.done():
                    session.pipeline_task.cancel()
                audio = b"".join(session.audio_buf)
                session.audio_buf = []
                session.interrupted = False
                session.pipeline_task = asyncio.create_task(_run_pipeline(session, audio))

            elif mtype == "interrupt":
                session.interrupted = True
                if session.tts_task and not session.tts_task.done():
                    session.tts_task.cancel()
                await session.send({"type": "interrupted"})

            elif mtype == "tool_result":
                data = msg.get("data", {})
                tool_id = data.get("id", data.get("name", ""))
                fut = session.pending_tool_results.get(tool_id)
                if fut and not fut.done():
                    fut.set_result(data.get("result"))

    except WebSocketDisconnect:
        pass
    except Exception as e:
        await session.send({"type": "error", "message": str(e)})
    finally:
        if session.pipeline_task:
            session.pipeline_task.cancel()


async def _run_pipeline(session: Session, audio: bytes):
    try:
        await _run_pipeline_inner(session, audio)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        traceback.print_exc()
        await session.send({"type": "error", "message": f"Pipeline error: {e}"})


async def _run_pipeline_inner(session: Session, audio: bytes):
    lap = {}
    t_start = time.perf_counter()

    # ── 1. ASR ──
    t_asr = time.perf_counter()
    transcript = await _asr(session, audio)
    lap["asr"] = int((time.perf_counter() - t_asr) * 1000)

    if not transcript:
        await session.send({"type": "error", "message": "Could not transcribe audio"})
        return

    await session.send({"type": "asr_final", "text": transcript, "latency_ms": lap["asr"]})

    # ── 2. RAG (optional) ──
    rag_context = ""
    if session.config.get("ragEnabled"):
        t_rag = time.perf_counter()
        rag_context = await _rag(session, transcript)
        lap["rag"] = int((time.perf_counter() - t_rag) * 1000)

    # ── 3. LLM ──
    from backend.services import history as hist
    from backend.services.llm_providers import get_streamer, LENGTH_TOKENS

    hist.add_turn(session.id, "user", transcript)
    messages = hist.get_messages(
        session.id,
        system_prompt=session.config.get("llmSystemPrompt", "You are Nimbus Assistant."),
        verbatim_n=session.config.get("llmHistoryN", 5),
        rag_context=rag_context or None,
    )

    provider = session.config.get("llmProvider", "openai")
    model = session.config.get("llmModel", "gpt-4o-mini")
    max_tokens = LENGTH_TOKENS.get(session.config.get("llmResponseLength", "medium"), 300)
    tools_enabled = session.config.get("toolsEnabled", [])

    streamer = get_streamer(provider)
    api_key = session.config.get("openaiKey") or session.config.get("googleKey") or session.config.get("anthropicKey")

    t_llm = time.perf_counter()
    full_text = ""
    tool_calls_seen = []

    if streamer:
        async for event in streamer(messages, model, max_tokens, tools_enabled, api_key):
            if session.interrupted:
                full_text += " [cancelled by the user]"
                break
            if event["type"] == "token":
                full_text += event["data"]
                await session.send({"type": "llm_token", "text": event["data"]})
            elif event["type"] == "tool_call":
                tc = event["data"]
                tool_calls_seen.append(tc)
                # Ask client to execute the tool
                fut: asyncio.Future = asyncio.get_event_loop().create_future()
                session.pending_tool_results[tc.get("id", tc["name"])] = fut
                await session.send({"type": "tool_call", "data": tc})
                try:
                    result = await asyncio.wait_for(fut, timeout=5.0)
                    tc["result"] = result
                    # Append tool result as a user turn so LLM context is correct
                    hist.add_turn(session.id, "user", f"[Tool {tc['name']} result: {json.dumps(result)}]")
                except asyncio.TimeoutError:
                    tc["result"] = None

    lap["llm"] = int((time.perf_counter() - t_llm) * 1000)

    hist.add_turn(session.id, "assistant", full_text)
    await session.send({"type": "llm_done", "text": full_text, "latency_ms": lap["llm"], "tool_calls": tool_calls_seen})

    # ── 4. TTS ──
    if full_text and not session.interrupted:
        t_tts = time.perf_counter()
        session.tts_task = asyncio.create_task(_tts_and_stream(session, full_text, t_tts, lap))
        await session.tts_task
    else:
        lap["tts"] = 0

    # ── Latency report ──
    lap["total"] = int((time.perf_counter() - t_start) * 1000)
    await session.send({"type": "latency_report", "breakdown": lap})


async def _asr(session: Session, audio: bytes) -> str:
    provider = session.config.get("asrProvider", "openai")
    lang = session.config.get("asrLanguage", "en-US")
    from backend.services import asr_providers as ap

    try:
        if provider == "openai":
            r = await ap.transcribe_openai(audio, lang, session.get_key("openaiKey"))
        elif provider == "gemini":
            r = await ap.transcribe_gemini(audio, lang, session.get_key("googleKey"))
        elif provider == "elevenlabs":
            r = await ap.transcribe_elevenlabs(audio, lang, session.get_key("elevenLabsKey"))
        else:
            return ""
        return r.get("transcript", "")
    except Exception as e:
        await session.send({"type": "error", "message": f"ASR error: {e}"})
        return ""


async def _rag(session: Session, query: str) -> str:
    from backend.services.retriever import search
    from backend.services.embedder import index_ready
    if not index_ready():
        return ""
    try:
        chunks, _ = search(
            query,
            top_k=session.config.get("ragTopK", 5),
            rerank=session.config.get("ragRerank", False),
            embedding_model=session.config.get("ragEmbeddingModel", "all-MiniLM-L6-v2"),
        )
        return "\n\n".join(c["text"] for c in chunks)
    except Exception:
        return ""


async def _tts_and_stream(session: Session, text: str, t_tts: float, lap: dict):
    provider = session.config.get("ttsProvider", "openai")
    voice = session.config.get("ttsVoice", "alloy")
    from backend.services.tts_providers import get_synth
    synth = get_synth(provider)
    if not synth:
        return

    key_map = {
        "openai": session.get_key("openaiKey"),
        "gemini": session.get_key("googleKey"),
        "elevenlabs": session.get_key("elevenLabsKey"),
    }
    try:
        audio_bytes = await synth(text, voice, key_map.get(provider))
        lap["tts"] = int((time.perf_counter() - t_tts) * 1000)
        # Send as single chunk (browser handles buffering)
        b64 = base64.b64encode(audio_bytes).decode()
        await session.send({"type": "tts_chunk", "audio_b64": b64, "latency_ms": lap["tts"]})
        await session.send({"type": "tts_done"})
    except asyncio.CancelledError:
        lap["tts"] = int((time.perf_counter() - t_tts) * 1000)
    except Exception as e:
        await session.send({"type": "error", "message": f"TTS error: {e}"})
        lap["tts"] = 0
