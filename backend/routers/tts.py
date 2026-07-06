import time
from typing import Optional

from fastapi import APIRouter, Header
from fastapi.responses import Response
from pydantic import BaseModel

router = APIRouter()


class TtsRequest(BaseModel):
    text: str
    provider: str = "openai"
    voice: str = "alloy"


@router.post("/tts")
async def tts(
    req: TtsRequest,
    x_openai_key: Optional[str] = Header(None),
    x_google_key: Optional[str] = Header(None),
    x_eleven_labs_key: Optional[str] = Header(None),
):
    from backend.services.tts_providers import get_synth
    synth = get_synth(req.provider)
    if not synth:
        return Response(content=b"", media_type="audio/mpeg", status_code=400)

    keys = {"openai": x_openai_key, "gemini": x_google_key, "elevenlabs": x_eleven_labs_key}
    api_key = keys.get(req.provider)

    t0 = time.perf_counter()
    audio_bytes = await synth(req.text, req.voice, api_key)
    ms = int((time.perf_counter() - t0) * 1000)
    return Response(content=audio_bytes, media_type="audio/mpeg", headers={"X-TTS-Ms": str(ms)})
