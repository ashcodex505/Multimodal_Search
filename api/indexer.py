#!/usr/bin/env python3
"""
Indexer — scans folders and embeds PDFs, images, and videos into ChromaDB
using Gemini Embedding 2 (natively multimodal).

Usage:
    python api/indexer.py [folder_path ...]
    python api/indexer.py                     # defaults to common user folders
    python api/indexer.py ~/Desktop ~/Photos
"""

import os
import sys
import json
import hashlib
import subprocess
import time
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from google import genai
from google.genai import types
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pypdf import PdfReader
from tenacity import retry, wait_exponential, stop_after_attempt
import chromadb
from paths import CHROMA_DB_DIR, MANIFEST_FILE, RATE_STATE_FILE, ensure_runtime_dirs

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

PROJECT_DIR = Path(__file__).resolve().parent.parent
CHROMA_DIR = CHROMA_DB_DIR
MANIFEST_PATH = MANIFEST_FILE
EMBEDDING_MODEL = "gemini-embedding-2-preview"
EMBEDDING_DIM = 768

SUPPORTED = {
    "pdf":  "pdf",
    "jpg":  "image", "jpeg": "image", "png": "image",
    "gif":  "image", "webp": "image", "heic": "image",
    "mp4":  "video", "mov":  "video", "avi":  "video", "mkv":  "video",
}

MIME_MAP = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "gif": "image/gif", "webp": "image/webp", "heic": "image/heic",
    "mp4": "video/mp4", "mov": "video/mp4", "avi": "video/mp4", "mkv": "video/mp4",
}

# Directories to always skip (case-insensitive basenames)
SKIP_DIRS = {
    ".trash", ".git", ".svn", ".hg", "__pycache__", "node_modules",
    ".npm", ".cache", ".venv", "venv", "env", ".env",
    ".tox", ".mypy_cache", ".pytest_cache",
    "library", ".library",
    ".spotlight-v100", ".fseventsd", ".temporaryitems",
    ".ds_store", "thumbs.db",
    "site-packages", "dist-packages",
    ".local", ".cargo", ".rustup", ".go",
    "build", "dist", ".build",
    ".xcode", "deriveddata",
    "photos library.photoslibrary",
}

# Free-tier Gemini limits: 15 RPM, 1500 RPD
RATE_LIMIT_RPM = 14
RATE_LIMIT_INTERVAL = 60.0 / RATE_LIMIT_RPM
DAILY_LIMIT = 1450

# ---------------------------------------------------------------------------
# Rate limiter
# ---------------------------------------------------------------------------

class RateLimiter:
    """Simple rate limiter for free-tier Gemini API."""

    def __init__(self):
        self.state_path = RATE_STATE_FILE
        self.last_call = 0.0
        self.daily_calls = 0
        self.day_key = time.strftime("%Y-%m-%d")
        self._load()

    def _load(self):
        if self.state_path.exists():
            try:
                state = json.loads(self.state_path.read_text())
                if state.get("day") == self.day_key:
                    self.daily_calls = state.get("calls", 0)
            except Exception:
                pass

    def _save(self):
        self.state_path.write_text(json.dumps({
            "day": self.day_key,
            "calls": self.daily_calls,
        }))

    def wait(self):
        if self.daily_calls >= DAILY_LIMIT:
            print(f"\n⚠  Daily API limit reached ({DAILY_LIMIT} calls).")
            print("   Re-run tomorrow to continue — already-indexed files will be skipped.")
            self._save()
            sys.exit(0)

        elapsed = time.time() - self.last_call
        if elapsed < RATE_LIMIT_INTERVAL:
            time.sleep(RATE_LIMIT_INTERVAL - elapsed)

        self.last_call = time.time()
        self.daily_calls += 1
        if self.daily_calls % 50 == 0:
            self._save()

    def finish(self):
        self._save()

    @property
    def remaining(self):
        return max(0, DAILY_LIMIT - self.daily_calls)

# ---------------------------------------------------------------------------
# Init
# ---------------------------------------------------------------------------

api_key = os.environ.get("GOOGLE_API_KEY")
if not api_key:
    sys.exit("ERROR: GOOGLE_API_KEY environment variable not set.")

ensure_runtime_dirs()
client = genai.Client(api_key=api_key)

chroma_client = chromadb.PersistentClient(path=str(CHROMA_DIR))
collection = chroma_client.get_or_create_collection(
    name="multimodal_index",
    metadata={"hnsw:space": "cosine"},
)

splitter = RecursiveCharacterTextSplitter(chunk_size=800, chunk_overlap=100)
rate_limiter = RateLimiter()

# ---------------------------------------------------------------------------
# Manifest helpers
# ---------------------------------------------------------------------------

