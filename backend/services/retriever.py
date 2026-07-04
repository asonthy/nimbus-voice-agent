"""
Top-k semantic search + optional cross-encoder reranking.
"""

import time
import numpy as np
from typing import Optional


def search(
    query: str,
    top_k: int = 5,
    rerank: bool = False,
    embedding_model: str = "all-MiniLM-L6-v2",
) -> tuple[list[dict], int]:
    """
    Returns (chunks, latency_ms).
    Each chunk: {text, source, label, score, rank, rerank_score?}
    """
    t0 = time.perf_counter()

    from backend.services.embedder import get_index, get_chunks_meta, embed_texts
    idx = get_index()
    meta = get_chunks_meta()

    if idx is None or not meta:
        return [], 0

    q_vec = embed_texts([query], embedding_model)
    k = min(top_k * 3 if rerank else top_k, len(meta))
    scores, indices = idx.search(q_vec, k)

    results = []
    for rank, (score, i) in enumerate(zip(scores[0], indices[0])):
        if i < 0:
            continue
        chunk = dict(meta[i])
        chunk["score"] = float(score)
        chunk["rank"] = rank
        results.append(chunk)

    if rerank and results:
        results = _rerank(query, results, top_k)
    else:
        results = results[:top_k]

    latency_ms = int((time.perf_counter() - t0) * 1000)
    return results, latency_ms


def _rerank(query: str, candidates: list[dict], top_k: int) -> list[dict]:
    try:
        from sentence_transformers import CrossEncoder
        model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
        pairs = [(query, c["text"]) for c in candidates]
        scores = model.predict(pairs)
        for c, s in zip(candidates, scores):
            c["rerank_score"] = float(s)
        candidates.sort(key=lambda x: x["rerank_score"], reverse=True)
    except Exception as e:
        print(f"Reranker error (falling back to cosine order): {e}")
    return candidates[:top_k]


def embed_query_for_viz(
    query: str,
    embedding_model: str = "all-MiniLM-L6-v2",
) -> Optional[list[float]]:
    """Project query into 2D PCA space for visualization."""
    from backend.services.embedder import embed_texts, get_pca_coords
    pca_data = get_pca_coords()
    if pca_data is None:
        return None

    try:
        from sklearn.decomposition import PCA
        from backend.services.embedder import get_chunks_meta, embed_texts as _embed
        meta = get_chunks_meta()
        if not meta:
            return None
        all_texts = [c["text"] for c in meta]
        all_vecs = _embed(all_texts, embedding_model)
        q_vec = embed_texts([query], embedding_model)

        pca = PCA(n_components=2)
        pca.fit(all_vecs)
        q_2d = pca.transform(q_vec)[0].tolist()
        return q_2d
    except Exception as e:
        print(f"PCA query projection error: {e}")
        return None
