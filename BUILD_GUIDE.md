# ═══════════════════════════════════════════
#  ENKRIT — Complete Build Guide
#  Mac · Windows · Linux · Android · iPhone
# ═══════════════════════════════════════════

## PROJECT STRUCTURE

ENKRIT/
├── src/
│   ├── index.html      ← Main UI (all platforms share this)
│   ├── style.css       ← Premium dark/light theme
│   └── app.js          ← All player logic
├── electron/
│   ├── main.js         ← Desktop app entry (Mac/Win/Linux)
│   └── preload.js      ← Secure IPC bridge
├── android-setup/
│   └── ANDROID_IOS_SETUP.md
├── assets/             ← Put your icon.png / icon.icns / icon.ico here
└── package.json

---

## STEP 1 — Install Node.js
Download from: https://nodejs.org  (version 18 or higher)

---

## STEP 2 — Install dependencies

Open Terminal (Mac/Linux) or Command Prompt (Windows):

  cd ENKRIT
  npm install

---

## STEP 3 — TEST (run without building)

  npm start

This opens ENKRIT as a native desktop window. Test all features.

---

## STEP 4A — BUILD FOR MAC (.dmg installer)

  npm run build:mac

Output: dist/ENKRIT-1.0.0.dmg
→ Double-click to install on any Mac (Intel + Apple Silicon both supported)

---

## STEP 4B — BUILD FOR WINDOWS (.exe installer)

On Windows, run:
  npm run build:win

Output: dist/ENKRIT Setup 1.0.0.exe
→ Standard Windows installer with Next/Next/Finish

---

## STEP 4C — BUILD FOR LINUX (.AppImage)

  npm run build:linux

Output: dist/ENKRIT-1.0.0.AppImage
→ chmod +x ENKRIT.AppImage && ./ENKRIT.AppImage

---

## STEP 4D — BUILD FOR ANDROID

Native project lives in android/ (custom WebView host + ExoPlayer, no
Capacitor at runtime).

  npm run android:build      ← debug APK (syncs web assets automatically)
  npm run android:install    ← build + adb install

Release APK: create android/keystore.properties, then:
  cd android && ./gradlew assembleRelease

---

## STEP 4E — BUILD FOR iPHONE (iOS)

Native Xcode project lives in ios/ (WKWebView host — same web UI as every
other platform). Requires a Mac with Xcode 15+.

1. Sync web assets (run after ANY change to src/):
     ./ios/sync-web-assets.sh        (or: npm run ios:sync)

2. Open the project:
     open ios/ENKRIT.xcodeproj

3. Xcode → target "ENKRIT" → Signing & Capabilities → select your Team
   (a free Apple ID works for installing on your own iPhone).

4. Plug in your iPhone, select it as the run destination, press ▶ (Cmd+R).
   First install: on the iPhone go to Settings → General → VPN & Device
   Management → trust your developer certificate.

iOS notes:
  - Library tab scans the Photos library (videos + audio); the open
    button also offers the Files app picker (video + audio, multi-select).
  - Playback uses the HTML <video> element — codec support is what iOS
    provides natively (MP4/MOV/M4V with H.264/HEVC, MP3/AAC/WAV audio).
    MKV/AVI will not decode on iOS.
  - AI (Whisper) subtitles are desktop-only; loading .srt/.vtt works.
  - Free Apple ID signing expires after 7 days — just rebuild from Xcode
    to re-install. A paid Apple Developer account removes this limit and
    enables TestFlight / App Store distribution.

---

## FEATURES INCLUDED

✅ Blue & Black premium dark theme (+ light mode toggle)
✅ ALL video formats: MP4, MKV, AVI, MOV, WEBM, FLV, WMV, M4V, OGV, TS, 3GP, etc.
✅ Volume boost UP TO 300% (Web Audio API GainNode)
✅ Default screen settings (brightness/contrast/saturation sliders)
✅ 8 filter presets: Normal, Vivid, Cinematic, Cool, Warm, Noir, Vintage, Auto Enhance
✅ Fully offline — no internet needed for playback
✅ Auto subtitle generation when online (Web Speech API)
✅ Manual subtitle: Load .SRT / .VTT files
✅ Subtitle ON/OFF toggle
✅ Controls: Play/Pause, Volume, Seek bar, Time display
✅ ±5 second skip (forward & backward)
✅ Previous / Next video buttons
✅ Playlist sidebar
✅ Playback speed: 0.1× to 5× (slider + presets)
✅ Picture-in-Picture popup mode
✅ Fullscreen
✅ Drag & drop video files
✅ Dark mode default, light mode toggle
✅ Keyboard shortcuts (Space, Arrow keys, F, M, P, [], N, B)

---

## KEYBOARD SHORTCUTS

  Space       → Play / Pause
  ← →         → Seek ±5 seconds
  ↑ ↓         → Volume ±10%
  [ ]         → Speed down / up (±0.25×)
  F           → Fullscreen
  M           → Mute
  P           → Picture in Picture
  N           → Next video
  B           → Previous video

---

## ADDING YOUR APP ICON

Place these files in the assets/ folder:
  icon.png   (1024×1024, for Linux + Android)
  icon.icns  (Mac — use iconutil or https://cloudconvert.com/png-to-icns)
  icon.ico   (Windows — use https://icoconvert.com)

---

## TROUBLESHOOTING

"App can't be opened" on Mac:
  System Settings → Privacy & Security → "Open Anyway"

Windows Defender warning:
  Click "More info" → "Run anyway" (unsigned app)

Video won't play:
  Electron uses Chromium — if a codec is missing (e.g. H.265),
  install electron with --enable-proprietary-codecs or use a pre-built
  Electron with all codecs from: https://github.com/castlabs/electron-releases
