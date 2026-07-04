import json
import time
import uuid
from typing import Optional

from fastapi import APIRouter, Header, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter()


class LlmRequest(BaseModel):
    messages: list[dict]
    provider: str = "openai"
    model: str = "gpt-4o-mini"
    system_prompt: str = ""
    response_length: str = "medium"
    use_rag: bool = True
    top_k: int = 5
    rerank: bool = False
    embedding_model: str = "all-MiniLM-L6-v2"
    tools_enabled: list[str] = []
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

    messages = _build_messages(req.messages, req.system_prompt, rag_context)
    max_tokens = LENGTH_TOKENS.get(req.response_length, 300)

    from backend.services.llm_providers import get_streamer
    streamer = get_streamer(req.provider)
    if not streamer:
        return {"reply": "", "error": f"Unknown provider: {req.provider}"}

    api_key = _pick_key(req.provider, keys)
    full_text = ""
    tool_calls = []

    async for event in streamer(messages, req.model, max_tokens, req.tools_enabled, api_key):
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


@router.get("/llm/stream")
async def llm_stream(
    request: Request,
    provider: str = "openai",
    model: str = "gpt-4o-mini",
    session_id: Optional[str] = None,
    system_prompt: str = "",
    response_length: str = "medium",
    use_rag: bool = False,
    top_k: int = 5,
    rerank: bool = False,
    embedding_model: str = "all-MiniLM-L6-v2",
    tools_enabled: str = "",
    x_openai_key: Optional[str] = Header(None),
    x_google_key: Optional[str] = Header(None),
    x_anthropic_key: Optional[str] = Header(None),
):
    keys = {"openai": x_openai_key, "google": x_google_key, "anthropic": x_anthropic_key}
    tools_list = [t for t in tools_enabled.split(",") if t]

    # Reconstruct a minimal LlmRequest-like from query params
    # In practice the WS router builds full messages; this endpoint is for playground text mode
    class _Req:
        pass

    r = _Req()
    r.provider = provider
    r.model = model
    r.session_id = session_id or str(uuid.uuid4())
    r.system_prompt = system_prompt
    r.response_length = response_length
    r.use_rag = use_rag
    r.top_k = top_k
    r.rerank = rerank
    r.embedding_model = embedding_model
    r.tools_enabled = tools_list
    r.messages = []

    from backend.services.llm_providers import get_streamer, LENGTH_TOKENS
    streamer = get_streamer(provider)
    api_key = _pick_key(provider, keys)
    max_tokens = LENGTH_TOKENS.get(response_length, 300)

    async def _generate():
        t0 = time.perf_counter()
        total_tokens = 0
        async for event in streamer(r.messages, model, max_tokens, tools_list, api_key):
            yield f"data: {json.dumps(event)}\n\n"
            total_tokens += 1
        done_event = {"type": "done", "data": {"total_latency_ms": int((time.perf_counter() - t0) * 1000)}}
        yield f"data: {json.dumps(done_event)}\n\n"

    return StreamingResponse(_generate(), media_type="text/event-stream")


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


def _build_messages(messages: list[dict], system_prompt: str, rag_context: str) -> list[dict]:
    system = system_prompt
    if rag_context:
        system += f"\n\n--- Retrieved context ---\n{rag_context}\n--- End context ---"
    return [{"role": "system", "content": system}] + messages


def _pick_key(provider: str, keys: dict) -> Optional[str]:
    return {"openai": keys["openai"], "gemini": keys["google"], "anthropic": keys["anthropic"]}.get(provider)
