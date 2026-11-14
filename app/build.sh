#!/bin/bash
# Builds app/build/AgentBoard.app from AgentBoard.swift and icon-1024.png.
#   app/build.sh             build only
#   app/build.sh --install   build, then copy to ~/Applications/AgentBoard.app
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$APP_DIR")"
BUILD="$APP_DIR/build"
APP="$BUILD/AgentBoard.app"

INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (try --install)" >&2; exit 2 ;;
  esac
done

mkdir -p "$BUILD"

echo "==> Compiling"
swiftc -O -parse-as-library -swift-version 5 -target arm64-apple-macos13 \
  -framework Cocoa -framework WebKit \
  "$APP_DIR/AgentBoard.swift" -o "$BUILD/AgentBoard.bin"

echo "==> Making the icon"
ICONSET="$BUILD/AppIcon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$APP_DIR/icon-1024.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$APP_DIR/icon-1024.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$BUILD/AppIcon.icns"
rm -rf "$ICONSET"

echo "==> Assembling AgentBoard.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mv "$BUILD/AgentBoard.bin" "$APP/Contents/MacOS/AgentBoard"
mv "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
PLIST="$APP/Contents/Info.plist"
cat > "$PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>AgentBoard</string>
  <key>CFBundleDisplayName</key><string>AgentBoard</string>
  <key>CFBundleIdentifier</key><string>app.agentboard.desktop</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleExecutable</key><string>AgentBoard</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST
# plutil escapes the path properly, whatever characters it has.
plutil -insert AgentBoardProject -string "$PROJECT_DIR" "$PLIST"
plutil -lint "$PLIST"

echo "==> Signing (ad-hoc)"
codesign --force --deep -s - "$APP"
codesign -v "$APP"

echo "Built $APP"
echo "Project folder: $PROJECT_DIR"

if [ "$INSTALL" = 1 ]; then
  DEST="$HOME/Applications/AgentBoard.app"
  mkdir -p "$HOME/Applications"
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  touch "$DEST"
  echo "Installed $DEST"
fi
