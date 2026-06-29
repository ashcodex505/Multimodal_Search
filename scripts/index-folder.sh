#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Index Folder
# @raycast.mode fullOutput
# @raycast.packageName Multimodal Search
# @raycast.icon 📂

# Optional parameters:
# @raycast.description Index a folder so its files appear in Multimodal Search
# @raycast.author ash
# @raycast.argument1 { "type": "text", "placeholder": "Folder path (e.g. ~/Documents)", "optional": false }

ENV_FILE="$HOME/multimodal-search/.env"
if [ -f "$ENV_FILE" ]; then
  export $(grep -v '^#' "$ENV_FILE" | xargs)
fi

if [ -z "$GOOGLE_API_KEY" ]; then
  echo "ERROR: GOOGLE_API_KEY is not set."
  echo "Add it to ~/multimodal-search/.env like: GOOGLE_API_KEY=your-key-here"
  exit 1
fi

FOLDER="$1"
PROJECT_DIR="$HOME/multimodal-search"
PYTHON="$PROJECT_DIR/venv/bin/python3"
INDEXER="$PROJECT_DIR/api/indexer.py"

echo "Starting indexing of: $FOLDER"
echo "This may take a while for large folders..."
echo "─────────────────────────────────────────"

"$PYTHON" "$INDEXER" "$FOLDER"
