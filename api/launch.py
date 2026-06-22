#!/usr/bin/env python3
"""
launch.py — Multimodal Search launcher.

Extends Apple Embedding Atlas directly:
  - Creates the Atlas FastAPI server using embedding_atlas internals
  - Injects a floating search panel into Atlas's index.html
  - Adds /gemini-search endpoint for Gemini-powered semantic search
  - Adds /open-file endpoint so the panel can open files in Finder

Usage: python api/launch.py [--port 5055]
"""

import asyncio
import json
import os
import re
import sys
import shutil
import tempfile
import subprocess
from pathlib import Path

import math

import click
import pandas as pd
import uvicorn
import chromadb
from fastapi import Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from google import genai
from google.genai import types

import embedding_atlas
from embedding_atlas.server import make_server
from embedding_atlas.data_source import DataSource
from embedding_atlas.cache import sha256_hexdigest
from embedding_atlas.options import make_embedding_atlas_props
from embedding_atlas.version import __version__
from paths import (
    ATLAS_CACHE_DIR,
    ATLAS_DATA_FILE,
    CHROMA_DB_DIR,
    CLUSTER_META_FILE,
    ENV_FILE,
    MANIFEST_FILE,
    ROOT_DIR,
    SEARCH_INDEX_DATA_DIR,
    UI_DASHBOARD_DIR,
    ensure_runtime_dirs,
)

# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────

PROJECT_DIR     = ROOT_DIR
PARQUET_FILE    = ATLAS_DATA_FILE
CHROMA_DIR      = CHROMA_DB_DIR
ATLAS_STATIC    = Path(embedding_atlas.__file__).parent / "static"

EMBEDDING_MODEL = "gemini-embedding-2-preview"
EMBEDDING_DIM   = 768
SEARCH_K        = 40

STOP_WORDS = [
    "screenshot", "screen", "recording", "image", "photo", "img",
    "document", "file", "page", "copy", "draft", "final", "new", "old",
    "the", "and", "for", "are", "was", "not", "you", "but", "have",
    "its", "they", "than", "been", "their", "more", "will", "when",
    "what", "which", "your", "into", "just", "also", "about", "other",
]

# ─────────────────────────────────────────────────────────────────────────────
# Cluster label generation (local, K-means + TF-IDF word frequency)
# ─────────────────────────────────────────────────────────────────────────────

_LABEL_SKIP = set(STOP_WORDS) | {
    "png", "jpg", "jpeg", "pdf", "mp4", "mov", "gif", "webp",
    "copy", "final", "new", "old", "updated", "draft", "version",
    "img", "file", "document", "page", "screen", "screenshot",
    "recording", "video", "image", "photo", "2024", "2025", "2026",
    "at", "pm", "am", "of", "in", "to", "a", "an",
}

def _tokenize(name: str) -> list[str]:
    """Split filename into lowercase words, drop extension and junk."""
    stem = re.sub(r'\.\w{2,4}$', '', name)          # drop extension
    words = re.findall(r'[a-zA-Z]{3,}', stem)        # letters only, ≥3 chars
    return [w.lower() for w in words if w.lower() not in _LABEL_SKIP]

def build_cluster_labels(df: pd.DataFrame, n_clusters: int = 10) -> list[dict]:
    """
    K-means cluster the UMAP points, derive a short label per cluster from
    the most distinctive words in file names (TF-IDF-style), and return
    Atlas-format label dicts with fixed positions.
    """
    from sklearn.cluster import KMeans
    from collections import Counter

    coords = df[["x", "y"]].values.astype(float)
    n = min(n_clusters, len(df))
    km = KMeans(n_clusters=n, random_state=42, n_init=10).fit(coords)
    labels_col = km.labels_

    # Global word frequency (for IDF-like weighting)
    global_freq: Counter = Counter()
    for name in df["name"]:
        global_freq.update(set(_tokenize(name)))
    total_docs = len(df)

    result = []
    for cid in range(n):
        mask   = labels_col == cid
        subset = df[mask]
        if len(subset) < 2:
            continue

        # Count words in this cluster
        cluster_freq: Counter = Counter()
        for name in subset["name"]:
            cluster_freq.update(_tokenize(name))

        if not cluster_freq:
            continue

        # Score = (cluster_count / cluster_size) / log(1 + global_count / total_docs)
        # Favours words common in THIS cluster but rare overall
        import math as _math
        scores = {
            w: (cnt / len(subset)) / _math.log(1 + global_freq[w] / total_docs)
            for w, cnt in cluster_freq.items()
            if cnt >= max(1, len(subset) * 0.15)   # in ≥15% of cluster docs
        }

        if not scores:
            # Fallback: most common words
            scores = dict(cluster_freq.most_common(5))

        top = sorted(scores, key=scores.get, reverse=True)[:3]
        label_text = " · ".join(w.title() for w in top) if top else f"Cluster {cid}"

        cx, cy = km.cluster_centers_[cid]
        result.append({
            "x":        float(cx),
            "y":        float(cy),
            "text":     label_text,
            "level":    0,          # 0 = always visible at any zoom level
            "priority": int(len(subset)),
        })

    return result


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def load_api_key() -> str:
    key = os.environ.get("GOOGLE_API_KEY", "")
    if key:
        return key
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith("GOOGLE_API_KEY="):
                return line.split("=", 1)[1].strip()
    return ""


