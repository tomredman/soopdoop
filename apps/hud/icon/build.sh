#!/bin/sh
# ABOUTME: Builds the app icon: renders the art in Blender (icon.py), fits it to Apple's macOS icon template at every size
# ABOUTME: (template.swift), and packs AppIcon.icns, plus icon-1024.png to look at. Run: sh apps/hud/icon/build.sh [samples]
set -eu

here=$(cd "$(dirname "$0")" && pwd)
samples=${1:-2048}
blender=$(command -v blender || echo /Applications/Blender.app/Contents/MacOS/Blender)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

"$blender" --background --python "$here/icon.py" -- "$work/art.png" "$samples"
xcrun swift "$here/template.swift" "$work/art.png" "$work/AppIcon.iconset"
iconutil --convert icns "$work/AppIcon.iconset" --output "$here/AppIcon.icns"
cp "$work/AppIcon.iconset/icon_512x512@2x.png" "$here/icon-1024.png"
echo "wrote $here/AppIcon.icns and $here/icon-1024.png"
