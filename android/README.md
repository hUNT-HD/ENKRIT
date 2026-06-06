# ENKRIT Android

Native Android wrapper for the ENKRIT offline media player.

## Support

- Minimum Android version: Android 11 / API 30
- Target SDK: API 36
- Package id: `com.enkrit.app`

## Build

From the project root:

```bash
npm run android:build
```

The debug APK is generated at:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

To install on a connected Android device with USB debugging enabled:

```bash
npm run android:install
```

## Notes

- The Android app uses the same `src/index.html`, `src/style.css`, and `src/app.js` UI as desktop.
- `MainActivity` exposes an `AndroidBridge` so the web UI can scan Android MediaStore and open local audio/video files.
- AI Whisper subtitles and FFmpeg conversion remain desktop-only for now; Android playback uses the device WebView/media codecs.
