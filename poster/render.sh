#!/bin/bash
# Render the launch poster to PNG using headless Chrome.
# Edit lab-launch-poster.html, then run:  bash poster/render.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

"$CHROME" --headless --disable-gpu --no-sandbox \
  --screenshot="$DIR/elias-lab-launch-poster.png" \
  --window-size=2160,2700 \
  --virtual-time-budget=8000 \
  --hide-scrollbars \
  --allow-file-access-from-files \
  "$DIR/lab-launch-poster.html" 2>/dev/null

echo "wrote poster/elias-lab-launch-poster.png"
file "$DIR/elias-lab-launch-poster.png"
