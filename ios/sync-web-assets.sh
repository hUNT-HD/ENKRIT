#!/bin/bash
# Sync web assets from src/ into the iOS app bundle folder.
# iOS equivalent of the Android Gradle `syncWebAssets` task.
# Run this after ANY change to src/ and before building in Xcode:
#   ./ios/sync-web-assets.sh
set -e
cd "$(dirname "$0")/.."

DEST="ios/ENKRIT/www"
mkdir -p "$DEST/fonts"
cp src/index.html src/style.css src/app.js "$DEST/"
cp src/fonts/*.ttf "$DEST/fonts/"
echo "Synced src/ -> $DEST"
