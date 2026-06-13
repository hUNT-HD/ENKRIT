#!/bin/bash
cd "$(dirname "$0")"
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/Library/Android/sdk/platform-tools"
echo "=== ENKRIT Android Build + Install ==="
echo ""

# Check adb
if ! command -v adb &>/dev/null; then
  echo "ERROR: adb not found. Make sure Android SDK is installed."
  echo "Press Enter to close."
  read
  exit 1
fi

# Check device
echo "Connected devices:"
adb devices
echo ""

DEVICE_COUNT=$(adb devices | grep -v "List of devices" | grep -c "device$" || true)
if [ "$DEVICE_COUNT" -eq 0 ]; then
  echo "ERROR: No Android device/emulator connected."
  echo "Connect your phone (USB debugging ON) and try again."
  echo "Press Enter to close."
  read
  exit 1
fi

echo "Building + installing..."
npm run android:install

if [ $? -eq 0 ]; then
  echo ""
  echo "SUCCESS! ENKRIT installed on device."
else
  echo ""
  echo "Build failed. Check errors above."
fi
echo ""
echo "Press Enter to close."
read
