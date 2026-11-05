#!/usr/bin/env bash
# Generate -> verify -> render a day's reels.
# Usage: ./make_reels.sh [count] [theme...]
set -euo pipefail
cd "$(dirname "$0")"
COUNT="${1:-3}"; shift || true
THEME="${*:-}"

if [ -n "$THEME" ]; then
  python3 generate_questions.py "$COUNT" --theme "$THEME" | tee /tmp/gen.log
else
  python3 generate_questions.py "$COUNT" | tee /tmp/gen.log
fi
BATCH=$(grep -o 'questions/batch-[0-9-]*\.json' /tmp/gen.log | tail -1)
python3 verify_questions.py "$BATCH"
python3 render.py "build/$(basename "${BATCH%.json}").verified.json"
echo "Done. Reels, covers and captions are in reels/out/"
