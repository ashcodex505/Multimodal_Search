# `api`

This folder contains the Python backend for the project. It owns indexing, search, Atlas dataset preparation, and the FastAPI server that exposes the dashboard endpoints.

## Key Files

- `launch.py`: starts the Atlas-based web server and mounts the project-specific API routes.
- `indexer.py`: scans files, embeds them with Gemini, and writes vectors into ChromaDB.
- `prepare_atlas.py`: converts indexed data into Atlas-ready parquet and cluster metadata.
- `searcher.py`: command-line semantic search entrypoint.
- `paths.py`: shared path definitions for the repo layout.

## Role In The Project

- This is the main backend/source folder.
- Anything that exposes API endpoints or talks to external AI/search services should live here.
