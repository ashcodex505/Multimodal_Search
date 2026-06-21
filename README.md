# Multimodal Search

A local, self-hostable semantic search engine for your files — images, PDFs, and videos — with a full visual exploration UI. Ask questions in plain English and find files by what they *contain*, not just what they're named.

Built on top of [Apple Embedding Atlas](https://github.com/apple/embedding-atlas), Google's Gemini Embedding 2 model, and ChromaDB.

---

## What it does

- **Semantic search** — type "slides about machine learning" or "screenshot of that error message" and find matching files across your entire machine, even if the filename says nothing
- **Visual scatter map** — every indexed file becomes a dot on a 2D map where similar files cluster together; zoom, pan, and explore
- **Graph mode** — full-screen interactive node graph with neighbor links, minimap, keyboard navigation, and thumbnail previews
- **Index from the UI** — pick folders and watch files get embedded in real time; already-indexed files are skipped automatically
- **Delete from the UI** — remove files from the index (and optionally from disk) via the dashboard; cmd+click to select multiple
- **Raycast integration** — search and index from Raycast without opening a browser
- **macOS .app launcher** — one click from Spotlight to open the dashboard

---

## How it works

The system has three stages that run in sequence:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          DATA PIPELINE                                  │
│                                                                         │
│  Your files                                                             │
│      │                                                                  │
│      ▼                                                                  │
│  indexer.py ──► Gemini Embedding 2 ──► 768-dim vector ──► ChromaDB    │
│      │                                                                  │
│      ▼                                                                  │
│  prepare_atlas.py                                                       │
│    - Pull all vectors from ChromaDB                                     │
│    - Load UMAP x/y coordinates (computed by Atlas on first load)        │
│    - Compute k-nearest neighbors (cosine similarity)                    │
│    - Run k-means clustering → semantic cluster labels                   │
│    - Generate thumbnails (images + video frame grabs)                   │
│    - Save atlas_data.parquet                                            │
│      │                                                                  │
│      ▼                                                                  │
│  launch.py ──► FastAPI server on :5055                                  │
│    - Serves Apple Embedding Atlas (WebGL scatter)                       │
│    - Injects search_panel.js + search_panel.css                         │
│    - Exposes /gemini-search, /open-file, /api/* endpoints              │
└─────────────────────────────────────────────────────────────────────────┘
```

### What happens when you search

1. You type a query in the search panel
2. The JS POSTs to `/gemini-search`
3. The server embeds your query with Gemini (same 768-dimensional vector space as the indexed files)
4. ChromaDB finds the ~40 most similar vectors using cosine similarity + HNSW indexing
5. The server returns file metadata, thumbnails, and match scores
6. The JS highlights matching dots on the Atlas scatter by updating a `search_match` column via the DuckDB REST endpoint that Atlas exposes internally

---

## Prerequisites

You need the following on your Mac before starting:

| Tool | Why | Install |
|------|-----|---------|
| **Python 3.11+** | Runs all backend scripts | `brew install python` |
| **ffmpeg** | Generates video thumbnails | `brew install ffmpeg` |
| **Node.js 18+** | Only needed for Raycast extension | `brew install node` |
| **Homebrew** | Makes the above easy | [brew.sh](https://brew.sh) |
| **Google API key** | Powers Gemini embeddings (free tier available) | [aistudio.google.com](https://aistudio.google.com) |

---

## Setup (new Mac, step by step)

### 1 — Clone the repo

```bash
git clone <your-repo-url> ~/multimodal-search
cd ~/multimodal-search
```

### 2 — Create a Python virtual environment

```bash
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
pip install embedding-atlas   # Apple's scatter-plot library
```

> **Note:** `embedding-atlas` is not in `requirements.txt` because it needs to be installed separately after the rest. If you hit dependency conflicts, install it first, then `pip install -r requirements.txt`.

### 3 — Add your Google API key

Create a `.env` file in the project root:

```bash
echo "GOOGLE_API_KEY=your_key_here" > .env
```

Get a free key at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).

**Free tier limits:** 15 requests/minute, 1,500 requests/day. The indexer handles this automatically — it throttles itself and saves its progress so you can resume the next day.

### 4 — Index your files

Run the indexer on whatever folders you want:

```bash
source venv/bin/activate
python indexer.py                          # defaults: Documents, Desktop, Downloads, Pictures, Movies
python indexer.py ~/Desktop ~/Projects     # custom folders
```

This is the slow step. Each file costs one Gemini API call (images and videos are embedded directly; PDFs are chunked and each chunk costs one call). At 14 requests/minute on the free tier, expect ~5–10 minutes per 100 files. Already-indexed files are skipped on future runs.

### 5 — Build the visualization data

```bash
python prepare_atlas.py
```

This pulls everything from ChromaDB, computes nearest neighbors, generates thumbnails, runs k-means clustering, and writes `atlas_data.parquet`. Takes 1–3 minutes depending on collection size.

> **Important:** You must re-run this after indexing new files for them to appear in the scatter map and graph view. The web UI has a shortcut that triggers `indexer.py` but you still need to re-run `prepare_atlas.py` and restart the server afterward to see new files in the graph.

### 6 — Launch the dashboard

```bash
python launch.py
```

Opens `http://localhost:5055` in your browser automatically. The search panel appears on the right side.

---

## File structure

```
multimodal-search/
│
├── indexer.py           # Scans folders, embeds files via Gemini, stores in ChromaDB
├── prepare_atlas.py     # Exports ChromaDB → atlas_data.parquet (UMAP, neighbors, thumbnails, clusters)
├── launch.py            # FastAPI server — runs Atlas + custom API endpoints
├── searcher.py          # CLI search tool (also used by Raycast extension)
│
├── search_panel.js      # ~1,900 lines — the entire custom UI overlay injected into Atlas
├── search_panel.css     # ~600 lines — styles for the search panel, graph mode, modals
│
├── requirements.txt     # Python dependencies
├── .env                 # Your API key (not committed to git)
├── manifest.json        # Tracks which files have been indexed (path → MD5 hash)
│
├── atlas_data.parquet   # The dataset Atlas reads — regenerated by prepare_atlas.py
├── cluster_meta.json    # K-means cluster centroids + labels for the graph overlay
├── chroma_db/           # ChromaDB vector database (persisted to disk)
│
├── scripts/             # Raycast script commands (bash wrappers)
│   ├── index-all.sh         # Raycast: index all default folders
│   ├── index-folder.sh      # Raycast: index a specific folder
│   └── multimodal-search.sh # Raycast: search and open top result
│
├── raycast-extension/   # Full Raycast extension (TypeScript / React)
│   ├── src/search.tsx       # Search UI with live results, open/reveal/delete actions
│   └── package.json
│
└── Multimodal Search.app  # macOS .app bundle — launches server + opens browser
```

---

## Usage

### Web dashboard

| Feature | How to use |
|---------|------------|
| **Search** | Type in the search box → results appear as cards with thumbnails and match % |
| **Filter by type** | Use the dropdown next to the search box (All / Images / PDFs / Videos) |
| **Open a file** | Click **Open** on any result card, or double-click a dot in the graph |
| **Reveal in Finder** | Click **Show in Finder** on any result card |
| **Reset view** | Click **⟳ Reset** in the Atlas toolbar to clear search, highlights, and filters |
| **Index new files** | Click **📂 Index Files** → pick folders → preview new files → watch progress |
| **Delete files** | Click **🗑 Delete** on a card, or cmd+click rows in the data table |

### Graph mode

Click **⬡ Graph** in the Atlas toolbar to open the full-screen interactive graph.

| Action | Result |
|--------|--------|
| **Scroll / two-finger swipe** | Pan the graph |
| **Pinch / Ctrl+scroll** | Zoom in/out |
| **Click a node** | Pin it — shows popup with thumbnail, metadata, and 10 nearest neighbors |
| **Click a neighbor** | Navigate to that node (builds a back-history) |
| **← → keys (or b / n)** | Navigate back/forward through pinned history |
| **/ or f** | Focus the node search filter |
| **Esc** | Dismiss popup / close graph |
| **⌘+click a node** | Add to selection for bulk delete |
| **Double-click a node** | Open the file |
| **Minimap (bottom-right)** | Shows full graph + gold rectangle = current viewport |

### Atlas scatter (main view)

| Action | Result |
|--------|--------|
| **Two-finger swipe** | Pan the scatter plot |
| **Pinch** | Zoom |
| **Click a dot** | Shows file tooltip with Open / Reveal / Delete buttons |
| **Lasso (click + drag on empty area)** | Selects a region → shows "Delete Selected" float |
| **⌘+click table rows** | Precise file selection → shows exact file list in delete float |
| **Shift+click table rows** | Range select in data table |

### Command line

```bash
# Search
source venv/bin/activate
python searcher.py "lecture notes on neural networks"
python searcher.py --type pdf "contract"
python searcher.py --type image "cat sitting on a desk"

# Index
python indexer.py ~/Documents ~/Desktop
python indexer.py                          # all default folders

# Rebuild visualization
python prepare_atlas.py

# Start server
python launch.py
python launch.py --port 8080 --no-browser
```

---

## Raycast integration (optional)

### Script commands (simplest)

Add the `scripts/` folder to Raycast as a Script Commands directory:

1. Open Raycast → Extensions → Script Commands → Add Directory
2. Point it at `~/multimodal-search/scripts/`
3. Three commands appear: **Multimodal Search**, **Index All My Files**, **Index Folder**

### Full extension (live search UI)

```bash
cd raycast-extension
npm install
npm run dev    # opens Raycast in dev mode with the extension loaded
```

The extension provides a live-search interface with type filtering, Open / Show in Finder / Copy Path / Delete actions, and a debounced 500ms search.

---

## macOS .app launcher

The `Multimodal Search.app` bundle in the project root can be placed in `/Applications` or your Dock. It starts the server and opens the browser in one click and is searchable from Spotlight.

---

## Server API reference

All endpoints are on `http://localhost:5055`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/gemini-search` | Semantic search. Body: `{ query, type_filter?, k? }` |
| `GET` | `/api/map-coords` | All file coordinates + metadata (lightweight, used by graph mode) |
| `GET` | `/api/scan-folders` | Discover new (un-indexed) files in folders. Query: `?folders=path1,path2` |
| `GET` | `/api/index-stream` | SSE stream — runs `indexer.py` in a subprocess, streams log lines. Query: `?folders=...` |
| `POST` | `/api/delete-items` | Remove items from ChromaDB + optionally disk. Body: `{ paths: [], delete_file: bool }` |
| `POST` | `/open-file` | Open or reveal a file in Finder. Body: `{ path, action: "open"\|"reveal" }` |
| `GET` | `/static/cluster_meta.json` | K-means cluster centroids and labels for graph overlay |
| `POST` | `/data/query` | Atlas's DuckDB REST endpoint — query the parquet directly from JS |

---

## Architecture notes for developers

### `search_panel.js` — how the UI injection works

Atlas is a Svelte app served as static files. `launch.py` copies Atlas's static dir to a temp folder, then appends `<script src="/search_panel.js">` to `index.html` before serving it. The JS runs after Atlas initializes and:

- Appends DOM elements (search panel, modals, graph overlay, delete float) to `document.body`
- Uses `MutationObserver` + polling to detect when Atlas renders its data table or tooltip, then injects action buttons
- Communicates with Atlas via its built-in DuckDB REST endpoint (`POST /data/query`) to highlight search results and read selection state
- Uses capture-phase event listeners (`addEventListener(fn, true)`) to intercept cmd+clicks before Atlas's handlers

### ChromaDB schema

All files share one collection named `multimodal_index` with cosine similarity (HNSW). Each record:

```
id:        file path (images/videos) OR "filepath::chunkN" (PDFs)
embedding: float[768]  — Gemini Embedding 2 output
document:  text string — "[Image: name.jpg]" or PDF chunk text
metadata:  { source: "/abs/path", type: "image"|"pdf"|"video", name: "file.jpg" }
```

PDF files produce multiple records (one per ~800-char chunk). `prepare_atlas.py` deduplicates them back to one row per file by averaging chunk embeddings.

### `atlas_data.parquet` schema

| Column | Type | Description |
|--------|------|-------------|
| `row_id` | int | Sequential index (matches neighbor IDs) |
| `doc_id` | str | ChromaDB document ID |
| `path` | str | Absolute file path |
| `name` | str | Filename |
| `type` | str | `image` / `pdf` / `video` |
| `x`, `y` | float | UMAP 2D coordinates (loaded from Atlas's cache) |
| `preview_text` | str | PDF text excerpt or placeholder |
| `thumbnail` | str \| null | Base64 JPEG data-URL (220×220) |
| `neighbors` | JSON | `{ ids: [int], distances: [float] }` — 25 nearest neighbors |
| `cluster_id` | int | K-means cluster (0–15) |
| `cluster_label` | str | Top-3 keyword label for the cluster |

### UMAP coordinates — the chicken-and-egg

Atlas computes UMAP projections internally (in the browser using WebAssembly) and caches the x/y coordinates to a `.cache/` directory on first load. `prepare_atlas.py` reads those cached coordinates. This means:

1. First ever run: launch the server, let Atlas load the scatter, wait for the dots to appear (~30s–2min depending on collection size), then close the server and run `prepare_atlas.py`
2. After adding new files: the new files won't have UMAP coords until Atlas re-runs its projection. Re-running `prepare_atlas.py` then restarting the server will trigger a new projection automatically

### Rate limiting

The free Gemini API tier allows 15 requests/minute and 1,500/day. `indexer.py` enforces:
- A minimum interval of `60/14 ≈ 4.3s` between calls
- A daily counter persisted to `.rate_state.json` that resets at midnight
- Automatic `sys.exit()` when the daily limit is reached (with a message to resume tomorrow)
- Exponential backoff retry (4–60s, max 3 attempts) via `tenacity` for transient errors

---

## Updating the index

When you add, move, or delete files, follow this sequence:

```bash
# 1. Re-index (skips already-indexed files automatically)
source venv/bin/activate
python indexer.py ~/new-folder

# 2. Rebuild the parquet (UMAP + neighbors + thumbnails)
python prepare_atlas.py

# 3. Restart the server
pkill -f launch.py
python launch.py
```

Or use the **📂 Index Files** button in the web UI to trigger step 1 — it streams progress live. You still need to run steps 2 and 3 manually afterward to see new files in the scatter map.

---

## Troubleshooting

**Server shows `{"detail": "Not Found"}` on all pages**

A stale process is still holding port 5055. Kill it and restart:
```bash
lsof -ti :5055 | xargs kill -9
python launch.py
```

**"Nothing indexed yet. Run indexer.py first."**

`prepare_atlas.py` found an empty ChromaDB. Run `indexer.py` on at least one folder first.

**Dots appear on the scatter but graph mode says "Loading graph data…" forever**

The parquet is missing the `cluster_id` or `cluster_label` column (old parquet). Re-run `prepare_atlas.py`.

**New files don't appear after indexing**

You need to re-run `prepare_atlas.py` AND restart the server. The web UI's index flow only runs `indexer.py` (step 1). Steps 2 and 3 are still manual.

**Thumbnails don't appear for videos**

`ffmpeg` is not installed or not on `$PATH`. Install with `brew install ffmpeg`.

**Daily API limit hit mid-index**

The indexer saves its progress to `manifest.json` and `.rate_state.json`. Just re-run `python indexer.py` tomorrow — it resumes from where it stopped.

**`GOOGLE_API_KEY` not found**

Make sure your `.env` file is in the project root (same folder as `launch.py`) and contains exactly:
```
GOOGLE_API_KEY=AIza...your-key-here
```

**Raycast extension can't find Python**

The extension looks for `~/multimodal-search/venv/bin/python3`. If your project is in a different location, update `PROJECT_DIR` in `raycast-extension/src/search.tsx`.
# Multimodal_Search
