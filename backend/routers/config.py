import os
from fastapi import APIRouter

router = APIRouter()


@router.get("/config/keys")
async def get_keys():
    """Return API keys from environment for playground pre-fill."""
    return {
        "openaiKey":     os.environ.get("OPENAI_API_KEY", ""),
        "googleKey":     os.environ.get("GOOGLE_API_KEY", ""),
        "elevenLabsKey": os.environ.get("ELEVEN_LABS_API", ""),
        "anthropicKey":  os.environ.get("ANTHROPIC_API_KEY", ""),
    }
