#!/usr/bin/env python3
"""
prepare_atlas.py — Export ChromaDB vectors → atlas_data.parquet
Run this once (or after re-indexing) to rebuild the Atlas data file.

Usage: python api/prepare_atlas.py
"""

import os
import sys
import json
import base64
import hashlib
import subprocess
import tempfile
from pathlib import Path

import re
import numpy as np
import pandas as pd
import chromadb
from PIL import Image
from pypdf import PdfReader
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.cluster import KMeans
from paths import (
    ATLAS_CACHE_DIR,
    ATLAS_DATA_FILE,
    CHROMA_DB_DIR,
    CLUSTER_META_FILE,
    ensure_runtime_dirs,
)

PROJECT_DIR = Path(__file__).resolve().parent.parent
CHROMA_DIR  = CHROMA_DB_DIR
CACHE_DIR   = ATLAS_CACHE_DIR
OUT_FILE    = ATLAS_DATA_FILE

THUMB_SIZE   = (220, 220)  # px — Atlas renders thumbnails small
NEIGHBORS_K  = 25          # nearest neighbors per point
N_CLUSTERS   = 16          # semantic clusters for label overlay

_STOPWORDS = {
    "the","a","an","and","or","of","to","in","is","it","for","on","with",
    "this","that","are","was","be","as","at","by","from","has","have","had",
    "not","but","if","can","all","its","into","we","i","you","he","she","they",
    "do","did","done","will","would","could","should","may","might","been",
    "their","there","which","who","what","when","how","more","my","your","our",
    "page","pages","pdf","image","video","file","files","document","documents",
    "also","then","than","so","no","up","out","use","used","just","new","one",
    "two","three","first","second","last","other","any","each","only","see",
    "get","got","make","made","like","some","time","way","back","well","long",
}

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _img_to_b64(img: Image.Image) -> str:
    """Encode a PIL image as a base64 JPEG data-URL."""
    img = img.convert("RGB")
    img.thumbnail(THUMB_SIZE, Image.LANCZOS)
    buf = __import__("io").BytesIO()
    img.save(buf, format="JPEG", quality=80, optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/jpeg;base64,{b64}"


def thumbnail_image(path: str) -> str | None:
    try:
        return _img_to_b64(Image.open(path))
    except Exception:
        return None


def thumbnail_video(path: str) -> str | None:
    try:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tpath = tmp.name
        r = subprocess.run(
            ["ffmpeg", "-i", path, "-ss", "00:00:02", "-vframes", "1",
             tpath, "-y", "-loglevel", "quiet"],
            capture_output=True, timeout=15,
        )
        p = Path(tpath)
        if p.exists() and p.stat().st_size > 0:
            result = _img_to_b64(Image.open(tpath))
            p.unlink(missing_ok=True)
            return result
    except Exception:
        pass
    return None


def pdf_preview(path: str) -> str:
    try:
        reader = PdfReader(path)
        pages = len(reader.pages)
        text = ""
        for page in reader.pages[:3]:  # first 3 pages
            text += (page.extract_text() or "")
        preview = text.strip()[:600]
        suffix = f"\n\n[{pages} pages]" if pages > 1 else ""
        return preview + suffix if preview else f"[Scanned PDF — {pages} pages]"
    except Exception:
        return "[PDF]"


# ─────────────────────────────────────────────────────────────────────────────
# Load UMAP cache (x, y per doc_id)
# ─────────────────────────────────────────────────────────────────────────────

def load_umap_cache() -> dict[str, tuple[float, float]]:
    """Returns {doc_id: (x, y)} from the most recent UMAP cache file."""
    if not CACHE_DIR.exists():
        return {}
    cache_files = sorted(CACHE_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime)
    if not cache_files:
        return {}

    coords: dict[str, tuple[float, float]] = {}
    # Merge all cache files (different reduction methods may exist)
    for cf in cache_files:
        try:
            data = json.loads(cf.read_text())
            for row in data.get("rows", []):
                doc_id = row["id"]
                # Only store if not already present (prefer most recently written)
                if doc_id not in coords:
                    coords[doc_id] = (float(row["x"]), float(row["y"]))
        except Exception:
            continue
    print(f"  Loaded {len(coords):,} UMAP coords from cache")
    return coords


# ─────────────────────────────────────────────────────────────────────────────
# Cluster labeling
# ─────────────────────────────────────────────────────────────────────────────

def cluster_label(texts: list[str], names: list[str]) -> str:
    """Return a 2-3 word label summarising a cluster from its items' text + filenames."""
    word_freq: dict[str, int] = {}
    for t in texts + names:
        for w in re.findall(r"[a-z]{3,}", t.lower()):
            if w not in _STOPWORDS:
                word_freq[w] = word_freq.get(w, 0) + 1
    if not word_freq:
        return "mixed"
    top = sorted(word_freq, key=word_freq.get, reverse=True)[:3]
    return " · ".join(top)


def assign_clusters(rows: list[dict], all_vecs: np.ndarray) -> tuple[list[int], list[str], list[dict]]:
    """
    Run k-means on 768-d vectors, then label each cluster by top keywords.
    Returns (cluster_ids per row, cluster_labels per row, cluster_meta list).
    """
    n = len(rows)
    k = min(N_CLUSTERS, max(1, n // 4))  # don't over-cluster small datasets

    km = KMeans(n_clusters=k, n_init=10, random_state=42)
    labels = km.fit_predict(all_vecs)

    # Build label strings per cluster
    cluster_texts: dict[int, list[str]] = {i: [] for i in range(k)}
    cluster_names: dict[int, list[str]] = {i: [] for i in range(k)}
    for i, row in enumerate(rows):
        cid = int(labels[i])
        cluster_texts[cid].append(row.get("preview", ""))
        cluster_names[cid].append(row.get("name", ""))

    label_map = {cid: cluster_label(cluster_texts[cid], cluster_names[cid]) for cid in range(k)}

    # Compute centroid in UMAP space for each cluster
    cluster_meta = []
    for cid in range(k):
        members = [i for i, l in enumerate(labels) if l == cid]
        cx = float(np.mean([rows[i]["x"] for i in members]))
        cy = float(np.mean([rows[i]["y"] for i in members]))
        cluster_meta.append({
            "cluster_id":    cid,
            "cluster_label": label_map[cid],
            "cx":            cx,
            "cy":            cy,
            "count":         len(members),
        })

    return (
        [int(l) for l in labels],
        [label_map[int(l)] for l in labels],
        cluster_meta,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    ensure_runtime_dirs()
    print("=== Building atlas_data.parquet ===\n")

    # ── 1. Connect to ChromaDB ───────────────────────────────────────────────
    print("[1/6] Connecting to ChromaDB...")
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    col = client.get_or_create_collection(
        "multimodal_index", metadata={"hnsw:space": "cosine"}
    )
    total = col.count()
    print(f"  {total:,} items in collection")
    if total == 0:
        sys.exit("  Nothing indexed yet. Run api/indexer.py first.")

    # ── 2. Pull everything from ChromaDB ────────────────────────────────────
    print("[2/6] Pulling vectors + metadata from ChromaDB...")
    result = col.get(include=["embeddings", "documents", "metadatas"])
    doc_ids   = result["ids"]
    embeddings = np.array(result["embeddings"], dtype=np.float32)  # (N, 768)
    metadatas  = result["metadatas"]
    documents  = result["documents"]
    print(f"  Got {len(doc_ids):,} vectors ({embeddings.shape[1]}d)")

    # ── 3. Load UMAP coords from cache ───────────────────────────────────────
    print("[3/6] Loading UMAP coordinates...")
    umap_cache = load_umap_cache()

    # Deduplicate PDF chunks: keep only the chunk whose x,y is closest to the
    # PDF's centroid (or just chunk0) and merge preview text per source file.
    print("  Deduplicating PDF chunks...")
    source_to_rows: dict[str, list[int]] = {}
    for i, meta in enumerate(metadatas):
        src = meta.get("source", doc_ids[i])
        source_to_rows.setdefault(src, []).append(i)

    rows = []
    no_coords = []   # (src_path, fname, ftype, preview, avg_vec) for files without UMAP coords
    for src_path, indices in source_to_rows.items():
        meta0 = metadatas[indices[0]]
        ftype = meta0.get("type", "unknown")
        fname = meta0.get("name", Path(src_path).name)

        # Pick the index with the best UMAP coverage (prefer chunk0)
        primary_idx = indices[0]
        for idx in indices:
            if doc_ids[idx] in umap_cache:
                primary_idx = idx
                break

        doc_id = doc_ids[primary_idx]
        x, y = umap_cache.get(doc_id, (None, None))

        # Merge text from all chunks of this document
        preview = " ".join(
            (documents[i] or "")
            for i in indices
            if documents[i] and not documents[i].startswith("[")
        )[:800]
        if not preview:
            preview = (documents[primary_idx] or "")[:200]

        # Average the embeddings across chunks for a single representative vector
        chunk_vecs = embeddings[indices]
        avg_vec = chunk_vecs.mean(axis=0)
        norm = np.linalg.norm(avg_vec)
        if norm > 0:
            avg_vec /= norm

        if x is None or y is None:
            no_coords.append((src_path, doc_id, fname, ftype, preview, avg_vec))
            continue

        rows.append({
            "_idx":    len(rows),
            "doc_id":  doc_id,
            "path":    src_path,
            "name":    fname,
            "type":    ftype,
            "x":       x,
            "y":       y,
            "preview": preview,
            "_vec":    avg_vec,
        })

    # Approximate UMAP coords for newly-indexed files (not yet in the cache).
    # Place each one near its nearest semantic neighbors that do have coords.
    if no_coords and rows:
        print(f"  Approximating UMAP coords for {len(no_coords)} newly-indexed file(s)...")
        known_vecs = np.array([r["_vec"] for r in rows], dtype=np.float32)
        rng = np.random.default_rng(seed=42)
        for src_path, doc_id, fname, ftype, preview, avg_vec in no_coords:
            sims = known_vecs @ avg_vec.astype(np.float32)
            top_k = np.argsort(sims)[-10:]
            ax = float(np.mean([rows[i]["x"] for i in top_k]))
            ay = float(np.mean([rows[i]["y"] for i in top_k]))
            # small jitter so the point doesn't land exactly on a neighbor
            ax += float(rng.normal(0, 0.4))
            ay += float(rng.normal(0, 0.4))
            rows.append({
                "_idx":    len(rows),
                "doc_id":  doc_id,
                "path":    src_path,
                "name":    fname,
                "type":    ftype,
                "x":       ax,
                "y":       ay,
                "preview": preview,
                "_vec":    avg_vec,
            })
    elif no_coords:
        print(f"  Skipping {len(no_coords)} file(s) — no existing UMAP coords to approximate from")

    print(f"  {len(rows):,} unique files ({len(no_coords)} approximated — new since last UMAP run)")

    # ── 4. Compute K-nearest neighbors ───────────────────────────────────────
    print(f"[4/6] Computing {NEIGHBORS_K}-nearest neighbors...")
    all_vecs = np.array([r["_vec"] for r in rows], dtype=np.float32)  # (M, 768)
    # Cosine similarity matrix: M×M — fine up to ~5k rows
    sim = cosine_similarity(all_vecs)                                   # (M, M)

    neighbors_col = []
    for i in range(len(rows)):
        scores = sim[i].copy()
        scores[i] = -999.0   # exclude self
        top_k = np.argsort(scores)[::-1][:NEIGHBORS_K]
        neighbors_col.append({
            "ids":       [int(j) for j in top_k],
            "distances": [float(1 - scores[j]) for j in top_k],
        })
    print(f"  Done — {NEIGHBORS_K} neighbors per point")

    # ── 5. Generate thumbnails ────────────────────────────────────────────────
    print("[5/6] Generating thumbnails...")
    n_img = sum(1 for r in rows if r["type"] == "image")
    n_vid = sum(1 for r in rows if r["type"] == "video")
    print(f"  {n_img} images, {n_vid} videos to thumbnail...")

    thumbnails = []
    preview_texts = []
    for i, row in enumerate(rows):
        ftype = row["type"]
        path  = row["path"]

        thumb = None
        if ftype == "image" and Path(path).exists():
            thumb = thumbnail_image(path)
        elif ftype == "video" and Path(path).exists():
            thumb = thumbnail_video(path)
        thumbnails.append(thumb)

        if ftype == "pdf" and Path(path).exists() and not row["preview"].strip():
            preview_texts.append(pdf_preview(path))
        else:
            preview_texts.append(row["preview"])

        if (i + 1) % 50 == 0:
            n_done = sum(1 for t in thumbnails if t)
            print(f"  {i+1}/{len(rows)} processed ({n_done} thumbnails)")

    n_thumbs = sum(1 for t in thumbnails if t)
    print(f"  Generated {n_thumbs} thumbnails")

    # ── 5b. Cluster ───────────────────────────────────────────────────────────
    print(f"[5b] Clustering {len(rows)} items into ≤{N_CLUSTERS} semantic groups...")
    cluster_ids, cluster_label_strs, cluster_meta = assign_clusters(rows, all_vecs)
    print(f"  {len(cluster_meta)} clusters: {[c['cluster_label'] for c in cluster_meta[:5]]}...")

    # Save cluster metadata alongside the parquet
    cluster_meta_path = CLUSTER_META_FILE
    cluster_meta_path.write_text(json.dumps(cluster_meta, indent=2))
    print(f"  Saved cluster metadata → {cluster_meta_path.name}")

    # ── 6. Build DataFrame and save ──────────────────────────────────────────
    print("[6/6] Building DataFrame and saving parquet...")
    df = pd.DataFrame({
        "row_id":        [r["_idx"]   for r in rows],
        "doc_id":        [r["doc_id"] for r in rows],
        "path":          [r["path"]   for r in rows],
        "name":          [r["name"]   for r in rows],
        "type":          [r["type"]   for r in rows],
        "x":             [r["x"]      for r in rows],
        "y":             [r["y"]      for r in rows],
        "preview_text":  preview_texts,
        "thumbnail":     thumbnails,
        "neighbors":     neighbors_col,
        "cluster_id":    cluster_ids,
        "cluster_label": cluster_label_strs,
    })

    df.to_parquet(OUT_FILE, index=False)
    size_mb = OUT_FILE.stat().st_size / 1024 / 1024
    print(f"\n✓ Saved {OUT_FILE} ({size_mb:.1f} MB, {len(df):,} rows)")
    print(f"  Columns: {list(df.columns)}")

    # Quick stats
    by_type = df["type"].value_counts().to_dict()
    n_thumbs = df["thumbnail"].notna().sum()
    print(f"  Types: {by_type}")
    print(f"  Thumbnails: {n_thumbs}/{len(df)}")
    print("\nRun python api/launch.py to launch the visualization.")


if __name__ == "__main__":
    main()
