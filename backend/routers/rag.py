from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional

router = APIRouter()


class RagQueryRequest(BaseModel):
    query: str
    top_k: int = 5
    rerank: bool = False
    embedding_model: str = "all-MiniLM-L6-v2"


@router.post("/rag/query")
async def rag_query(req: RagQueryRequest):
    from backend.services.retriever import search, embed_query_for_viz
    from backend.services.embedder import index_ready

    if not index_ready():
        raise HTTPException(503, "RAG index not ready yet")

    chunks, latency_ms = search(
        req.query,
        top_k=req.top_k,
        rerank=req.rerank,
        embedding_model=req.embedding_model,
    )
    query_coords = embed_query_for_viz(req.query, req.embedding_model)

    return {
        "chunks": chunks,
        "latency_ms": latency_ms,
        "query_coords": query_coords,
    }


@router.get("/rag/vectors")
async def rag_vectors():
    from backend.services.embedder import get_pca_coords
    data = get_pca_coords()
    if data is None:
        raise HTTPException(503, "PCA coordinates not available — run build first")
    return data


@router.get("/rag/rebuild")
async def rag_rebuild(model: str = Query("all-MiniLM-L6-v2")):
    from backend.services.scraper import run_scraper
    from backend.services.embedder import build_index, load_index
    _, chunks = run_scraper()
    build_index(chunks, model)
    load_index()
    return {"status": "rebuilt", "chunks": len(chunks), "model": model}
