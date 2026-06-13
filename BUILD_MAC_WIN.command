#!/bin/bash
# ENKRIT — build macOS DMG + Windows ZIP. Double-click to run.
cd "$(dirname "$0")" || exit 1
echo "============================================="
echo "   ENKRIT Desktop Build  (Mac DMG + Win ZIP)"
echo "============================================="
echo ""

# Make sure node/npm are reachable
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm/node not found on PATH. Install Node.js first (https://nodejs.org)."
  read -p "Press Enter to close..."
  exit 1
fi
echo "node: $(node -v 2>/dev/null)   npm: $(npm -v 2>/dev/null)"
echo ""

# Install dependencies if missing. --force is needed because the project
# lists Windows-only ffmpeg binaries as deps (cross-platform packaging).
if [ ! -x node_modules/.bin/electron-builder ]; then
  echo "[setup] node_modules missing — installing dependencies (one-time, may take a few minutes)..."
  npm install --force --no-audit --no-fund
  if [ ! -x node_modules/.bin/electron-builder ]; then
    echo ""
    echo "ERROR: dependency install failed. See messages above."
    read -p "Press Enter to close..."
    exit 1
  fi
  echo "[setup] dependencies installed."
  echo ""
fi

echo "[1/2] Building macOS DMG (x64 + arm64)..."
npm run build:mac
MAC_RC=$?
echo ""

echo "[2/2] Building Windows ZIP (x64 + ia32)..."
npm run build:win
WIN_RC=$?
echo ""

echo "============================================="
echo "  macOS build  exit code: $MAC_RC"
echo "  Windows build exit code: $WIN_RC"
echo "  Output files:"
ls -lh dist/*.dmg dist/*.zip 2>/dev/null
echo "============================================="
open dist 2>/dev/null
echo ""
read -p "Press Enter to close..."
