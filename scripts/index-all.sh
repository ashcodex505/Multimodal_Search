#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Index All My Files
# @raycast.mode fullOutput
# @raycast.packageName Multimodal Search
# @raycast.icon 🗂️

# Optional parameters:
# @raycast.description Index Documents, Desktop, Downloads, Pictures & Movies
# @raycast.author ash

ENV_FILE="$HOME/multimodal-search/.env"
if [ -f "$ENV_FILE" ]; then
  export $(grep -v '^#' "$ENV_FILE" | xargs)
fi

if [ -z "$GOOGLE_API_KEY" ]; then
  echo "ERROR: GOOGLE_API_KEY is not set."
  echo "Add it to ~/multimodal-search/.env like: GOOGLE_API_KEY=your-key-here"
  exit 1
fi

PROJECT_DIR="$HOME/multimodal-search"
PYTHON="$PROJECT_DIR/venv/bin/python3"
INDEXER="$PROJECT_DIR/api/indexer.py"

echo "Indexing all your folders (Documents, Desktop, Downloads, Pictures, Movies)"
echo "This runs in the background — already-indexed files are skipped automatically."
echo "Free tier: ~14 files/min, stops at daily limit and resumes next run."
echo "─────────────────────────────────────────"

"$PYTHON" "$INDEXER"
