#!/usr/bin/env python3
"""
Searcher — queries the ChromaDB vector index and returns results as JSON.
Uses Gemini Embedding 2 for query embedding (same model as indexer).
"""

import os
import sys
import json
from pathlib import Path

from google import genai
from google.genai import types
import chromadb

# ---------------------------------------------------------------------------
# Init
# ---------------------------------------------------------------------------

PROJECT_DIR = Path(__file__).parent
CHROMA_DIR = PROJECT_DIR / "chroma_db"
EMBEDDING_MODEL = "gemini-embedding-2-preview"
EMBEDDING_DIM = 768

api_key = os.environ.get("GOOGLE_API_KEY")
if not api_key:
    print(json.dumps({"error": "GOOGLE_API_KEY not set"}))
    sys.exit(1)

client = genai.Client(api_key=api_key)
chroma_client = chromadb.PersistentClient(path=str(CHROMA_DIR))
collection = chroma_client.get_or_create_collection(
    name="multimodal_index",
    metadata={"hnsw:space": "cosine"},
)

# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def embed_query(query: str) -> list[float]:
    result = client.models.embed_content(
        model=EMBEDDING_MODEL,
        contents=query,
        config=types.EmbedContentConfig(output_dimensionality=EMBEDDING_DIM),
    )
    return result.embeddings[0].values


def search(query: str, k: int = 10, file_type: str = None) -> list[dict]:
    query_embedding = embed_query(query)

    where_filter = {"type": file_type} if file_type else None
    try:
        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=k,
            where=where_filter,
        )
    except Exception as e:
        return [{"error": str(e)}]

    seen: set[str] = set()
    output = []

    ids = results["ids"][0] if results["ids"] else []
    documents = results["documents"][0] if results["documents"] else []
    metadatas = results["metadatas"][0] if results["metadatas"] else []
    distances = results["distances"][0] if results["distances"] else []

    for doc_id, document, metadata, distance in zip(ids, documents, metadatas, distances):
        src = metadata.get("source", "")
        if src in seen:
            continue
        seen.add(src)
        output.append({
            "path": src,
            "name": metadata.get("name", Path(src).name),
            "type": metadata.get("type", "unknown"),
            "score": round(float(1 - distance), 3),
            "preview": document[:300] if document else "",
        })

    return output


if __name__ == "__main__":
    args = sys.argv[1:]
    file_type = None
    if "--type" in args:
        idx = args.index("--type")
        if idx + 1 < len(args):
            file_type = args[idx + 1]
            args = args[:idx] + args[idx + 2:]

    query = " ".join(args).strip()
    if not query:
        print(json.dumps([]))
        sys.exit(0)

    results = search(query, file_type=file_type)
    print(json.dumps(results, indent=2))
