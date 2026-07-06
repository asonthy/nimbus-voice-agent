import os
from pathlib import Path
from contextlib import asynccontextmanager
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv(Path(__file__).parent.parent / ".env")

# Make the bundled ffmpeg binary (imageio-ffmpeg) discoverable on PATH — no
# system ffmpeg package required on hosts with a matching platform wheel
# (e.g. Railway/Linux). Some platforms (e.g. macOS arm64) have no bundled
# binary; that's fine locally — only Gemini ASR needs it, and it's looked up
# lazily there, so we just skip the PATH tweak rather than fail startup.
try:
    import imageio_ffmpeg
    os.environ["PATH"] = os.path.dirname(imageio_ffmpeg.get_ffmpeg_exe()) + os.pathsep + os.environ.get("PATH", "")
except Exception as e:
    print(f"imageio-ffmpeg binary unavailable on this platform ({e}); Gemini ASR will fail until ffmpeg is installed")

from backend.routers import rag as rag_router
from backend.routers import asr as asr_router
from backend.routers import llm as llm_router
from backend.routers import tts as tts_router
from backend.routers import ws as ws_router
from backend.routers import config as config_router

@asynccontextmanager
async def lifespan(app: FastAPI):
    from backend.services.embedder import load_or_build_index
    await load_or_build_index()
    yield

app = FastAPI(title="Nimbus Voice Agent API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

app.include_router(rag_router.router, prefix="/api")
app.include_router(asr_router.router, prefix="/api")
app.include_router(llm_router.router, prefix="/api")
app.include_router(tts_router.router, prefix="/api")
app.include_router(ws_router.router, prefix="/api")
app.include_router(config_router.router, prefix="/api")


@app.get("/api/health")
async def health():
    from backend.services.embedder import index_ready
    return {"status": "ok", "rag_ready": index_ready()}


@app.get("/api/openapi")
async def openapi_spec():
    return app.openapi()
