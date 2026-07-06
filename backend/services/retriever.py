"""
Top-k semantic search + optional cross-encoder reranking.
"""

import json
import os
import time
import numpy as np
from typing import Optional

from backend.services.embedder import EMBEDDING_PROFILE


def search(
    query: str,
    top_k: int = 5,
    rerank: bool = False,
    embedding_model: str = "all-MiniLM-L6-v2",
) -> tuple[list[dict], int]:
    """
    Returns (chunks, latency_ms).
    Each chunk: {id, text, source, label, score, rank, rerank_score?}
    "id" is the absolute chunk index — matches the point ids from
    embedder.get_pca_coords(), for highlighting retrieved points in the viz.
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
        chunk["id"] = int(i)
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
    if EMBEDDING_PROFILE == "light":
        return _rerank_llm(query, candidates, top_k)
    return _rerank_cross_encoder(query, candidates, top_k)


def _rerank_cross_encoder(query: str, candidates: list[dict], top_k: int) -> list[dict]:
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


def _rerank_llm(query: str, candidates: list[dict], top_k: int) -> list[dict]:
    """LLM-based rerank for the 'light' profile (no cross-encoder model download)."""
    try:
        import openai
        client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))
        listing = "\n".join(f"[{i}] {c['text'][:400]}" for i, c in enumerate(candidates))
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{
                "role": "user",
                "content": (
                    f"Query: {query}\n\nCandidate passages:\n{listing}\n\n"
                    "Return a JSON array of the candidate indices above, ordered from "
                    "most to least relevant to the query. Only output the JSON array, "
                    "e.g. [2, 0, 1]."
                ),
            }],
            max_tokens=200,
            temperature=0,
        )
        order = json.loads(resp.choices[0].message.content.strip())
        ranked = [candidates[i] for i in order if isinstance(i, int) and 0 <= i < len(candidates)]
        for pos, c in enumerate(ranked):
            c["rerank_score"] = float(len(ranked) - pos)
        return ranked[:top_k] if ranked else candidates[:top_k]
    except Exception as e:
        print(f"LLM rerank error (falling back to cosine order): {e}")
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
