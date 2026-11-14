#!/bin/bash
# Renders icon.svg to icon-1024.png with headless Chrome (only needed after editing the SVG).
# build.sh turns icon-1024.png into AppIcon.icns, so normal rebuilds don't need Chrome.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Google Chrome not found at $CHROME" >&2; exit 1; }
PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --user-data-dir="$PROFILE" --default-background-color=00000000 --window-size=1024,1024 \
  --screenshot="$HERE/icon-1024.png" "file://$HERE/icon.svg" >/dev/null 2>&1
sips -g pixelWidth -g pixelHeight "$HERE/icon-1024.png" | tail -2