def load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        return json.loads(MANIFEST_PATH.read_text())
    return {}


def save_manifest(manifest: dict):
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2))


def file_hash(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return h.hexdigest()


def should_skip_dir(dir_path: Path) -> bool:
    name_lower = dir_path.name.lower()
    if name_lower.startswith("."):
        if name_lower not in {".obsidian"}:
            return True
    return name_lower in SKIP_DIRS

# ---------------------------------------------------------------------------
# Embedding helpers (Gemini Embedding 2 — natively multimodal)
# ---------------------------------------------------------------------------

@retry(wait=wait_exponential(min=4, max=60), stop=stop_after_attempt(3))
def embed_text(text: str) -> list[float]:
    """Embed a text string."""
    rate_limiter.wait()
    result = client.models.embed_content(
        model=EMBEDDING_MODEL,
        contents=text,
        config=types.EmbedContentConfig(output_dimensionality=EMBEDDING_DIM),
    )
    return result.embeddings[0].values


@retry(wait=wait_exponential(min=4, max=60), stop=stop_after_attempt(3))
def embed_media(path: str, mime_type: str) -> list[float]:
    """Embed an image or video file directly (no text description needed)."""
    rate_limiter.wait()
    with open(path, "rb") as f:
        data = f.read()
    result = client.models.embed_content(
        model=EMBEDDING_MODEL,
        contents=types.Part.from_bytes(data=data, mime_type=mime_type),
        config=types.EmbedContentConfig(output_dimensionality=EMBEDDING_DIM),
    )
    return result.embeddings[0].values

# ---------------------------------------------------------------------------
# Per-type indexers
# ---------------------------------------------------------------------------

def index_pdf(path: str) -> list[dict]:
    """Extract text from PDF, chunk it, embed each chunk."""
    reader = PdfReader(path)
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    if not text.strip():
        return []
    chunks = splitter.split_text(text)
    results = []
    for i, chunk in enumerate(chunks):
        embedding = embed_text(chunk)
        results.append({
            "id": f"{path}::chunk{i}",
            "embedding": embedding,
            "document": chunk,
            "metadata": {"source": path, "type": "pdf", "name": Path(path).name},
        })
    return results


def index_image(path: str) -> list[dict]:
    """Embed image directly using Gemini Embedding 2."""
    ext = Path(path).suffix.lstrip(".").lower()
    mime = MIME_MAP.get(ext, "image/jpeg")
    embedding = embed_media(path, mime)
    return [{
        "id": path,
        "embedding": embedding,
        "document": f"[Image: {Path(path).name}]",
        "metadata": {"source": path, "type": "image", "name": Path(path).name},
    }]


def index_video(path: str) -> list[dict]:
    """Embed video directly using Gemini Embedding 2. Clips to 60s if >20MB."""
    size_mb = Path(path).stat().st_size / (1024 * 1024)
    work_path = path

    if size_mb > 20:
        seg = path + "_segment.mp4"
        subprocess.run(
            ["ffmpeg", "-i", path, "-t", "60", "-c", "copy", seg, "-y"],
            capture_output=True,
        )
        work_path = seg

    ext = Path(work_path).suffix.lstrip(".").lower()
    mime = MIME_MAP.get(ext, "video/mp4")
    embedding = embed_media(work_path, mime)

    if work_path != path and Path(work_path).exists():
        Path(work_path).unlink()

    return [{
        "id": path,
        "embedding": embedding,
        "document": f"[Video: {Path(path).name}]",
        "metadata": {"source": path, "type": "video", "name": Path(path).name},
    }]

HANDLERS = {"pdf": index_pdf, "image": index_image, "video": index_video}

# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------

def discover_files(folder: Path) -> list[Path]:
    files = []
    stack = [folder]
    while stack:
        current = stack.pop()
        try:
            entries = sorted(current.iterdir())
        except PermissionError:
            continue
        for entry in entries:
            if entry.is_dir():
                if not should_skip_dir(entry):
                    stack.append(entry)
            elif entry.is_file():
                ext = entry.suffix.lstrip(".").lower()
                if ext in SUPPORTED:
                    files.append(entry)
    return files

# ---------------------------------------------------------------------------
# Main indexing loop
# ---------------------------------------------------------------------------

def index_folder(folder_path: str, manifest: dict) -> tuple[int, int, int]:
    """Index a single folder. Returns (indexed_count, skipped_count, error_count)."""
    folder = Path(folder_path).expanduser().resolve()
    if not folder.exists():
        print(f"⚠  Folder not found: {folder}")
        return 0, 0, 0

    indexed = 0
    errors = 0
    skipped = 0

    print(f"\n{'='*60}")
    print(f"Scanning: {folder}")
    print(f"API calls remaining today: {rate_limiter.remaining}")
    print(f"{'='*60}")

    files = discover_files(folder)
    total = len(files)
    print(f"Found {total} supported files\n")

    for i, file in enumerate(files, 1):
        ext = file.suffix.lstrip(".").lower()
        file_type = SUPPORTED[ext]
        fpath = str(file)

        try:
            fhash = file_hash(fpath)
        except (PermissionError, OSError):
            continue

        if manifest.get(fpath) == fhash:
            skipped += 1
            continue

        tag = file_type.upper()[:3]
        print(f"  [{tag}] ({i}/{total}) {file.name}")

        try:
            items = HANDLERS[file_type](fpath)
            # Add to ChromaDB
            for item in items:
                collection.upsert(
                    ids=[item["id"]],
                    embeddings=[item["embedding"]],
                    documents=[item["document"]],
                    metadatas=[item["metadata"]],
                )
            manifest[fpath] = fhash
            indexed += len(items)
        except Exception as e:
            print(f"    ERROR: {e}")
            errors += 1

        # Save manifest periodically
        if indexed % 20 == 0 and indexed > 0:
            save_manifest(manifest)

    return indexed, skipped, errors


def index_multiple(folders: list[str]):
    manifest = load_manifest()
    total_indexed = 0
    total_errors = 0
    total_skipped = 0

    for folder in folders:
        indexed, skipped, errors = index_folder(folder, manifest)
        total_indexed += indexed
        total_errors += errors
        total_skipped += skipped

    save_manifest(manifest)
    rate_limiter.finish()

    print(f"\n{'='*60}")
    if total_indexed:
        print(f"Done! {total_indexed} new chunks indexed, {total_skipped} files unchanged, {total_errors} errors")
    else:
        print(f"All {total_skipped} files already up to date.")
    print(f"API calls remaining today: {rate_limiter.remaining}")


# ---------------------------------------------------------------------------
# Default folders
# ---------------------------------------------------------------------------

DEFAULT_FOLDERS = [
    str(Path.home() / "Documents"),
    str(Path.home() / "Desktop"),
    str(Path.home() / "Downloads"),
    str(Path.home() / "Pictures"),
    str(Path.home() / "Movies"),
]

def index_specific_files(file_paths: list[str]):
    """Index an explicit list of file paths, bypassing folder discovery."""
    manifest = load_manifest()
    total = len(file_paths)
    indexed = skipped = errors = 0

    print(f"\n{'='*60}")
    print(f"Indexing {total} selected file(s)")
    print(f"API calls remaining today: {rate_limiter.remaining}")
    print(f"{'='*60}\n")

    for i, fpath in enumerate(file_paths, 1):
        file = Path(fpath)
        if not file.exists():
            print(f"  SKIP ({i}/{total}) {file.name} — not found")
            skipped += 1
            continue

        ext = file.suffix.lstrip(".").lower()
        if ext not in SUPPORTED:
            print(f"  SKIP ({i}/{total}) {file.name} — unsupported type")
            skipped += 1
            continue

        file_type = SUPPORTED[ext]

        try:
            fhash = file_hash(fpath)
        except (PermissionError, OSError):
            skipped += 1
            continue

        if manifest.get(fpath) == fhash:
            skipped += 1
            continue

        tag = file_type.upper()[:3]
        print(f"  [{tag}] ({i}/{total}) {file.name}")

        try:
            items = HANDLERS[file_type](fpath)
            for item in items:
                collection.upsert(
                    ids=[item["id"]],
                    embeddings=[item["embedding"]],
                    documents=[item["document"]],
                    metadatas=[item["metadata"]],
                )
            manifest[fpath] = fhash
            indexed += len(items)
        except Exception as e:
            print(f"    ERROR: {e}")
            errors += 1

        if indexed % 20 == 0 and indexed > 0:
            save_manifest(manifest)

    save_manifest(manifest)
    rate_limiter.finish()

    print(f"\n{'='*60}")
    if indexed:
        print(f"Done! {indexed} chunks indexed, {skipped} skipped, {errors} errors")
    else:
        print(f"All {skipped} files already up to date.")
    print(f"API calls remaining today: {rate_limiter.remaining}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--files":
        # Index specific files: api/indexer.py --files /path/to/a.pdf /path/to/b.jpg ...
        index_specific_files(sys.argv[2:])
    elif len(sys.argv) > 1:
        index_multiple(sys.argv[1:])
    else:
        folders = [f for f in DEFAULT_FOLDERS if Path(f).exists()]
        print(f"No folders specified — indexing default folders:")
        for f in folders:
            print(f"  • {f}")
        index_multiple(folders)
