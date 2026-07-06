"""
Builds and loads the FAISS vector index from catalog chunks.
Also precomputes 2D PCA coordinates for the scatter plot.
"""

import json
import os
import pickle
from pathlib import Path
from typing import Optional

import numpy as np

ROOT = Path(__file__).parent.parent.parent
DATA_DIR = Path(__file__).parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

INDEX_PATH = DATA_DIR / "faiss.index"
META_PATH = DATA_DIR / "chunks_meta.json"
PCA_PATH = DATA_DIR / "pca_coords.json"

# "rich" (default, local): sentence-transformers MiniLM — free, no API calls,
#   best for the clustering visualization.
# "light" (Railway): OpenAI text-embedding-3-small — no torch/sentence-
#   transformers needed at runtime, smaller image, faster cold start.
EMBEDDING_PROFILE = os.environ.get("EMBEDDING_PROFILE", "rich")

_index = None
_chunks_meta: list[dict] = []
_embedder = None
_embed_model_name: str = ""


def _get_embedder(model_name: str = "all-MiniLM-L6-v2"):
    global _embedder, _embed_model_name
    if _embedder is None or _embed_model_name != model_name:
        from sentence_transformers import SentenceTransformer
        _embedder = SentenceTransformer(model_name)
        _embed_model_name = model_name
    return _embedder


def _embed_texts_openai(texts: list[str]) -> np.ndarray:
    import openai
    client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))
    resp = client.embeddings.create(model="text-embedding-3-small", input=texts)
    vecs = np.array([d.embedding for d in resp.data], dtype=np.float32)
    vecs /= np.linalg.norm(vecs, axis=1, keepdims=True)
    return vecs


def embed_texts(texts: list[str], model_name: str = "all-MiniLM-L6-v2") -> np.ndarray:
    if EMBEDDING_PROFILE == "light":
        return _embed_texts_openai(texts)
    model = _get_embedder(model_name)
    vecs = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    return np.array(vecs, dtype=np.float32)


def build_index(chunks: list[dict], model_name: str = "all-MiniLM-L6-v2") -> None:
    import faiss
    from sklearn.decomposition import PCA

    texts = [c["text"] for c in chunks]
    vecs = embed_texts(texts, model_name)

    dim = vecs.shape[1]
    idx = faiss.IndexFlatIP(dim)
    idx.add(vecs)

    faiss.write_index(idx, str(INDEX_PATH))
    with open(META_PATH, "w") as f:
        json.dump(chunks, f, ensure_ascii=False, indent=2)

    # Precompute 2D PCA for visualization
    pca = PCA(n_components=2)
    coords_2d = pca.fit_transform(vecs).tolist()
    points = [
        {
            "id": i,
            "x": coords_2d[i][0],
            "y": coords_2d[i][1],
            "label": chunks[i]["label"],
            "source": chunks[i]["source"],
        }
        for i in range(len(chunks))
    ]
    with open(PCA_PATH, "w") as f:
        json.dump({"points": points, "explained_variance": pca.explained_variance_ratio_.tolist()}, f)

    print(f"Embedder: built index with {len(chunks)} vectors (dim={dim})")


def load_index() -> bool:
    global _index, _chunks_meta
    if not INDEX_PATH.exists() or not META_PATH.exists():
        return False
    import faiss
    _index = faiss.read_index(str(INDEX_PATH))
    with open(META_PATH) as f:
        _chunks_meta = json.load(f)
    return True


def index_ready() -> bool:
    return _index is not None


def get_index():
    return _index


def get_chunks_meta() -> list[dict]:
    return _chunks_meta


async def load_or_build_index(model_name: str = "all-MiniLM-L6-v2") -> None:
    if load_index():
        print(f"Embedder: loaded existing index ({len(_chunks_meta)} chunks)")
        return
    print("Embedder: no index found — building from catalog...")
    from backend.services.scraper import run_scraper
    _, chunks = run_scraper()
    build_index(chunks, model_name)
    load_index()


def get_pca_coords() -> Optional[dict]:
    if PCA_PATH.exists():
        with open(PCA_PATH) as f:
            return json.load(f)
    return None
