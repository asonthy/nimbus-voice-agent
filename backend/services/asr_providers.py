"""
ASR provider adapters.
All return { transcript: str, latency_ms: int }.
"""

import base64
import os
import time
import tempfile
from pathlib import Path


def _key(name: str, override: str | None) -> str:
    return override or os.environ.get(name, "")


async def transcribe_openai(audio_bytes: bytes, language: str, api_key: str | None) -> dict:
    import openai
    t0 = time.perf_counter()
    client = openai.AsyncOpenAI(api_key=_key("OPENAI_API_KEY", api_key))
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
        f.write(audio_bytes)
        tmp = f.name
    try:
        with open(tmp, "rb") as af:
            resp = await client.audio.transcriptions.create(
                model="whisper-1",
                file=af,
                language=language.split("-")[0] if language else "en",
            )
        return {"transcript": resp.text, "latency_ms": int((time.perf_counter() - t0) * 1000)}
    finally:
        Path(tmp).unlink(missing_ok=True)


async def transcribe_gemini(audio_bytes: bytes, language: str, api_key: str | None) -> dict:
    import asyncio
    import google.generativeai as genai
    from backend.services.audio_utils import webm_to_wav
    t0 = time.perf_counter()
    genai.configure(api_key=_key("GOOGLE_API_KEY", api_key))
    model = genai.GenerativeModel("gemini-1.5-flash")
    # Gemini doesn't accept webm directly — transcode to wav first.
    wav_bytes = await asyncio.to_thread(webm_to_wav, audio_bytes)
    audio_part = {"mime_type": "audio/wav", "data": base64.b64encode(wav_bytes).decode()}
    result = await model.generate_content_async(
        ["Transcribe the following audio accurately:", audio_part]
    )
    transcript = result.text.strip()
    return {"transcript": transcript, "latency_ms": int((time.perf_counter() - t0) * 1000)}


async def transcribe_elevenlabs(audio_bytes: bytes, language: str, api_key: str | None) -> dict:
    import httpx
    t0 = time.perf_counter()
    key = _key("ELEVEN_LABS_API", api_key)
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://api.elevenlabs.io/v1/speech-to-text",
            headers={"xi-api-key": key},
            files={"audio": ("audio.webm", audio_bytes, "audio/webm")},
            data={"model_id": "scribe_v1", "language_code": language or "en"},
        )
        resp.raise_for_status()
        data = resp.json()
    return {"transcript": data.get("text", ""), "latency_ms": int((time.perf_counter() - t0) * 1000)}
