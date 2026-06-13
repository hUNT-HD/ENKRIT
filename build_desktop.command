#!/bin/bash
cd "$(dirname "$0")"
echo "=== ENKRIT Desktop Build ==="
echo ""
echo "[1/2] Building macOS DMG..."
npm run build:mac
echo ""
echo "[2/2] Building Windows ZIP..."
npm run build:win
echo ""
echo "=== All builds complete! Check dist/ folder ==="
read -p "Press Enter to close..."