def build_custom_static() -> str:
    """
    Copy Atlas's static dir to a temp folder, inject our search panel
    into index.html, and add our JS/CSS files.
    """
    tmp = tempfile.mkdtemp(prefix="multimodal_search_")
    shutil.copytree(str(ATLAS_STATIC), tmp, dirs_exist_ok=True)

    # Copy our search panel assets
    for fname in ["search_panel.js", "search_panel.css"]:
        src = UI_DASHBOARD_DIR / fname
        if src.exists():
            shutil.copy(src, tmp)

    # Inject into index.html right before </body>
    index = Path(tmp) / "index.html"
    html = index.read_text()
    inject = (
        '\n  <link rel="stylesheet" href="/search_panel.css">'
        '\n  <script src="/search_panel.js"></script>'
    )
    html = html.replace("</body>", inject + "\n</body>")
    index.write_text(html)

    return tmp


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

@click.command()
@click.option("--port", default=5055, show_default=True, help="Port to listen on.")
@click.option("--host", default="localhost", show_default=True)
@click.option("--no-browser", is_flag=True, default=False)
def main(port: int, host: str, no_browser: bool):
    ensure_runtime_dirs()
    api_key = load_api_key()
    if not api_key:
        print("ERROR: GOOGLE_API_KEY not set. Add it to .env")
        sys.exit(1)

    if not PARQUET_FILE.exists():
        print("ERROR: atlas_data.parquet not found. Run: python api/prepare_atlas.py")
        sys.exit(1)

    # ── Load data ────────────────────────────────────────────────────────────
    print("Loading atlas_data.parquet...")
    df = pd.read_parquet(PARQUET_FILE)
    print(f"  {len(df)} files ({df['type'].value_counts().to_dict()})")

    # search_match column drives the Atlas Color-by-field highlighting.
    # JS updates it via the DuckDB REST endpoint after each search.
    df["search_match"] = 0.0

    # cluster_id / cluster_label — added by prepare_atlas.py. Add stubs if old parquet.
    if "cluster_id" not in df.columns:
        df["cluster_id"]    = 0
        df["cluster_label"] = "unclustered"

    # Build lookup tables for search results mapping
    id_to_row   = dict(zip(df["doc_id"], df["row_id"]))
    path_to_row = dict(zip(df["path"],   df["row_id"]))
    row_info    = df.set_index("row_id")[
        ["path", "name", "type", "thumbnail", "preview_text"]
    ].to_dict("index")

    # ── ChromaDB ─────────────────────────────────────────────────────────────
    chroma_client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    col = chroma_client.get_or_create_collection(
        "multimodal_index", metadata={"hnsw:space": "cosine"}
    )

    # ── Build Atlas app ───────────────────────────────────────────────────────
    print("Building Atlas server...")
    os.chdir(SEARCH_INDEX_DATA_DIR)

    props = make_embedding_atlas_props(
        row_id      = "row_id",
        x           = "x",
        y           = "y",
        text        = "name",
        image       = "thumbnail",
        neighbors   = "neighbors",
        labels      = build_cluster_labels(df),
        stop_words  = STOP_WORDS,
        point_size  = 5.0,
        show_table  = False,
        show_charts = False,
        show_embedding = True,
    )
    # Default to Density display mode
    props.setdefault("embeddingViewConfig", {})["mode"] = "density"

    metadata   = {"props": props}
    identifier = sha256_hexdigest(
        [__version__, [str(PARQUET_FILE)], metadata], scope="DataSource"
    )
    dataset    = DataSource(identifier, df, metadata)

    # Build custom static dir with injected search panel
    custom_static = build_custom_static()

    app = make_server(
        dataset,
        static_path = custom_static,
        duckdb_uri  = "server",
        cors        = True,
    )

    # make_server() adds `app.mount("/", StaticFiles(...))` as its very last step,
    # which catches ALL requests — including our custom routes added after this call.
    # Fix: pull the static mount off the end, add our routes, then re-append it.
    from starlette.routing import Mount as _Mount
    _static_mounts = [
        (i, r) for i, r in enumerate(app.router.routes)
        if isinstance(r, _Mount) and r.path in ("/", "")
    ]
    for i, _ in reversed(_static_mounts):
        app.router.routes.pop(i)

    # ── /gemini-search endpoint ───────────────────────────────────────────────
    @app.post("/gemini-search")
    async def gemini_search(request: Request):
        body        = await request.json()
        query       = body.get("query", "").strip()
        type_filter = body.get("type_filter", "")
        k           = int(body.get("k", SEARCH_K))

        if not query:
            return JSONResponse({"row_ids": [], "results": []})

        try:
            # 1. Embed the query with Gemini
            gc  = genai.Client(api_key=api_key)
            res = gc.models.embed_content(
                model   = EMBEDDING_MODEL,
                contents= query,
                config  = types.EmbedContentConfig(output_dimensionality=EMBEDDING_DIM),
            )
            vec = res.embeddings[0].values

            # 2. Query ChromaDB
            where = {"type": type_filter} if type_filter else None
            hits  = col.query(
                query_embeddings=[vec],
                n_results=min(k, col.count()),
                where=where,
            )
            chroma_ids = hits["ids"][0]       if hits["ids"]       else []
            distances  = hits["distances"][0]  if hits["distances"]  else []

            # 3. Map to parquet row_ids
            results = []
            seen    = set()
            for cid, dist in zip(chroma_ids, distances):
                rid = id_to_row.get(cid)
                if rid is None:
                    base = cid.split("::chunk")[0]
                    rid  = path_to_row.get(base) or id_to_row.get(base)
                if rid is None or rid in seen:
                    continue
                seen.add(rid)
                info = row_info.get(rid, {})

                # pandas reads NULL string columns as float('nan') from parquet —
                # must convert to None/str before JSON serialisation.
                def _str(v, default=""):
                    return default if (v is None or (isinstance(v, float) and not math.isfinite(v))) else str(v)

                thumb = info.get("thumbnail")
                if isinstance(thumb, float) and not math.isfinite(thumb):
                    thumb = None

                raw_score = float(1 - dist)
                score = round(raw_score, 3) if math.isfinite(raw_score) else 0.0

                results.append({
                    "row_id":    int(rid),
                    "name":      _str(info.get("name")),
                    "path":      _str(info.get("path")),
                    "type":      _str(info.get("type")),
                    "thumbnail": thumb,
                    "preview":   _str(info.get("preview_text"))[:200],
                    "score":     score,
                })

            return JSONResponse({
                "row_ids": [r["row_id"] for r in results],
                "results": results,
            })

        except Exception as e:
            return JSONResponse({"error": str(e), "row_ids": [], "results": []},
                                status_code=500)

    # ── /api/map-coords endpoint ──────────────────────────────────────────────
    # Returns lightweight x,y,type,name,path for all rows — used by the
    # search panel to draw the mini scatter map and detect dot clicks.
    @app.get("/api/map-coords")
    async def api_map_coords():
        xs = df["x"].tolist()
        ys = df["y"].tolist()
        items = [
            {
                "row_id": int(row["row_id"]),
                "x":      float(row["x"]),
                "y":      float(row["y"]),
                "type":   str(row["type"]),
                "name":   str(row["name"]),
                "path":   str(row["path"]),
            }
            for _, row in df.iterrows()
        ]
        return JSONResponse({
            "x_min": float(min(xs)),
            "x_max": float(max(xs)),
            "y_min": float(min(ys)),
            "y_max": float(max(ys)),
            "items": items,
        })

    # ── /cluster-meta endpoint ───────────────────────────────────────────────
    @app.get("/static/cluster_meta.json")
    async def get_cluster_meta():
        if not CLUSTER_META_FILE.exists():
            return JSONResponse([])
        return JSONResponse(json.loads(CLUSTER_META_FILE.read_text()))

    # ── /open-file endpoint ───────────────────────────────────────────────────
    @app.post("/open-file")
    async def open_file(request: Request):
        body   = await request.json()
        path   = body.get("path", "")
        action = body.get("action", "open")   # "open" | "reveal"
        if not path or not Path(path).exists():
            return JSONResponse({"error": "file not found"}, status_code=404)
        try:
            if action == "reveal":
                subprocess.run(["open", "-R", path], check=False)
            else:
                subprocess.run(["open", path], check=False)
            return JSONResponse({"ok": True})
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    # ── File-management helpers (pure, no API calls) ──────────────────────────
    _SUPPORTED_EXTS = {
        "pdf": "pdf",
        "jpg": "image", "jpeg": "image", "png": "image",
        "gif": "image", "webp": "image", "heic": "image",
        "mp4": "video", "mov": "video", "avi": "video", "mkv": "video",
    }
    _SKIP_DIRS = {
        ".trash", ".git", ".svn", ".hg", "__pycache__", "node_modules",
        ".npm", ".cache", ".venv", "venv", "env", ".env",
        "library", ".library", ".spotlight-v100", ".fseventsd",
        "site-packages", "dist-packages", ".local", ".cargo",
        ".rustup", ".go", "build", "dist", ".build",
        "photos library.photoslibrary",
    }
    _DEFAULT_FOLDERS = [
        str(Path.home() / "Documents"),
        str(Path.home() / "Desktop"),
        str(Path.home() / "Downloads"),
        str(Path.home() / "Pictures"),
        str(Path.home() / "Movies"),
    ]

    def _should_skip(p: Path) -> bool:
        n = p.name.lower()
        return (n.startswith(".") and n not in {".obsidian"}) or n in _SKIP_DIRS

    def _discover(folder: Path) -> list[Path]:
        out, stack = [], [folder]
        while stack:
            cur = stack.pop()
            try:
                for e in sorted(cur.iterdir()):
                    if e.is_dir() and not _should_skip(e):
                        stack.append(e)
                    elif e.is_file() and e.suffix.lstrip(".").lower() in _SUPPORTED_EXTS:
                        out.append(e)
            except PermissionError:
                pass
        return out

    def _load_mf() -> dict:
        return json.loads(MANIFEST_FILE.read_text()) if MANIFEST_FILE.exists() else {}

    def _save_mf(m: dict):
        MANIFEST_FILE.write_text(json.dumps(m, indent=2))

    # ── /api/scan-folders ──────────────────────────────────────────────────────
    @app.get("/api/scan-folders")
    async def api_scan_folders(folders: str = ""):
        folder_list = [f.strip() for f in folders.split(",") if f.strip()] \
                      or [f for f in _DEFAULT_FOLDERS if Path(f).exists()]

        manifest = _load_mf()
        new_files, indexed_count = [], 0

        for fp in folder_list:
            folder = Path(fp).expanduser().resolve()
            if not folder.exists():
                continue
            for file in _discover(folder):
                fpath = str(file)
                if fpath in manifest:
                    indexed_count += 1
                else:
                    new_files.append({
                        "path":   fpath,
                        "name":   file.name,
                        "type":   _SUPPORTED_EXTS[file.suffix.lstrip(".").lower()],
                        "size":   file.stat().st_size,
                        "folder": str(folder),
                    })

        return JSONResponse({
            "new":           new_files,
            "indexed_count": indexed_count,
            "total":         len(new_files) + indexed_count,
            "default_folders": _DEFAULT_FOLDERS,
        })

    # ── /api/browse ───────────────────────────────────────────────────────────
    # Returns the direct children (dirs + eligible files) of a given directory.
    @app.get("/api/browse")
    async def api_browse(path: str = ""):
        folder = Path(path).expanduser().resolve()
        if not folder.exists() or not folder.is_dir():
            return JSONResponse({"error": "not a directory"}, status_code=400)

        manifest = _load_mf()
        dirs, files = [], []

        try:
            entries = sorted(folder.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
        except PermissionError:
            return JSONResponse({"dirs": [], "files": [], "path": str(folder),
                                  "parent": str(folder.parent)})

        for e in entries:
            if _should_skip(e):
                continue
            if e.is_dir():
                # Count new + indexed files recursively for the badge
                all_f = _discover(e)
                n_indexed = sum(1 for f in all_f if str(f) in manifest)
                dirs.append({
                    "name":    e.name,
                    "path":    str(e),
                    "total":   len(all_f),
                    "indexed": n_indexed,
                    "new":     len(all_f) - n_indexed,
                })
            elif e.is_file():
                ext = e.suffix.lstrip(".").lower()
                if ext in _SUPPORTED_EXTS:
                    fpath = str(e)
                    files.append({
                        "name":    e.name,
                        "path":    fpath,
                        "type":    _SUPPORTED_EXTS[ext],
                        "size":    e.stat().st_size,
                        "indexed": fpath in manifest,
                    })

        parent = str(folder.parent) if folder != folder.parent else None
        return JSONResponse({
            "path":   str(folder),
            "parent": parent,
            "dirs":   dirs,
            "files":  files,
        })

    # ── /api/index-session  +  /api/index-files-stream/{id} ───────────────────
    # Two-step: POST paths → get session_id → open SSE stream with that id.
    # This avoids URL-length limits when passing hundreds of file paths.
    import uuid as _uuid
    _index_sessions: dict[str, list[str]] = {}

    @app.post("/api/index-session")
    async def api_index_session(request: Request):
        body  = await request.json()
        paths = body.get("paths", [])
        sid   = str(_uuid.uuid4())
        _index_sessions[sid] = paths
        return JSONResponse({"session_id": sid})

    @app.get("/api/index-files-stream/{session_id}")
    async def api_index_files_stream(session_id: str):
        file_paths = _index_sessions.pop(session_id, [])
        if not file_paths:
            return JSONResponse({"error": "session not found"}, status_code=404)

        python_bin   = PROJECT_DIR / "venv" / "bin" / "python3"
        indexer_path = PROJECT_DIR / "api" / "indexer.py"

        async def generate():
            try:
                proc = await asyncio.create_subprocess_exec(
                    str(python_bin), str(indexer_path), "--files", *file_paths,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    env={**os.environ, "GOOGLE_API_KEY": api_key},
                    cwd=str(PROJECT_DIR),
                )
                async for line in proc.stdout:
                    text = line.decode("utf-8", errors="replace").rstrip()
                    if text:
                        yield f"data: {json.dumps({'line': text})}\n\n"
                await proc.wait()
                yield f"data: {json.dumps({'done': True, 'code': proc.returncode})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ── /api/delete-items ──────────────────────────────────────────────────────
    @app.post("/api/delete-items")
    async def api_delete_items(request: Request):
        body        = await request.json()
        paths       = body.get("paths", [])
        delete_file = body.get("delete_file", False)

        manifest = _load_mf()
        deleted, errors = 0, []

        for path_str in paths:
            # Remove from ChromaDB — query by source metadata to catch PDF chunks
            try:
                results = col.get(where={"source": path_str}, include=[])
                if results["ids"]:
                    col.delete(ids=results["ids"])
                else:
                    # Fallback: try path directly as ID (images/videos)
                    try:
                        col.delete(ids=[path_str])
                    except Exception:
                        pass
                deleted += 1
            except Exception as e:
                errors.append(f"ChromaDB: {e}")

            manifest.pop(path_str, None)

            if delete_file:
                try:
                    p = Path(path_str)
                    if p.exists():
                        p.unlink()
                except Exception as e:
                    errors.append(f"File delete: {e}")

        _save_mf(manifest)
        return JSONResponse({"deleted": deleted, "errors": errors})

    # ── /api/index-stream (SSE) ────────────────────────────────────────────────
    @app.get("/api/index-stream")
    async def api_index_stream(folders: str = ""):
        folder_list = [f.strip() for f in folders.split(",") if f.strip()] \
                      or [f for f in _DEFAULT_FOLDERS if Path(f).exists()]

        python_bin  = PROJECT_DIR / "venv" / "bin" / "python3"
        indexer_path = PROJECT_DIR / "api" / "indexer.py"

        async def generate():
            try:
                proc = await asyncio.create_subprocess_exec(
                    str(python_bin), str(indexer_path), *folder_list,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    env={**os.environ, "GOOGLE_API_KEY": api_key},
                    cwd=str(PROJECT_DIR),
                )
                async for line in proc.stdout:
                    text = line.decode("utf-8", errors="replace").rstrip()
                    if text:
                        yield f"data: {json.dumps({'line': text})}\n\n"
                await proc.wait()
                yield f"data: {json.dumps({'done': True, 'code': proc.returncode})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # Re-append the static mount after our custom routes so it catches everything else
    for _, mount in _static_mounts:
        app.router.routes.append(mount)

    # ── Start ─────────────────────────────────────────────────────────────────
    url = f"http://{host}:{port}"
    print()
    print("─" * 60)
    print(f"  🔍 Multimodal Search  (Embedding Atlas {__version__})")
    print(f"  ➜  {url}")
    print("─" * 60)
    print()

    if not no_browser:
        # Open browser after a short delay
        import threading, time, webbrowser
        def _open():
            time.sleep(1.5)
            webbrowser.open(url)
        threading.Thread(target=_open, daemon=True).start()

    uvicorn.run(app, host=host, port=port, access_log=False)


if __name__ == "__main__":
    main()
