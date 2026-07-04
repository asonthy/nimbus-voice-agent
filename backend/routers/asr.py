import base64
from fastapi import APIRouter, Header
from pydantic import BaseModel
from typing import Optional

router = APIRouter()


class AsrRequest(BaseModel):
    audio_b64: str
    provider: str = "openai"
    language: str = "en-US"


@router.post("/asr")
async def asr(
    req: AsrRequest,
    x_openai_key: Optional[str] = Header(None),
    x_google_key: Optional[str] = Header(None),
    x_eleven_labs_key: Optional[str] = Header(None),
):
    audio_bytes = base64.b64decode(req.audio_b64)
    from backend.services import asr_providers as ap

    if req.provider == "openai":
        return await ap.transcribe_openai(audio_bytes, req.language, x_openai_key)
    elif req.provider == "gemini":
        return await ap.transcribe_gemini(audio_bytes, req.language, x_google_key)
    elif req.provider == "elevenlabs":
        return await ap.transcribe_elevenlabs(audio_bytes, req.language, x_eleven_labs_key)
    else:
        return {"transcript": "", "latency_ms": 0, "error": f"Unknown provider: {req.provider}"}
