#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Multimodal Search
# @raycast.mode fullOutput
# @raycast.packageName Multimodal Search
# @raycast.icon 🔍

# Optional parameters:
# @raycast.description Search images, PDFs, and videos using AI
# @raycast.author ash
# @raycast.argument1 { "type": "text", "placeholder": "Search images, PDFs, videos...", "optional": false }
# @raycast.argument2 { "type": "text", "placeholder": "Type filter: pdf/image/video (optional)", "optional": true }


# Load API key from .env file if not already in environment
ENV_FILE="$HOME/multimodal-search/.env"
if [ -f "$ENV_FILE" ]; then
  export $(grep -v '^#' "$ENV_FILE" | xargs)
fi

if [ -z "$GOOGLE_API_KEY" ]; then
  echo "ERROR: GOOGLE_API_KEY is not set."
  echo "Add it to ~/multimodal-search/.env like: GOOGLE_API_KEY=your-key-here"
  exit 1
fi

QUERY="$1"
TYPE_FILTER="${2:-}"
PROJECT_DIR="$HOME/multimodal-search"
PYTHON="$PROJECT_DIR/venv/bin/python3"
SEARCHER="$PROJECT_DIR/api/searcher.py"

# Run the searcher and capture JSON output
ARGS="$QUERY"
if [ -n "$TYPE_FILTER" ]; then
  ARGS="--type $TYPE_FILTER $QUERY"
fi
RAW=$("$PYTHON" "$SEARCHER" $ARGS 2>/dev/null)

if [ -z "$RAW" ] || [ "$RAW" = "[]" ]; then
  echo "No results found for: \"$QUERY\""
  exit 0
fi

# Parse and display results, then open the top result
echo "Results for: \"$QUERY\""
echo "─────────────────────────────────────────"

# Use Python to pretty-print the JSON results
"$PYTHON" - "$RAW" << 'PYEOF'
import sys, json, subprocess

data = json.loads(sys.argv[1])

for i, r in enumerate(data, 1):
    icon = {"pdf": "📄", "image": "🖼️", "video": "🎬"}.get(r["type"], "📁")
    print(f"\n{icon} [{i}] {r['name']}")
    print(f"   Type:    {r['type'].upper()}  |  Score: {r['score']}")
    print(f"   Path:    {r['path']}")
    print(f"   Preview: {r['preview'][:150].strip()}...")

# Open the top result automatically
top_path = data[0]["path"]
print(f"\n─────────────────────────────────────────")
print(f"Opening top result: {data[0]['name']}")
subprocess.run(["open", top_path])
PYEOF
