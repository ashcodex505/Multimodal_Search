# Multimodal Search

Multimodal Search is a local semantic search system for images, PDFs, and videos. It uses Gemini embeddings to index file content, ChromaDB to store vectors, and Apple Embedding Atlas to render an interactive visualization/dashboard.

This root README is the main onboarding document for the project. If someone is new to the repo, start here first. The folder-level `README.md` files are there to add local context once you drill into a specific part of the tree.

## Table of Contents

- [What This Project Does](#what-this-project-does)
- [How The System Works](#how-the-system-works)
- [How To Navigate The Repo](#how-to-navigate-the-repo)
- [Setup](#setup)
  - [Prerequisites](#prerequisites)
  - [Initial Setup](#initial-setup)
  - [First-Time Startup](#first-time-startup)
- [Reference & Developer Docs](#folder-guide)

## What This Project Does

At a high level, the project lets a user:

- index local files from selected folders
- embed those files into a shared semantic vector space
- search them with natural language
- browse them in a dashboard and graph/scatter visualization
- trigger indexing and some management actions from the UI, Raycast, or a macOS launcher

The repo is split into four main concerns:

- backend/API code in `api/`
- browser and desktop-facing UI code in `ui-dashboard/`
- persistent vector database storage in `chroma-db/` <-- this will show up once you start indexing your file 
- generated metadata and Atlas artifacts in `search-index-data/` <-- also will show up once you start indexing your files by running indexer.py 

## How The System Works

The normal lifecycle is:

1. `api/indexer.py` scans files and creates embeddings.
2. Embeddings are written into ChromaDB under `chroma-db/`.
3. `api/prepare_atlas.py` reads that indexed data and produces visualization artifacts in `search-index-data/`.
4. `api/launch.py` starts the dashboard server and exposes the API routes used by the UI.

That means the project has two layers of data:

- search/index data in ChromaDB
- visualization/dashboard data in `search-index-data/atlas_data.parquet` and related files

If a developer understands that split, the repo becomes much easier to navigate.

## Repository Map

```text
multimodal-search/
├── api/                     # Python backend, indexing, search, and Atlas server
│   ├── launch.py
│   ├── indexer.py
│   ├── prepare_atlas.py
│   ├── searcher.py
│   └── paths.py
├── ui-dashboard/            # Browser UI, Raycast extension, and macOS launcher
│   ├── search_panel.js
│   ├── search_panel.css
│   ├── raycast-extension/
│   └── mac-app/
│       └── Multimodal Search.app
├── chroma-db/               # Persistent Chroma vector database
├── search-index-data/       # Generated metadata, manifests, parquet, caches
├── scripts/                 # Raycast-friendly shell wrappers
├── requirements.txt
├── .env
└── README.md
```

## How To Navigate The Repo

If you are trying to understand the project quickly, use this order:

1. Read `api/launch.py` to understand how the app is served and what routes exist.
2. Read `ui-dashboard/search_panel.js` to understand the main interactive UI behavior.
3. Read `api/indexer.py` to see how files become embeddings.
4. Read `api/prepare_atlas.py` to see how Chroma data becomes visualization data.
5. Read `api/searcher.py` to understand the simplest search flow without the dashboard.
6. Read `api/paths.py` to see the canonical repo layout and where generated/runtime files are supposed to live.

If your goal is more specific:

- API/backend bug: start in `api/`
- dashboard or interaction bug: start in `ui-dashboard/search_panel.js`
- broken indexing: start in `api/indexer.py`
- graph/scatter data problem: start in `api/prepare_atlas.py` and `search-index-data/`
- Raycast issue: start in `ui-dashboard/raycast-extension/` and `scripts/`
- launcher issue: start in `ui-dashboard/mac-app/`

## Folder Guide

### `api/`

This is the source of truth for the backend.

- `launch.py`: runs the server, injects the custom UI into Atlas, and exposes the API endpoints.
- `indexer.py`: discovers files, chunks PDFs, calls Gemini embeddings, and upserts vectors into ChromaDB.
- `prepare_atlas.py`: pulls vectors out of ChromaDB, computes visualization-friendly data, and writes Atlas artifacts.
- `searcher.py`: simple CLI entrypoint for search.
- `paths.py`: shared path constants so the repo structure is not hardcoded in multiple places.

### `ui-dashboard/`

This is the source of truth for user-facing UI outside the Python server.

- `search_panel.js`: the main dashboard logic injected into Atlas.
- `search_panel.css`: styling for the panel, graph, modals, and controls.
- `raycast-extension/`: TypeScript-based Raycast extension.
- `mac-app/`: checked-in macOS app bundle and launcher wrapper.

### `chroma-db/`

This is runtime database state. It is not normal source code.

- stores vector collections and index files
- used directly by backend search/index code
- should not usually be hand-edited

### `search-index-data/`

This is generated metadata used by the dashboard and visualization layers.

- `atlas_data.parquet`: main Atlas dataset
- `cluster_meta.json`: cluster labels/positions for graph overlays
- `manifest.json`: file hash tracking for incremental indexing
- `rate_state.json`: persisted Gemini rate-limit state
- `.cache/` and `.umap_cache.json`: projection/cache artifacts

### `scripts/`

This is a convenience layer for Raycast script commands and shell-based entrypoints. These scripts call into `api/` rather than containing core business logic themselves.

## Setup

### Prerequisites

- **Python 3.11 or newer** (the repo uses 3.13; 3.11/3.12 also work — 3.9/3.10 will not work)
- **ffmpeg** — required for video thumbnail extraction and clipping videos >20 MB before embedding. Install with Homebrew: `brew install ffmpeg`
- **A Google Gemini API key** — get one free at [aistudio.google.com](https://aistudio.google.com). The free tier covers 1,500 embedding calls per day, which is enough to index a few hundred files.
- **Node.js** — only needed if you want to work on the Raycast extension

If `python3 --version` returns 3.9 or 3.10, install a newer version first:

```bash
brew install python@3.11
```

Then verify the path is available:

```bash
python3.11 --version
```

### Initial Setup

```bash
git clone <your-repo-url> ~/multimodal-search
cd ~/multimodal-search

python3.11 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
pip install embedding-atlas
```

> **Note:** Use `python3.11` (or `python3.12`, `python3.13`) explicitly when creating the venv — not plain `python3`, which may still point to the system 3.9. Once the venv is active, `python` and `pip` inside it always use the version it was created with.

> **Note:** `embedding-atlas` is not in `requirements.txt` because it is a standalone Apple package. You must install it separately as shown above.

Create the root `.env` file with your API key:

```bash
echo "GOOGLE_API_KEY=your_key_here" > .env
```

### First-Time Startup

The startup sequence has a specific order that matters. Read through it before running anything.

### Step 1 — Index your files

This scans your files, embeds them with Gemini, and stores vectors in ChromaDB. With no arguments it defaults to Documents, Desktop, Downloads, Pictures, and Movies.

```bash
source venv/bin/activate
python api/indexer.py
```

Or specify folders explicitly:

```bash
python api/indexer.py ~/Desktop ~/Documents
```

This step makes API calls. The free tier allows ~1,450 calls per day. The indexer tracks this and will stop cleanly if you hit the limit — re-run it tomorrow and it will skip already-indexed files.

### Step 2 — Build the visualization dataset

```bash
python api/prepare_atlas.py
```

This computes UMAP coordinates, nearest neighbors, thumbnails, and k-means clustering, then writes `search-index-data/atlas_data.parquet`. You will see output like:

```
[1/6] Connecting to ChromaDB...
[2/6] Pulling vectors + metadata from ChromaDB...
[3/6] Loading UMAP coordinates...
...
✓ Saved atlas_data.parquet (1.5 MB, 953 rows)
```

### Step 3 — Launch the server

```bash
python api/launch.py
```

The server starts on `http://localhost:5055` and opens the browser automatically. The dashboard is now fully operational — search works, the scatter plot shows your files, and graph mode is available.

**After the first time,** day-to-day use is just `python api/launch.py`. Only re-run the indexer and `prepare_atlas.py` when you have new files to add.

## Day-To-Day Commands

Always activate the venv first if it is not already active and make sure it is using python 3.11

```bash
source ~/multimodal-search/venv/bin/activate
```

### Start the server

```bash
python api/launch.py
python api/launch.py --port 8080 --no-browser
```


### Index new files

Default folders (Documents, Desktop, Downloads, Pictures, Movies):

```bash
python api/indexer.py
```

Specific folders or individual files:

```bash
python api/indexer.py ~/Desktop ~/Projects
python api/indexer.py ~/Documents ~/Downloads
python api/indexer.py --files ~/Desktop/resume.pdf ~/Pictures/photo.jpg
```

After indexing, rebuild the visualization and restart the server:

```bash
python api/prepare_atlas.py
python api/launch.py
```

You can also trigger a rebuild from inside the dashboard using the "Index Files" button — it handles this automatically.

### CLI search (no dashboard needed)

```bash
python api/searcher.py "lecture notes on neural networks"
python api/searcher.py --type pdf "contract"
python api/searcher.py --type image "product screenshot"
```

## Important Developer Workflows

### If you change indexing logic

You usually need to:

1. re-run `python api/indexer.py`
2. re-run `python api/prepare_atlas.py`
3. restart `python api/launch.py`

### If you change dashboard UI code

You usually only need to:

1. restart `python api/launch.py`
2. refresh the browser

The UI assets are injected by `api/launch.py`, so dashboard changes typically do not require re-indexing.

### If you change path layout or runtime file locations

Update `api/paths.py` first. That file should remain the single shared definition of where backend code expects the repo’s generated/runtime data to live.

## Main Entry Points

These are the files a developer should know first:

- `api/launch.py`: main server entrypoint
- `api/indexer.py`: main indexing entrypoint
- `api/prepare_atlas.py`: main visualization-prep entrypoint
- `api/searcher.py`: main CLI search entrypoint
- `ui-dashboard/search_panel.js`: main interactive dashboard frontend

## API Surface

The server created by `api/launch.py` exposes project-specific routes plus Atlas internals.

### Search and file actions

- `POST /gemini-search`
- `POST /open-file`
- `POST /api/delete-items`

### Visualization/dashboard support

- `GET /api/map-coords`
- `GET /static/cluster_meta.json`
- `POST /data/query`

### Indexing support

- `GET /api/scan-folders`
- `GET /api/browse`
- `POST /api/index-session`
- `GET /api/index-files-stream/{session_id}`
- `GET /api/index-stream`

## Raycast

There are two Raycast integrations in the repo.

### Script commands

Point Raycast Script Commands at:

```bash
~/multimodal-search/scripts/
```

Those wrappers call the Python backend directly.

### Full extension

The full extension lives in:

```bash
ui-dashboard/raycast-extension/
```

To work on it:

```bash
cd ~/multimodal-search/ui-dashboard/raycast-extension
npm install
npm run dev
```

## macOS Launcher

The checked-in app bundle lives at:

```text
ui-dashboard/mac-app/Multimodal Search.app
```

It is a thin launcher around `api/launch.py`. If the desktop launcher breaks, inspect:

- the bundle script in `ui-dashboard/mac-app/Multimodal Search.app/Contents/MacOS/`
- the backend entrypoint in `api/launch.py`

## Generated Data vs Source Code

One of the easiest ways to get confused in this repo is mixing up authored code with generated output.

Source code folders:

- `api/`
- `ui-dashboard/`
- `scripts/`

Generated/runtime folders:

- `chroma-db/`
- `search-index-data/`

That distinction matters when debugging:

- if behavior is wrong, inspect source code first
- if results are stale or missing, inspect generated data next

## Common Problems

### `GOOGLE_API_KEY not set`

Make sure `.env` exists at the repo root and contains:

```bash
GOOGLE_API_KEY=your_key_here
```

### `atlas_data.parquet not found`

Run:

```bash
python api/prepare_atlas.py
```

### New files do not appear in the dashboard

The usual fix is:

```bash
python api/indexer.py <folders>
python api/prepare_atlas.py
python api/launch.py
```

If indexing ran but the graph/scatter is stale, the missing step is usually `prepare_atlas.py`.

### Video thumbnails are missing

Make sure `ffmpeg` is installed and available on `PATH`.

### Search works badly or returns stale results

Check:

1. whether the files were actually indexed into ChromaDB
2. whether `search-index-data/manifest.json` is stale or missing
3. whether you rebuilt `atlas_data.parquet` after indexing

## Contributing Guidance

If you add new backend behaviors, place them in `api/`.

If you add new dashboard interactions or views, place them in `ui-dashboard/`.

If you add new generated artifacts, they should generally live under `search-index-data/` rather than the repo root.

If you add new runtime data stores, keep them separate from source folders so the codebase remains navigable.
