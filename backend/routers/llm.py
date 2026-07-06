import json
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Header
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter()

CONTEXT_MD_PATH = Path(__file__).parent.parent.parent / "context" / "context.md"
_context_cache: Optional[str] = None


def _read_context() -> str:
    """Full corpus text for RAGless mode (see PLAN.md, Phase 0)."""
    global _context_cache
    if _context_cache is None:
        _context_cache = CONTEXT_MD_PATH.read_text() if CONTEXT_MD_PATH.exists() else ""
    return _context_cache


class LlmRequest(BaseModel):
    messages: list[dict]
    provider: str = "openai"
    model: str = "gpt-4o-mini"
    system_prompt: str = ""
    response_length: str = "medium"
    use_rag: bool = True
    use_context: bool = False
    top_k: int = 5
    rerank: bool = False
    embedding_model: str = "all-MiniLM-L6-v2"
    tools_enabled: list[str] = []
    temperature: float = 0.7
    streaming: bool = False
    session_id: Optional[str] = None


LENGTH_TOKENS = {"low": 80, "medium": 300, "high": 900}


@router.post("/llm")
async def llm_batch(
    req: LlmRequest,
    x_openai_key: Optional[str] = Header(None),
    x_google_key: Optional[str] = Header(None),
    x_anthropic_key: Optional[str] = Header(None),
):
    t0 = time.perf_counter()
    keys = {"openai": x_openai_key, "google": x_google_key, "anthropic": x_anthropic_key}

    rag_context, rag_latency = await _maybe_rag(req)
    messages = _build_messages(req, rag_context)
    max_tokens = LENGTH_TOKENS.get(req.response_length, 300)

    from backend.services.llm_providers import get_streamer
    streamer = get_streamer(req.provider)
    if not streamer:
        return {"reply": "", "error": f"Unknown provider: {req.provider}"}

    api_key = _pick_key(req.provider, keys)
    full_text = ""
    tool_calls = []

    async for event in streamer(messages, req.model, max_tokens, req.tools_enabled, api_key, req.temperature):
        if event["type"] == "token":
            full_text += event["data"]
        elif event["type"] == "tool_call":
            tool_calls.append(event["data"])

    return {
        "reply": full_text,
        "tool_calls": tool_calls,
        "rag_chunks": [],
        "latency_ms": int((time.perf_counter() - t0) * 1000),
        "rag_latency_ms": rag_latency,
    }


@router.post("/llm/stream")
async def llm_stream(
    req: LlmRequest,
    x_openai_key: Optional[str] = Header(None),
    x_google_key: Optional[str] = Header(None),
    x_anthropic_key: Optional[str] = Header(None),
):
    keys = {"openai": x_openai_key, "google": x_google_key, "anthropic": x_anthropic_key}

    rag_context, rag_latency = await _maybe_rag(req)
    messages = _build_messages(req, rag_context)
    max_tokens = LENGTH_TOKENS.get(req.response_length, 300)

    from backend.services.llm_providers import get_streamer
    streamer = get_streamer(req.provider)
    api_key = _pick_key(req.provider, keys)

    async def _generate():
        t0 = time.perf_counter()
        if not streamer:
            yield f"data: {json.dumps({'type': 'error', 'data': f'Unknown provider: {req.provider}'})}\n\n"
            return
        async for event in streamer(messages, req.model, max_tokens, req.tools_enabled, api_key, req.temperature):
            yield f"data: {json.dumps(event)}\n\n"
        done_event = {
            "type": "done",
            "data": {"latency_ms": int((time.perf_counter() - t0) * 1000), "rag_latency_ms": rag_latency},
        }
        yield f"data: {json.dumps(done_event)}\n\n"

    return StreamingResponse(_generate(), media_type="text/event-stream")


@router.get("/tools")
async def list_tools():
    from backend.services.llm_providers import TOOL_SCHEMAS
    return {"tools": [{"name": t["name"], "description": t["description"]} for t in TOOL_SCHEMAS.values()]}


async def _maybe_rag(req: LlmRequest) -> tuple[str, int]:
    if not req.use_rag:
        return "", 0
    from backend.services.retriever import search
    from backend.services.embedder import index_ready
    if not index_ready():
        return "", 0
    last_user = next((m["content"] for m in reversed(req.messages) if m["role"] == "user"), "")
    if not last_user:
        return "", 0
    chunks, lat = search(last_user, req.top_k, req.rerank, req.embedding_model)
    context = "\n\n".join(c["text"] for c in chunks)
    return context, lat


def _build_messages(req: LlmRequest, rag_context: str = "") -> list[dict]:
    system = req.system_prompt
    if req.use_context:
        system += f"\n\n--- Nimbus knowledge base ---\n{_read_context()}\n--- End knowledge base ---"
    elif rag_context:
        system += f"\n\n--- Retrieved context ---\n{rag_context}\n--- End context ---"
    return [{"role": "system", "content": system}] + req.messages


def _pick_key(provider: str, keys: dict) -> Optional[str]:
    return {"openai": keys["openai"], "gemini": keys["google"], "anthropic": keys["anthropic"]}.get(provider)
