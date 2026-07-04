"""
TTS provider adapters. All return bytes (audio/mpeg or audio/wav).
"""

import os
from typing import Optional


def _key(env: str, override: Optional[str]) -> str:
    return override or os.environ.get(env, "")


async def synth_openai(text: str, voice: str, api_key: Optional[str]) -> bytes:
    import openai
    client = openai.AsyncOpenAI(api_key=_key("OPENAI_API_KEY", api_key))
    response = await client.audio.speech.create(
        model="tts-1",
        voice=voice or "alloy",
        input=text,
        response_format="mp3",
    )
    return response.content


async def synth_gemini(text: str, voice: str, api_key: Optional[str]) -> bytes:
    import google.generativeai as genai
    genai.configure(api_key=_key("GOOGLE_API_KEY", api_key))
    model = genai.GenerativeModel("gemini-2.5-flash-preview-tts")
    response = await model.generate_content_async(
        text,
        generation_config=genai.types.GenerationConfig(
            response_modalities=["AUDIO"],
            speech_config=genai.types.SpeechConfig(
                voice_config=genai.types.VoiceConfig(
                    prebuilt_voice_config=genai.types.PrebuiltVoiceConfig(voice_name=voice or "Aoede")
                )
            ),
        ),
    )
    audio_data = response.candidates[0].content.parts[0].inline_data.data
    import base64
    return base64.b64decode(audio_data) if isinstance(audio_data, str) else audio_data


async def synth_elevenlabs(text: str, voice: str, api_key: Optional[str]) -> bytes:
    import httpx
    key = _key("ELEVEN_LABS_API", api_key)
    voice_id = voice or "EXAVITQu4vr4xnSDxMaL"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
            headers={"xi-api-key": key, "Content-Type": "application/json"},
            json={"text": text, "model_id": "eleven_multilingual_v2"},
        )
        resp.raise_for_status()
        return resp.content


def get_synth(provider: str):
    return {"openai": synth_openai, "gemini": synth_gemini, "elevenlabs": synth_elevenlabs}.get(provider)
